import { Error as ToolError, type Info, type ToolContext } from "@opencode/plugin/promise/tool"
import { Model, type Plugin } from "@opencode/plugin"
import type { SessionHttpResponse, SessionModelRequest } from "@opencode/plugin/promise/session"
import { Schema } from "effect"
import type { OhMyOpenCodeConfig } from "../config"
import type { AgentOverrideConfig, CategoryConfig, RuntimeFallbackConfig } from "../config/schema"
import type { BackgroundTaskConfig } from "../config/schema/background-task"
import { log } from "../shared/logger"
import { isProviderDisabled } from "../shared/disabled-providers"
import { DEFAULT_CATEGORIES } from "../tools/delegate-task/builtin-categories"
import { mergeCategories } from "../shared/merge-categories"
import {
	advanceV2DelegationFallback,
	delegationModelKey,
	resolveV2DelegationFallbackCandidates,
	resolveV2DelegationModelSelection,
	type DelegationFallbackState,
	type DelegationModelChoice,
	type DelegationModelRef,
} from "./delegation-model-selection"
import {
	createV2DelegationSettings,
	isV2DelegationSessionInLocation,
	type V2DelegationFailureWitness,
	type V2DelegationSettings,
	type V2DelegationSettingsRecord,
} from "./delegation-settings"
import {
	createV2BackgroundAdmission,
	type AdmissionModel,
	type BackgroundAdmissionTicket,
	type V2BackgroundAdmission,
	type VerifiedLogicalParentResolver,
} from "./background-admission"
import type { V2SubagentRunState } from "./task-state"

type NativeSubagent = Info & { readonly id: string }
type NativeInput = Record<string, unknown> & {
	agent: string
	model?: string
	sessionID?: string
}
type ModelRef = DelegationModelRef
type SessionInfo = Awaited<ReturnType<Plugin.Context["session"]["get"]>>
type AgentInfo = Awaited<ReturnType<Plugin.Context["agent"]["list"]>>["data"][number]
type ModelInfo = Awaited<ReturnType<Plugin.Context["model"]["list"]>>["data"][number]
type NativeResult = Awaited<ReturnType<NativeSubagent["execute"]>>
type ResolvedSubagentModel = {
	agent: AgentInfo
	model: ModelRef
	settings: Readonly<Record<string, unknown>>
	choice: DelegationModelChoice
}

export type V2DelegationAdmission = {
	readonly background: Pick<V2BackgroundAdmission, "acquire">
	readonly ready: () => Promise<void>
	readonly wrap: (native: NativeSubagent) => NativeSubagent
	readonly invokeWithSelection: (native: NativeSubagent, args: Record<string, unknown>, context: ToolContext, choice?: DelegationModelChoice, preparedFallback?: PreparedV2DelegationFallbackResume) => Promise<NativeResult>
	readonly prepareExplicitFallbackResume: (childSessionID: string, parentSessionID: string, agentID: string) => Promise<PreparedV2DelegationFallbackResume | undefined>
	readonly removeSettings: (sessionID: string) => Promise<void>
	readonly observeExecution: (event: unknown) => Promise<void>
	readonly dispose: () => Promise<void>
}

/** Opaque selection returned only after a current failed-child witness is verified. */
export type PreparedV2DelegationFallbackResume = {
	readonly choice: DelegationModelChoice
	readonly fallbackState: DelegationFallbackState
}

type PreparedFallbackProof = {
	readonly sessionID: string
	readonly parentSessionID: string
	readonly agentID: string
	readonly witness: V2DelegationFailureWitness
	readonly previousModel: DelegationModelRef
	readonly previousSettings: Readonly<Record<string, unknown>>
	readonly previousFallbackState: DelegationFallbackState
	readonly choice: DelegationModelChoice
	readonly fallbackState: DelegationFallbackState
}

type ChildPrimaryRequest = {
	readonly agentID: string
	readonly model: DelegationModelRef
	readonly requestedAt: number
	readonly userMessageID: string
	responseStatus?: number
}

type ChildInvocation = {
	readonly sessionID: string
	readonly parentSessionID: string
	readonly agentID: string
	readonly model: DelegationModelRef
	readonly startedAt: number
	readonly background: boolean
	readonly baselineIdle?: number
	primary?: ChildPrimaryRequest
	/** Legacy first-prompt watchdog: set when OMO interrupted a silent child to advance its fallback. */
	timedOut?: boolean
	watchdog?: ReturnType<typeof setTimeout>
	/** First-prompt semantics: armed once per invocation; host retries of the same step do not re-arm it. */
	watchdogArmed?: boolean
}

/** Legacy runtime-fallback first-prompt watchdog for delegated children (DEFAULT_FIRST_PROMPT_WATCHDOG_MS). */
export const CHILD_FALLBACK_WATCHDOG_MS = 90_000
const TIMEOUT_WITNESS_STATUS = 408
const CHILD_PROGRESS_EVENTS = new Set([
	"session.step.streamed", "session.text.started", "session.text.delta", "session.reasoning.started",
	"session.reasoning.delta", "session.tool.called", "session.tool.input.started",
])

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? value as Record<string, unknown>
		: undefined
}

function ref(value: unknown): ModelRef | undefined {
	const candidate = record(value)
	if (!candidate || typeof candidate.providerID !== "string" || typeof candidate.id !== "string") return undefined
	// OpenCode exposes an absent stored variant as "default" (session/info.ts);
	// its resolver normalizes that sentinel to undefined (model-resolver.ts:141).
	const variant = typeof candidate.variant === "string" && candidate.variant !== "default"
		? candidate.variant
		: undefined
	return {
		providerID: candidate.providerID,
		id: candidate.id,
		...(variant ? { variant } : {}),
	}
}

function parseOverride(value: unknown): ModelRef | undefined {
	if (typeof value !== "string" || value.trim() === "") return undefined
	const text = value.trim()
	try {
		const parsed = Model.Ref.parse(text)
		return {
			providerID: parsed.providerID,
			id: parsed.id,
			...(parsed.variant ? { variant: parsed.variant } : {}),
		}
	} catch {
		throw new ToolError({ message: `Invalid model "${value}". Expected providerID/modelID or providerID/modelID#variant.` })
	}
}

function nativeToolError(error: unknown): Error {
	if (error instanceof ToolError) return error
	return new ToolError({ message: error instanceof Error ? error.message : String(error) })
}

function modelText(model: ModelRef): string {
	return `${model.providerID}/${model.id}${model.variant ? `#${model.variant}` : ""}`
}

function sameModelRef(left: ModelRef, right: ModelRef): boolean {
	return left.providerID === right.providerID && left.id === right.id && left.variant === right.variant
}

function requireAgent(agents: readonly AgentInfo[], id: unknown): AgentInfo {
	if (typeof id !== "string" || !id.trim()) throw new ToolError({ message: "A subagent name is required." })
	const agent = agents.find((candidate) => candidate.id === id)
	if (!agent) throw new ToolError({ message: `Unknown native subagent "${id}".` })
	if (agent.mode === "primary") throw new ToolError({ message: `Agent "${agent.id}" cannot run as a subagent.` })
	return agent
}

