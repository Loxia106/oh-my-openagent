import type { Plugin } from "@opencode/plugin"
import type { ToolContext, ToolEditor } from "@opencode/plugin/promise/tool"
import { z } from "zod"
import type { OhMyOpenCodeConfig } from "../config"
import { isCmuxCompatEnvironment } from "../shared/tmux/cmux-detect"
import { shellSingleQuote } from "../shared/shell-env"
import { tokenizeCommand } from "../tools/interactive-bash/tools"
import {
	BLOCKED_TMUX_SUBCOMMANDS,
	DEFAULT_TIMEOUT_MS,
	INTERACTIVE_BASH_DESCRIPTION,
	PROHIBITED_TMUX_SUBCOMMANDS,
} from "../tools/interactive-bash/constants"
import { getTmuxPath } from "../tools/interactive-bash/tmux-path-resolver"
import { addV2Tool, type NativeTool } from "./tool-adapter"

const GLOBAL_TMUX_OPTIONS_WITH_ARGS = new Set(["-L", "-S", "-f", "-c", "-T"])
const tmuxInput = z.object({
	tmux_command: z.string().describe("The tmux command to execute (without the 'tmux' prefix)"),
})

export type V2InteractiveBashDependencies = {
	readonly getTmuxPath?: () => Promise<string | null>
	readonly isCmuxCompatEnvironment?: () => boolean
}

function isDisabled(config: OhMyOpenCodeConfig, name: string): boolean {
	return config.disabled_tools?.some((item) => item.trim().toLowerCase() === name) ?? false
}

function baseName(path: string): string {
	return path.split(/[\\/]/).at(-1)?.toLowerCase() ?? path.toLowerCase()
}

function normalizeCommandPrefix(parts: string[]): string[] {
	const result = [...parts]
	if (baseName(result[0] ?? "").replace(/\.exe$/, "") === "tmux") result.shift()
	if (baseName(result[0] ?? "").replace(/\.exe$/, "") === "cmux" && result[1] === "__tmux-compat") {
		result.splice(0, 2)
	}
	return result
}

function hasCommandSeparator(parts: readonly string[]): boolean {
	// tmux treats an argv item ending in `;` as a command separator. The legacy
	// tokenizer removes one escaping backslash, so a surviving `\\;` is the
	// only spelling we pass through as a literal trailing semicolon.
	return parts.some((part) => part.endsWith(";") && !part.endsWith("\\;"))
}

function findSubcommandIndex(parts: readonly string[]): number {
	let index = 0
	while (index < parts.length) {
		const part = parts[index] ?? ""
		if (part === "--") return index + 1 < parts.length ? index + 1 : -1
		if (GLOBAL_TMUX_OPTIONS_WITH_ARGS.has(part)) {
			index += 2
			continue
		}
		if (part.startsWith("-")) {
			index += 1
			continue
		}
		return index
	}
	return -1
}

function targetSession(parts: readonly string[]): string {
	const index = parts.findIndex((part) => part === "-t" || part.startsWith("-t"))
	if (index < 0) return "omo-session"
	const current = parts[index] ?? ""
	if (current === "-t" && parts[index + 1]) return parts[index + 1] ?? "omo-session"
	if (current.startsWith("-t")) return current.slice(2) || "omo-session"
	return "omo-session"
}

function blockedMessage(command: string, parts: readonly string[]): string {
	const session = targetSession(parts)
	const fence = String.fromCharCode(96).repeat(3)
	return [
		"Error: '" + command + "' is blocked in interactive_bash.",
		"",
		"**USE BASH TOOL INSTEAD:**",
		"",
		fence + "bash",
		"# Capture terminal output",
		"tmux capture-pane -p -t " + session,
		"",
		"# Or capture with history (last 1000 lines)",
		"tmux capture-pane -p -t " + session + " -S -1000",
		fence,
		"",
		"The Bash tool can execute these commands directly. Do NOT retry with interactive_bash.",
	].join("\n")
}

