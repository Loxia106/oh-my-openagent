import { createHash } from "node:crypto"
import { realpathSync } from "node:fs"
import { normalize, resolve } from "node:path"
import type { OpenCodeEvent } from "@opencode/client"
import type { Plugin } from "@opencode/plugin"
import type { OhMyOpenCodeConfig } from "../config"
import type { GoalController } from "../hooks/goal/controller"
import { validateObjective } from "../hooks/goal/validation"
import type { VerifiedLogicalParentResolver } from "./background-admission"
import { isV2DelegationSessionInLocation } from "./delegation-settings"
import { getV2SubagentRunState } from "./task-state"

type InboxEnqueuedEvent = Extract<OpenCodeEvent, { type: "session.inbox.enqueued" }>
type SessionInfo = Awaited<ReturnType<Plugin.Context["session"]["get"]>>

const MARKER_PREFIX = "oh-my-openagent:v2:goal-auto-start:v1:"
const INITIAL_SELECTION_MESSAGES = new Set(["agent-switched", "model-switched", "location-switched"])

type Marker = {
	readonly version: 1
	readonly projectID: string
	readonly directory: string
	readonly workspaceID: string | null
	readonly sessionID: string
	readonly inboxID: string
	readonly firstSeenAt: number
}

export type GoalAutoStartResult =
	| { readonly kind: "created"; readonly goalID: string }
	| { readonly kind: "skipped"; readonly reason: string }

export type GoalAutoStartHelper = {
	handle(event: InboxEnqueuedEvent): Promise<GoalAutoStartResult>
	/** Remove the durable first-turn marker only after a native session-deleted event. */
	forget(sessionID: string): Promise<void>
	dispose(): Promise<void>
}

export type GoalAutoStartOptions = {
	readonly resolveLogicalParent?: VerifiedLogicalParentResolver
	readonly now?: () => number
	/** Prevents an inbox callback from creating a goal after the owning session is stopped or disposed. */
	readonly isCurrent?: (sessionID: string) => boolean
}

const queuesByStorage = new WeakMap<object, Map<string, Promise<void>>>()

async function serialize<T>(storage: Plugin.Context["storage"], key: string, operation: () => Promise<T>): Promise<T> {
	let queues = queuesByStorage.get(storage as object)
	if (!queues) {
		queues = new Map()
		queuesByStorage.set(storage as object, queues)
	}
	const previous = queues.get(key) ?? Promise.resolve()
	let release!: () => void
	const gate = new Promise<void>((resolveGate) => { release = resolveGate })
	const tail = previous.catch(() => undefined).then(() => gate)
	queues.set(key, tail)
	await previous.catch(() => undefined)
	try {
		return await operation()
	} finally {
		release()
		if (queues.get(key) === tail) queues.delete(key)
	}
}

function canonicalDirectory(directory: string): string {
	const absolute = normalize(resolve(directory))
	try {
		return normalize(realpathSync.native(absolute))
	} catch {
		return absolute
	}
}

function markerScope(ctx: Plugin.Context): Pick<Marker, "projectID" | "directory" | "workspaceID"> {
	return {
		projectID: ctx.location.project.id,
		directory: canonicalDirectory(String(ctx.location.directory)),
		workspaceID: ctx.location.workspaceID ?? null,
	}
}

