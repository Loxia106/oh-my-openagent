import type { Plugin } from "@opencode/plugin"
import { Error as ToolError, type Info, type ToolContext, type ToolEditor } from "@opencode/plugin/promise/tool"
import { z } from "zod"
import type { OhMyOpenCodeConfig } from "../config"
import { DEFAULT_CATEGORIES, CATEGORY_PROMPT_APPENDS, CATEGORY_PROMPT_APPEND_RESOLVERS } from "../tools/delegate-task/builtin-categories"
import { buildTaskPrompt } from "../tools/delegate-task/prompt-builder"
import { isProviderDisabled } from "../shared/disabled-providers"
import { stripInvisibleAgentCharacters } from "../shared/agent-display-names"
import { resolvePromptAppend } from "../agents/builtin-agents/resolve-file-uri"
import { log } from "../shared/logger"
import { buildTaskMetadataBlock } from "../features/tool-metadata-store/task-metadata-contract"
import { createHash } from "node:crypto"
import { addV2Tool } from "./tool-adapter"
import { addV2LookAtTool } from "./tool-look-at"
import { readOwnedChildSession, type V2SessionStatus } from "./session-history"
import type { V2SubagentRunState } from "./task-state"
import { createV2DelegationAdmission, resolveV2DelegationModelChoice } from "./delegation-admission"
import type { V2BackgroundAdmission, VerifiedLogicalParentResolver } from "./background-admission"
import type { DelegationModelChoice } from "./delegation-model-selection"
import { isV2UnstableChild } from "./unstable-agent-babysitter"

type NativeSubagent = Info & { readonly id: string }
type ToolConfig = Readonly<Record<string, boolean>>
type PermissionRule = { action: string; resource: string; effect: "allow" | "ask" | "deny" }
type DelegationAlias = "task" | "call_omo_agent"
type AliasInvocations = Map<string, DelegationAlias>
type SessionWithPermissions = Awaited<ReturnType<Plugin.Context["session"]["get"]>>
type TerminalStatus = "completed" | "failed" | "interrupted"

function terminalOutcome(outcome: string | undefined): TerminalStatus | undefined {
  if (outcome === "succeeded") return "completed"
  if (outcome === "failed") return "failed"
  if (outcome === "interrupted") return "interrupted"
  return undefined
}

const taskInput = z.object({
  load_skills: z.array(z.string()).optional(),
  description: z.string().optional(),
  prompt: z.string(),
  run_in_background: z.boolean().optional(),
  category: z.string().optional(),
  subagent_type: z.string().optional(),
  task_id: z.string().optional(),
  command: z.string().optional(),
})

const callAgentInput = z.object({
  description: z.string(),
  prompt: z.string(),
  subagent_type: z.string(),
  run_in_background: z.boolean(),
  session_id: z.string().optional(),
})

const skillAliasInput = z.object({ id: z.string().optional(), name: z.string().optional() })

const backgroundOutputInput = z.object({
  task_id: z.string(),
  block: z.boolean().optional(),
  timeout: z.number().positive().optional(),
  full_session: z.boolean().optional(),
  include_thinking: z.boolean().optional(),
  include_tool_results: z.boolean().optional(),
  message_limit: z.number().int().positive().optional(),
  since_message_id: z.string().optional(),
  from_end: z.boolean().optional(),
  thinking_max_chars: z.number().int().nonnegative().optional(),
})

const backgroundCancelInput = z.object({
  taskId: z.string().optional(),
  all: z.boolean().optional(),
})

/** Legacy supervised-task budget (`background_task.syncPollTimeoutMs`, default 30 minutes). */
const DEFAULT_SUPERVISED_TIMEOUT_MS = 30 * 60 * 1000

/** Stable legacy-style `bg_` handle for a child session; prompts use it with background_output/background_cancel. */
export function v2BackgroundTaskID(sessionID: string): string {
  return `bg_${createHash("sha256").update(sessionID).digest("hex").slice(0, 8)}`
}

/** Accept either a `bg_` handle or a child sessionID; `bg_` handles resolve only among this parent's children. */
export async function resolveV2TaskReference(runs: V2SubagentRunState, parentSessionID: string, reference: string): Promise<string> {
  const value = reference.trim()
  if (!value.startsWith("bg_")) return value
  const candidates = [...new Set([...await runs.children(parentSessionID), ...await runs.observed(parentSessionID)])]
  const matches = candidates.filter((sessionID) => v2BackgroundTaskID(sessionID) === value)
  if (matches.length === 1) return matches[0]!
  throw new ToolError({ message: matches.length > 1
    ? `Background task ID ${value} is ambiguous; pass the child sessionID instead.`
    : `Unknown background task ID ${value}. Use a bg_ ID or sessionID from a task launched by this session.` })
}

type NativeTaskResult = Awaited<ReturnType<NativeSubagent["execute"]>>

function resultMetadata(result: NativeTaskResult): Record<string, unknown> {
  return typeof result.metadata === "object" && result.metadata !== null ? result.metadata as Record<string, unknown> : {}
}

