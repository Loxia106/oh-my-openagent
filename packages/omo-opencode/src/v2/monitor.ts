import type { Plugin } from "@opencode/plugin"
import type { SessionContext } from "@opencode/plugin/promise/session"
import type { ToolEditor } from "@opencode/plugin/promise/tool"
import { z } from "zod"
import type { OhMyOpenCodeConfig } from "../config"
import { formatMonitorBatch } from "../features/monitor/envelope"
import { createMonitorFilter } from "../features/monitor/filter"
import { MonitorManager } from "../features/monitor/manager"
import type { MonitorInjector } from "../features/monitor/manager-internals"
import type { MonitorCounters, MonitorMode, MonitorRecord, MonitorStatus, OutputBatch } from "../features/monitor/types"
import { tokenizeCommand } from "../tools/interactive-bash/tools"
import { log } from "../shared/logger"
import type { VerifiedLogicalParentResolver } from "./background-admission"
import { evaluatePermissionEffect } from "./permission-rules"
import { getV2SubagentRunState } from "./task-state"
import { addV2Tool } from "./tool-adapter"

const MONITOR_STATUS_PREFIX = "Active monitors:"
const HIDDEN_STATUSES = new Set<MonitorStatus>(["exited", "stopped", "failed"])
const EMPTY_COUNTERS: MonitorCounters = { totalLines: 0, matchedLines: 0, unmatchedLines: 0, droppedMatched: 0, droppedUnmatched: 0, bytesDropped: 0, lastSequence: 0 }

const startInput = z.object({
	command: z.string().describe("Shell command to run in the background monitor"),
	label: z.string().optional().describe("Safe human-facing label for the monitor"),
	mode: z.enum(["idle", "live_safe"]).optional().describe("Delivery mode. idle is safe default; live_safe requires monitor.live_mode_enabled."),
	match_pattern: z.string().optional().describe("Optional JavaScript regex. Matching lines are delivered automatically."),
})
const stopInput = z.object({ monitor_id: z.string().describe("Monitor ID to stop") })
const listInput = z.object({ include_exited: z.boolean().optional().describe("Include exited, stopped, and failed monitors") })
const outputInput = z.object({
	monitor_id: z.string().describe("Monitor ID to read output from"),
	stream: z.enum(["matched", "unmatched", "all"]).optional(),
	since_sequence: z.number().optional(),
	limit: z.number().optional(),
})

export type V2MonitorRuntime = {
	readonly manager: MonitorManager
	addTools(editor: ToolEditor): void
	cleanup(): Promise<void>
}

function isDisabled(config: OhMyOpenCodeConfig, tool: string): boolean {
	return config.disabled_tools?.some((entry) => entry.trim().toLowerCase() === tool) ?? false
}

export function buildV2MonitorStatus(records: readonly MonitorRecord[]): string | undefined {
	const active = records.filter((record) => record.status === "running" || record.status === "starting")
	if (active.length === 0) return undefined
	return `${MONITOR_STATUS_PREFIX} ${active.map((record) => `${record.id} (${record.label}, ${record.status}, ${record.counters.matchedLines} matched)`).join(", ")} - call monitor_stop to stop`
}

/**
 * Legacy `monitor_*` tools on the shared MonitorManager (process, filter, ring buffer, batcher). Output is
 * delivered to the owning primary session with native synthetic messages: `idle` batches wait until the
 * session is idle (queued, then resumed) and `live_safe` batches steer the running turn. The public v2 API
 * has no permission prompt for plugin tools, so the command is evaluated against the session's `shell`
 * rules: deny rejects, allow permits, and ask falls back to `monitor.allowed_commands`.
 */
