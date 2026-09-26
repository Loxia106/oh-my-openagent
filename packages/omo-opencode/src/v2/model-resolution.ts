import type { ModelEditor } from "@opencode/plugin/promise/model"
import type { ProviderEditor } from "@opencode/plugin/promise/provider"
import { AGENT_MODEL_REQUIREMENTS, transformModelForProvider } from "@oh-my-opencode/model-core"
import { isProviderDisabled } from "../shared/disabled-providers"
import { parseModelString } from "../shared/model-string-parser"

type V2CatalogModel = {
  readonly id: string
  readonly providerID: string
  readonly enabled: boolean
  readonly variants: readonly { readonly id: string }[]
}

export type V2ModelRef = {
  readonly id: string
  readonly providerID: string
  readonly variant?: string
}

export type V2ModelCatalogSnapshot = {
  readonly models: readonly V2CatalogModel[]
  readonly defaultModel?: { readonly providerID: string; readonly modelID: string }
  readonly providers: readonly string[]
}

const EMPTY_SNAPSHOT: V2ModelCatalogSnapshot = { models: [], providers: [] }

/**
 * Captures only the host's synchronous model/provider transform inputs. It does
 * not call the client during plugin setup, where model discovery can deadlock.
 */
export class V2ModelCatalog {
  #snapshot: V2ModelCatalogSnapshot = EMPTY_SNAPSHOT
  #fingerprint = ""

  get snapshot(): V2ModelCatalogSnapshot {
    return this.#snapshot
  }

  captureModels(editor: ModelEditor): boolean {
    const models = editor.list().map((model) => ({
      id: String(model.id),
      providerID: String(model.providerID),
      enabled: model.enabled,
      variants: model.variants.map((variant) => ({ id: String(variant.id) })),
    }))
    const currentDefault = editor.default.get()
    const defaultModel = currentDefault
      ? { providerID: String(currentDefault.providerID), modelID: String(currentDefault.modelID) }
      : undefined
    return this.#replace({ ...this.#snapshot, models, defaultModel })
  }

  captureProviders(editor: ProviderEditor): boolean {
    return this.#replace({
      ...this.#snapshot,
      providers: editor.list().map((record) => String(record.provider.id)).sort(),
    })
  }

  /** Replace provisional transform snapshots with the host's fully composed public catalog. */
  captureHostCatalog(input: {
    readonly models: readonly {
      readonly id: string
      readonly providerID: string
      readonly enabled: boolean
      readonly variants: readonly { readonly id: string }[]
    }[]
    readonly defaultModel: { readonly id: string; readonly providerID: string } | null
    readonly providers: readonly { readonly id: string }[]
  }): boolean {
    const models = input.models.map((model) => ({
      id: String(model.id),
      providerID: String(model.providerID),
      enabled: model.enabled,
      variants: model.variants.map((variant) => ({ id: String(variant.id) })),
    }))
    const defaultModel = input.defaultModel
      ? { providerID: String(input.defaultModel.providerID), modelID: String(input.defaultModel.id) }
      : undefined
    return this.#replace({
      models,
      defaultModel,
      providers: input.providers.map((provider) => String(provider.id)).sort(),
    })
  }

  #replace(snapshot: V2ModelCatalogSnapshot): boolean {
    const fingerprint = JSON.stringify({
      models: snapshot.models.map(({ providerID, id, enabled, variants }) => ({
        providerID,
        id,
        enabled,
        variants: variants.map((variant) => variant.id),
      })),
      defaultModel: snapshot.defaultModel,
      providers: snapshot.providers,
    })
    if (fingerprint === this.#fingerprint) return false
    this.#fingerprint = fingerprint
    this.#snapshot = snapshot
    return true
  }
}

export type V2AgentModelResolution = {
  readonly model?: string
  readonly variant?: string
  readonly source: "override" | "category" | "primary-default" | "fallback" | "unresolved"
  readonly diagnostic?: string
  /** True only when an explicit OMO model was rejected by disabled_providers. */
  readonly blocked?: boolean
}

export type V2ConfiguredModel = string | { readonly model: string; readonly variant?: string }

function modelText(value: V2ConfiguredModel | undefined): string | undefined {
  return typeof value === "string" ? value : value?.model
}

function findConfiguredModel(model: V2ConfiguredModel, snapshot: V2ModelCatalogSnapshot): V2ModelRef | undefined {
  const text = modelText(model)?.trim() ?? ""
  const parsed = parseModelString(text)
  const matches = snapshot.models.filter((candidate) => candidate.enabled && (
    parsed
      ? candidate.id === parsed.modelID && candidate.providerID === parsed.providerID
      : candidate.id === text
  ))
  if (matches.length !== 1) return undefined
  return {
    id: matches[0].id,
    providerID: matches[0].providerID,
    ...((typeof model !== "string" ? model.variant : undefined) ?? parsed?.variant
      ? { variant: (typeof model !== "string" ? model.variant : undefined) ?? parsed?.variant }
      : {}),
  }
}

