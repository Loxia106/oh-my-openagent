import type { Plugin } from "@opencode/plugin"
import type { SessionContext } from "@opencode/plugin/promise/session"
import { isClaudeAdaptiveThinkingOnlyModel } from "@oh-my-opencode/model-core"
import { getModelCapabilities } from "../shared/model-capabilities"
import { resolveCompatibleModelSettings } from "../shared/model-settings-compatibility"
import { log } from "../shared/logger"

const SAFE_MAX_OUTPUT_TOKENS_FALLBACK = 4096

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Port of the v1 chat-params compatibility pass. Agent request settings (for example Explore's temperature 0.1)
 * are computed for the model an agent was registered with, but the request can go to another model. Resolve the
 * final options against the capabilities of the model actually requested:
 * - drop `temperature`, `topP` and `thinking` the model does not support, clamp `maxTokens` to its output limit;
 * - adaptive-only Claude models (Opus 4.7+, Fable/Mythos, Claude 5 such as claude-sonnet-5) never get an explicit
 *   `thinking.type: "enabled"` budget;
 * - `reasoningEffort` is only downgraded within a known model's ladder. Unlike v1 it is kept for an unknown model
 *   family, because OpenCode routes it natively and the provider decides.
 */
export function applyV2ModelSettingsCompatibility(options: Record<string, unknown>, providerID: string, modelID: string): string[] {
	const removed: string[] = []
	if (isClaudeAdaptiveThinkingOnlyModel(modelID) && isRecord(options.thinking) && options.thinking.type === "enabled") {
		delete options.thinking
		removed.push("thinking")
	}
	const compatibility = resolveCompatibleModelSettings({
		providerID,
		modelID,
		desired: {
			reasoningEffort: typeof options.reasoningEffort === "string" ? options.reasoningEffort : undefined,
			temperature: typeof options.temperature === "number" ? options.temperature : undefined,
			topP: typeof options.topP === "number" ? options.topP : undefined,
			maxTokens: typeof options.maxTokens === "number" ? options.maxTokens : undefined,
			thinking: isRecord(options.thinking) ? options.thinking : undefined,
		},
		capabilities: getModelCapabilities({ providerID, modelID }),
	})
	for (const change of compatibility.changes) {
		if (change.field === "variant") continue
		if (change.field === "reasoningEffort" && change.reason === "unknown-model-family") continue
		removed.push(change.field)
		if (change.field === "reasoningEffort") {
			if (compatibility.reasoningEffort !== undefined) options.reasoningEffort = compatibility.reasoningEffort
			else delete options.reasoningEffort
		} else if (change.field === "maxTokens") {
			options.maxTokens = compatibility.maxTokens !== undefined && compatibility.maxTokens > 0 ? compatibility.maxTokens : SAFE_MAX_OUTPUT_TOKENS_FALLBACK
		} else {
			const value = compatibility[change.field]
			if (value !== undefined) options[change.field] = value
			else delete options[change.field]
		}
	}
	if (typeof options.maxTokens === "number" && options.maxTokens <= 0) {
		options.maxTokens = SAFE_MAX_OUTPUT_TOKENS_FALLBACK
		removed.push("maxTokens")
	}
	return [...new Set(removed)]
}

/** Register after every other context hook so it sees the final merged request options. */
export async function registerV2ModelSettingsGuard(ctx: Plugin.Context): Promise<() => Promise<void>> {
	const logged = new Set<string>()
	const registration = await ctx.session.hook("context", async (input: SessionContext) => {
		const providerID = typeof input.model?.providerID === "string" ? input.model.providerID : ""
		const modelID = typeof input.model?.id === "string" ? input.model.id : ""
		if (!modelID || !isRecord(input.options)) return
		const changed = applyV2ModelSettingsCompatibility(input.options as Record<string, unknown>, providerID, modelID)
		const key = `${providerID}/${modelID}:${changed.join(",")}`
		if (changed.length > 0 && !logged.has(key)) {
			logged.add(key)
			log(`[v2 model settings] Adjusted ${changed.join(", ")} for ${providerID}/${modelID}.`)
		}
	})
	return async () => { await registration.dispose() }
}
