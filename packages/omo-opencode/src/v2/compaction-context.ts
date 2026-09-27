import type { Plugin } from "@opencode/plugin"
import type { VerifiedLogicalParentResolver } from "./background-admission"
import { createV2DelegationSettings } from "./delegation-settings"
import { readSessionHistory } from "./session-history"
import { getV2SubagentRunState } from "./task-state"
import type { FinalWaveWait } from "./workflow-policy"

const MAX_DELEGATED_ENTRIES = 20
const MAX_REVIEWER_EXCERPTS = 8
const MAX_DESCRIPTION_CHARS = 240
const MAX_EXCERPT_CHARS = 400
const MAX_DELEGATED_TOTAL_CHARS = 6_000
const REVIEWER_AGENTS = new Set(["momus", "oracle", "metis"])

/**
 * OMO additions to the host summary request. The host appends its own template after hooks run and
 * rejects summaries without its headings, so this guidance extends those sections instead of
 * replacing them (legacy COMPACTION_CONTEXT_PROMPT sections 1-8).
 */
export const V2_COMPACTION_GUIDANCE = `<omo_compaction_guidance>
Keep the required summary headings. Within them, also preserve this Oh My OpenAgent continuity state:
- User requests: the latest unresolved user requests and any earlier request still affecting the work; quote exact wording only when a later agent needs the literal phrase.
- Explicit constraints: only constraints the user stated or AGENTS.md context actually contains, quoted verbatim. Do not invent or modify constraints; write "None" if there are none.
- Agent verification state: the current agent, what has already been verified or validated, pending verifications, previous reviewer rejections and their reasons, and the current acceptance status. This is critical for reviewer agents (Momus, Oracle) and final-wave reviews.
- Delegated agent sessions that still matter: agent, category, status, short description and task_id. RESUME, DON'T RESTART: after compaction, continue existing delegated work with task(task_id="...") instead of spawning a new task, so its context is kept and work is not duplicated.
</omo_compaction_guidance>`

export type V2DelegatedSessionEntry = {
	readonly taskID: string
	readonly agent: string
	readonly status: string
	readonly description?: string
	readonly category?: string
	readonly latestResponse?: string
}

type SessionInfo = Awaited<ReturnType<Plugin.Context["session"]["get"]>>

function compactInline(value: string, maxChars: number): string {
	const normalized = value.replace(/[\n\r]+/g, " ").replace(/\s+/g, " ").replace(/`/g, "'").trim()
	if (normalized.length <= maxChars) return normalized
	const suffix = "... [truncated]"
	return `${normalized.slice(0, Math.max(0, maxChars - suffix.length)).trimEnd()}${suffix}`
}

function formatEntry(entry: V2DelegatedSessionEntry): string {
	return [
		`- **${compactInline(entry.agent, 80)}**`,
		entry.category ? ` [${compactInline(entry.category, 60)}]` : "",
		` (${entry.status})`,
		` task_id: \`${compactInline(entry.taskID, 120)}\``,
		entry.description ? `: ${compactInline(entry.description, MAX_DESCRIPTION_CHARS)}` : "",
		entry.latestResponse ? `\n  latest response: ${compactInline(entry.latestResponse, MAX_EXCERPT_CHARS)}` : "",
	].join("")
}

/** Newest-first within a character budget, mirroring the legacy task-history compaction format. */
export function formatV2DelegatedSessions(entries: readonly V2DelegatedSessionEntry[], omittedOlder = 0): string | undefined {
	if (entries.length === 0) return undefined
	const lines: string[] = []
	let length = 0
	let budgetOmitted = 0
	for (let index = entries.length - 1; index >= 0; index--) {
		const line = formatEntry(entries[index]!)
		const next = length + (lines.length === 0 ? 0 : 1) + line.length
		if (next > MAX_DELEGATED_TOTAL_CHARS) {
			budgetOmitted = index + 1
			break
		}
		lines.push(line)
		length = next
	}
	const omitted = omittedOlder + budgetOmitted
	if (omitted > 0) lines.push(`- ${omitted} older delegated sessions omitted to stay within the compaction budget.`)
	return lines.join("\n")
}

