import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Plugin } from "@opencode/plugin"
import type { OhMyOpenCodeConfig } from "../config"
import { registerV2PlanFormatValidator } from "./plan-format-validator"

const roots: string[] = []

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

type Result = {
	content?: string | readonly unknown[]
	metadata?: Record<string, unknown>
	output?: unknown
}

type Event = {
	tool: string
	sessionID: string
	id: string
	input: unknown
	status: "completed" | "error"
	result?: Result
}

function makeHarness(directory: string) {
	let callback: ((event: Event) => unknown) | undefined
	let disposeCalls = 0
	const ctx = {
		location: { directory },
		tool: {
			hook: async (_name: string, handler: (event: Event) => unknown) => {
				callback = handler
				return { dispose: async () => { disposeCalls += 1 } }
			},
		},
	} as unknown as Plugin.Context
	return {
		ctx,
		invoke(event: Event) { return callback?.(event) },
		get disposeCalls() { return disposeCalls },
	}
}

async function setupWorkspace() {
	const parent = await mkdtemp(join(tmpdir(), "omo-v2-plan-format-"))
	roots.push(parent)
	const workspace = join(parent, "workspace")
	const plans = join(workspace, ".omo", "plans")
	await mkdir(plans, { recursive: true })
	return { parent, workspace, plans }
}

function event(filePath: string, overrides: Partial<Event> = {}): Event {
	return {
		tool: "write",
		sessionID: "ses-plan-format",
		id: "call-plan-format",
		input: { filePath },
		status: "completed",
		result: {
			content: [{ type: "file", uri: "data:text/plain;base64,eA==", mime: "text/plain" }, { type: "text", text: "Native write result" }],
			metadata: { nativeFlag: "preserve" },
			output: { type: "written", custom: true },
		},
		...overrides,
	}
}

function textContent(content: Result["content"]): string {
	if (typeof content === "string") return content
	if (!Array.isArray(content)) return ""
	return content.flatMap((part) => {
		const item = part as { type?: unknown; text?: unknown }
		return item.type === "text" && typeof item.text === "string" ? [item.text] : []
	}).join("\n")
}

