import { mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import type { ToolContext, ToolEditor } from "@opencode/plugin/promise/tool"
import { createV2TodoState } from "./task-state"
import { addV2TaskSystemTools } from "./tool-task"

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

function context(sessionID = "ses-tasks"): ToolContext {
  return {
    sessionID,
    agent: "sisyphus",
    messageID: "msg-1",
    id: "call-1" as ToolContext["id"],
    signal: new AbortController().signal,
    progress: async () => undefined,
  }
}

describe("native V2 task-system adapters", () => {
  test("reuses task factories, persists task state, and syncs todo continuation state", async () => {
    const directory = mkdtempSync(join(tmpdir(), "omo-v2-task-test-"))
    try {
      const config = { experimental: { task_system: true }, sisyphus: { tasks: { storage_path: directory } } } as never
      const todos = createV2TodoState(storage() as never)
      const editor = new TestEditor()
      addV2TaskSystemTools(editor as unknown as ToolEditor, config, todos, process.cwd())

      const created = await editor.get("task_create")!.execute({ subject: "Native V2 task" }, context())
      const taskID = JSON.parse(created.content).task.id as string
      expect(taskID).toMatch(/^T-/)
      expect(await todos.read("ses-tasks")).toMatchObject([{ id: taskID, content: "Native V2 task", status: "pending" }])

      const updated = await editor.get("task_update")!.execute({ id: taskID, status: "completed" }, context())
      expect(JSON.parse(updated.content).task.status).toBe("completed")
      expect(await todos.read("ses-tasks")).toMatchObject([{ id: taskID, status: "completed" }])

      const list = await editor.get("task_list")!.execute({}, context())
      expect(JSON.parse(list.content).tasks).toEqual([])
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test("honors the global feature gate and per-tool disabled list", () => {
    const editorOff = new TestEditor()
    addV2TaskSystemTools(editorOff as unknown as ToolEditor, {} as never, createV2TodoState(storage() as never), process.cwd())
    expect(editorOff.list()).toHaveLength(0)

    const editorPartial = new TestEditor()
    addV2TaskSystemTools(editorPartial as unknown as ToolEditor, {
      experimental: { task_system: true },
      disabled_tools: ["task_get", "task_update"],
    } as never, createV2TodoState(storage() as never), process.cwd())
    expect(editorPartial.list().map((tool) => tool.name)).toEqual(["task_create", "task_list"])
  })

  test("resolves relative storage paths against each native location rather than process cwd", async () => {
    const root = mkdtempSync(join(tmpdir(), "omo-v2-task-locations-"))
    const firstDirectory = join(root, "project-one")
    const secondDirectory = join(root, "project-two")
    try {
      const config = {
        experimental: { task_system: true },
        sisyphus: { tasks: { storage_path: ".omo/tasks" } },
      } as never
      const firstTodos = createV2TodoState(storage() as never)
      const secondTodos = createV2TodoState(storage() as never)
      const first = new TestEditor()
      const second = new TestEditor()
      addV2TaskSystemTools(first as unknown as ToolEditor, config, firstTodos, firstDirectory)
      addV2TaskSystemTools(second as unknown as ToolEditor, config, secondTodos, secondDirectory)

      const firstCreated = await first.get("task_create")!.execute({ subject: "First location" }, context("ses-first"))
      const secondCreated = await second.get("task_create")!.execute({ subject: "Second location" }, context("ses-second"))
      expect(JSON.parse(firstCreated.content).task.subject).toBe("First location")
      expect(JSON.parse(secondCreated.content).task.subject).toBe("Second location")
      expect(readdirSync(join(firstDirectory, ".omo/tasks"))).toHaveLength(1)
      expect(readdirSync(join(secondDirectory, ".omo/tasks"))).toHaveLength(1)

      const firstList = await first.get("task_list")!.execute({}, context("ses-first"))
      const secondList = await second.get("task_list")!.execute({}, context("ses-second"))
      expect(JSON.parse(firstList.content).tasks.map((task: { subject: string }) => task.subject)).toEqual(["First location"])
      expect(JSON.parse(secondList.content).tasks.map((task: { subject: string }) => task.subject)).toEqual(["Second location"])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
