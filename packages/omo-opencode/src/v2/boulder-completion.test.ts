import { afterEach, describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Plugin } from "@opencode/plugin"
import { readBoulderState, writeBoulderState, type BoulderState, type BoulderWorkState } from "../features/boulder-state"
import { handleV2CompletedBoulder } from "./boulder-completion"

const roots: string[] = []

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function makeWork(workID: string, planPath: string, sessionIDs: string[], overrides: Partial<BoulderWorkState> = {}): BoulderWorkState {
	return {
		work_id: workID,
		active_plan: planPath,
		plan_name: "finish-me",
		status: "active",
		started_at: "2026-01-02T10:00:00.000Z",
		session_ids: sessionIDs,
		task_sessions: {},
		...overrides,
	}
}

async function fixture(input?: { plan?: string; work?: BoulderWorkState; state?: BoulderState }) {
	const directory = await mkdtemp(join(tmpdir(), "omo-v2-boulder-complete-"))
	roots.push(directory)
	const planDirectory = join(directory, ".omo", "plans")
	await mkdir(planDirectory, { recursive: true })
	const planPath = join(planDirectory, "finish-me.md")
	await writeFile(planPath, input?.plan ?? "# Plan\n\n## TODOs\n- [x] 1. Done\n", "utf8")
	const work = input?.work ?? makeWork("work-finish", planPath, ["opencode:ses-finish"])
	const state = input?.state ?? {
		schema_version: 2 as const,
		active_work_id: work.work_id,
		works: { [work.work_id]: work },
		active_plan: work.active_plan,
		started_at: work.started_at,
		status: work.status,
		session_ids: [...work.session_ids],
		plan_name: work.plan_name,
	}
	if (!writeBoulderState(directory, state)) throw new Error("could not create test Boulder state")
	return { directory, planPath, work, state }
}

function makeContext(directory: string, storageData = new Map<string, unknown>(), onSynthetic?: (input: unknown) => void) {
	const synthetics: unknown[] = []
	const ctx = {
		location: { directory },
		storage: {
			get: async (key: string) => storageData.get(key),
			set: async (key: string, value: unknown) => { storageData.set(key, value) },
			remove: async (key: string) => { storageData.delete(key) },
			scan: async () => ({ entries: [] }),
		},
		session: {
			synthetic: async (input: unknown) => {
				synthetics.push(input)
				onSynthetic?.(input)
			},
		},
	}
	return { ctx: ctx as unknown as Plugin.Context, synthetics, storageData }
}

function activeInput(stopped: () => boolean = () => false, signal = new AbortController().signal) {
	return { signal, isStopped: stopped }
}

