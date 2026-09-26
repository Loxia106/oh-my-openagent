import { existsSync, readFileSync } from "node:fs"
import { describe, expect, test } from "bun:test"
import type { ToolContext, ToolEditor } from "@opencode/plugin/promise/tool"
import { addV2LookAtTool } from "./tool-look-at"

type RegisteredTool = { name: string; input: unknown; options?: unknown; execute: (args: any, context: ToolContext) => Promise<any> }

class TestEditor {
	readonly tools = new Map<string, RegisteredTool>()
	list() { return [...this.tools.values()] }
	get(name: string) { return this.tools.get(name) }
	add(tool: RegisteredTool) { this.tools.set(tool.name, tool) }
	remove(name: string) { this.tools.delete(name) }
	update() {}
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

function nativeRead(output: unknown, execute?: (input: unknown, context: ToolContext) => Promise<unknown>) {
	return {
		id: "read",
		name: "read",
		description: "Native read",
		input: {},
		execute: execute ?? (async () => ({ output })),
	} as never
}

describe("native V2 look_at adapter", () => {
	test("validates media through native read then launches an owned multimodal child", async () => {
		const editor = new TestEditor()
		const reads: unknown[] = []
		let launchRequest: unknown
		let launchContext: ToolContext | undefined
		addV2LookAtTool(
			editor as unknown as ToolEditor,
			{} as never,
			nativeRead(undefined, async (input, ctx) => {
				reads.push({ input, sessionID: ctx.sessionID })
				return { output: { type: "file", encoding: "base64", mime: "image/png", content: "cG5n" } }
			}),
			async (request, ctx) => {
				launchRequest = request
				launchContext = ctx
				return { output: { sessionID: "ses-child", output: "A red warning banner is visible." }, content: "A red warning banner is visible." }
			},
		)
		expect(editor.get("look_at")?.options).toMatchObject({ permission: "task" })

		const result = await editor.get("look_at")!.execute({ file_path: "/workspace/screen.png", goal: "Describe the warning banner" }, context())
		expect(reads).toEqual([{ input: { path: "/workspace/screen.png" }, sessionID: "ses-parent" }])
		expect(launchRequest).toMatchObject({ agent: "multimodal-looker", background: false })
		expect(launchRequest).not.toHaveProperty("model")
		expect((launchRequest as { prompt: string }).prompt).toContain("Use the native read tool")
		expect(launchContext?.sessionID).toBe("ses-parent")
		expect(result).toEqual({ content: "A red warning banner is visible.", metadata: { sessionID: "ses-child" } })
	})

	test("stages inline images for native permissioned reads and removes temp files after the child finishes", async () => {
		const editor = new TestEditor()
		const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("test")])
		const data = `data:image/png;base64,${png.toString("base64")}`
		let stagedPath: string | undefined
		let stagedContents: Buffer | undefined
		addV2LookAtTool(
			editor as unknown as ToolEditor,
			{} as never,
			nativeRead(undefined, async (input) => {
				stagedPath = (input as { path: string }).path
				stagedContents = readFileSync(stagedPath)
				return { output: { type: "file", encoding: "base64", mime: "image/png", content: stagedContents.toString("base64") } }
			}),
			async (request) => {
				expect((request as { prompt: string }).prompt).toContain("clipboard-1.png")
				return { content: "The image shows a chart." }
			},
		)
		const result = await editor.get("look_at")!.execute({ image_data: data, goal: "Describe it" }, context())
		expect(result.content).toBe("The image shows a chart.")
		expect(stagedContents).toEqual(png)
		expect(stagedPath).toBeDefined()
		expect(existsSync(stagedPath!)).toBe(false)
	})

	test("cleans staged files after child failure and preserves native read denials", async () => {
		const editor = new TestEditor()
		const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
		let stagedPath: string | undefined
		addV2LookAtTool(
			editor as unknown as ToolEditor,
			{} as never,
			nativeRead(undefined, async (input) => {
				stagedPath = (input as { path: string }).path
				return { output: { type: "file", encoding: "base64", mime: "image/png" } }
			}),
			async () => { throw new Error("child failed") },
		)
		await expect(editor.get("look_at")!.execute({ image_data: png.toString("base64"), goal: "Describe it" }, context()))
			.rejects.toThrow("child failed")
		expect(stagedPath).toBeDefined()
		expect(existsSync(stagedPath!)).toBe(false)

		const denied = new TestEditor()
		let childLaunched = false
		addV2LookAtTool(denied as unknown as ToolEditor, {} as never,
			nativeRead(undefined, async () => { throw new Error("read permission denied") }),
			async () => { childLaunched = true; return { content: "unexpected" } })
		await expect(denied.get("look_at")!.execute({ file_path: "/workspace/photo.png", goal: "Describe it" }, context()))
			.rejects.toThrow("read permission denied")
		expect(childLaunched).toBe(false)
	})

	test("rejects invalid, unsupported, and oversized inline media before invoking native read", async () => {
		const editor = new TestEditor()
		let reads = 0
		let launches = 0
		addV2LookAtTool(editor as unknown as ToolEditor, {} as never,
			nativeRead(undefined, async () => { reads += 1; return { output: {} } }),
			async () => { launches += 1; return { content: "unexpected" } })
		await expect(editor.get("look_at")!.execute({ image_data: "not-base64!", goal: "Describe it" }, context()))
			.rejects.toThrow("invalid base64")
		await expect(editor.get("look_at")!.execute({ image_data: "data:text/plain;base64,dGV4dA==", goal: "Describe it" }, context()))
			.rejects.toThrow("must be a PNG, JPEG, GIF, WebP, or PDF")
		const tooLarge = Buffer.alloc(20 * 1024 * 1024 + 1).toString("base64")
		await expect(editor.get("look_at")!.execute({ image_data: tooLarge, goal: "Describe it" }, context()))
			.rejects.toThrow("between 1 byte and 20971520 bytes")
		expect(reads).toBe(0)
		expect(launches).toBe(0)
	})

	test("hides the tool when read or multimodal-looker is disabled and rejects non-media", async () => {
		const disabledRead = new TestEditor()
		addV2LookAtTool(disabledRead as unknown as ToolEditor, { disabled_tools: ["read"] } as never, nativeRead({}), async () => ({ content: "" }))
		expect(disabledRead.get("look_at")).toBeUndefined()

		const disabledAgent = new TestEditor()
		addV2LookAtTool(disabledAgent as unknown as ToolEditor, { disabled_agents: ["multimodal-looker"] } as never, nativeRead({}), async () => ({ content: "" }))
		expect(disabledAgent.get("look_at")).toBeUndefined()

		const editor = new TestEditor()
		let launched = false
		addV2LookAtTool(editor as unknown as ToolEditor, {} as never, nativeRead({ type: "file", encoding: "utf8", mime: "text/plain" }), async () => { launched = true; return { content: "" } })
		await expect(editor.get("look_at")!.execute({ file_path: "/workspace/readme.txt", goal: "Summarize it" }, context()))
			.rejects.toThrow("supports native image/PDF files only")
		expect(launched).toBe(false)
	})
})
