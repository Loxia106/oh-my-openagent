import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Plugin } from "@opencode/plugin"
import { Error as ToolError } from "@opencode/plugin/promise/tool"
import type { OhMyOpenCodeConfig } from "../config"
import { createV2SubagentRunState } from "./task-state"
import { registerV2BackgroundToolPolicy } from "./background-tool-policy"

const POLICY_PREFIX = "oh-my-openagent:v2:background-tool-policy:"
const roots: string[] = []

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

type TestEvent = {
	sessionID: string
	messageID: string
	id: string
	tool: string
	input: unknown
}

type TestSession = {
	id: string
	parentID?: string
	projectID: string
	location: { directory: string; workspaceID?: string }
}

type StoredPolicy = {
	toolCalls: number
	consecutiveCount: number
	lastSignature?: string
	countedCalls: string[]
	lastTrigger?: { type: string; tool: string; count: number; limit: number }
}

type HarnessOptions = {
	readonly failPolicyRead?: () => boolean
	readonly failPolicyWrite?: () => boolean
	readonly failRegistration?: "before_capture" | "after_capture"
}

function makeTestStorage(options: HarnessOptions = {}) {
	const values = new Map<string, unknown>()
	const storage = {
		get: async (key: string) => {
			if (key.startsWith(POLICY_PREFIX) && options.failPolicyRead?.()) throw new Error("test policy read failure")
			return values.get(key) as never
		},
		set: async (key: string, value: unknown) => {
			if (key.startsWith(POLICY_PREFIX) && options.failPolicyWrite?.()) throw new Error("test policy write failure")
			values.set(key, value)
		},
		remove: async (key: string) => { values.delete(key) },
		scan: async () => ({ items: [], cursor: undefined }),
	} as unknown as Plugin.Context["storage"]
	return { storage, values }
}

function sessionInfo(id: string, parentID: string | undefined, directory: string, overrides: Partial<TestSession> = {}): TestSession {
	return {
		id,
		parentID,
		projectID: "project-policy-test",
		location: { directory, workspaceID: "workspace-policy-test" },
		...overrides,
	} as TestSession
}

function config(backgroundTask: unknown = {}) {
	return { background_task: backgroundTask } as OhMyOpenCodeConfig
}

function toolEvent(sessionID: string, ordinal: number, input: unknown = { path: "/tmp/item" }, tool = "read"): TestEvent {
	return {
		sessionID,
		messageID: `msg-${sessionID}`,
		id: `call-${sessionID}-${ordinal}`,
		tool,
		input,
	}
}

