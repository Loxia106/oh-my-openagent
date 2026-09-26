import { isAbsolute, relative, resolve, sep } from "node:path"
import { createHash } from "node:crypto"
import { realpath, stat } from "node:fs/promises"
import type { Plugin } from "@opencode/plugin"
import { truncateToTokenLimit } from "../shared/dynamic-truncator"

export const INSTRUCTION_RESULT_METADATA_KEY = "__omo_opencode_v2_instruction_injection"
export const INSTRUCTION_RESULT_METADATA_VERSION = 1

const DEFAULT_MAX_TOKENS = 50_000
const CONTEXT_LOOKUP_TIMEOUT_MS = 900
const MAX_HISTORY_MESSAGES = 4_000
const MAX_HISTORY_TEXT_CHARS = 8_000_000

export type InstructionMarker = {
	readonly version: 1
	readonly location: string
	readonly payloadHash: string
	readonly payloadLength: number
	readonly rules?: readonly string[]
	readonly readmes?: readonly string[]
}

export type InstructionHistoryMarkers = {
	readonly complete: boolean
	readonly ruleRelativePaths: ReadonlySet<string>
	readonly readmePaths: ReadonlySet<string>
}

export type NativeInstructionSnapshot = {
	readonly history: readonly unknown[]
	readonly markers: InstructionHistoryMarkers
	readonly maxTokens: number
	readonly truncate: (content: string, maxTokens?: number) => Promise<{ result: string; truncated: boolean }>
}

export async function canonicalWorkspace(rootDirectory: string): Promise<string> {
	return realpath(rootDirectory)
}

type RecordLike = Record<string, unknown>

