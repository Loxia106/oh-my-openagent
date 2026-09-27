import { createHash } from "node:crypto"
import { realpath } from "node:fs/promises"
import { resolve } from "node:path"
import type { Plugin } from "@opencode/plugin"
import type { V2TodoItem } from "./task-state"

const STORAGE_PREFIX = "oh-my-openagent:v2:workflow-policy:v1:"
const MAX_TRACKED_SESSIONS = 512
const MAX_APPROVED_TASK_KEYS = 64

export const TODO_STAGNATION_LIMIT = 3
export const TODO_FAILURE_LIMIT = 5
export const TODO_COOLDOWN_MS = 5_000
export const TODO_FAILURE_RESET_MS = 5 * 60_000
export const ATLAS_NO_PROGRESS_LIMIT = 3
export const ATLAS_COOLDOWN_MS = 5_000

export type FinalWaveWait = {
	readonly workID: string
	readonly planPath: string
	readonly status: "approve" | "reject" | "missing"
	readonly expected: number
	readonly approvedTaskKeys: readonly string[]
}

export type WorkflowPolicyRecord = {
	readonly version: 1
	readonly scope: string
	readonly sessionID: string
	readonly stopped: boolean
	readonly todo: {
		readonly signature?: string
		readonly stagnationCount: number
		readonly awaitingProgress: boolean
		readonly consecutiveFailures: number
		readonly lastFailureAt?: number
		readonly lastDispatchAt?: number
	}
	readonly atlas: {
		readonly workID?: string
		readonly planPath?: string
		readonly fingerprint?: string
		readonly noProgressIterations: number
		readonly awaitingToolProgress: boolean
		readonly toolProgress: boolean
		readonly stalled: boolean
		readonly consecutiveFailures: number
		readonly lastFailureAt?: number
		readonly lastDispatchAt?: number
	}
	readonly finalWave?: FinalWaveWait
	readonly compactionPending: boolean
}

export type WorkflowPolicyStore = {
	readonly scope: string
	get(sessionID: string): Promise<WorkflowPolicyRecord>
	update(sessionID: string, updater: (previous: WorkflowPolicyRecord) => WorkflowPolicyRecord): Promise<WorkflowPolicyRecord>
	clear(sessionID: string): Promise<void>
	dispose(): Promise<void>
}

function finite(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value)
}

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

function boundedCount(value: unknown, max = 1_000_000): number {
	return finite(value) ? Math.max(0, Math.min(max, Math.floor(value))) : 0
}

function emptyRecord(scope: string, sessionID: string): WorkflowPolicyRecord {
	return {
		version: 1,
		scope,
		sessionID,
		stopped: false,
		todo: { stagnationCount: 0, awaitingProgress: false, consecutiveFailures: 0 },
		atlas: { noProgressIterations: 0, awaitingToolProgress: false, toolProgress: false, stalled: false, consecutiveFailures: 0 },
		compactionPending: false,
	}
}

function decodeWait(value: unknown): FinalWaveWait | undefined {
	if (!record(value) || typeof value.workID !== "string" || typeof value.planPath !== "string" ||
		(value.status !== "approve" && value.status !== "reject" && value.status !== "missing") || !finite(value.expected)) return undefined
	return {
		workID: value.workID,
		planPath: value.planPath,
		status: value.status,
		expected: Math.max(0, Math.floor(value.expected)),
		approvedTaskKeys: Array.isArray(value.approvedTaskKeys)
			? value.approvedTaskKeys.filter((key): key is string => typeof key === "string").slice(-MAX_APPROVED_TASK_KEYS)
			: [],
	}
}

