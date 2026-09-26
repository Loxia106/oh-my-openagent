import type { Plugin } from "@opencode/plugin"
import type { OhMyOpenCodeConfig } from "../config"
import { registerV2ContextHooks } from "./context-hooks"
import { registerV2InstructionHooks } from "./instruction-hooks"
import { registerV2LifecycleHooks } from "./lifecycle"
import { registerV2SafetyHooks } from "./safety-hooks"
import { registerV2ToolHooks } from "./tool-hooks"

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
export async function registerV2Hooks(ctx: Plugin.Context, config: OhMyOpenCodeConfig): Promise<() => Promise<void>> {
	const cleanups: Array<() => Promise<void>> = []
	try {
		cleanups.push(await registerV2ContextHooks(ctx, config))
		cleanups.push(await registerV2ToolHooks(ctx, config))
		cleanups.push(await registerV2SafetyHooks(ctx, config))
		cleanups.push(await registerV2InstructionHooks(ctx, config))
		cleanups.push(await registerV2LifecycleHooks(ctx, config))
	} catch (error) {
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
		const errors = await unwind(cleanups)
		if (errors.length > 0) throw new AggregateError(errors, "One or more V2 hook registrations failed to clean up")
	}
}
