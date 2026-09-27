import { randomUUID } from "node:crypto"
import { realpathSync } from "node:fs"
import { normalize, resolve } from "node:path"
import type { Plugin } from "@opencode/plugin"
import type { BackgroundTaskConfig } from "../config/schema"
import { TASK_TTL_MS } from "../features/background-agent/constants"
import { createV2BackgroundActivityMonitor, type BackgroundActivityLease } from "./background-activity"

const LEASE_KEY_ROOT = "oh-my-openagent:v2:background-admission:lease:"
const STORAGE_PAGE_SIZE = 100
const SESSION_IDLE_WAIT_TIMEOUT_MS = 10_000
const MAX_TIMER_DELAY_MS = 2_147_483_647

export type AdmissionOutcome = "succeeded" | "failed" | "interrupted"
export type AdmissionMode = "new" | "resume"
export type AdmissionModel = { providerID: string; id: string }
export type AdmissionLeaseStatus = "queued" | "reserved" | "creating" | "running" | "terminal"

export type BackgroundAdmissionInput = {
	parentSessionID: string
	model: AdmissionModel
	mode: "new"
	signal?: AbortSignal
} | {
	parentSessionID: string
	model: AdmissionModel
	mode: "resume"
	sessionID: string
	signal?: AbortSignal
}

export type AdmissionEvent = {
	id?: string
	type: string
	durable?: { aggregateID?: string; seq?: number }
	data?: { sessionID?: string }
}

type StoredLease = {
	version: 1
	leaseID: string
	rootSessionID: string
	parentSessionID: string
	childSessionID: string | null
	model: string
	childDepth: number
	mode: AdmissionMode
	status: AdmissionLeaseStatus
	generation: number
	baselineIdle: number | null
	startedSeq: number | null
	lastTerminalSeq: number | null
	terminalEventID: string | null
	outcome: AdmissionOutcome | null
	createdAt: number
	updatedAt: number
	boundAt?: number | null
	creationStarted: boolean
	supersedes: string | null
	adoptedUntrackedResume: boolean
}

type Lineage = { rootSessionID: string; parentDepth: number; projectID: string; sessionIDs: string[] }
export type BackgroundAdmissionPool = { key: string; limit: number; unlimited: boolean }

/** Injectable timer surface for deterministic admission-queue tests. */
export type BackgroundAdmissionClock = {
	now(): number
	setTimeout(callback: () => void, delayMs: number): unknown
	clearTimeout(timer: unknown): void
}

const systemClock: BackgroundAdmissionClock = {
	now: () => Date.now(),
	setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
	clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
}

type SlotWaiter = {
	leaseID: string
	pool: BackgroundAdmissionPool
	resolve: () => void
	reject: (error: Error) => void
	signal?: AbortSignal
	abortHandler?: () => void
	expiresAt: number
	expiryTimer?: unknown
	settled: boolean
}

export type BackgroundAdmissionTicket = {
	readonly leaseID: string
	beginCreate(): Promise<void>
	bind(childSessionID: string): Promise<void>
	/** True means the reservation was safely removed or its child was proven idle. */
	rollback(input?: { executionSettled?: boolean }): Promise<boolean>
}

export type BackgroundAdmissionDiagnostics = {
	readonly unhealthy?: string
	readonly activeLeases: readonly {
		leaseID: string
		status: AdmissionLeaseStatus
		rootSessionID: string
		parentSessionID: string
		childSessionID?: string
		model: string
		unboundAfterCreate: boolean
	}[]
	readonly queuedWaiters: Readonly<Record<string, number>>
}

export type V2BackgroundAdmission = {
	readonly ready: () => Promise<void>
	readonly acquire: (input: BackgroundAdmissionInput) => Promise<BackgroundAdmissionTicket>
	readonly observeExecution: (event: unknown) => Promise<void>
	readonly diagnostics: () => Promise<BackgroundAdmissionDiagnostics>
	readonly dispose: () => Promise<void>
}

type SessionInfo = Awaited<ReturnType<Plugin.Context["session"]["get"]>>

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isAdmissionOutcome(value: unknown): value is AdmissionOutcome {
	return value === "succeeded" || value === "failed" || value === "interrupted"
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value)
}

function decodeLease(value: unknown): StoredLease | undefined {
	if (!isObject(value)) return undefined
	if (
		value.version !== 1 ||
		typeof value.leaseID !== "string" || value.leaseID.length === 0 ||
		typeof value.rootSessionID !== "string" ||
		typeof value.parentSessionID !== "string" ||
		!(value.childSessionID === null || typeof value.childSessionID === "string") ||
		typeof value.model !== "string" ||
		!isFiniteNumber(value.childDepth) ||
		(value.mode !== "new" && value.mode !== "resume") ||
		(value.status !== "queued" && value.status !== "reserved" && value.status !== "creating" && value.status !== "running" && value.status !== "terminal") ||
		!Number.isInteger(value.generation) ||
		!(value.baselineIdle === null || isFiniteNumber(value.baselineIdle)) ||
		!(value.startedSeq === null || Number.isInteger(value.startedSeq)) ||
		!(value.lastTerminalSeq === null || Number.isInteger(value.lastTerminalSeq)) ||
		!(value.terminalEventID === null || typeof value.terminalEventID === "string") ||
		!(value.outcome === null || isAdmissionOutcome(value.outcome)) ||
		!isFiniteNumber(value.createdAt) ||
		!isFiniteNumber(value.updatedAt) ||
		!(value.boundAt === undefined || value.boundAt === null || isFiniteNumber(value.boundAt)) ||
		typeof value.creationStarted !== "boolean" ||
		!(value.supersedes === null || typeof value.supersedes === "string") ||
		typeof value.adoptedUntrackedResume !== "boolean"
	) return undefined
	return value as unknown as StoredLease
}

