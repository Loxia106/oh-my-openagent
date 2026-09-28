import { describe, expect, test } from "bun:test"
import { applyV2ModelSettingsCompatibility } from "./model-settings-guard"

describe("v2 model settings compatibility guard", () => {
	test("drops temperature for GPT reasoning models such as gpt-5.6-luna, on any provider ID", () => {
		for (const provider of ["openai", "openchamber"]) {
			const options: Record<string, unknown> = { temperature: 0.1, reasoningEffort: "medium" }
			expect(applyV2ModelSettingsCompatibility(options, provider, "gpt-5.6-luna")).toEqual(["temperature"])
			expect(options).toEqual({ reasoningEffort: "medium" })
		}
	})

	test("drops an enabled thinking budget and temperature for adaptive-only Claude, including Bedrock ids", () => {
		for (const model of ["claude-sonnet-5", "us.anthropic.claude-sonnet-5-20260801-v1:0", "claude-opus-4-7"]) {
			const options: Record<string, unknown> = { thinking: { type: "enabled", budgetTokens: 32000 }, temperature: 0.1, maxTokens: 64000 }
			const changed = applyV2ModelSettingsCompatibility(options, "amazon-bedrock", model)
			expect(changed).toContain("thinking")
			expect(changed).toContain("temperature")
			expect(options).toEqual({ maxTokens: 64000 })
		}
	})

	test("keeps supported settings and unknown-model reasoning effort untouched", () => {
		const claude46: Record<string, unknown> = { thinking: { type: "enabled", budgetTokens: 32000 }, temperature: 0.1 }
		expect(applyV2ModelSettingsCompatibility(claude46, "anthropic", "claude-sonnet-4-6")).toEqual([])
		expect(claude46).toEqual({ thinking: { type: "enabled", budgetTokens: 32000 }, temperature: 0.1 })
		const unknown: Record<string, unknown> = { reasoningEffort: "high", temperature: 0.3 }
		expect(applyV2ModelSettingsCompatibility(unknown, "omoqa", "qa-model")).toEqual([])
		expect(unknown).toEqual({ reasoningEffort: "high", temperature: 0.3 })
		const adaptive: Record<string, unknown> = { thinking: { type: "adaptive" } }
		applyV2ModelSettingsCompatibility(adaptive, "anthropic", "claude-sonnet-5")
		expect(adaptive).toEqual({ thinking: { type: "adaptive" } })
	})

	test("clamps maxTokens to the model output limit", () => {
		const options: Record<string, unknown> = { maxTokens: 999_999 }
		expect(applyV2ModelSettingsCompatibility(options, "openai", "gpt-5.6-luna")).toEqual(["maxTokens"])
		expect(options.maxTokens).toBe(128000)
	})
})
