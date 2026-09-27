import { normalizeReasoning, transformModelForProvider } from "@oh-my-opencode/model-core"
import type { AgentOverrideConfig, CategoryConfig, FallbackModels } from "../config/schema"
import type { FallbackModelObject } from "../config/schema/fallback-models"
import { parseModelString } from "../shared/model-string-parser"
import { isProviderDisabled } from "../shared/disabled-providers"
import { AGENT_MODEL_REQUIREMENTS, CATEGORY_MODEL_REQUIREMENTS } from "../shared/model-requirements"

export type DelegationModelRef = {
	readonly providerID: string
	readonly id: string
	readonly variant?: string
}

export type DelegationModelCatalogEntry = {
	readonly providerID: string
	readonly id: string
	readonly enabled: boolean
	readonly variants: readonly {
		readonly id: string
		readonly settings?: Readonly<Record<string, unknown>>
	}[]
}

export type DelegationModelChoice = {
	readonly model: DelegationModelRef
	/** Flat OpenCode request options. Generation names use the native SDK spelling. */
	readonly settings: Readonly<Record<string, unknown>>
	readonly source: "configured" | "requirement" | "agent" | "parent" | "default"
	/** OMO category that selected this model, when the caller explicitly selected a task category. */
	readonly originCategory?: string
}

export type DelegationFallbackState = {
	readonly originCategory?: string
	readonly source: "agent" | "category"
	readonly candidates: readonly DelegationModelChoice[]
	/** Index of the last selected fallback; -1 means the initial model is still active. */
	readonly currentIndex: number
	readonly attempts: number
	readonly failedAt: Readonly<Record<string, number>>
}

export function delegationModelKey(model: DelegationModelRef): string {
	const variant = model.variant && model.variant !== "default" ? model.variant : ""
	return `${model.providerID}/${model.id}#${variant}`
}

/** Advance exactly one configured fallback and persist its failed predecessor. */
export function advanceV2DelegationFallback(
	state: DelegationFallbackState,
	failedModel: DelegationModelRef,
	options: { readonly now: number; readonly cooldownMs: number; readonly maxAttempts: number },
): { readonly state: DelegationFallbackState; readonly choice: DelegationModelChoice } | undefined {
	if (state.attempts >= options.maxAttempts) return undefined
	const failedAt = { ...state.failedAt, [delegationModelKey(failedModel)]: options.now }
	for (let index = state.currentIndex + 1; index < state.candidates.length; index += 1) {
		const candidate = state.candidates[index]
		if (!candidate || delegationModelKey(candidate.model) === delegationModelKey(failedModel)) continue
		const lastFailure = failedAt[delegationModelKey(candidate.model)]
		if (lastFailure !== undefined && options.now - lastFailure < options.cooldownMs) continue
		return {
			choice: candidate,
			state: { ...state, currentIndex: index, attempts: state.attempts + 1, failedAt },
		}
	}
	return undefined
}

type ModelEntry = string | FallbackModelObject
type ModelHolder = Pick<AgentOverrideConfig, "model" | "models" | "fallback_models" | "variant" | "reasoning" | "reasoningEffort" | "temperature" | "top_p" | "maxTokens" | "thinking" | "textVerbosity" | "providerOptions">
type CategoryHolder = Pick<CategoryConfig, "model" | "models" | "fallback_models" | "variant" | "reasoning" | "reasoningEffort" | "temperature" | "top_p" | "max_tokens" | "maxTokens" | "thinking" | "textVerbosity" | "provider_options">

export type ResolveDelegationModelInput = {
	readonly agentID: string
	readonly catalog: readonly DelegationModelCatalogEntry[]
	readonly disabledProviders?: readonly string[]
	readonly agentConfig?: ModelHolder
	readonly agentCategory?: CategoryHolder
	readonly categoryName?: string
	readonly categoryConfig?: CategoryHolder
	/** User-authored category chain, separated from merged builtin defaults. */
	readonly categoryOverride?: CategoryHolder
	/** Explicit user variant overrides selected fallback entry variants. */
	readonly variantOverride?: string
	readonly registeredModel?: DelegationModelRef
	readonly parentModel?: DelegationModelRef
	readonly defaultModel?: DelegationModelRef
}