function decodePolicy(value: unknown, scope: string, sessionID: string): WorkflowPolicyRecord {
	if (!record(value) || value.version !== 1 || value.scope !== scope || value.sessionID !== sessionID) return emptyRecord(scope, sessionID)
	const todo = record(value.todo) ? value.todo : {}
	const atlas = record(value.atlas) ? value.atlas : {}
	const optionalNumber = (candidate: unknown) => finite(candidate) ? candidate : undefined
	return {
		version: 1,
		scope,
		sessionID,
		stopped: value.stopped === true,
		todo: {
			...(typeof todo.signature === "string" ? { signature: todo.signature.slice(0, 16_384) } : {}),
			stagnationCount: boundedCount(todo.stagnationCount, TODO_STAGNATION_LIMIT),
			awaitingProgress: todo.awaitingProgress === true,
			consecutiveFailures: boundedCount(todo.consecutiveFailures, TODO_FAILURE_LIMIT),
			...(optionalNumber(todo.lastFailureAt) !== undefined ? { lastFailureAt: optionalNumber(todo.lastFailureAt) } : {}),
			...(optionalNumber(todo.lastDispatchAt) !== undefined ? { lastDispatchAt: optionalNumber(todo.lastDispatchAt) } : {}),
		},
		atlas: {
			...(typeof atlas.workID === "string" ? { workID: atlas.workID } : {}),
			...(typeof atlas.planPath === "string" ? { planPath: atlas.planPath } : {}),
			...(typeof atlas.fingerprint === "string" ? { fingerprint: atlas.fingerprint.slice(0, 128) } : {}),
			noProgressIterations: boundedCount(atlas.noProgressIterations, ATLAS_NO_PROGRESS_LIMIT),
			awaitingToolProgress: atlas.awaitingToolProgress === true,
			toolProgress: atlas.toolProgress === true,
			stalled: atlas.stalled === true,
			consecutiveFailures: boundedCount(atlas.consecutiveFailures, TODO_FAILURE_LIMIT),
			...(optionalNumber(atlas.lastFailureAt) !== undefined ? { lastFailureAt: optionalNumber(atlas.lastFailureAt) } : {}),
			...(optionalNumber(atlas.lastDispatchAt) !== undefined ? { lastDispatchAt: optionalNumber(atlas.lastDispatchAt) } : {}),
		},
		...(decodeWait(value.finalWave) ? { finalWave: decodeWait(value.finalWave) } : {}),
		compactionPending: value.compactionPending === true,
	}
}

/** Create durable workflow state scoped to the native project/workspace and session. */
export async function createV2WorkflowPolicyStore(ctx: Plugin.Context): Promise<WorkflowPolicyStore> {
	const directory = String(ctx.location.directory)
	const canonicalDirectory = await realpath(directory).catch(() => resolve(directory))
	const scope = createHash("sha256").update([
		String(ctx.location.project.id),
		String(ctx.location.workspaceID ?? ""),
		canonicalDirectory,
	].join("\0")).digest("hex")
	const queues = new Map<string, Promise<void>>()
	const recent = new Map<string, WorkflowPolicyRecord>()
	const keyFor = (sessionID: string) => `${STORAGE_PREFIX}${scope}:${encodeURIComponent(sessionID)}`

	async function serialize<T>(sessionID: string, operation: () => Promise<T>): Promise<T> {
		const previous = queues.get(sessionID) ?? Promise.resolve()
		let release!: () => void
		const gate = new Promise<void>((resolve) => { release = resolve })
		const tail = previous.catch(() => undefined).then(() => gate)
		queues.set(sessionID, tail)
		await previous.catch(() => undefined)
		try { return await operation() } finally {
			release()
			if (queues.get(sessionID) === tail) queues.delete(sessionID)
		}
	}

	function touch(sessionID: string, value: WorkflowPolicyRecord): void {
		recent.delete(sessionID)
		recent.set(sessionID, value)
		while (recent.size > MAX_TRACKED_SESSIONS) {
			const oldest = recent.keys().next().value
			if (oldest === undefined) break
			if (queues.has(oldest)) {
				const active = recent.get(oldest)
				recent.delete(oldest)
				if (active) recent.set(oldest, active)
				if ([...recent.keys()].every((candidate) => queues.has(candidate))) break
				continue
			}
			recent.delete(oldest)
		}
	}

	return {
		scope,
		async get(sessionID) {
			return serialize(sessionID, async () => {
				const value = decodePolicy(await ctx.storage.get(keyFor(sessionID)), scope, sessionID)
				touch(sessionID, value)
				return value
			})
		},
		async update(sessionID, updater) {
			return serialize(sessionID, async () => {
				const previous = recent.get(sessionID) ?? decodePolicy(await ctx.storage.get(keyFor(sessionID)), scope, sessionID)
				const next = decodePolicy(updater(previous), scope, sessionID)
				await ctx.storage.set(keyFor(sessionID), next)
				touch(sessionID, next)
				return next
			})
		},
		async clear(sessionID) {
			return serialize(sessionID, async () => {
				recent.delete(sessionID)
				await ctx.storage.remove(keyFor(sessionID))
			})
		},
		async dispose() {
			await Promise.all([...queues.values()].map((queue) => queue.catch(() => undefined)))
			recent.clear()
		},
	}
}

