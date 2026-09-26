import { describe, expect, test } from "bun:test"
import type { AgentConfig } from "@opencode-ai/sdk"
import type { AgentEditor } from "@opencode/plugin/promise/agent"
import type { Plugin } from "@opencode/plugin"
import type { OhMyOpenCodeConfig } from "../config"
import type { LoadedSkill } from "../features/opencode-skill-loader/types"
import { createSisyphusAgent } from "../agents/sisyphus-agent-factory"
import { createSisyphusJuniorAgentWithOverrides } from "../agents/sisyphus-junior"
import { buildV2AgentConfigs, registerV2Agents, toV2PermissionRules } from "./agents"
import { V2ModelCatalog } from "./model-resolution"

function loadedSkill(
  name: string,
  scope: LoadedSkill["scope"],
  options: Partial<LoadedSkill> = {},
): LoadedSkill {
  return {
    name,
    scope,
    definition: { name, description: `Description for ${name}`, template: `Instructions for ${name}` },
    ...options,
  }
}

function sisyphusPrompt(loadedSkills: readonly LoadedSkill[]): string {
  const configs = buildV2AgentConfigs({
    config: {} as OhMyOpenCodeConfig,
    catalog: new V2ModelCatalog().snapshot,
    loadedSkills,
    directory: process.cwd(),
  })
  return configs.sisyphus?.prompt ?? ""
}

function availableSkillsSection(prompt: string): string {
  const start = prompt.indexOf("#### Available Skills")
  if (start < 0) return ""
  const end = prompt.indexOf("\n\n---", start)
  return prompt.slice(start, end < 0 ? undefined : end)
}

async function registerAgents(
  config: OhMyOpenCodeConfig,
  agents = new Map<string, any>(),
): Promise<Map<string, any>> {
  let applyTransform: ((editor: AgentEditor) => void) | undefined
  const ctx = {
    location: { directory: process.cwd() },
    agent: {
      transform: async (callback: (editor: AgentEditor) => void) => {
        applyTransform = callback
        return { dispose: async () => undefined }
      },
    },
  } as unknown as Plugin.Context
  const cleanup = await registerV2Agents(ctx, config, [], new V2ModelCatalog())
  const editor = {
    list: () => Array.from(agents.values()),
    get: (id: string) => agents.get(id),
    default: () => undefined,
    remove: (id: string) => { agents.delete(id) },
    update: (id: string, update: (agent: any) => void) => {
      const agent = agents.get(id) ?? {
        id,
        name: id,
        request: { settings: {}, headers: {}, body: {} },
        permissions: [],
        mode: "primary",
        hidden: false,
      }
      update(agent)
      agents.set(id, agent)
    },
  } as unknown as AgentEditor
  applyTransform!(editor)
  await cleanup()
  return agents
}

function createAgentEditor(agents: Map<string, any>, defaultCalls: Array<string | undefined> = []): AgentEditor {
  return {
    list: () => Array.from(agents.values()),
    get: (id: string) => agents.get(id),
    default: (id: string | undefined) => defaultCalls.push(id),
    remove: (id: string) => { agents.delete(id) },
    update: (id: string, update: (agent: any) => void) => {
      const agent = agents.get(id) ?? {
        id,
        name: id,
        request: { settings: {}, headers: {}, body: {} },
        permissions: [],
        mode: "primary",
        hidden: false,
      }
      update(agent)
      agents.set(id, agent)
    },
  } as unknown as AgentEditor
}

async function registerWithModelGuard(config: OhMyOpenCodeConfig, agents = new Map<string, any>()) {
  let applyTransform: ((editor: AgentEditor) => void) | undefined
  let modelRequest: ((input: any) => void) | undefined
  let hookDisposeCount = 0
  const defaultCalls: Array<string | undefined> = []
  const ctx = {
    location: { directory: "/tmp/omo-v2-provider-policy" },
    session: {
      hook: async (name: string, callback: (input: any) => void) => {
        if (name === "model.request") modelRequest = callback
        return { dispose: async () => { hookDisposeCount += 1 } }
      },
    },
    agent: {
      transform: async (callback: (editor: AgentEditor) => void) => {
        applyTransform = callback
        return { dispose: async () => undefined }
      },
    },
  } as unknown as Plugin.Context
  const cleanup = await registerV2Agents(ctx, config, [], new V2ModelCatalog())
  applyTransform!(createAgentEditor(agents, defaultCalls))
  return { agents, defaultCalls, modelRequest, cleanup, get hookDisposeCount() { return hookDisposeCount } }
}

