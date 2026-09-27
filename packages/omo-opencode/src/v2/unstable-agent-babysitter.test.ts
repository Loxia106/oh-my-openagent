import { describe, expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin"
import type { OhMyOpenCodeConfig } from "../config"
import { getV2SubagentRunState } from "./task-state"
import { buildV2BabysitterReminder, isV2UnstableChild, registerV2UnstableAgentBabysitter } from "./unstable-agent-babysitter"

function harness(childModel = "gemini-3-pro") {
	const directory = process.cwd()
	const storage = new Map<string, unknown>()
	const synthetics: Array<Record<string, unknown>> = []
	const queue: unknown[] = []
	let wake: (() => void) | undefined
	const sessions: Record<string, Record<string, unknown>> = {
		"ses-parent": { id: "ses-parent", agent: "sisyphus", projectID: "p", location: { directory } },
		"ses-child": { id: "ses-child", parentID: "ses-parent", agent: "sisyphus-junior", title: "Long research", model: { providerID: "google", id: childModel }, projectID: "p", location: { directory } },
	}
	const ctx = {
		location: { directory, project: { id: "p" } },
		storage: {
			get: async (key: string) => storage.get(key),
			set: async (key: string, value: unknown) => { storage.set(key, value) },
			remove: async (key: string) => { storage.delete(key) },
		},
		session: {
			get: async ({ sessionID }: { sessionID: string }) => {
				const session = sessions[sessionID]
				if (!session) throw new Error("missing")
				return session
			},
			context: async ({ sessionID }: { sessionID: string }) => sessionID === "ses-child"
				? [{ type: "assistant", content: [{ type: "reasoning", text: "Still comparing the two API versions" }] }]
				: [{ type: "assistant", content: [{ type: "text", text: "Waiting for research." }] }],
			synthetic: async (input: Record<string, unknown>) => { synthetics.push(input) },
		},
		event: {
			subscribe: ({ signal }: { signal: AbortSignal }) => (async function* () {
				while (!signal.aborted) {
					const next = queue.shift()
					if (next) { yield next as never; continue }
					await new Promise<void>((resolve) => { wake = resolve; signal.addEventListener("abort", () => resolve(), { once: true }) })
				}
			})(),
		},
	}
	return {
		ctx: ctx as unknown as Plugin.Context,
		synthetics,
		emit(type: string, sessionID: string) { queue.push({ type, created: Date.now(), data: { sessionID } }); wake?.() },
	}
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe("v2 unstable agent babysitter", () => {
	test("classifies unstable children by category flag first, then Gemini/MiniMax models", () => {
		expect(isV2UnstableChild({} as OhMyOpenCodeConfig, "gemini-3-pro", undefined)).toBe(true)
		expect(isV2UnstableChild({} as OhMyOpenCodeConfig, "MiniMax-M3", undefined)).toBe(true)
		expect(isV2UnstableChild({} as OhMyOpenCodeConfig, "claude-opus-5-5", undefined)).toBe(false)
		expect(isV2UnstableChild({ categories: { research: { is_unstable_agent: true } } } as unknown as OhMyOpenCodeConfig, "claude-opus-5-5", "research")).toBe(true)
		expect(isV2UnstableChild({ categories: { research: { is_unstable_agent: false } } } as unknown as OhMyOpenCodeConfig, "gemini-3-pro", "research")).toBe(false)
		expect(buildV2BabysitterReminder({ childID: "ses-c", agent: "a", description: "d", idleMs: 150_000, summary: undefined }))
			.toContain('background_output task_id="ses-c"')
	})

	test("reminds an idle root once about a silent unstable background child, then respects the cooldown", async () => {
		const h = harness()
		await getV2SubagentRunState(h.ctx.storage).recordLaunch("ses-child", { parentSessionID: "ses-parent", startedAt: Date.now(), status: "running", blockedActions: [] })
		const cleanup = await registerV2UnstableAgentBabysitter(h.ctx, {} as OhMyOpenCodeConfig, { timeoutMs: 60, cooldownMs: 10_000 })
		h.emit("session.execution.started", "ses-parent")
		h.emit("session.execution.succeeded", "ses-parent")
		await wait(160)
		expect(h.synthetics).toHaveLength(1)
		expect(h.synthetics[0]).toMatchObject({ sessionID: "ses-parent", resume: true, metadata: { omoUnstableAgentBabysitter: { childID: "ses-child" } } })
		expect(String(h.synthetics[0]!.text)).toContain("Still comparing the two API versions")
		expect(String(h.synthetics[0]!.text)).toContain("Long research")
		h.emit("session.execution.started", "ses-parent")
		h.emit("session.execution.succeeded", "ses-parent")
		await wait(120)
		expect(h.synthetics).toHaveLength(1)
		await cleanup()
	})

	test("child activity, stable models, cancelled parents and disabled_hooks suppress reminders", async () => {
		const active = harness()
		await getV2SubagentRunState(active.ctx.storage).recordLaunch("ses-child", { parentSessionID: "ses-parent", startedAt: Date.now(), status: "running", blockedActions: [] })
		const cleanupActive = await registerV2UnstableAgentBabysitter(active.ctx, {} as OhMyOpenCodeConfig, { timeoutMs: 120 })
		active.emit("session.execution.succeeded", "ses-parent")
		for (let index = 0; index < 5; index++) {
			await wait(40)
			active.emit("session.text.delta", "ses-child")
		}
		expect(active.synthetics).toHaveLength(0)
		await cleanupActive()

		const stable = harness("claude-opus-5-5")
		await getV2SubagentRunState(stable.ctx.storage).recordLaunch("ses-child", { parentSessionID: "ses-parent", startedAt: Date.now() - 1_000, status: "running", blockedActions: [] })
		const cleanupStable = await registerV2UnstableAgentBabysitter(stable.ctx, {} as OhMyOpenCodeConfig, { timeoutMs: 10 })
		stable.emit("session.execution.succeeded", "ses-parent")
		await wait(80)
		expect(stable.synthetics).toHaveLength(0)
		await cleanupStable()

		const cancelled = harness()
		await getV2SubagentRunState(cancelled.ctx.storage).recordLaunch("ses-child", { parentSessionID: "ses-parent", startedAt: Date.now() - 1_000, status: "running", blockedActions: [] })
		const cleanupCancelled = await registerV2UnstableAgentBabysitter(cancelled.ctx, {} as OhMyOpenCodeConfig, { timeoutMs: 10 })
		cancelled.emit("session.execution.interrupted", "ses-parent")
		await wait(80)
		expect(cancelled.synthetics).toHaveLength(0)
		await cleanupCancelled()

		const disabled = harness()
		const cleanupDisabled = await registerV2UnstableAgentBabysitter(disabled.ctx, { disabled_hooks: ["unstable-agent-babysitter"] } as unknown as OhMyOpenCodeConfig)
		await cleanupDisabled()
	})
})
