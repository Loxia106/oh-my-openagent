/**
 * Isolated OpenCode 2.0.18 QA for delegated fallback selection and child-only settings.
 *
 * Run only against an explicitly reviewed bundle:
 * OPENCODE2_CLI=/absolute/path/to/opencode \
 * OPENCODE2_EXPECTED_SERVER_SHA256=<sha256> \
 * bun script/opencode2-delegation-fallback-qa.ts
 *
 * This driver is prepared for review; do not run it until the bundle is frozen
 * and the main session authorizes that specific hash.
 */
import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { Database } from "bun:sqlite"
import { OpenCode } from "@opencode/client"
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, join, resolve, sep } from "node:path"
import { tmpdir } from "node:os"

const ROOT = resolve(import.meta.dir, "..")
const EVIDENCE_ROOT = join(ROOT, ".omo", "evidence", "20260927-opencode2-delegation-fallback")
const PLUGIN_DIR = resolve(process.env.OPENCODE2_PLUGIN_DIR ?? join(ROOT, "dist", "opencode2"))
const CLI_INPUT = process.env.OPENCODE2_CLI?.trim() ?? ""
const OPENCODE_BIN = CLI_INPUT ? resolve(CLI_INPUT) : ""
const EXPECTED_SERVER_SHA256 = process.env.OPENCODE2_EXPECTED_SERVER_SHA256 ?? ""
const PASSWORD = "delegation-fallback-local-qa-password"
const API_KEY = "delegation-fallback-local-only-key"
const PROVIDER = "omoqa"
const PARENT_MODEL_ID = "qa-parent"
const SECONDARY_MODEL_ID = "qa-secondary"
const TERTIARY_MODEL_ID = "qa-tertiary"
const PARENT_MODEL = `${PROVIDER}/${PARENT_MODEL_ID}`
const SECONDARY_MODEL = `${PROVIDER}/${SECONDARY_MODEL_ID}`
const TERTIARY_MODEL = `${PROVIDER}/${TERTIARY_MODEL_ID}`
const TIMEOUT_MS = 60_000

const PARENT_SIBLINGS = "OMO_FALLBACK_PARENT_SIBLINGS"
const PARENT_CATEGORY = "OMO_FALLBACK_PARENT_CATEGORY"
const PARENT_BAD_CATEGORY = "OMO_FALLBACK_PARENT_BAD_CATEGORY"
const PARENT_BAD_MODEL = "OMO_FALLBACK_PARENT_BAD_MODEL"
const PARENT_BAD_VARIANT = "OMO_FALLBACK_PARENT_BAD_VARIANT"
const PARENT_RESUME = "OMO_FALLBACK_PARENT_RESUME"
const CHILD_EXPLORE = "OMO_FALLBACK_CHILD_EXPLORE"
const CHILD_LIBRARIAN = "OMO_FALLBACK_CHILD_LIBRARIAN"
const CHILD_CATEGORY = "OMO_FALLBACK_CHILD_CATEGORY"
const CHILD_RESUME = "OMO_FALLBACK_CHILD_RESUME"
const PARENT_POST_REORDER = "OMO_FALLBACK_PARENT_POST_REORDER"
const CHILD_POST_REORDER = "OMO_FALLBACK_CHILD_POST_REORDER"
const REQUEST_KINDS = new Set(["primary", "compaction", "title", "generate"])
const PARENT_MARKERS = new Set([
	PARENT_SIBLINGS,
	PARENT_CATEGORY,
	PARENT_BAD_CATEGORY,
	PARENT_BAD_MODEL,
	PARENT_BAD_VARIANT,
	PARENT_RESUME,
	PARENT_POST_REORDER,
])

type SessionRow = {
	id: string
	parentID: string | null
	directory: string
	agent: string | null
	model: string | null
}

type WireOptions = {
	temperature?: unknown
	top_p?: unknown
	max_tokens?: unknown
	max_completion_tokens?: unknown
	max_output_tokens?: unknown
	reasoning_effort?: unknown
	parallel_tool_calls?: unknown
}

type Observation = {
	index: number
	sessionID?: string
	kind?: string
	role: "root" | "child" | "unknown"
	parentID?: string | null
	agent?: string | null
	selectedModel?: string
	requestModel: string
	marker?: string
	toolNames: string[]
	wire: WireOptions
	responsePlan: string
}

type Check = { name: string; passed: boolean; detail?: unknown }
type Client = ReturnType<typeof OpenCode.make>
type ServerRun = { process: Bun.Subprocess; client: Client; port: number }

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message)
}

function redact(value: string): string {
	return value.replaceAll(PASSWORD, "[redacted-test-password]").replaceAll(API_KEY, "[redacted-test-api-key]")
}

function basicAuth(): string {
	return `Basic ${Buffer.from(`opencode:${PASSWORD}`).toString("base64")}`
}

function textContent(value: unknown): string {
	if (typeof value === "string") return value
	if (!Array.isArray(value)) return ""
	return value.flatMap((part) => {
		if (!part || typeof part !== "object") return []
		const item = part as Record<string, unknown>
		return item.type === "text" && typeof item.text === "string" ? [item.text] : []
	}).join("\n")
}

function allMessages(body: Record<string, unknown>): Array<Record<string, unknown>> {
	return Array.isArray(body.messages)
		? body.messages.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
		: []
}

function latestUser(body: Record<string, unknown>): string {
	const messages = allMessages(body)
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index]
		if (message?.role === "user") return textContent(message.content)
	}
	return ""
}

function toolResultCountInLatestTurn(body: Record<string, unknown>): number {
	const messages = allMessages(body)
	let latestUserIndex = -1
	for (let index = 0; index < messages.length; index += 1) {
		if (messages[index]?.role === "user") latestUserIndex = index
	}
	return messages.slice(latestUserIndex + 1).filter((message) => message.role === "tool").length
}

