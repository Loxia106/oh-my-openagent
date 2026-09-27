/**
 * Isolated native OpenCode 2.0.18 QA for OMO's todo, plan, and agent-use hooks.
 * Run only after a reviewed `build:opencode2` freeze:
 * OPENCODE2_CLI=/absolute/path/to/opencode \
 * OPENCODE2_EXPECTED_SERVER_SHA256=<64-hex-sha256> \
 * bun script/opencode2-advisory-hooks-qa.ts
 * Optionally set OPENCODE2_QA_EVIDENCE_DIR to one direct child of .omo/evidence/.
 */
import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { tmpdir } from "node:os"
import { Database } from "bun:sqlite"
import { OpenCode } from "@opencode/client"
import { REMINDER_MESSAGE } from "../packages/omo-opencode/src/hooks/agent-usage-reminder/constants"
import { TODOWRITE_DESCRIPTION } from "../packages/omo-opencode/src/hooks/todo-description-override/description"

const ROOT = resolve(import.meta.dir, "..")
const EVIDENCE_ROOT = join(ROOT, ".omo", "evidence")
const EVIDENCE = resolve(process.env.OPENCODE2_QA_EVIDENCE_DIR ?? join(EVIDENCE_ROOT, "20260927-advisory-hooks"))
const PLUGIN_DIR = resolve(process.env.OPENCODE2_PLUGIN_DIR ?? join(ROOT, "dist", "opencode2"))
const CLI_INPUT = process.env.OPENCODE2_CLI?.trim() ?? ""
const CLI = CLI_INPUT ? resolve(CLI_INPUT) : ""
const EXPECTED_SERVER_SHA256 = process.env.OPENCODE2_EXPECTED_SERVER_SHA256 ?? ""
const PASSWORD = "advisory-hooks-local-qa-only"
const API_KEY = "advisory-hooks-mock-key-only"
const PROVIDER = "omoqa"
const MODEL = "qa-model"
const TIMEOUT_MS = 60_000
const CHILD_MARKER = "OMO_ADVISORY_CHILD_QA"

type ModelRequest = {
	model: string
	marker: string
	sessionID?: string
	kind?: string
	sessionDirectory?: string
	sessionParentID?: string | null
	sessionAgent?: string | null
	sessionModel?: string
	role: "parent" | "child" | "auxiliary" | "other"
	originValid: boolean
	toolNames: string[]
	toolResultTexts: string[]
	stream: boolean
	action: string
	todowriteDescription?: string
	todowriteParameters?: unknown
}

type NativeToolState = { name: string; status: string; outputText: string }
type ToolDefinition = { name: string; description: string; parameters: unknown }
type HostRun = {
	phase: string
	port: number
	serverCommand: string[]
	databasePath: string
	child: Bun.Subprocess
	client: ReturnType<typeof OpenCode.make>
	stdout: string
	stderr: string
	stdoutTask: Promise<void>
	stderrTask: Promise<void>
}

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message)
}

function redact(text: string): string {
	return text.replaceAll(PASSWORD, "[redacted-test-password]").replaceAll(API_KEY, "[redacted-test-api-key]")
}

function basicAuth(): string {
	return `Basic ${Buffer.from(`opencode:${PASSWORD}`).toString("base64")}`
}

async function within<T>(label: string, promise: Promise<T>, timeoutMs = TIMEOUT_MS): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined
	try {
		return await Promise.race([
			promise,
			new Promise<T>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs)
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
	assert(typeof port === "number", "Could not reserve an isolated localhost port")
	return port
}

function responseText(value: unknown): string {
	if (typeof value === "string") return value
	if (!Array.isArray(value)) return ""
	return value.flatMap((part) => {
		if (!part || typeof part !== "object") return []
		const text = (part as Record<string, unknown>).text
		return typeof text === "string" ? [text] : []
	}).join("\n")
}

function toolNames(body: Record<string, unknown>): string[] {
	if (!Array.isArray(body.tools)) return []
	return body.tools.flatMap((entry) => {
		if (!entry || typeof entry !== "object") return []
		const row = entry as Record<string, unknown>
		const fn = row.function && typeof row.function === "object" ? row.function as Record<string, unknown> : undefined
		const name = typeof row.name === "string" ? row.name : typeof fn?.name === "string" ? fn.name : undefined
		return name ? [name] : []
	})
}

function findTool(body: Record<string, unknown>, expected: string): ToolDefinition | undefined {
	if (!Array.isArray(body.tools)) return undefined
	for (const entry of body.tools) {
		if (!entry || typeof entry !== "object") continue
		const row = entry as Record<string, unknown>
		const fn = row.function && typeof row.function === "object" ? row.function as Record<string, unknown> : row
		if (typeof fn.name !== "string" || fn.name.toLowerCase() !== expected.toLowerCase()) continue
		return {
			name: fn.name,
			description: typeof fn.description === "string" ? fn.description : "",
			parameters: fn.parameters,
		}
	}
	return undefined
}

function toolResultTexts(body: Record<string, unknown>): string[] {
	if (!Array.isArray(body.messages)) return []
	return body.messages.flatMap((message) => {
		if (!message || typeof message !== "object") return []
		const row = message as Record<string, unknown>
		return row.role === "tool" ? [responseText(row.content)] : []
	})
}

function nativeToolStates(messages: unknown): NativeToolState[] {
	if (!Array.isArray(messages)) return []
	return messages.flatMap((message) => {
		if (!message || typeof message !== "object") return []
		const content = (message as Record<string, unknown>).content
		if (!Array.isArray(content)) return []
		return content.flatMap((part) => {
			if (!part || typeof part !== "object") return []
			const record = part as Record<string, unknown>
			if (record.type !== "tool" || typeof record.name !== "string" || !record.state || typeof record.state !== "object") return []
			const state = record.state as Record<string, unknown>
			return [{
				name: record.name,
				status: typeof state.status === "string" ? state.status : "unknown",
				outputText: responseText(state.output ?? state.content),
			}]
		})
	})
}

function stableJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`
	if (typeof value === "object" && value !== null) {
		const record = value as Record<string, unknown>
		return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`
	}
	return JSON.stringify(value) ?? "undefined"
}

function countOccurrences(haystack: string, needle: string): number {
	if (!needle) return 0
	return haystack.split(needle).length - 1
}

