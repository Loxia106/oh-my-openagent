import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Plugin } from "@opencode/plugin"
import type { SessionPrompt } from "@opencode/plugin/promise/session"
import { Error as NativeToolError, type Result as NativeToolResult } from "@opencode/plugin/promise/tool"
import type { OhMyOpenCodeConfig } from "../config"
import { clearPluginExtendedConfigCache } from "../hooks/claude-code-hooks/config-loader"
import { clearClaudeHooksConfigCache } from "../hooks/claude-code-hooks/config"
import * as dispatchHookModule from "../hooks/claude-code-hooks/dispatch-hook"
import { registerV2ClaudeHooks } from "./claude-hooks"

type PromptCallback = (input: SessionPrompt) => Promise<void> | void
type SessionRecord = Awaited<ReturnType<Plugin.Context["session"]["get"]>>
type SyntheticInput = Parameters<Plugin.Context["session"]["synthetic"]>[0]

const roots: string[] = []
let originalClaudeConfigDir: string | undefined
let originalXdgConfigHome: string | undefined

afterEach(async () => {
	mock.restore()
	clearClaudeHooksConfigCache()
	clearPluginExtendedConfigCache()
	if (originalClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
	else process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir
	if (originalXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME
	else process.env.XDG_CONFIG_HOME = originalXdgConfigHome
	originalClaudeConfigDir = undefined
	originalXdgConfigHome = undefined
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function isolatedProject(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "omo-v2-claude-hooks-"))
	roots.push(root)
	const globalClaude = join(root, "home", ".claude")
	const xdg = join(root, "xdg")
	await mkdir(globalClaude, { recursive: true })
	await mkdir(xdg, { recursive: true })
	originalClaudeConfigDir ??= process.env.CLAUDE_CONFIG_DIR
	originalXdgConfigHome ??= process.env.XDG_CONFIG_HOME
	process.env.CLAUDE_CONFIG_DIR = globalClaude
	process.env.XDG_CONFIG_HOME = xdg
	clearClaudeHooksConfigCache()
	clearPluginExtendedConfigCache()
	return join(root, "project")
}

function promptConfig(event: "UserPromptSubmit" | "Stop", command: string): string {
	return JSON.stringify({ hooks: { [event]: [{ matcher: "*", hooks: [{ type: "command", command }] }] } })
}

function eventConfig(event: string, matcher: string, command: string): string {
	return JSON.stringify({ hooks: { [event]: [{ matcher, hooks: [{ type: "command", command }] }] } })
}

async function writeProjectHooks(directory: string, contents: string): Promise<void> {
	const settings = join(directory, ".claude", "settings.json")
	await mkdir(join(directory, ".claude"), { recursive: true })
	await writeFile(settings, contents)
}

type GenericCallback = (input: unknown) => Promise<void> | void

function makeHarness(directory: string, options: {
	parentID?: string
	projectID?: string
	storage?: Map<string, unknown>
	contextMessages?: readonly unknown[]
	beforeSessionGet?: (call: number) => Promise<void>
} = {}) {
	const callbacks = new Map<string, GenericCallback>()
	const toolCallbacks = new Map<string, GenericCallback>()
	const permissionCallbacks = new Map<string, GenericCallback>()
	const synthetics: SyntheticInput[] = []
	const storage = options.storage ?? new Map<string, unknown>()
	let sessionDeleted = false
	let sessionGetCalls = 0
	const sessionRecord = (sessionID: string): SessionRecord => ({
		id: sessionID,
		parentID: options.parentID,
		projectID: options.projectID ?? "project-claude-hooks",
		location: { directory },
		agent: "sisyphus",
		metadata: {},
	} as unknown as SessionRecord)
	const context = {
		location: {
			directory,
			workspaceID: "workspace-claude-hooks",
			project: { id: "project-claude-hooks", canonical: directory },
		},
		storage: {
			get: async (key: string) => storage.get(key),
			set: async (key: string, value: unknown) => { storage.set(key, value) },
			remove: async (key: string) => { storage.delete(key) },
			scan: async () => ({ items: [], cursor: undefined }),
		},
		session: {
			get: async ({ sessionID }: { sessionID: string }) => {
				await options.beforeSessionGet?.(++sessionGetCalls)
				if (sessionDeleted) throw new Error(`session ${sessionID} not found`)
				return sessionRecord(sessionID)
			},
			hook: async (name: string, callback: PromptCallback) => {
				callbacks.set(name, callback as GenericCallback)
				return { dispose: async () => { callbacks.delete(name) } }
			},
			context: async () => options.contextMessages ?? [{ type: "user", text: "previous conversation marker" }],
			 synthetic: async (input: SyntheticInput) => { synthetics.push(input) },
		},
		tool: {
			hook: async (name: string, callback: GenericCallback) => {
				toolCallbacks.set(name, callback)
				return { dispose: async () => { toolCallbacks.delete(name) } }
			},
		},
		permission: {
			hook: async (name: string, callback: GenericCallback) => {
				permissionCallbacks.set(name, callback)
				return { dispose: async () => { permissionCallbacks.delete(name) } }
			},
		},
		event: {
			subscribe: ({ signal }: { signal: AbortSignal }) => (async function* () {
				while (!signal.aborted) {
					await new Promise<void>((resolvePromise) => {
						if (signal.aborted) return resolvePromise()
						signal.addEventListener("abort", () => resolvePromise(), { once: true })
					})
				}
			})(),
		},
	} as unknown as Plugin.Context
	return {
		ctx: context,
		storage,
		synthetics,
		get sessionDeleted() { return sessionDeleted },
		setSessionDeleted(value: boolean) { sessionDeleted = value },
		prompt(input: { sessionID: string; messageID: string; text: string; files?: SessionPrompt["prompt"]["files"] }) {
			const callback = callbacks.get("prompt")
			if (!callback) throw new Error("prompt hook was not registered")
			const prompt: SessionPrompt = {
				sessionID: input.sessionID as SessionPrompt["sessionID"],
				messageID: input.messageID as SessionPrompt["messageID"],
				prompt: { text: input.text, ...(input.files ? { files: input.files } : {}) },
				delivery: "steer",
			}
			return callback(prompt).then(() => prompt)
		},
		toolCallback(name: string) { return toolCallbacks.get(name) },
		permissionCallback(name: string) { return permissionCallbacks.get(name) },
		sessionCallback(name: string) { return callbacks.get(name) },
	}
}

function countLines(contents: string): number {
	return contents.trim().length === 0 ? 0 : contents.trim().split("\n").length
}

describe("native V2 Claude prompt and Stop hooks", () => {
	test("blocks UserPromptSubmit before model admission and records a visible non-resuming notice", async () => {
		const directory = await isolatedProject()
		const command = `printf '%s' '{"decision":"block","reason":"policy denied this prompt"}'; exit 1`
		await writeProjectHooks(directory, promptConfig("UserPromptSubmit", command))
		const harness = makeHarness(directory)
		const registration = await registerV2ClaudeHooks(harness.ctx, { claude_code: { plugins: false } } as OhMyOpenCodeConfig)
		const files = [{ uri: "file:///tmp/attached.png", name: "attached.png" }]
		try {
			await expect(harness.prompt({ sessionID: "ses-prompt-block", messageID: "msg-user-1", text: "do this", files }))
				.rejects.toThrow("policy denied this prompt")
			expect(harness.synthetics).toHaveLength(1)
			expect(harness.synthetics[0]).toMatchObject({
				sessionID: "ses-prompt-block",
				text: expect.stringContaining("policy denied this prompt"),
				description: "Claude UserPromptSubmit hook block",
				delivery: "queue",
				resume: false,
			})
			expect(harness.synthetics[0]?.id).toMatch(/^msg_[0-9a-f]{64}$/)
		} finally {
			await registration.cleanup()
		}
	})

	test("passes a private native context transcript to UserPromptSubmit then removes it", async () => {
		const directory = await isolatedProject()
		await writeProjectHooks(directory, promptConfig("UserPromptSubmit", "capture"))
		const harness = makeHarness(directory, {
			contextMessages: [{ type: "user", text: "PRIOR_TRANSCRIPT_MARKER" }],
		})
		let path: string | undefined
		let transcript = ""
		spyOn(dispatchHookModule, "dispatchHook").mockImplementation(async (_hook, stdin) => {
			const data = JSON.parse(stdin) as { transcript_path?: string }
			path = data.transcript_path
			if (path) transcript = await readFile(path, "utf8")
			return { exitCode: 0, stdout: "", stderr: "" }
		})
		const registration = await registerV2ClaudeHooks(harness.ctx, { claude_code: { plugins: false } } as OhMyOpenCodeConfig)
		try {
			await harness.prompt({ sessionID: "ses-transcript-prompt", messageID: "msg-transcript-1", text: "current prompt" })
			expect(path).toBeDefined()
			expect(transcript).toContain("PRIOR_TRANSCRIPT_MARKER")
			await expect(stat(path!)).rejects.toThrow()
		} finally {
			await registration.cleanup()
		}
	})

	test("adapts native shell matcher/input and applies an allowed PreToolUse rewrite", async () => {
		const directory = await isolatedProject()
		await writeProjectHooks(directory, eventConfig("PreToolUse", "Bash", "rewrite"))
		const harness = makeHarness(directory, { contextMessages: [{ type: "user", text: "PRE_TOOL_HISTORY_MARKER" }] })
		let stdin: Record<string, unknown> | undefined
		let transcript = ""
		spyOn(dispatchHookModule, "dispatchHook").mockImplementation(async (_hook, input) => {
			stdin = JSON.parse(input) as Record<string, unknown>
			transcript = await readFile(String(stdin.transcript_path), "utf8")
			return { exitCode: 0, stdout: JSON.stringify({ decision: "allow", hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: { command: "printf rewritten" } } }), stderr: "" }
		})
		const registration = await registerV2ClaudeHooks(harness.ctx, { claude_code: { plugins: false } } as OhMyOpenCodeConfig)
		const event = { tool: "shell", sessionID: "ses-pretool", agent: "sisyphus", messageID: "msg-pretool", id: "call-pretool", input: { command: "printf original", timeout: 4 } }
		try {
			await harness.toolCallback("execute.before")?.(event)
			expect(event.input).toEqual({ command: "printf rewritten", timeout: 4 })
			expect(stdin).toMatchObject({ hook_event_name: "PreToolUse", tool_name: "Bash" })
			expect(stdin?.transcript_path).toBeString()
			expect(JSON.stringify(stdin?.tool_input)).toContain("printf original")
			expect(transcript).toContain("PRE_TOOL_HISTORY_MARKER")
			await expect(stat(String(stdin?.transcript_path))).rejects.toThrow()
		} finally {
			await registration.cleanup()
		}
	})

	test("rejects hook events whose session belongs to another project before dispatch", async () => {
		const directory = await isolatedProject()
		await writeProjectHooks(directory, eventConfig("PreToolUse", "Bash", "must-not-run"))
		const harness = makeHarness(directory, { projectID: "another-project" })
		const dispatch = spyOn(dispatchHookModule, "dispatchHook").mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" })
		const registration = await registerV2ClaudeHooks(harness.ctx, { claude_code: { plugins: false } } as OhMyOpenCodeConfig)
		try {
			await expect(harness.toolCallback("execute.before")?.({
				tool: "shell", sessionID: "ses-foreign", agent: "sisyphus", messageID: "msg-foreign", id: "call-foreign", input: { command: "true" },
			})).rejects.toThrow("belongs to this project and directory")
			expect(dispatch).not.toHaveBeenCalled()
		} finally {
			await registration.cleanup()
		}
	})

	test("discards a delayed PreToolUse rewrite when the native session disappears", async () => {
		const directory = await isolatedProject()
		await writeProjectHooks(directory, eventConfig("PreToolUse", "Bash", "rewrite"))
		const harness = makeHarness(directory)
		let signalStarted!: () => void
		let finishHook!: (value: { exitCode: number; stdout: string; stderr: string }) => void
		const started = new Promise<void>((resolveStarted) => { signalStarted = resolveStarted })
		const dispatch = spyOn(dispatchHookModule, "dispatchHook").mockImplementation(() => new Promise((resolveResult) => {
			finishHook = resolveResult
			signalStarted()
		}))
		const registration = await registerV2ClaudeHooks(harness.ctx, { claude_code: { plugins: false } } as OhMyOpenCodeConfig)
		const event = { tool: "shell", sessionID: "ses-deleted", agent: "sisyphus", messageID: "msg-deleted", id: "call-deleted", input: { command: "printf original" } }
		try {
			const pending = Promise.resolve(harness.toolCallback("execute.before")?.(event))
			await started
			harness.setSessionDeleted(true)
			finishHook({
				exitCode: 0,
				stdout: JSON.stringify({ decision: "allow", hookSpecificOutput: { permissionDecision: "allow", updatedInput: { command: "printf stale" } } }),
				stderr: "",
			})
			await expect(pending).rejects.toThrow("not found")
			expect(event.input).toEqual({ command: "printf original" })
			expect(dispatch).toHaveBeenCalledTimes(1)
		} finally {
			harness.setSessionDeleted(false)
			await registration.cleanup()
		}
	})

	test("does not apply a delayed rewrite after registration cleanup begins", async () => {
		const directory = await isolatedProject()
		await writeProjectHooks(directory, eventConfig("PreToolUse", "Bash", "rewrite"))
		const harness = makeHarness(directory)
		let signalStarted!: () => void
		let finishHook!: (value: { exitCode: number; stdout: string; stderr: string }) => void
		const started = new Promise<void>((resolveStarted) => { signalStarted = resolveStarted })
		spyOn(dispatchHookModule, "dispatchHook").mockImplementation(() => new Promise((resolveResult) => {
			finishHook = resolveResult
			signalStarted()
		}))
		const registration = await registerV2ClaudeHooks(harness.ctx, { claude_code: { plugins: false } } as OhMyOpenCodeConfig)
		const event = { tool: "shell", sessionID: "ses-cleanup", agent: "sisyphus", messageID: "msg-cleanup", id: "call-cleanup", input: { command: "printf original" } }
		try {
			const pending = Promise.resolve(harness.toolCallback("execute.before")?.(event))
			await started
			const cleanup = registration.cleanup()
			finishHook({
				exitCode: 0,
				stdout: JSON.stringify({ decision: "allow", hookSpecificOutput: { permissionDecision: "allow", updatedInput: { command: "printf stale" } } }),
				stderr: "",
			})
			await Promise.all([pending, cleanup])
			expect(event.input).toEqual({ command: "printf original" })
		} finally {
			await registration.cleanup()
		}
	})

	test("rechecks cleanup after the final awaited session verification", async () => {
		const directory = await isolatedProject()
		await writeProjectHooks(directory, eventConfig("PreToolUse", "Bash", "rewrite"))
		let signalSessionCheck!: () => void
		let finishSessionCheck!: () => void
		const sessionCheckStarted = new Promise<void>((resolveStarted) => { signalSessionCheck = resolveStarted })
		const sessionCheckGate = new Promise<void>((resolveGate) => { finishSessionCheck = resolveGate })
		const harness = makeHarness(directory, {
			beforeSessionGet: async (call) => {
				if (call === 3) {
					signalSessionCheck()
					await sessionCheckGate
				}
			},
		})
		spyOn(dispatchHookModule, "dispatchHook").mockResolvedValue({
			exitCode: 0,
			stdout: JSON.stringify({ decision: "allow", hookSpecificOutput: { permissionDecision: "allow", updatedInput: { command: "printf stale" } } }),
			stderr: "",
		})
		const registration = await registerV2ClaudeHooks(harness.ctx, { claude_code: { plugins: false } } as OhMyOpenCodeConfig)
		const event = { tool: "shell", sessionID: "ses-cleanup-recheck", agent: "sisyphus", messageID: "msg-cleanup-recheck", id: "call-cleanup-recheck", input: { command: "printf original" } }
		try {
			const pending = Promise.resolve(harness.toolCallback("execute.before")?.(event))
			await sessionCheckStarted
			const cleanup = registration.cleanup()
			finishSessionCheck()
			await Promise.all([pending, cleanup])
			expect(event.input).toEqual({ command: "printf original" })
		} finally {
			finishSessionCheck()
			await registration.cleanup()
		}
	})

	test("maps PreToolUse ask into permission.evaluate without replacing a native denial", async () => {
		const directory = await isolatedProject()
		await writeProjectHooks(directory, eventConfig("PreToolUse", "Bash", "ask"))
		const harness = makeHarness(directory)
		spyOn(dispatchHookModule, "dispatchHook").mockResolvedValue({ exitCode: 1, stdout: "", stderr: "approval required" })
		const registration = await registerV2ClaudeHooks(harness.ctx, { claude_code: { plugins: false } } as OhMyOpenCodeConfig)
		const call = { tool: "shell", sessionID: "ses-ask", agent: "sisyphus", messageID: "msg-ask", id: "call-ask", input: { command: "rm -rf /tmp/example" } }
		const evaluation = { sessionID: "ses-ask", action: "shell", resources: ["rm -rf /tmp/example"], source: { type: "tool", messageID: "msg-ask", id: "call-ask" }, effect: "allow" as "allow" | "ask" | "deny" }
		try {
			await harness.toolCallback("execute.before")?.(call)
			await harness.permissionCallback("evaluate")?.(evaluation)
			expect(evaluation.effect).toBe("ask")
			expect(evaluation.message).toBe("approval required")
			const denied = { ...evaluation, effect: "deny" as const, message: "native policy denied" }
			await harness.permissionCallback("evaluate")?.(denied)
			expect(denied.effect).toBe("deny")
			await harness.toolCallback("execute.after")?.({ ...call, status: "error", error: new NativeToolError({ message: "aborted" }) })
			const after = { ...evaluation, effect: "allow" as const, message: undefined }
			await harness.permissionCallback("evaluate")?.(after)
			expect(after.effect).toBe("allow")
		} finally {
			await registration.cleanup()
		}
	})

	test("PostToolUse preserves file results and metadata while appending hook context", async () => {
		const directory = await isolatedProject()
		await writeProjectHooks(directory, eventConfig("PostToolUse", "Read", "post"))
		const harness = makeHarness(directory, { contextMessages: [{ type: "user", text: "POST_HISTORY_MARKER" }] })
		let hookInput: Record<string, unknown> | undefined
		let transcript = ""
		spyOn(dispatchHookModule, "dispatchHook").mockImplementation(async (_hook, input) => {
			hookInput = JSON.parse(input) as Record<string, unknown>
			const path = String(hookInput.transcript_path)
			transcript = await readFile(path, "utf8")
			return { exitCode: 0, stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: "POST_CONTEXT_MARKER" }, continue: false, stopReason: "advisory stop after result" }), stderr: "" }
		})
		const registration = await registerV2ClaudeHooks(harness.ctx, { claude_code: { plugins: false } } as OhMyOpenCodeConfig)
		const result: NativeToolResult = { content: [{ type: "file", uri: "file:///tmp/read.png", mime: "image/png", name: "read.png" }], metadata: { kept: true } }
		const event = { tool: "read", sessionID: "ses-post", agent: "sisyphus", messageID: "msg-post", id: "call-post", input: { path: "/tmp/read.png" }, status: "completed" as const, result }
		try {
			await harness.toolCallback("execute.after")?.(event)
			expect(hookInput).toMatchObject({ hook_event_name: "PostToolUse", tool_name: "Read" })
			expect(transcript).toContain("POST_HISTORY_MARKER")
			expect(result.metadata).toEqual({ kept: true })
			expect(event.result.metadata).toEqual({ kept: true })
			expect(event.result.content).toContainEqual({ type: "file", uri: "file:///tmp/read.png", mime: "image/png", name: "read.png" })
			expect(event.result.content).toContainEqual(expect.objectContaining({ type: "text", text: expect.stringContaining("POST_CONTEXT_MARKER") }))
			expect(event.result.content).toContainEqual(expect.objectContaining({ type: "text", text: expect.stringContaining("advisory stop after result") }))
		} finally {
			await registration.cleanup()
		}
	})

	test("surfaces PostToolUseFailure context without erasing the native tool error", async () => {
		const directory = await isolatedProject()
		await writeProjectHooks(directory, eventConfig("PostToolUseFailure", "Bash", "failure-context"))
		const harness = makeHarness(directory, { contextMessages: [{ type: "user", text: "failure history" }] })
		let hookInput: Record<string, unknown> | undefined
		let transcript = ""
		spyOn(dispatchHookModule, "dispatchHook").mockImplementation(async (_hook, input) => {
			hookInput = JSON.parse(input) as Record<string, unknown>
			transcript = await readFile(String(hookInput.transcript_path), "utf8")
			return { exitCode: 0, stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUseFailure", additionalContext: "failure context" } }), stderr: "" }
		})
		const registration = await registerV2ClaudeHooks(harness.ctx, { claude_code: { plugins: false } } as OhMyOpenCodeConfig)
		const originalError = new NativeToolError({ message: "native failure", metadata: { preserved: true } })
		const event = { tool: "shell", sessionID: "ses-failed-tool", agent: "sisyphus", messageID: "msg-failed-tool", id: "call-failed-tool", input: { command: "false" }, status: "error" as const, error: originalError }
		try {
			await harness.toolCallback("execute.after")?.(event)
			expect(hookInput).toMatchObject({ hook_event_name: "PostToolUseFailure", tool_name: "Bash", error: "native failure" })
			expect(transcript).toContain("failure history")
			expect(transcript).toContain("native failure")
			expect(event.error).toBeInstanceOf(NativeToolError)
			expect(event.error).not.toBe(originalError)
			expect(event.error.message).toContain("native failure")
			expect(event.error.message).toContain("failure context")
			expect(event.error.metadata).toEqual({ preserved: true })
		} finally {
			await registration.cleanup()
		}
	})

	test("PreCompact adds hook context and aborts without a fabricated summary on continue=false", async () => {
		const directory = await isolatedProject()
		await writeProjectHooks(directory, eventConfig("PreCompact", "*", "compact"))
		const harness = makeHarness(directory, { contextMessages: [{ type: "user", text: "COMPACT_HISTORY_MARKER" }] })
		let transcript = ""
		spyOn(dispatchHookModule, "dispatchHook").mockImplementation(async (_hook, input) => {
			const data = JSON.parse(input) as { transcript_path: string }
			transcript = await readFile(data.transcript_path, "utf8")
			return { exitCode: 0, stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: "PreCompact", additionalContext: ["COMPACT_CONTEXT_MARKER"] } }), stderr: "" }
		})
		const registration = await registerV2ClaudeHooks(harness.ctx, { claude_code: { plugins: false } } as OhMyOpenCodeConfig)
		const input = { sessionID: "ses-compact", agent: "sisyphus", model: { id: "m", providerID: "p" }, system: [], messages: [], options: {}, tools: {} }
		try {
			await harness.sessionCallback("compaction")?.(input)
			expect(transcript).toContain("COMPACT_HISTORY_MARKER")
			expect(input.system).toContainEqual({ type: "text", text: "COMPACT_CONTEXT_MARKER" })
		} finally {
			await registration.cleanup()
		}
	})

	test("persists Stop decisions, deduplicates an idle replay, caps continuations, and resets for a new user prompt", async () => {
		const directory = await isolatedProject()
		const counter = join(directory, "stop-calls.txt")
		const json = `'{"decision":"block","reason":"continue","inject_prompt":"Finish the requested work"}'`
		const command = `echo called >> '${counter}'; printf '%s' ${json}`
		await writeProjectHooks(directory, promptConfig("Stop", command))
		const storage = new Map<string, unknown>()
		const harness = makeHarness(directory, { storage })
		const registration = await registerV2ClaudeHooks(harness.ctx, { claude_code: { plugins: false } } as OhMyOpenCodeConfig)
		const controller = new AbortController()
		const gate = (idleAt: number) => registration.beforeContinuation({
			sessionID: "ses-stop-cap",
			idleAt,
			signal: controller.signal,
			isCurrent: () => true,
		})
		try {
			await harness.prompt({ sessionID: "ses-stop-cap", messageID: "msg-user-a", text: "start" })
			const first = await gate(100)
			expect(first.kind).toBe("continue")
			const replay = await gate(100)
			expect(replay).toEqual(first)
			expect(countLines(await readFile(counter, "utf8"))).toBe(1)

			expect((await gate(101)).kind).toBe("continue")
			expect((await gate(102)).kind).toBe("continue")
			const capped = await gate(103)
			expect(capped.kind).toBe("pause")
			expect(await gate(103)).toEqual(capped)
			expect(countLines(await readFile(counter, "utf8"))).toBe(4)

			await registration.cleanup()
			const restarted = makeHarness(directory, { storage })
			const afterRestart = await registerV2ClaudeHooks(restarted.ctx, { claude_code: { plugins: false } } as OhMyOpenCodeConfig)
			try {
				expect(await afterRestart.beforeContinuation({
					sessionID: "ses-stop-cap",
					idleAt: 103,
					signal: controller.signal,
					isCurrent: () => true,
				})).toEqual(capped)
				expect(countLines(await readFile(counter, "utf8"))).toBe(4)
				await restarted.prompt({ sessionID: "ses-stop-cap", messageID: "msg-user-b", text: "new request" })
				const reset = await afterRestart.beforeContinuation({
					sessionID: "ses-stop-cap",
					idleAt: 104,
					signal: controller.signal,
					isCurrent: () => true,
				})
				expect(reset.kind).toBe("continue")
				expect(countLines(await readFile(counter, "utf8"))).toBe(5)
			} finally {
				await afterRestart.cleanup()
			}
		} finally {
			await registration.cleanup()
		}
	})

	test("does not run root user prompt hooks for native or verified logical children", async () => {
		const directory = await isolatedProject()
		const counter = join(directory, "prompt-calls.txt")
		const command = `echo called >> '${counter}'; printf 'extra context'`
		await writeProjectHooks(directory, promptConfig("UserPromptSubmit", command))
		const nativeChild = makeHarness(directory, { parentID: "ses-parent" })
		const registration = await registerV2ClaudeHooks(nativeChild.ctx, { claude_code: { plugins: false } } as OhMyOpenCodeConfig)
		try {
			await nativeChild.prompt({ sessionID: "ses-child", messageID: "msg-child", text: "child prompt" })
			expect(nativeChild.synthetics).toHaveLength(0)
			expect(countLines(await readFile(counter, "utf8").catch(() => ""))).toBe(0)
		} finally {
			await registration.cleanup()
		}
	})
})
