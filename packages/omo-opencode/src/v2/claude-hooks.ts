import { createHash } from "node:crypto"
import { realpath } from "node:fs/promises"
import { resolve } from "node:path"
import type { Plugin } from "@opencode/plugin"
import type { OpenCodeEvent } from "@opencode/client/promise"
import type { SessionPrompt } from "@opencode/plugin/promise/session"
import type { SessionCompaction } from "@opencode/plugin/promise/session"
import { Error as NativeToolError, type Result as NativeToolResult } from "@opencode/plugin/promise/tool"
import type {
	ClaudeHooksConfig,
	PluginHooksConfig,
} from "../hooks/claude-code-hooks/types"
import {
	discoverInstalledPlugins,
	loadPluginHooksConfigs,
	type PluginLoaderOptions,
} from "@oh-my-opencode/claude-code-compat-core/claude-code-plugin-loader"
import type { OhMyOpenCodeConfig } from "../config"
import { executeStopHooks } from "../hooks/claude-code-hooks/stop"
import { executeUserPromptSubmitHooks, type MessagePart } from "../hooks/claude-code-hooks/user-prompt-submit"
import { executePreToolUseHooks } from "../hooks/claude-code-hooks/pre-tool-use"
import { executePostToolUseHooks } from "../hooks/claude-code-hooks/post-tool-use"
import { executePreCompactHooks } from "../hooks/claude-code-hooks/pre-compact"
import { loadClaudeHooksConfig } from "../hooks/claude-code-hooks/config"
import { loadPluginExtendedConfig } from "../hooks/claude-code-hooks/config-loader"
import { isRealUserTextPart } from "../shared/internal-initiator-marker"
import { findMatchingHooks, transformToolName } from "../shared"
import { log } from "../shared/logger"
import type { VerifiedLogicalParentResolver } from "./background-admission"
import {
	applyClaudeToolInput,
	claudeToolName,
	createClaudeTranscriptFile,
	toClaudeToolInput,
	withClaudeToolExchange,
	type ClaudeToolTranscriptExchange,
} from "./claude-transcript"

const STOP_STATE_PREFIX = "oh-my-openagent:v2:claude-hooks:stop:v1:"
const MAX_STOP_CONTINUATIONS = 3
const MAX_SESSION_CACHE_ENTRIES = 512
const CLAUDE_BLOCK_NOTICE = "omoClaudeHookBlock"
const PERMISSION_ASK_LIMIT = 512
const PERMISSION_ASK_SUPPORTED_TOOLS = new Set(["edit", "patch", "shell", "subagent", "webfetch", "write"])

type StopDecision =
	| { readonly kind: "allow" }
	| { readonly kind: "cancel" }
	| { readonly kind: "continue"; readonly id: string; readonly text: string }
	| { readonly kind: "pause"; readonly text: string }

export type V2ClaudeBeforeContinuation = (input: {
	readonly sessionID: string
	readonly idleAt: number
	readonly signal: AbortSignal
	readonly isCurrent: () => boolean
}) => Promise<StopDecision>

export interface V2ClaudeHooksOptions {
	readonly resolveLogicalParent?: VerifiedLogicalParentResolver
}

export interface V2ClaudeHookRegistration {
	readonly cleanup: () => Promise<void>
	readonly beforeContinuation: V2ClaudeBeforeContinuation
}

