import { createHash, randomUUID } from "node:crypto"
import { Error as ToolError, type ToolContext, type ToolEditor } from "@opencode/plugin/promise/tool"
import type { Plugin } from "@opencode/plugin"
import { z } from "zod"
import { TeamModeConfigSchema, type TeamModeConfig } from "@oh-my-opencode/team-core/config"
import { TeamSpecSchema, type Member, type RuntimeState, type TeamSpec } from "@oh-my-opencode/team-core/types"
import { normalizeTeamSpecInput, loadTeamSpec, loadAllTeamSpecs } from "@oh-my-opencode/team-core/team-registry/loader"
import { validateSpec, TeamSpecValidationError } from "@oh-my-opencode/team-core/team-registry/validator"
import { TeamPathTraversalError } from "@oh-my-opencode/team-core/team-registry/paths"
import { createRuntimeState, loadRuntimeState, transitionRuntimeState, InvalidTransitionError, RuntimeStateError } from "@oh-my-opencode/team-core/team-state-store"
import { createTask, getTask, listTasks, claimTask, updateTaskStatus, AlreadyClaimedError, BlockedByError, CrossOwnerUpdateError, InvalidTaskTransitionError } from "@oh-my-opencode/team-core/team-tasklist"
import { ackMessages, listUnreadMessages, sendMessage, BroadcastNotPermittedError, DuplicateMessageIdError, PayloadTooLargeError, RecipientBackpressureError } from "@oh-my-opencode/team-core/team-mailbox"
import { InvalidRecipientError, TeamDeletingError } from "@oh-my-opencode/team-core/team-mailbox/send"
import { buildEnvelope } from "@oh-my-opencode/team-core/team-mailbox/poll"
import { MessageSchema, AGENT_ELIGIBILITY_REGISTRY, type Message, type Task } from "@oh-my-opencode/team-core/types"
import { requestShutdownOfMember, approveShutdown, rejectShutdown } from "../../features/team-mode/team-runtime/shutdown"
import { findLatestShutdownRequestIndex } from "../../features/team-mode/team-runtime/shutdown-helpers"
import { DEFAULT_CATEGORIES, CATEGORY_PROMPT_APPENDS, CATEGORY_PROMPT_APPEND_RESOLVERS } from "../../tools/delegate-task/builtin-categories"
import { resolvePromptAppend } from "../../agents/builtin-agents/resolve-file-uri"
import type { OhMyOpenCodeConfig } from "../../config"
import type { V2BackgroundAdmission } from "../background-admission"
import { createV2DelegationSettings } from "../delegation-settings"
import { resolveV2ManagedAgentModelChoice } from "../delegation-admission"
import { addV2Tool } from "../tool-adapter"
import type { V2SubagentRunState } from "../task-state"
import { log } from "../../shared/logger"
import { createV2TeamMembershipStore, V2TeamMembershipError, type V2TeamMembershipRecord, type TeamLogicalParentResolver } from "./membership-store"
import { buildV2TeamMemberPrompt } from "./prompts"
import type { V2TeamManager, V2TeamManagerStart } from "./types"

type SessionInfo = Awaited<ReturnType<Plugin.Context["session"]["get"]>>
type NativeEvent = Awaited<ReturnType<Plugin.Context["event"]["subscribe"]>> extends AsyncIterable<infer Event> ? Event : never
type ExecutionEvent = Extract<NativeEvent, {
	type: "session.execution.started" | "session.execution.succeeded" | "session.execution.failed" | "session.execution.interrupted"
}>

function isExecutionEvent(event: NativeEvent): event is ExecutionEvent {
	return event.type === "session.execution.started" || event.type === "session.execution.succeeded" ||
		event.type === "session.execution.failed" || event.type === "session.execution.interrupted"
}
type Actor = { name: string; role: "lead" | "member"; record: V2TeamMembershipRecord; runtime: RuntimeState }
type RunControl = {
	runId: string
	controller: AbortController
	closing: boolean
	pendingMembers: string[]
	pendingWakeups: Set<string>
	active: Set<string>
	reserved: number
	pendingPrompts: Map<string, number>
	executionStarted: Set<string>
	idleBaselines: Map<string, number | undefined>
	wakeupRetryAttempts: Map<string, number>
	wakeupRetryTimers: Map<string, ReturnType<typeof setTimeout>>
	startWaiters: Map<string, Set<() => void>>
	launchingMembers: Set<string>
	launches: Set<Promise<void>>
	settling: Map<string, Promise<void>>
	pumping?: Promise<void>
	pumpAgain: boolean
}

/** Grace before OMO resumes a member whose turn a host restart orphaned (unmanaged servers do not resume it). */
const RECOVERY_RESUME_GRACE_MS = 5_000
const BOOT_CATALOG_GRACE_MS = 30_000
const RECOVERY_RESUME_TEXT = "The server restarted while you were working. Continue from where you left off without repeating completed work."

const createInput = z.object({
	teamName: z.string().min(1).optional(),
	inline_spec: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
	leadSessionId: z.string().optional(),
}).superRefine((value, ctx) => {
	if (Number(value.teamName !== undefined) + Number(value.inline_spec !== undefined) !== 1) {
		ctx.addIssue({ code: "custom", message: "Provide exactly one of teamName or inline_spec." })
	}
})

const runIdInput = z.object({ teamRunId: z.string().uuid() })
const deleteInput = runIdInput.extend({ force: z.boolean().optional() })
const sendInput = runIdInput.extend({
	to: z.string().min(1), body: z.string(), kind: z.enum(["message", "announcement"]).optional(),
	correlationId: z.string().uuid().optional(), summary: z.string().optional(),
	references: z.array(z.object({ path: z.string().min(1), description: z.string().optional() })).optional(),
})
const taskCreateInput = runIdInput.extend({ subject: z.string().min(1), description: z.string(), blockedBy: z.array(z.string()).optional() })
const taskListInput = runIdInput.extend({ status: z.enum(["pending", "claimed", "in_progress", "completed", "deleted"]).optional(), owner: z.string().optional() })
const taskUpdateInput = runIdInput.extend({ taskId: z.string().min(1), status: z.enum(["pending", "claimed", "in_progress", "completed", "deleted"]), owner: z.string().optional() })
const taskGetInput = runIdInput.extend({ taskId: z.string().min(1) })
const shutdownRequestInput = runIdInput.extend({ targetMemberName: z.string().min(1) })
const shutdownMemberInput = runIdInput.extend({ memberName: z.string().min(1) })
const shutdownRejectInput = shutdownMemberInput.extend({ reason: z.string().min(1) })

function actionAliases(tools: Readonly<Record<string, boolean>> | undefined): string[] {
	if (!tools) return []
	const aliases: Record<string, string> = {
		bash: "shell", interactive_bash: "shell", shell: "shell", write: "edit", edit: "edit", patch: "edit",
		apply_patch: "edit", hashline_edit: "edit", task: "task", delegate_task: "task", call_omo_agent: "call_omo_agent",
	}
	return [...new Set(Object.entries(tools).filter(([, enabled]) => enabled === false).map(([name]) => aliases[name] ?? name))]
}

function settingsModel(model: { providerID: string; id: string; variant?: string }, settings: Readonly<Record<string, unknown>>) {
	const thinking = settings.thinking
	const validThinking = typeof thinking === "object" && thinking !== null &&
		"type" in thinking && (thinking.type === "enabled" || thinking.type === "disabled") &&
		(!("budgetTokens" in thinking) || typeof thinking.budgetTokens === "number" && Number.isInteger(thinking.budgetTokens) && thinking.budgetTokens > 0)
		? thinking as { type: "enabled" | "disabled"; budgetTokens?: number }
		: undefined
	return {
		providerID: model.providerID,
		modelID: model.id,
		...(model.variant ? { variant: model.variant } : {}),
		...(typeof settings.reasoningEffort === "string" ? { reasoningEffort: settings.reasoningEffort } : {}),
		...(typeof settings.temperature === "number" ? { temperature: settings.temperature } : {}),
		...(typeof settings.topP === "number" ? { top_p: settings.topP } : {}),
		...(typeof settings.maxTokens === "number" ? { maxTokens: settings.maxTokens } : {}),
		...(validThinking ? { thinking: validThinking } : {}),
	}
}