function resolvedConfiguredModel(
  model: V2ConfiguredModel,
  source: "override" | "category" | "fallback",
  snapshot: V2ModelCatalogSnapshot,
): V2AgentModelResolution {
  const text = modelText(model)?.trim()
  if (!text) return { source: "unresolved" }
  const catalogModel = findConfiguredModel(model, snapshot)
  if (catalogModel) return {
    model: `${catalogModel.providerID}/${catalogModel.id}`,
    ...(catalogModel.variant ? { variant: catalogModel.variant } : {}),
    source,
  }
  const parsed = parseModelString(text)
  if (parsed) {
    return {
      model: `${parsed.providerID}/${parsed.modelID}`,
      ...((typeof model !== "string" ? model.variant : undefined) ?? parsed.variant
        ? { variant: (typeof model !== "string" ? model.variant : undefined) ?? parsed.variant }
        : {}),
      source,
      diagnostic: `Configured model "${text}" is not in the current OpenCode catalog; preserving the explicit provider/model value.`,
    }
  }
  if (text.includes("/")) {
    // Keep malformed-but-qualified legacy values visible to OpenCode, as before.
    return { model: text, source, diagnostic: `Configured model "${text}" is not in the current OpenCode catalog; preserving the explicit value.` }
  }
  return { source: "unresolved", diagnostic: `Configured model "${text}" is not uniquely present in the current OpenCode catalog.` }
}

function resolveExplicitModel(
  model: V2ConfiguredModel,
  fallbacks: readonly V2ConfiguredModel[] | undefined,
  source: "override" | "category",
  agent: string,
  disabledProviders: readonly string[],
  snapshot: V2ModelCatalogSnapshot,
): V2AgentModelResolution {
  const text = modelText(model)?.trim()
  if (!text) return { source: "unresolved" }
  const selected = findConfiguredModel(model, snapshot)
  const selectedModelRef = selected && `${selected.providerID}/${selected.id}`
  if (!isProviderDisabled(selectedModelRef ?? text, disabledProviders)) {
    return resolvedConfiguredModel(model, source, snapshot)
  }

  const deniedProvider = selected?.providerID ?? parseModelString(text)?.providerID ?? text.split("/", 1)[0]?.trim() ?? text
  for (const fallback of fallbacks ?? []) {
    const fallbackText = modelText(fallback)?.trim()
    if (!fallbackText || isProviderDisabled(fallbackText, disabledProviders)) continue
    const parsedFallback = parseModelString(fallbackText)
    // A fallback must carry a provider so its policy can be evaluated without
    // guessing from a partially-loaded catalog.
    if (!parsedFallback) continue
    return {
      ...resolvedConfiguredModel(fallback, "fallback", snapshot),
      diagnostic: `Configured model "${text}" for ${agent} uses disabled provider "${deniedProvider}"; using allowed fallback "${fallbackText}".`,
    }
  }

  return {
    source: "unresolved",
    blocked: true,
    diagnostic: `Configured model "${text}" for ${agent} uses disabled provider "${deniedProvider}" and has no allowed declared fallback. Remove it, enable the provider, or add an allowed model to the configured fallback chain.`,
  }
}

/** Resolve OMO model choices without selecting a disabled provider. */
export function resolveV2AgentModel(input: {
  readonly agent: string
  readonly configuredModel?: V2ConfiguredModel
  readonly configuredFallbacks?: readonly V2ConfiguredModel[]
  readonly categoryModel?: V2ConfiguredModel
  readonly categoryFallbacks?: readonly V2ConfiguredModel[]
  readonly disabledProviders?: readonly string[]
  readonly primary: boolean
  readonly snapshot: V2ModelCatalogSnapshot
}): V2AgentModelResolution {
  const {
    agent,
    configuredModel,
    configuredFallbacks,
    categoryModel,
    categoryFallbacks,
    disabledProviders = [],
    primary,
    snapshot,
  } = input
  for (const [model, source] of [
    [configuredModel, "override"],
    [categoryModel, "category"],
  ] as const) {
    if (!model) continue
    return resolveExplicitModel(
      model,
      source === "override" ? configuredFallbacks : categoryFallbacks,
      source,
      agent,
      disabledProviders,
      snapshot,
    )
  }

  const defaultAvailable = snapshot.defaultModel && snapshot.models.some((model) =>
    model.enabled && model.providerID === snapshot.defaultModel?.providerID && model.id === snapshot.defaultModel?.modelID,
  )
  const defaultRef = snapshot.defaultModel && `${snapshot.defaultModel.providerID}/${snapshot.defaultModel.modelID}`
  if (primary && snapshot.defaultModel && defaultAvailable && !isProviderDisabled(defaultRef, disabledProviders)) {
    return {
      model: defaultRef!,
      source: "primary-default",
    }
  }

  const requirement = AGENT_MODEL_REQUIREMENTS[agent as keyof typeof AGENT_MODEL_REQUIREMENTS]
  for (const entry of requirement?.fallbackChain ?? []) {
    for (const providerID of entry.providers) {
      const modelID = transformModelForProvider(providerID, entry.model)
      const candidate = snapshot.models.find((model) =>
        model.enabled && model.providerID === providerID && model.id === modelID &&
        !isProviderDisabled(`${model.providerID}/${model.id}`, disabledProviders),
      )
      if (candidate) {
        return {
          model: `${candidate.providerID}/${candidate.id}`,
          variant: entry.variant,
          source: "fallback",
        }
      }
    }
  }

  if (primary && defaultRef && isProviderDisabled(defaultRef, disabledProviders)) {
    return {
      source: "unresolved",
      diagnostic: `OpenCode's configured default model "${defaultRef}" uses a provider listed in disabled_providers; no allowed OMO fallback was found for ${agent}.`,
    }
  }
  return { source: "unresolved" }
}

export function toV2ModelRef(model: string | undefined, variant?: string): V2ModelRef | undefined {
  if (!model) return undefined
  const parsed = parseModelString(model)
  if (!parsed?.providerID || !parsed.modelID) return undefined
  return {
    id: parsed.modelID,
    providerID: parsed.providerID,
    ...((variant ?? parsed.variant) ? { variant: variant ?? parsed.variant } : {}),
  }
}
