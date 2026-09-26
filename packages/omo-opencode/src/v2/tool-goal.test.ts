import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin"
import type { ToolContext, ToolEditor } from "@opencode/plugin/promise/tool"
import { getV2GoalController } from "./lifecycle"
import { addV2GoalTools } from "./tool-goal"

type RegisteredTool = { name: string; input: unknown; execute: (args: any, context: ToolContext) => Promise<any> }

class TestEditor {
	readonly tools = new Map<string, RegisteredTool>()
	list() { return [...this.tools.values()] }
	get(name: string) { return this.tools.get(name) }
	add(tool: RegisteredTool) { this.tools.set(tool.name, tool) }
	remove(name: string) { this.tools.delete(name) }
	update() {}
	namespace() {}
}

function context(sessionID = "ses-goal"): ToolContext {
	return {
		sessionID,
		agent: "sisyphus",
		messageID: "msg-1",
		id: "call-1" as ToolContext["id"],
		signal: new AbortController().signal,
		progress: async () => undefined,
	}
}

function pluginContext(directory: string): Plugin.Context {
	return {
		storage: {} as Plugin.Context["storage"],
		location: { directory } as Plugin.Context["location"],
	} as Plugin.Context
}

describe("native V2 goal tools", () => {
	test("uses the shared per-plugin goal controller and actual tool session ID", async () => {
		const directory = mkdtempSync(join(tmpdir(), "omo-v2-goal-test-"))
		try {
			const ctx = pluginContext(directory)
			const editor = new TestEditor()
			addV2GoalTools(editor as unknown as ToolEditor, ctx, { goal: { enabled: true } } as never)
			const created = await editor.get("create_goal")!.execute({ objective: "Finish the native port" }, context("ses-a"))
			expect(JSON.parse(created.content).goal).toMatchObject({ sessionID: "ses-a", objective: "Finish the native port", status: "active" })
			expect(getV2GoalController(ctx).getGoal("ses-a")?.objective).toBe("Finish the native port")
			const explicit = await editor.get("create_goal")!.execute({ objective: "Explicit target", session_id: "ses-explicit" }, context("ses-a"))
			expect(JSON.parse(explicit.content).goal.sessionID).toBe("ses-explicit")
			expect(getV2GoalController(ctx).getGoal("ses-a")?.objective).toBe("Finish the native port")
			const updated = await editor.get("update_goal")!.execute({ status: "paused" }, context("ses-a"))
			expect(JSON.parse(updated.content).goal.status).toBe("paused")
		} finally {
			rmSync(directory, { recursive: true, force: true })
		}
	})

	test("honors the goal feature gate and per-tool disabled list", () => {
		const ctx = pluginContext(tmpdir())
		const disabledFeature = new TestEditor()
		addV2GoalTools(disabledFeature as unknown as ToolEditor, ctx, {} as never)
		expect(disabledFeature.list()).toHaveLength(0)

		const partiallyDisabled = new TestEditor()
		addV2GoalTools(partiallyDisabled as unknown as ToolEditor, ctx, {
			goal: { enabled: true },
			disabled_tools: ["get_goal"],
		} as never)
		expect(partiallyDisabled.list().map((tool) => tool.name)).toEqual(["create_goal", "update_goal"])
	})
})
