import { z } from "zod"
import type { Plugin } from "@opencode/plugin"

export const V2TodoItemSchema = z.object({
  id: z.string().optional(),
  content: z.string(),
  status: z.enum(["pending", "in_progress", "completed", "cancelled"]),
  priority: z.enum(["low", "medium", "high"]).optional(),
})

export const V2TodoListSchema = z.array(V2TodoItemSchema)
export type V2TodoItem = z.infer<typeof V2TodoItemSchema>

const TODO_KEY_PREFIX = "oh-my-openagent:v2:todos:"

function todoKey(sessionID: string): string {
  return `${TODO_KEY_PREFIX}${encodeURIComponent(sessionID)}`
}

function decodeTodos(value: unknown): V2TodoItem[] {
  const parsed = V2TodoListSchema.safeParse(value)
  return parsed.success ? parsed.data : []
}

/**
 * Per-session todo persistence on OpenCode's plugin storage. Writes are serialized per
 * session within this plugin instance so simultaneous prompts cannot overwrite one another.
 */
export function createV2TodoState(storage: Plugin.Context["storage"]) {
  const queues = new Map<string, Promise<void>>()

  async function serialize<T>(sessionID: string, operation: () => Promise<T>): Promise<T> {
    const previous = queues.get(sessionID) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>((resolve) => {
      release = resolve
    })
    const tail = previous.catch(() => undefined).then(() => current)
    queues.set(sessionID, tail)
    await previous.catch(() => undefined)
    try {
      return await operation()
    } finally {
      release()
      if (queues.get(sessionID) === tail) queues.delete(sessionID)
    }
  }

  return {
    async read(sessionID: string): Promise<V2TodoItem[]> {
      const stored = await storage.get(todoKey(sessionID))
      return decodeTodos(stored)
    },

    async write(sessionID: string, todos: V2TodoItem[]): Promise<V2TodoItem[]> {
      return serialize(sessionID, async () => {
        const normalized = decodeTodos(todos)
        await storage.set(todoKey(sessionID), normalized)
        return normalized
      })
    },

    async update(sessionID: string, updater: (todos: V2TodoItem[]) => V2TodoItem[]): Promise<V2TodoItem[]> {
      return serialize(sessionID, async () => {
        const stored = await storage.get(todoKey(sessionID))
        const next = decodeTodos(updater(decodeTodos(stored)))
        await storage.set(todoKey(sessionID), next)
        return next
      })
    },

    async clear(sessionID: string): Promise<void> {
      return serialize(sessionID, () => storage.remove(todoKey(sessionID)))
    },
  }
}

export type V2TodoState = ReturnType<typeof createV2TodoState>

export type V2SubagentRunStatus = "running" | "completed" | "failed" | "interrupted"
export type V2SubagentRun = {
  readonly parentSessionID: string
  readonly startedAt: number
  readonly status: V2SubagentRunStatus
  readonly blockedActions: readonly string[]
}

const SUBAGENT_RUN_KEY_PREFIX = "oh-my-openagent:v2:subagent-run:"
const SUBAGENT_CHILDREN_KEY_PREFIX = "oh-my-openagent:v2:subagent-children:"
const OBSERVED_SESSIONS_KEY_PREFIX = "oh-my-openagent:v2:observed-sessions:"

function subagentRunKey(sessionID: string): string {
  return `${SUBAGENT_RUN_KEY_PREFIX}${encodeURIComponent(sessionID)}`
}

function subagentChildrenKey(parentSessionID: string): string {
  return `${SUBAGENT_CHILDREN_KEY_PREFIX}${encodeURIComponent(parentSessionID)}`
}

function observedSessionsKey(parentSessionID: string): string {
  return `${OBSERVED_SESSIONS_KEY_PREFIX}${encodeURIComponent(parentSessionID)}`
}

function decodeSubagentRun(value: unknown): V2SubagentRun | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  const candidate = value as Record<string, unknown>
  if (
    typeof candidate.parentSessionID !== "string" ||
    typeof candidate.startedAt !== "number" ||
    !["running", "completed", "failed", "interrupted"].includes(String(candidate.status)) ||
    !Array.isArray(candidate.blockedActions) ||
    !candidate.blockedActions.every((action) => typeof action === "string")
  ) return undefined
  return {
    parentSessionID: candidate.parentSessionID,
    startedAt: candidate.startedAt,
    status: candidate.status as V2SubagentRunStatus,
    blockedActions: candidate.blockedActions as string[],
  }
}

