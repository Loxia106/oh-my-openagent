import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { Database } from "bun:sqlite"
import { OpenCode } from "@opencode/client"

const ROOT = resolve(import.meta.dir, "..")
const EVIDENCE = resolve(process.env.OPENCODE2_EVIDENCE_DIR ?? join(ROOT, ".omo", "evidence", "20260926-opencode2", "runtime-green"))
const PLUGIN_DIR = resolve(process.env.OPENCODE2_PLUGIN_DIR ?? join(ROOT, "dist", "opencode2"))
const OPENCODE_BIN = process.env.OPENCODE2_CLI ? resolve(process.env.OPENCODE2_CLI) : Bun.which("opencode") ?? ""
const QA_PASSWORD = "opencode-v2-qa-only"
const QA_API_KEY = "omo-local-mock-only"
const DEFAULT_TIMEOUT_MS = 90_000
const TEAM_DEPENDENT_SKILLS = ["security-research", "security-review", "team-mode"] as const

type MockRequest = {
	model?: string
	stream?: boolean
	temperature?: number
	top_p?: number
	max_tokens?: number
	max_completion_tokens?: number
	max_output_tokens?: number
	toolNames: string[]
	availableTeamTools: string[]
	messageRoles: string[]
	systemContainsUltrawork: boolean
	systemContainsTeamMode: boolean
	systemContainsManualOnlySkillName: boolean
	systemContainsTeamDependentSkillNames: string[]
	teamModeMentionCount: number
	availableSkillNames: string[]
	toolCallNumber: number
	responsePlan?: string
}

function redact(value: string): string {
	return value
		.replaceAll(QA_PASSWORD, "[redacted-test-password]")
		.replaceAll(QA_API_KEY, "[redacted-test-api-key]")
}

function basicAuth(): string {
	return `Basic ${Buffer.from(`opencode:${QA_PASSWORD}`).toString("base64")}`
}

async function mkdirs(paths: readonly string[]): Promise<void> {
	await Promise.all(paths.map((path) => mkdir(path, { recursive: true })))
}

function sessionCount(databasePath: string): number | null {
	if (!existsSync(databasePath)) return 0
	try {
		const database = new Database(databasePath, { readonly: true, create: false })
		try {
			const result = database.query("SELECT COUNT(*) AS count FROM session_v2").get() as { count?: number } | null
			return typeof result?.count === "number" ? result.count : null
		} finally {
			database.close()
		}
	} catch {
		return null
	}
}

function projectSessionCount(databasePath: string, directory: string): number | null {
	if (!existsSync(databasePath)) return 0
	try {
		const database = new Database(databasePath, { readonly: true, create: false })
		try {
			const result = database.query("SELECT COUNT(*) AS count FROM session_v2 WHERE directory = ?").get(directory) as { count?: number } | null
			return typeof result?.count === "number" ? result.count : null
		} finally {
			database.close()
		}
	} catch {
		return null
	}
}

function projectSessions(databasePath: string, directory: string): Array<{ id: string; parentID?: string; forkSessionID?: string; agent?: string; title?: string }> {
	if (!existsSync(databasePath)) return []
	try {
		const database = new Database(databasePath, { readonly: true, create: false })
		try {
			return database.query("SELECT id, parent_id AS parentID, fork_session_id AS forkSessionID, agent, title FROM session_v2 WHERE directory = ? ORDER BY time_created ASC")
				.all(directory) as Array<{ id: string; parentID?: string; forkSessionID?: string; agent?: string; title?: string }>
		} finally {
			database.close()
		}
	} catch {
		return []
	}
}

function compactPermissions(agent: { id: string; permissions?: readonly { action: string; resource: string; effect: string }[] }) {
	return {
		id: agent.id,
		permissions: (agent.permissions ?? [])
			.filter((rule) => rule.action === "edit" || rule.action === "shell")
			.map(({ action, resource, effect }) => ({ action, resource, effect })),
	}
}

function findToolName(body: Record<string, unknown>, expected: string): string | undefined {
	if (!Array.isArray(body.tools)) return undefined
	for (const entry of body.tools) {
		if (!entry || typeof entry !== "object") continue
		const record = entry as Record<string, unknown>
		const fn = record.function && typeof record.function === "object" ? record.function as Record<string, unknown> : undefined
		const name = typeof record.name === "string" ? record.name : typeof fn?.name === "string" ? fn.name : undefined
		if (name?.toLowerCase() === expected.toLowerCase()) return name
	}
	return undefined
}

function collectSystemText(body: Record<string, unknown>): string {
	if (!Array.isArray(body.messages)) return ""
	return body.messages.flatMap((message) => {
		if (!message || typeof message !== "object") return []
		const record = message as Record<string, unknown>
		if (record.role !== "system" && record.role !== "developer") return []
		return [typeof record.content === "string" ? record.content : ""]
	}).join("\n")
}

function hasUserPromptMarker(body: Record<string, unknown>, marker: string): boolean {
	if (!Array.isArray(body.messages)) return false
	return body.messages.some((message) => {
		if (!message || typeof message !== "object") return false
		const record = message as Record<string, unknown>
		if (record.role !== "user") return false
		const content = record.content
		return typeof content === "string" ? content.includes(marker) : JSON.stringify(content ?? "").includes(marker)
	})
}

