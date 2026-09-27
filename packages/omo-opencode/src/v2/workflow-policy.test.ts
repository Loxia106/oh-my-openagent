import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Plugin } from "@opencode/plugin"
import {
	classifyWorkflowAgent,
	createV2WorkflowPolicyStore,
	hasUnansweredNativeQuestion,
	isTangibleProgressTool,
	markAtlasDispatched,
	markAtlasToolProgress,
	markTodoDispatched,
	observeAtlasTurn,
	observeTodoTurn,
	successfulTangibleToolResult,
	todoStatusSignature,
	type WorkflowPolicyRecord,
} from "./workflow-policy"

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))))

function emptyPolicy(): WorkflowPolicyRecord {
	return {
		version: 1,
		scope: "scope",
		sessionID: "ses-one",
		stopped: false,
		todo: { stagnationCount: 0, awaitingProgress: false, consecutiveFailures: 0 },
		atlas: { noProgressIterations: 0, awaitingToolProgress: false, toolProgress: false, stalled: false, consecutiveFailures: 0 },
		compactionPending: false,
	}
}

describe("native workflow policy", () => {
	test("todo progress is based only on stable task identity and status", () => {
		const first = [
			{ id: "a", content: "original", priority: "low" as const, status: "pending" as const },
			{ content: "fallback identity", priority: "high" as const, status: "in_progress" as const },
		]
		const editedText = [
			{ id: "a", content: "rewritten", priority: "high" as const, status: "pending" as const },
			{ content: "fallback identity", priority: "low" as const, status: "in_progress" as const },
		]
		expect(todoStatusSignature(first)).toBe(todoStatusSignature(editedText))
		expect(todoStatusSignature([{ ...editedText[0]!, status: "completed" as const }, editedText[1]!])).not.toBe(todoStatusSignature(editedText))
	})

	test("todo continuation stalls after three unchanged responses and resets only on status progress", () => {
		const todos = [{ id: "1", content: "finish work", status: "pending" as const }]
		let state = emptyPolicy().todo
		let decision = observeTodoTurn(state, todos, 10_000)
		expect(decision.decision).toMatchObject({ allowed: true, progressed: false })
		state = markTodoDispatched(decision.state, 10_000)

		for (const now of [16_000, 22_000]) {
			decision = observeTodoTurn(state, todos, now)
			expect(decision.decision.allowed).toBe(true)
			state = markTodoDispatched(decision.state, now)
		}
		decision = observeTodoTurn(state, todos, 28_000)
		expect(decision.decision).toMatchObject({ allowed: false, reason: "stagnant" })

		const progressed = observeTodoTurn(decision.state, [{ ...todos[0]!, status: "completed" }], 34_000)
		expect(progressed.decision).toMatchObject({ allowed: false, reason: "complete", progressed: true })
		expect(progressed.state.stagnationCount).toBe(0)
	})

	test("todo dispatch failure backoff and cooldown are bounded and recover", () => {
		let state = emptyPolicy().todo
		const todos = [{ content: "continue", status: "pending" as const }]
		let decision = observeTodoTurn(state, todos, 1_000)
		state = decision.state
		for (const now of [1_000, 7_000, 13_000, 19_000, 25_000]) {
			state = { ...state, lastDispatchAt: now - 6_000, consecutiveFailures: Math.min(5, state.consecutiveFailures + 1), lastFailureAt: now }
		}
		decision = observeTodoTurn(state, todos, 30_000)
		expect(decision.decision).toMatchObject({ allowed: false, reason: "failure-backoff" })
		decision = observeTodoTurn(state, todos, 5 * 60_000 + 26_000)
		expect(decision.decision.allowed).toBe(true)
		state = markTodoDispatched(decision.state, 5 * 60_000 + 26_000)
		expect(observeTodoTurn(state, todos, 5 * 60_000 + 27_000).decision.reason).toBe("cooldown")
	})

	test("Atlas progress counts only an explicitly recorded successful tangible action and resets on plan change", () => {
		let state = emptyPolicy().atlas
		for (const now of [10_000, 16_000, 22_000]) {
			const decision = observeAtlasTurn({ state, workID: "work-a", planPath: "/p/a.md", fingerprint: "a", remaining: true, now })
			expect(decision.allowed).toBe(true)
			state = markAtlasDispatched(decision.state, now)
		}
		let decision = observeAtlasTurn({ state, workID: "work-a", planPath: "/p/a.md", fingerprint: "a", remaining: true, now: 28_000 })
		expect(decision).toMatchObject({ allowed: false, reason: "stalled", state: { noProgressIterations: 3, stalled: true } })

		state = markAtlasToolProgress(decision.state)
		decision = observeAtlasTurn({ state, workID: "work-a", planPath: "/p/a.md", fingerprint: "a", remaining: true, now: 34_000 })
		expect(decision).toMatchObject({ allowed: true, progressed: true, state: { noProgressIterations: 0, stalled: false } })
		decision = observeAtlasTurn({ state: decision.state, workID: "work-b", planPath: "/p/b.md", fingerprint: "b", remaining: true, now: 35_000 })
		expect(decision).toMatchObject({ allowed: true, state: { noProgressIterations: 0, stalled: false } })
	})

	test("agent gates keep planning/compaction agents out of todo and identify orchestrators", () => {
		expect(classifyWorkflowAgent("Prometheus")).toBe("skip")
		expect(classifyWorkflowAgent("plan")).toBe("skip")
		expect(classifyWorkflowAgent("compaction")).toBe("skip")
		expect(classifyWorkflowAgent("Sisyphus-Junior")).toBe("orchestrator")
		expect(classifyWorkflowAgent("custom-reviewer")).toBe("todo")
		expect(classifyWorkflowAgent(undefined)).toBe("skip")
	})

	test("pending question detection stops at the newest real user message", () => {
		const unanswered = [
			{ type: "assistant", content: [{ type: "tool", name: "question", state: { status: "running" } }] },
		]
		expect(hasUnansweredNativeQuestion(unanswered)).toBe(true)
		expect(hasUnansweredNativeQuestion([
			...unanswered,
			{ type: "user", metadata: { source: "user" }, content: [{ type: "text", text: "Choice B" }] },
		])).toBe(false)
		expect(hasUnansweredNativeQuestion([
			...unanswered,
			{ type: "user", metadata: { synthetic: true } },
		])).toBe(true)
	})

	test("tangible native progress requires a successful result and rejects shell status/exit failures", () => {
		expect(isTangibleProgressTool("shell")).toBe(true)
		expect(isTangibleProgressTool("apply_patch")).toBe(true)
		expect(isTangibleProgressTool("hashline_edit")).toBe(true)
		expect(isTangibleProgressTool("read")).toBe(false)
		expect(successfulTangibleToolResult({ output: { status: "completed", exit: 0, output: "" } })).toBe(true)
		expect(successfulTangibleToolResult({ output: { status: "completed", output: "ordinary stdout" } })).toBe(true)
		expect(successfulTangibleToolResult({ output: { status: "completed", exit: 0, output: "" }, content: [] })).toBe(true)
		expect(successfulTangibleToolResult({ content: [{ type: "text", text: "Error: text from a successful tool" }] })).toBe(true)
		expect(successfulTangibleToolResult({ output: { status: "completed", exit: 2, output: "ordinary text" } })).toBe(false)
		expect(successfulTangibleToolResult({ output: { status: "completed", exitCode: 17, output: "ordinary stdout" } })).toBe(false)
		expect(successfulTangibleToolResult({ output: { status: "completed", code: 1, output: "ordinary stdout" } })).toBe(false)
		expect(successfulTangibleToolResult({ output: { status: "completed", exit: 0, timeout: true, output: "partial" } })).toBe(false)
		expect(successfulTangibleToolResult({ output: { status: "running", output: "background" } })).toBe(false)
		expect(successfulTangibleToolResult({ output: { status: "aborted", output: "partial" } })).toBe(false)
		expect(successfulTangibleToolResult({ output: { status: "error", output: "partial" } })).toBe(false)
		expect(successfulTangibleToolResult({ status: "error", error: { message: "tool failed" } })).toBe(false)
		expect(successfulTangibleToolResult({ status: "aborted" })).toBe(false)
		expect(successfulTangibleToolResult(undefined)).toBe(false)
	})

	test("durable workflow state serializes concurrent updates and isolates project scopes", async () => {
		const directory = await mkdtemp(join(tmpdir(), "omo-v2-workflow-policy-"))
		roots.push(directory)
		const storageData = new Map<string, unknown>()
		const ctx = (projectID: string) => ({
			location: { directory, workspaceID: "workspace", project: { id: projectID } },
			storage: {
				get: async (key: string) => storageData.get(key),
				set: async (key: string, value: unknown) => { storageData.set(key, value) },
				remove: async (key: string) => { storageData.delete(key) },
			},
		}) as unknown as Plugin.Context
		const first = await createV2WorkflowPolicyStore(ctx("project-a"))
		const second = await createV2WorkflowPolicyStore(ctx("project-b"))
		await Promise.all(Array.from({ length: 8 }, async () => first.update("ses-one", (state) => ({
			...state,
			todo: { ...state.todo, lastDispatchAt: (state.todo.lastDispatchAt ?? 0) + 1 },
		}))))
		expect((await first.get("ses-one")).todo.lastDispatchAt).toBe(8)
		expect((await second.get("ses-one")).todo.lastDispatchAt).toBeUndefined()
		await first.update("ses-one", (state) => ({ ...state, stopped: true }))
		const restarted = await createV2WorkflowPolicyStore(ctx("project-a"))
		expect((await restarted.get("ses-one")).stopped).toBe(true)
		await first.dispose()
		await second.dispose()
		await restarted.dispose()
	})
})