function prohibitedMessage(command: string): string {
	const fence = String.fromCharCode(96).repeat(3)
	return [
		"Error: '" + command + "' is prohibited in interactive_bash.",
		"",
		"NEVER EVER run tmux kill-server from interactive_bash.",
		"",
		"It terminates the entire tmux server, destroying every tmux session and pane that the user, Codex, or other agents may be using.",
		"",
		"Use scoped cleanup only:",
		"",
		fence + "bash",
		"tmux kill-session -t <session-name>",
		fence,
		"",
		"If you created an omo-* session, kill only that exact session. Do not retry kill-server with Bash or any other tool.",
	].join("\n")
}

function executablePrefix(tmuxPath: string, cmux: boolean): string[] {
	if (!cmux) return [tmuxPath]
	const executable = baseName(tmuxPath).replace(/\.exe$/, "") === "cmux" ? tmuxPath : "cmux"
	return [executable, "__tmux-compat"]
}

function nativeShellResult(result: Awaited<ReturnType<NativeTool["execute"]>>) {
	return {
		...(result.output === undefined ? {} : { output: result.output }),
		...(result.content === undefined ? {} : { content: result.content }),
		...(result.metadata === undefined ? {} : { metadata: result.metadata }),
	}
}

function localResult(message: string, hasOutputSchema: boolean) {
	return {
		...(hasOutputSchema ? { output: { output: message, status: "completed", exit: 1, truncated: false } } : {}),
		content: message,
	}
}

/**
 * Register the OMO interactive_bash alias through OpenCode's captured shell tool.
 * Shell permissions, working directory, cancellation, environment, and execution
 * remain owned by the native executor.
 */
export async function registerV2InteractiveBashTool(
	ctx: Plugin.Context,
	config: OhMyOpenCodeConfig,
	dependencies: V2InteractiveBashDependencies = {},
): Promise<() => Promise<void>> {
	if (isDisabled(config, "interactive_bash") || isDisabled(config, "shell")) return async () => undefined
	const tmuxPath = await (dependencies.getTmuxPath ?? getTmuxPath)()
	if (!tmuxPath) return async () => undefined
	const cmux = (dependencies.isCmuxCompatEnvironment ?? isCmuxCompatEnvironment)()
	let active = true

	const registration = await ctx.tool.transform((editor: ToolEditor) => {
		if (editor.get("interactive_bash")) return
		const nativeShell = editor.get("shell")
		if (!nativeShell) return

		addV2Tool(editor, {
			name: "interactive_bash",
			description: INTERACTIVE_BASH_DESCRIPTION,
			input: tmuxInput,
			output: nativeShell.output,
			options: { codemode: false, permission: nativeShell.options?.permission ?? "shell" },
			execute: async (args, context: ToolContext) => {
				if (!active) return localResult("Error: interactive_bash is no longer available after plugin cleanup.", nativeShell.output !== undefined)
				const parts = normalizeCommandPrefix(tokenizeCommand(args.tmux_command))
				if (parts.length === 0) return localResult("Error: Empty tmux command", nativeShell.output !== undefined)
				if (hasCommandSeparator(parts)) {
					return localResult("Error: tmux command separators are blocked in interactive_bash. Run one tmux command per call.", nativeShell.output !== undefined)
				}

				const subcommandIndex = findSubcommandIndex(parts)
				const command = subcommandIndex < 0 ? "" : parts[subcommandIndex] ?? ""
				const normalized = command.toLowerCase()
				if (PROHIBITED_TMUX_SUBCOMMANDS.includes(normalized)) return localResult(prohibitedMessage(command), nativeShell.output !== undefined)
				if (BLOCKED_TMUX_SUBCOMMANDS.includes(normalized)) return localResult(blockedMessage(command, parts), nativeShell.output !== undefined)

				// A transform callback can outlive its registration briefly during
				// teardown. Recheck immediately before side effects; native execution
				// itself remains cancellable through this ToolContext's signal.
				if (!active) return localResult("Error: interactive_bash is no longer available after plugin cleanup.", nativeShell.output !== undefined)
				const commandLine = [...executablePrefix(tmuxPath, cmux), ...parts].map(shellSingleQuote).join(" ")
				const result = await nativeShell.execute({
					command: commandLine,
					timeout: DEFAULT_TIMEOUT_MS,
				}, context)
				return nativeShellResult(result)
			},
		})
	})

	return async () => {
		if (!active) return
		active = false
		await registration.dispose()
	}
}
