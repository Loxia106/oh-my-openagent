import { mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import type { Plugin } from "@opencode/plugin"
import type { ModelEditor } from "@opencode/plugin/promise/model"
import type { SessionCompaction } from "@opencode/plugin/promise/session"
import type { OhMyOpenCodeConfig } from "../config"
import { getAgentConfigKey } from "../shared/agent-display-names"
import { log } from "../shared/logger"
import { truncateToTokenLimit } from "../shared/token-limit-truncator"
import { toV2ModelRef, type V2ModelRef } from "./model-resolution"

/** Legacy preemptive-compaction threshold: compact once input usage reaches 78% of the context window. */
export const PREEMPTIVE_COMPACTION_THRESHOLD = 0.78
/** OpenCode 2.0.18 `SessionCompaction` default buffer (`compaction.buffer`). */
export const HOST_COMPACTION_BUFFER = 20_000
const CHARS_PER_TOKEN = 4
const COMPACTION_TOOL_OUTPUT_MAX_CHARS = 2_000
const COMPACTION_OUTPUT_RESERVE_TOKENS = 32_000
const DEFAULT_TRUNCATION_TARGET_TOKENS = 50_000
const WEBFETCH_TRUNCATION_TARGET_TOKENS = 10_000
const MODEL_LIMIT_CACHE_MS = 30_000

export const TRUNCATABLE_TOOLS = new Set([
	"grep", "safe_grep", "glob", "safe_glob", "lsp_diagnostics", "lsp_lsp_diagnostics",
	"interactive_bash", "skill_mcp", "webfetch",
])

type ModelKey = string
const modelKey = (providerID: string, id: string): ModelKey => `${providerID}/${id}`

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * The host's automatic compaction runs once the estimated prompt reaches
 * `min(limit.input - buffer, context - max(output, buffer))`. Lowering `limit.input` to
 * `78% of context + buffer` makes the native trigger fire at the legacy OMO threshold.
 */
export function preemptiveInputLimit(context: number, threshold = PREEMPTIVE_COMPACTION_THRESHOLD, buffer = HOST_COMPACTION_BUFFER): number | undefined {
	if (!Number.isFinite(context) || context <= 0) return undefined
	return Math.floor(context * threshold) + buffer
}

type ComposedLimit = { readonly context: number; readonly input?: number }

/** Opt-in (`experimental.preemptive_compaction`) native threshold policy through the model registry. */
export async function registerV2PreemptiveCompaction(ctx: Plugin.Context, config: OhMyOpenCodeConfig): Promise<() => Promise<void>> {
	if (!config.experimental?.preemptive_compaction || config.disabled_hooks?.includes("preemptive-compaction")) return async () => {}
	const composed = new Map<ModelKey, ComposedLimit>()
	const applied = new Map<ModelKey, number>()
	let active = true
	const registration = await ctx.model.transform((editor: ModelEditor) => {
		applied.clear()
		for (const model of editor.list()) {
			const providerID = String(model.providerID)
			const id = String(model.id)
			const key = modelKey(providerID, id)
			const context = composed.get(key)?.context ?? Number(model.limit?.context ?? 0)
			const target = preemptiveInputLimit(context)
			if (target === undefined) continue
			const current = typeof model.limit?.input === "number" ? model.limit.input : undefined
			// A stricter host/model input limit already compacts earlier; never loosen it.
			if (current !== undefined && current <= target) continue
			editor.update(providerID, id, (draft) => {
				draft.limit = { ...draft.limit, input: target }
			})
			applied.set(key, target)
		}
	})
	let refreshing: Promise<void> | undefined
	let refreshAgain = false
	const refresh = () => {
		if (!active) return
		if (refreshing) {
			refreshAgain = true
			return
		}
		refreshing = (async () => {
			const models = await ctx.model.list()
			let changed = false
			for (const model of models.data) {
				const key = modelKey(String(model.providerID), String(model.id))
				const context = Number(model.limit?.context ?? 0)
				if (!Number.isFinite(context) || context <= 0) continue
				const previous = composed.get(key)
				if (previous?.context !== context) changed = true
				composed.set(key, { context, ...(typeof model.limit?.input === "number" ? { input: model.limit.input } : {}) })
				// Config providers can supply `limit.context` after plugin transforms. Reload once the
				// composed context is known so the transform computes the threshold from it.
				const target = preemptiveInputLimit(context)
				if (target !== undefined && applied.get(key) === undefined && (model.limit?.input === undefined || model.limit.input > target)) changed = true
			}
			if (changed && active) await ctx.model.reload()
		})().catch((error) => {
			if (active) log("[v2 preemptive-compaction] Could not refresh composed model limits.", error)
		}).finally(() => {
			refreshing = undefined
			if (refreshAgain && active) {
				refreshAgain = false
				refresh()
			}
		})
	}
	const controller = new AbortController()
	const events = (async () => {
		try {
			for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
				if (!active) break
				if (event.type === "model.updated" || event.type === "provider.updated") refresh()
			}
		} catch (error) {
			if (active && !controller.signal.aborted) log("[v2 preemptive-compaction] Model event subscription stopped.", error)
		}
	})()
	// Never query the composed catalog synchronously inside setup.
	const initial = setTimeout(refresh, 0)
	return async () => {
		active = false
		clearTimeout(initial)
		controller.abort()
		await events
		await refreshing
		await registration.dispose()
	}
}

