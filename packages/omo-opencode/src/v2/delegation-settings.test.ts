import { describe, expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin"
import { createV2DelegationSettings } from "./delegation-settings"

function storage() {
	const records = new Map<string, unknown>()
	const api = {
		get: async (key: string) => records.get(key),
		set: async (key: string, value: unknown) => { records.set(key, value) },
		remove: async (key: string) => { records.delete(key) },
		list: async () => [],
	}
	return { api: api as unknown as Plugin.Context["storage"], records }
}

function location(projectID: string, directory: string, workspaceID?: string): Plugin.Context["location"] {
	return { project: { id: projectID }, directory, workspaceID } as Plugin.Context["location"]
}

const selected = {
	sessionID: "ses-child",
	parentSessionID: "ses-parent",
	agentID: "explore",
	model: { providerID: "openai", id: "gpt-test", variant: "high" },
	settings: { temperature: 0.4, topP: 0.7, maxTokens: 1200, store: false },
}

const fallbackState = {
	source: "agent" as const,
	candidates: [
		{ model: { providerID: "openai", id: "next-model", variant: "high" }, settings: { maxTokens: 900 }, source: "configured" as const },
	],
	currentIndex: -1,
	attempts: 0,
	failedAt: {},
}

const failureWitness = {
	version: 1 as const,
	sessionID: "ses-child",
	parentSessionID: "ses-parent",
	agentID: "explore",
	model: selected.model,
	userMessageID: "msg-user",
	assistantMessageID: "msg-failed",
	errorType: "provider.rate-limit",
	status: 429,
	requestAt: 100,
	responseStatus: 429,
	idle: 110,
	background: true,
}

describe("native V2 delegation settings store", () => {
	test("persists and reads settings only for the exact child, parent, agent, and model", async () => {
		const backing = storage()
		const state = createV2DelegationSettings(backing.api, location("project-a", "/tmp/omo-a"))
		await state.write(selected)

		const record = await state.read("ses-child", {
			parentSessionID: "ses-parent",
			agentID: "explore",
			model: selected.model,
		})
		expect(record?.settings).toEqual(selected.settings)
		expect(await state.read("ses-child", { ...selected, parentSessionID: "other-parent" })).toBeUndefined()
		expect(await state.read("ses-child", { ...selected, agentID: "librarian" })).toBeUndefined()
		expect(await state.read("ses-child", { ...selected, model: { ...selected.model, variant: "medium" } })).toBeUndefined()
	})

	test("scopes plugin-global storage by project and canonical directory", async () => {
		const backing = storage()
		const first = createV2DelegationSettings(backing.api, location("project-a", "/tmp/omo-a"))
		const otherProject = createV2DelegationSettings(backing.api, location("project-b", "/tmp/omo-a"))
		const otherDirectory = createV2DelegationSettings(backing.api, location("project-a", "/tmp/omo-b"))

		await first.write(selected)
		expect(await otherProject.read("ses-child", selected)).toBeUndefined()
		expect(await otherDirectory.read("ses-child", selected)).toBeUndefined()
		await otherProject.remove("ses-child")
		expect((await first.read("ses-child", selected))?.settings).toEqual(selected.settings)
	})

	test("does not reuse a child selection after its workspace identity changes", async () => {
		const backing = storage()
		const first = createV2DelegationSettings(backing.api, location("project-a", "/tmp/omo-a", "workspace-a"))
		const moved = createV2DelegationSettings(backing.api, location("project-a", "/tmp/omo-a", "workspace-b"))
		await first.write(selected)
		expect(await moved.read("ses-child", selected)).toBeUndefined()
	})

	test("stores an empty selection to clear stale overrides on an explicitly changed model", async () => {
		const backing = storage()
		const state = createV2DelegationSettings(backing.api, location("project-a", "/tmp/omo-a"))
		await state.write(selected)
		await state.write({ ...selected, model: { providerID: "anthropic", id: "new-model" }, settings: {} })

		const record = await state.read("ses-child", {
			parentSessionID: "ses-parent",
			agentID: "explore",
			model: { providerID: "anthropic", id: "new-model" },
		})
		expect(record?.settings).toEqual({})
		expect(await state.read("ses-child", { ...selected })).toBeUndefined()
	})

	test("accepts native absent/default variant normalization", async () => {
		const backing = storage()
		const state = createV2DelegationSettings(backing.api, location("project-a", "/tmp/omo-a"))
		await state.write({ ...selected, model: { providerID: "openai", id: "gpt-test" } })
		expect((await state.read("ses-child", {
			parentSessionID: "ses-parent",
			agentID: "explore",
			model: { providerID: "openai", id: "gpt-test", variant: "default" },
		}))?.settings).toEqual(selected.settings)
	})

	test("round-trips a rich fallback chain and updates it only for the exact child selection", async () => {
		const backing = storage()
		const state = createV2DelegationSettings(backing.api, location("project-a", "/tmp/omo-a"))
		await state.write({ ...selected, fallbackState })

		const expected = { parentSessionID: selected.parentSessionID, agentID: selected.agentID, model: selected.model }
		expect((await state.read(selected.sessionID, expected))?.fallbackState).toEqual(fallbackState)

		const advanced = { ...fallbackState, currentIndex: 0, attempts: 1, failedAt: { "openai/gpt-test#high": 42 } }
		const updated = await state.updateFallbackState(selected.sessionID, expected, advanced)
		expect(updated?.fallbackState).toEqual(advanced)
		expect(await state.updateFallbackState(selected.sessionID, { ...expected, parentSessionID: "other-parent" }, fallbackState)).toBeUndefined()
		expect((await state.read(selected.sessionID, expected))?.fallbackState).toEqual(advanced)
	})

	test("fails closed when optional persisted fallback metadata is malformed", async () => {
		const backing = storage()
		const state = createV2DelegationSettings(backing.api, location("project-a", "/tmp/omo-a"))
		await state.write(selected)
		const [key, value] = [...backing.records.entries()][0]!
		backing.records.set(key, { ...(value as object), fallbackState: { source: "agent", candidates: ["not-a-choice"], currentIndex: 0 } })

		const record = await state.read(selected.sessionID, {
			parentSessionID: selected.parentSessionID,
			agentID: selected.agentID,
			model: selected.model,
		})
		expect(record).toBeUndefined()
	})

	test("records a scoped provider failure witness and consumes it atomically for a new model", async () => {
		const backing = storage()
		const state = createV2DelegationSettings(backing.api, location("project-a", "/tmp/omo-a"))
		const expected = { parentSessionID: selected.parentSessionID, agentID: selected.agentID, model: selected.model }
		await state.write({ ...selected, fallbackState })
		const recorded = await state.recordFailureWitness(selected.sessionID, expected, failureWitness)
		expect(recorded?.failureWitness).toEqual(failureWitness)
		expect(await state.recordFailureWitness(selected.sessionID, expected, { ...failureWitness, requestAt: 99 })).toBeUndefined()

		const nextModel = { providerID: "openai", id: "fallback" }
		const nextFallbackState = { ...fallbackState, currentIndex: 0, attempts: 1 }
		const consumed = await state.consumeFailureWitness({
			sessionID: selected.sessionID,
			expected,
			witness: failureWitness,
			consumedModel: nextModel,
			settings: { maxTokens: 800 },
			fallbackState: nextFallbackState,
		})
		expect(consumed).toMatchObject({ model: nextModel, settings: { maxTokens: 800 }, fallbackState: nextFallbackState })
		expect(consumed).not.toHaveProperty("failureWitness")
		expect(await state.consumeFailureWitness({
			sessionID: selected.sessionID,
			expected,
			witness: failureWitness,
			consumedModel: nextModel,
			settings: {},
			fallbackState: nextFallbackState,
		})).toBeUndefined()
		expect((await state.read(selected.sessionID, { ...expected, model: nextModel }))?.failureWitness).toBeUndefined()
	})

	test("rejects malformed and cross-record provider failure witnesses", async () => {
		const backing = storage()
		const state = createV2DelegationSettings(backing.api, location("project-a", "/tmp/omo-a"))
		const expected = { parentSessionID: selected.parentSessionID, agentID: selected.agentID, model: selected.model }
		await state.write({ ...selected, fallbackState })
		const [key, raw] = [...backing.records.entries()][0]!
		backing.records.set(key, { ...(raw as object), failureWitness: { ...failureWitness, responseStatus: 200 } })
		expect(await state.read(selected.sessionID, expected)).toBeUndefined()

		backing.records.set(key, raw)
		expect(await state.recordFailureWitness(selected.sessionID, { ...expected, parentSessionID: "other-parent" }, failureWitness)).toBeUndefined()
		expect(await state.recordFailureWitness(selected.sessionID, expected, { ...failureWitness, model: { providerID: "other", id: "model" } })).toBeUndefined()
	})
})