function leasePrefix(ctx: Plugin.Context): string {
	return `${LEASE_KEY_ROOT}${encodeURIComponent(ctx.location.project.id)}:${encodeURIComponent(ctx.location.workspaceID ?? "")}:${encodeURIComponent(canonicalDirectory(ctx.location.directory))}:`
}

function storageKey(prefix: string, leaseID: string): string {
	return `${prefix}${encodeURIComponent(leaseID)}`
}

function modelKey(model: AdmissionModel): string {
	if (!model.providerID.trim() || !model.id.trim()) {
		throw new Error("Background admission requires a concrete providerID/modelID selected before native subagent execution.")
	}
	return `${model.providerID}/${model.id}`
}

/**
 * Match the V1 manager's precedence and count comparison. A model-specific
 * override replaces its provider bucket; without either override the default
 * is per provider/model. Fractional limits retain `integerCount < limit` (so
 * a limit of 0.5 admits one entry); only exact zero means unlimited.
 */
export function resolveBackgroundAdmissionPool(config: BackgroundTaskConfig | undefined, model: string): BackgroundAdmissionPool {
	const exact = config?.modelConcurrency?.[model]
	if (exact !== undefined) return { key: `model:${model}`, limit: exact, unlimited: exact === 0 }
	const separator = model.indexOf("/")
	const provider = separator < 0 ? model : model.slice(0, separator)
	const providerLimit = config?.providerConcurrency?.[provider]
	if (providerLimit !== undefined) return { key: `provider:${provider}`, limit: providerLimit, unlimited: providerLimit === 0 }
	const fallback = config?.defaultConcurrency ?? 5
	return { key: `model:${model}`, limit: fallback, unlimited: fallback === 0 }
}

function isSessionNotFound(error: unknown): boolean {
	return isObject(error) && error._tag === "SessionNotFoundError" && typeof error.sessionID === "string"
}

function isActiveLease(lease: StoredLease): boolean {
	return lease.status !== "terminal"
}

