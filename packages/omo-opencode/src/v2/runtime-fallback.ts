import { createHash } from "node:crypto"
import { realpathSync } from "node:fs"
import { normalize, resolve } from "node:path"
import type * as Schema from "effect/Schema"
import type { Plugin } from "@opencode/plugin"
import type { SessionContext, SessionHttpResponse, SessionModelRequest } from "@opencode/plugin/promise/session"
import type { OhMyOpenCodeConfig } from "../config"
import type { AgentOverrideConfig, CategoryConfig, RuntimeFallbackConfig } from "../config/schema"
import { mergeCategories } from "../shared/merge-categories"
import { log } from "../shared/logger"
import { resolveV2DelegationFallbackCandidates, advanceV2DelegationFallback, delegationModelKey, type DelegationFallbackState, type DelegationModelChoice, type DelegationModelRef } from "./delegation-model-selection"
import { isV2DelegationSessionInLocation } from "./delegation-settings"
import type { VerifiedLogicalParentResolver } from "./background-admission"

const STORAGE_PREFIX = "oh-my-openagent:v2:runtime-fallback:"
const STORAGE_PAGE_SIZE = 100
const MAX_CACHED_SESSIONS = 512
const CONTEXT_LOOKUP_TIMEOUT_MS = 900
const MAX_SYNTHETIC_TEXT = 900

type RequestKind = "primary" | "compaction" | "title" | "generate"
type PrimaryRequest = {
	readonly sessionID: string
	readonly agentID: string
	readonly model: DelegationModelRef
	readonly kind: RequestKind
	readonly userMessageID: string
	readonly requestedAt: number
	responseStatus?: number
}

type PrimaryFallbackRecord = {
	readonly version: 1
	readonly sessionID: string
	readonly projectID: string
	readonly directory: string
	readonly workspaceID: string | null
	readonly agentID: string
	readonly originalModel: DelegationModelRef
	readonly currentModel: DelegationModelRef
	readonly currentSettings: Readonly<Record<string, unknown>>
	readonly fallback: DelegationFallbackState
	readonly userMessageID: string
	readonly phase: "pending" | "active"
	readonly lastFailureEventID: string
	readonly lastFailureSeq: number
	readonly failureType: string
	readonly lastSyntheticID: string
	readonly pendingFromModel?: DelegationModelRef
	readonly pendingFailedIdle?: number
	readonly updatedAt: number
}

type CacheEntry = { readonly kind: "valid"; readonly value: PrimaryFallbackRecord } | { readonly kind: "invalid" }
type PrimaryOwnershipProof = {
	readonly userMessageID: string
	readonly models: readonly DelegationModelRef[]
	readonly requireAssistant?: boolean
	readonly errorType?: string
	readonly errorStatus?: number
}

