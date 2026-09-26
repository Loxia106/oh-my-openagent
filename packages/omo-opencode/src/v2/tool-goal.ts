import type { Plugin } from "@opencode/plugin"
import type { ToolContext, ToolEditor } from "@opencode/plugin/promise/tool"
import { z } from "zod"
import type { OhMyOpenCodeConfig } from "../config"
import { GoalToolResponseSchema } from "../hooks/goal/types"
import { getV2GoalController } from "./lifecycle"
import { addV2Tool } from "./tool-adapter"

const createInput = z.object({ objective: z.string(), session_id: z.string().optional() })
const updateInput = z.object({
	status: z.enum(["active", "paused", "complete"]).optional(),
	objective: z.string().optional(),
	session_id: z.string().optional(),
})
const getInput = z.object({ session_id: z.string().optional() })

function disabled(config: OhMyOpenCodeConfig, name: string): boolean {
	return config.disabled_tools?.some((entry) => entry.trim().toLowerCase() === name) ?? false
}

function sessionID(args: { session_id?: string }, context: ToolContext): string {
	return args.session_id ?? context.sessionID
}

function response(goal: ReturnType<ReturnType<typeof getV2GoalController>["getGoal"]>) {
	return { content: JSON.stringify(GoalToolResponseSchema.parse({ goal }), null, 2) }
}

/** Native adapters use the actual tool-call session rather than a mutable V1 session closure. */
export function addV2GoalTools(editor: ToolEditor, ctx: Plugin.Context, config: OhMyOpenCodeConfig): void {
	if (!config.goal?.enabled) {
		for (const name of ["create_goal", "update_goal", "get_goal"]) editor.remove(name)
		return
	}
	const controller = getV2GoalController(ctx)
	if (disabled(config, "create_goal")) editor.remove("create_goal")
	else addV2Tool(editor, {
		name: "create_goal",
		description: "Create or replace the active goal for the current session. The goal persists across turns and compaction.",
		input: createInput,
		options: { codemode: false },
		execute: async (args, context) => response(controller.setGoal(sessionID(args, context), args.objective)),
	})

	if (disabled(config, "update_goal")) editor.remove("update_goal")
	else addV2Tool(editor, {
		name: "update_goal",
		description: "Update the active goal by changing its objective or pausing, resuming, or completing it.",
		input: updateInput,
		options: { codemode: false },
		execute: async (args, context) => {
			const id = sessionID(args, context)
			if (args.objective !== undefined) controller.setGoal(id, args.objective)
			if (args.status === "paused") controller.pauseGoal(id)
			else if (args.status === "active") controller.resumeGoal(id)
			else if (args.status === "complete") controller.markComplete(id)
			return response(controller.getGoal(id))
		},
	})

	if (disabled(config, "get_goal")) editor.remove("get_goal")
	else addV2Tool(editor, {
		name: "get_goal",
		description: "Read the active goal for the current session, including status and usage accounting.",
		input: getInput,
		options: { codemode: false },
		execute: async (args, context) => response(controller.getGoal(sessionID(args, context))),
	})
}