export function formatV2FinalWaveState(wait: FinalWaveWait | undefined): string | undefined {
	if (!wait) return undefined
	const status = wait.status === "approve"
		? "all final-wave reviewers approved; completion still requires the user's explicit approval"
		: wait.status === "reject"
			? "a final-wave reviewer rejected the work; address the rejection and rerun the review"
			: "a final-wave reviewer verdict is missing; obtain an explicit VERDICT before completion"
	return `<final_wave_review plan="${wait.planPath}" status="${wait.status}" expected_reviewers="${wait.expected}" approved_tasks="${wait.approvedTaskKeys.length}">\n${status}\n</final_wave_review>`
}

/** Children launched by OMO delegation for this parent, with native agent/status/title and reviewer excerpts. */
export async function readV2DelegatedSessions(
	ctx: Plugin.Context,
	parentSessionID: string,
	resolveLogicalParent?: VerifiedLogicalParentResolver,
): Promise<{ entries: V2DelegatedSessionEntry[]; omittedOlder: number }> {
	const runs = getV2SubagentRunState(ctx.storage)
	const settings = createV2DelegationSettings(ctx.storage, ctx.location)
	const childIDs = await runs.children(parentSessionID)
	const recent = childIDs.slice(-MAX_DELEGATED_ENTRIES)
	const entries: V2DelegatedSessionEntry[] = []
	let reviewerExcerpts = 0
	for (const childID of recent) {
		let session: SessionInfo
		try {
			session = await ctx.session.get({ sessionID: childID })
		} catch {
			continue
		}
		const parentID = session.parentID ?? await resolveLogicalParent?.(childID).catch(() => undefined)
		if (session.id !== childID || parentID !== parentSessionID) continue
		const run = await runs.get(childID)
		const agent = String(session.agent ?? "unknown")
		let category: string | undefined
		if (session.model?.providerID && session.model.id) {
			try {
				category = (await settings.read(childID, {
					parentSessionID,
					agentID: agent,
					model: {
						providerID: String(session.model.providerID),
						id: String(session.model.id),
						...(session.model.variant ? { variant: String(session.model.variant) } : {}),
					},
				}))?.originCategory
			} catch {
				category = undefined
			}
		}
		let latestResponse: string | undefined
		if (REVIEWER_AGENTS.has(agent.toLowerCase()) && reviewerExcerpts < MAX_REVIEWER_EXCERPTS) {
			try {
				const text = await readSessionHistory(ctx, childID)
				if (text && text !== "No assistant response is available yet.") {
					latestResponse = text
					reviewerExcerpts += 1
				}
			} catch {
				latestResponse = undefined
			}
		}
		const title = typeof session.title === "string" ? session.title : undefined
		entries.push({
			taskID: childID,
			agent,
			status: run?.status ?? session.outcome ?? "unknown",
			...(title ? { description: title } : {}),
			...(category ? { category } : {}),
			...(latestResponse ? { latestResponse } : {}),
		})
	}
	return { entries, omittedOlder: childIDs.length - recent.length }
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

function messageText(content: unknown): string {
	if (typeof content === "string") return content
	if (!Array.isArray(content)) return ""
	return content.flatMap((part) => isRecord(part) && typeof part.text === "string" ? [part.text] : []).join("\n")
}

/**
 * A request window follows a compaction when the host replays its text checkpoint (a user message
 * wrapped in `<conversation-checkpoint>`) or a provider-native checkpoint (a `compaction` content part).
 */
export function hasV2ConversationCheckpoint(messages: readonly unknown[]): boolean {
	return messages.some((message) => {
		if (!isRecord(message)) return false
		const content = message.content ?? message.parts
		if (Array.isArray(content) && content.some((part) => isRecord(part) && part.type === "compaction")) return true
		return message.role === "user" && messageText(content).trimStart().startsWith("<conversation-checkpoint>")
	})
}
