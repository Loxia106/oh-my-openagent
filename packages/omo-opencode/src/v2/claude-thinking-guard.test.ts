import { describe, expect, test } from "bun:test"
import { stripAdaptiveOnlyClaudeSettings } from "./claude-thinking-guard"

describe("adaptive-only Claude request guard", () => {
	test("drops an enabled thinking budget and temperature for claude-sonnet-5, including Bedrock ids", () => {
		for (const model of ["claude-sonnet-5", "us.anthropic.claude-sonnet-5-20260801-v1:0", "claude-opus-4-7"]) {
			const options: Record<string, unknown> = { thinking: { type: "enabled", budgetTokens: 32000 }, temperature: 0.1, maxTokens: 64000 }
			expect(stripAdaptiveOnlyClaudeSettings(options, model)).toEqual(["thinking", "temperature"])
			expect(options).toEqual({ maxTokens: 64000 })
		}
	})

	test("keeps adaptive thinking and leaves earlier Claude and other models untouched", () => {
		const adaptive: Record<string, unknown> = { thinking: { type: "adaptive" } }
		expect(stripAdaptiveOnlyClaudeSettings(adaptive, "claude-sonnet-5")).toEqual([])
		expect(adaptive).toEqual({ thinking: { type: "adaptive" } })
		for (const model of ["claude-sonnet-4-6", "gpt-5.5"]) {
			const options: Record<string, unknown> = { thinking: { type: "enabled", budgetTokens: 32000 }, temperature: 0.1 }
			expect(stripAdaptiveOnlyClaudeSettings(options, model)).toEqual([])
			expect(options.thinking).toEqual({ type: "enabled", budgetTokens: 32000 })
		}
	})
})
