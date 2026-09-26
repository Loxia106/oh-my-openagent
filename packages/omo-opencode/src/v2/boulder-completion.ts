import { createHash } from "node:crypto"
import { resolve } from "node:path"
import type { Plugin } from "@opencode/plugin"
import {
	completeBoulder,
	formatDurationHuman,
	getBoulderWorks,
	getPlanProgress,
	normalizeSessionId,
	readBoulderState,
	resolveBoulderPlanPathForWork,
	writeBoulderState,
	type BoulderWorkState,
} from "../features/boulder-state"
import { BOULDER_COMPLETE_PROMPT } from "../hooks/atlas/system-reminder-templates"
import { log } from "../shared/logger"
import { isCanonicallyAllowedMarkdown } from "./path-policy"

const COMPLETION_KEY_PREFIX = "oh-my-openagent:v2:boulder-completion:v1:"

type CompletionMarker = {
	version: 1
	workID: string
	sessionID: string
	syntheticID: string
	status: "pending" | "queued"
	queuedAt?: number
}

type Candidate = {
	work: BoulderWorkState
	marker?: CompletionMarker
	path: string
	workspace: string
}

export type BoulderCompletionResult = "not-applicable" | "handled" | "submitted"

function isSessionMember(work: BoulderWorkState, normalizedSessionID: string): boolean {
	return work.session_ids.some((id) => normalizeSessionId(id) === normalizedSessionID)
}

/** Statusless legacy mirror records are active only when they have no end time. */
export function isV2ActiveBoulderWork(work: BoulderWorkState): boolean {
	if (work.status === "active") return true
	return work.status === undefined && work.ended_at === undefined
}

function projectSessionPrefix(directory: string, sessionID: string): string {
	return `${COMPLETION_KEY_PREFIX}${encodeURIComponent(resolve(directory))}:${encodeURIComponent(sessionID)}:`
}

function markerKey(directory: string, workID: string, sessionID: string): string {
	return `${projectSessionPrefix(directory, sessionID)}${encodeURIComponent(workID)}`
}

function stableSyntheticID(directory: string, workID: string, sessionID: string): string {
	const digest = createHash("sha256")
		.update(`${resolve(directory)}\0${workID}\0${sessionID}`)
		.digest("hex")
	return `msg_omo_boulder_complete_${digest}`
}

function parseMarker(value: unknown, workID: string, sessionID: string, syntheticID: string): CompletionMarker | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
	const item = value as Record<string, unknown>
	if (
		item.version !== 1 ||
		item.workID !== workID ||
		item.sessionID !== sessionID ||
		item.syntheticID !== syntheticID ||
		(item.status !== "pending" && item.status !== "queued") ||
		(item.queuedAt !== undefined && typeof item.queuedAt !== "number")
	) return undefined
	return item as CompletionMarker
}

async function readMarker(
	ctx: Plugin.Context,
	directory: string,
	workID: string,
	sessionID: string,
): Promise<CompletionMarker | undefined> {
	const syntheticID = stableSyntheticID(directory, workID, sessionID)
	return parseMarker(
		await ctx.storage.get(markerKey(directory, workID, sessionID)),
		workID,
		sessionID,
		syntheticID,
	)
}

function completionPrompt(work: BoulderWorkState): string {
	const elapsedMilliseconds = work.elapsed_ms ?? (Date.now() - new Date(work.started_at).getTime())
	const elapsed = formatDurationHuman(elapsedMilliseconds)
	const taskBreakdown = Object.values(work.task_sessions ?? {})
		.sort((left, right) => {
			const leftValue = Number.parseInt(left.task_label.replace(/[^0-9]/g, ""), 10)
			const rightValue = Number.parseInt(right.task_label.replace(/[^0-9]/g, ""), 10)
			const leftSort = Number.isNaN(leftValue) ? Number.POSITIVE_INFINITY : leftValue
			const rightSort = Number.isNaN(rightValue) ? Number.POSITIVE_INFINITY : rightValue
			return leftSort - rightSort || left.task_label.localeCompare(right.task_label)
		})
		.map((task) => `- ${task.task_label} ${task.task_title}: ${typeof task.elapsed_ms === "number" ? formatDurationHuman(task.elapsed_ms) : "(no timing)"}`)
		.join("\n")
	const replacements = {
		PLAN_NAME: work.plan_name,
		ELAPSED_HUMAN: elapsed,
		TASK_BREAKDOWN: taskBreakdown || "- (no task timings)",
	}
	return BOULDER_COMPLETE_PROMPT.replace(/{(PLAN_NAME|ELAPSED_HUMAN|TASK_BREAKDOWN)}/g, (_match, key: keyof typeof replacements) => replacements[key])
}

