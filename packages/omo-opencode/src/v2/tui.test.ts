import { describe, expect, mock, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Context as TuiContext } from "@opencode/plugin/tui/plugin"
import { btwQuestion, setupV2Tui } from "./tui"

describe("native OpenCode 2 TUI helpers", () => {
	test("accepts slash-command arguments and full BTW drafts", () => {
		expect(btwQuestion("What changed in this branch?")).toBe("What changed in this branch?")
		expect(btwQuestion("/omo-btw What changed in this branch?")).toBe("What changed in this branch?")
		expect(btwQuestion("  /side  inspect the tests  ")).toBe("inspect the tests")
	})

	test("leaves an empty command for the prompt dialog", () => {
		expect(btwQuestion(undefined)).toBe("")
		expect(btwQuestion("/omo-btw")).toBe("")
	})

	test("does not claim the host's native /btw command", () => {
		expect(btwQuestion("/btw keep OpenCode's native command")).toBe("/btw keep OpenCode's native command")
	})

	test("unregisters command notices when a later TUI slot registration throws", async () => {
		const directory = await mkdtemp(join(tmpdir(), "omo-v2-tui-setup-"))
		const envKeys = ["HOME", "XDG_CONFIG_HOME", "OMO_HOME", "OPENCODE_CONFIG_DIR", "OCX_PROFILE", "OMO_PROFILE"] as const
		const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]])) as Record<typeof envKeys[number], string | undefined>
		const isolatedHome = join(directory, "home")
		const isolatedXdgConfig = join(directory, "xdg-config")
		const isolatedOmoHome = join(directory, "omo-home")
		const isolatedOpenCodeConfig = join(directory, "opencode-config")
		const unlisten = mock(() => undefined)
		const context = {
			location: { directory },
			data: {
				on: () => unlisten,
				location: { default: () => ({ directory }) },
			},
			client: { session: {} },
			ui: {
				slot: () => { throw new Error("slot registration failed") },
			},
		} as unknown as TuiContext

		try {
			process.env.HOME = isolatedHome
			process.env.XDG_CONFIG_HOME = isolatedXdgConfig
			process.env.OMO_HOME = isolatedOmoHome
			process.env.OPENCODE_CONFIG_DIR = isolatedOpenCodeConfig
			delete process.env.OCX_PROFILE
			delete process.env.OMO_PROFILE
			await Promise.all([isolatedHome, isolatedXdgConfig, isolatedOmoHome, isolatedOpenCodeConfig]
				.map((path) => mkdir(path, { recursive: true })))
			await expect(setupV2Tui(context)).rejects.toThrow("slot registration failed")
			expect(unlisten).toHaveBeenCalledTimes(1)
		} finally {
			for (const key of envKeys) {
				const value = originalEnv[key]
				if (value === undefined) delete process.env[key]
				else process.env[key] = value
			}
			await rm(directory, { recursive: true, force: true })
		}
	})
})
