import type { Plugin } from "@opencode/plugin"
import { loadV2Config } from "./config"
import { registerV2Hooks } from "./hooks"
import { registerV2Registries } from "./registry"
import { registerV2Tools } from "./tools"
import { registerV2Commands } from "./commands"
import { createV2TeamManager } from "./team-mode"
import { isV2ContinuationStopped } from "./lifecycle"
import { recordV2LocationHeartbeat } from "./team-mode/location-heartbeat"

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

/** Native OpenCode 2.0 setup entry; legacy server bootstrap remains in src/index.ts. */
export async function setupV2(ctx: Plugin.Context): Promise<() => Promise<void>> {
	const cleanups: Array<() => Promise<void>> = []
	let closing = false
	try {
		const config = loadV2Config(String(ctx.location.directory))
		cleanups.push(await registerV2Registries(ctx, config))
		const team = config.team_mode?.enabled ? createV2TeamManager(ctx, config) : undefined
		// The verified membership resolver must exist before admission restores
		// durable child leases. dispose is idempotent, including partial setup.
		if (team) cleanups.push(() => team.dispose())
		await team?.loadOwnership()
		const tools = await registerV2Tools(ctx, config, {
			team,
			isStopped: (sessionID) => closing || isV2ContinuationStopped(ctx, sessionID),
		})
		cleanups.push(tools.cleanup)
		cleanups.push(await registerV2Hooks(ctx, config, {
			resolveLogicalParent: team?.resolveLogicalParent,
			teamModeAvailable: team !== undefined,
		}))
		cleanups.push(await registerV2Commands(ctx, config))
		// Recovery may immediately prompt pending members. Install every hook
		// first, and stop those producers before tearing the hooks down.
		if (team) cleanups.push(() => team.dispose())
		await tools.startManagedSessions()
		await recordV2LocationHeartbeat(ctx, team !== undefined)
	} catch (error) {
		closing = true
		const cleanupErrors = await unwind(cleanups)
		if (cleanupErrors.length > 0) {
			throw new AggregateError([error, ...cleanupErrors], "V2 setup failed and cleanup was incomplete")
		}
		throw error
	}

	let disposed = false
	return async () => {
		if (disposed) return
		disposed = true
		closing = true
		const errors = await unwind(cleanups)
		if (errors.length > 0) throw new AggregateError(errors, "One or more V2 setup registrations failed to clean up")
	}
}
