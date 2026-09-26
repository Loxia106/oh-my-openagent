import type { Plugin } from "@opencode/plugin"
import { Error as ToolError, type ToolEditor } from "@opencode/plugin/promise/tool"
import { z } from "zod"
import type { OhMyOpenCodeConfig } from "../config"
import { readSessionHistory } from "./session-history"
import type { V2SubagentRunState, V2TodoState } from "./task-state"
import { addV2Tool } from "./tool-adapter"

const sessionID = z.string().min(1)
const sessionReadInput = z.object({
  session_id: sessionID,
  include_todos: z.boolean().optional(),
  include_transcript: z.boolean().optional(),
  limit: z.number().int().positive().optional(),
  from_end: z.boolean().optional(),
})
const sessionInfoInput = z.object({ session_id: sessionID })
const sessionSearchInput = z.object({
  query: z.string().min(1),
  session_id: sessionID.optional(),
  case_sensitive: z.boolean().optional(),
  limit: z.number().int().positive().optional(),
})
const sessionListInput = z.object({
  limit: z.number().int().positive().optional(),
  from_date: z.string().optional(),
  to_date: z.string().optional(),
  project_path: z.string().optional(),
})

async function getReadableSession(ctx: Plugin.Context, parentSessionID: string, targetSessionID: string, runs: V2SubagentRunState) {
  // Session inspection is read-only. Honor explicit historical session IDs through
  // the public host API; ownership is required only for resume/cancel operations.
  const session = await ctx.session.get({ sessionID: targetSessionID })
  await runs.observe(parentSessionID, targetSessionID)
  return session
}

function disabled(config: OhMyOpenCodeConfig, tool: string): boolean {
  return config.disabled_tools?.some((entry) => entry.trim().toLowerCase() === tool) ?? false
}

/** Inspection is limited to the current session and children created through native delegation. */
export function addV2SessionTools(
  editor: ToolEditor,
  ctx: Plugin.Context,
  config: OhMyOpenCodeConfig,
  runs: V2SubagentRunState,
  todos: V2TodoState,
): void {
  if (!disabled(config, "session_read")) {
    addV2Tool(editor, {
      name: "session_read",
      description: "Read the current or explicitly identified historical session transcript. Global project session enumeration is unavailable in the native plugin API.",
      input: sessionReadInput,
      options: { codemode: false },
      execute: async (args, context) => {
        await getReadableSession(ctx, context.sessionID, args.session_id, runs)
        const parts: string[] = []
        if (args.include_transcript !== false) {
          parts.push(await readSessionHistory(ctx, args.session_id, {
            fullSession: true,
            messageLimit: args.limit,
            fromEnd: args.from_end,
          }))
        }
        if (args.include_todos) {
          const items = await todos.read(args.session_id)
          parts.push(`Todos:\n${items.length ? JSON.stringify(items, null, 2) : "[]"}`)
        }
        return { content: parts.join("\n\n") || "Transcript and todos were not requested." }
      },
    })
  }

  if (!disabled(config, "session_info")) {
    addV2Tool(editor, {
      name: "session_info",
      description: "Inspect the current or explicitly identified historical session. Global project session enumeration is unavailable in the native plugin API.",
      input: sessionInfoInput,
      options: { codemode: false },
      execute: async (args, context) => {
        const session = await getReadableSession(ctx, context.sessionID, args.session_id, runs)
        const messages = await ctx.session.context({ sessionID: args.session_id })
        const todoItems = await todos.read(args.session_id)
        return {
          content: JSON.stringify({
            id: session.id,
            parentID: session.parentID,
            title: session.title,
            agent: session.agent,
            model: session.model,
            directory: session.location.directory,
            created: new Date(session.time.created).toISOString(),
            updated: new Date(session.time.updated).toISOString(),
            idle: session.time.idle === undefined ? undefined : new Date(session.time.idle).toISOString(),
            outcome: session.outcome,
            message_count: messages.length,
            todos: todoItems.length,
          }, null, 2),
        }
      },
    })
  }

  if (!disabled(config, "session_search")) {
    addV2Tool(editor, {
      name: "session_search",
      description: "Search one specified session, or the current session and session IDs observed through this tool plus OMO child sessions. This is not a complete project-wide search.",
      input: sessionSearchInput,
      options: { codemode: false },
      execute: async (args, context) => {
        const ids = args.session_id
          ? [args.session_id]
          : [context.sessionID, ...await runs.children(context.sessionID), ...await runs.observed(context.sessionID)]
        const needle = args.case_sensitive ? args.query : args.query.toLocaleLowerCase()
        const limit = Math.min(args.limit ?? 20, 100)
        const hits: string[] = []
        for (const id of [...new Set(ids)]) {
          try {
            await getReadableSession(ctx, context.sessionID, id, runs)
          } catch (error) {
            if (args.session_id) throw error
            continue
          }
          const transcript = await readSessionHistory(ctx, id, { fullSession: true, messageLimit: 200, fromEnd: true })
          for (const line of transcript.split(/\r?\n/)) {
            const haystack = args.case_sensitive ? line : line.toLocaleLowerCase()
            if (!haystack.includes(needle)) continue
            hits.push(`[${id}] ${line}`)
            if (hits.length >= limit) break
          }
          if (hits.length >= limit) break
        }
        return { content: hits.length ? hits.join("\n") : "No matches found in the current session or its OMO children." }
      },
    })
  }

  if (!disabled(config, "session_list")) {
    addV2Tool(editor, {
      name: "session_list",
      description: "List the current session, OMO child sessions, and historical sessions previously inspected through this tool. This observed-session index is not a complete project-wide listing.",
      input: sessionListInput,
      options: { codemode: false },
      execute: async (args, context) => {
        const ids = [context.sessionID, ...await runs.children(context.sessionID), ...await runs.observed(context.sessionID)]
        const from = args.from_date ? Date.parse(args.from_date) : undefined
        const to = args.to_date ? Date.parse(args.to_date) : undefined
        if ((from !== undefined && !Number.isFinite(from)) || (to !== undefined && !Number.isFinite(to))) {
          throw new ToolError({ message: "from_date and to_date must be valid ISO-8601 dates." })
        }
        const rows = []
        for (const id of [...new Set(ids)]) {
          let session
          try {
            session = await getReadableSession(ctx, context.sessionID, id, runs)
          } catch {
            continue
          }
          const created = session.time.created
          if (args.project_path && session.location.directory !== args.project_path) continue
          if (from !== undefined && created < from) continue
          if (to !== undefined && created > to) continue
          const messages = await ctx.session.context({ sessionID: id })
          rows.push({
            id: session.id,
            parentID: session.parentID,
            title: session.title,
            agent: session.agent,
            created: new Date(created).toISOString(),
            message_count: messages.length,
            outcome: session.outcome,
          })
        }
        return { content: JSON.stringify(rows.slice(0, Math.min(args.limit ?? 50, 100)), null, 2) }
      },
    })
  }
}
