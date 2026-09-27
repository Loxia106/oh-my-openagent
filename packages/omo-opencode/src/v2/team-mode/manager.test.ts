import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { SessionMessage } from "@opencode/schema"
import type { Plugin } from "@opencode/plugin"
import { Error as ToolError, type ToolEditor } from "@opencode/plugin/promise/tool"
import { listUnreadMessages } from "@oh-my-opencode/team-core/team-mailbox"
import { TeamModeConfigSchema } from "@oh-my-opencode/team-core/config"
import type { Task } from "@oh-my-opencode/team-core/types"
import { unsafeTestValue } from "../../../../../test-support/unsafe-test-value"
import type { OhMyOpenCodeConfig } from "../../config"
import { createV2TeamManager, isNewerTeamExecutionIdle, planV2TeamTaskUpdate, stableV2TeamMailboxPromptId, teamWakeRetryDelayMs } from "./manager"

const pendingTask: Task = {
	version: 1,
	id: "task-1",
	subject: "Task",
	description: "Description",
	status: "pending",
	blocks: [],
	blockedBy: [],
	createdAt: 1,
	updatedAt: 1,
}

describe("native Team task authorization", () => {
	test("only the lead may claim a pending task for another roster member", () => {
		expect(planV2TeamTaskUpdate({
			actorName: "lead",
			actorRole: "lead",
			task: pendingTask,
			status: "claimed",
			requestedOwner: "worker",
			memberNames: new Set(["lead", "worker"]),
		})).toEqual({ kind: "claim", memberName: "worker" })
		expect(() => planV2TeamTaskUpdate({
			actorName: "worker",
			actorRole: "member",
			task: pendingTask,
			status: "claimed",
			requestedOwner: "other",
			memberNames: new Set(["lead", "worker"]),
		})).toThrow(ToolError)
		expect(() => planV2TeamTaskUpdate({
			actorName: "lead",
			actorRole: "lead",
			task: pendingTask,
			status: "claimed",
			requestedOwner: "not-in-roster",
			memberNames: new Set(["lead", "worker"]),
		})).toThrow("not a member")
	})

	test("members cannot delete another member's owned task or reassign existing ownership", () => {
		const workerTask = { ...pendingTask, status: "in_progress", owner: "worker" } as Task
		for (const status of ["completed", "deleted"] as const) {
			expect(() => planV2TeamTaskUpdate({
				actorName: "other",
				actorRole: "member",
				task: workerTask,
				status,
				memberNames: new Set(["lead", "worker", "other"]),
			})).toThrow(ToolError)
		}
		expect(() => planV2TeamTaskUpdate({
			actorName: "lead",
			actorRole: "lead",
			task: workerTask,
			status: "in_progress",
			requestedOwner: "other",
			memberNames: new Set(["lead", "worker", "other"]),
		})).toThrow("cannot reassign")
		expect(planV2TeamTaskUpdate({
			actorName: "worker",
			actorRole: "member",
			task: workerTask,
			status: "completed",
			memberNames: new Set(["lead", "worker"]),
		})).toEqual({ kind: "update", memberName: "worker" })
	})
})

