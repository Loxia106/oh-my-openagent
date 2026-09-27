import type { Plugin } from "@opencode/plugin"
import type { OhMyOpenCodeConfig } from "../config"
import { TODOWRITE_DESCRIPTION } from "../hooks/todo-description-override/description"

function isDisabled(config: OhMyOpenCodeConfig): boolean {
	return config.disabled_hooks?.includes("todo-description-override") ?? false
}

/** Replace only the native todo tool description; the host schema and executor stay intact. */
export async function registerV2TodoDescriptionOverride(
	ctx: Plugin.Context,
	config: OhMyOpenCodeConfig,
): Promise<() => Promise<void>> {
	if (isDisabled(config)) return async () => undefined

	const registration = await ctx.tool.transform((editor) => {
		if (!editor.get("todowrite")) return
		editor.update("todowrite", (tool) => {
			tool.description = TODOWRITE_DESCRIPTION
		})
	})
	let disposed = false
	return async () => {
		if (disposed) return
		disposed = true
		await registration.dispose()
	}
}