type CompactionOverride = { readonly model: V2ModelRef }

export function resolveV2CompactionModel(config: OhMyOpenCodeConfig, agent: string): CompactionOverride | undefined {
	const agents = config.agents as Record<string, { compaction?: { model?: string; variant?: string; reasoning?: unknown } } | undefined> | undefined
	const override = agents?.[getAgentConfigKey(agent)]?.compaction
	if (!override?.model) return undefined
	const variant = override.variant ?? (typeof override.reasoning === "string" ? override.reasoning : undefined)
	const model = toV2ModelRef(override.model, variant)
	return model ? { model } : undefined
}

const SUMMARY_TEMPLATE = `You MUST use this format for your response (you may omit sections that aren't applicable). Do not include the <template> tags in your response.
<template>
## Objective
- [one or two brief sentences describing what the user is trying to accomplish]

## Requirements
- [constraints, preferences, requirements, and scope boundaries stated by the user, or "(none)"]

## Decisions
- [decisions already made and why, or "(none)"]

## Work State
Break the objective into smaller goals and report which are completed, which are being worked on, and which are blocked.
### Completed
- [goals that have been completed; otherwise "(none)"]

### Active
- [goals currently being worked on; otherwise "(none)"]

### Blocked
- [anything blocking progress, and why; otherwise "(none)"]

## Next Move
1. [ordered list of next actions, or "(none)"]

## Relevant Files
List the files and directories, other than the current working directory, that another agent would need to open to continue this work. Include at most 15, most important first. If none, write "(none)".
- \`[file or directory path]\`: [brief reason it matters]

## Important Context
- [facts the next agent cannot continue without and cannot easily find on its own; or "(none)"]
</template>`

const SUMMARY_RULES = `Rules:
- Keep each section concise. Use terse, single-line bullets, not prose paragraphs or nested lists.
- Preserve exact file paths, symbols, commands, error strings, URLs, and identifiers.
- Carry forward only user questions or requests that remain unanswered or require further action. Preserve exact wording when carrying one forward.
- Preserve consequential workflow state, including whether changes are uncommitted, committed, pushed, under review, or merged.
- Do not mention the summary process or that context was compacted.`

const SUMMARY_HEADINGS = SUMMARY_TEMPLATE.split("\n").filter((line) => line.startsWith("##")).map((line) => line.trim())

/** Mirrors OpenCode 2.0.18 `SessionCompaction.buildPrompt` so an OMO-selected model writes the host's format. */
export function buildV2CompactionPrompt(update: boolean): string {
	const shared = [
		"Summarize only what the user and the assistant said and did. Leave out instructions and setup the assistant was given rather than told by the user: repository conventions, instruction files such as AGENTS.md, and environment details like the session ID. The next agent receives current versions of all of these separately.",
		SUMMARY_TEMPLATE,
		SUMMARY_RULES,
		"Do not continue the task or call tools.",
		"Return only the structured summary in the requested format. Do not include a preamble, explanation, or other commentary.",
	]
	return update
		? [
			"Update the existing checkpoint in the conversation above into one consolidated summary.",
			"Newer history always takes precedence over the existing checkpoint. Preserve previous information unless newer history clearly contradicts, supersedes, resolves, or makes it stale.",
			"Return only the updated Markdown sections. Do not reproduce the `<conversation-checkpoint>`, `<summary>`, or `<recent-context>` wrapper tags from the previous checkpoint.",
			...shared,
		].join("\n\n")
		: ["You MUST summarize the conversation above into a structured summary that will be given to another agent to resume the work.", ...shared].join("\n\n")
}

export function hasV2SummarySection(summary: string): boolean {
	return summary.split("\n").some((line) => SUMMARY_HEADINGS.includes(line.trim()))
}

