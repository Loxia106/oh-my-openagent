import type { Plugin } from "@opencode/plugin"
import type { Info as NativeAgentInfo } from "@opencode/schema/agent"
import type { AgentConfig } from "@opencode-ai/sdk"
import { AGENT_MODEL_REQUIREMENTS, transformModelForProvider } from "@oh-my-opencode/model-core"
import type { OhMyOpenCodeConfig } from "../config"
import type { AgentOverrideConfig, BuiltinAgentName } from "../agents/types"
import type { AvailableAgent, AvailableCategory, AvailableSkill } from "../agents/dynamic-agent-prompt-builder"
import type { LoadedSkill } from "../features/opencode-skill-loader/types"
import { createSisyphusAgent, SISYPHUS_PROMPT_METADATA } from "../agents/sisyphus"
import { createHephaestusAgent, hephaestusPromptMetadata } from "../agents/hephaestus"
import { isHephaestusSupportedModel } from "../agents/hephaestus"
import { applyFrontierToolSchemaPermission } from "../agents/frontier-tool-schema-guard"
import { createOracleAgent, ORACLE_PROMPT_METADATA } from "../agents/oracle"
import { createLibrarianAgent, LIBRARIAN_PROMPT_METADATA } from "../agents/librarian"
import { createExploreAgent, EXPLORE_PROMPT_METADATA } from "../agents/explore"
import { createMultimodalLookerAgent, MULTIMODAL_LOOKER_PROMPT_METADATA } from "../agents/multimodal-looker"
import { createMetisAgent, metisPromptMetadata } from "../agents/metis"
import { createMomusAgent, momusPromptMetadata } from "../agents/momus"
import { createAtlasAgent, atlasPromptMetadata } from "../agents/atlas/agent"
import { createSisyphusJuniorAgentWithOverrides } from "../agents/sisyphus-junior"
import { getPrometheusPrompt, PROMETHEUS_PERMISSION } from "../agents/prometheus"
import { buildAvailableSkills } from "../agents/builtin-agents/available-skills"
import { applyOverrides } from "../agents/builtin-agents/agent-overrides"
import { applyEnvironmentContext } from "../agents/builtin-agents/environment-context"
import { resolveAgentSkills } from "../agents/agent-skill-resolution"
import { collectDisabledSkillAliases } from "../plugin/skill-context"
import { isTaskSystemEnabled } from "../shared"
import { mergeCategories } from "../shared/merge-categories"
import { CATEGORY_DESCRIPTIONS } from "../tools/delegate-task/constants"
import { log } from "../shared/logger"
import { resolveV2AgentModel, toV2ModelRef, type V2ModelCatalog, type V2ModelCatalogSnapshot } from "./model-resolution"
import { loadV2CustomAgentConfigs } from "./custom-agents"

const BUILTIN_AGENT_NAMES = [
  "sisyphus", "hephaestus", "prometheus", "atlas", "sisyphus-junior",
  "explore", "librarian", "oracle", "multimodal-looker", "metis", "momus",
] as const

const DISPLAY_NAMES: Record<(typeof BUILTIN_AGENT_NAMES)[number], string> = {
  sisyphus: "Sisyphus",
  hephaestus: "Hephaestus",
  prometheus: "Prometheus",
  atlas: "Atlas",
  "sisyphus-junior": "Sisyphus-Junior",
  explore: "Explore",
  librarian: "Librarian",
  oracle: "Oracle",
  "multimodal-looker": "Multimodal-Looker",
  metis: "Metis",
  momus: "Momus",
}

const PROMPT_METADATA: Partial<Record<(typeof BUILTIN_AGENT_NAMES)[number], AvailableAgent["metadata"]>> = {
  sisyphus: SISYPHUS_PROMPT_METADATA,
  hephaestus: hephaestusPromptMetadata,
  atlas: atlasPromptMetadata,
  explore: EXPLORE_PROMPT_METADATA,
  librarian: LIBRARIAN_PROMPT_METADATA,
  oracle: ORACLE_PROMPT_METADATA,
  "multimodal-looker": MULTIMODAL_LOOKER_PROMPT_METADATA,
  metis: metisPromptMetadata,
  momus: momusPromptMetadata,
}

