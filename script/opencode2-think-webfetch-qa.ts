/**
 * Local-only OpenCode 2.0.18 runtime check for request-local think mode and
 * native webfetch redirect handling. Requires a frozen plugin bundle.
 */
import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { tmpdir } from "node:os"
import { Database } from "bun:sqlite"
import { OpenCode } from "@opencode/client"

const ROOT = resolve(import.meta.dir, "..")
const EVIDENCE_ROOT = join(ROOT, ".omo", "evidence")
const EVIDENCE = resolve(process.env.OPENCODE2_QA_EVIDENCE_DIR ?? join(EVIDENCE_ROOT, "20260927-think-webfetch"))
const PLUGIN_DIR = resolve(process.env.OPENCODE2_PLUGIN_DIR ?? join(ROOT, "dist", "opencode2"))
const CLI_INPUT = process.env.OPENCODE2_CLI?.trim() ?? ""
const CLI = CLI_INPUT ? resolve(CLI_INPUT) : ""
const EXPECTED_SERVER_SHA256 = process.env.OPENCODE2_EXPECTED_SERVER_SHA256 ?? ""
const PROVIDER = "omoqa"
const MODEL = "qa-model"
const API_KEY = "think-webfetch-fake-key-only"
const PASSWORD = "think-webfetch-local-only"
const PROBE_ID = "omo-think-webfetch-origin-probe"
const TIMEOUT_MS = 60_000

type Check = { readonly name: string; readonly passed: boolean; readonly detail?: unknown }
type SessionRow = { id: string; parentID: string | null; directory: string; model: string | null; agent: string | null }
type RequestRecord = {
	readonly sessionID?: string
	readonly agent?: string
	readonly kind?: string
	readonly model: string
	readonly originValid: boolean
	readonly marker: string
	readonly wireMarker: string
	readonly userText: string[]
	readonly at: number
	readonly toolNames: string[]
	readonly toolResults: string[]
	readonly reasoning: unknown
	readonly parentID?: string | null
}
type MockRequest = { readonly sessionID?: string; readonly path: string; readonly method: string; readonly at: number }
type Host = {
	readonly port: number
	readonly process: Bun.Subprocess
	readonly client: ReturnType<typeof OpenCode.make>
	stdout: string
	stderr: string
	stdoutTask: Promise<void>
	stderrTask: Promise<void>
}

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message)
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
	assert(typeof port === "number", "Could not reserve a localhost port")
	return port
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function contentText(value: unknown): string {
	if (typeof value === "string") return value
	if (Array.isArray(value)) return value.map(contentText).filter(Boolean).join("\n")
	const row = asRecord(value)
	if (!row) return ""
	if (typeof row.text === "string") return row.text
	if (row.content !== undefined) return contentText(row.content)
	if (row.parts !== undefined) return contentText(row.parts)
	return ""
}

function modelRef(value: unknown): string | undefined {
	const row = asRecord(value)
	return typeof row?.providerID === "string" && typeof row.id === "string" ? `${row.providerID}/${row.id}` : undefined
}

function databaseSession(databasePath: string, sessionID: string | undefined): SessionRow | undefined {
	if (!sessionID || !existsSync(databasePath)) return undefined
	try {
		const db = new Database(databasePath, { readonly: true, create: false })
		try {
			return db.query("SELECT id, parent_id AS parentID, directory, model, agent FROM session_v2 WHERE id = ?")
				.get(sessionID) as SessionRow | undefined
		} finally {
			db.close()
		}
	} catch {
		return undefined
	}
}

function requestMarker(messages: unknown): string {
	if (!Array.isArray(messages)) return ""
	for (const item of [...messages].reverse()) {
		const message = asRecord(item)
		if (message?.role !== "user") continue
		const text = contentText(message.content)
		const match = /OMO_QA_(THINK_[12]|WEBFETCH_(?:CHAIN|LOOP))/.exec(text)
		if (match) return match[0]
	}
	return ""
}

function toolNames(body: Record<string, unknown>): string[] {
	if (!Array.isArray(body.tools)) return []
	return body.tools.flatMap((item) => {
		const row = asRecord(item)
		const fn = asRecord(row?.function) ?? row
		return typeof fn?.name === "string" ? [fn.name] : []
	})
}

