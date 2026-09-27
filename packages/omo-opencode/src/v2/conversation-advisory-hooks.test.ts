import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Plugin } from "@opencode/plugin"
import { Error as NativeToolError, type Result as NativeToolResult } from "@opencode/plugin/promise/tool"
import type { SessionContext } from "@opencode/plugin/promise/session"
import type { HookInput } from "@oh-my-opencode/comment-checker-core"
import type { OhMyOpenCodeConfig } from "../config"
import type { LoadedSkill } from "../features/opencode-skill-loader/types"
import { buildReminderMessage } from "../hooks/category-skill-reminder/formatter"
import type { AvailableSkill } from "../agents/dynamic-agent-prompt-builder"
import {
	filterV2CategoryReminderSkills,
	registerV2ConversationAdvisoryHooks,
	type V2ConversationAdvisoryDependencies,
} from "./conversation-advisory-hooks"

const roots: string[] = []
const CATEGORY_MARKER = "[Category+Skill Reminder]"
const TASK_MARKER = "[task CALL FAILED - IMMEDIATE RETRY REQUIRED]"
const COMMENT_MARKER = "[Comment Checker Findings]"

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

type NativeEvent = { type: string; location?: unknown; data?: unknown }
type ToolEvent = {
	tool: string
	sessionID: string
	agent: string
	messageID: string
	id: string
	input: unknown
	status: "completed" | "error"
	result?: NativeToolResult
	error?: InstanceType<typeof NativeToolError>
}
type ToolHandler = (event: ToolEvent) => unknown
type ContextHandler = (input: SessionContext) => unknown

function makeStorage() {
	const values = new Map<string, unknown>()
	return {
		values,
		get: async (key: string) => values.get(key),
		set: async (key: string, value: unknown) => { values.set(key, value) },
		remove: async (key: string) => { values.delete(key) },
		scan: async () => ({ entries: [], next: undefined }),
	}
}

function makeHarness(directory: string, storage = makeStorage(), failOnToolRegistration?: number) {
	const toolHandlers: ToolHandler[] = []
	const contextHandlers: ContextHandler[] = []
	const disposed: string[] = []
	const queue: NativeEvent[] = []
	let wake: (() => void) | undefined
	let resolveSubscribed!: () => void
	const subscribed = new Promise<void>((resolve) => { resolveSubscribed = resolve })
	let toolRegistrations = 0
	const ctx = {
		location: { directory, workspaceID: "workspace-advisory", project: { id: `project-${directory}`, canonical: directory } },
		storage,
		tool: {
			hook: async (name: string, handler: ToolHandler) => {
				toolRegistrations += 1
				if (toolRegistrations === failOnToolRegistration) throw new Error(`tool registration failed at ${toolRegistrations}`)
				toolHandlers.push(handler)
				const id = `${name}:${toolRegistrations}`
				return { dispose: async () => { disposed.push(id) } }
			},
		},
		session: {
			hook: async (name: string, handler: ContextHandler) => {
				contextHandlers.push(handler)
				return { dispose: async () => { disposed.push(`session:${name}`) } }
			},
		},
		event: {
			subscribe: ({ signal }: { signal: AbortSignal }) => (async function* () {
				resolveSubscribed()
				while (!signal.aborted) {
					const event = queue.shift()
					if (event) {
						yield event as unknown as Plugin.Event
						continue
					}
					await new Promise<void>((resolve) => {
						const onAbort = () => resolve()
						wake = resolve
						signal.addEventListener("abort", onAbort, { once: true })
					})
					wake = undefined
				}
			})(),
		},
	} as unknown as Plugin.Context
	return {
		ctx,
		storage,
		disposed,
		toolHandlers,
		contextHandlers,
		subscribed,
		emit(event: NativeEvent) { queue.push(event); wake?.() },
		async runTool(event: ToolEvent) {
			for (const handler of toolHandlers) await handler(event)
		},
		async runContext(input: SessionContext) {
			for (const handler of contextHandlers) await handler(input)
		},
	}
}

function toolEvent(overrides: Partial<ToolEvent> & Pick<ToolEvent, "tool" | "id">): ToolEvent {
	return {
		sessionID: "ses_advisory",
		agent: "sisyphus",
		messageID: `msg-${overrides.id}`,
		input: {},
		status: "completed",
		result: { content: "tool completed", output: { retained: true }, metadata: { native: "kept" } },
		...overrides,
	}
}

