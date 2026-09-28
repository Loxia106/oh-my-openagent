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
import { resolvePromptAppend } from "../agents/builtin-agents/resolve-file-uri"
import { applyEnvironmentContext } from "../agents/builtin-agents/environment-context"
import { collectDisabledSkillAliases } from "../plugin/skill-context"
import { isDisabledSkillAlias } from "../features/opencode-skill-loader"
import { injectGitMasterConfig } from "../features/opencode-skill-loader/skill-content"
import { matchSkillByName } from "@oh-my-opencode/skills-loader-core/skill/skill-matcher"
import { isTaskSystemEnabled } from "../shared"
import { mergeCategories } from "../shared/merge-categories"
import { CATEGORY_DESCRIPTIONS } from "../tools/delegate-task/constants"
import { log } from "../shared/logger"
import { isProviderDisabled } from "../shared/disabled-providers"
import { resolveV2AgentModel, toV2ModelRef, type V2ConfiguredModel, type V2ModelCatalog, type V2ModelCatalogSnapshot } from "./model-resolution"
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

/** Whether a builtin OMO agent is enabled by its native config gates. */
export function isV2BuiltinAgentEnabled(config: OhMyOpenCodeConfig, name: string): boolean {
	return (BUILTIN_AGENT_NAMES as readonly string[]).includes(name) && !isDisabled(config, name) &&
		!(name === "prometheus" && config.sisyphus_agent?.planner_enabled === false)
}

