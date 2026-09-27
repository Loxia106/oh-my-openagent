import { realpath, stat } from "node:fs/promises"
import { extname, isAbsolute, relative, resolve, sep } from "node:path"
import type { Plugin } from "@opencode/plugin"
import type { PluginInput } from "@opencode-ai/plugin"
import type { OhMyOpenCodeConfig } from "../config"
import { createPlanFormatValidatorHook } from "../hooks/plan-format-validator/hook"

type NativeResult = {
	readonly content?: string | readonly unknown[]
	readonly metadata?: Record<string, unknown>
	readonly output?: unknown
}

type NativeToolEvent = {
	readonly tool: string
	readonly sessionID: string
	readonly id: string
	readonly input: unknown
	readonly status: "completed" | "error"
	result?: NativeResult
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

function within(path: string, parent: string): boolean {
	const rel = relative(parent, path)
	return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

function inputPath(input: unknown): string | undefined {
	if (!isRecord(input)) return undefined
	for (const key of ["filePath", "path", "file"]) {
		const value = input[key]
		if (typeof value === "string" && value.trim()) return value
	}
	return undefined
}

function contentText(content: NativeResult["content"]): string {
	if (typeof content === "string") return content
	if (!Array.isArray(content)) return ""
	return content.flatMap((part) => {
		if (!isRecord(part) || part.type !== "text" || typeof part.text !== "string") return []
		return [part.text]
	}).join("\n")
}

function appendWarning(content: NativeResult["content"], warning: string): NativeResult["content"] {
	const addition = warning.trim()
	if (typeof content === "string") return `${content}${content.trim() ? "\n\n" : ""}${addition}`
	return [...(content ?? []), { type: "text", text: addition }]
}

async function canonicalPlanTarget(workspaceInput: string, workspace: string, candidate: string): Promise<string | undefined> {
	const lexicalPlanRoot = resolve(workspaceInput, ".omo", "plans")
	const canonicalPlanRoot = resolve(workspace, ".omo", "plans")
	const lexicalTarget = resolve(workspaceInput, candidate)
	const withinRequestedRoot = within(lexicalTarget, lexicalPlanRoot) || within(lexicalTarget, canonicalPlanRoot)
	if (!withinRequestedRoot || extname(lexicalTarget).toLowerCase() !== ".md") return undefined

	try {
		const [realWorkspace, realPlanRoot, realTarget, targetInfo] = await Promise.all([
			realpath(workspace),
			realpath(lexicalPlanRoot),
			realpath(lexicalTarget),
			stat(lexicalTarget),
		])
		if (!targetInfo.isFile() || extname(realTarget).toLowerCase() !== ".md") return undefined
		// Keep the legacy `.omo/plans/` matcher aligned with the canonical path; a symlinked plan root is unsupported.
		if (realPlanRoot !== canonicalPlanRoot || !within(realPlanRoot, realWorkspace) || !within(realTarget, realPlanRoot)) return undefined
		return realTarget
	} catch {
		return undefined
	}
}

/** Run the existing plan normalizer only for completed native writes inside the workspace plan tree. */
export async function registerV2PlanFormatValidator(
	ctx: Plugin.Context,
	config: OhMyOpenCodeConfig,
): Promise<() => Promise<void>> {
	if (config.disabled_hooks?.includes("plan-format-validator")) return async () => undefined

	const workspaceInput = resolve(String(ctx.location.directory))
	const workspace = await realpath(workspaceInput)
	const legacyHook = createPlanFormatValidatorHook({ directory: workspace } as Pick<PluginInput, "directory">)["tool.execute.after"]
	let disposed = false
	const registration = await ctx.tool.hook("execute.after", async (rawEvent) => {
		const event = rawEvent as NativeToolEvent
		if (disposed || event.status !== "completed" || !event.result) return
		const tool = event.tool.trim().toLowerCase()
		if (tool !== "write" && tool !== "edit") return
		const requestedPath = inputPath(event.input)
		if (!requestedPath) return
		const canonicalPath = await canonicalPlanTarget(workspaceInput, workspace, requestedPath)
		if (!canonicalPath || disposed || !event.result) return
		if (contentText(event.result.content).includes("<plan-format-warning>")) return

		const warningOutput = { title: canonicalPath, output: "", metadata: {} }
		await legacyHook(
			{
				tool,
				sessionID: event.sessionID,
				callID: event.id,
				args: { filePath: canonicalPath },
			},
			warningOutput,
		)
		if (disposed || !warningOutput.output || !event.result) return
		const result = event.result
		event.result = {
			...result,
			content: appendWarning(result.content, warningOutput.output),
		}
	})

	return async () => {
		if (disposed) return
		disposed = true
		await registration.dispose()
	}
}
