import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { Database, type SQLQueryBindings } from "bun:sqlite"
import { OpenCode } from "@opencode/client"
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises"
import { isAbsolute, join, resolve } from "node:path"
import { tmpdir } from "node:os"

const ROOT = resolve(import.meta.dir, "..")
const EVIDENCE_ROOT = resolve(process.env.OPENCODE2_QUEUE_TTL_EVIDENCE_DIR ?? join(ROOT, ".omo", "evidence", "20260927-native-background-queue-ttl"))
const PLUGIN_DIR = resolve(process.env.OPENCODE2_PLUGIN_DIR ?? join(ROOT, "dist", "opencode2"))
const CLI = process.env.OPENCODE2_CLI?.trim() ?? ""
const EXPECTED_SERVER_SHA256 = process.env.OPENCODE2_EXPECTED_SERVER_SHA256 ?? ""
const EXPECTED_VERSION = "2.0.18"
const PROVIDER = "omoqa"
const MODEL_ID = "queue-ttl-local-model"
const MODEL = `${PROVIDER}/${MODEL_ID}`
const PLUGIN_ID = "oh-my-openagent"
const ORIGIN_PLUGIN_ID = "omo-queue-ttl-origin-probe"
const PROBE_PASSWORD = "omo-queue-ttl-local-password"
const FAKE_API_KEY = "omo-queue-ttl-local-fake-key"
const TASK_TTL_MS = 300_000
const HEARTBEAT_MS = 5_000
const CHILD_MARKERS = {
	noProgress: "OMO_QUEUE_TTL_NO_PROGRESS",
	active: "OMO_QUEUE_TTL_ACTIVE_PROGRESS",
	expires: "OMO_QUEUE_TTL_WAITER_EXPIRES",
	survives: "OMO_QUEUE_TTL_WAITER_SURVIVES",
} as const

type ChildKind = keyof typeof CHILD_MARKERS
type Client = ReturnType<typeof OpenCode.make>
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
	mode: string
	status: string
	generation: number
	outcome: string | null
	createdAt: number
	updatedAt: number
}
type ActivityState = {
	sessionID: string
	status: string
	progressed: boolean
	lastProgressAt: number | null
	trigger: { reason: string; at: number; attempts: number } | null
}
type Observation = {
	at: number
	sessionID?: string
	parentID?: string | null
	kind?: string
	model: string
	role: "parent" | "child" | "other"
	childKind?: ChildKind
	toolNames: string[]
	responsePlan: string
	progressChunks: number
	aborted: boolean
}
type Check = { name: string; passed: boolean; detail?: unknown }
const REQUEST_KINDS = new Set(["primary", "compaction", "title", "generate"])

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

function dataOf(value: unknown): unknown {
	return isRecord(value) && "data" in value ? value.data : value
}

function selectedModel(value: unknown): string | undefined {
	if (!isRecord(value) || typeof value.providerID !== "string" || typeof value.id !== "string") return undefined
	return `${value.providerID}/${value.id}`
}

function sha256(value: Uint8Array | string): string {
	return createHash("sha256").update(value).digest("hex")
}

function redact(value: string): string {
	return value.replaceAll(PROBE_PASSWORD, "[redacted-qa-password]").replaceAll(FAKE_API_KEY, "[redacted-fake-api-key]")
}

function basicAuth(): string {
	return `Basic ${Buffer.from(`opencode:${PROBE_PASSWORD}`).toString("base64")}`
}

function toolNames(body: Record<string, unknown>): string[] {
	if (!Array.isArray(body.tools)) return []
	return body.tools.flatMap((entry) => {
		if (!isRecord(entry)) return []
		const fn = isRecord(entry.function) ? entry.function : undefined
		const name = typeof entry.name === "string" ? entry.name : typeof fn?.name === "string" ? fn.name : undefined
		return name ? [name] : []
	})
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
		headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" },
	})
}

function textResponse(text: string, id: string, model: string, streaming: boolean): Response {
	const created = Math.floor(Date.now() / 1000)
	if (!streaming) return Response.json({
		id: `chatcmpl-${id}`, object: "chat.completion", created, model,
		choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
		usage: { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 },
	})
	const chunks = [
		{ id: `chatcmpl-${id}`, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] },
		{ id: `chatcmpl-${id}`, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
	]
	return new Response(`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`, {
		headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" },
	})
}

function chunk(id: string, model: string, delta: Record<string, unknown>, finish: string | null = null): string {
	return `data: ${JSON.stringify({
		id: `chatcmpl-${id}`,
		object: "chat.completion.chunk",
		created: Math.floor(Date.now() / 1000),
		model,
		choices: [{ index: 0, delta, finish_reason: finish }],
	})}\n\n`
}

