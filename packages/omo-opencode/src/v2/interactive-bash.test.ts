import { describe, expect, test } from "bun:test"
import { z } from "zod"
import type { Plugin } from "@opencode/plugin"
import type { ToolContext, ToolEditor, Info } from "@opencode/plugin/promise/tool"
import type { OhMyOpenCodeConfig } from "../config"
import { registerV2InteractiveBashTool, type V2InteractiveBashDependencies } from "./interactive-bash"

type RegisteredTool = Info & { readonly id?: string }
type Execute = (input: { tmux_command: string }, context: ToolContext) => Promise<unknown>

function harness(options: {
	readonly tmuxPath?: string | null
	readonly cmux?: boolean
	readonly config?: Record<string, unknown>
	readonly nativeShell?: boolean
	readonly existingTool?: boolean
	readonly execute?: Execute
} = {}) {
	const tools = new Map<string, RegisteredTool>()
	const executed: Array<{ input: unknown; context: ToolContext }> = []
	const transformCalls: number[] = []
	const disposeCalls: number[] = []
	const context = {
		sessionID: "ses-interactive-test",
		agent: "hephaestus",
		messageID: "msg-interactive-test",
		id: "call-interactive-test",
		signal: new AbortController().signal,
		progress: async () => undefined,
	} as unknown as ToolContext
	const nativeShell: RegisteredTool = {
		id: "shell",
		name: "shell",
		description: "native shell",
		input: {} as never,
		output: z.object({ output: z.string(), status: z.string(), exit: z.number().optional(), truncated: z.boolean() }),
		options: { codemode: false, permission: "shell" },
		execute: async (input, forwardedContext) => {
			executed.push({ input, context: forwardedContext })
			if (options.execute) return options.execute(input as { tmux_command: string }, forwardedContext)
			return {
				output: { output: "native tmux output", status: "completed", exit: 0, truncated: false },
				content: [{ type: "text", text: "native tmux output" }],
				metadata: { shellID: "shell-job" },
			}
		},
	} as unknown as RegisteredTool
	if (options.nativeShell !== false) tools.set("shell", nativeShell)
	if (options.existingTool) tools.set("interactive_bash", { ...nativeShell, id: "interactive_bash", name: "interactive_bash" })
	const editor = {
		list: () => [...tools.values()],
		get: (name: string) => tools.get(name),
		namespace: () => undefined,
		add: (tool: RegisteredTool) => { tools.set(tool.name, tool) },
		update: () => undefined,
		remove: (name: string) => { tools.delete(name) },
	} as unknown as ToolEditor
	const ctx = {
		tool: {
			transform: async (callback: (editor: ToolEditor) => void) => {
				transformCalls.push(1)
				callback(editor)
				return { dispose: async () => { disposeCalls.push(1) } }
			},
		},
	} as unknown as Plugin.Context
	const dependencies: V2InteractiveBashDependencies = {
		getTmuxPath: async () => options.tmuxPath === undefined ? "/usr/bin/tmux" : options.tmuxPath,
		isCmuxCompatEnvironment: () => options.cmux ?? false,
	}
	return { ctx, config: (options.config ?? {}) as OhMyOpenCodeConfig, dependencies, tools, executed, transformCalls, disposeCalls, context }
}

function input(tool: RegisteredTool, tmux_command: string): { tmux_command: string } {
	return (tool.input as { parse(value: unknown): { tmux_command: string } }).parse({ tmux_command })
}

async function execute(tool: RegisteredTool, tmux_command: string, context: ToolContext): Promise<unknown> {
	return (tool.execute as Execute)(input(tool, tmux_command), context)
}

