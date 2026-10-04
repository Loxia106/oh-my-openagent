/** Shared isolated OpenCode 2.0.22 host harness for the native OMO QA drivers. */
import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises"
import { isAbsolute, join, resolve, sep } from "node:path"
import { tmpdir } from "node:os"
import { OpenCode } from "@opencode/client"

export const ROOT = resolve(import.meta.dir, "..")
export const PROVIDER = "omoqa"
export const TIMEOUT_MS = 60_000
export const REQUEST_KINDS = new Set(["primary", "compaction", "title", "generate"])

export type Client = ReturnType<typeof OpenCode.make>
export type Check = { name: string; passed: boolean; detail?: unknown }
export type QaModel = { id: string; context: number; output: number; variants?: Record<string, Record<string, unknown>> }
export type MockRequest = {
	index: number
	at: number
	sessionID?: string
	kind?: string
	model: string
	users: string[]
	toolResults: string[]
	toolNames: string[]
	system: string[]
	bodyChars: number
	originValid: boolean
	path: string
	body: Record<string, unknown>
}
export type Host = {
	port: number
	process: Bun.Subprocess
	client: Client
	stdout: string
	stderr: string
	stdoutTask: Promise<void>
	stderrTask: Promise<void>
}

export function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message)
}

export async function within<T>(label: string, promise: Promise<T>, timeoutMs = TIMEOUT_MS): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined
	try {
		return await Promise.race([
			promise,
			new Promise<T>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs) }),
		])
	} finally {
		if (timer) clearTimeout(timer)
	}
}

export function reservePort(): number {
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("reserved") })
	const port = server.port
	server.stop(true)
	assert(typeof port === "number", "Could not reserve an isolated localhost port")
	return port
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

export function contentText(value: unknown): string {
	if (typeof value === "string") return value
	if (Array.isArray(value)) return value.map(contentText).filter(Boolean).join("\n")
	const row = asRecord(value)
	if (!row) return ""
	if (typeof row.text === "string") return row.text
	if (row.content !== undefined) return contentText(row.content)
	return ""
}

export function modelRef(value: unknown): string | undefined {
	const row = asRecord(value)
	return typeof row?.providerID === "string" && typeof row.id === "string" ? `${row.providerID}/${row.id}` : undefined
}

function roleTexts(body: Record<string, unknown>, role: string): string[] {
	if (!Array.isArray(body.messages)) return []
	return body.messages.flatMap((item) => {
		const row = asRecord(item)
		return row?.role === role ? [contentText(row.content)] : []
	})
}

export function toolNames(body: Record<string, unknown>): string[] {
	if (!Array.isArray(body.tools)) return []
	return body.tools.flatMap((item) => {
		const row = asRecord(item)
		const fn = asRecord(row?.function) ?? row
		return typeof fn?.name === "string" ? [fn.name] : []
	})
}

export type Usage = { prompt: number; completion: number }

function sseResponse(chunks: unknown[]): Response {
	return new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", {
		headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive" },
	})
}

function usageChunk(id: string, created: number, model: string, usage: Usage | undefined) {
	return usage ? [{ id, object: "chat.completion.chunk", created, model, choices: [], usage: { prompt_tokens: usage.prompt, completion_tokens: usage.completion, total_tokens: usage.prompt + usage.completion } }] : []
}

export function sse(text: string, id: string, model: string, usage?: Usage): Response {
	const created = Math.floor(Date.now() / 1000)
	const chatID = `chatcmpl-${id}`
	return sseResponse([
		{ id: chatID, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] },
		{ id: chatID, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
		...usageChunk(chatID, created, model, usage),
	])
}

