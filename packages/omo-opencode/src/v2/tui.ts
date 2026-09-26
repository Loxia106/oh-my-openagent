import type { Context as TuiContext } from "@opencode/plugin/tui/plugin"
import type { JSX } from "@opentui/solid/jsx-runtime"
import { createComponent, createSignal } from "solid-js"
import { createNativeBtwDispatcher } from "./btw-dispatch"
import { loadV2Config } from "./config"
import { listenForNativeCommandNotices } from "./command-notice"

type SolidRuntime = {
	createElement(tag: string): unknown
	insert(parent: unknown, child: unknown, marker?: unknown, initial?: unknown): unknown
	setProp(node: unknown, name: string, value: unknown, previous?: unknown): unknown
}

function appendText(parent: unknown, value: string | (() => string), solid: SolidRuntime): void {
	const text = solid.createElement("text")
	solid.insert(text, value)
	solid.insert(parent, text)
}

function renderSidebar(sessionID: string, ctx: TuiContext, solid: SolidRuntime, revision: () => number): JSX.Element {
	const root = solid.createElement("box")
	solid.setProp(root, "flexDirection", "column")
	appendText(root, "OMO", solid)
	appendText(root, () => {
		revision()
		const current = ctx.data.session.get(sessionID)
		return `${current?.agent ?? "OpenCode"} · ${ctx.data.session.status(sessionID)}`
	}, solid)

	const children = solid.createElement("box")
	solid.setProp(children, "flexDirection", "column")
	solid.insert(children, () => {
		revision()
		return ctx.data.session.family(sessionID)
			.filter((id) => id !== sessionID)
			.map((id) => ctx.data.session.get(id))
			.filter((session): session is NonNullable<typeof session> => Boolean(session?.parentID))
			.slice(-6)
			.map((session) => {
				const row = solid.createElement("text")
				const label = () => {
					revision()
					const current = ctx.data.session.get(session.id) ?? session
					return `  ${current.agent ?? current.title ?? current.id.slice(0, 8)} · ${ctx.data.session.status(current.id)}`
				}
				solid.insert(row, label)
				return row
			})
	})
	solid.insert(root, children)
	return root as JSX.Element
}

function btwQuestion(input: string | undefined): string {
	return (input ?? "").replace(/^\s*\/(?:omo-btw|side)(?:\s+|$)/i, "").trim()
}

async function startBtw(
	ctx: TuiContext,
	dispatchBtw: ReturnType<typeof createNativeBtwDispatcher>["dispatch"],
	isActive: () => boolean,
	rawInput?: string,
): Promise<void> {
	const route = ctx.ui.router.current()
	if (route.type !== "session") {
		ctx.ui.toast.show({ title: "BTW unavailable", message: "Open a session before starting a side conversation.", variant: "warning" })
		return
	}
	let question = btwQuestion(rawInput)
	if (!question) {
		question = (await ctx.ui.dialog.prompt({
			title: "Start a BTW side conversation",
			description: "Fork the current session and ask a separate question.",
			placeholder: "What would you like to ask?",
		}))?.trim() ?? ""
	}
	if (!question) return

	try {
		const childSessionID = await dispatchBtw({ parentSessionID: route.sessionID, question })
		if (!isActive()) return
		if (!ctx.ui.tabs.focus(childSessionID)) ctx.ui.router.navigate({ type: "session", sessionID: childSessionID })
	} catch (error) {
		if (!isActive()) return
		ctx.ui.toast.show({
			title: "Unable to start BTW",
			message: error instanceof Error ? error.message : String(error),
			variant: "error",
		})
	}
}