function markerKey(scope: Pick<Marker, "projectID" | "directory" | "workspaceID">, sessionID: string): string {
	const digest = createHash("sha256")
		.update(JSON.stringify([scope.projectID, scope.directory, scope.workspaceID]))
		.digest("hex")
	return `${MARKER_PREFIX}${digest}:${encodeURIComponent(sessionID)}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

function hasTeamOwnershipHint(metadata: unknown): boolean {
	if (!isRecord(metadata)) return false
	const team = metadata.omoTeam
	return isRecord(team) && team.version === 1 && typeof team.teamRunId === "string"
}

function eventMatchesLocation(event: InboxEnqueuedEvent, ctx: Plugin.Context): boolean {
	const location = event.location
	const workspaceID = ctx.location.workspaceID ?? undefined
	if (!location) return workspaceID === undefined
	if (canonicalDirectory(location.directory) !== canonicalDirectory(String(ctx.location.directory))) return false
	if (location.workspaceID !== undefined) return location.workspaceID === workspaceID
	return workspaceID === undefined
}

function isOnlyInitialHistory(messages: unknown, inboxID: string): boolean {
	if (!Array.isArray(messages)) return false
	let currentInboxFound = false
	for (const raw of messages) {
		if (!isRecord(raw) || typeof raw.type !== "string") return false
		// Once this exact admitted inbox item appears, later messages may be from
		// a fast execution of this same first turn. Only its chronological prefix
		// determines whether the session was already in use.
		if (currentInboxFound) continue
		if (INITIAL_SELECTION_MESSAGES.has(raw.type)) continue
		if (raw.type === "user" && raw.id === inboxID) {
			currentInboxFound = true
			continue
		}
		// This includes any older user/assistant, compaction checkpoint, or
		// unrecognized message type. An old compacted session must not look new.
		return false
	}
	return true
}

async function verifiedPrimaryRoot(
	ctx: Plugin.Context,
	config: OhMyOpenCodeConfig,
	sessionID: string,
	resolveLogicalParent: VerifiedLogicalParentResolver | undefined,
): Promise<{ readonly session: SessionInfo } | { readonly reason: string }> {
	let session: SessionInfo
	try {
		session = await ctx.session.get({ sessionID })
	} catch {
		return { reason: "session-unavailable" }
	}
	if (session.id !== sessionID || !session.location?.directory || !isV2DelegationSessionInLocation(session, ctx.location)) {
		return { reason: "session-outside-location" }
	}
	if (session.parentID || hasTeamOwnershipHint(session.metadata)) return { reason: "child-session" }

	let run
	try {
		run = await getV2SubagentRunState(ctx.storage).get(sessionID)
	} catch {
		return { reason: "ownership-unavailable" }
	}
	if (run) return { reason: "managed-child-session" }

	if (config.team_mode?.enabled && !resolveLogicalParent) return { reason: "logical-ownership-unavailable" }
	if (resolveLogicalParent) {
		try {
			if ((await resolveLogicalParent(sessionID)) !== undefined) return { reason: "logical-child-session" }
		} catch {
			return { reason: "logical-ownership-unavailable" }
		}
	}

	if (session.agent !== undefined && session.agent !== null) {
		try {
			const agent = (await ctx.agent.get({ agentID: String(session.agent) })).data
			if (agent.mode !== "primary" && agent.mode !== "all") return { reason: "non-primary-agent" }
		} catch {
			return { reason: "agent-unavailable" }
		}
	}
	return { session }
}

/**
 * Create an event-driven, one-shot default goal helper. It intentionally runs
 * only from the ordered lifecycle inbox path, after the host accepts a prompt.
 */
export function createV2GoalAutoStartHelper(
	ctx: Plugin.Context,
	config: OhMyOpenCodeConfig,
	controller: GoalController,
	options: GoalAutoStartOptions = {},
): GoalAutoStartHelper {
	const scope = markerScope(ctx)
	const now = options.now ?? Date.now
	const pending = new Set<Promise<unknown>>()
	let active = true

	function gated(): boolean {
		return config.goal?.enabled === true && config.default_mode?.goal === true && !config.disabled_hooks?.includes("goal")
	}

	async function markSeen(key: string, sessionID: string, inboxID: string): Promise<void> {
		const value: Marker = {
			version: 1,
			...scope,
			sessionID,
			inboxID,
			firstSeenAt: now(),
		}
		await ctx.storage.set(key, value)
	}

	async function process(event: InboxEnqueuedEvent): Promise<GoalAutoStartResult> {
		if (!active) return { kind: "skipped", reason: "disposed" }
		if (!gated()) return { kind: "skipped", reason: "disabled" }
		if (event.type !== "session.inbox.enqueued" || event.data.item.type !== "user") {
			return { kind: "skipped", reason: "not-user-inbox" }
		}
		const { sessionID, inboxID, item } = event.data
		const isCurrent = () => active && (options.isCurrent?.(sessionID) ?? true)
		if (!isCurrent()) return { kind: "skipped", reason: "not-current" }
		if (!sessionID || !inboxID || !eventMatchesLocation(event, ctx)) {
			return { kind: "skipped", reason: "event-outside-location" }
		}
		const objective = item.payload.text
		if (typeof objective !== "string" || !objective.trim()) return { kind: "skipped", reason: "empty-objective" }
		const key = markerKey(scope, sessionID)
		const existingMarker = await ctx.storage.get(key)
		if (!isCurrent()) return { kind: "skipped", reason: active ? "not-current" : "disposed" }
		if (existingMarker !== undefined) return { kind: "skipped", reason: "already-seen" }

		const ownership = await verifiedPrimaryRoot(ctx, config, sessionID, options.resolveLogicalParent)
		if (!("session" in ownership)) return { kind: "skipped", reason: ownership.reason }
		if (!isCurrent()) return { kind: "skipped", reason: active ? "not-current" : "disposed" }
		if (controller.getGoal(sessionID)) {
			await markSeen(key, sessionID, inboxID)
			return { kind: "skipped", reason: "goal-exists" }
		}

		let messages: unknown
		try {
			messages = await ctx.session.context({ sessionID })
		} catch {
			return { kind: "skipped", reason: "history-unavailable" }
		}
		if (!isCurrent()) return { kind: "skipped", reason: active ? "not-current" : "disposed" }

		if (!isOnlyInitialHistory(messages, inboxID)) {
			await markSeen(key, sessionID, inboxID)
			return { kind: "skipped", reason: "prior-session-history" }
		}

		if (controller.getGoal(sessionID)) {
			await markSeen(key, sessionID, inboxID)
			return { kind: "skipped", reason: "goal-exists" }
		}

		let normalizedObjective: string
		try {
			normalizedObjective = validateObjective(objective)
		} catch {
			await markSeen(key, sessionID, inboxID)
			return { kind: "skipped", reason: "invalid-objective" }
		}

		// The durable marker precedes the goal write so a reload or concurrent
		// inbox callback cannot replace or recreate a goal after it is cleared.
		await markSeen(key, sessionID, inboxID)
		if (!active) {
			// Disposal during the marker write means this helper did not complete
			// the first-turn operation, so let a later instance retry it.
			await ctx.storage.remove(key)
			return { kind: "skipped", reason: "disposed" }
		}
		// A stopped session keeps the first-seen marker so a later turn cannot
		// turn the already-submitted prompt into a new default objective.
		if (!isCurrent()) return { kind: "skipped", reason: "not-current" }
		if (controller.getGoal(sessionID)) return { kind: "skipped", reason: "goal-exists" }
		const goal = controller.setGoal(sessionID, normalizedObjective)
		return { kind: "created", goalID: goal.id }
	}

	return {
		handle(event) {
			const sessionID = event.data?.sessionID ?? "<invalid>"
			const key = markerKey(scope, sessionID)
			const operation = serialize(ctx.storage, key, () => process(event))
			pending.add(operation)
			void operation.finally(() => pending.delete(operation)).catch(() => undefined)
			return operation
		},
		async forget(sessionID) {
			if (!sessionID) return
			const key = markerKey(scope, sessionID)
			await serialize(ctx.storage, key, () => ctx.storage.remove(key))
		},
		async dispose() {
			active = false
			await Promise.all([...pending].map((operation) => operation.catch(() => undefined)))
		},
	}
}