async function harness(options: HarnessOptions = {}) {
	const root = await mkdtemp(join(tmpdir(), "omo-v2-background-policy-"))
	roots.push(root)
	const directory = join(root, "project")
	await mkdir(directory, { recursive: true })
	const storageHarness = makeTestStorage(options)
	const sessions = new Map<string, TestSession>([
		["ses-parent", sessionInfo("ses-parent", undefined, directory)],
		["ses-child", sessionInfo("ses-child", "ses-parent", directory)],
	])
	const interrupts: Array<{ sessionID: string }> = []
	let sessionGets = 0
	let disposeCalls = 0
	let callback: ((event: TestEvent) => Promise<void>) | undefined
	const location = {
		directory,
		workspaceID: "workspace-policy-test",
		project: { id: "project-policy-test", directory, canonical: directory },
	}
	const ctx = {
		location,
		storage: storageHarness.storage,
		tool: {
			hook: async (_name: string, next: (event: TestEvent) => Promise<void>) => {
				if (options.failRegistration === "before_capture") throw new Error("test registration failure")
				callback = next
				if (options.failRegistration === "after_capture") throw new Error("test post-capture registration failure")
				return { dispose: async () => { disposeCalls += 1 } }
			},
		},
		session: {
			get: async ({ sessionID }: { sessionID: string }) => {
				sessionGets += 1
				const result = sessions.get(sessionID)
				if (!result) throw new Error(`session not found: ${sessionID}`)
				return result
			},
			interrupt: async ({ sessionID }: { sessionID: string }) => {
				interrupts.push({ sessionID })
				return { interrupted: true }
			},
		},
	} as unknown as Plugin.Context
	const runs = createV2SubagentRunState(ctx.storage)
	await runs.recordLaunch("ses-child", {
		parentSessionID: "ses-parent",
		startedAt: 100,
		status: "running",
		blockedActions: [],
	})
	const state = {
		ctx,
		runs,
		sessions,
		interrupts,
		values: storageHarness.values,
		get sessionGets() { return sessionGets },
		get disposeCalls() { return disposeCalls },
		get callback() { return callback },
		async register(configValue: OhMyOpenCodeConfig = config()) {
			return registerV2BackgroundToolPolicy(ctx, configValue, runs)
		},
		async before(event: TestEvent) {
			await callback?.(event)
		},
		addChild(sessionID: string, parentID = "ses-parent", info?: TestSession) {
			sessions.set(sessionID, info ?? sessionInfo(sessionID, parentID, directory))
			return runs.recordLaunch(sessionID, { parentSessionID: parentID, startedAt: 200, status: "running", blockedActions: [] })
		},
		policyRows() {
			return [...storageHarness.values.entries()].filter(([key]) => key.startsWith(POLICY_PREFIX))
		},
	}
	return state
}

async function invoke(host: Awaited<ReturnType<typeof harness>>, event: TestEvent, sideEffect: () => void): Promise<void> {
	await host.before(event)
	sideEffect()
}