/** Native OpenCode 2 TUI contribution; uses the host's current session family and status. */
export async function setupV2Tui(ctx: TuiContext): Promise<() => void> {
	const directory = String(ctx.location?.directory ?? ctx.data.location.default().directory)
	const config = loadV2Config(directory)
	const solid = await import("@opentui/solid") as unknown as SolidRuntime
	const [revision, setRevision] = createSignal(0)
	let disposeSlot: (() => void) | undefined
	let disposeKeymapSlot: (() => void) | undefined
	let disposeEvents: (() => void) | undefined
	let disposeCommandNotices: (() => void) | undefined
	let active = true
	let disposed = false
	const btwDispatcher = createNativeBtwDispatcher(ctx.client.session)
	const dispose = () => {
		if (disposed) return
		disposed = true
		active = false
		const errors: unknown[] = []
		for (const cleanup of [
			() => btwDispatcher.dispose(),
			() => disposeEvents?.(),
			() => disposeSlot?.(),
			() => disposeKeymapSlot?.(),
			() => disposeCommandNotices?.(),
		]) {
			try {
				cleanup()
			} catch (error) {
				errors.push(error)
			}
		}
		if (errors.length > 0) throw new AggregateError(errors, "One or more native TUI registrations failed to clean up")
	}

	try {
		disposeCommandNotices = listenForNativeCommandNotices(ctx, () => active)

	// Keymap.layer reads the host's Solid Keymap context and registers cleanup on
	// the current component owner. Plugin setup runs outside that provider, so the
	// layer must be created by a component mounted through a documented UI slot.
	const commands = [
		{
			id: "omo.status",
			title: "OMO status",
			description: "Show the active OpenCode session and child agents.",
			group: "OMO",
			palette: true as const,
			slash: { name: "omo-status" },
			run: async () => {
				const route = ctx.ui.router.current()
				if (route.type !== "session") {
					await ctx.ui.dialog.alert({ title: "OMO status", message: "No session is currently open." })
					return
				}
				const session = ctx.data.session.get(route.sessionID)
				const family = ctx.data.session.family(route.sessionID)
				const children = family
					.filter((id) => id !== route.sessionID)
					.map((id) => ctx.data.session.get(id))
					.filter((child): child is NonNullable<typeof child> => Boolean(child?.parentID))
				const rows = children.map((child) =>
					`• ${child.agent ?? child.title ?? child.id} — ${ctx.data.session.status(child.id)}`,
				)
				await ctx.ui.dialog.alert({
					title: "OMO status",
					message: [
						`Session: ${session?.title ?? route.sessionID}`,
						`Agent: ${session?.agent ?? "OpenCode"}`,
						`State: ${ctx.data.session.status(route.sessionID)}`,
						`Child sessions: ${children.length}`,
						...rows,
					].join("\n"),
				})
			},
		},
		{
			id: "omo.btw",
			title: "BTW side conversation",
			description: "Fork the current session to ask a separate question.",
			group: "OMO",
			palette: true as const,
			// OpenCode has its own /btw command. Keep OMO's forked side-session
			// behavior under a distinct slash name while retaining /side.
			slash: { name: "omo-btw", aliases: ["side"], arguments: true as const },
			run: (input?: string) => startBtw(ctx, btwDispatcher.dispatch, () => active, input),
		},
	]

	disposeKeymapSlot = ctx.ui.slot({
		append: "app",
		render: () => createComponent(() => {
			ctx.keymap.layer(() => ({ mode: "global", commands }))
			const empty = solid.createElement("box")
			solid.setProp(empty, "height", 0)
			solid.setProp(empty, "width", 0)
			return empty as JSX.Element
		}, {}),
	})

	if (config.tui?.sidebar?.enabled !== false) {
		disposeSlot = ctx.ui.slot({
			append: "sidebar.content",
			render: ({ sessionID }) => renderSidebar(sessionID, ctx, solid, revision),
		})
		disposeEvents = ctx.data.listen(({ details }) => {
			if (details.type.startsWith("session.")) {
				setRevision((value) => value + 1)
				ctx.renderer.requestRender()
			}
		})
	}
	} catch (error) {
		try {
			dispose()
		} catch (cleanupError) {
			throw new AggregateError([error, cleanupError], "Native TUI setup failed and cleanup was incomplete")
		}
		throw error
	}

	return dispose
}

export { btwQuestion }
