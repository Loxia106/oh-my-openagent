import type { Plugin } from "@opencode/plugin"
import type { SessionContext } from "@opencode/plugin/promise/session"
import { isClaudeAdaptiveThinkingOnlyModel } from "@oh-my-opencode/model-core"
import { log } from "../shared/logger"

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Agent request settings are computed for the model an agent was registered with, but a session can run on
 * another model. Adaptive-only Claude models (Opus 4.7+, Fable/Mythos, the Claude 5 generation such as
 * claude-sonnet-5) reject an explicit `thinking.type: "enabled"` budget and a custom temperature. Drop both for
 * the model actually being requested; OpenCode core then applies adaptive thinking and effort from the variant.
 */
export function stripAdaptiveOnlyClaudeSettings(options: Record<string, unknown>, modelID: string): string[] {
	if (!isClaudeAdaptiveThinkingOnlyModel(modelID)) return []
	const removed: string[] = []
	if (isRecord(options.thinking) && options.thinking.type === "enabled") {
		delete options.thinking
		removed.push("thinking")
	}
	if (options.temperature !== undefined) {
		delete options.temperature
		removed.push("temperature")
	}
	return removed
}

/** Register after every other context hook so it sees the final merged request options. */
export async function registerV2ClaudeThinkingGuard(ctx: Plugin.Context): Promise<() => Promise<void>> {
	const logged = new Set<string>()
	const registration = await ctx.session.hook("context", async (input: SessionContext) => {
		const modelID = typeof input.model?.id === "string" ? input.model.id : ""
		if (!modelID || !isRecord(input.options)) return
		const removed = stripAdaptiveOnlyClaudeSettings(input.options as Record<string, unknown>, modelID)
		if (removed.length > 0 && !logged.has(modelID)) {
			logged.add(modelID)
			log(`[v2 claude] Removed ${removed.join(", ")} for adaptive-thinking-only model ${modelID}.`)
		}
	})
	return async () => { await registration.dispose() }
}