/** The legacy stagnation contract tracks todo status, never mutable prose or priority. */
export function todoStatusSignature(todos: readonly V2TodoItem[]): string {
	return todos.map((todo, index) => `${todo.id ?? `index:${index}`}=${todo.status}`).sort().join("\n")
}

export type TodoDispatchDecision = {
	readonly allowed: boolean
	readonly reason?: "complete" | "stagnant" | "failure-backoff" | "cooldown"
	readonly progressed: boolean
}

/** Update one completed turn's todo baseline and decide whether another nudge is safe. */
export function observeTodoTurn(
	state: WorkflowPolicyRecord["todo"],
	todos: readonly V2TodoItem[],
	now: number,
): { readonly state: WorkflowPolicyRecord["todo"]; readonly decision: TodoDispatchDecision } {
	const signature = todoStatusSignature(todos)
	const incomplete = todos.some((todo) => todo.status === "pending" || todo.status === "in_progress")
	const progressed = state.signature !== undefined && state.signature !== signature
	let stagnationCount = progressed ? 0 : state.stagnationCount
	if (!progressed && state.awaitingProgress) stagnationCount += 1
	let failures = state.consecutiveFailures
	if (failures >= TODO_FAILURE_LIMIT) {
		if (state.lastFailureAt !== undefined && now - state.lastFailureAt >= TODO_FAILURE_RESET_MS) failures = 0
		else return {
			state: { ...state, signature, awaitingProgress: false, stagnationCount },
			decision: { allowed: false, reason: "failure-backoff", progressed },
		}
	}
	if (!incomplete) return {
		state: { ...state, signature, awaitingProgress: false, stagnationCount: 0, consecutiveFailures: 0 },
		decision: { allowed: false, reason: "complete", progressed },
	}
	if (stagnationCount >= TODO_STAGNATION_LIMIT) return {
		state: { ...state, signature, awaitingProgress: false, stagnationCount },
		decision: { allowed: false, reason: "stagnant", progressed },
	}
	if (state.lastDispatchAt !== undefined && now - state.lastDispatchAt < TODO_COOLDOWN_MS) return {
		state: { ...state, signature, awaitingProgress: false, stagnationCount },
		decision: { allowed: false, reason: "cooldown", progressed },
	}
	return {
		state: { ...state, signature, awaitingProgress: false, stagnationCount, consecutiveFailures: failures },
		decision: { allowed: true, progressed },
	}
}

export function markTodoDispatched(state: WorkflowPolicyRecord["todo"], now: number): WorkflowPolicyRecord["todo"] {
	return { ...state, awaitingProgress: true, lastDispatchAt: now, consecutiveFailures: 0, lastFailureAt: undefined }
}

export function markTodoDispatchFailed(state: WorkflowPolicyRecord["todo"], now: number): WorkflowPolicyRecord["todo"] {
	return {
		...state,
		awaitingProgress: false,
		lastDispatchAt: now,
		consecutiveFailures: Math.min(TODO_FAILURE_LIMIT, state.consecutiveFailures + 1),
		lastFailureAt: now,
	}
}

export type AtlasTurnDecision = {
	readonly state: WorkflowPolicyRecord["atlas"]
	readonly allowed: boolean
	readonly reason?: "stalled" | "failure-backoff" | "cooldown"
	readonly progressed: boolean
}

