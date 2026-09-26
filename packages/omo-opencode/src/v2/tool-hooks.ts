import type { Plugin } from "@opencode/plugin"
import type { OhMyOpenCodeConfig } from "../config"
import { computeLineHash } from "../tools/hashline-edit/hash-computation"
import { isCanonicallyAllowedMarkdown } from "./path-policy"

const PROMETHEUS_AGENT = "prometheus"
const READ_TOOL = "read"
const READ_LINE = /^\s*(\d+): ?(.*)$/
const TRUNCATED_LINE_SUFFIX = "... (line truncated to 2000 chars)"

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isPrometheus(agent: string | undefined): boolean {
	return agent?.toLowerCase() === PROMETHEUS_AGENT
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

		if (config.hashline_edit === true && !disabled.has("hashline-read-enhancer")) {
			const readEnhancer = await ctx.tool.hook("execute.after", (event) => {
				if (event.status !== "completed" || event.tool.toLowerCase() !== READ_TOOL) return
				event.result = enhanceReadResult(event.result) as typeof event.result
			})
			cleanups.push(() => readEnhancer.dispose())
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
