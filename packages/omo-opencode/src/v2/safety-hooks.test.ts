import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import type { Plugin } from "@opencode/plugin"
import { Error as ToolError } from "@opencode/plugin/promise/tool"
import type { OhMyOpenCodeConfig } from "../config"
import { registerV2SafetyHooks } from "./safety-hooks"

const roots: string[] = []

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

type HookEvent = {
	tool: string
	sessionID: string
	id: string
	input: unknown
	status?: "completed" | "error"
	result?: unknown
	error?: unknown
}

function makeContext(directory: string, options: { failRegistrationAt?: string } = {}) {
	const callbacks = new Map<string, (event: HookEvent) => unknown>()
	const disposed: string[] = []
	const queuedEvents: unknown[] = []
	let wake: (() => void) | undefined
	let markSubscribed!: () => void
	const subscribed = new Promise<void>((resolve) => { markSubscribed = resolve })
	const ctx = {
		location: { directory, workspaceID: "workspace-safety" },
		tool: {
			hook: async (name: string, callback: (event: HookEvent) => unknown) => {
				if (options.failRegistrationAt === name) throw new Error(`registration failed: ${name}`)
				callbacks.set(name, callback)
				return { dispose: async () => { disposed.push(name) } }
			},
		},
		event: {
			subscribe: ({ signal }: { signal: AbortSignal }) => (async function* () {
				markSubscribed()
				while (!signal.aborted) {
					const event = queuedEvents.shift()
					if (event) {
						yield event as Plugin.Event
						continue
					}
					await new Promise<void>((resolve) => {
						wake = resolve
						signal.addEventListener("abort", resolve, { once: true })
					})
					wake = undefined
				}
			})(),
		},
	}
	return {
		ctx: ctx as unknown as Plugin.Context,
		callbacks,
		disposed,
		subscribed,
		before(event: HookEvent) { return callbacks.get("execute.before")?.(event) },
		after(event: HookEvent) { return callbacks.get("execute.after")?.(event) },
		deleteSession(sessionID: string, location = { directory, workspaceID: "workspace-safety" }) {
			queuedEvents.push({ type: "session.deleted", data: { sessionID }, created: Date.now(), location })
			wake?.()
		},
	}
}

async function createFile(directory: string, path: string, content = "before") {
	const absolute = join(directory, path)
	await mkdir(dirname(absolute), { recursive: true })
	await writeFile(absolute, content, "utf8")
	return absolute
}

function event(tool: string, sessionID: string, input: unknown, status?: HookEvent["status"]): HookEvent {
	return { tool, sessionID, id: `call-${tool}-${sessionID}`, input, ...(status ? { status } : {}) }
}

async function waitUntil(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 1000
	while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5))
	expect(predicate()).toBe(true)
}

