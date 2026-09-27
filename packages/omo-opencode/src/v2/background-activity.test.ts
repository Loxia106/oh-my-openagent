import { describe, expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin"
import type { BackgroundTaskConfig } from "../config/schema"
import {
	createV2BackgroundActivityMonitor,
	decodeBackgroundActivityState,
	type BackgroundActivityClock,
	type BackgroundActivityEvent,
	type BackgroundActivityLease,
	type BackgroundActivityState,
} from "./background-activity"

type Session = Record<string, unknown>

function session(id: string, patch: Record<string, unknown> = {}): Session {
	return {
		id,
		parentID: "ses-parent",
		projectID: "project-a",
		location: { directory: "/workspace" },
		model: { providerID: "provider-a", id: "model-a" },
		time: { created: 1, updated: 1, idle: 500 },
		...patch,
	}
}

function fakeClock(startAt = 100_000) {
	let now = startAt
	let sequence = 0
	const timers = new Map<{ id: number }, { dueAt: number; callback: () => void }>()
	const clock: BackgroundActivityClock = {
		now: () => now,
		setTimeout(callback, delayMs) {
			const id = { id: ++sequence }
			timers.set(id, { dueAt: now + delayMs, callback })
			return id
		},
		clearTimeout(timer) {
			timers.delete(timer as { id: number })
		},
	}
	return {
		clock,
		get now() { return now },
		get activeTimerCount() { return timers.size },
		async advanceBy(milliseconds: number) {
			const target = now + milliseconds
			while (true) {
				const next = [...timers.entries()]
					.filter(([, timer]) => timer.dueAt <= target)
					.sort((a, b) => a[1].dueAt - b[1].dueAt || a[0].id - b[0].id)[0]
				if (!next) break
				const [id, timer] = next
				timers.delete(id)
				now = timer.dueAt
				timer.callback()
				for (let turn = 0; turn < 30; turn++) await Promise.resolve()
			}
			now = target
			for (let turn = 0; turn < 30; turn++) await Promise.resolve()
		},
	}
}

function deferred() {
	let resolve!: () => void
	const promise = new Promise<void>((done) => { resolve = done })
	return { promise, resolve }
}

function harness(options: {
	config?: BackgroundTaskConfig
	clock?: ReturnType<typeof fakeClock>
	lease?: Partial<BackgroundActivityLease>
	info?: Session
	getError?: () => unknown
	beforeGet?: () => Promise<void> | void
	beforeSet?: (value: unknown) => Promise<void> | void
	reconcile?: (info: Session) => Promise<boolean> | boolean
} = {}) {
	const time = options.clock ?? fakeClock()
	const values = new Map<string, unknown>()
	let info = options.info ?? session("ses-child")
	let writes = 0
	let removes = 0
	let interrupts = 0
	let reconciliations = 0
	let missing = 0
	const failures: string[] = []
	const lease: BackgroundActivityLease = {
		leaseID: "lease-a",
		rootSessionID: "ses-root",
		parentSessionID: "ses-parent",
		childSessionID: "ses-child",
		model: "provider-a/model-a",
		mode: "new",
		generation: 1,
		status: "running",
		baselineIdle: 500,
		createdAt: time.now,
		boundAt: time.now,
		startedSeq: null,
		...options.lease,
	}
	const storage = {
		get: async (key: string) => values.get(key),
		set: async (key: string, value: unknown) => {
			writes++
			await options.beforeSet?.(value)
			values.set(key, structuredClone(value))
		},
		remove: async (key: string) => {
			removes++
			values.delete(key)
		},
		scan: async ({ prefix, after, limit = 100 }: { prefix: string; after?: string; limit?: number }) => {
			const keys = [...values.keys()].filter((key) => key.startsWith(prefix)).sort().filter((key) => !after || key > after)
			const page = keys.slice(0, limit)
			return {
				entries: page.map((key) => ({ key, value: values.get(key) })),
				...(keys.length > page.length ? { next: page[page.length - 1] } : {}),
			}
		},
	}
	const ctx = {
		location: { directory: "/workspace", workspaceID: "ws-a", project: { id: "project-a" } },
		storage,
		session: {
			get: async ({ sessionID }: { sessionID: string }) => {
			await options.beforeGet?.()
			const error = options.getError?.()
				if (error) throw error
				if (sessionID !== lease.childSessionID) throw Object.assign(new Error("missing"), { _tag: "SessionNotFoundError", sessionID })
				return info
			},
			interrupt: async ({ sessionID }: { sessionID: string }) => {
				expect(sessionID).toBe(lease.childSessionID)
				interrupts++
				return true
			},
		},
	} as unknown as Plugin.Context
	const monitor = createV2BackgroundActivityMonitor({
		ctx,
		config: options.config,
		clock: time.clock,
		getLeases: () => [lease],
		getLease: (leaseID) => leaseID === lease.leaseID ? lease : undefined,
		reconcileIdle: async (_lease, current) => {
			reconciliations++
			const accepted = await options.reconcile?.(current as unknown as Session)
			if (accepted) await monitor.markTerminal(lease.leaseID, lease.generation, time.now)
			return Boolean(accepted)
		},
		removeMissing: async () => { missing++ },
		onFailure: (reason) => failures.push(reason),
	})
	return {
		monitor,
		time,
		values,
		lease,
		storage,
		setInfo(next: Session) { info = next },
		get writes() { return writes },
		get removes() { return removes },
		get interrupts() { return interrupts },
		get reconciliations() { return reconciliations },
		get missing() { return missing },
		failures,
		state(): BackgroundActivityState | undefined {
			return [...values.values()].map(decodeBackgroundActivityState).find(Boolean)
		},
	}
}

function started(sessionID = "ses-child", created = 100_000, seq = 1): BackgroundActivityEvent {
	return { type: "session.execution.started", created, durable: { aggregateID: sessionID, seq }, data: { sessionID } }
}

function step(sessionID = "ses-child", messageID = "msg-a", created = 100_001, seq = 2): BackgroundActivityEvent {
	return {
		type: "session.step.started",
		created,
		durable: { aggregateID: sessionID, seq },
		data: { sessionID, assistantMessageID: messageID },
	}
}

function textDelta(sessionID = "ses-child", messageID = "msg-a", created = 100_002, delta = "x"): BackgroundActivityEvent {
	return { type: "session.text.delta", created, data: { sessionID, assistantMessageID: messageID, delta } }
}

async function begin(h: ReturnType<typeof harness>): Promise<void> {
	await h.monitor.ready()
	await h.monitor.bind(h.lease)
	await h.monitor.start()
	await h.monitor.observe(started("ses-child", h.time.now))
	await h.monitor.observe(step("ses-child", "msg-a", h.time.now + 1, 2))
}

const watchdogConfig = {
	messageStalenessTimeoutMs: 60_000,
	staleTimeoutMs: 60_000,
	sessionGoneTimeoutMs: 5_000,
	taskCleanupDelayMs: 10_000,
} as BackgroundTaskConfig

describe("native V2 background activity monitor", () => {
	test("decoder rejects incomplete and cross-kind trigger records", () => {
		const h = harness()
		const invalid = { version: 1, leaseID: "x", trigger: { reason: "any", at: 1, attempts: 0 } }
		expect(decodeBackgroundActivityState(invalid)).toBeUndefined()
		expect(h.state()).toBeUndefined()
	})

	test("starts and step boundaries do not count as progress; native no-progress timeout interrupts only after the runtime floor", async () => {
		const h = harness({ config: watchdogConfig })
		await begin(h)
		await h.monitor.observe({
			type: "session.step.streamed",
			created: h.time.now + 2,
			durable: { aggregateID: "ses-child", seq: 3 },
			data: { sessionID: "ses-child", assistantMessageID: "msg-a" },
		})
		expect(h.state()?.progressed).toBe(false)
		await h.time.advanceBy(60_000)
		expect(h.interrupts).toBe(0)
		await h.time.advanceBy(5_000)
		expect(h.interrupts).toBe(1)
		expect(h.state()?.trigger?.reason).toBe("no-progress")
		expect(h.state()?.trigger?.at).toBeGreaterThan(160_000)
		expect(h.state()?.trigger?.attempts).toBe(1)
		expect(h.state()?.interruptAcceptedAt).not.toBeNull()
		await h.monitor.dispose()
	})

	test("a genuinely new child may prove its start when the native idle marker is absent", async () => {
		const h = harness({
			config: watchdogConfig,
			lease: { mode: "new", baselineIdle: null },
			info: session("ses-child", { time: { created: 1, updated: 1 } }),
		})
		await h.monitor.ready()
		await h.monitor.bind(h.lease)
		await h.monitor.start()
		await h.monitor.observe(started("ses-child", h.time.now))
		await h.monitor.observe(step("ses-child", "msg-new", h.time.now + 1, 2))
		expect(h.state()?.status).toBe("running")
		expect(h.state()?.freshStartSeen).toBe(true)
		await h.time.advanceBy(63_000)
		expect(h.interrupts).toBe(1)
		await h.monitor.dispose()
	})

	test("a resumed child without an idle watermark cannot adopt a fresh start", async () => {
		const h = harness({
			config: watchdogConfig,
			lease: { mode: "resume", baselineIdle: null },
			info: session("ses-child", { time: { created: 1, updated: 1 } }),
		})
		await h.monitor.ready()
		await h.monitor.bind(h.lease)
		await h.monitor.start()
		await h.monitor.observe(started("ses-child", h.time.now))
		expect(h.state()?.status).toBe("unknown")
		expect(h.state()?.freshStartSeen).toBe(false)
		await h.time.advanceBy(100_000)
		expect(h.interrupts).toBe(0)
		await h.monitor.dispose()
	})

	test("first model/tool progress resets no-progress; fresh activity survives until its own stale timeout", async () => {
		const h = harness({ config: { ...watchdogConfig, messageStalenessTimeoutMs: 500_000 } as BackgroundTaskConfig })
		await begin(h)
		await h.time.advanceBy(30_000)
		await h.monitor.observe(textDelta("ses-child", "msg-a", h.time.now, "provider output"))
		await h.time.advanceBy(59_000)
		expect(h.interrupts).toBe(0)
		expect(h.state()?.progressed).toBe(true)
		await h.time.advanceBy(4_000)
		expect(h.interrupts).toBe(1)
		expect(h.state()?.trigger?.reason).toBe("stale-progress")
		await h.monitor.dispose()
	})

	test("event flood coalesces progress persistence to one write per interval", async () => {
		const h = harness({ config: watchdogConfig })
		await begin(h)
		const before = h.writes
		for (let index = 0; index < 250; index++) {
			await h.monitor.observe(textDelta("ses-child", "msg-a", h.time.now + index + 1, `chunk-${index}`))
		}
		expect(h.writes).toBe(before)
		expect(h.state()?.lastProgressAt).toBeNull()
		await h.time.advanceBy(1_000)
		expect(h.writes).toBe(before + 1)
		expect(h.state()?.lastProgressAt).toBe(h.time.now - 750)
		await h.monitor.dispose()
	})

	test("progress arriving while trigger persistence is delayed prevents a stale interrupt", async () => {
		const entered = deferred()
		const release = deferred()
		let shouldBlock = false
		const h = harness({
			config: watchdogConfig,
			beforeSet: async (value) => {
				if (shouldBlock && (value as BackgroundActivityState).trigger) {
					shouldBlock = false
					entered.resolve()
					await release.promise
				}
			},
		})
		await begin(h)
		await h.time.advanceBy(60_000)
		shouldBlock = true
		await h.time.advanceBy(3_000)
		await entered.promise
		await h.monitor.observe(textDelta("ses-child", "msg-a", h.time.now, "late but current progress"))
		release.resolve()
		await h.time.advanceBy(0)
		expect(h.interrupts).toBe(0)
		expect(h.state()?.progressed).toBe(true)
		expect(h.state()?.trigger).toBeNull()
		expect(h.state()?.interruptAttempts).toBe(0)
		await h.monitor.dispose()
	})

	test("restored state and an untrusted later start stay unknown until a new generation is proven", async () => {
		const h = harness({ config: watchdogConfig })
		const lease = h.lease
		const old = {
			version: 1,
			leaseID: lease.leaseID,
			rootSessionID: lease.rootSessionID,
			parentSessionID: lease.parentSessionID,
			sessionID: lease.childSessionID,
			projectID: "project-a",
			workspaceID: "ws-a",
			directory: "/workspace",
			generation: lease.generation,
			status: "running",
			boundAt: lease.boundAt,
			baselineIdle: lease.baselineIdle,
			freshStartSeen: true,
			executionStartedAt: h.time.now - 1_000_000,
			startSeq: 10,
			lastSequence: 10,
			currentStepID: "old-message",
			progressed: false,
			lastProgressAt: null,
			missingSince: null,
			interruptAttempts: 0,
			lastInterruptAt: null,
			interruptAcceptedAt: null,
			trigger: null,
			terminalAt: null,
		}
		const key = "oh-my-openagent:v2:background-activity:project-a:ws-a:%2Fworkspace:lease-a"
		h.values.set(key, old)
		await h.monitor.ready()
		await h.monitor.start()
		await h.time.advanceBy(2_000_000)
		expect(h.interrupts).toBe(0)
		await h.monitor.observe(started("ses-child", h.lease.boundAt! - 1, 11))
		expect(h.interrupts).toBe(0)
		await h.monitor.observe(started("ses-child", h.time.now, 12))
		expect(h.state()?.status).toBe("running")
		await h.time.advanceBy(61_000)
		expect(h.interrupts).toBe(1)
		await h.monitor.dispose()
	})

	test("a second start without terminal proof is marked unknown and cannot authorize stale interruption", async () => {
		const h = harness({ config: watchdogConfig, reconcile: async () => false })
		await begin(h)
		h.setInfo(session("ses-child", { outcome: "succeeded", time: { created: 1, updated: h.time.now, idle: 501 } }))
		await h.monitor.observe(started("ses-child", h.time.now + 1, 3))
		expect(h.reconciliations).toBe(1)
		expect(h.state()?.status).toBe("unknown")
		await h.time.advanceBy(500_000)
		expect(h.interrupts).toBe(0)
		await h.monitor.observe(started("ses-child", h.time.now, 4))
		expect(h.state()?.status).toBe("unknown")
		await h.time.advanceBy(500_000)
		expect(h.interrupts).toBe(0)
		await h.monitor.dispose()
	})

	test("advanced native idle is reconciled before interruption, even if terminal outcome is ambiguous", async () => {
		const h = harness({ config: watchdogConfig, reconcile: async () => true })
		await begin(h)
		h.setInfo(session("ses-child", { outcome: "succeeded", time: { created: 1, updated: 200_000, idle: 200_000 } }))
		await h.time.advanceBy(100_000)
		expect(h.reconciliations).toBeGreaterThan(0)
		expect(h.state()?.status).toBe("terminal")
		expect(h.interrupts).toBe(0)
		await h.monitor.dispose()
	})

	test("public identity mismatch and transient lookup failure never count as a missing child", async () => {
		const wrongWorkspace = harness({ config: watchdogConfig, info: session("ses-child", { location: { directory: "/workspace", workspaceID: "ws-other" } }) })
		await begin(wrongWorkspace)
		await wrongWorkspace.time.advanceBy(100_000)
		expect(wrongWorkspace.interrupts).toBe(0)
		expect(wrongWorkspace.missing).toBe(0)
		await wrongWorkspace.monitor.dispose()

		const transient = harness({ config: watchdogConfig, getError: () => new Error("temporary database outage") })
		await begin(transient)
		await transient.time.advanceBy(100_000)
		expect(transient.interrupts).toBe(0)
		expect(transient.missing).toBe(0)
		await transient.monitor.dispose()
	})

	test("only persistent missing-session proof accrues the gone timeout", async () => {
		const h = harness({
			config: { ...watchdogConfig, sessionGoneTimeoutMs: 5_000 } as BackgroundTaskConfig,
			getError: () => Object.assign(new Error("gone"), { _tag: "SessionNotFoundError", sessionID: "ses-child" }),
		})
		await begin(h)
		await h.time.advanceBy(9_000)
		expect(h.missing).toBe(1)
		expect(h.interrupts).toBe(0)
		await h.monitor.dispose()
	})

	test("a healthy lookup resets the session-gone grace period", async () => {
		let lookupError: unknown = Object.assign(new Error("gone"), { _tag: "SessionNotFoundError", sessionID: "ses-child" })
		const h = harness({
			config: { ...watchdogConfig, sessionGoneTimeoutMs: 5_000 } as BackgroundTaskConfig,
			getError: () => lookupError,
		})
		await h.monitor.ready()
		await h.monitor.bind(h.lease)
		await h.monitor.start()
		await h.monitor.checkNow()
		await h.time.advanceBy(3_000)

		lookupError = undefined
		await h.monitor.checkNow()
		await h.time.advanceBy(1_000)
		lookupError = Object.assign(new Error("gone again"), { _tag: "SessionNotFoundError", sessionID: "ses-child" })
		await h.monitor.checkNow()
		await h.time.advanceBy(4_000)
		expect(h.missing).toBe(0)
		await h.time.advanceBy(2_000)
		expect(h.missing).toBe(1)
		await h.monitor.dispose()
	})

	test("a missing result from a stale lookup cannot remove a terminalized generation", async () => {
		const entered = deferred()
		const release = deferred()
		let block = false
		const h = harness({
			config: watchdogConfig,
			getError: () => Object.assign(new Error("gone"), { _tag: "SessionNotFoundError", sessionID: "ses-child" }),
			beforeGet: async () => {
				if (!block) return
				block = false
			entered.resolve()
			await release.promise
			},
		})
		await begin(h)
		block = true
		const checking = h.monitor.checkNow()
		await entered.promise
		await h.monitor.markTerminal(h.lease.leaseID, h.lease.generation, h.time.now)
		release.resolve()
		await checking
		expect(h.missing).toBe(0)
		expect(h.state()?.status).toBe("terminal")
		await h.monitor.dispose()
	})

	test("terminal cleanup keeps latest generation tombstone and dispose clears timers", async () => {
		const h = harness({ config: { ...watchdogConfig, taskCleanupDelayMs: 0 } as BackgroundTaskConfig })
		await begin(h)
		await h.monitor.markTerminal(h.lease.leaseID, h.lease.generation, h.time.now)
		h.lease.leaseID = "lease-b"
		h.lease.generation = 2
		h.lease.boundAt = h.time.now
		await h.monitor.bind(h.lease)
		await h.monitor.markTerminal(h.lease.leaseID, h.lease.generation, h.time.now)
		expect([...h.values.values()].map(decodeBackgroundActivityState).filter(Boolean).map((value) => value.leaseID)).toEqual(["lease-b"])
		await h.monitor.dispose()
		expect(h.time.activeTimerCount).toBe(0)
		// The current generation's terminal tombstone and admission counters are retained.
		expect(h.removes).toBe(1)
	})
})