function availableSkillNames(systemText: string): string[] {
	const start = systemText.indexOf("<available_skills>")
	if (start < 0) return []
	const end = systemText.indexOf("</available_skills>", start)
	if (end < 0) return []
	const section = systemText.slice(start, end)
	return Array.from(section.matchAll(/<name>([^<]+)<\/name>/g), (match) => match[1].trim())
}

function teamModeMentionCount(systemText: string): number {
	const pattern = /\[team-mode\]|team[-_ ]mode|team_[a-z_]+/gi
	return Array.from(systemText.matchAll(pattern)).length
}

function toolCallResponse(name: string, args: unknown, id: string, model: string, streaming: boolean): Response {
	const created = Math.floor(Date.now() / 1000)
	const call = { index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } }
	if (!streaming) {
		return Response.json({
			id: `chatcmpl-${id}`,
			object: "chat.completion",
			created,
			model,
			choices: [{ index: 0, message: { role: "assistant", content: null, tool_calls: [call] }, finish_reason: "tool_calls" }],
			usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
		})
	}
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

async function waitForServer(client: ReturnType<typeof OpenCode.make>, process: Bun.Subprocess): Promise<void> {
	const deadline = Date.now() + 20_000
	let lastError: unknown
	while (Date.now() < deadline) {
		if (process.exitCode !== null) throw new Error(`OpenCode exited before ready (code ${process.exitCode}).`)
		try {
			await client.server.info()
			return
		} catch (error) {
			lastError = error
			await new Promise((resolve) => setTimeout(resolve, 150))
		}
	}
	const detail = lastError instanceof Error ? ` Last API error: ${lastError.message}` : ""
	throw new Error(`OpenCode 2.0.18 did not become ready within 20 seconds.${detail}`)
}

async function waitForAgentRegistry(client: ReturnType<typeof OpenCode.make>, process: Bun.Subprocess) {
	const deadline = Date.now() + 30_000
	let lastAgents: Awaited<ReturnType<typeof client.agent.list>> | undefined
	let lastPlugins: Awaited<ReturnType<typeof client.plugin.list>> | undefined
	while (Date.now() < deadline) {
		if (process.exitCode !== null) throw new Error(`OpenCode exited while loading plugins (code ${process.exitCode}).`)
		try {
			lastAgents = await client.agent.list()
			lastPlugins = await client.plugin.list()
			const failed = lastPlugins.data.find((plugin) => plugin.state.status === "failed")
			if (failed) throw new Error(`OpenCode plugin failed to load: ${JSON.stringify(failed)}`)
			const ids = new Set(lastAgents.data.map((agent) => agent.id))
			if (ids.has("sisyphus") && ids.has("prometheus")) return { agents: lastAgents, plugins: lastPlugins }
		} catch (error) {
			if (error instanceof Error && error.message.startsWith("OpenCode plugin failed to load:")) throw error
		}
		await new Promise((resolve) => setTimeout(resolve, 200))
	}
	const ids = lastAgents?.data.map((agent) => agent.id) ?? []
	const states = lastPlugins?.data.map(({ id, state }) => ({ id, state })) ?? []
	throw new Error(`Native OMO agents did not register within 30 seconds; last agent IDs=${JSON.stringify(ids)}, plugin states=${JSON.stringify(states)}.`)
}

