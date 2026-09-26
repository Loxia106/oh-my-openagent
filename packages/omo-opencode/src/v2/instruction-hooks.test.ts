import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Plugin } from "@opencode/plugin"
import type { OhMyOpenCodeConfig } from "../config"
import { INSTRUCTION_RESULT_METADATA_KEY } from "./instruction-context"
import { registerV2InstructionHooks } from "./instruction-hooks"

const roots: string[] = []
const oldHome = process.env.HOME

afterEach(async () => {
	process.env.HOME = oldHome
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

type TestToolResult = {
	content?: string | readonly unknown[]
	metadata?: Record<string, unknown>
	output?: unknown
}

type TestHookEvent = {
	tool: string
	sessionID: string
	agent: string
	messageID: string
	id: string
	input: unknown
	status: "completed" | "error"
	result?: TestToolResult
	error?: unknown
}

function makeHarness(directory: string, options: {
	history?: unknown[]
	registrationFailure?: boolean
	context?: () => Promise<unknown[]>
} = {}) {
	const callbacks = new Map<string, (event: TestHookEvent) => unknown>()
	const disposed: string[] = []
	const queuedEvents: Array<unknown> = []
	let wake: (() => void) | undefined
	let markSubscribed!: () => void
	const subscribed = new Promise<void>((resolve) => { markSubscribed = resolve })
	const ctx = {
		location: { directory, workspaceID: "instruction-hooks-test" },
		tool: {
			hook: async (name: string, callback: (event: TestHookEvent) => unknown) => {
				if (options.registrationFailure) throw new Error("hook registration failed")
				callbacks.set(name, callback)
				return { dispose: async () => { disposed.push(name) } }
			},
		},
		event: {
			subscribe: ({ signal }: { signal: AbortSignal }) => (async function* () {
				markSubscribed()
				while (!signal.aborted) {
					const item = queuedEvents.shift()
					if (item) {
						yield item as Plugin.Event
						continue
					}
					await new Promise<void>((resolve) => {
						const onAbort = () => resolve()
						wake = resolve
						signal.addEventListener("abort", onAbort, { once: true })
					})
					wake = undefined
				}
			})(),
		},
		session: {
			context: async () => options.context ? options.context() : options.history ?? [],
		},
		model: { list: async () => ({ data: [] }) },
	}
	return {
		ctx: ctx as unknown as Plugin.Context,
		callbacks,
		disposed,
		subscribed,
		after(event: TestHookEvent) { return callbacks.get("execute.after")?.(event) },
		emit(event: unknown) {
			queuedEvents.push(event)
			wake?.()
		},
	}
}

async function setupWorkspace() {
	const parent = await mkdtemp(join(tmpdir(), "omo-v2-instruction-hooks-"))
	roots.push(parent)
	const root = join(parent, "workspace")
	const home = join(parent, "home")
	await Promise.all([mkdir(root), mkdir(home)])
	await mkdir(join(root, ".git"))
	await mkdir(join(root, ".omo", "rules"), { recursive: true })
	await mkdir(join(root, "src"), { recursive: true })
	await writeFile(join(root, "src", "index.ts"), "export const value = 1\n")
	await writeFile(join(root, ".omo", "rules", "always.md"), "---\nalwaysApply: true\n---\nRULE_INSTRUCTION_ALPHA\n")
	process.env.HOME = home
	return { parent, root, home, target: join(root, "src", "index.ts") }
}

function toolEvent(input: {
	tool?: string
	path: string
	sessionID?: string
	messageID?: string
	status?: "completed" | "error"
	content?: TestToolResult["content"]
	metadata?: Record<string, unknown>
	output?: unknown
	directoryListing?: boolean
}): TestHookEvent {
	const tool = input.tool ?? "read"
	const sessionID = input.sessionID ?? "ses-instructions"
	return {
		tool,
		sessionID,
		agent: "sisyphus",
		messageID: input.messageID ?? "msg-instructions",
		id: `call-${tool}-${sessionID}-${Math.random()}`,
		input: { path: input.path },
		status: input.status ?? "completed",
		result: {
			content: input.content ?? "Native tool output",
			metadata: input.metadata ?? {},
			output: input.output ?? (input.directoryListing ? { type: "list-page" } : { type: "file" }),
		},
	}
}

function contentText(content: TestToolResult["content"]): string {
	if (typeof content === "string") return content
	if (!Array.isArray(content)) return ""
	return content.flatMap((part) => {
		const value = part as { type?: unknown; text?: unknown }
		return value.type === "text" && typeof value.text === "string" ? [value.text] : []
	}).join("\n")
}

function metadataMarker(event: TestHookEvent): Record<string, unknown> | undefined {
	return event.result?.metadata?.[INSTRUCTION_RESULT_METADATA_KEY] as Record<string, unknown> | undefined
}

function persistedTool(event: TestHookEvent) {
	return {
		type: "assistant",
		content: [{
			type: "tool",
			name: event.tool,
			state: {
				status: "completed",
				content: event.result?.content,
				metadata: event.result?.metadata,
			},
		}],
	}
}

async function waitUntil(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 1000
	while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5))
	expect(predicate()).toBe(true)
}

