import { describe, expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin"
import { Error as ToolError, type ToolContext, type ToolEditor } from "@opencode/plugin/promise/tool"
import { computeLineHash } from "../tools/hashline-edit/hash-computation"
import { addV2FilesystemTools, executeHashlineEdit } from "./tool-filesystem"

type TestTool = {
  id: string
  name: string
  description: string
  input: unknown
  output?: unknown
  options?: { codemode?: boolean; permission?: string }
  execute: (input: any, context: ToolContext) => Promise<any>
}

class TestEditor {
  readonly tools = new Map<string, TestTool>()

  constructor(tools: TestTool[] = []) {
    for (const tool of tools) this.tools.set(tool.name, tool)
  }

  list() { return [...this.tools.values()] }
  get(name: string) { return this.tools.get(name) }
  add(tool: TestTool) { this.tools.set(tool.name, { ...tool, id: tool.name }) }
  remove(name: string) { this.tools.delete(name) }
  update(name: string, update: (tool: TestTool) => void) {
    const tool = this.tools.get(name)
    if (tool) update(tool)
  }
  namespace() {}
}

function context(): ToolContext {
  return {
    sessionID: "ses-parent",
    agent: "sisyphus",
    messageID: "msg-1",
    id: "call-1" as ToolContext["id"],
    signal: new AbortController().signal,
    progress: async () => undefined,
  }
}

function nativeTool(name: string, execute: TestTool["execute"], input: unknown = { fields: {} }): TestTool {
  return { id: name, name, description: `native ${name}`, input, options: { codemode: false }, execute }
}

const config = { hashline_edit: true } as never

describe("native V2 filesystem adapters", () => {
  test("normalizes path/filePath and patch/patchText aliases through captured host executors", async () => {
    const seen: Array<{ name: string; input: unknown }> = []
    const editor = new TestEditor([
      nativeTool("read", async (input) => { seen.push({ name: "read", input }); return { content: "read", output: {} } }),
      nativeTool("edit", async (input) => { seen.push({ name: "edit", input }); return { content: "edit" } }),
      nativeTool("write", async (input) => { seen.push({ name: "write", input }); return { content: "write" } }),
      nativeTool("patch", async (input) => { seen.push({ name: "patch", input }); return { content: "patch" } }, { fields: { patchText: {} } }),
    ])

    addV2FilesystemTools(editor as unknown as ToolEditor, {} as Plugin.Context, config)
    await editor.get("read")!.execute({ filePath: "/tmp/a.ts", offset: 0, limit: 0 }, context())
    await editor.get("read")!.execute({ path: "/tmp/b.ts", offset: 2 }, context())
    await editor.get("edit")!.execute({ filePath: "/tmp/a.ts", oldString: "a", newString: "b", replaceAll: true }, context())
    await editor.get("write")!.execute({ filePath: "/tmp/a.ts", content: "c" }, context())
    await editor.get("apply_patch")!.execute({ patch: "*** Begin Patch\n*** End Patch" }, context())

    expect(seen).toEqual([
      { name: "read", input: { path: "/tmp/a.ts", offset: 0, limit: 0 } },
      { name: "read", input: { path: "/tmp/b.ts", offset: 2 } },
      { name: "edit", input: { path: "/tmp/a.ts", oldString: "a", newString: "b", replaceAll: true } },
      { name: "write", input: { path: "/tmp/a.ts", content: "c" } },
      { name: "patch", input: { patchText: "*** Begin Patch\n*** End Patch" } },
    ])
  })

  test("uses the native write permission path to edit an empty file", async () => {
    let written: unknown
    const result = await executeHashlineEdit({
      filePath: "/tmp/empty.txt",
      edits: [{ op: "append", lines: ["created"] }],
    }, context(), nativeTool("read", async () => ({ output: { type: "file", encoding: "utf8", content: "" } })) as never,
    nativeTool("edit", async () => { throw new Error("native edit must not run for an empty oldString") }) as never,
    nativeTool("write", async (input) => { written = input; return { content: "created" } }) as never,
    undefined)

    expect(written).toEqual({ path: "/tmp/empty.txt", content: "created" })
    expect(result.content).toBe("created")
  })

  test("deletes through native patch and permission checks", async () => {
    let patch: unknown
    await executeHashlineEdit({ filePath: "/tmp/delete.txt", edits: [], delete: true }, context(),
      nativeTool("read", async () => { throw new Error("read must not run") }) as never,
      nativeTool("edit", async () => { throw new Error("edit must not run") }) as never,
      undefined,
      nativeTool("patch", async (input) => { patch = input; return { content: "deleted" } }) as never)

    expect(patch).toEqual({ patchText: "*** Begin Patch\n*** Delete File: /tmp/delete.txt\n*** End Patch" })
  })

  test("renames a file without a final newline while preserving bytes through native write plus patch delete", async () => {
    const calls: unknown[] = []
    const old = "before"
    const pos = `1#${computeLineHash(1, old)}`
    await executeHashlineEdit({
      filePath: "/tmp/source.txt",
      rename: "/tmp/destination.txt",
      edits: [{ op: "replace", pos, lines: "after" }],
    }, context(),
    nativeTool("read", async () => ({ output: { type: "file", encoding: "utf8", content: old } })) as never,
    nativeTool("edit", async () => { throw new Error("edit must not run for a rename") }) as never,
    nativeTool("write", async (input) => { calls.push(input); return {} }) as never,
    nativeTool("patch", async (input) => { calls.push(input); return { content: "moved" } }) as never)

    expect(calls).toEqual([
      { path: "/tmp/destination.txt", content: "after" },
      { patchText: "*** Begin Patch\n*** Delete File: /tmp/source.txt\n*** End Patch" },
    ])
  })

  test("refuses a CRLF/BOM rename before invoking mutating native tools", async () => {
    const calls: unknown[] = []
    const old = "\uFEFFbefore\r\n"
    const pos = `1#${computeLineHash(1, "before")}`
    await expect(executeHashlineEdit({
      filePath: "/tmp/source.txt",
      rename: "/tmp/destination.txt",
      edits: [{ op: "replace", pos, lines: "after" }],
    }, context(),
    nativeTool("read", async () => ({ output: { type: "file", encoding: "utf8", content: old } })) as never,
    nativeTool("edit", async (input) => { calls.push(input); return {} }) as never,
    nativeTool("write", async (input) => { calls.push(input); return {} }) as never,
    nativeTool("patch", async (input) => { calls.push(input); return {} }) as never))
      .rejects.toThrow("may normalize its BOM or line endings")
    expect(calls).toEqual([])
  })

  test("reports a partial no-final-newline rename when source deletion is denied", async () => {
    const calls: unknown[] = []
    const old = "before"
    const pos = `1#${computeLineHash(1, old)}`
    await expect(executeHashlineEdit({
      filePath: "/tmp/source.txt",
      rename: "/tmp/destination.txt",
      edits: [{ op: "replace", pos, lines: "after" }],
    }, context(),
    nativeTool("read", async () => ({ output: { type: "file", encoding: "utf8", content: old } })) as never,
    nativeTool("edit", async () => { throw new Error("edit must not run for a rename") }) as never,
    nativeTool("write", async (input) => { calls.push(input); return {} }) as never,
    nativeTool("patch", async (input) => {
      calls.push(input)
      throw new Error("permission denied")
    }) as never)).rejects.toThrow("rename is incomplete: permission denied")
    expect(calls).toEqual([
      { path: "/tmp/destination.txt", content: "after" },
      { patchText: "*** Begin Patch\n*** Delete File: /tmp/source.txt\n*** End Patch" },
    ])
  })

  test("preflights patch before writing a renamed empty file", async () => {
    let wrote = false
    await expect(executeHashlineEdit({
      filePath: "/tmp/empty.txt",
      rename: "/tmp/destination.txt",
      edits: [{ op: "append", lines: ["created"] }],
    }, context(),
    nativeTool("read", async () => ({ output: { type: "file", encoding: "utf8", content: "" } })) as never,
    nativeTool("edit", async () => { throw new Error("native edit must not run for an empty file") }) as never,
    nativeTool("write", async () => { wrote = true; return {} }) as never,
    undefined)).rejects.toThrow("native V2 patch tool is unavailable")
    expect(wrote).toBe(false)
  })

  test("refuses paged and long-line reads instead of editing partial content", async () => {
    const edit = nativeTool("edit", async () => ({ content: "" }))
    const readPaged = nativeTool("read", async () => ({ output: { type: "text-page", text: "1: partial" } }))
    await expect(executeHashlineEdit({ filePath: "/tmp/large.txt", edits: [{ op: "append", lines: "x" }] }, context(), readPaged as never, edit as never, undefined, undefined))
      .rejects.toThrow("paginated text")

    const readLong = nativeTool("read", async () => ({ output: { type: "file", encoding: "utf8", content: `long... (line truncated to 2000 chars)` } }))
    await expect(executeHashlineEdit({ filePath: "/tmp/long.txt", edits: [{ op: "append", lines: "x" }] }, context(), readLong as never, edit as never, undefined, undefined))
      .rejects.toThrow("truncated a long line")
  })

  test("returns an actionable error when safe delete/rename host tools are missing", async () => {
    await expect(executeHashlineEdit({ filePath: "/tmp/delete.txt", edits: [], delete: true }, context(),
      nativeTool("read", async () => ({ output: {} })) as never,
      nativeTool("edit", async () => ({})) as never,
      undefined,
      undefined)).rejects.toBeInstanceOf(ToolError)
  })
})
