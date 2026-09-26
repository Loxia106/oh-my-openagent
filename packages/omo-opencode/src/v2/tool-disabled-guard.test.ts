import { describe, expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin"
import type { OhMyOpenCodeConfig } from "../config"
import { registerV2DisabledToolGuard } from "./tool-disabled-guard"

describe("native V2 disabled tool guard", () => {
	test("blocks direct execution of arbitrary disabled native tools", async () => {
		let before: ((event: any) => unknown) | undefined
		let disposed = false
		const ctx = {
			tool: {
				hook: async (_name: string, callback: (event: any) => unknown) => {
					before = callback
					return { dispose: async () => { disposed = true } }
				},
			},
		} as unknown as Plugin.Context
		const cleanup = await registerV2DisabledToolGuard(ctx, { disabled_tools: ["grep", "webfetch"] } as unknown as OhMyOpenCodeConfig)
		await expect(Promise.resolve().then(() => before?.({ tool: "webfetch" }))).rejects.toThrow('Tool "webfetch" is disabled by disabled_tools.')
		await expect(Promise.resolve().then(() => before?.({ tool: "grep" }))).rejects.toThrow('Tool "grep" is disabled by disabled_tools.')
		await expect(Promise.resolve().then(() => before?.({ tool: "read" }))).resolves.toBeUndefined()
		await cleanup()
		expect(disposed).toBe(true)
	})
})
