import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Plugin } from "@opencode/plugin"
import type { BackgroundTaskConfig } from "../config/schema"
import {
	createV2BackgroundAdmission,
	resolveBackgroundAdmissionPool,
	type AdmissionEvent,
	type AdmissionModel,
} from "./background-admission"

const chosenModel: AdmissionModel = { providerID: "provider", id: "family/model/with/slash" }
const rootID = "ses-root"
const keyPrefix = "oh-my-openagent:v2:background-admission:lease:project-main:workspace-main:%2Frepo:"

type FakeSession = Record<string, any>

function info(id: string, overrides: Partial<FakeSession> = {}): FakeSession {
	return {
		id,
		parentID: undefined,
		projectID: "project-main",
		location: { directory: "/repo" },
		model: { providerID: chosenModel.providerID, id: chosenModel.id },
		time: { created: 1, updated: 1, idle: 10 },
		...overrides,
	}
}

function harness(options: {
	config?: BackgroundTaskConfig
	directory?: string
	projectID?: string
	workspaceID?: string
	rootSessionID?: string
	storageValues?: Map<string, unknown>
	seed?: Record<string, FakeSession>
	setFailure?: () => Error | undefined
	removeFailure?: () => Error | undefined
	wait?: (sessionID: string, signal?: AbortSignal) => Promise<void>
	get?: (sessionID: string, sessions: Map<string, FakeSession>) => Promise<FakeSession>
} = {}) {
	const values = options.storageValues ?? new Map<string, unknown>()
	const directory = options.directory ?? "/repo"
	const projectID = options.projectID ?? "project-main"
	const rootSessionID = options.rootSessionID ?? rootID
	const workspaceID = options.workspaceID ?? "workspace-main"
	const sessionInfo = (id: string, overrides: Partial<FakeSession> = {}) => info(id, {
		projectID,
		location: { directory },
		...overrides,
	})
	const sessions = new Map<string, FakeSession>([
		[rootSessionID, sessionInfo(rootSessionID)],
		...Object.entries(options.seed ?? {}).map(([id, session]) => [id, sessionInfo(id, session)] as const),
	])
	const storage = {
		get: async (key: string) => values.get(key),
		set: async (key: string, value: unknown) => {
			const failure = options.setFailure?.()
			if (failure) throw failure
			values.set(key, structuredClone(value))
		},
		remove: async (key: string) => {
			const failure = options.removeFailure?.()
			if (failure) throw failure
			values.delete(key)
		},
		scan: async ({ prefix, after, limit = 100 }: { prefix: string; after?: string; limit?: number }) => {
			const keys = [...values.keys()].filter((key) => key.startsWith(prefix)).sort().filter((key) => !after || key > after)
			const page = keys.slice(0, limit)
			return {
				entries: page.map((key) => ({ key, value: values.get(key) as any })),
				...(keys.length > page.length ? { next: page[page.length - 1] } : {}),
			}
		},
	}
	const ctx = {
		location: { directory, workspaceID, project: { id: projectID } },
		storage,
		session: {
			wait: async ({ sessionID }: { sessionID: string }, requestOptions?: { signal?: AbortSignal }) =>
				options.wait?.(sessionID, requestOptions?.signal),
			get: async ({ sessionID }: { sessionID: string }) => {
				if (options.get) return options.get(sessionID, sessions)
				const result = sessions.get(sessionID)
				if (!result) throw Object.assign(new Error("missing session"), { _tag: "SessionNotFoundError", sessionID })
				return result
			},
		},
	} as unknown as Plugin.Context
	return {
		values,
		sessions,
		create: (config = options.config) => createV2BackgroundAdmission(ctx, config),
	}
}

function executionEvent(type: string, sessionID: string, seq: number, id = "event-" + seq): AdmissionEvent {
	return { type, id, data: { sessionID }, durable: { aggregateID: sessionID, seq } }
}

async function waitFor(predicate: () => Promise<boolean>): Promise<void> {
	const deadline = Date.now() + 1000
	while (!(await predicate()) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 2))
	expect(await predicate()).toBe(true)
}

