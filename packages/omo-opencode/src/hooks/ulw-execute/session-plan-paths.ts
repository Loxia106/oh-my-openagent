import { posix, win32 } from "node:path"

const PLAN_PATH_PATTERN = /[A-Za-z0-9_./\\:~-]*\.(?:sisyphus|omo)[\\/]plans[\\/][A-Za-z0-9._/\\~-]+\.md/gi

interface LegacySessionMessagePart {
	text?: string
	output?: string
	input?: Record<string, unknown>
}

interface LegacySessionMessage {
	parts?: LegacySessionMessagePart[]
}

function normalizePlanPath(directory: string, candidate: string): string {
	const trimmedCandidate = candidate.trim().replace(/^['"`]+|['"`]+$/g, "")
	if (looksLikeWindowsAbsolutePath(trimmedCandidate)) return win32.resolve(trimmedCandidate)
	if (looksLikeWindowsAbsolutePath(directory)) return win32.resolve(directory, trimmedCandidate)
	if (posix.isAbsolute(trimmedCandidate)) return posix.resolve(trimmedCandidate)
	return posix.resolve(directory, trimmedCandidate)
}

function normalizePlanPathKey(planPath: string): string {
	const resolvedPath = looksLikeWindowsAbsolutePath(planPath)
		? win32.resolve(planPath)
		: posix.resolve(planPath)
	return resolvedPath.replaceAll("\\", "/")
}

function looksLikeWindowsAbsolutePath(path: string): boolean {
	return /^[A-Za-z]:[\\/]/.test(path) || /^[/\\]{2}[^/\\]/.test(path)
}

function extractPlanPathsFromText(directory: string, text: string): string[] {
	return (text.match(PLAN_PATH_PATTERN) ?? []).map((match) => normalizePlanPath(directory, match))
}

function extractPlanPathsFromValue(directory: string, value: unknown): string[] {
	if (typeof value === "string") return extractPlanPathsFromText(directory, value)
	if (Array.isArray(value)) return value.flatMap((item) => extractPlanPathsFromValue(directory, item))
	if (value && typeof value === "object") {
		return Object.values(value).flatMap((item) => extractPlanPathsFromValue(directory, item))
	}
	return []
}

function extractPlanPathsFromInput(directory: string, input: Record<string, unknown> | undefined): string[] {
	if (!input) return []

	const nestedCandidates = Object.entries(input)
		.filter(([key]) => key !== "filePath" && key !== "path" && key !== "file")
		.flatMap(([, value]) => extractPlanPathsFromValue(directory, value))
	const directCandidates = [input.filePath, input.path, input.file]
		.filter((value): value is string => typeof value === "string")
		.flatMap((value) => extractPlanPathsFromText(directory, value))

	return [...new Set([...nestedCandidates, ...directCandidates])]
}

function firstAvailablePlan(
	directory: string,
	parts: readonly LegacySessionMessagePart[],
	availablePlansByKey: ReadonlyMap<string, string>,
): string | null {
	for (let partIndex = parts.length - 1; partIndex >= 0; partIndex -= 1) {
		const part = parts[partIndex]
		const candidates = [
			...extractPlanPathsFromText(directory, part.text ?? ""),
			...extractPlanPathsFromText(directory, part.output ?? ""),
			...extractPlanPathsFromInput(directory, part.input),
		]
		const matchedPlan = candidates
			.map((planPath) => availablePlansByKey.get(normalizePlanPathKey(planPath)))
			.find((planPath): planPath is string => planPath !== undefined)
		if (matchedPlan) return matchedPlan
	}
	return null
}

function createAvailablePlansIndex(availablePlans: readonly string[]): Map<string, string> {
	return new Map(availablePlans.map((planPath) => [normalizePlanPathKey(planPath), planPath]))
}

/**
 * V1 affinity: retain the historical message/part scan and candidate precedence exactly.
 * Native OpenCode 2 records have a different shape and use the explicit adapter below.
 */
export function findRecentSessionPlanPathFromMessages(input: {
	directory: string
	messages: readonly unknown[]
	availablePlans: readonly string[]
}): string | null {
	const availablePlansByKey = createAvailablePlansIndex(input.availablePlans)
	if (availablePlansByKey.size === 0) return null

	for (let messageIndex = input.messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
		const message = input.messages[messageIndex] as LegacySessionMessage | undefined
		const matchedPlan = firstAvailablePlan(input.directory, message?.parts ?? [], availablePlansByKey)
		if (matchedPlan) return matchedPlan
	}
	return null
}

type NativePart = {
	text?: string
	output?: string
	input?: Record<string, unknown>
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown>
		: undefined
}

function nativeMessageParts(messageValue: unknown): NativePart[] {
	const message = objectValue(messageValue)
	if (!message) return []

	if (message.type === "assistant" && Array.isArray(message.content)) {
		return message.content.flatMap((contentValue): NativePart[] => {
			const content = objectValue(contentValue)
			if (!content) return []
			if ((content.type === "text" || content.type === "reasoning") && typeof content.text === "string") {
				return [{ text: content.text }]
			}
			if (content.type !== "tool") return []

			const state = objectValue(content.state)
			if (!state) return []
			const nativeInput = objectValue(state.input)
			const output = Array.isArray(state.content)
				? state.content
					.filter((item) => objectValue(item)?.type === "text")
					.map((item) => objectValue(item)?.text)
					.filter((text): text is string => typeof text === "string")
					.join("\n")
				: ""
			return [{ ...(output ? { output } : {}), ...(nativeInput ? { input: nativeInput } : {}) }]
		})
	}

	if (["user", "synthetic", "system", "skill"].includes(String(message.type)) && typeof message.text === "string") {
		return [{ text: message.text }]
	}
	if (message.type === "shell" && typeof message.output === "string") return [{ output: message.output }]
	return []
}

/** Find the newest available plan referenced by public native SessionMessageInfo records. */
export function findRecentSessionPlanPathFromNativeMessages(input: {
	directory: string
	messages: readonly unknown[]
	availablePlans: readonly string[]
}): string | null {
	const availablePlansByKey = createAvailablePlansIndex(input.availablePlans)
	if (availablePlansByKey.size === 0) return null

	for (let messageIndex = input.messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
		const matchedPlan = firstAvailablePlan(input.directory, nativeMessageParts(input.messages[messageIndex]), availablePlansByKey)
		if (matchedPlan) return matchedPlan
	}
	return null
}
