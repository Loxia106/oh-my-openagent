/**
 * Local-only OpenCode 2.0.22 QA for native delegated runtime fallback.
 *
 * Run only against an explicitly frozen bundle:
 * OPENCODE2_CLI=/absolute/path/to/opencode \
 * OPENCODE2_EXPECTED_SERVER_SHA256=<sha256> \
 * OPENCODE2_DELEGATION_RECOVERY_EVIDENCE_DIR=<direct child of .omo/evidence> \
 * bun script/opencode2-delegation-runtime-recovery-qa.ts
 *
 * The isolated retry hook disables OpenCode's own retry loop for primary model
 * requests, so the fixture can prove the OMO-owned 429 witness and bounded
 * child fallback path without waiting through unrelated native retry delays.
 */
import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { Database } from "bun:sqlite"
import { OpenCode } from "@opencode/client"
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { tmpdir } from "node:os"

const ROOT = resolve(import.meta.dir, "..")
const EVIDENCE_ROOT = join(ROOT, ".omo", "evidence")
const EVIDENCE = resolve(process.env.OPENCODE2_DELEGATION_RECOVERY_EVIDENCE_DIR
	?? join(EVIDENCE_ROOT, `20260927-delegation-runtime-recovery-${new Date().toISOString().replaceAll(":", "-")}`))
const PLUGIN_DIR = resolve(process.env.OPENCODE2_PLUGIN_DIR ?? join(ROOT, "dist", "opencode2"))
const CLI_INPUT = process.env.OPENCODE2_CLI?.trim() ?? ""
const CLI = CLI_INPUT ? resolve(CLI_INPUT) : ""
const EXPECTED_SERVER_SHA256 = process.env.OPENCODE2_EXPECTED_SERVER_SHA256 ?? ""

const PROVIDER = "omoqa"
const PARENT_MODEL_ID = "delegation-parent"
const CHILD_PRIMARY_ID = "delegation-child-primary"
const CHILD_BACKUP_ID = "delegation-child-backup"
const PARENT_MODEL = `${PROVIDER}/${PARENT_MODEL_ID}`
const CHILD_PRIMARY_MODEL = `${PROVIDER}/${CHILD_PRIMARY_ID}`
const CHILD_BACKUP_MODEL = `${PROVIDER}/${CHILD_BACKUP_ID}`
const MODEL_IDS = [PARENT_MODEL_ID, CHILD_PRIMARY_ID, CHILD_BACKUP_ID] as const
const PASSWORD = "delegation-runtime-local-qa-password"
const API_KEY = "delegation-runtime-local-fake-key"
const PROBE_ID = "omo-delegation-runtime-origin-probe"
const FOREGROUND_PARENT = "OMO_DELEGATION_FOREGROUND_PARENT"
const FOREGROUND_CHILD = "OMO_DELEGATION_FOREGROUND_CHILD"
const FOREGROUND_CHILD_SUCCESS = "OMO_DELEGATION_FOREGROUND_CHILD_RECOVERED"
const FOREGROUND_PARENT_SUCCESS = "OMO_DELEGATION_FOREGROUND_PARENT_RECEIVED_ONE_RESULT"
const BACKGROUND_PARENT = "OMO_DELEGATION_BACKGROUND_PARENT"
const BACKGROUND_CHILD = "OMO_DELEGATION_BACKGROUND_START_CHILD"
const BACKGROUND_CHILD_RESUME = "OMO_DELEGATION_BACKGROUND_CONTINUE_CHILD"
const BACKGROUND_CHILD_SUCCESS = "OMO_DELEGATION_BACKGROUND_CHILD_RECOVERED"
const BACKGROUND_PARENT_RESUME = "OMO_DELEGATION_BACKGROUND_PARENT_EXPLICIT_RESUME"
const BACKGROUND_PARENT_SUCCESS = "OMO_DELEGATION_BACKGROUND_PARENT_CONSUMED_RESUME"
const NO_CHAIN_PARENT = "OMO_DELEGATION_NO_CHAIN_PARENT"
const NO_CHAIN_CHILD = "OMO_DELEGATION_NO_CHAIN_CHILD"
const NO_CHAIN_PARENT_SUCCESS = "OMO_DELEGATION_NO_CHAIN_PARENT_OBSERVED_FAILURE"
const SUCCESS_ERROR_STATUS = 429
const REQUEST_KINDS = new Set(["primary", "compaction", "title", "generate"])
const TIMEOUT_MS = 90_000

type RecordValue = Record<string, unknown>
type Scenario = "foreground" | "background" | "no-chain"
type ParentRow = { id: string; parentID: string | null; directory: string; agent: string | null; model: string | null; outcome?: string }
type ParentState = {
	sessionID: string
	scenario: Scenario
	childPrompt: string
	childAgent: "explore" | "librarian"
	childID?: string
	initialTaskIssued: boolean
	resumeRequested: boolean
	resumeTaskIssued: boolean
	backgroundFailureVerified: boolean
	parentTaskCalls: Array<{ requestIndex: number; args: RecordValue; toolName: string }>
	parentFollowups: number
	parentSawFailureNotice: boolean
}
type RequestObservation = {
	index: number
	sessionID?: string
	parentID?: string | null
	role: "parent" | "child" | "unknown"
	scenario?: Scenario
	agent?: string
	kind?: string
	provider?: string
	model?: string
	bodyModel?: string
	selectedModel?: string
	latestUser?: string
	userTexts: string[]
	toolNames: string[]
	toolResults: string[]
	taskCalls: Array<{ name: string; args: RecordValue }>
	failureNoticeInBody: boolean
	status: number
	responsePlan: string
	streaming: boolean
	originErrors: string[]
}
type ToolState = { name: string; status: string; input?: unknown; output: string; error: string }
type Check = { name: string; passed: boolean; detail?: unknown }
type Client = ReturnType<typeof OpenCode.make>
type Host = { process: Bun.Subprocess; client: Client; port: number; stdout: string; stderr: string; stdoutTask: Promise<void>; stderrTask: Promise<void> }

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message)
}