const PRIMARY_AGENTS = new Set<string>(["sisyphus", "prometheus", "atlas"])

function promptFallbackModel(name: string): string | undefined {
  const requirement = AGENT_MODEL_REQUIREMENTS[name as BuiltinAgentName]
  const first = requirement?.fallbackChain?.[0]
  if (!first?.providers[0]) return undefined
  return `${first.providers[0]}/${transformModelForProvider(first.providers[0], first.model)}`
}

function getOverride(config: OhMyOpenCodeConfig, name: string): AgentOverrideConfig | undefined {
  const agents = config.agents as Record<string, AgentOverrideConfig | undefined> | undefined
  return agents?.[name] ?? Object.entries(agents ?? {}).find(([key]) => key.toLowerCase() === name)?.[1]
}

function isDisabled(config: OhMyOpenCodeConfig, name: string): boolean {
  return (config.disabled_agents ?? []).some((disabled) => disabled.toLowerCase() === name) ||
    (name === "sisyphus" && config.sisyphus_agent?.disabled === true) ||
    getOverride(config, name)?.disable === true
}

function createBaseAgent(input: {
  name: (typeof BUILTIN_AGENT_NAMES)[number]
  model: string
  agents: AvailableAgent[]
  skills: AvailableSkill[]
  categories: AvailableCategory[]
  userCategories: OhMyOpenCodeConfig["categories"]
  useTaskSystem: boolean
}): AgentConfig {
  const { name, model, agents, skills, categories, userCategories, useTaskSystem } = input
  switch (name) {
    case "sisyphus":
      return createSisyphusAgent(model, agents, undefined, skills, categories, useTaskSystem)
    case "hephaestus":
      return createHephaestusAgent(model, agents, undefined, skills, categories, useTaskSystem)
    case "prometheus":
      return {
        model,
        description: "Strategic planning agent that interviews, analyzes the task, and creates an actionable plan. (Prometheus - OhMyOpenCode)",
        mode: "primary",
        prompt: getPrometheusPrompt(model),
        permission: PROMETHEUS_PERMISSION as AgentConfig["permission"],
        color: "#FF5722",
      }
    case "atlas":
      return createAtlasAgent({ model, availableAgents: agents, availableSkills: skills, userCategories })
    case "sisyphus-junior":
      return createSisyphusJuniorAgentWithOverrides(undefined, model, useTaskSystem)
    case "oracle": return createOracleAgent(model)
    case "librarian": return createLibrarianAgent(model)
    case "explore": return createExploreAgent(model)
    case "multimodal-looker": {
      const agent = createMultimodalLookerAgent(model)
      return {
        ...agent,
        prompt: adaptMultimodalLookerPrompt(agent.prompt ?? ""),
      }
    }
    case "metis": return createMetisAgent(model)
    case "momus": return createMomusAgent(model)
  }
}

const LOOKER_LEGACY_ATTACHMENT_INSTRUCTION = "During look_at invocations, the file or image is already attached to the message. Analyze the attachment directly. Never call tools, never spawn other agents, and never try to load the file by path."

const LOOKER_NATIVE_READ_INSTRUCTION = "The caller provides local file paths; file bytes are not attached to this conversation. Use the native read tool only for the exact caller-provided paths, and analyze its returned image or PDF content. Do not write files or spawn agents. If a path cannot be read or its format is unsupported, say so clearly."

function adaptMultimodalLookerPrompt(prompt: string): string {
  return prompt.replace(LOOKER_LEGACY_ATTACHMENT_INSTRUCTION, LOOKER_NATIVE_READ_INSTRUCTION)
}

function permissionAction(action: string): string {
  if (action === "bash") return "shell"
  if (action === "write" || action === "edit" || action === "apply_patch" || action === "patch") return "edit"
  // task and call_omo_agent have different per-agent policies in OMO. Native
  // subagent execution is checked against those aliases at the delegation boundary.
  if (action === "delegate_task") return "task"
  return action
}

