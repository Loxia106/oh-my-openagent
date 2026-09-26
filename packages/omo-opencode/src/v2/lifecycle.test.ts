import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Plugin } from "@opencode/plugin"
import type { OhMyOpenCodeConfig } from "../config"
import { readBoulderState, writeBoulderState, type BoulderWorkState } from "../features/boulder-state"
import { getV2ContinuationState, getV2GoalController, registerV2LifecycleHooks } from "./lifecycle"
import { getV2TodoState } from "./task-state"

const roots: string[] = []
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

type TestEvent = { type: string; data: { sessionID: string }; created: number; location?: { directory: string; workspaceID?: string } }

function makeContext(directory: string, finalOutcome: "succeeded" | "failed" | "interrupted" = "succeeded", failCompaction = false) {
	const callbacks = new Map<string, (input: any) => unknown>()
	const disposed: string[] = []
	const storageData = new Map<string, unknown>()
	const events: TestEvent[] = []
	let sessionGetCalls = 0
	let getSession: () => Promise<unknown> = async () => ({
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
			get: async () => {
				sessionGetCalls++
				return getSession()
			},
		synthetic: async (input: unknown) => { synthetics.push(input) },
		},
		event,
	}
	return {
		ctx: ctx as unknown as Plugin.Context,
		callbacks,
		disposed,
		synthetics,
		subscribed,
		getSessionCalls: () => sessionGetCalls,
		setSessionGet(callback: () => Promise<unknown>) { getSession = callback },
		push(type: TestEvent["type"], sessionID: string, location?: TestEvent["location"]) {
			events.push({
				type,
				data: { sessionID },
				created: Date.now(),
				...(location ? { location } : type.startsWith("session.execution.") ? {} : { location: { directory, workspaceID: "workspace-main" } }),
			})
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

	test("unwinds earlier lifecycle registrations when compaction-hook registration fails", async () => {
		const directory = await mkdtemp(join(tmpdir(), "omo-v2-lifecycle-test-"))
		roots.push(directory)
		const { ctx, disposed } = makeContext(directory, "succeeded", true)
		await expect(registerV2LifecycleHooks(ctx, {} as OhMyOpenCodeConfig)).rejects.toThrow("compaction registration failure")
		expect(disposed).toEqual(["prompt"])
	})
})
