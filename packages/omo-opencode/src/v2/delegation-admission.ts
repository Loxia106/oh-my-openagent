import { Error as ToolError, type Info, type ToolContext } from "@opencode/plugin/promise/tool"
import { Model, type Plugin } from "@opencode/plugin"
import type { BackgroundTaskConfig } from "../config/schema"
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
type ModelRef = { providerID: string; id: string; variant?: string }
type SessionInfo = Awaited<ReturnType<Plugin.Context["session"]["get"]>>
type AgentInfo = Awaited<ReturnType<Plugin.Context["agent"]["list"]>>["data"][number]
type ModelInfo = Awaited<ReturnType<Plugin.Context["model"]["list"]>>["data"][number]
type NativeResult = Awaited<ReturnType<NativeSubagent["execute"]>>

export type V2DelegationAdmission = {
	readonly ready: () => Promise<void>
	readonly wrap: (native: NativeSubagent) => NativeSubagent
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

function requireAgent(agents: readonly AgentInfo[], id: unknown): AgentInfo {
	if (typeof id !== "string" || !id.trim()) throw new ToolError({ message: "A subagent name is required." })
	const agent = agents.find((candidate) => candidate.id === id)
	if (!agent) throw new ToolError({ message: `Unknown native subagent "${id}".` })
	if (agent.mode === "primary") throw new ToolError({ message: `Agent "${agent.id}" cannot run as a subagent.` })
	return agent
}

async function requireAvailableModel(ctx: Plugin.Context, model: ModelRef): Promise<ModelRef> {
	const available = (await ctx.model.list()).data
	const match = available.find((candidate) => candidate.providerID === model.providerID && candidate.id === model.id && candidate.enabled)
	if (!match) throw new ToolError({ message: `Effective subagent model "${modelText(model)}" is unavailable in the current OpenCode model catalog.` })
	if (model.variant && !match.variants.some((candidate) => candidate.id === model.variant)) {
		const variants = match.variants.map((candidate) => candidate.id).join(", ") || "none"
		throw new ToolError({ message: `Variant "${model.variant}" is unavailable for "${model.providerID}/${model.id}". Available variants: ${variants}.` })
	}
	return model
}

/** Resolve the same precedence as OpenCode's native subagent executor before reserving a pool slot. */
export async function resolveV2SubagentModel(
	ctx: Plugin.Context,
	input: NativeInput,
	parentSessionID: string,
): Promise<{ agent: AgentInfo; model: ModelRef }> {
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

	const selected = existing
		? override ?? (existing.agent !== agent.id ? ref(agent.model) : undefined) ?? ref(existing.model)
		: override ?? ref(agent.model) ?? ref(parent.model)
	const fallback = selected ? undefined : (await ctx.model.default()).data
	const effective = selected ?? ref(fallback)
	if (!effective) throw new ToolError({ message: "OpenCode has no concrete model for this subagent. Select a model or configure a default model before delegating." })
	return { agent, model: await requireAvailableModel(ctx, effective) }
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
	config?: BackgroundTaskConfig
	runs: V2SubagentRunState
	childSessions: Map<string, Set<string>>
	isAliasInvocation: (context: ToolContext) => boolean
}): V2DelegationAdmission {
	const { ctx, config, runs, childSessions, isAliasInvocation } = input
	const admission = createV2BackgroundAdmission(ctx, config)
	const wrappedExecutors = new WeakMap<NativeSubagent["execute"], NativeSubagent["execute"]>()

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
			const { agent, model } = await resolveV2SubagentModel(ctx, nativeInput, context.sessionID)
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

	return {
		ready: () => admission.ready(),
		wrap,
		observeExecution: (event) => admission.observeExecution(event),
		dispose: () => admission.dispose(),
	}
}
