import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { basename, dirname, isAbsolute } from "node:path"
import type { Plugin } from "@opencode/plugin"
import { findReadmeMdUp } from "../hooks/directory-readme-injector/finder"
import { createRuleInjectionProcessor } from "../hooks/rules-injector/injector"
import { createRuleScanCache } from "../hooks/rules-injector/rule-scan-cache"
import type { OhMyOpenCodeConfig } from "../config"
import { log } from "../shared/logger"
import {
	canonicalizeTarget,
	canonicalWorkspace,
	createV2InstructionContext,
	INSTRUCTION_RESULT_METADATA_KEY,
	INSTRUCTION_RESULT_METADATA_VERSION,
	type InstructionMarker,
} from "./instruction-context"

type RecordLike = Record<string, unknown>

type NativeToolResult = {
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
	readonly input: unknown
	readonly status: "completed" | "error"
	result?: NativeToolResult
	readonly error?: unknown
}

type SessionState = {
	pendingRules: Set<string>
	pendingReadmes: Set<string>
	pendingMessageID?: string
	queue: Promise<void>
	epoch: number
	active: number
	retired: boolean
}

type InjectionBlock = { readonly kind: "rule" | "readme"; readonly path: string; readonly text: string }

const INSTRUCTION_HOOKS = {
	rules: "rules-injector",
	readme: "directory-readme-injector",
} as const

const RULE_TOOL_NAMES = new Set(["read", "write", "edit", "multiedit"])
const HISTORY_INVALIDATION_EVENTS = new Set([
	"session.compaction.ended",
	"session.revert.committed",
	"session.deleted",
])
const MODEL_INVALIDATION_EVENTS = new Set(["model.updated", "provider.updated"])
const OUTPUT_OVERHEAD_TOKENS = 96
const BLOCK_OVERHEAD_TOKENS = 64
const HOST_OUTPUT_MAX_LINES = 2_000
const HOST_OUTPUT_MAX_BYTES = 50 * 1024

function asRecord(value: unknown): RecordLike | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? value as RecordLike
		: undefined
}

function locationMatches(value: unknown, ctx: Plugin.Context): boolean {
	const location = asRecord(value)
	if (!location) return true
	if (String(location.directory) !== String(ctx.location.directory)) return false
	return location.workspaceID === undefined || location.workspaceID === ctx.location.workspaceID
}

function retryDelay(signal: AbortSignal): Promise<void> {
	if (signal.aborted) return Promise.resolve()
	return new Promise((resolveDelay) => {
		const finish = () => {
			clearTimeout(timer)
			signal.removeEventListener("abort", finish)
			resolveDelay()
		}
		const timer = setTimeout(finish, 500)
		signal.addEventListener("abort", finish, { once: true })
	})
}

function newSessionState(): SessionState {
	return {
		pendingRules: new Set(),
		pendingReadmes: new Set(),
		queue: Promise.resolve(),
		epoch: 0,
		active: 0,
		retired: false,
	}
}

function toStringPath(value: unknown): string | undefined {
	if (typeof value !== "string" || !value.trim()) return undefined
	return value
}

function targetFromEvent(event: NativeToolEvent): { path: string; directoryListing: boolean } | undefined {
	const input = asRecord(event.input)
	const result = asRecord(event.result)
	const output = asRecord(result?.output)
	const outputPath = toStringPath(output?.path)
	const inputPath = toStringPath(input?.path) ?? toStringPath(input?.filePath) ?? toStringPath(input?.file_path)
	const path = outputPath ?? inputPath
	if (!path) return undefined
	return { path, directoryListing: output?.type === "list-page" }
}

function appendContent(content: NativeToolResult["content"], addition: string): string | readonly unknown[] {
	if (!addition) return content ?? ""
	if (typeof content === "string") return `${content}${addition}`
	if (Array.isArray(content)) return [...content, { type: "text", text: addition }]
	return addition
}

function tokenEstimate(text: string): number {
	return Math.ceil(text.length / 4)
}