describe("native V2 safety hooks", () => {
	test("blocks an existing file until a successful same-session read and consumes the grant once", async () => {
		const directory = await mkdtemp(join(tmpdir(), "omo-v2-write-guard-"))
		roots.push(directory)
		const path = await createFile(directory, "existing.txt")
		const { ctx, callbacks, subscribed } = makeContext(directory)
		const cleanup = await registerV2SafetyHooks(ctx, {} as OhMyOpenCodeConfig)
		await subscribed

		const denied = event("write", "ses-main", { path, content: "blocked" })
		await expect(Promise.resolve().then(() => callbacks.get("execute.before")?.(denied))).rejects.toBeInstanceOf(ToolError)
		expect(await readFile(path, "utf8")).toBe("before")

		await callbacks.get("execute.after")?.(event("read", "ses-main", { path }, "error"))
		await expect(Promise.resolve().then(() => callbacks.get("execute.before")?.(event("write", "ses-main", { path, content: "still blocked" }))))
			.rejects.toBeInstanceOf(ToolError)

		await callbacks.get("execute.after")?.(event("read", "ses-main", { path }, "completed"))
		const firstWrite = event("write", "ses-main", { path, content: "allowed" })
		await callbacks.get("execute.before")?.(firstWrite)
		expect(firstWrite.input).toEqual({ path, content: "allowed" })
		await expect(Promise.resolve().then(() => callbacks.get("execute.before")?.(event("write", "ses-main", { path, content: "second write" }))))
			.rejects.toBeInstanceOf(ToolError)
		expect(await readFile(path, "utf8")).toBe("before")
		await cleanup()
	})

	test("isolates read grants by session and supports one explicit overwrite without leaking its flag", async () => {
		const directory = await mkdtemp(join(tmpdir(), "omo-v2-write-session-"))
		roots.push(directory)
		const path = await createFile(directory, "shared.txt")
		const { ctx, callbacks, subscribed } = makeContext(directory)
		const cleanup = await registerV2SafetyHooks(ctx, {} as OhMyOpenCodeConfig)
		await subscribed

		await callbacks.get("execute.after")?.(event("read", "ses-a", { filePath: path }, "completed"))
		await expect(Promise.resolve().then(() => callbacks.get("execute.before")?.(event("write", "ses-b", { path, content: "cross-session" }))))
			.rejects.toBeInstanceOf(ToolError)

		const explicit = event("write", "ses-b", { path, content: "explicit", overwrite: "true" })
		await callbacks.get("execute.before")?.(explicit)
		expect(explicit.input).toEqual({ path, content: "explicit" })
		await expect(Promise.resolve().then(() => callbacks.get("execute.before")?.(event("write", "ses-b", { path, content: "again" }))))
			.rejects.toBeInstanceOf(ToolError)
		await expect(Promise.resolve().then(() => callbacks.get("execute.before")?.(event("write", "ses-a", { path, content: "grant invalidated by another session write" }))))
			.rejects.toBeInstanceOf(ToolError)
		await cleanup()
	})

	test("allows new files and the .omo workspace exception while preserving session-delete invalidation", async () => {
		const directory = await mkdtemp(join(tmpdir(), "omo-v2-write-paths-"))
		roots.push(directory)
		const path = await createFile(directory, "existing.txt")
		const omoPath = await createFile(directory, ".omo/config.jsonc")
		const { ctx, callbacks, subscribed, deleteSession } = makeContext(directory)
		const cleanup = await registerV2SafetyHooks(ctx, {} as OhMyOpenCodeConfig)
		await subscribed

		await callbacks.get("execute.before")?.(event("write", "ses-paths", { path: join(directory, "new.txt"), content: "new" }))
		await callbacks.get("execute.before")?.(event("write", "ses-paths", { path: omoPath, content: "workflow metadata" }))
		await callbacks.get("execute.after")?.(event("read", "ses-paths", { path }, "completed"))
		deleteSession("ses-paths")
		await new Promise((resolve) => setTimeout(resolve, 20))
		await expect(Promise.resolve().then(() => callbacks.get("execute.before")?.(event("write", "ses-paths", { path, content: "after deletion" }))))
			.rejects.toBeInstanceOf(ToolError)
		await cleanup()
	})

	test("task system blocks only TodoRead and points at the native task tool names", async () => {
		const directory = await mkdtemp(join(tmpdir(), "omo-v2-task-system-gate-"))
		roots.push(directory)
		const { ctx, callbacks } = makeContext(directory)
		const cleanup = await registerV2SafetyHooks(ctx, { experimental: { task_system: true } } as OhMyOpenCodeConfig)
		const blocked = Promise.resolve().then(() => callbacks.get("execute.before")?.(event("TodoRead", "ses-task", {})))
		await expect(blocked).rejects.toBeInstanceOf(ToolError)
		try {
			await blocked
		} catch (error) {
			const message = (error as Error).message
			expect(message).toContain("task_list")
			expect(message).toContain("task_get")
		}
		await expect(Promise.resolve().then(() => callbacks.get("execute.before")?.(event("TodoWrite", "ses-task", {}))))
			.resolves.toBeUndefined()
		await expect(Promise.resolve().then(() => callbacks.get("execute.before")?.(event("task_list", "ses-task", {}))))
			.resolves.toBeUndefined()
		await expect(Promise.resolve().then(() => callbacks.get("execute.before")?.(event("task_get", "ses-task", {}))))
			.resolves.toBeUndefined()
		await cleanup()
	})

	test("respects disabled hooks and disabled tools, unwinds partial registration, and cleans up idempotently", async () => {
		const directory = await mkdtemp(join(tmpdir(), "omo-v2-safety-cleanup-"))
		roots.push(directory)
		const disabled = makeContext(directory)
		const disabledCleanup = await registerV2SafetyHooks(disabled.ctx, {
			disabled_hooks: ["write-existing-file-guard", "tasks-todowrite-disabler"],
			experimental: { task_system: true },
		} as OhMyOpenCodeConfig)
		expect(disabled.callbacks.size).toBe(0)
		await disabledCleanup()

		const toolsDisabled = makeContext(directory)
		await registerV2SafetyHooks(toolsDisabled.ctx, {
			disabled_tools: ["write", "TodoRead"],
			experimental: { task_system: true },
		} as OhMyOpenCodeConfig)
		expect(toolsDisabled.callbacks.size).toBe(0)

		const rollback = makeContext(directory, { failRegistrationAt: "execute.after" })
		await expect(registerV2SafetyHooks(rollback.ctx, {} as OhMyOpenCodeConfig)).rejects.toThrow("registration failed: execute.after")
		expect(rollback.disposed).toEqual(["execute.before"])

		const active = makeContext(directory)
		const cleanup = await registerV2SafetyHooks(active.ctx, {} as OhMyOpenCodeConfig)
		await active.subscribed
		await cleanup()
		await cleanup()
		expect(active.disposed).toEqual(["execute.after", "execute.before"])
		await expect(Promise.resolve().then(() => active.callbacks.get("execute.before")?.(event("write", "ses-clean", { path: join(directory, ".omo", "gone.json"), content: "no callback after dispose" }))))
			.resolves.toBeUndefined()
	})
})
