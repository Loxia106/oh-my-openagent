import { describe, expect, test } from "bun:test"
import type { OpenCodeEvent } from "@opencode/client"
import type { Plugin } from "@opencode/plugin"
import type { OhMyOpenCodeConfig } from "../config"
import type { GoalController } from "../hooks/goal/controller"
import { createV2GoalAutoStartHelper } from "./goal-auto-start"
import { createV2SubagentRunState } from "./task-state"

type InboxEvent = Extract<OpenCodeEvent, { type: "session.inbox.enqueued" }>
type MockSession = {
	id: string
	projectID: string
	location: { directory: string }
	agent?: string | null
	parentID?: string
	metadata?: Record<string, unknown>
}

const directory = "/tmp/omo-goal-auto-start"
const location = { directory, workspaceID: "workspace-a", project: { id: "project-a" } }

function makeEvent(input: {
	readonly sessionID?: string
	readonly inboxID?: string
	readonly text?: string
	readonly eventLocation?: InboxEvent["location"]
	readonly itemType?: "user" | "synthetic"
} = {}): InboxEvent {
	const sessionID = input.sessionID ?? "ses-root"
	const inboxID = input.inboxID ?? "msg-first"
	return {
		id: `evt-${inboxID}`,
		created: 1,
		type: "session.inbox.enqueued",
		durable: { aggregateID: sessionID, seq: 1, version: 1 },
		location: input.eventLocation ?? { directory, workspaceID: "workspace-a" },
		data: {
			sessionID,
			inboxID,
			item: input.itemType === "synthetic"
				? { type: "synthetic", payload: { text: input.text ?? "Synthetic command result" }, delivery: "steer" }
				: { type: "user", payload: { text: input.text ?? "Ship the compatibility implementation" }, delivery: "sync" },
		},
	} as InboxEvent
}

function createHarness(input: {
	readonly config?: OhMyOpenCodeConfig
	readonly session?: Partial<MockSession>
	readonly messages?: unknown[]
	readonly sessionError?: boolean
	readonly contextError?: boolean
	readonly agentMode?: "primary" | "subagent" | "all"
	readonly agentError?: boolean
	readonly storageSetError?: boolean
	readonly goal?: { id: string; objective: string } | null
	readonly storageSet?: (key: string, value: unknown) => Promise<void>
	readonly contextWait?: () => Promise<void>
} = {}) {
	const values = new Map<string, unknown>()
	const session: MockSession = {
		id: "ses-root",
		projectID: location.project.id,
		location: { directory },
		agent: "sisyphus",
		...input.session,
	}
	const storage = {
		get: async (key: string) => values.get(key),
		set: async (key: string, value: unknown) => {
			if (input.storageSetError) throw new Error("storage write failed")
			if (input.storageSet) await input.storageSet(key, value)
			values.set(key, value)
		},
		remove: async (key: string) => { values.delete(key) },
		scan: async () => ({ entries: [] }),
	}
	const goals = new Map<string, { id: string; objective: string }>()
	if (input.goal) goals.set(session.id, input.goal)
	const setCalls: Array<{ sessionID: string; objective: string }> = []
	const controller = {
		getGoal: (sessionID: string) => goals.get(sessionID) ?? null,
		setGoal: (sessionID: string, objective: string) => {
			setCalls.push({ sessionID, objective })
			const goal = { id: `goal-${setCalls.length}`, objective }
			goals.set(sessionID, goal)
			return goal
		},
	} as unknown as GoalController
	const ctx = {
		location,
		storage,
		session: {
			get: async ({ sessionID }: { sessionID: string }) => {
				if (input.sessionError) throw new Error("session not available")
				if (sessionID !== session.id) throw new Error("unknown session")
				return session
			},
			context: async ({ sessionID }: { sessionID: string }) => {
				if (input.contextError) throw new Error("history unavailable")
				if (sessionID !== session.id) throw new Error("unknown session")
				await input.contextWait?.()
				return input.messages ?? [
					{ id: "agent-select", type: "agent-switched", agent: "sisyphus" },
					{ id: "model-select", type: "model-switched", model: { providerID: "openai", id: "gpt-test" } },
					{ id: "msg-first", type: "user", text: "Ship the compatibility implementation" },
				]
			},
		},
		agent: {
			get: async () => {
				if (input.agentError) throw new Error("agent unavailable")
				return { data: { id: "sisyphus", mode: input.agentMode ?? "primary" } }
			},
		},
	} as unknown as Plugin.Context
	const config = input.config ?? ({ goal: { enabled: true }, default_mode: { goal: true } } as OhMyOpenCodeConfig)
	const helper = createV2GoalAutoStartHelper(ctx, config, controller)
	return { ctx, storage, values, goals, controller, helper, setCalls }
}

