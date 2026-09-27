import type { Plugin } from "@opencode/plugin"
import type { OhMyOpenCodeConfig } from "../config"
import { registerV2ContextHooks } from "./context-hooks"
import { registerV2InstructionHooks } from "./instruction-hooks"
import { isV2ContinuationStopped, registerV2LifecycleHooks } from "./lifecycle"
import { registerV2RecoveryHooks } from "./recovery-hooks"
import { registerV2SafetyHooks } from "./safety-hooks"
import { registerV2ToolHooks } from "./tool-hooks"
import { registerV2BackgroundToolPolicy } from "./background-tool-policy"
import { getV2SubagentRunState } from "./task-state"
import { registerV2TodoDescriptionOverride } from "./todo-description-override"
import { registerV2PlanFormatValidator } from "./plan-format-validator"
import { registerV2AgentUsageReminder } from "./agent-usage-reminder"
import { registerV2ConversationAdvisoryHooks } from "./conversation-advisory-hooks"
import { registerV2ThinkModeHook } from "./think-mode"
import { registerV2ClaudeHooks } from "./claude-hooks"
import { registerV2RuntimeFallback } from "./runtime-fallback"
import type { VerifiedLogicalParentResolver } from "./background-admission"

async function unwind(cleanups: Array<() => Promise<void>>): Promise<unknown[]> {
	const errors: unknown[] = []
	for (const cleanup of cleanups.reverse()) {
		try {
			await cleanup()
		} catch (error) {
			errors.push(error)
		}
	}
	return errors
}

/** Register all native context, tool, and lifecycle hooks in dependency order. */
export async function registerV2Hooks(ctx: Plugin.Context, config: OhMyOpenCodeConfig, options: {
	resolveLogicalParent?: VerifiedLogicalParentResolver
	teamModeAvailable?: boolean
} = {}): Promise<() => Promise<void>> {
	const cleanups: Array<() => Promise<void>> = []
	let closing = false
	try {
		cleanups.push(await registerV2ContextHooks(ctx, config, options))
		cleanups.push(await registerV2ThinkModeHook(ctx, config))
		// Claude input rewrites must precede OMO's path and tool safety checks.
		const claudeHooks = await registerV2ClaudeHooks(ctx, config, options)
		cleanups.push(claudeHooks.cleanup)
		cleanups.push(await registerV2ToolHooks(ctx, config))
		cleanups.push(await registerV2TodoDescriptionOverride(ctx, config))
		cleanups.push(await registerV2PlanFormatValidator(ctx, config))
		cleanups.push(await registerV2AgentUsageReminder(ctx, config))
		cleanups.push(await registerV2ConversationAdvisoryHooks(ctx, config))
		cleanups.push(await registerV2SafetyHooks(ctx, config))
		cleanups.push(await registerV2InstructionHooks(ctx, config))
		cleanups.push(await registerV2RecoveryHooks(ctx, config))
		const backgroundToolPolicy = await registerV2BackgroundToolPolicy(ctx, config, getV2SubagentRunState(ctx.storage), options.resolveLogicalParent)
		cleanups.push(() => backgroundToolPolicy.cleanup())
		cleanups.push(await registerV2LifecycleHooks(ctx, config, {
			resolveLogicalParent: options.resolveLogicalParent,
			beforeContinuation: config.claude_code?.hooks === false || config.disabled_hooks?.includes("claude-code-hooks")
				? undefined : claudeHooks.beforeContinuation,
			onSessionDeleted: (sessionID) => backgroundToolPolicy.forget(sessionID),
		}))
		// Pending recovery can resume a session immediately. Install the workflow
		// coordinator and its durable stop store before restoring those deliveries.
		cleanups.push(await registerV2RuntimeFallback(ctx, config, {
			resolveLogicalParent: options.resolveLogicalParent,
			isStopped: (sessionID) => closing || isV2ContinuationStopped(ctx, sessionID),
		}))
	} catch (error) {
		closing = true
		const cleanupErrors = await unwind(cleanups)
		if (cleanupErrors.length > 0) {
			throw new AggregateError([error, ...cleanupErrors], "V2 hook registration failed and cleanup was incomplete")
		}
		throw error
	}

	let disposed = false
	return async () => {
		if (disposed) return
		disposed = true
		closing = true
		const errors = await unwind(cleanups)
		if (errors.length > 0) throw new AggregateError(errors, "One or more V2 hook registrations failed to clean up")
	}
}