function truncate(value: string, max: number): string {
	return value.length <= max ? value : `${value.slice(0, max)}\n[truncated]`
}

function partText(part: unknown): string {
	if (typeof part === "string") return part
	if (!isRecord(part)) return ""
	if (part.type === "text" || part.type === "reasoning" || part.type === "compaction") return typeof part.text === "string" ? part.text : ""
	if (part.type === "tool-call") return `[Assistant tool call]: ${String(part.name)}(${JSON.stringify(part.input ?? {})})`
	if (part.type === "tool-result") {
		const result = isRecord(part.result) ? part.result : undefined
		const value = result?.value
		const text = Array.isArray(value)
			? value.map((item) => isRecord(item) && typeof item.text === "string" ? item.text : isRecord(item) ? `[Attached ${String(item.mime ?? item.type)}]` : "").join("\n")
			: typeof value === "string" ? value : JSON.stringify(value ?? null)
		return `[Tool result]: ${truncate(text, COMPACTION_TOOL_OUTPUT_MAX_CHARS)}`
	}
	if (part.type === "media") return "[Attached media]"
	return ""
}

/** Serialize the native compaction transcript for a single-prompt summary request. */
export function serializeV2CompactionTranscript(input: Pick<SessionCompaction, "system" | "messages">): { system: string; transcript: string[] } {
	const system = input.system.map((part) => part.text).filter(Boolean).join("\n\n")
	const transcript = input.messages.flatMap((message) => {
		const row = message as unknown as { role?: string; content?: unknown }
		const content = Array.isArray(row.content) ? row.content.map(partText).filter(Boolean).join("\n") : partText(row.content)
		if (!content) return []
		const role = row.role === "assistant" ? "Assistant" : row.role === "tool" ? "Tool" : row.role === "system" ? "System" : "User"
		return [`[${role}]: ${content}`]
	})
	return { system, transcript }
}