function blocksFromRuleOutput(text: string, deliveredBodies: readonly string[]): InjectionBlock[] {
	const blocks: InjectionBlock[] = []
	const ruleHeader = /\[Rule: ([^\]\n]+)\]\n\[Match: [^\n]+\]\n/g
	let cursor = 0
	for (const body of deliveredBodies) {
		ruleHeader.lastIndex = cursor
		const match = ruleHeader.exec(text)
		if (!match || !match[1] || !text.startsWith(body, ruleHeader.lastIndex)) break
		const start = match.index >= 2 && text.slice(match.index - 2, match.index) === "\n\n" ? match.index - 2 : match.index
		cursor = ruleHeader.lastIndex + body.length
		ruleHeader.lastIndex = cursor
		const next = ruleHeader.exec(text)
		const end = next
			? next.index >= 2 && text.slice(next.index - 2, next.index) === "\n\n" ? next.index - 2 : next.index
			: text.length
		const blockText = text.slice(start, end)
		if (!blockText.includes("[Output suppressed - context window exhausted]")) {
			blocks.push({ kind: "rule", path: match[1], text: blockText })
		}
		cursor = end
	}
	return blocks
}

function readmeBlock(path: string, content: string, truncated: boolean): InjectionBlock {
	const note = truncated
		? `\n\n[Note: Content was truncated to save context window space. For full context, please read the file directly: ${path}]`
		: ""
	const text = `\n\n[Project README: ${path}]\n${content}${note}`
	return { kind: "readme", path, text }
}

function resultText(content: NativeToolResult["content"]): string {
	if (typeof content === "string") return content
	if (!Array.isArray(content)) return ""
	return content.flatMap((part) => {
		const item = asRecord(part)
		return item?.type === "text" && typeof item.text === "string" ? [item.text] : []
	}).join("\n")
}

function outputBudgetTokens(result: NativeToolResult, contextMaxTokens: number): number {
	let maxTokens = Math.max(0, contextMaxTokens - OUTPUT_OVERHEAD_TOKENS)
	if (result.metadata?.truncated !== undefined) return maxTokens
	const source = resultText(result.content)
	const sourceBytes = Buffer.byteLength(source, "utf8")
	const byteRoom = Math.max(0, HOST_OUTPUT_MAX_BYTES - sourceBytes - 384)
	maxTokens = Math.min(maxTokens, Math.floor(byteRoom / 4))
	return maxTokens
}

function outputRoom(result: NativeToolResult): { bytes: number; lines: number } {
	if (result.metadata?.truncated !== undefined) return { bytes: Number.POSITIVE_INFINITY, lines: Number.POSITIVE_INFINITY }
	const source = resultText(result.content)
	return {
		bytes: Math.max(0, HOST_OUTPUT_MAX_BYTES - Buffer.byteLength(source, "utf8") - 384),
		lines: Math.max(0, HOST_OUTPUT_MAX_LINES - (source === "" ? 0 : source.split("\n").length) - 8),
	}
}

async function capForNativeToolOutput(
	result: NativeToolResult,
	addition: string,
	contextMaxTokens: number,
	truncate: (text: string, tokens: number) => Promise<{ result: string; truncated: boolean }>,
): Promise<{ result: string; truncated: boolean }> {
	let maxTokens = outputBudgetTokens(result, contextMaxTokens)
	const hostWillTruncate = result.metadata?.truncated === undefined
	const room = hostWillTruncate ? outputRoom(result) : { bytes: Number.POSITIVE_INFINITY, lines: Number.POSITIVE_INFINITY }
	const byteRoom = room.bytes
	const lineRoom = room.lines
	if (hostWillTruncate && (lineRoom < 8 || byteRoom < 512)) return { result: "", truncated: true }
	maxTokens = Math.min(maxTokens, Math.floor(byteRoom / 4))
	for (let attempt = 0; attempt < 8 && maxTokens > 0; attempt += 1) {
		const bounded = await truncate(addition, maxTokens)
		if (!hostWillTruncate ||
			(bounded.result.split("\n").length <= lineRoom && Buffer.byteLength(bounded.result, "utf8") <= byteRoom)) return bounded
		maxTokens = Math.floor(maxTokens * 0.75)
	}
	return { result: "", truncated: true }
}

