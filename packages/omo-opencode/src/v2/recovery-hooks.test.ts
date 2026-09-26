import { describe, expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin"
import { Error as NativeToolError, type Result as NativeToolResult } from "@opencode/plugin/promise/tool"
import type { OhMyOpenCodeConfig } from "../config"
import { unsafeTestValue } from "../../../../test-support/unsafe-test-value"
import { registerV2RecoveryHooks } from "./recovery-hooks"

const EDIT_MARKER = "[EDIT ERROR - IMMEDIATE ACTION REQUIRED]"
const JSON_MARKER = "[JSON PARSE ERROR - IMMEDIATE ACTION REQUIRED]"
const EMPTY_MARKER = "[Task Empty Response Warning]"
const NO_TEXT = "Subagent completed without a text response."

type FailureEvent = {
	tool: string
	sessionID: string
	agent: string
	messageID: string
	id: string
	input: unknown
	status: "error"
	error: InstanceType<typeof NativeToolError>
}

type CompletedEvent = {
	tool: string
	sessionID: string
	agent: string
	messageID: string
	id: string
	input: unknown
	status: "completed"
	result: NativeToolResult
}

type TestEvent = FailureEvent | CompletedEvent
type Callback = (event: TestEvent) => Promise<void> | void

function makeFailure(tool: string, message: string): FailureEvent {
	return {
		tool,
		sessionID: "ses_recovery",
		agent: "sisyphus",
		messageID: "msg_recovery",
		id: "call_recovery",
		input: {},
		status: "error",
		error: new NativeToolError({ message }),
	}
}

function makeCompleted(tool: string, result: NativeToolResult): CompletedEvent {
	return {
		tool,
		sessionID: "ses_recovery",
		agent: "sisyphus",
		messageID: "msg_recovery",
		id: "call_recovery",
		input: {},
		status: "completed",
		result,
	}
}

function createHarness(failOnRegistration?: number) {
	const callbacks: Callback[] = []
	const disposed: number[] = []
	let registrations = 0
	const ctx = unsafeTestValue<Plugin.Context>({
		tool: {
			hook: async (_name: "execute.after", callback: Callback) => {
				registrations += 1
				const ordinal = registrations
				if (ordinal === failOnRegistration) throw new Error(`registration failed at ${ordinal}`)
				callbacks.push(callback)
				return { dispose: async () => { disposed.push(ordinal) } }
			},
		},
	})
	return {
		ctx,
		callbacks,
		disposed,
		get registrations() { return registrations },
		async run(event: TestEvent) {
			for (const callback of callbacks) await callback(event)
		},
	}
}

function textFromContent(content: NativeToolResult["content"]): string {
	if (typeof content === "string") return content
	if (!Array.isArray(content)) return ""
	return content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n")
}

describe("native v2 recovery hooks", () => {
	test("recognizes native Edit failure wording and preserves the original failure cause and metadata", async () => {
		const host = createHarness()
		const cleanup = await registerV2RecoveryHooks(host.ctx, {} as OhMyOpenCodeConfig)
		const cases = [
			"No changes to apply: oldString and newString are identical.",
			"Could not find oldString in src/app.ts. It must match exactly.",
			"Found 3 matches for oldString, but expected exactly one.",
			"oldString found multiple times and requires more context.",
		]

		for (const message of cases) {
			const cause = new Error("native edit cause")
			const metadata = { files: ["src/app.ts"], retryable: false }
			const event = makeFailure("edit", message)
			const original = new NativeToolError({ message, error: cause, metadata })
			event.error = original
			await host.run(event)

			expect(event.status).toBe("error")
			expect(event.error).toBeInstanceOf(NativeToolError)
			expect(event.error).not.toBe(original)
			expect(event.error.message).toContain(message)
			expect(event.error.message).toContain(EDIT_MARKER)
			expect(event.error.error).toBe(cause)
			expect(event.error.metadata).toEqual(metadata)
			expect(original.message).toBe(message)
		}

		await cleanup()
	})

	test("does not rewrite unrelated Edit errors or successful result text that mentions an edit error", async () => {
		const host = createHarness()
		const cleanup = await registerV2RecoveryHooks(host.ctx, {} as OhMyOpenCodeConfig)
		const failure = makeFailure("edit", "File not found: src/missing.ts")
		const originalError = failure.error
		await host.run(failure)
		expect(failure.error).toBe(originalError)
		expect(failure.error.message).not.toContain(EDIT_MARKER)

		const content = [{ type: "text", text: "Could not find oldString in this user-provided example." }] as const
		const result: NativeToolResult = { output: { ok: true }, content, metadata: { kept: true } }
		const success = makeCompleted("edit", result)
		await host.run(success)
		expect(success.result).toBe(result)
		expect(success.result.content).toBe(content)
		await cleanup()
	})

	test("adds JSON guidance to matching schema failures and excludes content-heavy native tools", async () => {
		const host = createHarness()
		const cleanup = await registerV2RecoveryHooks(host.ctx, {} as OhMyOpenCodeConfig)
		const cause = new Error("schema parse cause")
		const metadata = { field: "input", source: "host" }
		const event = makeFailure("custom_schema_tool", "JSON parse error: unexpected end of JSON input")
		const original = new NativeToolError({ message: event.error.message, error: cause, metadata })
		event.error = original
		await host.run(event)
		expect(event.status).toBe("error")
		expect(event.error.message).toContain(JSON_MARKER)
		expect(event.error.error).toBe(cause)
		expect(event.error.metadata).toEqual(metadata)
		await host.run(event)
		expect(event.error.message.split(JSON_MARKER)).toHaveLength(2)

		for (const tool of ["read", "shell", "task", "call_omo_agent", "subagent", "skill_mcp"]) {
			const excluded = makeFailure(tool, "JSON parse error: unexpected end of JSON input")
			const originalError = excluded.error
			await host.run(excluded)
			expect(excluded.error).toBe(originalError)
		}
		await cleanup()
	})

	test("does not inspect successful text or structured output for JSON error phrases", async () => {
		const host = createHarness()
		const cleanup = await registerV2RecoveryHooks(host.ctx, {} as OhMyOpenCodeConfig)
		const result: NativeToolResult = {
			output: { text: "The JSON parse error example is quoted user text." },
			content: [{ type: "text", text: "A file contains malformed JSON; this is not a tool failure." }],
			metadata: { source: "read" },
		}
		const event = makeCompleted("edit", result)
		await host.run(event)
		expect(event.result).toBe(result)
		expect(event.result.content).toBe(result.content)
		await cleanup()
	})

	test("appends empty-task guidance to model-facing content and preserves structured output", async () => {
		const host = createHarness()
		const cleanup = await registerV2RecoveryHooks(host.ctx, {} as OhMyOpenCodeConfig)
		const originalContent = [{ type: "text", text: "" }] as const
		const metadata = { status: "completed", sessionID: "ses_child", provider: { trace: "kept" } }
		const output = { sessionID: "ses_child", status: "completed", output: " \n ", custom: "kept" }
		const result: NativeToolResult = { output, content: originalContent, metadata }
		const event = makeCompleted("task", result)
		await host.run(event)

		expect(event.result).not.toBe(result)
		expect(event.result.output).toBe(output)
		expect((event.result.output as typeof output).output).toBe(output.output)
		expect(event.result.metadata).toBe(metadata)
		expect(Array.isArray(event.result.content)).toBe(true)
		expect(event.result.content).toEqual([...originalContent, { type: "text", text: expect.stringContaining(EMPTY_MARKER) }])
		const warningText = textFromContent(event.result.content)
		expect(warningText).toContain(EMPTY_MARKER)
		expect(warningText).toContain("Do not infer that the task objective was fulfilled.")
		expect(warningText).not.toContain("completed successfully")
		const warningContent = event.result.content
		await host.run(event)
		expect(event.result.content).toBe(warningContent)
		expect(textFromContent(event.result.content).split(EMPTY_MARKER)).toHaveLength(2)

		const sentinelOutput = { sessionID: "ses_child_2", status: "completed", output: NO_TEXT }
		const nativeSentinel = makeCompleted("call_omo_agent", {
			output: sentinelOutput,
			content: "",
			metadata: { source: "subagent" },
		})
		await host.run(nativeSentinel)
		expect(nativeSentinel.result.output).toBe(sentinelOutput)
		expect((nativeSentinel.result.output as typeof sentinelOutput).output).toBe(NO_TEXT)
		expect(nativeSentinel.result.content).toContain(EMPTY_MARKER)
		const sentinelContent = nativeSentinel.result.content
		await host.run(nativeSentinel)
		expect(nativeSentinel.result.content).toBe(sentinelContent)

		const file = { type: "file", uri: "file:///tmp/result.png", mime: "image/png", name: "result.png" } as const
		const fileResult: NativeToolResult = {
			output: { sessionID: "ses_file", status: "completed", output: "" },
			content: [file],
		}
		const fileEvent = makeCompleted("task", fileResult)
		await host.run(fileEvent)
		expect(fileEvent.result).toBe(fileResult)
		expect(fileEvent.result.content).toBe(fileResult.content)
		await cleanup()
	})

	test("does not warn on running, nonempty, failed, malformed, or unrelated task results", async () => {
		const host = createHarness()
		const cleanup = await registerV2RecoveryHooks(host.ctx, {} as OhMyOpenCodeConfig)
		const unchanged = [
			makeCompleted("task", { output: { status: "running", output: "" }, content: "running" }),
			makeCompleted("subagent", { output: { status: "completed", output: "Agent returned a result." }, content: "Agent returned a result." }),
			makeCompleted("task", { output: { status: "completed" }, content: "" }),
			makeCompleted("background_output", { output: { status: "completed", output: "" }, content: "" }),
		]
		const originalResults = unchanged.map((event) => event.result)
		for (const event of unchanged) await host.run(event)
		unchanged.forEach((event, index) => expect(event.result).toBe(originalResults[index]))

		const failed = makeFailure("task", "JSON parse error: malformed child request")
		const originalError = failed.error
		await host.run(failed)
		expect(failed.error).toBe(originalError)
		await cleanup()
	})

	test("honors each recovery hook disable switch independently", async () => {
		const disabledCases = [
			{
				disabled: "edit-error-recovery",
				event: makeFailure("edit", "Could not find oldString in file.ts"),
				marker: EDIT_MARKER,
			},
			{
				disabled: "json-error-recovery",
				event: makeFailure("custom_schema_tool", "JSON parse error: invalid JSON"),
				marker: JSON_MARKER,
			},
			{
				disabled: "empty-task-response-detector",
				event: makeCompleted("task", { output: { status: "completed", output: "" }, content: "" }),
				marker: EMPTY_MARKER,
			},
		] as const

		for (const fixture of disabledCases) {
			const host = createHarness()
			const cleanup = await registerV2RecoveryHooks(host.ctx, {
				disabled_hooks: [fixture.disabled],
			} as OhMyOpenCodeConfig)
			expect(host.callbacks).toHaveLength(2)
			await host.run(fixture.event)
			const value = fixture.event.status === "error" ? fixture.event.error.message : JSON.stringify(fixture.event.result)
			expect(value).not.toContain(fixture.marker)
			const activeCheck = fixture.disabled === "edit-error-recovery"
				? makeFailure("custom_schema_tool", "JSON parse error: active hook check")
				: makeFailure("edit", "Could not find oldString in active-hook-check.ts")
			const activeMarker = fixture.disabled === "edit-error-recovery"
				? JSON_MARKER
				: EDIT_MARKER
			await host.run(activeCheck)
			const activeValue = activeCheck.status === "error" ? activeCheck.error.message : JSON.stringify(activeCheck.result)
			expect(activeValue).toContain(activeMarker)
			await cleanup()
		}
	})

	test("unwinds earlier registrations on failure and cleanup is idempotent", async () => {
		const failedHost = createHarness(3)
		await expect(registerV2RecoveryHooks(failedHost.ctx, {} as OhMyOpenCodeConfig)).rejects.toThrow("registration failed at 3")
		expect(failedHost.registrations).toBe(3)
		expect(failedHost.disposed).toEqual([2, 1])

		const host = createHarness()
		const cleanup = await registerV2RecoveryHooks(host.ctx, {} as OhMyOpenCodeConfig)
		expect(host.callbacks).toHaveLength(3)
		const event = makeFailure("edit", "Could not find oldString in file.ts")
		await cleanup()
		await cleanup()
		expect(host.disposed).toEqual([3, 2, 1])
		await host.run(event)
		expect(event.error.message).not.toContain(EDIT_MARKER)
	})
})
