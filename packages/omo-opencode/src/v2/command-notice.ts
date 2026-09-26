import type { OpenCodeEvent } from "@opencode/client"
import type { Context as TuiContext } from "@opencode/plugin/tui/plugin"

export const COMMAND_NOTICE_METADATA_KEY = "omoCommandNotice"
export const COMMAND_NOTICE_METADATA_VERSION = 1
const MAX_SEEN_NOTICES = 256

type InboxEnqueuedEvent = Extract<OpenCodeEvent, { type: "session.inbox.enqueued" }>
type SessionRoute = { readonly type: "session"; readonly sessionID: string }
type NoticeLocation = { readonly directory: string; readonly workspaceID?: string }

export type NativeCommandNotice = {
	readonly sessionID: string
	readonly text: string
	readonly inboxID: string
}

export type NativeCommandNoticeDispatcher = {
	accept(input: {
		readonly event: InboxEnqueuedEvent
		readonly route: SessionRoute | undefined
		readonly location: NoticeLocation | undefined
		readonly sessionLocation: { readonly directory: string } | undefined
	}): NativeCommandNotice | undefined
	dispose(): void
}

function locationsMatch(event: NoticeLocation | undefined, current: NoticeLocation | undefined): boolean {
	return event !== undefined
		&& current !== undefined
		&& event.directory === current.directory
		&& event.workspaceID === current.workspaceID
}

/** Admit only tagged OMO command results addressed to the currently open native session. */
export function createNativeCommandNoticeDispatcher(maxSeen = MAX_SEEN_NOTICES): NativeCommandNoticeDispatcher {
	const seen = new Map<string, true>()
	let disposed = false
	return {
		accept({ event, route, location, sessionLocation }) {
			if (disposed || event.type !== "session.inbox.enqueued") return undefined
			if (!route || route.sessionID !== event.data.sessionID) return undefined
			if (event.location) {
				if (!locationsMatch(event.location, location)) return undefined
			} else if (!location || sessionLocation?.directory !== location.directory) {
				// Some native 2.0.18 session events omit their location envelope.
				// The exact route/session match above plus the public session's directory
				// is the narrowest available location check for those events.
				return undefined
			}

			const { inboxID, item } = event.data
			if (item.type !== "synthetic") return undefined
			const payload = item.payload
			if (payload.metadata?.[COMMAND_NOTICE_METADATA_KEY] !== COMMAND_NOTICE_METADATA_VERSION) return undefined
			if (!payload.text.trim()) return undefined

			const key = `${event.data.sessionID}\0${inboxID}`
			if (seen.has(key)) return undefined
			seen.set(key, true)
			while (seen.size > maxSeen) seen.delete(seen.keys().next().value as string)

			return { sessionID: event.data.sessionID, inboxID, text: payload.text }
		},
		dispose() {
			disposed = true
			seen.clear()
		},
	}
}

/** Listen for native command-result inbox events without waking or prompting the session. */
export function listenForNativeCommandNotices(
	ctx: Pick<TuiContext, "data" | "ui" | "location">,
	isActive: () => boolean = () => true,
): () => void {
	const dispatcher = createNativeCommandNoticeDispatcher()
	const currentLocation = () => ctx.location ?? ctx.data.location.default()
	const unlisten = ctx.data.on("session.inbox.enqueued", (event) => {
		if (!isActive()) return
		const route = ctx.ui.router.current()
		const notice = dispatcher.accept({
			event,
			route: route.type === "session" ? route : undefined,
			location: currentLocation(),
			sessionLocation: ctx.data.session.get(event.data.sessionID)?.location,
		})
		if (!notice || !isActive()) return
		ctx.ui.toast.show({
			title: "OMO command result",
			message: notice.text,
			variant: "info",
			duration: 8_000,
			sessionID: notice.sessionID,
		})
	})
	return () => {
		dispatcher.dispose()
		unlisten()
	}
}
