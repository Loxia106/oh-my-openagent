import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Plugin } from "@opencode/plugin"
import type { OhMyOpenCodeConfig } from "../config"
import { registerV2Hooks } from "./hooks"

const DISABLED_HOOKS = [
	"prometheus-md-only", "non-interactive-env", "notepad-write-guard", "sisyphus-junior-notepad",
	"hashline-read-enhancer", "task-resume-info", "write-existing-file-guard", "tasks-todowrite-disabler",
	"edit-error-recovery", "json-error-recovery", "empty-task-response-detector",
	"compaction-context-injector", "compaction-todo-preserver", "goal", "todo-continuation-enforcer", "atlas",
	"directory-readme-injector", "rules-injector",
]

describe("native V2 hook orchestration", () => {
	test("unwinds the background policy when a later lifecycle hook registration fails", async () => {
		const directory = await mkdtemp(join(tmpdir(), "omo-v2-hooks-unwind-"))
		const sessionDisposals: string[] = []
		const toolDisposals: string[] = []
		let promptRegistrations = 0
		const storage = {
			get: async () => undefined,
			set: async () => undefined,
			remove: async () => undefined,
			scan: async () => ({ items: [], cursor: undefined }),
		}
		const ctx = {
			location: {
				directory,
				project: { id: "project-hooks-test", directory, canonical: directory },
			},
			storage,
			session: {
				hook: async (name: string) => {
					if (name === "prompt" && ++promptRegistrations === 2) throw new Error("lifecycle prompt registration failed")
					return { dispose: async () => { sessionDisposals.push(name) } }
				},
			},
			tool: {
				hook: async (name: string) => ({ dispose: async () => { toolDisposals.push(name) } }),
			},
			event: { subscribe: async function* () { return } },
		} as unknown as Plugin.Context
		try {
			await expect(registerV2Hooks(ctx, { disabled_hooks: DISABLED_HOOKS } as OhMyOpenCodeConfig))
				.rejects.toThrow("lifecycle prompt registration failed")
			expect(toolDisposals).toEqual(["execute.before"])
			expect(sessionDisposals).toEqual(["context", "prompt"])
		} finally {
			await rm(directory, { recursive: true, force: true })
		}
	})
})