export type V2PermissionConflict = {
  readonly agent: string
  readonly action: string
  readonly resource: string
  readonly effects: readonly ["allow" | "ask" | "deny", "allow" | "ask" | "deny"]
  readonly selected: "allow" | "ask" | "deny"
}

const PERMISSION_RESTRICTIVENESS = { allow: 0, ask: 1, deny: 2 } as const

export function toV2PermissionRules(
  config: AgentConfig,
  agentName = "unknown",
  onConflict?: (conflict: V2PermissionConflict) => void,
): NativeAgentInfo["permissions"] {
  const permissions = (config.permission ?? {}) as Record<string, unknown>
  const tools = (config.tools ?? {}) as Record<string, boolean>
  const rules: Array<NativeAgentInfo["permissions"][number]> = []
  const ruleIndexes = new Map<string, number>()
  const add = (action: string, resource: string, effect: unknown) => {
    if (effect !== "allow" && effect !== "ask" && effect !== "deny") return
    const nativeAction = permissionAction(action)
    const key = `${nativeAction}\u0000${resource}`
    const priorIndex = ruleIndexes.get(key)
    if (priorIndex === undefined) {
      ruleIndexes.set(key, rules.length)
      rules.push({ action: nativeAction, resource, effect })
      return
    }
    const prior = rules[priorIndex]
    if (prior.effect === effect) return
    const selected = PERMISSION_RESTRICTIVENESS[prior.effect] > PERMISSION_RESTRICTIVENESS[effect]
      ? prior.effect
      : effect
    rules[priorIndex] = { ...prior, effect: selected }
    onConflict?.({
      agent: agentName,
      action: nativeAction,
      resource,
      effects: [prior.effect, effect],
      selected,
    })
  }

  for (const [action, effect] of Object.entries(permissions)) {
    if (typeof effect === "string") {
      add(action, "*", effect)
      continue
    }
    if (effect && typeof effect === "object" && !Array.isArray(effect)) {
      for (const [resource, resourceEffect] of Object.entries(effect)) add(action, resource, resourceEffect)
    }
  }
  for (const [action, enabled] of Object.entries(tools)) add(action, "*", enabled ? "allow" : "deny")

  return rules
}

function nativeSettings(config: AgentConfig): Record<string, unknown> {
  const source = config as AgentConfig & Record<string, unknown>
  const providerOptions = source.providerOptions
  const settings: Record<string, unknown> = providerOptions && typeof providerOptions === "object" && !Array.isArray(providerOptions)
    ? { ...(providerOptions as Record<string, unknown>) }
    : {}
  // Precedence is deliberate: flat providerOptions seed the native option bag;
  // mapped top-level generation/reasoning fields override them; the existing
  // native adapter's `options` object remains the final OMO override.
  if (source.temperature !== undefined) settings.temperature = source.temperature
  if (source.top_p !== undefined) settings.topP = source.top_p
  if (source.maxTokens !== undefined) settings.maxTokens = source.maxTokens
  for (const key of ["reasoningEffort", "textVerbosity", "thinking", "topK", "frequencyPenalty", "presencePenalty", "seed", "stop"]) {
    if (source[key] !== undefined) settings[key] = source[key]
  }
  if (source.options && typeof source.options === "object" && !Array.isArray(source.options)) {
    Object.assign(settings, source.options)
  }
  return settings
}

const V2_UNSUPPORTED_TEAM_PROMPT_SKILLS = new Set(["security-research", "security-review", "team-mode"])

function disablesModelInvocation(skill: Pick<LoadedSkill, "disableModelInvocation" | "metadata">): boolean {
  const autoinvoke: unknown = skill.metadata?.["opencode/autoinvoke"]
  return skill.disableModelInvocation === true || autoinvoke === false ||
    (typeof autoinvoke === "string" && autoinvoke.trim().toLowerCase() === "false")
}

