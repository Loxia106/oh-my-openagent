import { createHash } from "node:crypto"
import { realpath } from "node:fs/promises"
import type { Plugin } from "@opencode/plugin"
import type { OhMyOpenCodeConfig } from "../config"
import { AGENT_TOOLS, REMINDER_MESSAGE, TARGET_TOOLS } from "../hooks/agent-usage-reminder/constants"
import { getAgentConfigKey } from "../shared/agent-display-names"
import { log } from "../shared/logger"

const STORAGE_PREFIX = "oh-my-openagent:v2:agent-usage-reminder:"
const MAX_REMINDERS = 3
const MAX_SEEN_CALLS = 64
const DELEGATION_TOOLS = new Set([...AGENT_TOOLS, "subagent"])
const ORCHESTRATOR_AGENTS = new Set([
	"sisyphus",
	"sisyphus-junior",
	"atlas",
	"hephaestus",
	"prometheus",
])

type ReminderState = {
	readonly version: 1
	readonly location: string
	readonly sessionID: string
	readonly agentUsed: boolean
	readonly reminderCount: number
	readonly seenCallIDs: readonly string[]
}

type NativeResult = {
	readonly content?: string | readonly unknown[]
	readonly metadata?: Record<string, unknown>
	readonly output?: unknown
}

type NativeToolEvent = {
	readonly tool: string
	readonly sessionID: string
	readonly agent: string
	readonly messageID: string
	readonly id: string
	readonly status: "completed" | "error"
	result?: NativeResult
}

