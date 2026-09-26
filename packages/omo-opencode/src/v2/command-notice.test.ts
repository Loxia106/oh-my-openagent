import { describe, expect, mock, test } from "bun:test"
import type { OpenCodeEvent } from "@opencode/client"
import type { Context as TuiContext } from "@opencode/plugin/tui/plugin"
import {
	COMMAND_NOTICE_METADATA_KEY,
	COMMAND_NOTICE_METADATA_VERSION,
	createNativeCommandNoticeDispatcher,
	listenForNativeCommandNotices,
} from "./command-notice"

type InboxEnqueuedEvent = Extract<OpenCodeEvent, { type: "session.inbox.enqueued" }>

function makeEvent(input: {
	readonly sessionID?: string
	readonly inboxID?: string
	readonly directory?: string
	readonly workspaceID?: string
	readonly text?: string
	readonly tagged?: boolean
	readonly envelopeLocation?: boolean
} = {}): InboxEnqueuedEvent {
	const sessionID = input.sessionID ?? "ses-active"
	const metadata = input.tagged === false ? {} : { [COMMAND_NOTICE_METADATA_KEY]: COMMAND_NOTICE_METADATA_VERSION }
	return {
		id: `evt-${input.inboxID ?? "notice"}`,
		created: 1,
		type: "session.inbox.enqueued",
		durable: { aggregateID: sessionID, seq: 1, version: 1 },
		...(input.envelopeLocation === false ? {} : { location: { directory: input.directory ?? "/repo", workspaceID: input.workspaceID } }),
		data: {
			sessionID,
			inboxID: input.inboxID ?? "msg-notice",
			item: {
				type: "synthetic",
				payload: { text: input.text ?? "Command completed.", metadata },
				delivery: "steer",
			},
		},
	}
}

describe("native command notices", () => {
	test("accepts one tagged synthetic notice for the matching session and location", () => {
		const dispatcher = createNativeCommandNoticeDispatcher()
		const event = makeEvent()
		expect(dispatcher.accept({
			event,
			route: { type: "session", sessionID: "ses-active" },
			location: { directory: "/repo" },
			sessionLocation: { directory: "/repo" },
		})).toEqual({ sessionID: "ses-active", inboxID: "msg-notice", text: "Command completed." })
		dispatcher.dispose()
	})

	test("rejects untagged, blank, wrong-session, and wrong-location events", () => {
		const dispatcher = createNativeCommandNoticeDispatcher()
		const location = { directory: "/repo" }
		const route = { type: "session" as const, sessionID: "ses-active" }
		const accept = (event: InboxEnqueuedEvent, targetRoute = route, targetLocation = location, sessionLocation: { directory: string } | undefined = { directory: "/repo" }) =>
			dispatcher.accept({ event, route: targetRoute, location: targetLocation, sessionLocation })

		expect(accept(makeEvent({ tagged: false }))).toBeUndefined()
		expect(accept(makeEvent({ text: " \n " }))).toBeUndefined()
		expect(accept(makeEvent({ sessionID: "ses-other" }))).toBeUndefined()
		expect(accept(makeEvent({ directory: "/other" }))).toBeUndefined()
		expect(accept(makeEvent({ workspaceID: "workspace-a" }))).toBeUndefined()
		expect(dispatcher.accept({
			event: makeEvent({ envelopeLocation: false }),
			route,
			location,
			sessionLocation: undefined,
		})).toBeUndefined()
		expect(accept(makeEvent(), route, { directory: "/other" }, { directory: "/repo" })).toBeUndefined()
		expect(dispatcher.accept({ event: makeEvent(), route: undefined, location, sessionLocation: { directory: "/repo" } })).toBeUndefined()
		dispatcher.dispose()
	})

	test("uses cached native session directory when inbox event omits location envelope", () => {
		const dispatcher = createNativeCommandNoticeDispatcher()
		const event = makeEvent({ envelopeLocation: false })
		expect(dispatcher.accept({
			event,
			route: { type: "session", sessionID: "ses-active" },
			location: { directory: "/repo" },
			sessionLocation: { directory: "/repo" },
		})).toEqual({ sessionID: "ses-active", inboxID: "msg-notice", text: "Command completed." })
		expect(dispatcher.accept({
			event: makeEvent({ inboxID: "msg-other", envelopeLocation: false }),
			route: { type: "session", sessionID: "ses-active" },
			location: { directory: "/repo" },
			sessionLocation: { directory: "/other" },
		})).toBeUndefined()
		dispatcher.dispose()
	})

	test("deduplicates inbox IDs and bounds remembered notices", () => {
		const dispatcher = createNativeCommandNoticeDispatcher(1)
		const route = { type: "session" as const, sessionID: "ses-active" }
		const location = { directory: "/repo" }
		const accept = (event: InboxEnqueuedEvent) => dispatcher.accept({ event, route, location, sessionLocation: { directory: "/repo" } })
		const first = makeEvent({ inboxID: "msg-first" })
		const second = makeEvent({ inboxID: "msg-second" })

		expect(accept(first)).toBeDefined()
		expect(accept(first)).toBeUndefined()
		expect(accept(second)).toBeDefined()
		expect(accept(first)).toBeDefined()
		dispatcher.dispose()
		expect(accept(first)).toBeUndefined()
	})

	test("shows tagged events as session-scoped toasts and unregisters on disposal", () => {
		let listener: ((event: InboxEnqueuedEvent) => void) | undefined
		const unlisten = mock(() => undefined)
		const showToast = mock(() => undefined)
		const context = {
			location: { directory: "/repo" },
			data: {
				on: (type: "session.inbox.enqueued", callback: (event: InboxEnqueuedEvent) => void) => {
					expect(type).toBe("session.inbox.enqueued")
					listener = callback
					return unlisten
				},
				location: { default: () => ({ directory: "/repo" }) },
				session: { get: () => ({ location: { directory: "/repo" } }) },
			},
			ui: {
				router: { current: () => ({ type: "session", sessionID: "ses-active" }) },
				toast: { show: showToast },
			},
		} as unknown as Pick<TuiContext, "data" | "ui" | "location">
		let active = true
		const dispose = listenForNativeCommandNotices(context, () => active)
		const event = makeEvent()
		listener?.(event)
		listener?.(event)
		expect(showToast).toHaveBeenCalledTimes(1)
		expect(showToast).toHaveBeenCalledWith({
			title: "OMO command result",
			message: "Command completed.",
			variant: "info",
			duration: 8_000,
			sessionID: "ses-active",
		})

		active = false
		listener?.(makeEvent({ inboxID: "msg-disposed" }))
		dispose()
		listener?.(makeEvent({ inboxID: "msg-after-dispose" }))
		expect(showToast).toHaveBeenCalledTimes(1)
		expect(unlisten).toHaveBeenCalledTimes(1)
	})
})