function fallbackEntries(value: FallbackModels | undefined): ModelEntry[] {
	if (value === undefined) return []
	return typeof value === "string" ? [value] : [...value]
}

function hasFallbackModels(holder: { fallback_models?: FallbackModels } | undefined): boolean {
	return holder?.fallback_models !== undefined
}

function modelEntries(holder: { model?: string; models?: readonly ModelEntry[]; fallback_models?: FallbackModels } | undefined): ModelEntry[] {
	if (!holder) return []
	if (holder.models?.length) return [...holder.models]
	if (holder.model !== undefined) return [holder.model, ...fallbackEntries(holder.fallback_models)]
	return fallbackEntries(holder.fallback_models)
}

function hasExplicitModelChain(holder: { model?: string; models?: readonly ModelEntry[]; fallback_models?: FallbackModels } | undefined): boolean {
	return holder !== undefined && (holder.model !== undefined || holder.models !== undefined || holder.fallback_models !== undefined)
}

function parseRef(value: string): DelegationModelRef | undefined {
	const parsed = parseModelString(value.trim())
	return parsed ? { providerID: parsed.providerID, id: parsed.modelID, ...(parsed.variant ? { variant: parsed.variant } : {}) } : undefined
}

function modelText(ref: DelegationModelRef): string {
	return `${ref.providerID}/${ref.id}`
}

function baseSettings(holder: ModelHolder | CategoryHolder | undefined): Record<string, unknown> {
	if (!holder) return {}
	const value = holder as ModelHolder & CategoryHolder
	const providerOptions = value.provider_options ?? value.providerOptions
	return {
		...(providerOptions && typeof providerOptions === "object" && !Array.isArray(providerOptions)
			? providerOptions as Record<string, unknown>
			: {}),
		...(value.temperature !== undefined ? { temperature: value.temperature } : {}),
		...(value.top_p !== undefined ? { topP: value.top_p } : {}),
		...(value.max_tokens !== undefined || value.maxTokens !== undefined
			? { maxTokens: value.max_tokens ?? value.maxTokens }
			: {}),
		...(value.thinking !== undefined ? { thinking: value.thinking } : {}),
		...(value.textVerbosity !== undefined ? { textVerbosity: value.textVerbosity } : {}),
	}
}

function entrySettings(entry: ModelEntry): Partial<FallbackModelObject> {
	return typeof entry === "string" ? {} : entry
}

const NON_REQUEST_MODEL_SETTING = /^(?:api.?key|access.?token|auth(?:orization|token)?|secret|password|credential|base.?url|endpoint|transport|chunk.?timeout|timeout|compaction|fetch|headers?|body|query|url|package|providerid|modelid)$/i

function variantRequestSettings(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {}
	const result: Record<string, unknown> = {}
	for (const [key, item] of Object.entries(value)) {
		if (NON_REQUEST_MODEL_SETTING.test(key)) continue
		if (item && typeof item === "object" && !Array.isArray(item)) {
			result[key] = variantRequestSettings(item)
		} else if (Array.isArray(item)) {
			result[key] = item.map((entry) => entry && typeof entry === "object" && !Array.isArray(entry)
				? variantRequestSettings(entry)
				: entry)
		} else {
			result[key] = item
		}
	}
	return result
}

function mergeAgentBase(category: CategoryHolder | undefined, agent: ModelHolder | undefined): ModelHolder & CategoryHolder {
	const categoryProviders = category?.provider_options
	const agentProviders = agent?.providerOptions
	const maxTokens = agent?.maxTokens ?? category?.max_tokens ?? category?.maxTokens
	return {
		...category,
		...agent,
		// Category config accepts the legacy max_tokens spelling. Normalize the
		// merged value so an agent-level maxTokens always has higher precedence.
		max_tokens: maxTokens,
		maxTokens,
		provider_options: {
			...(categoryProviders ?? {}),
			...(agentProviders ?? {}),
		},
	}
}

function lowerReasoning(
	reasoning: string | undefined,
	model: DelegationModelCatalogEntry,
): { variant?: string; reasoningEffort?: string | null } {
	if (reasoning === undefined) return {}
	const normalized = normalizeReasoning(reasoning)
	if (normalized.passthrough) return { variant: normalized.passthrough }
	if (!normalized.level) return {}
	if (normalized.level === "auto") return { reasoningEffort: null }
	if (model.variants.some((candidate) => candidate.id === normalized.level)) {
		// Let OpenCode apply the native variant's configured settings. The variant
		// ID is not necessarily the provider's wire-level reasoning value.
		return { variant: normalized.level }
	}
	return { reasoningEffort: normalized.level === "off" ? "none" : normalized.level }
}

