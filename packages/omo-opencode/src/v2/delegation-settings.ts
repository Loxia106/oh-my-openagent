import { realpathSync } from "node:fs"
import { normalize, resolve } from "node:path"
import type * as Schema from "effect/Schema"
import type { Plugin } from "@opencode/plugin"
import type { DelegationModelRef } from "./delegation-model-selection"

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
	readonly selectedAt: number
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

function decode(value: unknown): V2DelegationSettingsRecord | undefined {
	if (!isRecord(value) || value.version !== 1 || typeof value.sessionID !== "string" ||
		typeof value.parentSessionID !== "string" || typeof value.projectID !== "string" ||
		typeof value.directory !== "string" || (value.workspaceID !== null && typeof value.workspaceID !== "string") || typeof value.agentID !== "string" ||
		typeof value.selectedAt !== "number" || !isRecord(value.model) || !isRecord(value.settings)) return undefined
	const model = value.model
	if (typeof model.providerID !== "string" || typeof model.id !== "string" ||
		(model.variant !== undefined && typeof model.variant !== "string")) return undefined
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

		async remove(sessionID: string): Promise<void> {
			return serialize(sessionID, () => storage.remove(storageKey(scope, sessionID)))
		},
	}
}

export type V2DelegationSettings = ReturnType<typeof createV2DelegationSettings>