type NativeEvent = {
	readonly type: string
	readonly location?: unknown
	readonly data?: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

function decodeState(value: unknown, location: string, sessionID: string): ReminderState {
	if (!isRecord(value) || value.version !== 1 || value.location !== location || value.sessionID !== sessionID) {
		return { version: 1, location, sessionID, agentUsed: false, reminderCount: 0, seenCallIDs: [] }
	}
	const reminderCount = typeof value.reminderCount === "number" && Number.isInteger(value.reminderCount)
		? Math.min(MAX_REMINDERS, Math.max(0, value.reminderCount))
		: 0
	return {
		version: 1,
		location,
		sessionID,
		agentUsed: value.agentUsed === true,
		reminderCount,
		seenCallIDs: Array.isArray(value.seenCallIDs)
			? value.seenCallIDs.filter((id): id is string => typeof id === "string").slice(-MAX_SEEN_CALLS)
			: [],
	}
}

function appendReminder(content: NativeResult["content"]): NativeResult["content"] {
	if (typeof content === "string") return `${content}${content.trim() ? "\n\n" : ""}${REMINDER_MESSAGE.trim()}`
	return [...(content ?? []), { type: "text", text: REMINDER_MESSAGE.trim() }]
}

async function locationMatches(eventLocation: unknown, ctx: Plugin.Context, canonicalDirectory: string): Promise<boolean> {
	if (!isRecord(eventLocation)) return true
	if (typeof eventLocation.directory === "string") {
		const eventDirectory = await realpath(eventLocation.directory).catch(() => eventLocation.directory as string)
		if (eventDirectory !== canonicalDirectory && eventDirectory !== String(ctx.location.directory)) return false
	}
	if (typeof eventLocation.workspaceID === "string" && eventLocation.workspaceID !== ctx.location.workspaceID) return false
	return true
}

function deletedSessionID(event: NativeEvent): string | undefined {
	if (!isRecord(event.data)) return undefined
	return typeof event.data.sessionID === "string" ? event.data.sessionID : undefined
}

async function locationScope(ctx: Plugin.Context): Promise<{ scope: string; canonicalDirectory: string }> {
	const location = ctx.location as unknown as Record<string, unknown>
	const project = isRecord(location.project) ? location.project : undefined
	const directory = String(location.directory ?? "")
	const canonicalDirectory = await realpath(directory).catch(() => directory)
	const canonicalProject = typeof project?.canonical === "string"
		? await realpath(project.canonical).catch(() => project.canonical as string)
		: ""
	const identity = [
		canonicalDirectory,
		String(location.workspaceID ?? ""),
		String(project?.id ?? ""),
		canonicalProject,
	].join("\0")
	return { scope: createHash("sha256").update(identity).digest("hex"), canonicalDirectory }
}

function storageKey(location: string, sessionID: string): string {
	return `${STORAGE_PREFIX}${location}:${encodeURIComponent(sessionID)}`
}

function enqueue<T>(queues: Map<string, Promise<void>>, key: string, operation: () => Promise<T>): Promise<T> {
	const previous = queues.get(key) ?? Promise.resolve()
	let release!: () => void
	const current = new Promise<void>((resolve) => { release = resolve })
	const tail = previous.catch(() => undefined).then(() => current)
	queues.set(key, tail)
	return (async () => {
		await previous.catch(() => undefined)
		try {
			return await operation()
		} finally {
			release()
			if (queues.get(key) === tail) queues.delete(key)
		}
	})()
}

/** Native, durable, per-location/session state for the legacy agent-usage reminder. */
export async function registerV2AgentUsageReminder(
	ctx: Plugin.Context,
	config: OhMyOpenCodeConfig,
): Promise<() => Promise<void>> {
	if (config.disabled_hooks?.includes("agent-usage-reminder")) return async () => undefined

	const { scope: location, canonicalDirectory } = await locationScope(ctx)
	const queues = new Map<string, Promise<void>>()
	const controller = new AbortController()
	let disposed = false

	const registration = await ctx.tool.hook("execute.after", async (rawEvent) => {
		const event = rawEvent as NativeToolEvent
		if (disposed || event.status !== "completed" || !event.result) return
		if (!ORCHESTRATOR_AGENTS.has(getAgentConfigKey(event.agent))) return

		const tool = event.tool.trim().toLowerCase()
		const isDelegation = DELEGATION_TOOLS.has(tool)
		if (!isDelegation && !TARGET_TOOLS.has(tool)) return

		const key = storageKey(location, event.sessionID)
		await enqueue(queues, key, async () => {
			if (disposed) return
			const stored = await ctx.storage.get(key)
			if (disposed) return
			const state = decodeState(stored, location, event.sessionID)
			const callIdentity = `${event.messageID}\0${event.id}`
			if (state.seenCallIDs.includes(callIdentity)) return

			const seenCallIDs = [...state.seenCallIDs, callIdentity].slice(-MAX_SEEN_CALLS)
			let next: ReminderState = { ...state, seenCallIDs }
			if (isDelegation) {
				next = { ...next, agentUsed: true }
			} else {
				if (state.agentUsed || state.reminderCount >= MAX_REMINDERS) {
					await ctx.storage.set(key, next)
					return
				}
				next = { ...next, reminderCount: state.reminderCount + 1 }
			}

			await ctx.storage.set(key, next)
			if (disposed || isDelegation || !event.result) return
			event.result = { ...event.result, content: appendReminder(event.result.content) }
		})
	})

	const eventTask = (async () => {
		try {
			for await (const rawEvent of ctx.event.subscribe({ signal: controller.signal })) {
				if (disposed || controller.signal.aborted) return
				const event = rawEvent as NativeEvent
				if (event.type !== "session.deleted" || !await locationMatches(event.location, ctx, canonicalDirectory)) continue
				const sessionID = deletedSessionID(event)
				if (!sessionID) continue
				const key = storageKey(location, sessionID)
				await enqueue(queues, key, async () => {
					if (disposed) return
					await ctx.storage.remove(key)
				})
			}
		} catch (error) {
			if (!disposed && !controller.signal.aborted) log("[v2 agent usage reminder] Event stream stopped", error)
		}
	})()

	return async () => {
		if (disposed) return
		disposed = true
		controller.abort()
		await registration.dispose()
		await eventTask
		await Promise.all([...queues.values()].map((queue) => queue.catch(() => undefined)))
	}
}
