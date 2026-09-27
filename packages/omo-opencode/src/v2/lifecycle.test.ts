import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Plugin } from "@opencode/plugin"
import type { OhMyOpenCodeConfig } from "../config"
import { readBoulderState, writeBoulderState, type BoulderWorkState } from "../features/boulder-state"
import { flushV2WorkflowPolicy, getV2ContinuationState, getV2GoalController, isV2ContinuationStopped, registerV2LifecycleHooks } from "./lifecycle"
import { getV2SubagentRunState, getV2TodoState } from "./task-state"
import { createV2WorkflowPolicyStore } from "./workflow-policy"

const roots: string[] = []
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

type TestEvent = { type: string; data: { sessionID: string; inboxID?: string; item?: unknown }; created: number; location?: { directory: string; workspaceID?: string } }

function makeContext(directory: string, finalOutcome: "succeeded" | "failed" | "interrupted" = "succeeded", failCompaction = false) {
	const callbacks = new Map<string, (input: any) => unknown>()
	const disposed: string[] = []
	const storageData = new Map<string, unknown>()
	const events: TestEvent[] = []
	const toolCallbacks = new Map<string, Array<(input: any) => unknown>>()
	let sessionContext: unknown = []
	let sessionGetCalls = 0
	let getSession: (sessionID: string) => Promise<unknown> = async (sessionID) => ({
		id: sessionID,
		agent: "atlas",
		outcome: finalOutcome,
		tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
		location: { directory },
		projectID: "project-main",
	})
	let wake: (() => void) | undefined
	let markSubscribed!: () => void
	const subscribed = new Promise<void>((resolve) => { markSubscribed = resolve })
	const synthetics: unknown[] = []
	const event = {
		subscribe: ({ signal }: { signal: AbortSignal }) => (async function* () {
			markSubscribed()
			while (!signal.aborted) {
				const next = events.shift()
				if (next) {
					yield next as unknown as Plugin.Event
					continue
				}
				await new Promise<void>((resolve) => {
					wake = resolve
					signal.addEventListener("abort", resolve, { once: true })
				})
				wake = undefined
			}
		})(),
	}
	const ctx = {
		location: { directory, workspaceID: "workspace-main", project: { id: "project-main" } },
		storage: {
			get: async (key: string) => storageData.get(key),
			set: async (key: string, value: unknown) => { storageData.set(key, value) },
			remove: async (key: string) => { storageData.delete(key) },
		},
		session: {
			hook: async (name: string, callback: (input: any) => unknown) => {
				if (failCompaction && name === "compaction") throw new Error("compaction registration failure")
				callbacks.set(name, callback)
				return { dispose: async () => { disposed.push(name) } }
			},
			get: async ({ sessionID }: { sessionID: string }) => {
				sessionGetCalls++
				return getSession(sessionID)
			},
			context: async () => sessionContext,
			synthetic: async (input: unknown) => { synthetics.push(input) },
		},
		tool: {
			hook: async (name: string, callback: (input: any) => unknown) => {
				const values = toolCallbacks.get(name) ?? []
				values.push(callback)
				toolCallbacks.set(name, values)
				return { dispose: async () => { disposed.push(`tool:${name}`) } }
			},
		},
		event,
	}
	return {
		ctx: ctx as unknown as Plugin.Context,
		callbacks,
		disposed,
		synthetics,
		storageData,
		setSessionContext(value: unknown) { sessionContext = value },
		subscribed,
		getSessionCalls: () => sessionGetCalls,
		setSessionGet(callback: (sessionID: string) => Promise<unknown>) {
			getSession = async (sessionID) => {
				const value = await callback(sessionID)
				return value && typeof value === "object" ? { id: sessionID, agent: "atlas", ...value } : value
			}
		},
		toolCallbacks,
		pushInbox(sessionID: string, inboxID: string, text: string, type: "user" | "synthetic" = "user") {
			events.push({ type: "session.inbox.enqueued", data: { sessionID, inboxID, item: { type, payload: { text }, delivery: "sync" } }, created: Date.now(), location: { directory, workspaceID: "workspace-main" } })
			wake?.()
		},
		push(type: TestEvent["type"], sessionID: string, location?: TestEvent["location"]) {
			events.push({
				type,
				data: { sessionID },
				created: Date.now(),
				...(location ? { location } : type.startsWith("session.execution.") ? {} : { location: { directory, workspaceID: "workspace-main" } }),
			})
			wake?.()
		},
		pushWithoutLocation(type: TestEvent["type"], sessionID: string) {
			events.push({ type, data: { sessionID }, created: Date.now() })
			wake?.()
		},
	}
}

function deferSessionLookup(setSessionGet: (callback: () => Promise<unknown>) => void) {
	let markStarted!: () => void
	let finish!: (value: unknown) => void
	const started = new Promise<void>((resolve) => { markStarted = resolve })
	setSessionGet(async () => {
		markStarted()
		return await new Promise((resolve) => { finish = resolve })
	})
	return { started, finish: (value: unknown) => finish(value) }
}

async function seedCompletedBoulderPlan(directory: string, sessionID: string, plan = "# Plan\n\n## TODOs\n- [x] 1. Done\n") {
	const planDirectory = join(directory, ".omo", "plans")
	await mkdir(planDirectory, { recursive: true })
	const planPath = join(planDirectory, "finish-me.md")
	await writeFile(planPath, plan, "utf8")
	const work: BoulderWorkState = {
		work_id: "work-lifecycle",
		active_plan: planPath,
		plan_name: "lifecycle-plan",
		status: "active",
		started_at: "2026-01-02T10:00:00.000Z",
		session_ids: [`opencode:${sessionID}`],
		task_sessions: {},
	}
	if (!writeBoulderState(directory, {
		schema_version: 2,
		active_work_id: work.work_id,
		works: { [work.work_id]: work },
		active_plan: work.active_plan,
		started_at: work.started_at,
		status: work.status,
		session_ids: [...work.session_ids],
		plan_name: work.plan_name,
	})) throw new Error("could not seed lifecycle Boulder state")
	return work
}

async function waitUntil(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 1500
	while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5))
	expect(predicate()).toBe(true)
}

