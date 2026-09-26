import { describe, expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin"
import { createV2SubagentRunState, createV2TodoState } from "./task-state"

function storage(): Plugin.Context["storage"] {
  const values = new Map<string, unknown>()
  return {
    get: async (key) => values.get(key),
    set: async (key, value) => { values.set(key, value) },
    remove: async (key) => { values.delete(key) },
  } as Plugin.Context["storage"]
}

describe("native V2 task state", () => {
  test("serializes concurrent todo writes and updates per session", async () => {
    const backing = storage()
    const todos = createV2TodoState(backing)
    await Promise.all([
      todos.write("ses-a", [{ id: "one", content: "one", status: "pending" }]),
      todos.update("ses-a", (current) => [...current, { id: "two", content: "two", status: "in_progress" }]),
    ])

    expect(await todos.read("ses-a")).toEqual([
      { id: "one", content: "one", status: "pending" },
      { id: "two", content: "two", status: "in_progress" },
    ])
    expect(await createV2TodoState(backing).read("ses-a")).toHaveLength(2)
  })

  test("persists blocked actions and prunes deleted children and their parent index", async () => {
    const runs = createV2SubagentRunState(storage())
    await runs.recordLaunch("ses-child", {
      parentSessionID: "ses-parent",
      startedAt: 100,
      status: "running",
      blockedActions: ["todowrite", "edit"],
    })
    await runs.recordLaunch("ses-grandchild", {
      parentSessionID: "ses-child",
      startedAt: 110,
      status: "running",
      blockedActions: [],
    })

    expect(await runs.children("ses-parent")).toEqual(["ses-child"])
    expect(await runs.get("ses-child")).toMatchObject({ blockedActions: ["todowrite", "edit"] })

    await runs.remove("ses-child")
    expect(await runs.children("ses-parent")).toEqual([])
    expect(await runs.children("ses-child")).toEqual([])
    expect(await runs.get("ses-child")).toBeUndefined()
    expect(await runs.get("ses-grandchild")).toBeUndefined()
  })

  test("merges concurrent resumed restrictions and keeps the original parent owner", async () => {
    const runs = createV2SubagentRunState(storage())
    await runs.recordLaunch("ses-child", {
      parentSessionID: "ses-parent",
      startedAt: 100,
      status: "running",
      blockedActions: ["todowrite"],
    })

    await Promise.all([
      runs.recordLaunch("ses-child", {
        parentSessionID: "ses-parent",
        startedAt: 120,
        status: "running",
        blockedActions: [],
      }),
      runs.recordLaunch("ses-child", {
        parentSessionID: "ses-parent",
        startedAt: 110,
        status: "running",
        blockedActions: ["edit"],
      }),
    ])

    const merged = await runs.get("ses-child")
    expect(merged?.startedAt).toBe(120)
    expect(new Set(merged?.blockedActions)).toEqual(new Set(["todowrite", "edit"]))
    await expect(runs.recordLaunch("ses-child", {
      parentSessionID: "ses-other-parent",
      startedAt: 130,
      status: "running",
      blockedActions: [],
    })).rejects.toThrow("Cannot change parent ownership")
    expect(await runs.get("ses-child")).toMatchObject({
      parentSessionID: "ses-parent",
      startedAt: 120,
      blockedActions: expect.arrayContaining(["todowrite", "edit"]),
    })
    expect(await runs.children("ses-parent")).toEqual(["ses-child"])
    expect(await runs.children("ses-other-parent")).toEqual([])
  })

  test("keeps a bounded observed-session index for read-only session inspection", async () => {
    const runs = createV2SubagentRunState(storage())
    await Promise.all(Array.from({ length: 20 }, (_, index) => runs.observe("ses-parent", `ses-history-${index}`)))
    await runs.observe("ses-parent", "ses-history-0")
    await runs.observe("ses-parent", "ses-parent")

    expect(await runs.observed("ses-parent")).toEqual(Array.from({ length: 20 }, (_, index) => `ses-history-${index}`))
  })
})