async function bindNew(manager: ReturnType<typeof createV2BackgroundAdmission>, sessions: Map<string, FakeSession>, childID: string) {
	const ticket = await manager.acquire({ parentSessionID: rootID, model: chosenModel, mode: "new" })
	await ticket.beginCreate()
	sessions.set(childID, info(childID, { parentID: rootID }))
	await ticket.bind(childID)
	return ticket
}

async function finish(manager: ReturnType<typeof createV2BackgroundAdmission>, childID: string, firstSeq: number): Promise<void> {
	await manager.observeExecution(executionEvent("session.execution.started", childID, firstSeq))
	await manager.observeExecution(executionEvent("session.execution.succeeded", childID, firstSeq + 1))
}

function persistedLease(overrides: Record<string, unknown> = {}) {
	return {
		version: 1,
		leaseID: "restored",
		rootSessionID: rootID,
		parentSessionID: rootID,
		childSessionID: "ses-restored",
		model: "provider/family/model/with/slash",
		childDepth: 1,
		mode: "new",
		status: "running",
		generation: 1,
		baselineIdle: 10,
		startedSeq: null,
		lastTerminalSeq: null,
		terminalEventID: null,
		outcome: null,
		createdAt: 1,
		updatedAt: 1,
		creationStarted: true,
		supersedes: null,
		adoptedUntrackedResume: false,
		...overrides,
	}
}