export type V2RuntimeFallbackOptions = {
	readonly resolveLogicalParent?: VerifiedLogicalParentResolver
	readonly isStopped?: (sessionID: string) => boolean | Promise<boolean>
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

function toJson(value: unknown): Schema.Json {
	if (value === null || typeof value === "string" || typeof value === "boolean") return value
	if (typeof value === "number" && Number.isFinite(value)) return value
	if (Array.isArray(value)) return value.map(toJson)
	if (isRecord(value)) {
		const output: Record<string, Schema.Json> = {}
		for (const [key, item] of Object.entries(value)) {
			if (item !== undefined) output[key] = toJson(item)
		}
		return output
	}
	throw new TypeError("Runtime fallback state must contain JSON-compatible values.")
}

function modelRef(value: unknown): DelegationModelRef | undefined {
	if (!isRecord(value) || typeof value.providerID !== "string" || typeof value.id !== "string") return undefined
	return {
		providerID: value.providerID,
		id: value.id,
		...(typeof value.variant === "string" && value.variant !== "default" ? { variant: value.variant } : {}),
	}
}

function decodeChoice(value: unknown): DelegationModelChoice | undefined {
	if (!isRecord(value) || !isRecord(value.settings) ||
		(value.source !== "configured" && value.source !== "requirement" && value.source !== "agent" && value.source !== "parent" && value.source !== "default") ||
		(value.originCategory !== undefined && typeof value.originCategory !== "string")) return undefined
	const model = modelRef(value.model)
	if (!model) return undefined
	return {
		model,
		settings: value.settings,
		source: value.source,
		...(typeof value.originCategory === "string" ? { originCategory: value.originCategory } : {}),
	}
}

function decodeFallback(value: unknown): DelegationFallbackState | undefined {
	if (!isRecord(value) || (value.source !== "agent" && value.source !== "category") ||
		(value.originCategory !== undefined && typeof value.originCategory !== "string") ||
		!Array.isArray(value.candidates) || value.candidates.length === 0 || value.candidates.length > 100 ||
		!Number.isSafeInteger(value.currentIndex) || (value.currentIndex as number) < -1 || (value.currentIndex as number) >= value.candidates.length ||
		!Number.isSafeInteger(value.attempts) || (value.attempts as number) < 0 || (value.attempts as number) > 20 || !isRecord(value.failedAt)) return undefined
	const candidates = value.candidates.map(decodeChoice)
	if (candidates.some((candidate) => candidate === undefined)) return undefined
	const failedAt: Record<string, number> = {}
	for (const [key, item] of Object.entries(value.failedAt)) {
		if (typeof item !== "number" || !Number.isFinite(item) || item < 0) return undefined
		failedAt[key] = item
	}
	return {
		source: value.source,
		...(typeof value.originCategory === "string" ? { originCategory: value.originCategory } : {}),
		candidates: candidates as DelegationModelChoice[],
		currentIndex: value.currentIndex as number,
		attempts: value.attempts as number,
		failedAt,
	}
}

function decodePrimary(value: unknown): PrimaryFallbackRecord | undefined {
	if (!isRecord(value) || value.version !== 1 || typeof value.sessionID !== "string" ||
		typeof value.projectID !== "string" || typeof value.directory !== "string" ||
		(value.workspaceID !== null && typeof value.workspaceID !== "string") || typeof value.agentID !== "string" ||
		typeof value.userMessageID !== "string" || !value.userMessageID ||
		(value.phase !== "pending" && value.phase !== "active") || typeof value.lastFailureEventID !== "string" ||
		!Number.isSafeInteger(value.lastFailureSeq) || (value.lastFailureSeq as number) < 0 ||
		typeof value.failureType !== "string" || !value.failureType.startsWith("provider.") ||
		typeof value.lastSyntheticID !== "string" || !value.lastSyntheticID ||
		(value.pendingFailedIdle !== undefined && (typeof value.pendingFailedIdle !== "number" || !Number.isFinite(value.pendingFailedIdle))) ||
		typeof value.updatedAt !== "number" || !Number.isFinite(value.updatedAt) || !isRecord(value.currentSettings)) return undefined
	const originalModel = modelRef(value.originalModel)
	const currentModel = modelRef(value.currentModel)
	const fallback = decodeFallback(value.fallback)
	if (!originalModel || !currentModel || !fallback) return undefined
	if (value.phase === "pending" && (!modelRef(value.pendingFromModel) || typeof value.pendingFailedIdle !== "number")) return undefined
	return {
		version: 1,
		sessionID: value.sessionID,
		projectID: value.projectID,
		directory: value.directory,
		workspaceID: value.workspaceID as string | null,
		agentID: value.agentID,
		originalModel,
		currentModel,
		currentSettings: value.currentSettings,
		fallback,
		userMessageID: value.userMessageID,
		phase: value.phase,
		lastFailureEventID: value.lastFailureEventID,
		lastFailureSeq: value.lastFailureSeq as number,
		failureType: value.failureType,
		lastSyntheticID: value.lastSyntheticID,
		...(modelRef(value.pendingFromModel) ? { pendingFromModel: modelRef(value.pendingFromModel) } : {}),
		...(typeof value.pendingFailedIdle === "number" ? { pendingFailedIdle: value.pendingFailedIdle } : {}),
		updatedAt: value.updatedAt,
	}
}

function sameModel(left: DelegationModelRef, right: DelegationModelRef): boolean {
	return delegationModelKey(left) === delegationModelKey(right)
}

function canonicalDirectory(directory: string): string {
	const absolute = normalize(resolve(directory))
	try { return normalize(realpathSync.native(absolute)) } catch { return absolute }
}

function scope(ctx: Plugin.Context): string {
	return `${encodeURIComponent(ctx.location.project.id)}:${encodeURIComponent(canonicalDirectory(String(ctx.location.directory)))}:${encodeURIComponent(ctx.location.workspaceID ?? "<no-workspace>")}`
}

function storageKey(scopeID: string, sessionID: string): string {
	return `${STORAGE_PREFIX}${scopeID}:${encodeURIComponent(sessionID)}`
}

type AssistantSnapshot = {
	readonly agentID: string
	readonly model: DelegationModelRef
	readonly errorType?: string
	readonly errorStatus?: number
}

type HistorySnapshot = {
	readonly messages: readonly unknown[]
	readonly userMessageID?: string
	readonly assistant?: AssistantSnapshot
}

function latestHistorySnapshot(messages: readonly unknown[]): HistorySnapshot {
	let latestUserIndex = -1
	let userMessageID: string | undefined
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index]
		if (isRecord(message) && message.type === "user" && typeof message.id === "string" && message.id) {
			latestUserIndex = index
			userMessageID = message.id
			break
		}
	}
	let assistant: AssistantSnapshot | undefined
	for (let index = messages.length - 1; index > latestUserIndex; index -= 1) {
		const message = messages[index]
		if (!isRecord(message) || message.type !== "assistant" || typeof message.agent !== "string") continue
		const model = modelRef(message.model)
		if (!model) continue
		const error = isRecord(message.error) ? message.error : undefined
		assistant = {
			agentID: message.agent,
			model,
			...(typeof error?.type === "string" ? { errorType: error.type } : {}),
			...(typeof error?.status === "number" ? { errorStatus: error.status } : {}),
		}
		break
	}
	return { messages, userMessageID, assistant }
}

