import type { Plugin } from "@opencode/plugin"
import type { SessionContext, SessionPrompt } from "@opencode/plugin/promise/session"
import type { OhMyOpenCodeConfig } from "../config"
import type { KeywordType } from "../config/schema/keyword-detector"
import { detectKeywordsWithType } from "../hooks/keyword-detector/detector"
import {
	isNonOmoAgent,
	isPlannerAgent,
	getUltraworkMessage,
	TEAM_MESSAGE,
} from "../hooks/keyword-detector/constants"
import { isSystemDirective, removeSystemReminders } from "../shared/system-directive"
import { log } from "../shared/logger"

const SESSION_STATE_LIMIT = 256
const STOP_CONTINUATION_COMMAND = /^\s*\/stop-continuation(?:\s|$)/i
const SLASH_COMMAND = /^\s*\/[a-zA-Z][\w-]*(?:\s|$)/
const HYPERPLAN_UNAVAILABLE_MESSAGE = `<native-mode-compatibility>
The requested Hyperplan adversarial team workflow is unavailable in this OpenCode 2 runtime because the OMO team manager is not available here. Do not load Hyperplan team instructions. Do not simulate team rounds or claim that team orchestration ran. Explain this limitation and offer supported alternatives; do not choose a substitute workflow without the user's direction.
If Ultrawork was also explicitly requested, continue its independent protocol while making clear that the Hyperplan team portion is unavailable.
</native-mode-compatibility>`

type ContextMode = {
	ultrawork: boolean
	hyperplan: boolean
	team: boolean
	lastPrompt?: string
}

type MessageLike = {
	role?: unknown
	content?: unknown
	parts?: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

function textFromContent(value: unknown): string {
	if (typeof value === "string") return value
	if (!Array.isArray(value)) return ""
	return value
		.flatMap((part) => {
			if (!isRecord(part) || part.type !== "text" || typeof part.text !== "string") return []
			return [part.text]
		})
		.join(" ")
}

export function latestUserText(messages: readonly unknown[]): string | undefined {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index] as MessageLike | undefined
		if (message?.role !== "user") continue
		const text = textFromContent(message.content ?? message.parts)
		if (text.trim()) return text
	}
	return undefined
}

function keywordModes(text: string, agent: string, model: string, config: OhMyOpenCodeConfig): ContextMode {
	const mode: ContextMode = { ultrawork: false, hyperplan: false, team: false }
	if (config.disabled_hooks?.includes("keyword-detector")) return mode
	const cleaned = removeSystemReminders(text)
	if (isSystemDirective(cleaned) || SLASH_COMMAND.test(cleaned)) return mode
	const detected = detectKeywordsWithType(
		cleaned,
		agent,
		model,
		config.keyword_detector?.disabled_keywords as KeywordType[] | undefined,
		config.keyword_detector?.enabled_expansions as KeywordType[] | undefined,
	)
	if (isPlannerAgent(agent)) return mode
	mode.ultrawork = detected.some((item) => item.type === "ultrawork" || item.type === "hyperplan-ultrawork")
	mode.hyperplan = detected.some((item) => item.type === "hyperplan" || item.type === "hyperplan-ultrawork")
	mode.team = detected.some((item) => item.type === "team")
	return mode
}

function getModePrompt(mode: ContextMode, agent: string, model: string, teamModeAvailable: boolean): string[] {
	const prompts: string[] = []
	if (mode.hyperplan) prompts.push(HYPERPLAN_UNAVAILABLE_MESSAGE)
	if (mode.ultrawork) prompts.push(getUltraworkMessage(agent, model))
	if (mode.team && teamModeAvailable) prompts.push(TEAM_MESSAGE)
	return prompts
}

function systemText(system: SessionContext["system"]): string {
	return system.map((part) => part.text).join("\n")
}

function applyDisabledTools(input: SessionContext, config: OhMyOpenCodeConfig): void {
	const disabled = new Set((config.disabled_tools ?? []).map((name) => name.toLowerCase()))
	if (disabled.size === 0) return
	for (const name of Object.keys(input.tools)) {
		if (disabled.has(name.toLowerCase())) delete input.tools[name]
	}
}