function resolveConfiguredCandidate(
	entry: ModelEntry,
	base: ModelHolder | CategoryHolder | undefined,
	catalog: readonly DelegationModelCatalogEntry[],
	disabledProviders: readonly string[],
	variantOverride?: string,
): DelegationModelChoice | undefined {
	const configuredText = typeof entry === "string" ? entry : entry.model
	const parsed = parseRef(configuredText)
	if (!parsed) return undefined
	const model = catalog.find((candidate) => candidate.enabled && candidate.providerID === parsed.providerID && candidate.id === parsed.id)
	if (!model || isProviderDisabled(modelText(parsed), disabledProviders)) return undefined

	const fields = entrySettings(entry)
	const parent = base as (ModelHolder & CategoryHolder) | undefined
	const configuredVariant = fields.variant ?? parsed.variant
	const reasoning = fields.reasoning ?? parent?.reasoning
	const lowered = lowerReasoning(reasoning, model)
	const variant = variantOverride ?? configuredVariant ?? lowered.variant ?? parent?.variant
	if (variant && !model.variants.some((candidate) => candidate.id === variant)) return undefined
	const finalVariant = variant ?? lowered.variant
	if (lowered.variant && !model.variants.some((candidate) => candidate.id === lowered.variant)) return undefined
	if (finalVariant && !model.variants.some((candidate) => candidate.id === finalVariant)) return undefined
	const selectedVariantSettings = finalVariant
		? variantRequestSettings(model.variants.find((candidate) => candidate.id === finalVariant)?.settings)
		: {}
	const entryProviderOptions = fields.provider_options ?? fields.providerOptions
	const settings: Record<string, unknown> = {
		...baseSettings(base),
		...(entryProviderOptions && typeof entryProviderOptions === "object" && !Array.isArray(entryProviderOptions)
			? entryProviderOptions
			: {}),
		...selectedVariantSettings,
		...(fields.temperature !== undefined ? { temperature: fields.temperature } : {}),
		...(fields.top_p !== undefined ? { topP: fields.top_p } : {}),
		...(fields.max_tokens !== undefined || fields.maxTokens !== undefined
			? { maxTokens: fields.max_tokens ?? fields.maxTokens }
			: {}),
		...(fields.thinking !== undefined ? { thinking: fields.thinking } : {}),
		...(fields.textVerbosity !== undefined ? { textVerbosity: fields.textVerbosity } : {}),
	}
	if (fields.reasoningEffort !== undefined) settings.reasoningEffort = fields.reasoningEffort
	else if (fields.reasoning !== undefined && (!lowered.variant || lowered.variant === finalVariant) && lowered.reasoningEffort !== undefined) {
		settings.reasoningEffort = lowered.reasoningEffort
	}
	else if ((lowered.variant === finalVariant || lowered.variant === undefined) && lowered.reasoningEffort !== undefined) {
		settings.reasoningEffort = lowered.reasoningEffort
	}
	else if (finalVariant && model.variants.some((candidate) => candidate.id === finalVariant) && selectedVariantSettings.reasoningEffort === undefined) {
		// Clear a conflicting Agent.Info request option so Core can honor all
		// selected variant settings (which may express reasoning as thinking).
		settings.reasoningEffort = null
	}
	else if (selectedVariantSettings.reasoningEffort === undefined && finalVariant === undefined && parent?.reasoningEffort !== undefined) {
		settings.reasoningEffort = parent.reasoningEffort
	}
	return {
		model: { providerID: model.providerID, id: model.id, ...(finalVariant ? { variant: finalVariant } : {}) },
		settings,
		source: "configured",
	}
}

