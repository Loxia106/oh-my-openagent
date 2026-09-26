import type { Plugin } from "@opencode/plugin"
import type { OhMyOpenCodeConfig } from "../config"
import type { CommandDefinition as LegacyCommandDefinition } from "../features/claude-code-command-loader"
import { loadBuiltinCommands } from "../features/builtin-commands/commands"
import { findPrometheusPlans, normalizeSessionId, readBoulderState } from "../features/boulder-state"
import { parseGoalCommand } from "../hooks/goal/command-arguments"
import { GOAL_TEMPLATE } from "../features/builtin-commands/templates/goal"
import { buildUlwExecuteContextInfo } from "../hooks/ulw-execute/context-info-builder"
import { parseUserRequest } from "../hooks/ulw-execute/parse-user-request"
import { findRecentSessionPlanPathFromNativeMessages } from "../hooks/ulw-execute/session-plan-paths"
import { detectWorktreePath } from "../hooks/ulw-execute/worktree-detector"
import { createPrDeliveryBlock, createWorktreeActiveBlock } from "../hooks/ulw-execute/worktree-block"
import { log } from "../shared/logger"
import { getV2ContinuationState, getV2GoalController } from "./lifecycle"
import {
	createV2CommandDispatchGate,
	ensureV2SessionAgent,
	submitV2CommandNotice,
	submitV2CommandPrompt,
	type NativeCommandInvocation,
	type AssertV2CommandActive,
} from "./command-dispatch"

const CONTEXT_INFO_MARKER = "<!-- omo-ulw-execute-context -->"

export function expandCommandTemplate(template: string, input: NativeCommandInvocation, timestamp: string): string {
	const hasArgumentsPlaceholder = template.includes("$ARGUMENTS")
	const expanded = template.replace(/\$(ARGUMENTS|SESSION_ID|TIMESTAMP)/g, (placeholder) => {
		switch (placeholder) {
			case "$ARGUMENTS": return input.prompt.text
			case "$SESSION_ID": return input.sessionID
			case "$TIMESTAMP": return timestamp
			default: return placeholder
		}
	}).trim()
	if (hasArgumentsPlaceholder || !input.prompt.text.trim()) return expanded
	return `${expanded}\n\n${input.prompt.text.trim()}`.trim()
}

function availableAgentNames(result: Awaited<ReturnType<Plugin.Context["agent"]["list"]>>): Set<string> {
	return new Set(result.data.map((agent) => String(agent.id).toLowerCase()))
}

async function selectUlwAgent(ctx: Plugin.Context, assertActive: AssertV2CommandActive): Promise<string | undefined> {
	const agents = await ctx.agent.list()
	assertActive()
	const names = availableAgentNames(agents)
	if (names.has("atlas")) return "atlas"
	if (names.has("sisyphus")) return "sisyphus"
	return undefined
}

function worktreeContext(explicitPath: string | null): { path: string | undefined; block: string } {
	if (explicitPath === null) return { path: undefined, block: "" }
	const path = detectWorktreePath(explicitPath)
	if (path) return { path, block: createWorktreeActiveBlock(path) }
	return {
		path: undefined,
		block: `\n**Worktree** (needs setup): \`git worktree add ${explicitPath} <branch>\`, then add \`"worktree_path"\` to boulder.json`,
	}
}

