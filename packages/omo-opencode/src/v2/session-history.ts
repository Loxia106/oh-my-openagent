import type { Plugin } from "@opencode/plugin"
import type { VerifiedLogicalParentResolver } from "./background-admission"

export type V2SessionStatus = "running" | "completed" | "failed" | "interrupted" | "unknown"

export type V2SessionHistoryOptions = {
  readonly fullSession?: boolean
  readonly includeThinking?: boolean
  readonly includeToolResults?: boolean
  readonly messageLimit?: number
  readonly sinceMessageID?: string
  readonly fromEnd?: boolean
  readonly thinkingMaxChars?: number
}

type AssistantContent = { type?: string; text?: string; state?: { status?: string; content?: Array<{ type?: string; text?: string }> } }
type SessionMessage = {
  id?: string
  type?: string
  text?: string
  content?: AssistantContent[]
}

/**
 * `Session.Info.outcome` and `time.idle` describe the last completed execution,
 * including when a session is resumed. Only call a run complete when its idle
 * timestamp is newer than the tracked admission time.
 */
export function sessionStatus(
  session: { outcome?: string; time?: { idle?: number } },
  runStartedAt?: number,
): V2SessionStatus {
  if (runStartedAt === undefined) return "unknown"
  const idle = session.time?.idle
  if (idle === undefined || idle < runStartedAt) return "running"
  if (session.outcome === "succeeded") return "completed"
  if (session.outcome === "failed") return "failed"
  if (session.outcome === "interrupted") return "interrupted"
  return "completed"
}

function textForMessage(message: SessionMessage, options: V2SessionHistoryOptions): string[] {
  if (message.type === "user") return typeof message.text === "string" ? [`user: ${message.text}`] : []
  if (message.type !== "assistant" || !Array.isArray(message.content)) return []

  const result: string[] = []
  for (const part of message.content) {
    if (part.type === "text" && typeof part.text === "string") {
      result.push(`assistant: ${part.text}`)
    } else if (part.type === "reasoning" && options.includeThinking && typeof part.text === "string") {
      const max = Math.max(0, options.thinkingMaxChars ?? 2000)
      result.push(`assistant reasoning: ${part.text.slice(0, max)}`)
    } else if (part.type === "tool" && options.includeToolResults && part.state?.status === "completed") {
      const content = part.state.content?.map((item) => item.text ?? "").filter(Boolean).join("\n")
      if (content) result.push(`tool result: ${content}`)
    }
  }
  return result
}

export async function readSessionHistory(
  ctx: Plugin.Context,
  sessionID: string,
  options: V2SessionHistoryOptions = {},
): Promise<string> {
  const messages = (await ctx.session.context({ sessionID })) as SessionMessage[]

  if (!options.fullSession) {
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index]
      if (message?.type !== "assistant") continue
      const finalText = (message.content ?? [])
        .filter((part) => part.type === "text" && typeof part.text === "string")
        .map((part) => part.text)
        .join("\n")
      if (finalText) return finalText
    }
    return "No assistant response is available yet."
  }

  let selected = messages
  if (options.sinceMessageID) {
    const index = selected.findIndex((message) => message.id === options.sinceMessageID)
    if (index < 0) return `Message ID not found in session history: ${options.sinceMessageID}`
    selected = selected.slice(index + 1)
  }
  const limit = Math.max(1, Math.min(200, options.messageLimit ?? 200))
  selected = options.fromEnd ? selected.slice(-limit) : selected.slice(0, limit)
  const lines = selected.flatMap((message) => textForMessage(message, options))
  return lines.length > 0 ? lines.join("\n\n") : "No session messages are available yet."
}

export async function readOwnedChildSession(
  ctx: Plugin.Context,
  parentSessionID: string,
  childSessionID: string,
  resolveLogicalParent?: VerifiedLogicalParentResolver,
): Promise<Awaited<ReturnType<Plugin.Context["session"]["get"]>>> {
  const session = await ctx.session.get({ sessionID: childSessionID })
  const actualParentID = session.parentID ?? await resolveLogicalParent?.(childSessionID)
  if (session.id !== childSessionID || actualParentID !== parentSessionID) {
    throw new Error(`Session ${childSessionID} is not a child of the current session`)
  }
  return session
}
