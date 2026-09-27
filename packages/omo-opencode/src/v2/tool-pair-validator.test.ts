import { describe, expect, test } from "bun:test"
import { Message } from "@opencode/ai"
import { INTERRUPTED_TOOL_ERROR, repairV2ToolPairs } from "./tool-pair-validator"

describe("v2 tool-pair validator", () => {
	test("pairs an unanswered tool call with an error result built with the host message class", () => {
		const messages: unknown[] = [
			Message.user("run it"),
			Message.make({ role: "assistant", content: [
				{ type: "tool-call", id: "call-done", name: "shell", input: { command: "ls" } },
				{ type: "tool-call", id: "call-cut", name: "shell", input: { command: "sleep 30" } },
				{ type: "tool-call", id: "call-hosted", name: "web_search", input: {}, providerExecuted: true },
			] }),
			Message.tool({ id: "call-done", name: "shell", result: "a.txt" }),
			Message.user("continue"),
		]
		expect(repairV2ToolPairs(messages)).toEqual(["call-cut"])
		expect(messages).toHaveLength(5)
		const inserted = messages[3] as Message
		expect(inserted).toBeInstanceOf(Message)
		expect(inserted.role).toBe("tool")
		expect(inserted.content[0]).toMatchObject({ type: "tool-result", id: "call-cut", name: "shell", result: { type: "error", value: INTERRUPTED_TOOL_ERROR } })
		expect((messages[4] as Message).role).toBe("user")
		expect(repairV2ToolPairs(messages)).toEqual([])
	})
})
