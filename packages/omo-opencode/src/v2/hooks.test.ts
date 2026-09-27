import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Plugin } from "@opencode/plugin"
import type { OhMyOpenCodeConfig } from "../config"
import { TODOWRITE_DESCRIPTION } from "../hooks/todo-description-override/description"
import { registerV2Hooks } from "./hooks"

const DISABLED_HOOKS = [
	"prometheus-md-only", "non-interactive-env", "notepad-write-guard", "sisyphus-junior-notepad",
	"hashline-read-enhancer", "task-resume-info", "write-existing-file-guard", "tasks-todowrite-disabler",
	"edit-error-recovery", "json-error-recovery", "empty-task-response-detector",
	"compaction-context-injector", "compaction-todo-preserver", "goal", "todo-continuation-enforcer", "atlas",
	"directory-readme-injector", "rules-injector", "think-mode",
	"claude-code-hooks",
]

describe("native V2 hook orchestration", () => {
	test("unwinds the background policy when a later lifecycle hook registration fails", async () => {
		const directory = await mkdtemp(join(tmpdir(), "omo-v2-hooks-unwind-"))
		const registrations: string[] = []
		const disposals: string[] = []
		const toolHookRegistrations: string[] = []
		let promptRegistrations = 0
		let toolHookSequence = 0
		let eventSubscriptions = 0
		let eventStreamsAborted = 0
		let transformApplications = 0
		let descriptionAtLifecycleFailure: string | undefined
		const originalTodoDescription = "Native todowrite description"
		const todoTool = { id: "todowrite", name: "todowrite", description: originalTodoDescription, input: {}, execute: async () => ({}) }
		const storageValues = new Map<string, unknown>()
		const storage = {
			get: async (key: string) => storageValues.get(key),
			set: async (key: string, value: unknown) => { storageValues.set(key, value) },
			remove: async (key: string) => { storageValues.delete(key) },
			scan: async () => ({ entries: [...storageValues].map(([key, value]) => ({ key, value })), next: undefined }),
		}
		const registration = (label: string) => {
			registrations.push(label)
			return { dispose: async () => { disposals.push(label) } }
		}
		const ctx = {
			location: {
				directory,
				project: { id: "project-hooks-test", directory, canonical: directory },
			},
			storage,
			session: {
				hook: async (name: string) => {
					if (name === "prompt" && ++promptRegistrations === 2) {
						descriptionAtLifecycleFailure = todoTool.description
						throw new Error("lifecycle prompt registration failed")
					}
					return registration(`session.hook:${name}`)
				},
			},
			tool: {
				hook: async (name: string) => {
					const label = `tool.hook:${name}:${++toolHookSequence}`
					toolHookRegistrations.push(label)
					return registration(label)
				},
				transform: async (callback: (editor: {
					list: () => typeof todoTool[]
					get: (id: string) => typeof todoTool | undefined
					namespace: () => void
					add: () => void
					update: (id: string, update: (tool: typeof todoTool) => void) => void
					remove: () => void
				}) => void) => {
					transformApplications++
					callback({
						list: () => [todoTool],
						get: (id) => id === "todowrite" ? todoTool : undefined,
						namespace: () => undefined,
						add: () => undefined,
						update: (id, update) => { if (id === "todowrite") update(todoTool) },
						remove: () => undefined,
					})
					const label = "tool.transform:todowrite-description"
					registrations.push(label)
					return {
						dispose: async () => {
							todoTool.description = originalTodoDescription
							disposals.push(label)
						},
					}
				},
			},
			event: {
				subscribe: ({ signal }: { signal: AbortSignal }) => (async function* () {
					eventSubscriptions++
					await new Promise<void>((resolve) => {
						if (signal.aborted) {
							eventStreamsAborted++
							resolve()
							return
						}
						signal.addEventListener("abort", () => {
							eventStreamsAborted++
							resolve()
						}, { once: true })
					})
				})(),
			},
		} as unknown as Plugin.Context
		try {
			await expect(registerV2Hooks(ctx, { disabled_hooks: DISABLED_HOOKS } as OhMyOpenCodeConfig))
				.rejects.toThrow("lifecycle prompt registration failed")
			expect(transformApplications).toBe(1)
			expect(descriptionAtLifecycleFailure).toBe(TODOWRITE_DESCRIPTION)
			expect(todoTool.description).toBe(originalTodoDescription)
			expect(toolHookRegistrations.some((label) => label.startsWith("tool.hook:execute.before:"))).toBe(true)
			expect(disposals).toEqual([...registrations].reverse())
			expect(eventSubscriptions).toBeGreaterThan(0)
			expect(eventStreamsAborted).toBe(eventSubscriptions)
		} finally {
			await rm(directory, { recursive: true, force: true })
		}
	})
})