async function buildUlwExecutePrompt(
	ctx: Plugin.Context,
	input: NativeCommandInvocation,
	command: LegacyCommandDefinition,
	activeAgent: string,
	timestamp: string,
	assertActive: AssertV2CommandActive,
): Promise<string> {
	const template = expandCommandTemplate(command.template ?? "", input, timestamp)
		.replace(
			"You are starting an Atlas work session.",
			activeAgent === "atlas" ? "You are starting an Atlas work session." : "You are starting a Sisyphus work session.",
		)
	const parsed = parseUserRequest(template)
	const { path: worktreePath, block } = worktreeContext(parsed.explicitWorktreePath)
	const worktreeBlock = block + createPrDeliveryBlock(
		{ makePr: parsed.makePr, ship: parsed.ship },
		worktreePath,
	)
	let preferredPlanPath: string | null = null
	if (!parsed.planName) {
		try {
			const messages = await ctx.session.context({ sessionID: input.sessionID })
			assertActive()
			preferredPlanPath = findRecentSessionPlanPathFromNativeMessages({
				directory: String(ctx.location.directory),
				messages,
				availablePlans: findPrometheusPlans(String(ctx.location.directory)),
			})
		} catch (error) {
			assertActive()
			log("[v2 command] Could not inspect native session history for a preferred plan.", {
				sessionID: input.sessionID,
				error: error instanceof Error ? error.message : String(error),
			})
		}
	}

	assertActive()
	const directory = String(ctx.location.directory)
	const contextInfo = buildUlwExecuteContextInfo({
		directory,
		explicitPlanName: parsed.planName,
		existingState: readBoulderState(directory),
		sessionId: normalizeSessionId(input.sessionID, "opencode"),
		timestamp,
		activeAgent,
		worktreePath,
		worktreeBlock,
		preferredPlanPath,
	})
	return `${template}\n\n---\n${CONTEXT_INFO_MARKER}\n${contextInfo}`
}

function goalStatusText(goal: ReturnType<ReturnType<typeof getV2GoalController>["getGoal"]>): string {
	if (!goal) return "There is no active goal for this session."
	return [
		`Active goal (${goal.status}): ${goal.objective}`,
		`Usage: ${goal.tokensUsed} tokens, ${goal.timeUsedSeconds} seconds.`,
	].join("\n")
}

function goalDisabled(config: OhMyOpenCodeConfig): boolean {
	return config.goal?.enabled !== true
}

async function executeGoalCommand(
	ctx: Plugin.Context,
	config: OhMyOpenCodeConfig,
	input: NativeCommandInvocation,
	assertActive: AssertV2CommandActive,
): Promise<void> {
	assertActive()
	const parsed = parseGoalCommand(input.prompt.text)
	if (goalDisabled(config) && (parsed.kind === "setObjective" || (parsed.kind === "setStatus" && parsed.status === "active"))) {
		await submitV2CommandNotice(ctx, input, "Goal work is disabled. Set `goal.enabled: true` in the OMO configuration before setting or resuming a goal.", assertActive)
		return
	}

	const sessionID = input.sessionID
	const controller = getV2GoalController(ctx)
	const continuation = getV2ContinuationState(ctx)
	const continuationNote = config.disabled_hooks?.includes("goal")
		? "\n\nAutomatic goal continuation is disabled by `disabled_hooks: [\"goal\"]`; this command starts only the current turn."
		: ""
	switch (parsed.kind) {
		case "show":
			await submitV2CommandNotice(ctx, input, goalStatusText(controller.getGoal(sessionID)), assertActive)
			return
		case "clear": {
			const cleared = controller.clearGoal(sessionID)
			await submitV2CommandNotice(ctx, input, cleared ? "The active goal was cleared for this session." : "There was no active goal to clear.", assertActive)
			return
		}
		case "setStatus": {
			if (parsed.status === "paused") {
				const goal = controller.pauseGoal(sessionID)
				await submitV2CommandNotice(ctx, input, goal ? "The goal is paused for this session." : "There is no active goal to pause.", assertActive)
				return
			}
			const goal = controller.resumeGoal(sessionID)
			if (!goal) {
				await submitV2CommandNotice(ctx, input, "There is no saved goal to resume. Set one with `/goal <objective>`.", assertActive)
				return
			}
			continuation.resume(sessionID)
			await submitV2CommandPrompt(ctx, input, `Continue working toward the active session goal. The goal is already resumed; do not replace it or reset its usage budget.\n\n${goal.objective}${continuationNote}`, undefined, assertActive)
			return
		}
		case "setObjective": {
			const goal = controller.setGoal(sessionID, parsed.objective)
			continuation.resume(sessionID)
			const goalGuidance = GOAL_TEMPLATE.slice(0, GOAL_TEMPLATE.indexOf("\n## Your Task"))
			const template = `<command-instruction>\n${goalGuidance}\n\n## Your Task\nThe goal has already been saved for this session. Begin working toward it now. Do not create or replace the goal again unless the user explicitly asks.\n</command-instruction>\n\n<user-task>\n${goal.objective}\n</user-task>${continuationNote}`
			await submitV2CommandPrompt(ctx, input, template, undefined, assertActive)
		}
	}
}

