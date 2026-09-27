import type { Plugin } from "@opencode/plugin"
import type { SessionContext } from "@opencode/plugin/promise/session"
import type { OhMyOpenCodeConfig } from "../config"
import { log } from "../shared/logger"

/** Same text the legacy validator stored on interrupted tool parts. */
export const INTERRUPTED_TOOL_ERROR = "[Tool execution was interrupted before it produced output]"

type Part = { type?: unknown; id?: unknown; name?: unknown; namespace?: unknown; providerExecuted?: unknown }
type MessageLike = { role?: unknown; content?: unknown }

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

function parts(message: unknown): Part[] {
	const content = isRecord(message) ? (message as MessageLike).content : undefined
	return Array.isArray(content) ? content.filter(isRecord) as Part[] : []
}

/**
 * Legacy `tool-pair-validator`: a tool call left without a result (for example a turn cut off by a
 * crash) is paired with an error result before the request is sent, so providers that require every
 * tool_use to have a tool_result do not reject the whole conversation. Durable history is unchanged.
 * Returns the repaired call IDs.
 */
export function repairV2ToolPairs(messages: unknown[]): string[] {
	const results = new Set<string>()
	for (const message of messages) {
		for (const part of parts(message)) {
			if (part.type === "tool-result" && typeof part.id === "string") results.add(part.id)
		}
	}
	const repaired: string[] = []
	for (let index = 0; index < messages.length; index++) {
		const message = messages[index]
		if (!isRecord(message) || message.role !== "assistant") continue
		const missing = parts(message).filter((part) => part.type === "tool-call" && part.providerExecuted !== true &&
			typeof part.id === "string" && !results.has(part.id))
		if (missing.length === 0) continue
		// Host messages are schema class instances; build replacements with the same constructor.
		const Ctor = (message as object).constructor as new (input: Record<string, unknown>) => unknown
		let insertAt = index + 1
		while (insertAt < messages.length && isRecord(messages[insertAt]) && (messages[insertAt] as MessageLike).role === "tool") insertAt++
		const synthesized = missing.map((part) => {
			const content = [{
				type: "tool-result",
				id: part.id,
				name: typeof part.name === "string" ? part.name : "unknown",
				...(typeof part.namespace === "string" ? { namespace: part.namespace } : {}),
				result: { type: "error", value: INTERRUPTED_TOOL_ERROR },
			}]
			results.add(part.id as string)
			repaired.push(part.id as string)
			return Ctor === Object ? { role: "tool", content } : new Ctor({ role: "tool", content })
		})
		messages.splice(insertAt, 0, ...synthesized)
		index = insertAt + synthesized.length - 1
	}
	return repaired
}

export async function registerV2ToolPairValidator(ctx: Plugin.Context, config: OhMyOpenCodeConfig): Promise<() => Promise<void>> {
	if (config.disabled_hooks?.includes("tool-pair-validator")) return async () => {}
	const registration = await ctx.session.hook("context", (input: SessionContext) => {
		const repaired = repairV2ToolPairs(input.messages as unknown[])
		if (repaired.length > 0) log("[v2 tool-pair-validator] Paired interrupted tool calls with error results.", { sessionID: input.sessionID, repaired })
	})
	return async () => { await registration.dispose() }
}
