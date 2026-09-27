import { describe, expect, test } from "bun:test"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Plugin } from "@opencode/plugin"
import type { CommandDefinition as NativeCommandDefinition, CommandInvocation } from "@opencode/plugin/promise/command"
import type { OhMyOpenCodeConfig } from "../config"
import type { CommandDefinition } from "../features/claude-code-command-loader"
import type { LoadedPlugin, PluginLoaderOptions } from "@oh-my-opencode/claude-code-compat-core/claude-code-plugin-loader"
import { unsafeTestValue } from "../../../../test-support/unsafe-test-value"
import type { NativeCommandInvocation } from "./command-dispatch"
import {
	expandV2CustomCommandTemplate,
	loadV2CustomCommandDefinitions,
	registerV2CustomCommands,
	type V2CustomCommandLoaders,
} from "./custom-commands"

function definition(template: string, overrides: Partial<CommandDefinition> = {}): CommandDefinition {
	return { template, ...overrides }
}

function loaders(overrides: Partial<V2CustomCommandLoaders> = {}): V2CustomCommandLoaders {
	return {
		loadUserCommands: async () => ({}),
		loadProjectCommands: async () => ({}),
		discoverInstalledPlugins: (_options: PluginLoaderOptions) => ({ plugins: [], errors: [] }),
		loadPluginCommands: (_plugins: LoadedPlugin[]) => ({}),
		loadSkills: async () => [],
		...overrides,
	}
}

function commandInput(text: string, sessionID = "ses-custom", delivery: "queue" | "steer" = "steer"): NativeCommandInvocation {
	return unsafeTestValue<CommandInvocation>({
		sessionID,
		prompt: {
			text,
			files: [{ uri: "file:///tmp/attachment.md", name: "attachment.md" }],
			agents: ["atlas"],
			skills: ["release-check"],
		},
		delivery,
	})
}

type RegisteredCommand = NativeCommandDefinition

function createHost(input: {
	directory?: string
	nativeNames?: string[]
	agents?: Array<{ id: string; mode?: string; model?: { providerID: string; id: string } }>
	models?: Array<{ providerID: string; id: string; enabled?: boolean; variants?: Array<{ id: string }> }>
	subagentResult?: { output?: unknown }
} = {}) {
	const commands = new Map<string, RegisteredCommand>()
	const sessionHooks = new Map<string, (value: any) => unknown>()
	const eventQueue: unknown[] = []
	let wakeEvents: (() => void) | undefined
	const commandCalls: unknown[] = []
	const subagentCalls: Array<{ input: unknown; context: unknown }> = []
	const promptCalls: unknown[] = []
	const syntheticCalls: unknown[] = []
	const agentSwitches: unknown[] = []
	const modelSwitches: unknown[] = []
	const sessionGets: unknown[] = []
	let registrationDisposed = 0
	const agentList = input.agents ?? [{ id: "atlas", mode: "primary", model: { providerID: "host", id: "atlas-model" } }]
	const modelList = input.models ?? [
		{ providerID: "host", id: "atlas-model", enabled: true, variants: [] },
		{ providerID: "configured", id: "custom-model", enabled: true, variants: [{ id: "high" }] },
	]
	const ctx = unsafeTestValue<Plugin.Context>({
		location: { directory: input.directory ?? "/tmp/custom-command-project" },
		agent: {
			get: async ({ agentID }: { agentID: string }) => {
				const agent = agentList.find((candidate) => candidate.id === agentID)
				if (!agent) throw new Error(`Unknown agent: ${agentID}`)
				return { data: agent }
			},
		},
		model: {
			list: async () => ({ data: modelList }),
		},
		session: {
			get: async ({ sessionID }: { sessionID: string }) => {
				sessionGets.push(sessionID)
				return { agent: "sisyphus", model: { providerID: "host", id: "current-model" }, location: { directory: input.directory ?? "/tmp/custom-command-project" } }
			},
			hook: async (name: string, callback: (value: any) => unknown) => {
				sessionHooks.set(name, callback)
				return { dispose: async () => { sessionHooks.delete(name) } }
			},
			switchAgent: async (value: unknown) => { agentSwitches.push(value) },
			switchModel: async (value: unknown) => { modelSwitches.push(value) },
			prompt: async (value: unknown) => { promptCalls.push(value) },
			synthetic: async (value: unknown) => { syntheticCalls.push(value) },
			command: async (value: unknown) => { commandCalls.push(value) },
		},
		event: {
			subscribe: ({ signal }: { signal: AbortSignal }) => (async function* () {
				while (!signal.aborted) {
					const next = eventQueue.shift()
					if (next) { yield next as never; continue }
					await new Promise<void>((resolve) => { wakeEvents = resolve; signal.addEventListener("abort", () => resolve(), { once: true }) })
				}
			})(),
		},
		tool: {
			list: async () => [{ id: "subagent", execute: async (value: unknown, context: unknown) => {
				subagentCalls.push({ input: value, context })
				return input.subagentResult ?? { output: { sessionID: "ses-subtask-child", status: "running", output: "background" } }
			} }],
		},
		command: {
			list: async () => ({ data: (input.nativeNames ?? []).map((name) => ({ name, description: "host command" })) }),
			transform: async (callback: (editor: { add: (command: RegisteredCommand) => void }) => void) => {
				callback({ add: (command) => commands.set(command.name, command) })
				return { dispose: async () => { registrationDisposed += 1 } }
			},
		},
	})
	return {
		ctx, commands, promptCalls, syntheticCalls, agentSwitches, modelSwitches, sessionGets, sessionHooks, subagentCalls, commandCalls,
		emit(event: unknown) { eventQueue.push(event); wakeEvents?.() },
		get registrationDisposed() { return registrationDisposed },
	}
}

