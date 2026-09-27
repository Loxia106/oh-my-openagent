import { createHash } from "node:crypto"
import { realpath } from "node:fs/promises"
import { resolve } from "node:path"
import type { Plugin } from "@opencode/plugin"
import { Error as ToolError } from "@opencode/plugin/promise/tool"
import type { OhMyOpenCodeConfig } from "../config"
import { createToolCallSignature, resolveCircuitBreakerSettings } from "../features/background-agent/loop-detector"
import { log } from "../shared/logger"
import type { V2SubagentRunState } from "./task-state"
import type { VerifiedLogicalParentResolver } from "./background-admission"

const STATE_PREFIX = "oh-my-openagent:v2:background-tool-policy:"
const STATE_VERSION = 1

type PolicyTrigger = {
	type: "max_tool_calls" | "repeated_tool_use"
	tool: string
	count: number
	limit: number
}

type PolicyState = {
	version: typeof STATE_VERSION
	sessionID: string
	locationID: string
	toolCalls: number
	lastSignature?: string
	consecutiveCount: number
	countedCalls: string[]
	lastTrigger?: PolicyTrigger
}

type VerifiedChild = {
	readonly parentSessionID: string
	readonly locationID: string
}

type SessionInfo = Awaited<ReturnType<Plugin.Context["session"]["get"]>>
type BeforeEvent = {
	readonly sessionID: string
	readonly messageID: string
	readonly id: string
	readonly tool: string
	readonly input: unknown
}

export type V2BackgroundToolPolicy = {
	/** Removes the native before hook. It does not alter sessions or interrupt state. */
	cleanup(): Promise<void>
	/** Remove this location's persisted policy counters when a native session is deleted. */
	forget(sessionID: string): Promise<void>
}

const lockMaps = new WeakMap<object, Map<string, Promise<void>>>()

function lockMap(storage: Plugin.Context["storage"]): Map<string, Promise<void>> {
	const identity = storage as object
	let locks = lockMaps.get(identity)
	if (!locks) {
		locks = new Map()
		lockMaps.set(identity, locks)
	}
	return locks
}