function findToolState(messages: unknown, name: string): Record<string, unknown> | undefined {
	if (!messages || typeof messages !== "object" || !Array.isArray((messages as { data?: unknown }).data)) return undefined
	for (const message of (messages as { data: unknown[] }).data) {
		if (!message || typeof message !== "object" || !Array.isArray((message as { content?: unknown }).content)) continue
		for (const part of (message as { content: unknown[] }).content) {
			if (!part || typeof part !== "object") continue
			const item = part as Record<string, unknown>
			if (item.type !== "tool" || String(item.name).toLowerCase() !== name.toLowerCase()) continue
			const state = item.state
			return state && typeof state === "object" ? state as Record<string, unknown> : undefined
		}
	}
	return undefined
}

function tokenSetting(wire: WireOptions | undefined): unknown {
	return wire?.max_tokens ?? wire?.max_completion_tokens ?? wire?.max_output_tokens
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

function response(model: string, id: string, text: string, streaming: boolean): Response {
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
		headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive" },
	})
}

function toolCall(model: string, id: string, name: string, args: unknown, streaming: boolean): Response {
	const created = Math.floor(Date.now() / 1000)
	const call = { index: 0, id: `call-${id}`, type: "function", function: { name, arguments: JSON.stringify(args) } }
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

function modelRef(value: unknown): string | undefined {
	if (!value || typeof value !== "object") return undefined
	const item = value as { providerID?: unknown; id?: unknown }
	return typeof item.providerID === "string" && typeof item.id === "string" ? `${item.providerID}/${item.id}` : undefined
}

function sessionRows(databasePath: string, directory: string): SessionRow[] {
	if (!existsSync(databasePath)) return []
	const db = new Database(databasePath, { readonly: true, create: false })
	try {
		return db.query("SELECT id, parent_id AS parentID, directory, agent, model FROM session_v2 WHERE directory = ? ORDER BY time_created ASC")
			.all(directory) as SessionRow[]
	} finally { db.close() }
}

function sessionRow(databasePath: string, sessionID: string): SessionRow | undefined {
	if (!existsSync(databasePath)) return undefined
	const db = new Database(databasePath, { readonly: true, create: false })
	try {
		return db.query("SELECT id, parent_id AS parentID, directory, agent, model FROM session_v2 WHERE id = ?")
			.get(sessionID) as SessionRow | undefined
	} finally { db.close() }
}

function persistedDelegationSettings(databasePath: string, sessionID: string): Record<string, unknown> | undefined {
	if (!existsSync(databasePath)) return undefined
	const db = new Database(databasePath, { readonly: true, create: false })
	try {
		const rows = db.query("SELECT value FROM kv WHERE key LIKE '%:oh-my-openagent:v2:delegation-settings:%'").all() as Array<{ value: string }>
		for (const row of rows) {
			try {
				const value = JSON.parse(row.value) as Record<string, unknown>
				if (value.sessionID === sessionID) return value
			} catch {
				// Ignore unrelated or malformed plugin records in this isolated fixture.
			}
		}
		return undefined
	} finally { db.close() }
}

function rowModel(row: SessionRow | undefined): string | undefined {
	if (!row?.model) return undefined
	try { return modelRef(JSON.parse(row.model)) }
	catch { return undefined }
}

function reservePort(): number {
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("reserved") })
	const port = server.port
	server.stop(true)
	assert(typeof port === "number", "Could not reserve a localhost port")
	return port
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

async function waitServer(client: Client, process: Bun.Subprocess): Promise<void> {
	const deadline = Date.now() + 20_000
	let last: unknown
	while (Date.now() < deadline) {
		if (process.exitCode !== null) throw new Error(`OpenCode exited before ready (${process.exitCode})`)
		try { await client.server.info(); return }
		catch (error) { last = error; await new Promise((resolve) => setTimeout(resolve, 150)) }
	}
	throw new Error(`OpenCode server did not become ready: ${String(last)}`)
}

async function stopHost(process: Bun.Subprocess | undefined): Promise<boolean> {
	if (!process || process.exitCode !== null) return true
	process.kill("SIGTERM")
	const clean = await Promise.race([
		process.exited.then(() => true),
		new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5_000)),
	])
	if (clean) return true
	if (process.exitCode === null) process.kill("SIGKILL")
	await process.exited
	return false
}

function omoConfig(reorderExploreFallbacks: boolean): Record<string, unknown> {
	const exploreFallbacks = [
		{ model: SECONDARY_MODEL, reasoning: "high", temperature: 0.31, top_p: 0.42, maxTokens: 2468, provider_options: { parallelToolCalls: false } },
		{ model: TERTIARY_MODEL, temperature: 0.29, top_p: 0.39, maxTokens: 1357 },
	]
	if (reorderExploreFallbacks) exploreFallbacks.reverse()
	return {
		telemetry: { enabled: false },
		"[opencode]": {
			telemetry: false,
			auto_update: false,
			runtime_fallback: { enabled: false },
			disabled_providers: ["blocked"],
			disabled_mcps: ["websearch", "context7", "grep_app", "lsp"],
			claude_code: { mcp: false, agents: false, skills: false, commands: false, plugins: false, hooks: false },
			agents: {
				sisyphus: { model: PARENT_MODEL },
				explore: { model: `${PROVIDER}/missing-primary`, reasoningEffort: "low", fallback_models: exploreFallbacks },
				librarian: { fallback_models: [{ model: TERTIARY_MODEL, temperature: 0.72, top_p: 0.82, maxTokens: 2864, provider_options: { reasoningEffort: "medium" } }] },
			},
			categories: {
				"deep-low": {
					model: "blocked/private",
					max_tokens: 100,
					reasoningEffort: "low",
					fallback_models: [{ model: SECONDARY_MODEL, reasoning: "high", temperature: 0.63, top_p: 0.76, maxTokens: 3579 }],
				},
				unavailable: { models: [`${PROVIDER}/missing-category-model`] },
			},
		},
	}
}

