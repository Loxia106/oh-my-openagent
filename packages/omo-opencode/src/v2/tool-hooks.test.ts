import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Plugin } from "@opencode/plugin"
import { Error as ToolError } from "@opencode/plugin/promise/tool"
import type { OhMyOpenCodeConfig } from "../config"
import { NON_INTERACTIVE_ENV } from "../hooks/non-interactive-env/constants"
import { NOTEPAD_DIRECTIVE } from "../hooks/sisyphus-junior-notepad/constants"
import { computeLineHash } from "../tools/hashline-edit/hash-computation"
import { registerV2ToolHooks } from "./tool-hooks"

const roots: string[] = []
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function mockContext(directory: string, failRegistration?: string) {
	let permissionCallback: ((event: any) => unknown) | undefined
	const toolCallbacks = new Map<string, Array<(event: any) => unknown>>()
	const shellCallbacks: Array<(event: any) => unknown> = []
	const disposed: string[] = []
	const counts = new Map<string, number>()
	const register = (key: string, callback: (event: any) => unknown, callbacks: Array<(event: any) => unknown>) => {
		const ordinal = (counts.get(key) ?? 0) + 1
		counts.set(key, ordinal)
		if (failRegistration === `${key}:${ordinal}`) throw new Error(`${key} hook registration failure`)
		callbacks.push(callback)
		return { dispose: async () => { disposed.push(`${key}:${ordinal}`) } }
	}
	const ctx = {
		location: { directory },
		permission: {
			hook: async (_name: string, callback: (event: any) => unknown) => {
				permissionCallback = callback
				return { dispose: async () => { disposed.push("permission:evaluate") } }
			},
		},
		shell: {
			hook: async (name: string, callback: (event: any) => unknown) => register(`shell:${name}`, callback, shellCallbacks),
		},
		tool: {
			hook: async (name: string, callback: (event: any) => unknown) => {
				const key = `tool:${name}`
				const callbacks = toolCallbacks.get(name) ?? []
				toolCallbacks.set(name, callbacks)
				return register(key, callback, callbacks)
			},
		},
	}
	return {
		ctx: ctx as unknown as Plugin.Context,
		permissionCallback: () => permissionCallback,
		toolCallback: (name: string, index = 0) => toolCallbacks.get(name)?.[index],
		toolCallbackCount: (name: string) => toolCallbacks.get(name)?.length ?? 0,
		shellCallback: (index = 0) => shellCallbacks[index],
		shellCallbackCount: () => shellCallbacks.length,
		disposed,
	}
}

