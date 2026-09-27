import type { Plugin } from "@opencode/plugin"
import { Error as ToolError, type ToolEditor } from "@opencode/plugin/promise/tool"
import { z } from "zod"
import type { OhMyOpenCodeConfig } from "../config"
import { readSessionHistory } from "./session-history"
import { getV2SessionIndex } from "./session-index"
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
const SEARCH_SESSION_LIMIT = 100

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
  await getV2SessionIndex(ctx).upsert(session).catch(() => undefined)
  return session
}

function disabled(config: OhMyOpenCodeConfig, tool: string): boolean {
  return config.disabled_tools?.some((entry) => entry.trim().toLowerCase() === tool) ?? false
}

/** Current, child, observed and OMO-indexed sessions of this project, newest first, without duplicates. */
async function projectSessionIDs(ctx: Plugin.Context, sessionID: string, runs: V2SubagentRunState, limit?: number): Promise<string[]> {
  const indexed = (await getV2SessionIndex(ctx).list().catch(() => [])).map((record) => record.id)
  const ids = [...new Set([sessionID, ...await runs.children(sessionID), ...await runs.observed(sessionID), ...indexed])]
  return limit === undefined ? ids : ids.slice(0, limit)
}

/**
 * Session tools read explicit session IDs through the native API and enumerate this project's sessions
 * from the durable OMO session index (sessions observed while OMO is active).
 */
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
      description: "Read the current or an explicitly identified historical session transcript. Use session_list to find this project's sessions.",
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
      description: "Inspect the current or an explicitly identified historical session. Use session_list to find this project's sessions.",
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
      description: "Search one specified session, or this project's sessions (current, OMO children, and sessions indexed while OMO is active; newest 100).",
      input: sessionSearchInput,
      options: { codemode: false },
      execute: async (args, context) => {
        const ids = args.session_id
          ? [args.session_id]
          : await projectSessionIDs(ctx, context.sessionID, runs, SEARCH_SESSION_LIMIT)
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
        return { content: hits.length ? hits.join("\n") : "No matches found in the searched project sessions." }
      },
    })
  }

  if (!disabled(config, "session_list")) {
    addV2Tool(editor, {
      name: "session_list",
      description: "List this project's sessions: the current session, OMO children, and sessions indexed while OMO is active (older sessions remain readable by explicit ID).",
      input: sessionListInput,
      options: { codemode: false },
      execute: async (args, context) => {
        const ids = await projectSessionIDs(ctx, context.sessionID, runs)
        const from = args.from_date ? Date.parse(args.from_date) : undefined
        const to = args.to_date ? Date.parse(args.to_date) : undefined
        if ((from !== undefined && !Number.isFinite(from)) || (to !== undefined && !Number.isFinite(to))) {
          throw new ToolError({ message: "from_date and to_date must be valid ISO-8601 dates." })
        }
        const limit = Math.min(args.limit ?? 50, 100)
        const candidates = []
        for (const id of ids) {
          let session
          try {
            session = await ctx.session.get({ sessionID: id })
          } catch {
            continue
          }
          if (String(session.projectID) !== String(ctx.location.project.id)) continue
          const created = session.time.created
          if (args.project_path && session.location.directory !== args.project_path) continue
          if (from !== undefined && created < from) continue
          if (to !== undefined && created > to) continue
          candidates.push(session)
        }
        candidates.sort((left, right) => right.time.created - left.time.created)
        const rows = []
        for (const session of candidates.slice(0, limit)) {
          const messages = await ctx.session.context({ sessionID: session.id })
          rows.push({
            id: session.id,
            parentID: session.parentID,
            title: session.title,
            agent: session.agent,
            directory: session.location.directory,
            created: new Date(session.time.created).toISOString(),
            message_count: messages.length,
            outcome: session.outcome,
          })
        }
        return { content: JSON.stringify(rows, null, 2) }
      },
    })
  }
}
