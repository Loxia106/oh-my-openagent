import { afterEach, describe, expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin"
import type { CommandInvocation, CommandDefinition } from "@opencode/plugin/promise/command"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { OhMyOpenCodeConfig } from "../config"
import {
	createBoulderState,
	getBoulderFilePath,
	readBoulderState,
	writeBoulderState,
} from "../features/boulder-state"
import { BuiltinCommandNameSchema } from "../config/schema/commands"
import { getV2ContinuationState, getV2GoalController, registerV2LifecycleHooks } from "./lifecycle"
import { getV2TodoState } from "./task-state"
import { expandCommandTemplate, registerV2Commands } from "./commands"
import type { NativeCommandInvocation } from "./command-dispatch"
import { unsafeTestValue } from "../../../../test-support/unsafe-test-value"

const roots: string[] = []
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

type RegisteredCommand = Pick<CommandDefinition, "name" | "execute">

function createStorage() {
	const values = new Map<string, unknown>()
	return {
		values,
		get: async (key: string) => values.get(key),
		set: async (key: string, value: unknown) => { values.set(key, value) },
		remove: async (key: string) => { values.delete(key) },
	}
}

function deferred<T>() {
	let resolve!: (value: T) => void
	let reject!: (reason: unknown) => void
	const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail })
	return { promise, resolve, reject }
}

type TestModel = { providerID: string; id: string; variant?: string }

function createHost(
	directory: string,
	agentNames = ["atlas", "sisyphus"],
	history: unknown[] = [],
	initialAgent = "sisyphus",
	agentModels: Record<string, TestModel | undefined> = {},
	initialModel: TestModel = { providerID: "host", id: "current-model" },
) {
	const storage = createStorage()
	const commands = new Map<string, RegisteredCommand>()
	const promptCalls: unknown[] = []
	const syntheticCalls: unknown[] = []
	const switches: string[] = []
	const modelSwitches: unknown[] = []
	const sessionAgents = new Map<string, string>([["ses-current", initialAgent]])
	const sessionModels = new Map<string, TestModel>([["ses-current", initialModel]])
	let historyCalls = 0
	let registrationDisposed = false
	const ctx = unsafeTestValue<Plugin.Context>({
		location: { directory, project: { id: "command-test-project" } },
		storage,
		agent: {
			list: async () => ({ data: agentNames.map((id) => ({ id })) }),
			get: async ({ agentID }: { agentID: string }) => ({ data: { id: agentID, model: agentModels[agentID] } }),
		},
		session: {
			hook: async () => ({ dispose: async () => undefined }),
			get: async ({ sessionID }: { sessionID: string }) => ({
				agent: sessionAgents.get(sessionID) ?? "sisyphus",
				model: sessionModels.get(sessionID),
			}),
		switchAgent: async ({ sessionID, agent }: { sessionID: string; agent: string }) => {
				if (sessionID === "ses-current" && readBoulderState(directory)) {
					throw new Error("state was written before the native agent switch")
				}
				switches.push(agent)
				sessionAgents.set(sessionID, agent)
			},
			switchModel: async ({ sessionID, model }: { sessionID: string; model: TestModel }) => {
				if (sessionID === "ses-current" && readBoulderState(directory)) {
					throw new Error("state was written before the native model switch")
				}
				modelSwitches.push({ sessionID, model })
				sessionModels.set(sessionID, model)
			},
			context: async () => { historyCalls += 1; return history },
			prompt: async (input: unknown) => { promptCalls.push(input) },
			synthetic: async (input: unknown) => { syntheticCalls.push(input) },
		},
		command: {
			list: async () => ({ data: [] }),
			transform: async (callback: (editor: { add: (command: RegisteredCommand) => void }) => void) => {
				callback({ add: (command) => commands.set(command.name, command) })
				return { dispose: async () => { registrationDisposed = true } }
			},
		},
	})
	return { ctx, storage, commands, promptCalls, syntheticCalls, switches, modelSwitches, sessionModels, get historyCalls() { return historyCalls }, get registrationDisposed() { return registrationDisposed } }
}

function commandInput(text: string, sessionID = "ses-current", delivery: "queue" | "steer" = "queue"): NativeCommandInvocation {
	return unsafeTestValue<CommandInvocation>({
		sessionID,
		prompt: {
			text,
			files: [{ uri: "file:///tmp/request.md", name: "request.md" }],
			agents: [],
			skills: [],
		},
		delivery,
	})
}

