import type { Plugin } from "@opencode/plugin"
import { log } from "../shared/logger"

const PREFIX = "oh-my-openagent:v2:session-index:v1:"
const PAGE_SIZE = 200
const MAX_SCAN_PAGES = 50
const DEBOUNCE_MS = 250
const TRACKED_EVENTS = new Set([
	"session.created", "session.renamed", "session.moved", "session.agent.selected", "session.model.selected",
	"session.execution.succeeded", "session.execution.failed", "session.execution.interrupted", "session.forked",
])

export type V2SessionIndexRecord = {
	readonly version: 1
	readonly id: string
	readonly projectID: string
	readonly parentID?: string
	readonly title?: string
	readonly agent?: string
	readonly directory: string
	readonly created: number
	readonly updated: number
}

type SessionInfo = Awaited<ReturnType<Plugin.Context["session"]["get"]>>

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

function time(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value
	if (value instanceof Date) return value.getTime()
	if (typeof value === "string") {
		const parsed = Date.parse(value)
		return Number.isFinite(parsed) ? parsed : undefined
	}
	return undefined
}

function decode(value: unknown): V2SessionIndexRecord | undefined {
	if (!isRecord(value) || value.version !== 1 || typeof value.id !== "string" || typeof value.projectID !== "string" ||
		typeof value.directory !== "string" || typeof value.created !== "number" || typeof value.updated !== "number") return undefined
	return {
		version: 1,
		id: value.id,
		projectID: value.projectID,
		...(typeof value.parentID === "string" ? { parentID: value.parentID } : {}),
		...(typeof value.title === "string" ? { title: value.title } : {}),
		...(typeof value.agent === "string" ? { agent: value.agent } : {}),
		directory: value.directory,
		created: value.created,
		updated: value.updated,
	}
}

/**
 * Durable, project-scoped index of native sessions observed while OMO is active. The public v2 plugin
 * API has no session listing, so the index is fed by native session events and by sessions the session
 * tools touch; sessions from before OMO was active are only reachable by their explicit ID.
 */
export function createV2SessionIndex(ctx: Plugin.Context) {
	const projectID = String(ctx.location.project.id)
	const projectPrefix = `${PREFIX}${encodeURIComponent(projectID)}:`
	const key = (sessionID: string) => `${projectPrefix}${encodeURIComponent(sessionID)}`

	const upsert = async (session: SessionInfo): Promise<V2SessionIndexRecord | undefined> => {
		if (String(session.projectID) !== projectID || !session.location?.directory) return undefined
		const record: V2SessionIndexRecord = {
			version: 1,
			id: String(session.id),
			projectID,
			...(session.parentID ? { parentID: String(session.parentID) } : {}),
			...(typeof session.title === "string" && session.title ? { title: session.title } : {}),
			...(session.agent ? { agent: String(session.agent) } : {}),
			directory: String(session.location.directory),
			created: time(session.time?.created) ?? Date.now(),
			updated: time(session.time?.updated) ?? Date.now(),
		}
		await ctx.storage.set(key(record.id), record)
		return record
	}

	return {
		projectID,
		upsert,
		async observe(sessionID: string): Promise<V2SessionIndexRecord | undefined> {
			try {
				return await upsert(await ctx.session.get({ sessionID }))
			} catch {
				return undefined
			}
		},
		async remove(sessionID: string): Promise<void> {
			await ctx.storage.remove(key(sessionID))
		},
		async list(): Promise<V2SessionIndexRecord[]> {
			const records: V2SessionIndexRecord[] = []
			let after: string | undefined
			for (let page = 0; page < MAX_SCAN_PAGES; page++) {
				const result = await ctx.storage.scan({ prefix: projectPrefix, ...(after ? { after } : {}), limit: PAGE_SIZE })
				for (const entry of result.entries) {
					const record = decode(entry.value)
					if (record && record.projectID === projectID && entry.key === key(record.id)) records.push(record)
				}
				if (!result.next || result.next === after) break
				after = result.next
			}
			return records.sort((left, right) => right.updated - left.updated)
		},
	}
}

export type V2SessionIndex = ReturnType<typeof createV2SessionIndex>

const indexes = new WeakMap<object, V2SessionIndex>()

export function getV2SessionIndex(ctx: Plugin.Context): V2SessionIndex {
	const existing = indexes.get(ctx.storage as object)
	if (existing) return existing
	const created = createV2SessionIndex(ctx)
	indexes.set(ctx.storage as object, created)
	return created
}

/** Keep the session index current from native events for this project. */
export async function registerV2SessionIndex(ctx: Plugin.Context): Promise<() => Promise<void>> {
	const index = getV2SessionIndex(ctx)
	const controller = new AbortController()
	const timers = new Map<string, ReturnType<typeof setTimeout>>()
	const refresh = (sessionID: string) => {
		const previous = timers.get(sessionID)
		if (previous) clearTimeout(previous)
		timers.set(sessionID, setTimeout(() => {
			timers.delete(sessionID)
			void index.observe(sessionID).catch((error) => log("[v2 session-index] Could not index a session.", { sessionID, error }))
		}, DEBOUNCE_MS))
	}
	const events = (async () => {
		while (!controller.signal.aborted) {
			try {
				for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
					const data: Record<string, unknown> | undefined = isRecord(event.data) ? event.data : undefined
					const durable = isRecord((event as { durable?: unknown }).durable) ? (event as { durable: Record<string, unknown> }).durable : undefined
					const sessionID = typeof data?.sessionID === "string" ? data.sessionID
						: event.type === "session.created" && typeof durable?.aggregateID === "string" ? durable.aggregateID : undefined
					if (!sessionID) continue
					if (event.type === "session.deleted") {
						const timer = timers.get(sessionID)
						if (timer) { clearTimeout(timer); timers.delete(sessionID) }
						await index.remove(sessionID).catch(() => undefined)
					} else if (TRACKED_EVENTS.has(event.type)) {
						refresh(sessionID)
					}
				}
			} catch (error) {
				if (!controller.signal.aborted) log("[v2 session-index] Event stream stopped; reconnecting.", error)
			}
			if (!controller.signal.aborted) await new Promise((resolve) => setTimeout(resolve, 500))
		}
	})()
	return async () => {
		controller.abort()
		for (const timer of timers.values()) clearTimeout(timer)
		timers.clear()
		await events
	}
}