async function requireAvailableModel(ctx: Plugin.Context, model: ModelRef, disabledProviders: readonly string[] = []): Promise<ModelRef> {
	const available = (await ctx.model.list()).data
	const match = available.find((candidate) => candidate.providerID === model.providerID && candidate.id === model.id && candidate.enabled)
	if (!match) throw new ToolError({ message: `Effective subagent model "${modelText(model)}" is unavailable in the current OpenCode model catalog.` })
	if (isProviderDisabled(modelText(model), disabledProviders)) {
		throw new ToolError({ message: `Effective subagent model "${modelText(model)}" uses a provider listed in disabled_providers.` })
	}
	if (model.variant && !match.variants.some((candidate) => candidate.id === model.variant)) {
		const variants = match.variants.map((candidate) => candidate.id).join(", ") || "none"
		throw new ToolError({ message: `Variant "${model.variant}" is unavailable for "${model.providerID}/${model.id}". Available variants: ${variants}.` })
	}
	return model
}

function nativeChoice(model: ModelRef, settings: Readonly<Record<string, unknown>> = {}, source: DelegationModelChoice["source"] = "agent"): DelegationModelChoice {
	return { model, settings, source }
}

function categoryConfig(config: OhMyOpenCodeConfig, name: string): CategoryConfig {
	return {
		...(DEFAULT_CATEGORIES[name] ?? {}),
		...(config.categories?.[name] ?? {}),
	}
}

type ChildRetryPolicy = {
	readonly retryOnErrors: readonly number[]
	readonly maxAttempts: number
	readonly cooldownMs: number
}

function childRetryPolicy(config: OhMyOpenCodeConfig): ChildRetryPolicy | undefined {
	if (config.disabled_hooks?.includes("runtime-fallback")) return undefined
	const value = config.runtime_fallback
	if (value !== true && (!value || typeof value !== "object" || value.enabled !== true)) return undefined
	const options = value === true ? undefined : value as RuntimeFallbackConfig
	return {
		retryOnErrors: options?.retry_on_errors?.filter((status) => Number.isSafeInteger(status) && status >= 100 && status <= 599) ?? [429, 500, 502, 503, 504],
		maxAttempts: Math.max(1, Math.min(20, Number.isSafeInteger(options?.max_fallback_attempts) ? options!.max_fallback_attempts! : 3)),
		cooldownMs: Math.max(0, (typeof options?.cooldown_seconds === "number" && Number.isFinite(options.cooldown_seconds) ? options.cooldown_seconds : 60) * 1000),
	}
}

function nativeRequestModel(value: unknown): ModelRef | undefined {
	const candidate = record(value)
	if (!candidate || typeof candidate.providerID !== "string" || typeof candidate.id !== "string") return undefined
	return {
		providerID: candidate.providerID,
		id: candidate.id,
		...(typeof candidate.variant === "string" && candidate.variant !== "default" ? { variant: candidate.variant } : {}),
	}
}

function sameModel(left: ModelRef, right: ModelRef): boolean {
	return delegationModelKey(left) === delegationModelKey(right)
}

function latestUserAndAssistant(messages: readonly unknown[]): {
	userMessageID?: string
	assistant?: { id: string; agentID: string; model: ModelRef; errorType: string; status?: number }
} {
	let userIndex = -1
	let userMessageID: string | undefined
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = record(messages[index])
		if (message?.type === "user" && typeof message.id === "string" && message.id) {
			userIndex = index
			userMessageID = message.id
			break
		}
	}
	if (userIndex < 0 || !userMessageID) return {}
	for (let index = messages.length - 1; index > userIndex; index -= 1) {
		const message = record(messages[index])
		if (message?.type !== "assistant") continue
		if (typeof message.id !== "string" || typeof message.agent !== "string") return { userMessageID }
		const model = nativeRequestModel(message.model)
		const error = record(message.error)
		// Only the latest assistant after the latest user can prove this failed
		// request. Skipping a newer assistant could reuse a stale provider error.
		if (!model || typeof error?.type !== "string" || !error.type.startsWith("provider.")) return { userMessageID }
		return {
			userMessageID,
			assistant: {
				id: message.id,
				agentID: message.agent,
				model,
				errorType: error.type,
				...(typeof error.status === "number" ? { status: error.status } : {}),
			},
		}
	}
	return { userMessageID }
}

