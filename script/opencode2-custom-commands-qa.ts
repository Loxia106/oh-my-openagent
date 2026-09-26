/**
 * Isolated OpenCode 2.0.18 custom-command smoke using a localhost mock only.
 * Run with explicit binaries/frozen artifact:
 * OPENCODE2_CLI=/absolute/path/opencode \
 * OPENCODE2_EXPECTED_SERVER_SHA256=<64-hex-sha256> \
 * bun script/opencode2-custom-commands-qa.ts
 * OPENCODE2_QA_EVIDENCE_DIR may select a subdirectory under .omo/evidence/.
 */
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { tmpdir } from "node:os"
import { Database } from "bun:sqlite"
import { OpenCode } from "@opencode/client"

const ROOT = resolve(import.meta.dir, "..")
const EVIDENCE_ROOT = join(ROOT, ".omo", "evidence")
const EVIDENCE = resolve(process.env.OPENCODE2_QA_EVIDENCE_DIR ?? join(EVIDENCE_ROOT, "20260927-native-custom-commands"))
const PLUGIN_DIR = resolve(process.env.OPENCODE2_PLUGIN_DIR ?? join(ROOT, "dist", "opencode2"))
const OPENCODE_CLI_INPUT = process.env.OPENCODE2_CLI?.trim() ?? ""
const OPENCODE_BIN = OPENCODE_CLI_INPUT ? resolve(OPENCODE_CLI_INPUT) : ""
const EXPECTED_SERVER_SHA256 = process.env.OPENCODE2_EXPECTED_SERVER_SHA256 ?? ""
const QA_PASSWORD = "custom-command-local-qa-only"
const QA_API_KEY = "custom-command-mock-key-only"
const MODEL_PROVIDER = "omoqa"
const MODEL_ID = "qa-model"
const TIMEOUT_MS = 40_000

type MockRequest = {
	model: string
	userText: string
	stream: boolean
}

type CommandObservation = {
	name: string
	marker: string
	requestCountBefore: number
	requestCountAfter: number
	outcome: string | undefined
	markerReachedProvider: boolean
}

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message)
}

function redact(value: string): string {
	return value.replaceAll(QA_PASSWORD, "[redacted-test-password]").replaceAll(QA_API_KEY, "[redacted-test-api-key]")
}

function basicAuth(): string {
	return `Basic ${Buffer.from(`opencode:${QA_PASSWORD}`).toString("base64")}`
}

function responseText(body: Record<string, unknown>): string {
	if (typeof body.content === "string") return body.content
	if (!Array.isArray(body.content)) return ""
	return body.content.flatMap((part) => {
		if (!part || typeof part !== "object") return []
		const item = part as Record<string, unknown>
		return typeof item.text === "string" ? [item.text] : []
	}).join("\n")
}

function streamedCompletion(text: string, id: string, model: string): Response {
	const created = Math.floor(Date.now() / 1000)
	const chunks = [
		{ id: `chatcmpl-${id}`, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] },
		{ id: `chatcmpl-${id}`, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
	]
	return new Response(`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`, {
		headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive" },
	})
}

function countSessions(databasePath: string): number | null {
	if (!existsSync(databasePath)) return 0
	try {
		const database = new Database(databasePath, { readonly: true, create: false })
		try {
			const row = database.query("SELECT COUNT(*) AS count FROM session_v2").get() as { count?: number } | null
			return typeof row?.count === "number" ? row.count : null
		} finally {
			database.close()
		}
	} catch {
		return null
	}
}

function reservePort(): number {
	const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("reserved") })
	const port = reservation.port
	reservation.stop(true)
	assert(typeof port === "number", "Unable to reserve an isolated localhost port")
	return port
}

async function within<T>(name: string, promise: Promise<T>, timeoutMs = TIMEOUT_MS): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined
	try {
		return await Promise.race([
			promise,
			new Promise<T>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error(`${name} timed out after ${timeoutMs}ms`)), timeoutMs)
			}),
		])
	} finally {
		if (timer) clearTimeout(timer)
	}
}