describe("native V2 plan format validator", () => {
	test("normalizes Effort, warns on malformed task rows, and preserves native structured output", async () => {
		const { workspace, plans } = await setupWorkspace()
		const file = join(plans, "active.md")
		await writeFile(file, "# Plan\n\n**Effort:** 2 days\n\n## TODOs\n- [ ] 1. Correct row\n- [ ] T2. Malformed row\n")
		const harness = makeHarness(workspace)
		const cleanup = await registerV2PlanFormatValidator(harness.ctx, {} as OhMyOpenCodeConfig)
		const nativeEvent = event(await realpath(file))

		await harness.invoke(nativeEvent)

		const updated = await readFile(file, "utf8")
		expect(updated).toContain("**Effort:** Medium")
		expect(updated).not.toContain("**Effort:** 2 days")
		expect(textContent(nativeEvent.result?.content)).toContain("<plan-format-warning>")
		expect(textContent(nativeEvent.result?.content).match(/<plan-format-warning>/g)).toHaveLength(2)
		expect(nativeEvent.result?.content).toEqual(expect.arrayContaining([
			expect.objectContaining({ type: "file", uri: "data:text/plain;base64,eA==" }),
		]))
		expect(nativeEvent.result?.metadata).toEqual({ nativeFlag: "preserve" })
		expect(nativeEvent.result?.output).toEqual({ type: "written", custom: true })
		await cleanup()
	})

	test("does not inspect failed writes or valid plans without duration normalization", async () => {
		const { workspace, plans } = await setupWorkspace()
		const failedFile = join(plans, "failed.md")
		const failedContent = "# Plan\n\n**Effort:** 2 days\n\n## TODOs\n- [ ] T1. Malformed row\n"
		const validFile = join(plans, "valid.md")
		const valid = "# Plan\n\n**Effort:** Medium\n\n## TODOs\n- [ ] 1. Complete the implementation\n"
		await Promise.all([writeFile(failedFile, failedContent), writeFile(validFile, valid)])
		const harness = makeHarness(workspace)
		const cleanup = await registerV2PlanFormatValidator(harness.ctx, {} as OhMyOpenCodeConfig)
		const failed = event(failedFile, { status: "error" })
		await harness.invoke(failed)
		expect(await readFile(failedFile, "utf8")).toBe(failedContent)
		expect(textContent(failed.result?.content)).not.toContain("<plan-format-warning>")

		const completed = event(validFile)
		await harness.invoke(completed)
		expect(await readFile(validFile, "utf8")).toBe(valid)
		expect(textContent(completed.result?.content)).not.toContain("<plan-format-warning>")
		await cleanup()
	})

	test("skips outside paths, traversal, and symlinks that escape the canonical plans directory", async () => {
		const { parent, workspace, plans } = await setupWorkspace()
		const outsideDir = join(parent, "outside")
		await mkdir(outsideDir)
		const outside = join(outsideDir, "outside.md")
		const original = "# Plan\n**Effort:** 2 days\n"
		await writeFile(outside, original)
		const link = join(plans, "escape.md")
		await symlink(outside, link)
		const linkedWorkspace = join(parent, "linked-workspace")
		const linkedOmo = join(linkedWorkspace, ".omo")
		await mkdir(linkedOmo, { recursive: true })
		await symlink(outsideDir, join(linkedOmo, "plans"))
		const throughRootLink = join(linkedOmo, "plans", "outside.md")
		const inside = join(plans, "normal.md")
		await writeFile(inside, original)
		const harness = makeHarness(workspace)
		const cleanup = await registerV2PlanFormatValidator(harness.ctx, {} as OhMyOpenCodeConfig)

		for (const candidate of [outside, join(plans, "..", "..", "outside", "outside.md"), link]) {
			const attempted = event(candidate)
			await harness.invoke(attempted)
			expect(textContent(attempted.result?.content)).not.toContain("<plan-format-warning>")
		}
		expect(await readFile(outside, "utf8")).toBe(original)
		expect(await readFile(inside, "utf8")).toBe(original)
		await cleanup()

		const linkedHarness = makeHarness(linkedWorkspace)
		const linkedCleanup = await registerV2PlanFormatValidator(linkedHarness.ctx, {} as OhMyOpenCodeConfig)
		const throughRootLinkEvent = event(throughRootLink)
		await linkedHarness.invoke(throughRootLinkEvent)
		expect(textContent(throughRootLinkEvent.result?.content)).not.toContain("<plan-format-warning>")
		expect(await readFile(outside, "utf8")).toBe(original)
		await linkedCleanup()
	})

	test("honors its own disabled hook and cleanup prevents later result mutation", async () => {
		const { workspace, plans } = await setupWorkspace()
		const file = join(plans, "active.md")
		await writeFile(file, "# Plan\n**Effort:** 2 days\n")
		const disabled = makeHarness(workspace)
		const noopCleanup = await registerV2PlanFormatValidator(disabled.ctx, { disabled_hooks: ["plan-format-validator"] } as OhMyOpenCodeConfig)
		const disabledEvent = event(file)
		await disabled.invoke(disabledEvent)
		expect(await readFile(file, "utf8")).toContain("2 days")
		expect(textContent(disabledEvent.result?.content)).not.toContain("<plan-format-warning>")
		await noopCleanup()

		const active = makeHarness(workspace)
		const cleanup = await registerV2PlanFormatValidator(active.ctx, {} as OhMyOpenCodeConfig)
		await cleanup()
		const afterDispose = event(file)
		await active.invoke(afterDispose)
		expect(await readFile(file, "utf8")).toContain("2 days")
		expect(active.disposeCalls).toBe(1)
	})
})
