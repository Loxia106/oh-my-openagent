import { Error as ToolError, type Info, type ToolContext } from "@opencode/plugin/promise/tool"
import { Model, type Plugin } from "@opencode/plugin"
import type { OhMyOpenCodeConfig } from "../config"
import type { AgentOverrideConfig, CategoryConfig } from "../config/schema"
import type { BackgroundTaskConfig } from "../config/schema/background-task"
import { isProviderDisabled } from "../shared/disabled-providers"
import { DEFAULT_CATEGORIES } from "../tools/delegate-task/builtin-categories"
import { mergeCategories } from "../shared/merge-categories"
import type { DelegationModelChoice, DelegationModelRef } from "./delegation-model-selection"
import { resolveV2DelegationModelSelection } from "./delegation-model-selection"
import { createV2DelegationSettings, type V2DelegationSettings } from "./delegation-settings"
import {
	createV2BackgroundAdmission,
	type AdmissionModel,
	type BackgroundAdmissionTicket,
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
	readonly ready: () => Promise<void>
	readonly wrap: (native: NativeSubagent) => NativeSubagent
	readonly invokeWithSelection: (native: NativeSubagent, args: Record<string, unknown>, context: ToolContext, choice?: DelegationModelChoice) => Promise<NativeResult>
	readonly removeSettings: (sessionID: string) => Promise<void>
	readonly observeExecution: (event: unknown) => Promise<void>
	readonly dispose: () => Promise<void>
}

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
	return choice
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
	if (override) {
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
}): V2DelegationAdmission {
	const { ctx, config, runs, childSessions, isAliasInvocation } = input
	const admission = createV2BackgroundAdmission(ctx, config.background_task as BackgroundTaskConfig | undefined)
	const settingsStore = createV2DelegationSettings(ctx.storage, ctx.location)
	const wrappedExecutors = new WeakMap<NativeSubagent["execute"], NativeSubagent["execute"]>()
	const trustedChoices = new WeakMap<object, DelegationModelChoice>()

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

	function wrap(native: NativeSubagent): NativeSubagent {
		const cached = wrappedExecutors.get(native.execute)
		if (cached) return native.execute === cached ? native : { ...native, execute: cached }

		const originalExecute = native.execute
		const execute: NativeSubagent["execute"] = async (rawInput, context) => {
			const inputRecord = record(rawInput)
			if (!inputRecord) throw new ToolError({ message: "Native subagent input must be an object." })
			const nativeInput = rawInput as NativeInput
			const trustedChoice = trustedChoices.get(rawInput as object)
			const { agent, model, settings } = await resolveV2SubagentModel(ctx, nativeInput, context.sessionID, {
				config,
				settingsStore,
				trustedChoice,
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
			const delegatedContext: ToolContext = {
				...context,
				progress: async (metadata) => {
					const childSessionID = record(metadata)?.sessionID
					const firstProgress = typeof childSessionID === "string" ? await bindChild(childSessionID) : false
					if (firstProgress && typeof childSessionID === "string") {
						await settingsStore.write({
							sessionID: childSessionID,
							parentSessionID: context.sessionID,
							agentID: agent.id,
							model,
							settings,
						})
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
				result = await originalExecute(pinnedInput, delegatedContext)
			} catch (error) {
				try {
					await ticket.rollback({ executionSettled: true })
				} catch {
					// Keep the original native permission/depth/model failure visible.
				}
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
			}
			return result
		}

		wrappedExecutors.set(originalExecute, execute)
		wrappedExecutors.set(execute, execute)
		return { ...native, execute }
	}

	async function invokeWithSelection(native: NativeSubagent, args: Record<string, unknown>, context: ToolContext, choice?: DelegationModelChoice): Promise<NativeResult> {
		const wrapped = wrap(native)
		if (!choice) return wrapped.execute(args, context)
		trustedChoices.set(args, choice)
		try {
			return await wrapped.execute(args, context)
		} finally {
			trustedChoices.delete(args)
		}
	}

	return {
		ready: () => admission.ready(),
		wrap,
		invokeWithSelection,
		removeSettings: (sessionID) => settingsStore.remove(sessionID),
		observeExecution: (event) => admission.observeExecution(event),
		dispose: () => admission.dispose(),
	}
}
