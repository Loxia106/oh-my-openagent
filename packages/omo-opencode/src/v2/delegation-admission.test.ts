import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Error as ToolError, type ToolContext } from "@opencode/plugin/promise/tool"
import type { Plugin } from "@opencode/plugin"
import type { OhMyOpenCodeConfig } from "../config"
import { resolveV2SubagentModel, resolveV2ManagedAgentModelChoice } from "./delegation-admission"
import { createV2DelegationAdmission } from "./delegation-admission"
import { createV2SubagentRunState } from "./task-state"

type FakeSession = Record<string, unknown>
type FakeAgent = Record<string, unknown> & { id: string; mode: string }
type FakeModel = Record<string, unknown> & { providerID: string; id: string; enabled: boolean; variants: Array<{ id: string }> }

function harness(input: {
	agents?: FakeAgent[]
	models?: FakeModel[]
	defaultModel?: FakeModel | null
	sessions?: Record<string, FakeSession>
} = {}) {
	const sessions = new Map<string, FakeSession>(Object.entries({
		"ses-parent": {
			id: "ses-parent",
			agent: "parent",
			model: { providerID: "host", id: "parent-model" },
			location: { directory: "/repo" },
		},
		...input.sessions,
	}))
	const models = input.models ?? [
		{ providerID: "host", id: "parent-model", enabled: true, variants: [] },
		{ providerID: "agent-provider", id: "agent-model", enabled: true, variants: [] },
		{ providerID: "stored-provider", id: "stored-model", enabled: true, variants: [] },
		{ providerID: "override-provider", id: "override-model", enabled: true, variants: [{ id: "high" }] },
		{ providerID: "openrouter", id: "org/model/path", enabled: true, variants: [{ id: "high" }] },
	]
	const ctx = {
		agent: {
			list: async () => ({ data: input.agents ?? [
				{ id: "target", mode: "subagent", model: { providerID: "agent-provider", id: "agent-model" } },
				{ id: "other", mode: "subagent", model: { providerID: "override-provider", id: "override-model" } },
				{ id: "primary", mode: "primary" },
			] }),
		},
		model: {
			list: async () => ({ data: models }),
			default: async () => ({ data: input.defaultModel ?? models.find((model) => model.providerID === "host") ?? null }),
		},
		session: {
			get: async ({ sessionID }: { sessionID: string }) => {
				const session = sessions.get(sessionID)
				if (!session) throw new Error(`Unknown session ${sessionID}`)
				return session
			},
		},
	} as unknown as Plugin.Context
	return { ctx, sessions }
}

