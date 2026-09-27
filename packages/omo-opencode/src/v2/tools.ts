import type { Plugin } from "@opencode/plugin"
import type { ToolEditor } from "@opencode/plugin/promise/tool"
import { z } from "zod"
import type { OhMyOpenCodeConfig } from "../config"
import { addV2Tool } from "./tool-adapter"
import { registerV2Delegation } from "./delegation"
import { getV2SubagentRunState, getV2TodoState } from "./task-state"
import { addV2FilesystemTools } from "./tool-filesystem"
import { addV2SessionTools } from "./tool-session"
import { addV2TaskSystemTools } from "./tool-task"
import { addV2GoalTools } from "./tool-goal"
import { registerV2DisabledToolGuard } from "./tool-disabled-guard"
import { addV2SkillMcpTool, registerV2SkillMcpRuntime } from "./tool-skill-mcp"
import type { createV2TeamManager } from "./team-mode"
import { registerV2InteractiveBashTool } from "./interactive-bash"

const todoInput = z.object({
  todos: z.array(z.object({
    id: z.string().optional(),
    content: z.string(),
    status: z.enum(["pending", "in_progress", "completed", "cancelled"]),
    priority: z.enum(["low", "medium", "high"]).optional(),
  })),
})

const emptyInput = z.object({}).strict()

function disabled(config: OhMyOpenCodeConfig, name: string): boolean {
  return config.disabled_tools?.some((entry) => entry.trim().toLowerCase() === name) ?? false
}

function addTodoTools(editor: ToolEditor, ctx: Plugin.Context, config: OhMyOpenCodeConfig) {
  const state = getV2TodoState(ctx.storage)
  if (!disabled(config, "todowrite") && !editor.get("todowrite")) {
    addV2Tool(editor, {
      name: "todowrite",
      description: "Replace the current session's todo list. Todo data persists across turns and compaction.",
      input: todoInput,
      options: { codemode: false },
      execute: async (args, context) => {
        const todos = await state.write(context.sessionID, args.todos)
        return {
          content: `Todo list updated (${todos.length} item${todos.length === 1 ? "" : "s"}).`,
          metadata: { sessionID: context.sessionID, todos },
        }
      },
    })
  }
  if (!disabled(config, "todoread") && !editor.get("todoread")) {
    addV2Tool(editor, {
      name: "todoread",
      description: "Read the current session's persisted todo list, including after compaction or a new prompt.",
      input: emptyInput,
      options: { codemode: false },
      execute: async (_args, context) => {
        const todos = await state.read(context.sessionID)
        return {
          content: JSON.stringify(todos, null, 2),
          metadata: { sessionID: context.sessionID, todos },
        }
      },
    })
  }
  if (disabled(config, "todowrite")) editor.remove("todowrite")
  if (disabled(config, "todoread")) editor.remove("todoread")
}

function addNativeTools(editor: ToolEditor, ctx: Plugin.Context, config: OhMyOpenCodeConfig, skillMcp?: Awaited<ReturnType<typeof registerV2SkillMcpRuntime>>): void {
	addTodoTools(editor, ctx, config)
	addV2SkillMcpTool(editor, skillMcp)
  addV2FilesystemTools(editor, ctx, config)
  const runs = getV2SubagentRunState(ctx.storage)
  const todos = getV2TodoState(ctx.storage)
  addV2SessionTools(editor, ctx, config, runs, todos)
  addV2TaskSystemTools(editor, config, todos, String(ctx.location.directory))
  addV2GoalTools(editor, ctx, config)
}

export async function disposeV2ToolRegistrations(cleanups: readonly (() => Promise<void>)[]): Promise<void> {
  const errors: unknown[] = []
  for (const cleanup of [...cleanups].reverse()) {
    try {
      await cleanup()
    } catch (error) {
      errors.push(error)
    }
  }
  if (errors.length > 0) throw new AggregateError(errors, "One or more V2 tool registrations failed to clean up")
}

export async function registerV2Tools(
  ctx: Plugin.Context,
  config: OhMyOpenCodeConfig,
  options: { team?: ReturnType<typeof createV2TeamManager>; isStopped?: (sessionID: string) => boolean | Promise<boolean> } = {},
): Promise<{ cleanup: () => Promise<void>; startManagedSessions: () => Promise<void> }> {
	let skillMcp: Awaited<ReturnType<typeof registerV2SkillMcpRuntime>>
	let toolRegistration: Awaited<ReturnType<typeof ctx.tool.transform>> | undefined
	let delegation: Awaited<ReturnType<typeof registerV2Delegation>> | undefined
	let disabledToolGuard: (() => Promise<void>) | undefined
	let teamTools: Awaited<ReturnType<typeof ctx.tool.transform>> | undefined
	let interactiveBash: (() => Promise<void>) | undefined
	try {
		skillMcp = await registerV2SkillMcpRuntime(ctx, config)
		toolRegistration = await ctx.tool.transform((editor) => addNativeTools(editor, ctx, config, skillMcp))
		delegation = await registerV2Delegation(ctx, config, getV2SubagentRunState(ctx.storage), {
			resolveLogicalParent: options.team?.resolveLogicalParent,
			isStopped: options.isStopped,
		})
		if (options.team) {
			teamTools = await ctx.tool.transform((editor) => options.team!.createTools(editor))
		}
		interactiveBash = await registerV2InteractiveBashTool(ctx, config)
		disabledToolGuard = await registerV2DisabledToolGuard(ctx, config)
	} catch (error) {
		const cleanups: Array<() => Promise<void>> = []
		if (skillMcp) cleanups.push(() => skillMcp!.cleanup())
		if (toolRegistration) cleanups.push(() => toolRegistration!.dispose())
		if (delegation) cleanups.push(() => delegation!.cleanup())
		if (options.team) cleanups.push(() => options.team!.dispose())
		if (teamTools) cleanups.push(() => teamTools!.dispose())
		if (interactiveBash) cleanups.push(interactiveBash)
    if (disabledToolGuard) cleanups.push(disabledToolGuard)
    try {
      await disposeV2ToolRegistrations(cleanups)
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "V2 tool setup failed and cleanup was incomplete")
    }
    throw error
  }

  let disposed = false
	let managedSessionsStarted = false
	const cleanup = async () => {
		if (disposed) return
		disposed = true
		const cleanups: Array<() => Promise<void>> = []
		if (skillMcp) cleanups.push(() => skillMcp!.cleanup())
		if (toolRegistration) cleanups.push(() => toolRegistration!.dispose())
		cleanups.push(async () => delegation?.cleanup())
		if (options.team) cleanups.push(() => options.team!.dispose())
		if (teamTools) cleanups.push(() => teamTools!.dispose())
		if (interactiveBash) cleanups.push(interactiveBash)
		cleanups.push(async () => disabledToolGuard?.())
		await disposeV2ToolRegistrations(cleanups)
	}
	return {
		cleanup,
		async startManagedSessions() {
			if (disposed) throw new Error("Cannot start managed sessions after tool cleanup")
			if (managedSessionsStarted) return
			managedSessionsStarted = true
			if (options.team && delegation) {
				await options.team.start({ admission: delegation.admission, runs: delegation.runs })
			}
		},
	}
}