describe("native Team roster preflight", () => {
	test("returns the queued roster without waiting for a shared admission slot", async () => {
		const root = await mkdtemp(join(tmpdir(), "omo-v2-team-queue-"))
		const projectDirectory = join(root, "project")
		await mkdir(projectDirectory)
		const runtimeRoot = join(root, "teams")
		const sessionsCreated: unknown[] = []
		let admissionCalls = 0
		const tools = new Map<string, { execute: (input: unknown, context: unknown) => Promise<{ content?: string }> }>()
		let markAcquireStarted!: () => void
		const acquireStarted = new Promise<void>((resolve) => { markAcquireStarted = resolve })
		const sessionInfo = {
			id: "ses-team-lead",
			projectID: "project-queue",
			agent: "atlas",
			model: { providerID: "host", id: "atlas-model" },
			location: { directory: projectDirectory },
			outcome: "succeeded",
		}
		const ctx = unsafeTestValue<Plugin.Context>({
			location: { directory: projectDirectory, project: { id: "project-queue", canonical: projectDirectory }, workspaceID: "workspace-queue" },
			storage: { get: async () => undefined, set: async () => undefined, remove: async () => undefined },
			agent: { list: async () => ({ data: [
				{ id: "atlas", mode: "primary", model: { providerID: "host", id: "atlas-model" } },
				{ id: "sisyphus", mode: "primary", model: { providerID: "host", id: "worker-model" } },
			] }) },
			model: {
				list: async () => ({ data: [
					{ providerID: "host", id: "atlas-model", enabled: true, variants: [] },
					{ providerID: "host", id: "worker-model", enabled: true, variants: [] },
				] }),
				default: async () => ({ data: { providerID: "host", id: "atlas-model" } }),
			},
				session: {
				get: async () => sessionInfo,
				create: async (input: unknown) => { sessionsCreated.push(input); throw new Error("unexpected child creation before admission") },
					prompt: async () => undefined,
				wait: async () => undefined,
				interrupt: async () => undefined,
				hook: async () => ({ dispose: async () => undefined }),
			},
			event: {
				subscribe: async function* ({ signal }: { signal: AbortSignal }) {
					await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }))
				},
			},
		})
		const config = unsafeTestValue<OhMyOpenCodeConfig>({
			team_mode: { enabled: true, base_dir: runtimeRoot, max_parallel_members: 1 },
		})
		const manager = createV2TeamManager(ctx, config)
		try {
			await manager.start({
				admission: {
					acquire: async (input: { signal?: AbortSignal }) => {
						admissionCalls += 1
						markAcquireStarted()
						return new Promise((_resolve, reject) => {
							const cancel = () => reject(input.signal?.reason ?? new Error("aborted"))
						if (input.signal?.aborted) cancel()
						else input.signal?.addEventListener("abort", cancel, { once: true })
					})
					},
				} as never,
				runs: { recordLaunch: async () => undefined } as never,
			})
			manager.createTools(unsafeTestValue<ToolEditor>({
				add: (tool: { name: string; execute: (input: unknown, context: unknown) => Promise<{ content?: string }> }) => tools.set(tool.name, tool),
				remove: () => undefined,
				get: () => undefined,
			}))
			const create = tools.get("team_create")
			if (!create) throw new Error("team_create was not registered")
			const response = await Promise.race([
				create.execute({ inline_spec: {
					version: 1,
					name: "queued-team",
					leadAgentId: "lead",
					members: [
						{ kind: "subagent_type", name: "lead", subagent_type: "atlas" },
						{ kind: "subagent_type", name: "worker", subagent_type: "sisyphus" },
					],
				} }, { sessionID: sessionInfo.id, signal: new AbortController().signal, id: "call-create" }),
				new Promise<never>((_, reject) => setTimeout(() => reject(new Error("team_create waited for member admission")), 1_000)),
			])
			await Promise.race([
				acquireStarted,
				new Promise<never>((_, reject) => setTimeout(() => reject(new Error("queued member launch never reached admission")), 1_000)),
			])
			expect(JSON.parse(response.content ?? "{}")).toMatchObject({ queued: 1, teamName: "queued-team" })
			expect(sessionsCreated).toEqual([])
			const teamRunId = JSON.parse(response.content ?? "{}").teamRunId as string
			const send = tools.get("team_send_message")
			if (!send) throw new Error("team_send_message was not registered")
			const sendResponse = await send.execute({ teamRunId, to: "worker", body: "Arrived before the member session exists." }, {
				sessionID: sessionInfo.id,
				signal: new AbortController().signal,
				id: "call-pending-member-message",
			})
			expect(JSON.parse(sendResponse.content ?? "{}").deliveredTo).toEqual(["worker"])
			expect(await listUnreadMessages(teamRunId, "worker", TeamModeConfigSchema.parse(config.team_mode))).toHaveLength(1)
			expect(admissionCalls).toBe(1)
		} finally {
			await manager.dispose()
			await rm(root, { recursive: true, force: true })
		}
	})

	test("rejects an unavailable required category before creating runtime or session state", async () => {
		const root = await mkdtemp(join(tmpdir(), "omo-v2-team-preflight-"))
		const runtimeRoot = join(root, "teams")
		const projectDirectory = join(root, "project")
		const sessionsCreated: unknown[] = []
		const tools = new Map<string, { execute: (input: unknown, context: unknown) => Promise<unknown> }>()
		const sessionInfo = {
			id: "ses-team-lead",
			projectID: "project-preflight",
			agent: "atlas",
			model: { providerID: "host", id: "atlas-model" },
			location: { directory: projectDirectory },
			outcome: "succeeded",
		}
		const ctx = unsafeTestValue<Plugin.Context>({
			location: { directory: projectDirectory, project: { id: "project-preflight", canonical: projectDirectory }, workspaceID: "workspace-preflight" },
			storage: { get: async () => undefined, set: async () => undefined, remove: async () => undefined },
			agent: {
				list: async () => ({ data: [
					{ id: "atlas", mode: "primary", model: { providerID: "host", id: "atlas-model" } },
					{ id: "sisyphus", mode: "primary", model: { providerID: "host", id: "worker-model" } },
					{ id: "sisyphus-junior", mode: "primary", model: { providerID: "host", id: "junior-model" } },
				] }),
			},
			model: {
				list: async () => ({ data: [
					{ providerID: "host", id: "atlas-model", enabled: true, variants: [] },
					{ providerID: "host", id: "worker-model", enabled: true, variants: [] },
					{ providerID: "host", id: "junior-model", enabled: true, variants: [] },
				] }),
				default: async () => ({ data: { providerID: "host", id: "atlas-model" } }),
			},
			session: {
				get: async () => sessionInfo,
				create: async (input: unknown) => { sessionsCreated.push(input); throw new Error("unexpected session.create") },
				prompt: async () => { throw new Error("unexpected session.prompt") },
				wait: async () => undefined,
				interrupt: async () => undefined,
				hook: async () => ({ dispose: async () => undefined }),
			},
			event: {
				subscribe: async function* ({ signal }: { signal: AbortSignal }) {
					await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }))
				},
			},
		})
		const config = unsafeTestValue<OhMyOpenCodeConfig>({
			team_mode: { enabled: true, base_dir: runtimeRoot, max_parallel_members: 2 },
		})
		const manager = createV2TeamManager(ctx, config)
		try {
			await manager.start({
				admission: { acquire: async () => { throw new Error("admission must not run during preflight") } } as never,
				runs: { recordLaunch: async () => undefined } as never,
			})
			manager.createTools(unsafeTestValue<ToolEditor>({
				add: (tool: { name: string; execute: (input: unknown, context: unknown) => Promise<unknown> }) => tools.set(tool.name, tool),
				remove: () => undefined,
				get: () => undefined,
			}))
			const create = tools.get("team_create")
			if (!create) throw new Error("team_create was not registered")
			await expect(create.execute({
				inline_spec: {
					version: 1,
					name: "preflight-team",
					leadAgentId: "lead",
					members: [
						{ kind: "subagent_type", name: "lead", subagent_type: "atlas" },
						{ kind: "subagent_type", name: "worker", subagent_type: "sisyphus" },
						{ kind: "category", name: "researcher", category: "unavailable-required-category", prompt: "Research this carefully" },
					],
				},
			}, { sessionID: "ses-team-lead", signal: new AbortController().signal })).rejects.toThrow(/researcher.*unavailable|unavailable.*researcher/i)
			expect(sessionsCreated).toEqual([])
			await expect(readdir(runtimeRoot)).rejects.toMatchObject({ code: "ENOENT" })
		} finally {
			await manager.dispose()
			await rm(root, { recursive: true, force: true })
		}
	})
})