function fallbackWrapperHarness(options: {
	background?: boolean
	responseStatus?: number
	errorSessionID?: string
	appendAssistantAfterFailure?: boolean
	failWitnessWriteOnce?: boolean
	stopped?: boolean
	hang?: boolean
	progressBeforeWatchdog?: boolean
} = {}) {
	const directory = process.cwd()
	const projectID = "project-fallback-wrapper"
	const parentSessionID = "ses-fallback-parent"
	const childSessionID = "ses-fallback-child"
	const primary = { providerID: "openai", id: "primary" }
	const backup = { providerID: "openai", id: "backup" }
	const sessions = new Map<string, Record<string, any>>([
		[parentSessionID, {
			id: parentSessionID,
			projectID,
			location: { directory },
			agent: "sisyphus",
			model: primary,
			outcome: "succeeded",
			time: { created: 1, updated: 1, idle: 1 },
		}],
	])
	const histories = new Map<string, unknown[]>([[parentSessionID, []]])
	const hookCallbacks = new Map<string, (event: unknown) => unknown>()
	const interrupts: string[] = []
	const storageValues = new Map<string, unknown>()
	let failWitnessWriteOnce = options.failWitnessWriteOnce === true
	let stopped = options.stopped === true
	let eventSequence = 0
	const storage = {
		get: async (key: string) => storageValues.get(key),
		set: async (key: string, value: unknown) => {
			if (failWitnessWriteOnce && key.includes("delegation-settings") &&
				typeof value === "object" && value !== null && "failureWitness" in value) {
				failWitnessWriteOnce = false
				throw new Error("fixture storage write failed")
			}
			storageValues.set(key, structuredClone(value))
		},
		remove: async (key: string) => { storageValues.delete(key) },
		scan: async ({ prefix, after, limit = 100 }: { prefix: string; after?: string; limit?: number }) => {
			const keys = [...storageValues.keys()].filter((key) => key.startsWith(prefix)).sort().filter((key) => !after || key > after)
			const page = keys.slice(0, limit)
			return {
				entries: page.map((key) => ({ key, value: storageValues.get(key) })),
				...(keys.length > page.length ? { next: page[page.length - 1] } : {}),
			}
		},
	}
	const models = [
		{ ...primary, enabled: true, variants: [] },
		{ ...backup, enabled: true, variants: [] },
	]
	const ctx = {
		location: { directory, project: { id: projectID }, workspaceID: undefined },
		storage,
		agent: {
			list: async () => ({ data: [{ id: "explore", mode: "subagent", model: primary }] }),
		},
		model: {
			list: async () => ({ data: models }),
			default: async () => ({ data: models[0] }),
		},
		session: {
			get: async ({ sessionID }: { sessionID: string }) => {
				const session = sessions.get(sessionID)
				if (!session) throw Object.assign(new Error(`missing ${sessionID}`), { _tag: "SessionNotFoundError", sessionID })
				return session
			},
			context: async ({ sessionID }: { sessionID: string }) => [...(histories.get(sessionID) ?? [])],
			interrupt: async ({ sessionID }: { sessionID: string }) => {
				interrupts.push(sessionID)
				const session = sessions.get(sessionID)
				if (session) {
					session.outcome = "interrupted"
					session.time.idle = Date.now() + 1
				}
			},
			hook: async (name: string, callback: (event: never) => unknown) => {
				hookCallbacks.set(name, callback as (event: unknown) => unknown)
				return { dispose: async () => { hookCallbacks.delete(name) } }
			},
		},
	} as unknown as Plugin.Context
	const runs = createV2SubagentRunState(storage as unknown as Plugin.Context["storage"])
	const admission = createV2DelegationAdmission({
		ctx,
		config: {
			runtime_fallback: { enabled: true, retry_on_errors: [429], max_fallback_attempts: 1, cooldown_seconds: 0 },
			agents: { explore: { model: "openai/primary", fallback_models: [{ model: "openai/backup", maxTokens: 317 }] } },
			background_task: { defaultConcurrency: 0 },
		} as unknown as OhMyOpenCodeConfig,
		runs,
		childSessions: new Map(),
		isAliasInvocation: () => false,
		isStopped: async () => stopped,
		childWatchdogMs: 60,
	})
	const invoked: Array<{ sessionID?: string; agent: string; model?: string; background?: boolean }> = []
	const ForeignToolFailure = Schema.TaggedError()("Tool.Error", { message: Schema.String })
	const originalExecute = async (rawInput: unknown, delegated: ToolContext): Promise<unknown> => {
		const input = rawInput as { agent: string; model?: string; sessionID?: string; background?: boolean }
		invoked.push({ sessionID: input.sessionID, agent: input.agent, model: input.model, background: input.background })
		const selectedModel = input.model === "openai/backup" ? backup : primary
		if (!input.sessionID) {
			const now = Date.now()
			sessions.set(childSessionID, {
				id: childSessionID,
				parentID: parentSessionID,
				projectID,
				location: { directory },
				agent: input.agent,
				model: selectedModel,
				outcome: "running",
				time: { created: now, updated: now, idle: now },
			})
			histories.set(childSessionID, [{ id: "msg-child-user-1", type: "user", role: "user", content: "Do the child task" }])
			await delegated.progress({ sessionID: childSessionID } as never)
			if (options.background) return { output: { sessionID: childSessionID, status: "running", output: "" }, content: "running" }
		} else {
			const child = sessions.get(childSessionID)!
			child.model = selectedModel
			child.outcome = "running"
			histories.get(childSessionID)!.push({ id: `msg-child-user-${invoked.length}`, type: "user", role: "user", content: "Continue the child task" })
			await delegated.progress({ sessionID: childSessionID } as never)
		}

		if (invoked.length > 1) {
			const child = sessions.get(childSessionID)!
			child.outcome = "succeeded"
			const idle = Date.now() + 10
			child.time.idle = idle
			child.time.updated = idle
			histories.get(childSessionID)!.push({
				id: "msg-child-fallback-done", type: "assistant", agent: input.agent, model: selectedModel,
				content: [{ type: "text", text: "CHILD_FALLBACK_OK" }],
			})
			return {
				output: { sessionID: childSessionID, status: "completed", output: "CHILD_FALLBACK_OK" },
				content: "<subagent sessionID=\"ses-fallback-child\" state=\"completed\">CHILD_FALLBACK_OK</subagent>",
				metadata: { sessionID: childSessionID, status: "completed" },
			}
		}
		if (options.hang) {
			const model = primary
			await hookCallbacks.get("model.request")?.({ sessionID: childSessionID, agent: "explore", model, kind: "primary" })
			await hookCallbacks.get("http.response")?.({ sessionID: childSessionID, agent: "explore", model, kind: "primary", request: new Request("http://localhost/mock"), response: new Response(null, { status: 200 }) })
			// A host retry of the same silent step must not re-arm the first-prompt watchdog.
			await new Promise((resolve) => setTimeout(resolve, 30))
			await hookCallbacks.get("model.request")?.({ sessionID: childSessionID, agent: "explore", model, kind: "primary" })
			if (options.progressBeforeWatchdog) {
				await admission.observeExecution({ type: "session.step.streamed", created: Date.now(), data: { sessionID: childSessionID } })
				await new Promise((resolve) => setTimeout(resolve, 150))
				throw new ForeignToolFailure({ message: `Subagent cancelled (sessionID: ${childSessionID})` })
			}
			const deadline = Date.now() + 1_000
			while (sessions.get(childSessionID)!.outcome !== "interrupted" && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10))
			await admission.observeExecution({ id: "evt-child-interrupted", type: "session.execution.interrupted", created: Date.now(), durable: { aggregateID: childSessionID, seq: ++eventSequence }, data: { sessionID: childSessionID } })
			throw new ForeignToolFailure({ message: `Subagent cancelled (sessionID: ${childSessionID})` })
		}
		await emitFailure(options.responseStatus ?? 429, options.errorSessionID ?? childSessionID)
		throw new ForeignToolFailure({ message: `Subagent failed (sessionID: ${options.errorSessionID ?? childSessionID}): fixture provider failure` })
	}
	const native = { id: "task", execute: originalExecute } as unknown as { id: string; execute: (input: never, context: ToolContext) => Promise<never> }
	const schemaOnlyFailure = new ForeignToolFailure({ message: "cross-copy schema fixture" })
	const abortController = new AbortController()
	const context = {
		sessionID: parentSessionID,
		messageID: "msg-parent-user",
		agent: "sisyphus",
		signal: abortController.signal,
		progress: async () => undefined,
	} as unknown as ToolContext

	async function emitFailure(status: number, errorSessionID: string, seq = ++eventSequence): Promise<void> {
		const model = invoked[invoked.length - 1]?.model === "openai/backup" ? backup : primary
		const request = { sessionID: childSessionID, agent: "explore", model, kind: "primary" }
		await hookCallbacks.get("model.request")?.(request)
		await hookCallbacks.get("http.response")?.({
			...request,
			request: new Request("http://localhost/mock"),
			response: new Response(null, { status }),
		})
		const child = sessions.get(childSessionID)!
		child.outcome = "failed"
		const created = Date.now() + 5
		child.time.idle = created + 5
		child.time.updated = created + 5
		histories.get(childSessionID)!.push({
			id: `msg-child-failed-${seq}`, type: "assistant", agent: "explore", model,
			error: { type: "provider.rate-limit", status: 429, message: "fixture rate limit" },
		})
		await admission.observeExecution({
			id: `evt-child-failed-${seq}`,
			type: "session.execution.failed",
			created,
			durable: { aggregateID: childSessionID, seq },
			data: { sessionID: childSessionID, error: { type: "provider.rate-limit", status: 429 } },
		})
		if (options.appendAssistantAfterFailure) {
			histories.get(childSessionID)!.push({
				id: `msg-child-newer-assistant-${seq}`, type: "assistant", agent: "explore", model,
				content: [{ type: "text", text: "A newer assistant message superseded the old error." }],
			})
		}
	}
	return {
		admission, native, context, invoked, storageValues, hooks: hookCallbacks, sessions, histories, interrupts,
		childSessionID, parentSessionID, emitFailure,
		abortController,
		stop: () => { stopped = true },
		foreignFailureIsSchemaValid: Schema.is(ToolError)(schemaOnlyFailure),
		foreignFailureIsLocalInstance: schemaOnlyFailure instanceof ToolError,
	}
}