describe("native v2 lifecycle hooks", () => {
	test("creates an opted-in default goal only from an admitted first user inbox and preserves the cleared marker", async () => {
		const directory = await mkdtemp(join(tmpdir(), "omo-v2-auto-goal-lifecycle-"))
		roots.push(directory)
		const { ctx, subscribed, pushInbox, push, setSessionGet, storageData } = makeContext(directory)
		setSessionGet(async () => ({ agent: null, projectID: "project-main", location: { directory } }))
		const config = { goal: { enabled: true }, default_mode: { goal: true } } as OhMyOpenCodeConfig
		const cleanup = await registerV2LifecycleHooks(ctx, config)
		const goals = getV2GoalController(ctx)
		try {
			await subscribed
			pushInbox("ses-auto", "msg-synthetic", "Not a user goal", "synthetic")
			pushInbox("ses-auto", "msg-first", "Finish the accepted task")
			await waitUntil(() => goals.getGoal("ses-auto") !== null)
			expect(goals.getGoal("ses-auto")?.objective).toBe("Finish the accepted task")
			goals.clearGoal("ses-auto")
			pushInbox("ses-auto", "msg-second", "Do not recreate the cleared goal")
			push("session.execution.started", "ses-barrier")
			await waitUntil(() => getV2ContinuationState(ctx).outcome.get("ses-barrier") === "running")
			expect(goals.getGoal("ses-auto")).toBeNull()
			expect([...storageData.keys()].some((key) => key.includes("goal-auto-start") && key.endsWith("ses-auto"))).toBe(true)
			push("session.deleted", "ses-auto")
			push("session.execution.started", "ses-deleted-barrier")
			await waitUntil(() => getV2ContinuationState(ctx).outcome.get("ses-deleted-barrier") === "running")
			expect([...storageData.keys()].some((key) => key.includes("goal-auto-start") && key.endsWith("ses-auto"))).toBe(false)
		} finally { await cleanup() }
	})

	test("a persisted stop blocks default goal creation even before the in-memory stop set is restored", async () => {
		const directory = await mkdtemp(join(tmpdir(), "omo-v2-auto-goal-stopped-"))
		roots.push(directory)
		const { ctx, subscribed, pushInbox, push, setSessionGet } = makeContext(directory)
		setSessionGet(async () => ({ agent: null, projectID: "project-main", location: { directory } }))
		const store = await createV2WorkflowPolicyStore(ctx)
		await store.update("ses-stopped", (current) => ({ ...current, stopped: true }))
		await store.dispose()
		const cleanup = await registerV2LifecycleHooks(ctx, { goal: { enabled: true }, default_mode: { goal: true } } as OhMyOpenCodeConfig)
		try {
			await subscribed
			expect(getV2ContinuationState(ctx).isStopped("ses-stopped")).toBe(false)
			expect(await isV2ContinuationStopped(ctx, "ses-stopped")).toBe(true)
			pushInbox("ses-stopped", "msg-first", "Do not create a stopped goal")
			push("session.execution.started", "ses-barrier")
			await waitUntil(() => getV2ContinuationState(ctx).outcome.get("ses-barrier") === "running")
			expect(getV2GoalController(ctx).getGoal("ses-stopped")).toBeNull()
			getV2ContinuationState(ctx).resume("ses-stopped")
			expect(await isV2ContinuationStopped(ctx, "ses-stopped")).toBe(false)
		} finally { await cleanup() }
	})

	test("automatic recovery is stopped before initialization, after deletion and after disposal", async () => {
		const directory = await mkdtemp(join(tmpdir(), "omo-v2-recovery-stop-gate-"))
		roots.push(directory)
		const { ctx } = makeContext(directory)
		expect(await isV2ContinuationStopped(ctx, "ses-live")).toBe(true)
		const cleanup = await registerV2LifecycleHooks(ctx, {} as OhMyOpenCodeConfig)
		try {
			expect(await isV2ContinuationStopped(ctx, "ses-live")).toBe(false)
			await getV2ContinuationState(ctx).clearSession("ses-deleted")
			expect(await isV2ContinuationStopped(ctx, "ses-deleted")).toBe(true)
		} finally { await cleanup() }
		expect(await isV2ContinuationStopped(ctx, "ses-live")).toBe(true)
	})

	test("queues a goal continuation only after a successful execution", async () => {
		const directory = await mkdtemp(join(tmpdir(), "omo-v2-lifecycle-test-"))
		roots.push(directory)
		const { ctx, subscribed, push, synthetics } = makeContext(directory, "succeeded")
		getV2GoalController(ctx).setGoal("ses-success", "Finish the acceptance checks")
		const cleanup = await registerV2LifecycleHooks(ctx, { goal: { enabled: true } } as OhMyOpenCodeConfig)
		await subscribed

		push("session.execution.started", "ses-success")
		push("session.execution.succeeded", "ses-success")
		push("session.execution.succeeded", "ses-success")
		await waitUntil(() => synthetics.length === 1)
		await new Promise((resolve) => setTimeout(resolve, 30))
		expect(synthetics).toHaveLength(1)
		expect(synthetics[0]).toMatchObject({
			sessionID: "ses-success",
			delivery: "queue",
			resume: true,
			description: "OMO workflow continuation",
		})

		push("session.execution.started", "ses-success")
		push("session.execution.succeeded", "ses-success")
		await waitUntil(() => synthetics.length === 2)
		expect(synthetics).toHaveLength(2)
		await cleanup()
	})

	test("does not continue failed or interrupted executions", async () => {
		for (const outcome of ["failed", "interrupted"] as const) {
			const directory = await mkdtemp(join(tmpdir(), "omo-v2-lifecycle-test-"))
			roots.push(directory)
			const sessionID = `ses-${outcome}`
			const { ctx, subscribed, push, synthetics } = makeContext(directory, outcome)
			getV2GoalController(ctx).setGoal(sessionID, "Finish the acceptance checks")
			const cleanup = await registerV2LifecycleHooks(ctx, { goal: { enabled: true } } as OhMyOpenCodeConfig)
			await subscribed

			push(`session.execution.${outcome}`, sessionID)
			await new Promise((resolve) => setTimeout(resolve, 30))
			expect(synthetics).toEqual([])
			await cleanup()
		}
	})

	test("ignores a terminal event when the session belongs to another project", async () => {
		const directory = await mkdtemp(join(tmpdir(), "omo-v2-lifecycle-project-"))
		roots.push(directory)
		const { ctx, subscribed, push, synthetics, setSessionGet } = makeContext(directory, "succeeded")
		setSessionGet(async () => ({
			outcome: "succeeded",
			tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
			location: { directory: `${directory}-other` },
			projectID: "project-other",
		}))
		getV2GoalController(ctx).setGoal("ses-other-project", "Finish the acceptance checks")
		const cleanup = await registerV2LifecycleHooks(ctx, { goal: { enabled: true } } as OhMyOpenCodeConfig)
		await subscribed

		push("session.execution.started", "ses-other-project")
		push("session.execution.succeeded", "ses-other-project")
		await new Promise((resolve) => setTimeout(resolve, 30))
		expect(synthetics).toEqual([])
		await cleanup()
	})

	test("ignores a same-directory terminal event routed from another workspace", async () => {
		const directory = await mkdtemp(join(tmpdir(), "omo-v2-lifecycle-workspace-"))
		roots.push(directory)
		const { ctx, subscribed, push, synthetics } = makeContext(directory, "succeeded")
		getV2GoalController(ctx).setGoal("ses-other-workspace", "Finish the acceptance checks")
		const cleanup = await registerV2LifecycleHooks(ctx, { goal: { enabled: true } } as OhMyOpenCodeConfig)
		await subscribed

		push("session.execution.started", "ses-other-workspace", { directory, workspaceID: "workspace-other" })
		push("session.execution.succeeded", "ses-other-workspace", { directory, workspaceID: "workspace-other" })
		await new Promise((resolve) => setTimeout(resolve, 30))
		expect(synthetics).toEqual([])
		await cleanup()
	})

	test("runs additional deletion cleanup only for events with the exact native location", async () => {
		const directory = await mkdtemp(join(tmpdir(), "omo-v2-lifecycle-delete-"))
		roots.push(directory)
		const { ctx, subscribed, push, pushWithoutLocation } = makeContext(directory)
		const deleted: string[] = []
		const cleanup = await registerV2LifecycleHooks(ctx, {
			disabled_hooks: [
				"stop-continuation-guard", "compaction-context-injector", "compaction-todo-preserver",
				"goal", "todo-continuation-enforcer", "atlas",
			],
		} as OhMyOpenCodeConfig, {
			onSessionDeleted: async (sessionID) => { deleted.push(sessionID) },
		})
		await subscribed

		push("session.deleted", "ses-current-location")
		await waitUntil(() => deleted.length === 1)
		push("session.deleted", "ses-other-directory", { directory: `${directory}-other`, workspaceID: "workspace-main" })
		push("session.deleted", "ses-other-workspace", { directory, workspaceID: "workspace-other" })
		push("session.deleted", "ses-location-without-workspace", { directory })
		pushWithoutLocation("session.deleted", "ses-unlocated")
		push("session.deleted", "ses-current-location-after-foreign-events")
		await waitUntil(() => deleted.length === 2)

		expect(deleted).toEqual(["ses-current-location", "ses-current-location-after-foreign-events"])
		await cleanup()
	})

	test("queues a persisted todo continuation on native execution success", async () => {
		const directory = await mkdtemp(join(tmpdir(), "omo-v2-lifecycle-todo-"))
		roots.push(directory)
		const sessionID = "ses-todo-success"
		const { ctx, subscribed, push, synthetics } = makeContext(directory, "succeeded")
		await getV2TodoState(ctx.storage).write(sessionID, [{ content: "Verify the release artifact", status: "pending" }])
		const cleanup = await registerV2LifecycleHooks(ctx, { disabled_hooks: ["goal", "atlas"] } as OhMyOpenCodeConfig)
		await subscribed

		push("session.execution.started", sessionID)
		push("session.execution.succeeded", sessionID)
		push("session.execution.succeeded", sessionID)
		await waitUntil(() => synthetics.length === 1)
		await new Promise((resolve) => setTimeout(resolve, 30))
		expect(synthetics).toHaveLength(1)
		expect(synthetics[0]).toMatchObject({
			sessionID,
			description: "OMO workflow continuation",
		})
		expect((synthetics[0] as { text: string }).text).toContain("Verify the release artifact")
		await cleanup()
	})

	test("retries one todo continuation after the native cooldown expires without another idle event", async () => {
		const directory = await mkdtemp(join(tmpdir(), "omo-v2-lifecycle-cooldown-"))
		roots.push(directory)
		const sessionID = "ses-todo-cooldown"
		const { ctx, subscribed, push, synthetics } = makeContext(directory, "succeeded")
		await getV2TodoState(ctx.storage).write(sessionID, [{ content: "finish after cooldown", status: "pending" }])
		const policyStore = await createV2WorkflowPolicyStore(ctx)
		await policyStore.update(sessionID, (policy) => ({
			...policy,
			todo: { ...policy.todo, lastDispatchAt: Date.now() - 4_500 },
		}))
		const cleanup = await registerV2LifecycleHooks(ctx, { disabled_hooks: ["goal", "atlas"] } as OhMyOpenCodeConfig)
		await subscribed

		push("session.execution.started", sessionID)
		push("session.execution.succeeded", sessionID)
		await new Promise((resolve) => setTimeout(resolve, 50))
		expect(synthetics).toEqual([])
		await waitUntil(() => synthetics.length === 1)
		expect(synthetics).toHaveLength(1)
		expect((synthetics[0] as { text: string }).text).toContain("finish after cooldown")
		await cleanup()
		await policyStore.dispose()
	})

	test("native child sessions do not inherit root todo or goal continuations", async () => {
		const directory = await mkdtemp(join(tmpdir(), "omo-v2-lifecycle-child-"))
		roots.push(directory)
		const parentID = "ses-root-owner"
		const childID = "ses-native-child"
		const { ctx, subscribed, push, synthetics, setSessionGet } = makeContext(directory, "succeeded")
		setSessionGet(async (sessionID) => sessionID === childID ? {
			parentID,
			agent: "sisyphus-junior",
			outcome: "succeeded",
			time: { idle: Date.now() },
			location: { directory },
			projectID: "project-main",
		} : { outcome: "succeeded", location: { directory }, projectID: "project-main" })
		await getV2TodoState(ctx.storage).write(childID, [{ content: "child-only task", status: "pending" }])
		getV2GoalController(ctx).setGoal(childID, "child-only goal")
		const cleanup = await registerV2LifecycleHooks(ctx, { goal: { enabled: true }, disabled_hooks: ["atlas"] } as OhMyOpenCodeConfig)
		await subscribed

		push("session.execution.started", childID)
		push("session.execution.succeeded", childID)
		await new Promise((resolve) => setTimeout(resolve, 50))

		expect(synthetics).toEqual([])
		await cleanup()
	})

	test("verified logical Team children reconcile stale running records before parent todo continuation", async () => {
		const directory = await mkdtemp(join(tmpdir(), "omo-v2-lifecycle-logical-child-"))
		roots.push(directory)
		const parentID = "ses-team-lead"
		const childID = "ses-team-member"
		const { ctx, subscribed, push, synthetics, setSessionGet } = makeContext(directory, "succeeded")
		setSessionGet(async (sessionID) => sessionID === childID ? {
			agent: "sisyphus-junior",
			outcome: "succeeded",
			time: { idle: 100 },
			location: { directory },
			projectID: "project-main",
		} : { outcome: "succeeded", location: { directory }, projectID: "project-main" })
		await getV2TodoState(ctx.storage).write(parentID, [{ content: "finish team work", status: "pending" }])
		await getV2TodoState(ctx.storage).write(childID, [{ content: "member-local todo", status: "pending" }])
		getV2GoalController(ctx).setGoal(childID, "member-local goal")
		const runs = getV2SubagentRunState(ctx.storage)
		await runs.recordLaunch(childID, { parentSessionID: parentID, startedAt: 50, status: "running", blockedActions: [] })
		const cleanup = await registerV2LifecycleHooks(ctx, { goal: { enabled: true }, disabled_hooks: ["atlas"] } as OhMyOpenCodeConfig, {
			resolveLogicalParent: async (sessionID) => sessionID === childID ? parentID : undefined,
		})
		await subscribed

		push("session.execution.started", childID)
		push("session.execution.succeeded", childID)
		await new Promise((resolve) => setTimeout(resolve, 35))
		expect(synthetics).toEqual([])

		push("session.execution.started", parentID)
		push("session.execution.succeeded", parentID)
		await waitUntil(() => synthetics.length === 1)

		expect(await runs.get(childID)).toMatchObject({ status: "completed", parentSessionID: parentID })
		expect((synthetics[0] as { text: string }).text).toContain("finish team work")
		await cleanup()
	})

	test("an exact completed Atlas task gets the next-step reminder while preserving native result metadata", async () => {
		const directory = await mkdtemp(join(tmpdir(), "omo-v2-lifecycle-task-result-"))
		roots.push(directory)
		const parentID = "ses-atlas-task-parent"
		const childID = "ses-atlas-task-child"
		const work = await seedCompletedBoulderPlan(directory, parentID, "# Plan\n\n## TODOs\n- [ ] 1. Implement the feature\n")
		const { ctx, toolCallbacks, setSessionGet } = makeContext(directory)
		setSessionGet(async (sessionID) => sessionID === childID ? {
			parentID,
			agent: "sisyphus-junior",
			outcome: "succeeded",
			location: { directory },
			projectID: "project-main",
		} : { outcome: "succeeded", location: { directory }, projectID: "project-main" })
		const cleanup = await registerV2LifecycleHooks(ctx, { disabled_hooks: ["goal", "todo-continuation-enforcer"] } as OhMyOpenCodeConfig)
		const before = toolCallbacks.get("execute.before")?.[0]
		const after = toolCallbacks.get("execute.after")?.[0]
		expect(before).toBeDefined()
		expect(after).toBeDefined()
		const call = { tool: "task", sessionID: parentID, messageID: "msg-atlas", id: "call-atlas", input: { prompt: "## 1. TASK\n1. Implement the feature" } }
		await before!(call)
		await writeFile(work.active_plan, "# Plan\n\n## TODOs\n- [x] 1. Implement the feature\n", "utf8")
		const result = { content: [{ type: "text", text: "Implemented and verified." }], output: { raw: "structured" }, metadata: { sessionID: childID, status: "completed", retained: true } }
		await after!({ ...call, status: "completed", result })

		expect(result.content).toHaveLength(2)
		expect(result.content[1]).toMatchObject({ type: "text" })
		expect(result.output).toEqual({ raw: "structured" })
		expect(result.metadata).toMatchObject({ sessionID: childID, status: "completed", retained: true })
		await cleanup()
	})

	test("final-wave approvals wait for every exact reviewer and release only on a real user prompt", async () => {
		const directory = await mkdtemp(join(tmpdir(), "omo-v2-lifecycle-final-wave-"))
		roots.push(directory)
		const parentID = "ses-atlas-final-wave"
		const reviewers = ["ses-final-f1", "ses-final-f2"]
		const plan = "# Plan\n\n## TODOs\n- [x] 1. Implement\n\n## Final Verification Wave\n- [ ] F1. Review behavior\n- [ ] F2. Review security\n"
		await seedCompletedBoulderPlan(directory, parentID, plan)
		const { ctx, callbacks, toolCallbacks, storageData, synthetics, setSessionGet, subscribed, push } = makeContext(directory)
		setSessionGet(async (sessionID) => reviewers.includes(sessionID) ? {
			parentID,
			agent: "sisyphus-junior",
			outcome: "succeeded",
			location: { directory },
			projectID: "project-main",
		} : { outcome: "succeeded", location: { directory }, projectID: "project-main" })
		const cleanup = await registerV2LifecycleHooks(ctx, { disabled_hooks: ["goal", "todo-continuation-enforcer"] } as OhMyOpenCodeConfig)
		await subscribed
		const before = toolCallbacks.get("execute.before")?.[0]
		const after = toolCallbacks.get("execute.after")?.[0]
		expect(before).toBeDefined()
		expect(after).toBeDefined()
		for (const [index, reviewerID] of reviewers.entries()) {
			const key = `F${index + 1}`
			const call = {
				tool: "task",
				sessionID: parentID,
				messageID: `msg-${key}`,
				id: `call-${key}`,
				input: { prompt: `## 1. TASK\n${key}. Review the change` },
			}
			await before!(call)
			const result = { content: [{ type: "text", text: "VERDICT: APPROVE" }], metadata: { sessionID: reviewerID, status: "completed" } }
			await after!({ ...call, status: "completed", result })
			if (index === 0) expect(result.content).toHaveLength(1)
			else expect(result.content).toHaveLength(2)
		}
		const durable = [...storageData.values()].find((value) => value && typeof value === "object" && (value as { sessionID?: string }).sessionID === parentID) as { finalWave?: { approvedTaskKeys: string[]; expected: number } } | undefined
		expect(durable?.finalWave).toMatchObject({ expected: 2, approvedTaskKeys: ["final-wave:f1", "final-wave:f2"] })

		push("session.execution.started", parentID)
		push("session.execution.succeeded", parentID)
		await new Promise((resolve) => setTimeout(resolve, 40))
		expect(synthetics).toEqual([])
		await callbacks.get("prompt")?.({ sessionID: parentID, prompt: { text: "Continue after the reviews." } })
		await flushV2WorkflowPolicy(ctx, parentID)
		const released = [...storageData.values()].find((value) => value && typeof value === "object" && (value as { sessionID?: string }).sessionID === parentID) as { finalWave?: unknown } | undefined
		expect(released?.finalWave).toBeUndefined()
		await cleanup()
	})

	test("completes one exact Boulder work and queues one nudge on native execution success", async () => {
		const directory = await mkdtemp(join(tmpdir(), "omo-v2-lifecycle-boulder-"))
		roots.push(directory)
		const sessionID = "ses-boulder-success"
		const work = await seedCompletedBoulderPlan(directory, sessionID)
		const { ctx, subscribed, push, synthetics } = makeContext(directory, "succeeded")
		const cleanup = await registerV2LifecycleHooks(ctx, { disabled_hooks: ["goal", "todo-continuation-enforcer"] } as OhMyOpenCodeConfig)
		await subscribed

		push("session.execution.started", sessionID)
		push("session.execution.succeeded", sessionID)
		push("session.execution.succeeded", sessionID)
		await waitUntil(() => synthetics.length === 1)
		await new Promise((resolve) => setTimeout(resolve, 30))

		expect(readBoulderState(directory)?.works?.[work.work_id]?.status).toBe("completed")
		expect(synthetics).toHaveLength(1)
		expect(synthetics[0]).toMatchObject({
			sessionID,
			delivery: "queue",
			resume: true,
			description: "Boulder complete: lifecycle-plan",
			metadata: { source: "oh-my-openagent:boulder-completion", workID: work.work_id },
		})
		await cleanup()
	})

	test("does not complete a verified Boulder plan until owned children and native questions settle", async () => {
		for (const gate of ["child", "question"] as const) {
			const directory = await mkdtemp(join(tmpdir(), `omo-v2-lifecycle-boulder-${gate}-gate-`))
			roots.push(directory)
			const parentID = `ses-boulder-${gate}-gate`
			const work = await seedCompletedBoulderPlan(directory, parentID)
			const { ctx, subscribed, push, synthetics, setSessionGet, setSessionContext } = makeContext(directory, "succeeded")
			if (gate === "child") {
				const childID = `${parentID}-child`
				setSessionGet(async (sessionID) => sessionID === childID ? {
					parentID,
					agent: "sisyphus-junior",
					outcome: "running",
					time: { idle: 0 },
					location: { directory },
					projectID: "project-main",
				} : { outcome: "succeeded", location: { directory }, projectID: "project-main" })
				await getV2SubagentRunState(ctx.storage).recordLaunch(childID, {
					parentSessionID: parentID,
					startedAt: Date.now(),
					status: "running",
					blockedActions: [],
				})
			} else {
				setSessionContext([{ type: "assistant", content: [{ type: "tool", name: "question", state: { status: "running" } }] }])
			}
			const cleanup = await registerV2LifecycleHooks(ctx, { disabled_hooks: ["goal", "todo-continuation-enforcer"] } as OhMyOpenCodeConfig)
			await subscribed
			push("session.execution.started", parentID)
			push("session.execution.succeeded", parentID)
			await new Promise((resolve) => setTimeout(resolve, 40))

			expect(readBoulderState(directory)?.works?.[work.work_id]?.status).toBe("active")
			expect(synthetics).toEqual([])
			await cleanup()
		}
	})

	test("does not complete Boulder after a failed or interrupted execution", async () => {
		for (const outcome of ["failed", "interrupted"] as const) {
			const directory = await mkdtemp(join(tmpdir(), "omo-v2-lifecycle-boulder-failed-"))
			roots.push(directory)
			const sessionID = `ses-boulder-${outcome}`
			const work = await seedCompletedBoulderPlan(directory, sessionID)
			const { ctx, subscribed, push, synthetics } = makeContext(directory, outcome)
			const state = getV2ContinuationState(ctx)
			const cleanup = await registerV2LifecycleHooks(ctx, { disabled_hooks: ["goal", "todo-continuation-enforcer"] } as OhMyOpenCodeConfig)
			await subscribed

			push("session.execution.started", sessionID)
			push(`session.execution.${outcome}`, sessionID)
			await waitUntil(() => state.outcome.get(sessionID) === outcome)
			expect(state.outcome.get(sessionID)).toBe(outcome)
			expect(state.pending.has(sessionID)).toBe(false)

			expect(readBoulderState(directory)?.works?.[work.work_id]?.status).toBe("active")
			expect(synthetics).toEqual([])
			await cleanup()
		}
	})

	test("atlas disablement and zero-item checklists never queue a plan continuation", async () => {
		for (const fixture of [
			{ sessionID: "ses-atlas-disabled", disabled: ["atlas"], plan: "# Plan\n\n## TODOs\n- [x] 1. Done\n" },
			{ sessionID: "ses-zero-plan", disabled: ["goal"], plan: "# Plan\n\n## TODOs\n" },
		]) {
			const directory = await mkdtemp(join(tmpdir(), "omo-v2-lifecycle-boulder-disabled-"))
			roots.push(directory)
			const work = await seedCompletedBoulderPlan(directory, fixture.sessionID, fixture.plan)
			const { ctx, subscribed, push, synthetics, setSessionGet } = makeContext(directory, "succeeded")
			const state = getV2ContinuationState(ctx)
			const lookup = deferSessionLookup(setSessionGet)
			const cleanup = await registerV2LifecycleHooks(ctx, { disabled_hooks: fixture.disabled } as OhMyOpenCodeConfig)
			await subscribed

			push("session.execution.succeeded", fixture.sessionID)
			await lookup.started
			expect(state.outcome.get(fixture.sessionID)).toBe("succeeded")
			expect(state.pending.has(fixture.sessionID)).toBe(true)
			lookup.finish({ outcome: "succeeded", tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, location: { directory }, projectID: "project-main" })
			await waitUntil(() => !state.pending.has(fixture.sessionID))

			expect(readBoulderState(directory)?.works?.[work.work_id]?.status).toBe("active")
			expect(synthetics).toEqual([])
			await cleanup()
		}
	})

	test("a stop after session lookup begins prevents Boulder mutation and nudge", async () => {
		const directory = await mkdtemp(join(tmpdir(), "omo-v2-lifecycle-boulder-stop-"))
		roots.push(directory)
		const sessionID = "ses-boulder-stop"
		const work = await seedCompletedBoulderPlan(directory, sessionID)
		const { ctx, subscribed, push, synthetics } = makeContext(directory, "succeeded")
		let started!: () => void
		const lookupStarted = new Promise<void>((resolve) => { started = resolve })
		let finishLookup!: (value: unknown) => void
		ctx.session.get = async () => {
			started()
			return await new Promise((resolve) => { finishLookup = resolve })
		}
		const state = getV2ContinuationState(ctx)
		const cleanup = await registerV2LifecycleHooks(ctx, { disabled_hooks: ["goal", "todo-continuation-enforcer"] } as OhMyOpenCodeConfig)
		await subscribed

		push("session.execution.succeeded", sessionID)
		await lookupStarted
		state.stop(sessionID)
		finishLookup({ outcome: "succeeded", tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } })
		await new Promise((resolve) => setTimeout(resolve, 30))

		expect(readBoulderState(directory)?.works?.[work.work_id]?.status).toBe("active")
		expect(synthetics).toEqual([])
		await cleanup()
	})

	test("cleanup aborts and drains an idle task waiting on session lookup", async () => {
		const directory = await mkdtemp(join(tmpdir(), "omo-v2-lifecycle-boulder-dispose-"))
		roots.push(directory)
		const sessionID = "ses-boulder-dispose"
		const work = await seedCompletedBoulderPlan(directory, sessionID)
		const { ctx, subscribed, push, synthetics } = makeContext(directory, "succeeded")
		let started!: () => void
		const lookupStarted = new Promise<void>((resolve) => { started = resolve })
		let finishLookup!: (value: unknown) => void
		ctx.session.get = async () => {
			started()
			return await new Promise((resolve) => { finishLookup = resolve })
		}
		const cleanup = await registerV2LifecycleHooks(ctx, { disabled_hooks: ["goal", "todo-continuation-enforcer"] } as OhMyOpenCodeConfig)
		await subscribed

		push("session.execution.succeeded", sessionID)
		await lookupStarted
		let cleanupFinished = false
		const disposing = cleanup().then(() => { cleanupFinished = true })
		await new Promise((resolve) => setTimeout(resolve, 20))
		expect(cleanupFinished).toBe(false)
		finishLookup({ outcome: "succeeded", tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } })
		await disposing

		expect(readBoulderState(directory)?.works?.[work.work_id]?.status).toBe("active")
		expect(synthetics).toEqual([])
	})

	test("shares a bounded stop/resume state with native command handlers", async () => {
		const directory = await mkdtemp(join(tmpdir(), "omo-v2-lifecycle-test-"))
		roots.push(directory)
		const { ctx } = makeContext(directory)
		const state = getV2ContinuationState(ctx)
		state.stop("ses-stop")
		expect(state.isStopped("ses-stop")).toBe(true)
		state.resume("ses-stop")
		expect(state.isStopped("ses-stop")).toBe(false)
		expect(state.markPending("ses-stop")).toBe(true)
		expect(state.markPending("ses-stop")).toBe(false)
		state.clearPending("ses-stop")
		expect(state.markPending("ses-stop")).toBe(true)
	})

	test("command stop/resume can await durable workflow policy writes and surface storage failure", async () => {
		const directory = await mkdtemp(join(tmpdir(), "omo-v2-lifecycle-policy-flush-"))
		roots.push(directory)
		const { ctx, storageData } = makeContext(directory)
		const cleanup = await registerV2LifecycleHooks(ctx, {
			disabled_hooks: ["stop-continuation-guard", "compaction-context-injector", "compaction-todo-preserver", "goal", "todo-continuation-enforcer", "atlas"],
		} as OhMyOpenCodeConfig)
		const state = getV2ContinuationState(ctx)
		state.stop("ses-durable-stop")
		expect(state.isStopped("ses-durable-stop")).toBe(true)
		await flushV2WorkflowPolicy(ctx, "ses-durable-stop")
		expect([...storageData.values()]).toContainEqual(expect.objectContaining({ sessionID: "ses-durable-stop", stopped: true }))
		state.resume("ses-durable-stop")
		await flushV2WorkflowPolicy(ctx, "ses-durable-stop")
		expect([...storageData.values()]).toContainEqual(expect.objectContaining({ sessionID: "ses-durable-stop", stopped: false }))
		await cleanup()

		const failed = makeContext(directory)
		failed.ctx.storage.set = async () => { throw new Error("storage write rejected") }
		const failedCleanup = await registerV2LifecycleHooks(failed.ctx, {} as OhMyOpenCodeConfig)
		getV2ContinuationState(failed.ctx).stop("ses-durable-failure")
		await new Promise((resolve) => setTimeout(resolve, 0))
		await expect(flushV2WorkflowPolicy(failed.ctx, "ses-durable-failure")).rejects.toThrow("storage write rejected")
		await failedCleanup()
	})

	test("session deletion drains queued stop writes, clears durable policy, and blocks later resurrection", async () => {
		const directory = await mkdtemp(join(tmpdir(), "omo-v2-lifecycle-delete-policy-"))
		roots.push(directory)
		const { ctx, storageData, subscribed, push } = makeContext(directory)
		const policyPrefix = "oh-my-openagent:v2:workflow-policy:v1:"
		let releaseSet!: () => void
		let signalSetStarted!: () => void
		const setStarted = new Promise<void>((resolve) => { signalSetStarted = resolve })
		let signalPolicyRemoved!: () => void
		const policyRemoved = new Promise<void>((resolve) => { signalPolicyRemoved = resolve })
		const originalSet = ctx.storage.set
		const originalRemove = ctx.storage.remove
		ctx.storage.set = async (key, value) => {
			if (key.startsWith(policyPrefix)) {
				signalSetStarted()
				await new Promise<void>((resolve) => { releaseSet = resolve })
			}
			await originalSet(key, value)
		}
		ctx.storage.remove = async (key) => {
			if (key.startsWith(policyPrefix)) signalPolicyRemoved()
			await originalRemove(key)
		}
		const cleanup = await registerV2LifecycleHooks(ctx, { disabled_hooks: ["goal", "todo-continuation-enforcer"] } as OhMyOpenCodeConfig)
		await subscribed
		const state = getV2ContinuationState(ctx)
		const sessionID = "ses-delete-policy-race"
		state.stop(sessionID)
		await setStarted
		push("session.deleted", sessionID)
		await new Promise((resolve) => setTimeout(resolve, 10))
		expect(storageData.size).toBe(0)
		releaseSet()
		await policyRemoved
		await new Promise((resolve) => setTimeout(resolve, 0))
		expect([...storageData.keys()].some((key) => key.startsWith(policyPrefix))).toBe(false)

		state.stop(sessionID)
		await flushV2WorkflowPolicy(ctx, sessionID)
		expect([...storageData.keys()].some((key) => key.startsWith(policyPrefix))).toBe(false)
		await cleanup()
	})

	test("compaction preserves delegated task_ids, reviewer verdicts and final-wave state, then re-injects them after compaction", async () => {
		const directory = await mkdtemp(join(tmpdir(), "omo-v2-lifecycle-compaction-"))
		roots.push(directory)
		const parentID = "ses-compaction-parent"
		const workerID = "ses-compaction-worker"
		const reviewerID = "ses-compaction-reviewer"
		const { ctx, callbacks, setSessionGet, setSessionContext } = makeContext(directory)
		setSessionGet(async (sessionID) => sessionID === workerID
			? { parentID, agent: "sisyphus-junior", title: "Implement the parser change", outcome: "succeeded", location: { directory }, projectID: "project-main" }
			: sessionID === reviewerID
				? { parentID, agent: "oracle", title: "Review the parser change", outcome: "succeeded", location: { directory }, projectID: "project-main" }
				: { agent: "sisyphus", outcome: "succeeded", location: { directory }, projectID: "project-main" })
		setSessionContext([{ type: "assistant", content: [{ type: "text", text: "VERDICT: REJECT - missing regression test for empty input" }] }])
		const runs = getV2SubagentRunState(ctx.storage)
		await runs.recordLaunch(workerID, { parentSessionID: parentID, startedAt: 1, status: "completed", blockedActions: [] })
		await runs.recordLaunch(reviewerID, { parentSessionID: parentID, startedAt: 2, status: "completed", blockedActions: [] })
		await getV2TodoState(ctx.storage).write(parentID, [{ content: "Add the empty-input regression test", status: "in_progress" }])
		const policies = await createV2WorkflowPolicyStore(ctx)
		await policies.update(parentID, (current) => ({ ...current, finalWave: { workID: "w", planPath: "/plan.md", status: "reject", expected: 2, approvedTaskKeys: [] } }))
		const cleanup = await registerV2LifecycleHooks(ctx, { disabled_hooks: ["goal", "atlas", "todo-continuation-enforcer"] } as OhMyOpenCodeConfig)

		const compaction = { sessionID: parentID, system: [] as Array<{ type: "text"; text: string }>, messages: [] }
		await callbacks.get("compaction")!(compaction)
		const compactionText = compaction.system.map((part) => part.text).join("\n")
		expect(compactionText).toContain("<omo_compaction_guidance>")
		expect(compactionText).toContain("RESUME, DON'T RESTART")
		expect(compactionText).toContain(`task_id: \`${workerID}\``)
		expect(compactionText).toContain(`task_id: \`${reviewerID}\``)
		expect(compactionText).toContain("Implement the parser change")
		expect(compactionText).toContain("VERDICT: REJECT - missing regression test for empty input")
		expect(compactionText).toContain('<final_wave_review plan="/plan.md" status="reject"')
		expect(compactionText).toContain("Add the empty-input regression test")
		expect(compactionText).toContain("<current_agent>sisyphus</current_agent>")

		const ordinary = { sessionID: parentID, system: [] as Array<{ type: "text"; text: string }>, messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }] }
		await callbacks.get("context")!(ordinary)
		expect(ordinary.system).toEqual([])

		const compacted = {
			sessionID: parentID,
			system: [] as Array<{ type: "text"; text: string }>,
			messages: [{ role: "user", content: [{ type: "text", text: "<conversation-checkpoint>\nThe following is a summary" }] }, { role: "user", content: "next" }],
		}
		await callbacks.get("context")!(compacted)
		const postText = compacted.system.map((part) => part.text).join("\n")
		expect(postText).toContain("<omo_post_compaction_state>")
		expect(postText).toContain(`task_id: \`${workerID}\``)
		expect(postText).toContain("VERDICT: REJECT")
		expect(postText).not.toContain("<omo_compaction_guidance>")
		await callbacks.get("context")!(compacted)
		expect(compacted.system).toHaveLength(1)

		const provider = { sessionID: parentID, system: [] as Array<{ type: "text"; text: string }>, messages: [{ role: "assistant", content: [{ type: "compaction", text: "opaque" }] }] }
		await callbacks.get("context")!(provider)
		expect(provider.system).toHaveLength(1)
		await cleanup()
		await policies.dispose()
	})

	test("compaction context omits OMO state when both compaction hooks are disabled and keeps children out of other parents", async () => {
		const directory = await mkdtemp(join(tmpdir(), "omo-v2-lifecycle-compaction-off-"))
		roots.push(directory)
		const { ctx, callbacks, setSessionGet } = makeContext(directory)
		setSessionGet(async (sessionID) => sessionID === "ses-foreign-child"
			? { parentID: "ses-other-parent", agent: "explore", location: { directory }, projectID: "project-main" }
			: { agent: "sisyphus", location: { directory }, projectID: "project-main" })
		await getV2SubagentRunState(ctx.storage).recordLaunch("ses-foreign-child", { parentSessionID: "ses-parent", startedAt: 1, status: "running", blockedActions: [] })
		const cleanup = await registerV2LifecycleHooks(ctx, { disabled_hooks: ["goal", "atlas", "todo-continuation-enforcer"] } as OhMyOpenCodeConfig)
		const compaction = { sessionID: "ses-parent", system: [] as Array<{ type: "text"; text: string }>, messages: [] }
		await callbacks.get("compaction")!(compaction)
		expect(compaction.system.map((part) => part.text).join("\n")).not.toContain("ses-foreign-child")
		await cleanup()

		const disabled = makeContext(directory)
		const cleanupDisabled = await registerV2LifecycleHooks(disabled.ctx, { disabled_hooks: ["goal", "atlas", "todo-continuation-enforcer", "compaction-context-injector", "compaction-todo-preserver"] } as OhMyOpenCodeConfig)
		expect(disabled.callbacks.has("compaction")).toBe(false)
		expect(disabled.callbacks.has("context")).toBe(false)
		await cleanupDisabled()
	})

	test("unwinds earlier lifecycle registrations when compaction-hook registration fails", async () => {
		const directory = await mkdtemp(join(tmpdir(), "omo-v2-lifecycle-test-"))
		roots.push(directory)
		const { ctx, disposed } = makeContext(directory, "succeeded", true)
		await expect(registerV2LifecycleHooks(ctx, {} as OhMyOpenCodeConfig)).rejects.toThrow("compaction registration failure")
		expect(disposed).toEqual(["prompt"])
	})

	test("Stop-hook continuation owns the turn before Boulder completion and goal/todo mutation", async () => {
		const directory = await mkdtemp(join(tmpdir(), "omo-v2-stop-owner-"))
		roots.push(directory)
		const fixture = makeContext(directory)
		const { ctx, setSessionGet, subscribed, push, synthetics, storageData } = fixture
		const sessionID = "ses-stop-owner"
		setSessionGet(async () => ({ outcome: "succeeded", time: { idle: 100 }, projectID: "project-main", location: { directory } }))
		const work = await seedCompletedBoulderPlan(directory, sessionID)
		await getV2TodoState(ctx.storage).write(sessionID, [{ content: "still pending", status: "pending" }])
		getV2GoalController(ctx).setGoal(sessionID, "Finish the goal")
		const id = "msg_" + "a".repeat(48)
		let calls = 0
		const cleanup = await registerV2LifecycleHooks(ctx, { goal: { enabled: true } } as OhMyOpenCodeConfig, {
			beforeContinuation: async (input) => {
				calls++
				expect(input.idleAt).toBe(100)
				expect(input.isCurrent()).toBe(true)
				return { kind: "continue", id, text: "Stop hook requires a verification" }
			},
		})
		try {
			await subscribed
			push("session.execution.succeeded", sessionID)
			await waitUntil(() => synthetics.length === 1)
			expect(synthetics[0]).toMatchObject({ id, text: "Stop hook requires a verification", resume: true, delivery: "queue" })
			expect(readBoulderState(directory)?.works?.[work.work_id]?.status).toBe("active")
			const policy = [...storageData.values()].find((value) => value && typeof value === "object" && "todo" in value) as { todo?: { lastDispatchAt?: number } } | undefined
			expect(policy?.todo?.lastDispatchAt).toBeUndefined()
			push("session.execution.succeeded", sessionID)
			await new Promise((resolve) => setTimeout(resolve, 20))
			expect(calls).toBe(1)
			expect(synthetics).toHaveLength(1)
		} finally { await cleanup() }
	})

	test("Stop-hook pause is visible without resuming; allow continues the ordinary goal", async () => {
		for (const kind of ["pause", "allow"] as const) {
			const directory = await mkdtemp(join(tmpdir(), "omo-v2-stop-decision-"))
			roots.push(directory)
			const { ctx, setSessionGet, subscribed, push, synthetics } = makeContext(directory)
			const sessionID = `ses-${kind}`
			setSessionGet(async () => ({ outcome: "succeeded", time: { idle: 100 }, projectID: "project-main", location: { directory } }))
			getV2GoalController(ctx).setGoal(sessionID, "Finish the goal")
			const cleanup = await registerV2LifecycleHooks(ctx, { goal: { enabled: true } } as OhMyOpenCodeConfig, {
				beforeContinuation: async () => kind === "pause" ? { kind, text: "Stop hook limit reached" } : { kind },
			})
			try {
				await subscribed
				push("session.execution.succeeded", sessionID)
				await waitUntil(() => synthetics.length === 1)
				if (kind === "pause") expect(synthetics[0]).toMatchObject({ resume: false, id: expect.stringMatching(/^msg_[a-f0-9]{48}$/), text: "Stop hook limit reached" })
				else expect(synthetics[0]).toMatchObject({ resume: true, description: "OMO workflow continuation" })
			} finally { await cleanup() }
		}
	})

	test("new user admission, changed native terminal state, or explicit stop cancels a pending Stop decision", async () => {
		for (const change of ["prompt", "idle", "stop"] as const) {
			const directory = await mkdtemp(join(tmpdir(), "omo-v2-stop-stale-"))
			roots.push(directory)
			const { ctx, callbacks, setSessionGet, subscribed, push, synthetics } = makeContext(directory)
			const sessionID = `ses-stop-${change}`
			let idleAt = 100
			setSessionGet(async () => ({ outcome: "succeeded", time: { idle: idleAt }, projectID: "project-main", location: { directory } }))
			getV2GoalController(ctx).setGoal(sessionID, "Finish the goal")
			let release!: () => void
			let entered = false
			const hold = new Promise<void>((resolve) => { release = resolve })
			const cleanup = await registerV2LifecycleHooks(ctx, { goal: { enabled: true } } as OhMyOpenCodeConfig, {
				beforeContinuation: async () => { entered = true; await hold; return { kind: "continue", id: "msg_" + "b".repeat(48), text: "obsolete continuation" } },
			})
			try {
				await subscribed
				push("session.execution.succeeded", sessionID)
				await waitUntil(() => entered)
				if (change === "prompt") await callbacks.get("prompt")?.({ sessionID, prompt: { text: "New real user request" } })
				if (change === "idle") idleAt = 101
				if (change === "stop") getV2ContinuationState(ctx).stop(sessionID)
				release()
				await waitUntil(() => !getV2ContinuationState(ctx).pending.has(sessionID))
				expect(synthetics).toEqual([])
			} finally { release(); await cleanup() }
		}
	})

	test("unanswered native question prevents Stop-hook execution", async () => {
		const directory = await mkdtemp(join(tmpdir(), "omo-v2-stop-question-"))
		roots.push(directory)
		const { ctx, setSessionGet, setSessionContext, subscribed, push, synthetics } = makeContext(directory)
		const sessionID = "ses-stop-question"
		setSessionGet(async () => ({ outcome: "succeeded", time: { idle: 100 }, projectID: "project-main", location: { directory } }))
		setSessionContext([{ type: "assistant", content: [{ type: "tool", name: "question", state: { status: "running" } }] }])
		let calls = 0
		const cleanup = await registerV2LifecycleHooks(ctx, {} as OhMyOpenCodeConfig, {
			beforeContinuation: async () => { calls++; return { kind: "allow" } },
		})
		try {
			await subscribed
			push("session.execution.succeeded", sessionID)
			await new Promise((resolve) => setTimeout(resolve, 30))
			expect(calls).toBe(0)
			expect(synthetics).toEqual([])
		} finally { await cleanup() }
	})


	test("cleanup aborts and drains a pending Stop hook without dispatch", async () => {
		const directory = await mkdtemp(join(tmpdir(), "omo-v2-stop-dispose-"))
		roots.push(directory)
		const { ctx, setSessionGet, subscribed, push, synthetics } = makeContext(directory)
		setSessionGet(async () => ({ outcome: "succeeded", time: { idle: 100 }, projectID: "project-main", location: { directory } }))
		let entered = false
		let aborted = false
		const cleanup = await registerV2LifecycleHooks(ctx, {} as OhMyOpenCodeConfig, {
			beforeContinuation: async ({ signal, isCurrent }) => {
				entered = true
				await new Promise<void>((resolve) => signal.addEventListener("abort", () => { aborted = true; resolve() }, { once: true }))
				expect(isCurrent()).toBe(false)
				return { kind: "continue", id: "msg_" + "c".repeat(48), text: "obsolete continuation" }
			},
		})
		await subscribed
		push("session.execution.succeeded", "ses-stop-dispose")
		await waitUntil(() => entered)
		await cleanup()
		expect(aborted).toBe(true)
		expect(synthetics).toEqual([])
	})


	test("a gate-owned stale epoch cancels even before the later lifecycle prompt callback", async () => {
		const directory = await mkdtemp(join(tmpdir(), "omo-v2-stop-epoch-"))
		roots.push(directory)
		const { ctx, setSessionGet, subscribed, push, synthetics } = makeContext(directory)
		const sessionID = "ses-stop-epoch"
		setSessionGet(async () => ({ outcome: "succeeded", time: { idle: 100 }, projectID: "project-main", location: { directory } }))
		getV2GoalController(ctx).setGoal(sessionID, "Finish the goal")
		let called = false
		const cleanup = await registerV2LifecycleHooks(ctx, { goal: { enabled: true } } as OhMyOpenCodeConfig, {
			beforeContinuation: async () => { called = true; return { kind: "cancel" } },
		})
		try {
			await subscribed
			push("session.execution.succeeded", sessionID)
			await waitUntil(() => called && !getV2ContinuationState(ctx).pending.has(sessionID))
			expect(synthetics).toEqual([])
		} finally { await cleanup() }
	})

})