describe("native Team mailbox generation safety", () => {
	test("uses a deterministic native message ID and caps wake retry backoff", () => {
		const first = stableV2TeamMailboxPromptId("run-id", "architect", "message-id")
		expect(first).toBe(stableV2TeamMailboxPromptId("run-id", "architect", "message-id"))
		expect(first).not.toBe(stableV2TeamMailboxPromptId("run-id", "architect", "another-message"))
		expect(Schema.decodeUnknownSync(SessionMessage.ID)(first)).toBe(first)
		expect([1, 2, 3, 100].map(teamWakeRetryDelayMs)).toEqual([250, 500, 1_000, 15_000])
		expect(isNewerTeamExecutionIdle(101, 101)).toBe(false)
		expect(isNewerTeamExecutionIdle(101, 102)).toBe(true)
		expect(isNewerTeamExecutionIdle(undefined, 102)).toBe(false)
		expect(isNewerTeamExecutionIdle(0, 0)).toBe(false)
		expect(isNewerTeamExecutionIdle(0, 1)).toBe(true)
	})

	test("a queued stale terminal cannot release a resumed member slot before its idle generation advances", async () => {
		const root = await mkdtemp(join(tmpdir(), "omo-v2-team-generation-"))
		const projectDirectory = join(root, "project")
		await mkdir(projectDirectory)
		const runtimeRoot = join(root, "teams")
		const leadID = "ses-team-lead"
		const childID = "ses-team-worker"
		const idle = { value: undefined as number | undefined }
		const outcome = { value: "succeeded" }
		const child = {
			id: childID,
			projectID: "project-generation",
			agent: "sisyphus",
			model: { providerID: "host", id: "worker-model" },
			location: { directory: projectDirectory },
			parentID: undefined,
			time: { created: 1, updated: 1, idle: idle.value },
			get outcome() { return outcome.value },
		}
		const lead = {
			id: leadID,
			projectID: "project-generation",
			agent: "atlas",
			model: { providerID: "host", id: "atlas-model" },
			location: { directory: projectDirectory },
			parentID: undefined,
			time: { created: 1, updated: 1, idle: 100 },
			outcome: "succeeded",
		}
		const eventQueue: unknown[] = []
		const eventWaiters: Array<() => void> = []
		const tools = new Map<string, { execute: (input: unknown, context: unknown) => Promise<{ content?: string }> }>()
		const syntheticIDs: string[] = []
		let syntheticAttempts = 0
		let rejectSynthetic = true
		let initialPromptCount = 0
		let childSessionReads = 0
		let sessionWaits = 0
		let resumeAdmissions = 0
		const publish = (type: string) => {
			eventQueue.push({ type, data: { sessionID: childID }, location: { directory: projectDirectory } })
			for (const wake of eventWaiters.splice(0)) wake()
		}
		const ctx = unsafeTestValue<Plugin.Context>({
			location: { directory: projectDirectory, project: { id: "project-generation", canonical: projectDirectory }, workspaceID: "workspace-generation" },
			storage: { get: async () => undefined, set: async () => undefined, remove: async () => undefined },
			agent: { list: async () => ({ data: [
				{ id: "atlas", mode: "primary", model: { providerID: "host", id: "atlas-model" } },
				{ id: "sisyphus", mode: "primary", model: { providerID: "host", id: "worker-model" } },
			] }) },
			model: {
				list: async () => ({ data: [
					{ providerID: "host", id: "atlas-model", enabled: true, variants: [] },
					{ providerID: "host", id: "worker-model", enabled: true, variants: [] },
				] }),
				default: async () => ({ data: { providerID: "host", id: "atlas-model" } }),
			},
			session: {
				get: async ({ sessionID }: { sessionID: string }) => {
					if (sessionID === childID) childSessionReads += 1
					return sessionID === leadID ? lead : child
				},
				create: async () => child,
				prompt: async () => { initialPromptCount += 1 },
				synthetic: async ({ id }: { id: string }) => {
					Schema.decodeUnknownSync(SessionMessage.ID)(id)
					syntheticAttempts += 1
					if (rejectSynthetic) throw new Error("temporary synthetic admission failure")
					syntheticIDs.push(id)
				},
				wait: async () => { sessionWaits += 1 },
				interrupt: async () => undefined,
				hook: async () => ({ dispose: async () => undefined }),
			},
			event: {
				subscribe: async function* ({ signal }: { signal: AbortSignal }) {
					while (!signal.aborted) {
						if (eventQueue.length === 0) {
							await new Promise<void>((resolve) => {
								const wake = () => { cleanup(); resolve() }
								const abort = () => { cleanup(); resolve() }
								const cleanup = () => {
									const index = eventWaiters.indexOf(wake)
									if (index >= 0) eventWaiters.splice(index, 1)
									signal.removeEventListener("abort", abort)
								}
								eventWaiters.push(wake)
								signal.addEventListener("abort", abort, { once: true })
							})
							if (signal.aborted) return
						}
						const next = eventQueue.shift()
						if (next !== undefined) yield next
					}
				},
			},
		})
		const config = unsafeTestValue<OhMyOpenCodeConfig>({
			team_mode: { enabled: true, base_dir: runtimeRoot, max_parallel_members: 1 },
		})
		const manager = createV2TeamManager(ctx, config)
		const toolEditor = unsafeTestValue<ToolEditor>({
			add: (tool: { name: string; execute: (input: unknown, context: unknown) => Promise<{ content?: string }> }) => tools.set(tool.name, tool),
			remove: () => undefined,
			get: () => undefined,
		})
		const waitUntil = async (predicate: () => boolean | Promise<boolean>, label: string) => {
			for (let attempt = 0; attempt < 200; attempt += 1) {
				if (await predicate()) return
				await new Promise((resolve) => setTimeout(resolve, 5))
			}
			throw new Error(`Timed out waiting for ${label}.`)
		}
		const status = async (teamRunId: string) => {
			const tool = tools.get("team_status")!
			const result = await tool.execute({ teamRunId }, { sessionID: leadID, signal: new AbortController().signal, id: "status" })
			const parsed = JSON.parse(result.content ?? "{}") as { runtimeState: { members: Array<{ name: string; status: string }> } }
			return parsed.runtimeState.members.find((member) => member.name === "worker")?.status
		}
		try {
			await manager.start({
				admission: { acquire: async (input: { mode: string }) => {
					if (input.mode === "resume") resumeAdmissions += 1
					return { beginCreate: async () => undefined, bind: async () => undefined, rollback: async () => true }
				} } as never,
				runs: { get: async () => undefined, recordLaunch: async () => undefined, children: async () => [] } as never,
			})
			manager.createTools(toolEditor)
			const create = tools.get("team_create")!
			const created = await create.execute({ inline_spec: {
				version: 1,
				name: "generation-team",
				leadAgentId: "lead",
				members: [
					{ kind: "subagent_type", name: "lead", subagent_type: "atlas" },
					{ kind: "subagent_type", name: "worker", subagent_type: "sisyphus" },
				],
			} }, { sessionID: leadID, signal: new AbortController().signal, id: "create" })
			const teamRunId = JSON.parse(created.content ?? "{}").teamRunId as string
			await waitUntil(() => initialPromptCount > 0, "initial member launch")
			expect(child.time.idle).toBeUndefined()
			publish("session.execution.started")
			await new Promise((resolve) => setTimeout(resolve, 10))
			idle.value = 101
			child.time.idle = idle.value
			publish("session.execution.succeeded")
			await waitUntil(async () => (await status(teamRunId)) === "idle", "first member completion")

			const send = tools.get("team_send_message")!
			await send.execute({ teamRunId, to: "worker", body: "Resume after the previous turn." }, {
				sessionID: leadID,
				signal: new AbortController().signal,
				id: "send-resume",
			})
			await waitUntil(() => syntheticAttempts === 1, "first synthetic attempt")
			await new Promise((resolve) => setTimeout(resolve, 50))
			expect(syntheticAttempts).toBe(1)
			rejectSynthetic = false
			await waitUntil(() => syntheticIDs.length === 1, "mailbox synthetic prompt")
			expect(syntheticIDs[0]).toStartWith("msg_")
			expect(resumeAdmissions).toBe(1)

			// The just-created child had no idle marker before its first prompt. Its
			// first real execution advanced from the native zero sentinel.
			expect(child.time.idle).toBe(101)

			// A delayed start/success pair from the previous native turn sees the
			// same durable idle marker and cannot release the resumed member slot.
			const readsBeforeStaleTerminal = childSessionReads
			const waitsBeforeStaleTerminal = sessionWaits
			publish("session.execution.started")
			publish("session.execution.succeeded")
			await waitUntil(() => sessionWaits > waitsBeforeStaleTerminal, "stale terminal wait reconciliation")
			await waitUntil(() => childSessionReads > readsBeforeStaleTerminal, "stale terminal idle lookup")
			await new Promise((resolve) => setTimeout(resolve, 20))
			expect(await status(teamRunId)).toBe("running")
			idle.value = 102
			child.time.idle = idle.value
			const readsBeforeResumeTerminal = childSessionReads
			const waitsBeforeResumeTerminal = sessionWaits
			publish("session.execution.started")
			publish("session.execution.succeeded")
			await waitUntil(() => sessionWaits > waitsBeforeResumeTerminal, "resumed terminal wait reconciliation")
			await waitUntil(() => childSessionReads > readsBeforeResumeTerminal, "resumed terminal idle lookup")
			await waitUntil(async () => (await status(teamRunId)) === "idle", "resumed execution completion")
			expect(await status(teamRunId)).toBe("idle")
		} finally {
			await manager.dispose()
			await rm(root, { recursive: true, force: true })
		}
	})
})

