import { readFile } from "node:fs/promises"
import { resolve as resolvePath } from "node:path"
import type { Plugin } from "@opencode/plugin"
import { Error as ToolError, type Result as NativeToolResult } from "@opencode/plugin/promise/tool"
import type { ShellCreateBefore } from "@opencode/plugin/promise/shell"
import type { OhMyOpenCodeConfig } from "../config"
import { NON_INTERACTIVE_ENV } from "../hooks/non-interactive-env/constants"
import { createNotepadWriteGuardHook } from "../hooks/notepad-write-guard"
import { NOTEPAD_DIRECTIVE } from "../hooks/sisyphus-junior-notepad/constants"
import { computeLineHash } from "../tools/hashline-edit/hash-computation"
import { isCanonicallyAllowedMarkdown } from "./path-policy"

const PROMETHEUS_AGENT = "prometheus"
const READ_TOOL = "read"
const WRITE_SUCCESS_MARKER = "File written successfully."
const READ_LINE = /^\s*(\d+): ?(.*)$/
const TRUNCATED_LINE_SUFFIX = "... (line truncated to 2000 chars)"

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isPrometheus(agent: string | undefined): boolean {
	return agent?.toLowerCase() === PROMETHEUS_AGENT
}

function isToolDisabled(config: OhMyOpenCodeConfig, name: string): boolean {
	return config.disabled_tools?.some((tool) => tool.trim().toLowerCase() === name) ?? false
}

function textFromContent(content: NativeToolResult["content"]): string {
	if (typeof content === "string") return content
	if (!Array.isArray(content)) return ""
	return content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n")
}

function appendTextContent(content: NativeToolResult["content"], text: string): NativeToolResult["content"] {
	if (typeof content === "string") return `${content.trimEnd()}${content.trim() ? "\n\n" : ""}${text}`
	return [...(content ?? []), { type: "text", text }]
}

function resumeSessionID(result: NativeToolResult): string | undefined {
	if (!isRecord(result.metadata)) return undefined
	const id = result.metadata.sessionID
	return typeof id === "string" && id.startsWith("ses") && id.trim() === id ? id : undefined
}