type StopLedger = {
	readonly version: 1
	readonly scope: string
	readonly sessionID: string
	readonly userEpoch: number
	readonly lastUserMessageID?: string
	readonly stopHookActive: boolean
	readonly continuationCount: number
	readonly lastDecision?: {
		readonly idleAt: number
		readonly userEpoch: number
		readonly decision: StopDecision
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

function stableMessageID(scope: string, sessionID: string, key: string): string {
	return `msg_${createHash("sha256").update(`${scope}\0${sessionID}\0${key}`).digest("hex")}`
}

function freshStopLedger(scope: string, sessionID: string): StopLedger {
	return { version: 1, scope, sessionID, userEpoch: 0, stopHookActive: false, continuationCount: 0 }
}

function isStopDecision(value: unknown): value is StopDecision {
	if (!isRecord(value)) return false
	if (value.kind === "allow" || value.kind === "cancel") return true
	if (value.kind === "pause") return typeof value.text === "string"
	return value.kind === "continue" && typeof value.id === "string" && value.id.startsWith("msg_") && typeof value.text === "string"
}

function decodeStopLedger(value: unknown, scope: string, sessionID: string): StopLedger {
	if (value === undefined) return freshStopLedger(scope, sessionID)
	if (!isRecord(value) || value.version !== 1 || value.scope !== scope || value.sessionID !== sessionID ||
		typeof value.userEpoch !== "number" || !Number.isSafeInteger(value.userEpoch) || value.userEpoch < 0 ||
		typeof value.stopHookActive !== "boolean" || typeof value.continuationCount !== "number" ||
		!Number.isSafeInteger(value.continuationCount) || value.continuationCount < 0 || value.continuationCount > MAX_STOP_CONTINUATIONS) {
		throw new Error(`Cannot verify persisted Claude Stop-hook state for session ${sessionID}; refusing continuation.`)
	}
	let lastDecision: StopLedger["lastDecision"]
	if (value.lastDecision !== undefined) {
		const last = value.lastDecision
		if (!isRecord(last) || typeof last.idleAt !== "number" || !Number.isFinite(last.idleAt) ||
			typeof last.userEpoch !== "number" || !Number.isSafeInteger(last.userEpoch) || !isStopDecision(last.decision)) {
			throw new Error(`Persisted Claude Stop-hook decision is malformed for session ${sessionID}; refusing continuation.`)
		}
		lastDecision = { idleAt: last.idleAt, userEpoch: last.userEpoch, decision: last.decision }
	}
	return {
		version: 1,
		scope,
		sessionID,
		userEpoch: value.userEpoch,
		...(typeof value.lastUserMessageID === "string" ? { lastUserMessageID: value.lastUserMessageID } : {}),
		stopHookActive: value.stopHookActive,
		continuationCount: value.continuationCount,
		...(lastDecision ? { lastDecision } : {}),
	}
}

function isLocationMatch(event: OpenCodeEvent, ctx: Plugin.Context): boolean {
	if (!event.location) return true
	return String(event.location.directory) === String(ctx.location.directory) &&
		(!("workspaceID" in event.location) || event.location.workspaceID === undefined ||
			event.location.workspaceID === ctx.location.workspaceID)
}

function waitForRetry(signal: AbortSignal): Promise<void> {
	if (signal.aborted) return Promise.resolve()
	return new Promise((resolvePromise) => {
		const finish = () => {
			clearTimeout(timer)
			signal.removeEventListener("abort", finish)
			resolvePromise()
		}
		const timer = setTimeout(finish, 500)
		signal.addEventListener("abort", finish, { once: true })
	})
}

function setBounded<K, V>(map: Map<K, V>, key: K, value: V): void {
	map.delete(key)
	map.set(key, value)
	while (map.size > MAX_SESSION_CACHE_ENTRIES) {
		const oldest = map.keys().next().value
		if (oldest === undefined) break
		map.delete(oldest)
	}
}

function setBoundedSet<T>(set: Set<T>, value: T): void {
	set.delete(value)
	set.add(value)
	while (set.size > MAX_SESSION_CACHE_ENTRIES) {
		const oldest = set.values().next().value
		if (oldest === undefined) break
		set.delete(oldest)
	}
}

function permissionSourceKey(sessionID: string, messageID: string, id: string): string {
	return `${sessionID}\0${messageID}\0${id}`
}

function appendHookText(content: NativeToolResult["content"], additions: readonly string[]): NativeToolResult["content"] {
	const text = additions.map((item) => item.trim()).filter(Boolean).join("\n\n")
	if (!text) return content
	const existing = typeof content === "string"
		? (content ? [{ type: "text" as const, text: content }] : [])
		: [...(content ?? [])]
	return [...existing, { type: "text", text }]
}

function postHookMessages(result: Awaited<ReturnType<typeof executePostToolUseHooks>>): string[] {
	return [
		result.message,
		result.additionalContext,
		result.block ? result.reason ?? "Claude PostToolUse hook blocked after the native tool had already run." : undefined,
		result.continue === false ? result.stopReason ?? "Claude PostToolUse hook requested that the agent stop." : undefined,
		result.systemMessage,
		...(result.warnings ?? []),
	].filter((value): value is string => typeof value === "string" && value.trim().length > 0)
}

function canonicalToolResult(result: NativeToolResult | undefined): Record<string, unknown> {
	if (!result) return {}
	return {
		...(result.output === undefined ? {} : { output: result.output }),
		...(result.content === undefined ? {} : { content: result.content }),
		...(result.metadata === undefined ? {} : { metadata: result.metadata }),
	}
}

function toolTranscriptExchange(input: {
	toolName: string
	toolUseID: string
	toolInput: unknown
	status: "running" | "completed" | "error"
	result?: NativeToolResult
	error?: unknown
}): ClaudeToolTranscriptExchange {
	const error = input.error instanceof Error ? input.error : undefined
	return {
		toolName: input.toolName,
		toolUseID: input.toolUseID,
		input: input.toolInput,
		status: input.status,
		...(input.result ? { result: { content: input.result.content, output: input.result.output } } : {}),
		...(error ? { error: { type: error.name, message: error.message } } : {}),
	}
}

function appendHookMessages(prompt: string, messages: readonly string[]): string {
	const additions = messages.filter((message) => message.trim().length > 0 && !prompt.includes(message))
	return additions.length === 0 ? prompt : `${additions.join("\n\n")}\n\n${prompt}`
}

async function isRootConversationSession(
	ctx: Plugin.Context,
	sessionID: string,
	resolveLogicalParent?: VerifiedLogicalParentResolver,
	deletedSessions?: ReadonlySet<string>,
): Promise<boolean> {
	const session = await verifyHookSession(ctx, sessionID, deletedSessions)
	if (session.parentID) return false
	if (resolveLogicalParent && await resolveLogicalParent(sessionID)) return false
	return true
}

async function verifyHookSession(
		ctx: Plugin.Context,
		sessionID: string,
		deletedSessions?: ReadonlySet<string>,
	): Promise<Awaited<ReturnType<Plugin.Context["session"]["get"]>>> {
	if (deletedSessions?.has(sessionID)) {
		throw new Error(`Claude hook session ${sessionID} was deleted while the hook was running.`)
	}
	const session = await ctx.session.get({ sessionID })
	if (session.id !== sessionID || session.location?.directory !== ctx.location.directory ||
		session.projectID !== ctx.location.project.id) {
		throw new Error(`Cannot verify Claude hook session ${sessionID} belongs to this project and directory.`)
	}
	if (deletedSessions?.has(sessionID)) {
		throw new Error(`Claude hook session ${sessionID} was deleted while the hook was running.`)
	}
	return session
}

async function createSessionTranscript(ctx: Plugin.Context, sessionID: string, exchange?: ClaudeToolTranscriptExchange, deletedSessions?: ReadonlySet<string>) {
	await verifyHookSession(ctx, sessionID, deletedSessions)
	const context = await ctx.session.context({ sessionID })
	await verifyHookSession(ctx, sessionID, deletedSessions)
	const messages = exchange ? withClaudeToolExchange(context, exchange) : context
	return createClaudeTranscriptFile(messages)
}

/** Register Claude conversation hooks on native V2 session APIs. */
export async function registerV2ClaudeHooks(
	ctx: Plugin.Context,
	config: OhMyOpenCodeConfig,
	options: V2ClaudeHooksOptions = {},
): Promise<V2ClaudeHookRegistration> {
	const enabled = config.claude_code?.hooks !== false && !config.disabled_hooks?.includes("claude-code-hooks")
	const directory = String(ctx.location.directory)
	const canonicalDirectory = await realpath(directory).catch(() => resolve(directory))
	const scope = createHash("sha256").update([
		String(ctx.location.project.id),
		String(ctx.location.workspaceID ?? ""),
		canonicalDirectory,
	].join("\0")).digest("hex")
	const stopKey = (sessionID: string) => `${STOP_STATE_PREFIX}${scope}:${encodeURIComponent(sessionID)}`
	const queues = new Map<string, Promise<void>>()
	const running = new Set<Promise<unknown>>()
	const promptGenerations = new Map<string, number>()
	const permissionAsks = new Map<string, string>()
	const deletedSessions = new Set<string>()
	const registrations: Array<{ dispose(): Promise<void> }> = []
	const eventController = new AbortController()
	let active = true
	let eventTask: Promise<void> | undefined
	let hooks: ClaudeHooksConfig | null = null
	let extendedConfig: Awaited<ReturnType<typeof loadPluginExtendedConfig>> = { disabledHooks: {} }

	const track = <T>(operation: () => Promise<T>): Promise<T> => {
		const promise = Promise.resolve().then(operation)
		running.add(promise)
		void promise.then(() => running.delete(promise), () => running.delete(promise))
		return promise
	}
	const enqueue = async <T>(sessionID: string, operation: () => Promise<T>): Promise<T> => {
		const previous = queues.get(sessionID) ?? Promise.resolve()
		let release!: () => void
		const gate = new Promise<void>((resolveGate) => { release = resolveGate })
		const tail = previous.catch(() => undefined).then(() => gate)
		queues.set(sessionID, tail)
		await previous.catch(() => undefined)
		try { return await operation() } finally {
			release()
			if (queues.get(sessionID) === tail) queues.delete(sessionID)
		}
	}
	const readStopLedger = async (sessionID: string): Promise<StopLedger> =>
		decodeStopLedger(await ctx.storage.get(stopKey(sessionID)), scope, sessionID)
	const writeStopLedger = async (ledger: StopLedger): Promise<void> => {
		await ctx.storage.set(stopKey(ledger.sessionID), ledger)
	}

	const evaluateBeforeContinuation = async (input: Parameters<V2ClaudeBeforeContinuation>[0]): Promise<StopDecision> => {
		if (!enabled) return { kind: "allow" }
		if (!active || input.signal.aborted || !input.isCurrent()) return { kind: "cancel" }
		try {
			if (!await isRootConversationSession(ctx, input.sessionID, options.resolveLogicalParent, deletedSessions)) return { kind: "cancel" }
		} catch (error) {
			log("[v2 Claude hooks] Could not verify Stop-hook session ownership; canceling continuation.", { sessionID: input.sessionID, error })
			return { kind: "cancel" }
		}
		const initial = await enqueue(input.sessionID, () => readStopLedger(input.sessionID))
		const generation = promptGenerations.get(input.sessionID) ?? 0
		if (initial.lastDecision?.idleAt === input.idleAt && initial.lastDecision.userEpoch === initial.userEpoch) {
			return initial.lastDecision.decision
		}
		if (!hooks?.Stop?.length) return { kind: "allow" }
		if (!active || input.signal.aborted || !input.isCurrent() || (promptGenerations.get(input.sessionID) ?? 0) !== generation) {
			return { kind: "cancel" }
		}

			let reportedActive = initial.stopHookActive
			const transcript = await createSessionTranscript(ctx, input.sessionID, undefined, deletedSessions)
			let result: Awaited<ReturnType<typeof executeStopHooks>>
			try {
				if (!active || input.signal.aborted || !input.isCurrent()) return { kind: "cancel" }
				result = await executeStopHooks({
					sessionId: input.sessionID,
					cwd: directory,
					transcriptPath: transcript.path,
					permissionMode: "default",
					stopHookActive: initial.stopHookActive,
					todoPath: null,
					onStopHookActiveChange: (value) => { if (value) reportedActive = true },
				}, hooks, extendedConfig)
			} finally {
				await transcript.cleanup()
			}
		if (!active || input.signal.aborted || !input.isCurrent() || (promptGenerations.get(input.sessionID) ?? 0) !== generation) {
			return { kind: "cancel" }
		}
		try {
			await verifyHookSession(ctx, input.sessionID, deletedSessions)
		} catch {
			return { kind: "cancel" }
		}

		let decision: StopDecision = { kind: "allow" }
		let continuationCount = initial.continuationCount
		if (result.block) {
			const text = (result.injectPrompt ?? result.reason ?? "").trim()
			if (!text) {
				decision = { kind: "pause", text: result.reason ?? "Claude Stop hook blocked continuation without a prompt." }
			} else if (continuationCount >= MAX_STOP_CONTINUATIONS) {
				decision = { kind: "pause", text: `Claude Stop hook continuation limit (${MAX_STOP_CONTINUATIONS}) reached for this user turn. Submit a new prompt to reset it.` }
			} else {
				continuationCount += 1
				decision = {
					kind: "continue",
					id: stableMessageID(scope, input.sessionID, `stop:${input.idleAt}:${initial.userEpoch}:${continuationCount}`),
					text,
				}
			}
		}

		return enqueue(input.sessionID, async () => {
			const latest = await readStopLedger(input.sessionID)
			if (!active || input.signal.aborted || !input.isCurrent() || latest.userEpoch !== initial.userEpoch ||
				(promptGenerations.get(input.sessionID) ?? 0) !== generation) return { kind: "cancel" }
			try {
				await verifyHookSession(ctx, input.sessionID, deletedSessions)
			} catch {
				return { kind: "cancel" }
			}
			if (!active || input.signal.aborted || !input.isCurrent()) return { kind: "cancel" }
			if (latest.lastDecision?.idleAt === input.idleAt && latest.lastDecision.userEpoch === latest.userEpoch) {
				return latest.lastDecision.decision
			}
			const { lastDecision: _previousDecision, ...withoutDecision } = latest
			const next: StopLedger = {
				...withoutDecision,
				stopHookActive: latest.stopHookActive || reportedActive || result.block,
				continuationCount,
				lastDecision: { idleAt: input.idleAt, userEpoch: latest.userEpoch, decision },
			}
			await writeStopLedger(next)
			return decision
		})
	}

	const stopInFlight = new Map<string, Promise<StopDecision>>()
	const beforeContinuation: V2ClaudeBeforeContinuation = (input) => {
		if (!enabled) return Promise.resolve({ kind: "allow" })
		if (!active) return Promise.resolve({ kind: "cancel" })
		const key = `${input.sessionID}\0${input.idleAt}\0${promptGenerations.get(input.sessionID) ?? 0}`
		const existing = stopInFlight.get(key)
		if (existing) return existing
		const current = track(() => evaluateBeforeContinuation(input))
		stopInFlight.set(key, current)
		const clearCurrent = () => { if (stopInFlight.get(key) === current) stopInFlight.delete(key) }
		void current.then(clearCurrent, clearCurrent)
		return current
	}

	if (!enabled) return { cleanup: async () => undefined, beforeContinuation }

	try {
		let pluginHooksConfigs: PluginHooksConfig[] = []
		if (config.claude_code?.plugins !== false) {
			const pluginOptions: PluginLoaderOptions = {
				projectDirectory: directory,
				enabledPluginsOverride: config.claude_code?.plugins_override,
			}
			const found = discoverInstalledPlugins(pluginOptions)
			for (const error of found.errors) log("[v2 Claude hooks] Could not load an enabled Claude plugin.", error)
			pluginHooksConfigs = loadPluginHooksConfigs(found.plugins)
		}
		hooks = await loadClaudeHooksConfig(undefined, {
			projectDirectory: directory,
			pluginHooksConfigs,
			allowedMcpEnvVars: config.mcp_env_allowlist ?? [],
		})
		extendedConfig = await loadPluginExtendedConfig({ projectDirectory: directory })
		if (!active) throw new Error("Claude hooks were disposed while configuration was loading.")

		if (hooks?.UserPromptSubmit?.length || hooks?.Stop?.length) {
			const promptRegistration = await ctx.session.hook("prompt", async (input: SessionPrompt) => track(async () => {
				if (!active || !hooks) return
				const sessionID = String(input.sessionID)
				const messageID = String(input.messageID)
				const parts: MessagePart[] = [{ type: "text", text: input.prompt.text }]
				if (!parts.some(isRealUserTextPart)) return
				let isRoot: boolean
				try {
					isRoot = await isRootConversationSession(ctx, sessionID, options.resolveLogicalParent, deletedSessions)
				} catch (error) {
					throw new Error(`Cannot verify whether Claude hooks apply to session ${sessionID}.`, { cause: error })
				}
				if (!isRoot || !active) return

				await enqueue(sessionID, async () => {
					const current = await readStopLedger(sessionID)
					if (current.lastUserMessageID === messageID) return
					const { lastDecision: _previousDecision, ...withoutDecision } = current
					const next: StopLedger = {
						...withoutDecision,
						userEpoch: current.userEpoch + 1,
						lastUserMessageID: messageID,
						stopHookActive: false,
						continuationCount: 0,
					}
					await writeStopLedger(next)
					setBounded(promptGenerations, sessionID, (promptGenerations.get(sessionID) ?? 0) + 1)
				})
				const generation = promptGenerations.get(sessionID) ?? 0
				if (!hooks.UserPromptSubmit?.length) return
				const transcript = await createSessionTranscript(ctx, sessionID, undefined, deletedSessions)
				let result: Awaited<ReturnType<typeof executeUserPromptSubmitHooks>>
				try {
					if (!active) return
					result = await executeUserPromptSubmitHooks({
						sessionId: sessionID,
						prompt: input.prompt.text,
						parts,
						cwd: directory,
						transcriptPath: transcript.path,
						permissionMode: "default",
					}, hooks, extendedConfig)
				} finally {
					await transcript.cleanup()
				}
				if (!active) return
				await verifyHookSession(ctx, sessionID, deletedSessions)
				if (!active) return
				if ((promptGenerations.get(sessionID) ?? 0) !== generation) {
					throw new Error("Claude UserPromptSubmit hook result was discarded because a newer user prompt arrived.")
				}
				if (result.block) {
					const reason = result.reason?.trim() || "Blocked by Claude UserPromptSubmit hook."
					try {
						await ctx.session.synthetic({
							sessionID: input.sessionID,
							id: stableMessageID(scope, sessionID, `prompt:${messageID}:${reason}`),
							text: `Claude UserPromptSubmit hook blocked this prompt: ${reason}`,
							description: "Claude UserPromptSubmit hook block",
							metadata: { [CLAUDE_BLOCK_NOTICE]: true, hook: "UserPromptSubmit", messageID },
							delivery: "queue",
							resume: false,
						})
					} catch (error) {
						log("[v2 Claude hooks] Could not add the visible UserPromptSubmit block notice.", { sessionID, error })
					}
					throw new Error(reason)
				}
				const nextText = appendHookMessages(input.prompt.text, result.messages)
				if (nextText !== input.prompt.text) input.prompt.text = nextText
			}))
			registrations.push(promptRegistration)
		}

		if (hooks?.PreToolUse?.length) {
			const beforeToolRegistration = await ctx.tool.hook("execute.before", async (event) => track(async () => {
				if (!active || !hooks?.PreToolUse?.length) return
				const sessionID = String(event.sessionID)
				const messageID = String(event.messageID)
				const toolUseID = String(event.id)
				const nativeInput = isRecord(event.input) ? event.input : {}
				const transcript = await createSessionTranscript(ctx, sessionID, toolTranscriptExchange({
					toolName: event.tool,
					toolUseID,
					toolInput: nativeInput,
					status: "running",
				}), deletedSessions)
				try {
					if (!active) return
					const result = await executePreToolUseHooks({
						sessionId: sessionID,
						toolName: claudeToolName(event.tool),
						toolInput: toClaudeToolInput(event.tool, nativeInput),
						cwd: directory,
						transcriptPath: transcript.path,
						toolUseId: toolUseID,
						permissionMode: "default",
						preserveInputKeys: true,
					}, hooks, extendedConfig)
					if (!active) return
					await verifyHookSession(ctx, sessionID, deletedSessions)
					if (!active) return
					if (result.decision === "deny" || result.continue === false) {
						throw new NativeToolError({ message: result.reason ?? result.stopReason ?? "Blocked by Claude PreToolUse hook." })
					}
					if (result.decision === "ask") {
						if (!PERMISSION_ASK_SUPPORTED_TOOLS.has(event.tool.toLowerCase())) {
						throw new NativeToolError({ message: `Claude PreToolUse requested approval for ${claudeToolName(event.tool)}, but OpenCode exposes no permission assertion for this tool.` })
					}
					const key = permissionSourceKey(sessionID, messageID, toolUseID)
					if (!permissionAsks.has(key) && permissionAsks.size >= PERMISSION_ASK_LIMIT) {
						throw new NativeToolError({ message: "Too many Claude PreToolUse approvals are pending; refusing to lose an approval decision." })
					}
					permissionAsks.set(key, result.reason ?? `Claude PreToolUse requests approval for ${claudeToolName(event.tool)}.`)
					}
					if (result.modifiedInput) event.input = applyClaudeToolInput(event.tool, nativeInput, result.modifiedInput)
				} finally {
					await transcript.cleanup()
				}
			}))
			registrations.push(beforeToolRegistration)
		}

		const registerAfterTool = Boolean(hooks?.PreToolUse?.length || hooks?.PostToolUse?.length || hooks?.PostToolUseFailure?.length)
		if (registerAfterTool) {
			const afterToolRegistration = await ctx.tool.hook("execute.after", async (event) => track(async () => {
				if (!active) return
				const sessionID = String(event.sessionID)
				const messageID = String(event.messageID)
				const toolUseID = String(event.id)
				const nativeInput = isRecord(event.input) ? event.input : {}
				permissionAsks.delete(permissionSourceKey(sessionID, messageID, toolUseID))
				const eventName = event.status === "completed" ? "PostToolUse" : "PostToolUseFailure"
				if (!hooks?.[eventName]?.length) return
				const exchange = toolTranscriptExchange({
					toolName: event.tool,
					toolUseID,
					toolInput: nativeInput,
					status: event.status,
					...(event.status === "completed" ? { result: event.result } : { error: event.error }),
				})
				const transcript = await createSessionTranscript(ctx, sessionID, exchange, deletedSessions)
				try {
					if (!active) return
					const failure = event.status === "error" ? {
						message: event.error.message,
						isInterrupt: /abort|interrupt/i.test(event.error.message),
					} : undefined
					const result = await executePostToolUseHooks({
						sessionId: sessionID,
						toolName: claudeToolName(event.tool),
						toolInput: toClaudeToolInput(event.tool, nativeInput),
						toolOutput: event.status === "completed" ? canonicalToolResult(event.result) : { error: event.error.message },
						cwd: directory,
						transcriptPath: transcript.path,
						toolUseId: toolUseID,
						permissionMode: "default",
						preserveInputKeys: true,
						preserveOutputKeys: true,
						hookEventName: eventName,
						...(failure ? { failure } : {}),
					}, hooks, extendedConfig)
					if (!active) return
					await verifyHookSession(ctx, sessionID, deletedSessions)
					if (!active) return
					const additions = postHookMessages(result)
					if (additions.length === 0) return
					if (event.status === "completed") {
						event.result = { ...event.result, content: appendHookText(event.result.content, additions) }
					} else {
						const nextError = new NativeToolError({
							message: `${event.error.message}\n\n${additions.join("\n\n")}`,
							error: event.error,
							metadata: event.error.metadata,
						})
						Object.assign(event, { error: nextError })
					}
				} finally {
					await transcript.cleanup()
				}
			}))
			registrations.push(afterToolRegistration)
		}

		if (hooks?.PreToolUse?.length) {
			const permissionRegistration = await ctx.permission.hook("evaluate", async (event) => {
				if (!active || event.source?.type !== "tool") return
				const reason = permissionAsks.get(permissionSourceKey(String(event.sessionID), event.source.messageID, event.source.id))
				if (!reason || event.effect === "deny") return
				event.effect = "ask"
				event.message = reason
			})
			registrations.push(permissionRegistration)
		}

		if (hooks?.PreCompact?.length) {
			const compactionRegistration = await ctx.session.hook("compaction", async (input: SessionCompaction) => track(async () => {
				if (!active || !hooks?.PreCompact?.length) return
				const sessionID = String(input.sessionID)
				const transcript = await createSessionTranscript(ctx, sessionID, undefined, deletedSessions)
				try {
					if (!active) return
					const result = await executePreCompactHooks({ sessionId: sessionID, cwd: directory, transcriptPath: transcript.path }, hooks, extendedConfig)
					if (!active) return
					await verifyHookSession(ctx, sessionID, deletedSessions)
					if (!active) return
					if (result.context.length > 0) input.system.push({ type: "text", text: result.context.join("\n\n") })
					if (result.continue === false) {
						throw new Error(result.stopReason ?? "Claude PreCompact hook stopped compaction.")
					}
				} finally {
					await transcript.cleanup()
				}
			}))
			registrations.push(compactionRegistration)
		}

		eventTask = (async () => {
			while (active && !eventController.signal.aborted) {
				try {
					for await (const event of ctx.event.subscribe({ signal: eventController.signal })) {
						if (!active || eventController.signal.aborted) return
						if (event.type !== "session.deleted" || !isLocationMatch(event, ctx)) continue
						const sessionID = event.data.sessionID
						setBoundedSet(deletedSessions, sessionID)
						await enqueue(sessionID, async () => {
							await ctx.storage.remove(stopKey(sessionID))
							promptGenerations.delete(sessionID)
							for (const key of permissionAsks.keys()) {
								if (key.startsWith(`${sessionID}\0`)) permissionAsks.delete(key)
							}
						})
					}
				} catch (error) {
					if (!eventController.signal.aborted) log("[v2 Claude hooks] Session event stream stopped; reconnecting.", error)
				}
				if (active && !eventController.signal.aborted) await waitForRetry(eventController.signal)
			}
		})()

		const cleanup = async () => {
			if (!active) return
			active = false
			eventController.abort()
			const errors: unknown[] = []
			for (const registration of registrations.reverse()) {
				try { await registration.dispose() } catch (error) { errors.push(error) }
			}
			await eventTask?.catch((error) => errors.push(error))
			await Promise.all([...running].map((promise) => promise.catch((error) => errors.push(error))))
			await Promise.all([...queues.values()].map((queue) => queue.catch((error) => errors.push(error))))
			promptGenerations.clear()
			permissionAsks.clear()
			deletedSessions.clear()
			stopInFlight.clear()
			if (errors.length > 0) throw new AggregateError(errors, "Claude V2 hooks cleanup did not finish cleanly.")
		}

		return { cleanup, beforeContinuation }
	} catch (error) {
		active = false
		eventController.abort()
		const errors: unknown[] = []
		for (const registration of registrations.reverse()) {
			try { await registration.dispose() } catch (cleanupError) { errors.push(cleanupError) }
		}
		await eventTask?.catch((cleanupError) => errors.push(cleanupError))
		permissionAsks.clear()
		deletedSessions.clear()
		if (errors.length > 0) throw new AggregateError([error, ...errors], "Claude V2 hook registration failed and cleanup was incomplete.")
		throw error
	}
}