async function canonicalReadmePaths(paths: Iterable<string>, root: string): Promise<Set<string>> {
	const result = new Set<string>()
	for (const candidate of paths) {
		if (!isAbsolute(candidate) || basename(candidate).toLowerCase() !== "readme.md") continue
		const canonical = await canonicalizeTarget(root, candidate)
		if (canonical?.isDirectory || !canonical) continue
		if (basename(canonical.path).toLowerCase() === "readme.md") result.add(canonical.path)
	}
	return result
}

function mergeMarker(
	metadata: Record<string, unknown> | undefined,
	marker: InstructionMarker,
): Record<string, unknown> {
	return {
		...(metadata ?? {}),
		[INSTRUCTION_RESULT_METADATA_KEY]: {
			version: INSTRUCTION_RESULT_METADATA_VERSION,
			location: marker.location,
			payloadHash: marker.payloadHash,
			payloadLength: marker.payloadLength,
			rules: [...new Set(marker.rules ?? [])],
			readmes: [...new Set(marker.readmes ?? [])],
		},
	}
}

function makeCacheMarker(location: string, payload: string, rules: Iterable<string>, readmes: Iterable<string>): InstructionMarker {
	return {
		version: INSTRUCTION_RESULT_METADATA_VERSION,
		location,
		payloadHash: createHash("sha256").update(payload, "utf8").digest("hex"),
		payloadLength: payload.length,
		rules: [...new Set(rules)],
		readmes: [...new Set(readmes)],
	}
}

function eventSessionID(event: unknown): string | undefined {
	const data = asRecord(asRecord(event)?.data)
	return typeof data?.sessionID === "string" ? data.sessionID : undefined
}