async function stopProcess(child: Bun.Subprocess | undefined): Promise<number | null> {
	if (!child) return null
	if (child.exitCode === null) {
		child.kill("SIGTERM")
		const stopped = await Promise.race([
			child.exited.then(() => true),
			new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5_000)),
		])
		if (!stopped && child.exitCode === null) {
			child.kill("SIGKILL")
			await child.exited
		}
	}
	return child.exitCode
}

async function waitForCommands(client: ReturnType<typeof OpenCode.make>, child: Bun.Subprocess, expected: string[]) {
	const deadline = Date.now() + 30_000
	let lastNames: string[] = []
	let pluginStates: unknown[] = []
	while (Date.now() < deadline) {
		if (child.exitCode !== null) throw new Error(`OpenCode exited during activation (code ${child.exitCode})`)
		const [commands, plugins] = await Promise.all([client.command.list(), client.plugin.list()])
		lastNames = commands.data.map((item) => item.name)
		pluginStates = plugins.data.map(({ id, state }) => ({ id, state }))
		const failed = plugins.data.find((plugin) => plugin.state.status === "failed")
		if (failed) throw new Error(`Plugin failed to load: ${JSON.stringify(failed)}`)
		if (expected.every((name) => lastNames.includes(name))) return { names: lastNames, pluginStates }
		await new Promise((resolve) => setTimeout(resolve, 150))
	}
	throw new Error(`Custom commands did not register; expected=${JSON.stringify(expected)}, observed=${JSON.stringify(lastNames)}, plugins=${JSON.stringify(pluginStates)}`)
}

function frontmatter(description: string, body: string, options: Record<string, string | boolean> = {}): string {
	const fields = [`description: ${JSON.stringify(description)}`, ...Object.entries(options).map(([key, value]) => `${key}: ${typeof value === "boolean" ? value : JSON.stringify(value)}`)]
	return `---\n${fields.join("\n")}\n---\n${body}\n`
}

