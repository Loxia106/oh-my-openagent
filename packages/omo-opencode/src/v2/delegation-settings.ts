import { realpathSync } from "node:fs"
import { normalize, resolve } from "node:path"
import type * as Schema from "effect/Schema"
import type { Plugin } from "@opencode/plugin"
import type { DelegationFallbackState, DelegationModelChoice, DelegationModelRef } from "./delegation-model-selection"

const SETTINGS_KEY_ROOT = "oh-my-openagent:v2:delegation-settings:"

export type V2DelegationSettingsRecord = {
	readonly version: 1
	readonly sessionID: string
	readonly parentSessionID: string
	readonly projectID: string
	readonly directory: string
	readonly workspaceID: string | null
	readonly agentID: string
	readonly model: DelegationModelRef
	readonly settings: Readonly<Record<string, unknown>>
	readonly originCategory?: string
	readonly fallbackState?: DelegationFallbackState
	readonly failureWitness?: V2DelegationFailureWitness
	readonly selectedAt: number
}

/** A native provider failure proven by this child's own primary HTTP response. */
export type V2DelegationFailureWitness = {
	readonly version: 1
	readonly sessionID: string
	readonly parentSessionID: string
	readonly agentID: string
	readonly model: DelegationModelRef
	readonly userMessageID: string
	readonly assistantMessageID: string
	readonly errorType: string
	readonly status: number
	readonly requestAt: number
	readonly responseStatus: number
	readonly idle: number
	readonly background: boolean
}

export type V2DelegationSettingsIdentity = {
	readonly parentSessionID: string
	readonly agentID: string
	readonly model: DelegationModelRef
}

type Location = Plugin.Context["location"]

export function isV2DelegationSessionInLocation(
	session: { readonly projectID: string; readonly location: { readonly directory: string } },
	location: Location,
): boolean {
	return session.projectID === location.project.id &&
		canonicalDirectory(session.location.directory) === canonicalDirectory(String(location.directory))
}

function toJson(value: unknown, path = "settings"): Schema.Json {
	if (value === null || typeof value === "string" || typeof value === "boolean") return value
	if (typeof value === "number" && Number.isFinite(value)) return value
	if (Array.isArray(value)) return value.map((item, index) => toJson(item, `${path}[${index}]`))
	if (typeof value === "object" && value !== null && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
		const result: Record<string, Schema.Json> = {}
		for (const [key, item] of Object.entries(value)) {
			if (item !== undefined) result[key] = toJson(item, `${path}.${key}`)
		}
		return result
	}
	throw new TypeError(`Delegated request ${path} contains a non-JSON value.`)
}

function canonicalDirectory(directory: string): string {
	const absolute = normalize(resolve(directory))
	try {
		return normalize(realpathSync.native(absolute))
	} catch {
		return absolute
	}
}

function scopeKey(location: Location): string {
	return `${encodeURIComponent(location.project.id)}:${encodeURIComponent(canonicalDirectory(String(location.directory)))}:${encodeURIComponent(location.workspaceID ?? "<no-workspace>")}`
}