function isRecord(value: unknown): value is RecordValue {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

function redact(value: string): string {
	return value.replaceAll(API_KEY, "[redacted-fake-key]").replaceAll(PASSWORD, "[redacted-test-password]")
}

function basicAuth(): string {
	return `Basic ${Buffer.from(`opencode:${PASSWORD}`).toString("base64")}`
}

function textOf(value: unknown): string {
	if (typeof value === "string") return value
	if (Array.isArray(value)) return value.map(textOf).filter(Boolean).join("\n")
	if (!isRecord(value)) return ""
	if (typeof value.text === "string") return value.text
	return textOf(value.content ?? value.parts ?? value.output ?? value.error)
}

function bodyMessages(body: RecordValue): RecordValue[] {
	return Array.isArray(body.messages) ? body.messages.filter(isRecord) : []
}

function userTexts(body: RecordValue): string[] {
	return bodyMessages(body).filter((message) => message.role === "user")
		.map((message) => textOf(message.content ?? message.parts ?? message.text))
}

function latestUserText(body: RecordValue): string {
	return userTexts(body).at(-1) ?? ""
}

function toolResultsAfterLatestUser(body: RecordValue): string[] {
	const messages = bodyMessages(body)
	let latestUserIndex = -1
	for (let index = 0; index < messages.length; index += 1) {
		if (messages[index]?.role === "user") latestUserIndex = index
	}
	return messages.slice(latestUserIndex + 1)
		.filter((message) => message.role === "tool")
		.map((message) => textOf(message.content))
}

function allToolNames(body: RecordValue): string[] {
	if (!Array.isArray(body.tools)) return []
	return body.tools.flatMap((entry) => {
		if (!isRecord(entry)) return []
		const fn = isRecord(entry.function) ? entry.function : entry
		return typeof fn.name === "string" ? [fn.name] : []
	})
}

function toolCall(body: RecordValue, id: string): { name: string; args: RecordValue } | undefined {
	for (const message of bodyMessages(body).toReversed()) {
		if (message.role !== "assistant" || !Array.isArray(message.tool_calls)) continue
		for (const raw of message.tool_calls) {
			if (!isRecord(raw) || !isRecord(raw.function) || typeof raw.function.name !== "string") continue
			const rawArgs = raw.function.arguments
			if (typeof rawArgs !== "string") continue
			try {
				const parsed: unknown = JSON.parse(rawArgs)
				if (isRecord(parsed)) return { name: raw.function.name, args: parsed }
			} catch { /* The fixture never trusts malformed model arguments. */ }
		}
	}
	return undefined
}

function modelRef(raw: unknown): string | undefined {
	if (typeof raw !== "string" || !raw) return undefined
	try {
		const parsed: unknown = JSON.parse(raw)
		return isRecord(parsed) && typeof parsed.providerID === "string" && typeof parsed.id === "string"
			? `${parsed.providerID}/${parsed.id}`
			: undefined
	} catch { return raw }
}

function rowModel(raw: unknown): string | undefined {
	return modelRef(raw)
}

function sessionRow(databasePath: string, sessionID: string): ParentRow | undefined {
	if (!existsSync(databasePath)) return undefined
	try {
		const db = new Database(databasePath, { readonly: true, create: false })
		try {
			const row = db.query("SELECT id, parent_id AS parentID, directory, agent, model, idle_outcome AS outcome FROM session_v2 WHERE id = ?").get(sessionID)
			return isRecord(row) ? row as ParentRow : undefined
		} finally { db.close() }
	} catch { return undefined }
}

function childRows(databasePath: string, directory: string, parentID: string): ParentRow[] {
	if (!existsSync(databasePath)) return []
	try {
		const db = new Database(databasePath, { readonly: true, create: false })
		try {
			return db.query("SELECT id, parent_id AS parentID, directory, agent, model, idle_outcome AS outcome FROM session_v2 WHERE directory = ? AND parent_id = ? ORDER BY time_created ASC")
				.all(directory, parentID) as ParentRow[]
		} finally { db.close() }
	} catch { return [] }
}

function sessionCount(databasePath: string): number | null {
	if (!existsSync(databasePath)) return 0
	try {
		const db = new Database(databasePath, { readonly: true, create: false })
		try {
			const row = db.query("SELECT count(*) AS count FROM session_v2").get() as { count?: number } | null
			return typeof row?.count === "number" ? row.count : null
		} finally { db.close() }
	} catch { return null }
}

function delegationSettings(databasePath: string, sessionID: string): RecordValue | undefined {
	if (!existsSync(databasePath)) return undefined
	try {
		const db = new Database(databasePath, { readonly: true, create: false })
		try {
			const rows = db.query("SELECT value FROM kv WHERE key LIKE '%:oh-my-openagent:v2:delegation-settings:%'").all() as Array<{ value: string }>
			for (const row of rows) {
				try {
					const value: unknown = JSON.parse(row.value)
					if (isRecord(value) && value.sessionID === sessionID) return value
				} catch { /* Ignore unrelated or malformed plugin state. */ }
			}
		} finally { db.close() }
	} catch { return undefined }
	return undefined
}

function contextMessages(raw: unknown): RecordValue[] {
	if (Array.isArray(raw)) return raw.filter(isRecord)
	if (isRecord(raw) && Array.isArray(raw.data)) return raw.data.filter(isRecord)
	if (isRecord(raw) && Array.isArray(raw.messages)) return raw.messages.filter(isRecord)
	return []
}

function userHistory(context: unknown): string[] {
	return contextMessages(context).filter((message) => message.type === "user")
		.map((message) => textOf(message.text ?? message.content ?? message.parts))
}

function assistantFailures(context: unknown): Array<RecordValue> {
	return contextMessages(context).filter((message) => message.type === "assistant" && isRecord(message.error))
		.map((message) => ({
			id: message.id,
			agent: message.agent,
			model: message.model,
			error: message.error,
			time: message.time,
		}))
}

function hasSubagentFailureBody(text: string): boolean {
	const start = text.indexOf('state="error"')
	if (start < 0) return false
	const bodyStart = text.indexOf(">", start)
	const bodyEnd = bodyStart < 0 ? -1 : text.indexOf("</subagent>", bodyStart + 1)
	return bodyStart >= 0 && bodyEnd > bodyStart && text.slice(bodyStart + 1, bodyEnd).trim().length > 0
}

function toolStates(context: unknown, toolName: string): ToolState[] {
	return contextMessages(context).flatMap((message) => {
		if (message.type !== "assistant" || !Array.isArray(message.content)) return []
		return message.content.flatMap((part) => {
			if (!isRecord(part) || part.type !== "tool" || String(part.name).toLowerCase() !== toolName.toLowerCase() || !isRecord(part.state)) return []
			const state = part.state
			return [{
				name: String(part.name),
				status: typeof state.status === "string" ? state.status : "unknown",
				input: state.input,
				output: textOf(state.output ?? state.content),
				error: textOf(state.error),
			}]
		})
	})
}

function syntheticFailureNotice(context: unknown, childID: string): string | undefined {
	for (const message of contextMessages(context)) {
		if (message.type !== "synthetic") continue
		const text = textOf(message.text ?? message.content ?? message.parts)
		if (text.includes(`<subagent sessionID="${childID}" state="error"`) && hasSubagentFailureBody(text)) return text
	}
	return undefined
}

function reservePort(): number {
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("reserved") })
	const port = server.port
	server.stop(true)
	assert(typeof port === "number", "Could not reserve an isolated localhost port")
	return port
}

async function within<T>(label: string, operation: Promise<T>, timeoutMs = TIMEOUT_MS): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined
	try {
		return await Promise.race([
			operation,
			new Promise<T>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs) }),
		])
	} finally { if (timer) clearTimeout(timer) }
}

async function waitFor<T>(label: string, read: () => Promise<T | undefined>, timeoutMs = TIMEOUT_MS): Promise<T> {
	const deadline = Date.now() + timeoutMs
	let last: unknown
	while (Date.now() < deadline) {
		try {
			const value = await read()
			if (value !== undefined) return value
		} catch (error) { last = error }
		await new Promise((resolve) => setTimeout(resolve, 100))
	}
	throw new Error(`${label} timed out${last ? `: ${String(last)}` : ""}`)
}

function completion(model: string, id: string, text: string, streaming: boolean): Response {
	const created = Math.floor(Date.now() / 1000)
	if (!streaming) return Response.json({
		id: `chatcmpl-${id}`, object: "chat.completion", created, model,
		choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
		usage: { prompt_tokens: 10, completion_tokens: 6, total_tokens: 16 },
	})
	const chunks = [
		{ id: `chatcmpl-${id}`, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] },
		{ id: `chatcmpl-${id}`, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
	]
	return new Response(`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`, {
		headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive" },
	})
}

function toolCallResponse(model: string, id: string, name: string, args: RecordValue, streaming: boolean): Response {
	const created = Math.floor(Date.now() / 1000)
	const calls = [{ index: 0, id: `call-${id}`, type: "function", function: { name, arguments: JSON.stringify(args) } }]
	if (!streaming) return Response.json({
		id: `chatcmpl-${id}`, object: "chat.completion", created, model,
		choices: [{ index: 0, message: { role: "assistant", content: null, tool_calls: calls }, finish_reason: "tool_calls" }],
		usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
	})
	const chunks = [
		{ id: `chatcmpl-${id}`, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { role: "assistant", tool_calls: calls }, finish_reason: null }] },
		{ id: `chatcmpl-${id}`, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
	]
	return new Response(`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`, {
		headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive" },
	})
}

function localProbeSource(mockOrigin: string): string {
	return `export default {
  id: ${JSON.stringify(PROBE_ID)},
  async setup({ session }) {
    const active = new Map()
    const model = await session.hook("model.request", (event) => {
      if (event.model.providerID !== ${JSON.stringify(PROVIDER)} || !${JSON.stringify(MODEL_IDS)}.includes(event.model.id)) {
        throw new Error("QA blocked a non-local provider/model request")
      }
      const value = { agent: String(event.agent), provider: String(event.model.providerID), model: String(event.model.id), kind: String(event.kind) }
      active.set(event.sessionID, value)
      event.headers["x-omo-qa-agent"] = value.agent
      event.headers["x-omo-qa-provider"] = value.provider
      event.headers["x-omo-qa-model"] = value.model
    })
    const http = await session.hook("http.request", (event) => {
      if (new URL(event.request.url).origin !== ${JSON.stringify(mockOrigin)}) throw new Error("QA blocked a non-local HTTP origin")
      const value = active.get(event.sessionID)
      if (!value || value.kind !== event.kind) throw new Error("QA could not correlate HTTP request to native model.request")
      const headers = new Headers(event.request.headers)
      headers.set("x-omo-qa-session-id", event.sessionID)
      headers.set("x-omo-qa-kind", event.kind)
      event.request = new Request(event.request, { headers })
    })
    const retry = await session.hook("retry", (event) => {
      const value = active.get(event.sessionID)
      if (value?.kind === "primary") event.decision = { retry: false }
    })
    return async () => { await Promise.all([retry.dispose(), http.dispose(), model.dispose()]) }
  }
}\n`
}

