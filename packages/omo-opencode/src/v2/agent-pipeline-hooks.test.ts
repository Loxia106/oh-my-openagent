import { describe, expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin"
import type { SessionContext, SessionPrompt } from "@opencode/plugin/promise/session"
import type { OhMyOpenCodeConfig } from "../config"
import type { LoadedSkill } from "../features/opencode-skill-loader/types"
import { buildV2AgentConfigs, createV2BuiltinAgentPromptRenderer, registerV2Agents } from "./agents"
import { registerV2AgentPipelineHooks } from "./agent-pipeline-hooks"
import { V2ModelCatalog } from "./model-resolution"
import { getV2SubagentRunState } from "./task-state"

type Hook = (input: any) => void | Promise<void>
type MockAgent = {
	id: string
	name?: string
	mode: "primary" | "subagent" | "all"
	hidden: boolean
	system?: string
	model?: { providerID: string; id: string; variant?: string }
	permissions: []
}
type MockSession = {
	id: string
	projectID: string
	location: { directory: string; workspaceID?: string }
	agent?: string
	parentID?: string
	model?: { providerID: string; id: string; variant?: string }
	metadata?: Record<string, unknown>
}

const directory = "/tmp/omo-agent-pipeline"
const location = { directory, workspaceID: "workspace-a", project: { id: "project-a" } }

function agent(id: string, mode: MockAgent["mode"] = "primary", system = `${id} original system`): MockAgent {
	return { id, name: id, mode, hidden: false, system, permissions: [] }
}

function loadedSkill(name: string, agentName?: string): LoadedSkill {
	return {
		name,
		scope: "project",
		definition: { name, description: `Description for ${name}`, template: `Instructions for ${name}`, ...(agentName ? { agent: agentName } : {}) },
	}
}

function availableSkillsSection(prompt: string): string {
	const start = prompt.indexOf("#### Available Skills")
	if (start < 0) return ""
	const end = prompt.indexOf("\n\n---", start)
	return prompt.slice(start, end < 0 ? undefined : end)
}

function createHarness(input: {
	readonly config?: OhMyOpenCodeConfig
	readonly agents?: MockAgent[]
	readonly sessions?: MockSession[]
	readonly failContextRegistration?: boolean
	readonly afterAgentGet?: (agentID: string) => void
} = {}) {
	const agents = new Map((input.agents ?? [agent("sisyphus"), agent("hephaestus")]).map((value) => [value.id, value]))
	const sessions = new Map((input.sessions ?? []).map((value) => [value.id, value]))
	const values = new Map<string, unknown>()
	const hooks = new Map<string, Hook>()
	const disposed: string[] = []
	const switched: Array<{ sessionID: string; agent: string }> = []
	const storage = {
		get: async (key: string) => values.get(key),
		set: async (key: string, value: unknown) => { values.set(key, value) },
		remove: async (key: string) => { values.delete(key) },
	}
	const ctx = {
		location,
		storage,
		session: {
			hook: async (name: string, callback: Hook) => {
				if (name === "context" && input.failContextRegistration) throw new Error("context registration failed")
				hooks.set(name, callback)
				return { dispose: async () => { disposed.push(name); hooks.delete(name) } }
			},
			get: async ({ sessionID }: { sessionID: string }) => {
				const value = sessions.get(sessionID)
				if (!value) throw new Error(`missing session ${sessionID}`)
				return {
					...value,
					location: { ...value.location },
					...(value.model ? { model: { ...value.model } } : {}),
				}
			},
			switchAgent: async (value: { sessionID: string; agent: string }) => { switched.push(value) },
		},
			agent: {
			get: async ({ agentID }: { agentID: string }) => {
				const value = agents.get(agentID)
				if (!value) throw new Error(`missing agent ${agentID}`)
				input.afterAgentGet?.(agentID)
				return { data: value }
			},
		},
	} as unknown as Plugin.Context
	return { ctx, hooks, agents, sessions, storage, switched, disposed }
}

function session(id: string, agentID: string, model = "gpt-4o", extras: Partial<MockSession> = {}): MockSession {
	return {
		id,
		projectID: location.project.id,
		location: { directory, workspaceID: location.workspaceID },
		agent: agentID,
		model: { providerID: "openai", id: model },
		...extras,
	}
}

async function invokePrompt(harness: ReturnType<typeof createHarness>, sessionID: string): Promise<void> {
	await harness.hooks.get("prompt")?.({
		sessionID,
		messageID: "msg-1",
		prompt: { text: "Continue", files: [], agents: [], skills: [] },
		delivery: "immediate",
	} as unknown as SessionPrompt)
}

describe("native v2 agent pipeline hooks", () => {
	test("routes an unsupported GPT Sisyphus primary request to an enabled Hephaestus", async () => {
		const root = session("root-1", "sisyphus", "gpt-4o", { model: { providerID: "openai", id: "gpt-4o", variant: "high" } })
		const harness = createHarness({ sessions: [root] })
		const cleanup = await registerV2AgentPipelineHooks(harness.ctx, {} as OhMyOpenCodeConfig, [], new V2ModelCatalog())
		await invokePrompt(harness, "root-1")
		expect(harness.switched).toEqual([{ sessionID: "root-1", agent: "hephaestus" }])
		expect(root.model?.variant).toBe("high")
		await cleanup()
	})

	test("rechecks ownership and model after resolving a redirect target", async () => {
		const root = session("racing-root", "sisyphus")
		const harness = createHarness({
			sessions: [root],
			afterAgentGet: (agentID) => {
				if (agentID === "hephaestus") root.agent = "hephaestus"
			},
		})
		const cleanup = await registerV2AgentPipelineHooks(harness.ctx, {} as OhMyOpenCodeConfig, [], new V2ModelCatalog())
		await invokePrompt(harness, "racing-root")
		expect(harness.switched).toEqual([])
		await cleanup()
	})

	test("keeps supported native Sisyphus GPT models and GPT-6 on Sisyphus", async () => {
		const harness = createHarness({ sessions: [session("gpt55", "sisyphus", "gpt-5.5"), session("gpt6", "sisyphus", "gpt-6-sol")] })
		const cleanup = await registerV2AgentPipelineHooks(harness.ctx, {} as OhMyOpenCodeConfig, [], new V2ModelCatalog())
		await invokePrompt(harness, "gpt55")
		await invokePrompt(harness, "gpt6")
		expect(harness.switched).toEqual([])
		await cleanup()
	})

	test("routes non-GPT Hephaestus to Sisyphus unless allow_non_gpt_model is true", async () => {
		const blocked = createHarness({ sessions: [session("heph-1", "hephaestus", "claude-opus-5")] })
		const cleanupBlocked = await registerV2AgentPipelineHooks(blocked.ctx, {} as OhMyOpenCodeConfig, [], new V2ModelCatalog())
		await invokePrompt(blocked, "heph-1")
		expect(blocked.switched).toEqual([{ sessionID: "heph-1", agent: "sisyphus" }])
		await cleanupBlocked()

		const allowed = createHarness({ sessions: [session("heph-2", "hephaestus", "claude-opus-5")] })
		const cleanupAllowed = await registerV2AgentPipelineHooks(allowed.ctx, {
			agents: { hephaestus: { allow_non_gpt_model: true } },
		} as OhMyOpenCodeConfig, [], new V2ModelCatalog())
		await invokePrompt(allowed, "heph-2")
		expect(allowed.switched).toEqual([])
		await cleanupAllowed()
	})

	test("does not redirect native children, parentless managed Team sessions, host agents, or other locations", async () => {
		const harness = createHarness({
			agents: [agent("sisyphus"), agent("hephaestus"), agent("host-agent")],
			sessions: [
				session("child", "sisyphus", "gpt-4o", { parentID: "root" }),
				session("team-child", "sisyphus"),
				session("team-metadata-only", "sisyphus", "gpt-4o", {
					metadata: { omoTeam: { version: 1, teamRunId: "team-after-parent-delete" } },
				}),
				session("host", "host-agent"),
				session("other-location", "sisyphus", "gpt-4o", { location: { directory: `${directory}-other` } }),
			],
		})
		await getV2SubagentRunState(harness.ctx.storage).recordLaunch("team-child", {
			parentSessionID: "team-root",
			startedAt: Date.now(),
			status: "running",
			blockedActions: [],
		})
		const cleanup = await registerV2AgentPipelineHooks(harness.ctx, {} as OhMyOpenCodeConfig, [], new V2ModelCatalog())
		for (const id of ["child", "team-child", "team-metadata-only", "host", "other-location"]) await invokePrompt(harness, id)
		expect(harness.switched).toEqual([])
		await cleanup()
	})

	test("only treats the recognized Team v1 metadata shape as a skip-only ancestry hint", async () => {
		const malformed = createHarness({ sessions: [
			session("malformed-team-hint", "sisyphus", "gpt-4o", {
				metadata: { omoTeam: { version: 2, teamRunId: "not-v1" } },
			}),
		] })
		const cleanup = await registerV2AgentPipelineHooks(malformed.ctx, {} as OhMyOpenCodeConfig, [], new V2ModelCatalog())
		await invokePrompt(malformed, "malformed-team-hint")
		expect(malformed.switched).toEqual([{ sessionID: "malformed-team-hint", agent: "hephaestus" }])
		await cleanup()
	})

	test("honors each disabled policy hook independently and fails before switching when target is unavailable", async () => {
		const disabledSisyphus = createHarness({ sessions: [session("disabled-sisyphus", "sisyphus")] })
		const cleanupDisabledSisyphus = await registerV2AgentPipelineHooks(disabledSisyphus.ctx, {
			disabled_hooks: ["no-sisyphus-gpt"],
		} as OhMyOpenCodeConfig, [], new V2ModelCatalog())
		expect(disabledSisyphus.hooks.has("prompt")).toBe(true)
		await invokePrompt(disabledSisyphus, "disabled-sisyphus")
		expect(disabledSisyphus.switched).toEqual([])
		await cleanupDisabledSisyphus()

		const disabledHephaestus = createHarness({ sessions: [session("disabled-hephaestus", "hephaestus", "claude-opus-5")] })
		const cleanupDisabledHephaestus = await registerV2AgentPipelineHooks(disabledHephaestus.ctx, {
			disabled_hooks: ["no-hephaestus-non-gpt"],
		} as OhMyOpenCodeConfig, [], new V2ModelCatalog())
		await invokePrompt(disabledHephaestus, "disabled-hephaestus")
		expect(disabledHephaestus.switched).toEqual([])
		await cleanupDisabledHephaestus()

		const missing = createHarness({ agents: [agent("sisyphus")], sessions: [session("missing-target", "sisyphus")] })
		const cleanupMissing = await registerV2AgentPipelineHooks(missing.ctx, {} as OhMyOpenCodeConfig, [], new V2ModelCatalog())
		await expect(invokePrompt(missing, "missing-target")).rejects.toThrow("target OMO agent is not registered")
		expect(missing.switched).toEqual([])
		await cleanupMissing()
	})

	test("re-renders only the exact builtin system part for the request model", async () => {
		const config = {} as OhMyOpenCodeConfig
		const registered = buildV2AgentConfigs({ config, catalog: new V2ModelCatalog().snapshot, loadedSkills: [], directory })
		const harness = createHarness({ agents: [agent("sisyphus", "primary", registered.sisyphus.prompt!)], sessions: [] })
		const catalog = new V2ModelCatalog()
		const cleanup = await registerV2AgentPipelineHooks(harness.ctx, config, [], catalog)
		const renderer = createV2BuiltinAgentPromptRenderer({ config, catalog: catalog.snapshot, loadedSkills: [], directory })
		const context = {
			sessionID: "root-context",
			agent: "sisyphus",
			model: { providerID: "openai", id: "gpt-5.5" },
			system: [
				{ type: "text", text: `prefix\n${registered.sisyphus.prompt!}\nHost AGENTS instructions stay in this same part.` },
				{ type: "text", text: "Host AGENTS instructions stay untouched." },
			],
			messages: [],
			options: {},
			tools: {},
		} satisfies SessionContext
		await harness.hooks.get("context")?.(context)
		const expected = renderer("sisyphus", "openai/gpt-5.5")
		// The registered baseline uses the fallback family; request-time prompt reflects GPT-5.5.
		expect(expected).toBeDefined()
		expect(context.system[0]?.text).toBe(`prefix\n${expected}\nHost AGENTS instructions stay in this same part.`)
		expect(context.system[1]?.text).toBe("Host AGENTS instructions stay untouched.")
		await cleanup()
	})

	test("renders Hephaestus instructions for the actual supported request model", async () => {
		const config = {} as OhMyOpenCodeConfig
		const catalog = new V2ModelCatalog()
		const registered = buildV2AgentConfigs({ config, catalog: catalog.snapshot, loadedSkills: [], directory })
		const harness = createHarness({ agents: [agent("hephaestus", "primary", registered.hephaestus.prompt!)] })
		const cleanup = await registerV2AgentPipelineHooks(harness.ctx, config, [], catalog)
		const context = {
			sessionID: "hephaestus-context",
			agent: "hephaestus",
			model: { providerID: "openai", id: "gpt-5.5" },
			system: [{ type: "text", text: registered.hephaestus.prompt! }],
			messages: [], options: {}, tools: {},
		} satisfies SessionContext
		await harness.hooks.get("context")?.(context)
		const render = createV2BuiltinAgentPromptRenderer({ config, catalog: catalog.snapshot, loadedSkills: [], directory })
		const expected = render("hephaestus", "openai/gpt-5.5")
		expect(expected).toBeDefined()
		expect(context.system[0]?.text).toBe(expected)
		expect(context.system[0]?.text).not.toBe(registered.hephaestus.prompt)
		await cleanup()
	})

	test("does not replace custom agents or contexts whose baked system prompt is not an exact match", async () => {
		const harness = createHarness({ agents: [agent("custom-worker"), agent("sisyphus") ] })
		const cleanup = await registerV2AgentPipelineHooks(harness.ctx, {} as OhMyOpenCodeConfig, [], new V2ModelCatalog())
		const custom = {
			sessionID: "custom-context",
			agent: "custom-worker",
			model: { providerID: "openai", id: "gpt-5.5" },
			system: [{ type: "text", text: "Custom prompt with user-specific content." }],
			messages: [], options: {}, tools: {},
		} satisfies SessionContext
		await harness.hooks.get("context")?.(custom)
		expect(custom.system[0]?.text).toBe("Custom prompt with user-specific content.")

		const unmatched = {
			...custom,
			agent: "sisyphus",
			system: [{ type: "text", text: "A user modified this native prompt." }],
		} satisfies SessionContext
		await harness.hooks.get("context")?.(unmatched)
		expect(unmatched.system[0]?.text).toBe("A user modified this native prompt.")
		await cleanup()
	})

	test("does not guess when a baked prompt occurs more than once in system context", async () => {
		const config = {} as OhMyOpenCodeConfig
		const registered = buildV2AgentConfigs({ config, catalog: new V2ModelCatalog().snapshot, loadedSkills: [], directory })
		const harness = createHarness({ agents: [agent("sisyphus", "primary", registered.sisyphus.prompt!)] })
		const cleanup = await registerV2AgentPipelineHooks(harness.ctx, config, [], new V2ModelCatalog())
		const duplicated = {
			sessionID: "duplicate-context",
			agent: "sisyphus",
			model: { providerID: "openai", id: "gpt-5.5" },
			system: [
				{ type: "text", text: registered.sisyphus.prompt! },
				{ type: "text", text: registered.sisyphus.prompt! },
			],
			messages: [], options: {}, tools: {},
		} satisfies SessionContext
		await harness.hooks.get("context")?.(duplicated)
		expect(duplicated.system[0]?.text).toBe(registered.sisyphus.prompt)
		expect(duplicated.system[1]?.text).toBe(registered.sisyphus.prompt)
		await cleanup()
	})

	test("rolls back partial registration and cleanup makes captured callbacks inert", async () => {
		const failed = createHarness({ failContextRegistration: true })
		await expect(registerV2AgentPipelineHooks(failed.ctx, {} as OhMyOpenCodeConfig, [], new V2ModelCatalog()))
			.rejects.toThrow("context registration failed")
		expect(failed.disposed).toEqual(["prompt"])

		const harness = createHarness({ sessions: [session("after-cleanup", "sisyphus")] })
		const cleanup = await registerV2AgentPipelineHooks(harness.ctx, {} as OhMyOpenCodeConfig, [], new V2ModelCatalog())
		const prompt = harness.hooks.get("prompt")!
		await cleanup()
		await prompt({ sessionID: "after-cleanup", messageID: "m", prompt: { text: "x" }, delivery: "immediate" })
		expect(harness.switched).toEqual([])
		expect(harness.disposed).toEqual(["context", "prompt"])
	})

	test("excludes skills restricted to other agents from prompts and native permission availability", async () => {
		const config = { tools: { skill: true } } as unknown as OhMyOpenCodeConfig
		const skills = [loadedSkill("hephaestus-only", "hephaestus"), loadedSkill("sisyphus-only", "sisyphus")]
		const configs = buildV2AgentConfigs({ config, catalog: new V2ModelCatalog().snapshot, loadedSkills: skills, directory })
		const sisyphusPrompt = configs.sisyphus?.prompt ?? ""
		const hephaestusPrompt = configs.hephaestus?.prompt ?? ""
		expect(availableSkillsSection(sisyphusPrompt)).toContain("sisyphus-only")
		expect(availableSkillsSection(sisyphusPrompt)).not.toContain("hephaestus-only")
		expect(availableSkillsSection(hephaestusPrompt)).toContain("hephaestus-only")
		expect(availableSkillsSection(hephaestusPrompt)).not.toContain("sisyphus-only")

		const registered = createHarness({ agents: [agent("sisyphus"), agent("hephaestus")] })
		let transform: ((editor: any) => void) | undefined
		const ctx = {
			...registered.ctx,
			agent: { ...registered.ctx.agent, transform: async (callback: (editor: any) => void) => { transform = callback; return { dispose: async () => undefined } } },
		} as unknown as Plugin.Context
		await registerV2Agents(ctx, config, skills, new V2ModelCatalog())
		const result = new Map<string, any>()
		transform?.({
			list: () => [], get: () => undefined, default: () => undefined, remove: () => undefined,
			update: (id: string, update: (value: any) => void) => {
				const value = { id, request: { settings: {}, headers: {}, body: {} }, permissions: [], mode: "primary", hidden: false }
				update(value); result.set(id, value)
			},
		})
		expect(result.get("sisyphus").permissions).toContainEqual({ action: "skill", resource: "hephaestus-only", effect: "deny" })
		expect(result.get("sisyphus").permissions.at(-1)).toEqual({ action: "skill", resource: "hephaestus-only", effect: "deny" })
		expect(result.get("hephaestus").permissions).toContainEqual({ action: "skill", resource: "sisyphus-only", effect: "deny" })
	})
})
