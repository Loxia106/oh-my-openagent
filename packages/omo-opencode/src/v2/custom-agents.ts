import type { AgentConfig } from "@opencode-ai/sdk"
import type { OhMyOpenCodeConfig } from "../config"
import { loadAgentDefinitions, loadProjectAgents, loadUserAgents } from "../features/claude-code-agent-loader"
import { applyOverrides } from "../agents/builtin-agents/agent-overrides"
import { resolveAgentSkills } from "../agents/agent-skill-resolution"
import { collectDisabledSkillAliases } from "../plugin/skill-context"
import { mergeCategories } from "../shared/merge-categories"
import { resolveAgentDefinitionPaths } from "../shared/resolve-agent-definition-paths"
import { migrateAgentConfig } from "../shared/permission-compat"
import { log } from "../shared/logger"

const BUILTIN_NAMES = new Set([
  "sisyphus", "hephaestus", "prometheus", "atlas", "sisyphus-junior",
  "explore", "librarian", "oracle", "multimodal-looker", "metis", "momus",
])

function isDisabled(config: OhMyOpenCodeConfig, name: string, override?: Record<string, unknown>): boolean {
  return (config.disabled_agents ?? []).some((entry) => entry.trim().toLowerCase() === name.toLowerCase()) ||
    override?.disable === true
}

function customOverride(config: OhMyOpenCodeConfig, name: string): Record<string, unknown> | undefined {
  const agents = config.agents as Record<string, Record<string, unknown> | undefined> | undefined
  return agents?.[name] ?? Object.entries(agents ?? {}).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1]
}

function matchedAgentName(record: Record<string, unknown>, name: string): string | undefined {
  return Object.keys(record).find((key) => key.toLowerCase() === name.toLowerCase())
}

function hasPrompt(config: Record<string, unknown> | undefined): boolean {
  return typeof config?.prompt === "string" && config.prompt.trim().length > 0
}

/** Load file-backed OMO/Claude agents and merge named OMO config overrides. */
export function loadV2CustomAgentConfigs(
  config: OhMyOpenCodeConfig,
  directory: string,
): Record<string, AgentConfig> {
  const sources: Record<string, Record<string, unknown>> = Object.create(null)
  const anthropicProvider = config.claude_code?.anthropic_provider
  if (config.claude_code?.agents !== false) {
    Object.assign(sources, loadUserAgents(anthropicProvider))
    Object.assign(sources, loadProjectAgents(directory, anthropicProvider))
  }
  if (config.agent_definitions?.length) {
    const paths = resolveAgentDefinitionPaths(config.agent_definitions, directory, null)
    Object.assign(sources, loadAgentDefinitions(paths, "definition-file", anthropicProvider))
  }

  const result: Record<string, AgentConfig> = Object.create(null)
  const mergedCategories = mergeCategories(config.categories)
  const disabledSkills = collectDisabledSkillAliases(config)
  const configAgents = config.agents as Record<string, Record<string, unknown> | undefined> | undefined

  const candidateNames = new Map<string, string>()
  for (const name of Object.keys(sources)) candidateNames.set(name.toLowerCase(), name)
  for (const name of Object.keys(configAgents ?? {})) {
    if (!candidateNames.has(name.toLowerCase())) candidateNames.set(name.toLowerCase(), name)
  }

  for (const name of candidateNames.values()) {
    if (BUILTIN_NAMES.has(name.toLowerCase())) continue
    const sourceName = matchedAgentName(sources, name)
    const source = sourceName ? sources[sourceName] : undefined
    const override = customOverride(config, name)
    if (isDisabled(config, name, override)) continue

    if (!source && !hasPrompt(override)) {
      // A field-only override may target an OpenCode-owned agent already in
      // the native registry. registerV2Agents handles that case there; do not
      // create an empty new agent from an incomplete OMO override.
      continue
    }

    let built = migrateAgentConfig({ ...(source ?? {}) }) as AgentConfig
    if (!built.mode) built.mode = "subagent"
    if (override) {
      built = applyOverrides(built, override as never, mergedCategories, directory)
    }
    built = resolveAgentSkills(built, {
      gitMasterConfig: config.git_master,
      browserProvider: config.browser_automation_engine?.provider,
      disabledSkills,
      teamModeEnabled: config.team_mode?.enabled,
    })
    result[sourceName ?? name] = built
  }

  const loaded = new Set(Object.keys(result).map((name) => name.toLowerCase()))
  for (const [name, override] of Object.entries(configAgents ?? {})) {
    if (BUILTIN_NAMES.has(name.toLowerCase()) || loaded.has(name.toLowerCase()) || isDisabled(config, name, override)) continue
    if (override && !hasPrompt(override)) {
      log(`[v2 agent] Custom agent override "${name}" has no loaded definition or prompt; preserving any native OpenCode agent with that ID.`)
    }
  }

  return result
}
