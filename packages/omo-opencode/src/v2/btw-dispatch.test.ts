import { describe, expect, mock, test } from "bun:test"
import type { OpenCodeClient } from "@opencode/client"
import { createNativeBtwDispatcher } from "./btw-dispatch"

type SessionApi = Pick<OpenCodeClient["session"], "fork" | "prompt">

function deferred<T>() {
	let resolve!: (value: T) => void
	let reject!: (error: unknown) => void
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise
		reject = rejectPromise
	})
	return { promise, resolve, reject }
}

function makeSession(overrides: Partial<SessionApi> = {}) {
	const fork = overrides.fork ?? mock(async ({ sessionID }: { sessionID: string }) => ({ id: `child:${sessionID}:${Math.random()}` }) as Awaited<ReturnType<SessionApi["fork"]>>)
	const prompt = overrides.prompt ?? mock(async (_input: Parameters<SessionApi["prompt"]>[0]) => ({}) as Awaited<ReturnType<SessionApi["prompt"]>>)
	const session = { fork, prompt } as SessionApi
	return { session, fork, prompt }
}

describe("native BTW dispatch gate", () => {
	test("coalesces concurrent duplicate fork-and-prompt requests to one distinct child", async () => {
		const forked = deferred<Awaited<ReturnType<SessionApi["fork"]>>>()
		const { session, fork, prompt } = makeSession({ fork: mock(() => forked.promise) })
		const dispatcher = createNativeBtwDispatcher(session)
		const first = dispatcher.dispatch({ parentSessionID: "parent-a", question: "inspect this" })
		const duplicate = dispatcher.dispatch({ parentSessionID: "parent-a", question: "  inspect this  " })
		forked.resolve({ id: "child-a" } as Awaited<ReturnType<SessionApi["fork"]>>)

		await expect(Promise.all([first, duplicate])).resolves.toEqual(["child-a", "child-a"])
		expect(fork).toHaveBeenCalledTimes(1)
		expect(prompt).toHaveBeenCalledTimes(1)
		expect(prompt).toHaveBeenCalledWith({ sessionID: "child-a", text: "inspect this" })
		expect(prompt.mock.calls[0]?.[0].sessionID).not.toBe("parent-a")
		dispatcher.dispose()
	})

	test("holds successful and rejected operations after settlement", async () => {
		const successful = makeSession()
		const successDispatcher = createNativeBtwDispatcher(successful.session)
		const childID = await successDispatcher.dispatch({ parentSessionID: "parent-a", question: "same" })
		await new Promise<void>((resolve) => setTimeout(resolve, 10))
		await expect(successDispatcher.dispatch({ parentSessionID: "parent-a", question: "same" })).resolves.toBe(childID)
		expect(successful.fork).toHaveBeenCalledTimes(1)
		expect(successful.prompt).toHaveBeenCalledTimes(1)
		successDispatcher.dispose()

		const rejected = makeSession({ fork: mock(async () => { throw new Error("fork failed") }) })
		const rejectDispatcher = createNativeBtwDispatcher(rejected.session)
		await expect(rejectDispatcher.dispatch({ parentSessionID: "parent-b", question: "same" })).rejects.toThrow("fork failed")
		await new Promise<void>((resolve) => setTimeout(resolve, 10))
		await expect(rejectDispatcher.dispatch({ parentSessionID: "parent-b", question: "same" })).rejects.toThrow("fork failed")
		expect(rejected.fork).toHaveBeenCalledTimes(1)
		expect(rejected.prompt).not.toHaveBeenCalled()
		rejectDispatcher.dispose()

		const promptRejected = makeSession({ prompt: mock(async () => { throw new Error("child prompt failed") }) })
		const promptRejectDispatcher = createNativeBtwDispatcher(promptRejected.session)
		await expect(promptRejectDispatcher.dispatch({ parentSessionID: "parent-c", question: "same" })).rejects.toThrow("child prompt failed")
		await new Promise<void>((resolve) => setTimeout(resolve, 10))
		await expect(promptRejectDispatcher.dispatch({ parentSessionID: "parent-c", question: "same" })).rejects.toThrow("child prompt failed")
		expect(promptRejected.fork).toHaveBeenCalledTimes(1)
		expect(promptRejected.prompt).toHaveBeenCalledTimes(1)
		promptRejectDispatcher.dispose()
	})

	test("does not merge different questions or parent sessions", async () => {
		const { session, fork } = makeSession()
		const dispatcher = createNativeBtwDispatcher(session)
		const children = await Promise.all([
			dispatcher.dispatch({ parentSessionID: "parent-a", question: "question one" }),
			dispatcher.dispatch({ parentSessionID: "parent-a", question: "question two" }),
			dispatcher.dispatch({ parentSessionID: "parent-b", question: "question one" }),
		])
		expect(children).toHaveLength(3)
		expect(fork).toHaveBeenCalledTimes(3)
		dispatcher.dispose()
	})

	test("blocks the child prompt if cleanup happens while fork is pending and rejects later calls", async () => {
		const forked = deferred<Awaited<ReturnType<SessionApi["fork"]>>>()
		const { session, fork, prompt } = makeSession({ fork: mock(() => forked.promise) })
		const dispatcher = createNativeBtwDispatcher(session)
		const pending = dispatcher.dispatch({ parentSessionID: "parent-a", question: "pending" })
		dispatcher.dispose()
		await expect(dispatcher.dispatch({ parentSessionID: "parent-a", question: "after cleanup" })).rejects.toThrow("disposed")
		forked.resolve({ id: "child-after-cleanup" } as Awaited<ReturnType<SessionApi["fork"]>>)
		await expect(pending).rejects.toThrow("disposed")
		expect(fork).toHaveBeenCalledTimes(1)
		expect(prompt).not.toHaveBeenCalled()
	})

	test("rejects a host fork response that points back to the parent session", async () => {
		const { session, prompt } = makeSession({ fork: mock(async () => ({ id: "parent-a" }) as Awaited<ReturnType<SessionApi["fork"]>>) })
		const dispatcher = createNativeBtwDispatcher(session)
		await expect(dispatcher.dispatch({ parentSessionID: "parent-a", question: "unsafe target" })).rejects.toThrow("distinct child session")
		expect(prompt).not.toHaveBeenCalled()
		dispatcher.dispose()
	})
})
