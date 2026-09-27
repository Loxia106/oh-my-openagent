import { describe, expect, test } from "bun:test"
import { resolveV2DelegationModelSelection } from "./delegation-model-selection"

const catalog = [
	{ providerID: "openai", id: "primary", enabled: false, variants: [] },
	{ providerID: "openai", id: "second", enabled: true, variants: [
		{ id: "high", settings: {
			reasoningEffort: "high", parallelToolCalls: false,
			apiKey: "fixture-secret", baseURL: "https://provider.invalid", transport: "websocket",
			chunkTimeout: 4000, compaction: { type: "native" }, headers: { Authorization: "fixture-secret" },
		} },
		{ id: "medium", settings: { reasoningEffort: "medium" } },
	] },
	{ providerID: "anthropic", id: "fallback", enabled: true, variants: [] },
]

describe("native V2 delegation model selection", () => {
	test("skips an unavailable primary and retains the selected rich fallback entry settings", () => {
		const selected = resolveV2DelegationModelSelection({
			agentID: "explore",
			catalog,
			disabledProviders: ["anthropic"],
			agentConfig: {
				model: "openai/primary",
				temperature: 0.2,
				top_p: 0.75,
				maxTokens: 1200,
				providerOptions: { store: false },
				fallback_models: [{ model: "openai/second", reasoning: "high", temperature: 0.6, top_p: 0.9, maxTokens: 2400 }],
			},
		})

		expect(selected).toEqual({
			model: { providerID: "openai", id: "second", variant: "high" },
			settings: {
				store: false,
				temperature: 0.6,
				topP: 0.9,
				maxTokens: 2400,
				reasoningEffort: "high",
				parallelToolCalls: false,
			},
			source: "configured",
		})
	})

	test("maps canonical fallback max_tokens and provider_options to native request settings", () => {
		const selected = resolveV2DelegationModelSelection({
			agentID: "explore",
			catalog,
			agentConfig: {
				model: "openai/primary",
				maxTokens: 1200,
				providerOptions: { store: true, parallelToolCalls: true },
				fallback_models: [{
					model: "openai/second",
					max_tokens: 2468,
					provider_options: { store: false, parallelToolCalls: false, textVerbosity: "high" },
				}],
			},
		})

		expect(selected).toEqual({
			model: { providerID: "openai", id: "second" },
			settings: {
				store: false,
				parallelToolCalls: false,
				textVerbosity: "high",
				maxTokens: 2468,
			},
			source: "configured",
		})
	})

	test("resolves fallback-only and canonical models chains in order", () => {
		const fallbackOnly = resolveV2DelegationModelSelection({
			agentID: "custom-agent",
			catalog,
			agentConfig: { fallback_models: ["openai/primary", "anthropic/fallback", "openai/second"] },
		})
		expect(fallbackOnly?.model).toEqual({ providerID: "anthropic", id: "fallback" })

		const canonical = resolveV2DelegationModelSelection({
			agentID: "custom-agent",
			catalog,
			agentConfig: { models: ["openai/primary", { model: "openai/second", variant: "high", temperature: 0.4 }] },
		})
		expect(canonical).toMatchObject({
			model: { providerID: "openai", id: "second", variant: "high" },
			settings: { temperature: 0.4 },
		})
	})

	test("uses category base provider options and selected fallback overrides", () => {
		const selected = resolveV2DelegationModelSelection({
			agentID: "sisyphus-junior",
			categoryName: "deep",
			catalog,
			disabledProviders: ["anthropic"],
			categoryConfig: {
				models: ["openai/primary", { model: "openai/second", variant: "high", reasoning: "high", top_p: 0.8 }],
				provider_options: { parallelToolCalls: true },
				temperature: 0.15,
				max_tokens: 900,
				variant: "medium",
			},
		})

		expect(selected).toEqual({
			model: { providerID: "openai", id: "second", variant: "high" },
			settings: { parallelToolCalls: false, temperature: 0.15, topP: 0.8, maxTokens: 900, reasoningEffort: "high" },
			source: "configured",
		})

		const explicitVariant = resolveV2DelegationModelSelection({
			agentID: "sisyphus-junior",
			categoryName: "deep",
			catalog,
			variantOverride: "medium",
			categoryConfig: { models: [{ model: "openai/second", variant: "high" }], variant: "low" },
		})
		expect(explicitVariant?.model.variant).toBe("medium")
	})

	test("keeps a registered agent model ahead of the builtin requirement fallback", () => {
		const selected = resolveV2DelegationModelSelection({
			agentID: "oracle",
			catalog: [
				...catalog,
				{ providerID: "custom", id: "registered", enabled: true, variants: [] },
				{ providerID: "openai", id: "gpt-5.6-sol", enabled: true, variants: [{ id: "xhigh" }] },
			],
			registeredModel: { providerID: "custom", id: "registered" },
		})
		expect(selected).toMatchObject({ model: { providerID: "custom", id: "registered" }, source: "agent" })
	})

	test("applies category settings when the category inherits a registered model", () => {
		const selected = resolveV2DelegationModelSelection({
			agentID: "sisyphus-junior",
			categoryName: "unspecified-low",
			catalog,
			categoryConfig: { temperature: 0.22, top_p: 0.6, provider_options: { store: false } },
			registeredModel: { providerID: "openai", id: "second" },
		})
		expect(selected).toEqual({
			model: { providerID: "openai", id: "second" },
			settings: { store: false, temperature: 0.22, topP: 0.6 },
			source: "agent",
		})
	})

	test("an explicit agent maxTokens overrides the inherited category max_tokens alias", () => {
		const selected = resolveV2DelegationModelSelection({
			agentID: "sisyphus-junior",
			catalog,
			agentCategory: { max_tokens: 100 },
			agentConfig: { maxTokens: 500 },
			registeredModel: { providerID: "openai", id: "second" },
		})
		expect(selected?.settings).toMatchObject({ maxTokens: 500 })
	})

	test("selected canonical reasoning cannot be downgraded by the registered agent base setting", () => {
		const selected = resolveV2DelegationModelSelection({
			agentID: "explore",
			catalog,
			agentConfig: {
				model: "openai/primary",
				reasoningEffort: "low",
			fallback_models: [{ model: "openai/second", variant: "high" }],
			},
		})
		expect(selected).toEqual({
			model: { providerID: "openai", id: "second", variant: "high" },
			settings: { reasoningEffort: "high", parallelToolCalls: false },
			source: "configured",
		})
	})

	test("selected canonical reasoning applies the live variant settings over the base generation option", () => {
		const selected = resolveV2DelegationModelSelection({
			agentID: "explore",
			catalog,
			agentConfig: {
				model: "openai/primary",
				reasoningEffort: "low",
				fallback_models: [{ model: "openai/second", reasoning: "high" }],
			},
		})
		expect(selected).toMatchObject({
			model: { providerID: "openai", id: "second", variant: "high" },
			settings: { reasoningEffort: "high", parallelToolCalls: false },
		})
	})

	test("automatic reasoning clears a base generation setting for the selected child", () => {
		const selected = resolveV2DelegationModelSelection({
			agentID: "explore",
			catalog,
		agentConfig: {
			model: "openai/primary",
				reasoningEffort: "low",
				fallback_models: [{ model: "openai/second", reasoning: "auto" }],
			},
		})
		expect(selected?.settings).toMatchObject({ reasoningEffort: null })
	})

	test("does not select disabled or unavailable catalog entries", () => {
		const selected = resolveV2DelegationModelSelection({
			agentID: "custom-agent",
			catalog,
			disabledProviders: ["openai", "anthropic"],
			agentConfig: { fallback_models: ["openai/second", "anthropic/fallback"] },
			parentModel: { providerID: "openai", id: "primary" },
		})
		expect(selected).toBeUndefined()
	})

	test("fails an exhausted explicit category chain instead of using an unrelated host fallback", () => {
		const selected = resolveV2DelegationModelSelection({
			agentID: "sisyphus-junior",
			categoryName: "deep",
			catalog: [
				{ providerID: "openai", id: "host-default", enabled: true, variants: [] },
			],
			categoryConfig: { model: "openai/host-default" },
			categoryOverride: { models: ["missing/unavailable"] },
			registeredModel: { providerID: "openai", id: "host-default" },
			defaultModel: { providerID: "openai", id: "host-default" },
		})
		expect(selected).toBeUndefined()
	})
})