async function main(): Promise<void> {
	assert(OPENCODE_BIN && existsSync(OPENCODE_BIN), "Set OPENCODE2_CLI to an explicit absolute path to the pinned OpenCode 2.0.18 executable")
	assert(isAbsolute(OPENCODE_CLI_INPUT), "OPENCODE2_CLI must be an absolute path")
	assert(/^[a-f0-9]{64}$/i.test(EXPECTED_SERVER_SHA256), "Set OPENCODE2_EXPECTED_SERVER_SHA256 to the expected 64-character bundle SHA-256")
	const evidenceRelative = relative(EVIDENCE_ROOT, EVIDENCE)
	assert(evidenceRelative !== "" && evidenceRelative !== ".." && !evidenceRelative.startsWith(`..${sep}`)
		&& !isAbsolute(evidenceRelative) && !evidenceRelative.includes(sep),
		`Choose one direct child directory under ${EVIDENCE_ROOT} for evidence`)
	await mkdir(EVIDENCE_ROOT, { recursive: true })
	const evidenceRoot = await realpath(EVIDENCE_ROOT)
	await mkdir(EVIDENCE, { recursive: true })
	const evidenceDirectory = await realpath(EVIDENCE)
	assert(dirname(evidenceDirectory) === evidenceRoot, `Evidence directory must remain directly under ${evidenceRoot}`)
	assert(existsSync(join(PLUGIN_DIR, "server.js")), `Native plugin bundle not found: ${join(PLUGIN_DIR, "server.js")}`)
	const serverHash = createHash("sha256").update(await readFile(join(PLUGIN_DIR, "server.js"))).digest("hex")
	assert(serverHash === EXPECTED_SERVER_SHA256, `Unexpected bundle hash ${serverHash}; expected the frozen accepted bundle ${EXPECTED_SERVER_SHA256}`)
	const versionResult = Bun.spawnSync([OPENCODE_BIN, "--version"], { stdout: "pipe", stderr: "pipe" })
	const version = new TextDecoder().decode(versionResult.stdout).trim()
	assert(versionResult.exitCode === 0 && version.includes("2.0.18"), `Expected OpenCode 2.0.18, got ${version}`)

	const runDirectory = join(EVIDENCE, `host-run-${Date.now()}`)
	await mkdir(runDirectory, { recursive: true })
	const tempCreated = await mkdtemp(join(tmpdir(), "omo-custom-command-host-"))
	const tempRoot = await realpath(tempCreated)
	const project = await realpath(join(tempRoot, "project")).catch(async () => {
		await mkdir(join(tempRoot, "project"), { recursive: true })
		return realpath(join(tempRoot, "project"))
	})
	const hostCwd = join(tempRoot, "opencode-server-cwd")
	const home = join(tempRoot, "home")
	const xdgData = join(tempRoot, "xdg-data")
	const xdgConfig = join(tempRoot, "xdg-config")
	const xdgState = join(tempRoot, "xdg-state")
	const xdgCache = join(tempRoot, "xdg-cache")
	const omoHome = join(tempRoot, "omo-home")
	const claudeHome = join(tempRoot, "claude-config")
	const pluginHome = join(tempRoot, "claude-plugins")
	const settingsPath = join(tempRoot, "claude-settings.json")
	const databasePath = join(tempRoot, "opencode-qa.db")
	const paths = [hostCwd, home, xdgData, xdgConfig, xdgState, xdgCache, omoHome, claudeHome, pluginHome, join(project, ".omo")]
	await Promise.all(paths.map((path) => mkdir(path, { recursive: true })))
	const pluginInstall = join(pluginHome, "install", "qa-scope-probe")
	await mkdir(join(pluginInstall, ".claude-plugin"), { recursive: true })
	await mkdir(join(pluginInstall, "commands"), { recursive: true })
	await mkdir(join(claudeHome, "commands"), { recursive: true })
	await mkdir(join(project, ".claude", "commands"), { recursive: true })

	await writeFile(join(claudeHome, "commands", "user-only.md"), frontmatter("User command", "USER_ONLY_MARKER $ARGUMENTS", { agent: "qa-command-agent" }))
	await writeFile(join(claudeHome, "commands", "layered.md"), frontmatter("User precedence loser", "USER_LAYERED_MARKER $ARGUMENTS", { agent: "qa-command-agent" }))
	await writeFile(join(claudeHome, "commands", "collision.md"), frontmatter("Imported collision loser", "IMPORTED_COLLISION_MARKER $ARGUMENTS", { agent: "qa-command-agent" }))
	await writeFile(join(claudeHome, "commands", "unsafe-shell.md"), frontmatter("Unsupported shell fixture", "Do !`printf SHOULD_NOT_RUN` before $ARGUMENTS"))
	await writeFile(join(claudeHome, "commands", "unsafe-subtask.md"), frontmatter("Unsupported subtask fixture", "SUBTASK_MUST_NOT_RUN $ARGUMENTS", { subtask: true }))
	await writeFile(join(project, ".claude", "commands", "project-only.md"), frontmatter("Project command", "PROJECT_ONLY_MARKER $ARGUMENTS", { agent: "qa-command-agent" }))
	await writeFile(join(project, ".claude", "commands", "layered.md"), frontmatter("Project precedence winner", "PROJECT_LAYERED_MARKER $ARGUMENTS", { agent: "qa-command-agent" }))
	await writeFile(join(pluginInstall, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "qa-scope-probe", version: "1.0.0" }))
	await writeFile(join(pluginInstall, "commands", "plugin-only.md"), frontmatter("Project-scoped installed plugin command", "PLUGIN_SCOPE_MARKER $ARGUMENTS", { agent: "qa-command-agent" }))
	await writeFile(join(pluginHome, "installed_plugins.json"), JSON.stringify({
		version: 1,
		plugins: {
			"qa-scope-probe@local-qa": {
				scope: "project",
				projectPath: project,
				installPath: pluginInstall,
				version: "1.0.0",
				installedAt: "2026-09-27T00:00:00Z",
				lastUpdated: "2026-09-27T00:00:00Z",
			},
		},
	}))
	await writeFile(settingsPath, JSON.stringify({ enabledPlugins: { "qa-scope-probe@local-qa": true } }))

	const requests: MockRequest[] = []
	const mock = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const url = new URL(request.url)
			if (url.pathname.endsWith("/models")) {
				return Response.json({ data: [{ id: MODEL_ID, object: "model", created: 0, owned_by: "local-qa" }] })
			}
			if (!url.pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 })
			const body = await request.json() as Record<string, unknown>
			const model = typeof body.model === "string" ? body.model : MODEL_ID
			const messages = Array.isArray(body.messages) ? body.messages : []
			const userText = messages.flatMap((message) => {
				if (!message || typeof message !== "object") return []
				const item = message as Record<string, unknown>
				return item.role === "user" ? [responseText(item)] : []
			}).join("\n")
			requests.push({ model, userText, stream: body.stream === true })
			return streamedCompletion("CUSTOM_COMMAND_QA_OK", `custom-${requests.length}`, model)
		},
	})

	const projectConfig = {
		$schema: "https://opencode.ai/config.json",
		plugins: [PLUGIN_DIR],
		enabled_providers: [MODEL_PROVIDER],
		model: `${MODEL_PROVIDER}/${MODEL_ID}`,
		default_agent: "qa-start-agent",
		agents: {
			"qa-start-agent": { mode: "primary", model: `${MODEL_PROVIDER}/${MODEL_ID}`, description: "Local command QA starting agent", prompt: "Stay ready for the imported command." },
			"qa-command-agent": { mode: "primary", model: `${MODEL_PROVIDER}/${MODEL_ID}`, description: "Local command QA agent", prompt: "Answer the imported command task directly with the provided local QA marker." },
		},
		provider: {
			[MODEL_PROVIDER]: {
				name: "Local command QA mock",
				npm: "@ai-sdk/openai-compatible",
				options: { baseURL: `http://127.0.0.1:${mock.port}/v1`, apiKey: QA_API_KEY },
				models: { [MODEL_ID]: { name: "Local command QA model", tool_call: true, limit: { context: 200_000, output: 8_192 } } },
			},
		},
		commands: {
			collision: { description: "Host-owned collision command", template: "NATIVE_COLLISION_MARKER $ARGUMENTS" },
		},
		mcp: {},
		telemetry: false,
		permission: { shell: "deny", edit: "deny" },
	}
	await writeFile(join(project, "opencode.json"), `${JSON.stringify(projectConfig, null, 2)}\n`)
	await writeFile(join(project, ".omo", "omo.jsonc"), `${JSON.stringify({
		"[opencode]": {
			claude_code: { commands: true, plugins: true, mcp: false },
			disabled_mcps: ["websearch", "context7", "grep_app", "lsp"],
			telemetry: false,
		},
	}, null, 2)}\n`)

	const versionProcess = Bun.spawnSync([OPENCODE_BIN, "--version"], { stdout: "pipe", stderr: "pipe" })
	const serverPort = reservePort()
	const serverCommand = [OPENCODE_BIN, "--print-logs", "--log-level", "debug", "serve", "--hostname", "127.0.0.1", "--port", String(serverPort)]
	const serverEnvironment = {
		PATH: "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin",
		TMPDIR: tmpdir(),
		HOME: home,
		XDG_DATA_HOME: xdgData,
		XDG_CONFIG_HOME: xdgConfig,
		XDG_STATE_HOME: xdgState,
		XDG_CACHE_HOME: xdgCache,
		OPENCODE_DB: databasePath,
		OMO_HOME: omoHome,
		CLAUDE_CONFIG_DIR: claudeHome,
		CLAUDE_PLUGINS_HOME: pluginHome,
		CLAUDE_SETTINGS_PATH: settingsPath,
		OPENCODE_DISABLE_MODELS_FETCH: "1",
		OPENCODE_TELEMETRY_DISABLED: "1",
		OPENCODE_SERVER_PASSWORD: QA_PASSWORD,
		OPENCODE_PASSWORD: QA_PASSWORD,
	}

	let child: Bun.Subprocess | undefined
	let stdout = ""
	let stderr = ""
	let stdoutTask: Promise<void> = Promise.resolve()
	let stderrTask: Promise<void> = Promise.resolve()
	let client: ReturnType<typeof OpenCode.make> | undefined
	let failure: string | undefined
	let cleanupStatus: { serverExitCode: number | null; mockStopped: boolean; tempRootRemoved: boolean; tempRootPreserved: boolean } = {
		serverExitCode: null,
		mockStopped: false,
		tempRootRemoved: false,
		tempRootPreserved: false,
	}
	const result: Record<string, unknown> = {
		runtime: version,
		gitHead: Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: ROOT, stdout: "pipe", stderr: "pipe" }).stdout.toString().trim(),
		bundleSha256: serverHash,
		cli: OPENCODE_BIN,
		pluginDirectory: PLUGIN_DIR,
		hostCwd,
		projectDirectory: project,
		projectCanonicalOutsideRepository: !project.startsWith(`${ROOT}/`),
		serverCommand,
		isolation: { home, xdgData, xdgConfig, xdgState, xdgCache, databasePath, omoHome, claudeHome, pluginHome, settingsPath },
		environmentKeys: Object.keys(serverEnvironment),
		mcpConfig: "native mcp empty; Claude mcp disabled; OMO built-in MCPs explicitly disabled",
	}
	const beforeSessionCount = countSessions(databasePath)

	try {
		assert(versionProcess.exitCode === 0 && version.includes("2.0.18"), `Expected OpenCode 2.0.18, got ${version}`)
		assert(!project.startsWith(`${ROOT}/`), `QA project must be outside the repository: ${project}`)
		await writeFile(join(runDirectory, "opencode-config-redacted.json"), JSON.stringify({
			...projectConfig,
			provider: { [MODEL_PROVIDER]: { ...projectConfig.provider[MODEL_PROVIDER], options: { baseURL: `http://127.0.0.1:${mock.port}/v1`, apiKey: "[redacted-test-api-key]" } } },
		}, null, 2))
		child = Bun.spawn(serverCommand, {
			cwd: hostCwd,
			env: serverEnvironment,
			stdout: "pipe",
			stderr: "pipe",
		})
		stdoutTask = new Response(child.stdout as ReadableStream<Uint8Array>).text().then((text) => { stdout += text })
		stderrTask = new Response(child.stderr as ReadableStream<Uint8Array>).text().then((text) => { stderr += text })
		client = OpenCode.make({
			baseUrl: `http://127.0.0.1:${serverPort}`,
			headers: { Authorization: basicAuth(), "x-opencode-directory": project },
		})
		const serverDeadline = Date.now() + 20_000
		let serverReady = false
		while (Date.now() < serverDeadline && !serverReady) {
			if (child.exitCode !== null) throw new Error(`OpenCode exited before ready with ${child.exitCode}`)
			try {
				await client.server.info()
				serverReady = true
			} catch {
				await new Promise((resolve) => setTimeout(resolve, 150))
			}
		}
		assert(serverReady, "OpenCode did not become ready within 20 seconds")

		const expectedCommands = ["user-only", "project-only", "layered", "collision", "unsafe-shell", "unsafe-subtask", "qa-scope-probe:plugin-only"]
		const ready = await within("native imported command registration", waitForCommands(client, child, expectedCommands), 35_000)
		const [agents, models, mcps] = await Promise.all([client.agent.list(), client.model.list(), client.mcp.list()])
		const location = agents.location.directory
		const modelIds = models.data.map((model) => `${model.providerID}/${model.id}`).sort()
		const mcpIds = mcps.data.map((mcp) => mcp.name)
		assert(location === project, `Host request location was ${location}, expected ${project}`)
		assert(JSON.stringify(modelIds) === JSON.stringify([`${MODEL_PROVIDER}/${MODEL_ID}`]), `Unexpected enabled model catalog: ${JSON.stringify(modelIds)}`)
		assert(mcpIds.length === 0, `MCPs remained enabled in the isolated QA project: ${JSON.stringify(mcpIds)}`)
		assert(agents.data.some((agent) => agent.id === "qa-command-agent"), "Configured local-only command agent is absent")
		const commandNames = ready.names
		const collisionOccurrences = commandNames.filter((name) => name === "collision").length
		assert(collisionOccurrences === 1, `Expected one native collision command, got ${collisionOccurrences}`)

		const session = await client.session.create({ title: "Native custom command QA", location: { directory: project } })
		assert(session.location.directory === project, `QA session location is ${session.location.directory}, expected ${project}`)
		await client.session.switchAgent({ sessionID: session.id, agent: "qa-start-agent" })
		await client.session.switchModel({ sessionID: session.id, model: { providerID: MODEL_PROVIDER, id: MODEL_ID } })
		const sessionModelIsPinned = async () => {
			const current = await client!.session.get({ sessionID: session.id })
			assert(current.location.directory === project, `Session location escaped the project: ${current.location.directory}`)
			const ref = current.model
			assert(ref, "Session has no selected model")
			assert(ref.providerID === MODEL_PROVIDER && ref.id === MODEL_ID, `Session model escaped the local fixture: ${JSON.stringify(ref)}`)
			return current
		}
		const observations: CommandObservation[] = []
		const callCommand = async (name: string, text: string, expectedMarker?: string) => {
			await sessionModelIsPinned()
			const requestCountBefore = requests.length
			await within(`command ${name}`, client!.session.command({ sessionID: session.id, name, text }))
			await within(`wait after command ${name}`, client!.session.wait({ sessionID: session.id }))
			const current = await sessionModelIsPinned()
			const requestCountAfter = requests.length
			if (expectedMarker) observations.push({
				name,
				marker: expectedMarker,
				requestCountBefore,
				requestCountAfter,
				outcome: current.outcome,
				markerReachedProvider: requests.slice(requestCountBefore, requestCountAfter).some((request) => request.userText.includes(expectedMarker)),
			})
			return current
		}

		const beforeCommands = requests.length
		await callCommand("user-only", "USER_ARG_OK", "USER_ONLY_MARKER USER_ARG_OK")
		await callCommand("layered", "literal $1 ${user_message}", "PROJECT_LAYERED_MARKER literal $1 ${user_message}")
		const afterLayered = await client.session.get({ sessionID: session.id })
		await callCommand("project-only", "PROJECT_ARG_OK", "PROJECT_ONLY_MARKER PROJECT_ARG_OK")
		await callCommand("qa-scope-probe:plugin-only", "PLUGIN_ARG_OK", "PLUGIN_SCOPE_MARKER PLUGIN_ARG_OK")
		await callCommand("collision", "NATIVE_ARG_OK", "NATIVE_COLLISION_MARKER NATIVE_ARG_OK")
		const beforeUnsupported = requests.length
		await callCommand("unsafe-shell", "UNSAFE_ARG")
		const afterShellUnsupported = requests.length
		await callCommand("unsafe-subtask", "UNSAFE_SUBTASK_ARG")
		const afterSubtaskUnsupported = requests.length

		const inbox = await client.session.inbox.list({ sessionID: session.id })
		const syntheticTexts = inbox.filter((item) => item.type === "synthetic").map((item) => item.payload.text)
		const allUserText = requests.map((request) => request.userText).join("\n")
		const layeredRequest = requests.find((request) => request.userText.includes("PROJECT_LAYERED_MARKER"))
		const pluginRequest = requests.find((request) => request.userText.includes("PLUGIN_SCOPE_MARKER"))
		const nativeCollisionRequest = requests.find((request) => request.userText.includes("NATIVE_COLLISION_MARKER"))
		const shellNotice = syntheticTexts.some((text) => text.includes("unsupported shell interpolation") && text.includes("/unsafe-shell"))
		const subtaskNotice = syntheticTexts.some((text) => text.includes("unsupported subtask execution") && text.includes("/unsafe-subtask"))
		const checks = {
			pluginLoadedAndCommandsRegistered: expectedCommands.every((name) => commandNames.includes(name)),
			projectScopeUsesNativeContextDirectory: ready.names.includes("qa-scope-probe:plugin-only") && location === project && hostCwd !== project,
			userAndProjectSourcesPrecedence: allUserText.includes("USER_ONLY_MARKER USER_ARG_OK")
				&& Boolean(layeredRequest?.userText.includes("PROJECT_LAYERED_MARKER literal $1 ${user_message}"))
				&& !allUserText.includes("USER_LAYERED_MARKER"),
			configuredAgentSelected: afterLayered.agent === "qa-command-agent"
				&& observations.some((observation) => observation.name === "layered" && observation.outcome === "succeeded"),
			projectOnlyCommandDispatched: requests.some((request) => request.userText.includes("PROJECT_ONLY_MARKER PROJECT_ARG_OK")),
			projectScopedPluginCommandDispatched: Boolean(pluginRequest?.userText.includes("PLUGIN_SCOPE_MARKER PLUGIN_ARG_OK")),
			nativeHostCollisionPreserved: collisionOccurrences === 1
				&& Boolean(nativeCollisionRequest?.userText.includes("NATIVE_COLLISION_MARKER NATIVE_ARG_OK"))
				&& !allUserText.includes("IMPORTED_COLLISION_MARKER"),
			allModelRequestsUseLocalFixture: requests.length > 0 && requests.every((request) => request.model === MODEL_ID),
			unsupportedShellNoticeWithoutModelTurn: shellNotice && afterShellUnsupported === beforeUnsupported,
			unsupportedSubtaskNoticeWithoutModelTurn: subtaskNotice && afterSubtaskUnsupported === afterShellUnsupported,
			everyPromptSessionStayedPinned: true,
			eachSupportedCommandReachedProviderAndCompleted: observations.length === 5
				&& observations.every((observation) => observation.requestCountAfter > observation.requestCountBefore
					&& observation.outcome === "succeeded"
					&& observation.markerReachedProvider),
		}
		const activeSession = await client.session.get({ sessionID: session.id })
		const finalSessionCount = countSessions(databasePath)
		const isolatedDatabaseProof = beforeSessionCount !== null && finalSessionCount === beforeSessionCount + 1
		const passed = Object.values(checks).every(Boolean) && activeSession.outcome === "succeeded" && isolatedDatabaseProof
		Object.assign(result, {
			projectLocation: location,
			nativeServerCwd: hostCwd,
			registeredCommandNames: commandNames.sort(),
			pluginStates: ready.pluginStates,
			modelIds,
			mcpIds,
			selectedAgentAfterProjectCommand: afterLayered.agent,
			selectedModelAfterProjectCommand: afterLayered.model,
			requestsBeforeCommands: beforeCommands,
			requestsBeforeUnsupported: beforeUnsupported,
			requestsAfterShellUnsupported: afterShellUnsupported,
			requestsAfterSubtaskUnsupported: afterSubtaskUnsupported,
			mockRequests: requests,
			commandObservations: observations,
			notices: { shell: shellNotice, subtask: subtaskNotice, syntheticInboxCount: syntheticTexts.length },
			finalSession: { id: activeSession.id, agent: activeSession.agent, model: activeSession.model, outcome: activeSession.outcome },
			databaseSessionCountBefore: beforeSessionCount,
			databaseSessionCountAfter: finalSessionCount,
			isolatedSessionCountIncremented: isolatedDatabaseProof,
			checks,
			passed,
		})
		assert(passed, `QA checks failed: ${JSON.stringify({ checks, outcome: activeSession.outcome, isolatedDatabaseProof })}`)
	} catch (error) {
		failure = error instanceof Error ? error.message : String(error)
	} finally {
		cleanupStatus.serverExitCode = await stopProcess(child)
		await Promise.all([stdoutTask, stderrTask])
		mock.stop(true)
		cleanupStatus.mockStopped = true
		cleanupStatus.tempRootRemoved = false
		cleanupStatus.tempRootPreserved = existsSync(tempRoot)
		Object.assign(result, {
			mockRequests: requests,
			failure,
			cleanup: cleanupStatus,
			sessionCountAfterCleanup: countSessions(databasePath),
		})
		await Promise.all([
			writeFile(join(runDirectory, "runtime.json"), `${JSON.stringify(result, null, 2)}\n`),
			writeFile(join(runDirectory, "server.log"), redact(`${stdout}\n--- stderr ---\n${stderr}`)),
			writeFile(join(runDirectory, "mock-requests.json"), `${JSON.stringify(requests, null, 2)}\n`),
			writeFile(join(runDirectory, "project-fixtures.json"), JSON.stringify({
				project,
				hostCwd,
				userCommands: ["user-only", "layered", "collision", "unsafe-shell", "unsafe-subtask"],
				projectCommands: ["project-only", "layered"],
				projectScopedPlugin: "qa-scope-probe@local-qa",
				nativeCommandCollision: "collision",
			}, null, 2)),
		])
	}
	if (failure) throw new Error(`Native custom-command QA failed; inspect ${join(runDirectory, "runtime.json")}: ${failure}`)
	process.stdout.write(`${JSON.stringify({ evidence: runDirectory, passed: result.passed, checks: result.checks, cleanup: result.cleanup }, null, 2)}\n`)
}

await main()