/** Register native session.prompt/session.context mutations and return their cleanup. */
export async function registerV2ContextHooks(ctx: Plugin.Context, config: OhMyOpenCodeConfig): Promise<() => Promise<void>> {
	const modes = new Map<string, ContextMode>()
	const loggedSettingsErrors = new Set<string>()
	const keywordDetectorEnabled = !config.disabled_hooks?.includes("keyword-detector")
	// OpenCode 2 has no OMO team manager yet. Names from an external plugin do
	// not prove the lifecycle semantics required by TEAM_MESSAGE.
	const teamModeAvailable = false
	const remembers = (sessionID: string, mode: ContextMode) => {
		if (!modes.has(sessionID) && modes.size >= SESSION_STATE_LIMIT) {
			const oldest = modes.keys().next().value
			if (oldest !== undefined) modes.delete(oldest)
		}
		modes.set(sessionID, mode)
	}
	let promptRegistration: Awaited<ReturnType<typeof ctx.session.hook>> | undefined
	let contextRegistration: Awaited<ReturnType<typeof ctx.session.hook>> | undefined
	try {
		promptRegistration = !keywordDetectorEnabled
		? undefined
		: await ctx.session.hook("prompt", (input: SessionPrompt) => {
			const text = input.prompt.text
			if (STOP_CONTINUATION_COMMAND.test(text)) {
				modes.delete(input.sessionID)
				return
			}
			if (!text.trim() || isSystemDirective(text)) return
			const current = modes.get(input.sessionID) ?? { ultrawork: false, hyperplan: false, team: false }
			const detected = detectKeywordsWithType(
				removeSystemReminders(text),
				undefined,
				undefined,
				config.keyword_detector?.disabled_keywords as KeywordType[] | undefined,
				config.keyword_detector?.enabled_expansions as KeywordType[] | undefined,
			)
			const explicitUltrawork = detected.some((item) => item.type === "ultrawork" || item.type === "hyperplan-ultrawork")
			const explicitHyperplan = detected.some((item) => item.type === "hyperplan" || item.type === "hyperplan-ultrawork")
			const explicitTeam = detected.some((item) => item.type === "team")
			remembers(input.sessionID, {
				ultrawork: current.ultrawork || explicitUltrawork || config.default_mode?.ultrawork === true,
				hyperplan: current.hyperplan || explicitHyperplan,
				team: current.team || explicitTeam,
				lastPrompt: text,
			})
		})

		contextRegistration = await ctx.session.hook("context", async (input: SessionContext) => {
		applyDisabledTools(input, config)
		const agent = String(input.agent)
		if (isNonOmoAgent(agent)) return
		try {
			const result = await ctx.agent.get({ agentID: agent })
			const settings = result.data.request?.settings
			if (isRecord(settings)) Object.assign(input.options, settings)
		} catch (error) {
			if (!loggedSettingsErrors.has(agent)) {
				loggedSettingsErrors.add(agent)
				log(`[v2 context] Could not apply native request settings for ${agent}: ${error instanceof Error ? error.message : String(error)}`)
			}
		}
		if (isPlannerAgent(agent)) return
		const model = String(input.model.id)
		const text = latestUserText(input.messages) ?? modes.get(input.sessionID)?.lastPrompt
		if (!text || isSystemDirective(text) || SLASH_COMMAND.test(text)) return
		const detected = keywordModes(text, agent, model, config)
		const previous = modes.get(input.sessionID) ?? { ultrawork: false, hyperplan: false, team: false }
		const mode = {
			ultrawork: previous.ultrawork || detected.ultrawork || (keywordDetectorEnabled && config.default_mode?.ultrawork === true),
			hyperplan: previous.hyperplan || detected.hyperplan,
			team: previous.team || detected.team,
			lastPrompt: text,
		}
		remembers(input.sessionID, mode)
		const existing = systemText(input.system)
		for (const prompt of getModePrompt(mode, agent, model, teamModeAvailable)) {
			if (!existing.includes(prompt)) input.system.push({ type: "text", text: prompt })
		}
		})
	} catch (error) {
		modes.clear()
		await contextRegistration?.dispose()
		await promptRegistration?.dispose()
		throw error
	}

	return async () => {
		modes.clear()
		loggedSettingsErrors.clear()
		await contextRegistration?.dispose()
		await promptRegistration?.dispose()
	}
}
