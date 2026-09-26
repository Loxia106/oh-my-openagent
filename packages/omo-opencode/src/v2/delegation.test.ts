import { describe, expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin"
import type { ToolContext, ToolEditor } from "@opencode/plugin/promise/tool"
import { createV2SubagentRunState } from "./task-state"
import { registerV2Delegation, resolveAgentId, toolRestrictionsToActions } from "./delegation"

type RegisteredTool = { id: string; name: string; input: unknown; output?: unknown; description: string; options?: unknown; execute: (args: any, context: ToolContext) => Promise<any> }
class TestEditor {
  readonly tools = new Map<string, RegisteredTool>()
  constructor(tools: RegisteredTool[]) { for (const tool of tools) this.tools.set(tool.name, tool) }
  list() { return [...this.tools.values()] }
  get(name: string) { return this.tools.get(name) }
  add(tool: RegisteredTool) { this.tools.set(tool.name, { ...tool, id: tool.name }) }
  remove(name: string) { this.tools.delete(name) }
  update() {}
  namespace() {}
}

function memoryStorage(): Plugin.Context["storage"] {
  const values = new Map<string, unknown>()
  return {
    get: async (key) => values.get(key),
    set: async (key, value) => { values.set(key, value) },
    remove: async (key) => { values.delete(key) },
  } as Plugin.Context["storage"]
}

function toolContext(sessionID = "ses-parent", agent = "sisyphus", messageID = "msg-1", id = "call-1"): ToolContext {
  return {
    sessionID,
    agent,
    messageID,
    id: id as ToolContext["id"],
    signal: new AbortController().signal,
    progress: async () => undefined,
  }
}

function abortableEvents({ signal }: { signal: AbortSignal }): AsyncIterable<never> {
  return {
    [Symbol.asyncIterator]() {
      return {
        next: () => new Promise<IteratorResult<never>>((resolve) => {
          if (signal.aborted) resolve({ done: true, value: undefined })
          else signal.addEventListener("abort", () => resolve({ done: true, value: undefined }), { once: true })
        }),
      }
    },
  }
}

type HarnessOptions = {
  config?: Record<string, unknown>
  runState?: ReturnType<typeof createV2SubagentRunState>
  nativeExecute?: RegisteredTool["execute"]
  nativePermissionEffect?: "allow" | "ask" | "deny"
  beforePermission?: () => Promise<void>
  agentPermissions?: Record<string, Array<{ action: string; resource: string; effect: "allow" | "ask" | "deny" }>>
  sessions?: Record<string, Record<string, unknown>>
  eventSource?: (signal: AbortSignal) => AsyncIterable<any>
}

async function harness(options: HarnessOptions = {}) {
  const storage = memoryStorage()
  const runs = options.runState ?? createV2SubagentRunState(storage)
  const registered: Array<{ dispose: () => Promise<void> }> = []
  const toolHooks: Array<(event: any) => Promise<void>> = []
  const permissionHooks: Array<(event: any) => Promise<void>> = []
  const permissionEvents: Array<Record<string, any>> = []
  const interrupted: string[] = []
  const nativeCalls: unknown[] = []
  const sessions = new Map<string, Record<string, unknown>>([
    ["ses-parent", { id: "ses-parent", agent: "sisyphus", time: { created: 1, updated: 1 }, location: { directory: "/repo" } }],
    ...Object.entries(options.sessions ?? {}),
  ])
  const native: RegisteredTool = {
    id: "subagent",
    name: "subagent",
    description: "native subagent",
    input: { fields: {} },
    output: { type: "object" },
    execute: async (args, context) => {
      await options.beforePermission?.()
      const permissionEvent: Record<string, any> = {
        sessionID: context.sessionID,
        agent: context.agent,
        action: "subagent",
        resources: [args.agent],
        source: { type: "tool", messageID: context.messageID, id: context.id },
        effect: options.nativePermissionEffect ?? "allow",
      }
      // Native OpenCode skips permission hooks for configured denies.
      if (permissionEvent.effect !== "deny") {
        for (const hook of permissionHooks) await hook(permissionEvent)
      }
      permissionEvents.push({ ...permissionEvent, source: { ...permissionEvent.source } })
      if (permissionEvent.effect === "deny") {
        throw new Error(`Permission denied: subagent. ${String(permissionEvent.message ?? "")}`)
      }
      nativeCalls.push(args)
      return options.nativeExecute ? options.nativeExecute(args, context) : { output: { sessionID: "ses-child", status: "completed", output: "done" }, content: "done" }
    },
  }
  const editor = new TestEditor([native])
  const ctx = {
    storage,
    location: { directory: "/repo" },
    model: { list: async () => ({ data: [] }) },
    agent: { list: async () => ({ data: [
      { id: "sisyphus-junior", mode: "subagent", permissions: options.agentPermissions?.["sisyphus-junior"] ?? [] },
      { id: "explore", mode: "subagent", permissions: options.agentPermissions?.explore ?? [] },
      { id: "librarian", mode: "subagent", permissions: options.agentPermissions?.librarian ?? [] },
      { id: "sisyphus", mode: "primary", permissions: options.agentPermissions?.sisyphus ?? [] },
    ] }) },
    session: {
      get: async ({ sessionID }: { sessionID: string }) => {
        const session = sessions.get(sessionID)
        if (!session) throw new Error(`Unknown session ${sessionID}`)
        return session
      },
      wait: async () => undefined,
      interrupt: async ({ sessionID }: { sessionID: string }) => { interrupted.push(sessionID) },
      context: async () => [{ id: "msg-a", type: "assistant", content: [{ type: "text", text: "latest result" }] }],
    },
    permission: {
      hook: async (_name: string, callback: (event: any) => Promise<void>) => { permissionHooks.push(callback); const registration = { dispose: async () => undefined }; registered.push(registration); return registration },
    },
    tool: {
      transform: async (callback: (editor: TestEditor) => void) => { callback(editor); const registration = { dispose: async () => undefined }; registered.push(registration); return registration },
      hook: async (_name: string, callback: (event: any) => Promise<void>) => { toolHooks.push(callback); const registration = { dispose: async () => undefined }; registered.push(registration); return registration },
    },
    event: { subscribe: ({ signal }: { signal: AbortSignal }) => options.eventSource?.(signal) ?? abortableEvents({ signal }) },
  } as unknown as Plugin.Context
  const runtime = await registerV2Delegation(ctx, (options.config ?? {}) as never, runs)
  return { ctx, editor, runs, runtime, toolHooks, permissionHooks, permissionEvents, interrupted, nativeCalls, sessions }
}

describe("native V2 delegation", () => {
  test("maps disabled native actions and custom OMO tools onto persisted restrictions", () => {
    expect(toolRestrictionsToActions({ bash: false, todowrite: false, task_create: false, write: false })).toEqual([
      "shell", "todowrite", "task_create", "edit",
    ])
    expect(toolRestrictionsToActions({ task: false, delegate_task: false, call_omo_agent: false })).toEqual([
      "task", "call_omo_agent",
    ])
  })

  test("rejects unknown, primary, and disabled agents with actionable errors", async () => {
    expect(() => resolveAgentId("missing", [{ id: "explore", mode: "subagent" }], {} as never))
      .toThrow('Unknown agent "missing"')
    expect(() => resolveAgentId("sisyphus", [{ id: "sisyphus", mode: "primary" }], {} as never))
      .toThrow("cannot run as a subagent")
    expect(() => resolveAgentId("explore", [{ id: "explore", mode: "subagent" }], { disabled_agents: ["explore"] } as never))
      .toThrow("disabled_agents")
  })

  test("keeps Sisyphus task usable while denying its call_omo_agent alias", async () => {
    const instance = await harness({
      nativePermissionEffect: "allow",
      agentPermissions: { sisyphus: [{ action: "call_omo_agent", resource: "*", effect: "deny" }] },
    })
    try {
      expect(instance.editor.get("task")?.options).toMatchObject({ permission: "task" })
      expect(instance.editor.get("call_omo_agent")?.options).toMatchObject({ permission: "call_omo_agent" })

      const taskResult = await instance.editor.get("task")!.execute({ subagent_type: "explore", prompt: "Inspect" }, toolContext())
      expect(taskResult.content).toBe("done")
      expect(instance.permissionEvents.at(-1)?.effect).toBe("allow")

      await expect(instance.editor.get("call_omo_agent")!.execute({
        subagent_type: "explore", prompt: "Research", description: "Research", run_in_background: false,
      }, toolContext())).rejects.toThrow("Permission denied: subagent")
      expect(instance.permissionEvents.at(-1)).toMatchObject({ action: "subagent", effect: "deny" })
      expect(instance.nativeCalls).toHaveLength(1)
    } finally {
      await instance.runtime.cleanup()
    }
  })

  test("keeps Junior task denied while allowing its call_omo_agent alias", async () => {
    const instance = await harness({
      nativePermissionEffect: "allow",
      agentPermissions: { "sisyphus-junior": [
        { action: "task", resource: "*", effect: "deny" },
        { action: "call_omo_agent", resource: "*", effect: "allow" },
      ] },
    })
    const juniorContext = toolContext("ses-parent", "sisyphus-junior")
    try {
      await expect(instance.editor.get("task")!.execute({ subagent_type: "explore", prompt: "Implement" }, juniorContext))
        .rejects.toThrow("Permission denied: subagent")
      expect(instance.permissionEvents.at(-1)).toMatchObject({ action: "subagent", effect: "deny" })

      const result = await instance.editor.get("call_omo_agent")!.execute({
        subagent_type: "explore", prompt: "Research", description: "Research", run_in_background: false,
      }, juniorContext)
      expect(result.content).toBe("done")
      expect(instance.permissionEvents.at(-1)?.effect).toBe("allow")
      expect(instance.nativeCalls).toHaveLength(1)

      await expect(instance.editor.get("subagent")!.execute({
        agent: "explore", description: "Direct native call", prompt: "Inspect",
      }, juniorContext)).rejects.toThrow("Permission denied: subagent")
      expect(instance.permissionEvents.at(-1)).toMatchObject({ action: "subagent", effect: "deny" })
      expect(instance.nativeCalls).toHaveLength(1)
    } finally {
      await instance.runtime.cleanup()
    }
  })

  test("does not let alias allow loosen native ask or deny", async () => {
    const asking = await harness({
      nativePermissionEffect: "ask",
      agentPermissions: { "sisyphus-junior": [{ action: "call_omo_agent", resource: "*", effect: "allow" }] },
    })
    try {
      await asking.editor.get("call_omo_agent")!.execute({
        subagent_type: "explore", prompt: "Research", description: "Research", run_in_background: false,
      }, toolContext("ses-parent", "sisyphus-junior"))
      expect(asking.permissionEvents.at(-1)?.effect).toBe("ask")
    } finally {
      await asking.runtime.cleanup()
    }

    const denying = await harness({
      nativePermissionEffect: "deny",
      agentPermissions: { "sisyphus-junior": [{ action: "call_omo_agent", resource: "*", effect: "allow" }] },
    })
    try {
      await expect(denying.editor.get("call_omo_agent")!.execute({
        subagent_type: "explore", prompt: "Research", description: "Research", run_in_background: false,
      }, toolContext("ses-parent", "sisyphus-junior"))).rejects.toThrow("Permission denied: subagent")
      expect(denying.permissionEvents.at(-1)?.effect).toBe("deny")
      expect(denying.nativeCalls).toHaveLength(0)
    } finally {
      await denying.runtime.cleanup()
    }
  })

  test("cleans alias correlation in finally after a launch failure", async () => {
    const instance = await harness({
      nativePermissionEffect: "allow",
      agentPermissions: { "sisyphus-junior": [
        { action: "task", resource: "*", effect: "deny" },
        { action: "call_omo_agent", resource: "*", effect: "allow" },
      ] },
      nativeExecute: async () => { throw new Error("child launch failed") },
    })
    const juniorContext = toolContext("ses-parent", "sisyphus-junior")
    try {
      await expect(instance.editor.get("call_omo_agent")!.execute({
        subagent_type: "explore", prompt: "Research", description: "Research", run_in_background: false,
      }, juniorContext)).rejects.toThrow("child launch failed")

      const directNativeCheck: Record<string, any> = {
        sessionID: "ses-parent",
        agent: "sisyphus-junior",
        action: "subagent",
        resources: ["explore"],
        source: { type: "tool", messageID: "msg-1", id: "call-1" },
        effect: "allow",
      }
      await instance.permissionHooks[0]!(directNativeCheck)
      expect(directNativeCheck.effect).toBe("deny")
    } finally {
      await instance.runtime.cleanup()
    }
  })

  test("keeps alias correlation until the native background launch settles, then clears it", async () => {
    let start!: () => void
    let release!: () => void
    const started = new Promise<void>((resolve) => { start = resolve })
    const gate = new Promise<void>((resolve) => { release = resolve })
    const instance = await harness({
      nativePermissionEffect: "allow",
      agentPermissions: { "sisyphus-junior": [
        { action: "task", resource: "*", effect: "deny" },
        { action: "call_omo_agent", resource: "*", effect: "allow" },
      ] },
      nativeExecute: async () => {
        start()
        await gate
        return { content: "background accepted" }
      },
    })
    const juniorContext = toolContext("ses-parent", "sisyphus-junior")
    const event = () => ({
      sessionID: "ses-parent",
      agent: "sisyphus-junior",
      action: "subagent",
      resources: ["explore"],
      source: { type: "tool", messageID: "msg-1", id: "call-1" },
      effect: "allow",
    })
    try {
      const executing = instance.editor.get("call_omo_agent")!.execute({
        subagent_type: "explore", prompt: "Research", description: "Research", run_in_background: true,
      }, juniorContext)
      await started

      const inFlight = event()
      await instance.permissionHooks[0]!(inFlight)
      expect(inFlight.effect).toBe("allow")

      release()
      await executing

      const afterCompletion = event()
      await instance.permissionHooks[0]!(afterCompletion)
      expect(afterCompletion.effect).toBe("deny")
    } finally {
      release()
      await instance.runtime.cleanup()
    }
  })

  test("isolates concurrent alias calls that reuse a provider call ID", async () => {
    let entered = 0
    let bothEntered!: () => void
    let release!: () => void
    const ready = new Promise<void>((resolve) => { bothEntered = resolve })
    const gate = new Promise<void>((resolve) => { release = resolve })
    const instance = await harness({
      nativePermissionEffect: "allow",
      beforePermission: async () => {
        entered++
        if (entered === 2) bothEntered()
        await gate
      },
      agentPermissions: {
        sisyphus: [
          { action: "task", resource: "*", effect: "allow" },
          { action: "call_omo_agent", resource: "*", effect: "deny" },
        ],
        "sisyphus-junior": [
          { action: "task", resource: "*", effect: "deny" },
          { action: "call_omo_agent", resource: "*", effect: "allow" },
        ],
      },
      sessions: { "ses-junior": {
        id: "ses-junior", agent: "sisyphus-junior", time: { created: 2, updated: 2 }, location: { directory: "/repo" },
      } },
    })
    const sisyphusContext = toolContext("ses-parent", "sisyphus", "msg-one", "call-reused")
    const juniorContext = toolContext("ses-junior", "sisyphus-junior", "msg-two", "call-reused")
    try {
      const sisyphusTask = instance.editor.get("task")!.execute({ subagent_type: "explore", prompt: "Inspect" }, sisyphusContext)
      const juniorResearch = instance.editor.get("call_omo_agent")!.execute({
        subagent_type: "explore", prompt: "Research", description: "Research", run_in_background: false,
      }, juniorContext)
      await ready
      release()
      const [taskResult, researchResult] = await Promise.all([sisyphusTask, juniorResearch])
      expect(taskResult.content).toBe("done")
      expect(researchResult.content).toBe("done")
      expect(instance.permissionEvents.find((event) => event.sessionID === "ses-parent")?.effect).toBe("allow")
      expect(instance.permissionEvents.find((event) => event.sessionID === "ses-junior")?.effect).toBe("allow")
    } finally {
      release()
      await instance.runtime.cleanup()
    }
  })

  test("preserves category task and call_omo_agent restrictions as separate aliases", async () => {
    const runState = createV2SubagentRunState(memoryStorage())
    const instance = await harness({
      runState,
      config: { categories: { task_restricted: { tools: { task: false } } } },
      agentPermissions: { "sisyphus-junior": [{ action: "call_omo_agent", resource: "*", effect: "allow" }] },
      sessions: { "ses-child": {
        id: "ses-child", parentID: "ses-parent", agent: "sisyphus-junior", permissions: [], time: { idle: 100 },
      } },
      nativeExecute: async (_args, context) => {
        if (context.sessionID === "ses-parent") {
          await context.progress({ sessionID: "ses-child" })
          return { output: { sessionID: "ses-child", status: "completed", output: "done" }, content: "done" }
        }
        return { output: { sessionID: "ses-grandchild", status: "completed", output: "done" }, content: "done" }
      },
    })
    try {
      await instance.editor.get("task")!.execute({ category: "task_restricted", prompt: "Inspect" }, toolContext())
      expect(await runState.get("ses-child")).toMatchObject({ blockedActions: ["task"] })

      const juniorContext = toolContext("ses-child", "sisyphus-junior")
      const callResult = await instance.editor.get("call_omo_agent")!.execute({
        subagent_type: "explore", prompt: "Research", description: "Research", run_in_background: false,
      }, juniorContext)
      expect(callResult.content).toBe("done")

      await expect(instance.editor.get("subagent")!.execute({
        agent: "explore", description: "Direct native call", prompt: "Inspect",
      }, { ...juniorContext, id: "call-direct" as ToolContext["id"] })).rejects.toThrow("task")
    } finally {
      await instance.runtime.cleanup()
    }
  })

  test("matches alias permission action and resource wildcards like OpenCode", async () => {
    const instance = await harness({
      nativePermissionEffect: "allow",
      agentPermissions: { sisyphus: [{ action: "ta?k", resource: "explo*", effect: "deny" }] },
    })
    try {
      await expect(instance.editor.get("task")!.execute({ subagent_type: "explore", prompt: "Inspect" }, toolContext()))
        .rejects.toThrow("Permission denied: subagent")
      expect(instance.permissionEvents.at(-1)?.effect).toBe("deny")
    } finally {
      await instance.runtime.cleanup()
    }
  })

  test("persists category tool restrictions before launching and blocks OMO custom tools", async () => {
    let observedAtLaunch: unknown
    const runState = createV2SubagentRunState(memoryStorage())
    const instance = await harness({
      runState,
      config: { categories: { restricted: { tools: { todowrite: false, write: false } } } },
      sessions: { "ses-child": { id: "ses-child", parentID: "ses-parent", agent: "explore", permissions: [], time: { idle: 100 } } },
      nativeExecute: async (_args, context) => {
        await context.progress({ sessionID: "ses-child" })
        observedAtLaunch = await runState.get("ses-child")
        return { output: { sessionID: "ses-child", status: "completed", output: "done" }, content: "done" }
      },
    })
    try {
      await instance.editor.get("task")!.execute({ category: "restricted", prompt: "Inspect" }, toolContext())
      expect(observedAtLaunch).toMatchObject({ parentSessionID: "ses-parent", status: "running", blockedActions: ["todowrite", "edit"] })
      await expect(instance.toolHooks[0]!({ sessionID: "ses-child", tool: "todowrite" }))
        .rejects.toThrow("tool restrictions")
      const permission = { sessionID: "ses-child", action: "edit", resources: ["/repo/a.ts"], effect: "allow" }
      await instance.permissionHooks[0]!(permission)
      expect(permission.effect).toBe("deny")
    } finally {
      await instance.runtime.cleanup()
    }
  })

  test("resumes an owned category task without selectors and never weakens its restrictions or model", async () => {
    const instance = await harness({
      config: { categories: {
        restricted: { tools: { todowrite: false } },
        broad: { tools: { todowrite: true } },
      } },
      sessions: { "ses-child": {
        id: "ses-child",
        parentID: "ses-parent",
        agent: "sisyphus-junior",
        model: { providerID: "qa", id: "stored-model" },
        time: { created: 100, updated: 100 },
      } },
      nativeExecute: async (_args, context) => {
        await context.progress({ sessionID: "ses-child" })
        return { output: { sessionID: "ses-child", status: "completed", output: "continued" }, content: "continued" }
      },
    })
    const task = instance.editor.get("task")!
    const context = toolContext()
    const expectTodoDenied = async () => {
      const permission = { sessionID: "ses-child", action: "todowrite", resources: [], effect: "allow" }
      await instance.permissionHooks[0]!(permission)
      expect(permission.effect).toBe("deny")
    }
    try {
      await task.execute({ category: "restricted", prompt: "Start restricted task" }, context)
      expect(await instance.runs.get("ses-child")).toMatchObject({ blockedActions: ["todowrite"] })

      await task.execute({ task_id: "ses-child", prompt: "Continue without a selector" }, context)
      expect(instance.nativeCalls.at(-1)).toMatchObject({ agent: "sisyphus-junior", sessionID: "ses-child" })
      expect(instance.nativeCalls.at(-1)).not.toHaveProperty("model")
      await expectTodoDenied()

      await task.execute({ task_id: "ses-child", subagent_type: "sisyphus-junior", prompt: "Continue by agent" }, context)
      expect(instance.nativeCalls.at(-1)).toMatchObject({ agent: "sisyphus-junior", sessionID: "ses-child" })
      expect(instance.nativeCalls.at(-1)).not.toHaveProperty("model")
      await expectTodoDenied()

      await task.execute({ task_id: "ses-child", category: "broad", prompt: "Continue by broader category" }, context)
      expect(instance.nativeCalls.at(-1)).toMatchObject({ agent: "sisyphus-junior", sessionID: "ses-child" })
      expect(instance.nativeCalls.at(-1)).not.toHaveProperty("model")
      await expectTodoDenied()
      expect(new Set((await instance.runs.get("ses-child"))?.blockedActions)).toEqual(new Set(["todowrite"]))
    } finally {
      await instance.runtime.cleanup()
    }
  })

  test("revalidates the inferred child agent and rejects foreign or different-agent resumes", async () => {
    const child = { id: "ses-child", parentID: "ses-parent", agent: "explore", time: { created: 1, updated: 1 } }
    const disabled = await harness({
      config: { disabled_agents: ["explore"] },
      sessions: { "ses-child": child },
    })
    try {
      await expect(disabled.editor.get("task")!.execute({ task_id: "ses-child", prompt: "Continue" }, toolContext()))
        .rejects.toThrow("disabled_agents")
      expect(disabled.nativeCalls).toHaveLength(0)
    } finally {
      await disabled.runtime.cleanup()
    }

    const instance = await harness({ sessions: {
      "ses-child": child,
      "ses-foreign": { id: "ses-foreign", parentID: "ses-other", agent: "explore", time: { created: 1, updated: 1 } },
    } })
    try {
      await expect(instance.editor.get("task")!.execute({
        task_id: "ses-child", subagent_type: "librarian", prompt: "Change agent",
      }, toolContext())).rejects.toThrow("different agent")
      await expect(instance.editor.get("task")!.execute({ task_id: "ses-foreign", prompt: "Foreign" }, toolContext()))
        .rejects.toThrow("not a child")
      expect(instance.nativeCalls).toHaveLength(0)
    } finally {
      await instance.runtime.cleanup()
    }
  })

  test("cancels only verified owned child sessions and records interruption", async () => {
    const storage = memoryStorage()
    const runs = createV2SubagentRunState(storage)
    await runs.recordLaunch("ses-child", { parentSessionID: "ses-parent", startedAt: 100, status: "running", blockedActions: [] })
    const instance = await harness({ runState: runs, sessions: {
      "ses-child": { id: "ses-child", parentID: "ses-parent", agent: "explore", time: { idle: 100 } },
      "ses-foreign": { id: "ses-foreign", parentID: "ses-other", agent: "explore", time: { idle: 100 } },
    } })
    try {
      const result = await instance.editor.get("background_cancel")!.execute({ taskId: "ses-child" }, toolContext())
      expect(instance.interrupted).toEqual(["ses-child"])
      expect(await runs.get("ses-child")).toMatchObject({ status: "interrupted" })
      expect(result.content).toContain("ses-child")
      await expect(instance.editor.get("background_cancel")!.execute({ taskId: "ses-foreign" }, toolContext()))
        .rejects.toThrow("not a child")
      expect(instance.interrupted).toEqual(["ses-child"])
    } finally {
      await instance.runtime.cleanup()
    }
  })

  test("waits for an unknown-but-owned child and reports an authoritative terminal result", async () => {
    const instance = await harness({ sessions: { "ses-child": {
      id: "ses-child", parentID: "ses-parent", agent: "explore", outcome: "succeeded", time: { idle: 200 },
    } } })
    try {
      const result = await instance.editor.get("background_output")!.execute({ task_id: "ses-child", block: true }, toolContext())
      expect(result.content).toContain("Status: completed")
      expect(await instance.runs.get("ses-child")).toMatchObject({ status: "completed", parentSessionID: "ses-parent" })
    } finally {
      await instance.runtime.cleanup()
    }
  })

  test("does not treat a prior successful outcome as current while a resumed child has not idled", async () => {
    const storage = memoryStorage()
    const runs = createV2SubagentRunState(storage)
    await runs.recordLaunch("ses-child", { parentSessionID: "ses-parent", startedAt: 300, status: "running", blockedActions: [] })
    const instance = await harness({ runState: runs, sessions: { "ses-child": {
      id: "ses-child", parentID: "ses-parent", agent: "explore", outcome: "succeeded", time: { idle: 200 },
    } } })
    try {
      const result = await instance.editor.get("background_output")!.execute({ task_id: "ses-child", block: false }, toolContext())
      expect(result.content).toContain("Status: running")
      expect(await runs.get("ses-child")).toMatchObject({ status: "running", startedAt: 300 })
    } finally {
      await instance.runtime.cleanup()
    }
  })

  test("prunes deleted child metadata when the host emits session.deleted", async () => {
    const storage = memoryStorage()
    const runs = createV2SubagentRunState(storage)
    await runs.recordLaunch("ses-child", { parentSessionID: "ses-parent", startedAt: 100, status: "running", blockedActions: [] })
    const instance = await harness({
      runState: runs,
      eventSource: (signal) => (async function* () {
        yield { type: "session.deleted", data: { sessionID: "ses-child" }, created: 200 }
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve()
          else signal.addEventListener("abort", () => resolve(), { once: true })
        })
      })(),
    })
    try {
      for (let attempt = 0; attempt < 40 && await runs.get("ses-child"); attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      expect(await runs.get("ses-child")).toBeUndefined()
      expect(await runs.children("ses-parent")).toEqual([])
    } finally {
      await instance.runtime.cleanup()
    }
  })
})