function eventData(event: unknown): Record<string, unknown> | undefined {
	if (!isRecord(event) || !isRecord(event.data)) return undefined
	return event.data
}

function eventCreatedAt(event: unknown): number | undefined {
	if (!isRecord(event) || typeof event.created !== "number" || !Number.isFinite(event.created)) return undefined
	return event.created
}

/** Require native provider attribution; message text alone never triggers a model switch. */
function isRetryableProviderFailure(
	error: unknown,
	responseStatus: number | undefined,
	retryOnErrors: readonly number[],
): boolean {
	if (!isRecord(error) || typeof error.type !== "string" || !error.type.startsWith("provider.")) return false
	const errorStatus = typeof error.status === "number" && Number.isSafeInteger(error.status) ? error.status : undefined
	// The public HTTP response hook identifies this session's own model request.
	// Without it, a streamed/transport error cannot yet be distinguished from an
	// unwrapped child/tool cause in the terminal session error.
	if (responseStatus === undefined || responseStatus >= 200 && responseStatus < 300) return false
	if (!retryOnErrors.includes(responseStatus)) return false
	if (errorStatus !== undefined && errorStatus !== responseStatus) return false
	return true
}

function modelFromHook(model: SessionModelRequest["model"]): DelegationModelRef {
	return { providerID: String(model.providerID), id: String(model.id), ...(model.variant ? { variant: String(model.variant) } : {}) }
}

