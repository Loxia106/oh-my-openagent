import { createHash } from "node:crypto"
import { realpath } from "node:fs/promises"
import type { Plugin } from "@opencode/plugin"
import { Error as NativeToolError, type Result as NativeToolResult } from "@opencode/plugin/promise/tool"
import type { SessionContext } from "@opencode/plugin/promise/session"
import type { CheckResult, HookInput } from "@oh-my-opencode/comment-checker-core"
import { extractApplyPatchEdits } from "@oh-my-opencode/comment-checker-core"
import { DELEGATE_TASK_ERROR_PATTERNS, type DetectedError } from "@oh-my-opencode/delegate-core"
import type { OhMyOpenCodeConfig } from "../config"
import { detectDelegateTaskError, buildRetryGuidance } from "../hooks/delegate-task-retry"
import { buildReminderMessage } from "../hooks/category-skill-reminder/formatter"
import { getCommentCheckerPath, runCommentChecker } from "../hooks/comment-checker/cli"
import { isCliPathUsable } from "../hooks/comment-checker/cli-runner"
import type { AvailableSkill } from "../agents/dynamic-agent-prompt-builder"
import { createSkillContext } from "../plugin/skill-context"
import type { LoadedSkill } from "../features/opencode-skill-loader/types"
import { getAgentConfigKey } from "../shared/agent-display-names"
import { latestUserText } from "./context-hooks"
import { log } from "../shared/logger"

const CATEGORY_REMINDER_MARKER = "[Category+Skill Reminder]"
const TASK_RETRY_MARKER = "[task CALL FAILED - IMMEDIATE RETRY REQUIRED]"
const COMMENT_CHECKER_MARKER = "[Comment Checker Findings]"
const CATEGORY_STATE_PREFIX = "oh-my-openagent:v2:category-skill-reminder:"
const CATEGORY_SEEN_CALL_LIMIT = 64
const COMMENT_SEEN_CALL_LIMIT = 96
const COMMENT_SESSION_LIMIT = 256
const COMMENT_DEDUP_WINDOW_MS = 30_000
const NON_TEAM_PROMPT_SKILLS = new Set(["security-research", "security-review", "team-mode"])

const TARGET_AGENTS = new Set(["sisyphus", "sisyphus-junior", "atlas"])
const DELEGATABLE_WORK_TOOLS = new Set(["edit", "write", "bash", "shell", "read", "grep", "glob"])
const DELEGATION_TOOLS = new Set(["task", "subagent", "call_omo_agent"])

type NativeToolEvent = {
	readonly tool: string
	readonly sessionID: string
	readonly agent: string
	readonly messageID: string
	readonly id: string
	readonly input: unknown
	readonly status: "completed" | "error"
	result?: NativeToolResult
	error?: InstanceType<typeof NativeToolError>
}

type NativeEvent = {
	readonly type: string
	readonly location?: unknown
	readonly data?: unknown
}

type CategoryState = {
	readonly version: 1
	readonly location: string
	readonly sessionID: string
	readonly delegationUsed: boolean
	readonly reminderPending: boolean
	readonly reminderShown: boolean
	readonly toolCallCount: number
	readonly seenCallIDs: readonly string[]
}

type CommentSessionState = {
	readonly seenCalls: readonly string[]
	readonly lastRunAt?: number
}

export type V2CommentCheckerDependencies = {
	readonly getPath: () => Promise<string | null>
	readonly isPathUsable: (path: string | null) => path is string
	readonly run: (input: HookInput, path: string, customPrompt?: string) => Promise<CheckResult>
}

export type V2ConversationAdvisoryDependencies = {
	readonly loadAvailableSkills?: (config: OhMyOpenCodeConfig, directory: string, agent: string) => Promise<readonly AvailableSkill[]>
	readonly commentChecker?: V2CommentCheckerDependencies
}