async function executeCommand(
	ctx: Plugin.Context,
	config: OhMyOpenCodeConfig,
	name: string,
	command: LegacyCommandDefinition,
	input: NativeCommandInvocation,
	assertActive: AssertV2CommandActive,
): Promise<void> {
	assertActive()
	if (name === "hyperplan") {
		await submitV2CommandNotice(ctx, input, "`/hyperplan` is unavailable in this OpenCode 2 adapter because the OMO team runtime is not implemented here.", assertActive)
		return
	}
	if (name === "stop-continuation") {
		const continuation = getV2ContinuationState(ctx)
		continuation.stop(input.sessionID)
		continuation.clearPending(input.sessionID)
		getV2GoalController(ctx).clearGoal(input.sessionID)
		await submitV2CommandNotice(ctx, input, "Continuation is stopped for this session and its goal was cleared. Project Boulder state and todos were preserved.", assertActive)
		return
	}
	if (name === "goal") {
		await executeGoalCommand(ctx, config, input, assertActive)
		return
	}
	if (name === "ulw-execute") {
		const agent = await selectUlwAgent(ctx, assertActive)
		assertActive()
		if (!agent) {
			await submitV2CommandNotice(ctx, input, "`/ulw-execute` needs the native `atlas` or `sisyphus` agent, but neither is registered.", assertActive)
			return
		}
		await ensureV2SessionAgent(ctx, input.sessionID, agent, assertActive)
		assertActive()
		if (config.disabled_hooks?.includes("ulw-execute")) {
			const template = expandCommandTemplate(command.template ?? "", input, new Date().toISOString())
			await submitV2CommandPrompt(ctx, input, template, undefined, assertActive)
			return
		}
		getV2ContinuationState(ctx).resume(input.sessionID)
		const prompt = await buildUlwExecutePrompt(ctx, input, command, agent, new Date().toISOString(), assertActive)
		assertActive()
		await submitV2CommandPrompt(ctx, input, prompt, undefined, assertActive)
		return
	}

	const expanded = expandCommandTemplate(command.template ?? "", input, new Date().toISOString())
	await submitV2CommandPrompt(ctx, input, expanded, undefined, assertActive)
}

/** Register the seven existing OMO builtin commands through OpenCode 2's command registry. */
export async function registerV2Commands(
	ctx: Plugin.Context,
	config: OhMyOpenCodeConfig,
): Promise<() => Promise<void>> {
	const commands = loadBuiltinCommands(config.disabled_commands, {
		useRegisteredAgents: false,
		teamModeEnabled: false,
	})
	const gate = createV2CommandDispatchGate()
	let active = true
	let registration: Awaited<ReturnType<typeof ctx.command.transform>>
	try {
		registration = await ctx.command.transform((editor) => {
			for (const command of Object.values(commands)) {
				editor.add({
					name: command.name,
					description: command.description,
					execute: async (input) => {
						if (!active) throw new Error("Native command registration has been disposed")
						const assertActive = () => {
							if (!active) throw new Error("Native command registration has been disposed")
						}
						return gate.run({ commandName: command.name, invocation: input }, () =>
							executeCommand(ctx, config, command.name, command, input, assertActive),
						)
					},
				})
			}
		})
	} catch (error) {
		gate.dispose()
		throw error
	}

	let cleanupPromise: Promise<void> | undefined
	return () => {
		cleanupPromise ??= (async () => {
			active = false
			gate.dispose()
			await registration.dispose()
		})()
		return cleanupPromise
	}
}