function contextInput(sessionID = "ses_advisory", agent = "sisyphus"): SessionContext {
	return {
		sessionID,
		agent,
		model: { providerID: "local", id: "mock" },
		messages: [{ role: "user", content: "Continue the work" }],
		system: [{ type: "text", text: "base system" }],
		tools: {},
		options: {},
	} as unknown as SessionContext
}

function contentText(content: NativeToolResult["content"]): string {
	if (typeof content === "string") return content
	if (!Array.isArray(content)) return ""
	return content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n")
}

const skills: AvailableSkill[] = [
	{ name: "frontend", description: "UI work", location: "user" },
	{ name: "ast-grep", description: "Structural search", location: "plugin" },
]

function loadedSkill(name: string, scope: LoadedSkill["scope"], options: Partial<LoadedSkill> = {}): LoadedSkill {
	return {
		name,
		scope,
		definition: { name, description: `Description for ${name}`, template: `Instructions for ${name}` },
		...options,
	}
}

function dependencies(overrides: Partial<V2ConversationAdvisoryDependencies> = {}): V2ConversationAdvisoryDependencies {
	return {
		loadAvailableSkills: async () => skills,
		commentChecker: {
			getPath: async () => "/fixture/comment-checker",
			isPathUsable: (path): path is string => path === "/fixture/comment-checker",
			run: async () => ({ hasComments: false, message: "" }),
		},
		...overrides,
	}
}

async function makeDirectory(): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), "omo-v2-conversation-advisory-"))
	roots.push(path)
	return path
}