function heldProgressResponse(request: Request, observation: Observation, id: string, model: string, release: Promise<void>, onEnd: () => void): Response {
	const encoder = new TextEncoder()
	let timer: ReturnType<typeof setInterval> | undefined
	let controllerRef: ReadableStreamDefaultController<Uint8Array> | undefined
	let ended = false
	const end = (aborted: boolean) => {
		if (ended) return
		ended = true
		observation.aborted = aborted
		onEnd()
		if (timer) clearInterval(timer)
		request.signal.removeEventListener("abort", onAbort)
		if (aborted) {
			try { controllerRef?.close() } catch { /* stream already cancelled */ }
			return
		}
		try {
			controllerRef?.enqueue(encoder.encode(chunk(id, model, { content: " child completed." })))
			controllerRef?.enqueue(encoder.encode(chunk(id, model, {}, "stop")))
			controllerRef?.enqueue(encoder.encode("data: [DONE]\n\n"))
			controllerRef?.close()
		} catch { /* host cancelled after test release */ }
	}
	const onAbort = () => end(true)
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			controllerRef = controller
			controller.enqueue(encoder.encode(chunk(id, model, { role: "assistant" })))
			timer = setInterval(() => {
				if (ended) return
				observation.progressChunks += 1
				try { controller.enqueue(encoder.encode(chunk(id, model, { content: "." }))) } catch { end(true) }
			}, HEARTBEAT_MS)
			request.signal.addEventListener("abort", onAbort, { once: true })
			void release.then(() => end(false))
			if (request.signal.aborted) onAbort()
		},
		cancel() { end(true) },
	})
	return new Response(stream, { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive" } })
}

function noProgressResponse(request: Request, observation: Observation, id: string, model: string, onEnd: () => void): Response {
	const encoder = new TextEncoder()
	let timer: ReturnType<typeof setInterval> | undefined
	let controllerRef: ReadableStreamDefaultController<Uint8Array> | undefined
	let ended = false
	const end = () => {
		if (ended) return
		ended = true
		observation.aborted = true
		onEnd()
		if (timer) clearInterval(timer)
		request.signal.removeEventListener("abort", onAbort)
		try { controllerRef?.close() } catch { /* stream already cancelled */ }
	}
	const onAbort = () => end()
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			controllerRef = controller
			// The role-only event starts a valid SSE response. Comments keep the
			// transport alive but must not count as model progress for the watchdog.
			controller.enqueue(encoder.encode(chunk(id, model, { role: "assistant" })))
			timer = setInterval(() => {
				try { controller.enqueue(encoder.encode(": native queue watchdog QA keepalive\n\n")) } catch { end() }
			}, HEARTBEAT_MS)
			request.signal.addEventListener("abort", onAbort, { once: true })
			if (request.signal.aborted) onAbort()
		},
		cancel() { end() },
	})
	observation.responsePlan = "SSE comment keepalives only until native watchdog interruption"
	return new Response(stream, { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive" } })
}

function readRows(dbPath: string, sql: string, ...args: SQLQueryBindings[]): unknown[] {
	if (!existsSync(dbPath)) return []
	const database = new Database(dbPath, { readonly: true, create: false })
	try { return database.query(sql).all(...args) }
	finally { database.close() }
}

function parseValue(value: unknown): unknown {
	if (typeof value === "string") {
		try { return JSON.parse(value) as unknown } catch { return value }
	}
	if (value instanceof Uint8Array) {
		try { return JSON.parse(new TextDecoder().decode(value)) as unknown } catch { return value }
	}
	return value
}

function sessionRows(dbPath: string, directory: string): SessionRow[] {
	return readRows(dbPath, `SELECT id, parent_id AS parentID, directory, agent, model,
		idle_outcome AS idleOutcome, time_idle AS timeIdle FROM session_v2 WHERE directory = ? ORDER BY time_created ASC`, directory) as SessionRow[]
}

function sessionRow(dbPath: string, sessionID: string): SessionRow | undefined {
	return readRows(dbPath, `SELECT id, parent_id AS parentID, directory, agent, model,
		idle_outcome AS idleOutcome, time_idle AS timeIdle FROM session_v2 WHERE id = ?`, sessionID)[0] as SessionRow | undefined
}

function leaseRows(dbPath: string): Lease[] {
	return readRows(dbPath, "SELECT value FROM kv WHERE key LIKE ? ORDER BY key", "%oh-my-openagent:v2:background-admission:lease:%")
		.flatMap((row) => {
			const value = isRecord(row) ? parseValue(row.value) : undefined
			return isRecord(value) && typeof value.leaseID === "string" ? [value as Lease] : []
		})
}

function activityRows(dbPath: string): ActivityState[] {
	return readRows(dbPath, "SELECT value FROM kv WHERE key LIKE ? ORDER BY key", "%oh-my-openagent:v2:background-activity:%")
		.flatMap((row) => {
			const value = isRecord(row) ? parseValue(row.value) : undefined
			return isRecord(value) && typeof value.sessionID === "string" ? [value as ActivityState] : []
		})
}

function rowModel(row: SessionRow | undefined): string | undefined {
	if (!row?.model) return undefined
	const value = parseValue(row.model)
	return selectedModel(value)
}

async function waitFor(label: string, predicate: () => boolean | Promise<boolean>, timeoutMs = 30_000): Promise<void> {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		if (await predicate()) return
		await new Promise((resolve) => setTimeout(resolve, 100))
	}
	throw new Error(`${label} was not observed within ${timeoutMs} ms`)
}

async function withTimeout<T>(label: string, promise: Promise<T>, timeoutMs = 30_000): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined
	try {
		return await Promise.race([
			promise,
			new Promise<T>((_, reject) => {
				timer = setTimeout(() => reject(new Error(`${label} did not settle within ${timeoutMs} ms`)), timeoutMs)
			}),
		])
	} finally {
		if (timer) clearTimeout(timer)
	}
}

function reservePort(): number {
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("reserved") })
	const port = server.port
	server.stop(true)
	if (typeof port !== "number") throw new Error("Could not reserve a localhost port")
	return port
}

async function stopProcess(process: Bun.Subprocess | undefined): Promise<boolean> {
	if (!process || process.exitCode !== null) return true
	process.kill("SIGTERM")
	const stopped = await Promise.race([
		process.exited.then(() => true),
		new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5_000)),
	])
	if (stopped) return true
	if (process.exitCode === null) process.kill("SIGKILL")
	await process.exited
	return process.exitCode !== null
}

