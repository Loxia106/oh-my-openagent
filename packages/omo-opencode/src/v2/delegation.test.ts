import { describe, expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin"
import { Error as ToolError, type ToolContext, type ToolEditor } from "@opencode/plugin/promise/tool"
import { createV2SubagentRunState } from "./task-state"
import { registerV2Delegation, resolveAgentId, toolRestrictionsToActions, v2BackgroundTaskID } from "./delegation"

type RegisteredTool = { id: string; name: string; input: unknown; output?: unknown; description: string; options?: unknown; execute: (args: any, context: ToolContext) => Promise<any> }
class TestEditor {
  readonly tools = new Map<string, RegisteredTool>()
  constructor(tools: RegisteredTool[]) { for (const tool of tools) this.tools.set(tool.name, tool) }
  list() { return [...this.tools.values()] }
  get(name: string) { return this.tools.get(name) }
  add(tool: RegisteredTool) { this.tools.set(tool.name, { ...tool, id: tool.name }) }
  remove(name: string) { this.tools.delete(name) }
  update(name: string, update: (tool: RegisteredTool) => void) {
    const tool = this.tools.get(name)
    if (tool) update(tool)
  }
  namespace() {}
}

function memoryStorage(): Plugin.Context["storage"] & { values: Map<string, unknown> } {
  const values = new Map<string, unknown>()
  return Object.assign({
    get: async (key) => values.get(key),
    set: async (key, value) => { values.set(key, value) },
    remove: async (key) => { values.delete(key) },
    scan: async ({ prefix, after, limit = 100 }: { prefix: string; after?: string; limit?: number }) => {
      const keys = [...values.keys()].filter((key) => key.startsWith(prefix)).sort().filter((key) => !after || key > after)
      const entries = keys.slice(0, limit).map((key) => ({ key, value: values.get(key) }))
      return { entries, ...(keys.length > entries.length ? { next: entries.at(-1)?.key } : {}) }
    },
  }, { values }) as Plugin.Context["storage"] & { values: Map<string, unknown> }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1500
  while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 2))
  expect(predicate()).toBe(true)
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

const SHELL_PERMISSION_RESOURCE = "printf 'permission-order\\n' >> '/repo/.qa-output/out.txt'"

