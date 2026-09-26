import type { OpenCodeClient } from "@opencode/client"

type SessionApi = Pick<OpenCodeClient["session"], "fork" | "prompt">

type DispatchInput = {
	parentSessionID: string
	question: string
}

type Operation = {
	promise: Promise<string>
	timer?: ReturnType<typeof setTimeout>
}

// OpenCode 2's native client dispatches directly to the host. Keep the same
// short post-settlement reservation that the v1 prompt gate provides.
const DUPLICATE_HOLD_MS = 1_000

export type NativeBtwDispatcher = {
	dispatch(input: DispatchInput): Promise<string>
	dispose(): void
}

/** Own the native fork + child prompt as one deduplicated dispatch operation. */
export function createNativeBtwDispatcher(session: SessionApi): NativeBtwDispatcher {
	const operations = new Map<string, Operation>()
	let disposed = false

	const keyFor = ({ parentSessionID, question }: DispatchInput): string => JSON.stringify([parentSessionID, question])

	const holdAfterSettlement = (key: string, operation: Operation): void => {
		if (disposed) return
		operation.timer = setTimeout(() => {
			if (operations.get(key) === operation) operations.delete(key)
		}, DUPLICATE_HOLD_MS)
	}

	return {
		dispatch({ parentSessionID, question }): Promise<string> {
			if (disposed) return Promise.reject(new Error("BTW dispatcher has been disposed"))
			const normalizedQuestion = question.trim()
			if (!parentSessionID.trim()) return Promise.reject(new Error("BTW requires a parent session"))
			if (!normalizedQuestion) return Promise.reject(new Error("BTW requires a non-empty question"))

			const input = { parentSessionID, question: normalizedQuestion }
			const key = keyFor(input)
			const existing = operations.get(key)
			if (existing) return existing.promise

			const operation: Operation = {
				promise: (async () => {
					const child = await session.fork({ sessionID: parentSessionID })
					if (disposed) throw new Error("BTW dispatcher was disposed before the child prompt was sent")
					if (!child.id || child.id === parentSessionID) {
						throw new Error("BTW fork must target a distinct child session")
					}
					await session.prompt({ sessionID: child.id, text: normalizedQuestion })
					return child.id
				})(),
			}
			operations.set(key, operation)
			void operation.promise.then(
				() => holdAfterSettlement(key, operation),
				() => holdAfterSettlement(key, operation),
			)
			return operation.promise
		},
		dispose(): void {
			if (disposed) return
			disposed = true
			for (const operation of operations.values()) {
				if (operation.timer) clearTimeout(operation.timer)
			}
			operations.clear()
		},
	}
}