function appendResultText(content: NativeTaskResult["content"], text: string): NativeTaskResult["content"] {
  if (typeof content === "string") return `${content}${content.trim() ? "\n\n" : ""}${text}`
  return [...(content ?? []), { type: "text" as const, text }]
}

function resultOutputText(result: NativeTaskResult): string {
  const output = result.output as { output?: unknown } | undefined
  if (typeof output?.output === "string") return output.output
  return typeof result.content === "string" ? result.content : ""
}

function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000)
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

function isDisabled(values: readonly string[] | undefined, name: string): boolean {
  return values?.some((value) => stripInvisibleAgentCharacters(value).trim().toLowerCase() === name.toLowerCase()) ?? false
}

export function resolveAgentId(requested: string, available: readonly { id: string; mode: string }[], config: OhMyOpenCodeConfig): string {
  const candidate = stripInvisibleAgentCharacters(requested).trim()
  if (!candidate) throw new ToolError({ message: "An agent name is required." })
  if (isDisabled(config.disabled_agents, candidate)) {
    throw new ToolError({ message: `Agent "${candidate}" is disabled by disabled_agents.` })
  }
  const agent = available.find((item) => item.id.toLowerCase() === candidate.toLowerCase())
  if (!agent) throw new ToolError({ message: `Unknown agent "${candidate}". Available subagents: ${available.filter((item) => item.mode !== "primary").map((item) => item.id).join(", ") || "none"}.` })
  if (agent.mode === "primary") throw new ToolError({ message: `Agent "${agent.id}" cannot run as a subagent.` })
  const override = config.agents?.[agent.id as keyof typeof config.agents]
  if (override?.disable) throw new ToolError({ message: `Agent "${agent.id}" is disabled by its agent configuration.` })
  return agent.id
}

function modelChoiceText(choice: DelegationModelChoice | undefined): string | undefined {
  if (!choice) return undefined
  const model = choice.model
  return `${model.providerID}/${model.id}${model.variant ? `#${model.variant}` : ""}`
}

export function toolRestrictionsToActions(tools: ToolConfig | undefined): string[] {
  if (!tools) return []
  const aliases: Record<string, string> = {
    bash: "shell",
    shell: "shell",
    interactive_bash: "shell",
    apply_patch: "edit",
    patch: "edit",
    write: "edit",
    edit: "edit",
    hashline_edit: "edit",
    task: "task",
    delegate_task: "task",
    call_omo_agent: "call_omo_agent",
  }
  return [...new Set(Object.entries(tools)
    .filter(([, enabled]) => enabled === false)
    .map(([name]) => aliases[name.toLowerCase()] ?? name.toLowerCase()))]
}

function wildcardMatches(value: string, pattern: string): boolean {
  // Keep this aligned with OpenCode's Wildcard.match implementation.
  const normalized = value.replaceAll("\\", "/")
  let escaped = pattern.replaceAll("\\", "/").replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")
  if (escaped.endsWith(" .*")) escaped = escaped.slice(0, -3) + "( .*)?"
  return new RegExp(`^${escaped}$`, process.platform === "win32" ? "si" : "s").test(normalized)
}

function aliasPermissionEffect(
  action: DelegationAlias,
  resources: readonly string[],
  rules: readonly PermissionRule[],
): PermissionRule["effect"] | undefined {
  const effects = resources.flatMap((resource) => {
    const matched = rules.findLast((rule) => wildcardMatches(action, rule.action) && wildcardMatches(resource, rule.resource))
    return matched ? [matched.effect] : []
  })
  if (effects.length === 0) return undefined
  if (effects.includes("deny")) return "deny"
  if (effects.includes("ask")) return "ask"
  return "allow"
}

function invocationKey(context: { sessionID: string; messageID: string; id: string }): string {
  return JSON.stringify([context.sessionID, context.messageID, String(context.id)])
}

async function withDelegationAlias<T>(
  invocations: AliasInvocations,
  action: DelegationAlias,
  context: ToolContext,
  execute: () => Promise<T>,
): Promise<T> {
  const id = invocationKey(context)
  const previous = invocations.get(id)
  invocations.set(id, action)
  try {
    return await execute()
  } finally {
    if (previous === undefined) invocations.delete(id)
    else invocations.set(id, previous)
  }
}

function evaluateRestrictions(action: string, resource: string, rules: readonly PermissionRule[]): PermissionRule["effect"] {
  // Match OpenCode's ordered policy evaluation within one agent/session ruleset.
  // The caller combines these effective decisions across ancestors separately;
  // applying deny-overrides here would make an earlier wildcard deny defeat a
  // later, narrower allow that OpenCode itself honors.
  return rules.findLast((rule) => wildcardMatches(action, rule.action) && wildcardMatches(resource, rule.resource))?.effect ?? "allow"
}

