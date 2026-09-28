import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadV2Config } from "./config"

const envKeys = ["HOME", "OCX_PROFILE", "OMO_PROFILE", "OPENCODE_CONFIG_DIR"] as const
const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]])) as Record<typeof envKeys[number], string | undefined>
const roots: string[] = []

function fixture(user: string | undefined, project: string): { root: string; project: string } {
	const root = mkdtempSync(join(tmpdir(), "omo-v2-config-"))
	roots.push(root)
	process.env.HOME = root
	for (const key of envKeys.slice(1)) delete process.env[key]
	if (user !== undefined) {
		mkdirSync(join(root, ".omo"), { recursive: true })
		writeFileSync(join(root, ".omo", "omo.jsonc"), user)
	}
	const projectDirectory = join(root, "work", "project")
	mkdirSync(join(projectDirectory, ".omo"), { recursive: true })
	mkdirSync(join(projectDirectory, "src", "deep"), { recursive: true })
	writeFileSync(join(projectDirectory, ".omo", "omo.jsonc"), project)
	return { root, project: projectDirectory }
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
	for (const key of envKeys) {
		const value = originalEnv[key]
		if (value === undefined) delete process.env[key]
		else process.env[key] = value
	}
})

describe("v2 OMO config loading", () => {
	test("reads an existing user and project .omo/omo.jsonc with comments, harness blocks and project precedence", () => {
		const f = fixture(`{
  // user defaults
  "agents": { "oracle": { "model": "openai/gpt-5.5" }, "sisyphus": { "model": "user/overridden" } },
  "[opencode]": { "goal": { "enabled": true } },
}`, `{
  // project settings
  "agents": { "sisyphus": { "model": "anthropic/claude-opus-5-5" } },
  "[opencode]": { "team_mode": { "enabled": true, "max_parallel_members": 3 }, "hashline_edit": true, "disabled_hooks": ["startup-toast"] },
  "[codex]": { "agents": { "oracle": { "model": "codex/not-for-opencode" } } },
}`)
		const config = loadV2Config(join(f.project, "src", "deep"))
		expect(config.agents?.sisyphus?.model).toBe("anthropic/claude-opus-5-5")
		expect(config.agents?.oracle?.model).toBe("openai/gpt-5.5")
		expect(config.team_mode).toMatchObject({ enabled: true, max_parallel_members: 3 })
		expect(config.hashline_edit).toBe(true)
		expect(config.goal?.enabled).toBe(true)
		expect(config.disabled_hooks).toEqual(["startup-toast"])
	})

	test("an older config with an unknown key still loads unchanged instead of disabling OMO", () => {
		const project = `{
  "agents": { "sisyphus": { "model": "anthropic/claude-opus-5-5" } },
  "[opencode]": { "team_mode": { "enabled": true } },
  "[codex]": { "hashline_edit": false }
}`
		const f = fixture(undefined, project)
		const config = loadV2Config(f.project)
		expect(config.agents?.sisyphus?.model).toBe("anthropic/claude-opus-5-5")
		expect(config.team_mode?.enabled).toBe(true)
		expect(readFileSync(join(f.project, ".omo", "omo.jsonc"), "utf8")).toBe(project)
	})
})
