import type { Plugin } from "@opencode/plugin"
import type { OhMyOpenCodeConfig } from "../config"
import { mergeCategories } from "../shared/merge-categories"
import { log } from "../shared/logger"
import type { VerifiedLogicalParentResolver } from "./background-admission"
import { createV2DelegationSettings, isV2DelegationSessionInLocation } from "./delegation-settings"
import { getV2SubagentRunState } from "./task-state"

const DEFAULT_TIMEOUT_MS = 120_000
const COOLDOWN_MS = 5 * 60 * 1000
const USER_MESSAGE_IN_PROGRESS_WINDOW_MS = 2_000
const THINKING_SUMMARY_MAX_CHARS = 500
const MAX_TRACKED = 512
const ACTIVITY_EVENTS = new Set([
	"session.execution.started", "session.step.started", "session.step.streamed", "session.step.ended",
	"session.text.started", "session.text.delta", "session.text.ended", "session.reasoning.started",
	"session.reasoning.delta", "session.reasoning.ended", "session.tool.called", "session.tool.progress",
	"session.tool.success", "session.tool.failed", "session.tool.input.delta",
])
const PARENT_ACTIVITY_EVENTS = new Set(["session.execution.started", "session.inbox.enqueued"])

type SessionInfo = Awaited<ReturnType<Plugin.Context["session"]["get"]>>

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Legacy isUnstableTask: an explicit category flag, otherwise Gemini/MiniMax models. */
export function isV2UnstableChild(config: OhMyOpenCodeConfig, modelID: string | undefined, category: string | undefined): boolean {
	const flag = category ? mergeCategories(config.categories)[category]?.is_unstable_agent : undefined
	if (typeof flag === "boolean") return flag
	const model = modelID?.toLowerCase() ?? ""
	return model.includes("gemini") || model.includes("minimax")
}

export function buildV2BabysitterReminder(input: {
	childID: string
	agent: string
	description: string
	idleMs: number
	summary: string | undefined
}): string {
	return `Unstable background agent appears idle for ${Math.round(input.idleMs / 1000)}s.

Task ID: ${input.childID}
Description: ${input.description}
Agent: ${input.agent}
Status: running

Thinking summary (first ${THINKING_SUMMARY_MAX_CHARS} chars):
${input.summary ?? "(No thinking trace available)"}

Suggested actions:
- background_output task_id="${input.childID}" full_session=true include_thinking=true include_tool_results=true message_limit=50
- background_cancel taskId="${input.childID}"

This is a reminder only. No automatic action was taken.`
}

function thinkingSummary(messages: readonly unknown[]): string | undefined {
	const chunks: string[] = []
	for (const message of messages) {
		if (!isRecord(message) || message.type !== "assistant" || !Array.isArray(message.content)) continue
		for (const part of message.content) {
			if (isRecord(part) && part.type === "reasoning" && typeof part.text === "string" && part.text.trim()) chunks.push(part.text)
		}
	}
	const combined = chunks.join("\n").trim()
	if (!combined) return undefined
	return combined.length <= THINKING_SUMMARY_MAX_CHARS ? combined : `${combined.slice(0, THINKING_SUMMARY_MAX_CHARS)}...`
}

/**
 * Legacy `unstable-agent-babysitter`: while an OMO primary root is idle, a running background child on an
 * unstable model that has shown no activity for `babysitting.timeout_ms` gets one reminder in the parent,
 * with its thinking summary and the inspection/cancel tools, at most once per cooldown. No automatic action.
 */
