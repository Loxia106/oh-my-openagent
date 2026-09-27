import type { Plugin } from "@opencode/plugin"
import type { SessionPrompt } from "@opencode/plugin/promise/session"
import type { OhMyOpenCodeConfig } from "../config"
import { getAgentConfigKey } from "../shared/agent-display-names"
import { log } from "../shared/logger"
import { isSystemDirective, removeSystemReminders } from "../shared/system-directive"
import type { VerifiedLogicalParentResolver } from "./background-admission"
import { isV2DelegationSessionInLocation } from "./delegation-settings"
import { toV2ModelRef, type V2ModelRef } from "./model-resolution"
import { getV2SubagentRunState } from "./task-state"

const STORAGE_PREFIX = "oh-my-openagent:v2:ultrawork-model:"
const SLASH_COMMAND = /^\s*\/[a-zA-Z][\w-]*(?:\s|$)/
// Same keyword rule as the legacy per-message override (plugin/ultrawork-model-override.ts),
// kept local so the native bundle does not load the V1 message-store override.
const CODE_BLOCK = /```[\s\S]*?```/g
const INLINE_CODE = /`[^`]+`/g
const ULTRAWORK_PATTERN = /\b(ultrawork|ulw)\b/i

function detectUltrawork(text: string): boolean {
	return ULTRAWORK_PATTERN.test(text.replace(CODE_BLOCK, "").replace(INLINE_CODE, ""))
}

type SessionInfo = Awaited<ReturnType<Plugin.Context["session"]["get"]>>

export type V2UltraworkModelRecord = {
	readonly version: 1
	readonly sessionID: string
	readonly previous: V2ModelRef
	readonly applied: V2ModelRef
	readonly messageID: string
	readonly appliedAt: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

function ref(value: unknown): V2ModelRef | undefined {
	if (!isRecord(value) || typeof value.providerID !== "string" || typeof value.id !== "string") return undefined
	return {
		providerID: value.providerID,
		id: value.id,
		...(typeof value.variant === "string" && value.variant !== "default" ? { variant: value.variant } : {}),
	}
}

function sameRef(left: V2ModelRef | undefined, right: V2ModelRef | undefined): boolean {
	return Boolean(left && right && left.providerID === right.providerID && left.id === right.id && (left.variant ?? "") === (right.variant ?? ""))
}

function decode(value: unknown, sessionID: string): V2UltraworkModelRecord | undefined {
	if (!isRecord(value) || value.version !== 1 || value.sessionID !== sessionID || typeof value.messageID !== "string" ||
		typeof value.appliedAt !== "number") return undefined
	const previous = ref(value.previous)
	const applied = ref(value.applied)
	return previous && applied ? { version: 1, sessionID, previous, applied, messageID: value.messageID, appliedAt: value.appliedAt } : undefined
}

/** `agents.<name>.ultrawork` model/variant, as resolved by the legacy per-message override. */
export function resolveV2UltraworkTarget(config: OhMyOpenCodeConfig, agent: string, current: V2ModelRef): V2ModelRef | undefined {
	const agents = config.agents as Record<string, { ultrawork?: { model?: string; variant?: string; reasoning?: unknown } } | undefined> | undefined
	const override = agents?.[getAgentConfigKey(agent)]?.ultrawork
	if (!override?.model && !override?.variant) return undefined
	const variant = override.variant ?? (typeof override.reasoning === "string" ? override.reasoning : undefined)
	if (!override.model) return variant ? { providerID: current.providerID, id: current.id, variant } : undefined
	return toV2ModelRef(override.model, variant)
}

export function isV2UltraworkPrompt(text: string): boolean {
	const cleaned = removeSystemReminders(text)
	return !isSystemDirective(cleaned) && !SLASH_COMMAND.test(cleaned) && detectUltrawork(cleaned)
}

/**
 * Legacy `ultrawork` model override: an explicit ultrawork user turn on an OMO primary root runs on the
 * agent's configured ultrawork model/variant. OpenCode 2 stores the model on the session, so the switch
 * is applied before the turn is admitted and the previous model is restored when that execution ends,
 * unless the user or another policy changed the model meanwhile.
 */
export async function registerV2UltraworkModelOverride(
	ctx: Plugin.Context,
	config: OhMyOpenCodeConfig,
	options: { resolveLogicalParent?: VerifiedLogicalParentResolver } = {},
): Promise<() => Promise<void>> {
	const configured = Object.values((config.agents ?? {}) as Record<string, { ultrawork?: { model?: string; variant?: string } } | undefined>)
		.some((agent) => agent?.ultrawork?.model || agent?.ultrawork?.variant)
	if (!configured) return async () => {}
	const key = (sessionID: string) => `${STORAGE_PREFIX}${encodeURIComponent(sessionID)}`
	const queues = new Map<string, Promise<unknown>>()
	let active = true
	const serialize = <T>(sessionID: string, operation: () => Promise<T>): Promise<T> => {
		const previous = queues.get(sessionID) ?? Promise.resolve()
		const current = previous.catch(() => undefined).then(operation)
		queues.set(sessionID, current)
		return current.finally(() => { if (queues.get(sessionID) === current) queues.delete(sessionID) })
	}

	const effectiveModel = async (session: SessionInfo): Promise<V2ModelRef | undefined> => {
		const selected = ref(session.model)
		if (selected) return selected
		if (session.agent) {
			try {
				const configuredModel = ref((await ctx.agent.get({ agentID: session.agent })).data.model)
				if (configuredModel) return configuredModel
			} catch {
				// Fall through to the host default.
			}
		}
		try {
			const fallback = (await ctx.model.default()).data
			return fallback ? { providerID: String(fallback.providerID), id: String(fallback.id) } : undefined
		} catch {
			return undefined
		}
	}

	const ownedRoot = async (sessionID: string): Promise<SessionInfo | undefined> => {
		let session: SessionInfo
		try { session = await ctx.session.get({ sessionID }) } catch { return undefined }
		if (!active || session.id !== sessionID || session.parentID || !session.agent || !isV2DelegationSessionInLocation(session, ctx.location)) return undefined
		if (await getV2SubagentRunState(ctx.storage).get(sessionID)) return undefined
		if (options.resolveLogicalParent) {
			try { if (await options.resolveLogicalParent(sessionID)) return undefined } catch { return undefined }
		}
		return session
	}

	const available = async (target: V2ModelRef): Promise<boolean> => {
		const model = (await ctx.model.list()).data.find((entry) => String(entry.providerID) === target.providerID && String(entry.id) === target.id)
		if (!model || model.enabled === false) return false
		return !target.variant || model.variants.some((variant) => String(variant.id) === target.variant)
	}

	const apply = async (input: SessionPrompt) => {
		if (!active || !isV2UltraworkPrompt(input.prompt.text)) return
		const session = await ownedRoot(input.sessionID)
		if (!session) return
		const current = await effectiveModel(session)
		if (!current) return
		const target = resolveV2UltraworkTarget(config, String(session.agent), current)
		if (!target || sameRef(target, current)) return
		if (!(await available(target))) {
			log("[v2 ultrawork-model] Configured ultrawork model/variant is unavailable; keeping the session model.", { sessionID: input.sessionID, target })
			return
		}
		const existing = decode(await ctx.storage.get(key(input.sessionID)), input.sessionID)
		const record: V2UltraworkModelRecord = {
			version: 1,
			sessionID: input.sessionID,
			previous: existing && sameRef(existing.applied, current) ? existing.previous : current,
			applied: target,
			messageID: String(input.messageID),
			appliedAt: Date.now(),
		}
		await ctx.storage.set(key(input.sessionID), record)
		if (!active) return
		await ctx.session.switchModel({ sessionID: input.sessionID, model: target })
		log(`[v2 ultrawork-model] ${current.providerID}/${current.id} -> ${target.providerID}/${target.id}${target.variant ? `#${target.variant}` : ""} for an ultrawork turn.`, { sessionID: input.sessionID })
	}

	const restore = async (sessionID: string, eventCreated: number) => {
		const record = decode(await ctx.storage.get(key(sessionID)), sessionID)
		if (!record || eventCreated < record.appliedAt || !active) return
		let session: SessionInfo
		try { session = await ctx.session.get({ sessionID }) } catch {
			await ctx.storage.remove(key(sessionID))
			return
		}
		if (sameRef(ref(session.model), record.applied)) {
			await ctx.session.switchModel({ sessionID, model: record.previous })
			log("[v2 ultrawork-model] Restored the pre-ultrawork session model.", { sessionID, model: record.previous })
		}
		await ctx.storage.remove(key(sessionID))
	}

	const registration = await ctx.session.hook("prompt", (input: SessionPrompt) =>
		serialize(input.sessionID, () => apply(input)).catch((error) => {
			log("[v2 ultrawork-model] Could not apply the ultrawork model override.", { sessionID: input.sessionID, error })
		}))
	const controller = new AbortController()
	const events = (async () => {
		while (!controller.signal.aborted) {
			try {
				for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
					if (!active) break
					if (event.type !== "session.execution.succeeded" && event.type !== "session.execution.failed" &&
						event.type !== "session.execution.interrupted" && event.type !== "session.deleted") continue
					const sessionID = String((event.data as { sessionID?: unknown }).sessionID ?? "")
					if (!sessionID) continue
					if (event.type === "session.deleted") {
						await serialize(sessionID, () => ctx.storage.remove(key(sessionID))).catch(() => undefined)
						continue
					}
					const created = typeof (event as { created?: unknown }).created === "number" ? (event as { created: number }).created : Date.now()
					await serialize(sessionID, () => restore(sessionID, created)).catch((error) => {
						log("[v2 ultrawork-model] Could not restore the session model.", { sessionID, error })
					})
				}
			} catch (error) {
				if (!controller.signal.aborted) log("[v2 ultrawork-model] Event stream stopped; reconnecting.", error)
			}
			if (!controller.signal.aborted) await new Promise((resolve) => setTimeout(resolve, 500))
		}
	})()
	return async () => {
		active = false
		controller.abort()
		await events
		await Promise.allSettled([...queues.values()])
		await registration.dispose()
	}
}