function toolResults(body: Record<string, unknown>): string[] {
	if (!Array.isArray(body.messages)) return []
	return body.messages.flatMap((item) => {
		const row = asRecord(item)
		return row?.role === "tool" ? [contentText(row.content)] : []
	})
}

function toolCallResponse(name: string, args: Record<string, unknown>, id: string, model: string, stream: boolean): Response {
	const created = Math.floor(Date.now() / 1000)
	const toolCall = { index: 0, id: `${id}-tool`, type: "function", function: { name, arguments: JSON.stringify(args) } }
	if (!stream) {
		return Response.json({
			id: `chatcmpl-${id}`, object: "chat.completion", created, model,
			choices: [{ index: 0, message: { role: "assistant", content: null, tool_calls: [toolCall] }, finish_reason: "tool_calls" }],
			usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
		})
	}
	return new Response([
		{ id: `chatcmpl-${id}`, object: "chat.completion.chunk", created, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [toolCall] }, finish_reason: null }] },
		{ id: `chatcmpl-${id}`, object: "chat.completion.chunk", created, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
	].map((item) => `data: ${JSON.stringify(item)}\n\n`).join("") + "data: [DONE]\n\n", {
		headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" },
	})
}

function textResponse(text: string, id: string, model: string, stream: boolean): Response {
	const created = Math.floor(Date.now() / 1000)
	if (!stream) {
		return Response.json({
			id: `chatcmpl-${id}`, object: "chat.completion", created, model,
			choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
			usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
		})
	}
	return new Response([
		{ id: `chatcmpl-${id}`, object: "chat.completion.chunk", created, choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] },
		{ id: `chatcmpl-${id}`, object: "chat.completion.chunk", created, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
	].map((item) => `data: ${JSON.stringify(item)}\n\n`).join("") + "data: [DONE]\n\n", {
		headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" },
	})
}

async function waitForHost(host: Host): Promise<void> {
	const deadline = Date.now() + 25_000
	while (Date.now() < deadline) {
		if (host.process.exitCode !== null) throw new Error(`OpenCode exited early with ${host.process.exitCode}`)
		try {
			await host.client.server.info()
			return
		} catch {
			await Bun.sleep(100)
		}
	}
	throw new Error("OpenCode server readiness timed out")
}

async function waitForRegistry(host: Host, projectDirectory: string): Promise<Record<string, unknown>> {
	const deadline = Date.now() + 45_000
	let state: Record<string, unknown> = {}
	while (Date.now() < deadline) {
		const [plugins, agents] = await Promise.all([host.client.plugin.list(), host.client.agent.list()])
		const pluginRows = plugins.data.map(({ id, state }) => ({ id, status: state.status }))
		const failed = plugins.data.find((entry) => entry.state.status === "failed")
		assert(!failed, `Plugin failed during setup: ${JSON.stringify({ id: failed?.id, state: failed?.state })}`)
		const omoActive = plugins.data.some((entry) => entry.id === "oh-my-openagent" && entry.state.status === "active")
		const probeActive = plugins.data.some((entry) => entry.id === PROBE_ID && entry.state.status === "active")
		const agentIDs = agents.data.map((entry) => entry.id)
		if (omoActive && probeActive && agentIDs.includes("sisyphus")) {
			const [models, providers, defaultModel, mcps] = await Promise.all([
				host.client.model.list(), host.client.provider.list(), host.client.model.default(), host.client.mcp.list(),
			])
			const modelIDs = models.data.map((entry) => `${entry.providerID}/${entry.id}`).sort()
			const providerIDs = providers.data.map((entry) => entry.id).sort()
			const mcpIDs = mcps.data.map((entry) => entry.name).sort()
			state = { pluginRows, agentIDs, modelIDs, providerIDs, defaultModel: modelRef(defaultModel.data), mcpIDs }
			if (modelIDs.join("\n") === `${PROVIDER}/${MODEL}` && providerIDs.join("\n") === PROVIDER &&
				modelRef(defaultModel.data) === `${PROVIDER}/${MODEL}` && mcpIDs.length === 0 && projectDirectory.length > 0) return state
		}
		await Bun.sleep(150)
	}
	throw new Error(`Local-only registry preflight failed: ${JSON.stringify(state)}`)
}

