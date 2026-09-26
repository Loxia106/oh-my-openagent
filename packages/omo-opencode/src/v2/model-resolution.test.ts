import { describe, expect, test } from "bun:test"
import { V2ModelCatalog, resolveV2AgentModel, type V2ModelCatalogSnapshot } from "./model-resolution"

const emptyCatalog: V2ModelCatalogSnapshot = { models: [], providers: [] }

describe("V2 model catalog and resolution", () => {
  test("does not assign a fallback while the host catalog is empty, then resolves its configured default", () => {
    const input = { agent: "sisyphus", primary: true, snapshot: emptyCatalog }
    expect(resolveV2AgentModel(input)).toEqual({ source: "unresolved" })

    const catalog = new V2ModelCatalog()
    const modelEditor = {
      list: () => [{ id: "gpt-6-sol", providerID: "openai", enabled: true, variants: [] }],
      default: { get: () => ({ providerID: "openai", modelID: "gpt-6-sol" }) },
    }
    expect(catalog.captureModels(modelEditor as never)).toBe(true)
    const providers = {
      list: () => [{ provider: { id: "openai" } }],
    }
    expect(catalog.captureProviders(providers as never)).toBe(true)

    expect(resolveV2AgentModel({ ...input, snapshot: catalog.snapshot })).toEqual({
      model: "openai/gpt-6-sol",
      source: "primary-default",
    })
  })

  test("preserves an explicit provider/model even before it appears in the host catalog", () => {
    expect(resolveV2AgentModel({
      agent: "oracle",
      configuredModel: "private-provider/custom-model",
      primary: false,
      snapshot: emptyCatalog,
    })).toMatchObject({
      model: "private-provider/custom-model",
      source: "override",
      diagnostic: expect.stringContaining("not in the current OpenCode catalog"),
    })
  })

  test("leaves an unqualified unknown model unresolved instead of guessing a provider", () => {
    expect(resolveV2AgentModel({
      agent: "oracle",
      configuredModel: "custom-model",
      primary: false,
      snapshot: emptyCatalog,
    })).toMatchObject({ source: "unresolved", diagnostic: expect.stringContaining("not uniquely present") })
  })

  test("preserves unique bare model IDs while applying provider policy after catalog resolution", () => {
    const unique = {
      models: [{ id: "shared-model", providerID: "openai", enabled: true, variants: [] }],
      providers: ["openai"],
    } satisfies V2ModelCatalogSnapshot
    expect(resolveV2AgentModel({
      agent: "oracle", configuredModel: "shared-model", primary: false, snapshot: unique,
    })).toMatchObject({ model: "openai/shared-model", source: "override" })

    expect(resolveV2AgentModel({
      agent: "oracle", configuredModel: "shared-model", primary: false,
      disabledProviders: ["OPENAI"], snapshot: unique,
    })).toMatchObject({ source: "unresolved", blocked: true })

    const ambiguous = {
      models: [
        { id: "shared-model", providerID: "openai", enabled: true, variants: [] },
        { id: "shared-model", providerID: "anthropic", enabled: true, variants: [] },
      ],
      providers: ["openai", "anthropic"],
    } satisfies V2ModelCatalogSnapshot
    expect(resolveV2AgentModel({
      agent: "oracle", configuredModel: "shared-model", primary: false, snapshot: ambiguous,
    })).toMatchObject({ source: "unresolved", diagnostic: expect.stringContaining("not uniquely present") })
  })

  test("does not select a primary agent default when that catalog entry is disabled", () => {
    const snapshot: V2ModelCatalogSnapshot = {
      models: [{ id: "gpt-6-sol", providerID: "openai", enabled: false, variants: [] }],
      defaultModel: { providerID: "openai", modelID: "gpt-6-sol" },
      providers: ["openai"],
    }
    expect(resolveV2AgentModel({ agent: "sisyphus", primary: true, snapshot })).toEqual({ source: "unresolved" })
  })

  test("replaces a disabled explicit model with the first declared allowed fallback", () => {
    const snapshot: V2ModelCatalogSnapshot = {
      models: [
        { id: "opus", providerID: "BlockedProvider", enabled: true, variants: [] },
        { id: "gpt-6-sol", providerID: "openai", enabled: true, variants: [] },
      ],
      providers: ["BlockedProvider", "openai"],
    }
    expect(resolveV2AgentModel({
      agent: "oracle",
      configuredModel: "BlockedProvider/opus",
      configuredFallbacks: [" OPENAI/gpt-6-sol(high)", "anthropic/claude-opus"],
      primary: false,
      disabledProviders: [" blockedprovider "],
      snapshot,
    })).toMatchObject({
      model: "OPENAI/gpt-6-sol",
      variant: "high",
      source: "fallback",
      diagnostic: expect.stringContaining("using allowed fallback"),
    })
  })

  test("marks a disabled explicit model with no allowed declared fallback as blocked", () => {
    const resolution = resolveV2AgentModel({
      agent: "oracle",
      configuredModel: " Anthropic/claude-opus-5-5 ",
      configuredFallbacks: [" ANTHROPIC/claude-sonnet-4-5 "],
      primary: true,
      disabledProviders: ["anthropic"],
      snapshot: emptyCatalog,
    })
    expect(resolution).toMatchObject({
      source: "unresolved",
      blocked: true,
      diagnostic: expect.stringContaining("no allowed declared fallback"),
    })
    expect(resolution.model).toBeUndefined()
  })

  test("filters disabled implicit requirement providers and host defaults", () => {
    const snapshot: V2ModelCatalogSnapshot = {
      models: [
        { id: "claude-opus-5-5", providerID: "anthropic", enabled: true, variants: [] },
        { id: "gpt-5.6-sol", providerID: "openai", enabled: true, variants: [] },
      ],
      defaultModel: { providerID: "anthropic", modelID: "claude-opus-5-5" },
      providers: ["anthropic", "openai"],
    }
    expect(resolveV2AgentModel({
      agent: "sisyphus",
      primary: true,
      disabledProviders: [" Anthropic "],
      snapshot,
    })).toMatchObject({ model: "openai/gpt-5.6-sol", source: "fallback" })
  })

  test("does not convert an empty startup catalog into a false blocked-model result", () => {
    expect(resolveV2AgentModel({
      agent: "oracle",
      configuredModel: "anthropic/claude-opus-5-5",
      primary: false,
      disabledProviders: ["openai"],
      snapshot: emptyCatalog,
    })).toMatchObject({ model: "anthropic/claude-opus-5-5", source: "override" })
  })

  test("replaces the early transform view with the final host catalog and configured default", () => {
    const catalog = new V2ModelCatalog()
    catalog.captureModels({
      list: () => [{ id: "early", providerID: "openai", enabled: true, variants: [] }],
      default: { get: () => undefined },
    } as never)
    const changed = catalog.captureHostCatalog({
      models: [{
        id: "configured",
        modelID: "canonical-configured",
        providerID: "anthropic",
        enabled: true,
        variants: [{ id: "fast" }],
      } as never],
      defaultModel: {
        id: "configured",
        modelID: "canonical-configured",
        providerID: "anthropic",
        enabled: true,
        variants: [{ id: "fast" }],
      } as never,
      providers: [{ id: "anthropic" } as never],
    })
    expect(changed).toBe(true)
    expect(resolveV2AgentModel({
      agent: "sisyphus",
      primary: true,
      snapshot: catalog.snapshot,
    })).toEqual({ model: "anthropic/configured", source: "primary-default" })
  })
})