describe("native v2 agents", () => {
  test("registers the complete built-in set, including Prometheus, without choosing unavailable models", () => {
    const configs = buildV2AgentConfigs({
      config: {} as OhMyOpenCodeConfig,
      catalog: new V2ModelCatalog().snapshot,
      loadedSkills: [],
      directory: process.cwd(),
    })

    expect(Object.keys(configs)).toHaveLength(11)
    expect(configs.prometheus).toBeDefined()
    for (const config of Object.values(configs)) expect(config.model).toBeUndefined()
  })

  test("adapts only the native multimodal looker from attached files to caller-authorized native reads", () => {
    const configs = buildV2AgentConfigs({
      config: {} as OhMyOpenCodeConfig,
      catalog: new V2ModelCatalog().snapshot,
      loadedSkills: [],
      directory: process.cwd(),
    })
    const looker = configs["multimodal-looker"]
    expect(looker.prompt).toContain("file bytes are not attached to this conversation")
    expect(looker.prompt).toContain("Use the native read tool only for the exact caller-provided paths")
    expect(looker.prompt).not.toContain("Never call tools")
    expect(toV2PermissionRules(looker)).toContainEqual({
      action: "read",
      resource: "*",
      effect: "allow",
    })
  })

  test("keeps model-disabled skills and unsupported team builtins out of native dynamic agent prompts", () => {
    const prompt = sisyphusPrompt([
      loadedSkill("qa-manual-only", "project", { disableModelInvocation: true }),
      loadedSkill("metadata-manual-only", "shared", { metadata: { "opencode/autoinvoke": "false" } }),
      loadedSkill("qa-visible", "project"),
    ])
    const skills = availableSkillsSection(prompt)

    expect(skills).toContain("qa-visible")
    expect(skills).toContain("frontend")
    expect(skills).not.toContain("qa-manual-only")
    expect(skills).not.toContain("metadata-manual-only")
    expect(skills).not.toContain("security-research")
    expect(skills).not.toContain("security-review")
  })

  test("preserves nonbuiltin custom skills that share names with unsupported team builtins", () => {
    for (const scope of ["project", "shared"] as const) {
      const prompt = sisyphusPrompt([loadedSkill("security-research", scope)])
      expect(prompt).toContain("security-research")
      expect(prompt).not.toContain("security-review")
    }
  })

  test("manual custom overrides suppress same-named builtin entries re-added by prompt factories", () => {
    const prompt = sisyphusPrompt([
      loadedSkill("frontend", "project", { disableModelInvocation: true }),
    ])

    expect(availableSkillsSection(prompt)).not.toContain("frontend")
  })

  test("translates action aliases in authored order and restricts irreducible alias conflicts", () => {
    const config = {
      permission: {
        bash: { "*": "allow", "rg *": "deny" },
        write: "deny",
        edit: "allow",
      },
      tools: { apply_patch: true },
    } as AgentConfig

    const conflicts: string[] = []
    expect(toV2PermissionRules(config, "metis", (conflict) => conflicts.push(conflict.selected))).toEqual([
      { action: "shell", resource: "*", effect: "allow" },
      { action: "shell", resource: "rg *", effect: "deny" },
      { action: "edit", resource: "*", effect: "deny" },
    ])
    expect(conflicts).toEqual(["deny", "deny"])
  })

  test("keeps task and call_omo_agent policies separate for Sisyphus and Sisyphus-Junior", () => {
    const sisyphus = toV2PermissionRules(createSisyphusAgent("openai/gpt-5.5"), "sisyphus")
    expect(sisyphus).toContainEqual({ action: "call_omo_agent", resource: "*", effect: "deny" })
    expect(sisyphus.some((rule) => rule.action === "subagent" && rule.effect === "deny")).toBe(false)

    const junior = toV2PermissionRules(
      createSisyphusJuniorAgentWithOverrides(undefined, "openai/gpt-5.5", false),
      "sisyphus-junior",
    )
    expect(junior).toContainEqual({ action: "task", resource: "*", effect: "deny" })
    expect(junior).toContainEqual({ action: "call_omo_agent", resource: "*", effect: "allow" })
    expect(junior.some((rule) => rule.action === "subagent")).toBe(false)

    expect(toV2PermissionRules({ permission: { task: "allow", delegate_task: "deny", call_omo_agent: "allow" } } as AgentConfig))
      .toEqual([
        { action: "task", resource: "*", effect: "deny" },
        { action: "call_omo_agent", resource: "*", effect: "allow" },
      ])
  })

  test("does not add broad restrictions based on agent name", () => {
    expect(toV2PermissionRules({} as AgentConfig, "oracle")).toEqual([])
    expect(toV2PermissionRules({ permission: { bash: "allow" } } as AgentConfig, "librarian")).toEqual([
      { action: "shell", resource: "*", effect: "allow" },
    ])
  })

  test("preserves the host default unless an enabled OMO primary agent is explicitly selected", async () => {
    const defaultCalls: Array<string | undefined> = []
    let transform: ((editor: AgentEditor) => void) | undefined
    const ctx = {
      location: { directory: "/tmp/omo-v2-agent-test" },
      agent: {
        transform: async (callback: (editor: AgentEditor) => void) => {
          transform = callback
          return { dispose: async () => undefined }
        },
      },
    } as unknown as Plugin.Context
    const catalog = new V2ModelCatalog()
    const makeEditor = (): AgentEditor => {
      const agents = new Map<string, any>()
      return {
        list: () => Array.from(agents.values()),
        get: (id: string) => agents.get(id),
        default: (id: string | undefined) => defaultCalls.push(id),
        remove: (id: string) => { agents.delete(id) },
        update: (id: string, update: (agent: any) => void) => {
          const agent = agents.get(id) ?? {
            id,
            name: id,
            request: { settings: {}, headers: {}, body: {} },
            permissions: [],
            mode: "primary",
            hidden: false,
          }
          update(agent)
          agents.set(id, agent)
        },
      } as unknown as AgentEditor
    }

    await registerV2Agents(ctx, {} as OhMyOpenCodeConfig, [], catalog)
    transform!(makeEditor())
    expect(defaultCalls).toEqual([])

    const explicitlyConfigured = { default_run_agent: "atlas" } as OhMyOpenCodeConfig
    await registerV2Agents(ctx, explicitlyConfigured, [], catalog)
    transform!(makeEditor())
    expect(defaultCalls).toEqual(["atlas"])

    const invalidDefault = { default_run_agent: "oracle" } as OhMyOpenCodeConfig
    await registerV2Agents(ctx, invalidDefault, [], catalog)
    transform!(makeEditor())
    expect(defaultCalls).toEqual(["atlas"])
  })

  test("blocks an explicitly denied OMO model even when the host could otherwise supply an allowed default", async () => {
    const existingBuiltin = new Map<string, any>([["sisyphus", { id: "sisyphus", name: "Sisyphus" }]])
    const instance = await registerWithModelGuard({
      disabled_providers: [" ANTHROPIC "],
      default_run_agent: "sisyphus",
      agents: { sisyphus: { model: "anthropic/claude-opus-5-5" } },
    } as unknown as OhMyOpenCodeConfig, existingBuiltin)
    try {
      expect(instance.agents.get("sisyphus")).toBeUndefined()
      expect(instance.defaultCalls).toEqual([])
      expect(() => instance.modelRequest?.({
        agent: "sisyphus",
        model: { providerID: "openai", id: "gpt-6-sol" },
        kind: "primary",
        sessionID: "ses-omo",
        headers: {},
      })).toThrow("no allowed declared fallback")
      // The plugin guard is scoped to configs this transform actually owns.
      expect(() => instance.modelRequest?.({
        agent: "host-owned-agent",
        model: { providerID: "anthropic", id: "claude-opus-5-5" },
        kind: "primary",
        sessionID: "ses-host",
        headers: {},
      })).not.toThrow()
    } finally {
      await instance.cleanup()
    }
  })

  test("blocks a disabled provider selected from an implicit host default for an OMO agent", async () => {
    const instance = await registerWithModelGuard({ disabled_providers: ["Anthropic"] } as OhMyOpenCodeConfig)
    try {
      expect(() => instance.modelRequest?.({
        agent: "sisyphus",
        model: { providerID: "anthropic", id: "claude-opus-5-5" },
        kind: "compaction",
        sessionID: "ses-omo",
        headers: {},
      })).toThrow("model request is blocked because provider")
    } finally {
      await instance.cleanup()
    }
  })

  test("resolves allowed fallback chains for OMO custom agents", async () => {
    const instance = await registerWithModelGuard({
      disabled_providers: ["blocked"],
      agents: {
        "api-builder": {
          prompt: "Build APIs.",
          model: "blocked/model-a",
          fallback_models: ["openai/gpt-6-sol"],
        },
      },
    } as unknown as OhMyOpenCodeConfig)
    try {
      expect(instance.agents.get("api-builder")?.model).toMatchObject({ providerID: "openai", id: "gpt-6-sol" })
      expect(() => instance.modelRequest?.({
        agent: "api-builder",
        model: { providerID: "blocked", id: "model-a" },
        kind: "primary",
        sessionID: "ses-custom",
        headers: {},
      })).toThrow("model request is blocked because provider")
    } finally {
      await instance.cleanup()
    }
  })

  test("disposes the model request guard and rolls it back if agent transform registration fails", async () => {
    const instance = await registerWithModelGuard({ disabled_providers: ["blocked"] } as OhMyOpenCodeConfig)
    await instance.cleanup()
    await instance.cleanup()
    expect(instance.hookDisposeCount).toBe(1)
    expect(() => instance.modelRequest?.({
      agent: "sisyphus",
      model: { providerID: "blocked", id: "model-a" },
      kind: "primary",
      sessionID: "ses-omo",
      headers: {},
    })).not.toThrow()

    let disposed = 0
    const failing = {
      location: { directory: "/tmp/omo-v2-provider-policy" },
      session: {
        hook: async () => ({ dispose: async () => { disposed += 1 } }),
      },
      agent: { transform: async () => { throw new Error("agent transform failed") } },
    } as unknown as Plugin.Context
    await expect(registerV2Agents(failing, { disabled_providers: ["blocked"] } as OhMyOpenCodeConfig, [], new V2ModelCatalog()))
      .rejects.toThrow("agent transform failed")
    expect(disposed).toBe(1)
  })

  test("bridges flat provider options with explicit OMO precedence and leaves host request body intact", async () => {
    const providerOptions = {
      temperature: 1.8,
      topP: 0.99,
      reasoningEffort: "max",
      thinking: { type: "disabled" },
      customOption: { source: "providerOptions" },
    }
    const sourceOptions = {
      temperature: 0.73,
      customOption: { source: "options" },
      optionsOnly: "last",
    }
    const originalProviderOptions = structuredClone(providerOptions)
    const originalSourceOptions = structuredClone(sourceOptions)
    const oracle = {
      id: "oracle",
      name: "Oracle",
      request: {
        settings: { hostSetting: "preserved" },
        headers: { "x-host-header": "preserved" },
        body: { hostBody: { preserved: true } },
      },
      permissions: [],
      mode: "subagent",
      hidden: false,
    }

    const registered = await registerAgents({
      agents: {
        oracle: {
          temperature: 0.23,
          top_p: 0.61,
          maxTokens: 317,
          reasoningEffort: "low",
          textVerbosity: "low",
          thinking: { type: "enabled", budgetTokens: 400 },
          providerOptions,
          options: sourceOptions,
        },
      },
    } as unknown as OhMyOpenCodeConfig, new Map([["oracle", oracle]]))

    expect(registered.get("oracle")?.request.settings).toMatchObject({
      hostSetting: "preserved",
      temperature: 0.73,
      topP: 0.61,
      maxTokens: 317,
      reasoningEffort: "low",
      textVerbosity: "low",
      thinking: { type: "enabled", budgetTokens: 400 },
      customOption: { source: "options" },
      optionsOnly: "last",
    })
    expect(registered.get("oracle")?.request.body).toEqual({ hostBody: { preserved: true } })
    expect(registered.get("oracle")?.request.headers).toEqual({ "x-host-header": "preserved" })
    expect(providerOptions).toEqual(originalProviderOptions)
    expect(sourceOptions).toEqual(originalSourceOptions)
  })

  test("ignores array providerOptions and options instead of exposing numeric keys", async () => {
    const registered = await registerAgents({
      agents: {
        oracle: {
          providerOptions: ["invalid-provider-options"],
          options: ["invalid-agent-options"],
        },
      },
    } as unknown as OhMyOpenCodeConfig)

    expect(registered.get("oracle")?.request.settings).not.toHaveProperty("0")
    expect(registered.get("oracle")?.request.body).toEqual({})
  })
})