async function parentRestriction(
  ctx: Plugin.Context,
  sessionID: string,
  action: string,
  resource: string,
  resolveLogicalParent?: VerifiedLogicalParentResolver,
): Promise<"allow" | "ask" | "deny"> {
  const agents = (await ctx.agent.list()).data
  let child: SessionWithPermissions | undefined = await ctx.session.get({ sessionID })
  let result: "allow" | "ask" | "deny" = "allow"
  let depth = 0
  if (child) {
    const current = child
    const ownAgent = agents.find((agent) => agent.id === current.agent)
    const ownRules = [
      ...(ownAgent?.permissions ?? []),
      ...((current.permissions ?? []) as PermissionRule[]),
    ] as PermissionRule[]
    const ownEffect = evaluateRestrictions(action, resource, ownRules)
    if (ownEffect === "deny") return "deny"
    if (ownEffect === "ask") result = "ask"
  }
  const visited = new Set([sessionID])
  while (child) {
    const parentID = child.parentID ?? await resolveLogicalParent?.(child.id)
    if (!parentID) break
    if (depth >= 32 || visited.has(parentID)) throw new Error("Subagent permission ancestry is cyclic or exceeds the traversal bound.")
    visited.add(parentID)
    const parent = await ctx.session.get({ sessionID: parentID })
    if (parent.id !== parentID) throw new Error("Subagent permission ancestor identity mismatch.")
    const parentAgent = agents.find((agent) => agent.id === parent.agent)
    const rules = [
      ...(parentAgent?.permissions ?? []),
      ...((parent.permissions ?? []) as PermissionRule[]),
    ] as PermissionRule[]
    const effect = evaluateRestrictions(action, resource, rules)
    if (effect === "deny") return "deny"
    if (effect === "ask") result = "ask"
    child = parent
    depth++
  }
  return result
}

/** Inherit restrictive ancestor agent/session permissions without copying allows. */
export async function registerV2SubagentPermissionGuard(
  ctx: Plugin.Context,
  runs: V2SubagentRunState,
  invocations: AliasInvocations = new Map(),
  resolveLogicalParent?: VerifiedLogicalParentResolver,
) {
  const permission = await ctx.permission.hook("evaluate", async (event) => {
    const run = await runs.get(event.sessionID)
    const delegatedAlias = event.action === "subagent"
      ? (event.source
        ? invocations.get(invocationKey({ sessionID: event.sessionID, messageID: event.source.messageID, id: event.source.id }))
        : undefined) ?? "task"
      : undefined
    if (run?.blockedActions.some((blocked) =>
      wildcardMatches(event.action, blocked) || (delegatedAlias !== undefined && wildcardMatches(delegatedAlias, blocked)))) {
      event.effect = "deny"
      event.message = `Blocked by the delegated task's tool restrictions (${delegatedAlias ?? event.action}).`
      return
    }

    try {
      let inherited: "allow" | "ask" | "deny" = "allow"
      for (const resource of event.resources) {
        const result = await parentRestriction(ctx, event.sessionID, event.action, resource, resolveLogicalParent)
        if (result === "deny") {
          inherited = "deny"
          break
        }
        if (result === "ask") inherited = "ask"
      }
      if (inherited === "deny") {
        event.effect = "deny"
        event.message = "Blocked by an ancestor agent or session permission inherited by this subagent."
      } else if (inherited === "ask" && event.effect === "allow") {
        event.effect = "ask"
        event.message = "This action requires approval under an ancestor agent's permissions."
      }

      if (event.action === "subagent" && event.resources.length > 0) {
        const action = delegatedAlias ?? "task"
        const [agents, session] = await Promise.all([
          ctx.agent.list(),
          ctx.session.get({ sessionID: event.sessionID }),
        ])
        const agentID = event.agent ?? session.agent
        const agent = agents.data.find((item) => item.id === agentID)
        const rules = [
          ...((agent?.permissions ?? []) as PermissionRule[]),
          ...((session.permissions ?? []) as PermissionRule[]),
        ]
        const effect = aliasPermissionEffect(action, event.resources, rules)
        if (effect === "deny") {
          event.effect = "deny"
          event.message = `Delegation denied by the ${action} permission policy.`
        } else if (effect === "ask" && event.effect === "allow") {
          event.effect = "ask"
          event.message = `Delegation requires approval under the ${action} permission policy.`
        }
      }
    } catch (error) {
      // A child ancestry lookup failure must never turn an inherited restriction into an allow.
      if (event.effect === "allow") event.effect = "ask"
      event.message = `Could not verify subagent permissions: ${error instanceof Error ? error.message : String(error)}`
    }
  })
  let toolGuard: Awaited<ReturnType<Plugin.Context["tool"]["hook"]>> | undefined
  try {
    toolGuard = await ctx.tool.hook("execute.before", async (event) => {
      const run = await runs.get(event.sessionID)
      if (!run) return
      if (!run.blockedActions.some((blocked) => wildcardMatches(event.tool.toLowerCase(), blocked))) return
      throw new ToolError({ message: `Blocked by the delegated task's tool restrictions (${event.tool}).` })
    })
  } catch (error) {
    await permission.dispose()
    throw error
  }
  return {
    dispose: async () => {
      const errors: unknown[] = []
      for (const registration of [toolGuard, permission]) {
        try {
          await registration?.dispose()
        } catch (error) {
          errors.push(error)
        }
      }
      if (errors.length > 0) throw new AggregateError(errors, "Delegated permission guard cleanup failed")
    },
  }
}

