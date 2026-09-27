import type { Plugin } from "@opencode/plugin"
import type { SessionContext, SessionPrompt } from "@opencode/plugin/promise/session"
import type { OhMyOpenCodeConfig } from "../config"
import { detectThinkKeyword } from "../hooks/think-mode/detector"
import { isAlreadyHighVariant } from "../hooks/think-mode/switcher"
import { log } from "../shared/logger"
import { getV2SubagentRunState } from "./task-state"
import { isV2DelegationSessionInLocation } from "./delegation-settings"

type NativeModel = Awaited<ReturnType<Plugin.Context["model"]["list"]>>["data"][number]
type NativeVariant = NativeModel["variants"][number]

type PromptRecord = { readonly messageID: string; readonly text: string }

const PROMPT_STATE_LIMIT = 256
const TERMINAL_EXECUTION_EVENTS = new Set([
	"session.execution.succeeded",
	"session.execution.failed",
	"session.execution.interrupted",
	"session.deleted",
])
const SLASH_COMMAND = /^\s*\/[a-zA-Z][\w-]*(?:\s|$)/

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Team metadata is a conservative ancestry hint only. Authorization and
 * membership still require the durable Team membership store.
 */
function hasV2TeamMetadataHint(metadata: unknown): boolean {
	if (!isRecord(metadata)) return false
	const team = metadata.omoTeam
	return isRecord(team) && team.version === 1 && typeof team.teamRunId === "string"
}

function agentOverride(config: OhMyOpenCodeConfig, name: string): Record<string, unknown> | undefined {
	const agents = config.agents as Record<string, unknown> | undefined
	const value = agents?.[name] ?? Object.entries(agents ?? {}).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1]
	return isRecord(value) ? value : undefined
}

function categoryOverride(config: OhMyOpenCodeConfig, name: unknown): Record<string, unknown> | undefined {
	if (typeof name !== "string") return undefined
	const categories = config.categories as Record<string, unknown> | undefined
	const value = categories?.[name] ?? Object.entries(categories ?? {}).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1]
	return isRecord(value) ? value : undefined
}

function explicitVariant(override: Record<string, unknown> | undefined, category: Record<string, unknown> | undefined): boolean {
	return override?.variant !== undefined || override?.reasoning !== undefined ||
		category?.variant !== undefined || category?.reasoning !== undefined
}

function explicitOptionKeys(
	override: Record<string, unknown> | undefined,
	category: Record<string, unknown> | undefined,
): Set<string> {
	const keys = new Set<string>()
	const fields: ReadonlyArray<readonly [string, string]> = [
		["temperature", "temperature"],
		["top_p", "topP"],
		["topP", "topP"],
		["maxTokens", "maxTokens"],
		["max_tokens", "maxTokens"],
		["reasoningEffort", "reasoningEffort"],
		["textVerbosity", "textVerbosity"],
		["thinking", "thinking"],
	]
	for (const source of [override, category]) {
		if (!source) continue
		for (const [field, option] of fields) if (source[field] !== undefined) keys.add(option)
		for (const key of Object.keys(isRecord(source.providerOptions) ? source.providerOptions :
			isRecord(source.provider_options) ? source.provider_options : {})) keys.add(key)
	}
	return keys
}

function highVariant(model: NativeModel): NativeVariant | undefined {
	return model.variants.find((variant) => String(variant.id) === "high")
}

function promptRecordFrom(event: SessionPrompt): PromptRecord {
	return { messageID: String(event.messageID), text: event.prompt.text }
}

function latestUserMessageID(messages: SessionContext["messages"]): string | undefined {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index] as { role?: unknown; id?: unknown }
		if (message?.role === "user" && typeof message.id === "string") return message.id
	}
	return undefined
}

function eventSessionID(event: unknown): string | undefined {
	if (!isRecord(event) || !isRecord(event.data)) return undefined
	return typeof event.data.sessionID === "string" ? event.data.sessionID : undefined
}

function hasUnsupportedOverlays(variant: NativeVariant): boolean {
	return (isRecord(variant.headers) && Object.keys(variant.headers).length > 0) ||
		(isRecord(variant.body) && Object.keys(variant.body).length > 0)
}

