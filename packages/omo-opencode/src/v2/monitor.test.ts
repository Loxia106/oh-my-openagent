import { describe, expect, test } from "bun:test"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Plugin } from "@opencode/plugin"
import type { ToolContext, ToolEditor } from "@opencode/plugin/promise/tool"
import type { OhMyOpenCodeConfig } from "../config"
import { registerV2MonitorRuntime } from "./monitor"

type Tool = { name: string; execute: (input: unknown, context: ToolContext) => Promise<{ content: string }> }

function harness(permissions: Array<{ action: string; resource: string; effect: string }>) {
	const synthetics: Array<Record<string, unknown>> = []
	const hooks = new Map<string, (input: any) => unknown>()
	const ctx = {
		location: { directory: process.cwd(), project: { id: "p" } },
		storage: { get: async () => undefined, set: async () => undefined, remove: async () => undefined },
		agent: { list: async () => ({ data: [{ id: "sisyphus", permissions }] }) },
		session: {
			get: async ({ sessionID }: { sessionID: string }) => ({ id: sessionID, agent: "sisyphus" }),
			synthetic: async (input: Record<string, unknown>) => { synthetics.push(input) },
			hook: async (name: string, callback: (input: any) => unknown) => {
				hooks.set(name, callback)
				return { dispose: async () => { hooks.delete(name) } }
			},
		},
		event: { subscribe: ({ signal }: { signal: AbortSignal }) => (async function* () { await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true })) })() },
	}
	return { ctx: ctx as unknown as Plugin.Context, synthetics, hooks }
}

function tools(runtime: NonNullable<Awaited<ReturnType<typeof registerV2MonitorRuntime>>>): Map<string, Tool> {
	const map = new Map<string, Tool>()
	runtime.addTools({ add: (tool: Tool) => map.set(tool.name, tool) } as unknown as ToolEditor)
	return map
}

const context = { sessionID: "ses-root", agent: "sisyphus", messageID: "msg", id: "call", signal: new AbortController().signal, progress: async () => undefined } as unknown as ToolContext
const config = { monitor: { enabled: true, flush_interval_ms: 250, allowed_commands: ["sleep"] } } as unknown as OhMyOpenCodeConfig

describe("v2 monitor tools", () => {
	test("delivers filtered process output to the idle parent as untrusted monitor output", async () => {
		const h = harness([{ action: "shell", resource: "*", effect: "allow" }])
		const runtime = (await registerV2MonitorRuntime(h.ctx, config))!
		const map = tools(runtime)
		// Monitor commands are tokenized argv, not shell strings; emit the fixture from a script.
		const script = join(await mkdtemp(join(tmpdir(), "omo-v2-monitor-")), "emit.sh")
		await writeFile(script, "printf 'MON_KEEP one\\nMON_SKIP two\\nMON_KEEP three\\n'\n")
		const started = await map.get("monitor_start")!.execute({ command: `sh ${script}`, label: "fixture", match_pattern: "MON_KEEP" }, context)
		expect(started.content).toContain("Monitor started successfully.")
		const id = /monitor_id: (\S+)/.exec(started.content)![1]!
		const deadline = Date.now() + 5_000
		while (h.synthetics.length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50))
		const text = h.synthetics.map((call) => String(call.text)).join("\n")
		expect(text).toContain("[OMO MONITOR OUTPUT]")
		expect(text).toContain("stream_policy: untrusted_observation")
		expect(text).toContain("MON_KEEP one")
		expect(text).toContain("MON_KEEP three")
		expect(text).not.toContain("MON_SKIP")
		expect(h.synthetics[0]).toMatchObject({ sessionID: "ses-root", delivery: "queue", resume: true })
		const output = JSON.parse((await map.get("monitor_output")!.execute({ monitor_id: id, stream: "unmatched" }, context)).content)
		expect(JSON.stringify(output.lines)).toContain("MON_SKIP two")
		expect(JSON.parse((await map.get("monitor_output")!.execute({ monitor_id: id }, { ...context, sessionID: "ses-other" } as ToolContext)).content).error).toBe("not_found")
		await runtime.cleanup()
	})

	test("shell deny rejects, ask falls back to allowed_commands, and running monitors appear in context", async () => {
		const denied = harness([{ action: "shell", resource: "*", effect: "deny" }])
		const deniedRuntime = (await registerV2MonitorRuntime(denied.ctx, config))!
		expect((await tools(deniedRuntime).get("monitor_start")!.execute({ command: "sleep 5" }, context)).content).toContain("denied by the shell permission policy")
		await deniedRuntime.cleanup()

		const asked = harness([{ action: "shell", resource: "*", effect: "ask" }])
		const runtime = (await registerV2MonitorRuntime(asked.ctx, config))!
		const map = tools(runtime)
		expect((await map.get("monitor_start")!.execute({ command: "echo hi" }, context)).content).toContain("not in monitor.allowed_commands")
		const started = await map.get("monitor_start")!.execute({ command: "sleep 5", label: "waiter" }, context)
		const id = /monitor_id: (\S+)/.exec(started.content)![1]!
		const input = { sessionID: "ses-root", system: [] as Array<{ type: string; text: string }> }
		await asked.hooks.get("context")!(input)
		expect(input.system[0]!.text).toContain(`Active monitors: ${id} (waiter, running`)
		expect(JSON.parse((await map.get("monitor_stop")!.execute({ monitor_id: id }, context)).content).status).toBe("stopped")
		const after = { sessionID: "ses-root", system: [] as Array<{ type: string; text: string }> }
		await asked.hooks.get("context")!(after)
		expect(after.system).toEqual([])
		await runtime.cleanup()
		expect(await registerV2MonitorRuntime(asked.ctx, {} as OhMyOpenCodeConfig)).toBeUndefined()
	})
})