function requirementEntries(agentID: string, categoryName?: string): FallbackModelObject[] {
	const result: FallbackModelObject[] = []
	const add = (requirement: typeof AGENT_MODEL_REQUIREMENTS[string] | undefined) => {
		for (const entry of requirement?.fallbackChain ?? []) {
			for (const providerID of entry.providers) {
				const model = `${providerID}/${transformModelForProvider(providerID, entry.model)}`
				result.push({
					model,
					...(entry.variant ? { variant: entry.variant } : {}),
					...(entry.reasoning ? { reasoning: entry.reasoning } : {}),
					...(entry.reasoningEffort ? { reasoningEffort: entry.reasoningEffort as FallbackModelObject["reasoningEffort"] } : {}),
					...(entry.temperature !== undefined ? { temperature: entry.temperature } : {}),
					...(entry.top_p !== undefined ? { top_p: entry.top_p } : {}),
					...(entry.maxTokens !== undefined ? { maxTokens: entry.maxTokens } : {}),
					...(entry.thinking ? { thinking: entry.thinking } : {}),
				})
			}
		}
	}
	if (categoryName) add(CATEGORY_MODEL_REQUIREMENTS[categoryName])
	add(AGENT_MODEL_REQUIREMENTS[agentID as keyof typeof AGENT_MODEL_REQUIREMENTS])
	return result
}

function choiceFromRef(
	ref: DelegationModelRef | undefined,
	source: DelegationModelChoice["source"],
	catalog: readonly DelegationModelCatalogEntry[],
	disabledProviders: readonly string[],
	base?: ModelHolder | CategoryHolder,
	variantOverride?: string,
): DelegationModelChoice | undefined {
	if (!ref || isProviderDisabled(modelText(ref), disabledProviders)) return undefined
	const model = catalog.find((candidate) => candidate.enabled && candidate.providerID === ref.providerID && candidate.id === ref.id)
	if (!model) return undefined
	const baseValue = base as (ModelHolder & CategoryHolder) | undefined
	const lowered = lowerReasoning(baseValue?.reasoning, model)
	const variant = variantOverride ?? baseValue?.variant ?? lowered.variant ?? ref.variant
	if (variant && !model.variants.some((candidate) => candidate.id === variant)) return undefined
	const finalVariant = variant ?? lowered.variant
	if (lowered.variant && !model.variants.some((candidate) => candidate.id === lowered.variant)) return undefined
	if (finalVariant && !model.variants.some((candidate) => candidate.id === finalVariant)) return undefined
	const selectedVariantSettings = finalVariant
		? variantRequestSettings(model.variants.find((candidate) => candidate.id === finalVariant)?.settings)
		: {}
	const settings = { ...baseSettings(base), ...selectedVariantSettings }
	if (baseValue?.reasoning === "auto") {
		settings.reasoningEffort = null
	} else if ((lowered.variant === finalVariant || lowered.variant === undefined) && lowered.reasoningEffort !== undefined) {
		settings.reasoningEffort = lowered.reasoningEffort
	} else if (finalVariant && model.variants.some((candidate) => candidate.id === finalVariant) && selectedVariantSettings.reasoningEffort === undefined) {
		settings.reasoningEffort = null
	} else if (baseValue?.reasoning === undefined && baseValue?.reasoningEffort !== undefined && settings.reasoningEffort === undefined) {
		settings.reasoningEffort = baseValue.reasoningEffort
	}
	return {
		model: { providerID: ref.providerID, id: ref.id, ...(finalVariant ? { variant: finalVariant } : {}) },
		settings,
		source,
	}
}

/**
 * Select a child model against the live, enabled OpenCode catalog. Configured
 * chains retain entry settings; unavailable entries are skipped in order.
 */