async function serialize<T>(storage: Plugin.Context["storage"], key: string, operation: () => Promise<T>): Promise<T> {
	const locks = lockMap(storage)
	const previous = locks.get(key) ?? Promise.resolve()
	let release!: () => void
	const current = new Promise<void>((resolve) => { release = resolve })
	locks.set(key, current)
	await previous
	try {
		return await operation()
	} finally {
		release()
		if (locks.get(key) === current) locks.delete(key)
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

function hash(value: string): string {
	return createHash("sha256").update(value).digest("hex")
}

async function canonicalDirectory(path: string): Promise<string> {
	return resolve(await realpath(path))
}

async function makeLocationID(ctx: Plugin.Context): Promise<string> {
	const [directory, projectCanonical] = await Promise.all([
		canonicalDirectory(String(ctx.location.directory)),
		canonicalDirectory(String(ctx.location.project.canonical)),
	])
	return hash(JSON.stringify({
		projectID: String(ctx.location.project.id),
		projectCanonical,
		directory,
		workspaceID: ctx.location.workspaceID ?? null,
	}))
}

function stateKey(locationID: string, sessionID: string): string {
	return `${STATE_PREFIX}${hash(JSON.stringify([locationID, sessionID]))}`
}

function decodeState(value: unknown, sessionID: string, locationID: string): PolicyState | undefined {
	if (value === undefined) return undefined
	if (!isRecord(value) || value.version !== STATE_VERSION || value.sessionID !== sessionID || value.locationID !== locationID) {
		throw new Error("Stored background tool-policy state is malformed or belongs to another session/location.")
	}
	if (
		!Number.isSafeInteger(value.toolCalls) || (value.toolCalls as number) < 0 ||
		!Number.isSafeInteger(value.consecutiveCount) || (value.consecutiveCount as number) < 0 ||
		!Array.isArray(value.countedCalls) || !value.countedCalls.every((item) => typeof item === "string") ||
		(value.lastSignature !== undefined && typeof value.lastSignature !== "string")
	) throw new Error("Stored background tool-policy counters are invalid.")
	let lastTrigger: PolicyTrigger | undefined
	if (value.lastTrigger !== undefined) {
		if (!isRecord(value.lastTrigger) ||
			!(["max_tool_calls", "repeated_tool_use"] as unknown[]).includes(value.lastTrigger.type) ||
			typeof value.lastTrigger.tool !== "string" ||
			!Number.isSafeInteger(value.lastTrigger.count) ||
			!Number.isSafeInteger(value.lastTrigger.limit)
		) throw new Error("Stored background tool-policy trigger is invalid.")
		lastTrigger = value.lastTrigger as PolicyTrigger
	}
	return {
		version: STATE_VERSION,
		sessionID,
		locationID,
		toolCalls: value.toolCalls as number,
		...(value.lastSignature !== undefined ? { lastSignature: value.lastSignature as string } : {}),
		consecutiveCount: value.consecutiveCount as number,
		countedCalls: [...value.countedCalls as string[]],
		...(lastTrigger ? { lastTrigger } : {}),
	}
}

function callIdentity(event: BeforeEvent): string {
	return JSON.stringify([event.messageID, event.id])
}

function inputSignature(event: BeforeEvent): string | undefined {
	if (!isRecord(event.input)) return undefined
	// Tool inputs are JSON objects. Persist only a digest; raw arguments can contain
	// paths, prompts, or other user data and are unnecessary for equality checks.
	return hash(createToolCallSignature(event.tool, event.input))
}

async function getVerifiedChild(
	ctx: Plugin.Context,
	runs: Pick<V2SubagentRunState, "get">,
	sessionID: string,
	resolveLogicalParent?: VerifiedLogicalParentResolver,
): Promise<VerifiedChild | undefined> {
	let run: Awaited<ReturnType<V2SubagentRunState["get"]>>
	try {
		run = await runs.get(sessionID)
	} catch (error) {
		log("[v2 background tool policy] Failed to read delegated-run ownership; blocking tool execution.", { sessionID, error })
		throw new ToolError({ message: "Unable to verify delegated-session ownership because OMO state storage failed; this tool call was blocked before execution." })
	}
	if (!run) return undefined

	let child: SessionInfo
	let parent: SessionInfo
	try {
		[child, parent] = await Promise.all([
			ctx.session.get({ sessionID }),
			ctx.session.get({ sessionID: run.parentSessionID }),
		])
	} catch (error) {
		log("[v2 background tool policy] Failed to verify delegated session metadata; blocking tool execution.", { sessionID, parentSessionID: run.parentSessionID, error })
		throw new ToolError({ message: "Unable to verify this delegated session's ownership and location; this tool call was blocked before execution." })
	}
	if (child.id !== sessionID || parent.id !== run.parentSessionID) return undefined
	const parentID = child.parentID ?? await resolveLogicalParent?.(sessionID)
	if (parentID !== parent.id) return undefined
	if (child.projectID !== parent.projectID || child.projectID !== ctx.location.project.id) return undefined
	let contextDirectory: string
	let childDirectory: string
	let parentDirectory: string
	let locationID: string
	try {
		[contextDirectory, childDirectory, parentDirectory, locationID] = await Promise.all([
			canonicalDirectory(String(ctx.location.directory)),
			canonicalDirectory(String(child.location.directory)),
			canonicalDirectory(String(parent.location.directory)),
			makeLocationID(ctx),
		])
	} catch (error) {
		log("[v2 background tool policy] Failed to canonicalize a delegated-session directory; blocking tool execution.", { sessionID, parentSessionID: run.parentSessionID, error })
		throw new ToolError({ message: "Unable to verify this delegated session's canonical directory; this tool call was blocked before execution." })
	}
	// Session.Info uses the public LocationRef, which omits workspaceID in the
	// 2.0.18 plugin API. Exact project IDs and real paths are the available checks.
	if (childDirectory !== contextDirectory || parentDirectory !== contextDirectory) return undefined
	return { parentSessionID: run.parentSessionID, locationID }
}

function updateState(
	state: PolicyState | undefined,
	event: BeforeEvent,
	locationID: string,
	maxToolCalls: number,
	consecutiveThreshold: number,
	repeatDetectionEnabled: boolean,
): { state: PolicyState; trigger?: PolicyTrigger } {
	const current: PolicyState = state ?? {
		version: STATE_VERSION,
		sessionID: event.sessionID,
		locationID,
		toolCalls: 0,
		consecutiveCount: 0,
		countedCalls: [],
	}
	const identity = callIdentity(event)
	const duplicate = current.countedCalls.includes(identity)
	const signature = inputSignature(event)
	let next: PolicyState
	if (duplicate) {
		next = current
	} else {
		const consecutiveCount = signature === undefined
			? 1
			: signature === current.lastSignature
				? current.consecutiveCount + 1
				: 1
		next = {
			version: STATE_VERSION,
			sessionID: event.sessionID,
			locationID,
			toolCalls: current.toolCalls + 1,
			...(signature !== undefined ? { lastSignature: signature } : {}),
			consecutiveCount,
			countedCalls: [...current.countedCalls, identity],
		}
	}

	let trigger: PolicyTrigger | undefined
	if (next.toolCalls >= maxToolCalls) {
		trigger = { type: "max_tool_calls", tool: event.tool, count: next.toolCalls, limit: maxToolCalls }
	} else if (
		repeatDetectionEnabled &&
		next.consecutiveCount >= consecutiveThreshold &&
		signature !== undefined &&
		signature === next.lastSignature
	) {
		trigger = { type: "repeated_tool_use", tool: event.tool, count: next.consecutiveCount, limit: consecutiveThreshold }
	}
	next = trigger ? { ...next, lastTrigger: trigger } : withoutLastTrigger(next)
	return { state: next, ...(trigger ? { trigger } : {}) }
}

function withoutLastTrigger(state: PolicyState): PolicyState {
	const { lastTrigger: _lastTrigger, ...next } = state
	return next
}

function serializeState(state: PolicyState): Parameters<Plugin.Context["storage"]["set"]>[1] {
	return state as unknown as Parameters<Plugin.Context["storage"]["set"]>[1]
}

function triggerMessage(trigger: PolicyTrigger): string {
	if (trigger.type === "max_tool_calls") {
		return `The background subagent reached its tool-call limit (${trigger.count}/${trigger.limit}). This call was blocked before execution and an interrupt was requested. Inspect the subagent progress or raise background_task.maxToolCalls / background_task.circuitBreaker.maxToolCalls if more calls are expected.`
	}
	return `The background subagent repeated ${trigger.tool} with identical input ${trigger.count} times (threshold ${trigger.limit}). This call was blocked before execution and an interrupt was requested. Inspect the subagent progress or adjust background_task.circuitBreaker.consecutiveThreshold if this repetition is expected.`
}

/**
 * Enforce the shared legacy background-task limits before native child tools run.
 * V1 observes running tool parts after the call starts; native execute.before
 * must stop the threshold call before side effects, so the effective last allowed
 * call is one below a reached threshold.
 */
export async function registerV2BackgroundToolPolicy(
	ctx: Plugin.Context,
	config: OhMyOpenCodeConfig,
	runs: Pick<V2SubagentRunState, "get">,
	resolveLogicalParent?: VerifiedLogicalParentResolver,
): Promise<V2BackgroundToolPolicy> {
	let disposed = false
	const before = async (event: BeforeEvent) => {
		if (disposed) return
		const owned = await getVerifiedChild(ctx, runs, event.sessionID, resolveLogicalParent)
		if (!owned || disposed) return
		const key = stateKey(owned.locationID, event.sessionID)
		const result = await serialize(ctx.storage, key, async () => {
			if (disposed) return undefined
			let current: PolicyState | undefined
			try {
				current = decodeState(await ctx.storage.get(key), event.sessionID, owned.locationID)
			} catch (error) {
				log("[v2 background tool policy] Failed to load persistent counters; blocking tool execution.", { sessionID: event.sessionID, error })
				throw new ToolError({ message: "Unable to load persistent background tool-loop counters; this tool call was blocked before execution." })
			}
			if (disposed) return undefined
			const settings = resolveCircuitBreakerSettings(config.background_task)
			const updated = updateState(current, event, owned.locationID, settings.maxToolCalls, settings.consecutiveThreshold, settings.enabled)
			try {
				await ctx.storage.set(key, serializeState(updated.state))
			} catch (error) {
				log("[v2 background tool policy] Failed to persist counters; blocking tool execution.", { sessionID: event.sessionID, error })
				throw new ToolError({ message: "Unable to persist background tool-loop counters; this tool call was blocked before execution." })
			}
			if (disposed) return undefined
			return updated
		})

		if (!result || disposed || !result.trigger) return
		const message = triggerMessage(result.trigger)
		log("[v2 background tool policy] Circuit breaker reached; interrupting delegated session.", {
			sessionID: event.sessionID,
			parentSessionID: owned.parentSessionID,
			tool: result.trigger.tool,
			type: result.trigger.type,
			count: result.trigger.count,
			limit: result.trigger.limit,
		})
		try {
			// The public host API acknowledges interruption without waiting for the
			// current execution to settle. Never wait for this session from its own hook.
			await ctx.session.interrupt({ sessionID: event.sessionID })
		} catch (error) {
			log("[v2 background tool policy] Session interrupt request failed after persisting the trigger.", { sessionID: event.sessionID, error })
			throw new ToolError({ message: `${message} The host could not acknowledge the interrupt request; no tool side effect was allowed.` })
		}
		throw new ToolError({ message })
	}

	let registration: Awaited<ReturnType<Plugin.Context["tool"]["hook"]>>
	try {
		registration = await ctx.tool.hook("execute.before", before)
	} catch (error) {
		// If the host registered before reporting an error, this guard makes any
		// retained callback inert even though no disposer was returned to us.
		disposed = true
		throw error
	}

	let cleaned = false
	return {
		async cleanup() {
			if (cleaned) return
			cleaned = true
			disposed = true
			await registration.dispose()
		},
		async forget(sessionID) {
			const locationID = await makeLocationID(ctx)
			const key = stateKey(locationID, sessionID)
			await serialize(ctx.storage, key, () => ctx.storage.remove(key))
		},
	}
}