export function toolSse(calls: Array<{ name: string; args: Record<string, unknown> }>, id: string, model: string, usage?: Usage): Response {
	const created = Math.floor(Date.now() / 1000)
	const chatID = `chatcmpl-${id}`
	const toolCalls = calls.map((call, index) => ({ index, id: `${id}-tool-${index}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args) } }))
	return sseResponse([
		{ id: chatID, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { role: "assistant", tool_calls: toolCalls }, finish_reason: null }] },
		{ id: chatID, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
		...usageChunk(chatID, created, model, usage),
	])
}

export type MockHandler = (request: MockRequest, context: { turn: (key: string) => number }) => Response | Promise<Response>

export type Mock = {
	origin: string
	requests: MockRequest[]
	originFailures: unknown[]
	unexpectedPaths: string[]
	stop: () => void
}

/**
 * Local OpenAI-compatible fixture. Session requests must carry the origin probe's session/kind headers.
 * `allowUnattributed` lists models that may be called outside a session (for example `generate.text`).
 */
export function startMock(models: readonly QaModel[], handler: MockHandler, options: { allowUnattributed?: readonly string[] } = {}): Mock {
	const requests: MockRequest[] = []
	const originFailures: unknown[] = []
	const unexpectedPaths: string[] = []
	const turns = new Map<string, number>()
	const known = new Set(models.map((model) => model.id))
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const url = new URL(request.url)
			if (url.pathname === "/v1/models") return Response.json({ data: models.map((model) => ({ id: model.id, object: "model", created: 0, owned_by: "omo-qa" })) })
			if (url.pathname !== "/v1/chat/completions" || request.method !== "POST") {
				unexpectedPaths.push(`${request.method} ${url.pathname}`)
				return new Response("unexpected path", { status: 404 })
			}
			const text = await request.text()
			const body = JSON.parse(text) as Record<string, unknown>
			const sessionID = request.headers.get("x-omo-qa-session-id") ?? undefined
			const kind = request.headers.get("x-omo-qa-kind") ?? undefined
			const model = typeof body.model === "string" ? body.model : ""
			const attributed = Boolean(sessionID && kind && REQUEST_KINDS.has(kind))
			const originValid = known.has(model) && (attributed || (!sessionID && !kind && (options.allowUnattributed ?? []).includes(model)))
			const row: MockRequest = {
				index: requests.length,
				at: Date.now(),
				sessionID,
				kind: kind ?? (attributed ? undefined : "unattributed"),
				model,
				users: roleTexts(body, "user"),
				toolResults: roleTexts(body, "tool"),
				toolNames: toolNames(body),
				system: roleTexts(body, "system"),
				bodyChars: text.length,
				originValid,
				path: url.pathname,
				body,
			}
			requests.push(row)
			if (!originValid) {
				originFailures.push({ ...row, body: undefined })
				return Response.json({ error: { message: "Rejected nonlocal or unattributed QA request" } }, { status: 400 })
			}
			return handler(row, {
				turn: (key) => {
					const next = (turns.get(key) ?? 0) + 1
					turns.set(key, next)
					return next
				},
			})
		},
	})
	return { origin: `http://127.0.0.1:${server.port}`, requests, originFailures, unexpectedPaths, stop: () => server.stop(true) }
}

export type Isolation = {
	attempt: string
	tempRoot: string
	project: string
	serverCwd: string
	home: string
	xdgData: string
	xdgConfig: string
	xdgState: string
	xdgCache: string
	omoHome: string
	claudeHome: string
	claudePlugins: string
	probeDirectory: string
	databasePath: string
}

export async function verifyArtifact(pluginDir: string, expectedSHA: string, cli: string): Promise<{ actualSHA: string; cliVersion: string }> {
	assert(cli && isAbsolute(cli) && existsSync(cli), "Set OPENCODE2_CLI to an explicit absolute OpenCode 2.0.22 executable")
	assert(/^[a-f0-9]{64}$/i.test(expectedSHA), "Set OPENCODE2_EXPECTED_SERVER_SHA256 to the frozen server SHA-256")
	assert(existsSync(join(pluginDir, "server.js")), `Missing frozen server bundle at ${pluginDir}`)
	const actualSHA = createHash("sha256").update(await readFile(join(pluginDir, "server.js"))).digest("hex")
	assert(actualSHA === expectedSHA, `Frozen bundle hash mismatch: expected ${expectedSHA}, got ${actualSHA}`)
	const version = Bun.spawnSync([cli, "--version"], { stdout: "pipe", stderr: "pipe" })
	assert(version.exitCode === 0 && version.stdout.toString().includes("2.0.22"), `Expected OpenCode 2.0.22: ${version.stdout.toString()} ${version.stderr.toString()}`)
	return { actualSHA, cliVersion: version.stdout.toString().trim() }
}

export async function prepareIsolation(evidenceDir: string, prefix: string): Promise<Isolation> {
	const evidenceRoot = join(ROOT, ".omo/evidence")
	const evidence = await realpath(evidenceDir).catch(async () => { await mkdir(evidenceDir, { recursive: true }); return realpath(evidenceDir) })
	const relative = evidence.slice(evidenceRoot.length + 1)
	assert(evidence.startsWith(evidenceRoot + sep) && relative.length > 0 && !relative.includes(sep), "Evidence must be one direct child under .omo/evidence")
	const attempt = join(evidence, `attempt-${Date.now()}`)
	await mkdir(attempt, { recursive: true })
	const tempRoot = await realpath(await mkdtemp(join(tmpdir(), prefix)))
	const paths = {
		project: join(tempRoot, "project"),
		serverCwd: join(tempRoot, "server-cwd"),
		home: join(tempRoot, "home"),
		xdgData: join(tempRoot, "xdg-data"),
		xdgConfig: join(tempRoot, "xdg-config"),
		xdgState: join(tempRoot, "xdg-state"),
		xdgCache: join(tempRoot, "xdg-cache"),
		omoHome: join(tempRoot, "omo-home"),
		claudeHome: join(tempRoot, "claude-home"),
		claudePlugins: join(tempRoot, "claude-plugins"),
		probeDirectory: join(tempRoot, "origin-probe"),
	}
	await Promise.all([...Object.values(paths), join(paths.project, ".omo")].map((path) => mkdir(path, { recursive: true })))
	const project = await realpath(paths.project)
	assert(!project.startsWith(ROOT + sep), "QA project must be outside the checkout")
	return { attempt, tempRoot, ...paths, project, databasePath: join(tempRoot, "opencode.db") }
}

/** A second local plugin tags every session request with its session/kind and blocks nonlocal routes. */
export async function writeOriginProbe(directory: string, probeID: string, mockOrigin: string, models: readonly QaModel[]): Promise<void> {
	const allowed = models.map((model) => model.id)
	await writeFile(join(directory, "index.js"), `export default { id: ${JSON.stringify(probeID)}, setup: async ({ session }) => {
	const origin = ${JSON.stringify(mockOrigin)};
	const allowed = new Set(${JSON.stringify(allowed)});
	const model = await session.hook("model.request", (event) => {
		if (event.model.providerID !== ${JSON.stringify(PROVIDER)} || !allowed.has(event.model.id)) throw new Error("QA blocked nonlocal model");
	});
	const http = await session.hook("http.request", (event) => {
		if (new URL(event.request.url).origin !== origin) throw new Error("QA blocked nonlocal HTTP destination");
		const headers = new Headers(event.request.headers);
		if (event.sessionID) headers.set("x-omo-qa-session-id", event.sessionID);
		if (event.kind) headers.set("x-omo-qa-kind", event.kind);
		event.request = new Request(event.request, { headers });
	});
	return async () => { await Promise.all([model.dispose(), http.dispose()]); };
} }\n`)
}

export type HostConfig = {
	isolation: Isolation
	pluginDir: string
	probeID: string
	mockOrigin: string
	models: readonly QaModel[]
	defaultModel: string
	omo: Record<string, unknown>
	permission?: Record<string, unknown>
	extraOpencode?: Record<string, unknown>
}

export async function writeHostConfig(config: HostConfig): Promise<Record<string, unknown>> {
	const providerModels = Object.fromEntries(config.models.map((model) => [model.id, {
		name: `Local fake ${model.id}`,
		tool_call: true,
		limit: { context: model.context, output: model.output },
		...(model.variants ? { variants: model.variants } : {}),
	}]))
	const provider = {
		name: "Isolated OMO QA mock",
		npm: "@ai-sdk/openai-compatible",
		options: { baseURL: `${config.mockOrigin}/v1`, apiKey: "omo-qa-fake-key-only" },
		models: providerModels,
	}
	const opencode = {
		$schema: "https://opencode.ai/config.json",
		plugins: [config.isolation.probeDirectory, config.pluginDir],
		enabled_providers: [PROVIDER],
		model: `${PROVIDER}/${config.defaultModel}`,
		default_agent: "sisyphus",
		provider: { [PROVIDER]: provider },
		mcp: {},
		telemetry: false,
		permission: config.permission ?? { read: "allow", edit: "allow", grep: "allow", glob: "allow", shell: "allow", task: "allow", subagent: "allow", webfetch: "allow" },
		...config.extraOpencode,
	}
	await writeFile(join(config.isolation.project, "opencode.json"), JSON.stringify(opencode, null, 2) + "\n")
	await writeFile(join(config.isolation.project, ".omo", "omo.jsonc"), JSON.stringify({
		telemetry: { enabled: false },
		"[opencode]": {
			telemetry: false,
			disabled_mcps: ["websearch", "context7", "grep_app", "lsp"],
			mcp_env_allowlist: [],
			claude_code: { mcp: false, agents: false, skills: false, commands: false, plugins: false, hooks: false },
			// sg provisioning downloads a pinned release; keep isolated runs localhost-only.
			disabled_hooks: ["ast-grep-sg-provision"],
			...config.omo,
		},
	}, null, 2) + "\n")
	return { ...opencode, provider: { [PROVIDER]: { ...provider, options: { baseURL: `${config.mockOrigin}/v1`, apiKey: "[redacted fake key]" } } } }
}

export function hostEnv(isolation: Isolation, password: string): Record<string, string> {
	return {
		PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
		TMPDIR: isolation.tempRoot, HOME: isolation.home, XDG_DATA_HOME: isolation.xdgData, XDG_CONFIG_HOME: isolation.xdgConfig,
		XDG_STATE_HOME: isolation.xdgState, XDG_CACHE_HOME: isolation.xdgCache, OMO_HOME: isolation.omoHome,
		CLAUDE_CONFIG_DIR: isolation.claudeHome, CLAUDE_PLUGINS_HOME: isolation.claudePlugins,
		OPENCODE_DB: isolation.databasePath, OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_TELEMETRY_DISABLED: "1",
		OPENCODE_SERVER_PASSWORD: password, OPENCODE_PASSWORD: password,
	}
}

export async function startHost(cli: string, isolation: Isolation, password: string, extraPath?: string): Promise<Host> {
	const port = reservePort()
	const env = hostEnv(isolation, password)
	if (extraPath) env.PATH = `${extraPath}:${env.PATH}`
	const process = Bun.spawn([cli, "--print-logs", "--log-level", "debug", "serve", "--hostname", "127.0.0.1", "--port", String(port)], {
		cwd: isolation.serverCwd, env, stdout: "pipe", stderr: "pipe",
	})
	const auth = Buffer.from(`opencode:${password}`).toString("base64")
	const host: Host = {
		port, process,
		client: OpenCode.make({ baseUrl: `http://127.0.0.1:${port}`, headers: { Authorization: `Basic ${auth}`, "x-opencode-directory": isolation.project } }),
		stdout: "", stderr: "", stdoutTask: Promise.resolve(), stderrTask: Promise.resolve(),
	}
	host.stdoutTask = new Response(process.stdout as ReadableStream<Uint8Array>).text().then((text) => { host.stdout = text })
	host.stderrTask = new Response(process.stderr as ReadableStream<Uint8Array>).text().then((text) => { host.stderr = text })
	const readyBy = Date.now() + 25_000
	while (Date.now() < readyBy) {
		if (process.exitCode !== null) throw new Error(`OpenCode exited early (${process.exitCode})`)
		try { await host.client.server.info(); break } catch { await Bun.sleep(100) }
	}
	await within("OpenCode server ready", host.client.server.info(), 1_000)
	return host
}

export async function stopHost(host: Host | undefined): Promise<number | null> {
	if (!host) return null
	if (host.process.exitCode === null) host.process.kill("SIGTERM")
	const stopped = await Promise.race([host.process.exited.then(() => true), Bun.sleep(5_000).then(() => false)])
	if (!stopped && host.process.exitCode === null) {
		host.process.kill("SIGKILL")
		await host.process.exited
	}
	await Promise.all([host.stdoutTask, host.stderrTask])
	return host.process.exitCode
}

/** Both plugins active, exactly the fixture models, the expected default and no MCP servers. */
export async function preflight(host: Host, probeID: string, models: readonly QaModel[], defaultModel: string, agent = "sisyphus"): Promise<Record<string, unknown>> {
	const expected = models.map((model) => `${PROVIDER}/${model.id}`).sort().join("\n")
	const activeBy = Date.now() + 45_000
	let rows: Record<string, unknown> = {}
	while (Date.now() < activeBy) {
		const [plugins, agents] = await Promise.all([host.client.plugin.list(), host.client.agent.list()])
		const failed = plugins.data.find((item) => item.state.status === "failed")
		assert(!failed, `Plugin failed before prompts: ${JSON.stringify({ id: failed?.id, state: failed?.state })}`)
		const omo = plugins.data.some((item) => item.id === "oh-my-openagent" && item.state.status === "active")
		const probe = plugins.data.some((item) => item.id === probeID && item.state.status === "active")
		if (omo && probe && agents.data.some((entry) => entry.id === agent)) {
			const [listed, providers, fallback, mcps] = await Promise.all([host.client.model.list(), host.client.provider.list(), host.client.model.default(), host.client.mcp.list()])
			const modelIDs = listed.data.map((entry) => `${entry.providerID}/${entry.id}`).sort()
			rows = {
				plugins: plugins.data.map(({ id, state }) => ({ id, status: state.status })),
				agents: agents.data.map((entry) => entry.id).sort(),
				modelIDs,
				limits: listed.data.map((entry) => ({ id: `${entry.providerID}/${entry.id}`, limit: entry.limit })),
				providerIDs: providers.data.map((entry) => entry.id).sort(),
				defaultModel: modelRef(fallback.data),
				mcpIDs: mcps.data.map((entry) => entry.name).sort(),
			}
			if (modelIDs.join("\n") === expected && (rows.providerIDs as string[]).join("\n") === PROVIDER &&
				rows.defaultModel === `${PROVIDER}/${defaultModel}` && (rows.mcpIDs as string[]).length === 0) return rows
		}
		await Bun.sleep(150)
	}
	throw new Error(`Native isolated preflight failed: ${JSON.stringify(rows)}`)
}

export async function createRootSession(client: Client, directory: string, title: string, agent: string, model: string): Promise<string> {
	const created = await client.session.create({ title, location: { directory } })
	assert(created.location.directory === directory, `Session ${created.id} escaped the isolated project`)
	await client.session.switchAgent({ sessionID: created.id, agent })
	await client.session.switchModel({ sessionID: created.id, model: { providerID: PROVIDER, id: model } })
	const session = await client.session.get({ sessionID: created.id })
	assert(session.location.directory === directory && session.agent === agent && modelRef(session.model) === `${PROVIDER}/${model}` && !session.parentID,
		`Session ownership/model preflight failed: ${JSON.stringify({ directory: session.location.directory, agent: session.agent, model: modelRef(session.model), parentID: session.parentID })}`)
	return created.id
}

export async function waitFor<T>(label: string, predicate: () => Promise<T | undefined> | T | undefined, timeoutMs = 20_000): Promise<T> {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		const value = await predicate()
		if (value !== undefined) return value
		await Bun.sleep(100)
	}
	throw new Error(`${label} did not become true before timeout`)
}

export async function promptAndWait(client: Client, sessionID: string, text: string, label: string, timeoutMs = TIMEOUT_MS): Promise<void> {
	await within(`${label} prompt`, client.session.prompt({ sessionID, text }), timeoutMs)
	await within(`${label} execution`, client.session.wait({ sessionID }), timeoutMs)
}

export function sha256(text: string | Uint8Array): string {
	return createHash("sha256").update(text).digest("hex")
}

export async function writeEvidence(attempt: string, name: string, value: unknown): Promise<void> {
	await writeFile(join(attempt, name), typeof value === "string" ? value : JSON.stringify(value, null, 2) + "\n")
}

export function gitState(): { gitHead: string; dirtyTree: boolean } {
	return {
		gitHead: Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: ROOT, stdout: "pipe", stderr: "pipe" }).stdout.toString().trim(),
		dirtyTree: Bun.spawnSync(["git", "status", "--short"], { cwd: ROOT, stdout: "pipe", stderr: "pipe" }).stdout.toString().trim().length > 0,
	}
}
