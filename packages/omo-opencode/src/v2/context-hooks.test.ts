import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Plugin } from "@opencode/plugin"
import type { SessionContext, SessionPrompt } from "@opencode/plugin/promise/session"
import type { OhMyOpenCodeConfig } from "../config"
import { getHyperplanUltraworkMessage, getUltraworkMessage, HYPERPLAN_MESSAGE, TEAM_MESSAGE } from "../hooks/keyword-detector/constants"
import { registerV2ContextHooks } from "./context-hooks"
import { registerV2Hooks } from "./hooks"
import { createV2DelegationSettings } from "./delegation-settings"
import { V2_HYPERPLAN_MODE_PROMPT } from "./team-skill-adapter"

const roots: string[] = []
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function mockContext(
	directory: string,
	failContextHook = false,
	toolNames: string[] = [],
	requests: Record<string, { settings?: Record<string, unknown>; body?: Record<string, unknown> }> = {},
	sessionRows: Record<string, Record<string, unknown>> = {},
) {
	const callbacks = new Map<string, (input: any) => unknown>()
	const disposed: string[] = []
	const agentGets: string[] = []
	const storageValues = new Map<string, unknown>()
	const sessions = new Map(Object.entries({
		"ses-context-test": { id: "ses-context-test", agent: "sisyphus", projectID: "project", location: { directory } },
		"ses-native-build": { id: "ses-native-build", agent: "build", projectID: "project", location: { directory } },
		"ses-native-plan": { id: "ses-native-plan", agent: "plan", projectID: "project", location: { directory } },
		...sessionRows,
	}))
	const storage = {
		get: async (key: string) => storageValues.get(key) as never,
		set: async (key: string, value: unknown) => { storageValues.set(key, value) },
		remove: async (key: string) => { storageValues.delete(key) },
		scan: async () => ({ entries: [] }),
	}
	const ctx = {
		location: { directory, project: { id: "project" } },
		storage,
		session: {
			get: async ({ sessionID }: { sessionID: string }) => {
				const session = sessions.get(sessionID)
				if (!session) throw new Error(`Unknown session ${sessionID}`)
				return session
			},
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
			get: async ({ agentID }: { agentID: string }) => {
				agentGets.push(agentID)
				return { data: { request: requests[agentID] ?? { settings: { temperature: 0.23, topP: 0.61, maxTokens: 317 } } } }
			},
			transform: async () => ({ dispose: async () => undefined }),
		},
	}
	return { ctx: ctx as unknown as Plugin.Context, callbacks, disposed, agentGets, storage, storageValues, sessions }
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

	test("explains that Hyperplan orchestration is unavailable instead of injecting team instructions", async () => {
		const directory = await mkdtemp(join(tmpdir(), "omo-v2-context-test-"))
		roots.push(directory)
		const { ctx, callbacks } = mockContext(directory)
		const cleanup = await registerV2ContextHooks(ctx, {} as OhMyOpenCodeConfig)

		const input = contextInput()
		input.messages = [{ role: "user", content: "Use hyperplan for this task." }] as never
		await callbacks.get("context")?.(input)
		const system = input.system.map((part) => part.text).join("\n")

		expect(system).toContain("Hyperplan")
		expect(system).toContain("team_mode.enabled: true")
		expect(system).toContain("Do not load")
		expect(system).not.toContain(HYPERPLAN_MESSAGE)
		expect(system).not.toContain("team_create")
		await cleanup()
	})

	test("preserves explicit ultrawork while reporting unsupported Hyperplan in the combined mode", async () => {
		const directory = await mkdtemp(join(tmpdir(), "omo-v2-context-test-"))
		roots.push(directory)
		const { ctx, callbacks } = mockContext(directory)
		const cleanup = await registerV2ContextHooks(ctx, {} as OhMyOpenCodeConfig)

		const input = contextInput()
		input.messages = [{ role: "user", content: "Use hyperplan ultrawork for this task." }] as never
		await callbacks.get("context")?.(input)
		const system = input.system.map((part) => part.text).join("\n")

		expect(system).toContain("Hyperplan")
		expect(system).toContain("team_mode.enabled: true")
		expect(system).toContain(getUltraworkMessage("sisyphus", "openai/mock"))
		expect(system).not.toContain(HYPERPLAN_MESSAGE)
		expect(system).not.toContain("<hyperplan-ultrawork-mode>")
		await cleanup()
	})

	test("enables native Hyperplan instructions only after its own Team manager started", async () => {
		const directory = await mkdtemp(join(tmpdir(), "omo-v2-team-context-"))
		roots.push(directory)
		const { ctx, callbacks } = mockContext(directory)
		const cleanup = await registerV2ContextHooks(ctx, {
			team_mode: { enabled: true },
			default_mode: { ultrawork: true },
		} as OhMyOpenCodeConfig, { teamModeAvailable: true })
		const input = contextInput()
		input.messages = [{ role: "user", content: "Use hyperplan ultrawork team-mode for this task." }] as never
		await callbacks.get("context")?.(input)
		const system = input.system.map((part) => part.text)
		expect(system).toContain(getHyperplanUltraworkMessage("sisyphus", "openai/mock"))
		expect(system).toContain(TEAM_MESSAGE)
		expect(system).not.toContain(getUltraworkMessage("sisyphus", "openai/mock"))
		expect(system.join("\n")).not.toContain("<native-mode-compatibility>")
		await cleanup()
	})

	test("keeps independently mentioned Hyperplan and Ultrawork out of the strict combo banner", async () => {
		const directory = await mkdtemp(join(tmpdir(), "omo-v2-team-context-"))
		roots.push(directory)
		const { ctx, callbacks } = mockContext(directory)
		const cleanup = await registerV2ContextHooks(ctx, { team_mode: { enabled: true } } as OhMyOpenCodeConfig, { teamModeAvailable: true })
		const input = contextInput()
		input.messages = [{ role: "user", content: "Use hyperplan for review. Later use ultrawork for execution." }] as never
		await callbacks.get("context")?.(input)
		const system = input.system.map((part) => part.text)
		expect(system).toContain(V2_HYPERPLAN_MODE_PROMPT)
		expect(system).toContain(getUltraworkMessage("sisyphus", "openai/mock"))
		expect(system).not.toContain(getHyperplanUltraworkMessage("sisyphus", "openai/mock"))
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

	test("applies request settings to a custom api-builder and retains its OMO mode behavior", async () => {
		const directory = await mkdtemp(join(tmpdir(), "omo-v2-context-test-"))
		roots.push(directory)
		const { ctx, callbacks, agentGets } = mockContext(directory, false, [], {
			"api-builder": { settings: { temperature: 0.42, reasoningEffort: "high" } },
		})
		const cleanup = await registerV2ContextHooks(ctx, {
			default_mode: { ultrawork: true },
		} as unknown as OhMyOpenCodeConfig)

		const input = contextInput()
		input.agent = "api-builder" as never
		await callbacks.get("context")?.(input)

		expect(agentGets).toContain("api-builder")
		expect(input.options).toMatchObject({ temperature: 0.42, reasoningEffort: "high" })
		expect(input.system.map((part) => part.text)).toContain(getUltraworkMessage("api-builder", "openai/mock"))
		await cleanup()
	})

	test("applies durable selection only to the matching child session and after its base agent settings", async () => {
		const directory = await mkdtemp(join(tmpdir(), "omo-v2-context-test-"))
		roots.push(directory)
		const { ctx, callbacks, sessions } = mockContext(directory, false, [], {
			"sisyphus-junior": { settings: { temperature: 0.2, reasoningEffort: "low" } },
		}, {
			"ses-selected-child": {
				id: "ses-selected-child", parentID: "ses-parent", agent: "sisyphus-junior",
				projectID: "project", location: { directory },
			},
			"ses-sibling": {
				id: "ses-sibling", parentID: "ses-parent", agent: "sisyphus-junior",
				projectID: "project", location: { directory },
			},
		})
		const settings = createV2DelegationSettings(ctx.storage, ctx.location)
		await settings.write({
			sessionID: "ses-selected-child",
			parentSessionID: "ses-parent",
			agentID: "sisyphus-junior",
			model: { providerID: "openai", id: "selected-model", variant: "high" },
			settings: { temperature: 0.7, reasoningEffort: "high", topP: 0.83 },
		})
		const cleanup = await registerV2ContextHooks(ctx, {} as OhMyOpenCodeConfig)

		const selectedChild = contextInput("ses-selected-child")
		selectedChild.agent = "sisyphus-junior" as never
		selectedChild.messages = [{ role: "user", content: "Use ultrawork and team-mode for this task" }] as never
		selectedChild.model = { providerID: "openai", id: "selected-model", variant: "high" } as never
		await callbacks.get("context")?.(selectedChild)
		expect(selectedChild.options).toMatchObject({ temperature: 0.7, reasoningEffort: "high", topP: 0.83 })
		expect(selectedChild.system.map((part) => part.text)).toEqual(["base system"])

		const sibling = contextInput("ses-sibling")
		sibling.agent = "sisyphus-junior" as never
		sibling.messages = [{ role: "user", content: "Use ultrawork and team-mode for this task" }] as never
		sibling.model = { providerID: "openai", id: "selected-model", variant: "high" } as never
		await callbacks.get("context")?.(sibling)
		expect(sibling.options).toMatchObject({ temperature: 0.2, reasoningEffort: "low" })
		expect(sibling.options).not.toHaveProperty("topP")
		expect(sibling.system.map((part) => part.text)).toEqual(["base system"])
		expect(sessions.has("ses-selected-child")).toBe(true)
		await cleanup()
	})

	test("verified parentless Team members receive their durable model settings", async () => {
		const directory = await mkdtemp(join(tmpdir(), "omo-v2-context-team-"))
		roots.push(directory)
		const { ctx, callbacks } = mockContext(directory, false, [], {}, {
			"ses-team-member": { id: "ses-team-member", agent: "atlas", projectID: "project", location: { directory } },
		})
		await createV2DelegationSettings(ctx.storage, ctx.location).write({
			sessionID: "ses-team-member", parentSessionID: "ses-lead", agentID: "atlas",
			model: { providerID: "omoqa", id: "team-model" }, settings: { temperature: 0.63, maxTokens: 4567 },
		})
		const cleanup = await registerV2ContextHooks(ctx, {
			default_mode: { ultrawork: true },
			team_mode: { enabled: true },
		} as OhMyOpenCodeConfig, {
			resolveLogicalParent: async (id) => id === "ses-team-member" ? "ses-lead" : undefined,
			teamModeAvailable: true,
		})
		try {
			const input = contextInput("ses-team-member")
			input.agent = "atlas" as never
			input.messages = [{ role: "user", content: "Use ultrawork and team-mode for this task" }] as never
			input.model = { providerID: "omoqa", id: "team-model" } as never
			await callbacks.get("context")?.(input)
			expect(input.options).toMatchObject({ temperature: 0.63, maxTokens: 4567 })
			expect(input.system.map((part) => part.text)).toEqual(["base system"])
		} finally { await cleanup() }
	})

	test("planner agents suppress Ultrawork and Hyperplan but keep an explicit Team keyword", async () => {
		const directory = await mkdtemp(join(tmpdir(), "omo-v2-planner-context-"))
		roots.push(directory)
		const { ctx, callbacks } = mockContext(directory, false, [], {}, {
			"ses-planner": { id: "ses-planner", agent: "prometheus", projectID: "project", location: { directory } },
		})
		const cleanup = await registerV2ContextHooks(ctx, {
			default_mode: { ultrawork: true },
			team_mode: { enabled: true },
		} as OhMyOpenCodeConfig, { teamModeAvailable: true })
		const input = contextInput("ses-planner")
		input.agent = "prometheus" as never
		input.messages = [{ role: "user", content: "Use team-mode and ultrawork for this task." }] as never
		await callbacks.get("context")?.(input)
		const system = input.system.map((part) => part.text)
		expect(system).toContain(TEAM_MESSAGE)
		expect(system).not.toContain(getUltraworkMessage("prometheus", "openai/mock"))
		expect(system).not.toContain(V2_HYPERPLAN_MODE_PROMPT)
		await cleanup()
	})

	test("clears inherited reasoning but preserves a null provider option", async () => {
		const directory = await mkdtemp(join(tmpdir(), "omo-v2-context-test-"))
		roots.push(directory)
		const { ctx, callbacks } = mockContext(directory, false, [], {
			"sisyphus-junior": { settings: { reasoningEffort: "low", store: false } },
		}, {
			"ses-auto-reasoning": {
				id: "ses-auto-reasoning", parentID: "ses-parent", agent: "sisyphus-junior",
				projectID: "project", location: { directory },
			},
		})
		const settings = createV2DelegationSettings(ctx.storage, ctx.location)
		await settings.write({
			sessionID: "ses-auto-reasoning",
			parentSessionID: "ses-parent",
			agentID: "sisyphus-junior",
			model: { providerID: "openai", id: "selected-model" },
			settings: { reasoningEffort: null, store: null },
		})
		const cleanup = await registerV2ContextHooks(ctx, {} as OhMyOpenCodeConfig)
		const input = contextInput("ses-auto-reasoning")
		input.agent = "sisyphus-junior" as never
		input.model = { providerID: "openai", id: "selected-model" } as never
		await callbacks.get("context")?.(input)
		expect(input.options).not.toHaveProperty("reasoningEffort")
		expect(input.options).toHaveProperty("store", null)
		await cleanup()
	})

	test("fails a delegated primary request when its durable selection cannot be read", async () => {
		const directory = await mkdtemp(join(tmpdir(), "omo-v2-context-test-"))
		roots.push(directory)
		const { ctx, callbacks, storage } = mockContext(directory, false, [], {
			"sisyphus-junior": { settings: { temperature: 0.2 } },
		}, {
			"ses-storage-failure": {
				id: "ses-storage-failure", parentID: "ses-parent", agent: "sisyphus-junior",
				projectID: "project", location: { directory },
			},
		})
		storage.get = async () => { throw new Error("isolated storage read failure") }
		const cleanup = await registerV2ContextHooks(ctx, {} as OhMyOpenCodeConfig)
		const input = contextInput("ses-storage-failure")
		input.agent = "sisyphus-junior" as never
		input.model = { providerID: "openai", id: "selected-model" } as never
		await expect(callbacks.get("context")?.(input)).rejects.toThrow("refusing to send a request with downgraded settings")
		await cleanup()
	})

	test("applies host build and plan settings but excludes their exact IDs from OMO keyword modes", async () => {
		const directory = await mkdtemp(join(tmpdir(), "omo-v2-context-test-"))
		roots.push(directory)
		const { ctx, callbacks, agentGets } = mockContext(directory, false, [], {
			build: { settings: { temperature: 0.31, reasoningEffort: "medium" } },
			plan: { settings: { topP: 0.77 } },
		})
		const cleanup = await registerV2ContextHooks(ctx, {
			default_mode: { ultrawork: true },
		} as unknown as OhMyOpenCodeConfig)

		const build = contextInput("ses-native-build")
		build.agent = "build" as never
		await callbacks.get("context")?.(build)
		expect(agentGets).toContain("build")
		expect(build.options).toMatchObject({ temperature: 0.31, reasoningEffort: "medium" })
		expect(build.system.map((part) => part.text)).toEqual(["base system"])

		const plan = contextInput("ses-native-plan")
		plan.agent = "plan" as never
		await callbacks.get("context")?.(plan)
		expect(agentGets).toContain("plan")
		expect(plan.options).toMatchObject({ topP: 0.77 })
		expect(plan.system.map((part) => part.text)).toEqual(["base system"])
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

	test("unwinds context and think hooks if a later native permission-hook registration fails", async () => {
		const directory = await mkdtemp(join(tmpdir(), "omo-v2-context-test-"))
		roots.push(directory)
		const { ctx, disposed } = mockContext(directory)
		await expect(registerV2Hooks(ctx, {} as OhMyOpenCodeConfig)).rejects.toThrow("permission registration failure")
		expect(disposed).toEqual(["context", "prompt", "context", "prompt"])
	})
})
