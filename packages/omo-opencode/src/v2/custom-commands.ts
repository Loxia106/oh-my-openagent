import { Model, type Plugin } from "@opencode/plugin"
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
const SHELL_INTERPOLATION = /!`[^`]*`/

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
	const expanded = template.replace(
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

export type UnsupportedCustomCommandFeature = "shell interpolation" | "subtask execution" | "Claude positional argument syntax"

export function unsupportedCustomCommandFeature(
	command: CommandDefinition,
): UnsupportedCustomCommandFeature | undefined {
	if (command.subtask === true) return "subtask execution"
	if (SHELL_INTERPOLATION.test(command.template)) return "shell interpolation"
	if (/\$ARGUMENTS\[\d+\]/.test(command.template)) return "Claude positional argument syntax"
	return undefined
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

async function executeCustomCommand(
	ctx: Plugin.Context,
	name: string,
	command: CommandDefinition,
	input: NativeCommandInvocation,
	assertActive: AssertV2CommandActive,
): Promise<void> {
	assertActive()
	const unsupported = unsupportedCustomCommandFeature(command)
	if (unsupported) {
		const remedy = unsupported === "shell interpolation"
			? "move this command to native `.opencode/commands` so the host can evaluate it, or remove the interpolation."
			: unsupported === "subtask execution"
				? "remove subtask: true or use a primary-mode agent; native subtask command execution is not available in this adapter."
				: "replace $ARGUMENTS[N] with the supported $N positional placeholder."
		await unavailableTargetNotice(ctx, input, name, `it uses unsupported ${unsupported}; ${remedy}`, assertActive)
		return
	}

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
		if (command.subtask !== false && targetAgent.mode === "subagent") {
			await unavailableTargetNotice(ctx, input, name, `configured agent "${command.agent}" runs in subagent mode, which requires unsupported subtask execution. Set subtask: false or select a primary-mode agent.`, assertActive)
			return
		}
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

	if (command.agent) {
		await ensureV2SessionAgent(ctx, input.sessionID, targetAgentID!, assertActive)
	}
	if (targetModel) {
		assertActive()
		await ctx.session.switchModel({ sessionID: input.sessionID, model: targetModel })
		assertActive()
	}
	const timestamp = new Date().toISOString()
	const expanded = expandV2CustomCommandTemplate(command.template, input, timestamp)
	await submitV2CommandPrompt(ctx, input, expanded, undefined, assertActive)
}

/** Register eligible imported commands without shadowing host or OMO commands. */
export async function registerV2CustomCommands(
	ctx: Plugin.Context,
	config: OhMyOpenCodeConfig,
	loaders: V2CustomCommandLoaders = DEFAULT_LOADERS,
): Promise<() => Promise<void>> {
	const definitions = await loadV2CustomCommandDefinitions(config, String(ctx.location.directory), loaders)
	const names = Object.keys(definitions)
	if (names.length === 0) return async () => undefined

	const nativeCommands = await ctx.command.list()
	const nativeNames = new Set(nativeCommands.data.map((command) => command.name.toLowerCase()))
	const eligible = Object.entries(definitions).filter(([name, definition]) => {
		const normalized = name.toLowerCase()
		if (RESERVED_OMO_COMMANDS.has(normalized)) {
			log("[v2 command] Skipping imported command reserved for an OMO builtin.", { command: name })
			return false
		}
		if (nativeNames.has(normalized)) {
			log("[v2 command] Skipping imported command that conflicts with a native command.", { command: name })
			return false
		}
		if (definition.handoffs?.length) {
			log("[v2 command] Imported command handoffs are not executed by the OpenCode 2 adapter.", { command: name })
		}
		return true
	})
	if (eligible.length === 0) return async () => undefined

	const gate = createV2CommandDispatchGate()
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
							executeCustomCommand(ctx, name, definition, input, assertActive),
						)
					},
				})
			}
		})
	} catch (error) {
		active = false
		gate.dispose()
		throw error
	}

	let cleanupPromise: Promise<void> | undefined
	return () => {
		cleanupPromise ??= (async () => {
			active = false
			gate.dispose()
			await registration.dispose()
		})()
		return cleanupPromise
	}
}
