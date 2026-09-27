import { describe, expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin"
import type { OhMyOpenCodeConfig } from "../config"
import { normalizeV2FallbackConfig, registerV2RuntimeFallback, requirementFallbackModels } from "./runtime-fallback"

type Callback = (input: never) => unknown
type Model = { providerID: string; id: string; variant?: string }

function createHarness(options: {
	readonly sessionAgent?: string | null
	readonly sessionModel?: Model | null
	readonly parentID?: string
	readonly agentModel?: Model
	readonly agentGetFails?: boolean
	readonly hostDefault?: Model | null
	readonly enabledModels?: readonly string[]
	readonly disableBackupAfterInitialLookup?: boolean
	readonly logicalParent?: boolean
	readonly stopped?: boolean
	readonly extraModels?: readonly string[]
} = {}) {
	const directory = process.cwd()
	const sessionID = "ses-runtime-fallback"
	const projectID = "project-runtime-fallback"
	const primary = { providerID: "openai", id: "primary" }
	const backup = { providerID: "openai", id: "backup" }
	const callbacks = new Map<string, Callback>()
	const storageValues = new Map<string, unknown>()
	const modelSwitches: Model[] = []
	const syntheticCalls: unknown[] = []
	const interrupts: string[] = []
	const events: Array<{ event: unknown; finish: () => void }> = []
	let eventWake: (() => void) | undefined
	let streamClosed = false
	const history: unknown[] = [{ id: "msg-user-1", type: "user", role: "user", content: "Continue this request" }]
	const currentSession: Record<string, unknown> = {
		id: sessionID,
		projectID,
		location: { directory },
		...(options.sessionAgent === null ? {} : { agent: options.sessionAgent ?? "sisyphus" }),
		...(options.sessionModel === null ? {} : { model: options.sessionModel ?? primary }),
		...(options.parentID ? { parentID: options.parentID } : {}),
		outcome: "running",
		time: {},
	}
	const storage = {
		get: async (key: string) => storageValues.get(key),
		set: async (key: string, value: unknown) => { storageValues.set(key, value) },
		remove: async (key: string) => { storageValues.delete(key) },
		scan: async () => ({ entries: [] as Array<{ key: string; value: unknown }>, next: undefined as string | undefined }),
	}
	const modelCatalog = [primary, backup, ...(options.extraModels ?? []).map((id) => ({ providerID: "openai", id }))].map((model) => ({
		...model,
		enabled: options.enabledModels ? options.enabledModels.includes(model.id) : true,
		variants: [],
	}))
	let modelListCalls = 0
	const ctx = {
		location: { directory, project: { id: projectID }, workspaceID: undefined },
		storage,
		session: {
			get: async ({ sessionID: requested }: { sessionID: string }) => {
				if (requested !== sessionID) throw new Error("unexpected session")
				return currentSession
			},
			context: async ({ sessionID: requested }: { sessionID: string }) => {
				if (requested !== sessionID) throw new Error("unexpected session")
				return [...history]
			},
			switchModel: async ({ model }: { sessionID: string; model: Model }) => {
				modelSwitches.push(model)
				currentSession.model = model
			},
			synthetic: async (input: unknown) => { syntheticCalls.push(input) },
			interrupt: async ({ sessionID: requested }: { sessionID: string }) => { interrupts.push(requested) },
			hook: async (name: string, callback: Callback) => {
				callbacks.set(name, callback)
				return { dispose: async () => { callbacks.delete(name) } }
			},
		},
		agent: {
			list: async () => ({ data: [{ id: "sisyphus", mode: "primary", model: options.agentModel }] }),
			get: async ({ agentID }: { agentID: string }) => {
				if (options.agentGetFails) throw new Error("agent lookup failed")
				if (agentID !== "sisyphus") throw new Error("unknown agent")
				return { data: { id: "sisyphus", mode: "primary", model: options.agentModel } }
			},
		},
		model: {
			list: async () => {
				modelListCalls += 1
				return { data: modelCatalog.map((model) => ({
					...model,
					enabled: model.id === "backup" && options.disableBackupAfterInitialLookup && modelListCalls > 1
						? false
						: model.enabled,
				})) }
			},
			default: async () => ({ data: options.hostDefault === undefined ? primary : options.hostDefault }),
		},
		event: {
			subscribe: async function* ({ signal }: { signal: AbortSignal }) {
				const abort = () => { streamClosed = true; eventWake?.() }
				signal.addEventListener("abort", abort, { once: true })
				try {
					while (!streamClosed) {
						const queued = events.shift()
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
		currentSession,
		history,
		storageValues,
		modelSwitches,
		syntheticCalls,
		interrupts,
		sessionID,
		primary,
		backup,
		async emit(event: unknown) {
			let finish!: () => void
			const delivered = new Promise<void>((resolve) => { finish = resolve })
			events.push({ event, finish })
			eventWake?.()
			await delivered
		},
	}
}

const config = {
	runtime_fallback: { enabled: true, retry_on_errors: [429], max_fallback_attempts: 2, cooldown_seconds: 0 },
	agents: { sisyphus: { fallback_models: [{ model: "openai/backup", maxTokens: 317 }] } },
} as unknown as OhMyOpenCodeConfig

async function runFailure(options: {
	readonly sessionAgent?: string | null
	readonly sessionModel?: Model | null
	readonly parentID?: string
	readonly agentModel?: Model
	readonly agentGetFails?: boolean
	readonly hostDefault?: Model | null
	readonly enabledModels?: readonly string[]
	readonly disableBackupAfterInitialLookup?: boolean
	readonly logicalParent?: boolean
	readonly stopped?: boolean
	readonly kind?: "primary" | "title" | "compaction" | "generate"
	readonly responseStatus?: number
	readonly missingResponse?: boolean
	readonly errorType?: string
	readonly errorStatus?: number
	readonly eventCreated?: number
	readonly seq?: number
	readonly requestModel?: Model
	readonly omitUserBeforeFailure?: boolean
	readonly config?: OhMyOpenCodeConfig
	readonly extraModels?: readonly string[]
} = {}) {
	const harness = createHarness(options)
	const cleanup = await registerV2RuntimeFallback(harness.ctx, options.config ?? config, {
		resolveLogicalParent: async () => options.logicalParent === true ? "ses-logical-parent" : undefined,
		isStopped: async () => options.stopped === true,
	})
	const modelRequest = harness.callbacks.get("model.request")
	if (!modelRequest) return { ...harness, cleanup, requestedAt: 0 }
	const requestedAt = Date.now()
	await modelRequest({
		sessionID: harness.sessionID,
		agent: "sisyphus",
		model: options.requestModel ?? harness.primary,
		kind: options.kind ?? "primary",
		headers: {},
	} as never)
	const response = harness.callbacks.get("http.response")
	if (response && !options.missingResponse) {
		await response({
			sessionID: harness.sessionID,
			agent: "sisyphus",
			model: options.requestModel ?? harness.primary,
			kind: options.kind ?? "primary",
			request: new Request("http://localhost/model"),
			response: new Response(null, { status: options.responseStatus ?? 429 }),
		} as never)
	}
	const errorType = options.errorType ?? "provider.rate-limit"
	const errorStatus = options.errorStatus ?? 429
	const eventCreated = options.eventCreated ?? Date.now() + 2
	harness.currentSession.outcome = "failed"
	;(harness.currentSession.time as Record<string, unknown>).idle = Math.max(eventCreated + 1, requestedAt + 1)
	if (options.omitUserBeforeFailure) harness.history.splice(0, 1)
	harness.history.push({
		id: "msg-assistant-failed",
		type: "assistant",
		agent: "sisyphus",
		model: options.requestModel ?? harness.primary,
		error: { type: errorType, status: errorStatus, message: "Fixture provider failure" },
	})
	await harness.emit({
		id: "evt-failed-1",
		type: "session.execution.failed",
		created: eventCreated,
		durable: { aggregateID: harness.sessionID, seq: options.seq ?? 1 },
		data: { sessionID: harness.sessionID, error: { type: errorType, status: errorStatus, message: "Fixture provider failure" } },
	})
	return { ...harness, cleanup, requestedAt }
}

function registeredFallbacks(storageValues: Map<string, unknown>): Array<Record<string, unknown>> {
	return [...storageValues.values()].filter((value): value is Record<string, unknown> =>
		typeof value === "object" && value !== null && "lastFailureEventID" in value,
	)
}

describe("native v2 runtime fallback", () => {
	test("recovers an attributed primary provider 429 using the current configured candidate", async () => {
		const harness = await runFailure({ sessionAgent: null, sessionModel: null })
		expect((harness.currentSession.model as Model).id).toBe("backup")
		expect(harness.modelSwitches).toEqual([{ providerID: "openai", id: "backup" }])
		expect(harness.syntheticCalls).toHaveLength(1)
		expect(harness.syntheticCalls[0]).toMatchObject({
			id: expect.any(String),
			delivery: "steer",
			resume: true,
			metadata: { omoRuntimeFallback: { eventID: "evt-failed-1", attempt: 1 } },
		})
		expect(registeredFallbacks(harness.storageValues)).toHaveLength(1)
		const record = registeredFallbacks(harness.storageValues)[0]!
		expect(record).toMatchObject({
			phase: "active",
			failureType: "provider.rate-limit",
			currentModel: { providerID: "openai", id: "backup" },
			currentSettings: { maxTokens: 317 },
		})
		const context = harness.callbacks.get("context")
		const options = { maxTokens: 1024 }
		await context?.({
			sessionID: harness.sessionID,
			agent: "sisyphus",
			model: harness.backup,
			messages: [], system: [], tools: {}, options,
		} as never)
		expect(options).toEqual({ maxTokens: 317 })
		await harness.cleanup()
	})

	test("uses the resolved agent model before the host default when session model is absent", async () => {
		const harness = await runFailure({
			sessionModel: null,
			agentModel: { providerID: "openai", id: "primary" },
			hostDefault: { providerID: "openai", id: "not-primary" },
		})
		expect((harness.currentSession.model as Model).id).toBe("backup")
		await harness.cleanup()
	})

	test("does not recover from auxiliary, non-provider, nonconfigured, or nested errors after a successful HTTP request", async () => {
		for (const options of [
			{ kind: "title" as const, responseStatus: 429 },
			{ kind: "compaction" as const, responseStatus: 429 },
			{ missingResponse: true },
			{ responseStatus: 429, errorType: "tool.execution", errorStatus: 429 },
			{ responseStatus: 500, errorType: "provider.internal", errorStatus: 500 },
			{ responseStatus: 200, errorType: "provider.rate-limit", errorStatus: 429 },
		]) {
			const harness = await runFailure(options)
			expect((harness.currentSession.model as Model).id).toBe("primary")
			expect(harness.modelSwitches).toHaveLength(0)
			expect(harness.syntheticCalls).toHaveLength(0)
			expect(registeredFallbacks(harness.storageValues)).toHaveLength(0)
			await harness.cleanup()
		}
	})

	test("rejects stale event times, mismatched identities, children, stopped sessions, and disabled fallback models", async () => {
		const cases = [
			{ eventCreated: 1 },
			{ sessionAgent: "other-agent" },
			{ parentID: "ses-parent" },
			{ logicalParent: true },
			{ stopped: true },
			{ enabledModels: ["primary"] },
			{ requestModel: { providerID: "openai", id: "not-primary" } },
			{ sessionAgent: null, sessionModel: null, agentGetFails: true },
		]
		for (const options of cases) {
			const harness = await runFailure(options)
			if (options.sessionModel === null) expect(harness.currentSession.model).toBeUndefined()
			else expect((harness.currentSession.model as Model).id).toBe("primary")
			expect(harness.modelSwitches).toHaveLength(0)
			expect(harness.syntheticCalls).toHaveLength(0)
			expect(registeredFallbacks(harness.storageValues)).toHaveLength(0)
			await harness.cleanup()
		}
		const withdrawnCandidate = await runFailure({ disableBackupAfterInitialLookup: true })
		expect((withdrawnCandidate.currentSession.model as Model).id).toBe("primary")
		expect(withdrawnCandidate.modelSwitches).toHaveLength(0)
		expect(withdrawnCandidate.syntheticCalls).toHaveLength(0)
		expect(registeredFallbacks(withdrawnCandidate.storageValues)[0]?.phase).toBe("pending")
		await withdrawnCandidate.cleanup()
	})

	test("fails closed when compacted history no longer contains the captured user message", async () => {
		const harness = await runFailure({ omitUserBeforeFailure: true })
		expect((harness.currentSession.model as Model).id).toBe("primary")
		expect(harness.modelSwitches).toHaveLength(0)
		expect(harness.syntheticCalls).toHaveLength(0)
		expect(registeredFallbacks(harness.storageValues)).toHaveLength(0)
		await harness.cleanup()
	})

	test("is opt-in and respects the runtime-fallback disabled hook", async () => {
		for (const disabledConfig of [
			{} as OhMyOpenCodeConfig,
			{ ...config, disabled_hooks: ["runtime-fallback"] } as unknown as OhMyOpenCodeConfig,
		]) {
			const harness = createHarness()
			const cleanup = await registerV2RuntimeFallback(harness.ctx, disabledConfig)
			expect(harness.callbacks.size).toBe(0)
			await cleanup()
		}
	})

	test("legacy model_fallback mode recovers with the explicit chain and runtime_fallback takes precedence", async () => {
		const modelConfig = { model_fallback: true, agents: { sisyphus: { fallback_models: ["openai/backup"] } } } as unknown as OhMyOpenCodeConfig
		expect(normalizeV2FallbackConfig(modelConfig)).toMatchObject({ mode: "model", cooldown_seconds: 0 })
		expect(normalizeV2FallbackConfig({ ...modelConfig, disabled_hooks: ["model-fallback"] } as unknown as OhMyOpenCodeConfig)).toBeUndefined()
		expect(normalizeV2FallbackConfig({ ...config, model_fallback: true } as unknown as OhMyOpenCodeConfig)).toMatchObject({ mode: "runtime", timeout_ms: 30_000 })
		const harness = await runFailure({ config: modelConfig, responseStatus: 529, errorType: "provider.overloaded", errorStatus: 529 })
		expect(harness.modelSwitches).toEqual([{ providerID: "openai", id: "backup" }])
		expect(harness.syntheticCalls).toHaveLength(1)
		await harness.cleanup()
		const runtimeOnly = await runFailure({ responseStatus: 529, errorType: "provider.overloaded", errorStatus: 529 })
		expect(runtimeOnly.modelSwitches).toHaveLength(0)
		await runtimeOnly.cleanup()
	})

	test("model_fallback derives the built-in agent requirement chain when no fallback_models are configured", async () => {
		const chain = requirementFallbackModels("sisyphus")
		expect(chain?.length).toBeGreaterThan(0)
		expect(chain!.every((entry) => typeof entry.model === "string" && entry.model.includes("/"))).toBe(true)
		expect(requirementFallbackModels("not-an-omo-agent")).toBeUndefined()
		// None of the requirement providers exist in this catalog, so no model is invented.
		const harness = await runFailure({ config: { model_fallback: true } as unknown as OhMyOpenCodeConfig })
		expect(harness.modelSwitches).toHaveLength(0)
		await harness.cleanup()
	})

	test("stops host retries early only when a verified primary request has a usable fallback", async () => {
		const harness = createHarness()
		const cleanup = await registerV2RuntimeFallback(harness.ctx, config)
		const retry = harness.callbacks.get("retry")
		expect(retry).toBeDefined()
		await harness.callbacks.get("model.request")!({ sessionID: harness.sessionID, agent: "sisyphus", model: harness.primary, kind: "primary", headers: {} } as never)
		await harness.callbacks.get("http.response")!({ sessionID: harness.sessionID, agent: "sisyphus", model: harness.primary, kind: "primary", request: new Request("http://localhost/m"), response: new Response(null, { status: 429 }) } as never)
		const input = { sessionID: harness.sessionID, agent: "sisyphus", model: harness.primary, error: { type: "provider.rate-limit", status: 429, message: "slow down" }, attempt: 1, decision: { retry: true, delay: 1000 } }
		await retry!(input as never)
		expect(input.decision).toEqual({ retry: false })
		const nonRetryable = { ...input, error: { type: "provider.invalid-request", status: 400, message: "bad" }, decision: { retry: true, delay: 1000 } }
		await retry!(nonRetryable as never)
		expect(nonRetryable.decision).toEqual({ retry: true, delay: 1000 })
		await cleanup()

		const noChain = createHarness()
		const cleanupNoChain = await registerV2RuntimeFallback(noChain.ctx, { runtime_fallback: { enabled: true, retry_on_errors: [429] } } as unknown as OhMyOpenCodeConfig)
		await noChain.callbacks.get("model.request")!({ sessionID: noChain.sessionID, agent: "sisyphus", model: noChain.primary, kind: "primary", headers: {} } as never)
		await noChain.callbacks.get("http.response")!({ sessionID: noChain.sessionID, agent: "sisyphus", model: noChain.primary, kind: "primary", request: new Request("http://localhost/m"), response: new Response(null, { status: 429 }) } as never)
		const kept = { ...input, decision: { retry: true, delay: 1000 } }
		await noChain.callbacks.get("retry")!(kept as never)
		expect(kept.decision).toEqual({ retry: true, delay: 1000 })
		await cleanupNoChain()

		const disabled = createHarness()
		const cleanupDisabled = await registerV2RuntimeFallback(disabled.ctx, { ...config, runtime_fallback: { ...(config.runtime_fallback as object), timeout_seconds: 0 } } as unknown as OhMyOpenCodeConfig)
		expect(disabled.callbacks.has("retry")).toBe(false)
		await cleanupDisabled()
	})

	test("a silent fallback is interrupted after timeout_seconds and the next candidate continues the same request", async () => {
		const timeoutConfig = {
			runtime_fallback: { enabled: true, retry_on_errors: [429], max_fallback_attempts: 3, cooldown_seconds: 0, timeout_seconds: 0.05 },
			agents: { sisyphus: { fallback_models: ["openai/backup", "openai/backup2"] } },
		} as unknown as OhMyOpenCodeConfig
		const harness = await runFailure({ config: timeoutConfig, extraModels: ["backup2"] })
		expect(harness.modelSwitches).toEqual([{ providerID: "openai", id: "backup" }])
		await new Promise((resolve) => setTimeout(resolve, 120))
		expect(harness.interrupts).toEqual([harness.sessionID])
		harness.currentSession.outcome = "interrupted"
		await harness.emit({ id: "evt-int", type: "session.execution.interrupted", created: Date.now(), data: { sessionID: harness.sessionID } })
		await new Promise((resolve) => setTimeout(resolve, 20))
		expect(harness.modelSwitches).toEqual([{ providerID: "openai", id: "backup" }, { providerID: "openai", id: "backup2" }])
		expect(harness.syntheticCalls).toHaveLength(2)
		expect(harness.syntheticCalls[1]).toMatchObject({ resume: true, metadata: { omoRuntimeFallback: { reason: "timeout" } } })
		expect(registeredFallbacks(harness.storageValues)[0]).toMatchObject({ phase: "active", currentModel: { id: "backup2" } })
		await harness.cleanup()

		const progressing = await runFailure({ config: timeoutConfig, extraModels: ["backup2"] })
		await progressing.emit({ id: "evt-stream", type: "session.step.streamed", created: Date.now() + 5, data: { sessionID: progressing.sessionID } })
		await new Promise((resolve) => setTimeout(resolve, 120))
		expect(progressing.interrupts).toEqual([])
		await progressing.cleanup()
	})
})

