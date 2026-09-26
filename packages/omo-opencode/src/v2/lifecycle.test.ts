import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Plugin } from "@opencode/plugin"
import type { OhMyOpenCodeConfig } from "../config"
import { getV2ContinuationState, getV2GoalController, registerV2LifecycleHooks } from "./lifecycle"

const roots: string[] = []
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

type TestEvent = { type: string; data: { sessionID: string }; created: number; location: { directory: string } }

function makeContext(directory: string, finalOutcome: "succeeded" | "failed" | "interrupted" = "succeeded", failCompaction = false) {
	const callbacks = new Map<string, (input: any) => unknown>()
	const disposed: string[] = []
	const storageData = new Map<string, unknown>()
	const events: TestEvent[] = []
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
		location: { directory },
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
			get: async () => ({
				outcome: finalOutcome,
				tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
			}),
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
		push(type: TestEvent["type"], sessionID: string) {
			events.push({ type, data: { sessionID }, created: Date.now(), location: { directory } })
			wake?.()
		},
	}
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
		push("session.idle", "ses-success")
		await waitUntil(() => synthetics.length === 1)
		expect(synthetics[0]).toMatchObject({
			sessionID: "ses-success",
			delivery: "queue",
			resume: true,
			description: "OMO workflow continuation",
		})
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
			push("session.idle", sessionID)
			await new Promise((resolve) => setTimeout(resolve, 30))
			expect(synthetics).toEqual([])
			await cleanup()
		}
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
