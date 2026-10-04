import { createHash, randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, realpath, rename, writeFile } from "node:fs/promises"
import { isAbsolute, join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { Database } from "bun:sqlite"
import { OpenCode } from "@opencode/client"

const ROOT = resolve(import.meta.dir, "..")
const EVIDENCE_ROOT = resolve(process.env.OPENCODE2_EVIDENCE_DIR ?? join(ROOT, ".omo", "evidence", "20260927-native-background-policy", "native-runtime-qa"))
const PLUGIN_DIR = resolve(process.env.OPENCODE2_PLUGIN_DIR ?? join(ROOT, "dist", "opencode2"))
const OPENCODE_CLI_ENV = process.env.OPENCODE2_CLI
const OPENCODE_BIN = OPENCODE_CLI_ENV && isAbsolute(OPENCODE_CLI_ENV) ? resolve(OPENCODE_CLI_ENV) : undefined
const EXPECTED_SERVER_SHA256 = process.env.OPENCODE2_EXPECTED_SERVER_SHA256
const QA_PASSWORD = "omo-admission-qa-password"
const QA_API_KEY = "omo-admission-qa-local-key"
const MODEL = "omoqa/qa-model"
const SECONDARY_MODEL = "omoqa/qa-secondary"
const TIMEOUT_MS = 90_000
const RELOAD_SCENARIO_ENABLED = process.env.OPENCODE2_ADMISSION_RELOAD_SCENARIO === "1"
const CHILD_MARKERS = [
	"OMO_ADMISSION_CHILD_DIRECT_A",
	"OMO_ADMISSION_CHILD_TASK_B",
	"OMO_ADMISSION_CHILD_CALL_C",
	"OMO_ADMISSION_CHILD_RESUME_B",
	"OMO_ADMISSION_CHILD_CANCEL_FOLLOWER",
	"OMO_ADMISSION_CHILD_DEPTH_PROBE",
	"OMO_ADMISSION_CHILD_RELOAD_HELD",
	"OMO_ADMISSION_CHILD_RELOAD_NEXT",
] as const
type ChildMarker = typeof CHILD_MARKERS[number]

type SessionRow = {
	id: string
	parentID: string | null
	directory: string
	agent: string | null
	model: string | null
	idleOutcome: string | null
	timeIdle: number | null
}
type Lease = {
	leaseID: string
	rootSessionID: string
	parentSessionID: string
	childSessionID: string | null
	model: string
	childDepth: number
	mode: string
	status: string
	generation: number
	outcome: string | null
	baselineIdle?: number | null
}
type Observation = {
	number: number
	model: string
	stream: boolean
	sessionID?: string
	kind?: string
	childMarker?: ChildMarker
	sessionDirectory?: string
	sessionParentID?: string | null
	sessionModel?: string
	runningAdmissionLeases?: number
	marker?: string
	role: "parent" | "child" | "other"
	toolNames: string[]
	responsePlan: string
	startedAt: number
	finishedAt?: number
	aborted?: boolean
}
type Check = { name: string; passed: boolean; detail?: unknown }
type Client = ReturnType<typeof OpenCode.make>

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void
	let reject!: (reason?: unknown) => void
	const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
	return { promise, resolve, reject }
}

function redact(value: string): string {
	return value.replaceAll(QA_PASSWORD, "[redacted-test-password]").replaceAll(QA_API_KEY, "[redacted-test-api-key]")
}

function basicAuth(): string {
	return `Basic ${Buffer.from(`opencode:${QA_PASSWORD}`).toString("base64")}`
}

function toolNames(body: Record<string, unknown>): string[] {
	if (!Array.isArray(body.tools)) return []
	return body.tools.flatMap((entry) => {
		if (!entry || typeof entry !== "object") return []
		const item = entry as Record<string, unknown>
		const fn = item.function && typeof item.function === "object" ? item.function as Record<string, unknown> : undefined
		const name = typeof item.name === "string" ? item.name : typeof fn?.name === "string" ? fn.name : undefined
		return name ? [name] : []
	})
}

function userMarker(body: Record<string, unknown>, markerList: readonly string[]): string | undefined {
	if (!Array.isArray(body.messages)) return undefined
	for (let index = body.messages.length - 1; index >= 0; index--) {
		const message = body.messages[index]
		if (!message || typeof message !== "object") continue
		const item = message as Record<string, unknown>
		if (item.role !== "user") continue
		const content = typeof item.content === "string" ? item.content : JSON.stringify(item.content ?? "")
		const marker = markerList.find((candidate) => content.includes(candidate))
		if (marker) return marker
	}
	return undefined
}

function toolCallResponse(name: string, args: unknown, id: string, model: string, streaming: boolean): Response {
	const created = Math.floor(Date.now() / 1000)
	const call = { index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } }
	if (!streaming) return Response.json({
		id: `chatcmpl-${id}`, object: "chat.completion", created, model,
		choices: [{ index: 0, message: { role: "assistant", content: null, tool_calls: [call] }, finish_reason: "tool_calls" }],
		usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
	})
	const chunks = [
		{ id: `chatcmpl-${id}`, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [call] }, finish_reason: null }] },
		{ id: `chatcmpl-${id}`, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
	]
	return new Response(`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`, {
		headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive" },
	})
}

function textResponse(text: string, id: string, model: string, streaming: boolean): Response {
	const created = Math.floor(Date.now() / 1000)
	if (!streaming) return Response.json({
		id: `chatcmpl-${id}`, object: "chat.completion", created, model,
		choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
		usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
	})
	const chunks = [
		{ id: `chatcmpl-${id}`, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] },
		{ id: `chatcmpl-${id}`, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
	]
	return new Response(`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`, {
		headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive" },
	})
}

function markerFrom(body: Record<string, unknown>): string | undefined {
	return userMarker(body, [
		"OMO_PARENT_DIRECT_A", "OMO_PARENT_TASK_B", "OMO_PARENT_CALL_C", "OMO_PARENT_RESUME_B",
		"OMO_PARENT_CANCEL_FOLLOWER", "OMO_PARENT_DEPTH", "OMO_PARENT_RELOAD_HELD", "OMO_PARENT_RELOAD_NEXT", ...CHILD_MARKERS,
	])
}

function parentToolCall(marker: string, resumedChildID?: string): { tool: string; args: Record<string, unknown> } | undefined {
	switch (marker) {
		case "OMO_PARENT_DIRECT_A": return { tool: "subagent", args: { agent: "explore", prompt: CHILD_MARKERS[0], model: MODEL, background: true, description: "admission direct A" } }
		case "OMO_PARENT_TASK_B": return { tool: "task", args: { subagent_type: "explore", prompt: CHILD_MARKERS[1], run_in_background: true, description: "admission task B" } }
		case "OMO_PARENT_CALL_C": return { tool: "call_omo_agent", args: { subagent_type: "explore", prompt: CHILD_MARKERS[2], run_in_background: true, description: "admission call C" } }
		case "OMO_PARENT_RESUME_B": return { tool: "task", args: { task_id: resumedChildID ?? "__RESUMED_CHILD_B__", prompt: CHILD_MARKERS[3], run_in_background: true } }
		case "OMO_PARENT_CANCEL_FOLLOWER": return { tool: "subagent", args: { agent: "explore", prompt: CHILD_MARKERS[4], model: MODEL, background: true, description: "admission cancellation follower" } }
		case "OMO_PARENT_DEPTH": return { tool: "subagent", args: { agent: "depth-probe", prompt: CHILD_MARKERS[5], model: MODEL, background: true, description: "admission native-depth probe" } }
		case "OMO_PARENT_RELOAD_HELD": return { tool: "subagent", args: { agent: "explore", prompt: CHILD_MARKERS[6], model: MODEL, background: true, description: "admission offline-reload held child" } }
		case "OMO_PARENT_RELOAD_NEXT": return { tool: "subagent", args: { agent: "explore", prompt: CHILD_MARKERS[7], model: MODEL, background: true, description: "admission post-reload queued child" } }
	}
	return undefined
}

