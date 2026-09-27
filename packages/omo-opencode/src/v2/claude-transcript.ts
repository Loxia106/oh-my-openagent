import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ClaudeCodeContent, ClaudeCodeMessage } from "../hooks/claude-code-hooks/types"
import { transformToolName } from "../shared/tool-name"

type RecordValue = Record<string, unknown>

function record(value: unknown): RecordValue | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? value as RecordValue
		: undefined
}

function text(value: unknown): string {
	return typeof value === "string" ? value : ""
}

export function claudeToolName(value: unknown): string {
	const name = text(value)
	switch (name.toLowerCase()) {
		case "shell": return "Bash"
		case "subagent": return "Task"
		case "patch": return "Edit"
		case "question": return "AskUserQuestion"
		default: return transformToolName(name)
	}
}

export function toClaudeToolInput(toolName: string, value: unknown): Record<string, unknown> {
	const input = record(value)
	if (!input) return {}
	const result = { ...input }
	const path = typeof input.path === "string" ? input.path : undefined
	if (path !== undefined && ["read", "write", "edit"].includes(toolName.toLowerCase())) result.file_path = path
	if (toolName.toLowerCase() === "edit") {
		if (typeof input.oldString === "string") result.old_string = input.oldString
		if (typeof input.newString === "string") result.new_string = input.newString
		if (typeof input.replaceAll === "boolean") result.replace_all = input.replaceAll
	}
	if (toolName.toLowerCase() === "patch" && typeof input.patchText === "string") result.patch_text = input.patchText
	if (toolName.toLowerCase() === "subagent" && typeof input.agent === "string") result.subagent_type = input.agent
	return result
}

/** Apply legacy aliases from `updatedInput` back onto the native tool schema. */
export function applyClaudeToolInput(toolName: string, nativeValue: unknown, updatedValue: unknown): Record<string, unknown> {
	const native = record(nativeValue) ?? {}
	const updated = record(updatedValue) ?? {}
	const result: Record<string, unknown> = { ...native }
	const aliases: Array<[nativeKey: string, legacyKey: string]> = []
	if (["read", "write", "edit"].includes(toolName.toLowerCase())) aliases.push(["path", "file_path"])
	if (toolName.toLowerCase() === "edit") aliases.push(["oldString", "old_string"], ["newString", "new_string"], ["replaceAll", "replace_all"])
	if (toolName.toLowerCase() === "patch") aliases.push(["patchText", "patch_text"])
	if (toolName.toLowerCase() === "subagent") aliases.push(["agent", "subagent_type"])
	const aliasKeys = new Set(aliases.map(([, legacyKey]) => legacyKey))
	for (const [key, value] of Object.entries(updated)) {
		if (aliasKeys.has(key)) continue
		result[key] = value
	}
	for (const [nativeKey, legacyKey] of aliases) {
		if (Object.hasOwn(updated, legacyKey)) result[nativeKey] = updated[legacyKey]
		else if (Object.hasOwn(updated, nativeKey)) result[nativeKey] = updated[nativeKey]
		delete result[legacyKey]
	}
	return result
}

function safeFileURI(value: unknown, mime: string, name: string): string {
	const uri = text(value)
	if (!uri) return `[payload omitted${mime ? `; ${mime}` : ""}${name ? `; ${name}` : ""}]`
	if (/^data:/i.test(uri)) return `[inline payload omitted${mime ? `; ${mime}` : ""}${name ? `; ${name}` : ""}]`
	return uri
}

function fileReference(file: unknown): string | undefined {
	const row = record(file)
	if (!row) return undefined
	const name = text(row.name)
	const mime = text(row.mime)
	const source = record(row.source)
	const uri = source?.type === "uri" ? safeFileURI(source.uri, mime, name) : ""
	const description = text(row.description)
	const details = [name || undefined, mime || undefined, uri || undefined, description || undefined].filter(Boolean).join("; ")
	return `[attachment payload omitted from transcript: ${details || "file reference unavailable"}]`
}

function contentText(value: unknown): string {
	if (!Array.isArray(value)) return ""
	return value.map((part) => {
		const row = record(part)
		if (row?.type === "text") return text(row.text)
		if (row?.type === "file") {
			const uri = safeFileURI(row.uri, text(row.mime), text(row.name))
			return `[file result: ${uri}${text(row.mime) ? ` (${text(row.mime)})` : ""}]`
		}
		return ""
	}).filter(Boolean).join("\n")
}

function assistantErrorText(value: unknown): string | undefined {
	const error = record(value)
	if (!error) return undefined
	const message = text(error.message)
	if (!message) return undefined
	const type = text(error.type)
	return `[OpenCode assistant error${type ? ` (${type})` : ""}]: ${message}`
}

export interface ClaudeToolTranscriptExchange {
	readonly toolName: string
	readonly toolUseID: string
	readonly input: unknown
	readonly status: "running" | "completed" | "error"
	readonly result?: { readonly content?: unknown; readonly output?: unknown }
	readonly error?: { readonly type?: string; readonly message?: string }
}