describe("native V2 delegation model resolution", () => {
	test("managed primary agents use the same live rich fallback chain without relaxing native subagent mode", async () => {
		const h = harness({ agents: [{ id: "atlas", mode: "primary" }] })
		const choice = await resolveV2ManagedAgentModelChoice(h.ctx, {
			agents: { atlas: { model: "missing/model", fallback_models: [{ model: "override-provider/override-model", variant: "high", temperature: 0.31, max_tokens: 1234 }] } },
		}, "atlas", "ses-parent")
		expect(choice.model).toEqual({ providerID: "override-provider", id: "override-model", variant: "high" })
		expect(choice.settings).toMatchObject({ temperature: 0.31, maxTokens: 1234 })
		await expect(resolveV2SubagentModel(h.ctx, { agent: "atlas" }, "ses-parent")).rejects.toThrow("cannot run as a subagent")
	})

	test("managed model selection validates agent, category, provider and variant", async () => {
		const h = harness({ agents: [{ id: "atlas", mode: "primary" }] })
		await expect(resolveV2ManagedAgentModelChoice(h.ctx, {}, "missing", "ses-parent")).rejects.toThrow("Unknown native agent")
		await expect(resolveV2ManagedAgentModelChoice(h.ctx, {}, "atlas", "ses-parent", "missing-category")).rejects.toThrow("unavailable or disabled")
		await expect(resolveV2ManagedAgentModelChoice(h.ctx, { categories: { quick: { disable: true } } }, "atlas", "ses-parent", "quick")).rejects.toThrow("unavailable or disabled")
		await expect(resolveV2ManagedAgentModelChoice(h.ctx, {
			agents: { atlas: { model: "override-provider/override-model", variant: "nonexistent" } },
		}, "atlas", "ses-parent")).rejects.toThrow("No available model")
		const choice = await resolveV2ManagedAgentModelChoice(h.ctx, {
			disabled_providers: ["override-provider"],
			agents: { atlas: { model: "override-provider/override-model", fallback_models: ["host/parent-model"] } },
		}, "atlas", "ses-parent")
		expect(choice.model).toEqual({ providerID: "host", id: "parent-model" })
	})

	test("new children use explicit override, then target agent, then parent, then host default", async () => {
		const h = harness()
		const explicit = await resolveV2SubagentModel(h.ctx, {
			agent: "target",
			model: "openrouter/org/model/path#high",
		}, "ses-parent")
		expect(explicit.model).toEqual({ providerID: "openrouter", id: "org/model/path", variant: "high" })

		const targetAgent = await resolveV2SubagentModel(h.ctx, { agent: "target" }, "ses-parent")
		expect(targetAgent.model).toEqual({ providerID: "agent-provider", id: "agent-model" })

		const noAgentModel = harness({
			agents: [{ id: "target", mode: "subagent" }],
			models: [
				{ providerID: "host", id: "parent-model", enabled: true, variants: [] },
				{ providerID: "host-default", id: "fallback-model", enabled: true, variants: [] },
			],
			defaultModel: { providerID: "host-default", id: "fallback-model", enabled: true, variants: [] },
		})
		const parent = await resolveV2SubagentModel(noAgentModel.ctx, { agent: "target" }, "ses-parent")
		expect(parent.model).toEqual({ providerID: "host", id: "parent-model" })

		noAgentModel.sessions.set("ses-parent", { id: "ses-parent", agent: "parent", location: { directory: "/repo" } })
		const hostDefault = await resolveV2SubagentModel(noAgentModel.ctx, { agent: "target" }, "ses-parent")
		expect(hostDefault.model).toEqual({ providerID: "host-default", id: "fallback-model" })
	})

	test("resume uses override, switched-agent model, then stored model before the host default", async () => {
		const sessions = {
			"ses-same": {
				id: "ses-same", parentID: "ses-parent", agent: "target",
				model: { providerID: "stored-provider", id: "stored-model" },
				location: { directory: "/repo" },
			},
			"ses-switched": {
				id: "ses-switched", parentID: "ses-parent", agent: "target",
				model: { providerID: "stored-provider", id: "stored-model" },
				location: { directory: "/repo" },
			},
		}
		const h = harness({ sessions })
		const sameAgent = await resolveV2SubagentModel(h.ctx, { agent: "target", sessionID: "ses-same" }, "ses-parent")
		expect(sameAgent.model).toEqual({ providerID: "stored-provider", id: "stored-model" })

		const switchedAgent = await resolveV2SubagentModel(h.ctx, { agent: "other", sessionID: "ses-switched" }, "ses-parent")
		expect(switchedAgent.model).toEqual({ providerID: "override-provider", id: "override-model" })

		const explicit = await resolveV2SubagentModel(h.ctx, {
			agent: "other", sessionID: "ses-switched", model: "override-provider/override-model#high",
		}, "ses-parent")
		expect(explicit.model).toEqual({ providerID: "override-provider", id: "override-model", variant: "high" })
	})

	test("normalizes the native default sentinel on inherited parent and resumed models", async () => {
		const h = harness({
			agents: [{ id: "target", mode: "subagent" }],
			sessions: {
				"ses-parent": {
					id: "ses-parent", agent: "parent",
					model: { providerID: "stored-provider", id: "stored-model", variant: "default" },
					location: { directory: "/repo" },
				},
				"ses-resume-default": {
					id: "ses-resume-default", parentID: "ses-parent", agent: "target",
					model: { providerID: "stored-provider", id: "stored-model", variant: "default" },
					location: { directory: "/repo" },
				},
			},
		})

		const inherited = await resolveV2SubagentModel(h.ctx, { agent: "target" }, "ses-parent")
		expect(inherited.model).toEqual({ providerID: "stored-provider", id: "stored-model" })

		const resumed = await resolveV2SubagentModel(h.ctx, { agent: "target", sessionID: "ses-resume-default" }, "ses-parent")
		expect(resumed.model).toEqual({ providerID: "stored-provider", id: "stored-model" })
	})

	test("preserves valid inherited variants and rejects unavailable inherited or explicit default variants", async () => {
		const available = [{ providerID: "stored-provider", id: "stored-model", enabled: true, variants: [{ id: "high" }] }]
		const valid = harness({
			agents: [{ id: "target", mode: "subagent", model: { providerID: "stored-provider", id: "stored-model", variant: "high" } }],
			models: available,
		})
		const inherited = await resolveV2SubagentModel(valid.ctx, { agent: "target" }, "ses-parent")
		expect(inherited.model).toEqual({ providerID: "stored-provider", id: "stored-model", variant: "high" })

		const invalid = harness({
			agents: [{ id: "target", mode: "subagent", model: { providerID: "stored-provider", id: "stored-model", variant: "missing" } }],
			models: available,
		})
		await expect(resolveV2SubagentModel(invalid.ctx, { agent: "target" }, "ses-parent"))
			.rejects.toThrow('Variant "missing" is unavailable')

		const explicitDefault = harness({
			models: [{ providerID: "override-provider", id: "override-model", enabled: true, variants: [{ id: "high" }] }],
		})
		await expect(resolveV2SubagentModel(explicitDefault.ctx, {
			agent: "target", model: "override-provider/override-model#default",
		}, "ses-parent"))
			.rejects.toThrow('Variant "default" is unavailable')
	})

	test("validates requested agent, direct-child ownership, enabled model, and variant", async () => {
		const h = harness({ sessions: {
			"ses-foreign": { id: "ses-foreign", parentID: "ses-other", agent: "target", location: { directory: "/repo" } },
			"ses-no-model": { id: "ses-no-model", parentID: "ses-parent", agent: "target", location: { directory: "/repo" } },
		} })
		await expect(resolveV2SubagentModel(h.ctx, { agent: "missing" }, "ses-parent"))
			.rejects.toThrow('Unknown native subagent "missing"')
		await expect(resolveV2SubagentModel(h.ctx, { agent: "primary" }, "ses-parent"))
			.rejects.toThrow("cannot run as a subagent")
		await expect(resolveV2SubagentModel(h.ctx, { agent: "target", sessionID: "ses-foreign" }, "ses-parent"))
			.rejects.toThrow("not a child")
		await expect(resolveV2SubagentModel(h.ctx, { agent: "target", model: "missing/model" }, "ses-parent"))
			.rejects.toThrow("unavailable in the current OpenCode model catalog")
		await expect(resolveV2SubagentModel(h.ctx, { agent: "target", model: "override-provider/override-model#missing" }, "ses-parent"))
			.rejects.toThrow('Variant "missing" is unavailable')
		await expect(resolveV2SubagentModel(h.ctx, { agent: "target", model: "override-provider/override-model#high#extra" }, "ses-parent"))
			.rejects.toThrow("Invalid model")

		const noModel = harness({
			agents: [{ id: "target", mode: "subagent" }],
			models: [],
			defaultModel: null,
			sessions: { "ses-no-model": { id: "ses-no-model", parentID: "ses-parent", agent: "target", location: { directory: "/repo" } } },
		})
		noModel.sessions.set("ses-parent", { id: "ses-parent", agent: "parent", location: { directory: "/repo" } })
		await expect(resolveV2SubagentModel(noModel.ctx, { agent: "target", sessionID: "ses-no-model" }, "ses-parent"))
			.rejects.toThrow("no concrete model")
	})
})

