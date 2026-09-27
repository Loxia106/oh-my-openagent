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
})