/**
 * Agent prompts are also used by the legacy skill picker, so keep its shared
 * behavior unchanged and apply native OpenCode's invocation policy here.
 * Provenance matters: custom plugin/user skills may intentionally share a
 * name with a builtin that this runtime cannot support.
 */
function nativePromptSkills(available: AvailableSkill[], loadedSkills: readonly LoadedSkill[]): AvailableSkill[] {
  const winners = new Map(loadedSkills.map((skill) => [skill.name.toLowerCase(), skill]))
  return available.filter((skill) => {
    const name = skill.name.toLowerCase()
    const winner = winners.get(name)
    if (winner && disablesModelInvocation(winner)) return false
    if (!V2_UNSUPPORTED_TEAM_PROMPT_SKILLS.has(name)) return true
    return winner !== undefined && winner.scope !== "builtin"
  })
}

function catalogPrompts(input: {
  config: OhMyOpenCodeConfig
  catalog: V2ModelCatalogSnapshot
  loadedSkills: readonly LoadedSkill[]
  directory: string
}): Record<string, AgentConfig> {
  const { config, catalog, loadedSkills, directory } = input
  const mergedCategories = mergeCategories(config.categories)
  const availableCategories: AvailableCategory[] = Object.entries(mergedCategories).map(([name, category]) => ({
    name,
    description: category.description ?? CATEGORY_DESCRIPTIONS[name] ?? "General tasks",
  }))
  const disabledSkills = collectDisabledSkillAliases(config)
  const modelInvocableSkills = loadedSkills.filter((skill) => !disablesModelInvocation(skill))
  const availableSkills = nativePromptSkills(buildAvailableSkills(
    [...modelInvocableSkills],
    config.browser_automation_engine?.provider,
    disabledSkills,
    config.team_mode?.enabled,
  ), loadedSkills)
  const resolutions = new Map<string, ReturnType<typeof resolveV2AgentModel>>()
  const promptModels = new Map<string, string>()
  for (const name of BUILTIN_AGENT_NAMES) {
    const override = getOverride(config, name)
    const categoryModel = override?.category ? mergedCategories[override.category]?.model : undefined
    const resolution = resolveV2AgentModel({
      agent: name,
      configuredModel: override?.model,
      categoryModel,
      primary: PRIMARY_AGENTS.has(name),
      snapshot: catalog,
    })
    resolutions.set(name, resolution)
    if (resolution.diagnostic) log(`[v2 agent] ${resolution.diagnostic}`)
    promptModels.set(name, resolution.model ?? promptFallbackModel(name) ?? "anthropic/claude-opus-5-5")
  }

  const preliminary = new Map<string, AgentConfig>()
  for (const name of BUILTIN_AGENT_NAMES) {
    if (isDisabled(config, name)) continue
    const model = promptModels.get(name)!
    if (name === "hephaestus" && !isHephaestusSupportedModel(model)) {
      log(`[v2 agent] Hephaestus is not registered because its prompt model "${model}" is unsupported.`)
      continue
    }
    const override = getOverride(config, name)
    let base: AgentConfig
    try {
      base = createBaseAgent({
        name,
        model,
        agents: [],
        skills: availableSkills,
        categories: availableCategories,
        userCategories: config.categories,
        useTaskSystem: isTaskSystemEnabled(config),
      })
    } catch (error) {
      if (name === "hephaestus") {
        log(`[v2 agent] Hephaestus could not build a prompt for model ${model}; skipping it.`, error)
        continue
      }
      log(`[v2 agent] Could not build ${name} for model ${model}; retrying with its built-in prompt model.`, error)
      base = createBaseAgent({
        name,
        model: promptFallbackModel(name) ?? "openai/gpt-5.6-sol",
        agents: [],
        skills: availableSkills,
        categories: availableCategories,
        userCategories: config.categories,
        useTaskSystem: isTaskSystemEnabled(config),
      })
    }
    let built = applyOverrides(base, override, mergedCategories, directory)
    if (name === "librarian") built = applyEnvironmentContext(built, directory, { disableOmoEnv: false })
    built = resolveAgentSkills(built, {
      gitMasterConfig: config.git_master,
      browserProvider: config.browser_automation_engine?.provider,
      disabledSkills,
      teamModeEnabled: config.team_mode?.enabled,
    })
    preliminary.set(name, built)
  }

  const visibleAgents: AvailableAgent[] = []
  for (const [name, metadata] of Object.entries(PROMPT_METADATA)) {
    const configAgent = preliminary.get(name)
    if (!configAgent || !metadata) continue
    visibleAgents.push({ name, description: configAgent.description ?? "", metadata })
  }

  const result: Record<string, AgentConfig> = {}
  for (const name of BUILTIN_AGENT_NAMES) {
    if (isDisabled(config, name)) continue
    const override = getOverride(config, name)
    const model = promptModels.get(name)!
    if (name === "hephaestus" && !isHephaestusSupportedModel(model)) {
      log(`[v2 agent] Hephaestus is not registered because its prompt model "${model}" is unsupported.`)
      continue
    }
    let base: AgentConfig
    try {
      base = createBaseAgent({
        name,
        model,
        agents: visibleAgents,
        skills: availableSkills,
        categories: availableCategories,
        userCategories: config.categories,
        useTaskSystem: isTaskSystemEnabled(config),
      })
    } catch (error) {
      if (name === "hephaestus") {
        log(`[v2 agent] Hephaestus could not build a prompt for model ${model}; skipping it.`, error)
        continue
      }
      log(`[v2 agent] Could not build ${name} for model ${model}; using the built-in prompt model.`, error)
      base = createBaseAgent({
        name,
        model: promptFallbackModel(name) ?? "openai/gpt-5.6-sol",
        agents: visibleAgents,
        skills: availableSkills,
        categories: availableCategories,
        userCategories: config.categories,
        useTaskSystem: isTaskSystemEnabled(config),
      })
    }
    let built = applyOverrides(base, override, mergedCategories, directory)
    if (name === "librarian") {
      built = applyEnvironmentContext(built, directory, {
        disableOmoEnv: config.experimental?.disable_omo_env ?? false,
      })
    }
    built = resolveAgentSkills(built, {
      gitMasterConfig: config.git_master,
      browserProvider: config.browser_automation_engine?.provider,
      disabledSkills,
      teamModeEnabled: config.team_mode?.enabled,
    })

    const resolution = resolutions.get(name)
    if (name === "hephaestus") {
      const resolvedModel = typeof built.model === "string" ? built.model : resolution?.model
      if (resolvedModel && !isHephaestusSupportedModel(resolvedModel)) {
        log(`[v2 agent] Hephaestus is not registered because its configured model "${resolvedModel}" is unsupported.`)
        continue
      }
      const permissionModel = resolvedModel ?? promptFallbackModel(name) ?? ""
      built.permission = applyFrontierToolSchemaPermission(
        built.permission,
        permissionModel,
        override?.permission,
        override?.tools,
      )
    }
    // A prompt model can be used to build family-specific instructions while
    // the host catalog is empty, but it is never installed as the agent model.
    if (resolution?.model) built.model = resolution.model
    else delete built.model
    if (resolution?.variant) built.variant = override?.variant ?? resolution.variant
    result[name] = built
  }
  return result
}

