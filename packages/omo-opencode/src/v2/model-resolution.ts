import type { ModelEditor } from "@opencode/plugin/promise/model"
import type { ProviderEditor } from "@opencode/plugin/promise/provider"
import { AGENT_MODEL_REQUIREMENTS, transformModelForProvider } from "@oh-my-opencode/model-core"

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

function parseModelName(model: string): { providerID?: string; modelID: string } {
  const separator = model.indexOf("/")
  if (separator < 0) return { modelID: model }
  return { providerID: model.slice(0, separator), modelID: model.slice(separator + 1) }
}

function findConfiguredModel(model: string, snapshot: V2ModelCatalogSnapshot): V2ModelRef | undefined {
  const parsed = parseModelName(model)
  const matches = snapshot.models.filter((candidate) =>
    candidate.enabled && candidate.id === parsed.modelID &&
    (parsed.providerID === undefined || candidate.providerID === parsed.providerID),
  )
  if (matches.length !== 1) return undefined
  return { id: matches[0].id, providerID: matches[0].providerID }
}

export type V2AgentModelResolution = {
  readonly model?: string
  readonly variant?: string
  readonly source: "override" | "category" | "primary-default" | "fallback" | "unresolved"
  readonly diagnostic?: string
}

/** Resolve an explicit model verbatim; only choose fallbacks present in OpenCode's live catalog. */
export function resolveV2AgentModel(input: {
  readonly agent: string
  readonly configuredModel?: string
  readonly categoryModel?: string
  readonly primary: boolean
  readonly snapshot: V2ModelCatalogSnapshot
}): V2AgentModelResolution {
  const { agent, configuredModel, categoryModel, primary, snapshot } = input
  for (const [model, source] of [
    [configuredModel, "override"],
    [categoryModel, "category"],
  ] as const) {
    if (!model) continue
    const catalogModel = findConfiguredModel(model, snapshot)
    if (catalogModel) return { model: `${catalogModel.providerID}/${catalogModel.id}`, source }
    // Preserve an explicit provider/model reference even when it is not yet in
    // the host catalog. OpenCode will report the same missing-provider/model
    // problem to the user; silently substituting a different model is worse.
    if (model.includes("/")) {
      return {
        model,
        source,
        diagnostic: `Configured model "${model}" for ${agent} is not in the current OpenCode catalog; preserving the explicit value.`,
      }
    }
    const diagnostic = `Configured model "${model}" for ${agent} is not uniquely present in the current OpenCode catalog.`
    return { source: "unresolved", diagnostic }
  }

  const defaultAvailable = snapshot.defaultModel && snapshot.models.some((model) =>
    model.enabled && model.providerID === snapshot.defaultModel?.providerID && model.id === snapshot.defaultModel?.modelID,
  )
  if (primary && snapshot.defaultModel && defaultAvailable) {
    return {
      model: `${snapshot.defaultModel.providerID}/${snapshot.defaultModel.modelID}`,
      source: "primary-default",
    }
  }

  const requirement = AGENT_MODEL_REQUIREMENTS[agent as keyof typeof AGENT_MODEL_REQUIREMENTS]
  for (const entry of requirement?.fallbackChain ?? []) {
    for (const providerID of entry.providers) {
      const modelID = transformModelForProvider(providerID, entry.model)
      const candidate = snapshot.models.find((model) =>
        model.enabled && model.providerID === providerID && model.id === modelID,
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

  return { source: "unresolved" }
}

export function toV2ModelRef(model: string | undefined, variant?: string): V2ModelRef | undefined {
  if (!model) return undefined
  const parsed = parseModelName(model)
  if (!parsed.providerID || !parsed.modelID) return undefined
  return {
    id: parsed.modelID,
    providerID: parsed.providerID,
    ...(variant ? { variant } : {}),
  }
}