describe("native V2 background admission", () => {
	test("uses exact model, provider, and default precedence; zero and fractional limits match V1", () => {
		const key = "provider/family/model/with/slash"
		expect(resolveBackgroundAdmissionPool(undefined, key)).toEqual({ key: "model:" + key, limit: 5, unlimited: false })
		expect(resolveBackgroundAdmissionPool({ defaultConcurrency: 0 } as BackgroundTaskConfig, key)).toEqual({ key: "model:" + key, limit: 0, unlimited: true })
		expect(resolveBackgroundAdmissionPool({ providerConcurrency: { provider: 2.5 } } as BackgroundTaskConfig, key)).toEqual({ key: "provider:provider", limit: 2.5, unlimited: false })
		expect(resolveBackgroundAdmissionPool({
			providerConcurrency: { provider: 4 },
			modelConcurrency: { [key]: 0.5 },
		} as BackgroundTaskConfig, key)).toEqual({ key: "model:" + key, limit: 0.5, unlimited: false })
	})

	test("serializes FIFO slot transfer and accounts for fractional limits without flooring", async () => {
		const h = harness({ config: { defaultConcurrency: 1 } as BackgroundTaskConfig })
		const manager = h.create()
		await bindNew(manager, h.sessions, "ses-first")
		const secondPromise = manager.acquire({ parentSessionID: rootID, model: chosenModel, mode: "new" })
		const thirdPromise = manager.acquire({ parentSessionID: rootID, model: chosenModel, mode: "new" })
		await waitFor(async () => (await manager.diagnostics()).queuedWaiters["model:provider/family/model/with/slash"] === 2)
		await finish(manager, "ses-first", 1)
		const second = await secondPromise
		await waitFor(async () => (await manager.diagnostics()).queuedWaiters["model:provider/family/model/with/slash"] === 1)
		expect((await manager.diagnostics()).activeLeases.map((lease) => lease.leaseID)).toContain(second.leaseID)
		expect(await second.rollback()).toBe(true)
		const third = await thirdPromise
		expect((await manager.diagnostics()).queuedWaiters).toEqual({})
		await third.rollback()
		await manager.dispose()

		const fractional = harness({ config: { defaultConcurrency: 0.5 } as BackgroundTaskConfig })
		const fractionalManager = fractional.create()
		const first = await fractionalManager.acquire({ parentSessionID: rootID, model: chosenModel, mode: "new" })
		const queued = fractionalManager.acquire({ parentSessionID: rootID, model: chosenModel, mode: "new" })
		await waitFor(async () => (await fractionalManager.diagnostics()).queuedWaiters["model:provider/family/model/with/slash"] === 1)
		await first.rollback()
		const admitted = await queued
		await admitted.rollback()
		await fractionalManager.dispose()
	})

	test("zero concurrency is unlimited and descendant/depth caps remain enforced", async () => {
		const unlimited = harness({ config: { defaultConcurrency: 0 } as BackgroundTaskConfig })
		const manager = unlimited.create()
		const tickets = await Promise.all(Array.from({ length: 3 }, () =>
			manager.acquire({ parentSessionID: rootID, model: chosenModel, mode: "new" })))
		expect((await manager.diagnostics()).queuedWaiters).toEqual({})
		await Promise.all(tickets.map((ticket) => ticket.rollback()))
		await manager.dispose()

		const bounded = harness({
			config: { maxDepth: 1, maxLiveDescendantsPerRoot: 1, defaultConcurrency: 0 } as BackgroundTaskConfig,
		})
		const limited = bounded.create()
		const first = await limited.acquire({ parentSessionID: rootID, model: chosenModel, mode: "new" })
		await expect(limited.acquire({ parentSessionID: rootID, model: chosenModel, mode: "new" })).rejects.toThrow("maxLiveDescendantsPerRoot=1")
		await first.beginCreate()
		bounded.sessions.set("ses-child", info("ses-child", { parentID: rootID }))
		await first.bind("ses-child")
		await expect(limited.acquire({ parentSessionID: "ses-child", model: chosenModel, mode: "new" })).rejects.toThrow("maxDepth=1")
		await limited.dispose()
	})

	test("fails closed on cyclic, cross-project, and mismatched session lookups", async () => {
		const cyclic = harness({ seed: {
			"ses-a": info("ses-a", { parentID: "ses-b" }),
			"ses-b": info("ses-b", { parentID: "ses-a" }),
		} })
		await expect(cyclic.create().acquire({ parentSessionID: "ses-a", model: chosenModel, mode: "new" })).rejects.toThrow("parent cycle")

		const wrongProject = harness({ seed: { "ses-other": info("ses-other", { projectID: "project-other" }) } })
		await expect(wrongProject.create().acquire({ parentSessionID: "ses-other", model: chosenModel, mode: "new" })).rejects.toThrow("another OpenCode project")
		const wrongLocation = harness({ seed: { "ses-other-location": info("ses-other-location", { location: { directory: "/another-worktree" } }) } })
		await expect(wrongLocation.create().acquire({ parentSessionID: "ses-other-location", model: chosenModel, mode: "new" })).rejects.toThrow("another OpenCode project or workspace")

		const realDirectory = mkdtempSync(join(tmpdir(), "omo-admission-location-"))
		const aliasDirectory = `${realDirectory}-alias`
		symlinkSync(realDirectory, aliasDirectory)
		try {
			const canonical = harness({
				directory: realDirectory,
				seed: { "ses-location-alias": info("ses-location-alias", { location: { directory: aliasDirectory } }) },
			})
			const ticket = await canonical.create().acquire({ parentSessionID: "ses-location-alias", model: chosenModel, mode: "new" })
			await ticket.rollback()
		} finally {
			rmSync(aliasDirectory)
			rmSync(realDirectory, { recursive: true, force: true })
		}

		const wrongIdentity = harness({ get: async (_id) => info("not-the-requested-session") })
		await expect(wrongIdentity.create().acquire({ parentSessionID: rootID, model: chosenModel, mode: "new" })).rejects.toThrow("different or missing identity")
	})

	test("keeps uncertain post-create reservations, but settled pre-progress failures release them", async () => {
		const h = harness({ config: { defaultConcurrency: 0 } as BackgroundTaskConfig })
		const manager = h.create()
		const uncertain = await manager.acquire({ parentSessionID: rootID, model: chosenModel, mode: "new" })
		await uncertain.beginCreate()
		expect(await uncertain.rollback()).toBe(false)
		expect((await manager.diagnostics()).activeLeases[0]?.unboundAfterCreate).toBe(true)
		expect(await uncertain.rollback({ executionSettled: true })).toBe(true)
		expect((await manager.diagnostics()).activeLeases).toEqual([])

		const resumeHarness = harness({ config: { defaultConcurrency: 0 } as BackgroundTaskConfig })
		const resumeManager = resumeHarness.create()
		await bindNew(resumeManager, resumeHarness.sessions, "ses-resume-abort")
		await finish(resumeManager, "ses-resume-abort", 1)
		const resume = await resumeManager.acquire({
			parentSessionID: rootID, model: chosenModel, mode: "resume", sessionID: "ses-resume-abort",
		})
		expect(await resume.rollback()).toBe(true)
		expect((await resumeManager.diagnostics()).activeLeases).toEqual([])
		await resumeManager.dispose()
		await manager.dispose()
	})

	test("does not release a bound lease after tool settlement until native session.wait proves idle", async () => {
		let startWait!: () => void
		let completeWait!: () => void
		const waiting = new Promise<void>((resolve) => { completeWait = resolve })
		const started = new Promise<void>((resolve) => { startWait = resolve })
		const h = harness({
			config: { defaultConcurrency: 0 } as BackgroundTaskConfig,
			wait: async () => { startWait(); await waiting },
		})
		const manager = h.create()
		const ticket = await bindNew(manager, h.sessions, "ses-bound-wait")
		h.sessions.get("ses-bound-wait")!.outcome = "succeeded" // historical; idle has not advanced
		const rollback = ticket.rollback({ executionSettled: true })
		await started
		expect((await manager.diagnostics()).activeLeases.some((lease) => lease.leaseID === ticket.leaseID)).toBe(true)
		h.sessions.get("ses-bound-wait")!.time.idle = 11
		await finish(manager, "ses-bound-wait", 20)
		expect((await manager.diagnostics()).activeLeases).toEqual([])
		completeWait()
		await rollback
		await manager.dispose()
	})

	test("releases completed generations once and ignores old terminal replay after resume", async () => {
		const h = harness({ config: { defaultConcurrency: 1 } as BackgroundTaskConfig })
		const manager = h.create()
		await bindNew(manager, h.sessions, "ses-reused")
		await finish(manager, "ses-reused", 10)
		h.sessions.get("ses-reused")!.time.idle = 11
		h.sessions.get("ses-reused")!.outcome = "succeeded"
		const resumed = await manager.acquire({
			parentSessionID: rootID, model: chosenModel, mode: "resume", sessionID: "ses-reused",
		})
		await resumed.beginCreate()
		await resumed.bind("ses-reused")
		await manager.observeExecution(executionEvent("session.execution.succeeded", "ses-reused", 11, "old-terminal"))
		expect((await manager.diagnostics()).activeLeases.some((lease) => lease.leaseID === resumed.leaseID)).toBe(true)
		await manager.observeExecution(executionEvent("session.execution.started", "ses-reused", 12))
		h.sessions.get("ses-reused")!.time.idle = 12
		h.sessions.get("ses-reused")!.outcome = "succeeded"
		await manager.observeExecution(executionEvent("session.execution.succeeded", "ses-reused", 13))
		expect((await manager.diagnostics()).activeLeases.some((lease) => lease.leaseID === resumed.leaseID)).toBe(false)
		await manager.dispose()
	})

	test("does not mistake delayed prior-generation events for a resumed child completion", async () => {
		const h = harness({ config: { defaultConcurrency: 1 } as BackgroundTaskConfig })
		const manager = h.create()
		const first = await bindNew(manager, h.sessions, "ses-delayed-resume-events")
		const child = h.sessions.get("ses-delayed-resume-events")!
		child.time.idle = 11
		child.outcome = "succeeded"
		// Foreground native execution settled before the event subscriber consumed
		// its start/terminal events; rollback safely closes generation one by wait.
		expect(await first.rollback({ executionSettled: true })).toBe(true)

		const second = await manager.acquire({
			parentSessionID: rootID,
			model: chosenModel,
			mode: "resume",
			sessionID: "ses-delayed-resume-events",
		})
		await second.beginCreate()
		await second.bind("ses-delayed-resume-events")
		const bound = (await manager.diagnostics()).activeLeases.find((lease) => lease.leaseID === second.leaseID)
		expect(bound?.status).toBe("running")

		// Replayed generation-one events have higher durable sequence numbers
		// relative to this fresh lease's null sequence baseline, but no new idle.
		await manager.observeExecution(executionEvent("session.execution.started", "ses-delayed-resume-events", 100, "old-start"))
		await manager.observeExecution(executionEvent("session.execution.succeeded", "ses-delayed-resume-events", 101, "old-terminal"))
		expect((await manager.diagnostics()).activeLeases.some((lease) => lease.leaseID === second.leaseID)).toBe(true)

		child.time.idle = 12
		child.outcome = "succeeded"
		await manager.observeExecution(executionEvent("session.execution.succeeded", "ses-delayed-resume-events", 102, "new-terminal"))
		expect((await manager.diagnostics()).activeLeases.some((lease) => lease.leaseID === second.leaseID)).toBe(false)
		await manager.dispose()
	})

	test("rejects a concurrent duplicate resume and applies depth to resume too", async () => {
		const h = harness({ config: { defaultConcurrency: 0 } as BackgroundTaskConfig })
		const manager = h.create()
		await bindNew(manager, h.sessions, "ses-resume-race")
		await finish(manager, "ses-resume-race", 1)
		const results = await Promise.allSettled([
			manager.acquire({ parentSessionID: rootID, model: chosenModel, mode: "resume", sessionID: "ses-resume-race" }),
			manager.acquire({ parentSessionID: rootID, model: chosenModel, mode: "resume", sessionID: "ses-resume-race" }),
		])
		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1)
		expect(results.filter((result) => result.status === "rejected")).toHaveLength(1)
		await manager.dispose()

		const resumeConfig = { maxDepth: 3, defaultConcurrency: 0 } as BackgroundTaskConfig
		const deeper = harness({ config: resumeConfig, seed: {
			"ses-parent-child": info("ses-parent-child", { parentID: rootID }),
		} })
		const depthManager = deeper.create()
		const deepTicket = await depthManager.acquire({ parentSessionID: "ses-parent-child", model: chosenModel, mode: "new" })
		await deepTicket.beginCreate()
		deeper.sessions.set("ses-too-deep", info("ses-too-deep", { parentID: "ses-parent-child" }))
		await deepTicket.bind("ses-too-deep")
		await finish(depthManager, "ses-too-deep", 1)
		resumeConfig.maxDepth = 1
		await expect(depthManager.acquire({
			parentSessionID: "ses-parent-child", model: chosenModel, mode: "resume", sessionID: "ses-too-deep",
		})).rejects.toThrow("resume blocked")
		await depthManager.dispose()
	})

	test("applies the root descendant cap to resumed children and fails fast on ancestor pool deadlock", async () => {
		const cap = harness({ config: { maxLiveDescendantsPerRoot: 1, defaultConcurrency: 0 } as BackgroundTaskConfig })
		const manager = cap.create()
		await bindNew(manager, cap.sessions, "ses-terminal-sibling")
		await finish(manager, "ses-terminal-sibling", 1)
		await bindNew(manager, cap.sessions, "ses-active-sibling")
		await expect(manager.acquire({
			parentSessionID: rootID, model: chosenModel, mode: "resume", sessionID: "ses-terminal-sibling",
		})).rejects.toThrow("maxLiveDescendantsPerRoot=1")
		await manager.dispose()

		const deadlock = harness({ config: { modelConcurrency: { "provider/family/model/with/slash": 1 } } as BackgroundTaskConfig })
		const nested = deadlock.create()
		await bindNew(nested, deadlock.sessions, "ses-nested-parent")
		await expect(nested.acquire({ parentSessionID: "ses-nested-parent", model: chosenModel, mode: "new" }))
			.rejects.toThrow("would deadlock")
		expect((await nested.diagnostics()).queuedWaiters).toEqual({})
		await nested.dispose()

		const partialAncestorUse = harness({ config: { modelConcurrency: { "provider/family/model/with/slash": 2 } } as BackgroundTaskConfig })
		const capacityTwo = partialAncestorUse.create()
		await bindNew(capacityTwo, partialAncestorUse.sessions, "ses-nested-caller")
		await bindNew(capacityTwo, partialAncestorUse.sessions, "ses-completing-sibling")
		const nestedChild = capacityTwo.acquire({ parentSessionID: "ses-nested-caller", model: chosenModel, mode: "new" })
		await waitFor(async () => (await capacityTwo.diagnostics()).queuedWaiters["model:provider/family/model/with/slash"] === 1)
		await finish(capacityTwo, "ses-completing-sibling", 40)
		const admitted = await nestedChild
		expect((await capacityTwo.diagnostics()).queuedWaiters).toEqual({})
		await admitted.rollback()
		await capacityTwo.dispose()
	})

	test("restart reconciliation requires idle newer than the bound generation", async () => {
		const h = harness({ seed: {
			"ses-restored": info("ses-restored", {
				parentID: rootID, outcome: "succeeded", time: { created: 1, updated: 2, idle: 11 },
			}),
		} })
		h.values.set(keyPrefix + "restored", persistedLease())
		const manager = h.create()
		await manager.ready()
		expect((await manager.diagnostics()).activeLeases).toEqual([])
		await manager.dispose()

		const same = harness({ seed: {
			"ses-restored": info("ses-restored", {
				parentID: rootID, outcome: "succeeded", time: { created: 1, updated: 2, idle: 10 },
			}),
		} })
		same.values.set(keyPrefix + "restored", persistedLease())
		const held = same.create()
		await held.ready()
		expect((await held.diagnostics()).activeLeases).toHaveLength(1)
		await held.dispose()
	})

	test("scopes plugin storage leases by project and canonical location", async () => {
		const shared = new Map<string, unknown>()
		const first = harness({ storageValues: shared, config: { defaultConcurrency: 1 } as BackgroundTaskConfig })
		const firstManager = first.create()
		await bindNew(firstManager, first.sessions, "ses-first-location-child")

		const second = harness({
			storageValues: shared,
			projectID: "project-other",
			workspaceID: "workspace-other",
			directory: "/another-project",
			rootSessionID: "ses-other-root",
			config: { defaultConcurrency: 1 } as BackgroundTaskConfig,
		})
		const secondManager = second.create()
		await secondManager.ready()
		expect((await secondManager.diagnostics()).activeLeases).toEqual([])
		const independent = await secondManager.acquire({ parentSessionID: "ses-other-root", model: chosenModel, mode: "new" })
		expect((await secondManager.diagnostics()).activeLeases).toHaveLength(1)
		await independent.rollback()
		await secondManager.dispose()
		await firstManager.dispose()
	})

	test("adopts an untracked legacy child only after abortable native idle wait", async () => {
		let waitSignal: AbortSignal | undefined
		const h = harness({
			config: { defaultConcurrency: 0 } as BackgroundTaskConfig,
			seed: { "ses-legacy": info("ses-legacy", { parentID: rootID, outcome: "succeeded" }) },
			wait: async (_sessionID, signal) => { waitSignal = signal },
		})
		const manager = h.create()
		const ticket = await manager.acquire({ parentSessionID: rootID, model: chosenModel, mode: "resume", sessionID: "ses-legacy" })
		expect(waitSignal?.aborted).toBe(false)
		await ticket.beginCreate()
		await ticket.bind("ses-legacy")
		await manager.observeExecution(executionEvent("session.execution.started", "ses-legacy", 1))
		await manager.observeExecution(executionEvent("session.execution.succeeded", "ses-legacy", 2))
		expect((await manager.diagnostics()).activeLeases.some((lease) => lease.leaseID === ticket.leaseID)).toBe(true)
		h.sessions.get("ses-legacy")!.time.idle = 11
		h.sessions.get("ses-legacy")!.outcome = "succeeded"
		await manager.observeExecution(executionEvent("session.execution.succeeded", "ses-legacy", 3))
		expect((await manager.diagnostics()).activeLeases.some((lease) => lease.leaseID === ticket.leaseID)).toBe(false)
		await manager.dispose()

		let waitStarted!: () => void
		const started = new Promise<void>((resolve) => { waitStarted = resolve })
		let waitAbort: AbortSignal | undefined
		const cancelled = harness({
			seed: { "ses-legacy": info("ses-legacy", { parentID: rootID }) },
			wait: async (_sessionID, signal) => {
				waitAbort = signal
				waitStarted()
				await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }))
			},
		})
		const cancelManager = cancelled.create()
		const controller = new AbortController()
		const pending = cancelManager.acquire({ parentSessionID: rootID, model: chosenModel, mode: "resume", sessionID: "ses-legacy", signal: controller.signal })
		await started
		controller.abort()
		await expect(pending).rejects.toThrow("cancelled")
		expect(waitAbort?.aborted).toBe(true)
		await cancelManager.dispose()
	})

	test("only typed SessionNotFound prunes persisted leases; transient errors retain them", async () => {
		const missing = harness({ get: async (sessionID) => {
			if (sessionID === "ses-restored") throw Object.assign(new Error("missing"), { _tag: "SessionNotFoundError", sessionID })
			return info(sessionID)
		} })
		missing.values.set(keyPrefix + "restored", persistedLease())
		const removed = missing.create()
		await removed.ready()
		expect((await removed.diagnostics()).activeLeases).toEqual([])
		await removed.dispose()

		const transient = harness({ get: async () => { throw new Error("network outage") } })
		transient.values.set(keyPrefix + "restored", persistedLease())
		const retained = transient.create()
		await retained.ready()
		expect((await retained.diagnostics()).activeLeases).toHaveLength(1)
		await retained.dispose()
	})

	test("storage failures never grant or free a slot", async () => {
		const failedSet = harness({ setFailure: () => new Error("disk full") })
		const noGrant = failedSet.create()
		await expect(noGrant.acquire({ parentSessionID: rootID, model: chosenModel, mode: "new" })).rejects.toThrow("could not persist lease")
		expect((await noGrant.diagnostics()).unhealthy).toContain("disk full")
		await noGrant.dispose()

		let failRemove = false
		const failedRemove = harness({
			config: { defaultConcurrency: 1 } as BackgroundTaskConfig,
			removeFailure: () => failRemove ? new Error("storage unavailable") : undefined,
		})
		const manager = failedRemove.create()
		await bindNew(manager, failedRemove.sessions, "ses-removal")
		const abort = new AbortController()
		const stored = manager.acquire({ parentSessionID: rootID, model: chosenModel, mode: "new", signal: abort.signal })
		await waitFor(async () => (await manager.diagnostics()).queuedWaiters["model:provider/family/model/with/slash"] === 1)
		failRemove = true
		abort.abort()
		await expect(stored).rejects.toThrow("could not safely release lease")
		expect((await manager.diagnostics()).unhealthy).toContain("storage unavailable")
		expect((await manager.diagnostics()).activeLeases).toHaveLength(2)
		await manager.dispose()
	})

	test("storage reconciliation failure promptly rejects queued admissions", async () => {
		let failWrites = false
		const h = harness({
			config: { defaultConcurrency: 1 } as BackgroundTaskConfig,
			setFailure: () => failWrites ? new Error("disk unavailable during event") : undefined,
		})
		const manager = h.create()
		await bindNew(manager, h.sessions, "ses-running")
		const queued = manager.acquire({ parentSessionID: rootID, model: chosenModel, mode: "new" })
		await waitFor(async () => (await manager.diagnostics()).queuedWaiters["model:provider/family/model/with/slash"] === 1)
		failWrites = true
		await manager.observeExecution(executionEvent("session.execution.started", "ses-running", 100))
		await expect(queued).rejects.toThrow("fail-closed")
		expect((await manager.diagnostics()).unhealthy).toContain("disk unavailable during event")
		expect((await manager.diagnostics()).queuedWaiters).toEqual({})
		await manager.dispose()
	})

	test("queued waiters abort or reject on disposal without releasing active children", async () => {
		const h = harness({ config: { defaultConcurrency: 1 } as BackgroundTaskConfig })
		const manager = h.create()
		await bindNew(manager, h.sessions, "ses-active")
		const controller = new AbortController()
		const queued = manager.acquire({ parentSessionID: rootID, model: chosenModel, mode: "new", signal: controller.signal })
		await waitFor(async () => (await manager.diagnostics()).queuedWaiters["model:provider/family/model/with/slash"] === 1)
		controller.abort()
		await expect(queued).rejects.toThrow("cancelled")
		expect((await manager.diagnostics()).activeLeases).toHaveLength(1)
		const pending = manager.acquire({ parentSessionID: rootID, model: chosenModel, mode: "new" })
		await waitFor(async () => (await manager.diagnostics()).queuedWaiters["model:provider/family/model/with/slash"] === 1)
		await manager.dispose()
		await expect(pending).rejects.toThrow("disposed")
	})
})
