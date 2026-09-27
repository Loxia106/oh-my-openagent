import type { Plugin } from "@opencode/plugin"
import type { OhMyOpenCodeConfig } from "../config"
import { createAstGrepSgProvisionHook, type AstGrepSgProvisionDeps } from "../hooks/ast-grep-sg-provision/hook"
import { log } from "../shared/logger"

/**
 * Legacy `ast-grep-sg-provision`: on the first native session creation, install the pinned `sg` binary into
 * the OMO runtime directory in the background when it is missing, so the ast-grep skill and MCP can run.
 */
export async function registerV2AstGrepProvision(
	ctx: Plugin.Context,
	config: OhMyOpenCodeConfig,
	deps: Partial<AstGrepSgProvisionDeps> = {},
): Promise<() => Promise<void>> {
	if (config.disabled_hooks?.includes("ast-grep-sg-provision")) return async () => {}
	const hook = createAstGrepSgProvisionHook(deps)
	const controller = new AbortController()
	const events = (async () => {
		try {
			for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
				if (event.type === "session.created") hook.event({ event: { type: event.type } })
			}
		} catch (error) {
			if (!controller.signal.aborted) log("[v2 ast-grep-sg-provision] Event stream stopped.", error)
		}
	})()
	return async () => {
		controller.abort()
		await events
	}
}