function countsConcurrency(lease: StoredLease): boolean {
	return lease.status === "reserved" || lease.status === "creating" || lease.status === "running"
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

function canonicalDirectory(directory: string): string {
	const absolute = resolve(directory)
	try {
		return realpathSync.native(absolute)
	} catch {
		return normalize(absolute)
	}
}

function activityLease(lease: StoredLease): BackgroundActivityLease {
	return {
		leaseID: lease.leaseID,
		rootSessionID: lease.rootSessionID,
		parentSessionID: lease.parentSessionID,
		childSessionID: lease.childSessionID,
		model: lease.model,
		mode: lease.mode,
		generation: lease.generation,
		status: lease.status,
		baselineIdle: lease.baselineIdle,
		createdAt: lease.createdAt,
		boundAt: lease.boundAt ?? null,
		startedSeq: lease.startedSeq,
	}
}

function abortError(): Error {
	return new Error("Background admission was cancelled before native child execution began.")
}

function isNewerIdle(info: SessionInfo, lease: StoredLease): boolean {
	return lease.baselineIdle !== null &&
		isFiniteNumber(info.time.idle) && info.time.idle > lease.baselineIdle &&
		isAdmissionOutcome(info.outcome)
}

function isFirstGenerationNewIdle(info: SessionInfo, lease: StoredLease): boolean {
	// Admission covers one wrapped subagent invocation. Later unwrapped prompts do
	// not acquire a slot here; each wrapped resume owns a distinct lease generation.
	// A new-mode lease creates a fresh child after reservation. Its first terminal
	// idle can prove this invocation completed even when bind had no prior idle value.
	// Resumes keep the stricter baseline comparison because their outcome is historical.
	return lease.mode === "new" && lease.generation === 1 && !lease.adoptedUntrackedResume &&
		lease.baselineIdle === null && isFiniteNumber(info.time.idle) && info.time.idle >= lease.createdAt &&
		isAdmissionOutcome(info.outcome)
}

function isTerminalIdleForLease(info: SessionInfo, lease: StoredLease): boolean {
	return isNewerIdle(info, lease) || isFirstGenerationNewIdle(info, lease)
}

/**
 * Per-plugin-instance admission policy. The caller acquires before invoking
 * native `subagent`, calls beginCreate immediately before invocation, awaits
 * bind from native progress before forwarding that progress, and forwards
 * durable execution events to observeExecution.
 */
export function createV2BackgroundAdmission(
	ctx: Plugin.Context,
	config?: BackgroundTaskConfig,
	clock: BackgroundAdmissionClock = systemClock,
): V2BackgroundAdmission {
	const records = new Map<string, StoredLease>()
	const waiters = new Map<string, SlotWaiter[]>()
	const pendingIdleWaits = new Set<AbortController>()
	const scopedLeasePrefix = leasePrefix(ctx)
	let unhealthy: string | undefined
	let disposed = false
	let disposePromise: Promise<void> | undefined
	let lock = Promise.resolve()
	let readyPromise: Promise<void> | undefined
	let activity: ReturnType<typeof createV2BackgroundActivityMonitor> | undefined

	async function serialized<T>(operation: () => Promise<T>): Promise<T> {
		const previous = lock
		let release!: () => void
		lock = new Promise<void>((resolve) => { release = resolve })
		await previous
		try {
			return await operation()
		} finally {
			release()
		}
	}

	function failClosed(reason: string): void {
		if (unhealthy) return
		unhealthy = reason
		activity?.stop()
		const error = new Error(`Background admission is fail-closed: ${reason}`)
		for (const queue of waiters.values()) {
			for (const waiter of queue) {
				if (waiter.settled) continue
				settleWaiter(waiter)
				waiter.reject(error)
			}
		}
		waiters.clear()
	}

	function clearWaiterTimer(waiter: SlotWaiter): void {
		if (waiter.expiryTimer === undefined) return
		clock.clearTimeout(waiter.expiryTimer)
		waiter.expiryTimer = undefined
	}

	function settleWaiter(waiter: SlotWaiter): void {
		waiter.settled = true
		clearWaiterTimer(waiter)
		if (waiter.abortHandler) waiter.signal?.removeEventListener("abort", waiter.abortHandler)
	}

	function timeoutError(waiter: SlotWaiter): Error {
		const ttl = config?.taskTtlMs ?? TASK_TTL_MS
		return new Error(`Background admission queue expired after ${ttl} ms (background_task.taskTtlMs); no native child was created for lease ${waiter.leaseID}.`)
	}

	function armWaiterExpiry(waiter: SlotWaiter): void {
		const remaining = Math.max(0, waiter.expiresAt - clock.now())
		const timer = clock.setTimeout(() => {
			if (waiter.expiryTimer !== timer) return
			waiter.expiryTimer = undefined
			void expireWaiter(waiter).catch((error) => {
				failClosed(`Could not expire queued lease ${waiter.leaseID}: ${errorText(error)}`)
			})
		}, Math.min(remaining, MAX_TIMER_DELAY_MS))
		waiter.expiryTimer = timer
	}

	async function expireWaiter(waiter: SlotWaiter): Promise<void> {
		await serialized(async () => {
			if (waiter.settled) return
			const queue = waiters.get(waiter.pool.key)
			const index = queue?.indexOf(waiter) ?? -1
			if (index < 0) return
			const remaining = waiter.expiresAt - clock.now()
			if (remaining > 0) {
				armWaiterExpiry(waiter)
				return
			}

			queue!.splice(index, 1)
			if (queue!.length === 0) waiters.delete(waiter.pool.key)
			settleWaiter(waiter)
			try {
				await rollbackRecordLocked(waiter.leaseID, true, false)
			} catch (error) {
				waiter.reject(error instanceof Error ? error : new Error(String(error)))
				return
			}
			waiter.reject(timeoutError(waiter))
			await admitWaiters(waiter.pool)
		})
	}

	function assertHealthy(): void {
		if (unhealthy) throw new Error(`Background admission is fail-closed: ${unhealthy}`)
		if (disposed) throw new Error("Background admission is disposed; no new child execution may start.")
	}

	function sessionMatchesContext(info: SessionInfo): boolean {
		// The public SessionInfo exposes only LocationPublicRef.directory, not
		// workspaceID. Bind sessions to the exact native plugin location instead
		// of reading a field that the pinned 2.0.18 SDK does not expose.
		return info.projectID === ctx.location.project.id &&
			canonicalDirectory(info.location.directory) === canonicalDirectory(ctx.location.directory)
	}

	async function persist(lease: StoredLease): Promise<void> {
		try {
			await ctx.storage.set(storageKey(scopedLeasePrefix, lease.leaseID), lease)
		} catch (error) {
			failClosed(`Could not persist lease ${lease.leaseID}: ${errorText(error)}`)
			throw new Error(`Background admission could not persist lease ${lease.leaseID}; no child execution was granted. ${errorText(error)}`)
		}
	}

	async function saveLease(lease: StoredLease): Promise<void> {
		await persist(lease)
		records.set(lease.leaseID, lease)
	}

	async function removePersisted(lease: StoredLease): Promise<void> {
		try {
			await ctx.storage.remove(storageKey(scopedLeasePrefix, lease.leaseID))
		} catch (error) {
			failClosed(`Could not remove lease ${lease.leaseID}: ${errorText(error)}`)
			throw new Error(`Background admission could not safely release lease ${lease.leaseID}. ${errorText(error)}`)
		}
	}

	async function removeLease(lease: StoredLease): Promise<void> {
		await removePersisted(lease)
		records.delete(lease.leaseID)
		await activity?.removeLease(lease.leaseID, lease.generation)
	}

	function modelPool(lease: StoredLease): BackgroundAdmissionPool {
		return resolveBackgroundAdmissionPool(config, lease.model)
	}

	function activeCountForPool(pool: BackgroundAdmissionPool): number {
		let count = 0
		for (const lease of records.values()) {
			if (countsConcurrency(lease) && modelPool(lease).key === pool.key) count++
		}
		return count
	}

	function activeForRoot(rootSessionID: string): StoredLease[] {
		return [...records.values()].filter((lease) => lease.rootSessionID === rootSessionID && isActiveLease(lease))
	}

	function activeRecordForChild(sessionID: string): StoredLease | undefined {
		return [...records.values()]
			.filter((lease) => lease.childSessionID === sessionID && isActiveLease(lease))
			.sort((a, b) => b.generation - a.generation || b.updatedAt - a.updatedAt)[0]
	}

	function terminalRecordForChild(sessionID: string): StoredLease | undefined {
		return [...records.values()]
			.filter((lease) => lease.childSessionID === sessionID && lease.status === "terminal")
			.sort((a, b) => b.generation - a.generation || b.updatedAt - a.updatedAt)[0]
	}

	function blockersForRoot(rootSessionID: string): string {
		return activeForRoot(rootSessionID).map((lease) =>
			lease.status === "creating" && lease.childSessionID === null
				? `${lease.leaseID} (unbound after create began)`
				: `${lease.leaseID} (${lease.status}${lease.childSessionID ? `, session ${lease.childSessionID}` : ""})`,
		).join(", ")
	}

	async function resolveLineage(sessionID: string): Promise<Lineage> {
		const visited = new Set<string>()
		let current: SessionInfo
		try {
			current = await ctx.session.get({ sessionID })
		} catch (error) {
			throw new Error(`Background admission blocked: cannot verify session lineage for ${sessionID}; refusing to bypass depth/descendant limits. ${errorText(error)}`)
		}
		if (!current?.id || current.id !== sessionID) throw new Error(`Background admission blocked: session lookup for ${sessionID} returned a different or missing identity.`)
		const projectID = current.projectID
		if (!sessionMatchesContext(current)) throw new Error(`Background admission blocked: session ${sessionID} belongs to another OpenCode project or workspace.`)
		visited.add(current.id)
		const sessionIDs = [current.id]
		let depth = 0
		while (current.parentID) {
			const parentID = current.parentID
			if (visited.has(parentID)) throw new Error(`Background admission blocked: detected a session parent cycle at ${parentID}.`)
			visited.add(parentID)
			try {
				current = await ctx.session.get({ sessionID: parentID })
			} catch (error) {
				throw new Error(`Background admission blocked: cannot verify ancestor ${parentID}; refusing to bypass depth/descendant limits. ${errorText(error)}`)
			}
			if (current.id !== parentID) throw new Error(`Background admission blocked: ancestor lookup for ${parentID} returned a different or missing identity.`)
			if (current.projectID !== projectID || !sessionMatchesContext(current)) throw new Error(`Background admission blocked: session lineage crosses projects or workspaces at ${parentID}.`)
			sessionIDs.push(current.id)
			depth++
			if (depth > 256) throw new Error(`Background admission blocked: session lineage exceeds the safe traversal bound at ${parentID}.`)
		}
		return { rootSessionID: current.id, parentDepth: depth, projectID, sessionIDs }
	}

	async function markTerminal(
		leaseID: string,
		generation: number,
		outcome: AdmissionOutcome | null,
		terminalSeq: number | null,
		eventID: string | null,
	): Promise<void> {
		const current = records.get(leaseID)
		if (!current || current.generation !== generation || current.status === "terminal") return
		const next: StoredLease = {
			...current,
			status: "terminal",
			outcome,
			lastTerminalSeq: terminalSeq ?? current.lastTerminalSeq,
			terminalEventID: eventID,
			creationStarted: false,
			updatedAt: Date.now(),
		}
		const pool = modelPool(current)
		await saveLease(next)
		await activity?.markTerminal(leaseID, generation)
		await admitWaiters(pool)
	}

	activity = createV2BackgroundActivityMonitor({
		ctx,
		config,
		getLeases: () => [...records.values()].map(activityLease),
		getLease: (leaseID) => {
			const lease = records.get(leaseID)
			return lease ? activityLease(lease) : undefined
		},
		reconcileIdle: async (lease, info) => serialized(async () => {
			const current = records.get(lease.leaseID)
			if (!current || current.status !== "running" || current.generation !== lease.generation ||
				current.childSessionID !== lease.childSessionID || current.parentSessionID !== lease.parentSessionID ||
				current.rootSessionID !== lease.rootSessionID || !sessionMatchesContext(info) ||
				!isTerminalIdleForLease(info, current)) return false
			await markTerminal(current.leaseID, current.generation, info.outcome!, current.lastTerminalSeq, current.terminalEventID)
			return records.get(current.leaseID)?.status === "terminal"
		}),
		removeMissing: async (lease) => serialized(async () => {
			const current = records.get(lease.leaseID)
			if (!current || current.status !== "running" || current.generation !== lease.generation ||
				current.childSessionID !== lease.childSessionID || current.parentSessionID !== lease.parentSessionID ||
				current.rootSessionID !== lease.rootSessionID) return
			const pool = modelPool(current)
			await removeLease(current)
			await admitWaiters(pool)
		}),
		onFailure: (reason) => failClosed(reason),
	})

	async function reconcileRestoredLease(lease: StoredLease): Promise<void> {
		if (!lease.childSessionID || lease.status === "terminal") return
		let info: SessionInfo
		try {
			info = await ctx.session.get({ sessionID: lease.childSessionID })
		} catch (error) {
			if (isSessionNotFound(error)) {
				await removeLease(lease)
				return
			}
			return
		}
		if (info.id !== lease.childSessionID || info.parentID !== lease.parentSessionID || !sessionMatchesContext(info)) {
			failClosed(`Persisted lease ${lease.leaseID} resolves to a session outside its recorded parent/project/location. Keep it reserved and inspect the plugin-storage record.`)
			return
		}
		if (isTerminalIdleForLease(info, lease)) {
			await markTerminal(lease.leaseID, lease.generation, info.outcome!, lease.lastTerminalSeq, lease.terminalEventID)
			return
		}
		// Keep an unresolved persisted lease fail-closed. A later terminal event
		// can reconcile it after `get` confirms a newer idle generation.
	}

	async function loadAndReconcile(): Promise<void> {
		try {
			let after: string | undefined
			const cursors = new Set<string>()
			do {
				const page = await ctx.storage.scan({ prefix: scopedLeasePrefix, ...(after ? { after } : {}), limit: STORAGE_PAGE_SIZE })
				for (const entry of page.entries) {
					const lease = decodeLease(entry.value)
					if (!lease || entry.key !== storageKey(scopedLeasePrefix, lease.leaseID)) {
						failClosed(`Malformed persisted admission lease at storage key ${entry.key}. Inspect that plugin-storage entry before clearing it.`)
						continue
					}
					records.set(lease.leaseID, lease)
				}
				after = page.next
				if (after && cursors.has(after)) {
					failClosed(`Plugin storage scan repeated cursor ${after}; refusing incomplete lease reconciliation.`)
					break
				}
				if (after) cursors.add(after)
			} while (after)

			await activity?.ready()

			for (const lease of [...records.values()]) {
				if (lease.status === "queued" || lease.status === "reserved") {
					// A persisted pre-create reservation cannot have started a native child.
					await removeLease(lease)
					continue
				}
				if (lease.status === "creating" && lease.childSessionID === null) {
					// A process may have died after crossing the host boundary but before
					// native progress supplied the child's identity. Fail closed with a
					// diagnostic; there is no public session-listing API to recover it.
					continue
				}
				await reconcileRestoredLease(lease)
			}
			if (!unhealthy && !disposed) await activity?.start()
		} catch (error) {
			failClosed(`Could not restore background admission leases: ${errorText(error)}`)
		}
	}

	async function ensureReady(): Promise<void> {
		readyPromise ??= loadAndReconcile()
		await readyPromise
	}

	function slotStatus(_lease: StoredLease): "reserved" {
		// A resumed child stays rollbackable until beginCreate crosses the host
		// executor boundary, exactly like a new-child reservation.
		return "reserved"
	}

	async function rollbackRecordLocked(leaseID: string, knownNotStarted: boolean, admitAfter = true): Promise<boolean> {
		const lease = records.get(leaseID)
		if (!lease || lease.status === "terminal") return false
		if (lease.status === "creating" && lease.creationStarted && !knownNotStarted) return false
		if (lease.childSessionID && lease.status !== "queued" && lease.status !== "reserved") return false
		await removeLease(lease)
		if (admitAfter) await admitWaiters(modelPool(lease))
		return true
	}

	async function admitWaiters(pool: BackgroundAdmissionPool): Promise<void> {
		if (pool.unlimited || unhealthy || disposed) return
		const queue = waiters.get(pool.key)
		while (queue?.length && activeCountForPool(pool) < pool.limit) {
			const waiter = queue.shift()!
			if (waiter.settled || waiter.signal?.aborted) {
				if (!waiter.settled) {
					settleWaiter(waiter)
					await rollbackRecordLocked(waiter.leaseID, true, false)
					waiter.reject(abortError())
				}
				continue
			}
			if (waiter.expiresAt <= clock.now()) {
				settleWaiter(waiter)
				try {
					await rollbackRecordLocked(waiter.leaseID, true, false)
				} catch (error) {
					waiter.reject(error instanceof Error ? error : new Error(String(error)))
					throw error
				}
				waiter.reject(timeoutError(waiter))
				continue
			}
			const current = records.get(waiter.leaseID)
			if (!current) {
				settleWaiter(waiter)
				waiter.reject(new Error(`Queued background admission lease ${waiter.leaseID} is missing.`))
				continue
			}
			try {
				await saveLease({ ...current, status: slotStatus(current), updatedAt: Date.now() })
				settleWaiter(waiter)
				waiter.resolve()
			} catch (error) {
				settleWaiter(waiter)
				waiter.reject(error instanceof Error ? error : new Error(String(error)))
				throw error
			}
		}
		if (queue && queue.length === 0) waiters.delete(pool.key)
	}

	async function cancelWaiter(waiter: SlotWaiter): Promise<void> {
		await serialized(async () => {
			if (waiter.settled) return
			const queue = waiters.get(waiter.pool.key) ?? []
			const index = queue.indexOf(waiter)
			if (index >= 0) queue.splice(index, 1)
			if (queue.length === 0) waiters.delete(waiter.pool.key)
			settleWaiter(waiter)
			try {
				await rollbackRecordLocked(waiter.leaseID, true, false)
				waiter.reject(abortError())
				await admitWaiters(waiter.pool)
			} catch (error) {
				waiter.reject(error instanceof Error ? error : new Error(String(error)))
			}
		})
	}

	async function reserveSlot(lease: StoredLease, signal?: AbortSignal): Promise<void> {
		const pool = modelPool(lease)
		const decision = await serialized(async () => {
			assertHealthy()
			if (signal?.aborted) {
				await rollbackRecordLocked(lease.leaseID, true)
				return { promise: Promise.reject<void>(abortError()) }
			}
			if (pool.unlimited || (waiters.get(pool.key)?.length ?? 0) === 0 && activeCountForPool(pool) < pool.limit) {
				const current = records.get(lease.leaseID)
				if (!current) throw new Error(`Background admission lease ${lease.leaseID} disappeared before reservation.`)
				await saveLease({ ...current, status: slotStatus(current), updatedAt: Date.now() })
				return { immediate: true as const }
			}
			const queue = waiters.get(pool.key) ?? []
			const promise = new Promise<void>((resolve, reject) => {
				const ttl = config?.taskTtlMs ?? TASK_TTL_MS
				const waiter: SlotWaiter = { leaseID: lease.leaseID, pool, resolve, reject, signal, expiresAt: clock.now() + ttl, settled: false }
				if (signal) {
					waiter.abortHandler = () => { void cancelWaiter(waiter).catch(() => undefined) }
					signal.addEventListener("abort", waiter.abortHandler, { once: true })
				}
				queue.push(waiter)
				waiters.set(pool.key, queue)
				armWaiterExpiry(waiter)
			})
			return { promise }
		})
		if ("promise" in decision) await decision.promise
		if (signal?.aborted) {
			await serialized(() => rollbackRecordLocked(lease.leaseID, true))
			throw abortError()
		}
	}

	async function createReservation(input: BackgroundAdmissionInput): Promise<{ lease: StoredLease; lineage: Lineage }> {
		const model = modelKey(input.model)
		const lineage = await resolveLineage(input.parentSessionID)
		let childSessionID: string | null = null
		let childDepth = lineage.parentDepth + 1
		let prior: StoredLease | undefined
		let baselineIdle: number | null = null
		let adoptedUntrackedResume = false

		if (input.mode === "new") {
			const maxDepth = config?.maxDepth ?? 3
			if (childDepth > maxDepth) {
				throw new Error(`Subagent spawn blocked: child depth ${childDepth} exceeds background_task.maxDepth=${maxDepth}. OpenCode's own subagent depth cap remains independently enforced.`)
			}
		} else {
			childSessionID = input.sessionID
			let childInfo: SessionInfo
			try {
				childInfo = await ctx.session.get({ sessionID: childSessionID })
			} catch (error) {
				throw new Error(`Cannot safely resume subagent session ${childSessionID}: session lookup failed. ${errorText(error)}`)
			}
			if (childInfo.id !== childSessionID || childInfo.parentID !== input.parentSessionID || !sessionMatchesContext(childInfo)) {
				throw new Error(`Cannot resume session ${childSessionID}: it is not a direct child of ${input.parentSessionID}.`)
			}
			if (childInfo.projectID !== lineage.projectID || childInfo.projectID !== ctx.location.project.id) {
				throw new Error(`Cannot resume session ${childSessionID}: parent and child belong to different projects.`)
			}
			prior = terminalRecordForChild(childSessionID)
			const active = activeRecordForChild(childSessionID)
			if (active) {
				throw new Error(`Cannot resume subagent session ${childSessionID}: admission lease ${active.leaseID} is already ${active.status}. Wait for that execution to finish.`)
			}
			if (prior && (prior.parentSessionID !== input.parentSessionID || prior.rootSessionID !== lineage.rootSessionID)) {
				throw new Error(`Cannot resume session ${childSessionID}: its persisted parent/root does not match the current lineage.`)
			}
			if (!prior) {
				await waitForLegacyResumeIdle(childSessionID, input.signal)
				try {
					childInfo = await ctx.session.get({ sessionID: childSessionID })
				} catch (error) {
					throw new Error(`Cannot adopt legacy child session ${childSessionID} after waiting for it to become idle. ${errorText(error)}`)
				}
				if (childInfo.id !== childSessionID || childInfo.parentID !== input.parentSessionID || childInfo.projectID !== ctx.location.project.id || !sessionMatchesContext(childInfo)) {
					throw new Error(`Cannot adopt legacy child session ${childSessionID}: session identity, parent, or project changed while waiting.`)
				}
				if (!isFiniteNumber(childInfo.time.idle)) {
					throw new Error(`Cannot adopt legacy child session ${childSessionID}: the host did not provide an idle-generation marker.`)
				}
				adoptedUntrackedResume = true
			}
			childDepth = lineage.parentDepth + 1
			const maxDepth = config?.maxDepth ?? 3
			if (childDepth > maxDepth) {
				throw new Error(`Subagent resume blocked: child depth ${childDepth} exceeds background_task.maxDepth=${maxDepth}. OpenCode's own subagent depth cap remains independently enforced.`)
			}
			baselineIdle = isFiniteNumber(childInfo.time.idle) ? childInfo.time.idle : null
		}

		const now = Date.now()
		const lease: StoredLease = {
			version: 1,
			leaseID: randomUUID(),
			rootSessionID: lineage.rootSessionID,
			parentSessionID: input.parentSessionID,
			childSessionID,
			model,
			childDepth,
			mode: input.mode,
			status: "queued",
			generation: (prior?.generation ?? 0) + 1,
			baselineIdle,
			startedSeq: null,
			lastTerminalSeq: prior?.lastTerminalSeq ?? null,
			terminalEventID: null,
			outcome: null,
			createdAt: now,
			updatedAt: now,
			boundAt: null,
			creationStarted: false,
			supersedes: prior?.leaseID ?? null,
			adoptedUntrackedResume,
		}
		return { lease, lineage }
	}

	async function waitForLegacyResumeIdle(sessionID: string, signal?: AbortSignal): Promise<void> {
		if (signal?.aborted) throw abortError()
		try {
			await waitForNativeIdle(sessionID, signal)
		} catch (error) {
			if (signal?.aborted) throw abortError()
			if (disposed) throw new Error(`Cannot resume legacy child session ${sessionID}: this plugin instance stopped while waiting for the host idle check.`)
			throw new Error(`Cannot verify untracked child session ${sessionID} is idle; resume was not started. ${errorText(error)}`)
		}
	}

	async function waitForNativeIdle(sessionID: string, signal?: AbortSignal): Promise<void> {
		if (signal?.aborted) throw abortError()
		const controller = new AbortController()
		pendingIdleWaits.add(controller)
		let timedOut = false
		const timer = setTimeout(() => {
			timedOut = true
			controller.abort()
		}, SESSION_IDLE_WAIT_TIMEOUT_MS)
		const onAbort = () => controller.abort(signal?.reason)
		signal?.addEventListener("abort", onAbort, { once: true })
		if (signal?.aborted) onAbort()
		try {
			await ctx.session.wait({ sessionID }, { signal: controller.signal })
		} catch (error) {
			if (signal?.aborted) throw abortError()
			if (disposed) throw new Error("Plugin instance stopped while waiting for native session idle.")
			if (timedOut) {
				throw new Error(`Native session ${sessionID} did not become idle within ${SESSION_IDLE_WAIT_TIMEOUT_MS} ms. The session was not interrupted.`)
			}
			throw error
		} finally {
			clearTimeout(timer)
			signal?.removeEventListener("abort", onAbort)
			pendingIdleWaits.delete(controller)
		}
	}

	async function acquire(input: BackgroundAdmissionInput): Promise<BackgroundAdmissionTicket> {
		await ensureReady()
		assertHealthy()
		const { lease, lineage } = await createReservation(input)
		const maxDescendants = config?.maxLiveDescendantsPerRoot ?? 24
		await serialized(async () => {
			assertHealthy()
			if (input.mode === "resume") {
				const active = activeRecordForChild(input.sessionID)
				if (active) throw new Error(`Cannot resume subagent session ${input.sessionID}: admission lease ${active.leaseID} is already ${active.status}. Wait for that execution to finish.`)
				const terminal = terminalRecordForChild(input.sessionID)
				if (lease.adoptedUntrackedResume ? Boolean(terminal) : !terminal || terminal.leaseID !== lease.supersedes) {
					throw new Error(`Cannot safely reserve resume for session ${input.sessionID}: its terminal admission state changed while waiting.`)
				}
			}
			const current = activeForRoot(lease.rootSessionID)
			const pool = modelPool(lease)
			const ancestorPoolSlots = !pool.unlimited
				? current.filter((activeLease) => countsConcurrency(activeLease) && activeLease.childSessionID !== null &&
					lineage.sessionIDs.includes(activeLease.childSessionID) && modelPool(activeLease).key === pool.key)
				: []
			if (!pool.unlimited && ancestorPoolSlots.length >= pool.limit) {
				const blockingAncestor = ancestorPoolSlots[0]!
				throw new Error(`Subagent admission would deadlock: ancestor session ${blockingAncestor.childSessionID} already holds lease ${blockingAncestor.leaseID} in the full ${pool.key} concurrency pool (limit ${pool.limit}). The nested child cannot run until its caller releases that slot.`)
			}
			if (maxDescendants !== 0 && current.length >= maxDescendants) {
				throw new Error(`Subagent spawn blocked: root ${lease.rootSessionID} already has ${current.length} live descendant admissions, reaching background_task.maxLiveDescendantsPerRoot=${maxDescendants}. Blocking leases: ${blockersForRoot(lease.rootSessionID)}.`)
			}
			await persist(lease)
			records.set(lease.leaseID, lease)
		})
		try {
			await reserveSlot(lease, input.signal)
		} catch (error) {
			const latest = records.get(lease.leaseID)
			if (latest && latest.status !== "creating" && latest.status !== "running") {
				await serialized(() => rollbackRecordLocked(lease.leaseID, true)).catch(() => undefined)
			}
			throw error
		}

		return {
			leaseID: lease.leaseID,
			beginCreate: async () => {
				await ensureReady()
				await serialized(async () => {
					assertHealthy()
					if (input.signal?.aborted) {
						await rollbackRecordLocked(lease.leaseID, true)
						throw abortError()
					}
					const current = records.get(lease.leaseID)
					if (!current || current.status !== "reserved") {
						throw new Error(`Admission lease ${lease.leaseID} is not reserved for native execution.`)
					}
					if (current.creationStarted) throw new Error(`Admission lease ${lease.leaseID} already began native execution.`)
					await saveLease({ ...current, status: "creating", creationStarted: true, updatedAt: Date.now() })
				})
			},
			bind: async (childSessionID: string) => {
				await ensureReady()
				const current = records.get(lease.leaseID)
				if (!current || current.status !== "creating" || !current.creationStarted) {
					throw new Error(`Admission lease ${lease.leaseID} cannot bind before beginCreate().`)
				}
				let info: SessionInfo
				let parent: SessionInfo
				try {
					[info, parent] = await Promise.all([
						ctx.session.get({ sessionID: childSessionID }),
						ctx.session.get({ sessionID: current.parentSessionID }),
					])
				} catch (error) {
					throw new Error(`Could not bind admission lease ${lease.leaseID} to child session ${childSessionID}: ${errorText(error)}`)
				}
				if (info.id !== childSessionID || info.parentID !== current.parentSessionID) {
					throw new Error(`Native child session ${childSessionID} is not a direct child of ${current.parentSessionID}; lease ${lease.leaseID} remains held until the native call settles.`)
				}
				if (input.mode === "resume" && childSessionID !== input.sessionID) {
					throw new Error(`Native resume bound lease ${lease.leaseID} to unexpected session ${childSessionID}.`)
				}
				if (parent.id !== current.parentSessionID || !sessionMatchesContext(parent) || info.projectID !== parent.projectID || !sessionMatchesContext(info)) {
					throw new Error(`Native child session ${childSessionID} belongs to a different project; lease ${lease.leaseID} remains held until the native call settles.`)
				}
				if (info.model && `${info.model.providerID}/${info.model.id}` !== current.model) {
					throw new Error(`Native child session ${childSessionID} resolved to ${info.model.providerID}/${info.model.id}, not reserved model ${current.model}. Refusing to run outside the correct concurrency pool.`)
				}
				await serialized(async () => {
					assertHealthy()
					const latest = records.get(lease.leaseID)
					if (!latest || latest.status !== "creating") throw new Error(`Admission lease ${lease.leaseID} changed before child binding.`)
					if (input.mode === "new" && activeRecordForChild(childSessionID)) {
						throw new Error(`Native child session ${childSessionID} already has an active admission lease.`)
					}
					await saveLease({
						...latest,
						childSessionID,
						baselineIdle: isFiniteNumber(info.time.idle) ? info.time.idle : null,
						startedSeq: null,
						boundAt: Date.now(),
						status: "running",
						updatedAt: Date.now(),
					})
				})
				const bound = records.get(lease.leaseID)
				if (bound) {
					try {
						await activity?.bind(activityLease(bound))
					} catch (error) {
						failClosed(`Could not initialize activity monitoring for child ${childSessionID}: ${errorText(error)}`)
						throw error
					}
				}
			},
			rollback: async (options = {}) => {
				await ensureReady()
				const latest = records.get(lease.leaseID)
				if (!latest || latest.status === "terminal") return false
				if ((latest.status === "queued" || latest.status === "reserved") && !latest.creationStarted) {
					return serialized(() => rollbackRecordLocked(lease.leaseID, true))
				}
				if (latest.childSessionID) {
					if (!options.executionSettled) return false
					try {
						await waitForNativeIdle(latest.childSessionID)
					} catch {
						return false
					}
					let info: SessionInfo
					try {
						info = await ctx.session.get({ sessionID: latest.childSessionID })
					} catch (error) {
						if (!isSessionNotFound(error)) return false
						return serialized(async () => {
							const current = records.get(lease.leaseID)
							if (!current || current.generation !== latest.generation) return false
						const pool = modelPool(current)
						await removeLease(current)
						await admitWaiters(pool)
						return true
						})
					}
					if (disposed || info.id !== latest.childSessionID || info.parentID !== latest.parentSessionID || info.projectID !== ctx.location.project.id || !sessionMatchesContext(info)) return false
					return serialized(async () => {
						const current = records.get(lease.leaseID)
						if (!current || current.generation !== latest.generation || current.status === "terminal") return false
						await markTerminal(current.leaseID, current.generation, null, current.lastTerminalSeq, current.terminalEventID)
						return true
					})
				}
				return serialized(() => rollbackRecordLocked(
					lease.leaseID,
					Boolean(options.executionSettled) || !latest.creationStarted,
				))
			},
		}
	}

	async function releaseFromEvent(event: AdmissionEvent): Promise<void> {
		const sessionID = typeof event.data?.sessionID === "string" ? event.data.sessionID : undefined
		if (!sessionID) return
		await ensureReady()
		if (event.type === "session.deleted") {
			await serialized(async () => {
				for (const lease of [...records.values()].filter((item) => item.childSessionID === sessionID)) {
					const pool = modelPool(lease)
					await removeLease(lease)
					await admitWaiters(pool)
				}
			})
			return
		}
		if (event.durable?.aggregateID !== sessionID || !Number.isInteger(event.durable.seq)) return
		const seq = event.durable.seq!
		const lease = activeRecordForChild(sessionID)
		if (!lease) return
		if (lease.lastTerminalSeq !== null && seq <= lease.lastTerminalSeq) return
		if (event.type === "session.execution.started") {
			await serialized(async () => {
				const current = records.get(lease.leaseID)
				if (!current || current.generation !== lease.generation || current.status !== "running") return
				// There is no prior durable seq baseline for an adopted legacy child.
				// Ignore potentially queued event history and reconcile terminal via idle.
				if (current.adoptedUntrackedResume) return
				if (current.lastTerminalSeq !== null && seq <= current.lastTerminalSeq) return
				if (current.startedSeq !== null && seq <= current.startedSeq) return
				await saveLease({ ...current, startedSeq: seq, updatedAt: Date.now() })
			})
			return
		}
		const outcome = event.type === "session.execution.succeeded"
			? "succeeded"
			: event.type === "session.execution.failed"
				? "failed"
				: event.type === "session.execution.interrupted"
					? "interrupted"
					: undefined
		if (!outcome) return
		// A resumed session may replay its prior generation's start/terminal event
		// after the new reservation is bound but before the plugin consumes the
		// current generation's events. Durable sequence ordering cannot identify
		// which invocation an event belongs to, so resumes require the public
		// session idle marker to advance beyond the bind-time baseline.
		if (lease.mode !== "resume" && !lease.adoptedUntrackedResume && lease.startedSeq !== null && seq > lease.startedSeq) {
			await serialized(() => markTerminal(lease.leaseID, lease.generation, outcome, seq, event.id ?? null))
			return
		}
		// A restart may have missed `started`, and a resumed session may still
		// deliver a prior generation's events. Outcome alone is historical, so
		// only a newer idle timestamp than the bind-time baseline can release it.
		let info: SessionInfo
		try {
			info = await ctx.session.get({ sessionID })
		} catch (error) {
			if (isSessionNotFound(error)) {
				await serialized(async () => {
					const current = records.get(lease.leaseID)
					if (!current || current.generation !== lease.generation) return
					const pool = modelPool(current)
					await removeLease(current)
					await admitWaiters(pool)
				})
			}
			return
		}
		if (info.id !== sessionID || info.parentID !== lease.parentSessionID || info.projectID !== ctx.location.project.id || !sessionMatchesContext(info) || !isTerminalIdleForLease(info, lease)) return
		await serialized(() => markTerminal(lease.leaseID, lease.generation, info.outcome!, seq, event.id ?? null))
	}

	async function handleExecutionEvent(event: unknown): Promise<void> {
		if (disposed) return
		if (!isObject(event)) return
		try {
			await ensureReady()
			await activity?.observe(event)
			await releaseFromEvent(event as AdmissionEvent)
			if (event.type === "session.deleted" && typeof (event as AdmissionEvent).data?.sessionID === "string") {
				await activity?.removeSession((event as AdmissionEvent).data!.sessionID!)
			}
		} catch (error) {
			failClosed(`Execution event reconciliation failed: ${errorText(error)}`)
		}
	}

	function dispose(): Promise<void> {
		if (disposePromise) return disposePromise
		// Close the public admission path before awaiting activity flushes so a new
		// caller cannot begin native work during plugin teardown.
		disposed = true
		disposePromise = (async () => {
			await ensureReady()
			activity?.stop()
			try {
				await activity?.dispose()
			} catch (error) {
				// A failed activity flush has already been surfaced through the
				// fail-closed diagnostic path. Still dispose queued admission state.
				failClosed(`Could not flush child activity during disposal: ${errorText(error)}`)
			}
			await serialized(async () => {
			for (const pending of pendingIdleWaits) pending.abort()
			for (const queue of waiters.values()) {
				for (const waiter of queue.splice(0)) {
					if (waiter.settled) continue
					settleWaiter(waiter)
					try {
						await rollbackRecordLocked(waiter.leaseID, true, false)
						waiter.reject(new Error("Background admission disposed while waiting for concurrency."))
					} catch (error) {
						waiter.reject(error instanceof Error ? error : new Error(String(error)))
					}
				}
			}
			waiters.clear()
			for (const lease of [...records.values()]) {
				if (lease.status === "queued" || lease.status === "reserved") {
					try { await rollbackRecordLocked(lease.leaseID, true, false) } catch { /* persisted reservation stays fail-closed */ }
				}
			}
			})
		})()
		return disposePromise
	}

	return {
		ready: ensureReady,
		acquire,
		observeExecution: handleExecutionEvent,
		async diagnostics() {
			await ensureReady()
			return {
				...(unhealthy ? { unhealthy } : {}),
				activeLeases: [...records.values()].filter(isActiveLease).map((lease) => ({
					leaseID: lease.leaseID,
					status: lease.status,
					rootSessionID: lease.rootSessionID,
					parentSessionID: lease.parentSessionID,
					...(lease.childSessionID ? { childSessionID: lease.childSessionID } : {}),
					model: lease.model,
					unboundAfterCreate: lease.status === "creating" && lease.creationStarted && lease.childSessionID === null,
				})),
				queuedWaiters: Object.fromEntries([...waiters.entries()].map(([key, queue]) => [key, queue.filter((waiter) => !waiter.settled).length])),
			}
		},
		dispose,
	}
}