function makeOriginPlugin(): string {
	return `export default {
  id: ${JSON.stringify(ORIGIN_PLUGIN_ID)},
  setup: async ({ session }) => {
    const registration = await session.hook("http.request", (event) => {
      const headers = new Headers(event.request.headers)
      headers.set("x-omo-qa-session-id", event.sessionID)
      headers.set("x-omo-qa-kind", event.kind)
      event.request = new Request(event.request, { headers })
    })
    return () => registration.dispose()
  },
}
`
}

async function waitForActivePlugin(client: Client, process: Bun.Subprocess): Promise<{ pluginIDs: string[]; agents: string[] }> {
	const deadline = Date.now() + 30_000
	let pluginIDs: string[] = []
	let agents: string[] = []
	while (Date.now() < deadline) {
		if (process.exitCode !== null) throw new Error(`OpenCode exited during plugin activation (${process.exitCode}).`)
		const [pluginsResponse, agentsResponse] = await Promise.all([client.plugin.list(), client.agent.list()])
		const plugins = dataOf(pluginsResponse)
		const agentData = dataOf(agentsResponse)
		if (!Array.isArray(plugins) || !Array.isArray(agentData)) throw new Error("Plugin/agent registry has an unexpected response shape.")
		const failed = plugins.filter((plugin) => isRecord(plugin) && isRecord(plugin.state) && plugin.state.status === "failed")
		if (failed.length) throw new Error(`Native plugin startup failed: ${JSON.stringify(failed)}`)
		pluginIDs = plugins.flatMap((plugin) => isRecord(plugin) && isRecord(plugin.state) && plugin.state.status === "active" && typeof plugin.id === "string" ? [plugin.id] : [])
		agents = agentData.flatMap((agent) => isRecord(agent) && typeof agent.id === "string" ? [agent.id] : [])
		if (pluginIDs.includes(PLUGIN_ID) && pluginIDs.includes(ORIGIN_PLUGIN_ID) && agents.includes("sisyphus") && agents.includes("explore")) return { pluginIDs, agents }
		await new Promise((resolve) => setTimeout(resolve, 150))
	}
	throw new Error(`Expected OMO, origin probe, and native agents to activate; active=${pluginIDs.join(",")}, agents=${agents.join(",")}`)
}

function assert(checks: Check[], name: string, passed: boolean, detail?: unknown): void {
	checks.push({ name, passed, ...(detail === undefined ? {} : { detail }) })
	if (!passed) throw new Error(`Assertion failed: ${name}${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`)
}