function createBaseAgent(input: {
  name: (typeof BUILTIN_AGENT_NAMES)[number]
  model: string
  agents: AvailableAgent[]
  skills: AvailableSkill[]
  categories: AvailableCategory[]
  userCategories: OhMyOpenCodeConfig["categories"]
  useTaskSystem: boolean
  disabledTools?: readonly string[]
}): AgentConfig {
  const { name, model, agents, skills, categories, userCategories, useTaskSystem, disabledTools } = input
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
        prompt: getPrometheusPrompt(model, disabledTools),
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

/** V1's Prometheus builder treats both prompt fields as additions to its base. */
function applyPrometheusOverrides(
  base: AgentConfig,
  override: AgentOverrideConfig | undefined,
  mergedCategories: Parameters<typeof applyOverrides>[2],
  directory: string,
): AgentConfig {
  if (!override) return base
  const { prompt, prompt_append, ...agentFields } = override
  let result = applyOverrides(base, agentFields, mergedCategories, directory)
  if (typeof result.prompt !== "string") return result
  for (const addition of [prompt, prompt_append]) {
    if (addition) result = { ...result, prompt: `${result.prompt}\n${resolvePromptAppend(addition, directory)}` }
  }
  return result
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
  agentRestrictedSkillIDs: readonly string[] = [],
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

  // OpenCode skill availability and the native skill executor both evaluate
  // the ordered `skill` permission rules. Append these denials after authored
  // permissions and tool aliases so a broad `skill: allow` cannot expose a
  // skill whose definition is restricted to another agent.
  for (const skillID of new Set(agentRestrictedSkillIDs)) {
    rules.push({ action: "skill", resource: skillID, effect: "deny" })
  }

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

function modelEntry(value: unknown): V2ConfiguredModel | undefined {
  if (typeof value === "string") return value
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const entry = value as Record<string, unknown>
  if (typeof entry.model !== "string") return undefined
  return {
    model: entry.model,
    ...(typeof entry.variant === "string" ? { variant: entry.variant } : {}),
  }
}

function modelEntries(value: unknown): V2ConfiguredModel[] {
  if (typeof value === "string") return [value]
  if (!Array.isArray(value)) return []
  return value.map(modelEntry).filter((entry): entry is V2ConfiguredModel => entry !== undefined)
}

function agentModelChain(override: AgentOverrideConfig | undefined): {
  primary?: V2ConfiguredModel
  fallbacks: V2ConfiguredModel[]
} {
  const raw = (override ?? {}) as Record<string, unknown>
  const models = modelEntries(raw.models)
  if (models.length > 0) return { primary: models[0], fallbacks: models.slice(1) }
  return {
    primary: modelEntry(raw.model),
    fallbacks: modelEntries(raw.fallback_models),
  }
}

function categoryModelChain(value: unknown): {
  primary?: V2ConfiguredModel
  fallbacks: V2ConfiguredModel[]
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { fallbacks: [] }
  const category = value as Record<string, unknown>
  const models = modelEntries(category.models)
  if (models.length > 0) return { primary: models[0], fallbacks: models.slice(1) }
  const model = modelEntry(category.model)
  const fallbacks = modelEntries(category.fallback_models)
  if (model) return { primary: model, fallbacks }
  return { primary: fallbacks[0], fallbacks: fallbacks.slice(1) }
}

function customAgentConfigsWithModelPolicy(
  customAgents: Record<string, AgentConfig>,
  config: OhMyOpenCodeConfig,
  catalog: V2ModelCatalogSnapshot,
  onBlocked: (name: string, diagnostic: string) => void,
): Record<string, AgentConfig> {
  const mergedCategories = mergeCategories(config.categories)
  const result: Record<string, AgentConfig> = {}
  for (const [name, customConfig] of Object.entries(customAgents)) {
    const override = getOverride(config, name)
    const direct = agentModelChain(override)
    const category = override?.category ? categoryModelChain(mergedCategories[override.category]) : { fallbacks: [] as V2ConfiguredModel[] }
    const useCategory = !direct.primary && Boolean(override?.category && category.primary)
    const rawCustomConfig = customConfig as AgentConfig & Record<string, unknown>
    const model = direct.primary ?? (useCategory ? undefined : modelEntry(rawCustomConfig.model))
    const fallbacks = direct.primary
      ? direct.fallbacks
      : useCategory
        ? []
        : modelEntries(rawCustomConfig.fallback_models)
    const resolution = resolveV2AgentModel({
      agent: name,
      configuredModel: model,
      configuredFallbacks: fallbacks,
      categoryModel: useCategory ? category.primary : undefined,
      categoryFallbacks: useCategory ? category.fallbacks : [],
      primary: customConfig.mode === "primary" || customConfig.mode === "all",
      disabledProviders: config.disabled_providers,
      snapshot: catalog,
    })
    if (resolution.diagnostic) log(`[v2 agent] ${resolution.diagnostic}`)
    if (resolution.blocked) {
      onBlocked(name, resolution.diagnostic ?? `Agent "${name}" has no allowed model.`)
      continue
    }
    const next = { ...customConfig }
    if (resolution.model) next.model = resolution.model
    if (resolution.variant) next.variant = resolution.variant
    result[name] = next
  }
  return result
}

/**
 * Agent prompts are also used by the legacy skill picker, so keep its shared
 * behavior unchanged and apply native OpenCode's invocation policy here.
 * Provenance matters: custom plugin/user skills may intentionally share a
 * name with a builtin that this runtime cannot support.
 */
function nativePromptSkills(
  available: AvailableSkill[],
  loadedSkills: readonly LoadedSkill[],
  teamModeEnabled: boolean | undefined,
  agentName: string,
): AvailableSkill[] {
  const winners = new Map(loadedSkills.map((skill) => [skill.name.toLowerCase(), skill]))
  return available.filter((skill) => {
    const name = skill.name.toLowerCase()
    const winner = winners.get(name)
    if (winner && disablesModelInvocation(winner)) return false
    if (winner?.definition.agent && winner.definition.agent !== agentName) return false
    if (!V2_UNSUPPORTED_TEAM_PROMPT_SKILLS.has(name)) return true
    if (teamModeEnabled === true) return true
    return winner !== undefined && winner.scope !== "builtin"
  })
}

type AgentConfigWithExplicitSkills = AgentConfig & { skills?: string[] }

/**
 * Resolve explicitly configured agent skills from the same merged catalog that
 * is registered with native OpenCode. The legacy synchronous resolver reads
 * only builtin definitions, which loses project overrides and V2-adapted
 * builtin content. Explicit selection remains valid for manual-only skills;
 * disabled aliases and agent-scoped definitions still apply.
 */
function resolveV2AgentSkills(
  config: AgentConfig,
  agentName: string,
  loadedSkills: readonly LoadedSkill[],
  options: { disabledSkills: Set<string>; gitMasterConfig: OhMyOpenCodeConfig["git_master"] },
): AgentConfig {
  const { skills, ...configWithoutSkills } = config as AgentConfigWithExplicitSkills
  if (!skills?.length) return configWithoutSkills

  const catalog = [...loadedSkills]
  const resolved = new Map<string, string>()
  for (const requestedName of skills) {
    const skill = matchSkillByName(catalog, requestedName)
    if (!skill || isDisabledSkillAlias(skill, options.disabledSkills)) continue
    if (skill.definition.agent && skill.definition.agent !== agentName) continue
    let template = skill.definition.template ?? skill.lazyContent?.content ?? ""
    if (!template) continue
    if (skill.name === "git-master") template = injectGitMasterConfig(template, options.gitMasterConfig)
    resolved.set(requestedName, template)
  }

  if (resolved.size === 0) return configWithoutSkills
  const skillContent = Array.from(resolved.values()).join("\n\n")
  return {
    ...configWithoutSkills,
    prompt: skillContent + (configWithoutSkills.prompt ? "\n\n" + configWithoutSkills.prompt : ""),
  }
}

function catalogPrompts(input: {
  config: OhMyOpenCodeConfig
  catalog: V2ModelCatalogSnapshot
  loadedSkills: readonly LoadedSkill[]
  directory: string
  onBlocked?: (name: string, diagnostic: string) => void
}): Record<string, AgentConfig> {
  const { config, catalog, loadedSkills, directory, onBlocked } = input
  const mergedCategories = mergeCategories(config.categories)
  const availableCategories: AvailableCategory[] = Object.entries(mergedCategories).map(([name, category]) => ({
    name,
    description: category.description ?? CATEGORY_DESCRIPTIONS[name] ?? "General tasks",
  }))
  const disabledSkills = collectDisabledSkillAliases(config)
  const modelInvocableSkills = loadedSkills.filter((skill) => !disablesModelInvocation(skill))
  const availableSkillsByAgent = new Map<string, AvailableSkill[]>()
  const availableSkillsFor = (agentName: string) => {
    const cached = availableSkillsByAgent.get(agentName)
    if (cached) return cached
    const available = nativePromptSkills(buildAvailableSkills(
      [...modelInvocableSkills],
      config.browser_automation_engine?.provider,
      disabledSkills,
      config.team_mode?.enabled,
      agentName,
    ), loadedSkills, config.team_mode?.enabled, agentName)
    availableSkillsByAgent.set(agentName, available)
    return available
  }
  const resolutions = new Map<string, ReturnType<typeof resolveV2AgentModel>>()
  const promptModels = new Map<string, string>()
  for (const name of BUILTIN_AGENT_NAMES) {
    if (!isV2BuiltinAgentEnabled(config, name)) continue
    const override = getOverride(config, name)
    const configured = agentModelChain(override)
    const category = override?.category ? categoryModelChain(mergedCategories[override.category]) : { fallbacks: [] as V2ConfiguredModel[] }
    const resolution = resolveV2AgentModel({
      agent: name,
      configuredModel: configured.primary,
      configuredFallbacks: configured.fallbacks,
      categoryModel: configured.primary ? undefined : category.primary,
      categoryFallbacks: configured.primary ? [] : category.fallbacks,
      primary: PRIMARY_AGENTS.has(name),
      disabledProviders: config.disabled_providers,
      snapshot: catalog,
    })
    resolutions.set(name, resolution)
    if (resolution.diagnostic) log(`[v2 agent] ${resolution.diagnostic}`)
    if (resolution.blocked) onBlocked?.(name, resolution.diagnostic ?? `Agent "${name}" has no allowed model.`)
    promptModels.set(name, resolution.model ?? promptFallbackModel(name) ?? "anthropic/claude-opus-5-5")
  }

  const preliminary = new Map<string, AgentConfig>()
  for (const name of BUILTIN_AGENT_NAMES) {
    if (!isV2BuiltinAgentEnabled(config, name)) continue
    if (resolutions.get(name)?.blocked) continue
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
        skills: availableSkillsFor(name),
        categories: availableCategories,
        userCategories: config.categories,
        useTaskSystem: isTaskSystemEnabled(config),
        disabledTools: config.disabled_tools,
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
        skills: availableSkillsFor(name),
        categories: availableCategories,
        userCategories: config.categories,
        useTaskSystem: isTaskSystemEnabled(config),
        disabledTools: config.disabled_tools,
      })
    }
    let built = name === "prometheus"
      ? applyPrometheusOverrides(base, override, mergedCategories, directory)
      : applyOverrides(base, override, mergedCategories, directory)
    if (name === "librarian") built = applyEnvironmentContext(built, directory, { disableOmoEnv: false })
    built = resolveV2AgentSkills(built, name, loadedSkills, { disabledSkills, gitMasterConfig: config.git_master })
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
    if (!isV2BuiltinAgentEnabled(config, name)) continue
    const resolution = resolutions.get(name)
    if (resolution?.blocked) continue
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
        skills: availableSkillsFor(name),
        categories: availableCategories,
        userCategories: config.categories,
        useTaskSystem: isTaskSystemEnabled(config),
        disabledTools: config.disabled_tools,
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
        skills: availableSkillsFor(name),
        categories: availableCategories,
        userCategories: config.categories,
        useTaskSystem: isTaskSystemEnabled(config),
        disabledTools: config.disabled_tools,
      })
    }
    let built = name === "prometheus"
      ? applyPrometheusOverrides(base, override, mergedCategories, directory)
      : applyOverrides(base, override, mergedCategories, directory)
    if (name === "librarian") {
      built = applyEnvironmentContext(built, directory, {
        disableOmoEnv: config.experimental?.disable_omo_env ?? false,
      })
    }
    built = resolveV2AgentSkills(built, name, loadedSkills, { disabledSkills, gitMasterConfig: config.git_master })

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
  agentRestrictedSkillIDs: readonly string[] = [],
): Partial<NativeAgentInfo> {
  const source = config as AgentConfig & Record<string, unknown>
  const model = toV2ModelRef(typeof source.model === "string" ? source.model : undefined, typeof source.variant === "string" ? source.variant : undefined)
  const settings = nativeSettings(config)
  const permissions = toV2PermissionRules(config, name, onPermissionConflict, agentRestrictedSkillIDs)
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

export type BuildV2AgentConfigsInput = {
  config: OhMyOpenCodeConfig
  catalog: V2ModelCatalogSnapshot
  loadedSkills: readonly LoadedSkill[]
  directory: string
  onBlocked?: (name: string, diagnostic: string) => void
}

export type V2BuiltinAgentPromptRenderer = (agentName: string, model: string) => string | undefined

export function buildV2AgentConfigs(input: BuildV2AgentConfigsInput): Record<string, AgentConfig> {
  return catalogPrompts(input)
}

/**
 * Render a native request-time prompt for one registered OMO builtin using the
 * same factory, override, category, skill, and environment pipeline as the
 * registration-time config. The returned AgentConfig is used only for its
 * prompt; its model and permissions are not installed into the host registry.
 */
export function createV2BuiltinAgentPromptRenderer(input: BuildV2AgentConfigsInput): V2BuiltinAgentPromptRenderer {
  const { config, loadedSkills, directory } = input
  const registeredConfigs = catalogPrompts(input)
  const mergedCategories = mergeCategories(config.categories)
  const availableCategories: AvailableCategory[] = Object.entries(mergedCategories).map(([name, category]) => ({
    name,
    description: category.description ?? CATEGORY_DESCRIPTIONS[name] ?? "General tasks",
  }))
  const disabledSkills = collectDisabledSkillAliases(config)
  const modelInvocableSkills = loadedSkills.filter((skill) => !disablesModelInvocation(skill))
  const availableSkillsByAgent = new Map<string, AvailableSkill[]>()
  const availableSkillsFor = (agentName: string) => {
    const cached = availableSkillsByAgent.get(agentName)
    if (cached) return cached
    const available = nativePromptSkills(buildAvailableSkills(
      [...modelInvocableSkills],
      config.browser_automation_engine?.provider,
      disabledSkills,
      config.team_mode?.enabled,
      agentName,
    ), loadedSkills, config.team_mode?.enabled, agentName)
    availableSkillsByAgent.set(agentName, available)
    return available
  }
  const visibleAgents: AvailableAgent[] = []
  for (const [name, metadata] of Object.entries(PROMPT_METADATA)) {
    const registered = registeredConfigs[name]
    if (!registered || !metadata) continue
    visibleAgents.push({ name, description: registered.description ?? "", metadata })
  }

  return (agentName, model) => {
    if (!(BUILTIN_AGENT_NAMES as readonly string[]).includes(agentName)) return undefined
    const name = agentName as (typeof BUILTIN_AGENT_NAMES)[number]
    if (!registeredConfigs[name] || isDisabled(config, name)) return undefined
    if (name === "hephaestus" && !isHephaestusSupportedModel(model)) {
      return undefined
    }

    let base: AgentConfig
    try {
      base = createBaseAgent({
        name,
        model,
        agents: visibleAgents,
        skills: availableSkillsFor(name),
        categories: availableCategories,
        userCategories: config.categories,
        useTaskSystem: isTaskSystemEnabled(config),
        disabledTools: config.disabled_tools,
      })
    } catch (error) {
      log(`[v2 agent] Could not render ${name} prompt for runtime model ${model}; retaining its registered prompt.`, error)
      return undefined
    }
    const override = getOverride(config, name)
    let rendered = name === "prometheus"
      ? applyPrometheusOverrides(base, override, mergedCategories, directory)
      : applyOverrides(base, override, mergedCategories, directory)
    if (name === "librarian") {
      rendered = applyEnvironmentContext(rendered, directory, {
        disableOmoEnv: config.experimental?.disable_omo_env ?? false,
      })
    }
    rendered = resolveV2AgentSkills(rendered, name, loadedSkills, { disabledSkills, gitMasterConfig: config.git_master })
    return typeof rendered.prompt === "string" ? rendered.prompt : undefined
  }
}

export async function registerV2Agents(
  ctx: Plugin.Context,
  config: OhMyOpenCodeConfig,
  loadedSkills: readonly LoadedSkill[],
  catalog: V2ModelCatalog,
): Promise<() => Promise<void>> {
  let defaultDiagnosticLogged = false
  const reportedPermissionConflicts = new Set<string>()
  const ownedAgentIDs = new Set<string>()
  const blockedModels = new Map<string, string>()
  const disabledProviders = config.disabled_providers ?? []
  let active = true
  let disposeModelGuard: (() => Promise<void>) | undefined
  let disposeAgents: (() => Promise<void>) | undefined
  const customAgents = loadV2CustomAgentConfigs(config, String(ctx.location.directory))
  try {
    if (disabledProviders.length > 0) {
      const modelGuard = await ctx.session.hook("model.request", (input) => {
        if (!active) return
        const agent = String(input.agent)
        if (!ownedAgentIDs.has(agent)) return
        const configuredBlock = blockedModels.get(agent)
        if (configuredBlock) throw new Error(configuredBlock)
        const providerID = String(input.model.providerID)
        if (isProviderDisabled(`${providerID}/${String(input.model.id)}`, disabledProviders)) {
          throw new Error(`OMO agent "${agent}" model request is blocked because provider "${providerID}" is listed in disabled_providers.`)
        }
      })
      disposeModelGuard = () => modelGuard.dispose()
    }

    const registration = await ctx.agent.transform((editor) => {
      const blocked = new Map<string, string>()
      const markBlocked = (name: string, diagnostic: string) => blocked.set(name, diagnostic)
      const builtInConfigs = buildV2AgentConfigs({
        config,
        catalog: catalog.snapshot,
        loadedSkills,
        directory: String(ctx.location.directory),
        onBlocked: markBlocked,
      })
      const resolvedCustomAgents = customAgentConfigsWithModelPolicy(customAgents, config, catalog.snapshot, markBlocked)
      const configs = { ...builtInConfigs, ...resolvedCustomAgents }
      ownedAgentIDs.clear()
      blockedModels.clear()
      for (const name of Object.keys(configs)) ownedAgentIDs.add(name)
      for (const [name, diagnostic] of blocked) {
        ownedAgentIDs.add(name)
        blockedModels.set(name, diagnostic)
        editor.remove(name)
      }

      const requestedDefault = config.default_run_agent?.trim()
      if (requestedDefault) {
        const configuredAgent = configs[requestedDefault]
        const existingAgent = editor.get(requestedDefault)
        const mode = configuredAgent?.mode ?? existingAgent?.mode
      const configuredBuiltin = (BUILTIN_AGENT_NAMES as readonly string[]).includes(requestedDefault)
      const enabledPrimary = !blocked.has(requestedDefault) && (configuredAgent !== undefined || existingAgent !== undefined) &&
          (mode === "primary" || mode === "all") &&
          (configuredBuiltin ? isV2BuiltinAgentEnabled(config, requestedDefault) : !isDisabled(config, requestedDefault))
        if (enabledPrimary) {
          editor.default(requestedDefault)
        } else if (!defaultDiagnosticLogged) {
          defaultDiagnosticLogged = true
          const diagnostic = blocked.get(requestedDefault)
          log(diagnostic
            ? `[v2 agent] default_run_agent "${requestedDefault}" is unavailable: ${diagnostic}`
            : `[v2 agent] default_run_agent "${requestedDefault}" is not an enabled primary native agent; preserving OpenCode's configured default.`)
        }
      }
      for (const name of BUILTIN_AGENT_NAMES) {
        if (!isV2BuiltinAgentEnabled(config, name)) editor.remove(name)
      }
      for (const [name, agentConfig] of Object.entries(configs)) {
        const restrictedSkillIDs = loadedSkills
          .filter((skill) => skill.definition.agent && skill.definition.agent !== name)
          .map((skill) => skill.name)
        const next = toNativeAgentConfig(name, agentConfig, (conflict) => {
          const key = `${conflict.agent}\u0000${conflict.action}\u0000${conflict.resource}`
          if (reportedPermissionConflicts.has(key)) return
          reportedPermissionConflicts.add(key)
          log(`[v2 agent] Conflicting permission aliases for ${conflict.agent} ${conflict.action} ${conflict.resource} were reduced to the stricter "${conflict.selected}" effect.`)
        }, restrictedSkillIDs)
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
    disposeAgents = () => registration.dispose()
  } catch (error) {
    active = false
    const cleanupErrors: unknown[] = []
    for (const cleanup of [disposeAgents, disposeModelGuard]) {
      try {
        await cleanup?.()
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError)
      }
    }
    if (cleanupErrors.length > 0) throw new AggregateError([error, ...cleanupErrors], "V2 agent registration failed and cleanup was incomplete")
    throw error
  }

  let disposed = false
  return async () => {
    if (disposed) return
    disposed = true
    active = false
    const errors: unknown[] = []
    for (const cleanup of [disposeAgents, disposeModelGuard]) {
      try {
        await cleanup?.()
      } catch (error) {
        errors.push(error)
      }
    }
    if (errors.length > 0) throw new AggregateError(errors, "V2 agent registrations failed to clean up")
  }
}