function sessionRows(dbPath: string, directory: string): SessionRow[] {
	if (!existsSync(dbPath)) return []
	const database = new Database(dbPath, { readonly: true, create: false })
	try {
		return database.query(`SELECT id, parent_id AS parentID, directory, agent, model,
			idle_outcome AS idleOutcome, time_idle AS timeIdle FROM session_v2 WHERE directory = ? ORDER BY time_created ASC`)
			.all(directory) as SessionRow[]
	} finally { database.close() }
}

function sessionRowByID(dbPath: string, sessionID: string): SessionRow | undefined {
	if (!existsSync(dbPath)) return undefined
	const database = new Database(dbPath, { readonly: true, create: false })
	try {
		return database.query(`SELECT id, parent_id AS parentID, directory, agent, model,
			idle_outcome AS idleOutcome, time_idle AS timeIdle FROM session_v2 WHERE id = ?`)
			.get(sessionID) as SessionRow | undefined
	} finally { database.close() }
}

function sessionModel(row: SessionRow | undefined): string | undefined {
	if (!row?.model) return undefined
	try { return selectedModel(JSON.parse(row.model)) }
	catch { return undefined }
}

function leaseRows(dbPath: string): Lease[] {
	if (!existsSync(dbPath)) return []
	const database = new Database(dbPath, { readonly: true, create: false })
	try {
		return database.query("SELECT value FROM kv WHERE key LIKE ? ORDER BY key")
			.all("%oh-my-openagent:v2:background-admission:lease:%")
			.flatMap((row) => {
				try { return [JSON.parse((row as { value: string }).value) as Lease] }
				catch { return [] }
			})
	} finally { database.close() }
}

async function within<T>(label: string, promise: Promise<T>, timeoutMs = TIMEOUT_MS): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined
	try {
		return await Promise.race([
			promise,
			new Promise<T>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs) }),
		])
	} finally { if (timer) clearTimeout(timer) }
}

async function waitFor(label: string, predicate: () => boolean | Promise<boolean>, timeoutMs = TIMEOUT_MS): Promise<void> {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		if (await predicate()) return
		await new Promise((resolve) => setTimeout(resolve, 50))
	}
	throw new Error(`${label} was not observed within ${timeoutMs}ms`)
}

async function stopProcess(process: Bun.Subprocess | undefined): Promise<void> {
	if (!process || process.exitCode !== null) return
	process.kill("SIGTERM")
	const stopped = await Promise.race([process.exited.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5000))])
	if (!stopped && process.exitCode === null) { process.kill("SIGKILL"); await process.exited }
}

function reservePort(): number {
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("reserved") })
	const port = server.port
	server.stop(true)
	if (typeof port !== "number") throw new Error("Unable to reserve a localhost port")
	return port
}

function childStatus(messages: unknown, toolName: string): { status?: string; text: string } {
	const text = JSON.stringify(messages ?? "")
	if (!messages || typeof messages !== "object" || !Array.isArray((messages as { data?: unknown }).data)) return { text }
	for (const message of (messages as { data: Array<Record<string, unknown>> }).data) {
		if (!Array.isArray(message.content)) continue
		for (const part of message.content as Array<Record<string, unknown>>) {
			if (part.type !== "tool" || part.name !== toolName || !part.state || typeof part.state !== "object") continue
			return { status: (part.state as Record<string, unknown>).status as string | undefined, text }
		}
	}
	return { text }
}

function selectedModel(value: unknown): string | undefined {
	if (!value || typeof value !== "object") return undefined
	const model = value as { providerID?: unknown; id?: unknown }
	return typeof model.providerID === "string" && typeof model.id === "string" ? `${model.providerID}/${model.id}` : undefined
}

