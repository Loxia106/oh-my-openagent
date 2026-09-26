import type { CommandInvocation } from "@opencode/plugin/promise/command"
import type { Plugin } from "@opencode/plugin"
import { COMMAND_NOTICE_METADATA_KEY, COMMAND_NOTICE_METADATA_VERSION } from "./command-notice"

export type NativeCommandInvocation = CommandInvocation

export type CommandDispatchIdentity = {
	readonly commandName: string
	readonly invocation: NativeCommandInvocation
}

type Operation = {
	readonly promise: Promise<void>
	timer?: ReturnType<typeof setTimeout>
}

export type V2CommandDispatchGate = {
	run(identity: CommandDispatchIdentity, operation: () => Promise<void>): Promise<void>
	dispose(): void
}

export type AssertV2CommandActive = () => void

type SelectedModel = {
	readonly providerID: string
	readonly id: string
	readonly variant?: string
}

function sameSelectedModel(left: SelectedModel | undefined, right: SelectedModel | undefined): boolean {
	if (!left || !right) return left === right
	return left.providerID === right.providerID && left.id === right.id && (left.variant ?? "default") === (right.variant ?? "default")
}

/** Apply the selected agent and its configured model before command-specific state is prepared. */
export async function ensureV2SessionAgent(
	ctx: Plugin.Context,
	sessionID: NativeCommandInvocation["sessionID"],
	targetAgent: string,
	assertActive: AssertV2CommandActive = () => undefined,
): Promise<void> {
	assertActive()
	const [session, target] = await Promise.all([
		ctx.session.get({ sessionID }),
		ctx.agent.get({ agentID: targetAgent }),
	])
	assertActive()
	if (target.data.id !== targetAgent) throw new Error(`Native command target agent "${targetAgent}" is not registered`)
	if (session.agent !== targetAgent) {
		assertActive()
		await ctx.session.switchAgent({ sessionID, agent: targetAgent })
		assertActive()
	}
	if (target.data.model && !sameSelectedModel(session.model, target.data.model)) {
		assertActive()
		await ctx.session.switchModel({ sessionID, model: target.data.model })
		assertActive()
	}
}

/** Submit one user-facing command prompt through the native session API. */
export async function submitV2CommandPrompt(
	ctx: Plugin.Context,
	invocation: NativeCommandInvocation,
	text: string,
	targetAgent?: string,
	assertActive: AssertV2CommandActive = () => undefined,
): Promise<void> {
	if (targetAgent) await ensureV2SessionAgent(ctx, invocation.sessionID, targetAgent, assertActive)
	assertActive()
	await ctx.session.prompt({
		...invocation.prompt,
		sessionID: invocation.sessionID,
		text,
		delivery: invocation.delivery,
	})
}

/** Insert a visible command result without starting another model execution. */
export async function submitV2CommandNotice(
	ctx: Plugin.Context,
	invocation: NativeCommandInvocation,
	text: string,
	assertActive: AssertV2CommandActive = () => undefined,
): Promise<void> {
	assertActive()
	await ctx.session.synthetic({
		sessionID: invocation.sessionID,
		text,
		description: "OMO command result",
		metadata: { [COMMAND_NOTICE_METADATA_KEY]: COMMAND_NOTICE_METADATA_VERSION },
		delivery: invocation.delivery,
		resume: false,
	})
}

const DEFAULT_SETTLE_MS = 1_000

function stableSerialize(value: unknown): string {
	if (value === undefined) return '"__omo_undefined__"'
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? String(value)
	if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`
	const entries = Object.entries(value as Record<string, unknown>)
		.sort(([left], [right]) => left.localeCompare(right))
	return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableSerialize(item)}`).join(",")}}`
}

function identityKey({ commandName, invocation }: CommandDispatchIdentity): string {
	const { prompt } = invocation
	return stableSerialize({
		sessionID: invocation.sessionID,
		commandName,
		text: prompt.text,
		files: prompt.files ?? [],
		agents: prompt.agents ?? [],
		skills: prompt.skills ?? [],
		delivery: invocation.delivery,
	})
}

/**
 * Coalesce duplicate native command callbacks across state preparation and prompt submission.
 * A brief settled hold also absorbs the host's duplicate execute event without conflating
 * different sessions, arguments, attachments, or delivery modes.
 */
export function createV2CommandDispatchGate(settleMs = DEFAULT_SETTLE_MS): V2CommandDispatchGate {
	const operations = new Map<string, Operation>()
	let disposed = false

	return {
		run(identity, operation) {
			if (disposed) return Promise.reject(new Error("Native command dispatcher has been disposed"))
			const key = identityKey(identity)
			const existing = operations.get(key)
			if (existing) return existing.promise

			const current: Operation = {
				promise: Promise.resolve().then(async () => {
					if (disposed) throw new Error("Native command dispatcher has been disposed")
					await operation()
				}),
			}
			operations.set(key, current)

			const settle = () => {
				if (operations.get(key) !== current) return
				if (disposed) {
					operations.delete(key)
					return
				}
				current.timer = setTimeout(() => {
					if (operations.get(key) === current) operations.delete(key)
				}, settleMs)
			}
			void current.promise.then(settle, settle)
			return current.promise
		},
		dispose() {
			if (disposed) return
			disposed = true
			for (const operation of operations.values()) {
				if (operation.timer) clearTimeout(operation.timer)
			}
			operations.clear()
		},
	}
}