describe("native child runtime fallback wrapper", () => {
	test("retains foreground failure through the terminal event/catch race and retries the same child", async () => {
		const h = fallbackWrapperHarness()
		const wrapped = h.admission.wrap(h.native as never)
		try {
			expect(h.foreignFailureIsSchemaValid).toBe(true)
			expect(h.foreignFailureIsLocalInstance).toBe(false)
			const result = await wrapped.execute({ agent: "explore", prompt: "Do the child task", background: false } as never, h.context)
			expect(h.invoked.map((call) => call.model)).toEqual(["openai/primary", "openai/backup"])
			expect(h.invoked.map((call) => call.sessionID)).toEqual([undefined, h.childSessionID])
			expect(result.output).toMatchObject({ sessionID: h.childSessionID, status: "completed", output: "CHILD_FALLBACK_OK" })
			expect(result.content).toContain("CHILD_FALLBACK_OK")
			expect(result.metadata).toMatchObject({ sessionID: h.childSessionID, status: "completed" })
		} finally {
			await h.admission.dispose()
		}
	})

		test("does not retry a different child error or provider error after a successful primary HTTP response", async () => {
		for (const options of [
			{ errorSessionID: "ses-some-other-child" },
			{ responseStatus: 200 },
			{ appendAssistantAfterFailure: true },
		]) {
			const h = fallbackWrapperHarness(options)
			const wrapped = h.admission.wrap(h.native as never)
			try {
				await expect(wrapped.execute({ agent: "explore", prompt: "Do the child task", background: false } as never, h.context))
					.rejects.toThrow("Subagent failed")
				expect(h.invoked).toHaveLength(1)
				expect([...h.storageValues.values()].some((value) =>
					typeof value === "object" && value !== null && "failureWitness" in value,
				)).toBe(false)
			} finally {
				await h.admission.dispose()
			}
		}
	})

	test("interrupts a silent foreground child after the watchdog and continues it on the next fallback", async () => {
		const h = fallbackWrapperHarness({ hang: true })
		const wrapped = h.admission.wrap(h.native as never)
		const startedAt = Date.now()
		const result = await wrapped.execute({ agent: "explore", description: "d", prompt: "p" } as never, h.context) as { output?: { status?: string; sessionID?: string } }
		expect(h.interrupts).toEqual([h.childSessionID])
		expect(Date.now() - startedAt).toBeLessThan(60 + 30 + 400)
		expect(h.invoked.map((call) => ({ sessionID: call.sessionID, model: call.model }))).toEqual([
			{ sessionID: undefined, model: "openai/primary" },
			{ sessionID: h.childSessionID, model: "openai/backup" },
		])
		expect(result.output).toMatchObject({ status: "completed", sessionID: h.childSessionID })
		await h.admission.dispose()
	})

	test("child progress before the watchdog prevents interruption and fallback", async () => {
		const h = fallbackWrapperHarness({ hang: true, progressBeforeWatchdog: true })
		const wrapped = h.admission.wrap(h.native as never)
		await expect(wrapped.execute({ agent: "explore", description: "d", prompt: "p" } as never, h.context)).rejects.toThrow("Subagent cancelled")
		expect(h.interrupts).toEqual([])
		expect(h.invoked).toHaveLength(1)
		await h.admission.dispose()
	})

	test("persists background failure before releasing its transient invocation and retries only on explicit same-child resume", async () => {
		const h = fallbackWrapperHarness({ background: true, failWitnessWriteOnce: true })
		const wrapped = h.admission.wrap(h.native as never)
		try {
			const original = await wrapped.execute({ agent: "explore", prompt: "Run in background", background: true } as never, h.context)
			expect(original.output).toMatchObject({ sessionID: h.childSessionID, status: "running" })

			// The first durable write fails. Replaying the observed terminal event must
			// still find the in-memory invocation and persist its verified witness.
			await h.emitFailure(429, h.childSessionID, 1)
			expect(await h.admission.prepareExplicitFallbackResume(h.childSessionID, h.parentSessionID, "explore")).toBeUndefined()
			await h.emitFailure(429, h.childSessionID, 2)
			const witnessRecord = [...h.storageValues.values()].find((value) =>
				typeof value === "object" && value !== null && "failureWitness" in value,
			) as Record<string, unknown> | undefined
			expect((witnessRecord?.failureWitness as Record<string, unknown>).background).toBe(true)
			expect(witnessRecord?.failureWitness).toMatchObject({
				sessionID: h.childSessionID,
				parentSessionID: h.parentSessionID,
				agentID: "explore",
				model: { providerID: "openai", id: "primary" },
				responseStatus: 429,
			})

			const prepared = await h.admission.prepareExplicitFallbackResume(h.childSessionID, h.parentSessionID, "explore")
			expect(prepared?.choice.model).toEqual({ providerID: "openai", id: "backup" })
			if (!prepared) throw new Error("Expected a verified fallback resume token")
			const args = {
				agent: "explore",
				sessionID: h.childSessionID,
				model: "openai/backup",
				prompt: "Continue the failed child",
				background: false,
			}
			await expect(h.admission.invokeWithSelection(h.native as never, { ...args, agent: "other" }, h.context, prepared.choice, prepared))
				.rejects.toThrow("invalid for this native child resume")
			const result = await h.admission.invokeWithSelection(h.native as never, args, h.context, prepared.choice, prepared)
			expect(h.invoked.map((call) => call.model)).toEqual(["openai/primary", "openai/backup"])
			expect(h.invoked.map((call) => call.sessionID)).toEqual([undefined, h.childSessionID])
			expect(result.output).toMatchObject({ sessionID: h.childSessionID, status: "completed", output: "CHILD_FALLBACK_OK" })
			await expect(h.admission.invokeWithSelection(h.native as never, args, h.context, prepared.choice, prepared))
				.rejects.toThrow("Prepared fallback token is invalid")
		} finally {
			await h.admission.dispose()
		}
	})

	test("does not consume a prepared background retry after the failure watermark, stop state, or signal changes", async () => {
		for (const invalidation of ["stale", "stopped", "aborted"] as const) {
			const h = fallbackWrapperHarness({ background: true })
			const wrapped = h.admission.wrap(h.native as never)
			try {
				await wrapped.execute({ agent: "explore", prompt: "Run in background", background: true } as never, h.context)
				await h.emitFailure(429, h.childSessionID, 1)
				const prepared = await h.admission.prepareExplicitFallbackResume(h.childSessionID, h.parentSessionID, "explore")
				expect(prepared).toBeDefined()
				if (!prepared) throw new Error("Expected a verified fallback resume token")
				if (invalidation === "stale") {
					h.sessions.get(h.childSessionID)!.time.idle += 10
				} else if (invalidation === "stopped") {
					h.stop()
				} else {
					h.abortController.abort()
				}
				await expect(h.admission.invokeWithSelection(h.native as never, {
					agent: "explore", sessionID: h.childSessionID, model: "openai/backup", prompt: "Resume", background: false,
				}, h.context, prepared.choice, prepared)).rejects.toThrow()
				expect(h.invoked).toHaveLength(1)
				expect([...h.storageValues.values()].some((value) =>
					typeof value === "object" && value !== null && "failureWitness" in value,
				)).toBe(true)
			} finally {
				await h.admission.dispose()
			}
		}
	})
})