function isRecord(value: unknown): value is RecordLike {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

function finiteNonNegative(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T | undefined> {
	let timer: ReturnType<typeof setTimeout> | undefined
	try {
		return await Promise.race([
			operation,
			new Promise<undefined>((resolveTimeout) => {
				timer = setTimeout(() => resolveTimeout(undefined), timeoutMs)
			}),
		])
	} finally {
		if (timer !== undefined) clearTimeout(timer)
	}
}

function markerFromMetadata(value: unknown, location: string): InstructionMarker | undefined {
	if (!isRecord(value)) return undefined
	const marker = value[INSTRUCTION_RESULT_METADATA_KEY]
	if (!isRecord(marker) || marker.version !== INSTRUCTION_RESULT_METADATA_VERSION || marker.location !== location) return undefined
	if (typeof marker.payloadHash !== "string" || !/^[a-f0-9]{64}$/.test(marker.payloadHash)) return undefined
	if (typeof marker.payloadLength !== "number" || !Number.isSafeInteger(marker.payloadLength) || marker.payloadLength <= 0) return undefined
	const rules = Array.isArray(marker.rules) ? marker.rules.filter((item): item is string => typeof item === "string") : []
	const readmes = Array.isArray(marker.readmes) ? marker.readmes.filter((item): item is string => typeof item === "string") : []
	return { version: INSTRUCTION_RESULT_METADATA_VERSION, location, payloadHash: marker.payloadHash, payloadLength: marker.payloadLength, rules, readmes }
}

function toolContentText(value: unknown): string {
	if (typeof value === "string") return value
	if (!Array.isArray(value)) return ""
	return value.flatMap((part) =>
		isRecord(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : [],
	).join("\n")
}

function isPersistedMarker(marker: InstructionMarker, content: unknown): boolean {
	const text = toolContentText(content)
	if (text.length < marker.payloadLength) return false
	const suffix = text.slice(-marker.payloadLength)
	return createHash("sha256").update(suffix, "utf8").digest("hex") === marker.payloadHash
}

/**
 * Rehydrates only markers written by this native adapter and scoped to the
 * current canonical location. Tool results inherited from a different project
 * cannot suppress this project's rules or README files.
 */
export function readInstructionMarkers(
	history: readonly unknown[],
	canonicalLocation: string,
): InstructionHistoryMarkers {
	const ruleRelativePaths = new Set<string>()
	const readmePaths = new Set<string>()
	const historyTruncated = history.length > MAX_HISTORY_MESSAGES
	let complete = true
	let scannedChars = 0
	const start = Math.max(0, history.length - MAX_HISTORY_MESSAGES)

	for (let index = history.length - 1; index >= start; index -= 1) {
		const message = history[index]
		if (!isRecord(message) || message.type !== "assistant" || !Array.isArray(message.content)) continue
		for (const part of message.content) {
			if (!isRecord(part) || part.type !== "tool" || !isRecord(part.state) || part.state.status !== "completed") continue
			const toolName = typeof part.name === "string" ? part.name.toLowerCase() : ""
			if (toolName !== "read" && toolName !== "write" && toolName !== "edit" && toolName !== "multiedit") continue
			const marker = markerFromMetadata(part.state.metadata, canonicalLocation)
			if (marker && isPersistedMarker(marker, part.state.content)) {
				for (const relativePath of marker.rules ?? []) ruleRelativePaths.add(relativePath)
				for (const readmePath of marker.readmes ?? []) readmePaths.add(readmePath)
			}
			const content = part.state.content
			if (typeof content === "string") scannedChars += content.length
			else if (Array.isArray(content)) {
				for (const item of content) {
					if (isRecord(item) && item.type === "text" && typeof item.text === "string") scannedChars += item.text.length
				}
			}
			if (scannedChars > MAX_HISTORY_TEXT_CHARS) complete = false
			if (!complete) break
		}
		if (!complete) break
	}
	// Scan the bounded tail even when earlier messages were omitted, but expose
	// that omission so callers can avoid treating absent markers as proof.
	return { complete: complete && !historyTruncated, ruleRelativePaths, readmePaths }
}

type ModelEntry = { providerID?: unknown; id?: unknown; limit?: { context?: unknown } }
type AssistantUsage = { providerID: string; modelID: string; usedTokens: number }

function latestAssistantUsage(history: readonly unknown[]): AssistantUsage | undefined {
	for (let index = history.length - 1; index >= 0; index -= 1) {
		const message = history[index]
		if (!isRecord(message) || message.type !== "assistant" || !isRecord(message.time) || message.time.completed === undefined) continue
		if (!isRecord(message.model) || !isRecord(message.tokens) || !isRecord(message.tokens.cache)) return undefined
		const { input, output, cache } = message.tokens
		if (!finiteNonNegative(input) || !finiteNonNegative(output) || !finiteNonNegative(cache.read)) return undefined
		const providerID = message.model.providerID
		const modelID = message.model.id
		if (typeof providerID !== "string" || typeof modelID !== "string") return undefined
		return { providerID, modelID, usedTokens: input + cache.read + output }
	}
	return undefined
}

/**
 * Bounded native session-history and model-limit bridge for rule/README
 * truncation. The 50k-token fallback matches the existing OMO truncator when
 * OpenCode cannot return usage or a model context limit.
 */
export function createV2InstructionContext(ctx: Plugin.Context, timeoutMs = CONTEXT_LOOKUP_TIMEOUT_MS) {
	let modelListPromise: Promise<{ data?: readonly ModelEntry[] } | undefined> | undefined
	let modelListExpiresAt = 0
	const invalidateModelList = () => {
		modelListPromise = undefined
		modelListExpiresAt = 0
	}

	async function modelContextLimit(providerID: string, modelID: string): Promise<number | undefined> {
		if (!modelListPromise || Date.now() >= modelListExpiresAt) {
			modelListPromise = withTimeout(ctx.model.list(), timeoutMs).catch(() => undefined)
			modelListExpiresAt = Date.now() + 30_000
		}
		const response = await modelListPromise
		if (!response) {
			modelListPromise = undefined
			return undefined
		}
		const model = response.data?.find((candidate) => candidate.providerID === providerID && candidate.id === modelID)
		return finiteNonNegative(model?.limit?.context) && model.limit.context > 0 ? model.limit.context : undefined
	}

	return {
		invalidateModelList,
		async load(sessionID: string): Promise<NativeInstructionSnapshot | undefined> {
			const history = await withTimeout(ctx.session.context({ sessionID }), timeoutMs)
			if (!history) return undefined
			const usage = latestAssistantUsage(history)
			let maxTokens = DEFAULT_MAX_TOKENS
			if (usage) {
				const limit = await modelContextLimit(usage.providerID, usage.modelID)
				if (limit !== undefined) {
					const remaining = Math.max(0, limit - usage.usedTokens)
					maxTokens = Math.min(DEFAULT_MAX_TOKENS, Math.floor(remaining * 0.5))
				}
			}
			const markers = readInstructionMarkers(history, await canonicalWorkspace(ctx.location.directory))
			return {
				history,
				markers,
				maxTokens,
				async truncate(content: string, requestedMaxTokens = maxTokens) {
					if (requestedMaxTokens <= 0) return { result: "[Output suppressed - context window exhausted]", truncated: true }
					const result = truncateToTokenLimit(content, requestedMaxTokens)
					return { result: result.result, truncated: result.truncated }
				},
			}
		},
	}
}

export type CanonicalTarget = {
	readonly root: string
	readonly path: string
	readonly isDirectory: boolean
}

/** Resolve and verify a target using real paths, including symlink resolution. */
export async function canonicalizeTarget(rootDirectory: string, targetPath: string): Promise<CanonicalTarget | undefined> {
	if (!targetPath.trim()) return undefined
	try {
		const root = await realpath(rootDirectory)
		const candidate = await realpath(isAbsolute(targetPath) ? targetPath : resolve(root, targetPath))
		const relativePath = relative(root, candidate)
		if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) return undefined
		const details = await stat(candidate)
		if (!details.isFile() && !details.isDirectory()) return undefined
		return { root, path: candidate, isDirectory: details.isDirectory() }
	} catch {
		return undefined
	}
}