describe("native v2 conversation advisory hooks", () => {
		test("keeps category suggestions aligned with native per-agent visibility", () => {
		const loaded = [
			loadedSkill("visible", "project"),
			loadedSkill("qa-manual-only", "project", { disableModelInvocation: true }),
			loadedSkill("metadata-manual-only", "user", { metadata: { "opencode/autoinvoke": "false" } }),
			loadedSkill("restricted", "project", { definition: { name: "restricted", description: "", template: "", agent: "explore" } }),
			loadedSkill("atlas-only", "project", { definition: { name: "atlas-only", description: "", template: "", agent: "atlas" } }),
			loadedSkill("security-review", "builtin"),
			loadedSkill("team-mode", "project"),
		]
		const available = loaded.map((skill) => ({ name: skill.name, description: "", location: "project" as const }))
		expect(filterV2CategoryReminderSkills(available, loaded, "sisyphus").map((skill) => skill.name)).toEqual([
			"visible",
			"team-mode",
		])
		expect(filterV2CategoryReminderSkills(available, loaded, "atlas").map((skill) => skill.name)).toEqual([
			"visible",
			"atlas-only",
			"team-mode",
		])
	})

	test("adds legacy retry guidance to native typed task failures without losing cause or metadata", async () => {
		const directory = await makeDirectory()
		const host = makeHarness(directory)
		const cleanup = await registerV2ConversationAdvisoryHooks(host.ctx, {} as OhMyOpenCodeConfig, dependencies())
		const cause = new Error("native schema failure")
		const metadata = { field: "load_skills", preserve: true }
		const event = toolEvent({
			tool: "task",
			status: "error",
			error: new NativeToolError({ message: "[ERROR] Invalid arguments: load_skills is required", error: cause, metadata }),
		})
		const original = event.error
		await host.runTool(event)
		expect(event.error).toBeInstanceOf(NativeToolError)
		expect(event.error).not.toBe(original)
		expect(event.error?.message).toContain(TASK_MARKER)
		expect(event.error?.message).toContain("Add load_skills=[]")
		expect(event.error?.error).toBe(cause)
		expect(event.error?.metadata).toEqual(metadata)
		await host.runTool(event)
		expect(event.error?.message.split(TASK_MARKER)).toHaveLength(2)
		await cleanup()
	})

	test("recognizes unprefixed native missing-agent errors but does not infer failures from successful prose", async () => {
		const directory = await makeDirectory()
		const host = makeHarness(directory)
		const cleanup = await registerV2ConversationAdvisoryHooks(host.ctx, {} as OhMyOpenCodeConfig, dependencies())
		const cause = new Error('Unknown agent "missing-agent". Available subagents: explore.')
		const metadata = { nativeCode: "unknown_agent", sessionID: "ses_missing-agent" }
		const failed = toolEvent({
			tool: "task",
			status: "error",
			error: new NativeToolError({ message: cause.message, error: cause, metadata }),
		})
		await host.runTool(failed)
		expect(failed.error?.message).toContain(TASK_MARKER)
		expect(failed.error?.message).toContain("Use a valid agent from the Available agents list")
		expect(failed.error?.error).toBe(cause)
		expect(failed.error?.metadata).toEqual(metadata)

		const success = toolEvent({
			tool: "task",
			id: "successful-unknown-agent-prose",
			result: { content: 'The delegated task succeeded; its log mentioned Unknown agent "missing-agent".' },
		})
		await host.runTool(success)
		expect(success.result?.content).toBe('The delegated task succeeded; its log mentioned Unknown agent "missing-agent".')
		await cleanup()
	})

	test("adds guidance to completed task text only for a known legacy error and preserves native result fields", async () => {
		const directory = await makeDirectory()
		const host = makeHarness(directory)
		const cleanup = await registerV2ConversationAdvisoryHooks(host.ctx, {} as OhMyOpenCodeConfig, dependencies())
		const file = { type: "file", uri: "data:text/plain;base64,eA==", mime: "text/plain", name: "x.txt" } as const
		const output = { status: "completed", custom: "preserved" }
		const metadata = { sessionID: "ses_child", provider: { trace: "preserved" } }
		const content = [file, { type: "text", text: "[ERROR] Invalid arguments: category OR subagent_type" }] as const
		const event = toolEvent({ tool: "task", result: { content, output, metadata } })
		await host.runTool(event)
		expect(event.result?.output).toBe(output)
		expect(event.result?.metadata).toBe(metadata)
		expect(event.result?.content).toEqual([...content, expect.objectContaining({ type: "text", text: expect.stringContaining(TASK_MARKER) })])
		expect(contentText(event.result?.content)).toContain("Provide ONLY one of")

		const unrelated = toolEvent({ tool: "task", id: "unrelated", result: { content: "The user quoted [ERROR] but this is not a known task failure." } })
		await host.runTool(unrelated)
		expect(unrelated.result?.content).toBe("The user quoted [ERROR] but this is not a known task failure.")
		const nonTask = toolEvent({ tool: "shell", id: "non-task", result: { content: "[ERROR] Invalid arguments: load_skills" } })
		await host.runTool(nonTask)
		expect(nonTask.result?.content).toBe("[ERROR] Invalid arguments: load_skills")
		await cleanup()
	})

	test("queues one durable skill reminder for Sisyphus Junior and injects it once in primary context", async () => {
		const directory = await makeDirectory()
		const host = makeHarness(directory)
		const cleanup = await registerV2ConversationAdvisoryHooks(host.ctx, {} as OhMyOpenCodeConfig, dependencies())
		await host.subscribed
		for (const [index, tool] of ["read", "grep", "shell"].entries()) {
			await host.runTool(toolEvent({ tool, agent: "sisyphus-junior", id: `work-${index}`, sessionID: "ses-junior" }))
		}
		const first = contextInput("ses-junior", "sisyphus-junior")
		await host.runContext(first)
		expect(first.system.map((part) => part.text).join("\n")).toContain(CATEGORY_MARKER)
		expect(first.system.map((part) => part.text).join("\n")).toContain("frontend")
		expect(first.system.map((part) => part.text).join("\n")).toContain(buildReminderMessage(skills))

		const second = contextInput("ses-junior", "sisyphus-junior")
		await host.runContext(second)
		expect(second.system.map((part) => part.text).join("\n")).not.toContain(CATEGORY_MARKER)
		const stateKey = [...host.storage.values.keys()].find((key) => key.startsWith("oh-my-openagent:v2:category-skill-reminder:"))
		expect(stateKey).toBeDefined()
		expect(host.storage.values.get(stateKey!)).toMatchObject({ reminderShown: true, reminderPending: false, toolCallCount: 3 })
		await cleanup()
	})

	test("suppresses a pending reminder after successful task/subagent delegation, not after failure", async () => {
		const directory = await makeDirectory()
		const host = makeHarness(directory)
		const cleanup = await registerV2ConversationAdvisoryHooks(host.ctx, {} as OhMyOpenCodeConfig, dependencies())
		await host.subscribed
		for (const [index, tool] of ["read", "grep", "edit"].entries()) {
			await host.runTool(toolEvent({ tool, id: `queued-${index}`, sessionID: "ses-queued" }))
		}
		await host.runTool(toolEvent({ tool: "subagent", id: "failed-delegate", sessionID: "ses-queued", status: "error" }))
		const stillPending = contextInput("ses-queued")
		await host.runContext(stillPending)
		expect(stillPending.system.map((part) => part.text).join("\n")).toContain(CATEGORY_MARKER)

		for (const [index, tool] of ["read", "grep", "edit"].entries()) {
			await host.runTool(toolEvent({ tool, id: `more-${index}`, sessionID: "ses-delegated" }))
		}
		await host.runTool(toolEvent({ tool: "task", id: "successful-task", sessionID: "ses-delegated" }))
		const suppressed = contextInput("ses-delegated")
		await host.runContext(suppressed)
		expect(suppressed.system.map((part) => part.text).join("\n")).not.toContain(CATEGORY_MARKER)
		await cleanup()
	})

	test("honors independent disabled-hook gates and never resolves a disabled checker", async () => {
		const directory = await makeDirectory()
		const host = makeHarness(directory)
		let pathLookups = 0
		const deps = dependencies({
			commentChecker: {
				getPath: async () => { pathLookups += 1; return null },
				isPathUsable: (path): path is string => typeof path === "string",
				run: async () => ({ hasComments: false, message: "" }),
			},
		})
		const cleanup = await registerV2ConversationAdvisoryHooks(host.ctx, {
			disabled_hooks: ["category-skill-reminder", "delegate-task-retry", "comment-checker"],
		} as OhMyOpenCodeConfig, deps)
		expect(host.toolHandlers).toHaveLength(0)
		expect(host.contextHandlers).toHaveLength(0)
		await host.runTool(toolEvent({ tool: "write", id: "disabled-check", input: { path: "a.ts", content: "// sample" } }))
		expect(pathLookups).toBe(0)
		await cleanup()
	})

	test("checks successful native write/edit/patch and appends findings without changing structured result or media", async () => {
		const directory = await makeDirectory()
		const host = makeHarness(directory)
		const calls: HookInput[] = []
		const deps = dependencies({
			commentChecker: {
				getPath: async () => "/fixture/comment-checker",
				isPathUsable: (path): path is string => path === "/fixture/comment-checker",
				run: async (input) => {
					calls.push(input)
					return { hasComments: true, message: `finding:${input.tool_input.file_path}` }
				},
			},
		})
		const cleanup = await registerV2ConversationAdvisoryHooks(host.ctx, {
			comment_checker: { custom_prompt: "Use a project-specific review style." },
		} as OhMyOpenCodeConfig, deps)
		const media = { type: "file", uri: "data:text/plain;base64,eA==", mime: "text/plain", name: "kept.txt" } as const
		const output = { operation: "native", detail: 1 }
		const metadata = { native: { trace: "kept" } }
		const result: NativeToolResult = { content: [media, { type: "text", text: "tool output" }], output, metadata }
		const write = toolEvent({ tool: "write", id: "write", sessionID: "ses-write", input: { path: "src/a.ts", content: "// new" }, result })
		await host.runTool(write)
		expect(calls.at(-1)).toMatchObject({
			tool_name: "Write",
			cwd: directory,
			tool_input: { file_path: "src/a.ts", content: "// new" },
		})
		expect(calls.at(-1)?.tool_input).toEqual(expect.objectContaining({ file_path: "src/a.ts" }))
		expect(write.result?.output).toBe(output)
		expect(write.result?.metadata).toBe(metadata)
		expect(write.result?.content).toEqual(expect.arrayContaining([media]))
		expect(contentText(write.result?.content)).toContain(COMMENT_MARKER)

		const edit = toolEvent({ tool: "edit", id: "edit", sessionID: "ses-edit", input: { path: "src/b.ts", oldString: "x", newString: "// added\nx" } })
		await host.runTool(edit)
		expect(calls.at(-1)?.tool_input).toEqual({ file_path: "src/b.ts", old_string: "x", new_string: "// added\nx" })

		const patchText = "*** Begin Patch\n*** Update File: src/c.ts\n@@\n-old\n+// added\n*** End Patch"
		const patch = toolEvent({ tool: "patch", id: "patch", sessionID: "ses-patch", input: { patchText } })
		await host.runTool(patch)
		expect(calls.at(-1)?.tool_input).toEqual({ file_path: "src/c.ts", old_string: "old\n", new_string: "// added\n" })
		expect(calls.at(-1)?.hook_event_name).toBe("PostToolUse")
		expect(calls.at(-1)?.tool_input.file_path).toBe("src/c.ts")
		expect(calls.at(-1)?.tool_name).toBe("Edit")

		const nativePatchText = "*** Begin Patch\n*** Update File: src/native.ts\n@@\n-export const value = 1\n+// added native comment\n+export const value = 2\n*** End Patch"
		const nativePatch = toolEvent({
			tool: "apply_patch",
			id: "native-apply-patch",
			sessionID: "ses-native-patch",
			input: { patchText: nativePatchText },
			result: {
				content: "Success. Updated the following files:\nM src/native.ts",
				output: { applied: [{ type: "update", resource: "src/native.ts", target: "src/native.ts" }] },
				metadata: { files: [{ file: "src/native.ts", patch: "native diff payload" }], truncated: false },
			},
		})
		await host.runTool(nativePatch)
		expect(calls.at(-1)?.tool_input).toEqual({ file_path: "src/native.ts", old_string: "export const value = 1\n", new_string: "// added native comment\nexport const value = 2\n" })
		expect(contentText(nativePatch.result?.content)).toContain(COMMENT_MARKER)
		await cleanup()
	})

	test("does not run on failed mutations, skips malformed patches, and deduplicates one native call", async () => {
		const directory = await makeDirectory()
		const host = makeHarness(directory)
		let runs = 0
		const deps = dependencies({
			commentChecker: {
				getPath: async () => "/fixture/comment-checker",
				isPathUsable: (path): path is string => path === "/fixture/comment-checker",
				run: async () => { runs += 1; return { hasComments: true, message: "finding" } },
			},
		})
		const cleanup = await registerV2ConversationAdvisoryHooks(host.ctx, {} as OhMyOpenCodeConfig, deps)
		const failed = toolEvent({ tool: "write", id: "failed", status: "error", input: { path: "a.ts", content: "// bad" } })
		await host.runTool(failed)
		const malformed = toolEvent({ tool: "patch", id: "malformed", input: { patchText: "not an apply patch" } })
		await host.runTool(malformed)
		const duplicate = toolEvent({ tool: "edit", id: "same", sessionID: "ses-duplicate", input: { path: "b.ts", oldString: "x", newString: "// comment" } })
		await host.runTool(duplicate)
		const contentAfterFirst = duplicate.result?.content
		await host.runTool(duplicate)
		expect(runs).toBe(1)
		expect(duplicate.result?.content).toBe(contentAfterFirst)
		await cleanup()
	})

	test("a non-comment edit does not consume the warning window and unchanged comments are ignored", async () => {
		const directory = await makeDirectory()
		const host = makeHarness(directory)
		let runs = 0
		const deps = dependencies({
			commentChecker: {
				getPath: async () => "/fixture/comment-checker",
				isPathUsable: (path): path is string => path === "/fixture/comment-checker",
				run: async () => { runs += 1; return { hasComments: true, message: "finding" } },
			},
		})
		const cleanup = await registerV2ConversationAdvisoryHooks(host.ctx, {} as OhMyOpenCodeConfig, deps)
		const unchanged = toolEvent({
			tool: "edit",
			id: "unchanged-comment",
			sessionID: "ses-comment-gate",
			input: { path: "a.ts", oldString: "// Existing explanation\nconst x = 1", newString: "// Existing explanation\nconst x = 2" },
		})
		await host.runTool(unchanged)
		expect(runs).toBe(0)

		const noComment = toolEvent({
			tool: "edit",
			id: "no-comment",
			sessionID: "ses-comment-gate",
			input: { path: "a.ts", oldString: "const x = 1", newString: "const x = 2" },
		})
		await host.runTool(noComment)
		expect(runs).toBe(0)

		const newComment = toolEvent({
			tool: "edit",
			id: "new-comment",
			sessionID: "ses-comment-gate",
			input: { path: "a.ts", oldString: "const x = 2", newString: "// New explanation\nconst x = 2" },
		})
		await host.runTool(newComment)
		expect(runs).toBe(1)
		expect(contentText(newComment.result?.content)).toContain(COMMENT_MARKER)
		await cleanup()
	})

	test("does not append findings when session deletion races a pending checker run", async () => {
		const directory = await makeDirectory()
		let releaseRun!: () => void
		let markRunStarted!: () => void
		const runStarted = new Promise<void>((resolve) => { markRunStarted = resolve })
		const runGate = new Promise<void>((resolve) => { releaseRun = resolve })
		const host = makeHarness(directory)
		const cleanup = await registerV2ConversationAdvisoryHooks(host.ctx, {} as OhMyOpenCodeConfig, dependencies({
			commentChecker: {
				getPath: async () => "/fixture/comment-checker",
				isPathUsable: (path): path is string => path === "/fixture/comment-checker",
				run: async () => {
					markRunStarted()
					await runGate
					return { hasComments: true, message: "must not be appended after deletion" }
				},
			},
		}))
		await host.subscribed
		const event = toolEvent({
			tool: "write",
			id: "comment-delete-race",
			sessionID: "ses-comment-delete-race",
			input: { path: "a.ts", content: "// new comment" },
		})
		const originalContent = event.result?.content
		const work = host.runTool(event)
		await runStarted
		host.emit({ type: "session.deleted", location: { directory, workspaceID: "workspace-advisory" }, data: { sessionID: "ses-comment-delete-race" } })
		await new Promise((resolve) => setTimeout(resolve, 10))
		releaseRun()
		await work
		expect(event.result?.content).toBe(originalContent)
		expect(contentText(event.result?.content)).not.toContain(COMMENT_MARKER)
		await cleanup()
	})

	test("cleans session-scoped reminder state on matching session deletion", async () => {
		const directory = await makeDirectory()
		const host = makeHarness(directory)
		const cleanup = await registerV2ConversationAdvisoryHooks(host.ctx, {} as OhMyOpenCodeConfig, dependencies())
		await host.subscribed
		for (const [index, tool] of ["read", "grep", "glob"].entries()) {
			await host.runTool(toolEvent({ tool, id: `delete-${index}`, sessionID: "ses-delete" }))
		}
		const categoryStorageKey = [...host.storage.values.keys()].find((key) => key.includes(encodeURIComponent("ses-delete")))
		expect(categoryStorageKey).toBeDefined()
		host.emit({ type: "session.deleted", location: { directory, workspaceID: "workspace-advisory" }, data: { sessionID: "ses-delete" } })
		await new Promise((resolve) => setTimeout(resolve, 10))
		expect(host.storage.values.has(categoryStorageKey!)).toBe(false)
		await cleanup()
		expect(host.disposed.length).toBeGreaterThan(0)
	})

	test("does not commit category tool state when deletion races a pending storage read", async () => {
		const directory = await makeDirectory()
		const storage = makeStorage()
		let releaseRead!: () => void
		let markReadStarted!: () => void
		const readStarted = new Promise<void>((resolve) => { markReadStarted = resolve })
		const readGate = new Promise<void>((resolve) => { releaseRead = resolve })
		let holdFirstRead = true
		const originalGet = storage.get
		storage.get = async (key: string) => {
			if (holdFirstRead && key.startsWith("oh-my-openagent:v2:category-skill-reminder:")) {
				holdFirstRead = false
				markReadStarted()
				await readGate
			}
			return originalGet(key)
		}
		const host = makeHarness(directory, storage)
		const cleanup = await registerV2ConversationAdvisoryHooks(host.ctx, {} as OhMyOpenCodeConfig, dependencies())
		await host.subscribed
		const work = host.runTool(toolEvent({ tool: "read", id: "read-racing-delete", sessionID: "ses-racing-delete" }))
		await readStarted
		host.emit({ type: "session.deleted", location: { directory, workspaceID: "workspace-advisory" }, data: { sessionID: "ses-racing-delete" } })
		await new Promise((resolve) => setTimeout(resolve, 10))
		releaseRead()
		await work
		await new Promise((resolve) => setTimeout(resolve, 10))
		expect(storage.values.size).toBe(0)
		await cleanup()
	})

	test("does not inject a reminder when deletion races the asynchronous skill lookup", async () => {
		const directory = await makeDirectory()
		let releaseSkills!: () => void
		let markSkillsStarted!: () => void
		const skillsStarted = new Promise<void>((resolve) => { markSkillsStarted = resolve })
		const skillsGate = new Promise<void>((resolve) => { releaseSkills = resolve })
		const host = makeHarness(directory)
		const cleanup = await registerV2ConversationAdvisoryHooks(host.ctx, {} as OhMyOpenCodeConfig, dependencies({
			loadAvailableSkills: async () => {
				markSkillsStarted()
				await skillsGate
				return skills
			},
		}))
		await host.subscribed
		for (const [index, tool] of ["read", "grep", "shell"].entries()) {
			await host.runTool(toolEvent({ tool, id: `delete-race-${index}`, sessionID: "ses-context-delete-race" }))
		}
		const input = contextInput("ses-context-delete-race")
		const contextWork = host.runContext(input)
		await skillsStarted
		host.emit({ type: "session.deleted", location: { directory, workspaceID: "workspace-advisory" }, data: { sessionID: "ses-context-delete-race" } })
		await new Promise((resolve) => setTimeout(resolve, 10))
		releaseSkills()
		await contextWork
		await new Promise((resolve) => setTimeout(resolve, 10))
		expect(input.system.map((part) => part.text).join("\n")).not.toContain(CATEGORY_MARKER)
		expect([...host.storage.values.keys()].some((key) => key.includes("ses-context-delete-race"))).toBe(false)
		await cleanup()
	})

	test("does not mutate context after cleanup begins during the skill lookup", async () => {
		const directory = await makeDirectory()
		let releaseSkills!: () => void
		let markSkillsStarted!: () => void
		const skillsStarted = new Promise<void>((resolve) => { markSkillsStarted = resolve })
		const skillsGate = new Promise<void>((resolve) => { releaseSkills = resolve })
		const host = makeHarness(directory)
		const cleanup = await registerV2ConversationAdvisoryHooks(host.ctx, {} as OhMyOpenCodeConfig, dependencies({
			loadAvailableSkills: async () => {
				markSkillsStarted()
				await skillsGate
				return skills
			},
		}))
		for (const [index, tool] of ["read", "grep", "shell"].entries()) {
			await host.runTool(toolEvent({ tool, id: `cleanup-race-${index}`, sessionID: "ses-context-cleanup-race" }))
		}
		const input = contextInput("ses-context-cleanup-race")
		const contextWork = host.runContext(input)
		await skillsStarted
		const cleanupWork = cleanup()
		releaseSkills()
		await Promise.all([contextWork, cleanupWork])
		expect(input.system.map((part) => part.text).join("\n")).not.toContain(CATEGORY_MARKER)
	})

	test("unwinds already registered advisory hooks when a later hook registration fails", async () => {
		const directory = await makeDirectory()
		const host = makeHarness(directory, makeStorage(), 2)
		await expect(registerV2ConversationAdvisoryHooks(host.ctx, {} as OhMyOpenCodeConfig, dependencies()))
			.rejects.toThrow("tool registration failed at 2")
		expect(host.disposed).toEqual(["execute.after:1", "session:context"])
	})

	test("category-disabled sessions receive no reminder while task guidance remains independently enabled", async () => {
		const directory = await makeDirectory()
		const host = makeHarness(directory)
		const cleanup = await registerV2ConversationAdvisoryHooks(host.ctx, {
			disabled_hooks: ["category-skill-reminder"],
		} as OhMyOpenCodeConfig, dependencies())
		const failure = toolEvent({
			tool: "task",
			id: "still-guided",
			status: "error",
			error: new NativeToolError({ message: "[ERROR] Invalid arguments: Unknown category" }),
		})
		await host.runTool(failure)
		expect(failure.error?.message).toContain(TASK_MARKER)
		expect(host.contextHandlers).toHaveLength(0)
		await cleanup()
	})
})