describe("native v2 tool hooks", () => {
	test("blocks Prometheus edit permission for paths outside workspace .omo Markdown", async () => {
		const directory = await mkdtemp(join(tmpdir(), "omo-v2-tools-test-"))
		roots.push(directory)
		const omo = join(directory, ".omo")
		await mkdir(omo)
		const approved = join(omo, "plan.md")
		const outside = join(directory, "notes.md")
		await writeFile(approved, "# Plan\n")
		await writeFile(outside, "# Outside\n")
		const { ctx, permissionCallback } = mockContext(directory)
		const cleanup = await registerV2ToolHooks(ctx, {} as OhMyOpenCodeConfig)
		const callback = permissionCallback()
		expect(callback).toBeDefined()

		const allowed = { agent: "prometheus", action: "edit", resources: [approved], effect: "allow" }
		await callback?.(allowed)
		expect(allowed.effect).toBe("allow")
		const denied = { agent: "prometheus", action: "edit", resources: [outside], effect: "allow" }
		await callback?.(denied)
		expect(denied.effect).toBe("deny")
		expect(denied.message).toContain("Prometheus may edit only Markdown files")
		const unrelatedAgent = { agent: "custom-prometheus-helper", action: "edit", resources: [outside], effect: "allow" }
		await callback?.(unrelatedAgent)
		expect(unrelatedAgent.effect).toBe("allow")
		await cleanup()
	})

	test("rejects an in-workspace .omo Markdown symlink that escapes the workspace", async () => {
		const directory = await mkdtemp(join(tmpdir(), "omo-v2-tools-test-"))
		roots.push(directory)
		const omo = join(directory, ".omo")
		await mkdir(omo)
		const outside = join(directory, "outside.md")
		const link = join(omo, "plan.md")
		await writeFile(outside, "# Outside\n")
		await symlink(outside, link)
		const { ctx, permissionCallback } = mockContext(directory)
		const cleanup = await registerV2ToolHooks(ctx, {} as OhMyOpenCodeConfig)
		const denied = { agent: "prometheus", action: "edit", resources: [link], effect: "allow" }
		await permissionCallback()?.(denied)
		expect(denied.effect).toBe("deny")
		await cleanup()
	})

	test("adds hashline IDs to native read output while preserving its structure", async () => {
		const directory = await mkdtemp(join(tmpdir(), "omo-v2-tools-test-"))
		roots.push(directory)
		const { ctx, toolCallback } = mockContext(directory)
		const cleanup = await registerV2ToolHooks(ctx, { hashline_edit: true } as OhMyOpenCodeConfig)
		const callback = toolCallback("execute.after")
		expect(callback).toBeDefined()
		const original = {
			status: "completed",
			tool: "read",
			result: { title: "Read", content: [{ type: "text", text: "Read file /tmp/sample.txt, lines 1-1\n1: alpha" }], extra: "kept" },
		}
		await callback?.(original)
		expect(original.result.extra).toBe("kept")
		expect(original.result.content[0]?.text).toBe(`Read file /tmp/sample.txt, lines 1-1\n1#${computeLineHash(1, "alpha")}|alpha`)
		await writeFile(join(directory, "written.txt"), "one\ntwo\nthree")
		const written = { status: "completed", tool: "write", input: { filePath: "written.txt", content: "x" }, result: { content: [{ type: "text", text: "Wrote file" }], metadata: { kept: true } } }
		await callback?.(written)
		expect(written.result.content).toEqual([{ type: "text", text: "File written successfully. 3 lines written." }])
		expect(written.result.metadata).toEqual({ kept: true })
		await cleanup()
	})

	test("unwinds the permission registration when a later read hook registration fails", async () => {
		const directory = await mkdtemp(join(tmpdir(), "omo-v2-tools-test-"))
		roots.push(directory)
		const { ctx, disposed } = mockContext(directory, "tool:execute.after:2")
		await expect(registerV2ToolHooks(ctx, { hashline_edit: true } as OhMyOpenCodeConfig)).rejects.toThrow("tool:execute.after hook registration failure")
		expect(disposed).toEqual([
			"tool:execute.after:1",
			"tool:execute.before:2",
			"tool:execute.before:1",
			"shell:create.before:1",
			"permission:evaluate",
		])
	})

	test("adds the shared noninteractive environment only to git shell commands without changing other invocation fields", async () => {
		const directory = await mkdtemp(join(tmpdir(), "omo-v2-tools-test-"))
		roots.push(directory)
		const { ctx, shellCallback } = mockContext(directory)
		const cleanup = await registerV2ToolHooks(ctx, {} as OhMyOpenCodeConfig)
		const callback = shellCallback()
		expect(callback).toBeDefined()
		const event = { command: "git status --short", cwd: "/repo", shell: "/bin/zsh", timeout: 1234, env: { GIT_EDITOR: "custom", SENTINEL: "kept" } }
		await callback?.(event)
		expect(event.env).toEqual({ ...NON_INTERACTIVE_ENV, SENTINEL: "kept" })
		expect(event).toMatchObject({ command: "git status --short", cwd: "/repo", shell: "/bin/zsh", timeout: 1234 })
		const nonGit = { command: "npm test", cwd: "/repo", shell: "/bin/zsh", timeout: 8, env: { SENTINEL: "same" } }
		await callback?.(nonGit)
		expect(nonGit).toEqual({ command: "npm test", cwd: "/repo", shell: "/bin/zsh", timeout: 8, env: { SENTINEL: "same" } })
		await cleanup()
	})

	test("converts the pure append-only notepad decision into a native Tool.Error before write execution", async () => {
		const directory = await mkdtemp(join(tmpdir(), "omo-v2-tools-test-"))
		roots.push(directory)
		const { ctx, toolCallback } = mockContext(directory)
		const cleanup = await registerV2ToolHooks(ctx, {} as OhMyOpenCodeConfig)
		const callback = toolCallback("execute.before", 0)
		expect(callback).toBeDefined()
		const blocked = { tool: "write", agent: "sisyphus-junior", sessionID: "ses_test", input: { path: ".omo/notepads/plan/issues.md", content: "new note" } }
		let thrown: unknown
		try { await callback?.(blocked) } catch (error) { thrown = error }
		expect(thrown).toBeInstanceOf(ToolError)
		expect((thrown as Error).message).toContain("append-only")
		const allowed = { tool: "write", agent: "sisyphus-junior", sessionID: "ses_test", input: { path: ".omo/plans/plan.md", content: "plan" } }
		await expect(callback?.(allowed)).resolves.toBeUndefined()
		await cleanup()
	})

	test("adds the notepad directive once only to native task calls from Atlas", async () => {
		const directory = await mkdtemp(join(tmpdir(), "omo-v2-tools-test-"))
		roots.push(directory)
		const { ctx, toolCallback } = mockContext(directory)
		const cleanup = await registerV2ToolHooks(ctx, {} as OhMyOpenCodeConfig)
		const callback = toolCallback("execute.before", 1)
		expect(callback).toBeDefined()
		const input = { prompt: "Inspect this bounded task." }
		const event = { tool: "task", agent: "atlas", sessionID: "ses_parent", input }
		await callback?.(event)
		expect(event.input).not.toBe(input)
		expect(event.input.prompt).toBe(`${NOTEPAD_DIRECTIVE}${input.prompt}`)
		const injected = event.input.prompt
		await callback?.(event)
		expect(event.input.prompt).toBe(injected)
		const unrelated = { tool: "task", agent: "sisyphus", input: { prompt: "Leave untouched" } }
		await callback?.(unrelated)
		expect(unrelated.input.prompt).toBe("Leave untouched")
		await cleanup()
	})

	test("appends task resume guidance only from successful native metadata and preserves content, output, and metadata", async () => {
		const directory = await mkdtemp(join(tmpdir(), "omo-v2-tools-test-"))
		roots.push(directory)
		const { ctx, toolCallback } = mockContext(directory)
		const cleanup = await registerV2ToolHooks(ctx, { hashline_edit: true } as OhMyOpenCodeConfig)
		const callback = toolCallback("execute.after", 1)
		expect(callback).toBeDefined()
		const textPart = { type: "text", text: "Child completed." }
		const filePart = { type: "file", uri: "file:///tmp/result.md", mime: "text/markdown", name: "result.md" }
		const metadata = { sessionID: "ses_realChild123", status: "completed", extra: "preserved" }
		const output = { title: "Child", output: "raw output preserved", content: [textPart, filePart], metadata }
		const event = { status: "completed", tool: "task", input: { category: "quick" }, result: output }
		await callback?.(event)
		expect(event.result.output).toBe("raw output preserved")
		expect(event.result.metadata).toBe(metadata)
		expect(event.result.content.slice(0, 2)).toEqual([textPart, filePart])
		expect(event.result.content[2]).toEqual({ type: "text", text: 'to continue: task(task_id="ses_realChild123", prompt="...")' })

		const noMetadata = { status: "completed", tool: "task", input: {}, result: { content: "The child mentioned ses_fake999 but has no native metadata." } }
		await callback?.(noMetadata)
		expect(noMetadata.result.content).toBe("The child mentioned ses_fake999 but has no native metadata.")
		const wrongID = { status: "completed", tool: "task", input: { task_id: "ses_other" }, result: { content: "Child output", metadata: { sessionID: "ses_realChild123", status: "completed" } } }
		await callback?.(wrongID)
		expect(wrongID.result.content).toBe("Child output")
		const failed = { status: "completed", tool: "task", input: {}, result: { content: "Child failed.", metadata: { sessionID: "ses_failed123", status: "failed" } } }
		await callback?.(failed)
		expect(failed.result.content).toBe("Child failed.")
		const delegated = { status: "completed", tool: "call_omo_agent", input: { session_id: "ses_realChild123" }, result: { content: [{ type: "text", text: "Explore completed." }], metadata: { sessionID: "ses_realChild123", status: "completed" } } }
		await callback?.(delegated)
		expect(delegated.result.content).toEqual([
			{ type: "text", text: "Explore completed." },
			{ type: "text", text: 'to continue: task(task_id="ses_realChild123", prompt="...")' },
		])
		const toolError = { status: "error", tool: "task", input: {}, error: new ToolError({ message: "No child" }) }
		await callback?.(toolError)
		await cleanup()
	})

	test("does not suggest a task resume route when OMO task is disabled", async () => {
		const directory = await mkdtemp(join(tmpdir(), "omo-v2-tools-test-"))
		roots.push(directory)
		const { ctx, toolCallback } = mockContext(directory)
		const cleanup = await registerV2ToolHooks(ctx, { disabled_tools: ["task"] } as OhMyOpenCodeConfig)
		const callback = toolCallback("execute.after", 0)
		expect(callback).toBeDefined()
		const result = { content: "Explore completed.", metadata: { sessionID: "ses_nativeChild", status: "completed" } }
		const event = { status: "completed", tool: "call_omo_agent", input: { subagent_type: "explore" }, result }
		await callback?.(event)
		expect(event.result).toBe(result)
		expect(event.result.content).toBe("Explore completed.")
		await cleanup()
	})

	test("honors the four native hook disable switches independently", async () => {
		const directory = await mkdtemp(join(tmpdir(), "omo-v2-tools-test-"))
		roots.push(directory)
		const { ctx, permissionCallback, toolCallbackCount, shellCallbackCount } = mockContext(directory)
		const cleanup = await registerV2ToolHooks(ctx, { disabled_hooks: [
			"non-interactive-env", "notepad-write-guard", "sisyphus-junior-notepad", "task-resume-info",
		] } as OhMyOpenCodeConfig)
		expect(permissionCallback()).toBeDefined()
		expect(shellCallbackCount()).toBe(0)
		expect(toolCallbackCount("execute.before")).toBe(0)
		expect(toolCallbackCount("execute.after")).toBe(0)
		await cleanup()
	})
})