function toNativeAgentConfig(
  name: string,
  config: AgentConfig,
  onPermissionConflict?: (conflict: V2PermissionConflict) => void,
): Partial<NativeAgentInfo> {
  const source = config as AgentConfig & Record<string, unknown>
  const model = toV2ModelRef(typeof source.model === "string" ? source.model : undefined, typeof source.variant === "string" ? source.variant : undefined)
  const settings = nativeSettings(config)
  const permissions = toV2PermissionRules(config, name, onPermissionConflict)
  return {
    id: name as NativeAgentInfo["id"],
    name: (typeof source.displayName === "string" ? source.displayName : DISPLAY_NAMES[name as keyof typeof DISPLAY_NAMES] ?? name) as NativeAgentInfo["name"],
    ...(model ? { model: model as NativeAgentInfo["model"] } : {}),
    ...(typeof source.prompt === "string" ? { system: source.prompt } : {}),
    ...(typeof source.description === "string" ? { description: source.description } : {}),
    mode: source.mode === "primary" || source.mode === "all" ? source.mode : "subagent",
    hidden: false,
    ...(typeof source.color === "string" ? { color: source.color } : {}),
    ...(typeof source.maxSteps === "number" ? { steps: source.maxSteps } : {}),
    request: {
      settings,
      headers: {},
      // Provider options are bridged through request.settings → SessionContext.options.
      // Keep request.body available for OpenCode-owned host configuration only.
      body: {},
    },
    permissions,
  }
}