function storageKey(scope: string, sessionID: string): string {
	return `${SETTINGS_KEY_ROOT}${scope}:${encodeURIComponent(sessionID)}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

function decodeModelChoice(value: unknown): DelegationModelChoice | undefined {
	if (!isRecord(value) || !isRecord(value.model) || !isRecord(value.settings) ||
		typeof value.model.providerID !== "string" || typeof value.model.id !== "string" ||
		(value.model.variant !== undefined && typeof value.model.variant !== "string") ||
		(value.source !== "configured" && value.source !== "requirement" && value.source !== "agent" && value.source !== "parent" && value.source !== "default") ||
		(value.originCategory !== undefined && typeof value.originCategory !== "string")) return undefined
	return {
		model: {
			providerID: value.model.providerID,
			id: value.model.id,
			...(typeof value.model.variant === "string" && value.model.variant !== "default" ? { variant: value.model.variant } : {}),
		},
		settings: value.settings,
		source: value.source,
		...(typeof value.originCategory === "string" ? { originCategory: value.originCategory } : {}),
	}
}

function decodeFallbackState(value: unknown): DelegationFallbackState | undefined {
	if (!isRecord(value) || (value.source !== "agent" && value.source !== "category") ||
		(value.originCategory !== undefined && typeof value.originCategory !== "string") ||
		!Array.isArray(value.candidates) || value.candidates.length === 0 || value.candidates.length > 100 || !Number.isInteger(value.currentIndex) ||
		(value.currentIndex as number) < -1 || (value.currentIndex as number) >= value.candidates.length ||
		!Number.isSafeInteger(value.attempts) || (value.attempts as number) < 0 || (value.attempts as number) > 20 || !isRecord(value.failedAt)) return undefined
	const candidates = value.candidates.map(decodeModelChoice)
	if (candidates.some((candidate) => candidate === undefined)) return undefined
	const failedAt: Record<string, number> = {}
	for (const [model, timestamp] of Object.entries(value.failedAt)) {
		if (typeof timestamp !== "number" || !Number.isFinite(timestamp) || timestamp < 0) return undefined
		failedAt[model] = timestamp
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

function decodeFailureWitness(value: unknown): V2DelegationFailureWitness | undefined {
	if (!isRecord(value) || value.version !== 1 || typeof value.sessionID !== "string" || !value.sessionID ||
		typeof value.parentSessionID !== "string" || !value.parentSessionID ||
		typeof value.agentID !== "string" || !value.agentID ||
		typeof value.userMessageID !== "string" || !value.userMessageID ||
		typeof value.assistantMessageID !== "string" || !value.assistantMessageID ||
		typeof value.errorType !== "string" || !value.errorType.startsWith("provider.") ||
		!Number.isSafeInteger(value.status) || (value.status as number) < 100 || (value.status as number) > 599 ||
		!Number.isFinite(value.requestAt) || typeof value.requestAt !== "number" || value.requestAt < 0 ||
		!Number.isSafeInteger(value.responseStatus) || value.responseStatus !== value.status ||
		!Number.isFinite(value.idle) || typeof value.idle !== "number" || value.idle < value.requestAt ||
		typeof value.background !== "boolean") return undefined
	const model = value.model
	if (!isRecord(model) || typeof model.providerID !== "string" || !model.providerID ||
		typeof model.id !== "string" || !model.id || (model.variant !== undefined && typeof model.variant !== "string")) return undefined
	return {
		version: 1,
		sessionID: value.sessionID,
		parentSessionID: value.parentSessionID,
		agentID: value.agentID,
		model: {
			providerID: model.providerID,
			id: model.id,
			...(typeof model.variant === "string" && model.variant !== "default" ? { variant: model.variant } : {}),
		},
		userMessageID: value.userMessageID,
		assistantMessageID: value.assistantMessageID,
		errorType: value.errorType,
		status: value.status as number,
		requestAt: value.requestAt as number,
		responseStatus: value.responseStatus as number,
		idle: value.idle as number,
		background: value.background,
	}
}

function decode(value: unknown): V2DelegationSettingsRecord | undefined {
	if (!isRecord(value) || value.version !== 1 || typeof value.sessionID !== "string" ||
		typeof value.parentSessionID !== "string" || typeof value.projectID !== "string" ||
		typeof value.directory !== "string" || (value.workspaceID !== null && typeof value.workspaceID !== "string") || typeof value.agentID !== "string" ||
		typeof value.selectedAt !== "number" || !isRecord(value.model) || !isRecord(value.settings)) return undefined
	const model = value.model
	if (typeof model.providerID !== "string" || typeof model.id !== "string" ||
		(model.variant !== undefined && typeof model.variant !== "string")) return undefined
	const fallbackState = value.fallbackState === undefined ? undefined : decodeFallbackState(value.fallbackState)
	if (value.fallbackState !== undefined && !fallbackState) return undefined
	const failureWitness = value.failureWitness === undefined ? undefined : decodeFailureWitness(value.failureWitness)
	if (value.failureWitness !== undefined && !failureWitness) return undefined
	if (value.originCategory !== undefined && typeof value.originCategory !== "string") return undefined
	if (failureWitness && (failureWitness.sessionID !== value.sessionID || failureWitness.parentSessionID !== value.parentSessionID ||
		failureWitness.agentID !== value.agentID || !sameModel(failureWitness.model, model as DelegationModelRef))) return undefined
	return {
		version: 1,
		sessionID: value.sessionID,
		parentSessionID: value.parentSessionID,
		projectID: value.projectID,
		directory: value.directory,
		workspaceID: value.workspaceID as string | null,
		agentID: value.agentID,
		model: {
			providerID: model.providerID,
			id: model.id,
			...(typeof model.variant === "string" && model.variant !== "default" ? { variant: model.variant } : {}),
		},
		settings: value.settings,
		...(typeof value.originCategory === "string" ? { originCategory: value.originCategory } : {}),
		...(fallbackState ? { fallbackState } : {}),
		...(failureWitness ? { failureWitness } : {}),
		selectedAt: value.selectedAt,
	}
}

function sameModel(left: DelegationModelRef, right: DelegationModelRef): boolean {
	return left.providerID === right.providerID && left.id === right.id &&
		(left.variant === undefined || left.variant === "default" ? undefined : left.variant) ===
		(right.variant === undefined || right.variant === "default" ? undefined : right.variant)
}

/** Durable OMO-only per-child settings. Keys are isolated by project and canonical directory. */
export function createV2DelegationSettings(
	storage: Plugin.Context["storage"],
	location: Location,
) {
	const scope = scopeKey(location)
	const directory = canonicalDirectory(String(location.directory))
	const projectID = location.project.id
	const workspaceID = location.workspaceID ?? null
	const writes = new Map<string, Promise<void>>()

	async function serialize<T>(sessionID: string, operation: () => Promise<T>): Promise<T> {
		const previous = writes.get(sessionID) ?? Promise.resolve()
		let release!: () => void
		const gate = new Promise<void>((resolveGate) => { release = resolveGate })
		const tail = previous.catch(() => undefined).then(() => gate)
		writes.set(sessionID, tail)
		await previous.catch(() => undefined)
		try {
			return await operation()
		} finally {
			release()
			if (writes.get(sessionID) === tail) writes.delete(sessionID)
		}
	}

	return {
		async write(input: Omit<V2DelegationSettingsRecord, "version" | "projectID" | "directory" | "workspaceID" | "selectedAt"> & { selectedAt?: number }): Promise<void> {
			return serialize(input.sessionID, async () => {
				const record: V2DelegationSettingsRecord = {
					version: 1,
					sessionID: input.sessionID,
					parentSessionID: input.parentSessionID,
					projectID,
					directory,
					workspaceID,
					agentID: input.agentID,
					model: {
						providerID: input.model.providerID,
						id: input.model.id,
						...(input.model.variant && input.model.variant !== "default" ? { variant: input.model.variant } : {}),
					},
					settings: { ...input.settings },
					...(input.originCategory ? { originCategory: input.originCategory } : {}),
					...(input.fallbackState ? { fallbackState: input.fallbackState } : {}),
					...(input.failureWitness ? { failureWitness: input.failureWitness } : {}),
					selectedAt: input.selectedAt ?? Date.now(),
				}
				await storage.set(storageKey(scope, input.sessionID), toJson(record))
			})
		},

		async read(sessionID: string, expected: V2DelegationSettingsIdentity): Promise<V2DelegationSettingsRecord | undefined> {
			return serialize(sessionID, async () => {
				const stored = decode(await storage.get(storageKey(scope, sessionID)))
				if (!stored || stored.sessionID !== sessionID || stored.projectID !== projectID || stored.directory !== directory || stored.workspaceID !== workspaceID ||
					stored.parentSessionID !== expected.parentSessionID || stored.agentID !== expected.agentID ||
					!sameModel(stored.model, expected.model)) return undefined
				return stored
			})
		},

		async updateFallbackState(
			sessionID: string,
			expected: V2DelegationSettingsIdentity,
			fallbackState: DelegationFallbackState,
		): Promise<V2DelegationSettingsRecord | undefined> {
			return serialize(sessionID, async () => {
				const key = storageKey(scope, sessionID)
				const stored = decode(await storage.get(key))
				if (!stored || stored.sessionID !== sessionID || stored.projectID !== projectID || stored.directory !== directory || stored.workspaceID !== workspaceID ||
					stored.parentSessionID !== expected.parentSessionID || stored.agentID !== expected.agentID || !sameModel(stored.model, expected.model)) return undefined
				const updated = { ...stored, fallbackState }
				await storage.set(key, toJson(updated))
				return updated
			})
		},

		async recordFailureWitness(
			sessionID: string,
			expected: V2DelegationSettingsIdentity,
			witness: V2DelegationFailureWitness,
		): Promise<V2DelegationSettingsRecord | undefined> {
			return serialize(sessionID, async () => {
				const key = storageKey(scope, sessionID)
				const stored = decode(await storage.get(key))
				if (!stored || stored.sessionID !== sessionID || stored.projectID !== projectID || stored.directory !== directory || stored.workspaceID !== workspaceID ||
					stored.parentSessionID !== expected.parentSessionID || stored.agentID !== expected.agentID || !sameModel(stored.model, expected.model) ||
					witness.sessionID !== sessionID || witness.parentSessionID !== expected.parentSessionID || witness.agentID !== expected.agentID || !sameModel(witness.model, expected.model) ||
					(stored.failureWitness !== undefined && witness.requestAt <= stored.failureWitness.requestAt)) return undefined
				const updated = { ...stored, failureWitness: witness }
				await storage.set(key, toJson(updated))
				return updated
			})
		},

		/** Consume a prepared fallback only if the same proven failure is still current. */
		async consumeFailureWitness(input: {
			sessionID: string
			expected: V2DelegationSettingsIdentity
			witness: V2DelegationFailureWitness
			consumedModel: DelegationModelRef
			settings: Readonly<Record<string, unknown>>
			fallbackState: DelegationFallbackState
		}): Promise<V2DelegationSettingsRecord | undefined> {
			return serialize(input.sessionID, async () => {
				const key = storageKey(scope, input.sessionID)
				const stored = decode(await storage.get(key))
				if (!stored || stored.sessionID !== input.sessionID || stored.projectID !== projectID || stored.directory !== directory || stored.workspaceID !== workspaceID ||
					stored.parentSessionID !== input.expected.parentSessionID || stored.agentID !== input.expected.agentID || !sameModel(stored.model, input.expected.model) ||
					!stored.failureWitness || !sameFailureWitness(stored.failureWitness, input.witness)) return undefined
				const updated: V2DelegationSettingsRecord = {
					...stored,
					model: input.consumedModel,
					settings: { ...input.settings },
					fallbackState: input.fallbackState,
					selectedAt: Date.now(),
				}
				const serialized = { ...updated } as Record<string, unknown>
				delete serialized.failureWitness
				await storage.set(key, toJson(serialized))
				return decode(serialized)
			})
		},

		/** Restore an unstarted explicit retry if cancellation wins before the host call. */
		async restoreFailureWitness(input: {
			sessionID: string
			expected: V2DelegationSettingsIdentity
			witness: V2DelegationFailureWitness
			model: DelegationModelRef
			settings: Readonly<Record<string, unknown>>
			fallbackState: DelegationFallbackState
		}): Promise<V2DelegationSettingsRecord | undefined> {
			return serialize(input.sessionID, async () => {
				const key = storageKey(scope, input.sessionID)
				const stored = decode(await storage.get(key))
				if (!stored || stored.sessionID !== input.sessionID || stored.projectID !== projectID || stored.directory !== directory || stored.workspaceID !== workspaceID ||
					stored.parentSessionID !== input.expected.parentSessionID || stored.agentID !== input.expected.agentID || !sameModel(stored.model, input.model) ||
					stored.failureWitness) return undefined
				const restored: V2DelegationSettingsRecord = {
					...stored,
					model: input.expected.model,
					settings: { ...input.settings },
					fallbackState: input.fallbackState,
					failureWitness: input.witness,
					selectedAt: Date.now(),
				}
				await storage.set(key, toJson(restored))
				return restored
			})
		},

		async remove(sessionID: string): Promise<void> {
			return serialize(sessionID, () => storage.remove(storageKey(scope, sessionID)))
		},
	}
}

function sameFailureWitness(left: V2DelegationFailureWitness, right: V2DelegationFailureWitness): boolean {
	return left.sessionID === right.sessionID && left.parentSessionID === right.parentSessionID && left.agentID === right.agentID &&
		sameModel(left.model, right.model) && left.userMessageID === right.userMessageID &&
		left.assistantMessageID === right.assistantMessageID && left.errorType === right.errorType && left.status === right.status &&
		left.requestAt === right.requestAt && left.responseStatus === right.responseStatus && left.idle === right.idle && left.background === right.background
}

export type V2DelegationSettings = ReturnType<typeof createV2DelegationSettings>
