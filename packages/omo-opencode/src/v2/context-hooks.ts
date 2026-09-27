import type { Plugin } from "@opencode/plugin"
import type { SessionContext, SessionPrompt } from "@opencode/plugin/promise/session"
import type { OhMyOpenCodeConfig } from "../config"
import type { KeywordType } from "../config/schema/keyword-detector"
import { detectKeywordsWithType } from "../hooks/keyword-detector/detector"
import {
	isPlannerAgent,
	getUltraworkMessage,
	getHyperplanUltraworkMessage,
	TEAM_MESSAGE,
} from "../hooks/keyword-detector/constants"
import { isSystemDirective, removeSystemReminders } from "../shared/system-directive"
import { log } from "../shared/logger"
import { createV2DelegationSettings, isV2DelegationSessionInLocation } from "./delegation-settings"
import type { VerifiedLogicalParentResolver } from "./background-admission"
import { V2_HYPERPLAN_MODE_PROMPT } from "./team-skill-adapter"

const SESSION_STATE_LIMIT = 256
const TEAM_MODE_STATUS_MARKER = "<team_mode_status enabled=\"true\">"
export const TEAM_MODE_STATUS = `${TEAM_MODE_STATUS_MARKER}
Team mode is ENABLED for this session. Presence of the team_* tools is authoritative proof; do not inspect config files to verify.
Closure invariant: every team you open is yours to close. After each team_task_update that completes or fails a task, call team_task_list({ teamRunId }); if every task is terminal, run team_shutdown_request + team_approve_shutdown per active member, then team_delete — in the same turn, without waiting for the user to ask. Lingering teams are a defect.
Load the team-mode skill for the full Closure Contract and Closure Sequence.
</team_mode_status>`
const STOP_CONTINUATION_COMMAND = /^\s*\/stop-continuation(?:\s|$)/i
const SLASH_COMMAND = /^\s*\/[a-zA-Z][\w-]*(?:\s|$)/
const NATIVE_AGENTS_WITHOUT_OMO_KEYWORD_MODES = new Set(["build", "plan"])
const HYPERPLAN_UNAVAILABLE_MESSAGE = `<native-mode-compatibility>
The requested Hyperplan adversarial team workflow requires OMO Team mode. Set team_mode.enabled: true in the OMO configuration and restart OpenCode. Do not load Hyperplan team instructions or claim that team orchestration ran while Team mode is disabled.
If Ultrawork was also explicitly requested, continue its independent protocol while making clear that the Hyperplan team portion is unavailable.
</native-mode-compatibility>`

type ContextMode = {
	ultrawork: boolean
	hyperplan: boolean
	hyperplanUltrawork: boolean
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
	const mode: ContextMode = { ultrawork: false, hyperplan: false, hyperplanUltrawork: false, team: false }
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
	const planner = isPlannerAgent(agent)
	mode.ultrawork = !planner && detected.some((item) => item.type === "ultrawork" || item.type === "hyperplan-ultrawork")
	mode.hyperplan = !planner && detected.some((item) => item.type === "hyperplan" || item.type === "hyperplan-ultrawork")
	mode.hyperplanUltrawork = !planner && detected.some((item) => item.type === "hyperplan-ultrawork")
	mode.team = detected.some((item) => item.type === "team")
	return mode
}

