import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { OpenCode } from "@opencode/client"
import type { OpenCodeEvent } from "@opencode/client"

type InboxEnqueuedEvent = Extract<OpenCodeEvent, { type: "session.inbox.enqueued" }>

const ROOT = resolve(import.meta.dir, "..")
const EVIDENCE = resolve(process.env.OPENCODE2_COMMANDS_EVIDENCE_DIR ?? join(ROOT, ".omo", "evidence", "20260927-opencode2", "commands"))
const PLUGIN_DIR = resolve(process.env.OPENCODE2_PLUGIN_DIR ?? join(ROOT, "dist", "opencode2"))
const OPENCODE_BIN = process.env.OPENCODE2_CLI ? resolve(process.env.OPENCODE2_CLI) : ""
const QA_PASSWORD = "opencode-v2-command-qa-only"
const QA_API_KEY = "omo-local-command-mock-only"

type ProviderObservation = {
	model?: string
	userText: string
	roles: string[]
	call: number
}

function redact(value: string): string {
	return value.replaceAll(QA_PASSWORD, "[redacted-test-password]").replaceAll(QA_API_KEY, "[redacted-test-api-key]")
}

function basicAuth(): string {
	return `Basic ${Buffer.from(`opencode:${QA_PASSWORD}`).toString("base64")}`
}

function textResponse(text: string, id: string, model: string, streaming: boolean): Response {
	const created = Math.floor(Date.now() / 1000)
	if (!streaming) {
		return Response.json({
			id: `chatcmpl-${id}`,
			object: "chat.completion",
			created,
			model,
			choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
			usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
		})
	}
	const chunks = [
		{ id: `chatcmpl-${id}`, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] },
		{ id: `chatcmpl-${id}`, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
	]
	return new Response(`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`, {
		headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive" },
	})
}

function userText(body: Record<string, unknown>): string {
	if (!Array.isArray(body.messages)) return ""
	return body.messages.flatMap((message) => {
		if (!message || typeof message !== "object") return []
		const record = message as Record<string, unknown>
		if (record.role !== "user") return []
		const content = record.content
		if (typeof content === "string") return [content]
		if (Array.isArray(content)) {
			return content.flatMap((part) => {
				if (!part || typeof part !== "object") return []
				const text = (part as Record<string, unknown>).text
				return typeof text === "string" ? [text] : []
			})
		}
		return []
	}).join("\n")
}

function roles(body: Record<string, unknown>): string[] {
	if (!Array.isArray(body.messages)) return []
	return body.messages.flatMap((message) => {
		if (!message || typeof message !== "object") return []
		const role = (message as Record<string, unknown>).role
		return typeof role === "string" ? [role] : []
	})
}