async function main(): Promise<void> {
	if (!isAbsolute(CLI) || !existsSync(CLI)) throw new Error("OPENCODE2_CLI must be an explicit absolute path to the pinned OpenCode 2.0.18 executable.")
	if (!EXPECTED_SERVER_SHA256) throw new Error("OPENCODE2_EXPECTED_SERVER_SHA256 must name the reviewed frozen server bundle.")
	const serverPath = join(PLUGIN_DIR, "server.js")
	if (!existsSync(serverPath)) throw new Error(`Native bundle not found: ${serverPath}`)
	const serverHash = sha256(await readFile(serverPath))
	if (serverHash !== EXPECTED_SERVER_SHA256) throw new Error(`Frozen server bundle hash mismatch: expected ${EXPECTED_SERVER_SHA256}, got ${serverHash}`)

	const runID = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-")
	const evidence = join(EVIDENCE_ROOT, `run-${runID}`)
	await mkdir(evidence, { recursive: true })
	const tempRoot = await realpath(await mkdtemp(join(tmpdir(), "omo-queue-ttl-qa-")))
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
	const env = {
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
		OPENCODE_SERVER_PASSWORD: PROBE_PASSWORD,
		OPENCODE_PASSWORD: PROBE_PASSWORD,
	}
	const canonicalProject = await realpath(project)
	const providerPort = reservePort()
	const openCodePort = reservePort()

	const originDir = join(tempRoot, "origin-plugin")
	await mkdir(originDir, { recursive: true })
	await writeFile(join(originDir, "index.js"), makeOriginPlugin(), "utf8")
	const pluginPaths = [PLUGIN_DIR, originDir]
	const projectConfig = {
		$schema: "https://opencode.ai/config.json",
		plugins: pluginPaths,
		enabled_providers: [PROVIDER],
		model: MODEL,
		provider: {
			[PROVIDER]: {
				name: "Queue TTL QA local mock",
				npm: "@ai-sdk/openai-compatible",
				options: { baseURL: `http://127.0.0.1:${providerPort}/v1`, apiKey: FAKE_API_KEY },
				models: { [MODEL_ID]: { name: MODEL_ID, tool_call: true, limit: { context: 200_000, output: 8_192 } } },
			},
		},
		mcp: {},
		permission: { subagent: "allow", shell: "deny", edit: "deny" },
	}
	await writeFile(join(project, "opencode.json"), `${JSON.stringify(projectConfig, null, 2)}\n`, "utf8")
	await mkdir(join(project, ".omo"), { recursive: true })
	const omoConfig = {
		telemetry: { enabled: false },
		"[opencode]": {
			telemetry: false,
			default_agent: "sisyphus",
			agents: {
				sisyphus: { model: MODEL },
				explore: { model: MODEL },
			},
			background_task: {
				defaultConcurrency: 1,
				maxDepth: 3,
				maxLiveDescendantsPerRoot: 12,
				taskTtlMs: TASK_TTL_MS,
				messageStalenessTimeoutMs: 60_000,
				staleTimeoutMs: 60_000,
				sessionGoneTimeoutMs: 300_000,
			},
			disabled_providers: [],
			runtime_fallback: { enabled: false },
			disabled_hooks: ["goal", "todo-continuation-enforcer", "atlas", "directory-readme-injector", "rules-injector"],
			disabled_mcps: ["websearch", "context7", "grep_app", "lsp"],
			claude_code: { mcp: false, agents: false, skills: false, commands: false, plugins: false, hooks: false },
		},
	}
	await writeFile(join(project, ".omo", "omo.jsonc"), `${JSON.stringify(omoConfig, null, 2)}\n`, "utf8")
	await writeFile(join(evidence, "opencode.json"), `${JSON.stringify(projectConfig, null, 2)}\n`, "utf8")
	await writeFile(join(evidence, "omo.jsonc"), `${JSON.stringify(omoConfig, null, 2)}\n`, "utf8")

	const checks: Check[] = []
	const observations: Observation[] = []
	const parentPlans = new Map<string, ChildKind>()
	const parentRequestCount = new Map<string, number>()
	const heldRelease = new Map<string, { promise: Promise<void>; resolve: () => void }>()
	let requestNumber = 0
	let localOriginFailures: Array<Record<string, unknown>> = []
	let serverProcess: Bun.Subprocess | undefined
	let providerApp: ReturnType<typeof Bun.serve> | undefined
	let providerStarted = false
	let providerStopped = false
	let providerStopError: string | undefined
	let stdout = ""
	let stderr = ""
	let stdoutTask: Promise<void> = Promise.resolve()
	let stderrTask: Promise<void> = Promise.resolve()
	let client: Client | undefined
	let failure: unknown
	let version = "unverified"
	let output: Record<string, unknown> = {}
	const activeChildRequests = new Set<string>()
	let peakChildRequests = 0
	const promptRuns = new Map<string, Promise<{ ok: boolean; error?: string }>>()
	const promptResult = (promise: Promise<unknown>) => promise.then(
		() => ({ ok: true }),
		(error: unknown) => ({ ok: false, error: error instanceof Error ? error.message : String(error) }),
	)
	let activePluginIDs: string[] = []
	let activeAgents: string[] = []

	try {
	providerApp = Bun.serve({
		hostname: "127.0.0.1",
		port: providerPort,
		async fetch(request) {
			const url = new URL(request.url)
			if (url.pathname.endsWith("/models")) return Response.json({ data: [{ id: MODEL_ID, object: "model", created: 0, owned_by: "omo-qa" }] })
			if (!url.pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 })
			const body = await request.json() as Record<string, unknown>
			const id = `omo-queue-ttl-${++requestNumber}`
			const model = typeof body.model === "string" ? body.model : ""
			const streaming = body.stream === true
			const sessionID = request.headers.get("x-omo-qa-session-id") ?? undefined
			const kind = request.headers.get("x-omo-qa-kind") ?? undefined
			const row = sessionID ? sessionRow(dbPath, sessionID) : undefined
			const names = toolNames(body)
			const parentKind = sessionID ? parentPlans.get(sessionID) : undefined
			const childKind = row?.parentID ? parentPlans.get(row.parentID) : undefined
			const role: Observation["role"] = parentKind && kind === "primary" ? "parent" : childKind && kind === "primary" ? "child" : "other"
			const observation: Observation = {
				at: Date.now(),
				...(sessionID ? { sessionID } : {}),
				...(row ? { parentID: row.parentID } : {}),
				...(kind ? { kind } : {}),
				model,
				role,
				...(childKind ? { childKind } : {}),
				toolNames: names,
				responsePlan: "unrouted local acknowledgement",
				progressChunks: 0,
				aborted: false,
			}
			observations.push(observation)
			const isParentSession = Boolean(parentKind && row && row.parentID === null && row.agent === "sisyphus")
			const isKnownChildSession = Boolean(childKind && row?.parentID && parentPlans.has(row.parentID) && row.agent === "explore")
			const validOrigin = Boolean(
				sessionID && kind && REQUEST_KINDS.has(kind) && row &&
				row.directory === canonicalProject && rowModel(row) === MODEL && model === MODEL_ID &&
				(isParentSession || isKnownChildSession),
			)
			if (!validOrigin) {
				localOriginFailures.push({ sessionID, kind, row, model })
				observation.responsePlan = "refused: request not tied to exact isolated session and local model"
				return new Response("QA refused a provider request outside its local session/model fixture.", { status: 500 })
			}
			if (role === "parent" && sessionID && parentKind) {
				const count = parentRequestCount.get(sessionID) ?? 0
				parentRequestCount.set(sessionID, count + 1)
				if (count > 0) {
					observation.responsePlan = "parent follow-up acknowledged"
					return textResponse("The background QA call has been recorded.", id, model, streaming)
				}
				const tool = names.includes("subagent") ? "subagent" : undefined
				if (!tool) {
					observation.responsePlan = "refused: native subagent tool not available"
					return textResponse("QA expected the native subagent tool.", id, model, streaming)
				}
				observation.responsePlan = `launch ${parentKind} via native subagent`
				return toolCallResponse(tool, {
					agent: "explore",
					description: `Queue TTL QA ${parentKind}`,
					prompt: `${CHILD_MARKERS[parentKind]}: return a short completion after the QA hold ends.`,
					model: MODEL,
					background: true,
				}, id, model, streaming)
			}
			if (role === "child" && row && sessionID && childKind) {
				activeChildRequests.add(sessionID)
				peakChildRequests = Math.max(peakChildRequests, activeChildRequests.size)
				const finish = () => activeChildRequests.delete(sessionID)
				if (childKind === "noProgress") {
					observation.responsePlan = "SSE comments only; expected inactivity interrupt"
					const response = noProgressResponse(request, observation, id, model, finish)
					request.signal.addEventListener("abort", finish, { once: true })
					return response
				}
				if (childKind === "active") {
					const release = row.parentID ? heldRelease.get(row.parentID) : undefined
					if (!release) {
						finish()
						return new Response("QA active hold gate missing", { status: 500 })
					}
					observation.responsePlan = "five-second model deltas until explicit test release or native interrupt"
					const response = heldProgressResponse(request, observation, id, model, release.promise, finish)
					release.promise.then(finish)
					request.signal.addEventListener("abort", finish, { once: true })
					return response
				}
				observation.responsePlan = "short local child completion"
				finish()
				return textResponse("OMO_QUEUE_TTL_CHILD_COMPLETED", id, model, streaming)
			}
			observation.responsePlan = `auxiliary ${kind ?? "unknown"} request acknowledged`
			return textResponse("OMO_QUEUE_TTL_QA_AUXILIARY_ACK", id, model, streaming)
		},
	})
	providerStarted = true
		const versionResult = Bun.spawnSync([CLI, "--version"], { stdout: "pipe", stderr: "pipe", env })
		if (versionResult.exitCode !== 0) throw new Error(`OpenCode --version failed with exit ${versionResult.exitCode}: ${new TextDecoder().decode(versionResult.stderr).trim()}`)
		version = new TextDecoder().decode(versionResult.stdout).trim()
		if (!version.includes(EXPECTED_VERSION)) throw new Error(`Expected OpenCode ${EXPECTED_VERSION}, got ${version}`)
		const [bundleInfo] = await Promise.all([readFile(serverPath)])
		if (sha256(bundleInfo) !== serverHash) throw new Error("Frozen bundle changed after preflight.")
		serverProcess = Bun.spawn([CLI, "--print-logs", "--log-level", "debug", "serve", "--hostname", "127.0.0.1", "--port", String(openCodePort)], {
			cwd: canonicalProject,
			env,
			stdout: "pipe",
			stderr: "pipe",
		})
		stdoutTask = new Response(serverProcess.stdout as ReadableStream<Uint8Array>).text().then((value) => { stdout += value })
		stderrTask = new Response(serverProcess.stderr as ReadableStream<Uint8Array>).text().then((value) => { stderr += value })
		const baseUrl = `http://127.0.0.1:${openCodePort}`
		client = OpenCode.make({ baseUrl, headers: { Authorization: basicAuth(), "x-opencode-directory": canonicalProject } })
		const startupDeadline = Date.now() + 30_000
		let serverReady = false
		while (Date.now() < startupDeadline) {
			if (serverProcess.exitCode !== null) throw new Error(`OpenCode exited before ready (${serverProcess.exitCode}).`)
			try { await client.server.info(); serverReady = true; break } catch { await new Promise((resolve) => setTimeout(resolve, 150)) }
		}
		if (!serverReady) throw new Error("OpenCode server never reported ready.")
		const activeRegistry = await waitForActivePlugin(client, serverProcess)
		activePluginIDs = activeRegistry.pluginIDs
		activeAgents = activeRegistry.agents
		const [modelsResponse, defaultResponse, providerResponse, mcpResponse] = await Promise.all([
			client.model.list(), client.model.default(), client.provider.list(), client.mcp.list(),
		])
		const models = dataOf(modelsResponse)
		const defaultModel = dataOf(defaultResponse)
		const providers = dataOf(providerResponse)
		const mcps = dataOf(mcpResponse)
		const modelRefs = Array.isArray(models) ? models.map(selectedModel).filter((model): model is string => typeof model === "string").sort() : []
		const providerIDs = Array.isArray(providers) ? providers.flatMap((provider) => isRecord(provider) && typeof provider.id === "string" ? [provider.id] : []).sort() : []
		assert(checks, "native model catalog is exactly the local QA model", JSON.stringify(modelRefs) === JSON.stringify([MODEL]), modelRefs)
		assert(checks, "native default model is the local QA model", selectedModel(defaultModel) === MODEL, selectedModel(defaultModel))
		assert(checks, "native provider registry contains only the local QA provider", JSON.stringify(providerIDs) === JSON.stringify([PROVIDER]), providerIDs)
		assert(checks, "MCP registry is empty", Array.isArray(mcps) && mcps.length === 0, mcps)

		const createParent = async (kind: ChildKind) => {
			const session = await client!.session.create({ title: `Queue TTL QA ${kind}`, location: { directory: canonicalProject } })
			await client!.session.switchAgent({ sessionID: session.id, agent: "sisyphus" })
			await client!.session.switchModel({ sessionID: session.id, model: { providerID: PROVIDER, id: MODEL_ID } })
			const info = await client!.session.get({ sessionID: session.id })
			assert(checks, `parent ${kind} uses isolated project and pinned model`, info.projectID !== "" && resolve(info.location.directory) === canonicalProject && selectedModel(info.model) === MODEL, { id: info.id, projectID: info.projectID, directory: info.location.directory, model: selectedModel(info.model) })
			parentPlans.set(session.id, kind)
			if (kind === "active") heldRelease.set(session.id, (() => {
				let resolveGate!: () => void
				const promise = new Promise<void>((done) => { resolveGate = done })
				return { promise, resolve: resolveGate }
			})())
			return session.id
		}
		const startPrompt = (sessionID: string) => {
			const promise = promptResult(client!.session.prompt({ sessionID, text: `Run one background subagent for ${CHILD_MARKERS[parentPlans.get(sessionID)!]}.` }))
			promptRuns.set(sessionID, promise)
			return promise
		}
		const childrenFor = (parentID: string) => sessionRows(dbPath, canonicalProject).filter((row) => row.parentID === parentID)
		const leaseFor = (parentID: string) => leaseRows(dbPath).find((lease) => lease.parentSessionID === parentID)
		const waitLease = async (parentID: string, status: string, timeout = 30_000) => {
			let found: Lease | undefined
			await waitFor(`lease ${parentID} to become ${status}`, () => {
				found = leaseFor(parentID)
				return found?.status === status
			}, timeout)
			return found!
		}
		const waitChild = async (parentID: string, timeout = 30_000) => {
			let child: SessionRow | undefined
			await waitFor(`native child under ${parentID}`, () => {
				child = childrenFor(parentID)[0]
				return Boolean(child)
			}, timeout)
			return child!
		}
		const activeOriginCheck = async (sessionID: string) => {
			const info = await client!.session.get({ sessionID })
			const passed = info.id === sessionID && info.projectID !== "" && resolve(info.location.directory) === canonicalProject && selectedModel(info.model) === MODEL
			return { passed, detail: { id: info.id, parentID: info.parentID, directory: info.location.directory, model: selectedModel(info.model), outcome: info.outcome } }
		}
		const settleParent = async (sessionID: string, label: string) => {
			await withTimeout(`${label} native session execution`, client!.session.wait({ sessionID }), 30_000)
			const prompt = await withTimeout(`${label} prompt request`, promptRuns.get(sessionID)!, 30_000)
			const session = await client!.session.get({ sessionID })
			const passed = prompt.ok && session.outcome === "succeeded"
			assert(checks, `${label} parent session settles successfully`, passed, { prompt, sessionID, outcome: session.outcome })
			return { prompt, outcome: session.outcome }
		}

		// Verify the no-progress watchdog with a comment-only stream, which keeps
		// the local HTTP connection alive without producing model output.
		const noProgressParent = await createParent("noProgress")
		void startPrompt(noProgressParent)
		const noProgressChild = await waitChild(noProgressParent)
		assert(checks, "no-progress child is a direct child in the isolated directory", noProgressChild.directory === canonicalProject && noProgressChild.parentID === noProgressParent && rowModel(noProgressChild) === MODEL, noProgressChild)
		await waitLease(noProgressParent, "running")
		await waitFor("no-progress child request to be interrupted", () => observations.some((item) => item.sessionID === noProgressChild.id && item.childKind === "noProgress" && item.aborted), 120_000)
		await waitFor("native no-progress child outcome to become interrupted", async () => (await client!.session.get({ sessionID: noProgressChild.id })).outcome === "interrupted", 30_000)
		const noProgressActivity = activityRows(dbPath).find((state) => state.sessionID === noProgressChild.id)
		assert(checks, "60-second no-progress watchdog persisted its trigger and interrupted the native child", noProgressActivity?.trigger?.reason === "no-progress" && (await client.session.get({ sessionID: noProgressChild.id })).outcome === "interrupted", noProgressActivity)
		await waitFor("no-progress admission lease to release", () => leaseFor(noProgressParent)?.status === "terminal", 20_000)
		const noProgressParentResult = await settleParent(noProgressParent, "no-progress")

		// Keep a progressing child open while two parents queue. One waiter expires
		// at the validated 300,000 ms minimum TTL; the next live waiter is admitted
		// after the active child completes.
		const activeParent = await createParent("active")
		void startPrompt(activeParent)
		const activeChild = await waitChild(activeParent)
		await waitLease(activeParent, "running")
		const activePreflight = await activeOriginCheck(activeChild.id)
		assert(checks, "held progressing child uses the isolated project and pinned local model", activePreflight.passed, activePreflight.detail)
		const activeRequest = () => observations.find((item) => item.sessionID === activeChild.id && item.childKind === "active")
		await waitFor("active child starts streaming progress", () => Boolean(activeRequest()?.progressChunks), 30_000)
		await new Promise((resolve) => setTimeout(resolve, 65_000))
		const progressBeforeQueue = activityRows(dbPath).find((state) => state.sessionID === activeChild.id)
		const activeState = await activeOriginCheck(activeChild.id)
		assert(checks, "active child survives beyond no-progress timeout while model deltas continue", !activeRequest()?.aborted && activeState.detail.outcome !== "interrupted" && progressBeforeQueue?.progressed === true, { activity: progressBeforeQueue, session: activeState.detail, request: activeRequest() })

		const expiresParent = await createParent("expires")
		const expiryPromptStartedAt = Date.now()
		void startPrompt(expiresParent)
		const expiresLease = await waitLease(expiresParent, "queued")
		const firstQueuedAt = Date.now()
		assert(checks, "expiring waiter is persisted without creating a child", expiresLease.childSessionID === null && childrenFor(expiresParent).length === 0, expiresLease)
		await new Promise((resolve) => setTimeout(resolve, 100_000))

		const survivesParent = await createParent("survives")
		void startPrompt(survivesParent)
		const survivesLease = await waitLease(survivesParent, "queued")
		const secondQueuedAt = Date.now()
		assert(checks, "later waiter is queued behind the same still-running child", survivesLease.childSessionID === null && childrenFor(survivesParent).length === 0 && leaseFor(activeParent)?.status === "running", { survivesLease, activeLease: leaseFor(activeParent) })

		const expiryLowerBound = expiryPromptStartedAt + TASK_TTL_MS
		const expiryUpperBound = firstQueuedAt + TASK_TTL_MS + 2_000
		let expiredAt: number | undefined
	while (Date.now() < expiryUpperBound && expiredAt === undefined) {
		if (!leaseFor(expiresParent)) expiredAt = Date.now()
		else await new Promise((resolve) => setTimeout(resolve, 250))
	}
	if (expiredAt === undefined) throw new Error(`Queued lease did not expire before the ${expiryUpperBound - firstQueuedAt} ms observation bound.`)
	assert(checks, "queued lease expiry falls after the pre-launch TTL lower bound", expiredAt >= expiryLowerBound, { expiryPromptStartedAt, persistedLeaseCreatedAt: expiresLease.createdAt, firstQueuedAt, expiredAt, lowerBound: expiryLowerBound, taskTtlMs: TASK_TTL_MS })
	assert(checks, "queued lease expiry falls within the TTL upper bound from queued observation", expiredAt <= expiryUpperBound, { firstQueuedAt, expiredAt, upperBound: expiryUpperBound, taskTtlMs: TASK_TTL_MS })
		const fullObservedTTLElapsedAt = firstQueuedAt + TASK_TTL_MS
		if (Date.now() < fullObservedTTLElapsedAt) await new Promise((resolve) => setTimeout(resolve, fullObservedTTLElapsedAt - Date.now()))
	assert(checks, "queue lease is absent after at least five minutes have elapsed from its persisted queued observation", !leaseFor(expiresParent) && Date.now() - firstQueuedAt >= TASK_TTL_MS, { firstQueuedAt, checkedAt: Date.now(), elapsedFromObservedQueueMs: Date.now() - firstQueuedAt })
		const activeStillLive = await activeOriginCheck(activeChild.id)
		const activityAtExpiry = activityRows(dbPath).find((state) => state.sessionID === activeChild.id)
		assert(checks, "expiry creates no child and leaves the active child lease and request untouched", childrenFor(expiresParent).length === 0 && leaseFor(expiresParent) === undefined && leaseFor(activeParent)?.status === "running" && !activeRequest()?.aborted && activeStillLive.detail.outcome !== "interrupted", { expiringChildren: childrenFor(expiresParent), activeLease: leaseFor(activeParent), request: activeRequest(), session: activeStillLive.detail })
		assert(checks, "surviving waiter remains queued and active child has recent model progress", leaseFor(survivesParent)?.status === "queued" && childrenFor(survivesParent).length === 0 && activityAtExpiry?.progressed === true && activityAtExpiry.lastProgressAt !== null && Date.now() - activityAtExpiry.lastProgressAt < HEARTBEAT_MS * 3, { survivesLease: leaseFor(survivesParent), children: childrenFor(survivesParent), activity: activityAtExpiry, elapsedFromQueue: expiredAt - secondQueuedAt })
		await withTimeout("expired parent session to settle after queue timeout", client.session.wait({ sessionID: expiresParent }), 30_000)
		const expiresPromptResult = await withTimeout("expired parent prompt to receive queue-timeout result", promptRuns.get(expiresParent)!, 30_000)
		const expiresParentInfo = await client.session.get({ sessionID: expiresParent })
		const expiresTranscript = await client.message.list({ sessionID: expiresParent })
		const timeoutDiagnosticVisible = JSON.stringify(expiresTranscript.data).includes(`Background admission queue expired after ${TASK_TTL_MS} ms`)
		assert(checks, "expired caller receives an actionable queue-timeout diagnostic", timeoutDiagnosticVisible && expiresPromptResult.ok && expiresParentInfo.outcome === "succeeded", { prompt: expiresPromptResult, outcome: expiresParentInfo.outcome, transcript: expiresTranscript.data })

		heldRelease.get(activeParent)?.resolve()
		await waitFor("active child completes after test release", async () => (await client!.session.get({ sessionID: activeChild.id })).outcome === "succeeded", 45_000)
		await waitFor("surviving waiter is durably bound to its native child", () => {
			const lease = leaseFor(survivesParent)
			const child = childrenFor(survivesParent)[0]
			return Boolean(lease?.childSessionID && child && child.id === lease.childSessionID && (lease.status === "running" || lease.status === "terminal"))
		}, 45_000)
		const survivor = childrenFor(survivesParent)[0]!
		const survivorInfo = await client.session.get({ sessionID: survivor.id })
		assert(checks, "surviving waiter becomes the next native child after the active child releases", survivor.parentID === survivesParent && rowModel(survivor) === MODEL && survivorInfo.parentID === survivesParent && selectedModel(survivorInfo.model) === MODEL && leaseFor(survivesParent)?.childSessionID === survivor.id, { survivor, info: { parentID: survivorInfo.parentID, model: selectedModel(survivorInfo.model) }, lease: leaseFor(survivesParent) })
		await waitFor("survivor child and admission lease complete", async () => (await client!.session.get({ sessionID: survivor.id })).outcome === "succeeded" && leaseFor(survivesParent)?.status === "terminal", 45_000)
		const activeParentResult = await settleParent(activeParent, "active-child")
		const survivingParentResult = await settleParent(survivesParent, "surviving-waiter")
		assert(checks, "native child request concurrency never exceeds one", peakChildRequests === 1, { peakChildRequests })
		assert(checks, "all provider requests are origin-tagged and used the single local model", observations.length > 0 && observations.every((item) => item.sessionID && item.kind && item.model === MODEL_ID && sessionRow(dbPath, item.sessionID)?.directory === canonicalProject && rowModel(sessionRow(dbPath, item.sessionID)) === MODEL) && localOriginFailures.length === 0, { observations, localOriginFailures })

		output = {
			result: "passed",
			version,
			runtimeCLI: CLI,
			bundle: { serverPath, serverSha256: serverHash, expectedServerSha256: EXPECTED_SERVER_SHA256 },
			projectDirectory: canonicalProject,
			configuration: { model: MODEL, taskTtlMs: TASK_TTL_MS, defaultConcurrency: 1, messageStalenessTimeoutMs: 60_000, staleTimeoutMs: 60_000, enabledProviders: [PROVIDER], disabledMCPs: ["websearch", "context7", "grep_app", "lsp"], claudeCapabilitiesDisabled: true },
			parents: { noProgressParent, activeParent, expiresParent, survivesParent },
			parentResults: { noProgressParentResult, expiresPromptResult, expiresOutcome: expiresParentInfo.outcome, activeParentResult, survivingParentResult },
			children: { noProgressChild, activeChild, survivingChild: survivor },
			queueTiming: { firstQueuedAt, secondQueuedAt, expiredAt, elapsedMs: expiredAt - firstQueuedAt, taskTtlMs: TASK_TTL_MS },
			activeChild: { activityBeforeQueue: progressBeforeQueue, activityAtExpiry, request: activeRequest(), outcome: (await client.session.get({ sessionID: activeChild.id })).outcome },
			noProgress: { activity: noProgressActivity, lease: leaseFor(noProgressParent), outcome: (await client.session.get({ sessionID: noProgressChild.id })).outcome },
			leases: leaseRows(dbPath),
			providerRequests: observations,
			peakChildRequests,
			checks: Object.fromEntries(checks.map((check) => [check.name, check.passed])),
			checkDetails: checks,
				isolation: { databasePath: dbPath, readonlyDBInspection: true, realUserDataOpened: false, temporaryRoot: tempRoot, cleanupRetainsFixture: true, allowedChildEnvironmentKeys: Object.keys(env), onlyLocalProviderAllowed: true },
			preflight: { activePluginIDs, activeAgents, modelCatalog: modelRefs, defaultModel: selectedModel(defaultModel), providers: providerIDs, mcpServers: mcps },
		}
	} catch (error) {
		failure = error
		output = { ...output, failure: error instanceof Error ? { name: error.name, message: redact(error.message), stack: redact(error.stack ?? "") } : redact(String(error)), checks: Object.fromEntries(checks.map((check) => [check.name, check.passed])), checkDetails: checks, providerRequests: observations, localOriginFailures }
	} finally {
		for (const gate of heldRelease.values()) gate.resolve()
		const serverStopped = await stopProcess(serverProcess)
		await Promise.all([stdoutTask, stderrTask])
		try {
			if (providerApp) providerApp.stop(true)
			providerStopped = true
		} catch (error) {
			providerStopError = redact(error instanceof Error ? error.message : String(error))
		}
		let finalSessions: SessionRow[] = []
		let finalLeases: Lease[] = []
		let finalActivities: ActivityState[] = []
		try {
			finalSessions = sessionRows(dbPath, canonicalProject)
			finalLeases = leaseRows(dbPath)
			finalActivities = activityRows(dbPath)
		} catch { /* Raw SQLite evidence remains retained for inspection. */ }
		const sourceFiles = [
			"script/opencode2-queue-ttl-qa.ts",
			"packages/omo-opencode/src/v2/background-admission.ts",
			"packages/omo-opencode/src/v2/background-activity.ts",
			"packages/omo-opencode/src/v2/delegation-admission.ts",
			"packages/omo-opencode/src/v2/delegation.ts",
		]
		const sourceHashes = Object.fromEntries(await Promise.all(sourceFiles.map(async (file) => [file, sha256(await readFile(join(ROOT, file)))])))
		const final = {
			...output,
			version,
			bundle: { serverPath, serverSha256: serverHash, expectedServerSha256: EXPECTED_SERVER_SHA256 },
			evidenceDirectory: evidence,
			temporaryRoot: tempRoot,
			canonicalProject,
			sourceHashes,
			observedFinalState: { sessions: finalSessions, leases: finalLeases, activityStates: finalActivities },
			serverLog: redact(`${stdout}\n${stderr}`),
			cleanup: { opencodeProcessStopped: serverStopped, mockProviderStarted: providerStarted, mockProviderStopped: providerStopped, ...(providerStopError ? { providerStopError } : {}), isolatedProjectRemoved: false, databasePath: dbPath, fixturePreserved: true },
			localOriginFailures,
		}
		await writeFile(join(evidence, "runtime.json"), `${JSON.stringify(final, null, 2)}\n`, "utf8")
		await writeFile(join(evidence, "provider-requests.json"), `${JSON.stringify(observations, null, 2)}\n`, "utf8")
		await writeFile(join(evidence, "server.log"), `${redact(`${stdout}\n${stderr}`)}\n`, "utf8")
		await writeFile(join(evidence, "QA-SUMMARY.md"), [
			"# Native OpenCode background queue/watchdog QA",
			"",
			`- Result: ${failure ? "FAILED" : "passed"}`,
			`- Checks: ${checks.filter((check) => check.passed).length}/${checks.length}`,
			`- OpenCode: ${version}`,
			`- Server bundle SHA-256: ${serverHash}`,
			`- Evidence: ${evidence}`,
			`- Isolated project and database retained at: ${tempRoot}`,
			"- Provider traffic is limited to the one localhost OpenAI-compatible endpoint and is tagged by the native HTTP hook with session ID and request kind.",
			`- The active-child queue scenario waits at least ${TASK_TTL_MS} ms from observing the first persisted queued lease before asserting expiry.`,
		].join("\n") + "\n", "utf8")
		const manifest = await Promise.all(["runtime.json", "provider-requests.json", "server.log", "QA-SUMMARY.md"].map(async (name) => `${sha256(await readFile(join(evidence, name)))}  ${name}`))
		await writeFile(join(evidence, "SHA256SUMS"), `${manifest.join("\n")}\n`, "utf8")
	}
	if (failure) throw new Error(`Queue/watchdog QA failed; preserved evidence at ${evidence}: ${failure instanceof Error ? failure.message : String(failure)}`)
	console.log(`Native OpenCode queue/watchdog QA passed; evidence: ${evidence}`)
}

await main()