/** Record real successful tool progress and bound Atlas continuation for one exact plan. */
export function observeAtlasTurn(input: {
	state: WorkflowPolicyRecord["atlas"]
	workID: string
	planPath: string
	fingerprint: string
	remaining: boolean
	now: number
}): AtlasTurnDecision {
	const samePlan = input.state.workID === input.workID && input.state.planPath === input.planPath && input.state.fingerprint === input.fingerprint
	const base = samePlan
		? input.state
		: { noProgressIterations: 0, awaitingToolProgress: false, toolProgress: false, stalled: false, consecutiveFailures: 0 }
	const progressed = samePlan && base.toolProgress
	let noProgressIterations = progressed ? 0 : base.noProgressIterations
	if (base.awaitingToolProgress && !progressed) noProgressIterations += 1
	const common = {
		...base,
		workID: input.workID,
		planPath: input.planPath,
		fingerprint: input.fingerprint,
		noProgressIterations,
		awaitingToolProgress: false,
		toolProgress: false,
		stalled: noProgressIterations >= ATLAS_NO_PROGRESS_LIMIT,
	}
	if (!input.remaining) return { state: common, allowed: false, reason: "stalled", progressed }
	if (common.consecutiveFailures >= TODO_FAILURE_LIMIT) {
		if (common.lastFailureAt !== undefined && input.now - common.lastFailureAt >= TODO_FAILURE_RESET_MS) {
			return { state: { ...common, consecutiveFailures: 0, lastFailureAt: undefined }, allowed: !common.stalled, reason: common.stalled ? "stalled" : undefined, progressed }
		}
		return { state: common, allowed: false, reason: "failure-backoff", progressed }
	}
	if (common.stalled) return { state: common, allowed: false, reason: "stalled", progressed }
	if (common.lastDispatchAt !== undefined && input.now - common.lastDispatchAt < ATLAS_COOLDOWN_MS) {
		return { state: common, allowed: false, reason: "cooldown", progressed }
	}
	return { state: common, allowed: true, progressed }
}

export function markAtlasToolProgress(state: WorkflowPolicyRecord["atlas"]): WorkflowPolicyRecord["atlas"] {
	return { ...state, toolProgress: true, awaitingToolProgress: false, noProgressIterations: 0, stalled: false }
}

export function markAtlasDispatched(state: WorkflowPolicyRecord["atlas"], now: number): WorkflowPolicyRecord["atlas"] {
	return { ...state, awaitingToolProgress: true, lastDispatchAt: now, consecutiveFailures: 0, lastFailureAt: undefined }
}

export function markAtlasDispatchFailed(state: WorkflowPolicyRecord["atlas"], now: number): WorkflowPolicyRecord["atlas"] {
	return { ...state, awaitingToolProgress: false, lastDispatchAt: now, consecutiveFailures: Math.min(TODO_FAILURE_LIMIT, state.consecutiveFailures + 1), lastFailureAt: now }
}

export function planFingerprint(content: string): string {
	return createHash("sha256").update(content).digest("hex")
}

export function isTangibleProgressTool(tool: string): boolean {
	return new Set(["bash", "shell", "edit", "write", "patch", "apply_patch", "hashline_edit"]).has(tool.toLowerCase())
}

export function successfulTangibleToolResult(result: unknown): boolean {
	if (!record(result)) return false
	if (result.status === "error" || result.status === "aborted" || result.status === "failed") return false
	if (record(result.error) || result.error !== undefined) return false
	const output = record(result.output) ? result.output : undefined
	if (!output) return true
	if (["running", "error", "aborted", "failed", "cancelled", "canceled"].includes(String(output.status))) return false
	if (output.timeout === true || (typeof output.signal === "string" && output.signal.length > 0)) return false
	for (const field of ["exit", "exitCode", "code"] as const) {
		const value = output[field]
		if (finite(value) && value !== 0) return false
	}
	return true
}

export function classifyWorkflowAgent(agent: string | undefined): "todo" | "orchestrator" | "skip" {
	const id = agent?.toLowerCase().replace(/[^a-z0-9]/g, "")
	if (!id) return "skip"
	if (["prometheus", "plan", "compaction"].includes(id)) return "skip"
	if (["atlas", "sisyphus", "sisyphusjunior", "hephaestus"].includes(id)) return "orchestrator"
	return "todo"
}

export function hasUnansweredNativeQuestion(messages: unknown): boolean {
	if (!Array.isArray(messages)) return false
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index]
		if (!record(message)) continue
		const role = typeof message.role === "string" ? message.role :
			record(message.info) && typeof message.info.role === "string" ? message.info.role :
			typeof message.type === "string" && ["user", "assistant"].includes(message.type) ? message.type : undefined
		if (role === "user") {
			const meta = record(message.metadata) ? message.metadata : {}
			if (meta.source === "oh-my-openagent" || meta.internal === true || meta.synthetic === true) continue
			return false
		}
		if (role !== "assistant") continue
		const parts = Array.isArray(message.content) ? message.content : Array.isArray(message.parts) ? message.parts : []
		return parts.some((part) => {
			if (!record(part)) return false
			const name = String(part.name ?? part.tool ?? part.toolName ?? "").toLowerCase()
			const state = record(part.state) ? part.state : {}
			return ["question", "ask_user_question", "askuserquestion"].includes(name) && state.status !== "completed"
		})
	}
	return false
}
