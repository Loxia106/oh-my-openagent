import type { Plugin } from "@opencode/plugin"
import { Error as ToolError, type Result as NativeToolResult } from "@opencode/plugin/promise/tool"
import type { OhMyOpenCodeConfig } from "../config"
import { EDIT_ERROR_PATTERNS, EDIT_ERROR_REMINDER } from "../hooks/edit-error-recovery"
import {
	JSON_ERROR_PATTERNS,
	JSON_ERROR_REMINDER,
	JSON_ERROR_TOOL_EXCLUDE_LIST,
} from "../hooks/json-error-recovery"

const EDIT_REMINDER_MARKER = "[EDIT ERROR - IMMEDIATE ACTION REQUIRED]"
const JSON_REMINDER_MARKER = "[JSON PARSE ERROR - IMMEDIATE ACTION REQUIRED]"
const EMPTY_RESPONSE_MARKER = "[Task Empty Response Warning]"
const SUBAGENT_NO_TEXT = "Subagent completed without a text response."

const NATIVE_EDIT_ERROR_PATTERNS = [
	/no changes to apply: oldstring and newstring are identical/i,
	/could not find oldstring\b/i,
	/\bfound \d+ matches for oldstring\b/i,
] as const

const JSON_ERROR_EXCLUDED_TOOLS = new Set([...JSON_ERROR_TOOL_EXCLUDE_LIST, "shell", "subagent"])
const EMPTY_RESPONSE_TOOLS = new Set(["task", "subagent", "call_omo_agent"])

const EMPTY_RESPONSE_WARNING = `[Task Empty Response Warning]

The call completed, but no textual result is available. Do not infer that the task objective was fulfilled.

Note: The call has already completed - you are NOT waiting for a response. Proceed accordingly.`

type FailureEvent = {
	tool: string
	status: "error"
	error: InstanceType<typeof ToolError>
}

type CompletedEvent = {
	tool: string
	status: "completed"
	result: NativeToolResult
}

function hasMarker(value: string, marker: string): boolean {
	return value.includes(marker)
}

function appendReminder(message: string, reminder: string, marker: string): string {
	if (hasMarker(message, marker)) return message
	return `${message}${message.endsWith("\n") ? "" : "\n"}${reminder}`
}

function replaceFailure(event: FailureEvent, message: string): void {
	const original = event.error
	event.error = new ToolError({
		message,
		error: original.error,
		metadata: original.metadata,
	})
}

function isEditRecoveryMessage(message: string): boolean {
	const lower = message.toLowerCase()
	return EDIT_ERROR_PATTERNS.some((pattern) => lower.includes(pattern.toLowerCase())) ||
		NATIVE_EDIT_ERROR_PATTERNS.some((pattern) => pattern.test(message))
}

function applyEditErrorRecovery(event: FailureEvent & { tool: string }): void {
	if (event.tool.trim().toLowerCase() !== "edit") return
	if (!isEditRecoveryMessage(event.error.message)) return
	const message = appendReminder(event.error.message, EDIT_ERROR_REMINDER, EDIT_REMINDER_MARKER)
	if (message !== event.error.message) replaceFailure(event, message)
}

function applyJsonErrorRecovery(event: FailureEvent & { tool: string }): void {
	if (JSON_ERROR_EXCLUDED_TOOLS.has(event.tool.trim().toLowerCase())) return
	if (!JSON_ERROR_PATTERNS.some((pattern) => pattern.test(event.error.message))) return
	const message = appendReminder(event.error.message, JSON_ERROR_REMINDER, JSON_REMINDER_MARKER)
	if (message !== event.error.message) replaceFailure(event, message)
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

function resultText(result: NativeToolResult): string {
	if (typeof result.content === "string") return result.content
	if (!Array.isArray(result.content)) return ""
	return result.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n")
}

function hasFileContent(result: NativeToolResult): boolean {
	if (typeof result.content === "string" || !Array.isArray(result.content)) return false
	return result.content.some((part) => part.type === "file")
}

function appendTextContent(content: NativeToolResult["content"], text: string): NativeToolResult["content"] {
	if (typeof content === "string") return `${content}${content.trim() ? "\n\n" : ""}${text}`
	return [...(content ?? []), { type: "text", text }]
}

function applyEmptyTaskResponseWarning(event: CompletedEvent & { tool: string }): void {
	if (!EMPTY_RESPONSE_TOOLS.has(event.tool.trim().toLowerCase())) return
	if (!isRecord(event.result.output)) return
	const output = event.result.output
	if (output.status !== "completed" || typeof output.output !== "string") return
	const response = output.output
	if (response.trim() !== "" && response.trim() !== SUBAGENT_NO_TEXT) return
	if (hasFileContent(event.result)) return
	if (response.includes(EMPTY_RESPONSE_MARKER) || resultText(event.result).includes(EMPTY_RESPONSE_MARKER)) return

	event.result = {
		...event.result,
		content: appendTextContent(event.result.content, EMPTY_RESPONSE_WARNING),
	} as typeof event.result
}

async function unwind(cleanups: Array<() => Promise<void>>): Promise<unknown[]> {
	const errors: unknown[] = []
	for (const cleanup of cleanups.reverse()) {
		try {
			await cleanup()
		} catch (error) {
			errors.push(error)
		}
	}
	return errors
}

/** Register the native, failure-preserving versions of OMO's tool-result recovery hooks. */
export async function registerV2RecoveryHooks(
	ctx: Plugin.Context,
	config: OhMyOpenCodeConfig,
): Promise<() => Promise<void>> {
	const disabled = new Set(config.disabled_hooks ?? [])
	const cleanups: Array<() => Promise<void>> = []
	let disposed = false

	try {
		if (!disabled.has("edit-error-recovery")) {
			const registration = await ctx.tool.hook("execute.after", (event) => {
				if (disposed || event.status !== "error") return
				applyEditErrorRecovery(event)
			})
			cleanups.push(() => registration.dispose())
		}

		if (!disabled.has("json-error-recovery")) {
			const registration = await ctx.tool.hook("execute.after", (event) => {
				if (disposed || event.status !== "error") return
				applyJsonErrorRecovery(event)
			})
			cleanups.push(() => registration.dispose())
		}

		if (!disabled.has("empty-task-response-detector")) {
			const registration = await ctx.tool.hook("execute.after", (event) => {
				if (disposed || event.status !== "completed") return
				applyEmptyTaskResponseWarning(event)
			})
			cleanups.push(() => registration.dispose())
		}
	} catch (error) {
		disposed = true
		const cleanupErrors = await unwind(cleanups)
		if (cleanupErrors.length > 0) {
			throw new AggregateError([error, ...cleanupErrors], "V2 recovery-hook registration failed and cleanup was incomplete")
		}
		throw error
	}

	return async () => {
		if (disposed) return
		disposed = true
		const errors = await unwind(cleanups)
		if (errors.length > 0) throw new AggregateError(errors, "One or more V2 recovery hooks failed to clean up")
	}
}
