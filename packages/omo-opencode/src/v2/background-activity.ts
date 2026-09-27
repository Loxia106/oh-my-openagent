import { realpathSync } from "node:fs"
import { normalize, resolve } from "node:path"
import type { Plugin } from "@opencode/plugin"
import type { BackgroundTaskConfig } from "../config/schema"
import { log } from "../shared/logger"
import {
	DEFAULT_MESSAGE_STALENESS_TIMEOUT_MS,
	DEFAULT_SESSION_GONE_TIMEOUT_MS,
	DEFAULT_STALE_TIMEOUT_MS,
	MIN_RUNTIME_BEFORE_STALE_MS,
	POLLING_INTERVAL_MS,
	TASK_CLEANUP_DELAY_MS,
} from "../features/background-agent/constants"

const ACTIVITY_KEY_ROOT = "oh-my-openagent:v2:background-activity:"
const ACTIVITY_STORAGE_PAGE_SIZE = 100
const ACTIVITY_PERSIST_INTERVAL_MS = 1000
const INTERRUPT_RETRY_DELAY_MS = 10_000
const MAX_INTERRUPT_ATTEMPTS = 3
const MAX_TIMER_DELAY_MS = 2_147_483_647

export type BackgroundActivityClock = {
	now(): number
	setTimeout(callback: () => void, delayMs: number): unknown
	clearTimeout(timer: unknown): void
}

const systemClock: BackgroundActivityClock = {
	now: () => Date.now(),
	setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
	clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
}

export type BackgroundActivityLease = {
	leaseID: string
	rootSessionID: string
	parentSessionID: string
	childSessionID: string | null
	model: string
	mode?: "new" | "resume"
	generation: number
	status: string
	baselineIdle: number | null
	createdAt: number
	boundAt?: number | null
	startedSeq?: number | null
}

export type BackgroundActivityEvent = {
	type: string
	created?: number
	durable?: { aggregateID?: string; seq?: number }
	data?: Record<string, unknown>
}

export type BackgroundActivityState = {
	version: 1
	leaseID: string
	rootSessionID: string
	parentSessionID: string
	sessionID: string
	projectID: string
	workspaceID: string | null
	directory: string
	generation: number
	status: "unknown" | "running" | "terminal"
	boundAt: number
	baselineIdle: number | null
	freshStartSeen: boolean
	generationAmbiguous: boolean
	executionStartedAt: number | null
	startSeq: number | null
	lastSequence: number | null
	currentStepID: string | null
	progressed: boolean
	lastProgressAt: number | null
	missingSince: number | null
	interruptAttempts: number
	lastInterruptAt: number | null
	interruptAcceptedAt: number | null
	trigger: { reason: "no-progress" | "stale-progress"; at: number; attempts: number } | null
	terminalAt: number | null
}

type SessionInfo = Awaited<ReturnType<Plugin.Context["session"]["get"]>>

