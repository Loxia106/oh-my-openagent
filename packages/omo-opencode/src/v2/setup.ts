import type { Plugin } from "@opencode/plugin"
import { loadV2Config } from "./config"
import { registerV2Hooks } from "./hooks"
import { registerV2Registries } from "./registry"
import { registerV2Tools } from "./tools"
import { registerV2Commands } from "./commands"
import { log } from "../shared/logger"

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
	try {
		const config = loadV2Config(String(ctx.location.directory))
		let nativeConfig = config
		if (config.team_mode?.enabled) {
			log("[v2 setup] Team mode is disabled in OpenCode 2 because the native OMO team manager is not implemented yet.")
			nativeConfig = { ...config, team_mode: { ...config.team_mode, enabled: false } }
		}
		cleanups.push(await registerV2Registries(ctx, nativeConfig))
		cleanups.push(await registerV2Tools(ctx, nativeConfig))
		cleanups.push(await registerV2Hooks(ctx, nativeConfig))
		cleanups.push(await registerV2Commands(ctx, nativeConfig))
	} catch (error) {
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
		const errors = await unwind(cleanups)
		if (errors.length > 0) throw new AggregateError(errors, "One or more V2 setup registrations failed to clean up")
	}
}