function getModePrompt(mode: ContextMode, agent: string, model: string, teamModeAvailable: boolean): string[] {
	const prompts: string[] = []
	if (mode.hyperplanUltrawork && teamModeAvailable) {
		prompts.push(getHyperplanUltraworkMessage(agent, model))
	} else {
		if (mode.hyperplan) prompts.push(teamModeAvailable ? V2_HYPERPLAN_MODE_PROMPT : HYPERPLAN_UNAVAILABLE_MESSAGE)
		if (mode.ultrawork) prompts.push(getUltraworkMessage(agent, model))
	}
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
export async function registerV2ContextHooks(ctx: Plugin.Context, config: OhMyOpenCodeConfig, options: {
	resolveLogicalParent?: VerifiedLogicalParentResolver
	teamModeAvailable?: boolean
} = {}): Promise<() => Promise<void>> {
	const modes = new Map<string, ContextMode>()
	const loggedSettingsErrors = new Set<string>()
	const delegationSettings = createV2DelegationSettings(ctx.storage, ctx.location)
	const keywordDetectorEnabled = !config.disabled_hooks?.includes("keyword-detector")
	// A config flag or a same-named external tool does not prove OMO ownership.
	// Setup sets this only after the native manager has started successfully.
	const teamModeAvailable = options.teamModeAvailable === true && config.team_mode?.enabled === true
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
			const current = modes.get(input.sessionID) ?? { ultrawork: false, hyperplan: false, hyperplanUltrawork: false, team: false }
			const detected = detectKeywordsWithType(
				removeSystemReminders(text),
				undefined,
				undefined,
				config.keyword_detector?.disabled_keywords as KeywordType[] | undefined,
				config.keyword_detector?.enabled_expansions as KeywordType[] | undefined,
			)
			const explicitUltrawork = detected.some((item) => item.type === "ultrawork" || item.type === "hyperplan-ultrawork")
			const explicitHyperplan = detected.some((item) => item.type === "hyperplan" || item.type === "hyperplan-ultrawork")
			const explicitHyperplanUltrawork = detected.some((item) => item.type === "hyperplan-ultrawork")
			const explicitTeam = detected.some((item) => item.type === "team")
			remembers(input.sessionID, {
				ultrawork: current.ultrawork || explicitUltrawork || config.default_mode?.ultrawork === true,
				hyperplan: current.hyperplan || explicitHyperplan,
				hyperplanUltrawork: current.hyperplanUltrawork || explicitHyperplanUltrawork,
				team: current.team || explicitTeam,
				lastPrompt: text,
			})
		})

		contextRegistration = await ctx.session.hook("context", async (input: SessionContext) => {
		applyDisabledTools(input, config)
		const agent = String(input.agent)
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
		const session = await ctx.session.get({ sessionID: input.sessionID })
		const sessionInLocation = isV2DelegationSessionInLocation(session, ctx.location)
		const parentSessionID = session.parentID ?? (sessionInLocation
			? await options.resolveLogicalParent?.(session.id) : undefined)
		if (parentSessionID && session.agent === agent && sessionInLocation &&
			typeof input.model.providerID === "string" && typeof input.model.id === "string") {
			let stored
			try {
				stored = await delegationSettings.read(input.sessionID, {
					parentSessionID,
					agentID: agent,
					model: {
						providerID: input.model.providerID,
						id: input.model.id,
						...(input.model.variant ? { variant: input.model.variant } : {}),
					},
				})
			} catch (error) {
				throw new Error(`Could not read durable delegated model settings for ${input.sessionID}; refusing to send a request with downgraded settings.`, { cause: error })
			}
			if (stored) {
				for (const [key, value] of Object.entries(stored.settings)) {
					if (key === "reasoningEffort" && value === null) delete input.options[key]
					else input.options[key] = value
				}
			}
		}
		// Request settings belong to the selected native agent, including host
		// agents and OMO custom agents with names like `api-builder`. Keep only
		// keyword-mode routing scoped to OpenCode's exact built-in IDs.
		// A delegated native child or a location-verified logical Team member keeps
		// its durable settings above, but never inherits root keyword/default modes.
		if (session.parentID || (sessionInLocation && parentSessionID)) return
		if (NATIVE_AGENTS_WITHOUT_OMO_KEYWORD_MODES.has(agent.toLowerCase())) return
		const model = String(input.model.id)
		const text = latestUserText(input.messages) ?? modes.get(input.sessionID)?.lastPrompt
		if (!text || isSystemDirective(text) || SLASH_COMMAND.test(text)) return
		const detected = keywordModes(text, agent, model, config)
		const previous = modes.get(input.sessionID) ?? { ultrawork: false, hyperplan: false, hyperplanUltrawork: false, team: false }
		const planner = isPlannerAgent(agent)
		const mode: ContextMode = {
			ultrawork: !planner && (previous.ultrawork || detected.ultrawork || (keywordDetectorEnabled && config.default_mode?.ultrawork === true)),
			hyperplan: !planner && (previous.hyperplan || detected.hyperplan),
			hyperplanUltrawork: !planner && (previous.hyperplanUltrawork || detected.hyperplanUltrawork),
			team: previous.team || detected.team,
			lastPrompt: text,
		}
		remembers(input.sessionID, mode)
		const existing = systemText(input.system)
		for (const prompt of getModePrompt(mode, agent, model, teamModeAvailable)) {
			if (!existing.includes(prompt)) input.system.push({ type: "text", text: prompt })
		}
		// Legacy team-mode-status-injector: a turn that asks for Team mode also gets the closure invariant.
		if (detected.team && teamModeAvailable && !existing.includes(TEAM_MODE_STATUS_MARKER)) {
			input.system.push({ type: "text", text: TEAM_MODE_STATUS })
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