function findExactWork(directory: string, sessionID: string, workID: string): BoulderWorkState | undefined {
	const state = readBoulderState(directory)
	if (!state) return undefined
	const normalizedSessionID = normalizeSessionId(sessionID)
	const work = getBoulderWorks(state).find((candidate) => candidate.work_id === workID)
	return work && isSessionMember(work, normalizedSessionID) ? work : undefined
}

function ensureAddressableWork(directory: string, sessionID: string, workID: string): boolean {
	const state = readBoulderState(directory)
	if (!state) return false
	if (state.works) return state.works[workID] !== undefined
	const work = getBoulderWorks(state).find((candidate) => candidate.work_id === workID)
	if (!work || !isSessionMember(work, normalizeSessionId(sessionID))) return false
	if (state.active_work_id && state.active_work_id !== workID) return false
	return writeBoulderState(directory, {
		...state,
		schema_version: 2,
		active_work_id: workID,
		works: { [workID]: work },
	})
}

function planLocation(directory: string, work: BoulderWorkState): { path: string; workspace: string } {
	return {
		path: resolveBoulderPlanPathForWork(directory, work),
		workspace: work.worktree_path ? resolve(directory, work.worktree_path) : directory,
	}
}

async function verifyCompletePlan(
	ctx: Plugin.Context,
	sessionID: string,
	workID: string,
	canProceed: () => boolean,
): Promise<Candidate | undefined> {
	const directory = String(ctx.location.directory)
	const work = findExactWork(directory, sessionID, workID)
	if (!work || !(isV2ActiveBoulderWork(work) || work.status === "completed")) return undefined
	const location = planLocation(directory, work)
	if (!(await isCanonicallyAllowedMarkdown(location.path, location.workspace))) return undefined
	if (!canProceed()) return undefined

	const freshWork = findExactWork(directory, sessionID, workID)
	if (!freshWork || !(isV2ActiveBoulderWork(freshWork) || freshWork.status === "completed")) return undefined
	const freshLocation = planLocation(directory, freshWork)
	if (freshLocation.path !== location.path || freshLocation.workspace !== location.workspace) return undefined
	const progress = getPlanProgress(freshLocation.path)
	if (!progress.isComplete) return undefined
	return { work: freshWork, ...freshLocation }
}

async function candidateForSession(
	ctx: Plugin.Context,
	sessionID: string,
	canProceed: () => boolean,
): Promise<{ candidate?: Candidate; handled: boolean }> {
	const directory = String(ctx.location.directory)
	const normalizedSessionID = normalizeSessionId(sessionID)
	const state = readBoulderState(directory)
	if (!state) return { handled: false }
	const members = getBoulderWorks(state).filter((work) => isSessionMember(work, normalizedSessionID))

	const completedPending: Array<{ work: BoulderWorkState; marker: CompletionMarker }> = []
	let hasQueuedCompletion = false
	for (const work of members) {
		if (work.status !== "completed") continue
		const marker = await readMarker(ctx, directory, work.work_id, normalizedSessionID)
		if (!canProceed()) return { handled: true }
		if (marker?.status === "pending") completedPending.push({ work, marker })
		else if (marker?.status === "queued") hasQueuedCompletion = true
	}
	if (completedPending.length > 1) {
		log("[v2 lifecycle] Multiple pending Boulder completion nudges match one session; skipping ambiguous recovery.", { sessionID })
		return { handled: true }
	}
	if (completedPending.length === 1) {
		const { work, marker } = completedPending[0]
		const candidate = await verifyCompletePlan(ctx, sessionID, work.work_id, canProceed)
		return candidate ? { candidate: { ...candidate, marker }, handled: true } : { handled: true }
	}

	const active = members.filter(isV2ActiveBoulderWork)
	if (active.length > 1) {
		log("[v2 lifecycle] Multiple active Boulder works match one session; skipping ambiguous completion.", { sessionID })
		return { handled: true }
	}
	if (active.length !== 1) return { handled: hasQueuedCompletion }

	const work = active[0]
	const marker = await readMarker(ctx, directory, work.work_id, normalizedSessionID)
	if (!canProceed()) return { handled: true }
	if (marker?.status === "queued") return { handled: true }
	const candidate = await verifyCompletePlan(ctx, sessionID, work.work_id, canProceed)
	return candidate ? { candidate: { ...candidate, marker }, handled: true } : { handled: false }
}