describe("native V2 rules and README instructions", () => {
	test("injects ordered rules and README text, preserves structured result, and deduplicates concurrent same-message completions", async () => {
		const { root, target } = await setupWorkspace()
		await writeFile(join(root, "README.md"), "ROOT_README_CONTEXT\n")
		await writeFile(join(root, "src", "README.md"), "NESTED_README_CONTEXT\n")
		const harness = makeHarness(root)
		const cleanup = await registerV2InstructionHooks(harness.ctx, {} as OhMyOpenCodeConfig)
		await harness.subscribed

		const first = toolEvent({ path: target, content: [{ type: "file", uri: "data:text/plain;base64,eA==", mime: "text/plain" }, { type: "text", text: "Native read content" }], metadata: { truncated: false, nativeFlag: "keep" }, output: { type: "file", value: "keep" } })
		const duplicate = toolEvent({ path: target, messageID: first.messageID, metadata: { truncated: false } })
		await Promise.all([harness.after(first), harness.after(duplicate)])
		const firstText = contentText(first.result?.content)
		expect(firstText).toContain("RULE_INSTRUCTION_ALPHA")
		expect(firstText.indexOf("[Project README: ")).toBeGreaterThan(-1)
		expect(firstText.indexOf("ROOT_README_CONTEXT")).toBeLessThan(firstText.indexOf("NESTED_README_CONTEXT"))
		expect(first.result?.content).toEqual(expect.arrayContaining([
			expect.objectContaining({ type: "file", uri: "data:text/plain;base64,eA==" }),
		]))
		expect(first.result?.output).toEqual({ type: "file", value: "keep" })
		expect(first.result?.metadata).toMatchObject({ truncated: false, nativeFlag: "keep" })
		expect(metadataMarker(first)?.rules).toContain(".omo/rules/always.md")
		expect(metadataMarker(first)?.readmes).toHaveLength(2)

		expect(contentText(duplicate.result?.content)).not.toContain("RULE_INSTRUCTION_ALPHA")
		expect(duplicate.result?.metadata?.[INSTRUCTION_RESULT_METADATA_KEY]).toBeUndefined()
		await cleanup()
	})

	test("rehydrates only committed same-location markers after adapter restart", async () => {
		const { root, target } = await setupWorkspace()
		await writeFile(join(root, "README.md"), "PERSISTED_README_CONTEXT\n")
		const firstHarness = makeHarness(root)
		const firstCleanup = await registerV2InstructionHooks(firstHarness.ctx, {} as OhMyOpenCodeConfig)
		await firstHarness.subscribed
		const first = toolEvent({ path: target, metadata: { truncated: false } })
		await firstHarness.after(first)
		const stored = persistedTool(first)
		await firstCleanup()

		const restarted = makeHarness(root, { history: [stored] })
		const restartCleanup = await registerV2InstructionHooks(restarted.ctx, {} as OhMyOpenCodeConfig)
		await restarted.subscribed
		const second = toolEvent({ path: target, metadata: { truncated: false } })
		await restarted.after(second)
		expect(contentText(second.result?.content)).not.toContain("RULE_INSTRUCTION_ALPHA")
		expect(second.result?.metadata?.[INSTRUCTION_RESULT_METADATA_KEY]).toBeUndefined()
		await restartCleanup()
	})

	test("keeps instruction deduplication isolated between native sessions", async () => {
		const { root, target } = await setupWorkspace()
		const harness = makeHarness(root)
		const cleanup = await registerV2InstructionHooks(harness.ctx, {} as OhMyOpenCodeConfig)
		await harness.subscribed
		const first = toolEvent({ path: target, sessionID: "ses-a", metadata: { truncated: false } })
		const otherSession = toolEvent({ path: target, sessionID: "ses-b", metadata: { truncated: false } })
		await harness.after(first)
		await harness.after(otherSession)
		expect(contentText(first.result?.content)).toContain("RULE_INSTRUCTION_ALPHA")
		expect(contentText(otherSession.result?.content)).toContain("RULE_INSTRUCTION_ALPHA")
		await cleanup()
	})

	test("runs the rules processor for native write, edit, and multiedit completions", async () => {
		const { root, target } = await setupWorkspace()
		const harness = makeHarness(root)
		const cleanup = await registerV2InstructionHooks(harness.ctx, {
			disabled_hooks: ["directory-readme-injector"],
		} as OhMyOpenCodeConfig)
		await harness.subscribed
		for (const tool of ["write", "edit", "multiedit"]) {
			const event = toolEvent({ tool, path: target, sessionID: `ses-${tool}`, messageID: `msg-${tool}` })
			await harness.after(event)
			expect(contentText(event.result?.content)).toContain("RULE_INSTRUCTION_ALPHA")
		}
		await cleanup()
	})

	test("does not allow markers from a forked session at another location to suppress local instructions", async () => {
		const first = await setupWorkspace()
		const secondRoot = join(first.parent, "other-workspace")
		await mkdir(secondRoot)
		await mkdir(join(secondRoot, ".git"))
		await mkdir(join(secondRoot, ".omo", "rules"), { recursive: true })
		const target = join(secondRoot, "same.ts")
		await writeFile(target, "local")
		await writeFile(join(secondRoot, ".omo", "rules", "local.md"), "---\nalwaysApply: true\n---\nOTHER_LOCATION_RULE\n")
		const oldHarness = makeHarness(first.root)
		const oldCleanup = await registerV2InstructionHooks(oldHarness.ctx, {} as OhMyOpenCodeConfig)
		await oldHarness.subscribed
		const oldEvent = toolEvent({ path: first.target, metadata: { truncated: false } })
		await oldHarness.after(oldEvent)
		await oldCleanup()

		const moved = makeHarness(secondRoot, { history: [persistedTool(oldEvent)] })
		const movedCleanup = await registerV2InstructionHooks(moved.ctx, {} as OhMyOpenCodeConfig)
		await moved.subscribed
		const current = toolEvent({ path: target, metadata: { truncated: false } })
		await moved.after(current)
		expect(contentText(current.result?.content)).toContain("OTHER_LOCATION_RULE")
		expect(metadataMarker(current)?.location).toBe(await realpath(secondRoot))
		await movedCleanup()
	})

	test("honors independent hook disables and claude_code.hooks only skips user Claude rules", async () => {
		const { root, home, target } = await setupWorkspace()
		await mkdir(join(root, ".claude", "rules"), { recursive: true })
		await mkdir(join(home, ".claude", "rules"), { recursive: true })
		await writeFile(join(root, ".claude", "rules", "project.md"), "---\nalwaysApply: true\n---\nPROJECT_CLAUDE_RULE\n")
		await writeFile(join(home, ".claude", "rules", "user.md"), "---\nalwaysApply: true\n---\nUSER_CLAUDE_RULE\n")

		const rulesDisabled = makeHarness(root)
		const noRules = await registerV2InstructionHooks(rulesDisabled.ctx, { disabled_hooks: ["rules-injector"] } as OhMyOpenCodeConfig)
		await rulesDisabled.subscribed
		const onlyReadme = toolEvent({ path: target, metadata: { truncated: false } })
		await rulesDisabled.after(onlyReadme)
		expect(contentText(onlyReadme.result?.content)).not.toContain("RULE_INSTRUCTION_ALPHA")
		await noRules()

		const readmeDisabled = makeHarness(root)
		const noReadme = await registerV2InstructionHooks(readmeDisabled.ctx, { disabled_hooks: ["directory-readme-injector"] } as OhMyOpenCodeConfig)
		await readmeDisabled.subscribed
		const onlyRules = toolEvent({ path: target, metadata: { truncated: false } })
		await readmeDisabled.after(onlyRules)
		expect(contentText(onlyRules.result?.content)).toContain("RULE_INSTRUCTION_ALPHA")
		expect(contentText(onlyRules.result?.content)).not.toContain("[Project README:")
		await noReadme()

		const skipUserRules = makeHarness(root)
		const skipUser = await registerV2InstructionHooks(skipUserRules.ctx, { claude_code: { hooks: false } } as OhMyOpenCodeConfig)
		await skipUserRules.subscribed
		const projectRules = toolEvent({ path: target, metadata: { truncated: false } })
		await skipUserRules.after(projectRules)
		expect(contentText(projectRules.result?.content)).toContain("PROJECT_CLAUDE_RULE")
		expect(contentText(projectRules.result?.content)).not.toContain("USER_CLAUDE_RULE")
		await skipUser()
	})

	test("ignores failed operations, external/sibling targets, and README symlinks that escape", async () => {
		const { parent, root, target } = await setupWorkspace()
		const sibling = join(parent, "workspace-neighbor")
		const outside = join(parent, "external")
		await mkdir(sibling)
		await mkdir(outside)
		const outsideTarget = join(outside, "secret.ts")
		const siblingTarget = join(sibling, "secret.ts")
		await writeFile(outsideTarget, "SECRET_FILE")
		await writeFile(siblingTarget, "SIBLING_FILE")
		await writeFile(join(outside, "README.md"), "SECRET_README")
		await symlink(join(outside, "README.md"), join(root, "src", "README.md"))
		const harness = makeHarness(root)
		const cleanup = await registerV2InstructionHooks(harness.ctx, {} as OhMyOpenCodeConfig)
		await harness.subscribed

		const failed = toolEvent({ path: target, status: "error", metadata: { truncated: false } })
		await harness.after(failed)
		expect(failed.result?.metadata?.[INSTRUCTION_RESULT_METADATA_KEY]).toBeUndefined()
		for (const path of [outsideTarget, siblingTarget]) {
			const rejected = toolEvent({ path, metadata: { truncated: false } })
			await harness.after(rejected)
			expect(rejected.result?.metadata?.[INSTRUCTION_RESULT_METADATA_KEY]).toBeUndefined()
			expect(contentText(rejected.result?.content)).not.toContain("SECRET_FILE")
		}
		const inside = toolEvent({ path: target, metadata: { truncated: false } })
		await harness.after(inside)
		expect(contentText(inside.result?.content)).not.toContain("SECRET_README")
		expect(JSON.stringify(metadataMarker(inside))).not.toContain("external/README.md")
		await cleanup()
	})

	test("starts README discovery at a listed directory and skips an already-present readme only after full output survives", async () => {
		const { root } = await setupWorkspace()
		const directory = join(root, "src")
		await writeFile(join(directory, "README.md"), "DIRECTORY_README_MARKER\n")
		const harness = makeHarness(root)
		const cleanup = await registerV2InstructionHooks(harness.ctx, {} as OhMyOpenCodeConfig)
		await harness.subscribed

		const listing = toolEvent({ path: directory, directoryListing: true, metadata: { truncated: false } })
		await harness.after(listing)
		expect(contentText(listing.result?.content)).toContain("DIRECTORY_README_MARKER")
		const stored = persistedTool(listing)
		const restarted = makeHarness(root, { history: [stored] })
		const cleanup2 = await registerV2InstructionHooks(restarted.ctx, { disabled_hooks: ["rules-injector"] } as OhMyOpenCodeConfig)
		await restarted.subscribed
		const repeat = toolEvent({ path: directory, directoryListing: true, metadata: { truncated: false } })
		await restarted.after(repeat)
		expect(contentText(repeat.result?.content)).not.toContain("DIRECTORY_README_MARKER")
		await cleanup2()
		await cleanup()
	})

	test("uses bounded complete blocks for oversized instructions and avoids false cache commits after host truncation", async () => {
		const { root, target } = await setupWorkspace()
		const oversized = "---\nalwaysApply: true\n---\n" + `${"LONG_RULE_USEFUL_CONTENT ".repeat(20_000)}\n`
		await writeFile(join(root, ".omo", "rules", "always.md"), oversized)
		const harness = makeHarness(root)
		const cleanup = await registerV2InstructionHooks(harness.ctx, {} as OhMyOpenCodeConfig)
		await harness.subscribed

		const read = toolEvent({ tool: "read", path: target, content: "small native read", metadata: { truncated: false } })
		await harness.after(read)
		const readOutput = contentText(read.result?.content)
		expect(readOutput).toContain("[Rule: .omo/rules/always.md]")
		expect(readOutput).toContain("LONG_RULE_USEFUL_CONTENT")
		expect(metadataMarker(read)?.rules).toEqual([".omo/rules/always.md"])

		const write = toolEvent({ tool: "write", path: target, content: "small native write", messageID: "msg-write" })
		await harness.after(write)
		const output = contentText(write.result?.content)
		expect(output).toContain("[Rule: .omo/rules/always.md]")
		expect(output).toContain("LONG_RULE_USEFUL_CONTENT")
		expect(output).toContain("truncated")
		expect(metadataMarker(write)?.rules).toEqual([".omo/rules/always.md"])
		expect(Buffer.byteLength(output, "utf8")).toBeLessThanOrEqual(50 * 1024)

		const droppedBody = toolEvent({ tool: "write", path: target, content: "x".repeat(50 * 1024), messageID: "msg-dropped" })
		await harness.after(droppedBody)
		expect(droppedBody.result?.metadata?.[INSTRUCTION_RESULT_METADATA_KEY]).toBeUndefined()
		await cleanup()
	})

	test("truncates an oversized README within the native read context budget", async () => {
		const { root, target } = await setupWorkspace()
		const readme = `${"LONG_README_USEFUL_CONTEXT\n".repeat(20_000)}`
		await writeFile(join(root, "src", "README.md"), readme)
		const harness = makeHarness(root)
		const cleanup = await registerV2InstructionHooks(harness.ctx, {
			disabled_hooks: ["rules-injector"],
		} as OhMyOpenCodeConfig)
		await harness.subscribed
		const event = toolEvent({ path: target, metadata: { truncated: false } })
		await harness.after(event)
		const output = contentText(event.result?.content)
		expect(output).toContain("[Project README:")
		expect(output).toContain("LONG_README_USEFUL_CONTEXT")
		expect(output).toContain("Content was truncated")
		expect(metadataMarker(event)?.readmes).toHaveLength(1)
		await cleanup()
	})

	test("invalidates per-session pending markers on native compaction, revert, and delete events", async () => {
		const { root, target } = await setupWorkspace()
		const harness = makeHarness(root)
		const cleanup = await registerV2InstructionHooks(harness.ctx, {} as OhMyOpenCodeConfig)
		await harness.subscribed

		const first = toolEvent({ path: target, messageID: "msg-a", metadata: { truncated: false } })
		await harness.after(first)
		const sameTurn = toolEvent({ path: target, messageID: "msg-a", metadata: { truncated: false } })
		await harness.after(sameTurn)
		expect(sameTurn.result?.metadata?.[INSTRUCTION_RESULT_METADATA_KEY]).toBeUndefined()

		for (const [type, sessionID] of [
			["session.compaction.ended", "ses-instructions"],
			["session.revert.committed", "ses-instructions"],
			["session.deleted", "ses-instructions"],
		] as const) {
			harness.emit({ type, data: { sessionID }, location: { directory: root, workspaceID: "instruction-hooks-test" } })
			await new Promise((resolve) => setTimeout(resolve, 10))
			const after = toolEvent({ path: target, messageID: "msg-a", metadata: { truncated: false } })
			await harness.after(after)
			expect(contentText(after.result?.content)).toContain("RULE_INSTRUCTION_ALPHA")
		}
		await cleanup()
	})

	test("registration failure, disposal during a pending context read, and repeated cleanup are safe", async () => {
		const { root, target } = await setupWorkspace()
		const failed = makeHarness(root, { registrationFailure: true })
		await expect(registerV2InstructionHooks(failed.ctx, {} as OhMyOpenCodeConfig)).rejects.toThrow("hook registration failed")
		await failed.subscribed
		expect(failed.callbacks.size).toBe(0)

		let resolveHistory!: (history: unknown[]) => void
		const pending = new Promise<unknown[]>((resolve) => { resolveHistory = resolve })
		const active = makeHarness(root, { context: () => pending })
		const cleanup = await registerV2InstructionHooks(active.ctx, {} as OhMyOpenCodeConfig)
		await active.subscribed
		const event = toolEvent({ path: target, metadata: { truncated: false } })
		const inFlight = active.after(event)
		const disposing = cleanup()
		resolveHistory([])
		await Promise.all([inFlight, disposing])
		await cleanup()
		expect(event.result?.metadata?.[INSTRUCTION_RESULT_METADATA_KEY]).toBeUndefined()
		expect(active.disposed).toEqual(["execute.after"])
	})

	test("keeps successful result metadata untouched when appending instruction content", async () => {
		const { root, target } = await setupWorkspace()
		const harness = makeHarness(root)
		const cleanup = await registerV2InstructionHooks(harness.ctx, {} as OhMyOpenCodeConfig)
		await harness.subscribed
		const original = { custom: { id: 1 }, truncated: false }
		const event = toolEvent({ path: target, content: [{ type: "file", uri: "data:image/png;base64,AA==", mime: "image/png" }], metadata: original, output: { nativeStructured: true } })
		await harness.after(event)
		expect(event.result?.metadata?.custom).toBe(original.custom)
		expect(event.result?.metadata?.truncated).toBe(false)
		expect(event.result?.output).toEqual({ nativeStructured: true })
		expect(event.result?.content).toEqual(expect.arrayContaining([
			expect.objectContaining({ type: "file", mime: "image/png" }),
		]))
		await cleanup()
	})
})