async function stopHost(host: Host | undefined): Promise<number | null | undefined> {
	if (!host) return undefined
	if (host.process.exitCode === null) {
		host.process.kill("SIGTERM")
		const stopped = await Promise.race([
			host.process.exited.then(() => true),
			new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 7_000)),
		])
		if (!stopped && host.process.exitCode === null) {
			host.process.kill("SIGKILL")
			await host.process.exited
		}
	}
	await Promise.allSettled([host.stdoutTask, host.stderrTask])
	return host.process.exitCode
}

async function main(): Promise<void> {
	assert(CLI_INPUT && isAbsolute(CLI_INPUT) && existsSync(CLI), "Set OPENCODE2_CLI to an explicit absolute OpenCode executable")
	assert(/^[a-f0-9]{64}$/i.test(EXPECTED_SERVER_SHA256), "Set OPENCODE2_EXPECTED_SERVER_SHA256 to the frozen server bundle hash")
	const relativeEvidence = relative(EVIDENCE_ROOT, EVIDENCE)
	assert(relativeEvidence !== "" && !relativeEvidence.startsWith("..") && !isAbsolute(relativeEvidence) && !relativeEvidence.includes(sep),
		"Evidence path must be one direct child of .omo/evidence")
	await mkdir(EVIDENCE_ROOT, { recursive: true })
	const rootCanonical = await realpath(EVIDENCE_ROOT)
	await mkdir(EVIDENCE, { recursive: true })
	const evidence = await realpath(EVIDENCE)
	assert(dirname(evidence) === rootCanonical, "Evidence path escaped the repository evidence root")
	const serverPath = join(PLUGIN_DIR, "server.js")
	assert(existsSync(serverPath), `Missing plugin server bundle: ${serverPath}`)
	const bundleHash = createHash("sha256").update(await readFile(serverPath)).digest("hex")
	assert(bundleHash === EXPECTED_SERVER_SHA256, `Frozen plugin bundle mismatch: ${bundleHash}`)

	const tempRoot = await realpath(await mkdtemp(join(tmpdir(), "omo-think-webfetch-qa-")))
	const project = join(tempRoot, "project")
	const serverCwd = join(tempRoot, "server-cwd")
	const home = join(tempRoot, "home")
	const xdgData = join(tempRoot, "xdg-data")
	const xdgConfig = join(tempRoot, "xdg-config")
	const xdgState = join(tempRoot, "xdg-state")
	const xdgCache = join(tempRoot, "xdg-cache")
	const omoHome = join(tempRoot, "omo-home")
	const claudeHome = join(tempRoot, "claude-home")
	const claudePlugins = join(tempRoot, "claude-plugins")
	const probeDirectory = join(tempRoot, "origin-probe")
	const databasePath = join(tempRoot, "opencode.db")
	await Promise.all([project, serverCwd, home, xdgData, xdgConfig, xdgState, xdgCache, omoHome, claudeHome, claudePlugins,
		probeDirectory, join(project, ".omo")].map((path) => mkdir(path, { recursive: true })))
	const projectDirectory = await realpath(project)
	assert(!projectDirectory.startsWith(ROOT + sep), "QA project must be outside this repository")

	const modelOverrides = {
		variants: { high: { reasoningEffort: "high" } },
	}
	const projectConfig = {
		$schema: "https://opencode.ai/config.json",
		plugins: [probeDirectory, PLUGIN_DIR],
		enabled_providers: [PROVIDER],
		model: `${PROVIDER}/${MODEL}`,
		default_agent: "sisyphus",
		provider: {
			[PROVIDER]: {
				name: "Local think/webfetch QA mock",
				npm: "@ai-sdk/openai-compatible",
				options: { baseURL: "http://127.0.0.1:0/v1", apiKey: API_KEY },
				models: {
					[MODEL]: {
						name: "Local QA text model", tool_call: true, ...modelOverrides,
						limit: { context: 200_000, output: 8_192 },
					},
				},
			},
		},
		mcp: {},
		telemetry: false,
		permission: { webfetch: "allow" },
	}
	const omoConfig = {
		telemetry: { enabled: false },
		"[opencode]": {
			telemetry: false,
			disabled_mcps: ["websearch", "context7", "grep_app", "lsp"],
			mcp_env_allowlist: [],
			claude_code: { mcp: false, agents: false, skills: false, commands: false, plugins: false, hooks: false },
		},
	}
	await writeFile(join(projectDirectory, ".omo", "omo.jsonc"), JSON.stringify(omoConfig, null, 2) + "\n")

	const mockRequests: RequestRecord[] = []
	const redirectRequests: MockRequest[] = []
	const scenarios = new Map<string, { marker: string; step: number }>()
	const originFailures: unknown[] = []
	let host: Host | undefined
	let mockStopped = false
	let mockPort = 0
	const mock = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const url = new URL(request.url)
			if (url.pathname === "/v1/models") {
				return Response.json({ data: [{ id: MODEL, object: "model", created: 0, owned_by: "omoqa" }] })
			}
			if (url.pathname.startsWith("/redirect/") || url.pathname.startsWith("/loop/")) {
				redirectRequests.push({ sessionID: request.headers.get("x-omo-qa-session-id") ?? undefined, path: url.pathname, method: request.method, at: Date.now() })
				if (url.pathname === "/redirect/one") return new Response(null, { status: 302, headers: { location: "/redirect/two" } })
				if (url.pathname === "/redirect/two") return new Response(null, { status: 307, headers: { location: "/redirect/final" } })
				if (url.pathname === "/redirect/final") return new Response("OMO_QA_REDIRECT_TARGET", { headers: { "content-type": "text/plain" } })
				if (url.pathname === "/loop/a") return new Response(null, { status: 302, headers: { location: "/loop/b" } })
				if (url.pathname === "/loop/b") return new Response(null, { status: 302, headers: { location: "/loop/a" } })
				return new Response("not found", { status: 404 })
			}
			if (!url.pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 })
			const body = await request.json() as Record<string, unknown>
			const model = typeof body.model === "string" ? body.model : ""
			const sessionID = request.headers.get("x-omo-qa-session-id") ?? undefined
			const agent = request.headers.get("x-omo-qa-agent") ?? undefined
			const kind = request.headers.get("x-omo-qa-kind") ?? undefined
			const provider = request.headers.get("x-omo-qa-provider") ?? undefined
			const effectiveModel = request.headers.get("x-omo-qa-model") ?? undefined
			const session = databaseSession(databasePath, sessionID)
			let storedModel: string | undefined
			if (session?.model) try { storedModel = modelRef(JSON.parse(session.model)) } catch { storedModel = undefined }
			const wireMarker = requestMarker(body.messages)
			const marker = wireMarker || (sessionID ? scenarios.get(sessionID)?.marker : undefined) || ""
			const userText = Array.isArray(body.messages) ? body.messages.flatMap((item) => {
				const row = asRecord(item)
				return row?.role === "user" ? [contentText(row.content)] : []
			}) : []
			const names = toolNames(body)
			const results = toolResults(body)
			const originValid = Boolean(sessionID && session && session.directory === projectDirectory && session.parentID == null &&
				session.agent === agent && kind === "primary" && model === MODEL && provider === PROVIDER && effectiveModel === MODEL &&
				storedModel === `${PROVIDER}/${MODEL}`)
			const record: RequestRecord = {
				...(sessionID ? { sessionID } : {}), ...(agent ? { agent } : {}), ...(kind ? { kind } : {}), model,
				originValid, marker, wireMarker, userText, at: Date.now(), toolNames: names, toolResults: results,
				reasoning: { effort: body.reasoning_effort, reasoning: body.reasoning, thinking: body.thinking },
				...(session ? { parentID: session.parentID } : {}),
			}
			mockRequests.push(record)
			if (!originValid) {
				originFailures.push({ sessionID, agent, kind, model, provider, effectiveModel, storedModel, directory: session?.directory, parentID: session?.parentID })
				return Response.json({ error: { message: "Rejected a request outside the isolated local QA session." } }, { status: 400 })
			}
			const stream = body.stream === true
			const id = `qa-${mockRequests.length}`
			if (marker === "OMO_QA_THINK_1") return textResponse("OMO_QA_THINK_FIRST_OK", id, model, stream)
			if (marker === "OMO_QA_THINK_2") return textResponse("OMO_QA_THINK_SECOND_OK", id, model, stream)
			if (marker === "OMO_QA_WEBFETCH_CHAIN" && results.length === 0) {
				const actual = names.find((name) => name.toLowerCase() === "webfetch")
				if (!actual) return textResponse("WEBFETCH_TOOL_MISSING", id, model, stream)
				return toolCallResponse(actual, { url: `http://127.0.0.1:${mockPort}/redirect/one`, format: "text" }, id, model, stream)
			}
			if (marker === "OMO_QA_WEBFETCH_LOOP" && results.length === 0) {
				const actual = names.find((name) => name.toLowerCase() === "webfetch")
				if (!actual) return textResponse("WEBFETCH_TOOL_MISSING", id, model, stream)
				return toolCallResponse(actual, { url: `http://127.0.0.1:${mockPort}/loop/a`, format: "text", timeout: 1 }, id, model, stream)
			}
			if (marker.startsWith("OMO_QA_WEBFETCH_") && results.length > 0) {
				return textResponse("OMO_QA_WEBFETCH_COMPLETED", id, model, stream)
			}
			return textResponse("OMO_QA_THINK_WEBFETCH_OK", id, model, stream)
		},
	})
	assert(typeof mock.port === "number" && mock.port > 0, "Could not bind the localhost provider mock")
	mockPort = mock.port

	const mockOrigin = `http://127.0.0.1:${mock.port}`
	;(projectConfig.provider[PROVIDER].options as { baseURL: string }).baseURL = `${mockOrigin}/v1`
	const probeSource = `export default { id: ${JSON.stringify(PROBE_ID)}, setup: async ({ session }) => {
	const allowedOrigin = ${JSON.stringify(mockOrigin)};
	const model = await session.hook("model.request", (event) => {
	 if (event.model.providerID !== ${JSON.stringify(PROVIDER)} || event.model.id !== ${JSON.stringify(MODEL)}) throw new Error("QA blocked a nonlocal model request");
	 event.headers["x-omo-qa-agent"] = String(event.agent); event.headers["x-omo-qa-provider"] = String(event.model.providerID); event.headers["x-omo-qa-model"] = String(event.model.id);
	});
	const http = await session.hook("http.request", (event) => {
	 if (new URL(event.request.url).origin !== allowedOrigin) throw new Error("QA blocked nonlocal HTTP");
	 const headers = new Headers(event.request.headers); if (event.sessionID) headers.set("x-omo-qa-session-id", event.sessionID); if (event.kind) headers.set("x-omo-qa-kind", event.kind);
	 event.request = new Request(event.request, { headers });
	});
	return async () => { await Promise.all([model.dispose(), http.dispose()]); };
} }\n`
	await writeFile(join(probeDirectory, "index.js"), probeSource)
	const redactedConfig = {
		...projectConfig,
		provider: { [PROVIDER]: { ...projectConfig.provider[PROVIDER], options: { baseURL: `${mockOrigin}/v1`, apiKey: "[redacted-fake-key]" } } },
	}
	await writeFile(join(projectDirectory, "opencode.json"), JSON.stringify(projectConfig, null, 2) + "\n")
	await writeFile(join(EVIDENCE, "project-config-redacted.json"), JSON.stringify({ opencode: redactedConfig, omo: omoConfig }, null, 2) + "\n")

	const environment = {
		PATH: "/tmp/omo-bun-runtime-1.4.2:/opt/homebrew/opt/node@24/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin",
		TMPDIR: tempRoot,
		HOME: home,
		XDG_DATA_HOME: xdgData,
		XDG_CONFIG_HOME: xdgConfig,
		XDG_STATE_HOME: xdgState,
		XDG_CACHE_HOME: xdgCache,
		OMO_HOME: omoHome,
		CLAUDE_CONFIG_DIR: claudeHome,
		CLAUDE_PLUGINS_HOME: claudePlugins,
		OPENCODE_DB: databasePath,
		OPENCODE_DISABLE_MODELS_FETCH: "1",
		OPENCODE_TELEMETRY_DISABLED: "1",
		OPENCODE_SERVER_PASSWORD: PASSWORD,
		OPENCODE_PASSWORD: PASSWORD,
	}
	const cliVersion = Bun.spawnSync([CLI, "--version"], { cwd: serverCwd, env: environment, stdout: "pipe", stderr: "pipe" })
	const version = cliVersion.stdout.toString().trim()
	assert(cliVersion.exitCode === 0 && version.includes("2.0.18"), `Expected OpenCode 2.0.18, got ${version}`)
	const serverPort = reservePort()
	const serverCommand = [CLI, "--print-logs", "--log-level", "debug", "serve", "--hostname", "127.0.0.1", "--port", String(serverPort)]
	const hostProcess = Bun.spawn(serverCommand, { cwd: serverCwd, env: environment, stdout: "pipe", stderr: "pipe" })
	const password = Buffer.from(`opencode:${PASSWORD}`).toString("base64")
	host = {
		port: serverPort,
		process: hostProcess,
		client: OpenCode.make({ baseUrl: `http://127.0.0.1:${serverPort}`, headers: { Authorization: `Basic ${password}`, "x-opencode-directory": projectDirectory } }),
		stdout: "", stderr: "", stdoutTask: Promise.resolve(), stderrTask: Promise.resolve(),
	}
	host.stdoutTask = new Response(hostProcess.stdout as ReadableStream<Uint8Array>).text().then((text) => { host!.stdout = text })
	host.stderrTask = new Response(hostProcess.stderr as ReadableStream<Uint8Array>).text().then((text) => { host!.stderr = text })
	const checks: Check[] = []
	const check = (name: string, passed: boolean, detail?: unknown) => checks.push({ name, passed, ...(detail === undefined ? {} : { detail }) })
	let registry: Record<string, unknown> = {}
	let sessionIDs: string[] = []
	const startedAt = new Date().toISOString()
	let cleanupCode: number | null | undefined
	let failure: string | undefined
	try {
		await waitForHost(host)
		registry = await waitForRegistry(host, projectDirectory)
		check("frozen native host and plugin artifact match", bundleHash === EXPECTED_SERVER_SHA256 && version.includes("2.0.18"), { version, bundleHash })
		check("preprompt registry is isolated to one local provider/model and no MCP", JSON.stringify(registry.modelIDs) === JSON.stringify([`${PROVIDER}/${MODEL}`]) && JSON.stringify(registry.providerIDs) === JSON.stringify([PROVIDER]) && registry.defaultModel === `${PROVIDER}/${MODEL}` && JSON.stringify(registry.mcpIDs) === "[]", registry)
		const agent = (await host.client.agent.get({ agentID: "sisyphus" })).data
		check("native Sisyphus agent is available before prompts", agent.id === "sisyphus" && !agent.hidden, { id: agent.id, hidden: agent.hidden })
		const modelRow = (await host.client.model.list()).data.find((row) => row.providerID === PROVIDER && row.id === MODEL)
		check("native local model catalog includes the high variant", Boolean(modelRow?.variants.some((item) => item.id === "high")), modelRow?.variants.map((item) => item.id))

		const preflight = async (label: string) => {
			const fresh = await waitForRegistry(host!, projectDirectory)
			assert(JSON.stringify(fresh.modelIDs) === JSON.stringify([`${PROVIDER}/${MODEL}`]) && JSON.stringify(fresh.providerIDs) === JSON.stringify([PROVIDER]) && fresh.defaultModel === `${PROVIDER}/${MODEL}` && JSON.stringify(fresh.mcpIDs) === "[]", `${label} local-only preflight failed: ${JSON.stringify(fresh)}`)
		}
		const prompt = async (marker: string, text: string, existingSessionID?: string): Promise<{ sessionID: string; outcome?: string }> => {
			await preflight(`before ${marker}`)
			let sessionID = existingSessionID
			if (!sessionID) {
				const created = await host!.client.session.create({ title: marker, location: { directory: projectDirectory } })
				sessionID = created.id
				sessionIDs.push(sessionID)
				assert(created.location.directory === projectDirectory, `${marker} session escaped the isolated project`)
				await host!.client.session.switchAgent({ sessionID, agent: "sisyphus" })
				await host!.client.session.switchModel({ sessionID, model: { providerID: PROVIDER, id: MODEL } })
			}
			const selected = await host!.client.session.get({ sessionID })
			assert(selected.location.directory === projectDirectory && selected.agent === "sisyphus" && modelRef(selected.model) === `${PROVIDER}/${MODEL}` && !selected.parentID, `${marker} session preflight failed`)
			scenarios.set(sessionID, { marker, step: 0 })
			const before = mockRequests.length
			await within(`${marker} prompt`, host!.client.session.prompt({ sessionID, text }))
			await within(`${marker} completion`, host!.client.session.wait({ sessionID }))
			const finished = await host!.client.session.get({ sessionID })
			const ownRequests = mockRequests.slice(before).filter((item) => item.sessionID === sessionID)
			check(`${marker} model requests have native session origin`, ownRequests.length > 0 && ownRequests.every((item) => item.originValid && item.agent === "sisyphus" && item.kind === "primary"), ownRequests.map(({ sessionID, agent, kind, model, originValid }) => ({ sessionID, agent, kind, model, originValid })))
			check(`${marker} session retains selected local model`, modelRef(finished.model) === `${PROVIDER}/${MODEL}` && finished.agent === "sisyphus", { model: modelRef(finished.model), agent: finished.agent, outcome: finished.outcome })
			return { sessionID, outcome: finished.outcome }
		}

		const thinkFirst = await prompt("OMO_QA_THINK_1", "QA_CASE=OMO_QA_THINK_1. Please think through this carefully, then return the exact marker OMO_QA_THINK_FIRST_OK.")
		const thinkSecond = await prompt("OMO_QA_THINK_2", "QA_CASE=OMO_QA_THINK_2. Answer directly in one short sentence, with no special reasoning instruction.", thinkFirst.sessionID)
		const firstThinkRequest = mockRequests.find((item) => item.sessionID === thinkFirst.sessionID && item.marker === "OMO_QA_THINK_1")
		const secondThinkRequest = mockRequests.find((item) => item.sessionID === thinkSecond.sessionID && item.marker === "OMO_QA_THINK_2")
		check("think keyword raises only the first request's wire reasoning effort", Boolean(firstThinkRequest && asRecord(firstThinkRequest.reasoning)?.effort === "high"), firstThinkRequest?.reasoning)
		check("next real user turn does not retain the temporary high overlay", Boolean(secondThinkRequest) && asRecord(secondThinkRequest?.reasoning)?.effort !== "high", secondThinkRequest?.reasoning)
		check("provider payloads include each distinct latest user-turn marker", firstThinkRequest?.wireMarker === "OMO_QA_THINK_1" && secondThinkRequest?.wireMarker === "OMO_QA_THINK_2", { first: firstThinkRequest?.wireMarker, second: secondThinkRequest?.wireMarker })
		check("think requests are distinct turns in the same native session", thinkFirst.sessionID === thinkSecond.sessionID, { first: thinkFirst.sessionID, second: thinkSecond.sessionID })
		check("think scenario completes two successful user turns", thinkFirst.outcome === "succeeded" && thinkSecond.outcome === "succeeded", { thinkFirst, thinkSecond })

		const chain = await prompt("OMO_QA_WEBFETCH_CHAIN", "QA_CASE=OMO_QA_WEBFETCH_CHAIN. Use webfetch on the local redirect-chain fixture and then report its exact final marker.")
		const chainResults = mockRequests.filter((item) => item.marker === "OMO_QA_WEBFETCH_CHAIN").flatMap((item) => item.toolResults)
		check("native webfetch followed the localhost redirect chain", chain.outcome === "succeeded" && chainResults.some((result) => result.includes("OMO_QA_REDIRECT_TARGET")) && redirectRequests.filter((item) => item.path.startsWith("/redirect/")).length === 3 && mockRequests.some((item) => item.sessionID === chain.sessionID && item.wireMarker === "OMO_QA_WEBFETCH_CHAIN"), { chainResults, redirects: redirectRequests.filter((item) => item.path.startsWith("/redirect/")) })

		const loop = await prompt("OMO_QA_WEBFETCH_LOOP", "QA_CASE=OMO_QA_WEBFETCH_LOOP. Use webfetch on the local redirect-loop fixture. Observe the tool failure and then return a short completion marker.")
		const loopResults = mockRequests.filter((item) => item.marker === "OMO_QA_WEBFETCH_LOOP").flatMap((item) => item.toolResults)
		const loopFetches = redirectRequests.filter((item) => item.path.startsWith("/loop/"))
		const loopModelRequests = mockRequests.filter((item) => item.sessionID === loop.sessionID && item.marker === "OMO_QA_WEBFETCH_LOOP")
		const loopRoundTripMs = loopModelRequests.length > 1 ? loopModelRequests.at(-1)!.at - loopModelRequests[0]!.at : Number.POSITIVE_INFINITY
		check("native webfetch returns a bounded error for the localhost redirect loop", loop.outcome === "succeeded" && loopResults.some((result) => /error|timed out|transport/i.test(result)) && loopFetches.length > 0 && loopRoundTripMs >= 0 && loopRoundTripMs <= 6_000 && loopModelRequests.every((item) => item.wireMarker === "OMO_QA_WEBFETCH_LOOP"), { loopResults, redirectRequestsObserved: loopFetches.length, requestedTimeoutSeconds: 1, observedToolRoundTripMs: loopRoundTripMs, hostSchedulingToleranceMs: 5_000 })
		check("every provider request stayed within its exact localhost session and model", mockRequests.length > 0 && mockRequests.every((item) => item.originValid) && originFailures.length === 0, originFailures)
		check("only the local redirect fixture received fetches", redirectRequests.length > 0 && redirectRequests.every((item) => item.path.startsWith("/redirect/") || item.path.startsWith("/loop/")), redirectRequests.map(({ path, method }) => ({ path, method })))
		check("all three sessions remained inside the retained isolated database", sessionIDs.length === 3 && sessionIDs.every((id) => databaseSession(join(tempRoot, "opencode.db"), id)?.directory === projectDirectory), sessionIDs)
		assert(checks.every((entry) => entry.passed), "One or more checks failed")
	} catch (error) {
		failure = error instanceof Error ? error.stack ?? error.message : String(error)
	} finally {
		cleanupCode = await stopHost(host)
		mock.stop(true)
		mockStopped = true
		const hostLog = (host ? `${host.stdout}\n--- stderr ---\n${host.stderr}` : "")
			.replaceAll(PASSWORD, "[redacted-test-password]").replaceAll(API_KEY, "[redacted-fake-key]")
		await Promise.all([
			writeFile(join(EVIDENCE, "server.log"), hostLog),
				writeFile(join(EVIDENCE, "provider-requests.json"), JSON.stringify(mockRequests.map((request) => ({ ...request, userText: request.userText.map((text) => text.slice(0, 500)), toolResults: request.toolResults.map((text) => text.slice(0, 1000)) })), null, 2) + "\n"),
			writeFile(join(EVIDENCE, "runtime.json"), JSON.stringify({
				status: failure ? "failed" : "passed", failure, checks, version, bundleHash, expectedServerSha256: EXPECTED_SERVER_SHA256,
				cli: CLI, pluginDirectory: PLUGIN_DIR, projectDirectory, projectOutsideRepository: !projectDirectory.startsWith(ROOT + sep),
				tempRoot, databasePath, sessionIDs, registry, mockRequests, redirectRequests, originFailures,
				policy: "Fake API key; one enabled localhost provider/model; explicit session model on each turn; MCP catalog empty; isolated HOME/XDG/OMO/Claude/DB; every model request origin-tagged and checked against the native session row.",
				cleanup: { hostExitCode: cleanupCode, mockStopped, tempRootRetained: existsSync(tempRoot), databaseRetained: existsSync(databasePath) },
				startedAt, finishedAt: new Date().toISOString(),
			}, null, 2) + "\n"),
		])
	}
	console.log(JSON.stringify({ status: failure ? "failed" : "passed", evidence: EVIDENCE, bundleHash, checks: checks.length, hostExitCode: cleanupCode, mockStopped }))
	if (failure) process.exitCode = 1
}

await main()