const DEFAULT_COMMENT_CHECKER: V2CommentCheckerDependencies = {
	getPath: getCommentCheckerPath,
	isPathUsable: isCliPathUsable,
	run: runCommentChecker,
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

function textFromContent(content: NativeToolResult["content"]): string {
	if (typeof content === "string") return content
	if (!Array.isArray(content)) return ""
	return content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n")
}

function appendTextContent(content: NativeToolResult["content"], text: string): NativeToolResult["content"] {
	if (typeof content === "string") return `${content}${content.trim() ? "\n\n" : ""}${text}`
	return [...(content ?? []), { type: "text", text }]
}

function appendTaskGuidance(event: NativeToolEvent, source: string): void {
	// Native v2 error status is authoritative. Its typed errors can omit the
	// textual marker required by the legacy completed-output detector.
	const detected = event.status === "error"
		? detectNativeTaskError(source)
		: detectDelegateTaskError(source)
	if (!detected) return
	const guidance = buildRetryGuidance(detected)

	if (event.status === "error" && event.error) {
		if (event.error.message.includes(TASK_RETRY_MARKER)) return
		const original = event.error
		event.error = new NativeToolError({
			message: `${original.message}${original.message.endsWith("\n") ? "" : "\n"}${guidance}`,
			error: original.error,
			metadata: original.metadata,
		})
		return
	}

	if (event.status !== "completed" || !event.result) return
	const current = textFromContent(event.result.content)
	if (current.includes(TASK_RETRY_MARKER)) return
	event.result = {
		...event.result,
		content: appendTextContent(event.result.content, guidance),
	}
}

function detectNativeTaskError(output: string): DetectedError | null {
	for (const errorPattern of DELEGATE_TASK_ERROR_PATTERNS) {
		if (output.includes(errorPattern.pattern)) {
			return { errorType: errorPattern.errorType, originalOutput: output }
		}
	}
	return null
}

function categoryKey(location: string, sessionID: string): string {
	return `${CATEGORY_STATE_PREFIX}${location}:${encodeURIComponent(sessionID)}`
}

function emptyCategoryState(location: string, sessionID: string): CategoryState {
	return {
		version: 1,
		location,
		sessionID,
		delegationUsed: false,
		reminderPending: false,
		reminderShown: false,
		toolCallCount: 0,
		seenCallIDs: [],
	}
}

function decodeCategoryState(value: unknown, location: string, sessionID: string): CategoryState {
	if (!isRecord(value) || value.version !== 1 || value.location !== location || value.sessionID !== sessionID) {
		return emptyCategoryState(location, sessionID)
	}
	return {
		version: 1,
		location,
		sessionID,
		delegationUsed: value.delegationUsed === true,
		reminderPending: value.reminderPending === true,
		reminderShown: value.reminderShown === true,
		toolCallCount: typeof value.toolCallCount === "number" && Number.isFinite(value.toolCallCount)
			? Math.max(0, Math.floor(value.toolCallCount))
			: 0,
		seenCallIDs: Array.isArray(value.seenCallIDs)
			? value.seenCallIDs.filter((entry): entry is string => typeof entry === "string").slice(-CATEGORY_SEEN_CALL_LIMIT)
			: [],
	}
}

async function locationScope(ctx: Plugin.Context): Promise<{ scope: string; canonicalDirectory: string }> {
	const location = ctx.location as unknown as Record<string, unknown>
	const project = isRecord(location.project) ? location.project : undefined
	const directory = String(location.directory ?? "")
	const canonicalDirectory = await realpath(directory).catch(() => directory)
	const canonicalProject = typeof project?.canonical === "string"
		? await realpath(project.canonical).catch(() => project.canonical as string)
		: ""
	const identity = [canonicalDirectory, String(location.workspaceID ?? ""), String(project?.id ?? ""), canonicalProject].join("\0")
	return { scope: createHash("sha256").update(identity).digest("hex"), canonicalDirectory }
}

function locationMatches(eventLocation: unknown, ctx: Plugin.Context, canonicalDirectory: string): boolean {
	if (!isRecord(eventLocation)) return true
	if (typeof eventLocation.directory === "string") {
		const eventDirectory = eventLocation.directory
		if (eventDirectory !== canonicalDirectory && eventDirectory !== String(ctx.location.directory)) return false
	}
	if (typeof eventLocation.workspaceID === "string" && eventLocation.workspaceID !== ctx.location.workspaceID) return false
	return true
}

function deletedSessionID(event: NativeEvent): string | undefined {
	return isRecord(event.data) && typeof event.data.sessionID === "string" ? event.data.sessionID : undefined
}

function isTargetAgent(agent: string): boolean {
	return TARGET_AGENTS.has(getAgentConfigKey(agent))
}

/** Keep reminder suggestions aligned with the native agent prompt's skill visibility. */
export function filterV2CategoryReminderSkills(
	available: readonly AvailableSkill[],
	loaded: readonly LoadedSkill[],
	agent: string,
): AvailableSkill[] {
	const winners = new Map(loaded.map((skill) => [skill.name.toLowerCase(), skill]))
	return available.filter((skill) => {
		const name = skill.name.toLowerCase()
		const source = winners.get(name)
		if (source && (source.disableModelInvocation === true ||
			String(source.metadata?.["opencode/autoinvoke"] ?? "").trim().toLowerCase() === "false")) return false
		if (source?.definition.agent && getAgentConfigKey(source.definition.agent) !== getAgentConfigKey(agent)) return false
		if (NON_TEAM_PROMPT_SKILLS.has(name) && (!source || source.scope === "builtin")) return false
		return true
	})
}

function enqueue<T>(queues: Map<string, Promise<void>>, key: string, operation: () => Promise<T>): Promise<T> {
	const previous = queues.get(key) ?? Promise.resolve()
	let release!: () => void
	const gate = new Promise<void>((resolve) => { release = resolve })
	const tail = previous.catch(() => undefined).then(() => gate)
	queues.set(key, tail)
	return (async () => {
		await previous.catch(() => undefined)
		try {
			return await operation()
		} finally {
			release()
			if (queues.get(key) === tail) queues.delete(key)
		}
	})()
}

function bumpSessionEpoch(epochs: Map<string, number>, queues: Map<string, Promise<void>>, key: string): number {
	const next = (epochs.get(key) ?? 0) + 1
	epochs.delete(key)
	epochs.set(key, next)
	while (epochs.size > COMMENT_SESSION_LIMIT) {
		const oldest = epochs.keys().next().value
		if (oldest === undefined) break
		if (queues.has(oldest)) {
			const value = epochs.get(oldest)
			epochs.delete(oldest)
			if (value !== undefined) epochs.set(oldest, value)
			if ([...epochs.keys()].every((candidate) => queues.has(candidate))) break
			continue
		}
		epochs.delete(oldest)
	}
	return next
}

function categorySystemText(system: SessionContext["system"]): string {
	return system.map((part) => part.text).join("\n")
}

function asString(input: Record<string, unknown>, key: string): string | undefined {
	return typeof input[key] === "string" ? input[key] as string : undefined
}

function hasCommentSyntax(text: string | undefined): boolean {
	if (!text) return false
	return /^\s*(\/\/|\/\*|#|--|<!--|:\s*)[\s\S]*$/m.test(text) || /<!--[\s\S]*-->/.test(text)
}

/** Same net-new-comment gate as the legacy runner, without its global lock or session map. */
function hasNewCommentsOnly(oldText: string | undefined, newText: string | undefined): boolean {
	if (!hasCommentSyntax(newText)) return false
	if (!hasCommentSyntax(oldText)) return true
	const oldLines = new Set((oldText ?? "").split("\n").map((line) => line.trim()))
	return (newText ?? "").split("\n").some((line) => {
		const trimmed = line.trim()
		return Boolean(trimmed && hasCommentSyntax(trimmed) && !oldLines.has(trimmed))
	})
}

function isNewCommentInput(input: HookInput): boolean {
	const oldText = input.tool_input.old_string
	const newText = input.tool_input.content ?? input.tool_input.new_string
	return hasNewCommentsOnly(oldText, newText)
}

function commentInputs(event: NativeToolEvent, cwd: string): HookInput[] {
	if (!event.result || !isRecord(event.input)) return []
	const tool = event.tool.trim().toLowerCase()
	const input = event.input
	const path = asString(input, "path") ?? asString(input, "filePath") ?? asString(input, "file_path")
	const common = {
		session_id: event.sessionID,
		transcript_path: "",
		cwd,
		hook_event_name: "PostToolUse",
	}

	if (tool === "write") {
		const content = asString(input, "content")
		if (!path || content === undefined) return []
		return [{ ...common, tool_name: "Write", tool_input: { file_path: path, content } }]
	}

	if (tool === "edit") {
		const oldString = asString(input, "oldString") ?? asString(input, "old_string")
		const newString = asString(input, "newString") ?? asString(input, "new_string")
		if (!path || newString === undefined) return []
		return [{ ...common, tool_name: "Edit", tool_input: { file_path: path, old_string: oldString, new_string: newString } }]
	}

	if (tool === "patch" || tool === "apply_patch") {
		return extractApplyPatchEdits(event.result.metadata, input).map((edit) => ({
			...common,
			tool_name: "Edit",
			tool_input: { file_path: edit.filePath, old_string: edit.before, new_string: edit.after },
		})).filter(isNewCommentInput)
	}

	return []
}

function trimCommentState(state: CommentSessionState): CommentSessionState {
	return { ...state, seenCalls: state.seenCalls.slice(-COMMENT_SEEN_CALL_LIMIT) }
}

/** Register native post-call guidance, category reminders, and comment analysis. */
export async function registerV2ConversationAdvisoryHooks(
	ctx: Plugin.Context,
	config: OhMyOpenCodeConfig,
	dependencies: V2ConversationAdvisoryDependencies = {},
): Promise<() => Promise<void>> {
	const disabled = new Set(config.disabled_hooks ?? [])
	const taskRetryEnabled = !disabled.has("delegate-task-retry")
	const categoryEnabled = !disabled.has("category-skill-reminder")
	const commentCheckerEnabled = !disabled.has("comment-checker")
	if (!taskRetryEnabled && !categoryEnabled && !commentCheckerEnabled) return async () => undefined

	const { scope, canonicalDirectory } = await locationScope(ctx)
	const categoryQueues = new Map<string, Promise<void>>()
	const categoryEpochs = new Map<string, number>()
	const commentQueues = new Map<string, Promise<void>>()
	const commentEpochs = new Map<string, number>()
	const commentState = new Map<string, CommentSessionState>()
	const commentChecker = dependencies.commentChecker ?? DEFAULT_COMMENT_CHECKER
	const cleanups: Array<() => Promise<void>> = []
	const eventController = new AbortController()
	let eventTask: Promise<void> | undefined
	let disposed = false
	const reminderMessages = new Map<string, Promise<string>>()
	let commentPathWarningLogged = false
	const categoryEpoch = (key: string): number => categoryEpochs.get(key) ?? 0
	const commentEpoch = (key: string): number => commentEpochs.get(key) ?? 0
	const rememberCommentState = (key: string, state: CommentSessionState): void => {
		commentState.delete(key)
		commentState.set(key, state)
		while (commentState.size > COMMENT_SESSION_LIMIT) {
			const oldest = commentState.keys().next().value
			if (oldest === undefined) break
			commentState.delete(oldest)
		}
	}

	try {
		if (categoryEnabled) {
			const loadAvailableSkills = dependencies.loadAvailableSkills ?? (async (pluginConfig, directory, agent) => {
				const skillContext = await createSkillContext({ directory, pluginConfig })
				return filterV2CategoryReminderSkills(skillContext.availableSkills, skillContext.mergedSkills, agent)
			})
			const reminderForAgent = (agent: string): Promise<string> => {
				const key = getAgentConfigKey(agent)
				let message = reminderMessages.get(key)
				if (!message) {
					message = loadAvailableSkills(config, String(ctx.location.directory), key)
						.then((available) => buildReminderMessage([...available]))
					reminderMessages.set(key, message)
				}
				return message
			}

			const contextRegistration = await ctx.session.hook("context", async (input: SessionContext) => {
				if (disposed || !isTargetAgent(String(input.agent))) return
				if (!latestUserText(input.messages)) return
				const key = categoryKey(scope, input.sessionID)
				const generation = categoryEpoch(key)
				await enqueue(categoryQueues, key, async () => {
					if (disposed || generation !== categoryEpoch(key)) return
					const state = decodeCategoryState(await ctx.storage.get(key), scope, input.sessionID)
					if (disposed || generation !== categoryEpoch(key)) return
					if (!state.reminderPending || state.reminderShown || state.delegationUsed) return
					let reminderMessage: string
					try {
						reminderMessage = await reminderForAgent(String(input.agent))
					} catch (error) {
						log("[v2 category-skill-reminder] Could not load native agent skill suggestions.", error)
						return
					}
					if (disposed || generation !== categoryEpoch(key)) return
					const alreadyPresent = categorySystemText(input.system).includes(CATEGORY_REMINDER_MARKER)
					await ctx.storage.set(key, { ...state, reminderPending: false, reminderShown: true })
					if (disposed || generation !== categoryEpoch(key)) return
					if (!alreadyPresent) input.system.push({ type: "text", text: reminderMessage })
				})
			})
			cleanups.push(() => contextRegistration.dispose())

			const categoryRegistration = await ctx.tool.hook("execute.after", async (rawEvent) => {
				const event = rawEvent as NativeToolEvent
				if (disposed || event.status !== "completed" || !isTargetAgent(event.agent)) return
				const tool = event.tool.trim().toLowerCase()
				if (!DELEGATABLE_WORK_TOOLS.has(tool) && !DELEGATION_TOOLS.has(tool)) return
				const key = categoryKey(scope, event.sessionID)
				const generation = categoryEpoch(key)
				await enqueue(categoryQueues, key, async () => {
					if (disposed || generation !== categoryEpoch(key)) return
					const state = decodeCategoryState(await ctx.storage.get(key), scope, event.sessionID)
					if (disposed || generation !== categoryEpoch(key)) return
					const callIdentity = `${event.messageID}\0${event.id}`
					if (state.seenCallIDs.includes(callIdentity)) return
					const seenCallIDs = [...state.seenCallIDs, callIdentity].slice(-CATEGORY_SEEN_CALL_LIMIT)
					if (DELEGATION_TOOLS.has(tool)) {
						await ctx.storage.set(key, { ...state, seenCallIDs, delegationUsed: true, reminderPending: false })
						return
					}
					const toolCallCount = state.toolCallCount + 1
					await ctx.storage.set(key, {
						...state,
						seenCallIDs,
						toolCallCount,
						reminderPending: state.reminderPending || (!state.delegationUsed && !state.reminderShown && toolCallCount >= 3),
					})
					if (disposed || generation !== categoryEpoch(key)) return
				})
			})
			cleanups.push(() => categoryRegistration.dispose())
		}

		if (taskRetryEnabled) {
			const taskRegistration = await ctx.tool.hook("execute.after", (rawEvent) => {
				const event = rawEvent as NativeToolEvent
				if (disposed || event.tool.trim().toLowerCase() !== "task") return
				if (event.status === "error") {
					if (event.error) appendTaskGuidance(event, event.error.message)
					return
				}
				appendTaskGuidance(event, textFromContent(event.result?.content))
			})
			cleanups.push(() => taskRegistration.dispose())
		}

		if (commentCheckerEnabled) {
			const commentRegistration = await ctx.tool.hook("execute.after", async (rawEvent) => {
				const event = rawEvent as NativeToolEvent
				if (disposed || event.status !== "completed" || !event.result) return
				const tool = event.tool.trim().toLowerCase()
				if (tool !== "write" && tool !== "edit" && tool !== "patch" && tool !== "apply_patch") return
				const key = `${scope}:${encodeURIComponent(event.sessionID)}`
				const generation = commentEpoch(key)
				await enqueue(commentQueues, key, async () => {
					if (disposed || generation !== commentEpoch(key) || !event.result) return
					const current = commentState.get(key) ?? { seenCalls: [] }
					const callIdentity = `${event.messageID}\0${event.id}`
					if (current.seenCalls.includes(callIdentity)) return
					const inputs = commentInputs(event, String(ctx.location.directory)).filter(isNewCommentInput)
					const nextState = (lastRunAt?: number) => trimCommentState({
						...current,
						seenCalls: [...current.seenCalls, callIdentity],
						...(lastRunAt === undefined ? {} : { lastRunAt }),
					})
					if (inputs.length === 0) {
						rememberCommentState(key, nextState(current.lastRunAt))
						return
					}
					const now = Date.now()
					if (typeof current.lastRunAt === "number" && now - current.lastRunAt < COMMENT_DEDUP_WINDOW_MS) {
						rememberCommentState(key, nextState(current.lastRunAt))
						return
					}
					rememberCommentState(key, nextState(now))
					let path: string | null
					try {
						path = await commentChecker.getPath()
					} catch (error) {
						log("[v2 comment-checker] Could not resolve or provision the pinned checker binary.", error)
						return
					}
					if (disposed || generation !== commentEpoch(key) || !event.result) return
					if (!commentChecker.isPathUsable(path)) {
						if (!commentPathWarningLogged) {
							commentPathWarningLogged = true
							log("[v2 comment-checker] The pinned checker binary is unavailable; comment checking is disabled for this process.")
						}
						return
					}

					const findings: string[] = []
					for (const input of inputs) {
						if (disposed || generation !== commentEpoch(key) || !event.result) return
						try {
							const result = await commentChecker.run(input, path, config.comment_checker?.custom_prompt)
							if (disposed || generation !== commentEpoch(key) || !event.result) return
							if (result.hasComments && result.message.trim()) findings.push(result.message.trim())
						} catch (error) {
							log("[v2 comment-checker] Checker execution failed after a successful file mutation.", error)
						}
					}
					if (disposed || generation !== commentEpoch(key) || findings.length === 0 || !event.result) return
					const currentText = textFromContent(event.result.content)
					if (currentText.includes(COMMENT_CHECKER_MARKER)) return
					event.result = {
						...event.result,
						content: appendTextContent(event.result.content, `${COMMENT_CHECKER_MARKER}\n\n${findings.join("\n\n")}`),
					}
				})
			})
			cleanups.push(() => commentRegistration.dispose())
		}

		if (categoryEnabled || commentCheckerEnabled) {
			eventTask = (async () => {
				try {
					for await (const rawEvent of ctx.event.subscribe({ signal: eventController.signal })) {
						if (disposed || eventController.signal.aborted) return
						const event = rawEvent as NativeEvent
						if (event.type !== "session.deleted" || !locationMatches(event.location, ctx, canonicalDirectory)) continue
						const sessionID = deletedSessionID(event)
						if (!sessionID) continue
						if (categoryEnabled) {
							const key = categoryKey(scope, sessionID)
							bumpSessionEpoch(categoryEpochs, categoryQueues, key)
							await enqueue(categoryQueues, key, async () => {
								if (!disposed) await ctx.storage.remove(key)
							})
						}
						if (commentCheckerEnabled) {
							const key = `${scope}:${encodeURIComponent(sessionID)}`
							bumpSessionEpoch(commentEpochs, commentQueues, key)
							await enqueue(commentQueues, key, async () => { commentState.delete(key) })
						}
					}
				} catch (error) {
					if (!disposed && !eventController.signal.aborted) log("[v2 conversation advisories] Session event stream stopped.", error)
				}
			})()
		}
	} catch (error) {
		disposed = true
		eventController.abort()
		const cleanupErrors: unknown[] = []
		for (const cleanup of cleanups.reverse()) {
			try { await cleanup() } catch (cleanupError) { cleanupErrors.push(cleanupError) }
		}
		await eventTask
		await Promise.all([...categoryQueues.values(), ...commentQueues.values()].map((queue) => queue.catch(() => undefined)))
		categoryQueues.clear()
		commentQueues.clear()
		categoryEpochs.clear()
		commentEpochs.clear()
		commentState.clear()
		if (cleanupErrors.length > 0) {
			throw new AggregateError([error, ...cleanupErrors], "V2 conversation advisory registration failed and cleanup was incomplete")
		}
		throw error
	}

	return async () => {
		if (disposed) return
		disposed = true
		eventController.abort()
		const cleanupErrors: unknown[] = []
		for (const cleanup of cleanups.reverse()) {
			try { await cleanup() } catch (error) { cleanupErrors.push(error) }
		}
		await eventTask
		await Promise.all([...categoryQueues.values(), ...commentQueues.values()].map((queue) => queue.catch(() => undefined)))
		categoryQueues.clear()
		commentQueues.clear()
		categoryEpochs.clear()
		commentEpochs.clear()
		commentState.clear()
		if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, "V2 conversation advisory cleanup was incomplete")
	}
}
