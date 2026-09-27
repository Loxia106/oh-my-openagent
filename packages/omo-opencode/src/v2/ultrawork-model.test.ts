import { describe, expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin"
import type { OhMyOpenCodeConfig } from "../config"
import { getV2SubagentRunState } from "./task-state"
import { isV2UltraworkPrompt, registerV2UltraworkModelOverride, resolveV2UltraworkTarget } from "./ultrawork-model"

type Model = { providerID: string; id: string; variant?: string }

function harness(options: { parentID?: string; models?: Array<{ providerID: string; id: string; variants?: Array<{ id: string }>; enabled?: boolean }> } = {}) {
	const directory = process.cwd()
	const storage = new Map<string, unknown>()
	const hooks = new Map<string, (input: any) => unknown>()
	const switches: Model[] = []
	const session: Record<string, unknown> = {
		id: "ses-ulw",
		agent: "sisyphus",
		model: { providerID: "omoqa", id: "qa-model" },
		projectID: "project",
		location: { directory },
		...(options.parentID ? { parentID: options.parentID } : {}),
	}
	const queue: unknown[] = []
	let wake: (() => void) | undefined
	const ctx = {
		location: { directory, project: { id: "project" } },
		storage: {
			get: async (key: string) => storage.get(key),
			set: async (key: string, value: unknown) => { storage.set(key, value) },
			remove: async (key: string) => { storage.delete(key) },
		},
		session: {
			get: async () => session,
			switchModel: async ({ model }: { model: Model }) => { switches.push(model); session.model = model },
			hook: async (name: string, callback: (input: any) => unknown) => {
				hooks.set(name, callback)
				return { dispose: async () => { hooks.delete(name) } }
			},
		},
		agent: { get: async () => ({ data: { model: undefined } }) },
		model: {
			list: async () => ({ data: (options.models ?? [
				{ providerID: "omoqa", id: "qa-model", variants: [{ id: "high" }] },
				{ providerID: "omoqa", id: "qa-ultra", variants: [{ id: "max" }] },
			]).map((model) => ({ enabled: true, variants: [], ...model })) }),
			default: async () => ({ data: null }),
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
		hooks,
		switches,
		session,
		storage,
		emit(event: unknown) { queue.push(event); wake?.() },
	}
}

const config = { agents: { sisyphus: { ultrawork: { model: "omoqa/qa-ultra", variant: "max" } } } } as unknown as OhMyOpenCodeConfig
const settle = () => new Promise((resolve) => setTimeout(resolve, 30))

describe("v2 ultrawork model override", () => {
	test("detects explicit ultrawork turns outside code, directives and slash commands", () => {
		expect(isV2UltraworkPrompt("ulw fix the parser")).toBe(true)
		expect(isV2UltraworkPrompt("please use `ultrawork` literally")).toBe(false)
		expect(isV2UltraworkPrompt("/refactor ulw")).toBe(false)
		expect(resolveV2UltraworkTarget(config, "sisyphus", { providerID: "omoqa", id: "qa-model" })).toEqual({ providerID: "omoqa", id: "qa-ultra", variant: "max" })
		expect(resolveV2UltraworkTarget({ agents: { sisyphus: { ultrawork: { variant: "high" } } } } as unknown as OhMyOpenCodeConfig, "sisyphus", { providerID: "omoqa", id: "qa-model" }))
			.toEqual({ providerID: "omoqa", id: "qa-model", variant: "high" })
		expect(resolveV2UltraworkTarget(config, "atlas", { providerID: "omoqa", id: "qa-model" })).toBeUndefined()
	})

	test("switches an ultrawork turn to the configured model and restores it when that execution ends", async () => {
		const h = harness()
		const cleanup = await registerV2UltraworkModelOverride(h.ctx, config)
		await h.hooks.get("prompt")!({ sessionID: "ses-ulw", messageID: "msg-1", prompt: { text: "ulw implement the fix" } })
		expect(h.switches).toEqual([{ providerID: "omoqa", id: "qa-ultra", variant: "max" }])
		await h.hooks.get("prompt")!({ sessionID: "ses-ulw", messageID: "msg-2", prompt: { text: "a normal follow-up" } })
		expect(h.switches).toHaveLength(1)
		h.emit({ type: "session.execution.succeeded", created: Date.now() + 5, data: { sessionID: "ses-ulw" } })
		await settle()
		expect(h.switches).toEqual([{ providerID: "omoqa", id: "qa-ultra", variant: "max" }, { providerID: "omoqa", id: "qa-model" }])
		expect([...h.storage.keys()].filter((key) => key.includes("ultrawork-model"))).toEqual([])
		await cleanup()
	})

	test("does not restore when the user changed the model during the turn", async () => {
		const h = harness()
		const cleanup = await registerV2UltraworkModelOverride(h.ctx, config)
		await h.hooks.get("prompt")!({ sessionID: "ses-ulw", messageID: "msg-1", prompt: { text: "ultrawork now" } })
		h.session.model = { providerID: "omoqa", id: "user-picked" }
		h.emit({ type: "session.execution.failed", created: Date.now() + 5, data: { sessionID: "ses-ulw" } })
		await settle()
		expect(h.switches).toHaveLength(1)
		await cleanup()
	})

	test("skips children, managed runs, unavailable targets and unconfigured agents", async () => {
		const child = harness({ parentID: "ses-parent" })
		const cleanupChild = await registerV2UltraworkModelOverride(child.ctx, config)
		await child.hooks.get("prompt")!({ sessionID: "ses-ulw", messageID: "m", prompt: { text: "ulw" } })
		expect(child.switches).toEqual([])
		await cleanupChild()

		const managed = harness()
		await getV2SubagentRunState(managed.ctx.storage).recordLaunch("ses-ulw", { parentSessionID: "ses-team-lead", startedAt: 1, status: "running", blockedActions: [] })
		const cleanupManaged = await registerV2UltraworkModelOverride(managed.ctx, config)
		await managed.hooks.get("prompt")!({ sessionID: "ses-ulw", messageID: "m", prompt: { text: "ulw" } })
		expect(managed.switches).toEqual([])
		await cleanupManaged()

		const missing = harness({ models: [{ providerID: "omoqa", id: "qa-model" }] })
		const cleanupMissing = await registerV2UltraworkModelOverride(missing.ctx, config)
		await missing.hooks.get("prompt")!({ sessionID: "ses-ulw", messageID: "m", prompt: { text: "ulw" } })
		expect(missing.switches).toEqual([])
		await cleanupMissing()

		const none = harness()
		await (await registerV2UltraworkModelOverride(none.ctx, {} as OhMyOpenCodeConfig))()
		expect(none.hooks.size).toBe(0)
	})
})