describe("native V2 first-user goal auto-start", () => {
	test("creates one goal from the first accepted root user inbox with initial selection metadata", async () => {
		const harness = createHarness()
		const result = await harness.helper.handle(makeEvent())
		expect(result.kind).toBe("created")
		expect(harness.setCalls).toEqual([{ sessionID: "ses-root", objective: "Ship the compatibility implementation" }])
		const marker = [...harness.values.values()][0] as Record<string, unknown>
		expect(marker).toMatchObject({ version: 1, sessionID: "ses-root", inboxID: "msg-first" })
		await harness.helper.dispose()
	})

	test("allows an absent native default agent and a history containing only the current inbox user", async () => {
		const harness = createHarness({ session: { agent: null }, messages: [{ id: "msg-first", type: "user", text: "First turn" }] })
		expect((await harness.helper.handle(makeEvent({ text: "First turn" }))).kind).toBe("created")
		await harness.helper.dispose()
	})

	test("accepts later assistant/tool history from the same inbox turn but rejects earlier assistant history", async () => {
		const sameTurn = createHarness({ messages: [
			{ id: "agent-select", type: "agent-switched", agent: "sisyphus" },
			{ id: "msg-first", type: "user", text: "First turn" },
			{ id: "assistant-fast", type: "assistant", agent: "sisyphus" },
		] })
		expect((await sameTurn.helper.handle(makeEvent({ text: "First turn" }))).kind).toBe("created")
		await sameTurn.helper.dispose()

		const olderAssistant = createHarness({ messages: [
			{ id: "assistant-old", type: "assistant", agent: "sisyphus" },
			{ id: "msg-first", type: "user", text: "Current turn" },
		] })
		expect(await olderAssistant.helper.handle(makeEvent())).toEqual({ kind: "skipped", reason: "prior-session-history" })
		expect(olderAssistant.setCalls).toHaveLength(0)
		await olderAssistant.helper.dispose()
	})

	test("requires all feature gates and ignores the legacy auto_start field", async () => {
		for (const config of [
			{ goal: { enabled: false }, default_mode: { goal: true } },
			{ goal: { enabled: true }, default_mode: { goal: false } },
			{ goal: { enabled: true }, default_mode: { goal: true }, disabled_hooks: ["goal"] },
		]) {
			const harness = createHarness({ config: config as OhMyOpenCodeConfig })
			expect((await harness.helper.handle(makeEvent())).kind).toBe("skipped")
			expect(harness.setCalls).toHaveLength(0)
			await harness.helper.dispose()
		}
		const legacyAutoStartFlag = createHarness({
			config: { goal: { enabled: true, auto_start: false }, default_mode: { goal: true } } as OhMyOpenCodeConfig,
		})
		expect((await legacyAutoStartFlag.helper.handle(makeEvent())).kind).toBe("created")
		await legacyAutoStartFlag.helper.dispose()
	})

	test("does not auto-start from old users, assistants, or compaction checkpoints", async () => {
		for (const messages of [
			[{ id: "old-user", type: "user", text: "Earlier work" }, { id: "msg-first", type: "user", text: "Current" }],
			[{ id: "old-assistant", type: "assistant", agent: "sisyphus" }, { id: "msg-first", type: "user", text: "Current" }],
			[{ id: "old-checkpoint", type: "compaction" }, { id: "msg-first", type: "user", text: "Current" }],
			[{ id: "old-checkpoint", type: "compaction" }],
		]) {
			const harness = createHarness({ messages })
			expect(await harness.helper.handle(makeEvent())).toEqual({ kind: "skipped", reason: "prior-session-history" })
			expect(harness.values.size).toBe(1)
			expect(harness.setCalls).toHaveLength(0)
			await harness.helper.dispose()
		}
	})

	test("fails closed on unknown history and session/location/agent lookup", async () => {
		for (const options of [
			{ contextError: true },
			{ sessionError: true },
			{ agentError: true },
			{ session: { projectID: "other-project" } },
			{ session: { location: { directory: "/other" } } },
			{ session: { id: "ses-other" } },
			{ messages: [{ id: "unknown", type: "assistant" }] },
		]) {
			const harness = createHarness(options)
			expect((await harness.helper.handle(makeEvent())).kind).toBe("skipped")
			expect(harness.setCalls).toHaveLength(0)
			await harness.helper.dispose()
		}
		const mismatch = createHarness()
		expect((await mismatch.helper.handle(makeEvent({ eventLocation: { directory, workspaceID: "workspace-b" } }))).kind).toBe("skipped")
		expect(mismatch.values.size).toBe(0)
		await mismatch.helper.dispose()
	})

	test("excludes native, managed, team-hinted, and resolver-verified logical children", async () => {
		const nativeChild = createHarness({ session: { parentID: "ses-parent" } })
		expect((await nativeChild.helper.handle(makeEvent())).kind).toBe("skipped")
		await nativeChild.helper.dispose()

		const teamChild = createHarness({ session: { metadata: { omoTeam: { version: 1, teamRunId: "team-1" } } } })
		expect((await teamChild.helper.handle(makeEvent())).kind).toBe("skipped")
		await teamChild.helper.dispose()

		const logicalChild = createHarness()
		const logicalHelper = createV2GoalAutoStartHelper(
			logicalChild.ctx,
			{ goal: { enabled: true }, default_mode: { goal: true } } as OhMyOpenCodeConfig,
			logicalChild.controller,
			{ resolveLogicalParent: async () => "ses-team-lead" },
		)
		expect((await logicalHelper.handle(makeEvent())).kind).toBe("skipped")
		await logicalHelper.dispose()

		const managed = createHarness()
		await createV2SubagentRunState(managed.storage as Plugin.Context["storage"]).recordLaunch("ses-root", {
			parentSessionID: "ses-parent",
			startedAt: 10,
			status: "running",
			blockedActions: [],
		})
		expect((await managed.helper.handle(makeEvent())).kind).toBe("skipped")
		expect(managed.setCalls).toHaveLength(0)
		await managed.helper.dispose()
	})

	test("requires a logical ownership resolver when Team mode is enabled and excludes non-primary agents", async () => {
		const noResolver = createHarness({ config: { goal: { enabled: true }, default_mode: { goal: true }, team_mode: { enabled: true } } as OhMyOpenCodeConfig })
		expect(await noResolver.helper.handle(makeEvent())).toEqual({ kind: "skipped", reason: "logical-ownership-unavailable" })
		await noResolver.helper.dispose()

		const childAgent = createHarness({ agentMode: "subagent" })
		expect(await childAgent.helper.handle(makeEvent())).toEqual({ kind: "skipped", reason: "non-primary-agent" })
		await childAgent.helper.dispose()

		const resolverFailure = createHarness()
		const helper = createV2GoalAutoStartHelper(resolverFailure.ctx, { goal: { enabled: true }, default_mode: { goal: true } } as OhMyOpenCodeConfig, resolverFailure.controller, {
			resolveLogicalParent: async () => { throw new Error("sidecar read failed") },
		})
		expect(await helper.handle(makeEvent())).toEqual({ kind: "skipped", reason: "logical-ownership-unavailable" })
		await helper.dispose()
	})

	test("preserves an existing goal and durable first-seen prevents recreation after clear/reload", async () => {
		const harness = createHarness({ goal: { id: "goal-existing", objective: "Keep this goal" } })
		expect(await harness.helper.handle(makeEvent())).toEqual({ kind: "skipped", reason: "goal-exists" })
		harness.goals.delete("ses-root")
		await harness.helper.dispose()

		const reloaded = createV2GoalAutoStartHelper(harness.ctx, { goal: { enabled: true }, default_mode: { goal: true } } as OhMyOpenCodeConfig, harness.controller)
		expect(await reloaded.handle(makeEvent({ inboxID: "msg-later", text: "A later request" }))).toEqual({ kind: "skipped", reason: "already-seen" })
		expect(harness.setCalls).toHaveLength(0)
		await reloaded.forget("ses-root")
		expect(await reloaded.handle(makeEvent({ inboxID: "msg-first" })).then((result) => result.kind)).toBe("created")
		await reloaded.dispose()
	})

	test("serializes duplicate/concurrent inbox events and limits marker cleanup to explicit deletion", async () => {
		const harness = createHarness()
		const duplicate = makeEvent()
		const results = await Promise.all([harness.helper.handle(duplicate), harness.helper.handle(duplicate)])
		expect(results.map((result) => result.kind).sort()).toEqual(["created", "skipped"])
		expect(harness.setCalls).toHaveLength(1)
		expect(await harness.helper.handle(makeEvent({ itemType: "synthetic", inboxID: "msg-synthetic" }))).toEqual({ kind: "skipped", reason: "not-user-inbox" })
		await harness.helper.dispose()
	})

	test("storage marker failure is fail-closed before setting a goal", async () => {
		const harness = createHarness({ storageSetError: true })
		await expect(harness.helper.handle(makeEvent())).rejects.toThrow("storage write failed")
		expect(harness.setCalls).toHaveLength(0)
		await harness.helper.dispose()
	})

	test("disposal during the marker write prevents goal mutation and rolls back its marker", async () => {
		let entered!: () => void
		let release!: () => void
		const atWrite = new Promise<void>((resolve) => { entered = resolve })
		const blocked = new Promise<void>((resolve) => { release = resolve })
		const harness = createHarness({ storageSet: async () => { entered(); await blocked } })
		const handling = harness.helper.handle(makeEvent())
		await atWrite
		const disposing = harness.helper.dispose()
		release()
		await disposing
		expect((await handling).kind).toBe("skipped")
		expect(harness.setCalls).toHaveLength(0)
		expect(harness.values.size).toBe(0)
	})

	test("a stop while native history is loading prevents the goal mutation", async () => {
		let entered!: () => void
		let release!: () => void
		const atHistory = new Promise<void>((resolve) => { entered = resolve })
		const blocked = new Promise<void>((resolve) => { release = resolve })
		const harness = createHarness({ contextWait: async () => { entered(); await blocked } })
		let stopped = false
		const helper = createV2GoalAutoStartHelper(
			harness.ctx,
			{ goal: { enabled: true }, default_mode: { goal: true } } as OhMyOpenCodeConfig,
			harness.controller,
			{ isCurrent: () => !stopped },
		)
		const handling = helper.handle(makeEvent())
		await atHistory
		stopped = true
		release()
		expect(await handling).toEqual({ kind: "skipped", reason: "not-current" })
		expect(harness.setCalls).toHaveLength(0)
		expect(harness.values.size).toBe(0)
		await helper.dispose()
	})
})