async function applyThinkMode(input: SessionContext, ctx: Plugin.Context, config: OhMyOpenCodeConfig, prompt: PromptRecord | undefined, current: () => boolean, reportedOverlays: Set<string>): Promise<void> {
	if (!current() || !prompt || latestUserMessageID(input.messages) !== prompt.messageID || !detectThinkKeyword(prompt.text)) return
	if (config.disabled_hooks?.includes("think-mode")) return
	if (SLASH_COMMAND.test(prompt.text)) return
	if (input.model.variant && String(input.model.variant) !== "default") return
	if (isAlreadyHighVariant(String(input.model.id))) return

	let session: Awaited<ReturnType<Plugin.Context["session"]["get"]>>
	try {
		session = await ctx.session.get({ sessionID: input.sessionID })
	} catch {
		return
	}
	if (!current() || session.agent !== input.agent || !isV2DelegationSessionInLocation(session, ctx.location) ||
		session.parentID || hasV2TeamMetadataHint(session.metadata)) return

	let run
	try {
		run = await getV2SubagentRunState(ctx.storage).get(input.sessionID)
	} catch (error) {
		log("[v2 think-mode] Could not verify session ownership; skipping the request-local high variant.", {
			sessionID: input.sessionID,
			error: error instanceof Error ? error.message : String(error),
		})
		return
	}
	if (!current() || run) return

	let agent
	try {
		agent = (await ctx.agent.get({ agentID: String(input.agent) })).data
	} catch {
		return
	}
	if (!current() || (agent.mode !== "primary" && agent.mode !== "all")) return

	const override = agentOverride(config, String(input.agent))
	const category = categoryOverride(config, override?.category)
	if (explicitVariant(override, category)) return
	const explicitOptions = explicitOptionKeys(override, category)

	let catalog: NativeModel[]
	try {
		catalog = (await ctx.model.list()).data
	} catch (error) {
		log("[v2 think-mode] Could not read the native model catalog; skipping the high variant.", {
			sessionID: input.sessionID,
			error: error instanceof Error ? error.message : String(error),
		})
		return
	}
	if (!current()) return
	const selected = catalog.find((model) => String(model.providerID) === String(input.model.providerID) &&
		String(model.id) === String(input.model.id))
	if (!selected) return
	const variant = highVariant(selected)
	if (!variant || !isRecord(variant.settings)) return
	const settings = variant.settings
	const collisions = Object.keys(settings).filter((key) => explicitOptions.has(key))
	if (collisions.length > 0) return

	if (hasUnsupportedOverlays(variant)) {
		const key = `${input.model.providerID}/${input.model.id}#high`
		if (!reportedOverlays.has(key)) {
			reportedOverlays.add(key)
			log(`[v2 think-mode] The high variant for ${key} includes headers/body overlays; native context hooks can apply settings only.`, {
				providerID: String(input.model.providerID),
				modelID: String(input.model.id),
				unsupported: [
					...(isRecord(variant.headers) && Object.keys(variant.headers).length > 0 ? ["headers"] : []),
					...(isRecord(variant.body) && Object.keys(variant.body).length > 0 ? ["body"] : []),
				],
			})
		}
	}
	if (!current()) return
	Object.assign(input.options, settings)
}

/** Register request-local think-mode settings for real primary prompts only. */
export async function registerV2ThinkModeHook(
	ctx: Plugin.Context,
	config: OhMyOpenCodeConfig,
): Promise<() => Promise<void>> {
	if (config.disabled_hooks?.includes("think-mode")) return async () => undefined

	const prompts = new Map<string, PromptRecord>()
	const reportedOverlays = new Set<string>()
	const controller = new AbortController()
	let active = true
	let promptRegistration: Awaited<ReturnType<typeof ctx.session.hook>> | undefined
	let contextRegistration: Awaited<ReturnType<typeof ctx.session.hook>> | undefined
	let eventTask: Promise<void> | undefined
	const remember = (sessionID: string, value: PromptRecord) => {
		if (prompts.has(sessionID)) prompts.delete(sessionID)
		while (prompts.size >= PROMPT_STATE_LIMIT) prompts.delete(prompts.keys().next().value as string)
		prompts.set(sessionID, value)
	}
	const dispose = async () => {
		if (!active) return
		active = false
		prompts.clear()
		reportedOverlays.clear()
		controller.abort()
		const errors: unknown[] = []
		try { await eventTask } catch (error) { errors.push(error) }
		for (const registration of [contextRegistration, promptRegistration]) {
			try { await registration?.dispose() } catch (error) { errors.push(error) }
		}
		if (errors.length > 0) throw new AggregateError(errors, "V2 think-mode cleanup failed")
	}

	try {
		promptRegistration = await ctx.session.hook("prompt", (input: SessionPrompt) => {
			if (!active || !input.prompt.text.trim()) return
			remember(String(input.sessionID), promptRecordFrom(input))
		})
		contextRegistration = await ctx.session.hook("context", (input: SessionContext) => {
			const sessionID = String(input.sessionID)
			const prompt = prompts.get(sessionID)
			return applyThinkMode(
				input,
				ctx,
				config,
				prompt,
				() => active && prompt !== undefined && prompts.get(sessionID) === prompt,
				reportedOverlays,
			)
		})
		eventTask = (async () => {
			try {
				for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
					if (!active || !TERMINAL_EXECUTION_EVENTS.has(event.type)) continue
					const sessionID = eventSessionID(event)
					if (sessionID) prompts.delete(sessionID)
				}
			} catch (error) {
				if (active && !controller.signal.aborted) {
					prompts.clear()
					log("[v2 think-mode] Native execution event stream stopped; clearing prompt state.", error)
				}
			}
		})()
	} catch (error) {
		await dispose()
		throw error
	}

	return dispose
}