async function main(): Promise<void> {
	if (!OPENCODE_BIN) throw new Error("OPENCODE2_CLI must be set to an explicit absolute path for the pinned OpenCode 2.0.22 executable.")
	if (!existsSync(OPENCODE_BIN)) throw new Error(`OpenCode CLI not found at ${OPENCODE_BIN}.`)
	if (!EXPECTED_SERVER_SHA256) throw new Error("OPENCODE2_EXPECTED_SERVER_SHA256 must be set to the reviewed frozen server bundle hash.")
	const serverPath = join(PLUGIN_DIR, "server.js")
	if (!existsSync(serverPath)) throw new Error(`Native bundle missing: ${serverPath}`)
	const serverHash = createHash("sha256").update(await readFile(serverPath)).digest("hex")
	if (serverHash !== EXPECTED_SERVER_SHA256) throw new Error(`Frozen bundle changed: expected ${EXPECTED_SERVER_SHA256}, received ${serverHash}`)

	const runID = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-")
	const evidence = join(EVIDENCE_ROOT, `run-${runID}`)
	await mkdir(evidence, { recursive: true })
	const tempRoot = await realpath(await mkdtemp(join(tmpdir(), "omo-native-admission-qa-")))
	const project = join(tempRoot, "project")
	const home = join(tempRoot, "home")
	const xdgData = join(tempRoot, "xdg-data")
	const xdgConfig = join(tempRoot, "xdg-config")
	const xdgState = join(tempRoot, "xdg-state")
	const xdgCache = join(tempRoot, "xdg-cache")
	const isolatedTmp = join(tempRoot, "tmp")
	const omoHome = join(tempRoot, "omo-home")
	const dbPath = join(tempRoot, "opencode.db")
	await Promise.all([project, home, xdgData, xdgConfig, xdgState, xdgCache, isolatedTmp, omoHome].map((path) => mkdir(path, { recursive: true })))
	const childEnvironment = {
		PATH: process.env.PATH ?? "/usr/bin:/bin",
		TMPDIR: isolatedTmp,
		HOME: home,
		XDG_DATA_HOME: xdgData,
		XDG_CONFIG_HOME: xdgConfig,
		XDG_STATE_HOME: xdgState,
		XDG_CACHE_HOME: xdgCache,
		OPENCODE_DB: dbPath,
		OMO_HOME: omoHome,
		OPENCODE_DISABLE_MODELS_FETCH: "1",
		OPENCODE_TELEMETRY_DISABLED: "1",
		OPENCODE_SERVER_PASSWORD: QA_PASSWORD,
		OPENCODE_PASSWORD: QA_PASSWORD,
	}
	const canonicalProject = await realpath(project)
	const port = reservePort()
	const observations: Observation[] = []
	const checks: Check[] = []
	const childEntered = new Map<ChildMarker, ReturnType<typeof deferred<void>>>()
	const childRelease = new Map<ChildMarker, ReturnType<typeof deferred<void>>>()
	const childParentByMarker = new Map<ChildMarker, string>()
	const childSessionByMarker = new Map<ChildMarker, string>()
	const childMarkerBySession = new Map<string, ChildMarker>()
	const parentMarkerBySession = new Map<string, string>()
	const childModelChecks: Array<{ marker: string; sessionID?: string; selected?: string; requestModel: string; passed: boolean }> = []
	const originFailures: Array<Record<string, unknown>> = []
	for (const marker of CHILD_MARKERS) { childEntered.set(marker, deferred<void>()); childRelease.set(marker, deferred<void>()) }
	const parentCallCounts = new Map<string, number>()
	let parentNotificationAcks = 0
	let parentNotificationsWithChildMarker = 0
	const markerCallCounts = new Map<string, number>()
	let resumedChildID: string | undefined
	const requestOrder: string[] = []
	const startedChildMarkers = new Set<string>()
	const activeChildRequests = new Set<number>()
	const activeChildMarkers = new Set<string>()
	const activeChildSessionCounts = new Map<string, number>()
	let peakConcurrentPrimaryChildSessionsInMockHandler = 0
	let peakRunningAdmissionLeases = 0
	let requestID = 0
	let serverProcess: Bun.Subprocess | undefined
	let client: Client | undefined
	let stdout = ""
	let stderr = ""
	let stdoutTask: Promise<void> = Promise.resolve()
	let stderrTask: Promise<void> = Promise.resolve()
	let failure: unknown
	let output: Record<string, unknown> = {}
	let version = "unverified"
	let originProbeActive = false
	let reloadScenarioEvidence: Record<string, unknown> = { enabled: RELOAD_SCENARIO_ENABLED }
	let mockServer: ReturnType<typeof Bun.serve> | undefined
	const promptRuns: Array<{ marker: string; sessionID: string; settled: Promise<{ ok: boolean; error?: string }> }> = []
	const promptResult = (promise: Promise<unknown>) => promise.then(
		() => ({ ok: true }),
		(error: unknown) => ({ ok: false, error: error instanceof Error ? error.message : String(error) }),
	)

	try {
		const versionResult = Bun.spawnSync([OPENCODE_BIN, "--version"], { stdout: "pipe", stderr: "pipe", env: childEnvironment })
		version = new TextDecoder().decode(versionResult.stdout).trim()
		if (!version.includes("2.0.22")) throw new Error(`Expected OpenCode 2.0.22, got ${version}`)

		const originHookDirectory = join(tempRoot, "omo-admission-origin-hook")
		const initialPluginOrder = RELOAD_SCENARIO_ENABLED ? [originHookDirectory, PLUGIN_DIR] : [PLUGIN_DIR, originHookDirectory]
		reloadScenarioEvidence = { enabled: RELOAD_SCENARIO_ENABLED, initialPluginOrder }
		await mkdir(originHookDirectory, { recursive: true })
		await writeFile(join(originHookDirectory, "index.js"), `export default {
	  id: "omo-native-admission-origin-probe",
	  setup: async ({ session }) => {
	    const registration = await session.hook("http.request", (event) => {
	      const headers = new Headers(event.request.headers)
	      headers.set("x-omo-qa-session-id", event.sessionID)
	      headers.set("x-omo-qa-kind", event.kind)
	      event.request = new Request(event.request, { headers })
	    })
	    return () => registration.dispose()
	  },
	}\n`, "utf8")
		mockServer = Bun.serve({
			hostname: "127.0.0.1", port: 0,
			async fetch(request) {
				const url = new URL(request.url)
				if (url.pathname.endsWith("/models")) return Response.json({ data: ["qa-model", "qa-secondary"].map((id) => ({ id, object: "model", created: 0, owned_by: "omo-qa" })) })
				if (!url.pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 })
				const body = await request.json() as Record<string, unknown>
				const id = `omo-admission-${++requestID}`
				const model = typeof body.model === "string" ? body.model : ""
				const streaming = body.stream === true
				const names = toolNames(body)
				const marker = markerFrom(body)
				const hintedChildMarker = CHILD_MARKERS.find((candidate) => candidate === marker)
				const sessionID = request.headers.get("x-omo-qa-session-id") ?? undefined
				const kind = request.headers.get("x-omo-qa-kind") ?? undefined
				const row = sessionID ? sessionRowByID(dbPath, sessionID) : undefined
				const sessionIDMarker = sessionID ? childMarkerBySession.get(sessionID) : undefined
				const candidateChildMarker = hintedChildMarker ?? sessionIDMarker
				const expectedParentID = candidateChildMarker ? childParentByMarker.get(candidateChildMarker) : undefined
				const sessionModelID = sessionModel(row)
				const childRequest = Boolean(kind === "primary" && row && expectedParentID && row.parentID === expectedParentID)
				const parentRequest = Boolean(kind === "primary" && sessionID && parentMarkerBySession.has(sessionID))
				const role: Observation["role"] = childRequest ? "child" : parentRequest ? "parent" : "other"
				const originValid = Boolean(sessionID && kind && row && row.directory === canonicalProject && sessionModelID === MODEL && model === "qa-model")
				const runningAdmissionLeases = leaseRows(dbPath).filter((lease) => lease.status === "running").length
				peakRunningAdmissionLeases = Math.max(peakRunningAdmissionLeases, runningAdmissionLeases)
				const observation: Observation = {
					number: requestID, model, stream: streaming, marker, role,
					...(childRequest && candidateChildMarker ? { childMarker: candidateChildMarker } : {}),
					...(sessionID ? { sessionID } : {}), ...(kind ? { kind } : {}),
					...(row ? { sessionDirectory: row.directory, sessionParentID: row.parentID } : {}),
					...(sessionModelID ? { sessionModel: sessionModelID } : {}),
					runningAdmissionLeases,
					toolNames: names, responsePlan: "text fallback", startedAt: Date.now(),
				}
				observations.push(observation)
				if (!originValid) {
					const detail = { sessionID, kind, row, sessionModel: sessionModelID, requestModel: model }
					originFailures.push(detail)
					observation.responsePlan = "refused: missing QA origin tag or request did not match isolated session/project/model"
					observation.finishedAt = Date.now()
					return new Response("QA refused an untagged request or a request outside the isolated project and pinned model.", { status: 500 })
				}
				if (role === "child" && sessionID && candidateChildMarker) {
					const childMarker = candidateChildMarker
					const knownChildID = childSessionByMarker.get(childMarker)
					if (knownChildID && knownChildID !== sessionID) {
						const detail = { childMarker, expectedSessionID: knownChildID, actualSessionID: sessionID, row }
						originFailures.push(detail)
						observation.responsePlan = "refused: marker did not belong to the expected child session"
						observation.finishedAt = Date.now()
						return new Response("QA refused a child marker attributed to a different session.", { status: 500 })
					}
					childSessionByMarker.set(childMarker, sessionID)
					childMarkerBySession.set(sessionID, childMarker)
					const modelCheck = {
						marker: childMarker, sessionID, selected: sessionModelID, requestModel: model,
						passed: row?.directory === canonicalProject && row.parentID === expectedParentID && sessionModelID === MODEL && model === "qa-model",
					}
					childModelChecks.push(modelCheck)
					if (!modelCheck.passed) {
						observation.responsePlan = `refused: child selected model ${sessionModelID ?? "unknown"} did not match local request model ${model}`
						observation.finishedAt = Date.now()
						return new Response("QA refused to answer a child model request that was not pinned to the local test model.", { status: 500 })
					}
					if (!startedChildMarkers.has(childMarker)) {
						startedChildMarkers.add(childMarker)
						requestOrder.push(childMarker)
					}
					activeChildRequests.add(requestID)
					activeChildMarkers.add(childMarker)
					activeChildSessionCounts.set(sessionID, (activeChildSessionCounts.get(sessionID) ?? 0) + 1)
					peakConcurrentPrimaryChildSessionsInMockHandler = Math.max(peakConcurrentPrimaryChildSessionsInMockHandler, activeChildSessionCounts.size)
					const finishChildRequest = () => {
						activeChildRequests.delete(requestID)
						activeChildMarkers.delete(childMarker)
						const count = activeChildSessionCounts.get(sessionID) ?? 1
						if (count <= 1) activeChildSessionCounts.delete(sessionID)
						else activeChildSessionCounts.set(sessionID, count - 1)
					}
					childEntered.get(childMarker)?.resolve()
					if (childMarker === CHILD_MARKERS[0] || childMarker === CHILD_MARKERS[3] || (RELOAD_SCENARIO_ENABLED && (childMarker === CHILD_MARKERS[6] || childMarker === CHILD_MARKERS[7]))) {
						const gate = childRelease.get(childMarker)!
						const aborted = deferred<void>()
						const onAbort = () => aborted.resolve()
						request.signal.addEventListener("abort", onAbort, { once: true })
						observation.responsePlan = "held until test release or native session interrupt"
						await Promise.race([gate.promise, aborted.promise])
						request.signal.removeEventListener("abort", onAbort)
						if (request.signal.aborted) {
							observation.aborted = true
							observation.finishedAt = Date.now()
							finishChildRequest()
							return new Response("mock request aborted by OpenCode session interrupt", { status: 499 })
						}
					observation.responsePlan = "released text completion"
					observation.finishedAt = Date.now()
					finishChildRequest()
						return textResponse(`OMO_CHILD_DONE_${childMarker}`, id, model, streaming)
					}
					if (childMarker === CHILD_MARKERS[5]) {
						const count = markerCallCounts.get(childMarker) ?? 0
						markerCallCounts.set(childMarker, count + 1)
						if (count === 0 && names.some((name) => name.toLowerCase() === "subagent")) {
							observation.responsePlan = "nested native subagent call expected to hit host depth limit"
							observation.finishedAt = Date.now()
							finishChildRequest()
							return toolCallResponse("subagent", { agent: "explore", model: SECONDARY_MODEL, prompt: "OMO_ADMISSION_NESTED_DEPTH_REJECTED", background: true, description: "native depth refusal" }, id, model, streaming)
						}
					}
					observation.responsePlan = "child text completion"
					observation.finishedAt = Date.now()
					finishChildRequest()
					return textResponse(`OMO_CHILD_DONE_${childMarker}`, id, model, streaming)
				}

				if (role === "parent" && sessionID) {
					const parentMarker = parentMarkerBySession.get(sessionID)!
					const count = parentCallCounts.get(parentMarker) ?? 0
					parentCallCounts.set(parentMarker, count + 1)
					const action = parentToolCall(parentMarker, resumedChildID)
					if (count === 0 && action) {
						const tool = names.find((name) => name.toLowerCase() === action.tool)
						if (tool) {
							observation.responsePlan = `parent invocation of ${tool}`
							observation.finishedAt = Date.now()
							return toolCallResponse(tool, action.args, id, model, streaming)
						}
						observation.responsePlan = `expected tool ${action.tool} is absent`
						observation.finishedAt = Date.now()
						return textResponse(`QA expected native/OMO tool ${action.tool} to be available.`, id, model, streaming)
					}
					parentNotificationAcks++
					if (hintedChildMarker) parentNotificationsWithChildMarker++
					observation.responsePlan = hintedChildMarker ? "parent notification acknowledged; marker validated against parent session" : "parent turn completion"
					observation.finishedAt = Date.now()
					return textResponse(`OMO_PARENT_DONE_${parentMarker}`, id, model, streaming)
				}

				observation.responsePlan = `auxiliary ${kind} request acknowledged without child/parent routing`
				observation.finishedAt = Date.now()
				return textResponse("OMO_ADMISSION_QA_AUXILIARY_ACK", id, model, streaming)
			},
		})
		const localProviderPort = mockServer.port
		if (typeof localProviderPort !== "number") throw new Error("Local mock provider did not bind")
		const agentModels = ["explore", "librarian", "sisyphus-junior"].map((id) => [id, { model: MODEL }])
		const projectConfig = {
			$schema: "https://opencode.ai/config.json",
			plugins: initialPluginOrder,
			enabled_providers: ["omoqa"],
			model: MODEL,
			provider: {
				omoqa: {
					name: "OMO admission QA local mock",
					npm: "@ai-sdk/openai-compatible",
					options: { baseURL: `http://127.0.0.1:${localProviderPort}/v1`, apiKey: QA_API_KEY },
					models: Object.fromEntries(["qa-model", "qa-secondary"].map((id) => [id, { name: id, tool_call: true, limit: { context: 200_000, output: 8_192 } }])),
				},
			},
			agents: {
				...Object.fromEntries(agentModels),
				"depth-probe": {
					model: MODEL,
					mode: "subagent",
					description: "A temporary isolated agent used only to verify the pinned native depth refusal.",
					system: "For the QA marker only, call the requested native subagent once and report the resulting error; do not perform other actions.",
					permissions: [{ action: "subagent", resource: "*", effect: "allow" }],
				},
			},
			experimental: { subagent_depth: 1 },
			permission: { edit: "deny", shell: "deny" },
		}
		const writeProjectPluginsAtomically = async (plugins: string[]) => {
			const temporaryConfig = join(project, `.opencode.json.qa-${randomUUID()}.tmp`)
			await writeFile(temporaryConfig, `${JSON.stringify({ ...projectConfig, plugins }, null, 2)}\n`, "utf8")
			await rename(temporaryConfig, join(project, "opencode.json"))
		}
		await writeFile(join(project, "opencode.json"), `${JSON.stringify(projectConfig, null, 2)}\n`, "utf8")
		await mkdir(join(project, ".omo"), { recursive: true })
		await writeFile(join(project, ".omo", "omo.jsonc"), `${JSON.stringify({
			"[opencode]": {
				telemetry: false,
				background_task: { defaultConcurrency: 1, maxDepth: 3, maxLiveDescendantsPerRoot: 12 },
				disabled_mcps: ["websearch", "context7", "grep_app", "lsp"],
				agents: Object.fromEntries(["explore", "librarian", "sisyphus-junior"].map((id) => [id, { model: MODEL }])),
				claude_code: { mcp: false, agents: false, skills: false, commands: false, plugins: false, hooks: false },
			},
		}, null, 2)}\n`, "utf8")

		serverProcess = Bun.spawn([OPENCODE_BIN, "--print-logs", "--log-level", "debug", "serve", "--hostname", "127.0.0.1", "--port", String(port)], {
			cwd: canonicalProject,
			env: childEnvironment,
			stdout: "pipe", stderr: "pipe",
		})
		stdoutTask = new Response(serverProcess.stdout as ReadableStream<Uint8Array>).text().then((value) => { stdout += value })
		stderrTask = new Response(serverProcess.stderr as ReadableStream<Uint8Array>).text().then((value) => { stderr += value })
		const baseUrl = `http://127.0.0.1:${port}`
		client = OpenCode.make({ baseUrl, headers: { Authorization: basicAuth(), "x-opencode-directory": canonicalProject } })
		await within("OpenCode server startup", (async () => {
			const deadline = Date.now() + 20_000
			while (Date.now() < deadline) {
				if (serverProcess?.exitCode !== null) throw new Error(`OpenCode exited early (${serverProcess?.exitCode})`)
				try { await client!.server.info(); return } catch { await new Promise((resolve) => setTimeout(resolve, 150)) }
			}
			throw new Error("OpenCode server did not become ready")
		})(), 22_000)
		await within("Native OMO plugin activation", (async () => {
			const deadline = Date.now() + 30_000
			while (Date.now() < deadline) {
				const [agents, plugins] = await Promise.all([client!.agent.list(), client!.plugin.list()])
				const failed = plugins.data.find((plugin) => plugin.state.status === "failed")
				if (failed) throw new Error(`Plugin failed: ${JSON.stringify(failed)}`)
				originProbeActive = plugins.data.some((plugin) => plugin.id === "omo-native-admission-origin-probe" && plugin.state.status === "active")
				const ids = new Set(agents.data.map((agent) => agent.id))
				if (ids.has("sisyphus") && ids.has("prometheus") && originProbeActive) return
				await new Promise((resolve) => setTimeout(resolve, 150))
			}
			throw new Error(`Native OMO agents or QA origin probe did not register (origin probe active: ${originProbeActive})`)
		})(), 32_000)
		const modelRegistry = await client.model.list()
		const availableModels = modelRegistry.data.map((entry) => `${entry.providerID}/${entry.id}`)
		const exactModelCatalog = [MODEL, SECONDARY_MODEL].sort()
		if (JSON.stringify([...availableModels].sort()) !== JSON.stringify(exactModelCatalog)) throw new Error(`Model catalog is not exactly the two local QA entries: ${JSON.stringify(availableModels)}`)
		const modelDefault = await client.model.default()
		if (selectedModel(modelDefault.data) !== MODEL) throw new Error(`Native default model is not pinned to ${MODEL}: ${JSON.stringify(modelDefault.data)}`)
		const mcpRegistry = await client.mcp.list()
		if (mcpRegistry.data.length !== 0) throw new Error(`Fixture unexpectedly activated MCP servers: ${JSON.stringify(mcpRegistry.data.map((item) => item.name))}`)
		const agentRegistry = await client.agent.list()
		const depthAgent = agentRegistry.data.find((agent) => agent.id === "depth-probe")
		if (!depthAgent || depthAgent.mode !== "subagent") throw new Error("Native configured depth-probe agent did not load")
		output = {
			...output,
			runtime: version,
			runtimeCli: OPENCODE_BIN,
			bundle: { serverPath, serverSha256: serverHash, expectedServerSha256: EXPECTED_SERVER_SHA256 },
			projectDirectory: canonicalProject,
			modelCatalog: [...availableModels].sort(),
			modelDefault: selectedModel(modelDefault.data),
			activeMcpNames: mcpRegistry.data.map((item) => item.name),
			originProbeActive,
			localOnlyPreflightPassed: JSON.stringify([...availableModels].sort()) === JSON.stringify(exactModelCatalog) && selectedModel(modelDefault.data) === MODEL && mcpRegistry.data.length === 0,
			originHookDirectory,
		}

		const createParent = async (title: string, agent = "sisyphus") => {
			const session = await client!.session.create({ title, location: { directory: canonicalProject } })
			assert(`session ${title} is created in the isolated project`, session.location.directory === canonicalProject, { sessionID: session.id, location: session.location })
			await client!.session.switchAgent({ sessionID: session.id, agent })
			await client!.session.switchModel({ sessionID: session.id, model: { providerID: "omoqa", id: "qa-model" } })
			const info = await client!.session.get({ sessionID: session.id })
			const selected = selectedModel(info.model)
			assert("parent session uses its requested agent", info.agent === agent, { sessionID: session.id, requested: agent, actual: info.agent })
			assert("parent session uses the local model before prompts", selected === MODEL, { sessionID: session.id, selected })
			return session
		}
		const startPrompt = async (sessionID: string, marker: string) => {
			const selected = selectedModel((await client!.session.get({ sessionID })).model)
			assert(`parent session model checked before ${marker}`, selected === MODEL, { sessionID, selected })
			parentMarkerBySession.set(sessionID, marker)
			const call = parentToolCall(marker, resumedChildID)
			if (call && CHILD_MARKERS.includes(call.args.prompt as ChildMarker)) {
				const childMarker = call.args.prompt as ChildMarker
				childParentByMarker.set(childMarker, sessionID)
				if (childMarker === CHILD_MARKERS[3] && resumedChildID) {
					childSessionByMarker.set(childMarker, resumedChildID)
					childMarkerBySession.set(resumedChildID, childMarker)
				}
			}
			const prompt = client!.session.prompt({ sessionID, text: marker })
			const run = { marker, sessionID, settled: promptResult(prompt) }
			promptRuns.push(run)
			return run
		}
		const leaseForParent = (parentSessionID: string, mode?: string) => leaseRows(dbPath).find((lease) => lease.parentSessionID === parentSessionID && (mode === undefined || lease.mode === mode))
		const childForParent = (parentSessionID: string) => sessionRows(dbPath, canonicalProject).find((row) => row.parentID === parentSessionID)
		const assert = (name: string, passed: boolean, detail?: unknown) => {
			checks.push({ name, passed, ...(detail === undefined ? {} : { detail }) })
			if (!passed) throw new Error(`Assertion failed: ${name}${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`)
		}
	const waitLease = async (parentSessionID: string, status: string, mode?: string, timeoutMs = TIMEOUT_MS) => {
		let found: Lease | undefined
		await waitFor(`lease ${parentSessionID} status ${status}`, () => {
			found = leaseForParent(parentSessionID, mode)
			return found?.status === status
		}, timeoutMs)
			return found!
		}
		const waitChildRequest = async (marker: ChildMarker, timeoutMs = TIMEOUT_MS) => within(`child model request ${marker}`, childEntered.get(marker)!.promise, timeoutMs)
		const currentSessionRows = () => sessionRows(dbPath, canonicalProject)
		const waitPromptSettlement = async (run: { marker: string; settled: Promise<{ ok: boolean; error?: string }> }) => within(`parent prompt ${run.marker}`, run.settled)
	const startQueueAction = async (title: string, promptMarker: string, expectedQueued: boolean, parentAgent?: string) => {
		const session = await createParent(title, parentAgent)
		const run = await startPrompt(session.id, promptMarker)
		if (expectedQueued) await waitLease(session.id, "queued", "new", 15_000)
			return { session, run }
		}

		// Direct native executor holds the one model slot while aliases queue.
		const directParent = await createParent("admission QA direct child")
		const directRun = await startPrompt(directParent.id, "OMO_PARENT_DIRECT_A")
		await waitChildRequest(CHILD_MARKERS[0])
		const directLease = await waitLease(directParent.id, "running", "new")
		const directChild = childForParent(directParent.id)
		assert("direct native child binds before its provider request", Boolean(directChild && directLease.childSessionID === directChild.id), { directChild, directLease })
		const directSettled = await waitPromptSettlement(directRun)
		assert("background direct call returns while child request remains held", directSettled.ok && activeChildMarkers.has(CHILD_MARKERS[0]), directSettled)

		const task = await startQueueAction("admission QA task alias", "OMO_PARENT_TASK_B", true)
		const taskLease = leaseForParent(task.session.id, "new")
		assert("task alias is queued behind the direct child", taskLease?.status === "queued" && !childForParent(task.session.id), { taskLease, child: childForParent(task.session.id) })
		const callAgent = await startQueueAction("admission QA call alias", "OMO_PARENT_CALL_C", true, "sisyphus-junior")
		const callLease = leaseForParent(callAgent.session.id, "new")
		assert("call_omo_agent alias is queued behind earlier work", callLease?.status === "queued" && !childForParent(callAgent.session.id), { callLease, child: childForParent(callAgent.session.id) })
		assert("aliases have not submitted child model requests while direct slot is held", !observations.some((request) => request.role === "child" && [CHILD_MARKERS[1], CHILD_MARKERS[2]].some((marker) => marker === request.childMarker)), observations)
		assert("only the direct child session is executing a primary request while the slot is held", activeChildSessionCounts.size === 1 && activeChildMarkers.has(CHILD_MARKERS[0]), { activeChildSessions: [...activeChildSessionCounts.keys()], activeMarkers: [...activeChildMarkers] })

		childRelease.get(CHILD_MARKERS[0])!.resolve()
		await waitChildRequest(CHILD_MARKERS[1])
		await waitLease(task.session.id, "running", "new")
		await waitPromptSettlement(task.run)
		await waitChildRequest(CHILD_MARKERS[2])
		await waitLease(callAgent.session.id, "running", "new")
		await waitPromptSettlement(callAgent.run)
		await waitFor("direct, task, and call_omo children to finish", () => [directParent.id, task.session.id, callAgent.session.id].every((parentID) => leaseForParent(parentID, "new")?.status === "terminal"))
		assert("direct and alias child requests start FIFO after the held predecessor", requestOrder.slice(0, 3).join(",") === CHILD_MARKERS.slice(0, 3).join(","), requestOrder)
		const firstChildren = [directParent.id, task.session.id, callAgent.session.id].map((parentID) => childForParent(parentID))
		assert("all three paths bind distinct direct native child sessions", firstChildren.every(Boolean) && new Set(firstChildren.map((row) => row?.id)).size === 3, firstChildren)
		assert("child models remain pinned to the configured local catalog entry", [directLease, taskLease!, callLease!].every((lease) => lease.model === MODEL) && observations.filter((request) => request.role === "child" && [CHILD_MARKERS[0], CHILD_MARKERS[1], CHILD_MARKERS[2]].some((marker) => marker === request.childMarker)).every((request) => request.model === "qa-model"), { leases: [directLease, taskLease, callLease], childModels: observations.filter((request) => request.role === "child").map((request) => request.model) })
		assert("one admission lease exists per direct/task/call_omo child", [directParent.id, task.session.id, callAgent.session.id].every((parentID) => leaseRows(dbPath).filter((lease) => lease.parentSessionID === parentID && lease.mode === "new").length === 1), leaseRows(dbPath))

		// Resume the exact task child, then keep its new generation held until a follower is queued.
		const taskChildID = firstChildren[1]!.id
		resumedChildID = taskChildID
		const taskChildBeforeResume = await client.session.get({ sessionID: taskChildID })
		const rowCountBeforeResume = currentSessionRows().length
		const resumeRun = await startPrompt(task.session.id, "OMO_PARENT_RESUME_B")
		await waitChildRequest(CHILD_MARKERS[3])
		const resumeLease = await waitLease(task.session.id, "running", "resume")
		assert("task resume binds a new generation to the same session", resumeLease.childSessionID === taskChildID && resumeLease.generation >= 2, resumeLease)
		const resumeSettled = await waitPromptSettlement(resumeRun)
		assert("background resume returns before its resumed request finishes", resumeSettled.ok && activeChildMarkers.has(CHILD_MARKERS[3]), resumeSettled)

		const follower = await startQueueAction("admission QA interrupt follower", "OMO_PARENT_CANCEL_FOLLOWER", true)
		const followerLease = leaseForParent(follower.session.id, "new")
		assert("follower queues behind the active resumed generation", followerLease?.status === "queued" && !childForParent(follower.session.id), { followerLease })
		await client.session.interrupt({ sessionID: taskChildID })
		await waitChildRequest(CHILD_MARKERS[4])
		await waitLease(task.session.id, "terminal", "resume")
		await waitPromptSettlement(follower.run)
		await waitFor("interrupted child record", async () => (await client!.session.get({ sessionID: taskChildID })).outcome === "interrupted")
		const taskChildAfterResume = await client.session.get({ sessionID: taskChildID })
		assert("native interrupt terminates the resumed generation and releases admission", taskChildAfterResume.outcome === "interrupted" && leaseForParent(task.session.id, "resume")?.outcome === "interrupted", { outcome: taskChildAfterResume.outcome, lease: leaseForParent(task.session.id, "resume") })
		const taskChildrenAfterResume = currentSessionRows().filter((row) => row.parentID === task.session.id)
		assert("resume reused its existing child row instead of creating another child session", taskChildrenAfterResume.length === 1 && taskChildrenAfterResume[0]?.id === taskChildID, { taskChildrenAfterResume, originalChildID: taskChildID, totalRowsBeforeResume: rowCountBeforeResume, totalRowsAfterResume: currentSessionRows().length })
		assert("resume kept the previously selected child model", JSON.stringify(taskChildBeforeResume.model) === JSON.stringify(taskChildAfterResume.model), { before: taskChildBeforeResume.model, after: taskChildAfterResume.model })

		// The host itself still rejects a depth-2 spawn when its configured cap is 1.
		const depthParent = await createParent("admission QA native depth refusal")
		const depthRun = await startPrompt(depthParent.id, "OMO_PARENT_DEPTH")
		const depthParentSettled = await waitPromptSettlement(depthRun)
		const depthChild = await waitChildRequest(CHILD_MARKERS[5]).then(() => childForParent(depthParent.id))
		if (!depthChild) throw new Error("depth-probe child session was not created")
		await waitFor("nested native depth error in child transcript", async () => JSON.stringify(await client!.message.list({ sessionID: depthChild.id })).includes("Subagent depth limit reached (1)"))
		await waitFor("depth probe completes", async () => (await client!.session.get({ sessionID: depthChild.id })).outcome === "succeeded")
		const nestedGrandchildren = currentSessionRows().filter((row) => row.parentID === depthChild.id)
		const depthTranscript = await client.message.list({ sessionID: depthChild.id })
		assert("native depth cap refuses the nested execution without a grandchild", depthParentSettled.ok && nestedGrandchildren.length === 0 && JSON.stringify(depthTranscript).includes("Subagent depth limit reached (1)"), { nestedGrandchildren, transcript: depthTranscript.data })

		let reloadParentSessionID: string | undefined
		let reloadNextParentSessionID: string | undefined
		if (RELOAD_SCENARIO_ENABLED) {
			assert("reload scenario orders the origin probe before OMO for prefix-preserving activation", initialPluginOrder[0] === originHookDirectory && initialPluginOrder[1] === PLUGIN_DIR, initialPluginOrder)
			const reloadParent = await createParent("admission QA offline reload lease")
			reloadParentSessionID = reloadParent.id
			const reloadRun = await startPrompt(reloadParent.id, "OMO_PARENT_RELOAD_HELD")
			await waitChildRequest(CHILD_MARKERS[6], 30_000)
			const reloadLease = await waitLease(reloadParent.id, "running", "new", 30_000)
			const reloadChild = childForParent(reloadParent.id)
			assert("fresh held child is bound with a null idle baseline", Boolean(reloadChild && reloadLease.childSessionID === reloadChild.id && reloadLease.baselineIdle === null), { reloadChild, reloadLease })
			if (!reloadChild) throw new Error("reload scenario child session was not created")
			const reloadParentSettled = await waitPromptSettlement(reloadRun)
			assert("held background invocation has returned while its provider response is pending", reloadParentSettled.ok && activeChildMarkers.has(CHILD_MARKERS[6]), reloadParentSettled)

			const serverInfoBefore = await client.server.info()
			const pluginsBefore = await client.plugin.list()
			assert("OMO and the origin probe are both active before the config reload", pluginsBefore.data.some((plugin) => plugin.id === "oh-my-openagent" && plugin.state.status === "active") && pluginsBefore.data.some((plugin) => plugin.id === "omo-native-admission-origin-probe" && plugin.state.status === "active"), pluginsBefore.data)
			const withoutOmo = [originHookDirectory, "-oh-my-openagent"]
			reloadScenarioEvidence = { ...reloadScenarioEvidence, serverPidBefore: serverInfoBefore.pid, parentSessionID: reloadParent.id, childSessionID: reloadChild?.id, leaseBeforeDisable: reloadLease, disabledPluginConfig: withoutOmo }
			await writeProjectPluginsAtomically(withoutOmo)
			await waitFor("OMO absent while the origin probe remains active", async () => {
				const current = await client!.plugin.list()
				return !current.data.some((plugin) => plugin.id === "oh-my-openagent") && current.data.some((plugin) => plugin.id === "omo-native-admission-origin-probe" && plugin.state.status === "active")
			}, 30_000)
			const [pluginsDuring, serverInfoDuring, agentsDuring] = await Promise.all([client.plugin.list(), client.server.info(), client.agent.list()])
			originProbeActive = pluginsDuring.data.some((plugin) => plugin.id === "omo-native-admission-origin-probe" && plugin.state.status === "active")
			assert("config reload removes only OMO and keeps the origin probe active", !pluginsDuring.data.some((plugin) => plugin.id === "oh-my-openagent") && originProbeActive, pluginsDuring.data)
			assert("public server remains healthy in the same process while OMO is absent", serverInfoBefore.version.includes("2.0.22") && serverInfoDuring.version === serverInfoBefore.version && serverInfoDuring.pid === serverInfoBefore.pid && serverInfoDuring.pid === serverProcess?.pid && agentsDuring.data.some((agent) => agent.id === "explore"), { processPid: serverProcess?.pid, before: serverInfoBefore, during: serverInfoDuring, agentCount: agentsDuring.data.length })
			reloadScenarioEvidence = { ...reloadScenarioEvidence, pluginIdsWhileAbsent: pluginsDuring.data.map((plugin) => plugin.id), serverPidWhileAbsent: serverInfoDuring.pid, healthyAgentCountWhileAbsent: agentsDuring.data.length, originProbeActiveWhileAbsent: originProbeActive }

			childRelease.get(CHILD_MARKERS[6])!.resolve()
			await waitFor("held child succeeds while OMO remains absent", async () => {
				const [child, currentPlugins] = await Promise.all([client!.session.get({ sessionID: reloadChild.id }), client!.plugin.list()])
				return child.outcome === "succeeded" && !currentPlugins.data.some((plugin) => plugin.id === "oh-my-openagent") && currentPlugins.data.some((plugin) => plugin.id === "omo-native-admission-origin-probe" && plugin.state.status === "active")
			}, 45_000)
			const reloadChildWhileOmoAbsent = await client.session.get({ sessionID: reloadChild.id })
			const heldRequest = observations.find((request) => request.childMarker === CHILD_MARKERS[6])
			const leaseWhileOmoAbsent = leaseForParent(reloadParent.id, "new")
			assert("native child completes while OMO is absent and its offline lease remains unreconciled", reloadChildWhileOmoAbsent.outcome === "succeeded" && heldRequest?.responsePlan === "released text completion" && !heldRequest.aborted && leaseWhileOmoAbsent?.status === "running", { outcome: reloadChildWhileOmoAbsent.outcome, heldRequest, leaseWhileOmoAbsent })
			reloadScenarioEvidence = { ...reloadScenarioEvidence, childOutcomeWhileOmoAbsent: reloadChildWhileOmoAbsent.outcome, heldRequestPlan: heldRequest?.responsePlan, leaseWhileOmoAbsent }

			await writeProjectPluginsAtomically(initialPluginOrder)
			await waitFor("OMO and origin probe reactivate from the restored exact plugin order", async () => {
				const [current, agents] = await Promise.all([client!.plugin.list(), client!.agent.list()])
				return current.data.some((plugin) => plugin.id === "oh-my-openagent" && plugin.state.status === "active") && current.data.some((plugin) => plugin.id === "omo-native-admission-origin-probe" && plugin.state.status === "active") && agents.data.some((agent) => agent.id === "sisyphus")
			}, 45_000)
			const restoredPlugins = await client.plugin.list()
			originProbeActive = restoredPlugins.data.some((plugin) => plugin.id === "omo-native-admission-origin-probe" && plugin.state.status === "active")
			assert("restored config uses the exact original plugin order and reactivates OMO", JSON.stringify(initialPluginOrder) === JSON.stringify([originHookDirectory, PLUGIN_DIR]) && restoredPlugins.data.some((plugin) => plugin.id === "oh-my-openagent" && plugin.state.status === "active") && originProbeActive, restoredPlugins.data)
			const reconciledLease = await waitLease(reloadParent.id, "terminal", "new", 30_000)
			assert("restored OMO reconciles the offline-completed null-baseline lease", reconciledLease.childSessionID === reloadChild.id && reconciledLease.outcome === "succeeded", reconciledLease)
			reloadScenarioEvidence = { ...reloadScenarioEvidence, pluginIdsAfterRestore: restoredPlugins.data.map((plugin) => plugin.id), leaseAfterRestore: reconciledLease }

			const nextParent = await createParent("admission QA child after offline lease recovery")
			reloadNextParentSessionID = nextParent.id
			const nextRun = await startPrompt(nextParent.id, "OMO_PARENT_RELOAD_NEXT")
			await waitChildRequest(CHILD_MARKERS[7], 30_000)
			const nextLease = await waitLease(nextParent.id, "running", "new", 30_000)
			const nextChild = childForParent(nextParent.id)
			if (!nextChild) throw new Error("post-reload child session was not created")
			childRelease.get(CHILD_MARKERS[7])!.resolve()
			await waitFor("post-reload child succeeds", async () => (await client!.session.get({ sessionID: nextChild.id })).outcome === "succeeded", 30_000)
			const nextParentSettled = await waitPromptSettlement(nextRun)
			const terminalNextLease = await waitLease(nextParent.id, "terminal", "new", 30_000)
			assert("next wrapped child starts and completes after the reconciled lease frees concurrency one", nextParentSettled.ok && nextLease.childSessionID === nextChild.id && terminalNextLease.outcome === "succeeded" && leaseForParent(reloadParent.id, "new")?.status === "terminal", { nextParentSettled, nextChild, nextLease, terminalNextLease, oldLease: leaseForParent(reloadParent.id, "new") })
			reloadScenarioEvidence = { ...reloadScenarioEvidence, nextParentSessionID: nextParent.id, nextChildSessionID: nextChild.id, nextChildOutcome: (await client.session.get({ sessionID: nextChild.id })).outcome, nextLease: terminalNextLease }
		}

			const allSessions = currentSessionRows()
			const allLeases = leaseRows(dbPath)
		const childObservations = observations.filter((request) => request.role === "child")
		const taggedExactOrigin = observations.length > 0 && observations.every((request) => Boolean(request.sessionID && request.kind && request.sessionDirectory === canonicalProject && request.sessionModel === MODEL && request.model === "qa-model"))
		assert("every mock chat request is tagged with its exact isolated session, kind, project, and pinned model", taggedExactOrigin, observations)
		assert("session HTTP origin probe plugin is active and no request failed origin validation", originProbeActive && originFailures.length === 0, { originProbeActive, originFailures })
		assert("child primary requests map to their expected parent, model, and one running admission lease", childObservations.length >= 6 && childObservations.every((request) => request.kind === "primary" && request.childMarker && request.sessionParentID === childParentByMarker.get(request.childMarker) && request.sessionModel === MODEL && request.runningAdmissionLeases === 1), childObservations)
		assert("parent completion notifications containing child markers are acknowledged by the parent session", parentNotificationsWithChildMarker > 0 && parentNotificationAcks >= parentNotificationsWithChildMarker && observations.filter((request) => request.role === "parent" && CHILD_MARKERS.includes(request.marker as ChildMarker)).every((request) => request.responsePlan.startsWith("parent notification acknowledged")), { parentNotificationAcks, parentNotificationsWithChildMarker, requests: observations.filter((request) => request.role === "parent" && CHILD_MARKERS.includes(request.marker as ChildMarker)) })
		assert("running admission leases observed at mock request starts never exceed configured concurrency one", peakRunningAdmissionLeases <= 1 && childObservations.every((request) => request.runningAdmissionLeases === 1), { peakRunningAdmissionLeases, childRequests: childObservations.map(({ sessionID, childMarker, runningAdmissionLeases }) => ({ sessionID, childMarker, runningAdmissionLeases })) })
		assert("distinct primary child sessions active in the mock handler never exceed the admission cap", peakConcurrentPrimaryChildSessionsInMockHandler <= 1, { peakConcurrentPrimaryChildSessionsInMockHandler })
		assert("every actual child primary request used the local model", childObservations.length >= 6 && childObservations.every((request) => request.model === "qa-model"), childObservations)
		assert("all observed mock requests used an expected local catalog model", observations.every((request) => request.model === "qa-model" || request.model === "qa-secondary"), observations)
		output = {
			runtime: version,
			productionSourceCommit: Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: ROOT, stdout: "pipe" }).stdout.toString().trim(),
			workingTreeHead: Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: ROOT, stdout: "pipe" }).stdout.toString().trim(),
			bundle: { serverPath, serverSha256: serverHash, expectedServerSha256: EXPECTED_SERVER_SHA256 },
			projectDirectory: canonicalProject,
			configuration: { model: MODEL, secondaryModel: SECONDARY_MODEL, backgroundTaskConcurrency: 1, nativeSubagentDepth: 1, disabledMcpIds: ["websearch", "context7", "grep_app", "lsp"], claudeMcpDisabled: true },
			modelCatalog: [...availableModels].sort(),
			modelDefault: selectedModel(modelDefault.data),
			activeMcpNames: mcpRegistry.data.map((item) => item.name),
			reloadScenario: reloadScenarioEvidence,
			childModelChecks,
			parentSessions: [directParent.id, task.session.id, callAgent.session.id, follower.session.id, depthParent.id, reloadParentSessionID, reloadNextParentSessionID].filter((id): id is string => Boolean(id)),
			children: allSessions.filter((row) => row.parentID !== null).map((row) => ({ id: row.id, parentID: row.parentID, agent: row.agent, model: row.model ? JSON.parse(row.model) : null, outcome: row.idleOutcome, timeIdle: row.timeIdle })),
			leases: allLeases.map(({ leaseID, rootSessionID, parentSessionID, childSessionID, model, childDepth, mode, status, generation, outcome, baselineIdle }) => ({ leaseID, rootSessionID, parentSessionID, childSessionID, model, childDepth, mode, status, generation, outcome, baselineIdle })),
			mockRequests: observations,
			childRequestOrder: requestOrder,
			primaryChildObservationCount: childObservations.length,
			parentNotificationsWithChildMarker,
			parentNotificationAcks,
			peakConcurrentPrimaryChildSessionsInMockHandler,
			peakRunningAdmissionLeasesAtRequestStart: peakRunningAdmissionLeases,
			originFailures,
			checks: Object.fromEntries(checks.map((check) => [check.name, check.passed])),
			checkDetails: checks,
			isolation: {
				databasePath: dbPath,
				databaseOnlyReadViaReadonlyConnections: true,
				realDatabaseInspected: false,
				allowedChildEnvironmentKeys: ["PATH", "TMPDIR", "HOME", "XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "OPENCODE_DB", "OMO_HOME", "OPENCODE_DISABLE_MODELS_FETCH", "OPENCODE_TELEMETRY_DISABLED", "OPENCODE_SERVER_PASSWORD", "OPENCODE_PASSWORD"],
				temporaryRoot: tempRoot,
				localOnlyPreflightPassed: JSON.stringify([...availableModels].sort()) === JSON.stringify(exactModelCatalog) && selectedModel(modelDefault.data) === MODEL && mcpRegistry.data.length === 0,
			},
		}
	} catch (error) {
		failure = error
		output = { ...output, failure: error instanceof Error ? { name: error.name, message: redact(error.message), stack: redact(error.stack ?? "") } : redact(String(error)), checks: Object.fromEntries(checks.map((check) => [check.name, check.passed])), checkDetails: checks, mockRequests: observations, childRequestOrder: requestOrder, originFailures }
	} finally {
		for (const release of childRelease.values()) release.resolve()
		await stopProcess(serverProcess)
		await Promise.all([stdoutTask, stderrTask])
		mockServer?.stop(true)
		let observedFinalState: { sessions?: SessionRow[]; leases?: Lease[]; readError?: string } = {}
		try {
			observedFinalState = { sessions: sessionRows(dbPath, canonicalProject), leases: leaseRows(dbPath) }
		} catch (error) {
			observedFinalState = { readError: error instanceof Error ? error.message : String(error) }
		}
		const sourceFiles = [
			"script/opencode2-admission-qa.ts",
			"packages/omo-opencode/src/v2/background-admission.ts",
			"packages/omo-opencode/src/v2/delegation-admission.ts",
			"packages/omo-opencode/src/v2/delegation.ts",
			"packages/omo-opencode/src/v2/task-state.ts",
		]
		const sourceHashes = Object.fromEntries(await Promise.all(sourceFiles.map(async (file) => [file, createHash("sha256").update(await readFile(join(ROOT, file))).digest("hex")])))
		const finalEvidence = {
			...output,
			reloadScenario: reloadScenarioEvidence,
			temporaryRoot: tempRoot,
			canonicalProjectDirectory: canonicalProject,
			evidenceDirectory: evidence,
			bundle: { serverPath: join(PLUGIN_DIR, "server.js"), serverSha256: serverHash, expectedServerSha256: EXPECTED_SERVER_SHA256 },
			sourceHashes,
			driverSha256: sourceHashes["script/opencode2-admission-qa.ts"],
			childModelChecks,
			observedFinalState,
			serverLog: redact(`${stdout}\n${stderr}`),
			cleanup: { opencodeProcessStopped: serverProcess?.exitCode !== null, localMockStopped: true, isolatedProjectRemoved: false, runtimeStateRetainedAt: tempRoot, databasePath: dbPath },
			providerTrafficClaim: checks.every((check) => check.passed) && childModelChecks.length >= 6 && childModelChecks.every((check) => check.passed)
				? { scope: "observed OpenAI-compatible chat requests whose HTTP hook tags mapped to an exact isolated session", requests: observations.length, models: [...new Set(observations.map((request) => request.model))], localModelCatalogExact: true, noMcpServers: true }
				: { scope: "fixture preflight was incomplete; no global locality assertion is made", observedRequests: observations.length },
		}
		await writeFile(join(evidence, "runtime.json"), `${JSON.stringify(finalEvidence, null, 2)}\n`, "utf8")
		await writeFile(join(evidence, "mock-requests.json"), `${JSON.stringify(observations, null, 2)}\n`, "utf8")
		await writeFile(join(evidence, "server.log"), `${redact(`${stdout}\n${stderr}`)}\n`, "utf8")
		await writeFile(join(evidence, "QA-SUMMARY.md"), [
			"# Native background admission QA",
			"",
			`- Runtime: OpenCode ${version}`,
			`- Server bundle SHA-256: ${serverHash}`,
			`- Result: ${failure ? "FAILED" : "passed"}`,
			`- Checks: ${checks.filter((check) => check.passed).length}/${checks.length}`,
			`- Evidence directory: ${evidence}`,
			`- Isolated runtime state: ${tempRoot}`,
			"- DB inspection used readonly SQLite connections to OPENCODE_DB under that isolated temporary root.",
			`- Offline plugin reload scenario: ${RELOAD_SCENARIO_ENABLED ? "enabled" : "not requested"}. Set OPENCODE2_ADMISSION_RELOAD_SCENARIO=1 to run it.`,
			"- Local-only scope is claimed only if exact-model, default-model, no-MCP, and child-model assertions all passed; see runtime.json otherwise.",
		].join("\n") + "\n", "utf8")
		const manifestFiles = ["runtime.json", "mock-requests.json", "server.log", "QA-SUMMARY.md"]
		const manifest = await Promise.all(manifestFiles.map(async (name) => `${createHash("sha256").update(await readFile(join(evidence, name))).digest("hex")}  ${name}`))
		await writeFile(join(evidence, "SHA256SUMS"), `${manifest.join("\n")}\n`, "utf8")
	}
	if (failure) throw new Error(`Native admission QA failed; evidence: ${evidence}; ${failure instanceof Error ? failure.message : String(failure)}`)
	console.log(`Native OpenCode 2.0.22 admission QA passed; evidence: ${evidence}`)
}

await main()