async function within<T>(label: string, promise: Promise<T>, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
	let timeout: ReturnType<typeof setTimeout> | undefined
	try {
		return await Promise.race([
			promise,
			new Promise<T>((_resolve, reject) => {
				timeout = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms.`)), timeoutMs)
			}),
		])
	} finally {
		if (timeout) clearTimeout(timeout)
	}
}

function reserveLocalPort(): number {
	const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("reserved") })
	const port = reservation.port
	reservation.stop(true)
	if (typeof port !== "number") throw new Error("Could not reserve a localhost port for the QA server.")
	return port
}

async function stopProcess(process: Bun.Subprocess | undefined): Promise<void> {
	if (!process || process.exitCode !== null) return
	process.kill("SIGTERM")
	const settled = await Promise.race([
		process.exited.then(() => true),
		new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5000)),
	])
	if (!settled && process.exitCode === null) {
		process.kill("SIGKILL")
		await process.exited
	}
}

async function main(): Promise<void> {
	if (!OPENCODE_BIN || !existsSync(OPENCODE_BIN)) throw new Error(`OpenCode CLI not found on PATH; set OPENCODE2_CLI to the pinned OpenCode v2.0.18 executable.`)
	if (!existsSync(join(PLUGIN_DIR, "server.js"))) throw new Error(`Native plugin bundle missing ${join(PLUGIN_DIR, "server.js")}; run bun run build:opencode2 or set OPENCODE2_PLUGIN_DIR.`)
	await mkdirs([EVIDENCE])
	const versionResult = Bun.spawnSync([OPENCODE_BIN, "--version"], { stdout: "pipe", stderr: "pipe" })
	const version = new TextDecoder().decode(versionResult.stdout).trim()
	if (!version.includes("2.0.18")) throw new Error(`Expected the pinned real runtime 2.0.18, received: ${version}`)

	const tempRootCreated = await mkdtemp(join(tmpdir(), "opencode2-omo-qa-"))
	const tempRoot = await realpath(tempRootCreated)
	const project = join(tempRoot, "project")
	const home = join(EVIDENCE, "home")
	const xdgData = join(EVIDENCE, "xdg-data")
	const xdgConfig = join(EVIDENCE, "xdg-config")
	const xdgState = join(EVIDENCE, "xdg-state")
	const xdgCache = join(EVIDENCE, "xdg-cache")
	const omoHome = join(EVIDENCE, "omo-home")
	const isolatedPaths = [home, xdgData, xdgConfig, xdgState, xdgCache, omoHome, project]
	await mkdirs(isolatedPaths)
	const isolatedDbPath = join(EVIDENCE, "opencode-qa.db")
	const isolatedSessionsBefore = sessionCount(isolatedDbPath)
	const fixturePath = join(project, "qa-fixture.md")
	await writeFile(fixturePath, "OMO_OPENCODE_V2_QA_FIXTURE_LINE\n", "utf8")
	const manualSkillPath = join(project, ".claude", "skills", "qa-manual-only", "SKILL.md")
	await mkdir(join(project, ".claude", "skills", "qa-manual-only"), { recursive: true })
	await writeFile(manualSkillPath, [
		"---",
		"name: qa-manual-only",
		"description: QA fixture skill that must be invoked manually.",
		"disable-model-invocation: true",
		"---",
		"This isolated QA skill is intentionally excluded from automatic skill hints.",
	].join("\n") + "\n", "utf8")

	const mockRequests: MockRequest[] = []
	let modelCallNumber = 0
	let primaryToolRequestNumber = 0
	const mockModel = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const url = new URL(request.url)
			if (url.pathname.endsWith("/models")) return Response.json({ data: [{ id: "qa-model", object: "model", created: 0, owned_by: "omo-qa" }] })
			if (!url.pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 })
			const body = await request.json() as Record<string, unknown>
			modelCallNumber += 1
			const model = typeof body.model === "string" ? body.model : "qa-model"
			const streaming = body.stream === true
			const toolNames = Array.isArray(body.tools)
				? body.tools.flatMap((tool) => {
					if (!tool || typeof tool !== "object") return []
					const item = tool as Record<string, unknown>
					const fn = item.function && typeof item.function === "object" ? item.function as Record<string, unknown> : undefined
					const name = typeof item.name === "string" ? item.name : typeof fn?.name === "string" ? fn.name : undefined
					return name ? [name] : []
				})
				: []
			const systemText = collectSystemText(body)
			const observation: MockRequest = {
				model,
				stream: streaming,
				temperature: typeof body.temperature === "number" ? body.temperature : undefined,
				top_p: typeof body.top_p === "number" ? body.top_p : undefined,
				max_tokens: typeof body.max_tokens === "number" ? body.max_tokens : undefined,
				max_completion_tokens: typeof body.max_completion_tokens === "number" ? body.max_completion_tokens : undefined,
				max_output_tokens: typeof body.max_output_tokens === "number" ? body.max_output_tokens : undefined,
				toolNames,
				availableTeamTools: toolNames.filter((name) => name.toLowerCase().startsWith("team_")),
				messageRoles: Array.isArray(body.messages) ? body.messages.flatMap((message) => message && typeof message === "object" && typeof (message as Record<string, unknown>).role === "string" ? [(message as Record<string, unknown>).role as string] : []) : [],
				systemContainsUltrawork: /ultrawork|ultra.?work/i.test(systemText),
				systemContainsTeamMode: teamModeMentionCount(systemText) > 0,
				systemContainsManualOnlySkillName: /\bqa-manual-only\b/i.test(systemText),
				systemContainsTeamDependentSkillNames: TEAM_DEPENDENT_SKILLS.filter((name) => new RegExp(`\\b${name}\\b`, "i").test(systemText)),
				teamModeMentionCount: teamModeMentionCount(systemText),
				availableSkillNames: availableSkillNames(systemText),
				toolCallNumber: modelCallNumber,
			}
			mockRequests.push(observation)
			if (hasUserPromptMarker(body, "OMO_QA_CHILD")) {
				observation.responsePlan = "native child completion: OMO_CHILD_OK"
				return textResponse("OMO_CHILD_OK", `omoqa-${modelCallNumber}`, model, streaming)
			}
			if (hasUserPromptMarker(body, "OMO_QA_TUI_BTW")) {
				observation.responsePlan = "native BTW child completion: OMO_QA_TUI_BTW_RESULT"
				return textResponse("OMO_QA_TUI_BTW_RESULT", `omoqa-${modelCallNumber}`, model, streaming)
			}

			if (toolNames.length === 0) {
				observation.responsePlan = "auxiliary text"
				return textResponse("OMO QA auxiliary response", `omoqa-${modelCallNumber}`, model, streaming)
			}
			primaryToolRequestNumber += 1
			if (primaryToolRequestNumber === 1) {
				const readName = findToolName(body, "read")
				if (readName) {
					observation.responsePlan = `tool call: ${readName}`
					return toolCallResponse(readName, { path: fixturePath }, `omoqa-${modelCallNumber}`, model, streaming)
				}
			}
			if (primaryToolRequestNumber === 2) {
				const todoName = findToolName(body, "todowrite")
				if (todoName) {
					observation.responsePlan = `tool call: ${todoName}`
					return toolCallResponse(todoName, { todos: [{ content: "native tool roundtrip", status: "completed" }] }, `omoqa-${modelCallNumber}`, model, streaming)
				}
			}
			if (primaryToolRequestNumber === 3) {
				const shellName = findToolName(body, "bash")
				if (shellName) {
					observation.responsePlan = `tool call: ${shellName}`
					return toolCallResponse(shellName, { command: "touch shell-deny-side-effect", description: "permission QA" }, `omoqa-${modelCallNumber}`, model, streaming)
				}
			}
			if (primaryToolRequestNumber === 4) {
				const taskName = findToolName(body, "task")
				if (taskName) {
					observation.responsePlan = `tool call: ${taskName} (native explore child)`
					return toolCallResponse(taskName, {
						subagent_type: "explore",
						prompt: "OMO_QA_CHILD",
						run_in_background: false,
					}, `omoqa-${modelCallNumber}`, model, streaming)
				}
			}
			observation.responsePlan = "completion text"
			return textResponse("OMO_V2_QA_COMPLETE", `omoqa-${modelCallNumber}`, model, streaming)
		},
	})

	const projectConfig = {
		$schema: "https://opencode.ai/config.json",
		plugins: [PLUGIN_DIR],
		model: "omoqa/qa-model",
		provider: {
			omoqa: {
				name: "OMO QA local mock",
				npm: "@ai-sdk/openai-compatible",
				options: { baseURL: `http://127.0.0.1:${mockModel.port}/v1`, apiKey: QA_API_KEY },
				models: { "qa-model": { name: "OMO QA model", tool_call: true, limit: { context: 200_000, output: 8_192 } } },
			},
		},
		permission: { shell: "deny", edit: "deny" },
	}
	await writeFile(join(project, "opencode.json"), `${JSON.stringify(projectConfig, null, 2)}\n`, "utf8")
	await mkdir(join(project, ".omo"), { recursive: true })
	await writeFile(join(project, ".omo", "omo.jsonc"), `${JSON.stringify({
		telemetry: { enabled: false },
		"[opencode]": {
			agents: { sisyphus: { model: "omoqa/qa-model", temperature: 0.23, top_p: 0.61, maxTokens: 317 } },
			team_mode: { enabled: true },
			hashline_edit: true,
			disabled_mcps: ["websearch", "context7", "grep_app", "lsp"],
			claude_code: { mcp: false },
			telemetry: false,
		},
	}, null, 2)}\n`, "utf8")

	let serverProcess: Bun.Subprocess | undefined
	let stdout = ""
	let stderr = ""
	let stdoutTask: Promise<void> = Promise.resolve()
	let stderrTask: Promise<void> = Promise.resolve()
	let client: ReturnType<typeof OpenCode.make> | undefined
	let outcome: Record<string, unknown> = {}
	let failure: unknown
	let sessionPromptResult: unknown
	let sessionWaitResult: unknown
	let tuiSmoke: Record<string, unknown> | undefined
	try {
		const port = reserveLocalPort()
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
				OPENCODE_DB: isolatedDbPath,
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
		const baseUrl = `http://127.0.0.1:${port}`
		client = OpenCode.make({
			baseUrl,
			headers: {
				Authorization: basicAuth(),
				"x-opencode-directory": project,
			},
		})
		await within("OpenCode server startup", waitForServer(client, serverProcess), 25_000)

		const registry = await within("Native plugin activation", waitForAgentRegistry(client, serverProcess), 32_000)
		const agents = registry.agents
		const pluginList = registry.plugins
		const configEntries = await client.config.get()
		const commands = await client.command.list()
		const skills = await client.skill.list()
		const modelList = await client.model.list()
		outcome = {
			runtime: version,
			pluginDirectory: PLUGIN_DIR,
			projectDirectory: project,
			apiLocation: agents.location.directory,
			initialAgentIds: agents.data.map((agent) => agent.id),
			pluginStates: pluginList.data.map(({ id, source, state }) => ({ id, source, state })),
			configPluginEntries: configEntries.flatMap((entry) => entry.type === "document" ? [{ path: entry.path, plugins: entry.info.plugins }] : []),
			registeredCommandNames: commands.data.map((command) => command.name),
			initialSkillIds: skills.data.map((skill) => skill.id),
			modelIds: modelList.data.map((model) => `${model.providerID}/${model.id}`),
		}
		const initialAgentByID = new Map(agents.data.map((agent) => [agent.id, agent]))
		if (!initialAgentByID.has("sisyphus") || !initialAgentByID.has("prometheus")) throw new Error("Native agent registry did not expose Sisyphus and Prometheus.")

		const session = await client.session.create({ title: "OMO native v2 QA" })
		await client.session.switchAgent({ sessionID: session.id, agent: "sisyphus" })
		await client.session.switchModel({ sessionID: session.id, model: { providerID: "omoqa", id: "qa-model" } })
		await within("Native OpenCode model/tool loop", (async () => {
			sessionPromptResult = await client!.session.prompt({
				sessionID: session.id,
				text: "Use ULTRAWORK for this QA task. The phrase team-mode is a gate check; do not call any team tools. Read the fixture, save a completed todo, attempt a shell command and a file write, then delegate one explore task. Report the fixture line.",
			})
			sessionWaitResult = await client!.session.wait({ sessionID: session.id })
		})())
		// The first session prompt waits for native plugin activation. Read the
		// post-activation registry here so permission evidence includes plugin
		// transforms that may not have run when the early catalog was queried.
		const activatedAgentRegistry = await within("Read native agents after plugin activation", client.agent.list())
		const activatedSkills = await within("Read native skills after plugin activation", client.skill.list())
		const agentByID = new Map(activatedAgentRegistry.data.map((agent) => [agent.id, agent]))
		const prometheus = agentByID.get("prometheus")
		const sisyphus = agentByID.get("sisyphus")
		if (!sisyphus || !prometheus) throw new Error("Activated native agent registry did not expose Sisyphus and Prometheus.")
		const messages = await within("Read native session transcript", client.message.list({ sessionID: session.id }))
		const nativeSessions = projectSessions(isolatedDbPath, project)
		const childRow = nativeSessions.find((candidate) => candidate.parentID === session.id)
		const nativeChild = childRow ? await within("Read native child session", client.session.get({ sessionID: childRow.id })) : undefined
		const childMessages = childRow ? await within("Read native child transcript", client.message.list({ sessionID: childRow.id })) : undefined
		const messageText = JSON.stringify(messages)
		const transcriptToolNames = [...new Set(Array.from(messageText.matchAll(/"name":"([A-Za-z0-9_-]+)"/g), (match) => match[1]))]
		const permissions = compactPermissions(prometheus)
		const sisyphusPermissions = compactPermissions(sisyphus)
		const requestSettings = (sisyphus as unknown as { request?: { settings?: Record<string, unknown> } }).request?.settings
		const hasDeny = (rules: ReturnType<typeof compactPermissions>["permissions"], action: string) => rules.some((rule) => rule.action === action && rule.effect === "deny")
		const allDenied = [permissions, sisyphusPermissions].every((agent) => hasDeny(agent.permissions, "shell") && hasDeny(agent.permissions, "edit"))
		const toolStates: Array<Record<string, unknown>> = messages.data
			.flatMap((message) => "content" in message && Array.isArray(message.content) ? message.content : [])
			.flatMap((part) => part.type === "tool" ? [part as unknown as Record<string, unknown>] : [])
		const completedState = (name: string) => toolStates.find((part) => String(part.name).toLowerCase() === name && (part.state as Record<string, unknown> | undefined)?.status === "completed")
		const erroredState = (names: string[]) => toolStates.find((part) => names.includes(String(part.name).toLowerCase()) && (part.state as Record<string, unknown> | undefined)?.status === "error")
		const readTool = completedState("read")
		const todoTool = completedState("todowrite")
		const taskTool = completedState("task")
		const bashTool = toolStates.find((part) => String(part.name).toLowerCase() === "bash")
		const shellDeniedTool = erroredState(["bash"])
		const editToolsHidden = !mockRequests.flatMap((request) => request.toolNames).some((name) => ["write", "edit", "apply_patch"].includes(name.toLowerCase()))
		const readResult = JSON.stringify(readTool?.state ?? "")
		const todoResult = JSON.stringify(todoTool?.state ?? "")
		const taskResult = JSON.stringify(taskTool?.state ?? "")
		const readRoundtrip = Boolean(readTool && readResult.includes("OMO_OPENCODE_V2_QA_FIXTURE_LINE"))
		const todoRoundtrip = Boolean(todoTool && todoResult.includes("native tool roundtrip"))
		const nativeChildOutput = JSON.stringify(childMessages ?? "")
		const taskRoundtrip = Boolean(taskTool && taskResult.includes("OMO_CHILD_OK") && childRow && nativeChild?.parentID === session.id && nativeChildOutput.includes("OMO_CHILD_OK"))
		const childProviderRequestSeen = mockRequests.some((request) => request.responsePlan === "native child completion: OMO_CHILD_OK")
		const deniedTools = Boolean(shellDeniedTool && editToolsHidden)
		const deniedSideEffectsAbsent = !existsSync(join(project, "shell-deny-side-effect")) && !existsSync(join(project, "edit-deny-side-effect.txt"))
		const contextInjected = mockRequests.some((request) => request.systemContainsUltrawork)
		const settingsSent = mockRequests.some((request) => request.temperature === 0.23 && request.top_p === 0.61 && request.max_completion_tokens === 317)
		const tuiProjectSessionsBefore = projectSessionCount(isolatedDbPath, project)
		const parentMessagesBeforeTui = JSON.stringify((await client.message.list({ sessionID: session.id })).data)
		const mockCallsBeforeTui = mockRequests.length
		const tuiOutputPath = join(EVIDENCE, "tui-pty.json")
		const tuiCommand = [OPENCODE_BIN, "--server", baseUrl, "--session", session.id, project]
		const tuiDriver = Bun.spawn([
			"/usr/bin/python3",
			join(ROOT, "script", "opencode2-pty-driver.py"),
			"--output",
			tuiOutputPath,
			"--",
			...tuiCommand,
		], {
			cwd: project,
			env: {
				PATH: process.env.PATH ?? "/usr/bin:/bin",
				TMPDIR: tmpdir(),
				HOME: home,
				XDG_DATA_HOME: xdgData,
				XDG_CONFIG_HOME: xdgConfig,
				XDG_STATE_HOME: xdgState,
				XDG_CACHE_HOME: xdgCache,
				OPENCODE_DB: isolatedDbPath,
				OMO_HOME: omoHome,
				OPENCODE_DISABLE_MODELS_FETCH: "1",
				OPENCODE_TELEMETRY_DISABLED: "1",
				OPENCODE_SERVER_PASSWORD: QA_PASSWORD,
				OPENCODE_PASSWORD: QA_PASSWORD,
				OMO_TUI_QA_PASSWORD: QA_PASSWORD,
				OMO_TUI_QA_API_KEY: QA_API_KEY,
			},
			stdout: "pipe",
			stderr: "pipe",
		})
		const tuiDriverStdoutTask = new Response(tuiDriver.stdout as ReadableStream<Uint8Array>).text()
		const tuiDriverStderrTask = new Response(tuiDriver.stderr as ReadableStream<Uint8Array>).text()
		const tuiDriverExitCode = await within("Native OpenCode TUI PTY smoke", tuiDriver.exited, 45_000)
		const [tuiDriverStdout, tuiDriverStderr] = await Promise.all([tuiDriverStdoutTask, tuiDriverStderrTask])
		const tuiPty = JSON.parse(await readFile(tuiOutputPath, "utf8")) as Record<string, unknown>
		const tuiSidebar = tuiPty.sidebar as Record<string, unknown> | undefined
		const tuiSidebarRendered = Boolean(tuiSidebar?.omoHeading && tuiSidebar.agentVisible && tuiSidebar.statusVisible)
		const tuiStatusDialogRendered = tuiPty.omoStatusDialogRendered === true
		const tuiBtwDialogRendered = tuiPty.btwDialogRendered === true
		const tuiDialogsDismissed = tuiPty.statusEscapeSent === true && tuiPty.btwEscapeSent === true
		const tuiPluginLoadSucceeded = tuiPty.pluginLoadFailedDiagnostic !== true
		const tuiCleanup = tuiPty.childExited === true && [0, 130, -2, -15].includes(Number(tuiPty.childExitStatus))
		const tuiProjectSessionsAfter = projectSessionCount(isolatedDbPath, project)
		const tuiSessionsIncremented = tuiProjectSessionsBefore !== null && tuiProjectSessionsAfter === tuiProjectSessionsBefore + 1
		const parentMessagesAfterTui = await client.message.list({ sessionID: session.id })
		const tuiParentHistoryUnchanged = JSON.stringify(parentMessagesAfterTui.data) === parentMessagesBeforeTui
		const tuiSessions = projectSessions(isolatedDbPath, project)
		const btwChildRow = tuiSessions.find((candidate) => candidate.forkSessionID === session.id && candidate.id !== session.id)
		const btwChild = btwChildRow ? await client.session.get({ sessionID: btwChildRow.id }) : undefined
		const btwChildMessages = btwChildRow ? await client.message.list({ sessionID: btwChildRow.id }) : undefined
		const btwChildTranscript = JSON.stringify(btwChildMessages?.data ?? [])
		const btwProviderRequestObserved = mockRequests.some((request) => request.responsePlan === "native BTW child completion: OMO_QA_TUI_BTW_RESULT")
		const tuiBtwRoundtrip = tuiPty.btwQuestionSubmissionAttempted === true
			&& tuiPty.btwQuestionResultVisible === true
			&& btwChildRow?.forkSessionID === session.id
			&& btwChildRow?.id !== session.id
			&& btwChildTranscript.includes("OMO_QA_TUI_BTW")
			&& btwChildTranscript.includes("OMO_QA_TUI_BTW_RESULT")
			&& btwProviderRequestObserved
		const tuiModelCallObserved = mockRequests.length > mockCallsBeforeTui && btwProviderRequestObserved
		const automaticallyAvailableSkills = new Set(mockRequests.flatMap((request) => request.availableSkillNames))
		const expectedSkillsInPrompt = ["frontend", "git-master"].every((skillName) => automaticallyAvailableSkills.has(skillName))
		const manualSkillRegistered = activatedSkills.data.some((skill) => String(skill.id) === "qa-manual-only")
		const manualSkillOmittedFromSystem = mockRequests.every((request) => !request.systemContainsManualOnlySkillName)
		const manualSkillOmittedFromPrompt = !automaticallyAvailableSkills.has("qa-manual-only") && manualSkillOmittedFromSystem
		const teamDependentSkillsInRegistry = activatedSkills.data.map((skill) => String(skill.id)).filter((name) => TEAM_DEPENDENT_SKILLS.includes(name as typeof TEAM_DEPENDENT_SKILLS[number]))
		const teamDependentSkillsInPrompt = Array.from(automaticallyAvailableSkills).filter((name) => TEAM_DEPENDENT_SKILLS.includes(name as typeof TEAM_DEPENDENT_SKILLS[number]))
		const teamDependentSkillNamesInSystem = [...new Set(mockRequests.flatMap((request) => request.systemContainsTeamDependentSkillNames))]
		const teamDependentSkillsAbsent = teamDependentSkillsInRegistry.length === 0
			&& teamDependentSkillsInPrompt.length === 0
			&& teamDependentSkillNamesInSystem.length === 0
		const teamModeSkillOmittedFromPrompt = !automaticallyAvailableSkills.has("team-mode")
		const teamModePromptSuppressed = mockRequests.every((request) => !request.systemContainsTeamMode && request.availableTeamTools.length === 0) && teamDependentSkillsAbsent
		tuiSmoke = {
			command: tuiCommand,
			pythonPtyDriver: join(ROOT, "script", "opencode2-pty-driver.py"),
			environment: {
				HOME: home,
				XDG_DATA_HOME: xdgData,
				XDG_CONFIG_HOME: xdgConfig,
				XDG_STATE_HOME: xdgState,
				XDG_CACHE_HOME: xdgCache,
				OPENCODE_DB: isolatedDbPath,
				OMO_HOME: omoHome,
				OPENCODE_DISABLE_MODELS_FETCH: "1",
				OPENCODE_TELEMETRY_DISABLED: "1",
				OPENCODE_SERVER_PASSWORD: "[set, value redacted]",
				OPENCODE_PASSWORD: "[set, value redacted]",
			},
			ptyOutputPath: tuiOutputPath,
			ptyDriverExitCode: tuiDriverExitCode,
			ptyDriverStdout: redact(tuiDriverStdout),
			ptyDriverStderr: redact(tuiDriverStderr),
			sidebar: tuiSidebar,
			omoStatusDialogRendered: tuiStatusDialogRendered,
			omoStatusPaletteEntryVisible: tuiPty.omoStatusPaletteEntryVisible === true,
			omoStatusPaletteOpened: tuiPty.omoStatusPaletteOpened === true,
			btwDialogRendered: tuiBtwDialogRendered,
			btwSuggestionVisible: tuiPty.btwSuggestionVisible === true,
			btwQuestionSubmissionAttempted: tuiPty.btwQuestionSubmissionAttempted === true,
			btwQuestionPromptVisible: tuiPty.btwQuestionPromptVisible === true,
			btwQuestionResultVisible: tuiPty.btwQuestionResultVisible === true,
			btwChild: btwChild ? { id: btwChild.id, parentID: btwChildRow?.parentID, forkSessionID: btwChildRow?.forkSessionID, agent: btwChild.agent, outcome: btwChild.outcome } : null,
			btwChildTranscript,
			btwProviderRequestObserved,
			tuiBtwRoundtrip,
			pluginLoadSucceeded: tuiPluginLoadSucceeded,
			statusEscapeSent: tuiPty.statusEscapeSent === true,
			btwEscapeSent: tuiPty.btwEscapeSent === true,
			processExited: tuiCleanup,
			processExitStatus: tuiPty.childExitStatus,
			projectSessionCountBefore: tuiProjectSessionsBefore,
			projectSessionCountAfter: tuiProjectSessionsAfter,
			projectSessionsIncremented: tuiSessionsIncremented,
			parentMessagesUnchanged: tuiParentHistoryUnchanged,
			mockProviderCallsBefore: mockCallsBeforeTui,
			mockProviderCallsAfter: mockRequests.length,
			mockProviderCallObserved: tuiModelCallObserved,
		}
		outcome = {
			runtime: version,
			pluginDirectory: PLUGIN_DIR,
			projectDirectory: project,
			apiLocation: agents.location.directory,
			initialAgentIds: agents.data.map((agent) => agent.id),
			postActivationAgentIds: activatedAgentRegistry.data.map((agent) => agent.id),
			nativeAgentPermissions: {
				prometheus: prometheus.permissions ?? [],
				sisyphus: sisyphus.permissions ?? [],
			},
			prometheusPermissions: permissions.permissions,
			sisyphusPermissions: sisyphusPermissions.permissions,
			registeredCommandNames: commands.data.map((command) => command.name),
			initialSkillIds: skills.data.map((skill) => skill.id),
			postActivationSkillIds: activatedSkills.data.map((skill) => skill.id),
			modelIds: modelList.data.map((model) => `${model.providerID}/${model.id}`),
			requestSettingsInAgentRegistry: requestSettings ?? {},
			mockRequests,
			interaction: {
				sessionID: session.id,
				sessionPromptResult,
				sessionWaitResult,
				messages: messages.data,
				transcriptToolNames,
				hasCompletionMarker: messageText.includes("OMO_V2_QA_COMPLETE"),
				readResult,
				readRoundtrip,
				todoResult,
				todoRoundtrip,
				taskResult,
				taskRoundtrip,
				nativeChild: nativeChild ? { id: nativeChild.id, parentID: nativeChild.parentID, agent: nativeChild.agent, outcome: nativeChild.outcome } : null,
				nativeChildOutput,
				childProviderRequestSeen,
				deniedToolStates: { bash: bashTool?.state ?? null, editToolsHidden },
				deniedTools,
				deniedSideEffectsAbsent,
				contextInjected,
				settingsSent,
				availableSkillsInPrompt: Array.from(automaticallyAvailableSkills).sort(),
				expectedSkillsInPrompt,
				manualSkillRegistered,
				manualSkillOmittedFromPrompt,
				manualSkillOmittedFromSystem,
				teamDependentSkillsInRegistry,
				teamDependentSkillsInPrompt,
				teamDependentSkillNamesInSystem,
				teamDependentSkillsAbsent,
				teamModePromptSuppressed,
				teamModeSkillOmittedFromPrompt,
			},
			tuiSmoke,
			checks: {
				agents: true,
				rootEditAndShellDenied: allDenied,
				deniedToolExecution: deniedTools,
				deniedSideEffectsAbsent,
				readRoundtrip,
				todoRoundtrip,
				contextInjection: contextInjected,
				agentSettingsInRequest: settingsSent,
				expectedSkillsInPrompt,
				manualSkillRegistered,
				manualSkillOmittedFromPrompt,
				manualSkillOmittedFromSystem,
				teamDependentSkillsAbsent,
				teamModePromptSuppressed,
				taskRoundtrip,
				childProviderRequestSeen,
				nativeChildParentMatches: nativeChild?.parentID === session.id,
				nativeChildOutputObserved: nativeChildOutput.includes("OMO_CHILD_OK"),
				tuiSidebarRendered,
				tuiPluginLoadSucceeded,
				tuiStatusDialogRendered,
				tuiBtwDialogRendered,
				tuiDialogsDismissed,
				tuiBtwRoundtrip,
				tuiParentHistoryUnchanged,
				tuiCleanup,
				tuiSessionsIncremented,
				tuiModelCallObserved,
			},
			isolation: {
				isolatedXdgDataHome: xdgData,
				isolatedDatabasePath: isolatedDbPath,
				databaseOverride: "OPENCODE_DB",
				isolatedSessionCountBefore: isolatedSessionsBefore,
				isolatedSessionCountAfter: sessionCount(isolatedDbPath),
				isolatedDatabaseCreated: existsSync(isolatedDbPath),
				realDatabaseInspected: false,
			},
			process: { opencodePid: serverProcess.pid, mockProviderPort: mockModel.port },
		}
		if (!allDenied || !deniedTools || !deniedSideEffectsAbsent || !readRoundtrip || !todoRoundtrip || !taskRoundtrip || !childProviderRequestSeen || !nativeChild?.parentID || !nativeChildOutput.includes("OMO_CHILD_OK") || !contextInjected || !settingsSent || !expectedSkillsInPrompt || !manualSkillRegistered || !manualSkillOmittedFromPrompt || !teamDependentSkillsAbsent || !teamModePromptSuppressed || !messageText.includes("OMO_V2_QA_COMPLETE") || tuiDriverExitCode !== 0 || !tuiSidebarRendered || !tuiPluginLoadSucceeded || !tuiStatusDialogRendered || !tuiBtwDialogRendered || !tuiDialogsDismissed || !tuiBtwRoundtrip || !tuiParentHistoryUnchanged || !tuiCleanup || !tuiSessionsIncremented || !tuiModelCallObserved) {
			throw new Error(`One or more native runtime assertions failed: ${JSON.stringify(outcome.checks)}`)
		}
	} catch (error) {
		failure = error
		outcome = {
			...outcome,
			failure: error instanceof Error ? { name: error.name, message: redact(error.message) } : redact(String(error)),
			modelCallNumber,
			mockRequests,
			process: { opencodePid: serverProcess?.pid, mockProviderPort: mockModel.port },
		}
	} finally {
		await stopProcess(serverProcess)
		await Promise.all([stdoutTask, stderrTask])
		mockModel.stop(true)
		const allLogs = redact(`${stdout}\n${stderr}`)
		await writeFile(join(EVIDENCE, "server.log"), `${allLogs}\n`, "utf8")
		await writeFile(join(EVIDENCE, "mock-requests.json"), `${JSON.stringify(mockRequests, null, 2)}\n`, "utf8")
		const isolatedSessionsAfter = sessionCount(isolatedDbPath)
		const evidence = {
			...outcome,
			isolation: {
				isolatedXdgDataHome: xdgData,
				isolatedDatabasePath: isolatedDbPath,
				databaseOverride: "OPENCODE_DB",
				isolatedSessionCountBefore: isolatedSessionsBefore,
				isolatedSessionCountAfter: isolatedSessionsAfter,
				isolatedDatabaseCreated: existsSync(isolatedDbPath),
				realDatabaseInspected: false,
			},
			cleanup: { opencodeChildStopped: serverProcess?.exitCode !== null, mockProviderStopped: true },
		}
		await writeFile(join(EVIDENCE, "runtime.json"), `${JSON.stringify(evidence, null, 2)}\n`, "utf8")
		await rm(tempRoot, { recursive: true, force: true })
	}
	if (failure) throw failure
	console.log(`OpenCode ${version} native QA passed; evidence: ${EVIDENCE}`)
}

await main()