/** Persistent child execution metadata, shared with hooks and background tools. */
export function createV2SubagentRunState(storage: Plugin.Context["storage"]) {
  const writes = new Map<string, Promise<void>>()
  const childWrites = new Map<string, Promise<void>>()

  async function updateChildren(parentSessionID: string, updater: (children: string[]) => string[]): Promise<void> {
    return serializeChildren(parentSessionID, async () => {
      const stored = await storage.get(subagentChildrenKey(parentSessionID))
      const children = Array.isArray(stored) ? stored.filter((value): value is string => typeof value === "string") : []
      await storage.set(subagentChildrenKey(parentSessionID), [...new Set(updater(children))])
    })
  }

  async function serializeChildren<T>(parentSessionID: string, operation: () => Promise<T>): Promise<T> {
    const previous = childWrites.get(parentSessionID) ?? Promise.resolve()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const tail = previous.catch(() => undefined).then(() => gate)
    childWrites.set(parentSessionID, tail)
    await previous.catch(() => undefined)
    try {
      return await operation()
    } finally {
      release()
      if (childWrites.get(parentSessionID) === tail) childWrites.delete(parentSessionID)
    }
  }

  async function update(sessionID: string, updater: (current: V2SubagentRun | undefined) => V2SubagentRun | undefined) {
    const previous = writes.get(sessionID) ?? Promise.resolve()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const tail = previous.catch(() => undefined).then(() => gate)
    writes.set(sessionID, tail)
    await previous.catch(() => undefined)
    try {
      const current = decodeSubagentRun(await storage.get(subagentRunKey(sessionID)))
      const next = updater(current)
      if (next === undefined) await storage.remove(subagentRunKey(sessionID))
      else await storage.set(subagentRunKey(sessionID), next)
      return next
    } finally {
      release()
      if (writes.get(sessionID) === tail) writes.delete(sessionID)
    }
  }

  async function listChildren(parentSessionID: string): Promise<string[]> {
    const stored = await storage.get(subagentChildrenKey(parentSessionID))
    return Array.isArray(stored) ? [...new Set(stored.filter((value) => typeof value === "string"))] : []
  }

  async function removeSession(sessionID: string): Promise<void> {
    for (const childID of await listChildren(sessionID)) await removeSession(childID)
    await storage.remove(subagentChildrenKey(sessionID))
    await storage.remove(observedSessionsKey(sessionID))
    const current = decodeSubagentRun(await storage.get(subagentRunKey(sessionID)))
    await update(sessionID, () => undefined)
    if (current) await updateChildren(current.parentSessionID, (children) => children.filter((id) => id !== sessionID))
  }

  return {
    async get(sessionID: string): Promise<V2SubagentRun | undefined> {
      return decodeSubagentRun(await storage.get(subagentRunKey(sessionID)))
    },
    async recordLaunch(sessionID: string, run: V2SubagentRun): Promise<void> {
      await update(sessionID, (current) => {
        if (current && current.parentSessionID !== run.parentSessionID) {
          throw new Error(`Cannot change parent ownership for subagent session ${sessionID}.`)
        }
        return {
          ...run,
          startedAt: Math.max(current?.startedAt ?? run.startedAt, run.startedAt),
          blockedActions: [...new Set([...(current?.blockedActions ?? []), ...run.blockedActions])],
        }
      })
      await updateChildren(run.parentSessionID, (children) => [...children, sessionID])
    },
    children: listChildren,
    async observed(parentSessionID: string): Promise<string[]> {
      const stored = await storage.get(observedSessionsKey(parentSessionID))
      return Array.isArray(stored) ? [...new Set(stored.filter((value): value is string => typeof value === "string"))] : []
    },
    async observe(parentSessionID: string, sessionID: string): Promise<void> {
      if (parentSessionID === sessionID) return
      return serializeChildren(parentSessionID, async () => {
        const key = observedSessionsKey(parentSessionID)
        const stored = await storage.get(key)
        const observed = Array.isArray(stored) ? stored.filter((value): value is string => typeof value === "string") : []
        await storage.set(key, [...new Set([...observed, sessionID])].slice(-500))
      })
    },
    async markStarted(sessionID: string, timestamp: number): Promise<void> {
      await update(sessionID, (current) => {
        if (!current || timestamp < current.startedAt) return current
        return { ...current, startedAt: timestamp, status: "running" }
      })
    },
    async markTerminal(sessionID: string, status: Exclude<V2SubagentRunStatus, "running">, timestamp: number): Promise<void> {
      await update(sessionID, (current) => {
        if (!current || timestamp < current.startedAt) return current
        return { ...current, status }
      })
    },
    remove: removeSession,
  }
}

export type V2SubagentRunState = ReturnType<typeof createV2SubagentRunState>

const todoStateByStorage = new WeakMap<object, V2TodoState>()
const subagentStateByStorage = new WeakMap<object, V2SubagentRunState>()

/** Shared accessor so tools and hooks observe the same session state and write locks. */
export function getV2TodoState(storage: Plugin.Context["storage"]): V2TodoState {
  const key = storage as object
  const existing = todoStateByStorage.get(key)
  if (existing) return existing
  const created = createV2TodoState(storage)
  todoStateByStorage.set(key, created)
  return created
}

/** Shared accessor for delegation tools, hooks, and background session readers. */
export function getV2SubagentRunState(storage: Plugin.Context["storage"]): V2SubagentRunState {
  const key = storage as object
  const existing = subagentStateByStorage.get(key)
  if (existing) return existing
  const created = createV2SubagentRunState(storage)
  subagentStateByStorage.set(key, created)
  return created
}
