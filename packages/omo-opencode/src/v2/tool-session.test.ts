import { describe, expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin"
import type { ToolContext, ToolEditor } from "@opencode/plugin/promise/tool"
import { createV2SubagentRunState, createV2TodoState } from "./task-state"
import { addV2SessionTools } from "./tool-session"

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

function storage() {
  const values = new Map<string, unknown>()
  return {
    get: async (key: string) => values.get(key),
    set: async (key: string, value: unknown) => { values.set(key, value) },
    remove: async (key: string) => { values.delete(key) },
    scan: async ({ prefix }: { prefix: string }) => ({
      entries: [...values.entries()].filter(([key]) => key.startsWith(prefix)).sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) => ({ key, value })),
    }),
  }
}

function toolContext(sessionID = "ses-current"): ToolContext {
  return {
    sessionID,
    agent: "sisyphus",
    messageID: "msg-1",
    id: "call-1" as ToolContext["id"],
    signal: new AbortController().signal,
    progress: async () => undefined,
  }
}

describe("native V2 session inspection tools", () => {
  test("supports explicit historical reads and indexes observed session IDs for later listing", async () => {
    const calls: string[] = []
    const sessionInfo = (sessionID: string) => ({
      id: sessionID,
      parentID: sessionID === "ses-current" ? undefined : "older-parent",
      title: `Session ${sessionID}`,
      agent: "sisyphus",
      model: { providerID: "openai", id: "gpt-6-sol" },
      location: { directory: "/repo" },
      projectID: "proj",
      time: { created: 100, updated: 200, idle: 190 },
      outcome: "succeeded",
    })
    const ctx = {
      location: { directory: "/repo", project: { id: "proj" } },
      session: {
        get: async ({ sessionID }: { sessionID: string }) => { calls.push(`get:${sessionID}`); return sessionInfo(sessionID) },
        context: async ({ sessionID }: { sessionID: string }) => [
          { id: `user-${sessionID}`, type: "user", text: "inspect this session" },
          { id: `assistant-${sessionID}`, type: "assistant", content: [{ type: "text", text: `answer for ${sessionID}` }] },
        ],
      },
      storage: storage(),
    } as unknown as Plugin.Context
    const runs = createV2SubagentRunState(ctx.storage)
    const todos = createV2TodoState(ctx.storage)
    const editor = new TestEditor()
    addV2SessionTools(editor as unknown as ToolEditor, ctx, {} as never, runs, todos)

    const info = await editor.get("session_info")!.execute({ session_id: "ses-history" }, toolContext())
    expect(JSON.parse(info.content).id).toBe("ses-history")
    expect(await runs.observed("ses-current")).toEqual(["ses-history"])

    const history = await editor.get("session_read")!.execute({ session_id: "ses-history", limit: 20 }, toolContext())
    expect(history.content).toContain("answer for ses-history")

    const listed = await editor.get("session_list")!.execute({}, toolContext())
    expect(JSON.parse(listed.content).map((entry: { id: string }) => entry.id)).toEqual(["ses-current", "ses-history"])

    const searched = await editor.get("session_search")!.execute({ session_id: "ses-history", query: "answer" }, toolContext())
    expect(searched.content).toContain("[ses-history] assistant: answer for ses-history")
    expect(calls).toContain("get:ses-history")
  })

  test("honors disabled session inspection tools", () => {
    const ctx = { storage: storage() } as unknown as Plugin.Context
    const editor = new TestEditor()
    addV2SessionTools(editor as unknown as ToolEditor, ctx, { disabled_tools: ["session_read", "session_search"] } as never,
      createV2SubagentRunState(ctx.storage), createV2TodoState(ctx.storage))
    expect(editor.list().map((tool) => tool.name)).toEqual(["session_info", "session_list"])
  })

  test("lists and searches this project's indexed sessions without prior observation and excludes other projects", async () => {
    const sessions: Record<string, Record<string, unknown>> = {
      "ses-current": { id: "ses-current", projectID: "proj", location: { directory: "/repo" }, time: { created: 300, updated: 300 }, agent: "sisyphus" },
      "ses-older": { id: "ses-older", projectID: "proj", title: "Earlier design discussion", location: { directory: "/repo" }, time: { created: 100, updated: 150 }, agent: "prometheus" },
      "ses-foreign": { id: "ses-foreign", projectID: "other", location: { directory: "/elsewhere" }, time: { created: 200, updated: 200 }, agent: "sisyphus" },
    }
    const ctx = {
      location: { directory: "/repo", project: { id: "proj" } },
      session: {
        get: async ({ sessionID }: { sessionID: string }) => {
          const session = sessions[sessionID]
          if (!session) throw new Error("missing")
          return session
        },
        context: async ({ sessionID }: { sessionID: string }) => [
          { id: `u-${sessionID}`, type: "user", text: sessionID === "ses-older" ? "Decide the CACHE_STRATEGY for the importer" : "hello" },
        ],
      },
      storage: storage(),
    } as unknown as Plugin.Context
    const { getV2SessionIndex } = await import("./session-index")
    const index = getV2SessionIndex(ctx)
    await index.upsert(sessions["ses-older"] as never)
    expect(await index.upsert(sessions["ses-foreign"] as never)).toBeUndefined()
    const runs = createV2SubagentRunState(ctx.storage)
    const editor = new TestEditor()
    addV2SessionTools(editor as unknown as ToolEditor, ctx, {} as never, runs, createV2TodoState(ctx.storage))
    const listed = JSON.parse((await editor.get("session_list")!.execute({}, toolContext())).content) as Array<{ id: string; title?: string }>
    expect(listed.map((row) => row.id)).toEqual(["ses-current", "ses-older"])
    expect(listed[1]!.title).toBe("Earlier design discussion")
    const searched = await editor.get("session_search")!.execute({ query: "cache_strategy" }, toolContext())
    expect(searched.content).toContain("[ses-older] user: Decide the CACHE_STRATEGY for the importer")
    // A deleted native session drops out of the index and can no longer be read.
    delete sessions["ses-older"]
    await index.remove("ses-older")
    const after = JSON.parse((await editor.get("session_list")!.execute({}, toolContext())).content) as Array<{ id: string }>
    expect(after.map((row) => row.id)).toEqual(["ses-current"])
  })
})

