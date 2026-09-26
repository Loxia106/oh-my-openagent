import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Plugin } from "@opencode/plugin"
import type { SessionContext, SessionPrompt } from "@opencode/plugin/promise/session"
import type { OhMyOpenCodeConfig } from "../config"
import { getUltraworkMessage, TEAM_MESSAGE } from "../hooks/keyword-detector/constants"
import { registerV2ContextHooks } from "./context-hooks"
import { registerV2Hooks } from "./hooks"

const roots: string[] = []
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function mockContext(directory: string, failContextHook = false, toolNames: string[] = []) {
	const callbacks = new Map<string, (input: any) => unknown>()
	const disposed: string[] = []
	const ctx = {
		location: { directory },
		storage: { get: async () => undefined, set: async () => undefined, remove: async () => undefined },
		session: {
			hook: async (name: string, callback: (input: any) => unknown) => {
				if (failContextHook && name === "context") throw new Error("context registration failure")
				callbacks.set(name, callback)
				return { dispose: async () => { disposed.push(name) } }
			},
		},
		permission: { hook: async () => { throw new Error("permission registration failure") } },
		tool: { list: async () => toolNames.map((id) => ({ id })), hook: async () => ({ dispose: async () => undefined }) },
		command: { transform: async () => ({ dispose: async () => undefined }) },
		mcp: { transform: async () => ({ dispose: async () => undefined }) },
		skill: { transform: async () => ({ dispose: async () => undefined }) },
		toolRegistry: { register: async () => ({ dispose: async () => undefined }) },
		event: { subscribe: async function* () { await new Promise<void>((resolve) => setTimeout(resolve, 1)) } },
		agent: {
			get: async () => ({ data: { request: { settings: { temperature: 0.23, topP: 0.61, maxTokens: 317 } } } }),
			transform: async () => ({ dispose: async () => undefined }),
		},
	}
	return { ctx: ctx as unknown as Plugin.Context, callbacks, disposed }
}

function contextInput(sessionID = "ses-context-test"): SessionContext {
	return {
		sessionID,
		agent: "sisyphus",
		model: { id: "openai/mock" },
		messages: [{ role: "user", content: "Please help with this task" }],
		system: [{ type: "text", text: "base system" }],
		tools: { read: {}, write: {} },
		options: {},
	} as unknown as SessionContext
}

describe("native v2 context hooks", () => {
	test("does not inject default ultrawork when the keyword detector hook is disabled", async () => {
		const directory = await mkdtemp(join(tmpdir(), "omo-v2-context-test-"))
		roots.push(directory)
		const { ctx, callbacks } = mockContext(directory)
		const cleanup = await registerV2ContextHooks(ctx, {
			default_mode: { ultrawork: true },
			disabled_hooks: ["keyword-detector"],
		} as unknown as OhMyOpenCodeConfig)

		const input = contextInput()
		await callbacks.get("context")?.(input)
		expect(input.system.map((part) => part.text)).toEqual(["base system"])
		expect(callbacks.has("prompt")).toBe(false)
		await cleanup()
	})

	test("adds native system context for the configured default ultrawork mode", async () => {
		const directory = await mkdtemp(join(tmpdir(), "omo-v2-context-test-"))
		roots.push(directory)
		const { ctx, callbacks } = mockContext(directory)
		const cleanup = await registerV2ContextHooks(ctx, {
			default_mode: { ultrawork: true },
		} as unknown as OhMyOpenCodeConfig)

		const input = contextInput()
		await callbacks.get("context")?.(input)
		expect(input.system.map((part) => part.text)).toContain(getUltraworkMessage("sisyphus", "openai/mock"))
		await cleanup()
	})

	test("does not infer OMO team mode from matching tool names owned by another plugin", async () => {
		const directory = await mkdtemp(join(tmpdir(), "omo-v2-context-test-"))
		roots.push(directory)
		const { ctx, callbacks } = mockContext(directory, false, [
			"team_create", "team_delete", "team_shutdown_request", "team_approve_shutdown", "team_reject_shutdown",
			"team_send_message", "team_task_create", "team_task_list", "team_task_update", "team_task_get", "team_status", "team_list",
		])
		const cleanup = await registerV2ContextHooks(ctx, {
			team_mode: { enabled: true },
		} as unknown as OhMyOpenCodeConfig)

		const input = contextInput()
		input.messages = [{ role: "user", content: "Use team-mode for this task." }] as never
		await callbacks.get("context")?.(input)
		expect(input.system.map((part) => part.text)).not.toContain(TEAM_MESSAGE)
		await cleanup()
	})

	test("applies configured native agent request settings to the model context", async () => {
		const directory = await mkdtemp(join(tmpdir(), "omo-v2-context-test-"))
		roots.push(directory)
		const { ctx, callbacks } = mockContext(directory)
		const cleanup = await registerV2ContextHooks(ctx, {} as OhMyOpenCodeConfig)

		const input = contextInput()
		await callbacks.get("context")?.(input)
		expect(input.options).toMatchObject({ temperature: 0.23, topP: 0.61, maxTokens: 317 })
		await cleanup()
	})

	test("omits arbitrary disabled native tools from the model context", async () => {
		const directory = await mkdtemp(join(tmpdir(), "omo-v2-context-test-"))
		roots.push(directory)
		const { ctx, callbacks } = mockContext(directory)
		const cleanup = await registerV2ContextHooks(ctx, { disabled_tools: ["grep", "webfetch"] } as unknown as OhMyOpenCodeConfig)
		const input = contextInput()
		input.tools = { grep: {}, webfetch: {}, write: {} }
		await callbacks.get("context")?.(input)
		expect(input.tools).toEqual({ write: {} })
		await cleanup()
	})

	test("unwinds the first native registration when a later context hook registration fails", async () => {
		const directory = await mkdtemp(join(tmpdir(), "omo-v2-context-test-"))
		roots.push(directory)
		const { ctx, disposed } = mockContext(directory, true)
		await expect(registerV2ContextHooks(ctx, {} as OhMyOpenCodeConfig)).rejects.toThrow("context registration failure")
		expect(disposed).toEqual(["prompt"])
	})

	test("unwinds context hooks if a later native permission-hook registration fails", async () => {
		const directory = await mkdtemp(join(tmpdir(), "omo-v2-context-test-"))
		roots.push(directory)
		const { ctx, disposed } = mockContext(directory)
		await expect(registerV2Hooks(ctx, {} as OhMyOpenCodeConfig)).rejects.toThrow("permission registration failure")
		expect(disposed).toEqual(["context", "prompt"])
	})
})