async function loadNativeSkills(
  native: NativeSubagent | undefined,
  names: readonly string[],
  config: OhMyOpenCodeConfig,
  toolContext: ToolContext,
) {
  if (names.length === 0) return []
  const resolved = []
  for (const requested of names) {
    if (isDisabled(config.disabled_skills, requested)) {
      throw new ToolError({ message: `Skill "${requested}" is disabled by disabled_skills.` })
    }
    if (toolDisabled(config, "skill")) throw new ToolError({ message: `Skill "${requested}" cannot be loaded because the native skill tool is disabled.` })
    if (!native) throw new ToolError({ message: `Skill "${requested}" cannot be loaded because the native V2 skill tool is unavailable.` })
    // Execute through the native tool so skill permissions and resource loading remain in force.
    const result = await native.execute({ id: requested }, toolContext)
    const output = result.output as { name?: unknown; output?: unknown } | undefined
    const content = typeof output?.output === "string"
      ? output.output
      : typeof result.content === "string" ? result.content : undefined
    if (!content) throw new ToolError({ message: `Native skill tool returned no prepared content for "${requested}".` })
    resolved.push({ name: typeof output?.name === "string" ? output.name : requested, content })
  }
  return resolved
}

function addPromptContext(input: {
  prompt: string
  category?: string
  categoryAppend?: string
  command?: string
  skills?: readonly { name: string; content: string }[]
  parentAgent: string
}) {
  const sections: string[] = []
  if (input.categoryAppend) sections.push(`<OMO category: ${input.category ?? "unspecified"}>\n${input.categoryAppend}`)
  if (input.command) sections.push(`<Triggering command>\n${input.command}`)
  for (const skill of input.skills ?? []) {
    sections.push(`<OMO skill: ${skill.name}>\n${skill.content}\n</OMO skill>`)
  }
  const taskPrompt = buildTaskPrompt(input.prompt, input.parentAgent)
  sections.push(taskPrompt)
  return sections.join("\n\n")
}

function toolDisabled(config: OhMyOpenCodeConfig, name: string): boolean {
  return isDisabled(config.disabled_tools, name)
}