async function main(): Promise<void> {
	assert(OPENCODE_BIN && existsSync(OPENCODE_BIN) && isAbsolute(CLI_INPUT), "OPENCODE2_CLI must be an existing absolute path to OpenCode 2.0.18")
	assert(/^[a-f0-9]{64}$/i.test(EXPECTED_SERVER_SHA256), "OPENCODE2_EXPECTED_SERVER_SHA256 must name the reviewed bundle hash")
	assert(existsSync(join(PLUGIN_DIR, "server.js")), `Missing native plugin bundle ${join(PLUGIN_DIR, "server.js")}`)
	const serverHash = createHash("sha256").update(await readFile(join(PLUGIN_DIR, "server.js"))).digest("hex")
	assert(serverHash === EXPECTED_SERVER_SHA256.toLowerCase(), `Bundle hash ${serverHash} does not match the reviewed hash`)
	const versionProcess = Bun.spawnSync([OPENCODE_BIN, "--version"], { stdout: "pipe", stderr: "pipe" })
	const version = new TextDecoder().decode(versionProcess.stdout).trim()
	assert(versionProcess.exitCode === 0 && version.includes("2.0.18"), `Expected OpenCode 2.0.18, got ${version}`)

	const runName = `run-${new Date().toISOString().replaceAll(":", "-")}`
	const runDirectory = join(EVIDENCE_ROOT, runName)
	await mkdir(runDirectory, { recursive: true })
	const evidenceRoot = await realpath(EVIDENCE_ROOT)
	const evidenceDirectory = await realpath(runDirectory)
	assert(dirname(evidenceDirectory) === evidenceRoot, "Evidence must be one direct child beneath .omo/evidence")
	const tempRoot = await realpath(await mkdtemp(join(tmpdir(), "omo-delegation-fallback-qa-")))
	const project = join(tempRoot, "project")
	const home = join(tempRoot, "home")
	const xdgData = join(tempRoot, "xdg-data")
	const xdgConfig = join(tempRoot, "xdg-config")
	const xdgState = join(tempRoot, "xdg-state")
	const xdgCache = join(tempRoot, "xdg-cache")
	const omoHome = join(tempRoot, "omo-home")
	const claudeHome = join(tempRoot, "claude-config")
	const claudePlugins = join(tempRoot, "claude-plugins")
	const databasePath = join(tempRoot, "opencode.sqlite")
	const originPluginDir = join(tempRoot, "origin-probe")
	await Promise.all([project, home, xdgData, xdgConfig, xdgState, xdgCache, omoHome, claudeHome, claudePlugins, originPluginDir].map((path) => mkdir(path, { recursive: true })))
	const canonicalProject = await realpath(project)

	const observations: Observation[] = []
	const routeFailures: string[] = []
	const originFailures: Array<Record<string, unknown>> = []
	const checks: Check[] = []
	const processRuns: Bun.Subprocess[] = []
	const outputTasks: Promise<void>[] = []
	const output: { stdout: string[]; stderr: string[] } = { stdout: [], stderr: [] }
	let mockStopped = false
	let failure: string | undefined
	let mockCallID = 0
	const parentSessionIDs: Record<string, string> = {}
	const parentOutcomes: Array<{ sessionID: string; outcome?: string }> = []
	let exploreChildID: string | undefined

	const mock = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const url = new URL(request.url)
			if (url.pathname.endsWith("/models")) {
				return Response.json({ data: [PARENT_MODEL_ID, SECONDARY_MODEL_ID, TERTIARY_MODEL_ID].map((id) => ({ id, object: "model", created: 0, owned_by: "local-qa" })) })
			}
			if (!url.pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 })
			const body = await request.json() as Record<string, unknown>
			const id = `delegation-${++mockCallID}`
			const requestModel = typeof body.model === "string" ? body.model : ""
			const streaming = body.stream === true
			const sessionID = request.headers.get("x-omo-qa-session-id") ?? undefined
			const kind = request.headers.get("x-omo-qa-kind") ?? undefined
			const row = sessionID ? sessionRow(databasePath, sessionID) : undefined
			const role: Observation["role"] = !row ? "unknown" : row.parentID ? "child" : "root"
			const selectedModel = rowModel(row)
			const fullMessages = allMessages(body)
			const latestMarker = latestUser(body).match(/OMO_FALLBACK_[A-Z_]+/)?.[0]
			const names = toolNames(body)
			const wire: WireOptions = {
				temperature: body.temperature,
				top_p: body.top_p,
				max_tokens: body.max_tokens,
				max_completion_tokens: body.max_completion_tokens,
				max_output_tokens: body.max_output_tokens,
				reasoning_effort: body.reasoning_effort,
				parallel_tool_calls: body.parallel_tool_calls,
			}
			const observation: Observation = {
				index: mockCallID,
				...(sessionID ? { sessionID } : {}),
				...(kind ? { kind } : {}),
				role,
				...(row ? { parentID: row.parentID, agent: row.agent } : {}),
				...(selectedModel ? { selectedModel } : {}),
				requestModel,
				...(latestMarker ? { marker: latestMarker } : {}),
				toolNames: names,
				wire,
				responsePlan: "unrouted",
			}
			observations.push(observation)
			const knownParents = new Set(Object.values(parentSessionIDs))
			const validModelID = [PARENT_MODEL_ID, SECONDARY_MODEL_ID, TERTIARY_MODEL_ID].includes(requestModel)
			const knownSessionRole = role === "root"
				? Boolean(sessionID && knownParents.has(sessionID) && row?.parentID === null)
				: role === "child"
					? Boolean(row?.parentID && knownParents.has(row.parentID) && ["explore", "librarian", "deep", "sisyphus-junior"].includes(row.agent ?? ""))
					: false
			const validOrigin = Boolean(sessionID && kind && REQUEST_KINDS.has(kind) && row && row.directory === canonicalProject && knownSessionRole && selectedModel?.startsWith(`${PROVIDER}/`) && selectedModel.slice(PROVIDER.length + 1) === requestModel)
			if (!validModelID || !validOrigin) {
				const detail = { index: mockCallID, sessionID, kind, role, row, selectedModel, requestModel }
				originFailures.push(detail)
				observation.responsePlan = "refused: request escaped exact project/session/model origin or used non-catalog model"
				return new Response("QA refused a request outside its local catalog and isolated project.", { status: 500 })
			}

			if (kind !== "primary") {
				observation.responsePlan = "local non-primary auxiliary completion"
				return response(requestModel, id, "LOCAL_QA_AUXILIARY", streaming)
			}
			if (role === "child") {
				observation.responsePlan = "complete owned child primary request"
				return response(requestModel, id, "LOCAL_QA_CHILD_COMPLETED", streaming)
			}

			const marker = latestMarker
			if (!marker || !PARENT_MARKERS.has(marker)) {
				routeFailures.push(`unrecognized primary parent marker: ${String(marker)}`)
				observation.responsePlan = "refused: unexpected primary root request"
				return new Response("QA refused an unrecognized primary root request.", { status: 500 })
			}
			const results = toolResultCountInLatestTurn(body)
			let route: { name: string; args: Record<string, unknown> } | undefined
			if (marker === PARENT_SIBLINGS && results === 0) {
				route = { name: "subagent", args: { agent: "explore", description: "QA missing-primary fallback", prompt: CHILD_EXPLORE, background: false } }
			} else if (marker === PARENT_SIBLINGS && results === 1) {
				route = { name: "subagent", args: { agent: "librarian", description: "QA fallback-only sibling", prompt: CHILD_LIBRARIAN, background: false } }
			} else if (marker === PARENT_CATEGORY && results === 0) {
				route = { name: "task", args: { category: "deep-low", prompt: CHILD_CATEGORY, load_skills: [], run_in_background: false, description: "QA disabled-provider rich fallback promotion" } }
			} else if (marker === PARENT_BAD_CATEGORY && results === 0) {
				route = { name: "task", args: { category: "unavailable", prompt: "QA_INVALID_CATEGORY_CHILD_MUST_NOT_EXIST", load_skills: [], run_in_background: false } }
			} else if (marker === PARENT_BAD_MODEL && results === 0) {
				route = { name: "subagent", args: { agent: "librarian", description: "QA invalid explicit model", prompt: "QA_INVALID_MODEL_CHILD_MUST_NOT_EXIST", model: `${PROVIDER}/not-in-catalog`, background: false } }
			} else if (marker === PARENT_BAD_VARIANT && results === 0) {
				route = { name: "subagent", args: { agent: "librarian", description: "QA invalid explicit variant", prompt: "QA_INVALID_VARIANT_CHILD_MUST_NOT_EXIST", model: `${SECONDARY_MODEL}#not-a-real-variant`, background: false } }
			} else if (marker === PARENT_RESUME && results === 0) {
				if (!exploreChildID) {
					routeFailures.push("resume prompt arrived without the previously observed explore child ID")
					observation.responsePlan = "failed: missing persisted child ID for resume"
					return new Response("QA fixture could not identify the persisted child to resume.", { status: 500 })
				}
				route = { name: "task", args: { task_id: exploreChildID, prompt: CHILD_RESUME, load_skills: [], run_in_background: false, description: "QA resume after fallback chain reorder" } }
			} else if (marker === PARENT_POST_REORDER && results === 0) {
				route = { name: "subagent", args: { agent: "explore", description: "QA next fallback after reorder", prompt: CHILD_POST_REORDER, background: false } }
			}
			if (route) {
				const toolName = names.find((name) => name.toLowerCase() === route!.name.toLowerCase())
				if (!toolName) {
					routeFailures.push(`expected native tool ${route.name} was not advertised; got ${names.join(", ")}`)
					observation.responsePlan = `failed: missing advertised ${route.name}`
					return new Response(`QA expected ${route.name} in the native tool catalog.`, { status: 500 })
				}
				observation.responsePlan = `invoke ${route.name} for ${marker} result ${results}`
				return toolCall(requestModel, id, toolName, route.args, streaming)
			}
			observation.responsePlan = `complete parent turn after ${fullMessages.filter((message) => message.role === "tool").length} tool results`
			return response(requestModel, id, "LOCAL_QA_PARENT_COMPLETED", streaming)
		},
	})

	const projectConfig = {
		$schema: "https://opencode.ai/config.json",
		plugins: [PLUGIN_DIR, originPluginDir],
		enabled_providers: [PROVIDER],
		model: PARENT_MODEL,
		default_agent: "sisyphus",
		provider: {
			[PROVIDER]: {
				name: "Local delegated fallback QA mock",
				npm: "@ai-sdk/openai-compatible",
				options: { baseURL: `http://127.0.0.1:${mock.port}/v1`, apiKey: API_KEY },
				models: {
					[PARENT_MODEL_ID]: { name: "QA parent", tool_call: true, limit: { context: 200_000, output: 8_192 } },
					[SECONDARY_MODEL_ID]: {
						name: "QA secondary",
						tool_call: true,
						limit: { context: 200_000, output: 8_192 },
						// This fixture uses the legacy `provider` input shape, whose model variants are keyed records.
						variants: { high: { reasoningEffort: "high" } },
					},
					[TERTIARY_MODEL_ID]: { name: "QA tertiary", tool_call: true, limit: { context: 200_000, output: 8_192 } },
				},
			},
		},
		mcp: {},
		telemetry: false,
		permission: { subagent: "allow", task: "allow", shell: "deny", edit: "deny" },
	}

	const environment = {
		PATH: "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin",
		TMPDIR: tempRoot,
		HOME: home,
		XDG_DATA_HOME: xdgData,
		XDG_CONFIG_HOME: xdgConfig,
		XDG_STATE_HOME: xdgState,
		XDG_CACHE_HOME: xdgCache,
		OPENCODE_DB: databasePath,
		OMO_HOME: omoHome,
		CLAUDE_CONFIG_DIR: claudeHome,
		CLAUDE_PLUGINS_HOME: claudePlugins,
		OPENCODE_DISABLE_MODELS_FETCH: "1",
		OPENCODE_TELEMETRY_DISABLED: "1",
		OPENCODE_SERVER_PASSWORD: PASSWORD,
		OPENCODE_PASSWORD: PASSWORD,
	}
	const redactedProjectConfig = JSON.parse(JSON.stringify(projectConfig)) as Record<string, unknown>
	const redactedProvider = redactedProjectConfig.provider as Record<string, Record<string, unknown>>
	const redactedOptions = redactedProvider[PROVIDER]!.options as Record<string, unknown>
	redactedOptions.apiKey = "[redacted-test-api-key]"
	try {
		await writeFile(join(runDirectory, "opencode-config-redacted.json"), `${JSON.stringify(redactedProjectConfig, null, 2)}\n`)
		await writeFile(join(runDirectory, "omo-config-initial.json"), `${JSON.stringify(omoConfig(false), null, 2)}\n`)
		await writeFile(join(originPluginDir, "index.js"), `export default {
  id: "omo-native-delegation-fallback-origin-probe",
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
	} catch (error) {
		mock.stop(true)
		throw error
	}

	const passedChecks = (name: string, passed: boolean, detail?: unknown) => {
		checks.push({ name, passed, ...(detail === undefined ? {} : { detail }) })
		if (!passed) throw new Error(`Assertion failed: ${name}${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`)
	}
	const preflights: Array<Record<string, unknown>> = []
	const ensureLocal = async (client: Client, phase: string) => {
		const [modelList, defaultResult, mcps, plugins, agents] = await Promise.all([
			client.model.list(), client.model.default(), client.mcp.list(), client.plugin.list(), client.agent.list(),
		])
		const catalog = modelList.data.map((item) => `${item.providerID}/${item.id}`).sort()
		const expected = [PARENT_MODEL, SECONDARY_MODEL, TERTIARY_MODEL].sort()
		const defaultID = modelRef(defaultResult.data)
		const active = plugins.data.filter((item) => item.state.status === "active").map((item) => item.id).sort()
		const failed = plugins.data.filter((item) => item.state.status === "failed").map((item) => ({ id: item.id, state: item.state }))
		const location = agents.location.directory
		preflights.push({ phase, catalog, defaultModel: defaultID, activeMcpNames: mcps.data.map((item) => item.name), activePlugins: active, failedPlugins: failed, location })
		assert(JSON.stringify(catalog) === JSON.stringify(expected), `Unexpected live model catalog at ${phase}: ${JSON.stringify(catalog)}`)
		assert(defaultID === PARENT_MODEL, `Unexpected default model at ${phase}: ${String(defaultID)}`)
		assert(mcps.data.length === 0, `MCP registry is not empty at ${phase}: ${JSON.stringify(mcps.data.map((item) => item.name))}`)
		assert(failed.length === 0, `Plugin activation failed at ${phase}: ${JSON.stringify(failed)}`)
		assert(active.includes("oh-my-openagent") && active.includes("omo-native-delegation-fallback-origin-probe"), `Required plugin/origin probe is not active at ${phase}: ${JSON.stringify(active)}`)
		assert(location === canonicalProject, `Agent listing escaped the QA project at ${phase}: ${location}`)
		assert(agents.data.some((agent) => agent.id === "explore") && agents.data.some((agent) => agent.id === "librarian"), `Expected delegated agents are absent at ${phase}`)
		return { catalog, defaultID, mcpNames: mcps.data.map((item) => item.name), active, agents: agents.data }
	}
	const startHost = async (): Promise<ServerRun> => {
		const port = reservePort()
		const process = Bun.spawn([OPENCODE_BIN, "--print-logs", "--log-level", "debug", "serve", "--hostname", "127.0.0.1", "--port", String(port)], {
			cwd: canonicalProject, env: environment, stdout: "pipe", stderr: "pipe",
		})
		processRuns.push(process)
		outputTasks.push(new Response(process.stdout as ReadableStream<Uint8Array>).text().then((text) => { output.stdout.push(text) }))
		outputTasks.push(new Response(process.stderr as ReadableStream<Uint8Array>).text().then((text) => { output.stderr.push(text) }))
		const client = OpenCode.make({ baseUrl: `http://127.0.0.1:${port}`, headers: { Authorization: basicAuth(), "x-opencode-directory": canonicalProject } })
		await waitServer(client, process)
		const activationDeadline = Date.now() + 30_000
		let ready = false
		while (Date.now() < activationDeadline) {
			if (process.exitCode !== null) throw new Error(`OpenCode exited during plugin activation (${process.exitCode})`)
			const plugins = await client.plugin.list()
			const failed = plugins.data.filter((plugin) => plugin.state.status === "failed")
			if (failed.length) throw new Error(`Plugin setup failure: ${JSON.stringify(failed)}`)
			if (plugins.data.some((plugin) => plugin.id === "oh-my-openagent" && plugin.state.status === "active") &&
				plugins.data.some((plugin) => plugin.id === "omo-native-delegation-fallback-origin-probe" && plugin.state.status === "active")) {
				ready = true
				break
			}
			await new Promise((resolve) => setTimeout(resolve, 150))
		}
		assert(ready, "OMO and the local origin probe did not become active")
		const probe = await ensureLocal(client, `server-ready-${process.pid}`)
		return { process, client, port }
	}
	const createParent = async (client: Client, title: string): Promise<string> => {
		const session = await client.session.create({ title, location: { directory: canonicalProject } })
		assert(session.location.directory === canonicalProject, `Session ${session.id} was created at ${session.location.directory}`)
		parentSessionIDs[title] = session.id
		await client.session.switchAgent({ sessionID: session.id, agent: "sisyphus" })
		await client.session.switchModel({ sessionID: session.id, model: { providerID: PROVIDER, id: PARENT_MODEL_ID } })
		const current = await client.session.get({ sessionID: session.id })
		assert(current.location.directory === canonicalProject && modelRef(current.model) === PARENT_MODEL, `Parent session is not pinned locally: ${JSON.stringify({ location: current.location, model: current.model })}`)
		return session.id
	}
	const promptParent = async (client: Client, sessionID: string, marker: string): Promise<void> => {
		await ensureLocal(client, `before-${marker}`)
		const current = await client.session.get({ sessionID })
		assert(current.location.directory === canonicalProject && modelRef(current.model) === PARENT_MODEL, `Parent changed model/location before ${marker}`)
		await within(`parent prompt ${marker}`, (async () => {
			await client.session.prompt({ sessionID, text: marker })
			await client.session.wait({ sessionID })
		})())
		const completed = await client.session.get({ sessionID })
		parentOutcomes.push({ sessionID, outcome: completed.outcome })
		assert(completed.outcome === "succeeded", `Parent ${sessionID} did not complete after ${marker}: ${String(completed.outcome)}`)
	}
	const childrenOf = (parentID: string) => sessionRows(databasePath, canonicalProject).filter((row) => row.parentID === parentID)
	const childPrimary = (sessionID: string) => observations.find((item) => item.sessionID === sessionID && item.kind === "primary" && item.role === "child")
	const checkSettings = (request: Observation | undefined, expected: { model: string; temperature: number; topP: number; maxTokens: number; reasoningEffort?: string }) => {
		if (!request) return false
		const selectedTokenSetting = tokenSetting(request.wire)
		return request.requestModel === expected.model && request.selectedModel === `${PROVIDER}/${expected.model}` &&
			request.wire.temperature === expected.temperature && request.wire.top_p === expected.topP && selectedTokenSetting === expected.maxTokens &&
			(expected.reasoningEffort === undefined || request.wire.reasoning_effort === expected.reasoningEffort)
	}

	let initialRows: SessionRow[] = []
	let finalRows: SessionRow[] = []
	let sessionIDs: Record<string, string> = {}
	let resumeRecord: unknown
	let isolatedDatabaseProof = false
	let cleanup: Record<string, unknown> = { serverStops: [], mockStopped: false, temporaryRootPreserved: true }
	let currentServer: ServerRun | undefined
	const priorStopResults: boolean[] = []
	try {
		assert(!canonicalProject.startsWith(`${ROOT}${sep}`), "QA project must be outside the repository")
		await mkdir(join(project, ".omo"), { recursive: true })
		await writeFile(join(project, "opencode.json"), `${JSON.stringify(projectConfig, null, 2)}\n`)
		await writeFile(join(project, ".omo", "omo.jsonc"), `${JSON.stringify(omoConfig(false), null, 2)}\n`)
		currentServer = await startHost()
		const siblingParent = await createParent(currentServer.client, "delegation fallback sibling QA")
		sessionIDs.siblings = siblingParent
		await promptParent(currentServer.client, siblingParent, PARENT_SIBLINGS)
		const siblingChildren = childrenOf(siblingParent)
		const exploreChild = siblingChildren.find((row) => row.agent === "explore")
		const librarianChild = siblingChildren.find((row) => row.agent === "librarian")
		assert(siblingChildren.length === 2 && Boolean(exploreChild && librarianChild), `Expected two sibling children, got ${JSON.stringify(siblingChildren)}`)
		assert(rowModel(exploreChild) === SECONDARY_MODEL && rowModel(librarianChild) === TERTIARY_MODEL, `Fallback selection did not pin expected sibling models: ${JSON.stringify(siblingChildren)}`)
		exploreChildID = exploreChild!.id
		const exploreRequest = childPrimary(exploreChild!.id)
		const librarianRequest = childPrimary(librarianChild!.id)
		const exploreStoredSettings = persistedDelegationSettings(databasePath, exploreChild!.id)
		passedChecks("missing configured primary selects the next enabled fallback", checkSettings(exploreRequest, { model: SECONDARY_MODEL_ID, temperature: 0.31, topP: 0.42, maxTokens: 2468, reasoningEffort: "high" }), exploreRequest)
		passedChecks("unsupported parallelToolCalls remains durably selected on the child", Boolean(exploreStoredSettings && (exploreStoredSettings.settings as Record<string, unknown>)?.parallelToolCalls === false && (exploreStoredSettings.settings as Record<string, unknown>)?.maxTokens === 2468), exploreStoredSettings)
		const exploreAuxiliaryRequests = observations.filter((item) => item.sessionID === exploreChild!.id && item.kind !== "primary")
		passedChecks("child fallback generation overrides are applied to primary calls only", exploreAuxiliaryRequests.every((item) => item.wire.temperature !== 0.31 && item.wire.top_p !== 0.42 && tokenSetting(item.wire) !== 2468), exploreAuxiliaryRequests)
		passedChecks("fallback-only agent selects its first available entry", checkSettings(librarianRequest, { model: TERTIARY_MODEL_ID, temperature: 0.72, topP: 0.82, maxTokens: 2864, reasoningEffort: "medium" }), librarianRequest)
		passedChecks("provider_options reasoning reaches its supported native wire field", librarianRequest?.wire.reasoning_effort === "medium", librarianRequest)
		passedChecks("sibling request settings stay isolated", Boolean(exploreRequest && librarianRequest && exploreRequest.sessionID !== librarianRequest.sessionID && exploreRequest.wire.temperature === 0.31 && librarianRequest.wire.temperature === 0.72 && tokenSetting(exploreRequest.wire) !== tokenSetting(librarianRequest.wire)), { exploreRequest, librarianRequest })
		passedChecks("siblings share the expected parent and native sessions remain successful", siblingChildren.every((row) => row.parentID === siblingParent) && (await Promise.all(siblingChildren.map((row) => currentServer!.client.session.get({ sessionID: row.id })))).every((session) => session.outcome === "succeeded"), siblingChildren)

		const categoryParent = await createParent(currentServer.client, "delegation fallback category QA")
		sessionIDs.category = categoryParent
		await promptParent(currentServer.client, categoryParent, PARENT_CATEGORY)
		const categoryChild = childrenOf(categoryParent)
		assert(categoryChild.length === 1, `Expected one category child, got ${JSON.stringify(categoryChild)}`)
		const categoryRequest = childPrimary(categoryChild[0]!.id)
		passedChecks("disabled-provider promotion carries the selected rich category settings", rowModel(categoryChild[0]) === SECONDARY_MODEL && checkSettings(categoryRequest, { model: SECONDARY_MODEL_ID, temperature: 0.63, topP: 0.76, maxTokens: 3579, reasoningEffort: "high" }), { child: categoryChild[0], request: categoryRequest })

		const failureCases = [
			{ key: "badCategory", marker: PARENT_BAD_CATEGORY, toolName: "task" },
			{ key: "badModel", marker: PARENT_BAD_MODEL, toolName: "subagent" },
			{ key: "badVariant", marker: PARENT_BAD_VARIANT, toolName: "subagent" },
		]
		for (const item of failureCases) {
			const parentID = await createParent(currentServer.client, `delegation fallback ${item.key} QA`)
			sessionIDs[item.key] = parentID
			const before = childrenOf(parentID)
			await promptParent(currentServer.client, parentID, item.marker)
			const after = childrenOf(parentID)
			const messages = await currentServer.client.message.list({ sessionID: parentID })
			const toolState = findToolState(messages, item.toolName)
			const toolErrorText = JSON.stringify(toolState?.error ?? toolState?.output ?? toolState ?? {})
			const validationError = toolState?.status === "error" && /model|variant|unavailable|not found/i.test(toolErrorText)
			passedChecks(`${item.key} is rejected by native tool validation before child creation`, before.length === 0 && after.length === 0 && validationError, { before, after, toolName: item.toolName, toolState, validationError })
		}

		const resumeConfig = omoConfig(true)
		await writeFile(join(project, ".omo", "omo.jsonc"), `${JSON.stringify(resumeConfig, null, 2)}\n`)
		await writeFile(join(runDirectory, "omo-config-after-fallback-reorder.json"), `${JSON.stringify(resumeConfig, null, 2)}\n`)
		const cleanOldServer = await stopHost(currentServer.process)
		priorStopResults.push(cleanOldServer)
		currentServer = await startHost()
		const beforeResumeObservation = observations.length
		await promptParent(currentServer.client, siblingParent, PARENT_RESUME)
		const resumeSession = await currentServer.client.session.get({ sessionID: exploreChild!.id })
		const resumedStoredSettings = persistedDelegationSettings(databasePath, exploreChild!.id)
		const resumedRequest = observations.slice(beforeResumeObservation).find((item) => item.sessionID === exploreChild!.id && item.kind === "primary" && item.role === "child")
		const resumedRows = childrenOf(siblingParent)
		resumeRecord = { session: { id: resumeSession.id, parentID: resumeSession.parentID, agent: resumeSession.agent, model: resumeSession.model, outcome: resumeSession.outcome }, request: resumedRequest }
		passedChecks("resume after fallback reorder sends a new primary request using persisted model and settings", resumedRows.length === 2 && resumeSession.id === exploreChild!.id && resumeSession.outcome === "succeeded" && rowModel(exploreChild) === SECONDARY_MODEL && checkSettings(resumedRequest, { model: SECONDARY_MODEL_ID, temperature: 0.31, topP: 0.42, maxTokens: 2468, reasoningEffort: "high" }) && (resumedStoredSettings?.settings as Record<string, unknown> | undefined)?.parallelToolCalls === false, { resumeRecord, resumedStoredSettings })

		await promptParent(currentServer.client, siblingParent, PARENT_POST_REORDER)
		const postReorderChildren = childrenOf(siblingParent)
		const postReorderExplore = postReorderChildren.filter((row) => row.agent === "explore")
		const reorderedRequest = postReorderExplore.length === 2 ? childPrimary(postReorderExplore[1]!.id) : undefined
		passedChecks("a fresh explore child after reorder selects the new first enabled fallback", postReorderChildren.length === 3 && postReorderExplore.length === 2 && rowModel(postReorderExplore[1]) === TERTIARY_MODEL && checkSettings(reorderedRequest, { model: TERTIARY_MODEL_ID, temperature: 0.29, topP: 0.39, maxTokens: 1357 }), { children: postReorderChildren, request: reorderedRequest })

		initialRows = sessionRows(databasePath, canonicalProject)
		passedChecks("all observed provider calls have exact session, kind, directory, and local catalog origin", observations.length > 0 && originFailures.length === 0 && observations.every((item) => item.sessionID && item.kind && item.selectedModel?.startsWith(`${PROVIDER}/`) && [PARENT_MODEL_ID, SECONDARY_MODEL_ID, TERTIARY_MODEL_ID].includes(item.requestModel)), { observations, originFailures })
		passedChecks("no active MCP or Claude integrations entered the fixture", preflights.every((item) => Array.isArray(item.activeMcpNames) && item.activeMcpNames.length === 0), preflights)
		passedChecks("all native parent sessions completed and routing had no unhandled path", parentOutcomes.length > 0 && parentOutcomes.every((item) => item.outcome === "succeeded") && routeFailures.length === 0, { parentOutcomes, routeFailures })
	} catch (error) {
		failure = error instanceof Error ? error.message : String(error)
	} finally {
		const stops: boolean[] = []
		if (currentServer) stops.push(await stopHost(currentServer.process))
		for (const process of processRuns) {
			if (currentServer?.process === process) continue
			stops.push(await stopHost(process))
		}
		await Promise.all(outputTasks)
		mock.stop(true)
		mockStopped = true
		finalRows = sessionRows(databasePath, canonicalProject)
		const finalCount = finalRows.length
		const retainedInitialRows = initialRows.every((before) => {
			const after = finalRows.find((row) => row.id === before.id)
			return after?.parentID === before.parentID && after.agent === before.agent && after.model === before.model && after.directory === before.directory
		})
		isolatedDatabaseProof = initialRows.length > 0 && retainedInitialRows && finalCount === initialRows.length
		cleanup = { serverStops: stops, mockStopped, temporaryRootPreserved: existsSync(tempRoot), databaseSessionCountBeforeCleanup: initialRows.length, databaseSessionCountAfterCleanup: finalCount }
		const allStopResults = [...priorStopResults, ...stops]
		const cleanShutdown = allStopResults.length > 0 && allStopResults.every(Boolean) && mockStopped && existsSync(tempRoot)
		cleanup = { ...cleanup, serverStops: allStopResults, mockStopped, temporaryRootPreserved: existsSync(tempRoot), databaseSessionCountBeforeCleanup: initialRows.length, databaseSessionCountAfterCleanup: finalCount }
		checks.push({ name: "all local processes stopped and isolated data was retained", passed: cleanShutdown, detail: cleanup })
		checks.push({ name: "restart retained original database sessions and created only the expected post-reorder child", passed: isolatedDatabaseProof, detail: { before: initialRows.length, after: finalCount, retainedInitialRows } })
		if (!cleanShutdown || !isolatedDatabaseProof) failure ??= "Cleanup or retained-database verification failed"
		const sourceFiles = [
			"packages/omo-opencode/src/v2/delegation-model-selection.ts",
			"packages/omo-opencode/src/v2/delegation-admission.ts",
			"packages/omo-opencode/src/v2/delegation-settings.ts",
			"packages/omo-opencode/src/v2/context-hooks.ts",
			"packages/omo-opencode/src/shared/disabled-providers.ts",
		]
		const sourceHashes = Object.fromEntries(await Promise.all(sourceFiles.map(async (file) => [file, createHash("sha256").update(await readFile(join(ROOT, file))).digest("hex")])))
		const headResult = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: ROOT, stdout: "pipe", stderr: "pipe" })
		const statusResult = Bun.spawnSync(["git", "status", "--short"], { cwd: ROOT, stdout: "pipe", stderr: "pipe" })
		const sourceSnapshotHash = createHash("sha256").update(JSON.stringify(sourceHashes)).digest("hex")
		const driverSha256 = createHash("sha256").update(await readFile(join(ROOT, "script/opencode2-delegation-fallback-qa.ts"))).digest("hex")
		const runtime = {
			purpose: "Local-only delegated fallback/settings host QA with pinned OpenCode 2.0.18 and bundle hash.",
			opencodeVersion: version,
			productionSourceBaseCommit: headResult.stdout.toString().trim(),
			productionWorkingTreeDirty: statusResult.stdout.toString().trim().length > 0,
			productionSourceSnapshotSha256: sourceSnapshotHash,
			driverSha256,
			pluginDirectory: PLUGIN_DIR,
			bundleSha256: serverHash,
			expectedBundleSha256: EXPECTED_SERVER_SHA256,
			opencodeCLI: OPENCODE_BIN,
			projectDirectory: canonicalProject,
			temporaryRoot: tempRoot,
			isolatedPaths: { home, xdgData, xdgConfig, xdgState, xdgCache, omoHome, claudeHome, claudePlugins, databasePath },
			localModelCatalog: [PARENT_MODEL, SECONDARY_MODEL, TERTIARY_MODEL].sort(),
			configuredDefaultModel: PARENT_MODEL,
			activeMcpsExpected: [],
			preflights,
			sessionIDs,
			children: finalRows.filter((row) => row.parentID).map((row) => ({ id: row.id, parentID: row.parentID, agent: row.agent, model: row.model ? JSON.parse(row.model) : null })),
			mockObservations: observations,
			originFailures,
			routeFailures,
			checks,
			passed: !failure && checks.length > 0 && checks.every((check) => check.passed),
			failure,
			resumeRecord,
			isolation: { databaseReadOnlyInspected: true, sessionRowsStableAfterShutdown: isolatedDatabaseProof, retainedTemporaryRoot: existsSync(tempRoot) },
			cleanup,
			sourceHashes,
		}
		await Promise.all([
			writeFile(join(runDirectory, "runtime.json"), `${JSON.stringify(runtime, null, 2)}\n`),
			writeFile(join(runDirectory, "server.log"), redact(`${output.stdout.join("\n")}\n--- stderr ---\n${output.stderr.join("\n")}`)),
			writeFile(join(runDirectory, "mock-observations.json"), `${JSON.stringify(observations, null, 2)}\n`),
		])
	}
	if (failure) throw new Error(`Delegated fallback QA failed; inspect ${join(runDirectory, "runtime.json")}: ${failure}`)
	process.stdout.write(`${JSON.stringify({ evidence: runDirectory, passed: checks.every((check) => check.passed), checkCount: checks.length, cleanup }, null, 2)}\n`)
}

if (import.meta.main) await main()
