import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Plugin } from "@opencode/plugin"
import type { OhMyOpenCodeConfig } from "../config"
import { REMINDER_MESSAGE } from "../hooks/agent-usage-reminder/constants"
import { registerV2AgentUsageReminder } from "./agent-usage-reminder"

const roots: string[] = []

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

type ToolResult = {
	content?: string | readonly unknown[]
	metadata?: Record<string, unknown>
	output?: unknown
}

type ToolEvent = {
	tool: string
	sessionID: string
	agent: string
	messageID: string
	id: string
	status: "completed" | "error"
	result?: ToolResult
}

type NativeEvent = { type: string; location?: unknown; data?: unknown }

function makeStorage() {
	const values = new Map<string, unknown>()
	return {
		values,
		get: async (key: string) => values.get(key),
		set: async (key: string, value: unknown) => { values.set(key, value) },
		remove: async (key: string) => { values.delete(key) },
		scan: async () => ({ items: [], cursor: undefined }),
	}
}

function makeHarness(directory: string, storage = makeStorage()) {
	let callback: ((event: ToolEvent) => unknown) | undefined
	const queuedEvents: NativeEvent[] = []
	const disposed: string[] = []
	let wake: (() => void) | undefined
	let markSubscribed!: () => void
	const subscribed = new Promise<void>((resolve) => { markSubscribed = resolve })
	const ctx = {
		location: { directory, workspaceID: "workspace-agent-reminder", project: { id: `project-${directory}`, canonical: directory } },
		storage,
		tool: {
			hook: async (name: string, handler: (event: ToolEvent) => unknown) => {
				callback = handler
				return { dispose: async () => { disposed.push(name) } }
			},
		},
		event: {
			subscribe: ({ signal }: { signal: AbortSignal }) => (async function* () {
				markSubscribed()
				while (!signal.aborted) {
					const event = queuedEvents.shift()
					if (event) {
						yield event as unknown as Plugin.Event
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
	} as unknown as Plugin.Context
	return {
		ctx,
		storage,
		disposed,
		subscribed,
		async after(event: ToolEvent) { await callback?.(event) },
		emit(event: NativeEvent) { queuedEvents.push(event); wake?.() },
	}
}

function toolEvent(input: Partial<ToolEvent> & Pick<ToolEvent, "tool" | "sessionID" | "id">): ToolEvent {
	return {
		agent: "sisyphus",
		messageID: `message-${input.id}`,
		status: "completed",
		result: {
			content: [{ type: "file", uri: "data:text/plain;base64,eA==", mime: "text/plain" }, { type: "text", text: `result ${input.id}` }],
			metadata: { nativeFlag: "keep" },
			output: { type: "result", value: input.id },
		},
		...input,
	}
}

function resultText(result: ToolResult | undefined): string {
	const content = result?.content
	if (typeof content === "string") return content
	if (!Array.isArray(content)) return ""
	return content.flatMap((part) => {
		const item = part as { type?: unknown; text?: unknown }
		return item.type === "text" && typeof item.text === "string" ? [item.text] : []
	}).join("\n")
}

async function waitUntil(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 1000
	while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5))
	expect(predicate()).toBe(true)
}

describe("native V2 agent usage reminder", () => {
	test("serializes concurrent calls, persists the three-reminder limit across restart, and preserves result data", async () => {
		const directory = await mkdtemp(join(tmpdir(), "omo-v2-agent-reminder-"))
		roots.push(directory)
		const storage = makeStorage()
		const first = makeHarness(directory, storage)
		const cleanup = await registerV2AgentUsageReminder(first.ctx, {} as OhMyOpenCodeConfig)
		await first.subscribed
		const concurrent = Array.from({ length: 5 }, (_, index) => toolEvent({ tool: "grep", sessionID: "ses-limit", id: `call-${index}` }))
		await Promise.all(concurrent.map((event) => first.after(event)))

		const reminded = concurrent.filter((event) => resultText(event.result).includes(REMINDER_MESSAGE.trim()))
		expect(reminded).toHaveLength(3)
		for (const event of concurrent) {
			expect(event.result?.output).toEqual({ type: "result", value: event.id })
			expect(event.result?.metadata).toEqual({ nativeFlag: "keep" })
			expect(event.result?.content).toEqual(expect.arrayContaining([
				expect.objectContaining({ type: "file", uri: "data:text/plain;base64,eA==" }),
			]))
		}
		await cleanup()

		const restarted = makeHarness(directory, storage)
		const restartCleanup = await registerV2AgentUsageReminder(restarted.ctx, {} as OhMyOpenCodeConfig)
		await restarted.subscribed
		const fourth = toolEvent({ tool: "grep", sessionID: "ses-limit", id: "call-fourth" })
		await restarted.after(fourth)
		expect(resultText(fourth.result)).not.toContain(REMINDER_MESSAGE.trim())
		await restartCleanup()
	})

	test("suppresses future reminders only after a successful native delegation", async () => {
		const directory = await mkdtemp(join(tmpdir(), "omo-v2-agent-delegation-"))
		roots.push(directory)
		const harness = makeHarness(directory)
		const cleanup = await registerV2AgentUsageReminder(harness.ctx, {} as OhMyOpenCodeConfig)
		await harness.subscribed

		const failedDelegation = toolEvent({ tool: "task", sessionID: "ses-failed-delegate", id: "call-failed", status: "error" })
		await harness.after(failedDelegation)
		const afterFailure = toolEvent({ tool: "grep", sessionID: "ses-failed-delegate", id: "call-after-failed" })
		await harness.after(afterFailure)
		expect(resultText(afterFailure.result)).toContain(REMINDER_MESSAGE.trim())

		const success = toolEvent({ tool: "subagent", sessionID: "ses-success-delegate", id: "call-success" })
		await harness.after(success)
		const afterSuccess = toolEvent({ tool: "webfetch", sessionID: "ses-success-delegate", id: "call-after-success" })
		await harness.after(afterSuccess)
		expect(resultText(afterSuccess.result)).not.toContain(REMINDER_MESSAGE.trim())
		await cleanup()
	})

	test("skips unknown and subagent IDs and keeps identical session IDs isolated by location", async () => {
		const firstDirectory = await mkdtemp(join(tmpdir(), "omo-v2-agent-reminder-a-"))
		const secondDirectory = await mkdtemp(join(tmpdir(), "omo-v2-agent-reminder-b-"))
		roots.push(firstDirectory, secondDirectory)
		const shared = makeStorage()
		const first = makeHarness(firstDirectory, shared)
		const second = makeHarness(secondDirectory, shared)
		const cleanupFirst = await registerV2AgentUsageReminder(first.ctx, {} as OhMyOpenCodeConfig)
		const cleanupSecond = await registerV2AgentUsageReminder(second.ctx, {} as OhMyOpenCodeConfig)
		await Promise.all([first.subscribed, second.subscribed])

		const custom = toolEvent({ tool: "glob", sessionID: "ses-scope", id: "call-custom", agent: "my-review-agent" })
		const subagent = toolEvent({ tool: "glob", sessionID: "ses-scope", id: "call-explore", agent: "explore" })
		await first.after(custom)
		await first.after(subagent)
		expect(resultText(custom.result)).not.toContain(REMINDER_MESSAGE.trim())
		expect(resultText(subagent.result)).not.toContain(REMINDER_MESSAGE.trim())

		const firstSession = toolEvent({ tool: "glob", sessionID: "ses-scope", id: "call-first-location" })
		const secondSession = toolEvent({ tool: "glob", sessionID: "ses-scope", id: "call-second-location" })
		await Promise.all([first.after(firstSession), second.after(secondSession)])
		expect(resultText(firstSession.result)).toContain(REMINDER_MESSAGE.trim())
		expect(resultText(secondSession.result)).toContain(REMINDER_MESSAGE.trim())
		const nativeSubagent = toolEvent({ tool: "subagent", sessionID: "ses-scope", id: "call-native-subagent" })
		const afterNativeSubagent = toolEvent({ tool: "grep", sessionID: "ses-scope", id: "call-after-native-subagent" })
		await first.after(nativeSubagent)
		await first.after(afterNativeSubagent)
		expect(resultText(afterNativeSubagent.result)).not.toContain(REMINDER_MESSAGE.trim())
		await cleanupFirst()
		await cleanupSecond()
	})

	test("deduplicates a native tool event by message and call identity", async () => {
		const directory = await mkdtemp(join(tmpdir(), "omo-v2-agent-reminder-call-id-"))
		roots.push(directory)
		const harness = makeHarness(directory)
		const cleanup = await registerV2AgentUsageReminder(harness.ctx, {} as OhMyOpenCodeConfig)
		await harness.subscribed

		const first = toolEvent({ tool: "grep", sessionID: "ses-call-identity", id: "same-call-id", messageID: "msg-first" })
		const duplicate = toolEvent({ tool: "grep", sessionID: "ses-call-identity", id: "same-call-id", messageID: "msg-first" })
		const nextMessage = toolEvent({ tool: "grep", sessionID: "ses-call-identity", id: "same-call-id", messageID: "msg-second" })
		await harness.after(first)
		await harness.after(duplicate)
		await harness.after(nextMessage)
		expect(resultText(first.result)).toContain(REMINDER_MESSAGE.trim())
		expect(resultText(duplicate.result)).not.toContain(REMINDER_MESSAGE.trim())
		expect(resultText(nextMessage.result)).toContain(REMINDER_MESSAGE.trim())
		await cleanup()
	})

	test("deletes scoped state on session.deleted and does not mutate after disposal", async () => {
		const directory = await mkdtemp(join(tmpdir(), "omo-v2-agent-reminder-delete-"))
		roots.push(directory)
		const harness = makeHarness(directory)
		const cleanup = await registerV2AgentUsageReminder(harness.ctx, {} as OhMyOpenCodeConfig)
		await harness.subscribed
		const first = toolEvent({ tool: "grep", sessionID: "ses-delete", id: "call-before-delete" })
		await harness.after(first)
		const key = [...harness.storage.values.keys()][0]
		expect(key).toBeDefined()

		harness.emit({
			type: "session.deleted",
			location: { directory, workspaceID: "workspace-agent-reminder" },
			data: { sessionID: "ses-delete" },
		})
		await waitUntil(() => harness.storage.values.size === 0)
		const afterDelete = toolEvent({ tool: "grep", sessionID: "ses-delete", id: "call-after-delete" })
		await harness.after(afterDelete)
		expect(resultText(afterDelete.result)).toContain(REMINDER_MESSAGE.trim())
		await cleanup()

		const beforeDispose = toolEvent({ tool: "grep", sessionID: "ses-disposed", id: "call-before-dispose" })
		await harness.after(beforeDispose)
		expect(resultText(beforeDispose.result)).not.toContain(REMINDER_MESSAGE.trim())
		expect(harness.disposed).toEqual(["execute.after"])
	})

	test("honors disabled_hooks without registering tool or event hooks", async () => {
		const directory = await mkdtemp(join(tmpdir(), "omo-v2-agent-reminder-disabled-"))
		roots.push(directory)
		const harness = makeHarness(directory)
		const cleanup = await registerV2AgentUsageReminder(harness.ctx, { disabled_hooks: ["agent-usage-reminder"] } as OhMyOpenCodeConfig)
		expect(harness.disposed).toEqual([])
		expect(harness.storage.values.size).toBe(0)
		await cleanup()
	})
})
