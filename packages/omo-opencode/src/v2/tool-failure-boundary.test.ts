import { describe, expect, test } from "bun:test"
import type * as NativePlugin from "@opencode/plugin/effect/plugin"
import { Error as ToolError, type Info as NativeToolInfo } from "@opencode/schema/tool"
import { Cause, Effect, Exit, Schema } from "effect"
import { unsafeTestValue } from "../../../../test-support/unsafe-test-value"
import { preserveToolErrorFailure, withToolFailureBoundary } from "./tool-failure-boundary"

type NativeToolEditor = Parameters<Parameters<NativePlugin.Context["tool"]["transform"]>[0]>[0]
type Hook = { name: string; callback: (event: never) => Effect.Effect<void, unknown> }

function makeTool(name: string, execute: NativeToolInfo["execute"]): NativeToolInfo {
	return {
		name,
		description: "Boundary test tool",
		input: Schema.Struct({}),
		options: { codemode: false },
		execute,
	}
}

function makeHarness(initial: NativeToolInfo[] = []) {
	const tools = new Map(initial.map((tool) => [tool.name, tool]))
	const hooks: Hook[] = []
	const editor: NativeToolEditor = {
		list: () => Array.from(tools.values()).map((tool) => ({ ...tool, id: tool.name })),
		get: (id) => {
			const tool = tools.get(id)
			return tool ? { ...tool, id } : undefined
		},
		namespace: () => undefined,
		add: (tool) => { tools.set(tool.name, tool) },
		update: (id, update) => {
			const tool = tools.get(id)
			if (tool) update(tool as never)
		},
		remove: (id) => { tools.delete(id) },
	}
	const context = unsafeTestValue<NativePlugin.Context>({
		tool: {
			transform: (callback: (editor: NativeToolEditor) => void) => {
				callback(editor)
				return Effect.succeed({ dispose: Effect.void })
			},
			hook: (name: string, callback: Hook["callback"]) => {
				hooks.push({ name, callback })
				return Effect.succeed({ dispose: Effect.void })
			},
			reload: () => Effect.void,
			list: () => Effect.succeed([]),
		},
	})
	return { context, tools, hooks }
}

function assertTypedFailure<A>(exit: Exit.Exit<A, unknown>, error: ToolError): void {
	expect(Exit.isFailure(exit)).toBe(true)
	if (Exit.isSuccess(exit)) throw new Error("expected a failed Effect")
	expect(exit.cause.reasons).toHaveLength(1)
	const reason = exit.cause.reasons[0]
	if (!reason || !Cause.isFailReason(reason)) throw new Error("expected a typed failure reason")
	expect(reason.error).toBe(error)
}

function executeContext(): Parameters<NativeToolInfo["execute"]>[1] {
	return {
		sessionID: "ses_boundary",
		agent: "sisyphus",
		messageID: "msg_boundary",
		id: "call_boundary" as never,
		progress: () => Effect.void,
	}
}