function appendTaskResumeHint(
	result: NativeToolResult,
	input: unknown,
	config: OhMyOpenCodeConfig,
): NativeToolResult {
	if (isToolDisabled(config, "task")) return result
	const sessionID = resumeSessionID(result)
	if (!sessionID) return result
	const metadata = isRecord(result.metadata) ? result.metadata : undefined
	const status = metadata?.status
	if (typeof status === "string" && status !== "completed") return result
	const data = isRecord(input) ? input : {}
	const existingSessionID = typeof data.task_id === "string" ? data.task_id
		: typeof data.session_id === "string" ? data.session_id : undefined
	if (existingSessionID && existingSessionID !== sessionID) return result
	const previousText = textFromContent(result.content)
	if (/^\s*(?:Error:|Failed\b)/i.test(previousText) || /to continue: task\(/i.test(previousText)) return result
	const hint = `to continue: task(task_id=${JSON.stringify(sessionID)}, prompt="...")`
	return { ...result, content: appendTextContent(result.content, hint) }
}

function enhanceText(text: string): string {
	const lines = text.split("\n")
	const headerIndex = lines.findIndex((line) => /^Read file .*, lines? \d+-\d+$/.test(line) || /^Read file .*, 0 lines$/.test(line))
	if (headerIndex < 0) return text
	let changed = false
	for (let index = headerIndex + 1; index < lines.length; index += 1) {
		const match = READ_LINE.exec(lines[index] ?? "")
		if (!match) continue
		const lineNumber = Number.parseInt(match[1] ?? "", 10)
		const content = match[2] ?? ""
		if (!Number.isInteger(lineNumber) || content.endsWith(TRUNCATED_LINE_SUFFIX)) continue
		lines[index] = `${lineNumber}#${computeLineHash(lineNumber, content)}|${content}`
		changed = true
	}
	return changed ? lines.join("\n") : text
}

function enhanceReadResult(result: unknown): unknown {
	if (!isRecord(result)) return result
	const content = result.content
	if (typeof content === "string") {
		const enhanced = enhanceText(content)
		return enhanced === content ? result : { ...result, content: enhanced }
	}
	if (!Array.isArray(content)) return result
	let changed = false
	const next = content.map((part) => {
		if (!isRecord(part) || part.type !== "text" || typeof part.text !== "string") return part
		const enhanced = enhanceText(part.text)
		if (enhanced === part.text) return part
		changed = true
		return { ...part, text: enhanced }
	})
	return changed ? { ...result, content: next } : result
}

function errorMessage(resources: readonly string[]): string {
	const attempted = resources.length > 0 ? resources.join(", ") : "an edit without a file resource"
	return "[prometheus-md-only] Prometheus may edit only Markdown files inside the workspace .omo directory. " +
		"Do not delegate implementation; record the intended change in the plan for /ulw-execute. " +
		`Attempted: ${attempted}.`
}

/** Register native permission and read-result hooks for OpenCode 2. */
export async function registerV2ToolHooks(ctx: Plugin.Context, config: OhMyOpenCodeConfig): Promise<() => Promise<void>> {
	const cleanups: Array<() => Promise<void>> = []
	const disabled = new Set(config.disabled_hooks ?? [])
	try {
		if (!disabled.has("prometheus-md-only")) {
			const permission = await ctx.permission.hook("evaluate", async (event) => {
				if (event.action !== "edit" || !isPrometheus(event.agent)) return
				const resources = event.resources
				const allowed = resources.length > 0 && (await Promise.all(
					resources.map((resource) => isCanonicallyAllowedMarkdown(resource, String(ctx.location.directory))),
				)).every(Boolean)
				if (allowed) return
				event.effect = "deny"
				event.message = errorMessage(resources)
			})
			cleanups.push(() => permission.dispose())
		}

		if (!disabled.has("non-interactive-env")) {
			const nonInteractive = await ctx.shell.hook("create.before", (event: ShellCreateBefore) => {
				// Keep the legacy trigger boundary: any command containing the git executable name.
				if (!/\bgit\b/i.test(event.command)) return
				Object.assign(event.env, NON_INTERACTIVE_ENV)
			})
			cleanups.push(() => nonInteractive.dispose())
		}

		if (!disabled.has("notepad-write-guard")) {
			const notepadGuard = createNotepadWriteGuardHook()["tool.execute.before"]!
			const registration = await ctx.tool.hook("execute.before", async (event) => {
				try {
					await notepadGuard(
						{ tool: event.tool, sessionID: event.sessionID, callID: event.id },
						{ args: isRecord(event.input) ? event.input : {} },
					)
				} catch (error) {
					if (!(error instanceof Error)) throw error
					throw new ToolError({ message: error.message })
				}
			})
			cleanups.push(() => registration.dispose())
		}

		if (!disabled.has("sisyphus-junior-notepad") && !isToolDisabled(config, "task")) {
			const atlasDirective = await ctx.tool.hook("execute.before", (event) => {
				if (event.tool !== "task" || event.agent !== "atlas" || !isRecord(event.input)) return
				const prompt = event.input.prompt
				if (typeof prompt !== "string" || prompt.includes("<Work_Context>")) return
				event.input = { ...event.input, prompt: `${NOTEPAD_DIRECTIVE}${prompt}` }
			})
			cleanups.push(() => atlasDirective.dispose())
		}

		if (config.hashline_edit === true && !disabled.has("hashline-read-enhancer")) {
			const readEnhancer = await ctx.tool.hook("execute.after", async (event) => {
				if (event.status !== "completed") return
				const tool = event.tool.toLowerCase()
				if (tool === READ_TOOL) {
					event.result = enhanceReadResult(event.result) as typeof event.result
					return
				}
				// Legacy hashline write summary: report the written line count so hash anchors are re-read.
				if (tool === "write" && isRecord(event.input)) {
					const path = typeof event.input.filePath === "string" ? event.input.filePath : typeof event.input.path === "string" ? event.input.path : undefined
					if (!path) return
					try {
						const absolute = resolvePath(String(ctx.location.directory), path)
						const content = await readFile(absolute, "utf8")
						const lineCount = content === "" ? 0 : content.split("\n").length
						event.result = { ...event.result, content: [{ type: "text", text: `${WRITE_SUCCESS_MARKER} ${lineCount} lines written.` }] } as typeof event.result
					} catch {
						// Keep the native write result when the file cannot be re-read.
					}
				}
			})
			cleanups.push(() => readEnhancer.dispose())
		}

		if (!disabled.has("task-resume-info")) {
			const resumeInfo = await ctx.tool.hook("execute.after", (event) => {
				if (event.status !== "completed" || (event.tool !== "task" && event.tool !== "call_omo_agent")) return
				event.result = appendTaskResumeHint(event.result, event.input, config) as typeof event.result
			})
			cleanups.push(() => resumeInfo.dispose())
		}
	} catch (error) {
		const cleanupErrors: unknown[] = []
		for (const cleanup of cleanups.reverse()) {
			try {
				await cleanup()
			} catch (cleanupError) {
				cleanupErrors.push(cleanupError)
			}
		}
		if (cleanupErrors.length > 0) {
			throw new AggregateError([error, ...cleanupErrors], "V2 tool-hook registration failed and cleanup was incomplete")
		}
		throw error
	}

	let disposed = false
	return async () => {
		if (disposed) return
		disposed = true
		const errors: unknown[] = []
		for (const cleanup of cleanups.reverse()) {
			try {
				await cleanup()
			} catch (error) {
				errors.push(error)
			}
		}
		if (errors.length > 0) throw new AggregateError(errors, "One or more V2 tool-hook registrations failed to clean up")
	}
}
