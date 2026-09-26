import type { Plugin } from "@opencode/plugin"
import { Error as ToolError } from "@opencode/plugin/promise/tool"
import type { OhMyOpenCodeConfig } from "../config"

/** Visibility filtering is not an authorization boundary: block direct dispatch too. */
export async function registerV2DisabledToolGuard(
	ctx: Plugin.Context,
	config: OhMyOpenCodeConfig,
): Promise<() => Promise<void>> {
	const disabled = new Set((config.disabled_tools ?? []).map((name) => name.trim().toLowerCase()).filter(Boolean))
	if (disabled.size === 0) return async () => undefined
	const registration = await ctx.tool.hook("execute.before", (event) => {
		if (!disabled.has(event.tool.trim().toLowerCase())) return
		throw new ToolError({ message: `Tool "${event.tool}" is disabled by disabled_tools.` })
	})
	let disposed = false
	return async () => {
		if (disposed) return
		disposed = true
		await registration.dispose()
	}
}
