import { describe, expect, test } from "bun:test"
import { advanceV2DelegationFallback, resolveV2DelegationFallbackCandidates, resolveV2DelegationModelSelection, type DelegationFallbackState } from "./delegation-model-selection"

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
	test("runtime fallback candidates preserve configured order and rich per-entry settings while filtering current and disabled models", () => {
		const resolved = resolveV2DelegationFallbackCandidates({
			agentID: "explore",
			catalog,
			disabledProviders: ["anthropic"],
			currentModel: { providerID: "openai", id: "primary" },
			agentConfig: {
				fallback_models: [
					"openai/primary",
					{ model: "openai/second", reasoning: "high", temperature: 0.45, top_p: 0.7, max_tokens: 900, provider_options: { store: false } },
					"anthropic/fallback",
					"openai/second#high",
				],
			},
		})

		expect(resolved?.source).toBe("agent")
		expect(resolved?.candidates).toEqual([{
			model: { providerID: "openai", id: "second", variant: "high" },
			settings: { store: false, temperature: 0.45, topP: 0.7, maxTokens: 900, reasoningEffort: "high", parallelToolCalls: false },
			source: "configured",
		}])
	})

	test("a configured category fallback chain takes precedence over agent fallbacks", () => {
		const resolved = resolveV2DelegationFallbackCandidates({
			agentID: "sisyphus-junior",
			categoryName: "deep",
			catalog,
			currentModel: { providerID: "openai", id: "primary" },
			categoryConfig: { fallback_models: [{ model: "openai/second", top_p: 0.6 }] },
			categoryOverride: { fallback_models: [{ model: "anthropic/fallback", temperature: 0.3 }] },
			agentConfig: { fallback_models: ["openai/second"] },
		})
		expect(resolved?.source).toBe("category")
		expect(resolved?.candidates).toMatchObject([{ model: { providerID: "anthropic", id: "fallback" }, settings: { temperature: 0.3 } }])
	})

	test("an explicit but unavailable category chain does not silently fall through to another chain", () => {
		const resolved = resolveV2DelegationFallbackCandidates({
			agentID: "sisyphus-junior",
			categoryName: "deep",
			catalog,
			categoryOverride: { fallback_models: ["missing/model"] },
			categoryConfig: { fallback_models: ["openai/second"] },
			agentConfig: { fallback_models: ["anthropic/fallback"] },
		})
		expect(resolved).toBeUndefined()
	})

	test("fallback progression advances once, persists the failed model, honors cooldown, and stops at the attempt cap", () => {
		const state: DelegationFallbackState = {
			source: "agent",
			candidates: [
				{ model: { providerID: "openai", id: "first" }, settings: {}, source: "configured" },
				{ model: { providerID: "openai", id: "second" }, settings: { maxTokens: 77 }, source: "configured" },
			],
			currentIndex: -1,
			attempts: 0,
			failedAt: {},
		}
		const first = advanceV2DelegationFallback(state, { providerID: "openai", id: "primary" }, {
			now: 1000, cooldownMs: 60_000, maxAttempts: 3,
		})
		expect(first?.choice.model.id).toBe("first")
		expect(first?.state).toMatchObject({ currentIndex: 0, attempts: 1, failedAt: { "openai/primary#": 1000 } })

		const second = advanceV2DelegationFallback(first!.state, first!.choice.model, {
			now: 1001, cooldownMs: 60_000, maxAttempts: 3,
		})
		expect(second?.choice).toEqual(state.candidates[1])
		expect(second?.state.attempts).toBe(2)
		expect(advanceV2DelegationFallback(second!.state, second!.choice.model, {
			now: 1002, cooldownMs: 60_000, maxAttempts: 2,
		})).toBeUndefined()
	})

	test("skips a configured candidate still in cooldown", () => {
		const state: DelegationFallbackState = {
			source: "agent",
			candidates: [
				{ model: { providerID: "openai", id: "first" }, settings: {}, source: "configured" },
				{ model: { providerID: "openai", id: "second" }, settings: {}, source: "configured" },
			],
			currentIndex: -1,
			attempts: 0,
			failedAt: { "openai/first#": 990 },
		}
		const next = advanceV2DelegationFallback(state, { providerID: "openai", id: "primary" }, {
			now: 1000, cooldownMs: 60_000, maxAttempts: 3,
		})
		expect(next?.choice.model.id).toBe("second")
	})

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