function shellPermissionEvent(sessionID = "ses-parent") {
  return { sessionID, action: "shell", resources: [SHELL_PERMISSION_RESOURCE], effect: "allow" }
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
  models?: Array<{ id: string; providerID: string; enabled: boolean; variants?: Array<{ id: string; settings?: Record<string, unknown> }> }>
  parentModel?: { providerID: string; id: string; variant?: string }
  runState?: ReturnType<typeof createV2SubagentRunState>
  nativeExecute?: RegisteredTool["execute"]
  nativePermissionEffect?: "allow" | "ask" | "deny"
  beforePermission?: () => Promise<void>
  agentPermissions?: Record<string, Array<{ action: string; resource: string; effect: "allow" | "ask" | "deny" }>>
  sessions?: Record<string, Record<string, unknown>>
  eventSource?: (signal: AbortSignal) => AsyncIterable<any>
  resolveLogicalParent?: (sessionID: string) => Promise<string | undefined>
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
  const defaultModels = (options.models ?? [{ id: "default-model", providerID: "provider", enabled: true }])
    .map((model) => ({ ...model, modelID: model.id, variants: (model as any).variants ?? [] }))
  const sessions = new Map<string, Record<string, unknown>>([
    ["ses-parent", { id: "ses-parent", projectID: "project-main", agent: "sisyphus", model: options.parentModel ?? { providerID: "provider", id: "default-model" }, time: { created: 1, updated: 1 }, location: { directory: "/repo" } }],
    ...Object.entries(options.sessions ?? {}).map(([id, session]) => [id, {
      projectID: "project-main", location: { directory: "/repo" }, ...session,
    }] as const),
  ])
  const parseModel = (value: unknown) => {
    const text = typeof value === "string" ? value.split("#", 1)[0]! : "provider/default-model"
    const slash = text.indexOf("/")
    return slash > 0 ? { providerID: text.slice(0, slash), id: text.slice(slash + 1) } : { providerID: "provider", id: "default-model" }
  }
  const childFor = (args: any, context: ToolContext, sessionID: string) => {
    if (!sessions.has(sessionID)) {
      sessions.set(sessionID, {
        id: sessionID,
        parentID: context.sessionID,
        projectID: "project-main",
        location: { directory: "/repo" },
        agent: args.agent,
        model: parseModel(args.model),
        time: { created: Date.now(), updated: Date.now(), idle: 1 },
      })
    }
  }
  let generatedChild = 0
  const nativeInputSchema = { fields: { nativeSubagent: true } }
  const nativeOutputSchema = { type: "object" }
  const native: RegisteredTool = {
    id: "subagent",
    name: "subagent",
    description: "native subagent",
    input: nativeInputSchema,
    output: nativeOutputSchema,
    options: { codemode: false, permission: "subagent" },
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
      const hostContext: ToolContext = {
        ...context,
        progress: async (metadata) => {
          const sessionID = typeof (metadata as any)?.sessionID === "string" ? (metadata as any).sessionID : undefined
          if (sessionID) childFor(args, context, sessionID)
          await context.progress(metadata)
        },
      }
      const fallbackSessionID = typeof args.sessionID === "string" ? args.sessionID : `ses-child-${++generatedChild}`
      if (!options.nativeExecute) {
        childFor(args, context, fallbackSessionID)
        await hostContext.progress({ sessionID: fallbackSessionID, status: "running" } as any)
        return { output: { sessionID: fallbackSessionID, status: "completed", output: "done" }, content: "done" }
      }
      return options.nativeExecute(args, hostContext)
    },
  }
  const nativeRead: RegisteredTool = {
    id: "read", name: "read", input: { fields: {} }, output: { type: "object" }, description: "native read",
    execute: async () => ({ output: { type: "file", encoding: "base64", mime: "image/png" }, content: "image" }),
  }
  const editor = new TestEditor([native, nativeRead])
  const ctx = {
    storage,
    location: { directory: "/repo", workspaceID: "workspace-main", project: { id: "project-main" } },
    model: {
      list: async () => ({ data: defaultModels }),
      default: async () => ({ data: defaultModels.find((model) => model.enabled) ?? null }),
    },
    agent: { list: async () => ({ data: [
      { id: "sisyphus-junior", mode: "subagent", permissions: options.agentPermissions?.["sisyphus-junior"] ?? [] },
      { id: "explore", mode: "subagent", permissions: options.agentPermissions?.explore ?? [] },
      { id: "librarian", mode: "subagent", permissions: options.agentPermissions?.librarian ?? [] },
      { id: "multimodal-looker", mode: "subagent", permissions: [] },
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
  const runtime = await registerV2Delegation(ctx, (options.config ?? {}) as never, runs, { resolveLogicalParent: options.resolveLogicalParent })
  return { ctx, editor, runs, runtime, storage, nativeInputSchema, nativeOutputSchema, toolHooks, permissionHooks, permissionEvents, interrupted, nativeCalls, sessions }
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

  test("shares one capped native admission across direct, task, call_omo_agent, and look_at routes", async () => {
    let directStarted!: () => void
    let releaseDirect!: () => void
    const directEntered = new Promise<void>((resolve) => { directStarted = resolve })
    const directGate = new Promise<void>((resolve) => { releaseDirect = resolve })
    let calls = 0
    const instance = await harness({
      config: { background_task: { defaultConcurrency: 1 } },
      nativeExecute: async (_args, context) => {
        const index = ++calls
        const sessionID = `ses-shared-admission-${index}`
        await context.progress({ sessionID, status: "running" })
        if (index === 1) {
          directStarted()
          await directGate
        }
        return { output: { sessionID, status: "completed", output: `child ${index}` }, content: `child ${index}` }
      },
    })
    const directContext = toolContext("ses-parent", "sisyphus", "msg-direct", "call-direct")
    try {
      const nativeTool = instance.editor.get("subagent")!
      expect(nativeTool.input).toBe(instance.nativeInputSchema)
      expect(nativeTool.output).toBe(instance.nativeOutputSchema)
      expect(nativeTool.options).toEqual({ codemode: false, permission: "subagent" })

      const direct = nativeTool.execute({ agent: "explore", description: "Direct", prompt: "Direct" }, directContext)
      await directEntered

      const task = instance.editor.get("task")!.execute(
        { subagent_type: "explore", prompt: "Task alias" },
        toolContext("ses-parent", "sisyphus", "msg-task", "call-task"),
      )
      const call = instance.editor.get("call_omo_agent")!.execute(
        { subagent_type: "explore", description: "Call alias", prompt: "Call alias", run_in_background: false },
        toolContext("ses-parent", "sisyphus", "msg-call", "call-call"),
      )
      const look = instance.editor.get("look_at")!.execute(
        { image_data: "data:image/png;base64,iVBORw0KGgo=", goal: "Describe the image" },
        toolContext("ses-parent", "sisyphus", "msg-look", "call-look"),
      )

      const leaseValues = () => [...instance.storage.values.entries()]
        .filter(([key]) => key.includes("background-admission:lease:"))
        .map(([, value]) => value as { status?: string })
      await waitFor(() => leaseValues().filter((lease) => lease.status === "queued").length === 3)
      expect(instance.nativeCalls).toHaveLength(1)

      releaseDirect()
      const results = await Promise.all([direct, task, call, look])
      expect(results).toHaveLength(4)
      expect(instance.nativeCalls).toHaveLength(4)
      expect(instance.nativeCalls.every((input: any) => typeof input.model === "string" && input.model === "provider/default-model")).toBe(true)
      expect(leaseValues()).toHaveLength(4)
      expect(leaseValues().every((lease) => lease.status === "terminal")).toBe(true)
      expect((await instance.runs.children("ses-parent")).sort()).toEqual([
        "ses-shared-admission-1",
        "ses-shared-admission-2",
        "ses-shared-admission-3",
        "ses-shared-admission-4",
      ])
    } finally {
      releaseDirect()
      await instance.runtime.cleanup()
    }
  })

  test("stops before the native prompt when persisting the pre-prompt child binding fails", async () => {
    let promptStarted = false
    const instance = await harness({
      nativeExecute: async (_args, context) => {
        await context.progress({ sessionID: "ses-bind-failure", status: "running" })
        promptStarted = true
        return { output: { sessionID: "ses-bind-failure", status: "completed" }, content: "unreachable" }
      },
    })
    const storage = instance.ctx.storage as unknown as {
      set: (key: string, value: unknown) => Promise<void>
    }
    const originalSet = storage.set.bind(storage)
    storage.set = async (key, value) => {
      if (key.includes("background-admission:lease:")) throw new Error("admission bind persistence failed")
      return originalSet(key, value)
    }
    try {
      await expect(instance.editor.get("subagent")!.execute(
        { agent: "explore", description: "Bind failure", prompt: "Must not start" },
        toolContext("ses-parent", "sisyphus", "msg-bind-failure", "call-bind-failure"),
      )).rejects.toThrow("admission bind persistence failed")
      expect(promptStarted).toBe(false)
      expect([...instance.storage.values.keys()].some((key) => key.includes("background-admission:lease:"))).toBe(false)
    } finally {
      await instance.runtime.cleanup()
    }
  })

  test("fails closed when native success omits the awaited pre-prompt progress event", async () => {
    const instance = await harness({
      config: { background_task: { maxLiveDescendantsPerRoot: 1 } },
      nativeExecute: async () => ({ output: { sessionID: "ses-without-progress", status: "running" }, content: "unverified child" }),
    })
    try {
      await expect(instance.editor.get("task")!.execute(
        { subagent_type: "explore", prompt: "No progress" },
        toolContext("ses-parent", "sisyphus", "msg-no-progress", "call-no-progress"),
      )).rejects.toThrow("without the required pre-prompt progress event")
      const leaseValues = [...instance.storage.values.entries()]
        .filter(([key]) => key.includes("background-admission:lease:"))
        .map(([, value]) => value as { status?: string; childSessionID?: string | null })
      expect(leaseValues).toHaveLength(1)
      expect(leaseValues[0]).toMatchObject({ status: "creating", childSessionID: null })

      await expect(instance.editor.get("task")!.execute(
        { subagent_type: "explore", prompt: "Must remain blocked" },
        toolContext("ses-parent", "sisyphus", "msg-no-progress-2", "call-no-progress-2"),
      )).rejects.toThrow("maxLiveDescendantsPerRoot=1")
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
      expect([...denying.storage.values.keys()].some((key) => key.includes("background-admission:lease:"))).toBe(false)
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
      expect([...instance.storage.values.keys()].some((key) => key.includes("background-admission:lease:"))).toBe(false)

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
      nativeExecute: async (_args, context) => {
        await context.progress({ sessionID: "ses-background", status: "running" })
        start()
        await gate
        return { output: { sessionID: "ses-background", status: "running", output: "background accepted" }, content: "background accepted" }
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
        await context.progress({ sessionID: "ses-grandchild", status: "running" })
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

  test("selects the first available allowed category model after filtering disabled providers", async () => {
    const instance = await harness({
      config: {
        disabled_providers: [" BLOCKED "],
        categories: {
          deep: { models: ["blocked/private", "openai/gpt-6-sol"] },
        },
      },
      models: [
        { id: "private", providerID: "blocked", enabled: true },
        { id: "gpt-6-sol", providerID: "openai", enabled: true },
      ],
    })
    try {
      await instance.editor.get("task")!.execute({ category: "deep", prompt: "Inspect" }, toolContext())
      expect(instance.nativeCalls.at(-1)).toMatchObject({ model: "openai/gpt-6-sol" })
    } finally {
      await instance.runtime.cleanup()
    }
  })

  test("uses the rich category choice and persists it before native progress is forwarded", async () => {
    const instance = await harness({
      config: {
        categories: {
          deep: {
            models: [{ model: "openai/selected", reasoning: "high", temperature: 0.71, top_p: 0.88, maxTokens: 2400 }],
          },
        },
      },
      models: [{
        id: "selected", providerID: "openai", enabled: true,
        variants: [{ id: "high", settings: { reasoningEffort: "high", parallelToolCalls: false } }],
      }],
    })
    const context = toolContext()
    context.progress = async () => {
      const stored = [...instance.storage.values.values()].find((value: any) => value?.agentID === "sisyphus-junior" && value?.sessionID === "ses-child-1") as any
      expect(stored?.settings).toMatchObject({
        reasoningEffort: "high", parallelToolCalls: false, temperature: 0.71, topP: 0.88, maxTokens: 2400,
      })
    }
    try {
      await instance.editor.get("task")!.execute({ category: "deep", prompt: "Inspect" }, context)
      expect(instance.nativeCalls.at(-1)).toMatchObject({ agent: "sisyphus-junior", model: "openai/selected#high" })
    } finally {
      await instance.runtime.cleanup()
    }
  })

  test("an explicit category variant overrides a fallback entry variant", async () => {
    const instance = await harness({
      config: {
        categories: {
          deep: {
            variant: "medium",
            models: [{ model: "openai/selected", variant: "high" }],
          },
        },
      },
      models: [{
        id: "selected", providerID: "openai", enabled: true,
        variants: [{ id: "high" }, { id: "medium" }],
      }],
    })
    try {
      await instance.editor.get("task")!.execute({ category: "deep", prompt: "Inspect" }, toolContext())
      expect(instance.nativeCalls.at(-1)).toMatchObject({ model: "openai/selected#medium" })
    } finally {
      await instance.runtime.cleanup()
    }
  })

  test("skips a disabled provider within a multi-provider model requirement", async () => {
    const instance = await harness({
      config: { disabled_providers: [" OPENAI "] },
      models: [
        { id: "gpt-5.6-sol-fast", providerID: "openai", enabled: true },
        { id: "gpt-5.6-sol-fast", providerID: "chatgpt-subscription", enabled: true, variants: [{ id: "medium" }] },
      ],
    })
    try {
      await instance.editor.get("task")!.execute({ category: "deep-low", prompt: "Inspect" }, toolContext())
      expect(instance.nativeCalls.at(-1)).toMatchObject({ model: "chatgpt-subscription/gpt-5.6-sol-fast#medium" })
    } finally {
      await instance.runtime.cleanup()
    }
  })

  test("fails a category whose explicit chain has no allowed model instead of delegating with a host default", async () => {
    const instance = await harness({
      config: {
        disabled_providers: ["blocked"],
        categories: { blocked_only: { models: ["blocked/private"] } },
      },
      models: [{ id: "private", providerID: "blocked", enabled: true }],
    })
    try {
      await expect(instance.editor.get("task")!.execute({ category: "blocked_only", prompt: "Inspect" }, toolContext()))
        .rejects.toThrow("No available model")
      expect(instance.nativeCalls).toHaveLength(0)
    } finally {
      await instance.runtime.cleanup()
    }
  })

  test("does not replace an unavailable explicit category chain with an unrelated registered or default model", async () => {
    const instance = await harness({
      config: { categories: { unavailable: { models: ["missing/not-connected"] } } },
      models: [
        { id: "default-model", providerID: "provider", enabled: true },
        { id: "unrelated", providerID: "openai", enabled: true },
      ],
    })
    try {
      await expect(instance.editor.get("task")!.execute({ category: "unavailable", prompt: "Inspect" }, toolContext()))
        .rejects.toThrow("No available model")
      expect(instance.nativeCalls).toHaveLength(0)
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

  test("uses OpenCode last-match precedence within the root agent rules", async () => {
    const rules = [
      { action: "shell", resource: "*", effect: "deny" as const },
      { action: "shell", resource: SHELL_PERMISSION_RESOURCE, effect: "allow" as const },
    ]
    const root = await harness({ agentPermissions: { sisyphus: rules } })
    try {
      const event = shellPermissionEvent()
      await root.permissionHooks[0]!(event)
      expect(event.effect).toBe("allow")
    } finally {
      await root.runtime.cleanup()
    }
  })

  test("uses OpenCode last-match precedence within inherited agent rules", async () => {
    const inherited = await harness({
      agentPermissions: { sisyphus: [
        { action: "shell", resource: "*", effect: "deny" },
        { action: "shell", resource: SHELL_PERMISSION_RESOURCE, effect: "allow" },
      ] },
      sessions: {
        "ses-child": { id: "ses-child", parentID: "ses-parent", agent: "explore", permissions: [] },
      },
    })
    try {
      const event = shellPermissionEvent("ses-child")
      await inherited.permissionHooks[0]!(event)
      expect(event.effect).toBe("allow")
    } finally {
      await inherited.runtime.cleanup()
    }
  })

  test("keeps a later wildcard deny effective after an earlier exact allow", async () => {
    const instance = await harness({
      agentPermissions: { sisyphus: [
        { action: "shell", resource: SHELL_PERMISSION_RESOURCE, effect: "allow" },
        { action: "shell", resource: "*", effect: "deny" },
      ] },
    })
    try {
      const event = shellPermissionEvent()
      await instance.permissionHooks[0]!(event)
      expect(event.effect).toBe("deny")
    } finally {
      await instance.runtime.cleanup()
    }
  })

  test("logical Team members and native descendants inherit the lead permission", async () => {
    const instance = await harness({
      agentPermissions: { sisyphus: [{ action: "shell", resource: "*", effect: "deny" }] },
      sessions: {
        "ses-member": { id: "ses-member", agent: "atlas", permissions: [{ action: "shell", resource: "*", effect: "allow" }] },
        "ses-descendant": { id: "ses-descendant", parentID: "ses-member", agent: "explore" },
      },
      resolveLogicalParent: async (id) => id === "ses-member" ? "ses-parent" : undefined,
    })
    try {
      for (const sessionID of ["ses-member", "ses-descendant"]) {
        const event = shellPermissionEvent(sessionID)
        await instance.permissionHooks[0]!(event)
        expect(event.effect).toBe("deny")
      }
    } finally {
      await instance.runtime.cleanup()
    }
  })

  test("does not let child allows relax an ancestor's effective deny or ask", async () => {
    const denied = await harness({
      agentPermissions: {
        sisyphus: [{ action: "shell", resource: "*", effect: "deny" }],
        explore: [{ action: "shell", resource: "*", effect: "allow" }],
      },
      sessions: {
        "ses-child": {
          id: "ses-child", parentID: "ses-parent", agent: "explore",
          permissions: [{ action: "shell", resource: SHELL_PERMISSION_RESOURCE, effect: "allow" }],
        },
      },
    })
    try {
      const event = shellPermissionEvent("ses-child")
      await denied.permissionHooks[0]!(event)
      expect(event.effect).toBe("deny")
    } finally {
      await denied.runtime.cleanup()
    }

    const asking = await harness({
      agentPermissions: {
        sisyphus: [{ action: "shell", resource: "*", effect: "ask" }],
        explore: [{ action: "shell", resource: SHELL_PERMISSION_RESOURCE, effect: "allow" }],
      },
      sessions: {
        "ses-child": { id: "ses-child", parentID: "ses-parent", agent: "explore", permissions: [] },
      },
    })
    try {
      const event = shellPermissionEvent("ses-child")
      await asking.permissionHooks[0]!(event)
      expect(event.effect).toBe("ask")
    } finally {
      await asking.runtime.cleanup()
    }
  })

  test("uses later session rules to override rules in the same agent policy", async () => {
    const instance = await harness({
      agentPermissions: { sisyphus: [{ action: "shell", resource: "*", effect: "deny" }] },
      sessions: {
        "ses-parent": {
          id: "ses-parent", agent: "sisyphus",
          permissions: [{ action: "shell", resource: SHELL_PERMISSION_RESOURCE, effect: "allow" }],
        },
      },
    })
    try {
      const event = shellPermissionEvent()
      await instance.permissionHooks[0]!(event)
      expect(event.effect).toBe("allow")
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
      parentModel: { providerID: "qa", id: "stored-model" },
      models: [{ id: "stored-model", providerID: "qa", enabled: true }],
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
      expect(instance.nativeCalls.at(-1)).toHaveProperty("model", "qa/stored-model")
      await expectTodoDenied()

      await task.execute({ task_id: "ses-child", subagent_type: "sisyphus-junior", prompt: "Continue by agent" }, context)
      expect(instance.nativeCalls.at(-1)).toMatchObject({ agent: "sisyphus-junior", sessionID: "ses-child" })
      expect(instance.nativeCalls.at(-1)).toHaveProperty("model", "qa/stored-model")
      await expectTodoDenied()

      await task.execute({ task_id: "ses-child", category: "broad", prompt: "Continue by broader category" }, context)
      expect(instance.nativeCalls.at(-1)).toMatchObject({ agent: "sisyphus-junior", sessionID: "ses-child" })
      expect(instance.nativeCalls.at(-1)).toHaveProperty("model", "qa/stored-model")
      await expectTodoDenied()
      expect(new Set((await instance.runs.get("ses-child"))?.blockedActions)).toEqual(new Set(["todowrite"]))
    } finally {
      await instance.runtime.cleanup()
    }
  })

  test("rejects resuming an owned child whose stored model provider is now disabled", async () => {
    const instance = await harness({
      config: { disabled_providers: [" BLOCKED "] },
      sessions: { "ses-child": {
        id: "ses-child",
        parentID: "ses-parent",
        agent: "sisyphus-junior",
        model: { providerID: "blocked", id: "persisted-model" },
        time: { created: 100, updated: 100 },
      } },
    })
    try {
      await expect(instance.editor.get("task")!.execute({ task_id: "ses-child", prompt: "Continue" }, toolContext()))
        .rejects.toThrow("uses a provider listed in disabled_providers")
      expect(instance.nativeCalls).toHaveLength(0)
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

  test("background cancellation handles mixed native and verified Team children without allowing task resume to bypass the native parent contract", async () => {
    const runs = createV2SubagentRunState(memoryStorage())
    for (const id of ["ses-native", "ses-member"]) {
      await runs.recordLaunch(id, { parentSessionID: "ses-parent", startedAt: 100, status: "running", blockedActions: [] })
    }
    const instance = await harness({ runState: runs, resolveLogicalParent: async (id) => id === "ses-member" ? "ses-parent" : undefined, sessions: {
      "ses-native": { id: "ses-native", parentID: "ses-parent", agent: "explore", time: { idle: 100 } },
      "ses-member": { id: "ses-member", agent: "atlas", time: { idle: 100 } },
    } })
    try {
      await instance.editor.get("background_cancel")!.execute({ all: true }, toolContext())
      expect(instance.interrupted.sort()).toEqual(["ses-member", "ses-native"])
      expect(await runs.get("ses-member")).toMatchObject({ status: "interrupted" })
      const result = await instance.editor.get("background_output")!.execute({ task_id: "ses-member" }, toolContext())
      expect(result.metadata).toMatchObject({ sessionID: "ses-member", parentSessionID: "ses-parent" })
      await expect(instance.editor.get("task")!.execute({ task_id: "ses-member", prompt: "Continue" }, toolContext())).rejects.toThrow("not a child")
      expect(instance.nativeCalls).toHaveLength(0)
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

  test("background launches return a legacy bg_ ID that background_output and background_cancel accept", async () => {
    const instance = await harness({
      nativeExecute: async (_args, context) => {
        await context.progress({ sessionID: "ses-bg-child", status: "running" })
        return { output: { sessionID: "ses-bg-child", status: "running", output: "working" }, content: "working", metadata: { sessionID: "ses-bg-child", status: "running" } }
      },
    })
    try {
      const launched = await instance.editor.get("task")!.execute({
        subagent_type: "explore", prompt: "Research", description: "Research", run_in_background: true,
      }, toolContext())
      const bgID = v2BackgroundTaskID("ses-bg-child")
      expect(bgID).toMatch(/^bg_[0-9a-f]{8}$/)
      expect(launched.content).toContain(`Background Task ID: ${bgID}`)
      expect(launched.content).toContain("session_id: ses-bg-child")
      expect(launched.content).toContain(`background_task_id: ${bgID}`)
      expect(launched.metadata).toMatchObject({ sessionID: "ses-bg-child", backgroundTaskId: bgID })

      const output = await instance.editor.get("background_output")!.execute({ task_id: bgID }, toolContext())
      expect(output.content).toContain(`Background Task ID: ${bgID}`)
      expect(output.content).toContain("Session: ses-bg-child")
      await expect(instance.editor.get("background_output")!.execute({ task_id: "bg_00000000" }, toolContext()))
        .rejects.toThrow("Unknown background task ID")
      await expect(instance.editor.get("background_output")!.execute({ task_id: bgID }, toolContext("ses-other")))
        .rejects.toThrow("Unknown background task ID")

      const cancelled = await instance.editor.get("background_cancel")!.execute({ taskId: bgID }, toolContext())
      expect(instance.interrupted).toEqual(["ses-bg-child"])
      expect(cancelled.content).toContain(`${bgID} (ses-bg-child)`)
    } finally {
      await instance.runtime.cleanup()
    }
  })

  test("an explicit foreground task on an unstable category model runs as a supervised task", async () => {
    const instance = await harness({
      models: [{ id: "gemini-3-pro", providerID: "google", enabled: true }],
      config: { categories: { visual: { model: "google/gemini-3-pro" } } },
    })
    try {
      const result = await instance.editor.get("task")!.execute({
        category: "visual", prompt: "Build the page", description: "Build page", run_in_background: false,
      }, toolContext())
      const bgID = v2BackgroundTaskID("ses-child-1")
      expect(result.content).toStartWith("SUPERVISED TASK COMPLETED SUCCESSFULLY")
      expect(result.content).toContain("This model (google/gemini-3-pro) is marked as unstable/experimental.")
      expect(result.content).toContain(`background_cancel(taskId="${bgID}")`)
      expect(result.content).toContain("RESULT:\n\ndone")
      expect(result.content).toContain(`background_task_id: ${bgID}`)
      expect(result.metadata).toMatchObject({ supervised: true, backgroundTaskId: bgID })

      // Omitted run_in_background, stable models and explicit background runs keep the ordinary paths.
      const omitted = await instance.editor.get("task")!.execute({ category: "visual", prompt: "Again", description: "Again" }, toolContext())
      expect(omitted.content).toBe("done")
    } finally {
      await instance.runtime.cleanup()
    }
  })

  test("a failed or timed-out supervised task keeps a typed failure with the legacy framing", async () => {
    const failing = await harness({
      models: [{ id: "minimax-m3", providerID: "minimax", enabled: true }],
      config: { categories: { visual: { model: "minimax/minimax-m3" } } },
      nativeExecute: async (_args, context) => {
        await context.progress({ sessionID: "ses-unstable", status: "running" })
        throw new ToolError({ message: "Subagent failed (sessionID: ses-unstable): provider exploded" })
      },
    })
    try {
      await expect(failing.editor.get("task")!.execute({
        category: "visual", prompt: "Fix", description: "Fix", run_in_background: false,
      }, toolContext())).rejects.toThrow(/^SUPERVISED TASK FAILED[\s\S]*provider exploded[\s\S]*background_task_id: bg_/)
    } finally {
      await failing.runtime.cleanup()
    }

    let interruptChild!: () => void
    const timed = await harness({
      models: [{ id: "gemini-3-pro", providerID: "google", enabled: true }],
      config: { categories: { visual: { model: "google/gemini-3-pro" } }, background_task: { syncPollTimeoutMs: 60_000 } },
      nativeExecute: async (_args, context) => {
        await context.progress({ sessionID: "ses-slow", status: "running" })
        await new Promise<void>((resolve) => { interruptChild = resolve })
        throw new ToolError({ message: "Subagent cancelled (sessionID: ses-slow)" })
      },
    })
    const realSetTimeout = globalThis.setTimeout
    try {
      // Fire the 60s supervision budget immediately.
      globalThis.setTimeout = ((callback: () => void, ms?: number) => realSetTimeout(callback, ms === 60_000 ? 0 : ms)) as typeof setTimeout
      const running = timed.editor.get("task")!.execute({
        category: "visual", prompt: "Slow", description: "Slow", run_in_background: false,
      }, toolContext())
      await waitFor(() => timed.interrupted.includes("ses-slow"))
      globalThis.setTimeout = realSetTimeout
      interruptChild()
      await expect(running).rejects.toThrow(/^SUPERVISED TASK TIMED OUT[\s\S]*60000ms/)
    } finally {
      globalThis.setTimeout = realSetTimeout
      interruptChild?.()
      await timed.runtime.cleanup()
    }
  })
})