function nativePermissions(blocked: readonly string[]) {
	return [
		{ action: "question", resource: "*", effect: "deny" as const },
		{ action: "team_create", resource: "*", effect: "deny" as const },
		{ action: "subagent", resource: "*", effect: "deny" as const },
		{ action: "task", resource: "*", effect: "deny" as const },
		{ action: "call_omo_agent", resource: "*", effect: "deny" as const },
		...blocked.map((action) => ({ action, resource: "*", effect: "deny" as const })),
	]
}

function agentLead(agentName: string | undefined) {
	const agentTypeId = agentName?.replace(/^\u200B+/, "").trim().toLowerCase()
	const eligibility = agentTypeId ? AGENT_ELIGIBILITY_REGISTRY[agentTypeId] : undefined
	return {
		...(agentTypeId ? { agentTypeId, displayName: agentTypeId } : {}),
		isEligibleForTeamLead: eligibility !== undefined && eligibility.verdict !== "hard-reject",
	}
}

function memberAgent(member: Member): { agentID: string; categoryName?: string } {
	return member.kind === "category"
		? { agentID: "sisyphus-junior", categoryName: member.category }
		: { agentID: member.subagent_type }
}

async function validateMemberLaunch(
	ctx: Plugin.Context,
	config: OhMyOpenCodeConfig,
	leadSessionID: string,
	member: Member,
): Promise<void> {
	if (member.backendType !== "in-process") {
		throw new Error(`Team member ${member.name} requests backendType=${member.backendType}; native Team members require backendType=in-process.`)
	}
	if (member.cwd || member.worktreePath) {
		throw new Error(`Team member ${member.name} specifies cwd/worktreePath; native Team members currently require the calling project location.`)
	}
	const route = memberAgent(member)
	if (config.disabled_agents?.some((name) => name.trim().toLowerCase() === route.agentID.toLowerCase()) ||
		config.agents?.[route.agentID as keyof NonNullable<OhMyOpenCodeConfig["agents"]>]?.disable) {
		throw new Error(`Team member ${member.name} agent ${route.agentID} is disabled by OMO configuration.`)
	}
	await resolveV2ManagedAgentModelChoice(ctx, config, route.agentID, leadSessionID, route.categoryName)
}

async function preflightRoster(
	ctx: Plugin.Context,
	config: OhMyOpenCodeConfig,
	spec: TeamSpec,
	leadName: string,
	leadSessionID: string,
): Promise<void> {
	for (const member of spec.members) {
		if (member.name === leadName) continue
		try {
			// This read-only pass is intentionally before createRuntimeState() and
			// any native session creation. The launch path resolves again later so
			// a catalog/config change while the roster is queued is still checked.
			await validateMemberLaunch(ctx, config, leadSessionID, member)
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error)
			throw new ToolError({ message: `Team member ${member.name} cannot be started: ${detail}` })
		}
	}
}

function categoryAppend(config: OhMyOpenCodeConfig, categoryName: string, model: string, directory: string): string | undefined {
	const builtIn = CATEGORY_PROMPT_APPEND_RESOLVERS[categoryName]?.(model) ?? CATEGORY_PROMPT_APPENDS[categoryName]
	const user = config.categories?.[categoryName]?.prompt_append
	const userAppend = user ? resolvePromptAppend(user, directory) : undefined
	return [builtIn, userAppend].filter((value): value is string => Boolean(value)).join("\n\n") || undefined
}

function activeRecipients(runtime: RuntimeState): string[] {
	return runtime.members.filter((member) => member.status !== "errored" && member.status !== "completed").map((member) => member.name)
}

function terminalMemberStatus(outcome: SessionInfo["outcome"]): RuntimeState["members"][number]["status"] {
	if (outcome === "failed") return "errored"
	if (outcome === "interrupted") return "idle"
	return "idle"
}

function canonical(value: string): string {
	return value.replaceAll("\\", "/").replace(/\/$/, "")
}

function eventMatchesLocation(event: NativeEvent, ctx: Plugin.Context): boolean {
	const location = "location" in event ? event.location : undefined
	if (!location) return true
	if (canonical(location.directory) !== canonical(String(ctx.location.directory))) return false
	return !("workspaceID" in location) || location.workspaceID === ctx.location.workspaceID
}

export function stableV2TeamMailboxPromptId(teamRunId: string, memberName: string, messageId: string): string {
	const digest = createHash("sha256").update(`${teamRunId}:${memberName}:${messageId}`).digest("hex").slice(0, 48)
	return `msg_${digest}`
}

export function teamWakeRetryDelayMs(attempt: number): number {
	const retry = Math.max(1, Math.trunc(attempt))
	return Math.min(15_000, 250 * 2 ** Math.min(retry - 1, 6))
}

export function isNewerTeamExecutionIdle(baselineIdle: number | undefined, currentIdle: number | undefined): boolean {
	return typeof baselineIdle === "number" && Number.isFinite(baselineIdle) &&
		typeof currentIdle === "number" && Number.isFinite(currentIdle) && currentIdle > baselineIdle
}

function sessionIdleTime(session: SessionInfo): number | undefined {
	const idle = session.time.idle
	return typeof idle === "number" && Number.isFinite(idle) ? idle : undefined
}