function textError(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

function executionEvent(value: unknown): { type: string; created?: number; data?: Record<string, unknown>; durable?: Record<string, unknown> } | undefined {
	const event = record(value)
	if (!event || typeof event.type !== "string") return undefined
	return {
		type: event.type,
		...(typeof event.created === "number" && Number.isFinite(event.created) ? { created: event.created } : {}),
		...(record(event.data) ? { data: record(event.data)! } : {}),
		...(record(event.durable) ? { durable: record(event.durable)! } : {}),
	}
}

function initialFallbackState(
	config: OhMyOpenCodeConfig,
	agent: AgentInfo,
	parent: SessionInfo,
	choice: DelegationModelChoice,
	catalog: readonly Awaited<ReturnType<Plugin.Context["model"]["list"]>>["data"][number][],
	defaultModel: Awaited<ReturnType<Plugin.Context["model"]["default"]>>["data"],
): DelegationFallbackState | undefined {
	if (!childRetryPolicy(config)) return undefined
	const agentOverrides = config.agents as Record<string, AgentOverrideConfig> | undefined
	const agentConfig = agentOverrides?.[agent.id] ?? Object.entries(agentOverrides ?? {}).find(([name]) => name.toLowerCase() === agent.id.toLowerCase())?.[1]
	const categories = mergeCategories(config.categories)
	const agentCategory = agentConfig?.category ? categories[agentConfig.category] : undefined
	const originCategory = choice.originCategory
	const targetCategory = originCategory ? categoryConfig(config, originCategory) : undefined
	const selected = resolveV2DelegationFallbackCandidates({
		agentID: agent.id,
		catalog: catalog.map((model) => ({
			providerID: model.providerID,
			id: model.id,
			enabled: model.enabled,
			variants: model.variants.map((variant) => ({ id: variant.id, settings: variant.settings })),
		})),
		disabledProviders: config.disabled_providers,
		agentConfig,
		agentCategory,
		...(originCategory ? {
			categoryName: originCategory,
			categoryConfig: targetCategory,
			categoryOverride: config.categories?.[originCategory],
			variantOverride: config.categories?.[originCategory]?.variant,
		} : {}),
		registeredModel: nativeRequestModel(agent.model),
		parentModel: nativeRequestModel(parent.model),
		defaultModel: nativeRequestModel(defaultModel),
		currentModel: choice.model,
	})
	if (!selected) return undefined
	return {
		source: selected.source,
		...(originCategory ? { originCategory } : {}),
		candidates: selected.candidates,
		currentIndex: -1,
		attempts: 0,
		failedAt: {},
	}
}

async function configuredChoice(
	ctx: Plugin.Context,
	config: OhMyOpenCodeConfig,
	agent: AgentInfo,
	parent: SessionInfo,
	categoryName?: string,
): Promise<DelegationModelChoice | undefined> {
	const catalog = (await ctx.model.list()).data
	const defaultModel = (await ctx.model.default()).data
	const agentOverride = config.agents?.[agent.id as keyof typeof config.agents] as AgentOverrideConfig | undefined
	const mergedCategories = mergeCategories(config.categories)
	const inheritedCategory = agentOverride?.category ? mergedCategories[agentOverride.category] : undefined
	const targetCategory = categoryName ? categoryConfig(config, categoryName) : undefined
	const choice = resolveV2DelegationModelSelection({
		agentID: agent.id,
		catalog: catalog.map((model: ModelInfo) => ({
			providerID: model.providerID,
			id: model.id,
			enabled: model.enabled,
			variants: model.variants.map((variant) => ({
				id: variant.id,
				settings: variant.settings,
			})),
		})),
		disabledProviders: config.disabled_providers,
		agentConfig: agentOverride,
		agentCategory: inheritedCategory,
		...(categoryName ? {
			categoryName,
			categoryConfig: targetCategory,
			categoryOverride: config.categories?.[categoryName],
			variantOverride: config.categories?.[categoryName]?.variant,
		} : {}),
		registeredModel: ref(agent.model),
		parentModel: ref(parent.model),
		defaultModel: ref(defaultModel),
	})
	return choice
}

/** Resolve an OMO category's rich model choice from the current native catalog. */
export async function resolveV2DelegationModelChoice(
	ctx: Plugin.Context,
	config: OhMyOpenCodeConfig,
	agentID: string,
	parentSessionID: string,
	categoryName: string,
): Promise<DelegationModelChoice> {
	const agent = requireAgent((await ctx.agent.list()).data, agentID)
	if (config.categories?.[categoryName]?.disable) {
		throw new ToolError({ message: `Category "${categoryName}" is disabled.` })
	}
	let parent: SessionInfo
	try {
		parent = await ctx.session.get({ sessionID: parentSessionID })
	} catch (error) {
		throw new ToolError({ message: `Parent session not found: ${parentSessionID}. ${error instanceof Error ? error.message : String(error)}` })
	}
	const choice = await configuredChoice(ctx, config, agent, parent, categoryName)
	if (!choice) throw new ToolError({ message: `No available model was found for category "${categoryName}" and agent "${agentID}".` })
	await requireAvailableModel(ctx, choice.model, config.disabled_providers)
	return { ...choice, originCategory: categoryName }
}

/** Model selection for a managed Team member, including primary-mode agents. */
export async function resolveV2ManagedAgentModelChoice(
	ctx: Plugin.Context,
	config: OhMyOpenCodeConfig,
	agentID: string,
	parentSessionID: string,
	categoryName?: string,
): Promise<DelegationModelChoice> {
	const agent = (await ctx.agent.list()).data.find((candidate) => candidate.id === agentID)
	if (!agent) throw new ToolError({ message: `Unknown native agent "${agentID}".` })
	if (categoryName) {
		const category = mergeCategories(config.categories)[categoryName]
		if (!category || category.disable) throw new ToolError({ message: `Category "${categoryName}" is unavailable or disabled.` })
	}
	const parent = await ctx.session.get({ sessionID: parentSessionID })
	if (parent.id !== parentSessionID) throw new ToolError({ message: `Parent session identity mismatch: ${parentSessionID}.` })
	const choice = await configuredChoice(ctx, config, agent, parent, categoryName)
	if (!choice) throw new ToolError({ message: `No available model was found for managed agent "${agentID}".` })
	const model = await requireAvailableModel(ctx, choice.model, config.disabled_providers)
	return { ...choice, model, ...(categoryName ? { originCategory: categoryName } : {}) }
}

/** Resolve against the current model catalog before reserving a pool slot. */
export async function resolveV2SubagentModel(
	ctx: Plugin.Context,
	input: NativeInput,
	parentSessionID: string,
options: {
	config?: OhMyOpenCodeConfig
	settingsStore?: V2DelegationSettings
	trustedChoice?: DelegationModelChoice
	preparedChoice?: DelegationModelChoice
} = {},
): Promise<ResolvedSubagentModel> {
	const agent = requireAgent((await ctx.agent.list()).data, input.agent)
	let parent: SessionInfo
	try {
		parent = await ctx.session.get({ sessionID: parentSessionID })
	} catch (error) {
		throw new ToolError({ message: `Parent session not found: ${parentSessionID}. ${error instanceof Error ? error.message : String(error)}` })
	}

	const override = parseOverride(input.model)
	let existing: SessionInfo | undefined
	if (typeof input.sessionID === "string" && input.sessionID) {
		try {
			existing = await ctx.session.get({ sessionID: input.sessionID })
		} catch (error) {
			throw new ToolError({ message: `Subagent session not found: ${input.sessionID}. ${error instanceof Error ? error.message : String(error)}` })
		}
		if (existing.id !== input.sessionID || existing.parentID !== parentSessionID) {
			throw new ToolError({ message: `Session ${input.sessionID} is not a child of the current session.` })
		}
	}

	const config = options.config
	let choice: DelegationModelChoice | undefined
	if (options.preparedChoice) {
		choice = options.preparedChoice
	} else if (override) {
		const storedModel = existing && existing.agent === agent.id ? ref(existing.model) : undefined
		const stored = storedModel && sameModelRef(storedModel, override)
			? await options.settingsStore?.read(existing!.id, { parentSessionID, agentID: agent.id, model: override })
			: undefined
		choice = nativeChoice(override, stored?.settings ?? {}, "configured")
	} else if (existing) {
		// A resume never reruns the configured fallback chain. Preserve the
		// session model, except that the native API can explicitly switch agents.
		const resumedModel = existing.agent !== agent.id ? ref(agent.model) ?? ref(existing.model) : ref(existing.model)
		if (resumedModel) {
			const stored = existing.agent === agent.id
				? await options.settingsStore?.read(existing.id, {
					parentSessionID,
					agentID: agent.id,
					model: resumedModel,
				})
				: undefined
			choice = nativeChoice(resumedModel, stored?.settings ?? {}, stored ? "configured" : "agent")
		}
	} else if (options.trustedChoice) {
		// This choice comes through the wrapper's instance-local WeakMap, never
		// from a property on the caller-controlled native input object.
		choice = options.trustedChoice
	} else if (config) {
		choice = await configuredChoice(ctx, config, agent, parent)
	} else {
		// Compatibility for focused legacy tests and callers that do not provide
		// OMO config: keep native registered-agent/parent/default precedence.
		const nativeModel = ref(agent.model) ?? ref(parent.model) ?? ref((await ctx.model.default()).data)
		if (nativeModel) choice = nativeChoice(nativeModel)
	}
	if (!choice) throw new ToolError({ message: "OpenCode has no concrete model for this subagent. Select a model or configure a default model before delegating." })
	const model = await requireAvailableModel(ctx, choice.model, config?.disabled_providers)
	return { agent, model, settings: choice.settings, choice: { ...choice, model } }
}

function resultSession(result: NativeResult): { sessionID?: string; status?: string } {
	const output = record(result.output)
	return {
		...(typeof output?.sessionID === "string" ? { sessionID: output.sessionID } : {}),
		...(typeof output?.status === "string" ? { status: output.status } : {}),
	}
}

/**
 * One admission manager and one idempotent wrapper for the native executor.
 * OMO aliases call the same wrapped function, so they share admission state and
 * keep all host tool schemas, permissions, progress, result, and cancellation behavior.
 */
export function createV2DelegationAdmission(input: {
	ctx: Plugin.Context
	config: OhMyOpenCodeConfig
	runs: V2SubagentRunState
	childSessions: Map<string, Set<string>>
	isAliasInvocation: (context: ToolContext) => boolean
	resolveLogicalParent?: VerifiedLogicalParentResolver
	managedDirectory?: (directory: string) => boolean
	isStopped?: (sessionID: string) => boolean | Promise<boolean>
	childWatchdogMs?: number
}): V2DelegationAdmission {
	const { ctx, config, runs, childSessions, isAliasInvocation } = input
	const admission = createV2BackgroundAdmission(ctx, config.background_task as BackgroundTaskConfig | undefined, undefined, input.resolveLogicalParent, input.managedDirectory)
	const settingsStore = createV2DelegationSettings(ctx.storage, ctx.location)
	const wrappedExecutors = new WeakMap<NativeSubagent["execute"], NativeSubagent["execute"]>()
	const trustedChoices = new WeakMap<object, DelegationModelChoice>()
	const preparedByArgs = new WeakMap<object, PreparedV2DelegationFallbackResume>()
	const preparedProofs = new WeakMap<object, PreparedFallbackProof>()
	const invocations = new Map<string, ChildInvocation>()
	const pending = new Set<Promise<unknown>>()
	const observerDisposers: Array<() => Promise<void>> = []
	let observersPromise: Promise<void> | undefined
	let disposed = false

	function track<T>(operation: Promise<T>): Promise<T> {
		pending.add(operation)
		void operation.finally(() => pending.delete(operation)).catch(() => undefined)
		return operation
	}

	async function stopped(sessionIDs: readonly string[]): Promise<boolean> {
		if (!input.isStopped) return false
		try {
			for (const sessionID of sessionIDs) if (await input.isStopped(sessionID)) return true
			return false
		} catch (error) {
			log("[v2 delegation] Stop-state lookup failed; fallback is blocked.", error)
			return true
		}
	}

	async function registerObservers(): Promise<void> {
		if (!observersPromise) observersPromise = (async () => {
			const local: Array<() => Promise<void>> = []
			try {
				const modelRequest = await ctx.session.hook("model.request", (hook) => track((async () => {
					if (disposed || hook.kind !== "primary") return
					const childSessionID = String(hook.sessionID)
					const invocation = invocations.get(childSessionID)
					const model = nativeRequestModel(hook.model)
					if (!invocation || !model || invocation.agentID !== String(hook.agent) || !sameModel(invocation.model, model)) return
					const requestedAt = Date.now()
					const messages = await ctx.session.context({ sessionID: childSessionID })
					const history = latestUserAndAssistant(messages)
					if (disposed || invocations.get(childSessionID) !== invocation || !history.userMessageID) return
					invocation.primary = {
						agentID: invocation.agentID,
						model,
						requestedAt,
						userMessageID: history.userMessageID,
					}
					armWatchdog(invocation)
				})()))
				local.push(() => modelRequest.dispose())
				const response = await ctx.session.hook("http.response", (hook) => {
					if (disposed || hook.kind !== "primary") return
					const invocation = invocations.get(String(hook.sessionID))
					const model = nativeRequestModel(hook.model)
					const request = invocation?.primary
					if (!invocation || !request || !model || request.agentID !== String(hook.agent) || !sameModel(request.model, model)) return
					if (typeof hook.response.status === "number" && Number.isSafeInteger(hook.response.status)) request.responseStatus = hook.response.status
				})
				local.push(() => response.dispose())
				observerDisposers.push(...local)
			} catch (error) {
				const failures: unknown[] = []
				for (const dispose of local.reverse()) {
					try { await dispose() } catch (cleanupError) { failures.push(cleanupError) }
				}
				if (failures.length) throw new AggregateError([error, ...failures], "Delegation fallback observer setup failed")
				throw error
			}
		})()
		await observersPromise
	}

	async function recordDirectChild(childSessionID: string, parentSessionID: string): Promise<void> {
		const existing = await runs.get(childSessionID)
		await runs.recordLaunch(childSessionID, {
			parentSessionID,
			startedAt: Date.now(),
			status: "running",
			blockedActions: existing?.parentSessionID === parentSessionID ? [...existing.blockedActions] : [],
		})
		const children = childSessions.get(parentSessionID) ?? new Set<string>()
		children.add(childSessionID)
		childSessions.set(parentSessionID, children)
	}

	async function childBelongsTo(session: SessionInfo, parentSessionID: string): Promise<boolean> {
		if (session.parentID === parentSessionID) return true
		if (!input.resolveLogicalParent) return false
		try { return await input.resolveLogicalParent(session.id) === parentSessionID } catch { return false }
	}

	async function shouldStop(parentSessionID: string, childSessionID: string): Promise<boolean> {
		return disposed || await stopped([parentSessionID, childSessionID])
	}

	function clearWatchdog(invocation: ChildInvocation): void {
		if (invocation.watchdog) clearTimeout(invocation.watchdog)
		invocation.watchdog = undefined
	}

	/** Only interrupt a silent child when its stored chain can still advance to another model. */
	async function hasNextFallback(invocation: ChildInvocation): Promise<boolean> {
		const policy = childRetryPolicy(config)
		if (!policy) return false
		const stored = await settingsStore.read(invocation.sessionID, { parentSessionID: invocation.parentSessionID, agentID: invocation.agentID, model: invocation.model })
		if (!stored?.fallbackState) return false
		return advanceV2DelegationFallback(stored.fallbackState, invocation.model, { now: Date.now(), cooldownMs: policy.cooldownMs, maxAttempts: policy.maxAttempts }) !== undefined
	}

	function armWatchdog(invocation: ChildInvocation): void {
		if (invocation.watchdogArmed || disposed || !childRetryPolicy(config)) return
		invocation.watchdogArmed = true
		invocation.watchdog = setTimeout(() => {
			invocation.watchdog = undefined
			if (disposed || invocations.get(invocation.sessionID) !== invocation) return
			track((async () => {
				if (await shouldStop(invocation.parentSessionID, invocation.sessionID) || !await hasNextFallback(invocation)) {
					log("[v2 delegation] Child produced no progress before the watchdog, but no fallback can take over.", { sessionID: invocation.sessionID })
					return
				}
				if (invocations.get(invocation.sessionID) !== invocation) return
				invocation.timedOut = true
				log("[v2 delegation] Child produced no progress before the watchdog; interrupting to advance its fallback.", { sessionID: invocation.sessionID })
				await ctx.session.interrupt({ sessionID: invocation.sessionID as Parameters<Plugin.Context["session"]["interrupt"]>[0]["sessionID"] })
			})()).catch((error) => log("[v2 delegation] Child watchdog failed closed.", { sessionID: invocation.sessionID, error: textError(error) }))
		}, input.childWatchdogMs ?? CHILD_FALLBACK_WATCHDOG_MS)
	}

	function assistantKey(assistant: { id: string } | undefined, userMessageID: string): string {
		return assistant?.id ?? `no-assistant:${userMessageID}`
	}

	/** Witness for a child the watchdog interrupted: same ownership proof, interrupted outcome, no HTTP status. */
	async function verifyTimeout(invocation: ChildInvocation): Promise<V2DelegationFailureWitness | undefined> {
		const request = invocation.primary
		if (!invocation.timedOut || !childRetryPolicy(config) || !request || await shouldStop(invocation.parentSessionID, invocation.sessionID)) return undefined
		let session: SessionInfo
		try { session = await ctx.session.get({ sessionID: invocation.sessionID }) } catch { return undefined }
		if (session.id !== invocation.sessionID || !isV2DelegationSessionInLocation(session, ctx.location) ||
			!await childBelongsTo(session, invocation.parentSessionID) || session.agent !== invocation.agentID ||
			session.outcome !== "interrupted" || typeof session.time?.idle !== "number" || session.time.idle < request.requestedAt) return undefined
		const sessionModel = nativeRequestModel(session.model)
		if (!sessionModel || !sameModel(sessionModel, invocation.model)) return undefined
		let history: ReturnType<typeof latestUserAndAssistant>
		try { history = latestUserAndAssistant(await ctx.session.context({ sessionID: invocation.sessionID })) } catch { return undefined }
		if (history.userMessageID !== request.userMessageID) return undefined
		const stored = await settingsStore.read(invocation.sessionID, { parentSessionID: invocation.parentSessionID, agentID: invocation.agentID, model: invocation.model })
		if (!stored?.fallbackState) return undefined
		return {
			version: 1,
			sessionID: invocation.sessionID,
			parentSessionID: invocation.parentSessionID,
			agentID: invocation.agentID,
			model: invocation.model,
			userMessageID: request.userMessageID,
			assistantMessageID: assistantKey(history.assistant, request.userMessageID),
			errorType: "provider.timeout",
			status: TIMEOUT_WITNESS_STATUS,
			requestAt: request.requestedAt,
			responseStatus: TIMEOUT_WITNESS_STATUS,
			idle: session.time.idle,
			background: invocation.background,
			reason: "timeout",
		}
	}

	async function verifyFailure(
		invocation: ChildInvocation,
		terminalEvent?: unknown,
	): Promise<V2DelegationFailureWitness | undefined> {
		const policy = childRetryPolicy(config)
		const request = invocation.primary
		if (!policy || !request || request.agentID !== invocation.agentID || !sameModel(request.model, invocation.model) ||
			request.responseStatus === undefined || !policy.retryOnErrors.includes(request.responseStatus) ||
			request.responseStatus >= 200 && request.responseStatus < 300 || await shouldStop(invocation.parentSessionID, invocation.sessionID)) return undefined
		if (terminalEvent !== undefined) {
			const event = executionEvent(terminalEvent)
			if (!event || event.type !== "session.execution.failed" || event.created === undefined || event.created < request.requestedAt ||
				event.data?.sessionID !== invocation.sessionID || event.durable?.aggregateID !== invocation.sessionID ||
				!Number.isSafeInteger(event.durable?.seq)) return undefined
		}
		let session: SessionInfo
		try { session = await ctx.session.get({ sessionID: invocation.sessionID }) } catch { return undefined }
		if (session.id !== invocation.sessionID || !isV2DelegationSessionInLocation(session, ctx.location) ||
			!await childBelongsTo(session, invocation.parentSessionID) || session.agent !== invocation.agentID ||
			session.outcome !== "failed" || !session.time || typeof session.time.idle !== "number" || !Number.isFinite(session.time.idle) ||
			session.time.idle < request.requestedAt || (invocation.baselineIdle !== undefined && session.time.idle <= invocation.baselineIdle)) return undefined
		const sessionModel = nativeRequestModel(session.model)
		if (!sessionModel || !sameModel(sessionModel, invocation.model)) return undefined
		let history: ReturnType<typeof latestUserAndAssistant>
		try { history = latestUserAndAssistant(await ctx.session.context({ sessionID: invocation.sessionID })) } catch { return undefined }
		const assistant = history.assistant
		if (history.userMessageID !== request.userMessageID || !assistant || assistant.agentID !== invocation.agentID ||
			!sameModel(assistant.model, invocation.model) || assistant.status !== undefined && assistant.status !== request.responseStatus ||
			!childRetryPolicy(config)?.retryOnErrors.includes(request.responseStatus)) return undefined
		const identity = { parentSessionID: invocation.parentSessionID, agentID: invocation.agentID, model: invocation.model }
		const stored = await settingsStore.read(invocation.sessionID, identity)
		if (!stored?.fallbackState) return undefined
		return {
			version: 1,
			sessionID: invocation.sessionID,
			parentSessionID: invocation.parentSessionID,
			agentID: invocation.agentID,
			model: invocation.model,
			userMessageID: request.userMessageID,
			assistantMessageID: assistant.id,
			errorType: assistant.errorType,
			status: request.responseStatus,
			requestAt: request.requestedAt,
			responseStatus: request.responseStatus,
			idle: session.time.idle,
			background: invocation.background,
		}
	}

	function sameWitness(left: V2DelegationFailureWitness, right: V2DelegationFailureWitness): boolean {
		return left.sessionID === right.sessionID && left.parentSessionID === right.parentSessionID && left.agentID === right.agentID &&
			sameModel(left.model, right.model) && left.userMessageID === right.userMessageID && left.assistantMessageID === right.assistantMessageID &&
			left.errorType === right.errorType && left.status === right.status && left.requestAt === right.requestAt &&
			left.responseStatus === right.responseStatus && left.idle === right.idle && left.background === right.background &&
			left.reason === right.reason
	}

	async function currentSessionProof(
		proof: PreparedFallbackProof,
	): Promise<{ stored: V2DelegationSettingsRecord; session: SessionInfo } | undefined> {
		if (await shouldStop(proof.parentSessionID, proof.sessionID)) return undefined
		let session: SessionInfo
		try { session = await ctx.session.get({ sessionID: proof.sessionID }) } catch { return undefined }
		if (session.id !== proof.sessionID || !isV2DelegationSessionInLocation(session, ctx.location) ||
			!await childBelongsTo(session, proof.parentSessionID) || session.agent !== proof.agentID ||
			session.outcome !== (proof.witness.reason === "timeout" ? "interrupted" : "failed") ||
			typeof session.time?.idle !== "number" || session.time.idle !== proof.witness.idle) return undefined
		const model = nativeRequestModel(session.model)
		if (!model || !sameModel(model, proof.previousModel)) return undefined
		let history: ReturnType<typeof latestUserAndAssistant>
		try { history = latestUserAndAssistant(await ctx.session.context({ sessionID: proof.sessionID })) } catch { return undefined }
		if (proof.witness.reason === "timeout") {
			if (history.userMessageID !== proof.witness.userMessageID ||
				assistantKey(history.assistant, proof.witness.userMessageID) !== proof.witness.assistantMessageID) return undefined
		} else if (history.userMessageID !== proof.witness.userMessageID || history.assistant?.id !== proof.witness.assistantMessageID ||
			history.assistant.agentID !== proof.agentID || !sameModel(history.assistant.model, proof.previousModel) ||
			history.assistant.errorType !== proof.witness.errorType ||
			(history.assistant.status !== undefined && history.assistant.status !== proof.witness.responseStatus)) return undefined
		const stored = await settingsStore.read(proof.sessionID, {
			parentSessionID: proof.parentSessionID,
			agentID: proof.agentID,
			model: proof.previousModel,
		})
		if (!stored?.failureWitness || !sameWitness(stored.failureWitness, proof.witness)) return undefined
		return { stored, session }
	}

	async function prepareFallback(
		childSessionID: string,
		parentSessionID: string,
		agentID: string,
		allowForeground: boolean,
	): Promise<PreparedV2DelegationFallbackResume | undefined> {
		const policy = childRetryPolicy(config)
		if (!policy || await shouldStop(parentSessionID, childSessionID)) return undefined
		let session: SessionInfo
		try { session = await ctx.session.get({ sessionID: childSessionID }) } catch { return undefined }
		if (session.id !== childSessionID || !isV2DelegationSessionInLocation(session, ctx.location) ||
			!await childBelongsTo(session, parentSessionID) || session.agent !== agentID ||
			(session.outcome !== "failed" && session.outcome !== "interrupted")) return undefined
		const currentModel = nativeRequestModel(session.model)
		if (!currentModel) return undefined
		const stored = await settingsStore.read(childSessionID, { parentSessionID, agentID, model: currentModel })
		const witness = stored?.failureWitness
		const timeout = witness?.reason === "timeout"
		if (!stored?.fallbackState || !witness || witness.background === allowForeground ||
			session.outcome !== (timeout ? "interrupted" : "failed") ||
			witness.sessionID !== childSessionID || witness.parentSessionID !== parentSessionID || witness.agentID !== agentID ||
			!sameModel(witness.model, currentModel) || (!timeout && !policy.retryOnErrors.includes(witness.responseStatus)) ||
			typeof session.time?.idle !== "number" || session.time.idle !== witness.idle) return undefined
		const agent = (await ctx.agent.list()).data.find((candidate) => candidate.id === agentID)
		if (!agent || agent.mode === "primary") return undefined
		let parent: SessionInfo
		try { parent = await ctx.session.get({ sessionID: parentSessionID }) } catch { return undefined }
		if (!isV2DelegationSessionInLocation(parent, ctx.location)) return undefined
		const catalog = (await ctx.model.list()).data
		const defaultModel = (await ctx.model.default()).data
		const selected = initialFallbackState(config, agent, parent, {
			...nativeChoice(currentModel, stored.settings),
			...(stored.fallbackState.originCategory ? { originCategory: stored.fallbackState.originCategory } : {}),
		}, catalog, defaultModel)
		if (!selected || selected.source !== stored.fallbackState.source) return undefined
		let liveState: DelegationFallbackState = {
			...selected,
			attempts: stored.fallbackState.attempts,
			failedAt: stored.fallbackState.failedAt,
		}
		let failedModel = currentModel
		let advanced: ReturnType<typeof advanceV2DelegationFallback>
		while ((advanced = advanceV2DelegationFallback(liveState, failedModel, {
			now: Date.now(),
			cooldownMs: policy.cooldownMs,
			maxAttempts: policy.maxAttempts,
		}))) {
			try { await requireAvailableModel(ctx, advanced.choice.model, config.disabled_providers) } catch { return undefined }
			if (await shouldStop(parentSessionID, childSessionID)) return undefined
			const token: PreparedV2DelegationFallbackResume = Object.freeze({
				choice: advanced.choice,
				fallbackState: advanced.state,
			})
			preparedProofs.set(token, {
				sessionID: childSessionID,
				parentSessionID,
				agentID,
				witness,
				previousModel: currentModel,
				previousSettings: stored.settings,
				previousFallbackState: stored.fallbackState,
				choice: advanced.choice,
				fallbackState: advanced.state,
			})
			return token
		}
		return undefined
	}

	async function persistConsumedFallback(proof: PreparedFallbackProof): Promise<boolean> {
		const current = await currentSessionProof(proof)
		if (!current || await shouldStop(proof.parentSessionID, proof.sessionID)) return false
		try { await requireAvailableModel(ctx, proof.choice.model, config.disabled_providers) } catch { return false }
		const consumed = await settingsStore.consumeFailureWitness({
			sessionID: proof.sessionID,
			expected: { parentSessionID: proof.parentSessionID, agentID: proof.agentID, model: proof.previousModel },
			witness: proof.witness,
			consumedModel: proof.choice.model,
			settings: proof.choice.settings,
			fallbackState: proof.fallbackState,
		})
		return consumed !== undefined
	}

	async function persistInitialSelection(
		childSessionID: string,
		parentSessionID: string,
		agent: AgentInfo,
		choice: DelegationModelChoice,
		settings: Readonly<Record<string, unknown>>,
	): Promise<void> {
		const child = await ctx.session.get({ sessionID: childSessionID })
		const parent = await ctx.session.get({ sessionID: parentSessionID })
		if (child.id !== childSessionID || !isV2DelegationSessionInLocation(child, ctx.location) ||
			!await childBelongsTo(child, parentSessionID) || !isV2DelegationSessionInLocation(parent, ctx.location)) {
			throw new ToolError({ message: `Cannot persist fallback state for unverified child session ${childSessionID}.` })
		}
		const [catalog, defaultModel] = await Promise.all([ctx.model.list(), ctx.model.default()])
		const fallbackState = initialFallbackState(config, agent, parent, choice, catalog.data, defaultModel.data)
		await settingsStore.write({
			sessionID: childSessionID,
			parentSessionID,
			agentID: agent.id,
			model: choice.model,
			settings,
			...(choice.originCategory ? { originCategory: choice.originCategory } : {}),
			...(fallbackState ? { fallbackState } : {}),
		})
	}

	function nativeSubagentFailure(error: unknown, childSessionID: string): boolean {
		return Schema.is(ToolError)(error) && error.message.startsWith(`Subagent failed (sessionID: ${childSessionID}):`)
	}

	function nativeSubagentCancelled(error: unknown, childSessionID: string): boolean {
		return Schema.is(ToolError)(error) && error.message.startsWith(`Subagent cancelled (sessionID: ${childSessionID})`)
	}

	async function invokePrepared(
		execute: NativeSubagent["execute"],
		args: Record<string, unknown>,
		context: ToolContext,
		prepared: PreparedV2DelegationFallbackResume,
	): Promise<NativeResult> {
		preparedByArgs.set(args, prepared)
		trustedChoices.set(args, prepared.choice)
		try { return await execute(args as never, context) } finally {
			preparedByArgs.delete(args)
			trustedChoices.delete(args)
			preparedProofs.delete(prepared)
		}
	}

	async function ready(): Promise<void> {
		if (disposed) throw new Error("Delegation admission has been disposed.")
		await admission.ready()
		if (childRetryPolicy(config)) await registerObservers()
	}

	function wrap(native: NativeSubagent): NativeSubagent {
		const cached = wrappedExecutors.get(native.execute)
		if (cached) return native.execute === cached ? native : { ...native, execute: cached }

		const originalExecute = native.execute
		const execute: NativeSubagent["execute"] = async (rawInput, context) => {
			await ready()
			const inputRecord = record(rawInput)
			if (!inputRecord) throw new ToolError({ message: "Native subagent input must be an object." })
			const nativeInput = rawInput as NativeInput
			const trustedChoice = trustedChoices.get(rawInput as object)
			const preparedFallback = preparedByArgs.get(rawInput as object)
			const preparedProof = preparedFallback ? preparedProofs.get(preparedFallback) : undefined
			if (preparedFallback && (!preparedProof || nativeInput.sessionID !== preparedProof.sessionID ||
				context.sessionID !== preparedProof.parentSessionID || nativeInput.agent !== preparedProof.agentID)) {
				throw new ToolError({ message: "Prepared child fallback does not match this owned native task resume." })
			}
			const { agent, model, settings, choice } = await resolveV2SubagentModel(ctx, nativeInput, context.sessionID, {
				config,
				settingsStore,
				trustedChoice,
				...(preparedProof ? { preparedChoice: preparedProof.choice } : {}),
			})
			const mode = typeof nativeInput.sessionID === "string" && nativeInput.sessionID ? "resume" : "new"
			const admissionModel: AdmissionModel = { providerID: model.providerID, id: model.id }
			let ticket: BackgroundAdmissionTicket
			try {
				ticket = mode === "resume"
					? await admission.acquire({ parentSessionID: context.sessionID, model: admissionModel, mode, sessionID: nativeInput.sessionID!, signal: context.signal })
					: await admission.acquire({ parentSessionID: context.sessionID, model: admissionModel, mode, signal: context.signal })
			} catch (error) {
				throw nativeToolError(error)
			}

			try {
				await ticket.beginCreate()
			} catch (error) {
				try { await ticket.rollback() } catch { /* Preserve the admission/storage failure. */ }
				if (preparedProof) throw nativeToolError(error)
				throw nativeToolError(error)
			}
			let boundSessionID: string | undefined
			const bindChild = async (childSessionID: string): Promise<boolean> => {
				if (boundSessionID && boundSessionID !== childSessionID) {
					throw new ToolError({ message: `Native subagent invocation reported multiple child sessions (${boundSessionID}, ${childSessionID}).` })
				}
				if (boundSessionID) return false
				try {
					await ticket.bind(childSessionID)
				} catch (error) {
					throw nativeToolError(error)
				}
				boundSessionID = childSessionID
				return true
			}
			const executionStartedAt = Date.now()
			let baselineIdle: number | undefined
			if (mode === "resume" && nativeInput.sessionID) {
				let child: SessionInfo
				try { child = await ctx.session.get({ sessionID: nativeInput.sessionID }) } catch (error) {
					try { await ticket.rollback() } catch { /* Preserve the lookup error. */ }
					throw nativeToolError(error)
				}
				if (child.id !== nativeInput.sessionID || !isV2DelegationSessionInLocation(child, ctx.location) ||
					!await childBelongsTo(child, context.sessionID) || (preparedProof && child.agent !== agent.id)) {
					try { await ticket.rollback() } catch { /* Preserve the ownership error. */ }
					throw new ToolError({ message: `Session ${nativeInput.sessionID} is not an eligible child task for ${agent.id}.` })
				}
				baselineIdle = typeof child.time?.idle === "number" && Number.isFinite(child.time.idle) ? child.time.idle : undefined
				invocations.set(nativeInput.sessionID, {
					sessionID: nativeInput.sessionID,
					parentSessionID: context.sessionID,
					agentID: agent.id,
					model,
					startedAt: executionStartedAt,
					background: nativeInput.background === true,
					...(baselineIdle !== undefined ? { baselineIdle } : {}),
				})
			}
			const delegatedContext: ToolContext = {
				...context,
				progress: async (metadata) => {
					const childSessionID = record(metadata)?.sessionID
					const firstProgress = typeof childSessionID === "string" ? await bindChild(childSessionID) : false
					if (firstProgress && typeof childSessionID === "string") {
						if (mode === "new") await persistInitialSelection(childSessionID, context.sessionID, agent, choice, settings)
						const child = await ctx.session.get({ sessionID: childSessionID })
						const progressInvocation: ChildInvocation = {
							sessionID: childSessionID,
							parentSessionID: context.sessionID,
							agentID: agent.id,
							model,
							startedAt: executionStartedAt,
							background: nativeInput.background === true,
							...(mode === "resume" && typeof child.time?.idle === "number" ? { baselineIdle: child.time.idle } : {}),
						}
						const existingInvocation = invocations.get(childSessionID)
						if (existingInvocation && (existingInvocation.parentSessionID !== context.sessionID || existingInvocation.agentID !== agent.id || !sameModel(existingInvocation.model, model))) {
							throw new ToolError({ message: `Native task invocation changed the verified owner or model for ${childSessionID}.` })
						}
						invocations.set(childSessionID, existingInvocation ?? progressInvocation)
					}
					const result = await context.progress(metadata)
					if (firstProgress && typeof childSessionID === "string" && !isAliasInvocation(context)) {
						await recordDirectChild(childSessionID, context.sessionID)
					}
					return result
				},
			}
			const pinnedInput = { ...nativeInput, agent: agent.id, model: modelText(model) } as typeof rawInput
			let result: NativeResult
			try {
				if (preparedProof) {
					if (context.signal.aborted || await shouldStop(preparedProof.parentSessionID, preparedProof.sessionID) || !await persistConsumedFallback(preparedProof)) {
						throw new ToolError({ message: "The child failure changed or fallback was stopped before retry admission; no model switch was made." })
					}
					if (context.signal.aborted || await shouldStop(preparedProof.parentSessionID, preparedProof.sessionID)) {
						await settingsStore.restoreFailureWitness({
							sessionID: preparedProof.sessionID,
							expected: { parentSessionID: preparedProof.parentSessionID, agentID: preparedProof.agentID, model: preparedProof.previousModel },
							model: preparedProof.choice.model,
							witness: preparedProof.witness,
							settings: preparedProof.previousSettings,
							fallbackState: preparedProof.previousFallbackState,
						})
						throw new ToolError({ message: "The parent or child was stopped before the fallback model request began." })
					}
				}
				result = await originalExecute(pinnedInput, delegatedContext)
			} catch (error) {
				try {
					await ticket.rollback({ executionSettled: true })
				} catch {
					// Keep the original native permission/depth/model failure visible.
				}
				const childSessionID = boundSessionID ?? (mode === "resume" ? nativeInput.sessionID : undefined)
				const invocation = childSessionID ? invocations.get(childSessionID) : undefined
				if (invocation) clearWatchdog(invocation)
				const timedOut = invocation?.timedOut === true && childSessionID !== undefined && nativeSubagentCancelled(error, childSessionID)
				if (invocation && !invocation.background && childSessionID && (timedOut || nativeSubagentFailure(error, childSessionID)) && !context.signal.aborted) {
					try {
						const witness = timedOut ? await verifyTimeout(invocation) : await verifyFailure(invocation)
						if (witness) {
							await settingsStore.recordFailureWitness(childSessionID, {
								parentSessionID: invocation.parentSessionID,
								agentID: invocation.agentID,
								model: invocation.model,
							}, witness)
							const next = await prepareFallback(childSessionID, invocation.parentSessionID, invocation.agentID, true)
							if (next) {
								const retryArgs: Record<string, unknown> = {
									...nativeInput,
									sessionID: childSessionID,
									model: modelText(next.choice.model),
									background: false,
									prompt: "Continue the existing child task from its session history. Do not repeat completed work; proceed with the next configured fallback model.",
								}
								return await invokePrepared(execute, retryArgs, context, next)
							}
						}
					} catch (recoveryError) {
						log("[v2 delegation] Foreground child fallback failed closed.", {
							sessionID: childSessionID,
							error: textError(recoveryError),
						})
					}
				}
				if (childSessionID) invocations.delete(childSessionID)
				throw error
			}

			const output = resultSession(result)
			if (!boundSessionID && output.sessionID) {
				throw new ToolError({
					message: `Native subagent returned child session ${output.sessionID} without the required pre-prompt progress event. The child cannot be safely registered or restricted; its admission remains held for reconciliation.`,
				})
			}
			if (!boundSessionID) {
				throw new ToolError({ message: "Native subagent returned without a child session identity or pre-prompt progress event; its admission remains held for safe reconciliation." })
			}
			if (output.sessionID && output.sessionID !== boundSessionID) {
				throw new ToolError({ message: `Native subagent result session ${output.sessionID} does not match bound session ${boundSessionID}.` })
			}
			if (output.status === "completed") {
				try {
					await ticket.rollback({ executionSettled: true })
				} catch {
					// The successful result remains valid; unresolved leases stay fail-closed.
				}
				invocations.delete(boundSessionID)
			}
			return result
		}

		wrappedExecutors.set(originalExecute, execute)
		wrappedExecutors.set(execute, execute)
		return { ...native, execute }
	}

	async function invokeWithSelection(
		native: NativeSubagent,
		args: Record<string, unknown>,
		context: ToolContext,
		choice?: DelegationModelChoice,
		preparedFallback?: PreparedV2DelegationFallbackResume,
	): Promise<NativeResult> {
		const wrapped = wrap(native)
		if (preparedFallback) {
			const proof = preparedProofs.get(preparedFallback)
			if (!proof || (choice !== undefined && choice !== preparedFallback.choice) || args.sessionID !== proof.sessionID ||
				context.sessionID !== proof.parentSessionID || args.agent !== proof.agentID) {
				throw new ToolError({ message: "Prepared fallback token is invalid for this native child resume." })
			}
			return invokePrepared(wrapped.execute, args, context, preparedFallback)
		}
		if (!choice) return wrapped.execute(args, context)
		trustedChoices.set(args, choice)
		try {
			return await wrapped.execute(args, context)
		} finally {
			trustedChoices.delete(args)
		}
	}

	async function observeExecution(eventValue: unknown): Promise<void> {
		const raw = record(eventValue)
		const progressSession = raw && typeof raw.type === "string" && CHILD_PROGRESS_EVENTS.has(raw.type) ? record(raw.data)?.sessionID : undefined
		if (typeof progressSession === "string") {
			const watched = invocations.get(progressSession)
			if (watched) clearWatchdog(watched)
		}
		const event = executionEvent(eventValue)
		try { await admission.observeExecution(eventValue) } catch (error) {
			log("[v2 delegation] Admission observation failed while processing a child event.", error)
		}
		if (!event) return
		const childSessionID = typeof event.data?.sessionID === "string" ? event.data.sessionID : undefined
		if (!childSessionID) return
		if (event.type === "session.deleted") {
			invocations.delete(childSessionID)
			return
		}
		const invocation = invocations.get(childSessionID)
		if (!invocation) return
		if (event.type === "session.execution.succeeded" || event.type === "session.execution.failed" || event.type === "session.execution.interrupted") clearWatchdog(invocation)
		if (event.type === "session.execution.interrupted" && invocation.background && invocation.timedOut) {
			try {
				const witness = await verifyTimeout(invocation)
				if (witness) await settingsStore.recordFailureWitness(childSessionID, {
					parentSessionID: invocation.parentSessionID,
					agentID: invocation.agentID,
					model: invocation.model,
				}, witness)
			} catch (error) {
				log("[v2 delegation] Background child timeout could not be persisted; explicit retry is disabled.", { sessionID: childSessionID, error: textError(error) })
			}
		}
		// The foreground catch path owns a watchdog interruption; keep its invocation until it runs.
		if (event.type === "session.execution.interrupted" && invocation.timedOut && !invocation.background) return
		if (event.type === "session.execution.succeeded" || event.type === "session.execution.interrupted") {
			if (event.created !== undefined && event.created >= (invocation.primary?.requestedAt ?? invocation.startedAt) && invocations.get(childSessionID) === invocation) {
				invocations.delete(childSessionID)
			}
			return
		}
		if (event.type !== "session.execution.failed" || !invocation.background) return
		try {
			const witness = await verifyFailure(invocation, eventValue)
			if (!witness) return
			const persisted = await settingsStore.recordFailureWitness(childSessionID, {
				parentSessionID: invocation.parentSessionID,
				agentID: invocation.agentID,
				model: invocation.model,
			}, witness)
			if (persisted && invocations.get(childSessionID) === invocation) invocations.delete(childSessionID)
		} catch (error) {
			log("[v2 delegation] Background provider failure could not be persisted; explicit retry is disabled.", {
				sessionID: childSessionID,
				error: textError(error),
			})
		}
	}

	async function dispose(): Promise<void> {
		if (disposed) return
		disposed = true
		const errors: unknown[] = []
		for (const dispose of observerDisposers.reverse()) {
			try { await dispose() } catch (error) { errors.push(error) }
		}
		for (const invocation of invocations.values()) clearWatchdog(invocation)
		const operations = [...pending]
		if (operations.length) await Promise.allSettled(operations)
		observerDisposers.length = 0
		invocations.clear()
		await admission.dispose()
		if (errors.length) throw new AggregateError(errors, "Delegation admission cleanup failed")
	}

	return {
		background: { acquire: admission.acquire },
		ready,
		wrap,
		invokeWithSelection,
		prepareExplicitFallbackResume: (childSessionID, parentSessionID, agentID) => prepareFallback(childSessionID, parentSessionID, agentID, false),
		removeSettings: (sessionID) => settingsStore.remove(sessionID),
		observeExecution,
		dispose,
	}
}