describe("native Team process-restart recovery", () => {
	test("an orphaned member keeps its slot, is resumed once, and the queued member launches after it settles", async () => {
		const root = await mkdtemp(join(tmpdir(), "omo-v2-team-restart-"))
		const projectDirectory = join(root, "project")
		await mkdir(projectDirectory)
		const runtimeRoot = join(root, "teams")
		const leadID = "ses-restart-lead"
		const sessions = new Map<string, { id: string; time: { created: number; updated: number; idle?: number }; outcome?: string; [key: string]: unknown }>()
		sessions.set(leadID, {
			id: leadID, projectID: "project-restart", agent: "atlas", model: { providerID: "host", id: "model" },
			location: { directory: projectDirectory }, parentID: undefined, time: { created: 1, updated: 1, idle: 100 }, outcome: "succeeded",
		})
		const prompts: Array<{ sessionID: string; text: string }> = []
		const eventQueue: unknown[] = []
		const eventWaiters: Array<() => void> = []
		let catalogReady = true
		let created = 0
		const publish = (type: string, sessionID: string) => {
			eventQueue.push({ type, data: { sessionID }, location: { directory: projectDirectory } })
			for (const wake of eventWaiters.splice(0)) wake()
		}
		const ctx = unsafeTestValue<Plugin.Context>({
			location: { directory: projectDirectory, project: { id: "project-restart", canonical: projectDirectory }, workspaceID: "workspace-restart" },
			storage: { get: async () => undefined, set: async () => undefined, remove: async () => undefined },
			agent: { list: async () => ({ data: [
				{ id: "atlas", mode: "primary", model: { providerID: "host", id: "model" } },
				{ id: "sisyphus", mode: "primary", model: { providerID: "host", id: "model" } },
			] }) },
			model: {
				list: async () => ({ data: catalogReady ? [{ providerID: "host", id: "model", enabled: true, variants: [] }] : [] }),
				default: async () => ({ data: catalogReady ? { providerID: "host", id: "model" } : undefined }),
			},
			session: {
				get: async ({ sessionID }: { sessionID: string }) => sessions.get(sessionID)!,
				create: async () => {
					created += 1
					const session = {
						id: `ses-restart-member-${created}`, projectID: "project-restart", agent: "sisyphus", model: { providerID: "host", id: "model" },
						location: { directory: projectDirectory }, parentID: undefined, time: { created: 1, updated: 1 }, outcome: undefined,
					}
					sessions.set(session.id, session)
					return session
				},
				prompt: async (input: { sessionID: string; text: string }) => { prompts.push({ sessionID: input.sessionID, text: input.text }) },
				synthetic: async () => undefined,
				wait: async () => undefined,
				interrupt: async () => undefined,
				hook: async () => ({ dispose: async () => undefined }),
			},
			event: {
				subscribe: async function* ({ signal }: { signal: AbortSignal }) {
					while (!signal.aborted) {
						if (eventQueue.length === 0) {
							await new Promise<void>((resolve) => {
								const done = () => { signal.removeEventListener("abort", done); resolve() }
								eventWaiters.push(done)
								signal.addEventListener("abort", done, { once: true })
							})
							if (signal.aborted) return
						}
						const next = eventQueue.shift()
						if (next !== undefined) yield next
					}
				},
			},
		})
		const config = unsafeTestValue<OhMyOpenCodeConfig>({ team_mode: { enabled: true, base_dir: runtimeRoot, max_parallel_members: 1 } })
		const tools = new Map<string, { execute: (input: unknown, context: unknown) => Promise<{ content?: string }> }>()
		const toolEditor = unsafeTestValue<ToolEditor>({
			add: (tool: { name: string; execute: (input: unknown, context: unknown) => Promise<{ content?: string }> }) => tools.set(tool.name, tool),
			remove: () => undefined,
			get: () => undefined,
		})
		const dependencies = {
			admission: { acquire: async () => ({ beginCreate: async () => undefined, bind: async () => undefined, rollback: async () => true }) } as never,
			runs: { get: async () => undefined, recordLaunch: async () => undefined, children: async () => [] } as never,
		}
		const waitUntil = async (predicate: () => boolean | Promise<boolean>, label: string, attempts = 400) => {
			for (let attempt = 0; attempt < attempts; attempt += 1) {
				if (await predicate()) return
				await new Promise((resolve) => setTimeout(resolve, 25))
			}
			throw new Error(`Timed out waiting for ${label}.`)
		}
		const statuses = async (teamRunId: string) => {
			const result = await tools.get("team_status")!.execute({ teamRunId }, { sessionID: leadID, signal: new AbortController().signal, id: "status" })
			const parsed = JSON.parse(result.content ?? "{}") as { runtimeState: { members: Array<{ name: string; status: string }> } }
			return Object.fromEntries(parsed.runtimeState.members.map((member) => [member.name, member.status]))
		}
		const first = createV2TeamManager(ctx, config)
		let second: ReturnType<typeof createV2TeamManager> | undefined
		try {
			await first.start(dependencies)
			first.createTools(toolEditor)
			const result = await tools.get("team_create")!.execute({ inline_spec: {
				version: 1, name: "restart-team", leadAgentId: "lead",
				members: [
					{ kind: "subagent_type", name: "lead", subagent_type: "atlas" },
					{ kind: "subagent_type", name: "alpha", subagent_type: "sisyphus" },
					{ kind: "subagent_type", name: "beta", subagent_type: "sisyphus" },
				],
			} }, { sessionID: leadID, signal: new AbortController().signal, id: "create" })
			const teamRunId = JSON.parse(result.content ?? "{}").teamRunId as string
			await waitUntil(() => prompts.length === 1, "alpha launch")
			const alphaID = prompts[0]!.sessionID
			publish("session.execution.started", alphaID)
			await waitUntil(async () => (await statuses(teamRunId)).alpha === "running", "alpha running")
			// The process dies mid-turn: alpha never reaches an outcome and beta is still queued.
			await first.dispose()

			catalogReady = false
			setTimeout(() => { catalogReady = true }, 300)
			second = createV2TeamManager(ctx, config)
			await second.start(dependencies)
			second.createTools(toolEditor)
			await new Promise((resolve) => setTimeout(resolve, 200))
			expect(await statuses(teamRunId)).toMatchObject({ alpha: "running", beta: "pending" })
			await waitUntil(() => prompts.some((prompt) => prompt.sessionID === alphaID && prompt.text.includes("The server restarted")), "orphan resume", 400)
			expect(prompts.filter((prompt) => prompt.text.includes("The server restarted"))).toHaveLength(1)
			expect(prompts.filter((prompt) => prompt.sessionID !== alphaID)).toHaveLength(0)

			publish("session.execution.started", alphaID)
			const alpha = sessions.get(alphaID)!
			alpha.time.idle = 200
			alpha.outcome = "succeeded"
			publish("session.execution.succeeded", alphaID)
			await waitUntil(() => prompts.some((prompt) => prompt.sessionID !== alphaID), "beta launch after alpha settles")
			expect(await statuses(teamRunId)).toMatchObject({ alpha: "idle", beta: "running" })
		} finally {
			await first.dispose()
			await second?.dispose()
			await rm(root, { recursive: true, force: true })
		}
	}, 30_000)
})