function sse(body: unknown[]): Response {
	return new Response(`${body.map((item) => `data: ${JSON.stringify(item)}\n\n`).join("")}data: [DONE]\n\n`, {
		headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive" },
	})
}

function toolCallResponse(name: string, args: unknown, id: string, model: string, stream: boolean): Response {
	const created = Math.floor(Date.now() / 1000)
	const call = { index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } }
	if (!stream) return Response.json({
		id: `chatcmpl-${id}`, object: "chat.completion", created, model,
		choices: [{ index: 0, message: { role: "assistant", content: null, tool_calls: [call] }, finish_reason: "tool_calls" }],
		usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
	})
	return sse([
		{ id: `chatcmpl-${id}`, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [call] }, finish_reason: null }] },
		{ id: `chatcmpl-${id}`, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
	])
}

function textResponse(text: string, id: string, model: string, stream: boolean): Response {
	const created = Math.floor(Date.now() / 1000)
	if (!stream) return Response.json({
		id: `chatcmpl-${id}`, object: "chat.completion", created, model,
		choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
		usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
	})
	return sse([
		{ id: `chatcmpl-${id}`, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] },
		{ id: `chatcmpl-${id}`, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
	])
}

function sessionCount(databasePath: string): number | null {
	if (!existsSync(databasePath)) return 0
	try {
		const db = new Database(databasePath, { readonly: true, create: false })
		try {
			const row = db.query("SELECT COUNT(*) AS count FROM session_v2").get() as { count?: number } | null
			return typeof row?.count === "number" ? row.count : null
		} finally { db.close() }
	} catch { return null }
}

function selectedModel(value: unknown): string | undefined {
	if (!value || typeof value !== "object") return undefined
	const model = value as { providerID?: unknown; id?: unknown }
	return typeof model.providerID === "string" && typeof model.id === "string" ? `${model.providerID}/${model.id}` : undefined
}

type SessionOrigin = { id: string; parentID: string | null; directory: string; model: string | null; agent: string | null }
const REQUEST_KINDS = new Set(["primary", "compaction", "title", "generate"])

function sessionOrigin(databasePaths: Record<string, string>, sessionID: string | undefined): SessionOrigin | undefined {
	if (!sessionID) return undefined
	for (const databasePath of Object.values(databasePaths)) {
		if (!existsSync(databasePath)) continue
		try {
			const db = new Database(databasePath, { readonly: true, create: false })
			try {
				const row = db.query("SELECT id, parent_id AS parentID, directory, model, agent FROM session_v2 WHERE id = ?")
					.get(sessionID) as SessionOrigin | undefined
				if (row) return row
			} finally { db.close() }
		} catch { /* A not-yet-created phase database has no session row. */ }
	}
	return undefined
}

function nativeChildren(databasePath: string, parentID: string): Array<{ id: string; parentID: string; agent: string | null }> {
	if (!existsSync(databasePath)) return []
	try {
		const db = new Database(databasePath, { readonly: true, create: false })
		try {
			return db.query("SELECT id, parent_id AS parentID, agent FROM session_v2 WHERE parent_id = ? ORDER BY time_created ASC")
				.all(parentID) as Array<{ id: string; parentID: string; agent: string | null }>
		} finally { db.close() }
	} catch { return [] }
}

async function writeOmoConfig(project: string, disabledHooks: string[]): Promise<void> {
	const config = {
		telemetry: { enabled: false },
		"[opencode]": {
			disabled_hooks: disabledHooks,
			disabled_mcps: ["websearch", "context7", "grep_app", "lsp"],
			mcp_env_allowlist: [],
			claude_code: { mcp: false },
			telemetry: false,
		},
	}
	await writeFile(join(project, ".omo", "omo.jsonc"), `${JSON.stringify(config, null, 2)}\n`)
}

async function stopHost(host: HostRun | undefined): Promise<{ phase: string; exitCode: number | null } | undefined> {
	if (!host) return undefined
	if (host.child.exitCode === null) {
		host.child.kill("SIGTERM")
		const stopped = await Promise.race([
			host.child.exited.then(() => true),
			new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5_000)),
		])
		if (!stopped && host.child.exitCode === null) {
			host.child.kill("SIGKILL")
			await host.child.exited
		}
	}
	await Promise.all([host.stdoutTask, host.stderrTask])
	return { phase: host.phase, exitCode: host.child.exitCode }
}

async function waitForReady(host: HostRun): Promise<{ agentIDs: string[]; pluginStates: unknown[]; modelIDs: string[]; providerIDs: string[]; mcpNames: string[] }> {
	const deadline = Date.now() + 35_000
	let lastAgents: string[] = []
	let lastPlugins: unknown[] = []
	while (Date.now() < deadline) {
		if (host.child.exitCode !== null) throw new Error(`${host.phase}: OpenCode exited before activation (${host.child.exitCode})`)
		try {
			await host.client.server.info()
			const [agents, plugins] = await Promise.all([host.client.agent.list(), host.client.plugin.list()])
			lastAgents = agents.data.map((agent) => agent.id)
			lastPlugins = plugins.data.map(({ id, state }) => ({ id, state }))
			const failed = plugins.data.find((plugin) => plugin.state.status === "failed")
			if (failed) throw new Error(`${host.phase}: plugin failed: ${JSON.stringify(failed)}`)
			const omoActive = plugins.data.some((plugin) => plugin.id === "oh-my-openagent" && plugin.state.status === "active")
			const originProbeActive = plugins.data.some((plugin) => plugin.id === "omo-advisory-hooks-origin-probe" && plugin.state.status === "active")
			if (lastAgents.includes("sisyphus") && omoActive && originProbeActive) {
				const [models, providers, mcps] = await Promise.all([host.client.model.list(), host.client.provider.list(), host.client.mcp.list()])
				return {
					agentIDs: lastAgents,
					pluginStates: lastPlugins,
					modelIDs: models.data.map((model) => `${model.providerID}/${model.id}`).sort(),
					providerIDs: providers.data.map((provider) => provider.id).sort(),
					mcpNames: mcps.data.map((mcp) => mcp.name),
				}
			}
		} catch (error) {
			if (error instanceof Error && error.message.includes("plugin failed")) throw error
		}
		await new Promise((resolve) => setTimeout(resolve, 150))
	}
	throw new Error(`${host.phase}: OMO agent activation timed out; agents=${JSON.stringify(lastAgents)}, plugins=${JSON.stringify(lastPlugins)}`)
}