async function stopHost(process: Bun.Subprocess | undefined): Promise<{ stopped: boolean; exitCode: number | null }> {
	if (!process) return { stopped: true, exitCode: null }
	if (process.exitCode !== null) return { stopped: true, exitCode: process.exitCode }
	process.kill("SIGTERM")
	const stopped = await Promise.race([
		process.exited.then(() => true),
		new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5_000)),
	])
	if (!stopped && process.exitCode === null) {
		process.kill("SIGKILL")
		await process.exited
	}
	return { stopped, exitCode: process.exitCode }
}

async function main(): Promise<void> {
	assert(CLI && existsSync(CLI) && isAbsolute(CLI_INPUT), "Set OPENCODE2_CLI to an explicit absolute OpenCode CLI path")
	assert(/^[a-f0-9]{64}$/i.test(EXPECTED_SERVER_SHA256), "Set OPENCODE2_EXPECTED_SERVER_SHA256 to the frozen server bundle hash")
	const evidenceRelative = relative(EVIDENCE_ROOT, EVIDENCE)
	assert(evidenceRelative && evidenceRelative !== ".." && !evidenceRelative.startsWith(`..${sep}`)
		&& !isAbsolute(evidenceRelative) && !evidenceRelative.includes(sep), `Evidence must be one direct child of ${EVIDENCE_ROOT}`)
	await mkdir(EVIDENCE_ROOT, { recursive: true })
	const canonicalEvidenceRoot = await realpath(EVIDENCE_ROOT)
	await mkdir(EVIDENCE, { recursive: true })
	const canonicalEvidence = await realpath(EVIDENCE)
	assert(dirname(canonicalEvidence) === canonicalEvidenceRoot, "Evidence directory escaped .omo/evidence")
	const serverPath = join(PLUGIN_DIR, "server.js")
	assert(existsSync(serverPath), `Missing frozen OpenCode 2 bundle: ${serverPath}`)
	const bundleSHA = createHash("sha256").update(await readFile(serverPath)).digest("hex")
	assert(bundleSHA === EXPECTED_SERVER_SHA256.toLowerCase(), `Frozen server hash mismatch: ${bundleSHA}`)

	const tempRoot = await realpath(await mkdtemp(join(tmpdir(), "omo-delegation-runtime-recovery-qa-")))
	const project = join(tempRoot, "project")
	const serverCwd = join(tempRoot, "server-cwd")
	const home = join(tempRoot, "home")
	const xdgData = join(tempRoot, "xdg-data")
	const xdgConfig = join(tempRoot, "xdg-config")
	const xdgState = join(tempRoot, "xdg-state")
	const xdgCache = join(tempRoot, "xdg-cache")
	const omoHome = join(tempRoot, "omo-home")
	const claudeConfig = join(tempRoot, "claude-config")
	const claudePlugins = join(tempRoot, "claude-plugins")
	const originPlugin = join(tempRoot, "origin-probe")
	const databasePath = join(tempRoot, "opencode.db")
	await Promise.all([project, join(project, ".omo"), serverCwd, home, xdgData, xdgConfig, xdgState, xdgCache, omoHome, claudeConfig, claudePlugins, originPlugin]
		.map((directory) => mkdir(directory, { recursive: true })))
	const canonicalProject = await realpath(project)
	assert(!canonicalProject.startsWith(`${ROOT}${sep}`), "QA project must be outside the repository")

	const checks: Check[] = []
	const observations: RequestObservation[] = []
	const originFailures: Array<RecordValue> = []
	const routeFailures: string[] = []
	const parentStates = new Map<string, ParentState>()
	const parentsByScenario = new Map<Scenario, ParentState>()
	const childPrimaryAttempts = new Map<string, number>()
	const childBackupAttempts = new Map<string, number>()
	const childTaskResponses: Array<RecordValue> = []
	const preflights: Array<RecordValue> = []
	const modelResponses: Array<RecordValue> = []
	let mock: ReturnType<typeof Bun.serve> | undefined
	let host: Host | undefined
	let mockOrigin = ""
	let mockStopped = false
	let serverShutdown: { stopped: boolean; exitCode: number | null } = { stopped: false, exitCode: null }
	let version = ""
	let failure: string | undefined
	let callIndex = 0
	let beforeSessionCount: number | null = null
	let afterSessionCount: number | null = null
	const runResult: RecordValue = {
		startedAt: new Date().toISOString(),
		cli: CLI,
		pluginDirectory: PLUGIN_DIR,
		serverPath,
		bundleSHA,
		expectedBundleSHA: EXPECTED_SERVER_SHA256,
		projectDirectory: canonicalProject,
		projectOutsideRepository: !canonicalProject.startsWith(`${ROOT}${sep}`),
		temporaryRoot: tempRoot,
		databasePath,
		configuredProvider: PROVIDER,
		configuredDefaultModel: PARENT_MODEL,
		configuredChildPrimary: CHILD_PRIMARY_MODEL,
		configuredChildBackup: CHILD_BACKUP_MODEL,
	}

	const openCodeEnvironment: Record<string, string> = {
		PATH: ["/tmp/omo-bun-runtime-1.4.2", "/usr/local/bin", "/opt/homebrew/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":"),
		TMPDIR: tempRoot,
		HOME: home,
		XDG_DATA_HOME: xdgData,
		XDG_CONFIG_HOME: xdgConfig,
		XDG_STATE_HOME: xdgState,
		XDG_CACHE_HOME: xdgCache,
		OPENCODE_DB: databasePath,
		OMO_HOME: omoHome,
		CLAUDE_CONFIG_DIR: claudeConfig,
		CLAUDE_PLUGINS_HOME: claudePlugins,
		OPENCODE_DISABLE_MODELS_FETCH: "1",
		OPENCODE_TELEMETRY_DISABLED: "1",
		OPENCODE_SERVER_PASSWORD: PASSWORD,
		OPENCODE_PASSWORD: PASSWORD,
	}

	const projectConfig = {
		$schema: "https://opencode.ai/config.json",
		plugins: [PLUGIN_DIR, originPlugin],
		enabled_providers: [PROVIDER],
		model: PARENT_MODEL,
		default_agent: "sisyphus",
		provider: {
			[PROVIDER]: {
				name: "Local delegated runtime recovery QA mock",
				npm: "@ai-sdk/openai-compatible",
				options: { baseURL: "__MOCK_ORIGIN__/v1", apiKey: API_KEY },
				models: {
					[PARENT_MODEL_ID]: { name: "QA parent model", tool_call: true, limit: { context: 200_000, output: 8_192 } },
					[CHILD_PRIMARY_ID]: { name: "QA delegated primary", tool_call: true, limit: { context: 200_000, output: 8_192 } },
					[CHILD_BACKUP_ID]: { name: "QA delegated backup", tool_call: true, limit: { context: 200_000, output: 8_192 } },
				},
			},
		},
		mcp: {},
		telemetry: false,
		permission: { task: "allow", subagent: "allow", read: "allow", shell: "deny", edit: "deny", write: "deny" },
	}
	const omoConfig = {
		telemetry: { enabled: false },
		"[opencode]": {
			telemetry: false,
			auto_update: false,
			runtime_fallback: { enabled: true, retry_on_errors: [SUCCESS_ERROR_STATUS], max_fallback_attempts: 1, cooldown_seconds: 0 },
			disabled_mcps: ["websearch", "context7", "grep_app", "lsp"],
			claude_code: { mcp: false, agents: false, skills: false, commands: false, plugins: false, hooks: false },
			agents: {
				sisyphus: { model: PARENT_MODEL },
				explore: { model: CHILD_PRIMARY_MODEL, fallback_models: [{ model: CHILD_BACKUP_MODEL, maxTokens: 733 }] },
				librarian: { model: CHILD_PRIMARY_MODEL },
			},
		},
	}

	const mockFailure = (model: string, id: string): Response => Response.json({
		id: `chatcmpl-${id}`,
		object: "error",
		error: { message: "Local fixture rate limit for delegated first attempt", type: "rate_limit_error", code: "rate_limit_exceeded", status: SUCCESS_ERROR_STATUS },
	}, { status: SUCCESS_ERROR_STATUS })

	const issueTaskCall = (observation: RequestObservation, parent: ParentState, args: RecordValue, purpose: string): Response => {
		const taskName = observation.toolNames.find((name) => name.toLowerCase() === "task")
		if (!taskName) {
			const message = `Expected OMO task tool was not advertised; available=${observation.toolNames.join(",")}`
			routeFailures.push(message)
			observation.responsePlan = `fixture failure: ${message}`
			return Response.json({ error: { message } }, { status: 500 })
		}
		parent.parentTaskCalls.push({ requestIndex: observation.index, args, toolName: taskName })
		observation.responsePlan = purpose
		observation.status = 200
		return toolCallResponse(observation.bodyModel ?? "", `delegation-recovery-${observation.index}`, taskName, args, observation.streaming)
	}

	try {
		const mockServer = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request) {
				const url = new URL(request.url)
				if (url.pathname.endsWith("/models")) {
					return Response.json({ data: MODEL_IDS.map((id) => ({ id, object: "model", created: 0, owned_by: "local-qa" })) })
				}
				if (!url.pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 })
				const rawBody: unknown = await request.json()
				if (!isRecord(rawBody)) return Response.json({ error: { message: "QA expected an object request body" } }, { status: 400 })
				const body = rawBody
				const index = ++callIndex
				const sessionID = request.headers.get("x-omo-qa-session-id") ?? undefined
				const kind = request.headers.get("x-omo-qa-kind") ?? undefined
				const agent = request.headers.get("x-omo-qa-agent") ?? undefined
				const provider = request.headers.get("x-omo-qa-provider") ?? undefined
				const model = request.headers.get("x-omo-qa-model") ?? undefined
				const bodyModel = typeof body.model === "string" ? body.model : undefined
				const row = sessionID ? sessionRow(databasePath, sessionID) : undefined
				const state = row?.parentID ? parentStates.get(row.parentID) : sessionID ? parentStates.get(sessionID) : undefined
				const role: RequestObservation["role"] = !row || !state ? "unknown" : row.parentID ? "child" : "parent"
				const selectedModel = modelRef(row?.model)
				const users = userTexts(body)
				const latestUser = latestUserText(body)
				const results = toolResultsAfterLatestUser(body)
				const failureNoticeInBody = bodyMessages(body).some((message) => {
					const text = textOf(message.content ?? message.text ?? message.parts)
					return hasSubagentFailureBody(text)
				})
				const observation: RequestObservation = {
					index,
					...(sessionID ? { sessionID } : {}),
					...(row ? { parentID: row.parentID, selectedModel } : {}),
					role,
					...(state ? { scenario: state.scenario } : {}),
					...(agent ? { agent } : {}),
					...(kind ? { kind } : {}),
					...(provider ? { provider } : {}),
					...(model ? { model } : {}),
					...(bodyModel ? { bodyModel } : {}),
					...(latestUser ? { latestUser } : {}),
					userTexts: users,
					toolNames: allToolNames(body),
					toolResults: results,
					taskCalls: [],
					failureNoticeInBody,
					status: 500,
					responsePlan: "unrouted",
					streaming: body.stream === true,
					originErrors: [],
				}
				observations.push(observation)

				const expectedAgent = role === "parent" ? "sisyphus" : state?.childAgent
				const expectedModel = role === "parent" ? PARENT_MODEL_ID : bodyModel
				if (url.origin !== mockOrigin) observation.originErrors.push(`unexpected request origin ${url.origin}`)
				if (!sessionID || !kind || !REQUEST_KINDS.has(kind)) observation.originErrors.push("missing/invalid native session or request kind")
				if (!row || row.directory !== canonicalProject) observation.originErrors.push("session is missing or escaped the isolated project")
				if (!state || role === "unknown") observation.originErrors.push("request session is not a registered QA parent or owned child")
				if (provider !== PROVIDER || !MODEL_IDS.includes(model as (typeof MODEL_IDS)[number])) observation.originErrors.push("model.request did not identify an allowlisted local provider/model")
				if (model !== bodyModel) observation.originErrors.push("model.request model differs from provider wire model")
				if (agent !== expectedAgent || row?.agent !== expectedAgent) observation.originErrors.push("native effective agent differs from the expected parent/child agent")
				if (selectedModel !== `${PROVIDER}/${String(expectedModel)}`) observation.originErrors.push("persisted session model differs from the active request")
				if (role === "parent" && row?.parentID != null) observation.originErrors.push("parent request unexpectedly has a native parent")
				if (role === "child" && (!row?.parentID || !parentStates.has(row.parentID))) observation.originErrors.push("child request has no known native parent")
				if (role === "child" && state && row?.agent !== state.childAgent) observation.originErrors.push("child agent differs from the requested delegated agent")
				if (observation.originErrors.length) {
					originFailures.push({ ...observation, row, requestOrigin: url.origin })
					observation.responsePlan = "refused: provider request escaped exact local model/session attribution"
					return Response.json({ error: { message: "QA blocked a provider request outside its allowlisted native session/model." } }, { status: 403 })
				}

				if (kind !== "primary") {
					observation.status = 200
					observation.responsePlan = "local auxiliary completion"
					return completion(bodyModel ?? "", `LOCAL_QA_AUXILIARY_${kind}`, `aux-${index}`, body.stream === true)
				}

				if (role === "child" && sessionID && state) {
					state.childID = sessionID
					const primaryAttempts = childPrimaryAttempts.get(sessionID) ?? 0
					if (bodyModel === CHILD_PRIMARY_ID) {
						childPrimaryAttempts.set(sessionID, primaryAttempts + 1)
						observation.status = SUCCESS_ERROR_STATUS
						observation.responsePlan = primaryAttempts === 0
							? "429 the child's configured primary; wait for native terminal failure proof"
							: "429 repeated child primary request; records a native retry-loop/duplicate failure"
						return mockFailure(bodyModel, `delegation-first-${index}`)
					}
					if (bodyModel === CHILD_BACKUP_ID) {
						childBackupAttempts.set(sessionID, (childBackupAttempts.get(sessionID) ?? 0) + 1)
						if (state.scenario === "no-chain") observation.originErrors.push("no-chain child unexpectedly selected a backup")
						if (state.scenario === "background" && !state.resumeTaskIssued) observation.originErrors.push("background child backup ran before explicit parent task_id resume")
						if (state.scenario === "foreground" && !state.initialTaskIssued) observation.originErrors.push("foreground child recovery began before parent task invocation")
						if (observation.originErrors.length) {
						originFailures.push({ ...observation, row, requestOrigin: url.origin })
						observation.responsePlan = "refused: fallback request occurred without the authorized child recovery path"
						return Response.json({ error: { message: "QA refused an unauthorized delegated fallback request." } }, { status: 403 })
						}
					observation.status = 200
					observation.responsePlan = state.scenario === "foreground"
						? "same-child foreground fallback succeeds"
						: "same-child explicit background task_id resume fallback succeeds"
					const text = state.scenario === "foreground" ? FOREGROUND_CHILD_SUCCESS : BACKGROUND_CHILD_SUCCESS
					return completion(bodyModel, `delegation-child-success-${index}`, text, body.stream === true)
				}
					observation.originErrors.push(`child selected a nonconfigured model ${String(bodyModel)}`)
					originFailures.push({ ...observation, row, requestOrigin: url.origin })
					observation.responsePlan = "refused: child model is outside its configured primary/fallback chain"
					return Response.json({ error: { message: "QA refused an unconfigured child model." } }, { status: 403 })
				}

				if (role !== "parent" || !state || !sessionID) {
					observation.status = 403
					observation.responsePlan = "refused: unowned request"
					return Response.json({ error: { message: "QA refused an unowned session." } }, { status: 403 })
				}
				if (bodyModel !== PARENT_MODEL_ID) {
					observation.originErrors.push("parent attempted a model outside its explicit no-fallback assignment")
					originFailures.push({ ...observation, row, requestOrigin: url.origin })
					observation.responsePlan = "refused: root model changed or used a fallback"
					return Response.json({ error: { message: "QA refused a non-parent model request." } }, { status: 403 })
				}

				const taskName = observation.toolNames.find((name) => name.toLowerCase() === "task")
				if (state.scenario === "foreground") {
					if (!state.initialTaskIssued) {
						state.initialTaskIssued = true
						const args: RecordValue = {
							subagent_type: "explore",
							description: "Recover one failed foreground Explore child",
							prompt: `Inspect no files; reply exactly ${FOREGROUND_CHILD_SUCCESS}. ${FOREGROUND_CHILD}`,
							load_skills: [],
							run_in_background: false,
						}
						return issueTaskCall(observation, state, args, "one foreground task call starts the owned child")
					}
					observation.responsePlan = "parent consumes the one successful foreground task result"
					if (results.length !== 1 || !results[0]?.includes(FOREGROUND_CHILD_SUCCESS)) routeFailures.push(`foreground parent expected one successful task result, got ${JSON.stringify(results)}`)
					observation.status = 200
					return completion(bodyModel, `foreground-parent-${index}`, FOREGROUND_PARENT_SUCCESS, body.stream === true)
				}
				if (state.scenario === "background") {
					const explicitResumeInBody = users.some((text) => text.includes(BACKGROUND_PARENT_RESUME))
					if (state.resumeRequested && explicitResumeInBody && !state.resumeTaskIssued) {
						state.resumeTaskIssued = true
						const childID = state.childID ?? childRows(databasePath, canonicalProject, state.sessionID)[0]?.id
						if (!childID || !state.backgroundFailureVerified) {
							const message = `Explicit background resume lacked verified failed child/witness (child=${String(childID)})`
							routeFailures.push(message)
							observation.responsePlan = `fixture failure: ${message}`
							return Response.json({ error: { message } }, { status: 500 })
						}
						const args: RecordValue = {
							task_id: childID,
							description: "Continue the exact failed background child using its configured fallback",
							prompt: `Continue the same task and reply exactly ${BACKGROUND_CHILD_SUCCESS}. ${BACKGROUND_CHILD_RESUME}`,
							load_skills: [],
							run_in_background: false,
						}
						return issueTaskCall(observation, state, args, `explicit task_id=${childID} resumes the failed background child`)
					}
					if (state.resumeTaskIssued) {
						observation.responsePlan = "parent consumes the explicit same-child fallback resume result"
						if (results.length !== 1 || !results[0]?.includes(BACKGROUND_CHILD_SUCCESS)) routeFailures.push(`background resume parent expected one successful task result, got ${JSON.stringify(results)}`)
						observation.status = 200
						return completion(bodyModel, `background-parent-resume-${index}`, BACKGROUND_PARENT_SUCCESS, body.stream === true)
					}
					if (!state.initialTaskIssued) {
						state.initialTaskIssued = true
						const args: RecordValue = {
							subagent_type: "explore",
							description: "Start one background Explore child that will fail its configured primary",
							prompt: `Inspect no files; first attempt should fail, then wait for parent resume. ${BACKGROUND_CHILD}`,
							load_skills: [],
							run_in_background: true,
						}
						return issueTaskCall(observation, state, args, "one background task call starts the child without recovery")
					}
					state.parentFollowups += 1
					state.parentSawFailureNotice ||= observation.failureNoticeInBody
					observation.responsePlan = "parent acknowledges/awaits the native failure notification; no implicit retry tool call"
					observation.status = 200
					return completion(bodyModel, `background-no-auto-retry-${index}`, "The background child is still the same task; wait for an explicit parent instruction.", body.stream === true)
				}
				if (!state.initialTaskIssued) {
					state.initialTaskIssued = true
					const args: RecordValue = {
						subagent_type: "librarian",
						description: "Run one child without a configured fallback chain",
						prompt: `Inspect no files and report the provider failure without retrying. ${NO_CHAIN_CHILD}`,
						load_skills: [],
						run_in_background: false,
					}
					return issueTaskCall(observation, state, args, "one no-chain foreground task call starts a Librarian child")
				}
				observation.responsePlan = "parent reports the genuine no-chain child error"
				observation.status = 200
				return completion(bodyModel, `no-chain-parent-${index}`, NO_CHAIN_PARENT_SUCCESS, body.stream === true)
			},
		})
		mock = mockServer
		mockOrigin = `http://127.0.0.1:${mockServer.port}`
		const configuredProject = JSON.parse(JSON.stringify(projectConfig)) as RecordValue
		const provider = configuredProject.provider as RecordValue
		const localProvider = provider[PROVIDER] as RecordValue
		const providerOptions = localProvider.options as RecordValue
		providerOptions.baseURL = `${mockOrigin}/v1`
		await writeFile(join(project, "opencode.json"), `${JSON.stringify(configuredProject, null, 2)}\n`)
		await writeFile(join(project, ".omo", "omo.jsonc"), `${JSON.stringify(omoConfig, null, 2)}\n`)
		await writeFile(join(originPlugin, "index.js"), localProbeSource(mockOrigin), "utf8")
		const redactedProject = JSON.parse(JSON.stringify(configuredProject)) as RecordValue
		const redactedLocalProvider = (redactedProject.provider as RecordValue)[PROVIDER] as RecordValue
		(redactedLocalProvider.options as RecordValue).apiKey = "[redacted-fake-key]"
		await writeFile(join(EVIDENCE, "config-redacted.json"), `${JSON.stringify({ opencode: redactedProject, omo: omoConfig }, null, 2)}\n`)
		beforeSessionCount = sessionCount(databasePath)

		const versionResult = Bun.spawnSync([CLI, "--version"], { cwd: serverCwd, env: openCodeEnvironment, stdout: "pipe", stderr: "pipe" })
		version = new TextDecoder().decode(versionResult.stdout).trim()
		assert(versionResult.exitCode === 0 && version.includes("2.0.22"), `Expected isolated OpenCode 2.0.22; got ${version}`)
		assert(createHash("sha256").update(await readFile(serverPath)).digest("hex") === EXPECTED_SERVER_SHA256.toLowerCase(), "Frozen bundle changed before launch")

		const port = reservePort()
		const process = Bun.spawn([CLI, "--print-logs", "--log-level", "debug", "serve", "--hostname", "127.0.0.1", "--port", String(port)], {
			cwd: serverCwd,
			env: openCodeEnvironment,
			stdout: "pipe",
			stderr: "pipe",
		})
		const client = OpenCode.make({ baseUrl: `http://127.0.0.1:${port}`, headers: { Authorization: basicAuth(), "x-opencode-directory": canonicalProject } })
		host = { process, client, port, stdout: "", stderr: "", stdoutTask: Promise.resolve(), stderrTask: Promise.resolve() }
		host.stdoutTask = new Response(process.stdout as ReadableStream<Uint8Array>).text().then((text) => { host!.stdout = text })
		host.stderrTask = new Response(process.stderr as ReadableStream<Uint8Array>).text().then((text) => { host!.stderr = text })
		const startupDeadline = Date.now() + 25_000
		let startupError: unknown
		while (Date.now() < startupDeadline) {
			if (process.exitCode !== null) throw new Error(`OpenCode exited before ready (${process.exitCode})`)
			try { await client.server.info(); break }
			catch (error) { startupError = error; await new Promise((resolve) => setTimeout(resolve, 150)) }
		}
		assert(process.exitCode === null, `OpenCode exited during startup (${process.exitCode})`)
		assert(Date.now() < startupDeadline, `OpenCode host did not become healthy: ${String(startupError)}`)

		const activationDeadline = Date.now() + 35_000
		let activePluginIDs: string[] = []
		let pluginFailure: unknown
		while (Date.now() < activationDeadline) {
			if (process.exitCode !== null) throw new Error(`OpenCode exited during plugin activation (${process.exitCode})`)
			const plugins = await client.plugin.list()
			const failed = plugins.data.filter((plugin) => plugin.state.status === "failed")
			if (failed.length) { pluginFailure = failed; break }
			activePluginIDs = plugins.data.filter((plugin) => plugin.state.status === "active")
				.map((plugin) => plugin.id).filter((id): id is string => typeof id === "string").sort()
			if (activePluginIDs.includes("oh-my-openagent") && activePluginIDs.includes(PROBE_ID)) break
			await new Promise((resolve) => setTimeout(resolve, 150))
		}
		assert(!pluginFailure, `Plugin activation failed: ${JSON.stringify(pluginFailure)}`)
		assert(activePluginIDs.includes("oh-my-openagent") && activePluginIDs.includes(PROBE_ID), `OMO/local origin probe failed to activate: ${JSON.stringify(activePluginIDs)}`)
		checks.push({ name: "native OMO and exact-origin probe are active", passed: true, detail: activePluginIDs })

		const preflight = async (phase: string) => {
			const [providers, models, defaultModel, mcps, agents, plugins] = await Promise.all([
				client.provider.list(), client.model.list(), client.model.default(), client.mcp.list(), client.agent.list(), client.plugin.list(),
			])
			const providerIDs = providers.data.map((item) => item.id).sort()
			const modelIDs = models.data.map((item) => `${item.providerID}/${item.id}`).sort()
			const expectedModels = [PARENT_MODEL, CHILD_PRIMARY_MODEL, CHILD_BACKUP_MODEL].sort()
			const defaultRef = defaultModel.data ? `${defaultModel.data.providerID}/${defaultModel.data.id}` : undefined
			const activeMcps = mcps.data.map((item) => item.name)
			const failed = plugins.data.filter((plugin) => plugin.state.status === "failed").map((plugin) => ({ id: plugin.id, state: plugin.state }))
			const result = { phase, providerIDs, modelIDs, defaultModel: defaultRef, activeMcps, agents: agents.data.map((agent) => ({ id: agent.id, mode: agent.mode, model: agent.model })), failedPlugins: failed, location: agents.location.directory }
			preflights.push(result)
			assert(JSON.stringify(providerIDs) === JSON.stringify([PROVIDER]), `Unexpected provider catalog during ${phase}: ${JSON.stringify(providerIDs)}`)
			assert(JSON.stringify(modelIDs) === JSON.stringify(expectedModels), `Unexpected model catalog during ${phase}: ${JSON.stringify(modelIDs)}`)
			assert(defaultRef === PARENT_MODEL, `Unexpected native default during ${phase}: ${String(defaultRef)}`)
			assert(activeMcps.length === 0, `MCP catalog was not empty during ${phase}: ${JSON.stringify(activeMcps)}`)
			assert(failed.length === 0, `A plugin failed activation during ${phase}: ${JSON.stringify(failed)}`)
			assert(agents.location.directory === canonicalProject, `Agent catalog escaped project during ${phase}: ${agents.location.directory}`)
			assert(agents.data.some((agent) => agent.id === "explore") && agents.data.some((agent) => agent.id === "librarian"), `Expected Explore/Librarian absent during ${phase}`)
			return agents.data
		}
		await preflight("server-start")
		checks.push({ name: "provider catalog/default/MCP preflight is strictly local", passed: true, detail: preflights[0] })

		const addCheck = (name: string, passed: boolean, detail?: unknown) => checks.push({ name, passed, ...(detail === undefined ? {} : { detail }) })
		const createParent = async (scenario: Scenario, title: string, childPrompt: string): Promise<ParentState> => {
			await preflight(`before-create-${scenario}`)
			const session = await client.session.create({ title, location: { directory: canonicalProject } })
			const state: ParentState = {
				sessionID: session.id,
				scenario,
				childPrompt,
				childAgent: scenario === "no-chain" ? "librarian" : "explore",
				initialTaskIssued: false,
				resumeRequested: false,
				resumeTaskIssued: false,
				backgroundFailureVerified: false,
				parentTaskCalls: [],
				parentFollowups: 0,
				parentSawFailureNotice: false,
			}
			parentStates.set(session.id, state)
			parentsByScenario.set(scenario, state)
			await client.session.switchAgent({ sessionID: session.id, agent: "sisyphus" })
			await client.session.switchModel({ sessionID: session.id, model: { providerID: PROVIDER, id: PARENT_MODEL_ID } })
			const selected = await client.session.get({ sessionID: session.id })
			assert(selected.location.directory === canonicalProject && selected.agent === "sisyphus" && selected.model?.providerID === PROVIDER && selected.model.id === PARENT_MODEL_ID,
				`Parent ${scenario} did not retain exact local agent/model: ${JSON.stringify({ id: selected.id, agent: selected.agent, model: selected.model, location: selected.location })}`)
			return state
		}
		const prompt = async (state: ParentState, text: string, phase: string) => {
			await preflight(`before-${phase}`)
			const session = await client.session.get({ sessionID: state.sessionID })
			assert(session.location.directory === canonicalProject && session.agent === "sisyphus" && session.model?.providerID === PROVIDER && session.model.id === PARENT_MODEL_ID,
				`Parent changed local model/agent before ${phase}`)
			await within(`${phase} prompt admission`, client.session.prompt({ sessionID: state.sessionID, text }), 30_000)
			await within(`${phase} parent completion`, client.session.wait({ sessionID: state.sessionID }))
			const current = await client.session.get({ sessionID: state.sessionID })
			return { id: current.id, outcome: current.outcome, agent: current.agent, model: current.model, location: current.location }
		}
		const childFor = (state: ParentState): ParentRow[] => childRows(databasePath, canonicalProject, state.sessionID)
		const childContext = async (state: ParentState, childID: string): Promise<RecordValue[]> => contextMessages(await client.session.context({ sessionID: childID }))
		const parentContext = async (state: ParentState): Promise<RecordValue[]> => contextMessages(await client.session.context({ sessionID: state.sessionID }))
		const waitChildOutcome = async (state: ParentState, childID: string, outcome: "succeeded" | "failed") => await waitFor(
			`${state.scenario} child ${outcome}`,
			async () => {
				const current = await client.session.get({ sessionID: childID })
				return current.outcome === outcome ? current : undefined
			},
		)

		// Foreground: the native task alias is called once; the OMO wrapper may
		// internally retry only that same child after its own proven 429.
		const foreground = await createParent("foreground", "native foreground delegated recovery QA", FOREGROUND_CHILD)
		const foregroundParentResult = await prompt(foreground, `${FOREGROUND_PARENT} Run one foreground Explore task: ${FOREGROUND_CHILD}. Do not invoke more than one task.`, FOREGROUND_PARENT)
		const foregroundChildren = childFor(foreground)
		addCheck("foreground parent completed the original turn", foregroundParentResult.outcome === "succeeded", foregroundParentResult)
		addCheck("foreground call created exactly one owned Explore child", foregroundChildren.length === 1 && foregroundChildren[0]?.agent === "explore" && foregroundChildren[0]?.parentID === foreground.sessionID, foregroundChildren)
		const foregroundChildID = foregroundChildren[0]?.id
		if (foregroundChildID) {
			foreground.childID = foregroundChildID
			const child = await waitChildOutcome(foreground, foregroundChildID, "succeeded")
			const childCalls = observations.filter((item) => item.sessionID === foregroundChildID && item.kind === "primary")
			const childRowsFinal = childFor(foreground)
			const context = await childContext(foreground, foregroundChildID)
			const parentMessages = await parentContext(foreground)
			const taskStates = toolStates(parentMessages, "task")
			const parentTurnResult = observations.filter((item) => item.sessionID === foreground.sessionID && item.kind === "primary")
				.find((item) => item.toolResults.some((value) => value.includes(FOREGROUND_CHILD_SUCCESS)))
			const childUsers = userHistory(context)
			const taskCall = foreground.parentTaskCalls[0]
			addCheck("foreground 429 and backup success are requests from the same native child", childCalls.length === 2 &&
				childCalls[0]?.model === CHILD_PRIMARY_ID && childCalls[0]?.status === SUCCESS_ERROR_STATUS &&
				childCalls[1]?.model === CHILD_BACKUP_ID && childCalls[1]?.status === 200 &&
				childCalls[0]?.sessionID === childCalls[1]?.sessionID && childCalls.every((item) => item.parentID === foreground.sessionID && item.agent === "explore" && item.originErrors.length === 0), childCalls)
			addCheck("foreground fallback preserves the configured child backup selection", child.model?.providerID === PROVIDER && child.model.id === CHILD_BACKUP_ID &&
				rowModel(childRowsFinal[0]?.model) === CHILD_BACKUP_MODEL, { child, row: childRowsFinal[0], requests: childCalls })
			addCheck("foreground parent issued one task call and consumed one successful tool result", foreground.parentTaskCalls.length === 1 &&
				foreground.parentTaskCalls[0]?.args.subagent_type === "explore" && foreground.parentTaskCalls[0]?.args.run_in_background === false &&
				taskStates.length === 1 && taskStates[0]?.status === "completed" && taskStates[0]?.output.includes(FOREGROUND_CHILD_SUCCESS) &&
				parentTurnResult?.toolResults.length === 1 && parentTurnResult.toolResults[0]?.includes(FOREGROUND_CHILD_SUCCESS),
				{ modelTaskCalls: foreground.parentTaskCalls, nativeTaskStates: taskStates, parentRequestResults: parentTurnResult?.toolResults })
			addCheck("foreground does not replay the parent payload into the child", childUsers.filter((text) => text.includes(FOREGROUND_CHILD)).length === 1 &&
				childUsers.every((text) => !text.includes(FOREGROUND_PARENT)), { childUsers, parentMarkerOccurrences: childUsers.filter((text) => text.includes(FOREGROUND_PARENT)).length })
			addCheck("foreground original parent user payload appears once in its native history", userHistory(parentMessages).filter((text) => text.includes(FOREGROUND_PARENT)).length === 1, userHistory(parentMessages))
		} else {
			addCheck("foreground child was created", false, foregroundChildren)
		}

		// Background: wait for the native error notification and a durable witness,
		// then require the parent model to issue an explicit task_id resume. No
		// detached child retry is allowed before that tool call.
		const background = await createParent("background", "native background delegated recovery QA", BACKGROUND_CHILD)
		const backgroundParentResult = await prompt(background, `${BACKGROUND_PARENT} Start one background Explore task: ${BACKGROUND_CHILD}. Do not resume it automatically.`, BACKGROUND_PARENT)
		let backgroundChildren = childFor(background)
		if (backgroundChildren.length !== 1) {
			backgroundChildren = await waitFor("one native background Explore child", async () => {
				const rows = childFor(background)
				return rows.length === 1 ? rows : undefined
			})
		}
		const backgroundChildID = backgroundChildren[0]?.id
		addCheck("background task created exactly one owned Explore child", backgroundChildren.length === 1 && backgroundChildren[0]?.agent === "explore" && backgroundChildren[0]?.parentID === background.sessionID, backgroundChildren)
		if (backgroundChildID) {
			background.childID = backgroundChildID
			const failedChild = await waitChildOutcome(background, backgroundChildID, "failed")
			const errorContext = await childContext(background, backgroundChildID)
			const backgroundParentContext = await parentContext(background)
			const errorNotice = syntheticFailureNotice(backgroundParentContext, backgroundChildID)
			const nativeErrors = assistantFailures(errorContext)
			const failureSettings = delegationSettings(databasePath, backgroundChildID)
			const witness = isRecord(failureSettings?.failureWitness) ? failureSettings.failureWitness : undefined
			const witnessModel = isRecord(witness?.model) ? `${String(witness.model.providerID)}/${String(witness.model.id)}` : undefined
			const witnessedError = witness ? nativeErrors.find((item) => item.id === witness.assistantMessageID) : undefined
			background.backgroundFailureVerified = Boolean(errorNotice && witness && witness.sessionID === backgroundChildID &&
				witness.parentSessionID === background.sessionID && witness.agentID === "explore" && witness.status === SUCCESS_ERROR_STATUS &&
				witness.responseStatus === SUCCESS_ERROR_STATUS && witness.background === true && typeof witness.userMessageID === "string" &&
				typeof witness.assistantMessageID === "string" && typeof witness.errorType === "string" && witness.errorType.startsWith("provider.") &&
				witnessModel === CHILD_PRIMARY_MODEL && typeof witness.requestAt === "number" && typeof witness.idle === "number" &&
				isRecord(witnessedError?.error) && witnessedError.error.type === witness.errorType && witnessedError.error.status === SUCCESS_ERROR_STATUS)
			const failedChildRequests = observations.filter((item) => item.sessionID === backgroundChildID && item.kind === "primary")
			const noBackupBeforeResume = (childBackupAttempts.get(backgroundChildID) ?? 0) === 0
			addCheck("background child preserves its native provider error and failure witness", failedChild.outcome === "failed" && nativeErrors.some((item) => isRecord(item.error) &&
				typeof item.error.type === "string" && item.error.type.startsWith("provider.") && item.error.status === SUCCESS_ERROR_STATUS) &&
				witness?.status === SUCCESS_ERROR_STATUS && witness?.responseStatus === SUCCESS_ERROR_STATUS && witness?.background === true &&
				witnessModel === CHILD_PRIMARY_MODEL && witnessedError !== undefined,
				{ failedChild, nativeErrors, witness, witnessModel, witnessedError })
			addCheck("background child emits native error notification to its parent", Boolean(errorNotice), { childID: backgroundChildID, errorNotice, parentSyntheticMessages: backgroundParentContext.filter((item) => item.type === "synthetic") })
			addCheck("background child receives no detached fallback before explicit resume", noBackupBeforeResume &&
				failedChildRequests.length === 1 && failedChildRequests[0]?.model === CHILD_PRIMARY_ID && failedChildRequests[0]?.status === SUCCESS_ERROR_STATUS,
				{ childRequestsBeforeResume: failedChildRequests, backupAttempts: childBackupAttempts.get(backgroundChildID) ?? 0 })
			addCheck("background launch returned a native task result without hidden resume", backgroundParentResult.outcome === "succeeded" &&
				background.parentTaskCalls.length === 1 && background.parentTaskCalls[0]?.args.run_in_background === true &&
				background.parentTaskCalls[0]?.args.task_id === undefined,
				{ parent: backgroundParentResult, initialTaskCalls: background.parentTaskCalls, autoNotificationFollowups: background.parentFollowups, parentSawFailureNotice: background.parentSawFailureNotice })

			// Ensure any native parent notification turn has settled before the
			// explicit user turn; it must not itself issue a retry task call.
			await within("background parent notification turn settle", client.session.wait({ sessionID: background.sessionID }), 30_000)
			const parentCallsBeforeExplicitResume = background.parentTaskCalls.length
			addCheck("background error notification did not auto-issue a parent resume call", parentCallsBeforeExplicitResume === 1 && noBackupBeforeResume,
				{ taskCalls: background.parentTaskCalls, backupAttempts: childBackupAttempts.get(backgroundChildID) ?? 0, parentFollowups: background.parentFollowups })
			background.backgroundFailureVerified = Boolean(background.backgroundFailureVerified && errorNotice)
			background.resumeRequested = true
			await prompt(background, `${BACKGROUND_PARENT_RESUME} Explicitly resume the failed child session ${backgroundChildID} with task_id and finish its original delegated work.`, BACKGROUND_PARENT_RESUME)
			const resumedChildren = childFor(background)
			const resumedSession = await client.session.get({ sessionID: backgroundChildID })
			const resumedCalls = observations.filter((item) => item.sessionID === backgroundChildID && item.kind === "primary")
			const resumedParentContext = await parentContext(background)
			const resumedTaskStates = toolStates(resumedParentContext, "task")
			const explicitTaskCall = background.parentTaskCalls.find((entry) => entry.args.task_id === backgroundChildID)
			const explicitParentRequest = observations.filter((item) => item.sessionID === background.sessionID && item.kind === "primary")
				.find((item) => item.latestUser?.includes(BACKGROUND_PARENT_RESUME) && item.toolResults.some((value) => value.includes(BACKGROUND_CHILD_SUCCESS)))
			addCheck("explicit task_id fallback resumes the same failed child on its configured backup", resumedChildren.length === 1 && resumedChildren[0]?.id === backgroundChildID &&
				resumedSession.id === backgroundChildID && resumedSession.parentID === background.sessionID && resumedSession.agent === "explore" &&
				resumedSession.outcome === "succeeded" && rowModel(resumedChildren[0]?.model) === CHILD_BACKUP_MODEL &&
				resumedCalls.length === 2 && resumedCalls[0]?.model === CHILD_PRIMARY_ID && resumedCalls[0]?.status === SUCCESS_ERROR_STATUS &&
				resumedCalls[1]?.model === CHILD_BACKUP_ID && resumedCalls[1]?.status === 200 && resumedCalls.every((item) => item.sessionID === backgroundChildID && item.originErrors.length === 0),
				{ children: resumedChildren, session: resumedSession, requests: resumedCalls })
			addCheck("parent explicitly resumed the exact child and consumed one successful task result", background.parentTaskCalls.length === 2 &&
				background.parentTaskCalls[1]?.args.task_id === backgroundChildID && background.parentTaskCalls[1]?.args.subagent_type === undefined &&
				background.parentTaskCalls[1]?.args.category === undefined && explicitTaskCall !== undefined &&
				resumedTaskStates.length === 2 && resumedTaskStates[0]?.status !== "error" &&
				resumedTaskStates[1]?.status === "completed" && resumedTaskStates[1]?.output.includes(BACKGROUND_CHILD_SUCCESS) &&
				explicitParentRequest?.toolResults.length === 1 && explicitParentRequest.toolResults[0]?.includes(BACKGROUND_CHILD_SUCCESS),
				{ modelTaskCalls: background.parentTaskCalls, nativeTaskStates: resumedTaskStates, parentTurnResults: explicitParentRequest?.toolResults })
			const resumedChildUsers = userHistory(await childContext(background, backgroundChildID))
			addCheck("background resume does not duplicate the original child task prompt", resumedChildUsers.filter((text) => text.includes(BACKGROUND_CHILD)).length === 1 &&
				resumedChildUsers.every((text) => !text.includes(BACKGROUND_PARENT)), resumedChildUsers)
		} else {
			addCheck("background child was created", false, backgroundChildren)
		}

		// Negative case: a delegated agent with no configured fallback must keep
		// the native failure and must not inherit a parent/default backup.
		const noChain = await createParent("no-chain", "native delegated no-fallback chain QA", NO_CHAIN_CHILD)
		const noChainParentResult = await prompt(noChain, `${NO_CHAIN_PARENT} Run one foreground Librarian task with no fallback configured.`, NO_CHAIN_PARENT)
		const noChainChildren = childFor(noChain)
		addCheck("no-chain task created exactly one owned Librarian child", noChainChildren.length === 1 && noChainChildren[0]?.agent === "librarian" && noChainChildren[0]?.parentID === noChain.sessionID, noChainChildren)
		if (noChainChildren[0]?.id) {
			const childID = noChainChildren[0].id
			const failedChild = await waitChildOutcome(noChain, childID, "failed")
			const requests = observations.filter((item) => item.sessionID === childID && item.kind === "primary")
			const context = await childContext(noChain, childID)
			const taskState = toolStates(await parentContext(noChain), "task")
			addCheck("no-chain child returns its original provider failure without selecting an unrelated backup", failedChild.outcome === "failed" &&
				requests.length === 1 && requests[0]?.model === CHILD_PRIMARY_ID && requests[0]?.status === SUCCESS_ERROR_STATUS &&
				(childBackupAttempts.get(childID) ?? 0) === 0 && assistantFailures(context).some((item) => isRecord(item.error) && item.error.status === SUCCESS_ERROR_STATUS),
				{ failedChild, requests, errors: assistantFailures(context), backupAttempts: childBackupAttempts.get(childID) ?? 0 })
			addCheck("no-chain parent receives exactly one failed task result and can report it", noChainParentResult.outcome === "succeeded" &&
				noChain.parentTaskCalls.length === 1 && taskState.length === 1 && taskState[0]?.status === "error" &&
				noChain.parentTaskCalls[0]?.args.subagent_type === "librarian",
				{ parent: noChainParentResult, taskCalls: noChain.parentTaskCalls, toolState: taskState })
		}

		const allRequestsLocal = observations.length > 0 && observations.every((item) => item.originErrors.length === 0 &&
			item.provider === PROVIDER && item.model === item.bodyModel && MODEL_IDS.includes(item.model as (typeof MODEL_IDS)[number]))
		addCheck("all primary and auxiliary requests have exact local session/model attribution", allRequestsLocal, observations)
		addCheck("fixture did not attempt unconfigured network or native MCP calls", originFailures.length === 0 && routeFailures.length === 0 &&
			preflights.every((item) => Array.isArray(item.activeMcps) && item.activeMcps.length === 0), { originFailures, routeFailures, preflights })
		addCheck("parent requests stayed on the model with no fallback chain", observations.filter((item) => item.role === "parent").every((item) => item.model === PARENT_MODEL_ID),
			observations.filter((item) => item.role === "parent").map((item) => ({ sessionID: item.sessionID, model: item.model, scenario: item.scenario })))
	} catch (error) {
		failure = error instanceof Error ? error.stack ?? error.message : String(error)
	} finally {
		serverShutdown = await stopHost(host?.process)
		if (mock) { mock.stop(true); mockStopped = true }
		await host?.stdoutTask
		await host?.stderrTask
		afterSessionCount = sessionCount(databasePath)
		const sourceFiles = [
			"packages/omo-opencode/src/v2/runtime-fallback.ts",
			"packages/omo-opencode/src/v2/delegation-admission.ts",
			"packages/omo-opencode/src/v2/delegation-settings.ts",
			"packages/omo-opencode/src/v2/delegation.ts",
		]
		const sourceHashes: Record<string, string> = {}
		for (const file of sourceFiles) {
			try { sourceHashes[file] = createHash("sha256").update(await readFile(join(ROOT, file))).digest("hex") }
			catch { sourceHashes[file] = "missing" }
		}
		const head = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: ROOT, stdout: "pipe", stderr: "pipe" }).stdout.toString().trim()
		const driverSHA = createHash("sha256").update(await readFile(join(ROOT, "script/opencode2-delegation-runtime-recovery-qa.ts"))).digest("hex")
		const cleanup = {
			openCodeStopped: serverShutdown.stopped,
			openCodeExitCode: serverShutdown.exitCode,
			mockStopped,
			temporaryFixturePreserved: existsSync(tempRoot),
			databaseSessionCountBefore: beforeSessionCount,
			databaseSessionCountAfter: afterSessionCount,
		}
		checks.push({ name: "only fixture-owned host/mock stopped and isolated database retained", passed:
			serverShutdown.stopped && mockStopped && existsSync(tempRoot) && beforeSessionCount === 0 && (afterSessionCount ?? 0) > 0, detail: cleanup })
		const runtime = {
			purpose: "Native foreground/background delegated provider-failure recovery on OpenCode 2.0.22 using localhost-only model endpoints.",
			startedAt: runResult.startedAt,
			finishedAt: new Date().toISOString(),
			cli: CLI,
			opencodeVersion: version,
			bundle: { serverPath, sha256: bundleSHA, expectedSha256: EXPECTED_SERVER_SHA256 },
			gitHead: head,
			driverSha256: driverSHA,
			sourceHashes,
			mockOrigin,
			projectDirectory: canonicalProject,
			temporaryRoot: tempRoot,
			databasePath,
			isolatedEnvironment: { home, xdgData, xdgConfig, xdgState, xdgCache, omoHome, claudeConfig, claudePlugins },
			localCatalog: [PARENT_MODEL, CHILD_PRIMARY_MODEL, CHILD_BACKUP_MODEL],
			configuredDefaultModel: PARENT_MODEL,
			fallbackPolicy: { enabled: true, retryOnErrors: [SUCCESS_ERROR_STATUS], maxFallbackAttempts: 1, nativeRetrySuppressedByQaProbe: true },
			preflights,
			parents: Array.from(parentStates.values()).map((state) => ({
				sessionID: state.sessionID,
				scenario: state.scenario,
				childID: state.childID,
				parentTaskCalls: state.parentTaskCalls,
				parentFollowups: state.parentFollowups,
				parentSawFailureNotice: state.parentSawFailureNotice,
				backgroundFailureVerified: state.backgroundFailureVerified,
				resumeTaskIssued: state.resumeTaskIssued,
			})),
			requests: observations,
			originFailures,
			routeFailures,
			checks,
			passed: !failure && checks.length > 0 && checks.every((check) => check.passed),
			failure,
			cleanup,
		}
		await Promise.all([
			writeFile(join(EVIDENCE, "runtime.json"), `${JSON.stringify(runtime, null, 2)}\n`),
			writeFile(join(EVIDENCE, "server.log"), redact(`${host?.stdout ?? ""}\n--- stderr ---\n${host?.stderr ?? ""}`), "utf8"),
			writeFile(join(EVIDENCE, "mock-requests.json"), `${JSON.stringify(observations, null, 2)}\n`),
			writeFile(join(EVIDENCE, "commands.txt"), [
				`OPENCODE2_CLI=${CLI}`,
				`OPENCODE2_EXPECTED_SERVER_SHA256=${EXPECTED_SERVER_SHA256}`,
				`OPENCODE2_PLUGIN_DIR=${PLUGIN_DIR}`,
				`OPENCODE2_DELEGATION_RECOVERY_EVIDENCE_DIR=${EVIDENCE}`,
				`serverSha256=${bundleSHA}`,
				`version=${version}`,
				`temporaryRoot=${tempRoot}`,
				`project=${canonicalProject}`,
				`database=${databasePath}`,
				"OpenCode received only isolated HOME/XDG/OMO/Claude paths, an allowlisted local provider, and fake credentials.",
				"The retry probe disables native retry for primary requests to make the OMO failure witness deterministic; this is not a test of native retry policy.",
			].join("\n") + "\n"),
		])
	}
	if (failure || !checks.length || checks.some((check) => !check.passed)) {
		throw new Error(`Delegated runtime recovery QA failed; inspect ${join(EVIDENCE, "runtime.json")}${failure ? `: ${failure}` : ""}`)
	}
	process.stdout.write(`${JSON.stringify({ evidence: EVIDENCE, passed: true, checkCount: checks.length, bundleSHA, cleanup: { serverShutdown, mockStopped, temporaryRoot: tempRoot } }, null, 2)}\n`)
}

if (import.meta.main) await main()