/** Complete only the exact successful session's checked plan and durably enqueue one nudge. */
export async function handleV2CompletedBoulder(
	ctx: Plugin.Context,
	sessionID: string,
	input: { signal: AbortSignal; isStopped: () => boolean },
): Promise<BoulderCompletionResult> {
	const canProceed = () => !input.signal.aborted && !input.isStopped()
	if (!canProceed()) return "handled"
	const directory = String(ctx.location.directory)
	const normalizedSessionID = normalizeSessionId(sessionID)
	const selected = await candidateForSession(ctx, sessionID, canProceed)
	if (!canProceed()) return "handled"
	if (!selected.candidate) return selected.handled ? "handled" : "not-applicable"

	let candidate = selected.candidate
	const key = markerKey(directory, candidate.work.work_id, normalizedSessionID)
	const syntheticID = stableSyntheticID(directory, candidate.work.work_id, normalizedSessionID)
	if (!candidate.marker) {
		const marker: CompletionMarker = {
			version: 1,
			workID: candidate.work.work_id,
			sessionID: normalizedSessionID,
			syntheticID,
			status: "pending",
		}
		if (!canProceed()) return "handled"
		await ctx.storage.set(key, marker)
		if (!canProceed()) return "handled"
		candidate = { ...candidate, marker }
	}

	const verified = await verifyCompletePlan(ctx, sessionID, candidate.work.work_id, canProceed)
	if (!canProceed()) return "handled"
	if (!verified) {
		log("[v2 lifecycle] Boulder completion changed before persistence; leaving its marker pending.", {
			sessionID,
			workID: candidate.work.work_id,
		})
		return "handled"
	}

	if (verified.work.status !== "completed") {
		if (!canProceed()) return "handled"
		if (!ensureAddressableWork(directory, sessionID, verified.work.work_id)) {
			log("[v2 lifecycle] Could not safely address legacy Boulder work for completion; leaving its nudge marker pending.", {
				sessionID,
				workID: verified.work.work_id,
			})
			return "handled"
		}
		const completed = completeBoulder(directory, verified.work.work_id)
		if (!completed) {
			log("[v2 lifecycle] Failed to persist completed Boulder; leaving its nudge marker pending.", {
				sessionID,
				workID: verified.work.work_id,
			})
			return "handled"
		}
		candidate = {
			...candidate,
			work: getBoulderWorks(completed).find((work) => work.work_id === verified.work.work_id) ?? verified.work,
		}
	} else if (verified.work.ended_at === undefined || verified.work.elapsed_ms === undefined) {
		if (!canProceed() || !ensureAddressableWork(directory, sessionID, verified.work.work_id)) return "handled"
		const completed = completeBoulder(directory, verified.work.work_id)
		if (!completed) return "handled"
		candidate = {
			...candidate,
			work: getBoulderWorks(completed).find((work) => work.work_id === verified.work.work_id) ?? verified.work,
		}
	}

	if (!canProceed()) return "handled"
	try {
		await ctx.session.synthetic({
			sessionID,
			id: syntheticID,
			text: completionPrompt(candidate.work),
			description: `Boulder complete: ${candidate.work.plan_name}`,
			metadata: { source: "oh-my-openagent:boulder-completion", workID: candidate.work.work_id },
			delivery: "queue",
			resume: true,
		})
	} catch (error) {
		log("[v2 lifecycle] Failed to enqueue Boulder completion nudge; it can retry on a later idle.", {
			sessionID,
			workID: candidate.work.work_id,
			error,
		})
		return "handled"
	}

	if (canProceed()) {
		try {
			await ctx.storage.set(key, {
				version: 1,
				workID: candidate.work.work_id,
				sessionID: normalizedSessionID,
				syntheticID,
				status: "queued",
				queuedAt: Date.now(),
			} satisfies CompletionMarker)
		} catch (error) {
			log("[v2 lifecycle] Completion nudge was admitted but its queued marker could not be saved; retries use the same synthetic ID.", {
				sessionID,
			workID: candidate.work.work_id,
				error,
			})
		}
	}
	return "submitted"
}
