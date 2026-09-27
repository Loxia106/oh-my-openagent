import { describe, expect, test } from "bun:test"
import type { AgentConfig } from "@opencode-ai/sdk"
import type { AgentEditor } from "@opencode/plugin/promise/agent"
import type { Plugin } from "@opencode/plugin"
import type { OhMyOpenCodeConfig } from "../config"
import type { LoadedSkill } from "../features/opencode-skill-loader/types"
import { createSisyphusAgent } from "../agents/sisyphus-agent-factory"
import { createSisyphusJuniorAgentWithOverrides } from "../agents/sisyphus-junior"
import { buildV2AgentConfigs, createV2BuiltinAgentPromptRenderer, registerV2Agents, toV2PermissionRules } from "./agents"
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

function sisyphusPrompt(
  loadedSkills: readonly LoadedSkill[],
  config: OhMyOpenCodeConfig = {} as OhMyOpenCodeConfig,
): string {
  const configs = buildV2AgentConfigs({
    config,
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

  test("uses native child session IDs in built-in background guidance without rewriting user prompt additions", () => {
    const catalog = new V2ModelCatalog()
    const configs = buildV2AgentConfigs({
      config: {} as OhMyOpenCodeConfig,
      catalog: catalog.snapshot,
      loadedSkills: [],
      directory: process.cwd(),
    })

    for (const name of ["sisyphus", "hephaestus"] as const) {
      expect(configs[name]?.prompt).toContain('background_output(task_id="ses_...")')
      expect(configs[name]?.prompt).not.toContain("bg_")
    }

    const withUserAppend = buildV2AgentConfigs({
      config: { agents: { sisyphus: { prompt_append: "Literal user example: bg_user_task" } } } as OhMyOpenCodeConfig,
      catalog: catalog.snapshot,
      loadedSkills: [],
      directory: process.cwd(),
    })
    expect(withUserAppend.sisyphus?.prompt).toContain("Literal user example: bg_user_task")

    const render = createV2BuiltinAgentPromptRenderer({
      config: { agents: { sisyphus: { prompt: "User prompt keeps bg_user_text" } } } as OhMyOpenCodeConfig,
      catalog: catalog.snapshot,
      loadedSkills: [],
      directory: process.cwd(),
    })
    expect(render("sisyphus", "openai/gpt-5.5")).toContain("User prompt keeps bg_user_text")
  })

  test("respects planner_enabled and keeps Prometheus user prompts as additions to the native plan prompt", async () => {
    const catalog = new V2ModelCatalog()
    const base = buildV2AgentConfigs({
      config: {} as OhMyOpenCodeConfig,
      catalog: catalog.snapshot,
      loadedSkills: [],
      directory: process.cwd(),
    }).prometheus?.prompt ?? ""
    expect(base.length).toBeGreaterThan(0)

    const configured = buildV2AgentConfigs({
      config: {
        sisyphus_agent: { planner_enabled: true },
        categories: { planning: { prompt_append: "Category planning addition" } },
        agents: {
          prometheus: {
            category: "planning",
            prompt: "User plan prompt addition",
            prompt_append: "User prompt_append addition",
            description: "Custom plan description",
          },
        },
      } as OhMyOpenCodeConfig,
      catalog: catalog.snapshot,
      loadedSkills: [],
      directory: process.cwd(),
    }).prometheus
    expect(configured?.prompt?.startsWith(base)).toBe(true)
    expect(configured?.prompt).toContain("Category planning addition")
    expect(configured?.prompt).toContain("User plan prompt addition")
    expect(configured?.prompt).toContain("User prompt_append addition")
    expect(configured?.description).toBe("Custom plan description")

    const disabled = buildV2AgentConfigs({
      config: { sisyphus_agent: { planner_enabled: false } } as OhMyOpenCodeConfig,
      catalog: catalog.snapshot,
      loadedSkills: [],
      directory: process.cwd(),
    })
    expect(disabled.prometheus).toBeUndefined()

    const existing = new Map<string, any>([["prometheus", { id: "prometheus", mode: "primary" }]])
    await registerAgents({ sisyphus_agent: { planner_enabled: false } } as OhMyOpenCodeConfig, existing)
    expect(existing.has("prometheus")).toBe(false)
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
    expect(skills).not.toContain("team-mode")
  })

  test("includes builtin team skills in agent prompts only when team mode is enabled", () => {
    const disabledSkills = availableSkillsSection(sisyphusPrompt([]))
    expect(disabledSkills).not.toContain("security-research")
    expect(disabledSkills).not.toContain("security-review")
    expect(disabledSkills).not.toContain("team-mode")

    const enabledSkills = availableSkillsSection(sisyphusPrompt([], {
      team_mode: { enabled: true },
    } as OhMyOpenCodeConfig))
    expect(enabledSkills).toContain("security-research")
    expect(enabledSkills).toContain("security-review")
    expect(enabledSkills).toContain("team-mode")
  })

  test("preserves nonbuiltin custom skills sharing names with team builtins when team mode is disabled", () => {
    for (const name of ["security-research", "security-review", "team-mode"]) {
      for (const scope of ["project", "shared"] as const) {
        const skills = availableSkillsSection(sisyphusPrompt([loadedSkill(name, scope)]))
        expect(skills).toContain(name)
      }
    }
  })

  test("does not reveal a team-named skill restricted to another agent", () => {
    const restricted = loadedSkill("security-review", "project", {
      definition: {
        name: "security-review",
        description: "Hephaestus-only security review fixture",
        template: "Review as Hephaestus.",
        agent: "hephaestus",
      },
    })
    const configs = buildV2AgentConfigs({
      config: { team_mode: { enabled: true } } as OhMyOpenCodeConfig,
      catalog: new V2ModelCatalog().snapshot,
      loadedSkills: [restricted],
      directory: process.cwd(),
    })

    expect(availableSkillsSection(configs.sisyphus?.prompt ?? "")).not.toContain("security-review")
    expect(availableSkillsSection(configs.hephaestus?.prompt ?? "")).toContain("security-review")
  })

  test("injects explicit project skill overrides from the merged V2 catalog", () => {
    const projectSkill = loadedSkill("frontend", "project", {
      definition: { name: "frontend", description: "Project override", template: "PROJECT_FRONTEND_SKILL_BODY" },
    })
    const config = { agents: { sisyphus: { skills: ["frontend"] } } } as OhMyOpenCodeConfig
    const input = {
      config,
      catalog: new V2ModelCatalog().snapshot,
      loadedSkills: [projectSkill],
      directory: "/tmp/omo-v2-agent-test",
    }

    const registered = buildV2AgentConfigs(input).sisyphus?.prompt ?? ""
    const rendered = createV2BuiltinAgentPromptRenderer(input)("sisyphus", "openai/gpt-5.5") ?? ""
    expect(registered.startsWith("PROJECT_FRONTEND_SKILL_BODY")).toBe(true)
    expect(rendered.startsWith("PROJECT_FRONTEND_SKILL_BODY")).toBe(true)
    expect(registered).not.toContain("Create a visual language")
  })

  test("injects adapted builtin skill bodies and permits explicit manual-only skill selection", () => {
    const adaptedTeamSkill = loadedSkill("team-mode", "builtin", {
      definition: { name: "team-mode", description: "Adapted native team skill", template: "V2_ADAPTED_TEAM_MODE_BODY" },
      lazyContent: { loaded: true, content: "STALE_PRE_ADAPTATION_TEAM_BODY", load: async () => "STALE_PRE_ADAPTATION_TEAM_BODY" },
    })
    const manualSkill = loadedSkill("qa-manual-only", "project", {
      disableModelInvocation: true,
      definition: { name: "qa-manual-only", description: "Explicit selection", template: "EXPLICIT_MANUAL_ONLY_BODY" },
    })
    const config = {
      team_mode: { enabled: true },
      agents: { sisyphus: { skills: ["team-mode", "qa-manual-only"] } },
    } as OhMyOpenCodeConfig
    const prompt = buildV2AgentConfigs({
      config,
      catalog: new V2ModelCatalog().snapshot,
      loadedSkills: [adaptedTeamSkill, manualSkill],
      directory: "/tmp/omo-v2-agent-test",
    }).sisyphus?.prompt ?? ""

    expect(prompt.startsWith("V2_ADAPTED_TEAM_MODE_BODY\n\nEXPLICIT_MANUAL_ONLY_BODY")).toBe(true)
    expect(prompt).not.toContain("STALE_PRE_ADAPTATION_TEAM_BODY")
  })

  test("omits disabled aliases and explicit skills restricted to a different agent", () => {
    const restricted = loadedSkill("qa-hephaestus-only", "project", {
      definition: {
        name: "qa-hephaestus-only",
        description: "Hephaestus only",
        template: "HEPHAESTUS_ONLY_EXPLICIT_BODY",
        agent: "hephaestus",
      },
    })
    const disabled = loadedSkill("qa-disabled-explicit", "project", {
      definition: { name: "qa-disabled-explicit", description: "Disabled", template: "DISABLED_EXPLICIT_BODY" },
    })
    const config = {
      disabled_skills: ["qa-disabled-explicit"],
      agents: {
        sisyphus: { skills: ["qa-hephaestus-only", "qa-disabled-explicit"] },
        hephaestus: { skills: ["qa-hephaestus-only", "qa-disabled-explicit"] },
      },
    } as OhMyOpenCodeConfig
    const configs = buildV2AgentConfigs({
      config,
      catalog: new V2ModelCatalog().snapshot,
      loadedSkills: [restricted, disabled],
      directory: "/tmp/omo-v2-agent-test",
    })

    expect(configs.sisyphus?.prompt).not.toContain("HEPHAESTUS_ONLY_EXPLICIT_BODY")
    expect(configs.sisyphus?.prompt).not.toContain("DISABLED_EXPLICIT_BODY")
    expect(configs.hephaestus?.prompt).toContain("HEPHAESTUS_ONLY_EXPLICIT_BODY")
    expect(configs.hephaestus?.prompt).not.toContain("DISABLED_EXPLICIT_BODY")
  })

  test("applies git-master settings to the resolved V2 catalog template", () => {
    const projectGitMaster = loadedSkill("git-master", "project", {
      definition: {
        name: "git-master",
        description: "Project git workflow override",
        template: "## MODE DETECTION (FIRST STEP)\nUse the project git workflow.",
      },
    })
    const prompt = buildV2AgentConfigs({
      config: {
        git_master: { git_env_prefix: "QA_GIT_MASTER=1", commit_footer: true },
        agents: { sisyphus: { skills: ["git-master"] } },
      } as OhMyOpenCodeConfig,
      catalog: new V2ModelCatalog().snapshot,
      loadedSkills: [projectGitMaster],
      directory: "/tmp/omo-v2-agent-test",
    }).sisyphus?.prompt ?? ""

    expect(prompt).toContain("QA_GIT_MASTER=1")
    expect(prompt).toContain("Ultraworked with [Sisyphus]")
    expect(prompt).toContain("Use the project git workflow.")
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

  test("places agent-restricted skill denials after authored broad and exact allows", () => {
    const rules = toV2PermissionRules({
      permission: { skill: { "*": "allow", "hephaestus-only": "allow" } },
      tools: { skill: true },
    } as unknown as AgentConfig, "sisyphus", undefined, ["hephaestus-only"])

    expect(rules.at(-1)).toEqual({ action: "skill", resource: "hephaestus-only", effect: "deny" })
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
