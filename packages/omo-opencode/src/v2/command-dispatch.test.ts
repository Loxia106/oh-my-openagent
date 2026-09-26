import { describe, expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin"
import type { CommandInvocation } from "@opencode/plugin/promise/command"
import { unsafeTestValue } from "../../../../test-support/unsafe-test-value"
import {
	createV2CommandDispatchGate,
	ensureV2SessionAgent,
	submitV2CommandPrompt,
	type CommandDispatchIdentity,
	type NativeCommandInvocation,
} from "./command-dispatch"

const invocation = (overrides: Partial<NativeCommandInvocation> = {}): NativeCommandInvocation =>
	unsafeTestValue<CommandInvocation>({
		sessionID: "ses-current",
		prompt: { text: "run this", files: [], agents: [], skills: [] },
		delivery: "queue",
		...overrides,
	})

describe("native command dispatch", () => {
	test("coalesces concurrent duplicate callbacks but distinguishes attachments and delivery", async () => {
		const gate = createV2CommandDispatchGate(20)
		const base = invocation()
		const identity: CommandDispatchIdentity = { commandName: "refactor", invocation: base }
		let executions = 0
		let release!: () => void
		const pending = new Promise<void>((resolve) => { release = resolve })
		const first = gate.run(identity, async () => { executions += 1; await pending })
		const duplicate = gate.run(identity, async () => { executions += 1 })
		const differentFile = gate.run({
			commandName: "refactor",
			invocation: invocation({ prompt: { ...base.prompt, files: [{ uri: "file:///different" }] } }),
		}, async () => { executions += 1 })
		const differentDelivery = gate.run({
			commandName: "refactor",
			invocation: invocation({ delivery: "steer" }),
		}, async () => { executions += 1 })
		const differentSession = gate.run({
			commandName: "refactor",
			invocation: invocation({ sessionID: "ses-other" }),
		}, async () => { executions += 1 })
		const differentText = gate.run({
			commandName: "refactor",
			invocation: invocation({ prompt: { ...base.prompt, text: "different request" } }),
		}, async () => { executions += 1 })
		const differentCommand = gate.run({
			commandName: "handoff",
			invocation: base,
		}, async () => { executions += 1 })

		release()
		await Promise.all([first, duplicate, differentFile, differentDelivery, differentSession, differentText, differentCommand])
		expect(executions).toBe(6)
		await gate.run(identity, async () => { executions += 1 })
		expect(executions).toBe(6)
		gate.dispose()
	})

	test("default gate holds successful and failed dispatches after settlement", async () => {
		const gate = createV2CommandDispatchGate()
		const successIdentity: CommandDispatchIdentity = { commandName: "goal", invocation: invocation() }
		const failureIdentity: CommandDispatchIdentity = {
			commandName: "goal",
			invocation: invocation({ prompt: { text: "fail", files: [], agents: [], skills: [] } }),
		}
		let successes = 0
		let failures = 0
		await gate.run(successIdentity, async () => { successes += 1 })
		await new Promise((resolve) => setTimeout(resolve, 10))
		await gate.run(successIdentity, async () => { successes += 1 })
		const failedOperation = async () => { failures += 1; throw new Error("held failure") }
		await expect(gate.run(failureIdentity, failedOperation)).rejects.toThrow("held failure")
		await new Promise((resolve) => setTimeout(resolve, 10))
		await expect(gate.run(failureIdentity, failedOperation)).rejects.toThrow("held failure")
		expect(successes).toBe(1)
		expect(failures).toBe(1)
		gate.dispose()
	})

	test("retains failures briefly, then permits retry and rejects after disposal", async () => {
		const gate = createV2CommandDispatchGate(15)
		const identity: CommandDispatchIdentity = { commandName: "ulw-execute", invocation: invocation() }
		let executions = 0
		const operation = async () => { executions += 1; throw new Error("dispatch failed") }
		await expect(gate.run(identity, operation)).rejects.toThrow("dispatch failed")
		await expect(gate.run(identity, operation)).rejects.toThrow("dispatch failed")
		expect(executions).toBe(1)
		await new Promise((resolve) => setTimeout(resolve, 25))
		await expect(gate.run(identity, operation)).rejects.toThrow("dispatch failed")
		expect(executions).toBe(2)
		gate.dispose()
		await expect(gate.run(identity, operation)).rejects.toThrow("disposed")
	})

	test("switches agent before prompt and preserves the native prompt and delivery", async () => {
		const order: string[] = []
		let prompted: unknown
		const atlasModel = { providerID: "allowed", id: "atlas-model", variant: "reasoning" }
		const ctx = unsafeTestValue<Plugin.Context>({
			agent: {
				get: async () => ({ data: { id: "atlas", model: atlasModel } }),
			},
			session: {
				get: async () => ({ agent: "sisyphus", model: { providerID: "allowed", id: "old-model" } }),
				switchAgent: async () => { order.push("agent") },
				switchModel: async ({ model }: { model: typeof atlasModel }) => { order.push(`model:${model.providerID}/${model.id}/${model.variant}`) },
				prompt: async (input: unknown) => { order.push("prompt"); prompted = input },
			},
		})
		const input = invocation({
			prompt: { text: "hello", files: [{ uri: "file:///plan.md", name: "plan.md" }], agents: [{ name: "atlas" }], skills: [{ id: "skill-x" }] },
			delivery: "steer",
		})

		await ensureV2SessionAgent(ctx, input.sessionID, "atlas")
		await submitV2CommandPrompt(ctx, input, "expanded")
		expect(order).toEqual(["agent", "model:allowed/atlas-model/reasoning", "prompt"])
		expect(prompted).toEqual({
			...input.prompt,
			sessionID: input.sessionID,
			text: "expanded",
			delivery: "steer",
		})
	})

	test("keeps the current model when the target agent has no configured model", async () => {
		const order: string[] = []
		const currentModel = { providerID: "host", id: "current-model", variant: "custom" }
		const ctx = unsafeTestValue<Plugin.Context>({
			agent: { get: async () => ({ data: { id: "atlas", model: undefined } }) },
			session: {
				get: async () => ({ agent: "sisyphus", model: currentModel }),
				switchAgent: async () => { order.push("agent") },
				switchModel: async () => { order.push("model") },
			},
		})

		await ensureV2SessionAgent(ctx, "ses-current", "atlas")

		expect(order).toEqual(["agent"])
	})

	test("normalizes absent and default variants and skips redundant agent/model changes", async () => {
		const order: string[] = []
		const ctx = unsafeTestValue<Plugin.Context>({
			agent: { get: async () => ({ data: { id: "atlas", model: { providerID: "allowed", id: "atlas-model", variant: "default" } } }) },
			session: {
				get: async () => ({ agent: "atlas", model: { providerID: "allowed", id: "atlas-model" } }),
				switchAgent: async () => { order.push("agent") },
				switchModel: async () => { order.push("model") },
			},
		})

		await ensureV2SessionAgent(ctx, "ses-current", "atlas")

		expect(order).toEqual([])
	})

	test("fails before selection mutations when target-agent lookup fails", async () => {
		const order: string[] = []
		const ctx = unsafeTestValue<Plugin.Context>({
			agent: { get: async () => { throw new Error("target agent unavailable") } },
			session: {
				get: async () => ({ agent: "sisyphus", model: { providerID: "host", id: "current-model" } }),
				switchAgent: async () => { order.push("agent") },
				switchModel: async () => { order.push("model") },
			},
		})

		await expect(ensureV2SessionAgent(ctx, "ses-current", "atlas")).rejects.toThrow("target agent unavailable")
		expect(order).toEqual([])
	})
})
