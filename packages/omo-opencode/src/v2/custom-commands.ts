import { exec } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { Model, type Plugin } from "@opencode/plugin"
import type { SessionPrompt } from "@opencode/plugin/promise/session"
import type { ToolContext } from "@opencode/plugin/promise/tool"
import { findEmbeddedCommands } from "@oh-my-opencode/utils/command-executor/embedded-commands"
import { AUTO_SLASH_COMMAND_TAG_CLOSE, AUTO_SLASH_COMMAND_TAG_OPEN } from "@oh-my-opencode/skills-loader-core/auto-slash-command/constants"
import { detectSlashCommand } from "@oh-my-opencode/skills-loader-core/auto-slash-command/detector"
import type { LoadedSkill } from "../features/opencode-skill-loader/types"
import { resolveFileReferencesInText } from "../shared/file-reference-resolver"
import { isSystemDirective, removeSystemReminders } from "../shared/system-directive"
import { collectDisabledSkillAliases } from "../plugin/skill-context"
import { loadV2SkillCatalog } from "./skills"
import type { OhMyOpenCodeConfig } from "../config"
import { BuiltinCommandNameSchema } from "../config/schema/commands"
import type { CommandDefinition } from "../features/claude-code-command-loader"
import {
	loadProjectCommands,
	loadUserCommands,
} from "../features/claude-code-command-loader"
import {
	discoverInstalledPlugins,
	loadPluginCommands,
	type LoadedPlugin,
	type PluginLoaderOptions,
} from "@oh-my-opencode/claude-code-compat-core/claude-code-plugin-loader"
import { getAgentConfigKey } from "../shared/agent-display-names"
import { log } from "../shared/logger"
import {
	createV2CommandDispatchGate,
	ensureV2SessionAgent,
	submitV2CommandNotice,
	submitV2CommandPrompt,
	type AssertV2CommandActive,
	type NativeCommandInvocation,
} from "./command-dispatch"

export interface V2CustomCommandLoaders {
	/** Skills available to free-text `/name` invocation; defaults to the native V2 skill catalog. */
	loadSkills?(config: OhMyOpenCodeConfig, directory: string): Promise<readonly LoadedSkill[]>
	loadUserCommands(): Promise<Record<string, CommandDefinition>>
	loadProjectCommands(directory: string): Promise<Record<string, CommandDefinition>>
	discoverInstalledPlugins(options: PluginLoaderOptions): { plugins: LoadedPlugin[]; errors: Array<{ pluginKey: string; installPath: string; error: string }> }
	loadPluginCommands(plugins: LoadedPlugin[]): Record<string, CommandDefinition>
}

const DEFAULT_LOADERS: V2CustomCommandLoaders = {
	loadUserCommands,
	loadProjectCommands,
	discoverInstalledPlugins,
	loadPluginCommands,
}