describe("native Effect Tool.Error boundary", () => {
	test("converts a Promise-adapter defect back to typed Tool.Error and preserves identity/metadata", async () => {
		const cause = new Error("file access cause")
		const error = new ToolError({ message: "Could not find oldString in src/example.ts", error: cause, metadata: { path: "src/example.ts" } })
		const harness = makeHarness()
		const context = withToolFailureBoundary(harness.context)
		const registration = context.tool.transform((editor) => {
			editor.add(makeTool("owned_tool", () => Effect.promise(() => Promise.reject(error))))
		})
		await Effect.runPromise(registration)

		const registered = harness.tools.get("owned_tool")
		if (!registered) throw new Error("tool was not registered")
		const exit = await Effect.runPromiseExit(registered.execute({}, executeContext()))
		assertTypedFailure(exit, error)
		if (!Exit.isFailure(exit)) throw new Error("expected a failed Effect")
		const failure = exit.cause.reasons[0]
		if (!failure || !Cause.isFailReason(failure) || !(failure.error instanceof ToolError)) {
			throw new Error("expected the native Tool.Error instance")
		}
		expect(failure.error.error).toBe(cause)
		expect(failure.error.metadata).toEqual({ path: "src/example.ts" })
	})

	test("wraps updated native executors after their update callback", async () => {
		const error = new ToolError({ message: "update failed" })
		const harness = makeHarness([makeTool("native_alias", () => Effect.succeed({ content: "old" }))])
		const context = withToolFailureBoundary(harness.context)
		await Effect.runPromise(context.tool.transform((editor) => {
			editor.update("native_alias", (tool) => {
				tool.execute = () => Effect.promise(() => Promise.reject(error))
			})
		}))

		const registered = harness.tools.get("native_alias")
		if (!registered) throw new Error("updated tool disappeared")
		assertTypedFailure(await Effect.runPromiseExit(registered.execute({}, executeContext())), error)
	})

	test("converts rejected execute.before callbacks without changing other hook registrations", async () => {
		const error = new ToolError({ message: "guard rejected write", metadata: { guard: "notepad-write" } })
		const harness = makeHarness()
		const context = withToolFailureBoundary(harness.context)
		const callback = () => Effect.promise(() => Promise.reject(error))
		await Effect.runPromise(context.tool.hook("execute.before", callback))
		const before = harness.hooks[0]
		if (!before) throw new Error("before hook was not registered")
		assertTypedFailure(await Effect.runPromiseExit(before.callback({} as never)), error)

		const afterCallback = () => Effect.void
		await Effect.runPromise(context.tool.hook("execute.after", afterCallback))
		expect(harness.hooks[1]?.callback).toBe(afterCallback)
	})

	test("keeps successful outputs unchanged", async () => {
		const output = { output: { value: 7 }, content: "unchanged", metadata: { source: "test" } }
		const harness = makeHarness()
		const context = withToolFailureBoundary(harness.context)
		await Effect.runPromise(context.tool.transform((editor) => {
			editor.add(makeTool("success", () => Effect.succeed(output)))
		}))
		const registered = harness.tools.get("success")
		if (!registered) throw new Error("tool was not registered")
		expect(await Effect.runPromise(registered.execute({}, executeContext()))).toBe(output)
	})

	test("does not convert unknown defects or interruptions", async () => {
		const unknown = new Error("unexpected programming defect")
		const unknownExit = await Effect.runPromiseExit(preserveToolErrorFailure(Effect.promise(() => Promise.reject(unknown))))
		expect(Exit.isFailure(unknownExit)).toBe(true)
		if (Exit.isFailure(unknownExit)) {
			const reason = unknownExit.cause.reasons[0]
			expect(reason && Cause.isDieReason(reason)).toBe(true)
			if (reason && Cause.isDieReason(reason)) expect(reason.defect).toBe(unknown)
		}

		const interruptExit = await Effect.runPromiseExit(preserveToolErrorFailure(Effect.interrupt))
		expect(Exit.isFailure(interruptExit)).toBe(true)
		if (Exit.isFailure(interruptExit)) {
			const reason = interruptExit.cause.reasons[0]
			expect(reason && Cause.isInterruptReason(reason)).toBe(true)
		}
	})

	test("uses the public Tool.Error schema and leaves arbitrary tag-shaped values as defects", async () => {
		const genuine = new ToolError({ message: "schema-validated failure", metadata: { source: "schema" } })
		expect(Schema.is(ToolError)(genuine)).toBe(true)
		assertTypedFailure(await Effect.runPromiseExit(preserveToolErrorFailure(Effect.die(genuine))), genuine)

		const arbitrary = { _tag: "Tool.Error", message: "not a yieldable native error" }
		expect(Schema.is(ToolError)(arbitrary)).toBe(false)
		const arbitraryExit = await Effect.runPromiseExit(preserveToolErrorFailure(Effect.die(arbitrary)))
		expect(Exit.isFailure(arbitraryExit)).toBe(true)
		if (Exit.isFailure(arbitraryExit)) {
			const reason = arbitraryExit.cause.reasons[0]
			expect(reason && Cause.isDieReason(reason)).toBe(true)
			if (reason && Cause.isDieReason(reason)) expect(reason.defect).toBe(arbitrary)
		}
	})
})