/** Per-agent `compaction.model`: supply the summary from the configured model instead of the session model. */
export async function registerV2CompactionModelOverride(ctx: Plugin.Context, config: OhMyOpenCodeConfig): Promise<() => Promise<void>> {
	const configured = Object.values((config.agents ?? {}) as Record<string, { compaction?: { model?: string } } | undefined>).some((agent) => agent?.compaction?.model)
	if (!configured) return async () => {}
	const registration = await ctx.session.hook("compaction", async (input: SessionCompaction) => {
		if (input.result) return
		const override = resolveV2CompactionModel(config, String(input.agent))
		if (!override) return
		const current = input.model
		if (String(current.providerID) === override.model.providerID && String(current.id) === override.model.id &&
			(override.model.variant === undefined || String(current.variant ?? "") === override.model.variant)) return
		let model = override.model
		let context = 0
		try {
			const listed = (await ctx.model.list()).data.find((entry) => String(entry.providerID) === model.providerID && String(entry.id) === model.id)
			if (!listed || listed.enabled === false) {
				log("[v2 compaction-model] Configured compaction model is unavailable; using the session model.", { sessionID: input.sessionID, model })
				return
			}
			context = Number(listed.limit?.context ?? 0)
			if (model.variant && !listed.variants?.some((variant) => String(variant.id) === model.variant)) {
				log("[v2 compaction-model] Configured compaction variant is unavailable; using the model default.", { model })
				model = { providerID: model.providerID, id: model.id }
			}
		} catch (error) {
			log("[v2 compaction-model] Could not verify the compaction model; using the session model.", { sessionID: input.sessionID, error })
			return
		}
		const { system, transcript } = serializeV2CompactionTranscript(input)
		const update = transcript.some((line) => line.includes("<conversation-checkpoint>"))
		const instructions = buildV2CompactionPrompt(update)
		const budgetChars = context > 0
			? Math.max(4_000, (context - COMPACTION_OUTPUT_RESERVE_TOKENS) * CHARS_PER_TOKEN - system.length - instructions.length)
			: Number.POSITIVE_INFINITY
		const kept: string[] = []
		let size = 0
		for (let index = transcript.length - 1; index >= 0; index--) {
			const line = transcript[index]!
			if (size + line.length + 2 > budgetChars && kept.length > 0) {
				kept.unshift(`[${index + 1} earlier transcript entries omitted to fit the compaction model context]`)
				break
			}
			kept.unshift(line)
			size += line.length + 2
		}
		const prompt = [
			system ? `<system>\n${system}\n</system>` : "",
			`<conversation>\n${kept.join("\n\n")}\n</conversation>`,
			instructions,
		].filter(Boolean).join("\n\n")
		try {
			const generated = await ctx.generate.text({ prompt, model })
			const summary = generated.text.trim()
			if (!hasV2SummarySection(summary)) {
				log("[v2 compaction-model] Compaction model output did not match the host template; using the session model.", { sessionID: input.sessionID, model })
				return
			}
			input.result = { summary, metadata: { omoCompactionModel: `${model.providerID}/${model.id}${model.variant ? `#${model.variant}` : ""}` } }
		} catch (error) {
			log("[v2 compaction-model] Compaction model request failed; using the session model.", { sessionID: input.sessionID, model, error })
		}
	})
	return async () => { await registration.dispose() }
}

type Usage = { used: number; limit: number }

async function contextUsage(ctx: Plugin.Context, sessionID: string, limits: () => Promise<Map<ModelKey, number>>): Promise<Usage | undefined> {
	const session = await ctx.session.get({ sessionID })
	if (!session.model?.providerID || !session.model.id) return undefined
	const limit = (await limits()).get(modelKey(String(session.model.providerID), String(session.model.id)))
	if (!limit) return undefined
	const messages = await ctx.session.context({ sessionID }) as Array<{ type?: string; tokens?: { input?: number; output?: number; cache?: { read?: number; write?: number } } }>
	for (let index = messages.length - 1; index >= 0; index--) {
		const tokens = messages[index]?.type === "assistant" ? messages[index]?.tokens : undefined
		if (!tokens) continue
		const used = (tokens.input ?? 0) + (tokens.cache?.read ?? 0) + (tokens.cache?.write ?? 0) + (tokens.output ?? 0)
		if (used > 0) return { used, limit }
	}
	return undefined
}

function contentTextOf(content: unknown): string {
	if (typeof content === "string") return content
	if (!Array.isArray(content)) return ""
	return content.flatMap((item) => isRecord(item) && item.type === "text" && typeof item.text === "string" ? [item.text] : []).join("\n")
}

/**
 * Dynamic token budget for large tool outputs (legacy `tool-output-truncator`): the smaller of the
 * tool target and half of the remaining context. Marks the result truncated so the host's fixed
 * line/byte fallback does not apply twice, and retains the full output on disk.
 */
export async function registerV2ToolOutputTruncator(ctx: Plugin.Context, config: OhMyOpenCodeConfig): Promise<() => Promise<void>> {
	if (config.disabled_hooks?.includes("tool-output-truncator")) return async () => {}
	const truncateAll = config.experimental?.truncate_all_tool_outputs === true
	let cached: { at: number; value: Promise<Map<ModelKey, number>> } | undefined
	const limits = () => {
		if (!cached || Date.now() - cached.at > MODEL_LIMIT_CACHE_MS) {
			const value = ctx.model.list().then((models) => new Map(models.data.flatMap((model) => {
				const context = Number(model.limit?.context ?? 0)
				return context > 0 ? [[modelKey(String(model.providerID), String(model.id)), context] as const] : []
			})))
			value.catch(() => { if (cached?.value === value) cached = undefined })
			cached = { at: Date.now(), value }
		}
		return cached.value
	}
	const directory = join(tmpdir(), "omo-tool-output")
	const registration = await ctx.tool.hook("execute.after", async (event) => {
		if (event.status !== "completed") return
		const tool = event.tool.toLowerCase()
		if (!truncateAll && !TRUNCATABLE_TOOLS.has(tool)) return
		const result = event.result as { content?: unknown; metadata?: Record<string, unknown> }
		if (result.metadata?.truncated === true) return
		const text = contentTextOf(result.content)
		if (!text) return
		const target = tool === "webfetch" ? WEBFETCH_TRUNCATION_TARGET_TOKENS : DEFAULT_TRUNCATION_TARGET_TOKENS
		let maxTokens = target
		try {
			const usage = await contextUsage(ctx, event.sessionID, limits)
			if (usage) maxTokens = Math.min(Math.floor((usage.limit - usage.used) * 0.5), target)
		} catch (error) {
			log("[v2 tool-output-truncator] Could not read context usage; using the fixed target.", { sessionID: event.sessionID, error })
		}
		const truncation = maxTokens <= 0
			? { result: "[Output suppressed - context window exhausted]", truncated: true }
			: truncateToTokenLimit(text, maxTokens)
		if (!truncation.truncated) return
		let outputPath: string | undefined
		try {
			await mkdir(directory, { recursive: true })
			outputPath = join(directory, `tool_${Date.now()}_${randomUUID().slice(0, 8)}.txt`)
			await writeFile(outputPath, text, "utf8")
		} catch (error) {
			outputPath = undefined
			log("[v2 tool-output-truncator] Could not retain the full output.", error)
		}
		const files = Array.isArray(result.content) ? result.content.filter((item) => isRecord(item) && item.type === "file") : []
		const marker = outputPath ? `\n[OMO dynamic truncation; full output saved to ${outputPath}]` : ""
		result.content = [{ type: "text", text: `${truncation.result}${marker}` }, ...files]
		result.metadata = { ...result.metadata, truncated: true, ...(outputPath ? { outputPath } : {}), omoTruncation: { maxTokens } }
	})
	return async () => { await registration.dispose() }
}

const COMPACTION_TRUNCATED_RESULT_MIN_CHARS = 500

function toolResultTexts(message: unknown): Array<{ get: () => string; set: (text: string) => void }> {
	const row = message as { content?: unknown }
	if (!Array.isArray(row.content)) return []
	return row.content.flatMap((part) => {
		if (!isRecord(part) || part.type !== "tool-result" || !isRecord(part.result)) return []
		const result = part.result
		if (typeof result.value === "string") {
			return [{ get: () => result.value as string, set: (text: string) => { result.value = text } }]
		}
		if (!Array.isArray(result.value)) return []
		return result.value.flatMap((item) => isRecord(item) && item.type === "text" && typeof item.text === "string"
			? [{ get: () => item.text as string, set: (text: string) => { item.text = text } }]
			: [])
	})
}

function estimateRequestChars(input: Pick<SessionCompaction, "system" | "messages">): number {
	const system = input.system.reduce((sum, part) => sum + part.text.length, 0)
	return system + input.messages.reduce((sum, message) => sum + JSON.stringify((message as { content?: unknown }).content ?? "").length, 0)
}

/**
 * Opt-in `experimental.aggressive_truncation`: before the host summarizes an overflowing history,
 * shrink the largest tool results in the compaction transcript (legacy target-token truncation) so
 * the summary request itself fits the model window. Durable history is never modified.
 */
export function boundV2CompactionTranscript(input: Pick<SessionCompaction, "system" | "messages">, contextTokens: number, outputTokens: number): number {
	const budgetChars = (contextTokens - Math.min(outputTokens || COMPACTION_OUTPUT_RESERVE_TOKENS, COMPACTION_OUTPUT_RESERVE_TOKENS) - HOST_COMPACTION_BUFFER) * CHARS_PER_TOKEN
	if (budgetChars <= 0) return 0
	let excess = estimateRequestChars(input) - budgetChars
	if (excess <= 0) return 0
	const results = input.messages.flatMap(toolResultTexts).sort((left, right) => right.get().length - left.get().length)
	let truncated = 0
	for (const result of results) {
		if (excess <= 0) break
		const text = result.get()
		if (text.length <= COMPACTION_TRUNCATED_RESULT_MIN_CHARS) break
		const marker = `\n[Tool output truncated from ${text.length} characters for compaction]`
		const keep = Math.max(COMPACTION_TRUNCATED_RESULT_MIN_CHARS, text.length - excess - marker.length - 16)
		if (keep >= text.length) continue
		result.set(`${text.slice(0, keep)}${marker}`)
		excess -= text.length - keep - marker.length
		truncated += 1
	}
	return truncated
}

export async function registerV2CompactionOverflowGuard(ctx: Plugin.Context, config: OhMyOpenCodeConfig): Promise<() => Promise<void>> {
	if (config.experimental?.aggressive_truncation !== true || config.disabled_hooks?.includes("anthropic-context-window-limit-recovery")) return async () => {}
	const registration = await ctx.session.hook("compaction", async (input: SessionCompaction) => {
		if (input.result) return
		try {
			const model = (await ctx.model.list()).data.find((entry) => String(entry.providerID) === String(input.model.providerID) && String(entry.id) === String(input.model.id))
			const context = Number(model?.limit?.context ?? 0)
			if (context <= 0) return
			const truncated = boundV2CompactionTranscript(input, context, Number(model?.limit?.output ?? 0))
			if (truncated > 0) log("[v2 context-window-recovery] Bounded tool results in the compaction transcript.", { sessionID: input.sessionID, truncated })
		} catch (error) {
			log("[v2 context-window-recovery] Could not bound the compaction transcript.", { sessionID: input.sessionID, error })
		}
	})
	return async () => { await registration.dispose() }
}
