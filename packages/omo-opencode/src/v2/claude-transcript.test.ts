import { afterEach, describe, expect, test } from "bun:test"
import { readFile, stat } from "node:fs/promises"
import { dirname } from "node:path"
import { applyClaudeToolInput, createClaudeTranscriptFile, toClaudeTranscript, toClaudeToolInput } from "./claude-transcript"

const cleanup: Array<() => Promise<void>> = []

afterEach(async () => {
	await Promise.all(cleanup.splice(0).map((remove) => remove()))
})

describe("native Claude transcript adapter", () => {
	test("maps only known Claude aliases back onto native tool fields", () => {
		expect(toClaudeToolInput("patch", { patchText: "old", extra: 1 })).toEqual({ patchText: "old", patch_text: "old", extra: 1 })
		expect(applyClaudeToolInput("patch", { patchText: "old", extra: 1 }, { patch_text: "new", extra: 2 })).toEqual({ patchText: "new", extra: 2 })
		expect(applyClaudeToolInput("edit", { path: "/old", oldString: "before", newString: "after" }, { file_path: "/new", old_string: "left", new_string: "right" })).toEqual({ path: "/new", oldString: "left", newString: "right" })
		expect(applyClaudeToolInput("custom_tool", { file_path: "custom-field" }, { file_path: "updated-custom-field" })).toEqual({ file_path: "updated-custom-field" })
	})

	test("maps model-visible conversation and known native tool aliases without copying inline media bytes", () => {
		const messages = toClaudeTranscript([
			{
				type: "user",
				text: "inspect these files",
				files: [
					{ name: "scan.pdf", mime: "application/pdf", source: { type: "uri", uri: "data:application/pdf;base64,PRIVATE_PDF_BYTES" }, data: "PRIVATE_PDF_BYTES" },
					{ name: "notes.txt", mime: "text/plain", source: { type: "uri", uri: "file:///tmp/notes.txt" }, data: "PRIVATE_INLINE_BYTES" },
				],
			},
			{
				type: "assistant",
				error: { type: "ProviderError", message: "prior model failure" },
				content: [
					{ type: "tool", id: "call-read", name: "read", state: { status: "completed", input: { path: "/tmp/scan.pdf" }, content: [{ type: "file", uri: "data:application/pdf;base64,PRIVATE_TOOL_BYTES", mime: "application/pdf", name: "scan.pdf" }] } },
					{ type: "tool", id: "call-patch", name: "patch", state: { status: "error", input: { patchText: "*** Begin Patch" }, error: { type: "ToolError", message: "patch rejected" } } },
				],
			},
			{ type: "assistant", error: { type: "ProviderError", message: "failure with no content" }, content: [] },
		])

		expect(JSON.stringify(messages)).not.toContain("PRIVATE_PDF_BYTES")
		expect(JSON.stringify(messages)).not.toContain("PRIVATE_INLINE_BYTES")
		expect(JSON.stringify(messages)).not.toContain("PRIVATE_TOOL_BYTES")
		expect(messages[0]?.type).toBe("user")
		const userText = messages[0]?.message.content[0]?.type === "text" ? messages[0].message.content[0].text : ""
		expect(userText).toContain("inline payload omitted")
		expect(userText).toContain("file:///tmp/notes.txt")
		expect(messages[1]).toMatchObject({
			type: "assistant",
			message: {
				content: [
					{ type: "tool_use", id: "call-read", name: "Read", input: { path: "/tmp/scan.pdf", file_path: "/tmp/scan.pdf" } },
					{ type: "tool_use", id: "call-patch", name: "Edit", input: { patchText: "*** Begin Patch", patch_text: "*** Begin Patch" } },
					{ type: "text", text: "[OpenCode assistant error (ProviderError)]: prior model failure" },
				],
			},
		})
		expect(messages[2]?.type).toBe("user")
		const readResult = messages[2]?.message.content[0]
		expect(readResult?.type === "tool_result" ? readResult.content : "").toContain("inline payload omitted")
		expect(messages[2]?.message.content[1]).toEqual({ type: "tool_result", tool_use_id: "call-patch", content: "patch rejected", is_error: true })
		expect(messages[3]).toMatchObject({
			type: "assistant",
			message: { content: [{ type: "text", text: "[OpenCode assistant error (ProviderError)]: failure with no content" }] },
		})
	})

	test("writes one private JSONL transcript and cleans only its own directory", async () => {
		const file = await createClaudeTranscriptFile([
			{ type: "user", text: "transcript marker" },
			{ type: "assistant", content: [{ type: "text", text: "answer" }] },
		])
		cleanup.push(file.cleanup)
		const contents = await readFile(file.path, "utf8")
		const metadata = await stat(file.path)
		expect(contents).toContain("transcript marker")
		expect(contents.trim().split("\n")).toHaveLength(2)
		expect(metadata.mode & 0o777).toBe(0o600)
		expect(dirname(file.path)).toContain("omo-v2-claude-transcript-")
		await file.cleanup()
		cleanup.pop()
		await expect(stat(file.path)).rejects.toThrow()
	})
})