export type V2BackgroundActivityMonitor = {
	readonly ready: () => Promise<void>
	readonly start: () => Promise<void>
	readonly bind: (lease: BackgroundActivityLease) => Promise<void>
	readonly observe: (event: unknown) => Promise<void>
	readonly markTerminal: (leaseID: string, generation: number, terminalAt?: number) => Promise<void>
	readonly removeLease: (leaseID: string, generation: number) => Promise<void>
	readonly removeSession: (sessionID: string) => Promise<void>
	readonly checkNow: () => Promise<void>
	readonly stop: () => void
	readonly dispose: () => Promise<void>
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

function finite(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value)
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

function canonicalDirectory(value: string): string {
	const absolute = resolve(value)
	try { return normalize(realpathSync(absolute)) } catch { return normalize(absolute) }
}

function activityPrefix(ctx: Plugin.Context): string {
	return `${ACTIVITY_KEY_ROOT}${encodeURIComponent(ctx.location.project.id)}:${encodeURIComponent(ctx.location.workspaceID ?? "")}:${encodeURIComponent(canonicalDirectory(ctx.location.directory))}:`
}

function stateKey(prefix: string, leaseID: string): string {
	return `${prefix}${encodeURIComponent(leaseID)}`
}

function isOutcome(value: unknown): value is "succeeded" | "failed" | "interrupted" {
	return value === "succeeded" || value === "failed" || value === "interrupted"
}

export function decodeBackgroundActivityState(value: unknown): BackgroundActivityState | undefined {
	if (!isObject(value)) return undefined
	if (
		value.version !== 1 ||
		typeof value.leaseID !== "string" ||
		typeof value.rootSessionID !== "string" ||
		typeof value.parentSessionID !== "string" ||
		typeof value.sessionID !== "string" ||
		typeof value.projectID !== "string" ||
		!(value.workspaceID === null || typeof value.workspaceID === "string") ||
		typeof value.directory !== "string" ||
		!Number.isInteger(value.generation) ||
		(value.status !== "unknown" && value.status !== "running" && value.status !== "terminal") ||
		!finite(value.boundAt) ||
		!(value.baselineIdle === null || finite(value.baselineIdle)) ||
		typeof value.freshStartSeen !== "boolean" ||
		!(value.generationAmbiguous === undefined || typeof value.generationAmbiguous === "boolean") ||
		!(value.executionStartedAt === null || finite(value.executionStartedAt)) ||
		!(value.startSeq === null || Number.isInteger(value.startSeq)) ||
		!(value.lastSequence === null || Number.isInteger(value.lastSequence)) ||
		!(value.currentStepID === null || typeof value.currentStepID === "string") ||
		typeof value.progressed !== "boolean" ||
		!(value.lastProgressAt === null || finite(value.lastProgressAt)) ||
		!(value.missingSince === null || finite(value.missingSince)) ||
		!Number.isInteger(value.interruptAttempts) ||
		!(value.lastInterruptAt === null || finite(value.lastInterruptAt)) ||
		!(value.interruptAcceptedAt === null || finite(value.interruptAcceptedAt)) ||
		!(value.trigger === null || (
			isObject(value.trigger) &&
			(value.trigger.reason === "no-progress" || value.trigger.reason === "stale-progress") &&
			finite(value.trigger.at) && Number.isInteger(value.trigger.attempts)
		)) ||
		!(value.terminalAt === null || finite(value.terminalAt))
	) return undefined
	return { ...value, generationAmbiguous: value.generationAmbiguous === true } as unknown as BackgroundActivityState
}

function sessionNotFound(error: unknown): boolean {
	return isObject(error) && error._tag === "SessionNotFoundError" && typeof error.sessionID === "string"
}

function eventCreated(event: { created?: unknown }): number | undefined {
	if (finite(event.created)) return event.created
	return undefined
}

function assistantMessageID(event: BackgroundActivityEvent): string | undefined {
	return typeof event.data?.assistantMessageID === "string" ? event.data.assistantMessageID : undefined
}

function progressEventHasContent(event: BackgroundActivityEvent): boolean {
	if (event.type.endsWith(".delta")) {
		const delta = event.data?.delta
		return typeof delta === "string" && delta.length > 0
	}
	if (event.type === "session.text.ended" || event.type === "session.reasoning.ended") {
		const text = event.data?.text
		return typeof text === "string" && text.length > 0
	}
	if (event.type === "session.tool.progress") {
		return isObject(event.data?.metadata) && Object.keys(event.data!.metadata as Record<string, unknown>).length > 0
	}
	return true
}

function isProgressEvent(event: BackgroundActivityEvent): boolean {
	return event.type === "session.text.delta" ||
		event.type === "session.text.ended" ||
		event.type === "session.reasoning.delta" ||
		event.type === "session.reasoning.ended" ||
		event.type === "session.tool.input.delta" ||
		event.type === "session.tool.input.ended" ||
		event.type === "session.tool.called" ||
		event.type === "session.tool.progress" ||
		event.type === "session.tool.success" ||
		event.type === "session.tool.failed"
}

function sameLocation(ctx: Plugin.Context, info: SessionInfo): boolean {
	// Session.Info currently uses Location.PublicRef (directory only). If a host
	// adds workspaceID, reject a mismatch; otherwise the canonical directory is
	// the strongest public identity check available from session.get.
	const location = info.location as typeof info.location & { workspaceID?: string }
	if (location.workspaceID !== undefined && location.workspaceID !== (ctx.location.workspaceID ?? undefined)) return false
	return info.projectID === ctx.location.project.id &&
		canonicalDirectory(info.location.directory) === canonicalDirectory(ctx.location.directory)
}

function stateMatchesLease(state: BackgroundActivityState, lease: BackgroundActivityLease): boolean {
	return lease.childSessionID !== null &&
		state.leaseID === lease.leaseID &&
		state.generation === lease.generation &&
		state.sessionID === lease.childSessionID &&
		state.parentSessionID === lease.parentSessionID &&
		state.rootSessionID === lease.rootSessionID
}

function toState(ctx: Plugin.Context, lease: BackgroundActivityLease, now: number): BackgroundActivityState | undefined {
	if (!lease.childSessionID) return undefined
	return {
		version: 1,
		leaseID: lease.leaseID,
		rootSessionID: lease.rootSessionID,
		parentSessionID: lease.parentSessionID,
		sessionID: lease.childSessionID,
		projectID: ctx.location.project.id,
		workspaceID: ctx.location.workspaceID ?? null,
		directory: canonicalDirectory(ctx.location.directory),
		generation: lease.generation,
		status: "unknown",
		boundAt: lease.boundAt ?? lease.createdAt,
		baselineIdle: lease.baselineIdle,
		freshStartSeen: false,
		generationAmbiguous: false,
		executionStartedAt: null,
		startSeq: null,
		lastSequence: lease.startedSeq ?? null,
		currentStepID: null,
		progressed: false,
		lastProgressAt: null,
		missingSince: null,
		interruptAttempts: 0,
		lastInterruptAt: null,
		interruptAcceptedAt: null,
		trigger: null,
		terminalAt: null,
	}
}

/**
 * Session-scoped watchdog for native child executions. A start event proves the
 * current generation, but only actual model/tool output counts as progress.
 * Restored generations are intentionally unproven until a fresh start event.
 */
export function createV2BackgroundActivityMonitor(input: {
	ctx: Plugin.Context
	config?: BackgroundTaskConfig
	clock?: BackgroundActivityClock
	resolveParent?: (info: SessionInfo) => Promise<string | undefined>
	getLeases: () => readonly BackgroundActivityLease[]
	getLease: (leaseID: string) => BackgroundActivityLease | undefined
	reconcileIdle: (lease: BackgroundActivityLease, info: SessionInfo) => Promise<boolean>
	removeMissing: (lease: BackgroundActivityLease) => Promise<void>
	onFailure: (reason: string) => void
}): V2BackgroundActivityMonitor {
	const { ctx, config, getLeases, getLease, reconcileIdle, removeMissing, onFailure } = input
	const clock = input.clock ?? systemClock
	const prefix = activityPrefix(ctx)
	const states = new Map<string, BackgroundActivityState>()
	const pendingPersist = new Map<string, unknown>()
	let disposed = false
	let started = false
	let monitorEpoch = 0
	let timer: unknown
	let cycle: Promise<void> | undefined
	let storageQueue = Promise.resolve()

	async function serialized<T>(operation: () => Promise<T>): Promise<T> {
		const previous = storageQueue
		let release!: () => void
		storageQueue = new Promise<void>((resolve) => { release = resolve })
		await previous
		try { return await operation() } finally { release() }
	}

	function clearPersistTimer(leaseID: string): void {
		const current = pendingPersist.get(leaseID)
		if (current === undefined) return
		clock.clearTimeout(current)
		pendingPersist.delete(leaseID)
	}

	async function persistLatest(leaseID: string): Promise<void> {
		await serialized(async () => {
			const latest = states.get(leaseID)
			if (latest) await ctx.storage.set(stateKey(prefix, leaseID), latest)
		})
	}

	function schedulePersist(state: BackgroundActivityState): void {
		if (pendingPersist.has(state.leaseID) || disposed) return
		const handle = clock.setTimeout(() => {
			pendingPersist.delete(state.leaseID)
			void persistLatest(state.leaseID).catch((error) => {
				onFailure(`Could not persist activity for child ${state.sessionID}: ${errorText(error)}`)
			})
		}, ACTIVITY_PERSIST_INTERVAL_MS)
		pendingPersist.set(state.leaseID, handle)
		unref(handle)
	}

	function unref(handle: unknown): void {
		if (typeof handle !== "object" || handle === null) return
		const method = (handle as { unref?: unknown }).unref
		if (typeof method === "function") method.call(handle)
	}

	async function persistImmediately(leaseID: string): Promise<void> {
		clearPersistTimer(leaseID)
		await persistLatest(leaseID)
	}

	function currentRunningLeases(): BackgroundActivityLease[] {
		return getLeases().filter((lease) => lease.status === "running" && Boolean(lease.childSessionID))
	}

	function ensureScheduled(): void {
		if (!started || disposed || timer !== undefined || currentRunningLeases().length === 0) return
		const handle = clock.setTimeout(() => {
			timer = undefined
			cycle = checkNow().catch((error) => {
				onFailure(`Background activity watchdog failed: ${errorText(error)}`)
			}).finally(() => {
				cycle = undefined
				ensureScheduled()
			})
		}, POLLING_INTERVAL_MS)
		timer = handle
		unref(handle)
	}

	function matchingStoredState(lease: BackgroundActivityLease): BackgroundActivityState | undefined {
		if (!lease.childSessionID) return undefined
		const current = states.get(lease.leaseID)
		return current && stateMatchesLease(current, lease) ? current : undefined
	}

	async function seedUnknown(lease: BackgroundActivityLease): Promise<BackgroundActivityState | undefined> {
		const seeded = toState(ctx, lease, clock.now())
		if (!seeded) return undefined
		states.set(lease.leaseID, seeded)
		await persistImmediately(seeded.leaseID)
		return seeded
	}

	async function observeStart(event: BackgroundActivityEvent, lease: BackgroundActivityLease): Promise<void> {
		const seq = event.durable?.seq
		const sessionID = typeof event.data?.sessionID === "string" ? event.data.sessionID : undefined
		const created = eventCreated(event)
		if (!sessionID || !Number.isInteger(seq) || event.durable?.aggregateID !== sessionID || sessionID !== lease.childSessionID || created === undefined) return
		if (!sameGeneration(getLease(lease.leaseID), lease)) return
		let current = matchingStoredState(lease)
		if (!current) current = await seedUnknown(lease)
		if (!current || created < current.boundAt) return
		if (current.generationAmbiguous) return
		if (current.freshStartSeen) {
			if (seq! <= (current.lastSequence ?? current.startSeq ?? -1)) return
			// A second start without an observed terminal makes this lease generation
			// permanently ambiguous; a later third start cannot restore proof.
			const unknown: BackgroundActivityState = {
				...current,
				status: "unknown",
				freshStartSeen: false,
				generationAmbiguous: true,
				executionStartedAt: null,
				startSeq: null,
				lastSequence: seq!,
				currentStepID: null,
				progressed: false,
				lastProgressAt: null,
				interruptAcceptedAt: null,
				trigger: null,
			}
			states.set(lease.leaseID, unknown)
			await persistImmediately(lease.leaseID)
			if (!sameGeneration(getLease(lease.leaseID), lease) || states.get(lease.leaseID) !== unknown) return
			let info: SessionInfo | undefined
			try { info = await ctx.session.get({ sessionID }) } catch { info = undefined }
			if (info && await validIdentity(lease, info) && isOutcome(info.outcome) && sameGeneration(getLease(lease.leaseID), lease)) await reconcileIdle(lease, info)
			return
		}
		if (current.lastSequence !== null && seq! <= current.lastSequence) return

		// A start event is generation evidence only when the public session record
		// still matches the bound child and its idle watermark has not advanced.
		let info: SessionInfo
		try { info = await ctx.session.get({ sessionID }) } catch { return }
		if (!(await validIdentity(lease, info)) || states.get(lease.leaseID) !== current || !sameGeneration(getLease(lease.leaseID), lease)) return
		const idle = info.time.idle
		if (current.baselineIdle !== null && !finite(idle)) return
		if (current.baselineIdle === null && !finite(idle) && lease.mode !== "new") return
		const idleAdvanced = finite(idle) && (current.baselineIdle !== null
			? idle > current.baselineIdle
			: idle >= current.boundAt)
		if (idleAdvanced) {
			if (isOutcome(info.outcome)) await reconcileIdle(lease, info)
			if (states.get(lease.leaseID) !== current || !sameGeneration(getLease(lease.leaseID), lease)) return
			const unknown: BackgroundActivityState = {
				...current,
				status: "unknown",
				freshStartSeen: false,
				generationAmbiguous: true,
				lastSequence: seq!,
			}
			states.set(lease.leaseID, unknown)
			await persistImmediately(lease.leaseID)
			return
		}
		if (current.baselineIdle !== null && idle !== current.baselineIdle) {
			const unknown: BackgroundActivityState = {
				...current,
				status: "unknown",
				freshStartSeen: false,
				generationAmbiguous: true,
				lastSequence: seq!,
			}
			states.set(lease.leaseID, unknown)
			await persistImmediately(lease.leaseID)
			return
		}
		if (current.baselineIdle === null && finite(idle) && idle >= current.boundAt) return
		if (states.get(lease.leaseID) !== current || !sameGeneration(getLease(lease.leaseID), lease)) return
		const next: BackgroundActivityState = {
			...current,
			status: "running",
			freshStartSeen: true,
			executionStartedAt: created,
			startSeq: seq!,
			lastSequence: seq!,
			currentStepID: null,
			progressed: false,
			lastProgressAt: null,
			missingSince: null,
			interruptAttempts: 0,
			lastInterruptAt: null,
			interruptAcceptedAt: null,
			trigger: null,
			terminalAt: null,
		}
		states.set(lease.leaseID, next)
		await persistImmediately(next.leaseID)
	}

	async function observeActivity(event: BackgroundActivityEvent, lease: BackgroundActivityLease): Promise<void> {
		const sessionID = event.data?.sessionID
		const created = eventCreated(event)
		if (sessionID !== lease.childSessionID || created === undefined) return
		const seq = event.durable?.seq
		const isDurable = Number.isInteger(seq) && event.durable?.aggregateID === sessionID
		const current = matchingStoredState(lease)
		if (!current || current.status !== "running" || !current.freshStartSeen || current.executionStartedAt === null) return
		if (created < current.boundAt || created < current.executionStartedAt) return
		if (isDurable && seq! <= (current.lastSequence ?? current.startSeq ?? -1)) return
		const dataMessageID = assistantMessageID(event)
		if (event.type === "session.step.started") {
			if (typeof dataMessageID !== "string" || !isDurable) return
			const next = { ...current, currentStepID: dataMessageID, lastSequence: seq! }
			states.set(lease.leaseID, next)
			await persistImmediately(next.leaseID)
			return
		}
		if (!isProgressEvent(event) || !progressEventHasContent(event)) return
		if (typeof dataMessageID !== "string" || dataMessageID !== current.currentStepID) return
		if (current.lastProgressAt !== null && created < current.lastProgressAt) return
		const interruptInFlight = current.trigger !== null && current.interruptAcceptedAt === null
		const next: BackgroundActivityState = {
			...current,
			progressed: true,
			lastProgressAt: created,
			lastSequence: isDurable ? seq! : current.lastSequence,
			missingSince: null,
			interruptAttempts: interruptInFlight || current.interruptAcceptedAt !== null ? current.interruptAttempts : 0,
			lastInterruptAt: interruptInFlight || current.interruptAcceptedAt !== null ? current.lastInterruptAt : null,
			trigger: interruptInFlight || current.interruptAcceptedAt !== null ? current.trigger : null,
		}
		states.set(lease.leaseID, next)
		schedulePersist(next)
	}

	async function observe(eventValue: unknown): Promise<void> {
		if (disposed || !isObject(eventValue) || !isObject(eventValue.data)) return
		const event = eventValue as BackgroundActivityEvent
		const sessionID = typeof event.data?.sessionID === "string" ? event.data.sessionID : undefined
		if (!sessionID) return
		const lease = currentRunningLeases().find((candidate) => candidate.childSessionID === sessionID)
		if (!lease) return
		if (event.type === "session.execution.started") await observeStart(event, lease)
		else await observeActivity(event, lease)
	}

	async function markTerminal(leaseID: string, generation: number, terminalAt = clock.now()): Promise<void> {
		const current = states.get(leaseID)
		if (!current || current.generation !== generation || current.status === "terminal") return
		const next: BackgroundActivityState = {
			...current,
			status: "terminal",
			terminalAt,
			interruptAcceptedAt: current.interruptAcceptedAt ?? null,
		}
		states.set(leaseID, next)
		await persistImmediately(leaseID)
		await pruneSupersededTerminal()
	}

	async function removeLease(leaseID: string, generation: number): Promise<void> {
		const current = states.get(leaseID)
		if (!current || current.generation !== generation) return
		clearPersistTimer(leaseID)
		states.delete(leaseID)
		await serialized(() => ctx.storage.remove(stateKey(prefix, leaseID)))
	}

	async function removeSession(sessionID: string): Promise<void> {
		const removed = [...states.values()].filter((candidate) => candidate.sessionID === sessionID)
		for (const state of removed) {
			clearPersistTimer(state.leaseID)
			states.delete(state.leaseID)
		}
		await serialized(async () => {
			for (const state of removed) await ctx.storage.remove(stateKey(prefix, state.leaseID))
		})
	}

	async function pruneSupersededTerminal(): Promise<void> {
		const delay = config?.taskCleanupDelayMs ?? TASK_CLEANUP_DELAY_MS
		const now = clock.now()
		const latestGeneration = new Map<string, number>()
		for (const state of states.values()) {
			latestGeneration.set(state.sessionID, Math.max(latestGeneration.get(state.sessionID) ?? 0, state.generation))
		}
		for (const state of [...states.values()]) {
			if (state.status !== "terminal" || state.terminalAt === null || now - state.terminalAt < delay) continue
			if ((latestGeneration.get(state.sessionID) ?? state.generation) <= state.generation) continue
			await removeLease(state.leaseID, state.generation)
		}
	}

	async function validIdentity(lease: BackgroundActivityLease, info: SessionInfo): Promise<boolean> {
		return Boolean(lease.childSessionID) && info.id === lease.childSessionID &&
			info.projectID === ctx.location.project.id && sameLocation(ctx, info) &&
			(input.resolveParent ? await input.resolveParent(info) : info.parentID) === lease.parentSessionID
	}

	function sameGeneration(current: BackgroundActivityLease | undefined, expected: BackgroundActivityLease): boolean {
		return Boolean(current && current.leaseID === expected.leaseID && current.generation === expected.generation &&
			current.childSessionID === expected.childSessionID && current.parentSessionID === expected.parentSessionID &&
			current.rootSessionID === expected.rootSessionID && current.status === "running")
	}

	async function onMissingSession(lease: BackgroundActivityLease, current: BackgroundActivityState): Promise<void> {
		if (states.get(lease.leaseID) !== current || !sameGeneration(getLease(lease.leaseID), lease)) return
		const now = clock.now()
		const missingSince = current.missingSince ?? now
		if (current.missingSince === null) {
			const next = { ...current, missingSince }
			states.set(lease.leaseID, next)
			schedulePersist(next)
			return
		}
		const timeout = config?.sessionGoneTimeoutMs ?? DEFAULT_SESSION_GONE_TIMEOUT_MS
		if (now - missingSince < timeout) return
		if (!sameGeneration(getLease(lease.leaseID), lease)) return
		await removeMissing(lease)
	}

	async function considerInterrupt(lease: BackgroundActivityLease, snapshot: BackgroundActivityState, now: number, epoch: number): Promise<void> {
		if (disposed || !started || monitorEpoch !== epoch || !snapshot.freshStartSeen || snapshot.status !== "running" || snapshot.executionStartedAt === null) return
		if (snapshot.interruptAcceptedAt !== null || snapshot.interruptAttempts >= MAX_INTERRUPT_ATTEMPTS) return
		if (snapshot.lastInterruptAt !== null && now - snapshot.lastInterruptAt < INTERRUPT_RETRY_DELAY_MS) return
		if (now - snapshot.executionStartedAt < MIN_RUNTIME_BEFORE_STALE_MS) return
		const anchor = snapshot.progressed ? snapshot.lastProgressAt : snapshot.executionStartedAt
		if (anchor === null) return
		const timeout = snapshot.progressed
			? config?.staleTimeoutMs ?? DEFAULT_STALE_TIMEOUT_MS
			: config?.messageStalenessTimeoutMs ?? DEFAULT_MESSAGE_STALENESS_TIMEOUT_MS
		if (now - anchor <= timeout) return
		if (!sameGeneration(getLease(lease.leaseID), lease)) return
		if (states.get(lease.leaseID) !== snapshot) return
		const reason = snapshot.progressed ? "stale-progress" : "no-progress"
		const attempts = snapshot.interruptAttempts + 1
		const next: BackgroundActivityState = {
			...snapshot,
			interruptAttempts: attempts,
			lastInterruptAt: now,
			trigger: { reason, at: now, attempts },
		}
		if (disposed || !started || monitorEpoch !== epoch || !sameGeneration(getLease(lease.leaseID), lease) || states.get(lease.leaseID) !== snapshot) return
		states.set(lease.leaseID, next)
		await persistImmediately(next.leaseID)
		if (disposed || !started || monitorEpoch !== epoch || !sameGeneration(getLease(lease.leaseID), lease) || states.get(lease.leaseID) !== next) {
			const latest = states.get(lease.leaseID)
			if (latest && latest.generation === lease.generation && latest.status === "running" &&
				latest.trigger?.at === now && latest.interruptAcceptedAt === null && states.get(lease.leaseID) === latest) {
				states.set(lease.leaseID, {
					...latest,
					interruptAttempts: snapshot.interruptAttempts,
					lastInterruptAt: snapshot.lastInterruptAt,
					trigger: snapshot.trigger,
				})
				await persistImmediately(lease.leaseID)
			}
			return
		}
		log("[v2 background activity] Inactivity threshold reached; requesting native child interruption.", {
			leaseID: lease.leaseID,
			sessionID: lease.childSessionID,
			reason,
			attempts,
		})
		try {
			const accepted = await ctx.session.interrupt({ sessionID: lease.childSessionID! })
			const after = states.get(lease.leaseID)
			if (disposed || !started || monitorEpoch !== epoch || !sameGeneration(getLease(lease.leaseID), lease) || after?.generation !== lease.generation || after.status !== "running") return
			const result: BackgroundActivityState = {
				...after,
				interruptAcceptedAt: accepted ? now : null,
			}
			if (states.get(lease.leaseID) !== after) return
			states.set(lease.leaseID, result)
			await persistImmediately(result.leaseID)
		} catch {
			// A bounded retry is permitted on later watchdog ticks. Do not release
			// admission or claim that native execution stopped until terminal proof.
		}
	}

	async function checkNow(): Promise<void> {
		if (disposed || !started) return
		const epoch = monitorEpoch
		for (const lease of currentRunningLeases()) {
			if (disposed || !started || monitorEpoch !== epoch) return
			let state = matchingStoredState(lease)
			if (!state) state = await seedUnknown(lease)
			if (!state || state.status === "terminal") continue
			let info: SessionInfo
			try {
				info = await ctx.session.get({ sessionID: lease.childSessionID! })
			} catch (error) {
				if (disposed || !started || monitorEpoch !== epoch || !sameGeneration(getLease(lease.leaseID), lease) || states.get(lease.leaseID) !== state) continue
				if (sessionNotFound(error)) {
					await onMissingSession(lease, state)
					continue
				}
				if (state.missingSince !== null && states.get(lease.leaseID) === state) {
					const next = { ...state, missingSince: null }
					states.set(lease.leaseID, next)
					schedulePersist(next)
				}
				continue
			}
			if (!sameGeneration(getLease(lease.leaseID), lease) || states.get(lease.leaseID) !== state) continue
			if (state.missingSince !== null) {
				state = { ...state, missingSince: null }
				states.set(lease.leaseID, state)
				schedulePersist(state)
			}
			const identityValid = await validIdentity(lease, info)
			if (disposed || !started || monitorEpoch !== epoch || !sameGeneration(getLease(lease.leaseID), lease) || states.get(lease.leaseID) !== state) continue
			if (!identityValid) {
				const unknown: BackgroundActivityState = { ...state, status: "unknown", freshStartSeen: false, generationAmbiguous: true }
				states.set(lease.leaseID, unknown)
				schedulePersist(unknown)
				continue
			}
			const idleAdvanced = finite(info.time.idle) && (
				state.baselineIdle !== null
					? info.time.idle > state.baselineIdle
					: isOutcome(info.outcome) && info.time.idle >= state.boundAt
			)
			if (idleAdvanced) {
				if (isOutcome(info.outcome)) await reconcileIdle(lease, info)
				// The idle watermark advanced. Reconciliation must decide whether this
				// generation completed; absent that proof, stop destructive monitoring.
				if (states.get(lease.leaseID) === state) {
					const unknown: BackgroundActivityState = { ...state, status: "unknown", freshStartSeen: false }
					states.set(lease.leaseID, unknown)
					await persistImmediately(unknown.leaseID)
				}
				continue
			}
			await considerInterrupt(lease, state, clock.now(), epoch)
		}
		await pruneSupersededTerminal()
	}

	async function ready(): Promise<void> {
		let after: string | undefined
		const cursors = new Set<string>()
		do {
			const page = await ctx.storage.scan({ prefix, ...(after ? { after } : {}), limit: ACTIVITY_STORAGE_PAGE_SIZE })
			for (const entry of page.entries) {
				const state = decodeBackgroundActivityState(entry.value)
				if (!state || entry.key !== stateKey(prefix, state.leaseID) ||
					state.projectID !== ctx.location.project.id || state.workspaceID !== (ctx.location.workspaceID ?? null) ||
					state.directory !== canonicalDirectory(ctx.location.directory)) {
					throw new Error(`Malformed or cross-location background activity record at ${entry.key}.`)
				}
				// Hot reload erases proof that an observed start belongs to the live
				// invocation. Wait for a fresh start event before destructive policy.
				states.set(state.leaseID, state.status === "terminal" ? state : {
					...state,
					status: "unknown",
					freshStartSeen: false,
					currentStepID: null,
					interruptAcceptedAt: null,
				})
			}
			after = page.next
			if (after && cursors.has(after)) throw new Error(`Plugin-storage activity scan repeated cursor ${after}.`)
			if (after) cursors.add(after)
		} while (after)
	}

	async function start(): Promise<void> {
		if (disposed) return
		monitorEpoch++
		started = true
		for (const lease of currentRunningLeases()) {
			if (!matchingStoredState(lease)) await seedUnknown(lease)
		}
		ensureScheduled()
	}

	async function bind(lease: BackgroundActivityLease): Promise<void> {
		if (disposed || lease.status !== "running" || !lease.childSessionID) return
		const seeded = toState(ctx, lease, clock.now())
		if (!seeded) return
		states.set(lease.leaseID, seeded)
		await persistImmediately(seeded.leaseID)
		ensureScheduled()
	}

	function stop(): void {
		started = false
		monitorEpoch++
		if (timer !== undefined) clock.clearTimeout(timer)
		timer = undefined
	}

	async function dispose(): Promise<void> {
		stop()
		disposed = true
		await cycle?.catch(() => undefined)
		for (const leaseID of [...pendingPersist.keys()]) clearPersistTimer(leaseID)
		await Promise.all([...states.keys()].map((leaseID) => persistImmediately(leaseID)))
	}

	return {
		ready,
		start,
		bind,
		observe,
		markTerminal,
		removeLease,
		removeSession,
		checkNow,
		stop,
		dispose,
	}
}