function stableToolMessageId(teamRunId: string, callID: string): string {
	const bytes = createHash("sha256").update(`${teamRunId}:${callID}`).digest().subarray(0, 16)
	bytes[6] = (bytes[6]! & 0x0f) | 0x50
	bytes[8] = (bytes[8]! & 0x3f) | 0x80
	const hex = bytes.toString("hex")
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

type TaskUpdatePlan = { readonly kind: "claim" | "update"; readonly memberName: string }

export function planV2TeamTaskUpdate(input: {
	readonly actorName: string
	readonly actorRole: "lead" | "member"
	readonly task: Task
	readonly status: Task["status"]
	readonly requestedOwner?: string
	readonly memberNames: ReadonlySet<string>
}): TaskUpdatePlan {
	const { actorName, actorRole, task, status, requestedOwner, memberNames } = input
	if (status === "claimed") {
		const owner = requestedOwner ?? actorName
		if (actorRole !== "lead" && owner !== actorName) {
			throw new ToolError({ message: "Team members may only claim a task for themselves." })
		}
		if (!memberNames.has(owner)) throw new ToolError({ message: `Task owner ${owner} is not a member of this Team.` })
		return { kind: "claim", memberName: owner }
	}
	if (requestedOwner !== undefined && requestedOwner !== task.owner) {
		throw new ToolError({ message: "team_task_update cannot reassign an existing task; ownership changes are allowed only when claiming a pending task." })
	}
	if (actorRole !== "lead" && task.owner !== undefined && task.owner !== actorName) {
		throw new ToolError({ message: "Team members may not update or delete another member's task." })
	}
	if (actorRole !== "lead" && status !== "deleted" && task.owner !== actorName) {
		throw new ToolError({ message: "Team members may update only tasks they own." })
	}
	return { kind: "update", memberName: task.owner ?? actorName }
}

function isKnownTeamToolFailure(error: unknown): error is Error {
	return error instanceof V2TeamMembershipError || error instanceof TeamSpecValidationError || error instanceof TeamPathTraversalError ||
		error instanceof RuntimeStateError || error instanceof InvalidTransitionError || error instanceof AlreadyClaimedError ||
		error instanceof BlockedByError || error instanceof CrossOwnerUpdateError || error instanceof InvalidTaskTransitionError ||
		error instanceof BroadcastNotPermittedError || error instanceof DuplicateMessageIdError || error instanceof InvalidRecipientError ||
		error instanceof PayloadTooLargeError || error instanceof RecipientBackpressureError || error instanceof TeamDeletingError
}

function asNativeTeamToolError(error: unknown): ToolError | undefined {
	if (error instanceof ToolError) return error
	if (isKnownTeamToolFailure(error)) return new ToolError({ message: error.message })
	return undefined
}

export function createV2TeamManager(ctx: Plugin.Context, omoConfig: OhMyOpenCodeConfig): V2TeamManager {
	const rawTeamConfig = omoConfig.team_mode
	if (!rawTeamConfig?.enabled) throw new Error("createV2TeamManager requires team_mode.enabled=true.")
	const teamConfig: TeamModeConfig = TeamModeConfigSchema.parse(rawTeamConfig)
	const membership = createV2TeamMembershipStore(ctx, teamConfig)
	const settings = createV2DelegationSettings(ctx.storage, ctx.location)
	const controls = new Map<string, RunControl>()
	const eventController = new AbortController()
	let dependencies: V2TeamManagerStart | undefined
	let started = false
	let disposed = false
	let eventLoop: Promise<void> | undefined
	const wallClockTimers = new Map<string, ReturnType<typeof setTimeout>>()
	const recoveryTimers: Array<ReturnType<typeof setTimeout>> = []
	const startedSinceBoot = new Set<string>()
	let bootAt = 0
	const registrations: Array<Awaited<ReturnType<typeof ctx.session.hook>>> = []
	const actionQueues = new Map<string, Promise<void>>()

	async function serializeAction<T>(key: string, action: () => Promise<T>): Promise<T> {
		const previous = actionQueues.get(key) ?? Promise.resolve()
		let release!: () => void
		const gate = new Promise<void>((resolve) => { release = resolve })
		const tail = previous.catch(() => undefined).then(() => gate)
		actionQueues.set(key, tail)
		await previous.catch(() => undefined)
		try {
			return await action()
		} finally {
			release()
			if (actionQueues.get(key) === tail) actionQueues.delete(key)
		}
	}

	async function shutdownRequest(actor: Actor, targetMemberName: string): Promise<void> {
		const target = actor.runtime.members.find((member) => member.name === targetMemberName)
		if (!target || target.agentType === "leader") throw new ToolError({ message: `Shutdown target ${targetMemberName} is not a Team member.` })
		const key = `shutdown-request:${actor.record.teamRunId}:${actor.name}:${targetMemberName}`
		await serializeAction(key, async () => {
			const current = await loadRuntimeState(actor.record.teamRunId, teamConfig)
			const requestIndex = findLatestShutdownRequestIndex(current, targetMemberName, actor.name)
			const latest = requestIndex >= 0 ? current.shutdownRequests[requestIndex] : undefined
			const isPending = latest !== undefined && latest.approvedAt === undefined && latest.rejectedAt === undefined
			if (!isPending) {
				const generation = current.shutdownRequests.filter((request) => request.memberId === targetMemberName && request.requesterName === actor.name).length
				await membership.reserveMessage(actor.record.teamRunId, teamConfig.max_messages_per_run, `shutdown-request:${actor.name}:${targetMemberName}:${generation}`)
			}
			await requestShutdownOfMember(actor.record.teamRunId, targetMemberName, actor.name, teamConfig)
		})
	}

	async function approveMemberShutdown(actor: Actor, memberName: string): Promise<void> {
		if (!actor.runtime.members.some((member) => member.name === memberName && member.agentType !== "leader")) {
			throw new ToolError({ message: `Shutdown target ${memberName} is not a Team member.` })
		}
		const key = `shutdown-approve:${actor.record.teamRunId}:${memberName}`
		await serializeAction(key, async () => {
			const current = await loadRuntimeState(actor.record.teamRunId, teamConfig)
			const requestIndex = findLatestShutdownRequestIndex(current, memberName)
			const request = requestIndex >= 0 ? current.shutdownRequests[requestIndex] : undefined
			if (!request) throw new ToolError({ message: `No shutdown request is pending for ${memberName}.` })
			if (request.approvedAt === undefined) {
				await membership.reserveMessage(actor.record.teamRunId, teamConfig.max_messages_per_run, `shutdown-approve:${memberName}:${request.requestedAt}`)
			}
			await approveShutdown(actor.record.teamRunId, memberName, actor.name, teamConfig)
		})
	}

	async function rejectMemberShutdown(actor: Actor, memberName: string, reason: string): Promise<void> {
		if (!actor.runtime.members.some((member) => member.name === memberName && member.agentType !== "leader")) {
			throw new ToolError({ message: `Shutdown target ${memberName} is not a Team member.` })
		}
		const key = `shutdown-reject:${actor.record.teamRunId}:${memberName}`
		await serializeAction(key, async () => {
			const current = await loadRuntimeState(actor.record.teamRunId, teamConfig)
			const requestIndex = findLatestShutdownRequestIndex(current, memberName)
			const request = requestIndex >= 0 ? current.shutdownRequests[requestIndex] : undefined
			if (!request) throw new ToolError({ message: `No shutdown request is pending for ${memberName}.` })
			if (request.rejectedAt === undefined || request.rejectedReason !== reason) {
				await membership.reserveMessage(actor.record.teamRunId, teamConfig.max_messages_per_run, `shutdown-reject:${memberName}:${request.requestedAt}:${reason}`)
			}
			await rejectShutdown(actor.record.teamRunId, memberName, actor.name, reason, teamConfig)
		})
	}

	function controlFor(runId: string): RunControl {
		let value = controls.get(runId)
		if (!value) {
			value = {
				runId,
				controller: new AbortController(),
				closing: false,
				pendingMembers: [],
				pendingWakeups: new Set(),
				active: new Set(),
				reserved: 0,
				pendingPrompts: new Map(),
				executionStarted: new Set(),
				idleBaselines: new Map(),
				wakeupRetryAttempts: new Map(),
				wakeupRetryTimers: new Map(),
				startWaiters: new Map(),
				launchingMembers: new Set(),
				launches: new Set(),
				settling: new Map(),
				pumpAgain: false,
			}
			controls.set(runId, value)
		}
		return value
	}

	function clearWakeRetry(control: RunControl, memberName: string): void {
		const timer = control.wakeupRetryTimers.get(memberName)
		if (timer) clearTimeout(timer)
		control.wakeupRetryTimers.delete(memberName)
		control.wakeupRetryAttempts.delete(memberName)
	}

	function cancelWakeRetries(control: RunControl): void {
		for (const timer of control.wakeupRetryTimers.values()) clearTimeout(timer)
		control.wakeupRetryTimers.clear()
		control.wakeupRetryAttempts.clear()
	}

	function scheduleWakeRetry(runId: string, memberName: string, control: RunControl): void {
		if (disposed || control.closing || control.controller.signal.aborted || control.wakeupRetryTimers.has(memberName)) return
		const attempt = (control.wakeupRetryAttempts.get(memberName) ?? 0) + 1
		control.wakeupRetryAttempts.set(memberName, attempt)
		const timer = setTimeout(() => {
			control.wakeupRetryTimers.delete(memberName)
			if (disposed || control.closing || control.controller.signal.aborted) return
			void pump(runId)
		}, teamWakeRetryDelayMs(attempt))
		control.wakeupRetryTimers.set(memberName, timer)
	}

	async function requireActor(teamRunId: string, sessionID: string | undefined): Promise<Actor> {
		if (!sessionID) throw new ToolError({ message: "Team tools require an active session." })
		const record = await membership.recordForRun(teamRunId)
		if (!record || record.closedAt !== null) throw new ToolError({ message: `Team run ${teamRunId} is closed or unavailable.` })
		const identity = record.members.find((candidate) => candidate.sessionID === sessionID)
		if (!identity) throw new ToolError({ message: `Session ${sessionID} is not a member of Team ${teamRunId}.` })
		const runtime = await loadRuntimeState(teamRunId, teamConfig)
		if (runtime.status !== "active" && runtime.status !== "shutdown_requested") {
			throw new ToolError({ message: `Team ${teamRunId} does not accept tool actions while ${runtime.status}.` })
		}
		const runtimeMember = runtime.members.find((candidate) => candidate.name === identity.name && candidate.sessionId === sessionID)
		if (!runtimeMember) throw new ToolError({ message: `Team runtime no longer recognizes ${identity.name} session ${sessionID}.` })
		if (Date.now() - runtime.createdAt > teamConfig.max_wall_clock_minutes * 60_000) {
			throw new ToolError({ message: `Team ${teamRunId} exceeded max_wall_clock_minutes (${teamConfig.max_wall_clock_minutes}).` })
		}
		return { name: identity.name, role: identity.role, record, runtime }
	}

	async function setMemberStatus(runId: string, memberName: string, status: RuntimeState["members"][number]["status"]): Promise<void> {
		await transitionRuntimeState(runId, (runtime) => ({
			...runtime,
			members: runtime.members.map((member) => member.name === memberName
				? { ...member, status: member.status === "shutdown_approved" ? member.status : status }
				: member),
		}), teamConfig)
	}

	async function releaseSlot(runId: string, sessionID: string): Promise<void> {
		const control = controlFor(runId)
		if (!control.active.delete(sessionID)) return
		control.executionStarted.delete(sessionID)
		control.idleBaselines.delete(sessionID)
		void pump(runId)
	}

	function waitForIdle(runId: string, memberName: string, sessionID: string, baselineIdle?: number, recovery = false): Promise<void> {
		const control = controlFor(runId)
		const settleKey = `${sessionID}:${recovery ? "recovery" : baselineIdle ?? "unknown"}`
		const existing = control.settling.get(settleKey)
		if (existing) return existing
		const pending = (async () => {
			await ctx.session.wait({ sessionID }, { signal: eventController.signal })
			if (disposed || eventController.signal.aborted) return
			const session = await ctx.session.get({ sessionID })
			if (recovery && session.outcome === undefined) {
				// An unmanaged host leaves an orphaned turn without an outcome; keep the slot and let the
				// recovery resume (or a host-resumed execution) settle it against this idle baseline.
				control.idleBaselines.set(sessionID, sessionIdleTime(session) ?? 0)
				return
			}
			if (!recovery && (control.idleBaselines.get(sessionID) !== baselineIdle ||
				!isNewerTeamExecutionIdle(baselineIdle, session.time.idle))) return
			await setMemberStatus(runId, memberName, terminalMemberStatus(session.outcome))
			await releaseSlot(runId, sessionID)
		})().catch((error) => {
			if (!eventController.signal.aborted) log("[v2 team] native member idle reconciliation failed", {
				runId,
				memberName,
				sessionID,
				error: error instanceof Error ? error.message : String(error),
			})
		}).finally(() => {
			control.settling.delete(settleKey)
		})
		control.settling.set(settleKey, pending)
		return pending
	}

	/** Provider catalogs can still be loading right after boot; recovered launches wait for them briefly. */
	async function resolveMemberModel(route: ReturnType<typeof memberAgent>, leadSessionID: string, control: RunControl, signal?: AbortSignal) {
		while (true) {
			try {
				return await resolveV2ManagedAgentModelChoice(ctx, omoConfig, route.agentID, leadSessionID, route.categoryName)
			} catch (error) {
				if (Date.now() - bootAt >= BOOT_CATALOG_GRACE_MS || disposed || control.closing || signal?.aborted) throw error
				await new Promise((resolve) => setTimeout(resolve, 1_000))
			}
		}
	}

	async function launchMember(record: V2TeamMembershipRecord, member: Member, signal?: AbortSignal): Promise<string> {
		if (!dependencies) throw new Error("Team manager has not started.")
		const control = controlFor(record.teamRunId)
		if (control.closing || signal?.aborted) throw new ToolError({ message: `Team ${record.teamRunId} is shutting down; member launch cancelled.` })
		control.reserved += 1
		let ticket: Awaited<ReturnType<V2BackgroundAdmission["acquire"]>> | undefined
		let childID: string | undefined
		let reservationHeld = true
		try {
			const route = memberAgent(member)
			await validateMemberLaunch(ctx, omoConfig, record.leadSessionID, member)
			const choice = await resolveMemberModel(route, record.leadSessionID, control, signal)
			ticket = await dependencies.admission.acquire({
				parentSessionID: record.leadSessionID,
				model: { providerID: choice.model.providerID, id: choice.model.id },
				mode: "new",
				signal,
			})
			if (control.closing || signal?.aborted) throw new ToolError({ message: `Team ${record.teamRunId} is shutting down; member launch cancelled.` })
			await ticket.beginCreate()
			const blocked = route.categoryName
				? actionAliases(omoConfig.categories?.[route.categoryName]?.tools)
				: []
			const session = await ctx.session.create({
				title: `${record.teamName} / ${member.name}`,
				agent: route.agentID,
				model: choice.model,
				location: { directory: String(ctx.location.directory) },
				metadata: { omoTeam: { version: 1, teamRunId: record.teamRunId, memberName: member.name, leadSessionID: record.leadSessionID } },
				permissions: nativePermissions(blocked),
			})
			childID = session.id
			if (control.closing || signal?.aborted) throw new ToolError({ message: `Team ${record.teamRunId} is shutting down; member launch cancelled.` })
			if (session.parentID || session.projectID !== ctx.location.project.id || canonical(session.location.directory) !== canonical(String(ctx.location.directory))) {
				throw new Error(`Native Team session ${session.id} does not match the managed project/location or has a native parent.`)
			}
			await transitionRuntimeState(record.teamRunId, (current) => ({
				...current,
				members: current.members.map((entry) => entry.name === member.name
					? { ...entry, sessionId: session.id, status: "running", subagent_type: route.agentID, ...(route.categoryName ? { category: route.categoryName } : {}), model: settingsModel(choice.model, choice.settings) }
					: entry),
			}), teamConfig)
			await membership.bindSession({ teamRunId: record.teamRunId, memberName: member.name, sessionID: session.id })
			await dependencies.runs.recordLaunch(session.id, {
				parentSessionID: record.leadSessionID,
				startedAt: Date.now(),
				status: "running",
				blockedActions: [...new Set([...blocked, "question", "team_create", "subagent", "task", "call_omo_agent"])],
			})
			await ticket.bind(session.id)
			await settings.write({
				sessionID: session.id,
				parentSessionID: record.leadSessionID,
				agentID: route.agentID,
				model: choice.model,
				settings: choice.settings,
			})
			const beforePrompt = await ctx.session.get({ sessionID: session.id })
			// A just-created, never-executed session may not have an idle timestamp
			// yet. Its first successful execution advances the native projector's
			// idle marker above zero. Resumes still require an existing finite marker.
			const baselineIdle = sessionIdleTime(beforePrompt) ?? 0
			control.idleBaselines.set(session.id, baselineIdle)
			control.executionStarted.delete(session.id)
			if (control.closing || signal?.aborted) throw new ToolError({ message: `Team ${record.teamRunId} is shutting down; member launch cancelled.` })
			const modelText = `${choice.model.providerID}/${choice.model.id}${choice.model.variant ? `#${choice.model.variant}` : ""}`
			const prompt = buildV2TeamMemberPrompt({ spec: record.spec, member, teamRunId: record.teamRunId, model: choice.model })
			const append = route.categoryName ? categoryAppend(omoConfig, route.categoryName, modelText, String(ctx.location.directory)) : undefined
			const text = append ? `${prompt}\n\n# Category instructions\n${append}` : prompt
			control.active.add(session.id)
			control.reserved = Math.max(0, control.reserved - 1)
			reservationHeld = false
			await ctx.session.prompt({ sessionID: session.id, text, delivery: "queue" })
			void pump(record.teamRunId)
			return session.id
		} catch (error) {
			if (reservationHeld) control.reserved = Math.max(0, control.reserved - 1)
			if (childID && !reservationHeld) {
				const released = ticket ? await ticket.rollback({ executionSettled: true }).catch(() => false) : false
				if (released) control.active.delete(childID)
				else control.active.add(childID)
			}
			else if (ticket) {
				await ticket.rollback({ executionSettled: true }).catch(() => false)
			}
			await transitionRuntimeState(record.teamRunId, (current) => ({
				...current,
				members: current.members.map((entry) => entry.name === member.name ? { ...entry, ...(childID ? { sessionId: childID } : {}), status: "errored" } : entry),
			}), teamConfig).catch(() => undefined)
			throw error
		}
	}

	async function startWakeup(record: V2TeamMembershipRecord, memberName: string): Promise<boolean> {
		const control = controlFor(record.teamRunId)
		if (control.closing || control.controller.signal.aborted) return false
		const runtime = await loadRuntimeState(record.teamRunId, teamConfig)
		const member = runtime.members.find((candidate) => candidate.name === memberName)
		if (!member?.sessionId) return false
		const isLead = member.agentType === "leader"
		const alreadyActive = isLead || control.active.has(member.sessionId)
		if (!alreadyActive) control.reserved += 1
		let reservationHeld = !alreadyActive
		let ticket: Awaited<ReturnType<V2BackgroundAdmission["acquire"]>> | undefined
		let deliveryAttempted = false
		try {
			const messages = await listUnreadMessages(record.teamRunId, memberName, teamConfig)
			if (messages.length === 0) {
				if (reservationHeld) control.reserved = Math.max(0, control.reserved - 1)
				return true
			}
			if (!alreadyActive) {
				if (!dependencies) throw new Error("Team manager has not started.")
				const nativeSession = await ctx.session.get({ sessionID: member.sessionId })
				const model = member.model
					? { providerID: member.model.providerID, id: member.model.modelID }
					: nativeSession.model
				if (!model) throw new Error(`Team member ${memberName} has no persisted or native model for mailbox wakeup.`)
				ticket = await dependencies.admission.acquire({
					parentSessionID: record.leadSessionID,
					model: { providerID: model.providerID, id: model.id },
					mode: "resume",
					sessionID: member.sessionId,
					signal: control.controller.signal,
				})
				await ticket.beginCreate()
				const previousRun = await dependencies.runs.get(member.sessionId)
				await dependencies.runs.recordLaunch(member.sessionId, {
					parentSessionID: record.leadSessionID,
					startedAt: Date.now(),
					status: "running",
					blockedActions: previousRun?.blockedActions ?? ["question", "team_create", "subagent", "task", "call_omo_agent"],
				})
				await ticket.bind(member.sessionId)
				control.active.add(member.sessionId)
				control.reserved = Math.max(0, control.reserved - 1)
				reservationHeld = false
				await transitionRuntimeState(record.teamRunId, (current) => ({
					...current,
					members: current.members.map((entry) => entry.name === memberName ? { ...entry, status: "running" } : entry),
				}), teamConfig)
			}
			if (!alreadyActive && messages.length > 0) {
				const beforeSynthetic = await ctx.session.get({ sessionID: member.sessionId })
				const baselineIdle = sessionIdleTime(beforeSynthetic)
				if (baselineIdle === undefined) {
					throw new Error(`Native Team session ${member.sessionId} did not expose an idle baseline before mailbox delivery.`)
				}
				control.idleBaselines.set(member.sessionId, baselineIdle)
				control.executionStarted.delete(member.sessionId)
			}
			for (const message of messages) {
				const promptID = stableV2TeamMailboxPromptId(record.teamRunId, memberName, message.messageId)
				await membership.admitSyntheticTurn(member.sessionId, promptID, teamConfig.max_member_turns)
				deliveryAttempted = true
				await ctx.session.synthetic({
					sessionID: member.sessionId,
					id: promptID,
					text: `Team mailbox update:\n\n${buildEnvelope(message)}`,
					description: `Team message ${message.messageId}`,
					metadata: { omoTeam: { teamRunId: record.teamRunId, memberName, messageID: message.messageId } },
					delivery: "queue",
					resume: true,
				})
				await ackMessages(record.teamRunId, memberName, [message.messageId], teamConfig)
			}
			control.wakeupRetryAttempts.delete(memberName)
			return true
		} catch (error) {
			if (reservationHeld) control.reserved = Math.max(0, control.reserved - 1)
			if (ticket && !deliveryAttempted) {
				const released = await ticket.rollback({ executionSettled: true }).catch(() => false)
				if (released) control.active.delete(member.sessionId)
				else control.active.add(member.sessionId)
			} else if (deliveryAttempted) {
				// Once a synthetic prompt may have been accepted, keep the bound lease
				// and unread mailbox record fail-closed for event/wait reconciliation.
				control.active.add(member.sessionId)
			}
			throw error
		}
	}

	async function pump(runId: string): Promise<void> {
		const control = controlFor(runId)
		if (disposed || !started || control.closing) return
		if (control.pumping) {
			control.pumpAgain = true
			return control.pumping
		}
		control.pumping = (async () => {
			const record = await membership.recordForRun(runId)
			if (!record || record.closedAt !== null) return
			const runtime = await loadRuntimeState(runId, teamConfig)
			if (runtime.status !== "active" && runtime.status !== "shutdown_requested") return
			if (Date.now() - runtime.createdAt > teamConfig.max_wall_clock_minutes * 60_000) return
			while (!disposed && !control.closing) {
				if (control.pendingMembers.length > 0 && control.active.size + control.reserved < teamConfig.max_parallel_members) {
					const memberName = control.pendingMembers.shift()!
					const member = record.spec.members.find((entry) => entry.name === memberName)
					if (!member) throw new Error(`Team ${runId} lost pending member ${memberName} from its persisted spec.`)
					control.launchingMembers.add(memberName)
					const launched = launchMember(record, member, control.controller.signal)
					const tracked = launched.then(() => undefined).catch((error) => {
						log("[v2 team] queued member launch failed", { runId, memberName, error: error instanceof Error ? error.message : String(error) })
					}).finally(() => {
						control.launchingMembers.delete(memberName)
						control.launches.delete(tracked)
						void pump(runId)
					})
					control.launches.add(tracked)
					continue
				}
				const capacityAvailable = control.active.size + control.reserved < teamConfig.max_parallel_members
				const wakeup = [...control.pendingWakeups].find((name) => {
					if (control.launchingMembers.has(name)) return false
					if (control.wakeupRetryTimers.has(name)) return false
					const candidate = runtime.members.find((member) => member.name === name)
					if (!candidate?.sessionId) return false
					return candidate.agentType === "leader" || control.active.has(candidate.sessionId) || capacityAvailable
				})
				if (!wakeup) return
				const runtimeMember = runtime.members.find((member) => member.name === wakeup)!
				control.pendingWakeups.delete(wakeup)
				control.launchingMembers.add(wakeup)
				const waking = startWakeup(record, wakeup)
				const tracked = waking.then((delivered) => {
					if (!delivered) {
						control.pendingWakeups.add(wakeup)
						scheduleWakeRetry(runId, wakeup, control)
					} else {
						clearWakeRetry(control, wakeup)
					}
				}).catch((error) => {
					log("[v2 team] member wake failed", { runId, memberName: wakeup, error: error instanceof Error ? error.message : String(error) })
					if (error instanceof V2TeamMembershipError && /max_member_turns/.test(error.message)) {
						clearWakeRetry(control, wakeup)
						void setMemberStatus(runId, wakeup, "errored").catch((statusError) => log("[v2 team] could not stop over-quota member", statusError))
					} else {
						control.pendingWakeups.add(wakeup)
						scheduleWakeRetry(runId, wakeup, control)
					}
				}).finally(() => {
					control.launchingMembers.delete(wakeup)
					control.launches.delete(tracked)
					void pump(runId)
				})
				control.launches.add(tracked)
				// Leads and already-active members do not consume another member slot.
				if (runtimeMember.agentType === "leader" || control.active.has(runtimeMember.sessionId!)) continue
				if (control.active.size + control.reserved >= teamConfig.max_parallel_members) return
			}
		})().catch((error) => {
			if (!disposed && !control.closing) log("[v2 team] member pump failed", {
				runId,
				error: error instanceof Error ? error.message : String(error),
			})
		}).finally(() => {
			control.pumping = undefined
			if (control.pumpAgain && !disposed && !control.closing) {
				control.pumpAgain = false
				void pump(runId)
			}
		})
		return control.pumping
	}

	async function memberForSession(sessionID: string): Promise<{ record: V2TeamMembershipRecord; member: V2TeamMembershipRecord["members"][number] } | undefined> {
		const membershipResult = await membership.sessionMembership(sessionID)
		if (!membershipResult || membershipResult.record.closedAt !== null) return undefined
		return { record: membershipResult.record, member: membershipResult.member }
	}

	async function onExecutionEvent(event: ExecutionEvent): Promise<void> {
		if (!eventMatchesLocation(event, ctx)) return
		const sessionID = event.data?.sessionID
		if (!sessionID) return
		const found = await memberForSession(sessionID)
		if (!found || found.member.role === "lead") return
		const control = controlFor(found.record.teamRunId)
		if (event.type === "session.execution.started") {
			startedSinceBoot.add(sessionID)
			control.executionStarted.add(sessionID)
			control.active.add(sessionID)
			await setMemberStatus(found.record.teamRunId, found.member.name, "running")
		} else {
			if (!control.executionStarted.has(sessionID)) return
			const baselineIdle = control.idleBaselines.get(sessionID)
			void waitForIdle(found.record.teamRunId, found.member.name, sessionID, baselineIdle)
		}
	}

	async function watchEvents(): Promise<void> {
		while (!disposed && !eventController.signal.aborted) {
			try {
				for await (const event of ctx.event.subscribe({ signal: eventController.signal })) {
					if (disposed || eventController.signal.aborted) return
					if (!isExecutionEvent(event) || !eventMatchesLocation(event, ctx)) continue
					try {
						await onExecutionEvent(event)
					} catch (error) {
						log("[v2 team] native session event could not be reconciled", {
							type: event.type,
							sessionID: event.data?.sessionID,
							error: error instanceof Error ? error.message : String(error),
						})
					}
				}
				if (eventController.signal.aborted) return
				throw new Error("Native session event stream ended unexpectedly.")
			} catch (error) {
				if (eventController.signal.aborted || disposed) return
				log("[v2 team] native session event stream disconnected; reconnecting", error)
				await new Promise<void>((resolve) => {
					const onAbort = () => {
						clearTimeout(timer)
						eventController.signal.removeEventListener("abort", onAbort)
						resolve()
					}
					const timer = setTimeout(() => {
						eventController.signal.removeEventListener("abort", onAbort)
						resolve()
					}, 250)
					eventController.signal.addEventListener("abort", onAbort, { once: true })
				})
			}
		}
	}

	async function makeSpec(raw: z.infer<typeof createInput>, sessionID: string): Promise<TeamSpec> {
		const current = await ctx.session.get({ sessionID })
		if (raw.leadSessionId && raw.leadSessionId !== sessionID) throw new ToolError({ message: "leadSessionId must match the calling native session." })
		const caller = agentLead(current.agent)
		if (raw.teamName) return loadTeamSpec(raw.teamName, teamConfig, String(ctx.location.directory), { callerTeamLead: caller })
		const categories = Object.keys(omoConfig.categories ?? {})
		const defaultCategoryName = categories.find((name) => omoConfig.categories?.[name]?.disable !== true) ?? Object.keys(DEFAULT_CATEGORIES)[0]
		let value: unknown = raw.inline_spec
		if (typeof value === "string") {
			try { value = JSON.parse(value) } catch (error) { throw new ToolError({ message: `inline_spec is not valid JSON: ${error instanceof Error ? error.message : String(error)}` }) }
		}
		const normalized = normalizeTeamSpecInput(value, { callerTeamLead: caller, defaultCategoryName })
		const parsed = TeamSpecSchema.safeParse(normalized)
		if (!parsed.success) throw new ToolError({ message: `Invalid inline_spec: ${parsed.error.issues.slice(0, 5).map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}` })
		validateSpec(parsed.data)
		if (parsed.data.members.length > teamConfig.max_members) throw new ToolError({ message: `Team exceeds max_members (${teamConfig.max_members}).` })
		return parsed.data
	}

	async function createRun(sessionID: string, raw: z.infer<typeof createInput>): Promise<{ teamRunId: string; state: RuntimeState }> {
		const existingMembership = await membership.sessionMembership(sessionID)
		if (existingMembership && existingMembership.member.role !== "lead" && existingMembership.record.closedAt === null) {
			throw new ToolError({ message: "Nested Team creation is not allowed from a Team member session." })
		}
		const spec = await makeSpec(raw, sessionID)
		if (spec.members.length > teamConfig.max_members) throw new ToolError({ message: `Team exceeds max_members (${teamConfig.max_members}).` })
		const current = await ctx.session.get({ sessionID })
		if (!current.agent) throw new ToolError({ message: `The calling session ${sessionID} has no native agent identity.` })
		const leadName = spec.leadAgentId
		if (!leadName) throw new ToolError({ message: "TeamSpec must identify a lead member." })
		await preflightRoster(ctx, omoConfig, spec, leadName, sessionID)
		let runtime = await createRuntimeState(spec, sessionID, "project", teamConfig)
		runtime = await transitionRuntimeState(runtime.teamRunId, (value) => ({
			...value,
			status: "active",
			members: value.members.map((member) => member.name === leadName
				? { ...member, sessionId: sessionID, status: "running", subagent_type: current.agent, agentType: "leader" }
				: member),
		}), teamConfig)
		await membership.registerRun({
			teamRunId: runtime.teamRunId,
			teamName: spec.name,
			spec,
			leadSessionID: sessionID,
			leadMemberName: leadName,
			memberNames: spec.members.map((member) => member.name),
		})
		const control = controlFor(runtime.teamRunId)
		control.pendingMembers = spec.members.filter((member) => member.name !== leadName).map((member) => member.name)
		scheduleWallClock(runtime.teamRunId, runtime.createdAt)
		return { teamRunId: runtime.teamRunId, state: runtime }
	}

	function scheduleWallClock(teamRunId: string, createdAt: number): void {
		const previous = wallClockTimers.get(teamRunId)
		if (previous) clearTimeout(previous)
		const expiresAt = createdAt + teamConfig.max_wall_clock_minutes * 60_000
		const timer = setTimeout(() => {
			void (async () => {
				const runtime = await loadRuntimeState(teamRunId, teamConfig).catch(() => undefined)
				if (!runtime || runtime.status !== "active" && runtime.status !== "shutdown_requested") return
				const sessions = runtime.members.filter((member) => member.agentType !== "leader" && member.sessionId && member.status === "running")
				for (const member of sessions) await ctx.session.interrupt({ sessionID: member.sessionId! }).catch(() => undefined)
			})().catch((error) => log("[v2 team] wall-clock enforcement failed", { teamRunId, error: error instanceof Error ? error.message : String(error) }))
		}, Math.max(0, expiresAt - Date.now()))
		wallClockTimers.set(teamRunId, timer)
	}

	async function deleteRun(actor: Actor, force: boolean | undefined, signal: AbortSignal): Promise<void> {
		if (actor.role !== "lead") throw new ToolError({ message: "team_delete is lead-only." })
		const control = controlFor(actor.record.teamRunId)
		const queuedWork = control.pendingMembers.length > 0 || control.reserved > 0 || control.launches.size > 0
		const nonLead = actor.runtime.members.filter((member) => member.agentType !== "leader")
		const running = nonLead.filter((member) => member.sessionId && ["pending", "running", "idle"].includes(member.status))
		if ((running.length > 0 || queuedWork) && force !== true) {
			throw new ToolError({ message: "Team members or queued launches are still active; finish or approve shutdown before deleting, or use force=true." })
		}
		control.closing = true
		control.pendingMembers = []
		control.pendingWakeups.clear()
		cancelWakeRetries(control)
		control.controller.abort(new Error("Team is being deleted."))
		if (force === true && control.launches.size > 0) await Promise.allSettled([...control.launches])
		const latest = await loadRuntimeState(actor.record.teamRunId, teamConfig)
		const latestNonLead = latest.members.filter((member) => member.agentType !== "leader")
		const descendants = new Set<string>()
		const collect = async (parent: string): Promise<void> => {
			for (const child of await dependencies!.runs.children(parent)) {
				if (descendants.has(child)) continue
				descendants.add(child)
				await collect(child)
			}
		}
		for (const member of latestNonLead) if (member.sessionId) await collect(member.sessionId)
		const all = [...new Set([
			...(force === true
				? latestNonLead.flatMap((member) => member.sessionId ? [member.sessionId] : [])
				: running.flatMap((member) => member.sessionId ? [member.sessionId] : [])),
			...descendants,
		])]
		if (force === true) {
			for (const sessionID of all) await ctx.session.interrupt({ sessionID }).catch(() => undefined)
		}
		for (const sessionID of all) {
			if (signal.aborted) throw signal.reason ?? new Error("Team deletion was cancelled.")
			await ctx.session.wait({ sessionID }, { signal })
		}
		await transitionRuntimeState(actor.record.teamRunId, (current) => ({
			...current,
			status: "deleting",
			members: current.members.map((member) => member.agentType === "leader" ? member : { ...member, status: "completed" }),
		}), teamConfig)
		await membership.closeRun(actor.record.teamRunId)
		await transitionRuntimeState(actor.record.teamRunId, (current) => ({ ...current, status: "deleted" }), teamConfig)
		const timer = wallClockTimers.get(actor.record.teamRunId)
		if (timer) clearTimeout(timer)
		wallClockTimers.delete(actor.record.teamRunId)
	}

	function disableIfConfigured(editor: ToolEditor, toolName: string): boolean {
		if (omoConfig.disabled_tools?.some((name) => name.trim().toLowerCase() === toolName)) {
			editor.remove(toolName)
			return true
		}
		return false
	}

	function createTools(editor: ToolEditor): void {
		if (!dependencies || !started || disposed) throw new Error("Team tools cannot be registered before manager start.")
		const add = <Input extends z.ZodTypeAny>(
			name: string,
			description: string,
			input: Input,
			execute: (args: z.infer<Input>, context: ToolContext) => Promise<string>,
		) => {
			if (disableIfConfigured(editor, name)) return
			addV2Tool(editor, {
				name,
				description,
				input,
				options: { codemode: false },
				execute: async (args, context) => {
					try {
						return { content: await execute(args as z.infer<Input>, context) }
					} catch (error) {
						const toolError = asNativeTeamToolError(error)
						if (toolError) throw toolError
						throw error
					}
				},
			})
		}
		add("team_create", "Create a coordinated team using a declared teamName or inline TeamSpec. Team members are native OpenCode sessions.", createInput, async (args, context) => {
			const created = await createRun(context.sessionID, args as z.infer<typeof createInput>)
			const control = controlFor(created.teamRunId)
			void pump(created.teamRunId)
			return JSON.stringify({
				teamRunId: created.teamRunId,
				teamName: created.state.teamName,
				members: created.state.members.filter((member) => member.name !== created.state.members.find((entry) => entry.agentType === "leader")?.name)
					.map((member) => ({ name: member.name, status: member.status })),
				queued: control.pendingMembers.length,
				message: "The Team run was created and member launches are queued; use team_status to observe progress.",
			})
		})
		add("team_delete", "Delete a finished team run. force=true interrupts native member and descendant sessions before retaining an ancestry tombstone.", deleteInput, async (args, context) => {
			const actor = await requireActor(args.teamRunId, context.sessionID)
			await deleteRun(actor, args.force, context.signal)
			return JSON.stringify({ teamRunId: args.teamRunId, deleted: true, ancestryRetained: true })
		})
		add("team_shutdown_request", "Request a member shutdown; the team lead controls requests.", runIdInput.extend({ targetMemberName: z.string().min(1) }), async (args, context) => {
			const actor = await requireActor(args.teamRunId, context.sessionID)
			if (actor.role !== "lead") throw new ToolError({ message: "team_shutdown_request is lead-only." })
			await shutdownRequest(actor, args.targetMemberName)
			controlFor(args.teamRunId).pendingWakeups.add(args.targetMemberName)
			await pump(args.teamRunId)
			return JSON.stringify({ teamRunId: args.teamRunId, targetMemberName: args.targetMemberName, status: "shutdown_requested" })
		})
		add("team_approve_shutdown", "Approve a pending shutdown request for yourself or as team lead.", shutdownMemberInput, async (args, context) => {
			const actor = await requireActor(args.teamRunId, context.sessionID)
			if (actor.role !== "lead" && actor.name !== args.memberName) throw new ToolError({ message: "Only the target member or team lead can approve shutdown." })
			await approveMemberShutdown(actor, args.memberName)
			for (const member of actor.runtime.members) controlFor(args.teamRunId).pendingWakeups.add(member.name)
			const target = actor.runtime.members.find((member) => member.name === args.memberName)
			if (target?.sessionId) await ctx.session.interrupt({ sessionID: target.sessionId })
			await pump(args.teamRunId)
			return JSON.stringify({ teamRunId: args.teamRunId, memberName: args.memberName, status: "shutdown_approved" })
		})
		add("team_reject_shutdown", "Reject a pending shutdown request for yourself or as team lead.", shutdownRejectInput, async (args, context) => {
			const actor = await requireActor(args.teamRunId, context.sessionID)
			if (actor.role !== "lead" && actor.name !== args.memberName) throw new ToolError({ message: "Only the target member or team lead can reject shutdown." })
			await rejectMemberShutdown(actor, args.memberName, args.reason)
			for (const member of actor.runtime.members) controlFor(args.teamRunId).pendingWakeups.add(member.name)
			await pump(args.teamRunId)
			return JSON.stringify({ teamRunId: args.teamRunId, memberName: args.memberName, status: "shutdown_rejected", reason: args.reason })
		})
		add("team_send_message", "Send a durable mailbox message to a Team member or broadcast to active and queued members.", sendInput, async (args, context) => {
			const actor = await requireActor(args.teamRunId, context.sessionID)
			const runtime = actor.runtime
			const message = MessageSchema.parse({ version: 1, messageId: stableToolMessageId(args.teamRunId, context.id), from: actor.name, to: args.to, body: args.body, kind: args.kind ?? "message", timestamp: Date.now(), correlationId: args.correlationId, summary: args.summary, references: args.references })
			await membership.reserveMessage(args.teamRunId, teamConfig.max_messages_per_run, `tool:${context.id}`)
			const leader = runtime.members.find((member) => member.agentType === "leader")?.name
			const sent = await sendMessage(message, args.teamRunId, teamConfig, { isLead: actor.role === "lead", activeMembers: activeRecipients(runtime), leadRecipient: leader })
			const control = controlFor(args.teamRunId)
			for (const name of sent.deliveredTo) if (name !== actor.name) control.pendingWakeups.add(name)
			await pump(args.teamRunId)
			return JSON.stringify({ ...sent, queuedForLiveDelivery: sent.deliveredTo })
		})
		add("team_task_create", "Create a task in the Team's shared dependency-aware task list.", taskCreateInput, async (args, context) => {
			await requireActor(args.teamRunId, context.sessionID)
			const task = await createTask(args.teamRunId, { subject: args.subject, description: args.description, status: "pending", blocks: [], blockedBy: args.blockedBy ?? [] }, teamConfig)
			return JSON.stringify({ taskId: task.id, task })
		})
		add("team_task_list", "List Team tasks, optionally filtered by status and owner.", taskListInput, async (args, context) => {
			await requireActor(args.teamRunId, context.sessionID)
			return JSON.stringify({ tasks: await listTasks(args.teamRunId, teamConfig, { status: args.status as Task["status"] | undefined, owner: args.owner }) })
		})
		add("team_task_update", "Claim or update a Team task. Only the lead may claim a pending task for another verified member; existing task ownership cannot be reassigned.", taskUpdateInput, async (args, context) => {
			const actor = await requireActor(args.teamRunId, context.sessionID)
			const taskBefore = await getTask(args.teamRunId, args.taskId, teamConfig)
			const plan = planV2TeamTaskUpdate({
				actorName: actor.name,
				actorRole: actor.role,
				task: taskBefore,
				status: args.status as Task["status"],
				requestedOwner: args.owner,
				memberNames: new Set(actor.record.members.map((member) => member.name)),
			})
			const task = plan.kind === "claim"
				? await claimTask(args.teamRunId, args.taskId, plan.memberName, teamConfig)
				: await updateTaskStatus(args.teamRunId, args.taskId, args.status as Task["status"], plan.memberName, teamConfig)
			return JSON.stringify({ task })
		})
		add("team_task_get", "Get one Team task and its dependency state.", taskGetInput, async (args, context) => {
			await requireActor(args.teamRunId, context.sessionID)
			return JSON.stringify({ task: await getTask(args.teamRunId, args.taskId, teamConfig) })
		})
		add("team_status", "Show the current Team members, tasks, unread mailbox counts, and lifecycle state.", runIdInput, async (args, context) => {
			const actor = await requireActor(args.teamRunId, context.sessionID)
			const tasks = await listTasks(args.teamRunId, teamConfig)
			const unread = await Promise.all(actor.runtime.members.map(async (member) => [member.name, (await listUnreadMessages(args.teamRunId, member.name, teamConfig)).length] as const))
			return JSON.stringify({ runtimeState: actor.runtime, tasks, unreadMessages: Object.fromEntries(unread) })
		})
		add("team_list", "List configured TeamSpecs and active Team runs in this native project location.", z.object({ scope: z.enum(["user", "project", "all"]).optional() }), async (args, context) => {
			const session = await ctx.session.get({ sessionID: context.sessionID })
			if (session.projectID !== ctx.location.project.id || canonical(session.location.directory) !== canonical(String(ctx.location.directory))) throw new ToolError({ message: "Current session is outside this project location." })
			const declared = await loadAllTeamSpecs(teamConfig, String(ctx.location.directory))
			const filteredDeclared = args.scope === "all" || args.scope === undefined ? declared : declared.filter((entry) => entry.scope === args.scope)
			const running = await membership.listForLocation()
			return JSON.stringify({ declared: filteredDeclared.map((entry) => ({ name: entry.name, scope: entry.scope, valid: entry.spec !== undefined, error: entry.error?.message })), activeRuns: await Promise.all(running.map(async (record) => ({ teamRunId: record.teamRunId, teamName: record.teamName, runtime: await loadRuntimeState(record.teamRunId, teamConfig) }))) })
		})
	}

	return {
		resolveLogicalParent: (sessionID) => membership.resolveLogicalParent(sessionID),
		async start(input) {
			if (disposed) throw new Error("Team manager is disposed.")
			if (started) throw new Error("Team manager has already started.")
			dependencies = input
			registrations.push(await ctx.session.hook("prompt", async (event) => {
				const found = await memberForSession(event.sessionID)
				if (!found || found.member.role === "lead") return
				const runtime = await loadRuntimeState(found.record.teamRunId, teamConfig)
				if (Date.now() - runtime.createdAt > teamConfig.max_wall_clock_minutes * 60_000) throw new ToolError({ message: `Team ${found.record.teamRunId} exceeded its wall-clock limit.` })
				await membership.incrementTurnCount(event.sessionID, teamConfig.max_member_turns)
			}))
			started = true
			bootAt = Date.now()
			eventLoop = watchEvents()
			const records = await membership.listForLocation()
			for (const record of records) {
				const runtime = await loadRuntimeState(record.teamRunId, teamConfig)
				if (runtime.status !== "active" && runtime.status !== "shutdown_requested") continue
				scheduleWallClock(record.teamRunId, runtime.createdAt)
				const control = controlFor(record.teamRunId)
				for (const item of runtime.members) {
					if (item.agentType === "leader") continue
					if (!item.sessionId && item.status === "pending") control.pendingMembers.push(item.name)
					if (item.sessionId && item.status === "running") {
						control.active.add(item.sessionId)
						control.executionStarted.add(item.sessionId)
						void waitForIdle(record.teamRunId, item.name, item.sessionId, undefined, true)
						const sessionID = item.sessionId
						const memberName = item.name
						// A managed host resumes orphaned turns at boot; an unmanaged `serve` does not, and the
						// member would hold its slot forever. Resume it once if no execution starts meanwhile.
						recoveryTimers.push(setTimeout(() => {
							if (disposed || control.closing || startedSinceBoot.has(sessionID) || !control.active.has(sessionID)) return
							log("[v2 team] resuming a member whose turn was orphaned by a restart", { runId: record.teamRunId, memberName, sessionID })
							void ctx.session.prompt({ sessionID: sessionID as Parameters<Plugin.Context["session"]["prompt"]>[0]["sessionID"], text: RECOVERY_RESUME_TEXT, delivery: "queue" })
								.catch((error) => log("[v2 team] orphaned member resume failed", { sessionID, error: error instanceof Error ? error.message : String(error) }))
						}, RECOVERY_RESUME_GRACE_MS))
					}
					if (item.sessionId && item.status !== "errored" && item.status !== "completed") {
						const unread = await listUnreadMessages(record.teamRunId, item.name, teamConfig).catch((error) => {
							log("[v2 team] recovery could not inspect member mailbox", { runId: record.teamRunId, memberName: item.name, error: error instanceof Error ? error.message : String(error) })
							return []
						})
						if (unread.length > 0) control.pendingWakeups.add(item.name)
					}
				}
				void pump(record.teamRunId)
			}
		},
		createTools,
		async dispose() {
			if (disposed) return
			disposed = true
			const failures: unknown[] = []
			for (const control of controls.values()) {
				control.closing = true
				control.pendingMembers = []
				control.pendingWakeups.clear()
				cancelWakeRetries(control)
				control.controller.abort(new Error("Team manager disposed."))
			}
			eventController.abort(new Error("Team manager disposed."))
			for (const timer of recoveryTimers) clearTimeout(timer)
			recoveryTimers.length = 0
			for (const timer of wallClockTimers.values()) clearTimeout(timer)
			wallClockTimers.clear()
			for (const registration of registrations.reverse()) {
				try { await registration.dispose() } catch (error) { failures.push(error) }
			}
			const pending = [
				...(eventLoop ? [eventLoop] : []),
				...[...controls.values()].flatMap((control) => [
					...(control.pumping ? [control.pumping] : []),
					...control.launches,
					...control.settling.values(),
				]),
			]
			const settled = await Promise.allSettled(pending)
			for (const result of settled) if (result.status === "rejected") failures.push(result.reason)
			for (const control of controls.values()) {
				control.active.clear()
				control.reserved = 0
			}
			if (failures.length > 0) throw new AggregateError(failures, "One or more native Team resources failed to dispose.")
		},
	}
}
