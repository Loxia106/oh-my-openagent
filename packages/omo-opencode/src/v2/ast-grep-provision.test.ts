import { describe, expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin"
import type { OhMyOpenCodeConfig } from "../config"
import { clearAstGrepSgProvisionTargetsForTesting } from "../hooks/ast-grep-sg-provision/hook"
import { registerV2AstGrepProvision } from "./ast-grep-provision"

function events() {
	const queue: unknown[] = []
	let wake: (() => void) | undefined
	return {
		ctx: { event: { subscribe: ({ signal }: { signal: AbortSignal }) => (async function* () {
			while (!signal.aborted) {
				const next = queue.shift()
				if (next) { yield next as never; continue }
				await new Promise<void>((resolve) => { wake = resolve; signal.addEventListener("abort", () => resolve(), { once: true }) })
			}
		})() } } as unknown as Plugin.Context,
		emit(type: string) { queue.push({ type, data: { sessionID: "s" } }); wake?.() },
	}
}

describe("v2 ast-grep sg provisioning", () => {
	test("provisions a missing sg binary once on the first native session creation", async () => {
		clearAstGrepSgProvisionTargetsForTesting()
		const calls: string[] = []
		const h = events()
		const cleanup = await registerV2AstGrepProvision(h.ctx, {} as OhMyOpenCodeConfig, {
			homeDir: () => "/tmp/omo-sg-home",
			findSgBinary: () => null,
			provisionSgBinary: async (options) => { calls.push(options.targetDir); return `${options.targetDir}/sg` },
			schedule: (task) => { void task() },
			log: () => undefined,
		})
		h.emit("session.execution.started")
		h.emit("session.created")
		h.emit("session.created")
		await new Promise((resolve) => setTimeout(resolve, 20))
		expect(calls).toHaveLength(1)
		expect(calls[0]).toContain("/tmp/omo-sg-home/.omo")
		await cleanup()
	})

	test("skips an existing binary and honors disabled_hooks", async () => {
		clearAstGrepSgProvisionTargetsForTesting()
		const calls: string[] = []
		const present = events()
		const cleanup = await registerV2AstGrepProvision(present.ctx, {} as OhMyOpenCodeConfig, {
			homeDir: () => "/tmp/omo-sg-home-2",
			findSgBinary: () => "/usr/local/bin/sg",
			provisionSgBinary: async () => { calls.push("x"); return "x" },
			schedule: (task) => { void task() },
			log: () => undefined,
		})
		present.emit("session.created")
		await new Promise((resolve) => setTimeout(resolve, 20))
		await cleanup()
		const disabled = events()
		const cleanupDisabled = await registerV2AstGrepProvision(disabled.ctx, { disabled_hooks: ["ast-grep-sg-provision"] } as unknown as OhMyOpenCodeConfig, {
			findSgBinary: () => null,
			provisionSgBinary: async () => { calls.push("disabled"); return "x" },
			schedule: (task) => { void task() },
		})
		disabled.emit("session.created")
		await new Promise((resolve) => setTimeout(resolve, 20))
		await cleanupDisabled()
		expect(calls).toEqual([])
	})
})