async function main(): Promise<void> {
	assert(CLI_INPUT && isAbsolute(CLI_INPUT) && existsSync(CLI), "Set OPENCODE2_CLI to an explicit absolute path to the pinned OpenCode 2.0.18 executable")
	assert(/^[a-f0-9]{64}$/i.test(EXPECTED_SERVER_SHA256), "Set OPENCODE2_EXPECTED_SERVER_SHA256 to the expected 64-character server bundle hash")
	const evidenceRelative = relative(EVIDENCE_ROOT, EVIDENCE)
	assert(evidenceRelative !== "" && evidenceRelative !== ".." && !evidenceRelative.startsWith(`..${sep}`) && !isAbsolute(evidenceRelative) && !evidenceRelative.includes(sep),
		`Evidence path must be one direct child of ${EVIDENCE_ROOT}`)
	await mkdir(EVIDENCE_ROOT, { recursive: true })
	const evidenceRoot = await realpath(EVIDENCE_ROOT)
	await mkdir(EVIDENCE, { recursive: true })
	const evidenceDirectory = await realpath(EVIDENCE)
	assert(dirname(evidenceDirectory) === evidenceRoot, "Evidence directory escaped the repository evidence root")
	assert(existsSync(join(PLUGIN_DIR, "server.js")), `Native bundle missing: ${join(PLUGIN_DIR, "server.js")}`)
	const bundleHash = createHash("sha256").update(await readFile(join(PLUGIN_DIR, "server.js"))).digest("hex")
	assert(bundleHash === EXPECTED_SERVER_SHA256, `Bundle hash ${bundleHash} differs from required frozen hash ${EXPECTED_SERVER_SHA256}`)

	const runDirectory = join(EVIDENCE, `run-${Date.now()}`)
	await mkdir(runDirectory, { recursive: true })
	const sourcePaths = [
		"packages/omo-opencode/src/v2/todo-description-override.ts",
		"packages/omo-opencode/src/v2/plan-format-validator.ts",
		"packages/omo-opencode/src/v2/agent-usage-reminder.ts",
		"packages/omo-opencode/src/v2/hooks.ts",
		"packages/omo-opencode/src/hooks/todo-description-override/description.ts",
		"packages/omo-opencode/src/hooks/agent-usage-reminder/constants.ts",
		"packages/omo-opencode/src/hooks/plan-format-validator/hook.ts",
	]
	const sourceHashes = Object.fromEntries(await Promise.all(sourcePaths.map(async (path) => [
		path,
		createHash("sha256").update(await readFile(join(ROOT, path))).digest("hex"),
	] as const)))
	const driverPath = join(import.meta.dir, "opencode2-advisory-hooks-qa.ts")
	const driverSha256 = createHash("sha256").update(await readFile(driverPath)).digest("hex")
	const tempRoot = await realpath(await mkdtemp(join(tmpdir(), "omo-advisory-hooks-qa-")))
	const project = join(tempRoot, "project")
	const hostCwd = join(tempRoot, "server-cwd")
	const home = join(tempRoot, "home")
	const xdgData = join(tempRoot, "xdg-data")
	const xdgConfig = join(tempRoot, "xdg-config")
	const xdgState = join(tempRoot, "xdg-state")
	const xdgCache = join(tempRoot, "xdg-cache")
	const omoHome = join(tempRoot, "omo-home")
	const claudeHome = join(tempRoot, "claude-config")
	const claudePlugins = join(tempRoot, "claude-plugins")
	const databasePaths = {
		baseline: join(tempRoot, "baseline.db"),
		active: join(tempRoot, "active.db"),
		disabled: join(tempRoot, "disabled.db"),
	}
	await Promise.all([project, hostCwd, home, xdgData, xdgConfig, xdgState, xdgCache, omoHome, claudeHome, claudePlugins, join(project, ".omo", "plans"), join(project, ".omo", "outside")]
		.map((path) => mkdir(path, { recursive: true })))
	const projectCanonical = await realpath(project)
	assert(!projectCanonical.startsWith(`${ROOT}${sep}`), "QA project must be canonicalized outside the source repository")
	const planRoot = join(project, ".omo", "plans")
	const outsideRoot = join(project, ".omo", "outside")
	const originHookDirectory = join(tempRoot, "omo-advisory-origin-probe")
	const symlinkTarget = join(outsideRoot, "linked-plan.md")
	const symlinkPlan = join(planRoot, "escape.md")
	await writeFile(symlinkTarget, "# Outside Plan\n\n**Effort:** 2 days\n\n## TODOs\n- [ ] T1. Malformed row\n")
	await symlink(symlinkTarget, symlinkPlan)
	await mkdir(originHookDirectory, { recursive: true })
	await writeFile(join(originHookDirectory, "index.js"), `export default {
	  id: "omo-advisory-hooks-origin-probe",
	  setup: async ({ session }) => {
	    const registration = await session.hook("http.request", (event) => {
	      const headers = new Headers(event.request.headers)
	      headers.set("x-omo-qa-session-id", event.sessionID)
	      headers.set("x-omo-qa-kind", event.kind)
	      event.request = new Request(event.request, { headers })
	    })
	    return () => registration.dispose()
	  },
}\n`)
	const settingsPath = join(tempRoot, "claude-settings.json")
	await writeFile(settingsPath, "{}\n")
	const providerRequests: ModelRequest[] = []
	const scenarioSteps = new Map<string, number>()
	const scenarioSessions = new Map<string, string>()
	const scenarioBySession = new Map<string, string>()
	let childRequests = 0
	const originFailures: Array<Record<string, unknown>> = []
	const routeFailures: Array<Record<string, unknown>> = []
	let activeHost: HostRun | undefined
	const allHosts: HostRun[] = []
	const cleanup: Array<{ phase: string; exitCode: number | null }> = []
	const catalogPreflights: Record<string, { modelIDs: string[]; providerIDs: string[]; mcpNames: string[]; agentIDs: string[] }> = {}
	const defaultModelPreflights: Record<string, string | undefined> = {}
	const phaseConfigs: Record<string, { disabledHooks: string[]; disabledMcps: string[] }> = {}
	let mockStopped = false
	let failure: string | undefined
	const results: Record<string, unknown> = {
		gitHead: Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: ROOT, stdout: "pipe", stderr: "pipe" }).stdout.toString().trim(),
		sourceHashes,
		driverSha256,
		bundleSha256: bundleHash,
		pluginDirectory: PLUGIN_DIR,
		cli: CLI,
		tempRoot,
		projectDirectory: projectCanonical,
		projectOutsideRepository: true,
		hostCwd,
		isolation: { home, xdgData, xdgConfig, xdgState, xdgCache, omoHome, claudeHome, claudePlugins, settingsPath, databasePaths },
		environmentKeys: ["PATH", "TMPDIR", "HOME", "XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "OPENCODE_DB", "OMO_HOME", "CLAUDE_CONFIG_DIR", "CLAUDE_PLUGINS_HOME", "CLAUDE_SETTINGS_PATH", "OPENCODE_DISABLE_MODELS_FETCH", "OPENCODE_TELEMETRY_DISABLED", "OPENCODE_SERVER_PASSWORD", "OPENCODE_PASSWORD"],
		fixturePolicy: "enabled_providers contains only localhost omoqa; project model and every session are pinned to omoqa/qa-model; native/OMO MCPs disabled; fake credentials only",
	}

	const mock = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const url = new URL(request.url)
			if (url.pathname.endsWith("/models")) return Response.json({ data: [{ id: MODEL, object: "model", created: 0, owned_by: "advisory-qa" }] })
			if (!url.pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 })
			const body = await request.json() as Record<string, unknown>
			const model = typeof body.model === "string" ? body.model : ""
			const names = toolNames(body)
			const stream = body.stream === true
			const outputs = toolResultTexts(body)
			const sessionID = request.headers.get("x-omo-qa-session-id") ?? undefined
			const kind = request.headers.get("x-omo-qa-kind") ?? undefined
			const session = sessionOrigin(databasePaths, sessionID)
			let sessionModel: string | undefined
			if (session?.model) {
				try { sessionModel = selectedModel(JSON.parse(session.model)) } catch { sessionModel = undefined }
			}
			const childParent = scenarioSessions.get("AGENT_REMINDER_DELEGATION")
			const parentMarker = sessionID ? scenarioBySession.get(sessionID) : undefined
			const parentSession = parentMarker !== undefined && session?.parentID == null
			const childSession = kind === "primary" && session?.agent === "explore" && session.parentID === childParent
			const role: ModelRequest["role"] = childSession
				? "child"
				: kind === "primary" && parentSession ? "parent"
				: session && kind !== "primary" ? "auxiliary" : "other"
			// Scenario routing is authorized by the origin probe's session ID plus the
			// isolated native session row, never by marker text in a prompt/history.
			const marker = childSession ? CHILD_MARKER : parentSession ? parentMarker ?? "" : ""
			const knownParentIDs = new Set(scenarioSessions.values())
			const parentRelationValid = session?.parentID == null || knownParentIDs.has(session.parentID)
			const originValid = Boolean(sessionID && kind && REQUEST_KINDS.has(kind) && session && parentRelationValid
				&& session.directory === projectCanonical && sessionModel === `${PROVIDER}/${MODEL}` && model === MODEL)
			const requestRecord: ModelRequest = {
				model,
				marker,
				...(sessionID ? { sessionID } : {}),
				...(kind ? { kind } : {}),
				...(session ? { sessionDirectory: session.directory, sessionParentID: session.parentID } : {}),
				...(session ? { sessionAgent: session.agent } : {}),
				...(sessionModel ? { sessionModel } : {}),
				role,
				originValid,
				toolNames: names,
				toolResultTexts: outputs,
				stream,
				action: "completion",
			}
			const todo = findTool(body, "todowrite")
			if (todo) {
				requestRecord.todowriteDescription = todo.description
				requestRecord.todowriteParameters = todo.parameters
			}
			const index = providerRequests.push(requestRecord)
			const id = `advisory-${index}`
			if (!originValid) {
				originFailures.push({ sessionID, kind, sessionDirectory: session?.directory, sessionModel, model, marker, role })
				return Response.json({ error: { message: "QA request origin or local model validation failed" } }, { status: 400 })
			}
			if (kind === "primary" && role !== "parent" && role !== "child") {
				routeFailures.push({ sessionID, kind, marker, sessionParentID: session?.parentID })
			}
			if (role === "child") {
				childRequests += 1
				requestRecord.action = "child-completion"
				return textResponse("ADVISORY_CHILD_QA_OK", id, model, stream)
			}
			if (kind !== "primary" || role !== "parent") {
				requestRecord.action = "auxiliary-completion"
				return textResponse("ADVISORY_QA_AUXILIARY_OK", id, model, stream)
			}

			const route = (expectedTool: string, call: (name: string, step: number) => { name: string; args: unknown } | undefined) => {
				const tool = findTool(body, expectedTool)
				if (!marker || !tool) return undefined
				const step = scenarioSteps.get(marker) ?? 0
				const next = call(tool.name, step)
				if (!next) return undefined
				scenarioSteps.set(marker, step + 1)
				requestRecord.action = `tool:${next.name}:step-${step}`
				return toolCallResponse(next.name, next.args, `${id}-tool`, model, stream)
			}

			const todoCall = marker === "TODO_SCHEMA_BASELINE" || marker === "TODO_DESCRIPTION_ACTIVE" ? route("todowrite", (name, step) => step === 0
				? { name, args: { todos: [{ content: "advisory hook native QA", status: "completed", priority: "medium" }] } }
				: undefined) : undefined
			if (todoCall) return todoCall
			const planValid = marker === "PLAN_VALID_ACTIVE" ? route("write", (name, step) => step === 0
				? { name, args: { path: join(planRoot, "active.md"), content: "# Plan\n\n**Effort:** 2 days\n\n## TODOs\n- [ ] T1. Malformed row\n" } }
				: undefined) : undefined
			if (planValid) return planValid
			const planOutside = route("write", (name, step) => step === 0 && marker === "PLAN_OUTSIDE_ACTIVE"
				? { name, args: { path: join(outsideRoot, "direct.md"), content: "# Outside Plan\n\n**Effort:** 2 days\n\n## TODOs\n- [ ] T1. Malformed row\n" } }
				: undefined)
			if (planOutside) return planOutside
			const planSymlink = route("write", (name, step) => step === 0 && marker === "PLAN_SYMLINK_ACTIVE"
				? { name, args: { path: symlinkPlan, content: "# Outside Plan\n\n**Effort:** 2 days\n\n## TODOs\n- [ ] T1. Malformed row\n" } }
				: undefined)
			if (planSymlink) return planSymlink
			const reminderTask = marker === "AGENT_REMINDER_DELEGATION" ? route("task", (name, step) => step === 1
				? { name, args: { subagent_type: "explore", description: "Advisory QA", prompt: CHILD_MARKER, load_skills: [], run_in_background: false } }
				: undefined) : undefined
			if (reminderTask) return reminderTask
			const reminder = route("grep", (name, step) => {
				if (marker === "AGENT_REMINDER_CAP" && step < 4) {
					return { name, args: { pattern: "OMO_ADVISORY_NO_MATCH", path: ".", literal: true, limit: 1 } }
				}
				if (marker === "AGENT_REMINDER_DELEGATION" && (step === 0 || step === 2)) {
					return { name, args: { pattern: "OMO_ADVISORY_NO_MATCH", path: ".", literal: true, limit: 1 } }
				}
				if (marker === "AGENT_REMINDER_DISABLED" && step === 0) return { name, args: { pattern: "OMO_ADVISORY_NO_MATCH", path: ".", literal: true, limit: 1 } }
				return undefined
			})
			if (reminder) return reminder
			requestRecord.action = "text-completion"
			return textResponse("ADVISORY_HOOK_QA_OK", id, model, stream)
		},
	})

	const projectConfig = {
		$schema: "https://opencode.ai/config.json",
		plugins: [originHookDirectory, PLUGIN_DIR],
		enabled_providers: [PROVIDER],
		model: `${PROVIDER}/${MODEL}`,
		default_agent: "sisyphus",
		provider: {
			[PROVIDER]: {
				name: "Local advisory hooks QA mock",
				npm: "@ai-sdk/openai-compatible",
				options: { baseURL: `http://127.0.0.1:${mock.port}/v1`, apiKey: API_KEY },
				models: { [MODEL]: { name: "Local advisory hooks QA model", tool_call: true, limit: { context: 200_000, output: 8_192 } } },
			},
		},
		mcp: {},
		telemetry: false,
		permission: { edit: "allow", grep: "allow", subagent: "allow" },
	}
	await writeFile(join(projectCanonical, "opencode.json"), `${JSON.stringify(projectConfig, null, 2)}\n`)
	await writeFile(join(runDirectory, "opencode-config-redacted.json"), `${JSON.stringify({
		...projectConfig,
		provider: { [PROVIDER]: { ...projectConfig.provider[PROVIDER], options: { baseURL: `http://127.0.0.1:${mock.port}/v1`, apiKey: "[redacted-test-api-key]" } } },
	}, null, 2)}\n`)

	const envBase = {
		PATH: "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin",
		TMPDIR: tempRoot,
		HOME: home,
		XDG_DATA_HOME: xdgData,
		XDG_CONFIG_HOME: xdgConfig,
		XDG_STATE_HOME: xdgState,
		XDG_CACHE_HOME: xdgCache,
		OMO_HOME: omoHome,
		CLAUDE_CONFIG_DIR: claudeHome,
		CLAUDE_PLUGINS_HOME: claudePlugins,
		CLAUDE_SETTINGS_PATH: settingsPath,
		OPENCODE_DISABLE_MODELS_FETCH: "1",
		OPENCODE_TELEMETRY_DISABLED: "1",
		OPENCODE_SERVER_PASSWORD: PASSWORD,
		OPENCODE_PASSWORD: PASSWORD,
	}

	const startHost = async (phase: string): Promise<HostRun> => {
			const port = reservePort()
		const databasePath = databasePaths[phase as keyof typeof databasePaths]
		assert(databasePath, `Unknown isolated DB phase: ${phase}`)
		const serverCommand = [CLI, "--print-logs", "--log-level", "debug", "serve", "--hostname", "127.0.0.1", "--port", String(port)]
		const child = Bun.spawn(serverCommand, {
			cwd: hostCwd,
			env: { ...envBase, OPENCODE_DB: databasePath },
			stdout: "pipe",
			stderr: "pipe",
		})
		const host: HostRun = {
			phase,
			port,
			serverCommand,
			databasePath,
			child,
			client: OpenCode.make({ baseUrl: `http://127.0.0.1:${port}`, headers: { Authorization: basicAuth(), "x-opencode-directory": projectCanonical } }),
			stdout: "",
			stderr: "",
			stdoutTask: Promise.resolve(),
			stderrTask: Promise.resolve(),
		}
		host.stdoutTask = new Response(child.stdout as ReadableStream<Uint8Array>).text().then((text) => { host.stdout += text })
		host.stderrTask = new Response(child.stderr as ReadableStream<Uint8Array>).text().then((text) => { host.stderr += text })
		allHosts.push(host)
		activeHost = host
		const versionResult = Bun.spawnSync([CLI, "--version"], { cwd: hostCwd, env: { ...envBase, OPENCODE_DB: databasePath }, stdout: "pipe", stderr: "pipe" })
		const version = new TextDecoder().decode(versionResult.stdout).trim()
		assert(versionResult.exitCode === 0 && version.includes("2.0.18"), `Expected OpenCode 2.0.18, received ${version}`)
		const deadline = Date.now() + 20_000
		let ready = false
		while (Date.now() < deadline && !ready) {
			if (child.exitCode !== null) throw new Error(`${phase}: server exited before ready (${child.exitCode})`)
			try { await host.client.server.info(); ready = true } catch { await new Promise((resolve) => setTimeout(resolve, 100)) }
		}
		assert(ready, `${phase}: native server failed readiness`)
		const registry = await within(`${phase} plugin activation`, waitForReady(host))
		const expectedModels = [`${PROVIDER}/${MODEL}`]
		assert(stableJson(registry.modelIDs) === stableJson(expectedModels), `${phase}: enabled model catalog escaped local mock: ${JSON.stringify(registry.modelIDs)}`)
		assert(stableJson(registry.providerIDs) === stableJson([PROVIDER]), `${phase}: enabled provider catalog escaped local mock: ${JSON.stringify(registry.providerIDs)}`)
		assert(registry.mcpNames.length === 0, `${phase}: MCPs enabled: ${JSON.stringify(registry.mcpNames)}`)
		assert(registry.agentIDs.includes("explore"), `${phase}: expected native explore subagent in agent registry`)
		const modelDefault = await host.client.model.default()
		const defaultModel = selectedModel(modelDefault.data)
		assert(defaultModel === `${PROVIDER}/${MODEL}`, `${phase}: native default model is not pinned to local mock: ${JSON.stringify(modelDefault.data)}`)
		catalogPreflights[phase] = { modelIDs: registry.modelIDs, providerIDs: registry.providerIDs, mcpNames: registry.mcpNames, agentIDs: registry.agentIDs }
		defaultModelPreflights[phase] = defaultModel
		const omoConfig = JSON.parse(await readFile(join(projectCanonical, ".omo", "omo.jsonc"), "utf8")) as Record<string, unknown>
		const opencodeOmoConfig = omoConfig["[opencode]"] && typeof omoConfig["[opencode]"] === "object"
			? omoConfig["[opencode]"] as Record<string, unknown>
			: {}
		phaseConfigs[phase] = {
			disabledHooks: Array.isArray(opencodeOmoConfig.disabled_hooks) ? opencodeOmoConfig.disabled_hooks.filter((value): value is string => typeof value === "string") : [],
			disabledMcps: Array.isArray(opencodeOmoConfig.disabled_mcps) ? opencodeOmoConfig.disabled_mcps.filter((value): value is string => typeof value === "string") : [],
		}
		return host
	}

	const closeHost = async (host: HostRun) => {
		const stopped = await stopHost(host)
		if (stopped) cleanup.push(stopped)
		if (activeHost === host) activeHost = undefined
	}

	const promptInSession = async (host: HostRun, marker: string) => {
		const session = await host.client.session.create({ title: `Advisory hooks ${marker}`, location: { directory: projectCanonical } })
		assert(session.location.directory === projectCanonical, `Session location ${session.location.directory} differs from isolated project`)
		await host.client.session.switchAgent({ sessionID: session.id, agent: "sisyphus" })
		await host.client.session.switchModel({ sessionID: session.id, model: { providerID: PROVIDER, id: MODEL } })
		const selected = await host.client.session.get({ sessionID: session.id })
		assert(selected.location.directory === projectCanonical, "Session escaped the isolated project")
		assert(selected.model?.providerID === PROVIDER && selected.model.id === MODEL, `Session model escaped local mock: ${JSON.stringify(selected.model)}`)
		const before = providerRequests.length
		scenarioSessions.set(marker, session.id)
		scenarioBySession.set(session.id, marker)
		await within(`prompt ${marker}`, host.client.session.prompt({ sessionID: session.id, text: `Run isolated native hook QA marker ${marker}. Use only the described native tool call and then finish.` }))
		await within(`wait ${marker}`, host.client.session.wait({ sessionID: session.id }))
		const finalSession = await host.client.session.get({ sessionID: session.id })
		assert(finalSession.outcome === "succeeded", `${marker}: native session outcome was ${finalSession.outcome}`)
		assert(finalSession.model?.providerID === PROVIDER && finalSession.model.id === MODEL, `${marker}: session model changed from local mock`)
		const messages = await host.client.message.list({ sessionID: session.id })
		return {
			sessionID: session.id,
			outcome: finalSession.outcome,
			agent: finalSession.agent,
			model: finalSession.model,
			requests: providerRequests.slice(before),
			toolStates: nativeToolStates(messages.data),
		}
	}

	let passed = false
	let version = ""
	let baselineSchema: ToolDefinition | undefined
	let activeTodoSchema: ToolDefinition | undefined
	let scenarios: Record<string, unknown> = {}
	const checks: Record<string, boolean> = {}
	try {
		const versionResult = Bun.spawnSync([CLI, "--version"], { cwd: hostCwd, env: { ...envBase, OPENCODE_DB: databasePaths.baseline }, stdout: "pipe", stderr: "pipe" })
		version = new TextDecoder().decode(versionResult.stdout).trim()
		assert(versionResult.exitCode === 0 && version.includes("2.0.18"), `Expected OpenCode 2.0.18, received ${version}`)
		await writeOmoConfig(projectCanonical, ["todo-description-override"])
		const baseline = await startHost("baseline")
		const baselineRun = await promptInSession(baseline, "TODO_SCHEMA_BASELINE")
		const baselineRequest = [...providerRequests].reverse().find((request) => request.marker === "TODO_SCHEMA_BASELINE" && request.todowriteDescription)
		if (baselineRequest) baselineSchema = { name: "todowrite", description: baselineRequest.todowriteDescription ?? "", parameters: baselineRequest.todowriteParameters }
		await closeHost(baseline)

		await writeOmoConfig(projectCanonical, [])
		const active = await startHost("active")
		const todoRun = await promptInSession(active, "TODO_DESCRIPTION_ACTIVE")
		const activeRequest = [...providerRequests].reverse().find((request) => request.marker === "TODO_DESCRIPTION_ACTIVE" && request.todowriteDescription)
		if (activeRequest) activeTodoSchema = { name: "todowrite", description: activeRequest.todowriteDescription ?? "", parameters: activeRequest.todowriteParameters }
		const todoSchemaUnchanged = Boolean(baselineSchema && activeTodoSchema && stableJson(baselineSchema.parameters) === stableJson(activeTodoSchema.parameters))
		const todoDescriptionChangedOnly = Boolean(baselineSchema && activeTodoSchema && activeTodoSchema.description === TODOWRITE_DESCRIPTION && baselineSchema.description !== TODOWRITE_DESCRIPTION && todoSchemaUnchanged)

		const activePlanPath = join(planRoot, "active.md")
		const validPlan = await promptInSession(active, "PLAN_VALID_ACTIVE")
		const directOutside = await promptInSession(active, "PLAN_OUTSIDE_ACTIVE")
		const symlinkPlanRun = await promptInSession(active, "PLAN_SYMLINK_ACTIVE")
		const activePlanContents = await readFile(activePlanPath, "utf8")
		const outsidePlanContents = await readFile(join(outsideRoot, "direct.md"), "utf8")
		const symlinkContents = await readFile(symlinkTarget, "utf8")
		const validPlanRequest = [...providerRequests].reverse().find((request) => request.marker === "PLAN_VALID_ACTIVE" && request.toolResultTexts.some((text) => text.includes("<plan-format-warning>")))
		const validWarningText = validPlanRequest?.toolResultTexts.join("\n") ?? ""
		const outsideRequest = [...providerRequests].reverse().find((request) => request.marker === "PLAN_OUTSIDE_ACTIVE" && request.toolResultTexts.length > 0)
		const symlinkRequest = [...providerRequests].reverse().find((request) => request.marker === "PLAN_SYMLINK_ACTIVE" && request.toolResultTexts.length > 0)
		const capRun = await promptInSession(active, "AGENT_REMINDER_CAP")
		const finalCapRequest = [...capRun.requests].reverse().find((request) => request.marker === "AGENT_REMINDER_CAP" && request.action === "text-completion")
		const capToolResults = finalCapRequest?.toolResultTexts.join("\n") ?? ""
		const capReminderCount = countOccurrences(capToolResults, REMINDER_MESSAGE.trim())
		const capGrepCount = capRun.toolStates.filter((tool) => tool.name.toLowerCase() === "grep" && tool.status === "completed").length

		const delegationRun = await promptInSession(active, "AGENT_REMINDER_DELEGATION")
		const finalDelegationRequest = [...delegationRun.requests].reverse().find((request) => request.marker === "AGENT_REMINDER_DELEGATION" && request.action === "text-completion")
		const delegationToolResults = finalDelegationRequest?.toolResultTexts.join("\n") ?? ""
		const delegationReminderCount = countOccurrences(delegationToolResults, REMINDER_MESSAGE.trim())
		const taskCallObserved = delegationRun.requests.some((request) => request.action.includes("tool:task:"))
		const completedTaskCount = delegationRun.toolStates.filter((tool) => tool.name.toLowerCase() === "task" && tool.status === "completed").length
		const delegationGrepCount = delegationRun.toolStates.filter((tool) => tool.name.toLowerCase() === "grep" && tool.status === "completed").length
		const successfulTaskResultObserved = delegationToolResults.includes("ADVISORY_CHILD_QA_OK") && childRequests === 1 && completedTaskCount === 1
		const childRows = nativeChildren(active.databasePath, delegationRun.sessionID)
		const childSession = childRows.length === 1 ? await active.client.session.get({ sessionID: childRows[0]!.id }) : undefined
		const childTranscript = childSession ? await active.client.message.list({ sessionID: childSession.id }) : undefined
		const childText = JSON.stringify(childTranscript?.data ?? [])
		const nativeChildSucceeded = childRows.length === 1
			&& childRows[0]?.agent === "explore"
			&& childSession?.parentID === delegationRun.sessionID
			&& childSession?.outcome === "succeeded"
			&& childSession.model?.providerID === PROVIDER
			&& childSession.model.id === MODEL
			&& childText.includes("ADVISORY_CHILD_QA_OK")
		const allSessionsLocal = [baselineRun, todoRun, validPlan, directOutside, symlinkPlanRun, capRun, delegationRun].every((scenario) => scenario.outcome === "succeeded")
		await closeHost(active)

		await writeOmoConfig(projectCanonical, ["agent-usage-reminder"])
		const disabled = await startHost("disabled")
		const disabledRun = await promptInSession(disabled, "AGENT_REMINDER_DISABLED")
		const disabledLast = [...disabledRun.requests].reverse().find((request) => request.marker === "AGENT_REMINDER_DISABLED" && request.action === "text-completion")
		const disabledReminderCount = countOccurrences(disabledLast?.toolResultTexts.join("\n") ?? "", REMINDER_MESSAGE.trim())
		await closeHost(disabled)
		mock.stop(true)
		mockStopped = true

		checks.explicitPinnedRuntime = version.includes("2.0.18") && CLI_INPUT === CLI
		checks.frozenBundleHash = bundleHash === EXPECTED_SERVER_SHA256
		checks.localOnlyCatalogAndNoMcp = Object.keys(catalogPreflights).length === 3
			&& Object.values(catalogPreflights).every((entry) => stableJson(entry.modelIDs) === stableJson([`${PROVIDER}/${MODEL}`])
				&& stableJson(entry.providerIDs) === stableJson([PROVIDER]) && entry.mcpNames.length === 0)
		checks.todoDescriptionOverrideActualModelRequest = todoDescriptionChangedOnly
			&& baselineRun.toolStates.some((tool) => tool.name.toLowerCase() === "todowrite" && tool.status === "completed")
			&& todoRun.toolStates.some((tool) => tool.name.toLowerCase() === "todowrite" && tool.status === "completed")
			&& todoRun.requests.some((request) => request.action.startsWith("tool:todowrite:"))
		checks.todoSchemaUnchanged = todoSchemaUnchanged
		checks.planNormalizerActualWriteAndWarning = validPlan.toolStates.some((tool) => tool.name.toLowerCase() === "write" && tool.status === "completed")
			&& activePlanContents.includes("**Effort:** Medium")
			&& !activePlanContents.includes("**Effort:** 2 days")
			&& countOccurrences(validWarningText, "<plan-format-warning>") === 2
		checks.planOutsideTargetNotNormalized = directOutside.toolStates.some((tool) => tool.name.toLowerCase() === "write" && tool.status === "completed")
			&& outsidePlanContents.includes("**Effort:** 2 days")
			&& !(outsideRequest?.toolResultTexts.join("\n") ?? "").includes("<plan-format-warning>")
		checks.planSymlinkEscapeNotNormalized = symlinkPlanRun.toolStates.some((tool) => tool.name.toLowerCase() === "write" && tool.status === "completed")
			&& symlinkContents.includes("**Effort:** 2 days")
			&& !(symlinkRequest?.toolResultTexts.join("\n") ?? "").includes("<plan-format-warning>")
		checks.agentUsageReminderMaximumThree = capReminderCount === 3 && capGrepCount === 4
		checks.agentUsageReminderSuppressedAfterSuccessfulDelegation = successfulTaskResultObserved
			&& nativeChildSucceeded
			&& delegationGrepCount === 2
			&& delegationReminderCount === 1
			&& delegationRun.requests.some((request) => request.action.startsWith("tool:grep:step-2"))
		checks.disabledHookControl = disabledReminderCount === 0 && disabledRun.outcome === "succeeded"
			&& disabledRun.toolStates.some((tool) => tool.name.toLowerCase() === "grep" && tool.status === "completed")
		checks.allModelRequestsUseLocalModel = providerRequests.length > 0 && providerRequests.every((request) => request.model === MODEL)
		checks.everyPromptSessionSucceededOnPinnedModel = allSessionsLocal && disabledRun.outcome === "succeeded"
		checks.disabledHooksPhaseConfiguration = phaseConfigs.baseline?.disabledHooks.includes("todo-description-override")
			&& phaseConfigs.active?.disabledHooks.length === 0
			&& phaseConfigs.disabled?.disabledHooks.includes("agent-usage-reminder")
		checks.cleanupStoppedOwnedProcesses = cleanup.length === 3 && cleanup.every((item) => item.exitCode !== null) && mockStopped
		const sessionCounts = Object.fromEntries(allHosts.map((host) => [host.phase, sessionCount(host.databasePath)]))
		checks.isolatedDatabasesObservedSessions = Object.values(sessionCounts).every((count) => typeof count === "number" && count > 0)
		checks.everyChatRequestHasValidSessionOrigin = providerRequests.length > 0
			&& providerRequests.every((request) => request.originValid && Boolean(request.sessionID && request.kind && request.sessionDirectory === projectCanonical && request.sessionModel === `${PROVIDER}/${MODEL}` && request.model === MODEL))
		checks.requestKindsValidatedAndAuxiliarySeparated = providerRequests.every((request) => request.kind && REQUEST_KINDS.has(request.kind)
			&& (request.kind === "primary" ? request.role === "parent" || request.role === "child"
				: request.role === "auxiliary" && request.action === "auxiliary-completion"))
		checks.noOriginOrRoutingFailures = originFailures.length === 0 && routeFailures.length === 0
		checks.primaryRequestsHaveSessionAndExpectedParent = providerRequests.filter((request) => request.kind === "primary").length > 0
			&& providerRequests.filter((request) => request.kind === "primary").every((request) => request.originValid
				&& ((request.role === "parent" && request.sessionParentID == null)
				|| (request.role === "child" && request.sessionParentID === delegationRun.sessionID && request.sessionAgent === "explore")))
		checks.defaultModelPinnedEveryPhase = Object.keys(defaultModelPreflights).length === 3
			&& Object.values(defaultModelPreflights).every((model) => model === `${PROVIDER}/${MODEL}`)
		passed = Object.values(checks).every(Boolean)
		scenarios = {
			baselineTodo: { sessionID: baselineRun.sessionID, schema: baselineSchema },
			activeTodo: { sessionID: todoRun.sessionID, schema: activeTodoSchema },
			planValid: { sessionID: validPlan.sessionID, warningToolOutput: validWarningText, file: activePlanPath, contents: activePlanContents },
			planOutside: { sessionID: directOutside.sessionID, file: join(outsideRoot, "direct.md"), contents: outsidePlanContents, toolResultTexts: outsideRequest?.toolResultTexts },
			planSymlink: { sessionID: symlinkPlanRun.sessionID, link: symlinkPlan, target: symlinkTarget, contents: symlinkContents, toolResultTexts: symlinkRequest?.toolResultTexts },
			reminderCap: { sessionID: capRun.sessionID, toolCalls: capRun.requests.filter((request) => request.action.startsWith("tool:")).map(({ action }) => action), reminderOccurrencesInFinalTranscript: capReminderCount, completedGrepCount: capGrepCount },
			reminderDelegation: { sessionID: delegationRun.sessionID, toolCalls: delegationRun.requests.filter((request) => request.action.startsWith("tool:")).map(({ action }) => action), reminderOccurrencesInFinalTranscript: delegationReminderCount, taskCallObserved, completedTaskCount, completedGrepCount: delegationGrepCount, childRequests, successfulTaskResultObserved, childRows, nativeChildSucceeded },
			disabledReminder: { sessionID: disabledRun.sessionID, reminderOccurrencesInFinalTranscript: disabledReminderCount },
			databaseSessionCounts: sessionCounts,
			phaseConfigs,
			catalogPreflights,
			defaultModelPreflights,
			sourceHashes,
			driverSha256,
			originProbeDirectory: originHookDirectory,
			originFailures,
			routeFailures,
		}
		assert(passed, `Advisory hook checks failed: ${JSON.stringify(checks)}`)
	} catch (error) {
		failure = error instanceof Error ? error.message : String(error)
	} finally {
		if (activeHost) await closeHost(activeHost)
		for (const host of allHosts) {
			if (!cleanup.some((item) => item.phase === host.phase)) await closeHost(host)
		}
		if (!mockStopped) {
			mock.stop(true)
			mockStopped = true
		}
		Object.assign(results, {
			version,
			bundleSha256: bundleHash,
			runDirectory,
			providerRequests,
			providerRequestCount: providerRequests.length,
			childRequests,
			baselineTodoSchema: baselineSchema,
			activeTodoSchema,
			scenarios,
			checks,
			passed,
			failure,
			cleanup,
			cleanupAllStopped: cleanup.length === allHosts.length && cleanup.every((item) => item.exitCode !== null),
			tempRootRetained: existsSync(tempRoot),
			mockStopped,
			phaseConfigs,
			catalogPreflights,
			serverCommands: Object.fromEntries(allHosts.map((host) => [host.phase, host.serverCommand])),
		})
		await Promise.all([
			writeFile(join(runDirectory, "runtime.json"), `${JSON.stringify(results, null, 2)}\n`),
			writeFile(join(runDirectory, "mock-requests.json"), `${JSON.stringify(providerRequests, null, 2)}\n`),
			writeFile(join(runDirectory, "fixture-paths.json"), `${JSON.stringify({ projectCanonical, hostCwd, planRoot, outsideRoot, symlinkPlan, symlinkTarget, databasePaths }, null, 2)}\n`),
			...allHosts.map((host) => writeFile(join(runDirectory, `${host.phase}-server.log`), redact(`${host.stdout}\n--- stderr ---\n${host.stderr}`))),
		])
	}
	if (failure) throw new Error(`Advisory hook QA failed; inspect ${join(runDirectory, "runtime.json")}: ${failure}`)
	process.stdout.write(`${JSON.stringify({ evidence: runDirectory, passed, checks, cleanup }, null, 2)}\n`)
}

await main()