export function buildV2AgentConfigs(input: {
  config: OhMyOpenCodeConfig
  catalog: V2ModelCatalogSnapshot
  loadedSkills: readonly LoadedSkill[]
  directory: string
}): Record<string, AgentConfig> {
  return catalogPrompts(input)
}

export async function registerV2Agents(
  ctx: Plugin.Context,
  config: OhMyOpenCodeConfig,
  loadedSkills: readonly LoadedSkill[],
  catalog: V2ModelCatalog,
): Promise<() => Promise<void>> {
  let defaultDiagnosticLogged = false
  const reportedPermissionConflicts = new Set<string>()
  const customAgents = loadV2CustomAgentConfigs(config, String(ctx.location.directory))
  const registration = await ctx.agent.transform((editor) => {
    const configs = {
      ...buildV2AgentConfigs({
      config,
      catalog: catalog.snapshot,
      loadedSkills,
      directory: String(ctx.location.directory),
      }),
      ...customAgents,
    }
    const requestedDefault = config.default_run_agent?.trim()
    if (requestedDefault) {
      const configuredAgent = configs[requestedDefault]
      const existingAgent = editor.get(requestedDefault)
      const mode = configuredAgent?.mode ?? existingAgent?.mode
      const enabledPrimary = (configuredAgent !== undefined || existingAgent !== undefined) &&
        (mode === "primary" || mode === "all") && !isDisabled(config, requestedDefault)
      if (enabledPrimary) {
        editor.default(requestedDefault)
      } else if (!defaultDiagnosticLogged) {
        defaultDiagnosticLogged = true
        log(`[v2 agent] default_run_agent "${requestedDefault}" is not an enabled primary native agent; preserving OpenCode's configured default.`)
      }
    }
    for (const name of BUILTIN_AGENT_NAMES) {
      if (isDisabled(config, name)) {
        editor.remove(name)
      }
    }
    for (const [name, agentConfig] of Object.entries(configs)) {
      const next = toNativeAgentConfig(name, agentConfig, (conflict) => {
        const key = `${conflict.agent}\u0000${conflict.action}\u0000${conflict.resource}`
        if (reportedPermissionConflicts.has(key)) return
        reportedPermissionConflicts.add(key)
        log(`[v2 agent] Conflicting permission aliases for ${conflict.agent} ${conflict.action} ${conflict.resource} were reduced to the stricter "${conflict.selected}" effect.`)
      })
      editor.update(name, (agent) => {
        const added = next.permissions ?? []
        agent.id = next.id as NativeAgentInfo["id"]
        agent.name = next.name as NativeAgentInfo["name"]
        if (next.model !== undefined) agent.model = next.model as NativeAgentInfo["model"]
        agent.system = next.system
        agent.description = next.description
        agent.mode = next.mode ?? "subagent"
        agent.hidden = false
        agent.color = next.color
        agent.steps = next.steps
        const request = next.request ?? { settings: {}, headers: {}, body: {} }
        agent.request.settings = { ...agent.request.settings, ...request.settings }
        Object.assign(agent.request.headers, request.headers)
        Object.assign(agent.request.body, request.body)
        agent.permissions.push(...added)
      })
    }
  })
  return async () => registration.dispose()
}