describe("native v2 interactive_bash", () => {
	test("registers only when enabled and tmux is available", async () => {
		const disabled = harness({ config: { disabled_tools: ["INTERACTIVE_BASH"] } })
		const disabledCleanup = await registerV2InteractiveBashTool(disabled.ctx, disabled.config, disabled.dependencies)
		expect(disabled.transformCalls).toHaveLength(0)
		await disabledCleanup()

		const shellDisabled = harness({ config: { disabled_tools: ["shell"] } })
		const shellCleanup = await registerV2InteractiveBashTool(shellDisabled.ctx, shellDisabled.config, shellDisabled.dependencies)
		expect(shellDisabled.transformCalls).toHaveLength(0)
		await shellCleanup()

		const missingTmux = harness({ tmuxPath: null })
		const missingCleanup = await registerV2InteractiveBashTool(missingTmux.ctx, missingTmux.config, missingTmux.dependencies)
		expect(missingTmux.transformCalls).toHaveLength(0)
		await missingCleanup()

		const missingShell = harness({ nativeShell: false })
		const missingShellCleanup = await registerV2InteractiveBashTool(missingShell.ctx, missingShell.config, missingShell.dependencies)
		expect(missingShell.tools.has("interactive_bash")).toBe(false)
		await missingShellCleanup()
	})

	test("wraps the captured native shell and preserves its schema, authorization context, and structured result", async () => {
		const state = harness({ tmuxPath: "/opt/tools/tmux binary" })
		const cleanup = await registerV2InteractiveBashTool(state.ctx, state.config, state.dependencies)
		const registered = state.tools.get("interactive_bash")
		expect(registered).toBeDefined()
		expect(registered?.options).toEqual({ codemode: false, permission: "shell" })
		expect(registered?.output).toBe(state.tools.get("shell")?.output)

		const result = await execute(registered!, "new-session -d -s 'a; touch sentinel'", state.context)

		expect(state.executed).toHaveLength(1)
		expect(state.executed[0]?.input).toEqual({
			command: "'/opt/tools/tmux binary' 'new-session' '-d' '-s' 'a; touch sentinel'",
			timeout: 60_000,
		})
		expect(state.executed[0]?.context).toBe(state.context)
		expect(result).toEqual({
			output: { output: "native tmux output", status: "completed", exit: 0, truncated: false },
			content: [{ type: "text", text: "native tmux output" }],
			metadata: { shellID: "shell-job" },
		})
		await cleanup()
		await cleanup()
		expect(state.disposeCalls).toHaveLength(1)
	})

	test("routes cmux compatibility through its shim and safely removes an optional tmux prefix", async () => {
		const state = harness({ tmuxPath: "/Applications/cmux", cmux: true })
		const cleanup = await registerV2InteractiveBashTool(state.ctx, state.config, state.dependencies)
		const registered = state.tools.get("interactive_bash")
		await execute(registered!, "tmux new-session -d -s qa", state.context)
		expect(state.executed[0]?.input).toEqual({
			command: "'/Applications/cmux' '__tmux-compat' 'new-session' '-d' '-s' 'qa'",
			timeout: 60_000,
		})
		await cleanup()
	})

	test("blocks terminal capture and server-wide kill before invoking the native shell", async () => {
		const state = harness()
		const cleanup = await registerV2InteractiveBashTool(state.ctx, state.config, state.dependencies)
		const registered = state.tools.get("interactive_bash")!

		const capture = await execute(registered, "-L omo-socket capturep -t qa", state.context) as { content: string }
		const kill = await execute(registered, "tmux -L omo-socket kill-server", state.context) as { content: string }

		expect(capture.content).toContain("capturep' is blocked")
		expect(capture.content).toContain("capture-pane -p -t qa")
		expect(kill.content).toContain("kill-server' is prohibited")
		expect(kill.content).toContain("Do not retry kill-server with Bash or any other tool.")
		expect(state.executed).toHaveLength(0)
		await cleanup()
	})

	test("rejects tmux command separators including trailing separators that would execute a second command", async () => {
		const state = harness()
		const cleanup = await registerV2InteractiveBashTool(state.ctx, state.config, state.dependencies)
		const registered = state.tools.get("interactive_bash")!

		const killChain = await execute(registered, "new-session -d -s qa; kill-server", state.context) as { content: string }
		const captureChain = await execute(registered, "new-session -d -s qa; capture-pane -p", state.context) as { content: string }
		const trailingSeparator = await execute(registered, "new-session -d -s qa;", state.context) as { content: string; output?: { exit: number } }

		expect(killChain.content).toContain("command separators are blocked")
		expect(captureChain.content).toContain("command separators are blocked")
		expect(trailingSeparator.content).toContain("command separators are blocked")
		expect(trailingSeparator.output).toMatchObject({ exit: 1, status: "completed", truncated: false })
		expect(state.executed).toHaveLength(0)
		await cleanup()
	})

	test("keeps a deliberately escaped trailing semicolon as a literal argument", async () => {
		const state = harness()
		const cleanup = await registerV2InteractiveBashTool(state.ctx, state.config, state.dependencies)
		const registered = state.tools.get("interactive_bash")!

		await execute(registered, "new-session -d -s qa\\\\;", state.context)

		expect(state.executed).toHaveLength(1)
		expect(state.executed[0]?.input).toMatchObject({ command: "'/usr/bin/tmux' 'new-session' '-d' '-s' 'qa\\;'" })
		await cleanup()
	})

	test("prevents stale captured executors from reaching native shell after cleanup", async () => {
		const state = harness()
		const cleanup = await registerV2InteractiveBashTool(state.ctx, state.config, state.dependencies)
		const staleTool = state.tools.get("interactive_bash")!
		await cleanup()

		const result = await execute(staleTool, "new-session -d -s qa", state.context) as { content: string }

		expect(result.content).toContain("no longer available after plugin cleanup")
		expect(state.executed).toHaveLength(0)
	})

	test("forwards native execution failures unchanged", async () => {
		const failure = new Error("native shell rejected the command")
		const state = harness({
			execute: async () => { throw failure },
		})
		const cleanup = await registerV2InteractiveBashTool(state.ctx, state.config, state.dependencies)
		await expect(execute(state.tools.get("interactive_bash")!, "new-session -d", state.context)).rejects.toBe(failure)
		await cleanup()
	})

	test("leaves an existing interactive_bash registration untouched", async () => {
		const state = harness({ existingTool: true })
		const existing = state.tools.get("interactive_bash")
		const cleanup = await registerV2InteractiveBashTool(state.ctx, state.config, state.dependencies)
		expect(state.tools.get("interactive_bash")).toBe(existing)
		await cleanup()
	})
})