export async function registerV2MonitorRuntime(
	ctx: Plugin.Context,
	config: OhMyOpenCodeConfig,
	options: { resolveLogicalParent?: VerifiedLogicalParentResolver } = {},
): Promise<V2MonitorRuntime | undefined> {
	const monitorConfig = config.monitor
	if (!monitorConfig?.enabled) return undefined
	const running = new Set<string>()
	const pending = new Map<string, { record: MonitorRecord; batches: OutputBatch[] }>()
	let active = true

	const deliver = async (monitorID: string, delivery: "queue" | "steer") => {
		const entry = pending.get(monitorID)
		if (!entry || entry.batches.length === 0 || !active) return
		pending.delete(monitorID)
		const text = entry.batches.map((batch) => formatMonitorBatch(entry.record, batch, entry.record.counters)).join("\n\n")
		await ctx.session.synthetic({
			sessionID: entry.record.parentSessionId as Parameters<Plugin.Context["session"]["synthetic"]>[0]["sessionID"],
			text,
			description: `OMO monitor output (${entry.record.label})`,
			metadata: { omoMonitor: { version: 1, monitorID, batches: entry.batches.map((batch) => batch.batchSeq) } },
			delivery,
			resume: true,
		})
	}

	const manager = new MonitorManager({
		pluginContext: { client: {} as never, directory: String(ctx.location.directory) },
		config: monitorConfig,
		deps: {
			isBackgroundSession: () => false,
			createInjector: (): MonitorInjector => ({
				queueBatch(record, batch) {
					const entry = pending.get(record.id) ?? { record, batches: [] }
					entry.record = record
					entry.batches.push(batch)
					pending.set(record.id, entry)
					const live = record.mode === "live_safe"
					if (live || !running.has(record.parentSessionId)) {
						void deliver(record.id, live ? "steer" : "queue").catch((error) => log("[v2 monitor] Output delivery failed.", { monitorID: record.id, error }))
					}
				},
				flushMonitor: (monitorID) => deliver(monitorID, "queue"),
			}),
		},
	})

	const statusHook = config.disabled_hooks?.includes("monitor-status-injector")
		? undefined
		: await ctx.session.hook("context", (input: SessionContext) => {
			const status = buildV2MonitorStatus(manager.list(String(input.sessionID)))
			if (status) input.system.push({ type: "text", text: status })
		})

	const controller = new AbortController()
	const events = (async () => {
		while (!controller.signal.aborted) {
			try {
				for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
					const data: Record<string, unknown> | undefined = typeof event.data === "object" && event.data !== null ? event.data as Record<string, unknown> : undefined
					const sessionID = typeof data?.sessionID === "string" ? data.sessionID : undefined
					if (!sessionID) continue
					if (event.type === "session.execution.started") running.add(sessionID)
					else if (event.type === "session.execution.succeeded" || event.type === "session.execution.failed" || event.type === "session.execution.interrupted") {
						running.delete(sessionID)
						manager.handleEvent({ type: "session.idle", sessionId: sessionID })
					} else if (event.type === "session.deleted") {
						running.delete(sessionID)
						manager.handleEvent({ type: "session.deleted", sessionId: sessionID })
					}
				}
			} catch (error) {
				if (!controller.signal.aborted) log("[v2 monitor] Event stream stopped; reconnecting.", error)
			}
			if (!controller.signal.aborted) await new Promise((resolve) => setTimeout(resolve, 500))
		}
	})()

	const isPrimary = async (sessionID: string): Promise<boolean> => {
		try {
			const session = await ctx.session.get({ sessionID })
			if (session.parentID || await getV2SubagentRunState(ctx.storage).get(sessionID)) return false
			if (options.resolveLogicalParent && await options.resolveLogicalParent(sessionID)) return false
			return true
		} catch {
			return false
		}
	}

	const permit = async (sessionID: string, agent: string, command: string): Promise<{ allowed: boolean; reason: string }> => {
		const effect = await evaluatePermissionEffect(ctx, sessionID, agent, "shell", [command]).catch(() => "ask" as const)
		if (effect === "deny") return { allowed: false, reason: "denied by the shell permission policy" }
		if (effect === "allow") return { allowed: true, reason: "allowed by the shell permission policy" }
		const program = tokenizeCommand(command)[0]
		if (program && (monitorConfig.allowed_commands ?? []).includes(program)) return { allowed: true, reason: "command allowed by allowed_commands" }
		return { allowed: false, reason: "the shell permission requires approval and the command is not in monitor.allowed_commands" }
	}

	return {
		manager,
		addTools(editor) {
			if (!isDisabled(config, "monitor_start")) addV2Tool(editor, {
				name: "monitor_start",
				description: "Start a non-interactive background monitor command. Output is delivered automatically to the parent session; use labels instead of raw commands in transcripts.",
				input: startInput,
				options: { codemode: false },
				execute: async (args, context) => {
					if (!(await isPrimary(String(context.sessionID)))) return { content: "[ERROR] monitor_start is only available from a primary session" }
					const permission = await permit(String(context.sessionID), String(context.agent), args.command)
					if (!permission.allowed) return { content: `[ERROR] monitor_start denied: ${permission.reason}` }
					const filter = createMonitorFilter(args.match_pattern, { patternMaxLength: monitorConfig.pattern_max_length })
					if (!filter.filter) return { content: `[ERROR] monitor_start match_pattern rejected: ${filter.error ?? "invalid pattern"}` }
					const coerced = args.mode === "live_safe" && !monitorConfig.live_mode_enabled
					const mode: MonitorMode = coerced ? "idle" : args.mode ?? "idle"
					try {
						const record = await manager.start({ command: args.command, label: args.label, mode, matchPattern: args.match_pattern, parentSessionId: String(context.sessionID), parentMessageId: String(context.messageID) })
						const note = coerced ? '\nnote: requested mode "live_safe" was coerced to "idle" because monitor.live_mode_enabled is false' : ""
						return { content: `Monitor started successfully.\n\nmonitor_id: ${record.id}\nlabel: ${record.label}\nmode: ${mode}\ncaps: max_monitors_per_session=${monitorConfig.max_monitors_per_session}, max_runtime_ms=${monitorConfig.max_runtime_ms}${note}\n\nTo stop this monitor, call monitor_stop with monitor_id="${record.id}".\n\noutput arrives automatically — do not poll` }
					} catch (error) {
						return { content: `[ERROR] monitor_start failed for label: ${args.label ?? "(manager-assigned label)"}: ${error instanceof Error ? error.message : String(error)}` }
					}
				},
			})
			if (!isDisabled(config, "monitor_stop")) addV2Tool(editor, {
				name: "monitor_stop",
				description: "Stop a running monitor owned by the current session.",
				input: stopInput,
				options: { codemode: false },
				execute: async (args, context) => {
					const record = manager.get(args.monitor_id)
					if (!record || record.status === "stopped") return { content: JSON.stringify({ status: "already-stopped", monitor_id: args.monitor_id }) }
					if (record.parentSessionId !== String(context.sessionID)) return { content: JSON.stringify({ status: "denied", monitor_id: args.monitor_id }) }
					await manager.stop(args.monitor_id)
					return { content: JSON.stringify({ status: "stopped", monitor_id: args.monitor_id }) }
				},
			})
			if (!isDisabled(config, "monitor_list")) addV2Tool(editor, {
				name: "monitor_list",
				description: "List monitors owned by the current session. Raw commands are never included.",
				input: listInput,
				options: { codemode: false },
				execute: async (args, context) => {
					const records = manager.list(String(context.sessionID)).filter((record) => args.include_exited || !HIDDEN_STATUSES.has(record.status))
					return { content: JSON.stringify(records.map((record) => ({
						id: record.id, label: record.label, mode: record.mode, startedAt: record.startedAt.toISOString(), status: record.status,
						counters: {
							matched: record.counters.matchedLines, unmatched: record.counters.unmatchedLines, droppedMatched: record.counters.droppedMatched,
							droppedUnmatched: record.counters.droppedUnmatched, bytesDropped: record.counters.bytesDropped, lastSequence: record.counters.lastSequence,
						},
					})), null, 2) }
				},
			})
			if (!isDisabled(config, "monitor_output")) addV2Tool(editor, {
				name: "monitor_output",
				description: "Retrieve retained monitor output and counters for the calling session. Unknown or unauthorized monitor IDs return not_found.",
				input: outputInput,
				options: { codemode: false },
				execute: async (args, context) => {
					const record = manager.get(args.monitor_id)
					if (!record || record.parentSessionId !== String(context.sessionID)) return { content: JSON.stringify({ lines: [], counters: EMPTY_COUNTERS, error: "not_found" }) }
					return { content: JSON.stringify(manager.getOutput(args.monitor_id, {
						stream: args.stream ?? "all",
						...(args.since_sequence === undefined ? {} : { since_sequence: args.since_sequence }),
						...(args.limit === undefined ? {} : { limit: args.limit }),
					})) }
				},
			})
		},
		async cleanup() {
			active = false
			controller.abort()
			await events
			await statusHook?.dispose()
			await manager.shutdown()
		},
	}
}