describe("native v2 Boulder completion", () => {
	test("completes only the exact active member and durably queues one stable nudge", async () => {
		const { directory, work } = await fixture({
			work: makeWork("work-finish", join(".omo", "plans", "finish-me.md"), ["opencode:ses-finish"], {
			plan_name: "$&/$'/$`/{ELAPSED_HUMAN}/{TASK_BREAKDOWN}",
			}),
		})
		const { ctx, synthetics, storageData } = makeContext(directory)

		const result = await handleV2CompletedBoulder(ctx, "ses-finish", activeInput())

		expect(result).toBe("submitted")
		expect(readBoulderState(directory)?.works?.[work.work_id]).toMatchObject({ status: "completed" })
		expect(typeof readBoulderState(directory)?.works?.[work.work_id]?.elapsed_ms).toBe("number")
		expect(synthetics).toHaveLength(1)
		expect(synthetics[0]).toMatchObject({
			sessionID: "ses-finish",
			delivery: "queue",
			resume: true,
			metadata: { source: "oh-my-openagent:boulder-completion", workID: work.work_id },
		})
		const synthetic = synthetics[0] as { id: string; text: string }
		expect(synthetic.id).toMatch(/^msg_omo_boulder_complete_[a-f0-9]{64}$/)
		expect(synthetic.text).toContain("$&/$'/$`/{ELAPSED_HUMAN}/{TASK_BREAKDOWN}")
		expect([...storageData.values()]).toContainEqual(expect.objectContaining({ status: "queued", workID: work.work_id }))

		const restarted = makeContext(directory, storageData)
		expect(await handleV2CompletedBoulder(restarted.ctx, "ses-finish", activeInput())).toBe("handled")
		expect(restarted.synthetics).toEqual([])
	})

	test("does not resume a paused session work or follow another work's project mirror", async () => {
		const directory = await mkdtemp(join(tmpdir(), "omo-v2-boulder-paused-"))
		roots.push(directory)
		const planDirectory = join(directory, ".omo", "plans")
		await mkdir(planDirectory, { recursive: true })
		const pausedPlan = join(planDirectory, "paused.md")
		const unrelatedPlan = join(planDirectory, "unrelated.md")
		await writeFile(pausedPlan, "# Plan\n\n## TODOs\n- [x] 1. Done\n", "utf8")
		await writeFile(unrelatedPlan, "# Plan\n\n## TODOs\n- [ ] 1. Pending\n", "utf8")
		const paused = makeWork("work-paused", pausedPlan, ["opencode:ses-paused"], { status: "paused" })
		const unrelated = makeWork("work-unrelated", unrelatedPlan, ["opencode:ses-other"], { status: "active" })
		writeBoulderState(directory, {
			schema_version: 2,
			active_work_id: unrelated.work_id,
			works: { [paused.work_id]: paused, [unrelated.work_id]: unrelated },
			active_plan: unrelated.active_plan,
			started_at: unrelated.started_at,
			status: "active",
			session_ids: [...unrelated.session_ids],
			plan_name: unrelated.plan_name,
		})
		const { ctx, synthetics } = makeContext(directory)

		expect(await handleV2CompletedBoulder(ctx, "ses-paused", activeInput())).toBe("not-applicable")
		expect(readBoulderState(directory)?.works).toMatchObject({
			[paused.work_id]: { status: "paused" },
			[unrelated.work_id]: { status: "active" },
		})
		expect(synthetics).toEqual([])
	})

	test("skips ambiguous active membership and zero-item plans", async () => {
		const first = await fixture()
		const firstPlan = first.planPath
		const secondPlan = join(first.directory, ".omo", "plans", "second.md")
		await writeFile(secondPlan, "# Plan\n\n## TODOs\n- [x] 1. Done\n", "utf8")
		const second = makeWork("work-second", secondPlan, ["opencode:ses-finish"])
		const firstWork = makeWork(first.work.work_id, firstPlan, ["opencode:ses-finish"])
		writeBoulderState(first.directory, {
			...first.state,
			works: { [firstWork.work_id]: firstWork, [second.work_id]: second },
		})
		const ambiguous = makeContext(first.directory)
		expect(await handleV2CompletedBoulder(ambiguous.ctx, "ses-finish", activeInput())).toBe("handled")
		expect(ambiguous.synthetics).toEqual([])
		expect(readBoulderState(first.directory)?.works?.[firstWork.work_id]?.status).toBe("active")

		const empty = await fixture({ plan: "# Plan\n\n## TODOs\n" })
		const emptyContext = makeContext(empty.directory)
		expect(await handleV2CompletedBoulder(emptyContext.ctx, "ses-finish", activeInput())).toBe("not-applicable")
		expect(readBoulderState(empty.directory)?.works?.[empty.work.work_id]?.status).toBe("active")
		expect(emptyContext.synthetics).toEqual([])
	})

	test("stages before completion and retries a completed work after an interrupted nudge", async () => {
		const { directory, work } = await fixture()
		let stopped = false
		let failFirstNudge = true
		const { ctx, synthetics, storageData } = makeContext(directory, new Map(), () => {
			if (failFirstNudge) {
				failFirstNudge = false
				throw new Error("simulated interruption after admission attempt")
			}
		})

		expect(await handleV2CompletedBoulder(ctx, "ses-finish", activeInput(() => stopped))).toBe("handled")
		expect(readBoulderState(directory)?.works?.[work.work_id]?.status).toBe("completed")
		expect([...storageData.values()]).toContainEqual(expect.objectContaining({ status: "pending", workID: work.work_id }))
		const firstID = (synthetics[0] as { id: string }).id

		stopped = false
		expect(await handleV2CompletedBoulder(ctx, "ses-finish", activeInput(() => stopped))).toBe("submitted")
		expect(synthetics).toHaveLength(2)
		expect((synthetics[1] as { id: string }).id).toBe(firstID)
		expect([...storageData.values()]).toContainEqual(expect.objectContaining({ status: "queued", workID: work.work_id }))
	})

	test("a stop while marker storage is pending prevents completion and submission", async () => {
		const { directory, work } = await fixture()
		let release!: () => void
		let stopped = false
		const storageData = new Map<string, unknown>()
		const context = makeContext(directory, storageData)
		const originalSet = context.ctx.storage.set
		context.ctx.storage.set = async (key, value) => {
			await new Promise<void>((resolve) => { release = resolve })
			await originalSet(key, value)
		}
		const running = handleV2CompletedBoulder(context.ctx, "ses-finish", activeInput(() => stopped))
		while (!release) await new Promise((resolve) => setTimeout(resolve, 1))
		stopped = true
		release()

		expect(await running).toBe("handled")
		expect(readBoulderState(directory)?.works?.[work.work_id]?.status).toBe("active")
		expect(context.synthetics).toEqual([])
		expect([...storageData.values()]).toContainEqual(expect.objectContaining({ status: "pending", workID: work.work_id }))
	})

	test("does not complete or nudge through a symlink that escapes the project", async () => {
		const fixtureState = await fixture()
		const outside = await mkdtemp(join(tmpdir(), "omo-v2-boulder-outside-"))
		roots.push(outside)
		const outsidePlan = join(outside, "outside.md")
		await writeFile(outsidePlan, "# Plan\n\n## TODOs\n- [x] 1. Done\n", "utf8")
		const link = join(fixtureState.directory, ".omo", "plans", "linked.md")
		await rm(fixtureState.planPath)
		await symlink(outsidePlan, link)
		const linkedWork = { ...fixtureState.work, active_plan: link }
		writeBoulderState(fixtureState.directory, {
			...fixtureState.state,
			active_plan: link,
			works: { [linkedWork.work_id]: linkedWork },
		})
		const { ctx, synthetics } = makeContext(fixtureState.directory)

		expect(await handleV2CompletedBoulder(ctx, "ses-finish", activeInput())).toBe("not-applicable")
		expect(readBoulderState(fixtureState.directory)?.works?.[linkedWork.work_id]?.status).toBe("active")
		expect(synthetics).toEqual([])
	})

	test("upgrades only the exact statusless legacy mirror before marking it complete", async () => {
		const directory = await mkdtemp(join(tmpdir(), "omo-v2-boulder-legacy-"))
		roots.push(directory)
		const planDirectory = join(directory, ".omo", "plans")
		await mkdir(planDirectory, { recursive: true })
		const planPath = join(planDirectory, "legacy.md")
		await writeFile(planPath, "# Plan\n\n## TODOs\n- [x] 1. Done\n", "utf8")
		const workID = "legacy-plan-legacy"
		writeBoulderState(directory, {
			active_plan: planPath,
			started_at: "2026-01-02T10:00:00.000Z",
			session_ids: ["opencode:ses-legacy"],
			plan_name: "legacy-plan",
		})
		const { ctx, synthetics } = makeContext(directory)

		expect(await handleV2CompletedBoulder(ctx, "ses-legacy", activeInput())).toBe("submitted")
		expect(readBoulderState(directory)).toMatchObject({
			schema_version: 2,
			active_work_id: workID,
			works: { [workID]: { status: "completed" } },
		})
		expect(synthetics).toHaveLength(1)
	})

	test("a Boulder write failure leaves the pending marker and submits no completion nudge", async () => {
		const { directory, work } = await fixture()
		const statePath = join(directory, ".omo", "boulder.json")
		await chmod(statePath, 0o444)
		const { ctx, synthetics, storageData } = makeContext(directory)

		expect(await handleV2CompletedBoulder(ctx, "ses-finish", activeInput())).toBe("handled")
		expect(readBoulderState(directory)?.works?.[work.work_id]?.status).toBe("active")
		expect(synthetics).toEqual([])
		expect([...storageData.values()]).toContainEqual(expect.objectContaining({ status: "pending", workID: work.work_id }))
		const persisted = JSON.parse(await readFile(statePath, "utf8")) as BoulderState
		expect(persisted.works?.[work.work_id]?.status).toBe("active")
	})
})
