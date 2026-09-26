import { describe, expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin"
import { resolveV2SubagentModel } from "./delegation-admission"

type FakeSession = Record<string, unknown>
type FakeAgent = Record<string, unknown> & { id: string; mode: string }
type FakeModel = Record<string, unknown> & { providerID: string; id: string; enabled: boolean; variants: Array<{ id: string }> }

function harness(input: {
	agents?: FakeAgent[]
	models?: FakeModel[]
	defaultModel?: FakeModel | null
	sessions?: Record<string, FakeSession>
} = {}) {
	const sessions = new Map<string, FakeSession>(Object.entries({
		"ses-parent": {
			id: "ses-parent",
			agent: "parent",
			model: { providerID: "host", id: "parent-model" },
			location: { directory: "/repo" },
		},
		...input.sessions,
	}))
	const models = input.models ?? [
		{ providerID: "host", id: "parent-model", enabled: true, variants: [] },
		{ providerID: "agent-provider", id: "agent-model", enabled: true, variants: [] },
		{ providerID: "stored-provider", id: "stored-model", enabled: true, variants: [] },
		{ providerID: "override-provider", id: "override-model", enabled: true, variants: [{ id: "high" }] },
		{ providerID: "openrouter", id: "org/model/path", enabled: true, variants: [{ id: "high" }] },
	]
	const ctx = {
		agent: {
			list: async () => ({ data: input.agents ?? [
				{ id: "target", mode: "subagent", model: { providerID: "agent-provider", id: "agent-model" } },
				{ id: "other", mode: "subagent", model: { providerID: "override-provider", id: "override-model" } },
				{ id: "primary", mode: "primary" },
			] }),
		},
		model: {
			list: async () => ({ data: models }),
			default: async () => ({ data: input.defaultModel ?? models.find((model) => model.providerID === "host") ?? null }),
		},
		session: {
			get: async ({ sessionID }: { sessionID: string }) => {
				const session = sessions.get(sessionID)
				if (!session) throw new Error(`Unknown session ${sessionID}`)
				return session
			},
		},
	} as unknown as Plugin.Context
	return { ctx, sessions }
}

describe("native V2 delegation model resolution", () => {
	test("new children use explicit override, then target agent, then parent, then host default", async () => {
		const h = harness()
		const explicit = await resolveV2SubagentModel(h.ctx, {
			agent: "target",
			model: "openrouter/org/model/path#high",
		}, "ses-parent")
		expect(explicit.model).toEqual({ providerID: "openrouter", id: "org/model/path", variant: "high" })

		const targetAgent = await resolveV2SubagentModel(h.ctx, { agent: "target" }, "ses-parent")
		expect(targetAgent.model).toEqual({ providerID: "agent-provider", id: "agent-model" })

		const noAgentModel = harness({
			agents: [{ id: "target", mode: "subagent" }],
			models: [
				{ providerID: "host", id: "parent-model", enabled: true, variants: [] },
				{ providerID: "host-default", id: "fallback-model", enabled: true, variants: [] },
			],
			defaultModel: { providerID: "host-default", id: "fallback-model", enabled: true, variants: [] },
		})
		const parent = await resolveV2SubagentModel(noAgentModel.ctx, { agent: "target" }, "ses-parent")
		expect(parent.model).toEqual({ providerID: "host", id: "parent-model" })

		noAgentModel.sessions.set("ses-parent", { id: "ses-parent", agent: "parent", location: { directory: "/repo" } })
		const hostDefault = await resolveV2SubagentModel(noAgentModel.ctx, { agent: "target" }, "ses-parent")
		expect(hostDefault.model).toEqual({ providerID: "host-default", id: "fallback-model" })
	})

	test("resume uses override, switched-agent model, then stored model before the host default", async () => {
		const sessions = {
			"ses-same": {
				id: "ses-same", parentID: "ses-parent", agent: "target",
				model: { providerID: "stored-provider", id: "stored-model" },
				location: { directory: "/repo" },
			},
			"ses-switched": {
				id: "ses-switched", parentID: "ses-parent", agent: "target",
				model: { providerID: "stored-provider", id: "stored-model" },
				location: { directory: "/repo" },
			},
		}
		const h = harness({ sessions })
		const sameAgent = await resolveV2SubagentModel(h.ctx, { agent: "target", sessionID: "ses-same" }, "ses-parent")
		expect(sameAgent.model).toEqual({ providerID: "stored-provider", id: "stored-model" })

		const switchedAgent = await resolveV2SubagentModel(h.ctx, { agent: "other", sessionID: "ses-switched" }, "ses-parent")
		expect(switchedAgent.model).toEqual({ providerID: "override-provider", id: "override-model" })

		const explicit = await resolveV2SubagentModel(h.ctx, {
			agent: "other", sessionID: "ses-switched", model: "override-provider/override-model#high",
		}, "ses-parent")
		expect(explicit.model).toEqual({ providerID: "override-provider", id: "override-model", variant: "high" })
	})

	test("normalizes the native default sentinel on inherited parent and resumed models", async () => {
		const h = harness({
			agents: [{ id: "target", mode: "subagent" }],
			sessions: {
				"ses-parent": {
					id: "ses-parent", agent: "parent",
					model: { providerID: "stored-provider", id: "stored-model", variant: "default" },
					location: { directory: "/repo" },
				},
				"ses-resume-default": {
					id: "ses-resume-default", parentID: "ses-parent", agent: "target",
					model: { providerID: "stored-provider", id: "stored-model", variant: "default" },
					location: { directory: "/repo" },
				},
			},
		})

		const inherited = await resolveV2SubagentModel(h.ctx, { agent: "target" }, "ses-parent")
		expect(inherited.model).toEqual({ providerID: "stored-provider", id: "stored-model" })

		const resumed = await resolveV2SubagentModel(h.ctx, { agent: "target", sessionID: "ses-resume-default" }, "ses-parent")
		expect(resumed.model).toEqual({ providerID: "stored-provider", id: "stored-model" })
	})

	test("preserves valid inherited variants and rejects unavailable inherited or explicit default variants", async () => {
		const available = [{ providerID: "stored-provider", id: "stored-model", enabled: true, variants: [{ id: "high" }] }]
		const valid = harness({
			agents: [{ id: "target", mode: "subagent", model: { providerID: "stored-provider", id: "stored-model", variant: "high" } }],
			models: available,
		})
		const inherited = await resolveV2SubagentModel(valid.ctx, { agent: "target" }, "ses-parent")
		expect(inherited.model).toEqual({ providerID: "stored-provider", id: "stored-model", variant: "high" })

		const invalid = harness({
			agents: [{ id: "target", mode: "subagent", model: { providerID: "stored-provider", id: "stored-model", variant: "missing" } }],
			models: available,
		})
		await expect(resolveV2SubagentModel(invalid.ctx, { agent: "target" }, "ses-parent"))
			.rejects.toThrow('Variant "missing" is unavailable')

		const explicitDefault = harness({
			models: [{ providerID: "override-provider", id: "override-model", enabled: true, variants: [{ id: "high" }] }],
		})
		await expect(resolveV2SubagentModel(explicitDefault.ctx, {
			agent: "target", model: "override-provider/override-model#default",
		}, "ses-parent"))
			.rejects.toThrow('Variant "default" is unavailable')
	})

	test("validates requested agent, direct-child ownership, enabled model, and variant", async () => {
		const h = harness({ sessions: {
			"ses-foreign": { id: "ses-foreign", parentID: "ses-other", agent: "target", location: { directory: "/repo" } },
			"ses-no-model": { id: "ses-no-model", parentID: "ses-parent", agent: "target", location: { directory: "/repo" } },
		} })
		await expect(resolveV2SubagentModel(h.ctx, { agent: "missing" }, "ses-parent"))
			.rejects.toThrow('Unknown native subagent "missing"')
		await expect(resolveV2SubagentModel(h.ctx, { agent: "primary" }, "ses-parent"))
			.rejects.toThrow("cannot run as a subagent")
		await expect(resolveV2SubagentModel(h.ctx, { agent: "target", sessionID: "ses-foreign" }, "ses-parent"))
			.rejects.toThrow("not a child")
		await expect(resolveV2SubagentModel(h.ctx, { agent: "target", model: "missing/model" }, "ses-parent"))
			.rejects.toThrow("unavailable in the current OpenCode model catalog")
		await expect(resolveV2SubagentModel(h.ctx, { agent: "target", model: "override-provider/override-model#missing" }, "ses-parent"))
			.rejects.toThrow('Variant "missing" is unavailable')
		await expect(resolveV2SubagentModel(h.ctx, { agent: "target", model: "override-provider/override-model#high#extra" }, "ses-parent"))
			.rejects.toThrow("Invalid model")

		const noModel = harness({
			agents: [{ id: "target", mode: "subagent" }],
			models: [],
			defaultModel: null,
			sessions: { "ses-no-model": { id: "ses-no-model", parentID: "ses-parent", agent: "target", location: { directory: "/repo" } } },
		})
		noModel.sessions.set("ses-parent", { id: "ses-parent", agent: "parent", location: { directory: "/repo" } })
		await expect(resolveV2SubagentModel(noModel.ctx, { agent: "target", sessionID: "ses-no-model" }, "ses-parent"))
			.rejects.toThrow("no concrete model")
	})
})
