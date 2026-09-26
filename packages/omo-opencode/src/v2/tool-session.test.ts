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
      time: { created: 100, updated: 200, idle: 190 },
      outcome: "succeeded",
    })
    const ctx = {
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
})
