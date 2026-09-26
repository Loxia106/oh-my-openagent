import type { Plugin } from "@opencode/plugin"
import { Error as ToolError } from "@opencode/plugin/promise/tool"
import { createWriteExistingFileGuardHook } from "../hooks/write-existing-file-guard"
import { isTaskSystemEnabled } from "../shared/task-system-enabled"
import type { OhMyOpenCodeConfig } from "../config"
import { log } from "../shared/logger"

const TASK_READ_REPLACEMENT =
	"TodoRead is disabled while experimental.task_system is enabled. Use task_list to list tasks and task_get to inspect a task. todowrite remains available for the live todo panel."

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? value as Record<string, unknown>
		: undefined
}

function hasPath(args: Record<string, unknown>): boolean {
	return [args.filePath, args.path, args.file_path].some((value) => typeof value === "string" && value.length > 0)
}

function isDisabled(config: OhMyOpenCodeConfig, name: string): boolean {
	return config.disabled_tools?.some((entry) => entry.trim().toLowerCase() === name) ?? false
}

function eventMatchesLocation(locationValue: unknown, ctx: Plugin.Context): boolean {
	const location = asRecord(locationValue)
	if (!location) return true
	if (String(location.directory) !== String(ctx.location.directory)) return false
	const workspaceID = location.workspaceID
	return workspaceID === undefined || workspaceID === ctx.location.workspaceID
}

function retryDelay(signal: AbortSignal): Promise<void> {
	if (signal.aborted) return Promise.resolve()
	return new Promise((resolve) => {
		const finish = () => {
			clearTimeout(timer)
			signal.removeEventListener("abort", finish)
			resolve()
		}
		const timer = setTimeout(finish, 500)
		signal.addEventListener("abort", finish, { once: true })
	})
}

function startSessionDeletionMonitor(
	ctx: Plugin.Context,
	guard: Pick<ReturnType<typeof createWriteExistingFileGuardHook>, "clearSession">,
): () => Promise<void> {
	const controller = new AbortController()
	const task = (async () => {
		while (!controller.signal.aborted) {
			try {
				for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
					if (controller.signal.aborted) return
					if (event.type !== "session.deleted" || !eventMatchesLocation(event.location, ctx)) continue
					guard.clearSession(event.data.sessionID)
				}
			} catch (error) {
				if (!controller.signal.aborted) log("[v2 safety] Session deletion stream stopped; reconnecting.", error)
			}
			if (!controller.signal.aborted) await retryDelay(controller.signal)
		}
	})()
	return async () => {
		controller.abort()
		await task
	}
}

/** Native guards for existing-file overwrites and the legacy TodoRead task-system gate. */
export async function registerV2SafetyHooks(
	ctx: Plugin.Context,
	config: OhMyOpenCodeConfig,
): Promise<() => Promise<void>> {
	const disabledHooks = new Set(config.disabled_hooks ?? [])
	const writeGuardEnabled = !disabledHooks.has("write-existing-file-guard") && !isDisabled(config, "write")
	const taskGateEnabled =
		isTaskSystemEnabled(config) &&
		!disabledHooks.has("tasks-todowrite-disabler") &&
		!isDisabled(config, "todoread")
	if (!writeGuardEnabled && !taskGateEnabled) return async () => undefined

	const directoryContext = { directory: String(ctx.location.directory) }
	const legacyGuard = writeGuardEnabled ? createWriteExistingFileGuardHook(directoryContext) : undefined
	const legacyBefore = legacyGuard?.["tool.execute.before"]
	const cleanups: Array<() => Promise<void>> = []
	let disposed = false
	try {
		if (writeGuardEnabled || taskGateEnabled) {
			const before = await ctx.tool.hook("execute.before", async (event) => {
				if (disposed) return
				const tool = event.tool.trim().toLowerCase()
				if (taskGateEnabled && tool === "todoread") {
					throw new ToolError({ message: TASK_READ_REPLACEMENT })
				}
				if (!writeGuardEnabled || tool !== "write" || !legacyBefore) return
				const args = asRecord(event.input)
				if (!args || !hasPath(args)) return
				const output = { args }
				try {
					await legacyBefore(
						{ tool: event.tool, sessionID: event.sessionID, callID: event.id },
						output,
					)
				} catch (error) {
					if (error instanceof ToolError) throw error
					if (error instanceof Error) throw new ToolError({ message: error.message })
					throw error
				}
				// The legacy bypass field is consumed by the guard and must never reach host write.
				if (output.args !== args) event.input = output.args
			})
			cleanups.push(() => before.dispose())
		}
		if (writeGuardEnabled && legacyBefore) {
			const after = await ctx.tool.hook("execute.after", async (event) => {
				if (disposed || event.status !== "completed" || event.tool.trim().toLowerCase() !== "read") return
				const args = asRecord(event.input)
				if (!args || !hasPath(args)) return
				try {
					await legacyBefore(
						{ tool: event.tool, sessionID: event.sessionID, callID: event.id },
						{ args },
					)
				} catch (error) {
					// Read permission recording is bookkeeping; it must not turn a successful read into a tool failure.
					log("[v2 safety] Could not record a successful read for the overwrite guard.", error)
				}
			})
			cleanups.push(() => after.dispose())
			if (legacyGuard) cleanups.push(startSessionDeletionMonitor(ctx, legacyGuard))
		}
	} catch (error) {
		disposed = true
		const cleanupErrors: unknown[] = []
		for (const cleanup of cleanups.reverse()) {
			try {
				await cleanup()
			} catch (cleanupError) {
				cleanupErrors.push(cleanupError)
			}
		}
		if (cleanupErrors.length > 0) {
			throw new AggregateError([error, ...cleanupErrors], "V2 safety-hook registration failed and cleanup was incomplete")
		}
		throw error
	}

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
		if (errors.length > 0) throw new AggregateError(errors, "One or more V2 safety hooks failed to clean up")
	}
}