async function createDirectory(prefix: string): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), prefix))
	roots.push(directory)
	return directory
}

async function register(host: ReturnType<typeof createHost>, config: OhMyOpenCodeConfig = {}) {
	// Builtin-command tests should not consult the real user's Claude directories.
	const testConfig = { ...config, claude_code: { ...config.claude_code, commands: false, plugins: false } }
	// Production initializes durable workflow state before registering commands.
	// These tests isolate command dispatch from event-driven continuations.
	const cleanupLifecycle = await registerV2LifecycleHooks(host.ctx, { disabled_hooks: [
		"stop-continuation-guard", "compaction-context-injector", "compaction-todo-preserver",
		"atlas", "goal", "todo-continuation-enforcer",
	] })
	const cleanupCommands = await registerV2Commands(host.ctx, testConfig)
	const cleanup = async () => {
		await cleanupCommands()
		await cleanupLifecycle()
	}
	return { cleanup, commands: host.commands }
}

describe("native OpenCode 2 builtin commands", () => {
	test("registers a Claude command through the shared loader and native command transform", async () => {
		const directory = await createDirectory("omo-v2-command-imported-")
		const claudeConfig = join(directory, "claude-config")
		const previousClaudeConfig = process.env.CLAUDE_CONFIG_DIR
		try {
			process.env.CLAUDE_CONFIG_DIR = claudeConfig
			await mkdir(join(claudeConfig, "commands"), { recursive: true })
			await mkdir(join(directory, ".claude", "commands"), { recursive: true })
			await writeFile(join(claudeConfig, "commands", "user-command.md"), "---\ndescription: User command\n---\nUser task: $ARGUMENTS")
			await writeFile(join(directory, ".claude", "commands", "project-command.md"), "---\ndescription: Project command\n---\nProject task: ${user_message}")
			const host = createHost(directory)
			const cleanup = await registerV2Commands(host.ctx, { claude_code: { commands: true, plugins: false } })

			expect(host.commands.has("user-command")).toBe(true)
			expect(host.commands.has("project-command")).toBe(true)
			await host.commands.get("user-command")!.execute(commandInput("release it"))
			await host.commands.get("project-command")!.execute(commandInput("verify it"))
			expect((host.promptCalls[0] as { text: string }).text).toContain("User task: release it")
			expect((host.promptCalls[1] as { text: string }).text).toContain("Project task: verify it")
			await cleanup()
		} finally {
			if (previousClaudeConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
			else process.env.CLAUDE_CONFIG_DIR = previousClaudeConfig
		}
	})

	test("registers /ulw-execute with native Atlas switch, recent-plan context, and session-scoped Boulder", async () => {
		const directory = await createDirectory("omo-v2-command-ulw-")
		const plans = join(directory, ".omo", "plans")
		await mkdir(plans, { recursive: true })
		const preferredPlan = join(plans, "preferred-flow.md")
		const otherPlan = join(plans, "other-flow.md")
		await writeFile(preferredPlan, "# Preferred Flow\n\n## Tasks\n- [ ] 1. Implement the native command\n")
		await writeFile(otherPlan, "# Other Flow\n\n## Tasks\n- [ ] 1. Unselected task\n")
		const atlasModel = { providerID: "allowed", id: "atlas-model", variant: "reasoning" }
		const host = createHost(directory, ["atlas", "sisyphus"], [
			{ type: "assistant", content: [{ type: "text", text: `Plan file: ${preferredPlan}` }] },
		], "sisyphus", { atlas: atlasModel })
		const { cleanup, commands } = await register(host)
		const ulw = commands.get("ulw-execute")
		expect(ulw).toBeDefined()
		const input = commandInput("")
		await Promise.all([ulw!.execute(input), ulw!.execute(input)])

		expect(host.switches).toEqual(["atlas"])
		expect(host.modelSwitches).toEqual([{ sessionID: "ses-current", model: atlasModel }])
		expect(host.sessionModels.get("ses-current")).toEqual(atlasModel)
		expect(host.historyCalls).toBe(1)
		expect(host.promptCalls).toHaveLength(1)
		const prompted = host.promptCalls[0] as { sessionID: string; text: string; delivery: string; files: unknown[] }
		expect(prompted.sessionID).toBe("ses-current")
		expect(prompted.delivery).toBe("queue")
		expect(prompted.files).toEqual(input.prompt.files)
		expect(prompted.text).toContain("You are starting an Atlas work session.")
		expect(prompted.text).toContain(CONTEXT_MARKER)
		expect(prompted.text).toContain("preferred-flow")
		expect(prompted.text).not.toContain("other-flow")
		expect(prompted.text).toContain("Most recently referenced plan in this session")
		const state = readBoulderState(directory)
		expect(state?.active_plan).toBe(preferredPlan)
		expect(state?.agent).toBe("atlas")
		expect(state?.session_ids).toContain("opencode:ses-current")
		expect(state?.session_ids).not.toContain("ses-current")
		expect(getBoulderFilePath(directory)).toContain(".omo/boulder.json")
		await cleanup()
		expect(host.registrationDisposed).toBe(true)
	})

	test("falls back to Sisyphus when Atlas is unavailable and reports when neither is registered", async () => {
		const directory = await createDirectory("omo-v2-command-agent-fallback-")
		const sisyphusModel = { providerID: "allowed", id: "sisyphus-model", variant: "fallback" }
		const sisyphus = createHost(directory, ["sisyphus"], [], "explore", { sisyphus: sisyphusModel })
		const sisyphusRegistration = await register(sisyphus)
		await sisyphus.commands.get("ulw-execute")!.execute(commandInput(""))
		expect(sisyphus.switches).toEqual(["sisyphus"])
		expect(sisyphus.modelSwitches).toEqual([{ sessionID: "ses-current", model: sisyphusModel }])
		expect(sisyphus.sessionModels.get("ses-current")).toEqual(sisyphusModel)
		expect((sisyphus.promptCalls[0] as { text: string }).text).toContain("You are starting a Sisyphus work session.")
		await sisyphusRegistration.cleanup()

		const empty = createHost(directory, ["prometheus"])
		const emptyRegistration = await register(empty)
		await empty.commands.get("ulw-execute")!.execute(commandInput(""))
		expect(empty.promptCalls).toEqual([])
		expect(empty.syntheticCalls).toHaveLength(1)
		expect((empty.syntheticCalls[0] as { text: string }).text).toContain("neither is registered")
		await emptyRegistration.cleanup()
	})

	test("disabled ulw-execute hook keeps command template and Atlas selection but skips context preparation", async () => {
		const directory = await createDirectory("omo-v2-command-ulw-hook-disabled-")
		const host = createHost(directory, ["atlas", "sisyphus"], [], "sisyphus")
		const { cleanup, commands } = await register(host, { disabled_hooks: ["ulw-execute"] })
		const input = commandInput("chosen-plan --make-pr")

		await commands.get("ulw-execute")!.execute(input)

		expect(host.switches).toEqual(["atlas"])
		expect(host.modelSwitches).toEqual([])
		expect(host.sessionModels.get(input.sessionID)).toEqual({ providerID: "host", id: "current-model" })
		expect(host.historyCalls).toBe(0)
		expect(host.promptCalls).toHaveLength(1)
		expect(host.syntheticCalls).toEqual([])
		const prompt = host.promptCalls[0] as { sessionID: string; text: string }
		expect(prompt.sessionID).toBe(input.sessionID)
		expect(prompt.text).toContain("Find available plans")
		expect(prompt.text).toContain("chosen-plan --make-pr")
		expect(prompt.text).toContain(`Session ID: ${input.sessionID}`)
		expect(prompt.text).not.toContain(CONTEXT_MARKER)
		expect(readBoulderState(directory)).toBeNull()
		await cleanup()
	})

	test("aborts /ulw-execute before Boulder, history, or prompt when Atlas model selection fails", async () => {
		const directory = await createDirectory("omo-v2-command-ulw-model-failure-")
		const atlasModel = { providerID: "allowed", id: "atlas-model", variant: "reasoning" }
		const host = createHost(directory, ["atlas", "sisyphus"], [], "sisyphus", { atlas: atlasModel })
		const raw = host.ctx as unknown as { session: { switchModel: (input: unknown) => Promise<void> } }
		raw.session.switchModel = async () => { throw new Error("Atlas model selection failed") }
		const { cleanup, commands } = await register(host)

		await expect(commands.get("ulw-execute")!.execute(commandInput(""))).rejects.toThrow("Atlas model selection failed")

		// Native selection is sequential (agent, then model); the model failure stops all command-side work.
		expect(host.switches).toEqual(["atlas"])
		expect(host.historyCalls).toBe(0)
		expect(host.promptCalls).toEqual([])
		expect(readBoulderState(directory)).toBeNull()
		await cleanup()
	})

	test("/goal resume emits one prompt, preserves budget, and carries prompt attachments", async () => {
		const directory = await createDirectory("omo-v2-command-goal-resume-")
		const host = createHost(directory)
		const { cleanup, commands } = await register(host, { goal: { enabled: true, auto_start: false, default_max_iterations: 100 } })
		const controller = getV2GoalController(host.ctx)
		const goal = controller.setGoal("ses-current", "Finish the native command tests")
		controller.accountUsage("ses-current", { input: 23, output: 12, cacheRead: 0, cacheWrite: 0, totalTokens: 35 }, 41)
		controller.pauseGoal("ses-current")
		const continuation = getV2ContinuationState(host.ctx)
		continuation.stop("ses-current")
		continuation.markPending("ses-current")
		const input = commandInput("resume", "ses-current", "steer")

		await commands.get("goal")!.execute(input)

		const resumed = controller.getGoal("ses-current")!
		expect(resumed.id).toBe(goal.id)
		expect(resumed.status).toBe("active")
		expect(resumed.tokensUsed).toBe(35)
		expect(resumed.timeUsedSeconds).toBe(41)
		expect(continuation.isStopped("ses-current")).toBe(false)
		expect(continuation.pending.has("ses-current")).toBe(false)
		expect(host.promptCalls).toHaveLength(1)
		expect(host.syntheticCalls).toEqual([])
		expect(host.promptCalls[0]).toMatchObject({
			sessionID: "ses-current",
			text: expect.stringContaining("do not replace it or reset its usage budget"),
			delivery: "steer",
			files: input.prompt.files,
		})
		await cleanup()
	})

	test("/goal objective stores the goal and starts exactly one native prompt", async () => {
		const directory = await createDirectory("omo-v2-command-goal-objective-")
		const host = createHost(directory)
		const { cleanup, commands } = await register(host, { goal: { enabled: true, auto_start: false, default_max_iterations: 100 } })
		const input = commandInput("Complete the release acceptance checklist", "ses-current", "steer")

		await commands.get("goal")!.execute(input)

		expect(getV2GoalController(host.ctx).getGoal("ses-current")?.objective).toBe("Complete the release acceptance checklist")
		expect(getV2ContinuationState(host.ctx).isStopped("ses-current")).toBe(false)
		expect(host.promptCalls).toHaveLength(1)
		expect(host.syntheticCalls).toEqual([])
		const goalPrompt = host.promptCalls[0] as { text: string; sessionID: string; delivery: string; files: unknown[] }
		expect(goalPrompt.sessionID).toBe("ses-current")
		expect(goalPrompt.delivery).toBe("steer")
		expect(goalPrompt.files).toEqual(input.prompt.files)
		expect(goalPrompt.text.includes("Complete the release acceptance checklist")).toBe(true)
		expect(goalPrompt.text.includes("The goal has already been saved")).toBe(true)
		expect(goalPrompt.text.includes("Parse the arguments below and set the goal")).toBe(false)
		await cleanup()
	})

	test("/goal show, pause, and clear are synthetic-only actions scoped to the current session", async () => {
		const directory = await createDirectory("omo-v2-command-goal-actions-")
		const host = createHost(directory)
		const { cleanup, commands } = await register(host, { goal: { enabled: true, auto_start: false, default_max_iterations: 100 } })
		const controller = getV2GoalController(host.ctx)
		controller.setGoal("ses-current", "Current session objective")
		controller.setGoal("ses-other", "Other session objective")
		await commands.get("goal")!.execute(commandInput(""))
		await commands.get("goal")!.execute(commandInput("pause"))
		await commands.get("goal")!.execute(commandInput("clear"))

		expect(host.promptCalls).toEqual([])
		expect(host.syntheticCalls).toHaveLength(3)
		expect(host.syntheticCalls.every((call) => (call as { resume: boolean }).resume === false)).toBe(true)
		expect((host.syntheticCalls[0] as { text: string }).text).toContain("Current session objective")
		expect(controller.getGoal("ses-current")).toBeNull()
		expect(controller.getGoal("ses-other")?.objective).toBe("Other session objective")
		await cleanup()
	})

	test("/stop-continuation stops only this session and preserves goals, todos, and shared Boulder elsewhere", async () => {
		const directory = await createDirectory("omo-v2-command-stop-")
		const planPath = join(directory, ".omo", "plans", "shared.md")
		await mkdir(join(directory, ".omo", "plans"), { recursive: true })
		await writeFile(planPath, "# Shared\n\n- [ ] Work\n")
		const host = createHost(directory)
		const { cleanup, commands } = await register(host, { goal: { enabled: true, auto_start: false, default_max_iterations: 100 } })
		const controller = getV2GoalController(host.ctx)
		controller.setGoal("ses-current", "Stop this goal")
		controller.setGoal("ses-other", "Keep the other goal")
		const continuation = getV2ContinuationState(host.ctx)
		continuation.markPending("ses-current")
		continuation.markPending("ses-other")
		const todos = getV2TodoState(host.ctx.storage)
		await todos.write("ses-current", [{ id: "current", content: "current todo", status: "pending" }])
		await todos.write("ses-other", [{ id: "other", content: "other todo", status: "in_progress" }])
		writeBoulderState(directory, createBoulderState(planPath, "ses-other", "atlas"))
		const boulderBefore = readBoulderState(directory)

		await commands.get("stop-continuation")!.execute(commandInput(""))

		expect(continuation.isStopped("ses-current")).toBe(true)
		expect(continuation.pending.has("ses-current")).toBe(false)
		expect(continuation.isStopped("ses-other")).toBe(false)
		expect(continuation.pending.has("ses-other")).toBe(true)
		expect(controller.getGoal("ses-current")).toBeNull()
		expect(controller.getGoal("ses-other")?.objective).toBe("Keep the other goal")
		expect(await todos.read("ses-current")).toEqual([{ id: "current", content: "current todo", status: "pending" }])
		expect(await todos.read("ses-other")).toEqual([{ id: "other", content: "other todo", status: "in_progress" }])
		expect(readBoulderState(directory)).toEqual(boulderBefore)
		expect(host.promptCalls).toEqual([])
		expect(host.syntheticCalls).toHaveLength(1)
		expect((host.syntheticCalls[0] as { resume: boolean }).resume).toBe(false)
		expect(host.syntheticCalls[0]).toMatchObject({ sessionID: "ses-current" })
		expect(getBoulderFilePath(directory)).toContain("boulder.json")
		await cleanup()
	})

	test("stop reports success only after its durable transition is stored and propagates write failure", async () => {
		const directory = await createDirectory("omo-v2-command-durable-stop-")
		const host = createHost(directory)
		const { cleanup, commands } = await register(host)
		const entered = deferred<void>()
		const persisted = deferred<void>()
		const originalSet = host.storage.set
		host.storage.set = async (key, value) => {
			entered.resolve()
			await persisted.promise
			await originalSet(key, value)
		}
		const invocation = commands.get("stop-continuation")!.execute(commandInput(""))
		await entered.promise
		expect(getV2ContinuationState(host.ctx).isStopped("ses-current")).toBe(true)
		expect(host.syntheticCalls).toHaveLength(0)
		persisted.resolve()
		await invocation
		expect(host.syntheticCalls).toHaveLength(1)
		host.storage.set = async () => { throw new Error("storage write unavailable") }
		await expect(commands.get("stop-continuation")!.execute(commandInput("again"))).rejects.toThrow("storage write unavailable")
		expect(host.syntheticCalls).toHaveLength(1)
		await cleanup()
	})

	test("honors goal.enabled and disabled_commands, and reports /hyperplan unavailable", async () => {
		const directory = await createDirectory("omo-v2-command-gates-")
		const host = createHost(directory)
		const { cleanup, commands } = await register(host, {
			goal: { enabled: false, auto_start: false, default_max_iterations: 100 },
			disabled_commands: ["refactor"],
		})
		expect(commands.has("refactor")).toBe(false)
		await commands.get("goal")!.execute(commandInput("Build this goal"))
		await commands.get("hyperplan")!.execute(commandInput("Plan the release"))
		expect(host.promptCalls).toEqual([])
		expect(host.syntheticCalls).toHaveLength(2)
		expect((host.syntheticCalls[0] as { text: string }).text).toContain("goal.enabled: true")
		expect((host.syntheticCalls[1] as { text: string }).text).toContain("team_mode.enabled: true")
		expect(getV2GoalController(host.ctx).getGoal("ses-current")).toBeNull()
		expect(BuiltinCommandNameSchema.parse("handoff")).toBe("handoff")
		await cleanup()
	})

	test("dispatches Hyperplan with native Team enabled and keeps request arguments literal", async () => {
		const directory = await createDirectory("omo-v2-command-hyperplan-")
		const host = createHost(directory)
		const { cleanup, commands } = await register(host, { team_mode: { enabled: true } } as OhMyOpenCodeConfig)
		const request = "Plan the release $SESSION_ID"
		await commands.get("hyperplan")!.execute(commandInput(request))
		expect(host.syntheticCalls).toEqual([])
		expect(host.promptCalls).toHaveLength(1)
		const text = (host.promptCalls[0] as { text: string }).text
		expect(text).toContain('skill(name="hyperplan")')
		expect(text).toContain(request)
		expect(text).toContain("team_create")
		await cleanup()
	})

	test("expands placeholders safely, appends arguments when absent, and preserves native payloads", async () => {
		const directory = await createDirectory("omo-v2-command-template-")
		const host = createHost(directory)
		const { cleanup, commands } = await register(host)
		const literalArguments = "Continue the release notes $SESSION_ID $TIMESTAMP $ARGUMENTS $& $` $'"
		const input = commandInput(literalArguments, "ses-native", "steer")
		await commands.get("handoff")!.execute(input)
		const prompt = host.promptCalls[0] as { text: string; sessionID: string; delivery: string; files: unknown[] }
		expect(prompt.sessionID).toBe("ses-native")
		expect(prompt.delivery).toBe("steer")
		expect(prompt.files).toEqual(input.prompt.files)
		expect(prompt.text).toContain('session_read({ session_id: "ses-native" })')
		expect(prompt.text).toContain(literalArguments)
		expect(prompt.text).not.toContain("opencode:ses-native")

		const noPlaceholderInput = commandInput("src/app.ts --scope=module", "ses-native")
		const appended = expandCommandTemplate("## Fixed command", noPlaceholderInput, "2030-01-02T03:04:05.000Z")
		expect(appended.endsWith("\n\nsrc/app.ts --scope=module")).toBe(true)
		await cleanup()
	})

	test("cleanup prevents pending native preparation from mutating Boulder state or submitting prompts", async () => {
		const cases = ["agent.list", "session.get", "session.context"] as const
		for (const pendingAt of cases) {
			const directory = await createDirectory(`omo-v2-command-cleanup-${pendingAt.replaceAll(".", "-")}-`)
			const host = createHost(directory)
			const pending = deferred<unknown>()
			const raw = host.ctx as unknown as {
				agent: { list: () => Promise<unknown> }
				session: {
					get: () => Promise<unknown>
					context: () => Promise<unknown>
				}
			}
			if (pendingAt === "agent.list") raw.agent.list = () => pending.promise
			if (pendingAt === "session.get") raw.session.get = () => pending.promise
			if (pendingAt === "session.context") raw.session.context = async () => {
				await pending.promise
				return []
			}
			const { cleanup, commands } = await register(host)
			const execute = commands.get("ulw-execute")!.execute(commandInput(""))
			await new Promise((resolve) => setTimeout(resolve, 0))
			await cleanup()
			pending.resolve(pendingAt === "agent.list" ? { data: [{ id: "atlas" }] } : pendingAt === "session.get" ? { agent: "sisyphus" } : undefined)
			await expect(execute).rejects.toThrow("disposed")
			expect(host.promptCalls).toEqual([])
			expect(readBoulderState(directory)).toBeNull()
		}
	})
})

const CONTEXT_MARKER = "<!-- omo-ulw-execute-context -->"