function registerToolAliases(input: {
  editor: ToolEditor
  ctx: Plugin.Context
  config: OhMyOpenCodeConfig
  native: NativeSubagent
  nativeSkill?: NativeSubagent
  admission: ReturnType<typeof createV2DelegationAdmission>
  runs: V2SubagentRunState
  childSessions: Map<string, Set<string>>
  invocations: AliasInvocations
  resolveLogicalParent?: VerifiedLogicalParentResolver
}) {
  const { editor, ctx, config, native, nativeSkill, admission, runs, childSessions, invocations } = input
  const nativeRead = editor.get("read")

  const launch = async (
    request: { agent: string; description: string; prompt: string; model?: string; modelSelection?: DelegationModelChoice; sessionID?: string; background: boolean; blockedActions?: string[]; category?: string },
    toolContext: ToolContext,
    onChild?: (sessionID: string) => void,
  ) => {
    // Agent transforms can change the visible catalog after tool transforms run.
    // Resolve at invocation time so validation matches the current native registry.
    const agents = (await ctx.agent.list()).data
    const agentID = resolveAgentId(request.agent, agents, config)
    if (request.sessionID) {
      const existing = await readOwnedChildSession(ctx, toolContext.sessionID, request.sessionID)
      if (existing.agent !== agentID) {
        throw new ToolError({ message: `Cannot continue session ${request.sessionID} as a different agent; this would change its permission profile.` })
      }
      if (existing.model && isProviderDisabled(`${existing.model.providerID}/${existing.model.id}`, config.disabled_providers ?? [])) {
        throw new ToolError({
          message: `Cannot resume child session ${request.sessionID}: its stored model ${existing.model.providerID}/${existing.model.id} uses a provider listed in disabled_providers. Start a new child with an allowed model or remove that provider from the denylist.`,
        })
      }
      const existingRun = await runs.get(request.sessionID)
      if (existingRun && existingRun.parentSessionID !== toolContext.sessionID) {
        throw new ToolError({ message: `Session ${request.sessionID} is not owned by this parent session.` })
      }
    }

    const inheritedProgress: ToolContext["progress"] = async (metadata) => {
      const data = metadata as Record<string, unknown>
      const childSessionID = typeof data.sessionID === "string" ? data.sessionID : undefined
      if (childSessionID) {
        onChild?.(childSessionID)
        const startedAt = Date.now()
        const blockedActions = request.blockedActions ?? []
        await runs.recordLaunch(childSessionID, {
          parentSessionID: toolContext.sessionID,
          startedAt,
          status: "running",
          blockedActions,
        })
        const children = childSessions.get(toolContext.sessionID) ?? new Set<string>()
        children.add(childSessionID)
        childSessions.set(toolContext.sessionID, children)
      }
      return toolContext.progress(metadata)
    }
    const delegatedContext = { ...toolContext, progress: inheritedProgress }
    const nativeInput = {
      agent: agentID,
      description: request.description,
      prompt: request.prompt,
      ...(!request.sessionID && !request.modelSelection && request.model ? { model: request.model } : {}),
      ...(request.sessionID ? { sessionID: request.sessionID } : {}),
      ...(request.background ? { background: true } : {}),
    }
    const preparedFallback = request.sessionID
      ? await admission.prepareExplicitFallbackResume(request.sessionID, toolContext.sessionID, agentID)
      : undefined
    const result = await admission.invokeWithSelection(
      native, nativeInput, delegatedContext,
      preparedFallback?.choice ?? request.modelSelection,
      preparedFallback,
    )
    const metadata = resultMetadata(result)
    const output = (typeof result.output === "object" && result.output !== null ? result.output : {}) as { sessionID?: unknown; status?: unknown }
    const childSessionID = typeof metadata.sessionID === "string" ? metadata.sessionID : typeof output.sessionID === "string" ? output.sessionID : undefined
    const status = metadata.status ?? output.status
    if (!childSessionID || status !== "running") return result
    // Legacy prompts collect background results by `bg_` ID and continue work by session ID.
    const backgroundTaskId = v2BackgroundTaskID(childSessionID)
    return {
      ...result,
      content: appendResultText(result.content, [
        `Background Task ID: ${backgroundTaskId}`,
        buildTaskMetadataBlock({ sessionId: childSessionID, taskId: childSessionID, backgroundTaskId, agent: agentID, category: request.category }),
      ].join("\n")),
      metadata: { ...metadata, backgroundTaskId },
    }
  }

  /**
   * Legacy unstable-agent policy: an explicit foreground call on an unstable category model runs as a
   * supervised task with a `bg_` handle, a timeout budget and the legacy SUPERVISED result framing.
   * The native job stays in the foreground so the parent does not also receive a background completion notice.
   */
  const superviseUnstable = async (
    request: Parameters<typeof launch>[0] & { model?: string },
    toolContext: ToolContext,
  ): Promise<NativeTaskResult> => {
    const budget = config.background_task?.syncPollTimeoutMs ?? DEFAULT_SUPERVISED_TIMEOUT_MS
    const startedAt = Date.now()
    let childSessionID: string | undefined
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      if (childSessionID) {
        void ctx.session.interrupt({ sessionID: childSessionID as Parameters<Plugin.Context["session"]["interrupt"]>[0]["sessionID"] })
          .catch((error) => log("[v2 delegation] Could not interrupt a timed-out supervised task.", { sessionID: childSessionID, error }))
      }
    }, budget)
    const header = (title: string) => [
      title,
      "",
      `Duration: ${formatDuration(Date.now() - startedAt)}`,
      `Agent: ${request.agent}${request.category ? ` (category: ${request.category})` : ""}`,
      `Model: ${request.model ?? "unknown"}`,
    ].join("\n")
    const metadataBlock = () => childSessionID
      ? buildTaskMetadataBlock({ sessionId: childSessionID, taskId: childSessionID, backgroundTaskId: v2BackgroundTaskID(childSessionID), agent: request.agent, category: request.category })
      : ""
    try {
      // A child that completed despite a late interrupt request still returns its result.
      const result = await launch(request, toolContext, (sessionID) => { childSessionID ??= sessionID })
      const text = [
        header("SUPERVISED TASK COMPLETED SUCCESSFULLY"),
        "",
        `IMPORTANT: This model (${request.model ?? "unknown"}) is marked as unstable/experimental.`,
        "Your run_in_background=false call ran as a supervised task with a background task ID for reliability monitoring.",
        "",
        "MONITORING INSTRUCTIONS:",
        "- The task was monitored and completed successfully",
        "- If you observe this agent behaving erratically in future calls, actively monitor its progress",
        `- Use background_cancel(taskId="${childSessionID ? v2BackgroundTaskID(childSessionID) : "bg_..."}") to abort if the agent seems stuck or producing garbage output`,
        "- Do NOT retry automatically if you see this message - the task already succeeded",
        "",
        "---",
        "",
        "RESULT:",
        "",
        resultOutputText(result) || "(No text output)",
        "",
        metadataBlock(),
      ].join("\n")
      return {
        ...result,
        content: text,
        metadata: { ...resultMetadata(result), ...(childSessionID ? { backgroundTaskId: v2BackgroundTaskID(childSessionID) } : {}), supervised: true },
      }
    } catch (error) {
      if (!(error instanceof ToolError) || error.message.startsWith("SUPERVISED TASK")) throw error
      const title = timedOut ? "SUPERVISED TASK TIMED OUT" : "SUPERVISED TASK FAILED"
      throw new ToolError({ message: `${header(title)}\n\n${timedOut ? `Task did not complete within the monitored timeout budget (${budget}ms) and was interrupted.` : error.message}\nThe task session may contain partial results.\n\n${metadataBlock()}` })
    } finally {
      clearTimeout(timer)
    }
  }

  addV2LookAtTool(editor, config, nativeRead, (request, context) =>
    withDelegationAlias(invocations, "task", context, () => launch(request, context)),
  )

  if (!toolDisabled(config, "task")) {
    addV2Tool(editor, {
      name: "task",
      description: "Delegate a new task with exactly one of category or subagent_type. To continue a child, pass its task_id and prompt without either selector; the stored child agent, model, and tool restrictions are preserved. Use background mode for independent work; a background launch returns a background task ID (`bg_...`) for background_output/background_cancel and the child sessionID (`ses_...`) for task_id follow-ups.",
      input: taskInput,
      output: native.output,
      options: { codemode: false, permission: "task" },
      execute: async (args, context) => {
        if (args.category && args.subagent_type) throw new ToolError({ message: "Pass either category or subagent_type, not both." })
        if (!args.category && !args.subagent_type && !args.task_id) {
          throw new ToolError({ message: "Pass a category or subagent_type when starting a task." })
        }
        const runInBackground = args.run_in_background === true
        let agent = args.subagent_type ?? "sisyphus-junior"
        if (!args.category && !args.subagent_type && args.task_id) {
          let existing: Awaited<ReturnType<typeof ctx.session.get>>
          try {
            existing = await readOwnedChildSession(ctx, context.sessionID, args.task_id)
          } catch (error) {
            throw new ToolError({ message: error instanceof Error ? error.message : String(error) })
          }
          if (typeof existing.agent !== "string" || !existing.agent) {
            throw new ToolError({ message: `Cannot infer the agent for owned child session ${args.task_id}.` })
          }
          agent = existing.agent
        }
        let model: string | undefined
        let modelSelection: DelegationModelChoice | undefined
        let categoryAppend: string | undefined
        let blockedActions: string[] = []
        if (args.category) {
          const categoryName = args.category
          const categoryConfig = config.categories?.[categoryName] ?? DEFAULT_CATEGORIES[categoryName]
          if (!categoryConfig || categoryConfig.disable) {
            const names = Object.entries({ ...DEFAULT_CATEGORIES, ...config.categories }).filter(([, value]) => !value.disable).map(([name]) => name).join(", ")
            throw new ToolError({ message: `Unknown or disabled category "${categoryName}". Available categories: ${names}.` })
          }
          agent = "sisyphus-junior"
          // A resumed child keeps its persisted model/settings. New category
          // children resolve a rich choice once and pass it through the
          // admission instance's private WeakMap, never native input fields.
          modelSelection = args.task_id
            ? undefined
            : await resolveV2DelegationModelChoice(ctx, config, agent, context.sessionID, categoryName)
          model = modelChoiceText(modelSelection)
          const userPromptAppend = config.categories?.[categoryName]?.prompt_append
          const modelPromptAppend = CATEGORY_PROMPT_APPEND_RESOLVERS[categoryName]?.(model)
          categoryAppend = [
            modelPromptAppend ?? CATEGORY_PROMPT_APPENDS[categoryName],
            userPromptAppend ? resolvePromptAppend(userPromptAppend, ctx.location.directory) : undefined,
          ].filter((value): value is string => Boolean(value)).join("\n\n") || undefined
          blockedActions = toolRestrictionsToActions(categoryConfig.tools)
        }
        const skills = await loadNativeSkills(nativeSkill, args.load_skills ?? [], config, context)
        const prompt = addPromptContext({
          prompt: args.prompt,
          category: args.category,
          categoryAppend,
          command: args.command,
          skills,
          parentAgent: context.agent,
        })
        const request = {
          agent,
          description: args.description?.trim() || args.prompt.trim().split(/\s+/).slice(0, 5).join(" "),
          prompt,
          model,
          modelSelection,
          sessionID: args.task_id,
          background: runInBackground,
          blockedActions,
          category: args.category,
        }
        const supervised = Boolean(args.category) && !args.task_id && args.run_in_background === false &&
          !toolDisabled(config, "background_cancel") && isV2UnstableChild(config, model, args.category)
        if (supervised) log("[v2 delegation] Running an explicit foreground task on an unstable model as a supervised task.", { category: args.category, model })
        return withDelegationAlias(invocations, "task", context, () => supervised ? superviseUnstable(request, context) : launch(request, context))
      },
    })
  } else {
    // The host's native alias must not remain a bypass around OMO's disabled delegation setting.
    editor.remove("subagent")
  }

  if (!toolDisabled(config, "call_omo_agent")) {
    addV2Tool(editor, {
      name: "call_omo_agent",
      description: "Invoke only the OMO explore or librarian subagent. This tool does not select task categories or inject skills.",
      input: callAgentInput,
      output: native.output,
      options: { codemode: false, permission: "call_omo_agent" },
      execute: async (args, context) => {
        const agent = stripInvisibleAgentCharacters(args.subagent_type).trim().toLowerCase()
        if (agent !== "explore" && agent !== "librarian") {
          throw new ToolError({ message: `Invalid agent type "${args.subagent_type}". Only explore and librarian are allowed.` })
        }
        return withDelegationAlias(invocations, "call_omo_agent", context, () => launch({
          agent,
          description: args.description,
          prompt: addPromptContext({ prompt: args.prompt, parentAgent: context.agent }),
          sessionID: args.session_id,
          background: args.run_in_background,
        }, context))
      },
    })
  }

  if (!toolDisabled(config, "skill") && nativeSkill) {
    // Existing OMO prompts use both `skill(name=...)` and native `skill(id=...)`.
    // Keep the alias schema but route every call through the captured host executor.
    editor.remove("skill")
    addV2Tool(editor, {
      name: "skill",
      description: "Load a native skill by id or name. The host permission policy is applied before its resources are read.",
      input: skillAliasInput,
      output: nativeSkill.output,
      options: { codemode: false },
      execute: async (args, context) => {
        const id = args.id?.trim()
        const name = args.name?.trim()
        if (id && name && id.toLowerCase() !== name.toLowerCase()) {
          throw new ToolError({ message: "Pass either id or name to skill, not two different values." })
        }
        const requested = id || name
        if (!requested) throw new ToolError({ message: "Pass the skill id or name." })
        return nativeSkill.execute({ id: requested }, context)
      },
    })
  } else if (toolDisabled(config, "skill")) {
    editor.remove("skill")
  }

  if (!toolDisabled(config, "background_output")) {
    addV2Tool(editor, {
      name: "background_output",
      description: "Read output from a background task by its background task ID (`bg_...`) or child sessionID. Use block=true to wait for the current execution.",
      input: backgroundOutputInput,
      options: { codemode: false },
      execute: async (rawArgs, context) => {
        const args = { ...rawArgs, task_id: await resolveV2TaskReference(runs, context.sessionID, rawArgs.task_id) }
        await readOwnedChildSession(ctx, context.sessionID, args.task_id, input.resolveLogicalParent)
        let run = await runs.get(args.task_id)
        if (run && run.parentSessionID !== context.sessionID) throw new ToolError({ message: `Session ${args.task_id} is not owned by this parent session.` })
        let waitTimedOut = false
        let waitedForTerminal = false
        if (args.block && (run?.status === undefined || run.status === "running")) {
          const timeout = Math.min(args.timeout ?? 60000, 600000)
          const controller = new AbortController()
          const abortFromCall = () => controller.abort(context.signal.reason)
          context.signal.addEventListener("abort", abortFromCall, { once: true })
          const timer = setTimeout(() => {
            waitTimedOut = true
            controller.abort(new Error("background_output timeout"))
          }, timeout)
          try {
            await ctx.session.wait({ sessionID: args.task_id }, { signal: controller.signal })
            waitedForTerminal = true
          } catch (error) {
            if (context.signal.aborted) throw error
            if (!waitTimedOut) throw error
          } finally {
            clearTimeout(timer)
            context.signal.removeEventListener("abort", abortFromCall)
          }
          run = await runs.get(args.task_id)
        }
        const latest = await ctx.session.get({ sessionID: args.task_id })
        let status: V2SessionStatus = run?.status !== "running"
          ? run?.status ?? "unknown"
          : (latest.time.idle !== undefined && latest.time.idle >= run.startedAt
            ? terminalOutcome(latest.outcome) ?? "running"
            : "running")
        if (waitedForTerminal) {
          // Session.wait resolves only after the child execution is idle. Its outcome
          // is authoritative even when run metadata was lost across plugin reload.
          status = terminalOutcome(latest.outcome) ?? "completed"
          if (run) {
            await runs.markTerminal(args.task_id, status as TerminalStatus, Date.now())
          } else {
            await runs.recordLaunch(args.task_id, {
              parentSessionID: context.sessionID,
              startedAt: latest.time.idle ?? Date.now(),
              status: status as TerminalStatus,
              blockedActions: [],
            })
          }
        }
        const base = `Background Task ID: ${v2BackgroundTaskID(args.task_id)}\nSession: ${args.task_id}\nStatus: ${status}${waitTimedOut ? `\nWait timed out after ${Math.min(args.timeout ?? 60000, 600000)}ms.` : ""}`
        if (status === "running") return { content: `${base}\nThe current child execution has not reached a verified idle state.` }
        if (status === "unknown") return { content: `${base}\nThe active execution could not be verified after plugin reload. Pass block=true to wait for an authoritative idle transition.` }
        const transcript = await import("./session-history").then(({ readSessionHistory }) => readSessionHistory(ctx, args.task_id, {
          fullSession: args.full_session,
          includeThinking: args.include_thinking,
          includeToolResults: args.include_tool_results,
          messageLimit: args.message_limit,
          sinceMessageID: args.since_message_id,
          fromEnd: args.from_end,
          thinkingMaxChars: args.thinking_max_chars,
        }))
        return { content: `${base}\n\n${transcript}`, metadata: { sessionID: args.task_id, backgroundTaskId: v2BackgroundTaskID(args.task_id), status, parentSessionID: context.sessionID } }
      },
    })
  }

  if (!toolDisabled(config, "background_cancel")) {
    addV2Tool(editor, {
      name: "background_cancel",
      description: "Cancel a background task by its background task ID (`bg_...`) or child sessionID. Set all=true to interrupt tracked running children of the current session.",
      input: backgroundCancelInput,
      options: { codemode: false },
      execute: async (args, context) => {
        const sessionIDs = args.all
          ? await runs.children(context.sessionID)
          : args.taskId ? [await resolveV2TaskReference(runs, context.sessionID, args.taskId)] : []
        if (sessionIDs.length === 0) throw new ToolError({ message: "Provide taskId or set all=true when tracked running children exist." })
        const interrupted: string[] = []
        for (const sessionID of sessionIDs) {
          await readOwnedChildSession(ctx, context.sessionID, sessionID, input.resolveLogicalParent)
          const run = await runs.get(sessionID)
          if (run && run.parentSessionID !== context.sessionID) throw new ToolError({ message: `Session ${sessionID} is not owned by this parent session.` })
          if (run && run.status !== "running") continue
          await ctx.session.interrupt({ sessionID })
          interrupted.push(sessionID)
          await runs.markTerminal(sessionID, "interrupted", Date.now())
        }
        return { content: interrupted.length ? `Interrupt requested for background task(s): ${interrupted.map((sessionID) => `${v2BackgroundTaskID(sessionID)} (${sessionID})`).join(", ")}` : "No tracked running child sessions were found." }
      },
    })
  }
}