describe("native V2 background tool-loop policy", () => {
	test("enforces the hard limit even when repeat detection is disabled and uses nested max precedence", async () => {
		const host = await harness()
		await host.register(config({ maxToolCalls: 12, circuitBreaker: { enabled: false, maxToolCalls: 10 } }))
		let sideEffects = 0
		for (let index = 1; index < 10; index += 1) {
			await invoke(host, toolEvent("ses-child", index, { ordinal: index }, `tool-${index}`), () => { sideEffects += 1 })
		}
		await expect(invoke(host, toolEvent("ses-child", 10, { ordinal: 10 }, "last-tool"), () => { sideEffects += 1 }))
			.rejects.toBeInstanceOf(ToolError)
		expect(sideEffects).toBe(9)
		expect(host.interrupts).toEqual([{ sessionID: "ses-child" }])
		expect(host.policyRows()).toHaveLength(1)
		expect(host.policyRows()[0]![1]).toMatchObject({
			toolCalls: 10,
			lastTrigger: { type: "max_tool_calls", count: 10, limit: 10 },
		})
	})

	test("uses key-sorted signatures, resets on changed input, and stores only the signature digest", async () => {
		const host = await harness()
		await host.register(config({ maxToolCalls: 40, circuitBreaker: { consecutiveThreshold: 5 } }))
		const calls = [
			{ b: 2, a: 1 },
			{ a: 1, b: 2 },
			{ a: 1, b: 3 },
			{ b: 3, a: 1 },
			{ a: 1, b: 3 },
			{ b: 3, a: 1 },
			{ a: 1, b: 3 },
		] as const
		for (let index = 0; index < calls.length - 1; index += 1) {
			await host.before(toolEvent("ses-child", index + 1, calls[index], "edit"))
		}
		await expect(host.before(toolEvent("ses-child", calls.length, calls.at(-1), "edit"))).rejects.toBeInstanceOf(ToolError)
		const serialized = JSON.stringify(host.policyRows())
		expect(serialized).not.toContain('"b":3')
		expect(serialized).toContain('"type":"repeated_tool_use"')
		expect(host.interrupts).toEqual([{ sessionID: "ses-child" }])
	})

	test("does not build a repeated-input streak when tool input is unavailable", async () => {
		const host = await harness()
		await host.register(config({ maxToolCalls: 40, circuitBreaker: { consecutiveThreshold: 5 } }))
		for (let index = 1; index <= 8; index += 1) {
			await host.before(toolEvent("ses-child", index, null, "read"))
		}
		expect(host.interrupts).toHaveLength(0)
		expect(host.policyRows()[0]![1]).toMatchObject({ toolCalls: 8, consecutiveCount: 1 })
	})

	test("deduplicates a messageID and callID pair without double-counting it", async () => {
		const host = await harness()
		await host.register(config({ maxToolCalls: 10, circuitBreaker: { enabled: false } }))
		for (let index = 1; index < 10; index += 1) {
			await host.before(toolEvent("ses-child", index, { ordinal: index }, `tool-${index}`))
		}
		const duplicate = toolEvent("ses-child", 1, { ordinal: 1 }, "tool-1")
		await host.before(duplicate)
		expect(host.interrupts).toHaveLength(0)
		await expect(host.before(toolEvent("ses-child", 10, { ordinal: 10 }, "tool-10"))).rejects.toBeInstanceOf(ToolError)
		expect(host.policyRows()[0]![1]).toMatchObject({ toolCalls: 10 })
	})

	test("serializes concurrent calls for one session without losing counter updates", async () => {
		const host = await harness()
		await host.register(config({ maxToolCalls: 10, circuitBreaker: { enabled: false } }))
		const results = await Promise.allSettled(Array.from({ length: 10 }, (_, index) =>
			host.before(toolEvent("ses-child", index + 1, { ordinal: index + 1 }, `tool-${index + 1}`)),
		))
		expect(results.filter((result) => result.status === "rejected")).toHaveLength(1)
		expect(host.interrupts).toEqual([{ sessionID: "ses-child" }])
		expect(host.policyRows()[0]![1]).toMatchObject({ toolCalls: 10 })
	})

	test("isolates sibling counters per native child session", async () => {
		const host = await harness()
		await host.addChild("ses-sibling")
		await host.register(config({ maxToolCalls: 50, circuitBreaker: { consecutiveThreshold: 5 } }))
		for (let index = 1; index < 5; index += 1) {
			await host.before(toolEvent("ses-child", index, { same: true }))
			await host.before(toolEvent("ses-sibling", index, { same: true }))
		}
		expect(host.interrupts).toHaveLength(0)
		await expect(host.before(toolEvent("ses-child", 5, { same: true }))).rejects.toBeInstanceOf(ToolError)
		expect(host.interrupts).toEqual([{ sessionID: "ses-child" }])
		await expect(host.before(toolEvent("ses-sibling", 5, { same: true }))).rejects.toBeInstanceOf(ToolError)
		expect(host.interrupts).toEqual([{ sessionID: "ses-child" }, { sessionID: "ses-sibling" }])
	})

	test("leaves parent, unmanaged, and foreign project/directory/parent sessions untouched", async () => {
		const host = await harness()
		await host.addChild("ses-wrong-parent", "ses-parent", sessionInfo("ses-wrong-parent", "ses-other-parent", join(roots.at(-1)!, "project")))
		await host.addChild("ses-wrong-project", "ses-parent", {
			...sessionInfo("ses-wrong-project", "ses-parent", join(roots.at(-1)!, "project")),
			projectID: "project-other",
		})
		await host.addChild("ses-wrong-directory", "ses-parent", sessionInfo("ses-wrong-directory", "ses-parent", join(roots.at(-1)!, "foreign")))
		await mkdir(join(roots.at(-1)!, "foreign"), { recursive: true })
		await host.addChild("ses-wrong-id", "ses-parent", sessionInfo("ses-not-requested", "ses-parent", join(roots.at(-1)!, "project")))
		await host.register(config({ maxToolCalls: 10, circuitBreaker: { consecutiveThreshold: 5 } }))
		await host.before(toolEvent("ses-parent", 1))
		await host.before(toolEvent("ses-unmanaged", 1))
		for (const sessionID of ["ses-wrong-parent", "ses-wrong-project", "ses-wrong-directory", "ses-wrong-id"]) {
			await host.before(toolEvent(sessionID, 1))
		}
		expect(host.interrupts).toHaveLength(0)
		expect(host.policyRows()).toHaveLength(0)
	})

	test("preserves cumulative counters across policy recreation and resumed sessions", async () => {
		const host = await harness()
		const settings = config({ maxToolCalls: 20, circuitBreaker: { consecutiveThreshold: 5 } })
		const first = await host.register(settings)
		for (let index = 1; index <= 3; index += 1) await host.before(toolEvent("ses-child", index, { same: true }))
		await first.cleanup()
		const resumed = await host.register(settings)
		await host.before(toolEvent("ses-child", 4, { same: true }))
		await expect(host.before(toolEvent("ses-child", 5, { same: true }))).rejects.toBeInstanceOf(ToolError)
		expect(host.interrupts).toEqual([{ sessionID: "ses-child" }])
		await resumed.cleanup()
	})

	test("recomputes limits from current config instead of retaining a tripped lockout", async () => {
		const host = await harness()
		const settings = config({ maxToolCalls: 10, circuitBreaker: { enabled: false } })
		const policy = await host.register(settings)
		for (let index = 1; index <= 10; index += 1) {
			const call = host.before(toolEvent("ses-child", index, { ordinal: index }, `tool-${index}`))
			if (index === 10) await expect(call).rejects.toBeInstanceOf(ToolError)
			else await call
		}
		;(settings as unknown as { background_task: { maxToolCalls: number; circuitBreaker: { enabled: boolean } } }).background_task.maxToolCalls = 20
		await expect(host.before(toolEvent("ses-child", 11, { ordinal: 11 }, "tool-11"))).resolves.toBeUndefined()
		expect(host.interrupts).toEqual([{ sessionID: "ses-child" }])
		await policy.cleanup()
	})

	test("fails closed when policy storage cannot load or persist before tool side effects", async () => {
		for (const stage of ["read", "write"] as const) {
			let fail = false
			const host = await harness({
				failPolicyRead: () => stage === "read" && fail,
				failPolicyWrite: () => stage === "write" && fail,
			})
			await host.register(config({ maxToolCalls: 10 }))
			fail = true
			let sideEffects = 0
			await expect(invoke(host, toolEvent("ses-child", 1), () => { sideEffects += 1 })).rejects.toBeInstanceOf(ToolError)
			expect(sideEffects).toBe(0)
			expect(host.interrupts).toHaveLength(0)
		}
	})

	test("cleanup makes a retained callback inert and forget removes only the session state", async () => {
		const host = await harness()
		const policy = await host.register(config({ maxToolCalls: 10 }))
		await host.before(toolEvent("ses-child", 1))
		expect(host.policyRows()).toHaveLength(1)
		const getCallsBeforeCleanup = host.sessionGets
		await policy.cleanup()
		await policy.cleanup()
		expect(host.disposeCalls).toBe(1)
		await host.before(toolEvent("ses-child", 2))
		expect(host.sessionGets).toBe(getCallsBeforeCleanup)
		await policy.forget("ses-child")
		expect(host.policyRows()).toHaveLength(0)
	})

	test("registration failure leaves any retained callback inert", async () => {
		const host = await harness({ failRegistration: "after_capture" })
		await expect(host.register(config())).rejects.toThrow("post-capture registration failure")
		const getCallsBefore = host.sessionGets
		await host.before(toolEvent("ses-child", 1))
		expect(host.sessionGets).toBe(getCallsBefore)
		expect(host.policyRows()).toHaveLength(0)
		expect(host.interrupts).toHaveLength(0)
	})
})
