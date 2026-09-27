import { describe, expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin"
import type { SessionContext, SessionPrompt } from "@opencode/plugin/promise/session"
import type { OhMyOpenCodeConfig } from "../config"
import { createV2SubagentRunState } from "./task-state"
import { registerV2ThinkModeHook } from "./think-mode"

type Callback = (input: unknown) => unknown

function modelCatalog() {
	return [{
		providerID: "openai",
		id: "reasoner",
		variants: [{ id: "high", settings: { reasoningEffort: "high", parallelToolCalls: false } }],
	}]
}

function createHarness(options: {
	readonly model?: { providerID: string; id: string; variant?: string }
	readonly models?: ReturnType<typeof modelCatalog>
	readonly parentSessionID?: string
	readonly teamMetadata?: unknown
	readonly agentMode?: "primary" | "subagent" | "all"
	readonly modelList?: () => Promise<unknown>
} = {}) {
	const callbacks = new Map<string, Callback>()
	const disposed: string[] = []
	const storageValues = new Map<string, unknown>()
	const pendingEvents: Array<{ event: unknown; finish: () => void }> = []
	let eventWake: (() => void) | undefined
	let eventClosed = false
	const directory = process.cwd()
	const sessionID = "ses-think-primary"
	const session = {
		id: sessionID,
		agent: "sisyphus",
		projectID: "project-think",
		location: { directory },
		...(options.parentSessionID ? { parentID: options.parentSessionID } : {}),
		...(options.teamMetadata !== undefined ? { metadata: { omoTeam: options.teamMetadata } } : {}),
	}
	const storage = {
		get: async (key: string) => storageValues.get(key),
		set: async (key: string, value: unknown) => { storageValues.set(key, value) },
		remove: async (key: string) => { storageValues.delete(key) },
		scan: async () => ({ entries: [] }),
	}
	const ctx = {
		location: { directory, project: { id: "project-think" } },
		storage,
		session: {
			get: async ({ sessionID: requested }: { sessionID: string }) => {
				if (requested !== sessionID) throw new Error("unexpected session")
				return session
			},
			hook: async (name: string, callback: Callback) => {
				callbacks.set(name, callback)
				return { dispose: async () => { disposed.push(name) } }
			},
		},
		agent: {
			get: async () => ({ data: { id: "sisyphus", mode: options.agentMode ?? "primary" } }),
		},
		model: {
			list: options.modelList ?? (async () => ({ data: options.models ?? modelCatalog() })),
		},
		event: {
			subscribe: async function* ({ signal }: { signal: AbortSignal }) {
				const abort = () => {
					eventClosed = true
					eventWake?.()
				}
				signal.addEventListener("abort", abort, { once: true })
				try {
					while (!eventClosed) {
						const queued = pendingEvents.shift()
						if (queued) {
							yield queued.event as never
							queued.finish()
							continue
						}
						await new Promise<void>((resolve) => { eventWake = resolve })
					}
				} finally {
					signal.removeEventListener("abort", abort)
				}
			},
		},
	}
	return {
		ctx: ctx as unknown as Plugin.Context,
		callbacks,
		disposed,
		storage,
		sessionID,
		input(model = options.model ?? { providerID: "openai", id: "reasoner" }, messageID = "msg-static") {
			return {
				sessionID,
				agent: "sisyphus",
				model: { ...model },
				messages: [{ id: messageID, role: "user", content: "A real admitted prompt" }],
				system: [],
				tools: {},
				options: { reasoningEffort: "medium", retainedOption: "from-default" },
			} as unknown as SessionContext
		},
		prompt(text: string, messageID = "msg-static") {
			return {
				sessionID,
				messageID,
				prompt: { text },
				delivery: "sync",
			} as unknown as SessionPrompt
		},
		async emit(event: unknown) {
			let finish!: () => void
			const delivered = new Promise<void>((resolve) => { finish = resolve })
			pendingEvents.push({ event, finish })
			eventWake?.()
			await delivered
		},
	}
}

describe("native v2 think mode", () => {
	test("applies high settings over factory defaults for one real prompt without changing the selected model", async () => {
		const harness = createHarness()
		const cleanup = await registerV2ThinkModeHook(harness.ctx, {} as OhMyOpenCodeConfig)
		const selectedModel = { providerID: "openai", id: "reasoner" }

		await harness.callbacks.get("prompt")?.(harness.prompt("Think through this carefully."))
		const input = harness.input(selectedModel)
		await harness.callbacks.get("context")?.(input)

		expect(input.options).toEqual({
			reasoningEffort: "high",
			parallelToolCalls: false,
			retainedOption: "from-default",
		})
		expect(input.model).toEqual(selectedModel)
		await cleanup()
	})

	test("preserves a selected variant and explicit configured effort", async () => {
		const selected = createHarness({ model: { providerID: "openai", id: "reasoner", variant: "medium" } })
		const selectedCleanup = await registerV2ThinkModeHook(selected.ctx, {} as OhMyOpenCodeConfig)
		await selected.callbacks.get("prompt")?.(selected.prompt("Think carefully."))
		const selectedInput = selected.input()
		await selected.callbacks.get("context")?.(selectedInput)
		expect(selectedInput.options).toEqual({ reasoningEffort: "medium", retainedOption: "from-default" })
		await selectedCleanup()

		const configured = createHarness()
		const configuredCleanup = await registerV2ThinkModeHook(configured.ctx, {
			agents: { sisyphus: { reasoningEffort: "medium" } },
		} as unknown as OhMyOpenCodeConfig)
		await configured.callbacks.get("prompt")?.(configured.prompt("Think carefully."))
		const configuredInput = configured.input()
		await configured.callbacks.get("context")?.(configuredInput)
		expect(configuredInput.options).toEqual({ reasoningEffort: "medium", retainedOption: "from-default" })
		await configuredCleanup()
	})

	test("honors disabled hooks and non-primary agent modes", async () => {
		const disabled = createHarness()
		const disabledCleanup = await registerV2ThinkModeHook(disabled.ctx, { disabled_hooks: ["think-mode"] } as unknown as OhMyOpenCodeConfig)
		expect(disabled.callbacks.size).toBe(0)
		await disabledCleanup()

		const subagent = createHarness({ agentMode: "subagent" })
		const subagentCleanup = await registerV2ThinkModeHook(subagent.ctx, {} as OhMyOpenCodeConfig)
		await subagent.callbacks.get("prompt")?.(subagent.prompt("Think carefully."))
		const input = subagent.input()
		await subagent.callbacks.get("context")?.(input)
		expect(input.options).toEqual({ reasoningEffort: "medium", retainedOption: "from-default" })
		await subagentCleanup()
	})

	test("skips native and managed logical children without changing their settings", async () => {
		const nativeChild = createHarness({ parentSessionID: "ses-parent" })
		const nativeCleanup = await registerV2ThinkModeHook(nativeChild.ctx, {} as OhMyOpenCodeConfig)
		await nativeChild.callbacks.get("prompt")?.(nativeChild.prompt("Think carefully."))
		const nativeInput = nativeChild.input()
		await nativeChild.callbacks.get("context")?.(nativeInput)
		expect(nativeInput.options).toEqual({ reasoningEffort: "medium", retainedOption: "from-default" })
		await nativeCleanup()

		const logicalChild = createHarness()
		await createV2SubagentRunState(logicalChild.storage as never).recordLaunch(logicalChild.sessionID, {
			parentSessionID: "ses-team-lead",
			startedAt: Date.now(),
			status: "running",
			blockedActions: [],
		})
		const logicalCleanup = await registerV2ThinkModeHook(logicalChild.ctx, {} as OhMyOpenCodeConfig)
		await logicalChild.callbacks.get("prompt")?.(logicalChild.prompt("Think carefully."))
		const logicalInput = logicalChild.input()
		await logicalChild.callbacks.get("context")?.(logicalInput)
		expect(logicalInput.options).toEqual({ reasoningEffort: "medium", retainedOption: "from-default" })
		await logicalCleanup()
	})

	test("skips a recognized Team metadata hint after the managed run record is gone", async () => {
		const teamChild = createHarness({ teamMetadata: { version: 1, teamRunId: "team-after-parent-delete" } })
		const cleanup = await registerV2ThinkModeHook(teamChild.ctx, {} as OhMyOpenCodeConfig)
		await teamChild.callbacks.get("prompt")?.(teamChild.prompt("Think carefully."))
		const input = teamChild.input()
		await teamChild.callbacks.get("context")?.(input)
		expect(input.options).toEqual({ reasoningEffort: "medium", retainedOption: "from-default" })
		await cleanup()
	})

	test("does not apply a prompt keyword to a different latest native user message", async () => {
		const harness = createHarness()
		const cleanup = await registerV2ThinkModeHook(harness.ctx, {} as OhMyOpenCodeConfig)
		await harness.callbacks.get("prompt")?.(harness.prompt("Think carefully.", "msg-admitted"))
		const laterUserInput = harness.input(undefined, "msg-later")
		await harness.callbacks.get("context")?.(laterUserInput)
		expect(laterUserInput.options).toEqual({ reasoningEffort: "medium", retainedOption: "from-default" })
		await cleanup()
	})

	test("clears the admitted prompt on execution completion so the next turn resets", async () => {
		const harness = createHarness()
		const cleanup = await registerV2ThinkModeHook(harness.ctx, {} as OhMyOpenCodeConfig)
		await harness.callbacks.get("prompt")?.(harness.prompt("Think carefully."))
		const first = harness.input()
		await harness.callbacks.get("context")?.(first)
		expect(first.options.reasoningEffort).toBe("high")

		await harness.emit({ type: "session.execution.succeeded", data: { sessionID: harness.sessionID } })
		const second = harness.input()
		await harness.callbacks.get("context")?.(second)
		expect(second.options).toEqual({ reasoningEffort: "medium", retainedOption: "from-default" })
		await cleanup()
	})

	test("abandons a catalog lookup after a newer prompt replaces its record", async () => {
		let releaseCatalog!: (value: unknown) => void
		let signalCatalog!: () => void
		const catalogReady = new Promise<void>((resolve) => { signalCatalog = resolve })
		const harness = createHarness({
			modelList: async () => {
				signalCatalog()
				return new Promise((resolve) => { releaseCatalog = resolve })
			},
		})
		const cleanup = await registerV2ThinkModeHook(harness.ctx, {} as OhMyOpenCodeConfig)
		await harness.callbacks.get("prompt")?.(harness.prompt("Think carefully.", "msg-old"))
		const input = harness.input(undefined, "msg-old")
		const applying = harness.callbacks.get("context")?.(input)
		await catalogReady
		await harness.callbacks.get("prompt")?.(harness.prompt("Just summarize this.", "msg-new"))
		releaseCatalog({ data: modelCatalog() })
		await applying

		expect(input.options).toEqual({ reasoningEffort: "medium", retainedOption: "from-default" })
		await cleanup()
	})
})
