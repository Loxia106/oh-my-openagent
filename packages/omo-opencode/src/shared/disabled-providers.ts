import type { OhMyOpenCodeConfig } from "../config"
import type { FallbackModelObject, FallbackModels } from "../config/schema/fallback-models"
import { addConfigLoadError } from "./config-errors"
import { log } from "./logger"

const HOOK_NAME = "disabled-providers"

export function getModelProvider(model: string): string | undefined {
  const slash = model.indexOf("/")
  if (slash <= 0) return undefined
  const provider = model.slice(0, slash).trim()
  return provider || undefined
}

export function isProviderDisabled(
  model: string | undefined,
  disabled: readonly string[],
): boolean {
  if (!model || disabled.length === 0) return false
  const provider = getModelProvider(model)
  if (provider === undefined) return false
  const providerLower = provider.toLowerCase()
  return disabled.some((entry) => entry.trim().toLowerCase() === providerLower)
}

export function filterDisabledProviderModels<T extends string | FallbackModelObject>(
  models: readonly T[],
  disabled: readonly string[],
): T[] {
  if (disabled.length === 0) return [...models]
  return models.filter((entry) => {
    const model = typeof entry === "string" ? entry : entry.model
    return !isProviderDisabled(model, disabled)
  })
}

type ModelHolder = {
  model?: string | unknown
  fallback_models?: FallbackModels
  variant?: string
  reasoning?: FallbackModelObject["reasoning"]
  reasoningEffort?: FallbackModelObject["reasoningEffort"]
  temperature?: number
  top_p?: number
  max_tokens?: number
  maxTokens?: number
  provider_options?: Readonly<Record<string, unknown>>
  providerOptions?: Readonly<Record<string, unknown>>
  thinking?: FallbackModelObject["thinking"]
  textVerbosity?: FallbackModelObject["textVerbosity"]
}

function isThinkingOption(value: unknown): value is NonNullable<ModelHolder["thinking"]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const entry = value as Record<string, unknown>
  return (entry.type === "enabled" || entry.type === "disabled") &&
    (entry.budgetTokens === undefined || typeof entry.budgetTokens === "number")
}

function isTextVerbosity(value: unknown): value is NonNullable<ModelHolder["textVerbosity"]> {
  return value === "low" || value === "medium" || value === "high"
}

function fallbackEntries(value: FallbackModels | undefined): (string | FallbackModelObject)[] | undefined {
  if (!value) return undefined
  return typeof value === "string" ? [value] : [...value]
}

function findFirstAllowedReplacement(
  chain: (string | FallbackModelObject)[] | undefined,
  disabled: readonly string[],
): string | FallbackModelObject | undefined {
  if (!chain) return undefined
  for (const entry of chain) {
    const model = typeof entry === "string" ? entry : entry.model
    if (!isProviderDisabled(model, disabled)) return entry
  }
  return undefined
}

function promoteFallbackSettings(holder: ModelHolder, replacement: string | FallbackModelObject, label: string): string {
  if (typeof replacement === "string") return replacement
  if (holder.variant === undefined && replacement.variant !== undefined) holder.variant = replacement.variant
  if (replacement.reasoning !== undefined) {
    holder.reasoning = replacement.reasoning
    // A canonical reasoning choice must not be downgraded by a base direct
    // generation option; V2 applies the selected variant/settings at request time.
    holder.reasoningEffort = undefined
  } else if (replacement.reasoningEffort !== undefined && holder.reasoning === undefined) {
    holder.reasoningEffort = replacement.reasoningEffort
  }
  if (replacement.temperature !== undefined) holder.temperature = replacement.temperature
  if (replacement.top_p !== undefined) holder.top_p = replacement.top_p
  const maxTokens = replacement.max_tokens ?? replacement.maxTokens
  if (maxTokens !== undefined) {
    holder.maxTokens = maxTokens
    // A category may still contain the legacy alias, which otherwise shadows
    // this promoted value during model selection.
    if (holder.max_tokens !== undefined) holder.max_tokens = maxTokens
  }
  const providerOptions = replacement.provider_options ?? replacement.providerOptions
  if (providerOptions !== undefined) {
    const merged = {
      ...(label.startsWith("agents.") ? holder.providerOptions : holder.provider_options),
      ...providerOptions,
    }
    if (label.startsWith("agents.")) holder.providerOptions = merged
    else holder.provider_options = merged
    if (isThinkingOption(providerOptions.thinking)) holder.thinking = providerOptions.thinking
    if (isTextVerbosity(providerOptions.textVerbosity)) holder.textVerbosity = providerOptions.textVerbosity
  }
  if (replacement.thinking !== undefined) holder.thinking = replacement.thinking
  if (replacement.textVerbosity !== undefined) holder.textVerbosity = replacement.textVerbosity
  return replacement.model
}

function applyToHolder(label: string, holder: ModelHolder, disabled: readonly string[]): void {
  const normalizedChain = fallbackEntries(holder.fallback_models)
  if (normalizedChain) {
    const filteredChain = filterDisabledProviderModels(normalizedChain, disabled)
    if (filteredChain.length !== normalizedChain.length) {
      log(`[${HOOK_NAME}] Filtered disabled-provider entries from fallback chain`, {
        label,
        removed: normalizedChain.length - filteredChain.length,
        remaining: filteredChain.length,
      })
    }
    // Normalize empty chain to undefined so downstream "no chain declared"
    // and "empty chain declared" stay semantically distinct.
    holder.fallback_models = filteredChain.length === 0 ? undefined : filteredChain
  }

  if (typeof holder.model === "string" && isProviderDisabled(holder.model, disabled)) {
    const replacement = findFirstAllowedReplacement(
      fallbackEntries(holder.fallback_models),
      disabled,
    )
    if (replacement) {
      const replacementModel = typeof replacement === "string" ? replacement : replacement.model
      log(`[${HOOK_NAME}] Substituted primary model from fallback chain`, {
        label,
        from: holder.model,
        to: replacementModel,
      })
      holder.model = promoteFallbackSettings(holder, replacement, label)
    } else {
      // Surface to the user-facing config-error channel so this does not
      // hide as a runtime ProviderModelNotFoundError on first delegation.
      const message =
        `${label} primary model "${holder.model}" uses a disabled provider and no allowed entry is available in fallback_models. ` +
        `Either remove the provider from disabled_providers or add an allowed entry to fallback_models.`
      addConfigLoadError({ path: `disabled_providers:${label}`, error: message })
      log(`[${HOOK_NAME}] ${message}`, { label, primary: holder.model })
    }
  }
}

/**
 * Filters `disabled_providers`-listed entries out of every agent/category
 * fallback chain and substitutes any primary `model` referencing a disabled
 * provider with the first allowed entry from the same chain.
 *
 * Returns the same config reference (mutated in place). Safe to call when
 * `disabled_providers` is unset or empty - it becomes a no-op.
 */
export function applyDisabledProviders(config: OhMyOpenCodeConfig): OhMyOpenCodeConfig {
  const disabled = config.disabled_providers ?? []
  if (disabled.length === 0) return config

  if (config.agents) {
    for (const [name, agentConfig] of Object.entries(config.agents)) {
      if (agentConfig && typeof agentConfig === "object") {
        applyToHolder(`agents.${name}`, agentConfig as ModelHolder, disabled)
      }
    }
  }

  if (config.categories) {
    for (const [name, categoryConfig] of Object.entries(config.categories)) {
      if (categoryConfig && typeof categoryConfig === "object") {
        applyToHolder(`categories.${name}`, categoryConfig as ModelHolder, disabled)
      }
    }
  }

  return config
}