/** Native V2 rules and directory README injection using only public plugin APIs. */
export async function registerV2InstructionHooks(
	ctx: Plugin.Context,
	config: OhMyOpenCodeConfig,
): Promise<() => Promise<void>> {
	const disabled = new Set(config.disabled_hooks ?? [])
	const rulesEnabled = !disabled.has(INSTRUCTION_HOOKS.rules)
	const readmeEnabled = !disabled.has(INSTRUCTION_HOOKS.readme)
	if (!rulesEnabled && !readmeEnabled) return async () => undefined

	const root = await canonicalWorkspace(ctx.location.directory)
	const context = createV2InstructionContext(ctx)
	const states = new Map<string, SessionState>()
	const cleanups: Array<() => Promise<void>> = []
	const controller = new AbortController()
	let disposed = false

	const stateFor = (sessionID: string): SessionState => {
		let state = states.get(sessionID)
		if (!state || state.retired) {
			state = newSessionState()
			states.set(sessionID, state)
			if (states.size > 256) {
				for (const [candidateID, candidate] of states) {
					if (states.size <= 192) break
					if (candidateID !== sessionID && candidate.active === 0) states.delete(candidateID)
				}
			}
		}
		return state
	}

	const processEvent = async (event: NativeToolEvent, state: SessionState, epoch: number): Promise<void> => {
		if (disposed || event.status !== "completed" || !event.result) return
		const tool = event.tool.trim().toLowerCase()
		const runRules = rulesEnabled && RULE_TOOL_NAMES.has(tool)
		const runReadme = readmeEnabled && tool === "read"
		if (!runRules && !runReadme) return

		const target = targetFromEvent(event)
		if (!target) return
		const canonicalTarget = await canonicalizeTarget(root, target.path)
		if (!canonicalTarget || disposed || state.epoch !== epoch) return
		const snapshot = await context.load(event.sessionID)
		if (!snapshot || !snapshot.markers.complete || disposed || state.epoch !== epoch) return

		const markerReadmes = await canonicalReadmePaths(snapshot.markers.readmePaths, root)
		const pendingMatches = state.pendingMessageID === event.messageID
		const knownRules = new Set(snapshot.markers.ruleRelativePaths)
		const knownReadmes = new Set(markerReadmes)
		if (pendingMatches) {
			for (const rule of state.pendingRules) knownRules.add(rule)
			for (const readme of state.pendingReadmes) knownReadmes.add(readme)
		} else {
			state.pendingRules.clear()
			state.pendingReadmes.clear()
			state.pendingMessageID = undefined
		}

		let tokenBudget = outputBudgetTokens(event.result, snapshot.maxTokens)
		const room = outputRoom(event.result)
		let lineBudget = room.lines
		let byteBudget = room.bytes
		const deliveredRuleBodies: string[] = []
		const truncateBlock = async (content: string) => {
			let bodyTokens = tokenBudget - BLOCK_OVERHEAD_TOKENS
			if (bodyTokens <= 0) return { result: "[Output suppressed - context window exhausted]", truncated: true }
			let bounded = await snapshot.truncate(content, bodyTokens)
			for (let attempt = 0; attempt < 8 && room.bytes !== Number.POSITIVE_INFINITY; attempt += 1) {
				const bytes = Buffer.byteLength(bounded.result, "utf8")
				const lines = bounded.result.split("\n").length
				if (bytes + 384 <= byteBudget && lines + 8 <= lineBudget) break
				bodyTokens = Math.floor(bodyTokens * 0.75)
				if (bodyTokens <= 0) return { result: "[Output suppressed - context window exhausted]", truncated: true }
				bounded = await snapshot.truncate(content, bodyTokens)
			}
			const bytes = Buffer.byteLength(bounded.result, "utf8")
			const lines = bounded.result.split("\n").length
			if (room.bytes !== Number.POSITIVE_INFINITY && (bytes + 384 > byteBudget || lines + 8 > lineBudget)) {
				return { result: "[Output suppressed - context window exhausted]", truncated: true }
			}
			tokenBudget = Math.max(0, tokenBudget - tokenEstimate(bounded.result) - BLOCK_OVERHEAD_TOKENS)
			if (room.bytes !== Number.POSITIVE_INFINITY) {
				byteBudget = Math.max(0, byteBudget - bytes - 384)
				lineBudget = Math.max(0, lineBudget - lines - 8)
			}
			return bounded
		}
		const boundedTruncator = { truncate: async (_sessionID: string, content: string) => {
			const bounded = await truncateBlock(content)
			deliveredRuleBodies.push(bounded.result)
			return bounded
		} }

		let ruleAddition = ""
		let ruleBlocks: InjectionBlock[] = []
		if (runRules) {
			const processor = createRuleInjectionProcessor({
				workspaceDirectory: root,
				truncator: boundedTruncator,
				getSessionCache: () => ({ contentHashes: new Set(), realPaths: new Set() }),
				getSessionRuleScanCache: () => createRuleScanCache(),
				saveInjectedRules: () => undefined,
				transcriptHydration: { hydrateSession: async () => knownRules },
				ruleFinderOptions: config.claude_code?.hooks === false ? { skipClaudeUserRules: true } : undefined,
			})
			const ruleOutput = { title: canonicalTarget.path, output: "", metadata: { filePath: canonicalTarget.path } }
			await processor.processFilePathForInjection(canonicalTarget.path, event.sessionID, ruleOutput)
			ruleAddition = ruleOutput.output
			ruleBlocks = blocksFromRuleOutput(ruleAddition, deliveredRuleBodies)
		}

		const readmeBlocks: InjectionBlock[] = []
		if (runReadme) {
			const startDir = target.directoryListing || canonicalTarget.isDirectory
				? canonicalTarget.path
				: dirname(canonicalTarget.path)
			const candidates = await findReadmeMdUp({ startDir, rootDir: root })
			for (const candidate of candidates) {
				if (disposed || state.epoch !== epoch) return
				const safeReadme = await canonicalizeTarget(root, candidate)
				if (!safeReadme || safeReadme.isDirectory || basename(safeReadme.path).toLowerCase() !== "readme.md") continue
				if (knownReadmes.has(safeReadme.path)) continue
				try {
					const raw = await readFile(safeReadme.path, "utf8")
					if (disposed || state.epoch !== epoch) return
					if (tokenBudget <= BLOCK_OVERHEAD_TOKENS) continue
					const bounded = await truncateBlock(raw)
					if (bounded.result === "[Output suppressed - context window exhausted]") continue
					readmeBlocks.push(readmeBlock(safeReadme.path, bounded.result, bounded.truncated))
					knownReadmes.add(safeReadme.path)
				} catch (error) {
					log("[v2 instructions] Skipped README after read/truncate failure", { error, path: safeReadme.path, sessionID: event.sessionID })
				}
			}
		}

		const blocks = [...ruleBlocks, ...readmeBlocks]
		const addition = blocks.map((block) => block.text).join("")
		if (!addition || disposed || state.epoch !== epoch) return

		// Cap to both remaining context and the native tool-output limit when its
		// own truncator is active. Existing tool bytes/content stay untouched.
		const boundedAddition = await capForNativeToolOutput(event.result, addition, snapshot.maxTokens, snapshot.truncate)
		if (disposed || state.epoch !== epoch) return
		const visibleBlocks = blocks.filter((block) => boundedAddition.result.includes(block.text))
		const safeAddition = visibleBlocks.map((block) => block.text).join("")
		const rules = visibleBlocks.filter((block) => block.kind === "rule").map((block) => block.path)
		const readmes = visibleBlocks.filter((block) => block.kind === "readme").map((block) => block.path)
		if (!safeAddition || rules.length + readmes.length === 0) return
		const nextResult = event.result
		if (!nextResult) return
		const nextMetadata = mergeMarker(nextResult.metadata, makeCacheMarker(root, safeAddition, rules, readmes))
		const nextContent = appendContent(nextResult.content, safeAddition)

		if (disposed || state.epoch !== epoch) return
		event.result = { ...nextResult, content: nextContent, metadata: nextMetadata }
		if (state.pendingMessageID !== event.messageID) {
			state.pendingMessageID = event.messageID
			state.pendingRules.clear()
			state.pendingReadmes.clear()
		}
		for (const rule of rules) state.pendingRules.add(rule)
		for (const readme of readmes) state.pendingReadmes.add(readme)
	}

	const queuedAfter = async (event: NativeToolEvent): Promise<void> => {
		if (disposed || event.status !== "completed") return
		const state = stateFor(event.sessionID)
		state.active += 1
		const epoch = state.epoch
		const operation = state.queue.then(() => processEvent(event, state, epoch))
		state.queue = operation.catch((error) => {
			if (!disposed && state.epoch === epoch) log("[v2 instructions] Injection failed without changing the native tool result", error)
		}).finally(() => {
			state.active = Math.max(0, state.active - 1)
			if (state.retired && state.active === 0 && states.get(event.sessionID) === state) states.delete(event.sessionID)
		})
		await state.queue
	}

	const invalidateSession = (sessionID: string) => {
		const state = states.get(sessionID)
		if (state) {
			state.epoch += 1
			state.pendingRules.clear()
			state.pendingReadmes.clear()
			state.pendingMessageID = undefined
			if (state.active === 0) states.delete(sessionID)
			else state.retired = true
		}
	}

	const monitorTask = (async () => {
		while (!controller.signal.aborted) {
			try {
				for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
					if (controller.signal.aborted || disposed) return
					if (!locationMatches(event.location, ctx)) continue
					if (MODEL_INVALIDATION_EVENTS.has(event.type)) {
						context.invalidateModelList()
						continue
					}
					if (HISTORY_INVALIDATION_EVENTS.has(event.type)) {
						const sessionID = eventSessionID(event)
						if (sessionID) invalidateSession(sessionID)
					}
				}
			} catch (error) {
				if (!controller.signal.aborted) log("[v2 instructions] Event stream stopped; reconnecting", error)
			}
			if (!controller.signal.aborted) await retryDelay(controller.signal)
		}
	})()
	// A disconnected server can end the iterator normally. Keep the monitor
	// rejection observed during its whole lifetime, not only at cleanup.
	void monitorTask.catch((error) => log("[v2 instructions] Event monitor failed", error))

	try {
		const cleanup = await ctx.tool.hook("execute.after", queuedAfter)
		cleanups.push(() => cleanup.dispose())
	} catch (error) {
		disposed = true
		controller.abort()
		await monitorTask
		throw error
	}

	return async () => {
		if (disposed) return
		disposed = true
		controller.abort()
		for (const state of states.values()) state.epoch += 1
		const errors: unknown[] = []
		for (const cleanup of cleanups.reverse()) {
			try {
				await cleanup()
			} catch (error) {
				errors.push(error)
			}
		}
		await monitorTask
		await Promise.all([...states.values()].map((state) => state.queue))
		states.clear()
		if (errors.length > 0) throw new AggregateError(errors, "One or more V2 instruction hooks failed to clean up")
	}
}
