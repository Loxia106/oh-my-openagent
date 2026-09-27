import { describe, expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin"
import type { OhMyOpenCodeConfig } from "../config"
import { TODOWRITE_DESCRIPTION } from "../hooks/todo-description-override/description"
import { registerV2TodoDescriptionOverride } from "./todo-description-override"

function makeHarness(options: { includeTool?: boolean } = {}) {
	const schema = { type: "object", required: ["todos"], properties: { todos: { type: "array" } } }
	const execute = async () => ({ content: "unchanged" })
	const tool: Record<string, unknown> = { id: "todowrite", description: "host description", input: schema, execute }
	let transformCalls = 0
	let updateCalls = 0
	let disposeCalls = 0
	const editor = {
		get(id: string) { return id === "todowrite" && options.includeTool !== false ? tool : undefined },
		update(id: string, update: (tool: Record<string, unknown>) => void) {
			if (id !== "todowrite" || options.includeTool === false) return
			updateCalls += 1
			update(tool)
		},
	}
	const ctx = {
		tool: {
			transform: async (callback: (editor: typeof editor) => void) => {
				transformCalls += 1
				callback(editor)
				return { dispose: async () => { disposeCalls += 1 } }
			},
		},
	} as unknown as Plugin.Context
	return { ctx, tool, schema, execute, get transformCalls() { return transformCalls }, get updateCalls() { return updateCalls }, get disposeCalls() { return disposeCalls } }
}

describe("native V2 todo description override", () => {
	test("changes only todowrite description and preserves the native schema and executor", async () => {
		const harness = makeHarness()
		const cleanup = await registerV2TodoDescriptionOverride(harness.ctx, {} as OhMyOpenCodeConfig)

		expect(harness.tool.description).toBe(TODOWRITE_DESCRIPTION)
		expect(harness.tool.input).toBe(harness.schema)
		expect(harness.tool.execute).toBe(harness.execute)
		expect(harness.updateCalls).toBe(1)
		await cleanup()
		await cleanup()
		expect(harness.disposeCalls).toBe(1)
	})

	test("honors disabled_hooks and tolerates an absent native todowrite tool", async () => {
		const disabled = makeHarness()
		await registerV2TodoDescriptionOverride(disabled.ctx, { disabled_hooks: ["todo-description-override"] } as OhMyOpenCodeConfig)
		expect(disabled.transformCalls).toBe(0)
		expect(disabled.tool.description).toBe("host description")

		const missing = makeHarness({ includeTool: false })
		const cleanup = await registerV2TodoDescriptionOverride(missing.ctx, {} as OhMyOpenCodeConfig)
		expect(missing.updateCalls).toBe(0)
		await cleanup()
	})
})