function normalizeConfig(config: OhMyOpenCodeConfig): Required<Pick<RuntimeFallbackConfig, "retry_on_errors" | "max_fallback_attempts" | "cooldown_seconds">> | undefined {
	if (config.disabled_hooks?.includes("runtime-fallback")) return undefined
	const raw = config.runtime_fallback
	if (raw !== true && (!isRecord(raw) || raw.enabled !== true)) return undefined
	return {
		retry_on_errors: Array.isArray(raw === true ? undefined : raw.retry_on_errors)
			? (raw as { retry_on_errors: number[] }).retry_on_errors.filter((item) => Number.isSafeInteger(item) && item >= 100 && item <= 599)
			: [429, 500, 502, 503, 504],
		max_fallback_attempts: typeof raw === "object" && raw !== null && Number.isSafeInteger(raw.max_fallback_attempts)
			? Math.max(1, Math.min(20, raw.max_fallback_attempts as number))
			: 3,
		cooldown_seconds: typeof raw === "object" && raw !== null && typeof raw.cooldown_seconds === "number" && Number.isFinite(raw.cooldown_seconds)
			? Math.max(0, raw.cooldown_seconds)
			: 60,
	}
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T | undefined> {
	let timer: ReturnType<typeof setTimeout> | undefined
	try {
		return await Promise.race([operation, new Promise<undefined>((resolveTimeout) => {
			timer = setTimeout(() => resolveTimeout(undefined), timeoutMs)
		})])
	} finally {
		if (timer !== undefined) clearTimeout(timer)
	}
}

function settingsForAgent(config: OhMyOpenCodeConfig, agentID: string): {
	agent?: AgentOverrideConfig
	agentCategory?: CategoryConfig
} {
	const agents = config.agents as Record<string, AgentOverrideConfig> | undefined
	const agent = agents?.[agentID] ?? Object.entries(agents ?? {}).find(([name]) => name.toLowerCase() === agentID.toLowerCase())?.[1]
	const categories = mergeCategories(config.categories)
	const agentCategory = agent?.category ? categories[agent.category] : undefined
	return { agent, agentCategory }
}

/** Register opt-in recovery only after a verified primary provider failure. */
export async function registerV2RuntimeFallback(
	ctx: Plugin.Context,
	config: OhMyOpenCodeConfig,
	options: V2RuntimeFallbackOptions = {},
): Promise<() => Promise<void>> {
	const settings = normalizeConfig(config)
	if (!settings) return async () => undefined

	const scopeID = scope(ctx)
	const requests = new Map<string, PrimaryRequest>()
	const cache = new Map<string, CacheEntry>()
	const serialized = new Map<string, Promise<unknown>>()
	const controller = new AbortController()
	const pending = new Set<Promise<unknown>>()
	let active = true
	let modelRequestHook: Awaited<ReturnType<typeof ctx.session.hook>> | undefined
	let httpResponseHook: Awaited<ReturnType<typeof ctx.session.hook>> | undefined
	let contextHook: Awaited<ReturnType<typeof ctx.session.hook>> | undefined
	let eventTask: Promise<void> | undefined

	const remember = (sessionID: string, entry: CacheEntry) => {
		cache.delete(sessionID)
		while (cache.size >= MAX_CACHED_SESSIONS) cache.delete(cache.keys().next().value as string)
		cache.set(sessionID, entry)
	}

	const isCurrentScope = (value: PrimaryFallbackRecord, sessionID: string): boolean =>
		value.sessionID === sessionID &&
		value.projectID === ctx.location.project.id &&
		value.directory === canonicalDirectory(String(ctx.location.directory)) &&
		value.workspaceID === (ctx.location.workspaceID ?? null)

	const readStateOrEmpty = async (sessionID: string): Promise<{ kind: "missing" } | { kind: "invalid" } | { kind: "valid"; value: PrimaryFallbackRecord }> => {
		const cached = cache.get(sessionID)
		if (cached) {
			if (cached.kind === "valid") return isCurrentScope(cached.value, sessionID) ? cached : { kind: "invalid" }
			const raw = await ctx.storage.get(storageKey(scopeID, sessionID))
			return raw === undefined ? { kind: "missing" } : { kind: "invalid" }
		}
		const raw = await ctx.storage.get(storageKey(scopeID, sessionID))
		if (raw === undefined) {
			const missing: CacheEntry = { kind: "invalid" }
			remember(sessionID, missing)
			return { kind: "missing" }
		}
		const value = decodePrimary(raw)
		if (!value || !isCurrentScope(value, sessionID)) {
			remember(sessionID, { kind: "invalid" })
			log("[v2 runtime-fallback] Invalid or cross-scope primary fallback state; leaving session unchanged.", { sessionID })
			return { kind: "invalid" }
		}
		const valid: CacheEntry = { kind: "valid", value }
		remember(sessionID, valid)
		return valid
	}

	const writeState = async (value: PrimaryFallbackRecord): Promise<void> => {
		if (!active || !isCurrentScope(value, value.sessionID)) return
		await ctx.storage.set(storageKey(scopeID, value.sessionID), toJson(value))
		if (active) remember(value.sessionID, { kind: "valid", value })
	}

	const removeState = async (sessionID: string): Promise<void> => {
		cache.delete(sessionID)
		requests.delete(sessionID)
		await ctx.storage.remove(storageKey(scopeID, sessionID))
	}

	const rememberRequest = (sessionID: string, request: PrimaryRequest) => {
		requests.delete(sessionID)
		while (requests.size >= MAX_CACHED_SESSIONS) requests.delete(requests.keys().next().value as string)
		requests.set(sessionID, request)
	}

	const isStopped = async (sessionID: string): Promise<boolean> => {
		try { return active && await options.isStopped?.(sessionID) === true } catch { return true }
	}

	const latestHistory = async (sessionID: string): Promise<HistorySnapshot | undefined> => {
		const messages = await withTimeout(ctx.session.context({ sessionID }), CONTEXT_LOOKUP_TIMEOUT_MS)
		if (!Array.isArray(messages)) return undefined
		return latestHistorySnapshot(messages)
	}

	const effectiveSessionModel = async (
		session: Awaited<ReturnType<Plugin.Context["session"]["get"]>>,
		agentID: string,
	): Promise<DelegationModelRef | undefined> => {
		const selected = modelRef(session.model)
		if (selected) return selected
		try {
			const agent = await withTimeout(ctx.agent.get({ agentID }), CONTEXT_LOOKUP_TIMEOUT_MS)
			if (!agent) return undefined
			const configured = modelRef(agent?.data.model)
			if (configured) return configured
		} catch { return undefined }
		try {
			const hostDefault = await withTimeout(ctx.model.default(), CONTEXT_LOOKUP_TIMEOUT_MS)
			return modelRef(hostDefault?.data)
		} catch { return undefined }
	}

	const isOwnedPrimary = async (
		sessionID: string,
		agentID: string,
		proof?: PrimaryOwnershipProof,
	): Promise<Awaited<ReturnType<Plugin.Context["session"]["get"]>> | undefined> => {
		let session: Awaited<ReturnType<Plugin.Context["session"]["get"]>>
		try { session = await ctx.session.get({ sessionID }) } catch { return undefined }
		if (!active || session.id !== sessionID || (session.agent != null && session.agent !== agentID) || session.parentID ||
			!isV2DelegationSessionInLocation(session, ctx.location)) return undefined
		let agents: Awaited<ReturnType<Plugin.Context["agent"]["list"]>> | undefined
		try { agents = await withTimeout(ctx.agent.list(), CONTEXT_LOOKUP_TIMEOUT_MS) } catch { return undefined }
		const requestedAgent = agents?.data.find((candidate) => candidate.id === agentID)
		if (!requestedAgent || requestedAgent.mode === "subagent") return undefined
		const effectiveModel = await effectiveSessionModel(session, agentID)
		if (!effectiveModel || (proof && !proof.models.some((model) => sameModel(model, effectiveModel)))) return undefined
		if (session.agent == null) {
			if (!proof) return undefined
			const history = await latestHistory(sessionID)
			if (!history || history.userMessageID !== proof.userMessageID) return undefined
			if (proof.requireAssistant !== false) {
				const assistant = history.assistant
				if (!assistant || assistant.agentID !== agentID || !proof.models.some((model) => sameModel(model, assistant.model)) ||
					(proof.errorType !== undefined && assistant.errorType !== proof.errorType) ||
					(proof.errorStatus !== undefined && assistant.errorStatus !== proof.errorStatus)) return undefined
			}
		}
		if (options.resolveLogicalParent) {
			try { if (await options.resolveLogicalParent(sessionID)) return undefined } catch { return undefined }
		}
		return session
	}

	const configuredFallback = async (
		agentID: string,
		currentModel: DelegationModelRef,
	): Promise<{ readonly source: "agent" | "category"; readonly candidates: readonly DelegationModelChoice[] } | undefined> => {
		const [agents, models] = await Promise.all([ctx.agent.list(), ctx.model.list()])
		const agent = agents.data.find((candidate) => candidate.id === agentID)
		if (!agent || agent.mode === "subagent") return undefined
		const configured = settingsForAgent(config, agentID)
		return resolveV2DelegationFallbackCandidates({
			agentID,
			catalog: models.data.map((model) => ({
				providerID: model.providerID,
				id: model.id,
				enabled: model.enabled,
				variants: model.variants.map((variant) => ({ id: variant.id, settings: variant.settings })),
			})),
			disabledProviders: config.disabled_providers,
			agentConfig: configured.agent,
			agentCategory: configured.agentCategory,
			currentModel,
		})
	}

	const serialize = <T>(sessionID: string, operation: () => Promise<T>): Promise<T> => {
		const previous = serialized.get(sessionID) ?? Promise.resolve()
		const current = previous.catch(() => undefined).then(operation)
		serialized.set(sessionID, current)
		return current.finally(() => {
			if (serialized.get(sessionID) === current) serialized.delete(sessionID)
		})
	}

	const track = (operation: Promise<unknown>) => {
		pending.add(operation)
		void operation.finally(() => pending.delete(operation)).catch(() => undefined)
	}

	const settleDelivery = async (value: PrimaryFallbackRecord): Promise<void> => {
		if (!active || value.phase !== "pending" || !value.pendingFromModel || value.pendingFailedIdle === undefined) return
		const pendingFromModel = value.pendingFromModel
		const history = await latestHistory(value.sessionID)
		if (!active || !history || history.userMessageID !== value.userMessageID) return
		const ownershipProof = {
			userMessageID: value.userMessageID,
			models: [pendingFromModel, value.currentModel],
			errorType: value.failureType,
		}
		const session = await isOwnedPrimary(value.sessionID, value.agentID, ownershipProof)
		if (!session || await isStopped(value.sessionID)) return

		const pendingMessageAlreadyStored = history.messages.some((message) => isRecord(message) && message.id === value.lastSyntheticID)
		if (pendingMessageAlreadyStored) {
			await writeState({ ...value, phase: "active", pendingFromModel: undefined, pendingFailedIdle: undefined, updatedAt: Date.now() })
			return
		}
		if (session.outcome !== "failed" || typeof session.time?.idle !== "number" || session.time.idle !== value.pendingFailedIdle) return
		const refreshed = await configuredFallback(value.agentID, pendingFromModel)
		const refreshedIndex = refreshed?.candidates.findIndex((candidate) => sameModel(candidate.model, value.currentModel)) ?? -1
		if (!refreshed || refreshedIndex < 0) return
		const refreshedChoice = refreshed.candidates[refreshedIndex]
		if (!refreshedChoice) return
		value = {
			...value,
			currentSettings: refreshedChoice.settings,
			fallback: {
				...value.fallback,
				source: refreshed.source,
				candidates: refreshed.candidates,
				currentIndex: refreshedIndex,
			},
		}
		await writeState(value)
		if (!active || await isStopped(value.sessionID)) return
		const beforeSwitchHistory = await latestHistory(value.sessionID)
		if (!beforeSwitchHistory || beforeSwitchHistory.userMessageID !== value.userMessageID) return
		const beforeSwitch = await isOwnedPrimary(value.sessionID, value.agentID, ownershipProof)
		if (!beforeSwitch || beforeSwitch.outcome !== "failed" || beforeSwitch.time?.idle !== value.pendingFailedIdle) return

		const liveModel = await effectiveSessionModel(beforeSwitch, value.agentID)
		if (!liveModel) return
		if (sameModel(liveModel, pendingFromModel)) {
			await ctx.session.switchModel({ sessionID: value.sessionID, model: value.currentModel })
		} else if (!sameModel(liveModel, value.currentModel)) {
			return
		}
		if (!active || await isStopped(value.sessionID)) return
		const latest = await latestHistory(value.sessionID)
		if (!latest || latest.userMessageID !== value.userMessageID) return
		const latestSession = await isOwnedPrimary(value.sessionID, value.agentID, ownershipProof)
		const latestModel = latestSession ? await effectiveSessionModel(latestSession, value.agentID) : undefined
		if (!latestSession || latestSession.outcome !== "failed" || latestSession.time?.idle !== value.pendingFailedIdle ||
			!latestModel || !sameModel(latestModel, value.currentModel)) return

		const target = value.currentModel
		const text = `The primary provider attempt failed. Continue the same user request using the configured fallback model ${target.providerID}/${target.id}${target.variant ? `#${target.variant}` : ""}. Do not repeat the user's prompt or completed work; continue from the conversation history.`
		try {
			await ctx.session.synthetic({
				sessionID: value.sessionID,
				id: value.lastSyntheticID as Parameters<Plugin.Context["session"]["synthetic"]>[0]["id"],
				text: text.slice(0, MAX_SYNTHETIC_TEXT),
				description: "OMO runtime fallback continuation",
				metadata: { omoRuntimeFallback: { version: 1, eventID: value.lastFailureEventID, attempt: value.fallback.attempts } },
				delivery: "steer",
				resume: true,
			})
		} catch (error) {
			log("[v2 runtime-fallback] Native fallback continuation could not be queued; state remains pending for deduplicated reconciliation.", {
				sessionID: value.sessionID,
				eventID: value.lastFailureEventID,
				error: error instanceof Error ? error.message : String(error),
			})
			return
		}
		if (!active) return
		await writeState({ ...value, phase: "active", pendingFromModel: undefined, pendingFailedIdle: undefined, updatedAt: Date.now() })
	}

	const restorePendingDeliveries = async (): Promise<void> => {
		let after: string | undefined
		const seen = new Set<string>()
		try {
			do {
				const page = await ctx.storage.scan({ prefix: `${STORAGE_PREFIX}${scopeID}:`, ...(after ? { after } : {}), limit: STORAGE_PAGE_SIZE })
				for (const entry of page.entries) {
					const value = decodePrimary(entry.value)
					if (!value || !isCurrentScope(value, value.sessionID) || entry.key !== storageKey(scopeID, value.sessionID) || value.phase !== "pending") continue
					remember(value.sessionID, { kind: "valid", value })
					await serialize(value.sessionID, () => settleDelivery(value))
				}
				after = page.next
				if (after && seen.has(after)) throw new Error(`Storage scan repeated cursor ${after}.`)
				if (after) seen.add(after)
			} while (after)
		} catch (error) {
			log("[v2 runtime-fallback] Could not reconcile pending persisted deliveries; leaving them fail-closed.", error)
		}
	}

	const recoverFailure = async (event: unknown, request: PrimaryRequest): Promise<void> => {
		const data = eventData(event)
		const eventRecord = isRecord(event) ? event : undefined
		const eventID = typeof eventRecord?.id === "string" ? eventRecord.id : undefined
		const eventCreated = typeof eventRecord?.created === "number" && Number.isFinite(eventRecord.created) ? eventRecord.created : undefined
		const durable = isRecord(eventRecord?.durable) ? eventRecord.durable : undefined
		const seq = typeof durable?.seq === "number" && Number.isSafeInteger(durable.seq) ? durable.seq : undefined
		if (!data || data.sessionID !== request.sessionID || !eventID || eventCreated === undefined ||
			eventCreated < request.requestedAt || seq === undefined || durable?.aggregateID !== request.sessionID) return
		await serialize(request.sessionID, async () => {
			if (!active || request.kind !== "primary" || await isStopped(request.sessionID)) return
			const history = await latestHistory(request.sessionID)
			const error = data.error
			if (!active || !history || !history.userMessageID || history.userMessageID !== request.userMessageID ||
				!history.assistant || history.assistant.agentID !== request.agentID || !sameModel(history.assistant.model, request.model) ||
				!isRecord(error) || typeof error.type !== "string" || history.assistant.errorType !== error.type ||
				(history.assistant.errorStatus !== undefined && error.status !== history.assistant.errorStatus) ||
				!isRetryableProviderFailure(error, request.responseStatus, settings.retry_on_errors)) return
			const ownershipProof: PrimaryOwnershipProof = {
				userMessageID: request.userMessageID,
				models: [request.model],
				errorType: error.type,
				...(typeof error.status === "number" ? { errorStatus: error.status } : {}),
			}
			const ownership = await isOwnedPrimary(request.sessionID, request.agentID, ownershipProof)
			if (!ownership || ownership.outcome !== "failed" || typeof ownership.time?.idle !== "number" ||
				ownership.time.idle < request.requestedAt || ownership.time.idle < eventCreated) return

			const prior = await readStateOrEmpty(request.sessionID)
			if (!active || prior.kind === "invalid") return
			if (prior.kind === "valid" && prior.value.lastFailureEventID === eventID) {
				if (prior.value.phase === "pending") await settleDelivery(prior.value)
				return
			}
			if (prior.kind === "valid" && seq <= prior.value.lastFailureSeq) return
			const chain = await configuredFallback(request.agentID, request.model)
			if (!chain?.candidates.length) return
			let currentState: PrimaryFallbackRecord | undefined
			const priorFallback = prior.kind === "valid" && prior.value.agentID === request.agentID && sameModel(prior.value.currentModel, request.model)
				? prior.value.fallback
				: undefined
			const fallback: DelegationFallbackState = {
				source: chain.source,
				candidates: chain.candidates,
				currentIndex: -1,
				attempts: priorFallback?.attempts ?? 0,
				failedAt: priorFallback?.failedAt ?? {},
			}
			const next = advanceV2DelegationFallback(fallback, request.model, {
				now: Date.now(),
				cooldownMs: settings.cooldown_seconds * 1000,
				maxAttempts: settings.max_fallback_attempts,
			})
			if (!next || !active || await isStopped(request.sessionID)) return
			if (requests.has(request.sessionID)) return
			const latestOwnership = await isOwnedPrimary(request.sessionID, request.agentID, ownershipProof)
			const latestFailure = await latestHistory(request.sessionID)
			const latestModel = latestOwnership ? await effectiveSessionModel(latestOwnership, request.agentID) : undefined
			if (!latestOwnership || latestOwnership.outcome !== "failed" || latestOwnership.time?.idle !== ownership.time.idle ||
				!latestModel || !sameModel(latestModel, request.model) ||
				!latestFailure || latestFailure.userMessageID !== request.userMessageID ||
				latestFailure.assistant?.agentID !== request.agentID || !sameModel(latestFailure.assistant.model, request.model) ||
				latestFailure.assistant.errorType !== error.type) return
			const syntheticID = `msg_${createHash("sha256").update(`${request.sessionID}\n${eventID}\n${delegationModelKey(next.choice.model)}`).digest("hex").slice(0, 32)}`
			currentState = {
				version: 1,
				sessionID: request.sessionID,
				projectID: ctx.location.project.id,
				directory: canonicalDirectory(String(ctx.location.directory)),
				workspaceID: ctx.location.workspaceID ?? null,
				agentID: request.agentID,
				originalModel: prior.kind === "valid" && prior.value.agentID === request.agentID ? prior.value.originalModel : request.model,
				currentModel: next.choice.model,
				currentSettings: next.choice.settings,
				fallback: next.state,
				userMessageID: request.userMessageID,
				phase: "pending",
				lastFailureEventID: eventID,
				lastFailureSeq: seq,
				failureType: error.type,
				lastSyntheticID: syntheticID,
				pendingFromModel: request.model,
				pendingFailedIdle: ownership.time.idle,
				updatedAt: Date.now(),
			}
			await writeState(currentState)
			if (active) await settleDelivery(currentState)
		})
	}

	const dispose = async () => {
		if (!active) return
		active = false
		controller.abort()
		requests.clear()
		cache.clear()
		const errors: unknown[] = []
		try { await eventTask } catch (error) { errors.push(error) }
		const work = [...pending]
		if (work.length) await Promise.allSettled(work)
		for (const registration of [contextHook, httpResponseHook, modelRequestHook]) {
			try { await registration?.dispose() } catch (error) { errors.push(error) }
		}
		if (errors.length) throw new AggregateError(errors, "V2 runtime fallback cleanup failed")
	}

	try {
		modelRequestHook = await ctx.session.hook("model.request", async (input: SessionModelRequest) => {
			if (!active) return
			const sessionID = String(input.sessionID)
			const model = modelFromHook(input.model)
			const history = await latestHistory(sessionID)
			if (!active || !history?.userMessageID) {
				requests.delete(sessionID)
				return
			}
			rememberRequest(sessionID, {
				sessionID,
				agentID: String(input.agent),
				model,
				kind: input.kind,
				userMessageID: history.userMessageID,
				requestedAt: Date.now(),
			})
		})
		httpResponseHook = await ctx.session.hook("http.response", (input: SessionHttpResponse) => {
			if (!active || input.kind !== "primary") return
			const capture = requests.get(String(input.sessionID))
			if (!capture || capture.kind !== input.kind || capture.agentID !== String(input.agent) || !sameModel(capture.model, modelFromHook(input.model))) return
			capture.responseStatus = input.response.status
		})
		contextHook = await ctx.session.hook("context", async (input: SessionContext) => {
			if (!active) return
			const sessionID = String(input.sessionID)
			const state = await readStateOrEmpty(sessionID)
			if (!active || state.kind !== "valid" || state.value.agentID !== String(input.agent) ||
				!sameModel(state.value.currentModel, modelFromHook(input.model))) return
			const history = await latestHistory(sessionID)
			if (!history?.userMessageID || (state.value.phase === "pending" && history.userMessageID !== state.value.userMessageID)) return
			const session = await isOwnedPrimary(sessionID, String(input.agent), {
				userMessageID: history.userMessageID,
				models: [state.value.currentModel],
				requireAssistant: false,
			})
			if (!session || !active || await isStopped(String(input.sessionID))) return
			Object.assign(input.options, state.value.currentSettings)
		})
		eventTask = (async () => {
			try {
				for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
					if (!active || !isRecord(event)) continue
					const data = eventData(event)
					const sessionID = typeof data?.sessionID === "string" ? data.sessionID : undefined
					if (!sessionID) continue
					if (event.type === "session.deleted") {
						const task = removeState(sessionID)
						track(task)
						continue
					}
					const eventCreated = eventCreatedAt(event)
					if (event.type === "session.execution.succeeded" || event.type === "session.execution.interrupted") {
						const request = requests.get(sessionID)
						if (request && eventCreated !== undefined && eventCreated >= request.requestedAt) requests.delete(sessionID)
						continue
					}
					if (event.type !== "session.execution.failed") continue
					const request = requests.get(sessionID)
					if (!request || eventCreated === undefined || eventCreated < request.requestedAt) continue
					requests.delete(sessionID)
					if (request.kind !== "primary") continue
					const task = recoverFailure(event, request)
					track(task)
					try { await task } catch (error) {
						log("[v2 runtime-fallback] Primary recovery failed closed.", {
							sessionID,
							error: error instanceof Error ? error.message : String(error),
						})
					}
				}
			} catch (error) {
				if (active && !controller.signal.aborted) {
					log("[v2 runtime-fallback] Native event stream stopped; automatic recovery is disabled until restart.", error)
				}
			}
		})()
		await restorePendingDeliveries()
	} catch (error) {
		await dispose()
		throw error
	}

	return dispose
}