export function resolveV2DelegationModelSelection(input: ResolveDelegationModelInput): DelegationModelChoice | undefined {
	const disabled = input.disabledProviders ?? []
	const agentBase = mergeAgentBase(input.agentCategory, input.agentConfig)
	const variantOverride = input.variantOverride ?? input.agentConfig?.variant
	const agentCandidates = input.categoryName ? [] : modelEntries(input.agentConfig)
	for (const candidate of agentCandidates) {
		const selected = resolveConfiguredCandidate(candidate, agentBase, input.catalog, disabled, variantOverride)
		if (selected) return selected
	}

	if (input.categoryName) {
		for (const candidate of modelEntries(input.categoryOverride)) {
			const selected = resolveConfiguredCandidate(candidate, input.categoryConfig, input.catalog, disabled, input.variantOverride)
			if (selected) return selected
		}
		// An explicit user category chain is a constraint. If none of its entries
		// exist in the live catalog, don't silently replace it with an unrelated
		// registered-agent or host default.
		if (hasExplicitModelChain(input.categoryOverride)) return undefined
		for (const candidate of modelEntries(input.agentConfig)) {
			const selected = resolveConfiguredCandidate(candidate, agentBase, input.catalog, disabled, variantOverride)
			if (selected) return selected
		}
		for (const candidate of modelEntries(input.categoryConfig)) {
			const selected = resolveConfiguredCandidate(candidate, input.categoryConfig, input.catalog, disabled, input.variantOverride)
			if (selected) return selected
		}
	} else if (input.agentCategory) {
		for (const candidate of modelEntries(input.agentCategory)) {
			const selected = resolveConfiguredCandidate(candidate, agentBase, input.catalog, disabled, variantOverride)
			if (selected) return selected
		}
	}

	const inheritedBase = input.categoryName ? input.categoryConfig : agentBase
	const registered = choiceFromRef(input.registeredModel, "agent", input.catalog, disabled, inheritedBase, variantOverride)
	if (registered) return registered

	for (const candidate of requirementEntries(input.agentID, input.categoryName)) {
		const base = input.categoryName ? input.categoryConfig : agentBase
		const selected = resolveConfiguredCandidate(candidate, base, input.catalog, disabled, variantOverride)
		if (selected) return { ...selected, source: "requirement" }
	}

	const parent = choiceFromRef(input.parentModel, "parent", input.catalog, disabled, inheritedBase, variantOverride)
	if (parent) return parent
	return choiceFromRef(input.defaultModel, "default", input.catalog, disabled, inheritedBase, variantOverride)
}

/**
 * Resolve only explicitly configured runtime fallback entries, retaining the
 * full native settings for each candidate. Runtime fallback must not invent a
 * provider or silently substitute the model-requirement chain.
 */
export function resolveV2DelegationFallbackCandidates(
	input: ResolveDelegationModelInput & { readonly currentModel?: DelegationModelRef },
): { readonly source: "agent" | "category"; readonly candidates: readonly DelegationModelChoice[] } | undefined {
	const disabled = input.disabledProviders ?? []
	const agentBase = mergeAgentBase(input.agentCategory, input.agentConfig)
	let entries: ModelEntry[] = []
	let base: ModelHolder | CategoryHolder | undefined
	let source: "agent" | "category" = "agent"
	let chainChosen = false

	if (input.categoryName) {
		if (hasFallbackModels(input.categoryOverride)) {
			entries = fallbackEntries(input.categoryOverride?.fallback_models)
			base = input.categoryConfig
			source = "category"
			chainChosen = true
		} else if (hasFallbackModels(input.categoryConfig)) {
			entries = fallbackEntries(input.categoryConfig?.fallback_models)
			base = input.categoryConfig
			source = "category"
			chainChosen = true
		}
	}

	// Preserve the legacy precedence: an agent's own fallback chain wins over
	// its inherited category chain; an explicit task category wins over both.
	if (!chainChosen && hasFallbackModels(input.agentConfig)) {
		entries = fallbackEntries(input.agentConfig?.fallback_models)
		base = agentBase
		source = "agent"
		chainChosen = true
	}
	if (!chainChosen && hasFallbackModels(input.agentCategory)) {
		entries = fallbackEntries(input.agentCategory?.fallback_models)
		base = agentBase
		source = "category"
		chainChosen = true
	}
	if (!chainChosen || entries.length === 0) return undefined

	const seen = new Set<string>()
	const candidates: DelegationModelChoice[] = []
	for (const entry of entries) {
		const selected = resolveConfiguredCandidate(entry, base, input.catalog, disabled)
		if (!selected) continue
		const key = `${selected.model.providerID}/${selected.model.id}#${selected.model.variant ?? ""}`
		if (seen.has(key)) continue
		seen.add(key)
		if (input.currentModel && key === `${input.currentModel.providerID}/${input.currentModel.id}#${input.currentModel.variant ?? ""}`) continue
		candidates.push(selected)
	}
	// An explicitly configured chain with no enabled/currently usable entry is
	// still a constraint, but it cannot seed a durable retry state.
	return candidates.length > 0 ? { source, candidates } : undefined
}

export function categoryModelCandidates(config: CategoryHolder): readonly ModelEntry[] {
	return modelEntries(config)
}