async function within<T>(label: string, promise: Promise<T>, timeoutMs = 60_000): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined
	try {
		return await Promise.race([
			promise,
			new Promise<T>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms.`)), timeoutMs)
			}),
		])
	} finally {
		if (timer) clearTimeout(timer)
	}
}

async function waitForServer(client: ReturnType<typeof OpenCode.make>, process: Bun.Subprocess): Promise<void> {
	const deadline = Date.now() + 25_000
	let lastError: unknown
	while (Date.now() < deadline) {
		if (process.exitCode !== null) throw new Error(`OpenCode exited before startup (code ${process.exitCode}).`)
		try {
			await client.server.info()
			return
		} catch (error) {
			lastError = error
			await new Promise((resolve) => setTimeout(resolve, 150))
		}
	}
	throw new Error(`OpenCode 2.0.22 did not become ready. ${lastError instanceof Error ? lastError.message : ""}`)
}

async function waitForAgents(client: ReturnType<typeof OpenCode.make>, process: Bun.Subprocess) {
	const deadline = Date.now() + 35_000
	let latestAgents: Awaited<ReturnType<typeof client.agent.list>> | undefined
	let latestPlugins: Awaited<ReturnType<typeof client.plugin.list>> | undefined
	while (Date.now() < deadline) {
		if (process.exitCode !== null) throw new Error(`OpenCode exited while loading plugins (code ${process.exitCode}).`)
		latestAgents = await client.agent.list()
		latestPlugins = await client.plugin.list()
		const failed = latestPlugins.data.find((plugin) => plugin.state.status === "failed")
		if (failed) throw new Error(`OpenCode plugin failed to load: ${JSON.stringify(failed)}`)
		const ids = new Set(latestAgents.data.map((agent) => agent.id))
		if (["atlas", "sisyphus", "prometheus"].every((id) => ids.has(id))) return latestAgents
		await new Promise((resolve) => setTimeout(resolve, 200))
	}
	throw new Error(`Native OMO agents did not register: ${JSON.stringify(latestAgents?.data.map((agent) => agent.id) ?? [])}`)
}

async function stopProcess(process: Bun.Subprocess | undefined): Promise<void> {
	if (!process || process.exitCode !== null) return
	process.kill("SIGTERM")
	const stopped = await Promise.race([
		process.exited.then(() => true),
		new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5_000)),
	])
	if (!stopped && process.exitCode === null) {
		process.kill("SIGKILL")
		await process.exited
	}
}

async function waitForPendingNotice(client: ReturnType<typeof OpenCode.make>, sessionID: string, marker: string) {
	const deadline = Date.now() + 5_000
	let latest: Awaited<ReturnType<typeof client.session.inbox.list>> | undefined
	while (Date.now() < deadline) {
		latest = await client.session.inbox.list({ sessionID })
		if (latest.some((item) => item.type === "synthetic" && item.payload.text.includes(marker))) return latest
		await new Promise((resolve) => setTimeout(resolve, 50))
	}
	throw new Error(`Session ${sessionID} did not admit expected command notice: ${marker}. Pending inbox: ${JSON.stringify(latest ?? [])}`)
}

function stripTerminalControls(value: string): string {
	return value
		.replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
		.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/\u001b[@-_]/g, "")
}

async function waitForPtyText(getOutput: () => string, marker: string, process: Bun.Subprocess): Promise<string> {
	const deadline = Date.now() + 10_000
	let latest = ""
	while (Date.now() < deadline) {
		if (process.exitCode !== null) throw new Error(`The OpenCode TUI exited before rendering the command result (code ${process.exitCode}).`)
		latest = stripTerminalControls(getOutput())
		if (latest.includes(marker)) return latest
		await new Promise((resolve) => setTimeout(resolve, 100))
	}
	throw new Error(`The OpenCode PTY did not render ${marker}. Captured output: ${latest.slice(-4_000)}`)
}

async function stopTui(process: Bun.Subprocess | undefined, terminal: Bun.Terminal | undefined): Promise<void> {
	if (!process) {
		terminal?.close()
		return
	}
	if (process.exitCode !== null) {
		terminal?.close()
		return
	}
	terminal?.write("\u0003")
	const stopped = await Promise.race([
		process.exited.then(() => true),
		new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5_000)),
	])
	if (!stopped) {
		process.kill("SIGTERM")
		const terminated = await Promise.race([
			process.exited.then(() => true),
			new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3_000)),
		])
		if (!terminated) process.kill("SIGKILL")
	}
	terminal?.close()
}

async function main(): Promise<void> {
	if (!OPENCODE_BIN || !existsSync(OPENCODE_BIN)) throw new Error("Set OPENCODE2_CLI to the pinned OpenCode 2.0.22 executable.")
	if (!existsSync(join(PLUGIN_DIR, "server.js"))) throw new Error(`Native plugin bundle not found: ${join(PLUGIN_DIR, "server.js")}`)
	const versionResult = Bun.spawnSync([OPENCODE_BIN, "--version"], { stdout: "pipe", stderr: "pipe" })
	const version = new TextDecoder().decode(versionResult.stdout).trim()
	if (!version.includes("2.0.22")) throw new Error(`Expected OpenCode 2.0.22, got ${version}`)
	await mkdir(EVIDENCE, { recursive: true })

	const tempRoot = await realpath(await mkdtemp(join(tmpdir(), "opencode2-command-qa-")))
	const project = join(tempRoot, "project")
	const home = join(EVIDENCE, "home")
	const xdgData = join(EVIDENCE, "xdg-data")
	const xdgConfig = join(EVIDENCE, "xdg-config")
	const xdgState = join(EVIDENCE, "xdg-state")
	const xdgCache = join(EVIDENCE, "xdg-cache")
	const omoHome = join(EVIDENCE, "omo-home")
	const databasePath = join(EVIDENCE, "opencode-commands-qa.db")
	await Promise.all([project, home, xdgData, xdgConfig, xdgState, xdgCache, omoHome].map((path) => mkdir(path, { recursive: true })))
	const planDirectory = join(project, ".omo", "plans")
	await mkdir(planDirectory, { recursive: true })
	const planPath = join(planDirectory, "command-qa-plan.md")
	await writeFile(planPath, "# Command QA Plan\n\n## Tasks\n\n- [ ] 1. Keep this isolated QA plan active.\n", "utf8")

	const observations: ProviderObservation[] = []
	let modelCall = 0
	const mockModel = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const url = new URL(request.url)
			if (url.pathname.endsWith("/models")) return Response.json({ data: [{ id: "command-qa-model", object: "model", created: 0, owned_by: "omo-command-qa" }] })
			if (!url.pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 })
			const body = await request.json() as Record<string, unknown>
			modelCall += 1
			const model = typeof body.model === "string" ? body.model : "command-qa-model"
			const streaming = body.stream === true
			observations.push({ model, userText: userText(body), roles: roles(body), call: modelCall })
			return textResponse("OMO_COMMAND_QA_MODEL_RESPONSE", `omo-command-qa-${modelCall}`, model, streaming)
		},
	})

	const projectConfig = {
		$schema: "https://opencode.ai/config.json",
		plugins: [PLUGIN_DIR],
		model: "omoqa/command-qa-model",
		default_agent: "sisyphus",
		provider: {
			omoqa: {
				name: "OMO isolated command QA mock",
				npm: "@ai-sdk/openai-compatible",
				options: { baseURL: `http://127.0.0.1:${mockModel.port}/v1`, apiKey: QA_API_KEY },
				models: { "command-qa-model": { name: "Command QA model", tool_call: true, limit: { context: 200_000, output: 8_192 } } },
			},
		},
		permission: { shell: "deny", edit: "deny" },
	}
	await writeFile(join(project, "opencode.json"), `${JSON.stringify(projectConfig, null, 2)}\n`, "utf8")
	await mkdir(join(project, ".omo"), { recursive: true })
	await writeFile(join(project, ".omo", "omo.jsonc"), `${JSON.stringify({
		telemetry: { enabled: false },
		"[opencode]": {
			goal: { enabled: true, auto_start: false, default_max_iterations: 10 },
			disabled_hooks: ["goal", "todo-continuation-enforcer", "atlas"],
			disabled_mcps: ["websearch", "context7", "grep_app", "lsp"],
			claude_code: { mcp: false },
			agents: {
				atlas: { model: "omoqa/command-qa-model" },
				sisyphus: { model: "omoqa/command-qa-model" },
			},
			telemetry: false,
		},
	}, null, 2)}\n`, "utf8")

	let serverProcess: Bun.Subprocess | undefined
	let tuiProcess: Bun.Subprocess | undefined
	let tuiTerminal: Bun.Terminal | undefined
	let tuiOutput = ""
	let stdout = ""
	let stderr = ""
	let stdoutTask: Promise<void> = Promise.resolve()
	let stderrTask: Promise<void> = Promise.resolve()
	let client: ReturnType<typeof OpenCode.make> | undefined
	const observedEvents: InboxEnqueuedEvent[] = []
	const observedEventTypes: string[] = []
	const eventAbort = new AbortController()
	let eventTask: Promise<void> | undefined
	let failure: unknown
	let result: Record<string, unknown> = {}
	try {
		const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("reserved") })
		const port = reservation.port
		reservation.stop(true)
		serverProcess = Bun.spawn([OPENCODE_BIN, "--print-logs", "--log-level", "debug", "serve", "--hostname", "127.0.0.1", "--port", String(port)], {
			cwd: project,
			env: {
				PATH: process.env.PATH ?? "/usr/bin:/bin",
				TMPDIR: tmpdir(),
				HOME: home,
				XDG_DATA_HOME: xdgData,
				XDG_CONFIG_HOME: xdgConfig,
				XDG_STATE_HOME: xdgState,
				XDG_CACHE_HOME: xdgCache,
				OPENCODE_DB: databasePath,
				OMO_HOME: omoHome,
				OPENCODE_DISABLE_MODELS_FETCH: "1",
				OPENCODE_TELEMETRY_DISABLED: "1",
				OPENCODE_SERVER_PASSWORD: QA_PASSWORD,
				OPENCODE_PASSWORD: QA_PASSWORD,
			},
			stdout: "pipe",
			stderr: "pipe",
		})
		stdoutTask = new Response(serverProcess.stdout as ReadableStream<Uint8Array>).text().then((text) => { stdout += text })
		stderrTask = new Response(serverProcess.stderr as ReadableStream<Uint8Array>).text().then((text) => { stderr += text })
		client = OpenCode.make({
			baseUrl: `http://127.0.0.1:${port}`,
			headers: { Authorization: basicAuth(), "x-opencode-directory": project },
		})
		await within("OpenCode server startup", waitForServer(client, serverProcess), 30_000)
		eventTask = (async () => {
			try {
				for await (const event of client!.event.subscribe({ signal: eventAbort.signal })) {
					observedEventTypes.push(event.type)
					if (event.type === "session.inbox.enqueued") observedEvents.push(event)
				}
			} catch (error) {
				if (!eventAbort.signal.aborted) throw error
			}
		})()
		const agentList = await within("Native OMO agent registration", waitForAgents(client, serverProcess), 40_000)
		const commandList = await client.command.list()
		const commandNames = commandList.data.map((command) => command.name)
		for (const name of ["ulw-execute", "goal", "stop-continuation"]) {
			if (!commandNames.includes(name)) throw new Error(`Native command registry is missing ${name}.`)
		}

		const ulwSession = await client.session.create({ title: "OMO command QA: ulw execute" })
		await client.session.switchAgent({ sessionID: ulwSession.id, agent: "sisyphus" })
		await client.session.switchModel({ sessionID: ulwSession.id, model: { providerID: "omoqa", id: "command-qa-model" } })
		const ulwCallsBefore = observations.length
		await within("Public /ulw-execute command", client.session.command({ sessionID: ulwSession.id, name: "ulw-execute", text: "command-qa-plan" }))
		await within("/ulw-execute model turn", client.session.wait({ sessionID: ulwSession.id }))
		const ulwSessionAfter = await client.session.get({ sessionID: ulwSession.id })
		const ulwMessages = await client.message.list({ sessionID: ulwSession.id })
		const boulderPath = join(project, ".omo", "boulder.json")
		const boulderText = await readFile(boulderPath, "utf8")
		const boulder = JSON.parse(boulderText) as { active_plan?: string; session_ids?: string[]; agent?: string }
		const ulwConversation = JSON.stringify(ulwMessages.data)
		const ulwModelRequests = observations.slice(ulwCallsBefore)
		const ulwCommandTurnOnce = ulwModelRequests.length === 1
		const ulwPlanContextIncluded = ulwModelRequests.some((request) => request.userText.includes(planPath) && request.userText.includes("omo-ulw-execute-context"))
		const ulwBoulderScoped = boulder.active_plan === planPath && boulder.session_ids?.includes(`opencode:${ulwSession.id}`) === true
		const ulwAgentSelected = ulwSessionAfter.agent === "atlas"
		if (!ulwCommandTurnOnce || !ulwPlanContextIncluded || !ulwBoulderScoped || !ulwAgentSelected || !ulwConversation.includes("command-qa-plan")) {
			throw new Error(`Native /ulw-execute assertions failed: ${JSON.stringify({ ulwCommandTurnOnce, ulwPlanContextIncluded, ulwBoulderScoped, ulwAgentSelected, modelRequests: ulwModelRequests })}`)
		}

		const goalSession = await client.session.create({ title: "OMO command QA: goal" })
		await client.session.switchAgent({ sessionID: goalSession.id, agent: "sisyphus" })
		await client.session.switchModel({ sessionID: goalSession.id, model: { providerID: "omoqa", id: "command-qa-model" } })
		const setCallsBefore = observations.length
		await within("Public /goal objective command", client.session.command({ sessionID: goalSession.id, name: "goal", text: "QA_GOAL_OBJECTIVE_MARKER Complete a verified goal" }))
		await within("/goal objective model turn", client.session.wait({ sessionID: goalSession.id }))
		const objectivePromptOnce = observations.length === setCallsBefore + 1

		const boulderBeforeStop = await readFile(boulderPath, "utf8")
		const decoder = new TextDecoder()
		tuiTerminal = new Bun.Terminal({
			cols: 120,
			rows: 40,
			data: (_terminal, data) => { tuiOutput += decoder.decode(data, { stream: true }) },
		})
		tuiProcess = Bun.spawn([OPENCODE_BIN, "--server", `http://127.0.0.1:${port}`, "--session", goalSession.id, project], {
			cwd: project,
			env: {
				PATH: process.env.PATH ?? "/usr/bin:/bin",
				TMPDIR: tmpdir(),
				HOME: home,
				XDG_DATA_HOME: xdgData,
				XDG_CONFIG_HOME: xdgConfig,
				XDG_STATE_HOME: xdgState,
				XDG_CACHE_HOME: xdgCache,
				OPENCODE_DB: databasePath,
				OMO_HOME: omoHome,
				OPENCODE_DISABLE_MODELS_FETCH: "1",
				OPENCODE_TELEMETRY_DISABLED: "1",
				OPENCODE_SERVER_PASSWORD: QA_PASSWORD,
				OPENCODE_PASSWORD: QA_PASSWORD,
			},
			terminal: tuiTerminal,
		})
		await new Promise((resolve) => setTimeout(resolve, 1_500))
		if (tuiProcess.exitCode !== null) throw new Error(`The OpenCode TUI exited during startup (code ${tuiProcess.exitCode}).`)

		const infoCallsBefore = observations.length
		await within("Public /goal show command", client.session.command({ sessionID: goalSession.id, name: "goal", text: "" }))
		const goalStatusText = "Active goal (active): QA_GOAL_OBJECTIVE_MARKER Complete a verified goal"
		const goalStatusInbox = await waitForPendingNotice(client, goalSession.id, goalStatusText)
		const goalStatusNoticeQueued = goalStatusInbox.some((item) => item.type === "synthetic"
			&& item.payload.text.includes(goalStatusText)
			&& item.payload.metadata?.omoCommandNotice === 1)
		const goalStatusTuiMarker = "Active goal (active): QA_GOAL_OBJECTIVE_MARKER"
		const goalStatusVisibleInTui = (await waitForPtyText(() => tuiOutput, goalStatusTuiMarker, tuiProcess)).includes(goalStatusTuiMarker)
		await within("Public /goal pause command", client.session.command({ sessionID: goalSession.id, name: "goal", text: "pause" }))
		const goalPauseInbox = await waitForPendingNotice(client, goalSession.id, "The goal is paused for this session.")
		const goalPauseNoticeQueued = goalPauseInbox.some((item) => item.type === "synthetic"
			&& item.payload.text.includes("The goal is paused for this session.")
			&& item.payload.metadata?.omoCommandNotice === 1)
		const goalPauseTuiMarker = "paused for this session."
		const goalPauseVisibleInTui = (await waitForPtyText(() => tuiOutput, goalPauseTuiMarker, tuiProcess)).includes(goalPauseTuiMarker)
		const infoNoModelTurn = observations.length === infoCallsBefore

		const resumeCallsBefore = observations.length
		await within("Public /goal resume command", client.session.command({ sessionID: goalSession.id, name: "goal", text: "resume" }))
		await within("/goal resume model turn", client.session.wait({ sessionID: goalSession.id }))
		const resumeOneTurn = observations.length === resumeCallsBefore + 1
		const resumedCall = observations.slice(resumeCallsBefore)
		const resumeInstruction = "The goal is already resumed; do not replace it or reset its usage budget."
		const resumedGoalVisible = resumedCall.some((request) => request.userText.includes(resumeInstruction)
			&& request.userText.includes("QA_GOAL_OBJECTIVE_MARKER Complete a verified goal"))

		const otherSession = await client.session.create({ title: "OMO command QA: other session goal" })
		await client.session.switchAgent({ sessionID: otherSession.id, agent: "sisyphus" })
		await client.session.switchModel({ sessionID: otherSession.id, model: { providerID: "omoqa", id: "command-qa-model" } })
		await within("Public other-session /goal objective", client.session.command({ sessionID: otherSession.id, name: "goal", text: "QA_OTHER_GOAL_MARKER Keep this other session goal" }))
		await within("Other-session goal model turn", client.session.wait({ sessionID: otherSession.id }))
		const stopCallsBefore = observations.length
		await within("Public /stop-continuation command", client.session.command({ sessionID: goalSession.id, name: "stop-continuation", text: "" }))
		const stopNoticeInbox = await waitForPendingNotice(client, goalSession.id, "Continuation is stopped for this session")
		const stopNoticeEvent = observedEvents.find((event) => event.data.sessionID === goalSession.id
			&& event.data.item.type === "synthetic"
			&& event.data.item.payload.text.includes("Continuation is stopped for this session"))
		const stopNoticeTuiMarker = "Continuation is stopped"
		const stopNoticeVisibleInTui = (await waitForPtyText(() => tuiOutput, stopNoticeTuiMarker, tuiProcess)).includes(stopNoticeTuiMarker)
		const stopNoModelTurn = observations.length === stopCallsBefore
		// An identical command/input is intentionally coalesced for one second to absorb host duplicate callbacks.
		await new Promise((resolve) => setTimeout(resolve, 1_050))
		const afterStopStatusCallsBefore = observations.length
		await within("Public /goal show after stop", client.session.command({ sessionID: goalSession.id, name: "goal", text: "" }))
		await within("Public /goal show in other session", client.session.command({ sessionID: otherSession.id, name: "goal", text: "" }))
		const afterStopInbox = await waitForPendingNotice(client, goalSession.id, "There is no active goal for this session.")
		const otherGoalStatus = "Active goal (active): QA_OTHER_GOAL_MARKER Keep this other session goal"
		const otherGoalInbox = await waitForPendingNotice(client, otherSession.id, otherGoalStatus)
		const afterStopStatusesNoModelTurn = observations.length === afterStopStatusCallsBefore
		const stopClearedOnlyCurrentGoal = stopNoticeInbox.some((item) => item.type === "synthetic" && item.payload.text.includes("Continuation is stopped for this session"))
			&& afterStopInbox.some((item) => item.type === "synthetic" && item.payload.text.includes("There is no active goal for this session."))
			&& otherGoalInbox.some((item) => item.type === "synthetic" && item.payload.text.includes(otherGoalStatus))
		const boulderPreserved = await readFile(boulderPath, "utf8") === boulderBeforeStop

		const checks = {
			registeredCommands: ["ulw-execute", "goal", "stop-continuation"].every((name) => commandNames.includes(name)),
			ulwCommandTurnOnce,
			ulwPlanContextIncluded,
			ulwBoulderScoped,
			ulwAgentSelected,
			objectivePromptOnce,
			infoNoModelTurn,
			goalStatusNoticeQueued,
			goalStatusVisibleInTui,
			goalPauseNoticeQueued,
			goalPauseVisibleInTui,
			resumeOneTurn,
			resumedGoalVisible,
			stopNoModelTurn,
			stopNoticeVisibleInTui,
			afterStopStatusesNoModelTurn,
			stopClearedOnlyCurrentGoal,
			boulderPreserved,
		}
		result = {
			runtime: version,
			pluginDirectory: PLUGIN_DIR,
			projectDirectory: project,
			registeredCommands: commandNames,
			agentIds: agentList.data.map((agent) => agent.id),
			ulw: {
				sessionID: ulwSession.id,
				selectedAgent: ulwSessionAfter.agent,
				providerRequests: ulwModelRequests,
				messages: ulwMessages.data,
				boulder,
				planPath,
			},
			goal: {
				sessionID: goalSession.id,
				otherSessionID: otherSession.id,
				objectiveRequests: observations.slice(setCallsBefore),
				resumeRequests: resumedCall,
				goalStatusPendingInbox: goalStatusInbox,
				goalPausePendingInbox: goalPauseInbox,
				stopPendingInbox: stopNoticeInbox,
				stopInboxEvent: stopNoticeEvent,
				afterStopPendingInbox: afterStopInbox,
				otherSessionPendingInbox: otherGoalInbox,
				tuiSessionID: goalSession.id,
				boulderBeforeStop,
				boulderAfterStop: await readFile(boulderPath, "utf8"),
			},
			checks,
			providerObservations: observations,
			isolation: { home, xdgData, xdgConfig, xdgState, xdgCache, omoHome, databasePath, realDatabaseInspected: false },
		}
		if (Object.values(checks).some((value) => value !== true)) throw new Error(`Command QA assertions failed: ${JSON.stringify(checks)}`)
	} catch (error) {
		failure = error
		result = {
			...result,
			failure: error instanceof Error ? { name: error.name, message: redact(error.message) } : redact(String(error)),
			providerObservations: observations,
			observedEventTypes,
			observedInboxEvents: observedEvents,
		}
	} finally {
		await stopTui(tuiProcess, tuiTerminal)
		eventAbort.abort()
		await eventTask?.catch(() => undefined)
		await stopProcess(serverProcess)
		await Promise.all([stdoutTask, stderrTask])
		mockModel.stop(true)
		await Promise.all([
			writeFile(join(EVIDENCE, "server.log"), `${redact(`${stdout}\n${stderr}`)}\n`, "utf8"),
			writeFile(join(EVIDENCE, "commands-qa-pty.typescript"), tuiOutput, "utf8"),
			writeFile(join(EVIDENCE, "runtime.json"), `${JSON.stringify({ ...result, cleanup: { opencodeStopped: serverProcess?.exitCode !== null, mockProviderStopped: true } }, null, 2)}\n`, "utf8"),
		])
		await rm(tempRoot, { recursive: true, force: true })
	}
	if (failure) throw failure
	console.log(`OpenCode ${version} native command QA passed; evidence: ${EVIDENCE}`)
}

await main()