/** Replace this invocation's transient state with the exact event currently being hooked. */
export function withClaudeToolExchange(messages: readonly unknown[], exchange: ClaudeToolTranscriptExchange): unknown[] {
	const withoutCurrent = messages.flatMap((value) => {
		const message = record(value)
		if (message?.type !== "assistant" || !Array.isArray(message.content)) return [value]
		const content = message.content.filter((partValue) => {
			const part = record(partValue)
			return !(part?.type === "tool" && part.id === exchange.toolUseID)
		})
		if (content.length === 0 && !message.error) return []
		return [{ ...message, content }]
	})
	const input = record(exchange.input) ?? {}
	let state: Record<string, unknown>
	if (exchange.status === "running") {
		state = { status: "running", input, metadata: {} }
	} else if (exchange.status === "completed") {
		const result = exchange.result ?? {}
		const output = result.content ?? result.output
		const content = typeof output === "string" ? [{ type: "text", text: output }] : Array.isArray(output) ? output : [{ type: "text", text: "" }]
		state = { status: "completed", input, content, metadata: {} }
	} else {
		state = {
			status: "error",
			input,
			error: { type: exchange.error?.type ?? "Tool.Error", message: exchange.error?.message ?? "Tool failed" },
			content: [{ type: "text", text: exchange.error?.message ?? "Tool failed" }],
			metadata: {},
		}
	}
	return [...withoutCurrent, { type: "assistant", agent: "", model: { id: "", providerID: "" }, content: [{
		type: "tool", id: exchange.toolUseID, name: text(exchange.toolName), state,
	}] }]
}

function userMessage(value: string): ClaudeCodeMessage | undefined {
	return value.trim() ? {
		type: "user",
		message: { role: "user", content: [{ type: "text", text: value }] },
	} : undefined
}

/**
 * Convert OpenCode's current model-visible session context into Claude JSONL.
 * The public context API is a compacted context window, not archival history;
 * media bytes are intentionally represented by file references, never copied.
 */
export function toClaudeTranscript(messages: readonly unknown[]): ClaudeCodeMessage[] {
	const output: ClaudeCodeMessage[] = []
	for (const value of messages) {
		const message = record(value)
		if (!message) continue
		if (message.type === "user") {
			const parts = [text(message.text), ...(Array.isArray(message.files) ? message.files.map(fileReference).filter((item): item is string => item !== undefined) : [])]
			const entry = userMessage(parts.filter(Boolean).join("\n"))
			if (entry) output.push(entry)
			continue
		}
		if (message.type === "synthetic" || message.type === "system") {
			const label = message.type === "system" ? "System update" : text(message.description)
			const entry = userMessage(label ? `[${label}]\n${text(message.text)}` : text(message.text))
			if (entry) output.push(entry)
			continue
		}
		if (message.type === "skill") {
			const entry = userMessage(`[Skill loaded: ${text(message.name)}]\n${text(message.text)}`)
			if (entry) output.push(entry)
			continue
		}
		if (message.type === "compaction") {
			const summary = text(message.summary)
			const recent = text(message.recent)
			const failure = message.status === "failed" ? assistantErrorText(message.error) : undefined
			const entry = userMessage([summary && `[Conversation summary]\n${summary}`, recent && `[Recent context]\n${recent}`, failure].filter(Boolean).join("\n\n"))
			if (entry) output.push(entry)
			continue
		}
		if (message.type !== "assistant") continue

		const assistantContent: ClaudeCodeContent[] = []
		const toolResults: ClaudeCodeContent[] = []
		for (const rawPart of Array.isArray(message.content) ? message.content : []) {
			const part = record(rawPart)
			if (part?.type === "text" && typeof part.text === "string") {
				assistantContent.push({ type: "text", text: part.text })
				continue
			}
			if (part?.type !== "tool") continue
			const toolName = claudeToolName(part.name)
			const state = record(part.state)
			let input = state?.input
			if (typeof input === "string") {
				try { input = JSON.parse(input) as unknown } catch { continue }
			}
			if (!record(input)) continue
			const toolUseId = text(part.id)
			if (!toolUseId) continue
			assistantContent.push({ type: "tool_use", id: toolUseId, name: toolName, input: toClaudeToolInput(text(part.name), input) })
			if (state?.status === "completed") {
				toolResults.push({ type: "tool_result", tool_use_id: toolUseId, content: contentText(state.content) })
			} else if (state?.status === "error") {
				const error = record(state.error)
				const details = [text(error?.message), contentText(state.content)].filter(Boolean).join("\n")
				toolResults.push({ type: "tool_result", tool_use_id: toolUseId, content: details || "Tool failed", is_error: true })
			}
		}
		const failure = assistantErrorText(message.error)
		if (failure) assistantContent.push({ type: "text", text: failure })
		if (assistantContent.length > 0) output.push({ type: "assistant", message: { role: "assistant", content: assistantContent } })
		if (toolResults.length > 0) output.push({ type: "user", message: { role: "user", content: toolResults } })
	}
	return output
}

export interface ClaudeTranscriptFile {
	readonly path: string
	readonly cleanup: () => Promise<void>
}

/** Create a private transcript file for one hook invocation; caller must cleanup in finally. */
export async function createClaudeTranscriptFile(messages: readonly unknown[]): Promise<ClaudeTranscriptFile> {
	const directory = await mkdtemp(join(tmpdir(), "omo-v2-claude-transcript-"))
	const path = join(directory, "transcript.jsonl")
	try {
		const entries = toClaudeTranscript(messages)
		await writeFile(path, entries.map((entry) => JSON.stringify(entry)).join("\n") + (entries.length ? "\n" : ""), { mode: 0o600 })
	} catch (error) {
		await rm(directory, { recursive: true, force: true })
		throw error
	}
	return { path, cleanup: () => rm(directory, { recursive: true, force: true }) }
}