async function register(
	host: ReturnType<typeof createHost>,
	definitions: Record<string, CommandDefinition>,
	config: OhMyOpenCodeConfig = {},
) {
	const cleanup = await registerV2CustomCommands(host.ctx, config, loaders({
		loadUserCommands: async () => definitions,
		loadProjectCommands: async () => ({}),
		discoverInstalledPlugins: () => ({ plugins: [], errors: [] }),
		loadPluginCommands: () => ({}),
	}))
	return { cleanup, commands: host.commands }
}

describe("native OpenCode 2 custom commands", () => {
	test("merges user, project, and plugin definitions in explicit precedence order", async () => {
		const calls: string[] = []
		const plugin = unsafeTestValue<LoadedPlugin>({ name: "release", installPath: "/plugins/release" })
		const result = await loadV2CustomCommandDefinitions({}, "/project", loaders({
			loadUserCommands: async () => { calls.push("user"); return { duplicate: definition("user"), userOnly: definition("user-only") } },
			loadProjectCommands: async (directory) => { calls.push(`project:${directory}`); return { duplicate: definition("project"), projectOnly: definition("project-only") } },
			discoverInstalledPlugins: (options) => {
				calls.push(`plugins:${options.projectDirectory}:${options.enabledPluginsOverride?.release}`)
				return { plugins: [plugin], errors: [] }
			},
			loadPluginCommands: (plugins) => {
				expect(plugins).toEqual([plugin])
				return { duplicate: definition("plugin"), pluginOnly: definition("plugin-only") }
			},
		}),
		)

		expect(result.duplicate.template).toBe("plugin")
		expect(Object.keys(result)).toEqual(["duplicate", "userOnly", "projectOnly", "pluginOnly"])
		expect(calls).toEqual(["user", "project:/project", "plugins:/project:undefined"])
	})

	test("commands and plugin gates are independent, and forwards plugin overrides", async () => {
		const calls: string[] = []
		const deps = loaders({
			loadUserCommands: async () => { calls.push("user"); return { user: definition("user") } },
			loadProjectCommands: async () => { calls.push("project"); return { project: definition("project") } },
			discoverInstalledPlugins: (options) => {
				calls.push(`plugins:${options.projectDirectory}:${options.enabledPluginsOverride?.["release@market"]}`)
				return { plugins: [], errors: [] }
			},
		})
		const pluginOnly = await loadV2CustomCommandDefinitions({ claude_code: { commands: false, plugins_override: { "release@market": false } } }, "/project", deps)
		expect(pluginOnly).toEqual({})
		expect(calls).toEqual(["plugins:/project:false"])

		calls.length = 0
		const claudeOnly = await loadV2CustomCommandDefinitions({ claude_code: { plugins: false } }, "/project", deps)
		expect(Object.keys(claudeOnly)).toEqual(["user", "project"])
		expect(calls).toEqual(["user", "project"])
	})

	test("uses the native context project directory for Claude plugin scope filtering", async () => {
		const host = createHost({ directory: "/workspace/native-project" })
		let observedProjectDirectory: string | undefined
		const cleanup = await registerV2CustomCommands(host.ctx, {}, loaders({
			discoverInstalledPlugins: (options) => {
				observedProjectDirectory = options.projectDirectory
				return { plugins: [], errors: [] }
			},
		}))

		expect(observedProjectDirectory).toBe("/workspace/native-project")
		await cleanup()
	})

	test("expands native positional and OMO placeholders literally without losing native fallback argument behavior", () => {
		const input = commandInput('"two words" three four $& $` $$ $1 $ARGUMENTS')
		expect(expandV2CustomCommandTemplate("first=$1 rest=$2", input, "2030-01-02T03:04:05.000Z"))
			.toBe("first=two words rest=three four $& $` $$ $1 $ARGUMENTS")
		expect(expandV2CustomCommandTemplate("$1/$3", commandInput("one two three four"), "now"))
			.toBe("one/three four")
		expect(expandV2CustomCommandTemplate("$ARGUMENTS|${user_message}|$SESSION_ID|$TIMESTAMP", input, "then"))
			.toBe(`${input.prompt.text}|${input.prompt.text}|ses-custom|then`)
		const literalTemplateArguments = "$1 $ARGUMENTS ${user_message} $SESSION_ID"
		expect(expandV2CustomCommandTemplate("$ARGUMENTS", commandInput(literalTemplateArguments), "then"))
			.toBe(literalTemplateArguments)
		expect(expandV2CustomCommandTemplate("Use session $SESSION_ID", commandInput("extra words"), "then"))
			.toBe("Use session ses-custom\n\nextra words")
		expect(expandV2CustomCommandTemplate("Run $9", commandInput("one two"), "then")).toBe("Run")
	})

	test("skips host command conflicts case-insensitively and reserves every OMO builtin name", async () => {
		const host = createHost({ nativeNames: ["Existing"] })
		const { cleanup, commands } = await register(host, {
			existing: definition("must not replace host"),
			goal: definition("must not replace builtin"),
			allowed: definition("safe command"),
		})

		expect([...commands.keys()]).toEqual(["allowed"])
		await cleanup()
		expect(host.registrationDisposed).toBe(1)
	})

	test("executes once through the native prompt with validated agent/model and all attachments intact", async () => {
		const host = createHost()
		const { cleanup, commands } = await register(host, {
			deploy: definition("Ship $ARGUMENTS for $SESSION_ID", { agent: "Atlas - Plan Executor", model: "configured/custom-model#high" }),
		})
		const input = commandInput("the release")
		await Promise.all([commands.get("deploy")!.execute(input), commands.get("deploy")!.execute(input)])

		expect(host.agentSwitches).toEqual([{ sessionID: "ses-custom", agent: "atlas" }])
		expect(host.modelSwitches).toEqual([
			{ sessionID: "ses-custom", model: { providerID: "host", id: "atlas-model" } },
			{ sessionID: "ses-custom", model: { providerID: "configured", id: "custom-model", variant: "high" } },
		])
		expect(host.promptCalls).toHaveLength(1)
		expect(host.promptCalls[0]).toMatchObject({
			sessionID: input.sessionID,
			text: "Ship the release for ses-custom",
			delivery: input.delivery,
			files: input.prompt.files,
			agents: input.prompt.agents,
			skills: input.prompt.skills,
		})
		expect(host.syntheticCalls).toEqual([])
		await cleanup()
		await cleanup()
		await expect(commands.get("deploy")!.execute(input)).rejects.toThrow("disposed")
		expect(host.registrationDisposed).toBe(1)
	})

	test("evaluates shell interpolation in the template, zero-based $ARGUMENTS[N], and runs subtask commands through the native subagent executor", async () => {
		const directory = await mkdtemp(join(tmpdir(), "omo-v2-command-shell-"))
		await writeFile(join(directory, "note.md"), "NOTE_CONTENT")
		const host = createHost({ directory, agents: [{ id: "explore", mode: "subagent" }, { id: "atlas", mode: "primary" }] })
		const { commands, cleanup } = await register(host, {
			shell: definition("Status: !`printf SHELL_OUTPUT` ref @note.md first=$ARGUMENTS[0] second=$ARGUMENTS[1]"),
			subtask: definition("Investigate $ARGUMENTS", { subtask: true, agent: "explore", description: "(user) Explore it" }),
			primarySubtask: definition("x", { subtask: true, agent: "atlas" }),
		})
		await commands.get("shell")!.execute(commandInput("alpha beta"))
		expect((host.promptCalls[0] as { text: string }).text).toBe("Status: SHELL_OUTPUT ref NOTE_CONTENT first=alpha second=beta")
		await commands.get("shell")!.execute(commandInput("!`printf INJECTED`"))
		expect((host.promptCalls[1] as { text: string }).text).toContain("first=!`printf")
		expect((host.promptCalls[1] as { text: string }).text).toContain("second=INJECTED`")
		expect((host.promptCalls[1] as { text: string }).text).not.toContain("first=INJECTED")

		await commands.get("subtask")!.execute(commandInput("the parser"))
		expect(host.subagentCalls).toHaveLength(1)
		expect(host.subagentCalls[0]!.input).toEqual({ agent: "explore", description: "Explore it", prompt: "Investigate the parser", background: true })
		expect((host.subagentCalls[0]!.context as { sessionID: string }).sessionID).toBe("ses-custom")
		expect(host.promptCalls).toHaveLength(2)
		expect(JSON.stringify(host.syntheticCalls.at(-1))).toContain("task_id: ses-subtask-child")

		await commands.get("primarySubtask")!.execute(commandInput(""))
		expect(host.subagentCalls).toHaveLength(1)
		expect(JSON.stringify(host.syntheticCalls.at(-1))).toContain("primary-only")
		await cleanup()
	})

	test("free-text slash prompts expand imported commands and skills once, honoring disabled_hooks", async () => {
		const host = createHost()
		const skill = { name: "release-notes", definition: { template: "Write notes for $ARGUMENTS", description: "notes" }, scope: "user", lazyContent: { loaded: true, content: "Write notes for $ARGUMENTS", load: async () => "" } }
		const cleanup = await registerV2CustomCommands(host.ctx, {}, loaders({
			loadUserCommands: async () => ({ review: definition("Review carefully: $ARGUMENTS") }),
			loadSkills: async () => [skill as never],
		}))
		const prompt = host.sessionHooks.get("prompt")!
		const skillPrompt = { sessionID: "ses-custom", prompt: { text: "/release-notes v2.0" }, delivery: "steer" }
		await prompt(skillPrompt)
		expect(skillPrompt.prompt.text).toContain("<auto-slash-command>")
		expect(skillPrompt.prompt.text).toContain("Write notes for v2.0")
		const again = skillPrompt.prompt.text
		await prompt(skillPrompt)
		expect(skillPrompt.prompt.text).toBe(again)
		const commandPrompt = { sessionID: "ses-custom", prompt: { text: "/review the diff" }, delivery: "steer" }
		await prompt(commandPrompt)
		expect(commandPrompt.prompt.text).toContain("Review carefully: the diff")
		const unknown = { sessionID: "ses-custom", prompt: { text: "/unknown thing" }, delivery: "steer" }
		await prompt(unknown)
		expect(unknown.prompt.text).toBe("/unknown thing")
		await cleanup()

		const disabled = createHost()
		const cleanupDisabled = await registerV2CustomCommands(disabled.ctx, { disabled_hooks: ["auto-slash-command"] } as OhMyOpenCodeConfig, loaders({
			loadUserCommands: async () => ({ review: definition("x") }),
			loadSkills: async () => [skill as never],
		}))
		expect(disabled.sessionHooks.has("prompt")).toBe(false)
		await cleanupDisabled()
	})

	test("rejects unavailable agent or model before changing the selected session", async () => {
		const host = createHost({
			agents: [{ id: "atlas", mode: "primary" }],
			models: [
				{ providerID: "missing", id: "model", enabled: false, variants: [{ id: "high" }] },
				{ providerID: "configured", id: "custom-model", enabled: true, variants: [{ id: "high" }] },
			],
		})
		const { cleanup, commands } = await register(host, {
			missingAgent: definition("Run", { agent: "missing" }),
			missingModel: definition("Run", { agent: "atlas", model: "missing/model#high" }),
			missingVariant: definition("Run", { model: "configured/custom-model#unlisted" }),
			malformedModel: definition("Run", { model: "model-without-provider" }),
			malformedRepeatedVariant: definition("Run", { model: "configured/custom-model#high#other" }),
		})
		for (const name of ["missingAgent", "missingModel", "missingVariant", "malformedModel", "malformedRepeatedVariant"]) {
			await commands.get(name)!.execute(commandInput("work"))
		}
		expect(host.syntheticCalls).toHaveLength(5)
		expect(host.syntheticCalls.map((call) => (call as { text: string }).text).join("\n")).toContain("not registered")
		expect(host.syntheticCalls.map((call) => (call as { text: string }).text).join("\n")).toContain("not enabled or available")
		expect(host.syntheticCalls.map((call) => (call as { text: string }).text).join("\n")).toContain("available variants: high")
		expect(host.syntheticCalls.map((call) => (call as { text: string }).text).join("\n")).toContain("provider/model form")
		expect(host.syntheticCalls.map((call) => (call as { text: string }).text).join("\n"))
			.toContain("/malformedRepeatedVariant cannot run safely: configured model \"configured/custom-model#high#other\" must use provider/model form.")
		expect(host.agentSwitches).toEqual([])
		expect(host.modelSwitches).toEqual([])
		expect(host.promptCalls).toEqual([])
		expect(host.sessionGets).toEqual([])
		await cleanup()
	})

	test("honors explicit subtask:false for a subagent-mode agent", async () => {
		const host = createHost({ agents: [{ id: "explore", mode: "subagent" }] })
		const { cleanup, commands } = await register(host, {
			run: definition("Inspect $ARGUMENTS", { agent: "explore", subtask: false }),
		})
		await commands.get("run")!.execute(commandInput("the tree"))
		expect(host.syntheticCalls).toEqual([])
		expect(host.agentSwitches).toEqual([{ sessionID: "ses-custom", agent: "explore" }])
		expect(host.promptCalls).toHaveLength(1)
		await cleanup()
	})

	test("command handoffs are suggested after a successful turn and a send:true command is dispatched once", async () => {
		const host = createHost({ nativeNames: ["speckit.tasks"] })
		const { commands, cleanup } = await register(host, {
			plan: definition("Plan $ARGUMENTS", { handoffs: [
				{ label: "Create tasks", agent: "speckit.tasks", prompt: "Break the plan into tasks", send: true },
				{ label: "Review", agent: "oracle", prompt: "Review the plan" },
			] }),
		})
		await commands.get("plan")!.execute(commandInput("the feature"))
		host.emit({ type: "session.execution.succeeded", created: Date.now() + 5, data: { sessionID: "ses-custom" } })
		await new Promise((resolve) => setTimeout(resolve, 40))
		expect(JSON.stringify(host.syntheticCalls)).toContain("suggested handoffs")
		expect(host.commandCalls).toEqual([{ sessionID: "ses-custom", name: "speckit.tasks", text: "Break the plan into tasks", delivery: "queue" }])
		host.emit({ type: "session.execution.succeeded", created: Date.now() + 10, data: { sessionID: "ses-custom" } })
		await new Promise((resolve) => setTimeout(resolve, 30))
		expect(host.commandCalls).toHaveLength(1)
		await cleanup()
	})
})