const RESERVED_OMO_COMMANDS = new Set<string>(BuiltinCommandNameSchema.options.map((name) => name.toLowerCase()))
const POSITIONAL_ARGUMENTS = /\$(\d+)/g
const ARGUMENT_TOKEN = /(?:\[Image\s+\d+\]|"[^"]*"|'[^']*'|[^\s"']+)/gi
const ARGUMENT_QUOTE = /^["']|["']$/g
const ARGUMENTS_INDEX = /\$ARGUMENTS\[(\d+)\]/g
const SHELL_TIMEOUT_MS = 30_000
const SHELL_MAX_BUFFER = 1024 * 1024
const SHELL_MAX_DEPTH = 3
const DEFAULT_SUBTASK_AGENT = "sisyphus-junior"

/**
 * Load only Claude Code user/project commands and enabled Claude plugin commands.
 * Merge order is explicit: project commands shadow user commands, then plugins
 * shadow both. Native OpenCode command sources are owned and discovered by the host.
 */
export async function loadV2CustomCommandDefinitions(
	config: OhMyOpenCodeConfig,
	directory: string,
	loaders: V2CustomCommandLoaders = DEFAULT_LOADERS,
): Promise<Record<string, CommandDefinition>> {
	const includeCommands = config.claude_code?.commands ?? true
	const includePlugins = config.claude_code?.plugins ?? true
	const [user, project] = await Promise.all([
		includeCommands ? loaders.loadUserCommands() : Promise.resolve({}),
		includeCommands ? loaders.loadProjectCommands(directory) : Promise.resolve({}),
	])

	let plugins: Record<string, CommandDefinition> = {}
	if (includePlugins) {
		const result = loaders.discoverInstalledPlugins({
			projectDirectory: directory,
			enabledPluginsOverride: config.claude_code?.plugins_override,
		})
		for (const error of result.errors) {
			log("[v2 command] Could not load an enabled Claude Code plugin.", error)
		}
		plugins = loaders.loadPluginCommands(result.plugins)
	}

	return { ...user, ...project, ...plugins }
}

/** OpenCode 2's positional argument behavior: quoted tokens are unquoted and
 * the highest referenced positional placeholder receives the remaining words. */
function parseCommandArguments(text: string): string[] {
	return (text.match(ARGUMENT_TOKEN) ?? []).map((argument) => argument.replace(ARGUMENT_QUOTE, ""))
}

export function expandV2CustomCommandTemplate(
	template: string,
	input: NativeCommandInvocation,
	timestamp: string,
): string {
	const args = parseCommandArguments(input.prompt.text)
	const positions = [...template.matchAll(POSITIONAL_ARGUMENTS)].map((match) => Number(match[1]))
	const lastPosition = Math.max(0, ...positions)
	const hasArgumentPlaceholder = positions.length > 0 || /\$ARGUMENTS|\$\{user_message\}/.test(template)
	// Claude Code `$ARGUMENTS[N]` is a zero-based single argument; resolve it before `$ARGUMENTS`.
	const indexed = template.replace(ARGUMENTS_INDEX, (_match, index: string) => args[Number(index)] ?? "")
	const expanded = indexed.replace(
		/\$(\d+)|\$ARGUMENTS|\$SESSION_ID|\$TIMESTAMP|\$\{user_message\}/g,
		(placeholder, position: string | undefined) => {
			if (position !== undefined) {
				const oneBased = Number(position)
				const index = oneBased - 1
				if (index < 0 || index >= args.length) return ""
				return oneBased === lastPosition ? args.slice(index).join(" ") : args[index]
			}
			switch (placeholder) {
				case "$ARGUMENTS":
				case "${user_message}": return input.prompt.text
				case "$SESSION_ID": return input.sessionID
				case "$TIMESTAMP": return timestamp
				default: return placeholder
			}
		},
	).trim()
	if (hasArgumentPlaceholder || !input.prompt.text.trim()) return expanded
	return `${expanded}\n\n${input.prompt.text.trim()}`.trim()
}

/** Run one `!\`command\`` interpolation in the session directory, combining output like the legacy executor. */
export function runV2CommandShell(command: string, cwd: string, timeoutMs = SHELL_TIMEOUT_MS): Promise<string> {
	return new Promise((resolve) => {
		exec(command, { cwd, timeout: timeoutMs, maxBuffer: SHELL_MAX_BUFFER, shell: process.env.SHELL || "/bin/sh" }, (error, stdout, stderr) => {
			const out = String(stdout ?? "").trim()
			const err = String(stderr ?? "").trim() || (error ? error.message : "")
			resolve(err ? (out ? `${out}\n[stderr: ${err}]` : `[stderr: ${err}]`) : out)
		})
	})
}

/**
 * Evaluate command-template sources before user arguments are substituted (legacy order): `@path`
 * references inside the project are inlined, then `!\`command\`` interpolations run in the session
 * directory. User-supplied arguments are never executed or read as file references.
 */
export async function evaluateV2CommandTemplateSources(
	template: string,
	directory: string,
	runShell: (command: string, cwd: string) => Promise<string> = runV2CommandShell,
): Promise<string> {
	let text = await resolveFileReferencesInText(template, directory)
	for (let depth = 0; depth < SHELL_MAX_DEPTH; depth++) {
		const matches = findEmbeddedCommands(text)
		if (matches.length === 0) break
		const outputs = await Promise.all(matches.map((match) => runShell(match.command, directory).catch((error: unknown) =>
			`[error: ${error instanceof Error ? error.message : String(error)}]`)))
		let index = 0
		text = text.replace(/!`([^`]+)`/g, () => outputs[index++] ?? "")
	}
	return text
}

function parseModelReference(model: string): { providerID: string; id: string; variant?: string } | undefined {
	try {
		const parsed = Model.Ref.parse(model.trim())
		return {
			providerID: parsed.providerID,
			id: parsed.id,
			...(parsed.variant ? { variant: parsed.variant } : {}),
		}
	} catch {
		return undefined
	}
}

async function unavailableTargetNotice(
	ctx: Plugin.Context,
	input: NativeCommandInvocation,
	name: string,
	message: string,
	assertActive: AssertV2CommandActive,
): Promise<void> {
	await submitV2CommandNotice(ctx, input, `/${name} cannot run safely: ${message}`, assertActive)
}

type NativeTool = { execute: (input: unknown, context: ToolContext) => Promise<{ output?: unknown; content?: unknown }> }

async function nativeSubagentTool(ctx: Plugin.Context): Promise<NativeTool | undefined> {
	const tool = (await ctx.tool.list()).find((entry) => entry.id === "subagent")
	return tool as unknown as NativeTool | undefined
}

/**
 * `subtask: true` (or a subagent-mode command agent) runs the evaluated template in a background child
 * through the native `subagent` executor, wrapped by OMO admission and model selection. The host notifies
 * the parent session when the child finishes, as for its own subtask commands.
 */
async function executeSubtaskCommand(
	ctx: Plugin.Context,
	name: string,
	command: CommandDefinition,
	input: NativeCommandInvocation,
	agentID: string,
	text: string,
	assertActive: AssertV2CommandActive,
): Promise<void> {
	const tool = await nativeSubagentTool(ctx)
	assertActive()
	if (!tool) {
		await unavailableTargetNotice(ctx, input, name, "the native subagent tool is unavailable (task/subagent disabled), so subtask execution cannot start.", assertActive)
		return
	}
	const session = await ctx.session.get({ sessionID: input.sessionID })
	assertActive()
	const callID = `cmd_${createHash("sha256").update(`${input.sessionID}\n${name}\n${randomUUID()}`).digest("hex").slice(0, 24)}`
	const controller = new AbortController()
	const context = {
		sessionID: input.sessionID,
		agent: session.agent ?? agentID,
		messageID: `msg_${callID}`,
		id: callID,
		signal: controller.signal,
		progress: async () => undefined,
	} as unknown as ToolContext
	const args: Record<string, unknown> = {
		agent: agentID,
		description: (command.description ?? name).replace(/^\([^)]*\)\s*/, "").slice(0, 80) || name,
		prompt: text,
		background: true,
		...(command.model ? { model: command.model.trim() } : {}),
	}
	let result: { output?: unknown; content?: unknown }
	try {
		result = await tool.execute(args, context)
	} catch (error) {
		await unavailableTargetNotice(ctx, input, name, `the subtask could not start: ${error instanceof Error ? error.message : String(error)}`, assertActive)
		return
	}
	const output = result.output && typeof result.output === "object" ? result.output as { sessionID?: unknown } : undefined
	const childID = typeof output?.sessionID === "string" ? output.sessionID : undefined
	await submitV2CommandNotice(ctx, input, `/${name} started as a ${agentID} subtask${childID ? ` (task_id: ${childID})` : ""}. Its result will be delivered to this session when it finishes.`, assertActive)
}

async function executeCustomCommand(
	ctx: Plugin.Context,
	name: string,
	command: CommandDefinition,
	input: NativeCommandInvocation,
	assertActive: AssertV2CommandActive,
	handoffs: V2CommandHandoffs,
): Promise<void> {
	assertActive()
	let targetAgent: Awaited<ReturnType<Plugin.Context["agent"]["get"]>>["data"] | undefined
	const targetAgentID = command.agent ? getAgentConfigKey(command.agent) : undefined
	if (command.agent) {
		try {
			const result = await ctx.agent.get({ agentID: targetAgentID! })
			assertActive()
			targetAgent = result.data
			if (targetAgent.id !== targetAgentID) targetAgent = undefined
		} catch {
			assertActive()
		}
		if (!targetAgent) {
			await unavailableTargetNotice(ctx, input, name, `configured agent "${command.agent}" (resolved as "${targetAgentID}") is not registered. Select an available agent or update the command frontmatter.`, assertActive)
			return
		}
	}
	const subtask = command.subtask === true || (command.subtask !== false && targetAgent?.mode === "subagent")
	if (subtask && targetAgent?.mode === "primary") {
		await unavailableTargetNotice(ctx, input, name, `configured agent "${command.agent}" is primary-only and cannot run as a subtask. Select a subagent-mode agent or set subtask: false.`, assertActive)
		return
	}

	let targetModel: { providerID: string; id: string; variant?: string } | undefined
	if (command.model) {
		targetModel = parseModelReference(command.model)
		if (!targetModel) {
			await unavailableTargetNotice(ctx, input, name, `configured model "${command.model}" must use provider/model form. Update the command frontmatter.`, assertActive)
			return
		}
		const models = await ctx.model.list()
		assertActive()
		const available = models.data.find((model) =>
			model.providerID === targetModel!.providerID && model.id === targetModel!.id && model.enabled,
		)
		if (!available) {
			await unavailableTargetNotice(ctx, input, name, `configured model "${command.model}" is not enabled or available. Enable its provider/model or update the command frontmatter.`, assertActive)
			return
		}
		if (targetModel.variant && !available.variants.some((variant) => variant.id === targetModel!.variant)) {
			const variants = available.variants.map((variant) => variant.id).join(", ") || "none"
			await unavailableTargetNotice(ctx, input, name, `variant "${targetModel.variant}" is unavailable for "${targetModel.providerID}/${targetModel.id}"; available variants: ${variants}. Update the command frontmatter.`, assertActive)
			return
		}
	}

	const session = await ctx.session.get({ sessionID: input.sessionID })
	assertActive()
	const directory = String(session.location?.directory ?? ctx.location.directory)
	const sources = await evaluateV2CommandTemplateSources(command.template, directory)
	assertActive()
	const timestamp = new Date().toISOString()
	const expanded = expandV2CustomCommandTemplate(sources, input, timestamp)
	if (subtask) {
		await executeSubtaskCommand(ctx, name, command, input, targetAgentID ?? DEFAULT_SUBTASK_AGENT, expanded, assertActive)
		return
	}
	if (command.agent) {
		await ensureV2SessionAgent(ctx, input.sessionID, targetAgentID!, assertActive)
	}
	if (targetModel) {
		assertActive()
		await ctx.session.switchModel({ sessionID: input.sessionID, model: targetModel })
		assertActive()
	}
	if (command.handoffs?.length) handoffs.arm(input.sessionID, name, command.handoffs)
	await submitV2CommandPrompt(ctx, input, expanded, undefined, assertActive)
}

type HandoffDefinition = NonNullable<CommandDefinition["handoffs"]>[number]

type V2CommandHandoffs = {
	arm(sessionID: string, command: string, handoffs: readonly HandoffDefinition[]): void
	dispose(): Promise<void>
}

/**
 * Claude command `handoffs`: after the command's turn succeeds, list the suggested transitions and
 * dispatch the first `send: true` entry once (a registered command by name, otherwise an agent switch
 * with the pre-filled prompt). This is separate from OMO's built-in `/handoff` command.
 */
function createV2CommandHandoffs(ctx: Plugin.Context): V2CommandHandoffs {
	const armed = new Map<string, { command: string; handoffs: readonly HandoffDefinition[]; armedAt: number }>()
	const controller = new AbortController()
	const run = async (sessionID: string, entry: { command: string; handoffs: readonly HandoffDefinition[] }) => {
		const lines = entry.handoffs.map((handoff) => `- ${handoff.label} → ${handoff.agent}${handoff.send ? " (sent automatically)" : ""}: ${handoff.prompt}`)
		await ctx.session.synthetic({
			sessionID,
			text: `/${entry.command} suggested handoffs:\n${lines.join("\n")}`,
			description: "OMO command handoffs",
			metadata: { omoCommandHandoffs: { version: 1, command: entry.command } },
			delivery: "queue",
			resume: false,
		})
		const automatic = entry.handoffs.find((handoff) => handoff.send === true)
		if (!automatic) return
		const commands = await ctx.command.list()
		const commandName = commands.data.find((command) => command.name.toLowerCase() === automatic.agent.toLowerCase())?.name
		if (commandName) {
			await ctx.session.command({ sessionID, name: commandName, text: automatic.prompt, delivery: "queue" })
			return
		}
		const agentID = getAgentConfigKey(automatic.agent)
		try {
			const agent = (await ctx.agent.get({ agentID })).data
			if (agent.id !== agentID || agent.mode === "subagent") throw new Error("not a primary agent")
		} catch {
			log("[v2 command] Automatic handoff target is neither a command nor a primary agent.", { sessionID, target: automatic.agent })
			return
		}
		await ensureV2SessionAgent(ctx, sessionID as NativeCommandInvocation["sessionID"], agentID, () => undefined)
		await ctx.session.prompt({ sessionID, text: automatic.prompt, delivery: "queue" })
	}
	let events: Promise<void> | undefined
	// Subscribe only once a command with handoffs actually runs.
	const listen = () => (async () => {
		while (!controller.signal.aborted) {
			try {
				for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
					if (event.type !== "session.execution.succeeded" && event.type !== "session.execution.failed" &&
						event.type !== "session.execution.interrupted" && event.type !== "session.deleted") continue
					const sessionID = String((event.data as { sessionID?: unknown }).sessionID ?? "")
					const entry = armed.get(sessionID)
					if (!entry) continue
					const created = typeof (event as { created?: unknown }).created === "number" ? (event as { created: number }).created : Date.now()
					if (created < entry.armedAt) continue
					armed.delete(sessionID)
					if (event.type !== "session.execution.succeeded") continue
					await run(sessionID, entry).catch((error) => log("[v2 command] Command handoff dispatch failed.", { sessionID, error }))
				}
			} catch (error) {
				if (!controller.signal.aborted) log("[v2 command] Handoff event stream stopped; reconnecting.", error)
			}
			if (!controller.signal.aborted) await new Promise((resolve) => setTimeout(resolve, 500))
		}
	})()
	return {
		arm(sessionID, command, handoffs) {
			armed.set(sessionID, { command, handoffs, armedAt: Date.now() })
			events ??= listen()
		},
		async dispose() {
			controller.abort()
			armed.clear()
			await events
		},
	}
}

function formatV2SlashTemplate(name: string, description: string | undefined, body: string, args: string): string {
	const sections = [`# /${name} Command`]
	if (description) sections.push(`**Description**: ${description}`)
	if (args) sections.push(`**User Arguments**: ${args}`)
	sections.push("---", "## Command Instructions", body.trim())
	if (args && !/\$ARGUMENTS|\$\{user_message\}/.test(body)) sections.push("---", "## User Request", args)
	return sections.join("\n\n")
}

/**
 * Legacy `auto-slash-command`: a submitted user prompt that starts with `/name` for a loaded skill or an
 * imported template command (for example through `opencode run` or a client that does not execute
 * commands) is replaced by the evaluated template, tagged so it is expanded only once. Native and OMO
 * built-in commands keep their own execution path.
 */
export async function registerV2AutoSlashCommand(
	ctx: Plugin.Context,
	config: OhMyOpenCodeConfig,
	commands: Readonly<Record<string, CommandDefinition>>,
	skills: readonly LoadedSkill[],
): Promise<() => Promise<void>> {
	if (config.disabled_hooks?.includes("auto-slash-command")) return async () => {}
	const disabledSkills = collectDisabledSkillAliases(config)
	const skillByName = new Map(skills
		.filter((skill) => !disabledSkills.has(skill.name.toLowerCase()))
		.map((skill) => [skill.name.toLowerCase(), skill]))
	const commandByName = new Map(Object.entries(commands).map(([name, definition]) => [name.toLowerCase(), { name, definition }]))
	if (skillByName.size === 0 && commandByName.size === 0) return async () => {}
	const registration = await ctx.session.hook("prompt", async (input: SessionPrompt) => {
		const text = input.prompt.text
		if (!text || text.includes(AUTO_SLASH_COMMAND_TAG_OPEN) || text.includes(AUTO_SLASH_COMMAND_TAG_CLOSE)) return
		const cleaned = removeSystemReminders(text)
		if (isSystemDirective(cleaned)) return
		const parsed = detectSlashCommand(cleaned)
		if (!parsed) return
		const skill = skillByName.get(parsed.command)
		const command = skill ? undefined : commandByName.get(parsed.command)
		if (!skill && !command) return
		let session: Awaited<ReturnType<Plugin.Context["session"]["get"]>>
		try {
			session = await ctx.session.get({ sessionID: input.sessionID })
		} catch {
			return
		}
		const directory = String(session.location?.directory ?? ctx.location.directory)
		let replacement: string
		if (skill) {
			if (skill.definition.agent && getAgentConfigKey(skill.definition.agent) !== getAgentConfigKey(String(session.agent ?? ""))) {
				log("[v2 auto-slash-command] Skill is restricted to another agent; leaving the prompt unchanged.", { skill: skill.name, agent: session.agent })
				return
			}
			const body = skill.lazyContent?.loaded ? skill.lazyContent.content ?? "" : skill.lazyContent ? await skill.lazyContent.load() : skill.definition.template ?? ""
			const sources = await evaluateV2CommandTemplateSources(body, directory)
			replacement = formatV2SlashTemplate(skill.name, skill.definition.description, expandV2CustomCommandTemplate(sources, {
				sessionID: input.sessionID,
				prompt: { ...input.prompt, text: parsed.args },
				delivery: input.delivery,
			}, new Date().toISOString()), parsed.args)
		} else {
			const sources = await evaluateV2CommandTemplateSources(command!.definition.template, directory)
			replacement = formatV2SlashTemplate(command!.name, command!.definition.description, expandV2CustomCommandTemplate(sources, {
				sessionID: input.sessionID,
				prompt: { ...input.prompt, text: parsed.args },
				delivery: input.delivery,
			}, new Date().toISOString()), "")
		}
		input.prompt.text = `${AUTO_SLASH_COMMAND_TAG_OPEN}\n${replacement}\n${AUTO_SLASH_COMMAND_TAG_CLOSE}`
		log("[v2 auto-slash-command] Expanded a free-text slash command.", { sessionID: input.sessionID, command: parsed.command })
	})
	return async () => { await registration.dispose() }
}

/**
 * Legacy skill commands: every enabled skill was also a slash command whose template wraps the skill body
 * with the user request. Imported commands, host commands and OMO built-ins keep their names.
 */
async function v2SkillCommandDefinitions(
	ctx: Plugin.Context,
	config: OhMyOpenCodeConfig,
	skills: readonly LoadedSkill[],
	taken: ReadonlySet<string>,
): Promise<Array<[string, CommandDefinition]>> {
	if (skills.length === 0) return []
	const disabledSkills = collectDisabledSkillAliases(config)
	const disabledCommands = new Set((config.disabled_commands ?? []).map((name) => String(name).toLowerCase()))
	const native = taken.size > 0 ? taken : new Set((await ctx.command.list()).data.map((command) => command.name.toLowerCase()))
	const result: Array<[string, CommandDefinition]> = []
	for (const skill of skills) {
		const name = skill.name
		const normalized = name.toLowerCase()
		if (disabledSkills.has(normalized) || disabledCommands.has(normalized) || RESERVED_OMO_COMMANDS.has(normalized) || native.has(normalized)) continue
		if (!/^[a-zA-Z@][\w.:@/-]*$/.test(name)) continue
		const body = skill.lazyContent?.loaded ? skill.lazyContent.content ?? "" : skill.definition.template ?? ""
		const template = body.includes("<skill-instruction>")
			? body
			: `<skill-instruction>\n${body.trim()}\n</skill-instruction>\n\n<user-request>\n$ARGUMENTS\n</user-request>`
		result.push([name, {
			name,
			description: skill.definition.description ? `(skill) ${skill.definition.description}` : "(skill)",
			template,
			...(skill.definition.agent ? { agent: skill.definition.agent } : {}),
			...(skill.definition.model ? { model: skill.definition.model } : {}),
			...(skill.definition.subtask !== undefined ? { subtask: skill.definition.subtask } : {}),
		}])
	}
	return result
}

/** Register eligible imported commands without shadowing host or OMO commands. */
export async function registerV2CustomCommands(
	ctx: Plugin.Context,
	config: OhMyOpenCodeConfig,
	loaders: V2CustomCommandLoaders = DEFAULT_LOADERS,
): Promise<() => Promise<void>> {
	const directory = String(ctx.location.directory)
	const definitions = await loadV2CustomCommandDefinitions(config, directory, loaders)
	const names = Object.keys(definitions)
	const nativeCommands = await ctx.command.list()
	const nativeNames = new Set(nativeCommands.data.map((command) => command.name.toLowerCase()))
	const eligible = Object.entries(definitions).filter(([name]) => {
		const normalized = name.toLowerCase()
		if (RESERVED_OMO_COMMANDS.has(normalized)) {
			log("[v2 command] Skipping imported command reserved for an OMO builtin.", { command: name })
			return false
		}
		if (nativeNames.has(normalized)) {
			log("[v2 command] Skipping imported command that conflicts with a native command.", { command: name })
			return false
		}
		return true
	})
	const skills = config.disabled_hooks?.includes("auto-slash-command")
		? []
		: await (loaders.loadSkills ?? (async (current, root) => (await loadV2SkillCatalog(current, root)).loaded))(config, directory)
	const autoSlashCleanup = await registerV2AutoSlashCommand(ctx, config, Object.fromEntries(eligible), skills)
	const skillCommands = await v2SkillCommandDefinitions(ctx, config, skills, new Set([...nativeNames, ...eligible.map(([name]) => name.toLowerCase())]))
	eligible.push(...skillCommands)
	if (eligible.length === 0) return autoSlashCleanup

	const gate = createV2CommandDispatchGate()
	const handoffs = createV2CommandHandoffs(ctx)
	let active = true
	let registration: Awaited<ReturnType<typeof ctx.command.transform>>
	try {
		registration = await ctx.command.transform((editor) => {
			for (const [name, definition] of eligible) {
				editor.add({
					name,
					description: definition.description,
					execute: async (input) => {
						if (!active) throw new Error("Native command registration has been disposed")
						const assertActive = () => {
							if (!active) throw new Error("Native command registration has been disposed")
						}
						return gate.run({ commandName: name, invocation: input }, () =>
							executeCustomCommand(ctx, name, definition, input, assertActive, handoffs),
						)
					},
				})
			}
		})
	} catch (error) {
		active = false
		gate.dispose()
		await handoffs.dispose()
		await autoSlashCleanup()
		throw error
	}

	let cleanupPromise: Promise<void> | undefined
	return () => {
		cleanupPromise ??= (async () => {
			active = false
			gate.dispose()
			await registration.dispose()
			await handoffs.dispose()
			await autoSlashCleanup()
		})()
		return cleanupPromise
	}
}