export async function registerV2UnstableAgentBabysitter(
	ctx: Plugin.Context,
	config: OhMyOpenCodeConfig,
	options: { resolveLogicalParent?: VerifiedLogicalParentResolver; timeoutMs?: number; cooldownMs?: number } = {},
): Promise<() => Promise<void>> {
	if (config.disabled_hooks?.includes("unstable-agent-babysitter")) return async () => {}
	const timeoutMs = options.timeoutMs ?? config.babysitting?.timeout_ms ?? DEFAULT_TIMEOUT_MS
	const cooldownMs = options.cooldownMs ?? COOLDOWN_MS
	const runs = getV2SubagentRunState(ctx.storage)
	const settings = createV2DelegationSettings(ctx.storage, ctx.location)
	const lastActivity = new Map<string, number>()
	const reminded = new Map<string, number>()
	const parentRunning = new Set<string>()
	const cancelledParents = new Set<string>()
	const timers = new Map<string, ReturnType<typeof setTimeout>>()
	const controller = new AbortController()
	let active = true

	const touch = <T>(map: Map<string, T>, key: string, value: T) => {
		map.delete(key)
		map.set(key, value)
		while (map.size > MAX_TRACKED) map.delete(map.keys().next().value as string)
	}

	const ownedRoot = async (sessionID: string): Promise<SessionInfo | undefined> => {
		let session: SessionInfo
		try { session = await ctx.session.get({ sessionID }) } catch { return undefined }
		if (session.id !== sessionID || session.parentID || !isV2DelegationSessionInLocation(session, ctx.location)) return undefined
		if (await runs.get(sessionID)) return undefined
		if (options.resolveLogicalParent) {
			try { if (await options.resolveLogicalParent(sessionID)) return undefined } catch { return undefined }
		}
		return session
	}

	const userMessageInProgress = async (parentID: string, now: number): Promise<boolean> => {
		try {
			const messages = await ctx.session.context({ sessionID: parentID }) as unknown[]
			for (let index = messages.length - 1; index >= 0; index--) {
				const message = messages[index]
				if (!isRecord(message)) continue
				if (message.type === "user") {
					const time = isRecord(message.time) && typeof message.time.created === "number" ? message.time.created : undefined
					return time !== undefined && now - time <= USER_MESSAGE_IN_PROGRESS_WINDOW_MS
				}
				if (message.type === "assistant") return false
			}
		} catch {
			return false
		}
		return false
	}

	const check = async (parentID: string) => {
		timers.delete(parentID)
		if (!active || parentRunning.has(parentID) || cancelledParents.has(parentID)) return
		const parent = await ownedRoot(parentID)
		if (!parent) return
		const now = Date.now()
		if (await userMessageInProgress(parentID, now)) return
		let nextCheck: number | undefined
		for (const childID of await runs.children(parentID)) {
			const run = await runs.get(childID)
			if (!run || run.parentSessionID !== parentID || run.status !== "running") continue
			let child: SessionInfo
			try { child = await ctx.session.get({ sessionID: childID }) } catch { continue }
			if (child.parentID !== parentID || !child.model?.id) continue
			let category: string | undefined
			try {
				category = (await settings.read(childID, {
					parentSessionID: parentID,
					agentID: String(child.agent ?? ""),
					model: { providerID: String(child.model.providerID), id: String(child.model.id), ...(child.model.variant ? { variant: String(child.model.variant) } : {}) },
				}))?.originCategory
			} catch {
				category = undefined
			}
			if (!isV2UnstableChild(config, String(child.model.id), category)) continue
			const lastAt = Math.max(lastActivity.get(childID) ?? 0, run.startedAt)
			const idleMs = now - lastAt
			if (idleMs < timeoutMs) {
				nextCheck = Math.min(nextCheck ?? Number.POSITIVE_INFINITY, lastAt + timeoutMs)
				continue
			}
			const previous = reminded.get(childID)
			if (previous !== undefined && now - previous < cooldownMs) {
				nextCheck = Math.min(nextCheck ?? Number.POSITIVE_INFINITY, previous + cooldownMs)
				continue
			}
			let summary: string | undefined
			try { summary = thinkingSummary(await ctx.session.context({ sessionID: childID }) as unknown[]) } catch { summary = undefined }
			if (!active || parentRunning.has(parentID)) return
			touch(reminded, childID, now)
			await ctx.session.synthetic({
				sessionID: parentID,
				text: buildV2BabysitterReminder({
					childID,
					agent: String(child.agent ?? "unknown"),
					description: typeof child.title === "string" ? child.title : childID,
					idleMs,
					summary,
				}),
				description: "OMO unstable agent reminder",
				metadata: { omoUnstableAgentBabysitter: { version: 1, childID } },
				delivery: "queue",
				resume: true,
			})
			log("[v2 unstable-agent-babysitter] Reminder injected.", { parentID, childID, idleMs })
			return
		}
		if (nextCheck !== undefined && Number.isFinite(nextCheck)) schedule(parentID, Math.max(0, nextCheck - Date.now()) + 50)
	}

	const schedule = (parentID: string, delayMs: number) => {
		if (!active) return
		const existing = timers.get(parentID)
		if (existing) clearTimeout(existing)
		timers.set(parentID, setTimeout(() => {
			void check(parentID).catch((error) => log("[v2 unstable-agent-babysitter] Check failed.", { parentID, error }))
		}, delayMs))
	}

	const events = (async () => {
		while (!controller.signal.aborted) {
			try {
				for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
					if (!active) break
					const data: Record<string, unknown> | undefined = isRecord(event.data) ? event.data : undefined
					const sessionID = typeof data?.sessionID === "string" ? data.sessionID : undefined
					if (!sessionID) continue
					const created = typeof (event as { created?: unknown }).created === "number" ? (event as { created: number }).created : Date.now()
					if (ACTIVITY_EVENTS.has(event.type)) touch(lastActivity, sessionID, created)
					if (PARENT_ACTIVITY_EVENTS.has(event.type)) {
						parentRunning.add(sessionID)
						cancelledParents.delete(sessionID)
						const timer = timers.get(sessionID)
						if (timer) { clearTimeout(timer); timers.delete(sessionID) }
					}
					if (event.type === "session.execution.succeeded" || event.type === "session.execution.failed") {
						parentRunning.delete(sessionID)
						const run = await runs.get(sessionID).catch(() => undefined)
						if (run) {
							// A settled child can wake its parent; re-check the parent later.
							if (!parentRunning.has(run.parentSessionID) && !timers.has(run.parentSessionID)) schedule(run.parentSessionID, timeoutMs)
						} else {
							schedule(sessionID, 0)
						}
					} else if (event.type === "session.execution.interrupted") {
						parentRunning.delete(sessionID)
						if (!(await runs.get(sessionID).catch(() => undefined))) cancelledParents.add(sessionID)
					} else if (event.type === "session.deleted") {
						lastActivity.delete(sessionID)
						reminded.delete(sessionID)
						parentRunning.delete(sessionID)
						cancelledParents.delete(sessionID)
						const timer = timers.get(sessionID)
						if (timer) { clearTimeout(timer); timers.delete(sessionID) }
					}
				}
			} catch (error) {
				if (!controller.signal.aborted) log("[v2 unstable-agent-babysitter] Event stream stopped; reconnecting.", error)
			}
			if (!controller.signal.aborted) await new Promise((resolve) => setTimeout(resolve, 500))
		}
	})()

	return async () => {
		active = false
		controller.abort()
		for (const timer of timers.values()) clearTimeout(timer)
		timers.clear()
		await events
	}
}