export type V2DelegationRuntime = {
	readonly admission: Pick<V2BackgroundAdmission, "acquire">
  readonly runs: V2SubagentRunState
  readonly childSessions: Map<string, Set<string>>
  readonly cleanup: () => Promise<void>
}

export async function registerV2Delegation(
  ctx: Plugin.Context,
  config: OhMyOpenCodeConfig,
  runs: V2SubagentRunState,
  options: { resolveLogicalParent?: VerifiedLogicalParentResolver; isStopped?: (sessionID: string) => boolean | Promise<boolean> } = {},
): Promise<V2DelegationRuntime> {
  const childSessions = new Map<string, Set<string>>()
  const invocations: AliasInvocations = new Map()
  const delegationAdmission = createV2DelegationAdmission({
    ctx,
    config,
    runs,
    childSessions,
    isAliasInvocation: (context) => invocations.has(invocationKey(context)),
    resolveLogicalParent: options.resolveLogicalParent,
    isStopped: options.isStopped,
  })
  let permissionRegistration: Awaited<ReturnType<typeof registerV2SubagentPermissionGuard>> | undefined
  let toolRegistration: Awaited<ReturnType<Plugin.Context["tool"]["transform"]>> | undefined
  const eventAbort = new AbortController()
  let eventLoop: Promise<void> | undefined
  try {
    await delegationAdmission.ready()
    permissionRegistration = await registerV2SubagentPermissionGuard(ctx, runs, invocations, options.resolveLogicalParent)
    toolRegistration = await ctx.tool.transform((editor) => {
      const nativeInput = editor.get("subagent")
      if (!nativeInput) throw new Error("OpenCode V2 native subagent tool is unavailable; OMO delegation cannot be registered safely.")
      const native = delegationAdmission.wrap(nativeInput)
      if (native.execute !== nativeInput.execute) {
        editor.update("subagent", (tool) => { tool.execute = native.execute })
      }
      const nativeSkill = editor.get("skill")
      if (toolDisabled(config, "task")) editor.remove("subagent")
      registerToolAliases({ editor, ctx, config, native, nativeSkill, admission: delegationAdmission, runs, childSessions, invocations, resolveLogicalParent: options.resolveLogicalParent })
    })
    eventLoop = (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: eventAbort.signal })) {
          if (eventAbort.signal.aborted) break
          try {
            await delegationAdmission.observeExecution(event)
            if (event.type === "session.execution.started") {
              await runs.markStarted(event.data.sessionID, event.created)
            } else if (event.type === "session.execution.succeeded") {
              await runs.markTerminal(event.data.sessionID, "completed", event.created)
            } else if (event.type === "session.execution.failed") {
              await runs.markTerminal(event.data.sessionID, "failed", event.created)
            } else if (event.type === "session.execution.interrupted") {
              await runs.markTerminal(event.data.sessionID, "interrupted", event.created)
            } else if (event.type === "session.deleted") {
              await Promise.all([
                runs.remove(event.data.sessionID),
                delegationAdmission.removeSettings(event.data.sessionID),
              ])
            }
          } catch (error) {
            log("[v2 delegation] Failed to update child execution state for an event.", error)
          }
        }
      } catch (error) {
        if (!eventAbort.signal.aborted) log("[v2 delegation] Execution event stream stopped unexpectedly.", error)
      }
    })()
  } catch (error) {
    eventAbort.abort()
    const cleanupErrors: unknown[] = []
    for (const cleanup of [
      () => toolRegistration?.dispose(),
      () => permissionRegistration?.dispose(),
      () => eventLoop?.catch(() => undefined),
      () => delegationAdmission.dispose(),
    ]) {
      try { await cleanup() } catch (cleanupError) { cleanupErrors.push(cleanupError) }
    }
    if (cleanupErrors.length > 0) throw new AggregateError([error, ...cleanupErrors], "V2 delegation setup failed and cleanup was incomplete")
    throw error
  }

  return {
    admission: delegationAdmission.background,
    runs,
    childSessions,
    cleanup: async () => {
      eventAbort.abort()
      const errors: unknown[] = []
      for (const cleanup of [
        () => toolRegistration?.dispose(),
        () => permissionRegistration?.dispose(),
        () => eventLoop?.catch(() => undefined),
        () => delegationAdmission.dispose(),
      ]) {
        try { await cleanup() } catch (error) { errors.push(error) }
      }
      if (errors.length > 0) throw new AggregateError(errors, "V2 delegation cleanup failed")
    },
  }
}
