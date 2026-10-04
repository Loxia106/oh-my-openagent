/**
 * Local-only OpenCode 2.0.22 host QA for Hephaestus tool workflows.
 *
 * This drives hashline rename/delete through the native apply_patch executor,
 * look_at through a real multimodal-looker child and native read, the
 * interactive_bash alias through a task-local tmux socket, and lsp_diagnostics
 * through the local stdio LSP server. It requires a frozen plugin bundle.
 */
import { createHash } from "node:crypto"
import { existsSync, lstatSync } from "node:fs"
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { tmpdir } from "node:os"
import { Database } from "bun:sqlite"
import { OpenCode } from "@opencode/client"
import { computeLineHash } from "../packages/omo-opencode/src/tools/hashline-edit/hash-computation"

const ROOT = resolve(import.meta.dir, "..")
const EVIDENCE_ROOT = join(ROOT, ".omo", "evidence")
const EVIDENCE = resolve(process.env.OPENCODE2_QA_EVIDENCE_DIR ?? join(EVIDENCE_ROOT, "20260927-hephaestus-tools"))
const PLUGIN_DIR = resolve(process.env.OPENCODE2_PLUGIN_DIR ?? join(ROOT, "dist", "opencode2"))
const CLI_INPUT = process.env.OPENCODE2_CLI?.trim() ?? ""
const CLI = CLI_INPUT ? resolve(CLI_INPUT) : ""
const EXPECTED_SERVER_SHA256 = process.env.OPENCODE2_EXPECTED_SERVER_SHA256 ?? ""
const PROVIDER = "omoqa"
const MODEL = "gpt-5.6"
const API_KEY = "hephaestus-tool-surface-fake-key-only"
const PASSWORD = "hephaestus-tool-surface-local-only"
const PROBE_ID = "omo-hephaestus-tool-surface-origin"
const TIMEOUT_MS = 90_000
const TOOL_MARKERS = [
	"OMO_QA_HASHLINE_RENAME",
	"OMO_QA_HASHLINE_DELETE",
	"OMO_QA_LOOK_AT",
	"OMO_QA_LOOK_AT_PDF",
	"OMO_QA_INTERACTIVE_BASH",
	"OMO_QA_LSP_DIAGNOSTICS",
] as const
type ToolMarker = typeof TOOL_MARKERS[number]

type Check = { readonly name: string; readonly passed: boolean; readonly detail?: unknown }
type SessionRow = {
	id: string
	parentID: string | null
	directory: string
	model: string | null
	agent: string | null
}
type RequestRecord = {
	readonly sessionID?: string
	readonly parentID?: string | null
	readonly role: "parent" | "child" | "other"
	readonly agent?: string
	readonly kind?: string
	readonly model: string
	readonly marker?: string
	readonly tools: string[]
	readonly registeredTools: string[]
	readonly codeModePaths: string[]
	readonly toolResults: string[]
	readonly originValid: boolean
	readonly hasProjectAgentsMarker: boolean
	readonly hasHephaestus56Identity: boolean
	readonly childReadHasImageBytes: boolean
	readonly childMedia: Array<{ readonly mime: string; readonly byteLength: number; readonly sha256: string }>
	readonly at: number
}
type Host = {
	readonly port: number
	readonly process: Bun.Subprocess
	readonly client: ReturnType<typeof OpenCode.make>
	stdout: string
	stderr: string
	stdoutTask: Promise<void>
	stderrTask: Promise<void>
}
type ToolCall = { readonly name: string; readonly args: Record<string, unknown> }

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message)
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value)
}

function textOf(value: unknown): string {
	if (typeof value === "string") return value
	if (Array.isArray(value)) return value.map(textOf).filter(Boolean).join("\n")
	if (!isRecord(value)) return ""
	if (typeof value.text === "string") return value.text
	return textOf(value.content ?? value.parts ?? value.output ?? value.text)
}

function messageRows(body: Record<string, unknown>): Record<string, unknown>[] {
	return Array.isArray(body.messages) ? body.messages.filter(isRecord) : []
}

function latestUserText(body: Record<string, unknown>): string {
	for (const message of messageRows(body).reverse()) {
		if (message.role === "user") return textOf(message.content ?? message.parts ?? message.text)
	}
	return ""
}

function systemText(body: Record<string, unknown>): string {
	return [
		textOf(body.system),
		...messageRows(body)
			.filter((message) => message.role === "system" || message.role === "developer")
			.map((message) => textOf(message.content ?? message.parts ?? message.text)),
	].filter(Boolean).join("\n")
}

function toolNames(body: Record<string, unknown>): string[] {
	if (!Array.isArray(body.tools)) return []
	return body.tools.flatMap((entry) => {
		if (!isRecord(entry)) return []
		const fn = isRecord(entry.function) ? entry.function : entry
		return typeof fn.name === "string" ? [fn.name] : []
	})
}

function findTool(body: Record<string, unknown>, requested: string): string | undefined {
	const names = toolNames(body)
	return names.find((name) => name.toLowerCase() === requested.toLowerCase())
}

function toolResultTexts(body: Record<string, unknown>): string[] {
	return messageRows(body).flatMap((message) => message.role === "tool" ? [textOf(message.content)] : [])
}

function mediaPayloads(value: unknown): Array<{ readonly mime: string; readonly byteLength: number; readonly sha256: string }> {
	const found = new Map<string, { readonly mime: string; readonly byteLength: number; readonly sha256: string }>()
	const visit = (item: unknown): void => {
		if (Array.isArray(item)) {
			for (const child of item) visit(child)
			return
		}
		if (!isRecord(item)) return
		const ownMime = [item.mime, item.mimeType, item.mediaType].find((candidate): candidate is string => typeof candidate === "string")
		for (const candidate of [item.uri, item.url, item.data, item.content, item.image_url, item.file_data]) {
			if (typeof candidate !== "string") continue
			const dataUri = /^data:([^;,]+);base64,([A-Za-z0-9+/=]+)$/.exec(candidate)
			if (dataUri) {
				const bytes = Buffer.from(dataUri[2]!, "base64")
				const mime = dataUri[1]!.toLowerCase()
				if (mime.startsWith("image/") || mime === "application/pdf") {
					const sha256 = createHash("sha256").update(bytes).digest("hex")
					found.set(`${mime}:${sha256}`, { mime, byteLength: bytes.length, sha256 })
				}
				continue
			}
			if (ownMime && (ownMime.toLowerCase().startsWith("image/") || ownMime.toLowerCase() === "application/pdf") && /^[A-Za-z0-9+/=]+$/.test(candidate)) {
				const bytes = Buffer.from(candidate, "base64")
				const mime = ownMime.toLowerCase()
				const sha256 = createHash("sha256").update(bytes).digest("hex")
				found.set(`${mime}:${sha256}`, { mime, byteLength: bytes.length, sha256 })
			}
		}
		for (const child of Object.values(item)) visit(child)
	}
	visit(value)
	return [...found.values()]
}

async function stopOwnedLspDaemon(root: string): Promise<{ readonly found: boolean; readonly pid?: number; readonly stopped: boolean; readonly directoryRemoved: boolean; readonly reason?: string }> {
	const versionDir = join(root, "v0.1.0")
	const ownerPath = join(versionDir, "daemon.owner")
	if (!existsSync(ownerPath)) {
		await rm(root, { recursive: true, force: true })
		return { found: false, stopped: true, directoryRemoved: true }
	}
	try {
		const owner = JSON.parse(await readFile(ownerPath, "utf8")) as {
			pid?: unknown
			endpoint?: { kind?: unknown; path?: unknown; dev?: unknown; ino?: unknown }
		}
		const pid = owner.pid
		const endpoint = owner.endpoint
		const expectedSocket = join(versionDir, "daemon.sock")
		if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 1 || endpoint?.kind !== "unix" || endpoint.path !== expectedSocket ||
			typeof endpoint.dev !== "number" || typeof endpoint.ino !== "number") {
			return { found: true, stopped: false, directoryRemoved: false, reason: "daemon owner record did not match this fixture's socket" }
		}
		const socket = lstatSync(expectedSocket)
		if (!socket.isSocket() || socket.dev !== endpoint.dev || socket.ino !== endpoint.ino) {
			return { found: true, pid, stopped: false, directoryRemoved: false, reason: "daemon socket identity changed; refusing to signal" }
		}
		const command = Bun.spawnSync(["ps", "-p", String(pid), "-o", "command="], { stdout: "pipe", stderr: "pipe" }).stdout.toString()
		if (!command.includes("lsp-daemon") && !command.includes("cli.js daemon")) {
			return { found: true, pid, stopped: false, directoryRemoved: false, reason: "owner PID did not match an LSP daemon command; refusing to signal" }
		}
		try {
			process.kill(pid, "SIGTERM")
		} catch (error) {
			if (!isRecord(error) || error.code !== "ESRCH") throw error
		}
		let stopped = false
		for (let attempt = 0; attempt < 30; attempt += 1) {
			try {
				process.kill(pid, 0)
				await Bun.sleep(100)
			} catch (error) {
				if (isRecord(error) && error.code === "ESRCH") stopped = true
				else throw error
				break
			}
		}
		if (!stopped) return { found: true, pid, stopped: false, directoryRemoved: false, reason: "LSP daemon did not exit after SIGTERM" }
		await rm(root, { recursive: true, force: true })
		return { found: true, pid, stopped: true, directoryRemoved: true }
	} catch (error) {
		return { found: true, stopped: false, directoryRemoved: false, reason: error instanceof Error ? error.message : String(error) }
	}
}

function makePdfFixture(marker: string): Buffer {
	const stream = `BT /F1 18 Tf 36 60 Td (${marker}) Tj ET`
	const objects = [
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 100] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
		`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
	]
	const chunks = ["%PDF-1.4\n"]
	const offsets = [0]
	for (let index = 0; index < objects.length; index++) {
		offsets.push(Buffer.byteLength(chunks.join("")))
		chunks.push(`${index + 1} 0 obj\n${objects[index]}\nendobj\n`)
	}
	const xrefOffset = Buffer.byteLength(chunks.join(""))
	chunks.push(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`)
	for (const offset of offsets.slice(1)) chunks.push(`${String(offset).padStart(10, "0")} 00000 n \n`)
	chunks.push(`trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`)
	return Buffer.from(chunks.join(""), "binary")
}

function modelRef(value: unknown): string | undefined {
	if (!isRecord(value) || typeof value.providerID !== "string" || typeof value.id !== "string") return undefined
	return `${value.providerID}/${value.id}`
}

function effectivePermission(agent: unknown, action: string): string | undefined {
	if (!isRecord(agent) || !Array.isArray(agent.permissions)) return undefined
	const rule = agent.permissions.filter(isRecord).findLast((entry) => entry.action === action || entry.action === "*")
	return typeof rule?.effect === "string" ? rule.effect : undefined
}

function sessionRow(databasePath: string, sessionID: string | undefined): SessionRow | undefined {
	if (!sessionID || !existsSync(databasePath)) return undefined
	try {
		const database = new Database(databasePath, { readonly: true, create: false })
		try {
			return database.query("SELECT id, parent_id AS parentID, directory, model, agent FROM session_v2 WHERE id = ?")
				.get(sessionID) as SessionRow | undefined
		} finally {
			database.close()
		}
	} catch {
		return undefined
	}
}

function modelFromRow(raw: string | null | undefined): string | undefined {
	if (!raw) return undefined
	try {
		const parsed = JSON.parse(raw) as { providerID?: unknown; id?: unknown }
		return typeof parsed.providerID === "string" && typeof parsed.id === "string"
			? `${parsed.providerID}/${parsed.id}`
			: raw
	} catch {
		return raw
	}
}

function childRows(databasePath: string, parentID: string): Array<{ id: string }> {
	const database = new Database(databasePath, { readonly: true, create: false })
	try {
		return database.query("SELECT id FROM session_v2 WHERE parent_id = ? ORDER BY time_created").all(parentID) as Array<{ id: string }>
	} finally {
		database.close()
	}
}

function databaseSessionCount(databasePath: string): number {
	if (!existsSync(databasePath)) return 0
	const database = new Database(databasePath, { readonly: true, create: false })
	try {
		return (database.query("SELECT COUNT(*) AS count FROM session_v2").get() as { count: number }).count
	} finally {
		database.close()
	}
}

function toolStates(messages: unknown): Array<{ name: string; status: string; input: unknown; text: string }> {
	if (!Array.isArray(messages)) return []
	return messages.flatMap((message) => {
		if (!isRecord(message) || !Array.isArray(message.parts ?? message.content)) return []
		const parts = Array.isArray(message.parts) ? message.parts : message.content as unknown[]
		return parts.flatMap((part) => {
			if (!isRecord(part) || part.type !== "tool" || typeof part.name !== "string" || !isRecord(part.state)) return []
			const state = part.state
			return [{
				name: part.name,
				status: typeof state.status === "string" ? state.status : "unknown",
				input: state.input,
				text: textOf(state.output ?? state.error ?? state.content),
			}]
		})
	})
}

function sse(items: unknown[]): Response {
	return new Response(items.map((item) => `data: ${JSON.stringify(item)}\n\n`).join("") + "data: [DONE]\n\n", {
		headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive" },
	})
}

function completionResponse(text: string, id: string, model: string, stream: boolean): Response {
	const created = Math.floor(Date.now() / 1000)
	const complete = {
		id: `chatcmpl-${id}`, object: "chat.completion", created, model,
		choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
		usage: { prompt_tokens: 14, completion_tokens: 8, total_tokens: 22 },
	}
	if (!stream) return Response.json(complete)
	return sse([
		{ id: complete.id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] },
		{ id: complete.id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
	])
}

function toolResponse(call: ToolCall, id: string, model: string, stream: boolean): Response {
	const created = Math.floor(Date.now() / 1000)
	const tc = { index: 0, id: `${id}-tool`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args) } }
	if (!stream) return Response.json({
		id: `chatcmpl-${id}`, object: "chat.completion", created, model,
		choices: [{ index: 0, message: { role: "assistant", content: null, tool_calls: [tc] }, finish_reason: "tool_calls" }],
		usage: { prompt_tokens: 14, completion_tokens: 8, total_tokens: 22 },
	})
	return sse([
		{ id: `chatcmpl-${id}`, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [tc] }, finish_reason: null }] },
		{ id: `chatcmpl-${id}`, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
	])
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
	} finally {
		if (timer) clearTimeout(timer)
	}
}

async function stopHost(host: Host | undefined): Promise<number | null | undefined> {
	if (!host) return undefined
	if (host.process.exitCode === null) {
		host.process.kill("SIGTERM")
		const stopped = await Promise.race([host.process.exited.then(() => true), Bun.sleep(5_000).then(() => false)])
		if (!stopped && host.process.exitCode === null) {
			host.process.kill("SIGKILL")
			await host.process.exited
		}
	}
	await Promise.all([host.stdoutTask, host.stderrTask])
	return host.process.exitCode
}

function responseCall(body: Record<string, unknown>, name: string, args: Record<string, unknown>, record: RequestRecord, failures: unknown[]): Response {
	const actual = findTool(body, name)
	if (!actual) {
		failures.push({ marker: record.marker, agent: record.agent, requestedTool: name, available: record.tools })
		return Response.json({ error: { message: `Required native tool ${name} is missing` } }, { status: 500 })
	}
	return toolResponse({ name: actual, args }, `tool-surface-${Date.now()}`, record.model, body.stream === true)
}

async function main(): Promise<void> {
	assert(CLI_INPUT && isAbsolute(CLI_INPUT) && existsSync(CLI), "Set OPENCODE2_CLI to an explicit absolute pinned OpenCode executable")
	assert(/^[a-f0-9]{64}$/i.test(EXPECTED_SERVER_SHA256), "Set OPENCODE2_EXPECTED_SERVER_SHA256 to the frozen server bundle SHA-256")
	const relativeEvidence = relative(EVIDENCE_ROOT, EVIDENCE)
	assert(relativeEvidence && relativeEvidence !== ".." && !relativeEvidence.startsWith(`..${sep}`) && !relativeEvidence.includes(sep),
		`Evidence path must be one direct child of ${EVIDENCE_ROOT}`)
	await mkdir(EVIDENCE_ROOT, { recursive: true })
	const evidenceRoot = await realpath(EVIDENCE_ROOT)
	await mkdir(EVIDENCE, { recursive: true })
	assert(dirname(await realpath(EVIDENCE)) === evidenceRoot, "Evidence directory escaped .omo/evidence")

	const serverPath = join(PLUGIN_DIR, "server.js")
	assert(existsSync(serverPath), `Missing frozen server bundle: ${serverPath}`)
	const bundleSha256 = createHash("sha256").update(await readFile(serverPath)).digest("hex")
	assert(bundleSha256 === EXPECTED_SERVER_SHA256, `Frozen server bundle hash mismatch: ${bundleSha256}`)

	const runDirectory = join(EVIDENCE, `attempt-${Date.now()}`)
	await mkdir(runDirectory, { recursive: true })
	const tempRoot = await realpath(await mkdtemp(join(tmpdir(), "omo-hephaestus-tools-qa-")))
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
	const claudeSettings = join(tempRoot, "claude-settings.json")
	const databasePath = join(tempRoot, "opencode.db")
	const probeDirectory = join(tempRoot, "origin-probe")
	const tmuxPathInput = process.env.OPENCODE2_QA_TMUX_PATH?.trim() ?? ""
	const lspBinaryInput = process.env.OPENCODE2_QA_LSP_BINARY?.trim() ?? ""
	const tmuxPath = tmuxPathInput ? resolve(tmuxPathInput) : ""
	const lspBinary = lspBinaryInput ? resolve(lspBinaryInput) : ""
	assert(tmuxPath && isAbsolute(tmuxPath) && existsSync(tmuxPath), "Set OPENCODE2_QA_TMUX_PATH to the task-local tmux binary")
	assert(lspBinary && isAbsolute(lspBinary) && existsSync(lspBinary), "Set OPENCODE2_QA_LSP_BINARY to the task-local TypeScript language server")
	const projectDirectory = await (async () => {
		await Promise.all([
			project, serverCwd, home, xdgData, xdgConfig, xdgState, xdgCache, omoHome, claudeHome, claudePlugins, probeDirectory,
			join(project, ".omo"), join(project, "src"),
		].map((path) => mkdir(path, { recursive: true })))
		return realpath(project)
	})()
	assert(!projectDirectory.startsWith(ROOT + sep), "QA project must be outside the repository")
	const renameSource = join(projectDirectory, "src", "rename-source.txt")
	const renameTarget = join(projectDirectory, "src", "rename-target.txt")
	const deleteTarget = join(projectDirectory, "src", "delete-target.txt")
	const imagePath = join(projectDirectory, "src", "fixture.png")
	const siblingImagePath = join(projectDirectory, "src", "sibling.png")
	const pdfPath = join(projectDirectory, "src", "fixture.pdf")
	const lspFixture = join(projectDirectory, "src", "diagnostic-fixture.ts")
	const tmuxSocket = `omoqa-${Date.now().toString(36)}`
	const tmuxSession = `surface-${Date.now().toString(36)}`
	const oldText = "HASHLINE_SOURCE_BEFORE"
	const renamedText = "HASHLINE_RENAMED_BYTES"
	// CRC-valid local-only media fixtures; the previous literals had invalid PNG CRCs.
	const imageBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z/D/PwAG/gL+DHWJ3gAAAABJRU5ErkJggg==", "base64")
	const siblingImageBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGNgYGD4/x+IQQhE/AcAM94G+v5/wPQAAAAASUVORK5CYII=", "base64")
	const pdfBytes = makePdfFixture("OMO_QA_PDF_MARKER")
	await Promise.all([
		writeFile(join(projectDirectory, "AGENTS.md"), "# Local Hephaestus QA\nProject-level instructions: HEPHAESTUS_AGENTS_CONTEXT_MARKER.\n"),
		writeFile(renameSource, `${oldText}\n`),
		writeFile(deleteTarget, "HASHLINE_DELETE_ME\n"),
		writeFile(imagePath, imageBytes),
		writeFile(siblingImagePath, siblingImageBytes),
		writeFile(pdfPath, pdfBytes),
		writeFile(lspFixture, 'const expectedNumber: number = "LSP_QA_TYPE_MISMATCH";\nexport const result = expectedNumber;\n'),
		writeFile(join(projectDirectory, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, noEmit: true }, include: ["src/**/*.ts"] }, null, 2) + "\n"),
		writeFile(join(projectDirectory, ".omo", "lsp.json"), JSON.stringify({ lsp: { typescript: { command: [lspBinary, "--stdio"], extensions: [".ts", ".tsx", ".js", ".jsx"] } } }, null, 2) + "\n"),
		writeFile(claudeSettings, "{}\n"),
	])

	const localModel = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const url = new URL(request.url)
			if (url.pathname.endsWith("/models")) return Response.json({ data: [{ id: MODEL, object: "model", created: 0, owned_by: "hephaestus-tool-surface-qa" }] })
			if (!url.pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 })
			const body = await request.json() as Record<string, unknown>
			const requestModel = typeof body.model === "string" ? body.model : ""
			const sessionID = request.headers.get("x-omo-qa-session-id") ?? undefined
			const kind = request.headers.get("x-omo-qa-kind") ?? undefined
			const agent = request.headers.get("x-omo-qa-agent") ?? undefined
			const provider = request.headers.get("x-omo-qa-provider") ?? undefined
			const modelHeader = request.headers.get("x-omo-qa-model") ?? undefined
			const registeredTools = (request.headers.get("x-omo-qa-registered-tools") ?? "").split(",").filter(Boolean)
			const codeModePaths = (request.headers.get("x-omo-qa-codemode-paths") ?? "").split(",").filter(Boolean)
			const row = sessionRow(databasePath, sessionID)
			const role: RequestRecord["role"] = sessionID === parentSessionID ? "parent" : row?.parentID === parentSessionID ? "child" : "other"
			const expectedAgent = role === "parent" ? "hephaestus" : role === "child" ? "multimodal-looker" : undefined
			const markerMatch = new RegExp([...TOOL_MARKERS].toSorted((left, right) => right.length - left.length).join("|"), "g")
			let marker = Array.from(latestUserText(body).matchAll(markerMatch), (match) => match[0]).at(-1) as ToolMarker | undefined
			const system = systemText(body)
			if (role === "child" && sessionID) {
				const requestedMarker = marker?.startsWith("OMO_QA_LOOK_AT") ? marker : undefined
				const establishedMarker = childMarkers.get(sessionID)
				if (requestedMarker && !establishedMarker) childMarkers.set(sessionID, requestedMarker)
				else if (establishedMarker) marker = establishedMarker
			}
			const media = role === "child" ? mediaPayloads(body.messages) : []
			const imagePayload = media.some((part) => part.mime.startsWith("image/") && part.byteLength > 0)
			const pdfPayload = media.some((part) => part.mime === "application/pdf" && part.byteLength > 0)
			const record: RequestRecord = {
				...(sessionID ? { sessionID } : {}), ...(row ? { parentID: row.parentID } : {}), role,
				...(agent ? { agent } : {}), ...(kind ? { kind } : {}), model: requestModel,
				...(marker ? { marker } : {}), tools: toolNames(body), registeredTools, codeModePaths, toolResults: toolResultTexts(body),
				originValid: Boolean(sessionID && row && row.directory === projectDirectory && kind && ["primary", "title", "compaction", "generate"].includes(kind)
					&& modelFromRow(row.model) === `${PROVIDER}/${MODEL}` && requestModel === MODEL
					&& provider === PROVIDER && modelHeader === MODEL && agent?.toLowerCase() === expectedAgent),
				hasProjectAgentsMarker: system.includes("HEPHAESTUS_AGENTS_CONTEXT_MARKER"),
				hasHephaestus56Identity: system.includes("You are Hephaestus, an autonomous deep worker based on GPT-5.6."),
				childReadHasImageBytes: imagePayload,
				childMedia: media,
				at: Date.now(),
			}
			requests.push(record)
			if (requestModel !== MODEL || provider !== PROVIDER || !record.originValid) {
				originFailures.push({ sessionID, role, agent, kind, provider, modelHeader, requestModel, selected: row?.model, directory: row?.directory })
				return Response.json({ error: { message: "Rejected nonlocal or misattributed tool-surface request" } }, { status: 403 })
			}

			const requestID = `surface-${requests.length}`
			const stream = body.stream === true
			const stageKey = `${sessionID ?? "missing"}:${marker ?? "unmarked"}`
			const stage = stages.get(stageKey) ?? 0
			const complete = (text: string) => completionResponse(text, requestID, requestModel, stream)
			const call = (name: string, args: Record<string, unknown>) => responseCall(body, name, args, record, routeFailures)

			if (kind !== "primary") return complete("HEPHAESTUS_AUXILIARY_ACK")
			if (role === "child") {
				if (agent?.toLowerCase() !== "multimodal-looker" || !marker || !marker.startsWith("OMO_QA_LOOK_AT")) {
					routeFailures.push({ sessionID, role, agent, marker, reason: "unexpected child request" })
					return Response.json({ error: { message: "Unexpected child request in Hephaestus tool-surface fixture" } }, { status: 500 })
				}
				if (stage === 0) {
					stages.set(stageKey, stage + 1)
					return call("read", { path: marker === "OMO_QA_LOOK_AT_PDF" ? pdfPath : imagePath })
				}
				const mediaArrived = marker === "OMO_QA_LOOK_AT_PDF" ? pdfPayload : imagePayload
				if (!mediaArrived) childImageFailures.push({ sessionID, marker, available: record.tools, media })
				stages.set(stageKey, stage + 1)
				return complete(mediaArrived
					? marker === "OMO_QA_LOOK_AT_PDF" ? "LOOKER_READ_PDF_BYTES: OMO_QA_PDF_READ" : "LOOKER_READ_IMAGE_BYTES: OMO_QA_PIXEL_READ"
					: marker === "OMO_QA_LOOK_AT_PDF" ? "LOOKER_PDF_BYTES_MISSING" : "LOOKER_IMAGE_BYTES_MISSING")
			}

			if (role !== "parent" || agent?.toLowerCase() !== "hephaestus") {
				routeFailures.push({ sessionID, role, agent, kind, marker, reason: "unexpected primary model request" })
				return Response.json({ error: { message: "Unexpected primary session in tool-surface fixture" } }, { status: 500 })
			}
			const results = record.toolResults.join("\n")
			if (marker === "OMO_QA_HASHLINE_RENAME") {
				if (stage === 0) {
					stages.set(stageKey, stage + 1)
					return call("hashline_edit", {
						filePath: renameSource,
						edits: [{ op: "replace", pos: `1#${computeLineHash(1, oldText)}`, lines: [renamedText] }],
						rename: renameTarget,
					})
				}
				if (!results.includes(renamedText) && !results.includes("Updated")) toolResultFailures.push({ marker, results, phase: "rename" })
				stages.set(stageKey, stage + 1)
				return complete("HASHLINE_RENAME_RESULT")
			}
			if (marker === "OMO_QA_HASHLINE_DELETE") {
				if (stage === 0) {
					stages.set(stageKey, stage + 1)
					return call("hashline_edit", { filePath: deleteTarget, edits: [], delete: true })
				}
				if (!results.includes("delete") && !results.includes("Delete")) toolResultFailures.push({ marker, results, phase: "delete" })
				stages.set(stageKey, stage + 1)
				return complete("HASHLINE_DELETE_RESULT")
			}
			if (marker === "OMO_QA_LOOK_AT") {
				if (stage === 0) {
					stages.set(stageKey, stage + 1)
					return call("look_at", { file_path: imagePath, goal: "OMO_QA_LOOK_AT identify the pixel fixture and return OMO_QA_PIXEL_READ." })
				}
				if (!results.includes("OMO_QA_PIXEL_READ")) toolResultFailures.push({ marker, results, phase: "look_at" })
				stages.set(stageKey, stage + 1)
				return complete("LOOK_AT_RESULT_CONSUMED")
			}
			if (marker === "OMO_QA_LOOK_AT_PDF") {
				if (stage === 0) {
					stages.set(stageKey, stage + 1)
					return call("look_at", { file_path: pdfPath, goal: "OMO_QA_LOOK_AT_PDF inspect this one-page document and return OMO_QA_PDF_READ." })
				}
				if (!results.includes("OMO_QA_PDF_READ")) toolResultFailures.push({ marker, results, phase: "look_at-pdf" })
				stages.set(stageKey, stage + 1)
				return complete("LOOK_AT_PDF_RESULT_CONSUMED")
			}
			if (marker === "OMO_QA_INTERACTIVE_BASH") {
				const commands = [
					{ name: "interactive_bash", args: { tmux_command: `-L ${tmuxSocket} new-session -d -s ${tmuxSession}` } },
					{ name: "interactive_bash", args: { tmux_command: `-L ${tmuxSocket} send-keys -t ${tmuxSession} 'printf INTERACTIVE_PANE_MARKER' Enter` } },
					{ name: "interactive_bash", args: { tmux_command: `-L ${tmuxSocket} capture-pane -p -t ${tmuxSession}` } },
					{ name: "interactive_bash", args: { tmux_command: `-L ${tmuxSocket} kill-server` } },
				]
				if (stage < commands.length) {
					stages.set(stageKey, stage + 1)
					return call(commands[stage]!.name, commands[stage]!.args)
				}
				if (!results.includes("INTERACTIVE_PANE_MARKER")) toolResultFailures.push({ marker, results, phase: "interactive-pane" })
				if (!results.includes("prohibited")) toolResultFailures.push({ marker, results, phase: "interactive-kill-server-block" })
				stages.set(stageKey, stage + 1)
				return complete("INTERACTIVE_BASH_RESULT_CONSUMED")
			}
			if (marker === "OMO_QA_LSP_DIAGNOSTICS") {
				if (stage === 0) {
					stages.set(stageKey, stage + 1)
					const code = `return await tools.lsp.diagnostics({ filePath: ${JSON.stringify(lspFixture)} });`
					return call("execute", { code })
				}
				if (!results.includes("LSP_QA_TYPE_MISMATCH") && !results.includes("Type 'string' is not assignable to type 'number'")) {
					toolResultFailures.push({ marker, results, phase: "lsp-diagnostic-result" })
				}
				stages.set(stageKey, stage + 1)
				return complete("LSP_DIAGNOSTIC_RESULT_CONSUMED")
			}
			return complete("HEPHAESTUS_TOOL_SURFACE_ACK")
		},
	})
	const mockOrigin = `http://127.0.0.1:${localModel.port}`
	await mkdir(probeDirectory, { recursive: true })
	await writeFile(join(probeDirectory, "index.js"), `export default { id: ${JSON.stringify(PROBE_ID)}, setup: async ({ session, tool }) => { const model = await session.hook("model.request", async (event) => { if (event.model.providerID !== ${JSON.stringify(PROVIDER)} || event.model.id !== ${JSON.stringify(MODEL)}) throw new Error("QA blocked nonlocal provider/model request"); event.headers["x-omo-qa-agent"] = String(event.agent); event.headers["x-omo-qa-provider"] = String(event.model.providerID); event.headers["x-omo-qa-model"] = String(event.model.id); const registered = await tool.list(); const path = (entry) => { const name = String(entry.name ?? entry.id); const namespace = typeof entry.options?.namespace === "string" ? entry.options.namespace : ""; return namespace ? namespace + "." + name : name; }; event.headers["x-omo-qa-registered-tools"] = registered.map((entry) => String(entry.id ?? entry.name)).join(","); event.headers["x-omo-qa-codemode-paths"] = registered.filter((entry) => entry.options?.codemode !== false).map(path).join(","); }); const http = await session.hook("http.request", (event) => { if (new URL(event.request.url).origin !== ${JSON.stringify(mockOrigin)}) throw new Error("QA blocked nonlocal HTTP destination"); const headers = new Headers(event.request.headers); headers.set("x-omo-qa-session-id", event.sessionID); headers.set("x-omo-qa-kind", event.kind); event.request = new Request(event.request, { headers }); }); return async () => { await Promise.all([model.dispose(), http.dispose()]); }; } }\n`, "utf8")

	const agentOverrides = {
		hephaestus: { model: `${PROVIDER}/${MODEL}` },
		"multimodal-looker": { model: `${PROVIDER}/${MODEL}` },
	}
	const projectConfig = {
		$schema: "https://opencode.ai/config.json",
		plugins: [probeDirectory, PLUGIN_DIR],
		enabled_providers: [PROVIDER],
		model: `${PROVIDER}/${MODEL}`,
		default_agent: "hephaestus",
		provider: {
			[PROVIDER]: {
				name: "Local Hephaestus tool-surface QA mock",
				npm: "@ai-sdk/openai-compatible",
				options: { baseURL: `${mockOrigin}/v1`, apiKey: API_KEY, timeout: 120_000, headerTimeout: 120_000, chunkTimeout: 120_000 },
				models: {
					[MODEL]: {
						name: "Local GPT-5.6 tool and image QA model",
						tool_call: true,
						reasoning: true,
						modalities: { input: ["text", "image", "pdf"], output: ["text"] },
						limit: { context: 200_000, output: 8_192 },
					},
				},
			},
		},
		mcp: {},
		telemetry: false,
		permissions: [
			{ action: "*", resource: "*", effect: "deny" },
			{ action: "read", resource: "*", effect: "allow" },
			{ action: "edit", resource: "*", effect: "allow" },
			{ action: "shell", resource: "*", effect: "allow" },
			{ action: "subagent", resource: "*", effect: "allow" },
			{ action: "task", resource: "*", effect: "allow" },
			{ action: "execute", resource: "*", effect: "allow" },
			{ action: "interactive_bash", resource: "*", effect: "allow" },
			{ action: "lsp_diagnostics", resource: "*", effect: "allow" },
		],
	}
	const omoConfig = {
		telemetry: { enabled: false },
		"[opencode]": {
			telemetry: false,
			agents: agentOverrides,
			hashline_edit: true,
			disabled_mcps: ["websearch", "context7", "grep_app"],
			mcp_env_allowlist: [],
			claude_code: { mcp: false, agents: false, skills: false, commands: false, plugins: false, hooks: false },
		},
	}
	await writeFile(join(projectDirectory, "opencode.json"), JSON.stringify(projectConfig, null, 2) + "\n")
	await writeFile(join(projectDirectory, ".omo", "omo.jsonc"), JSON.stringify(omoConfig, null, 2) + "\n")
	await writeFile(join(runDirectory, "config-redacted.json"), JSON.stringify({
		opencode: { ...projectConfig, provider: { [PROVIDER]: { ...projectConfig.provider[PROVIDER], options: { ...projectConfig.provider[PROVIDER].options, apiKey: "[redacted-fake-key]" } } } },
		omo: omoConfig,
		lspConfig: { lsp: { typescript: { command: [lspBinary, "--stdio"], extensions: [".ts", ".tsx", ".js", ".jsx"] } } },
		localRuntime: { tmuxPath, lspBinary },
	}, null, 2) + "\n")

	const tmuxRoot = join("/tmp", `omoqa-${process.pid}-${Date.now().toString(36)}`)
	await mkdir(tmuxRoot, { recursive: true })
	const sockets = await realpath(tmuxRoot)
	// Keep the daemon's natural socket path below macOS's AF_UNIX path limit.
	// If the canonical version directory is too long, upstream falls back under
	// os.tmpdir(); here TMPDIR is deliberately nested under tempRoot, so the
	// override must itself be short enough to avoid that fallback.
	const lspDaemonRoot = await realpath(await mkdtemp(join("/tmp", "omoq-lsp-")))
	const lspDaemonDir = lspDaemonRoot
	const lspHome = join(tempRoot, "lsp-user-config")
	await Promise.all([mkdir(lspDaemonDir, { recursive: true }), mkdir(lspHome, { recursive: true })])
	const runtimePath = [dirname(lspBinary), dirname(tmuxPath), "/opt/homebrew/opt/node@24/bin", "/tmp/omo-bun-runtime-1.4.2", "/usr/local/bin", "/opt/homebrew/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":")
	const env = {
		PATH: runtimePath,
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
		CLAUDE_SETTINGS_PATH: claudeSettings,
		OPENCODE_DISABLE_MODELS_FETCH: "1",
		OPENCODE_TELEMETRY_DISABLED: "1",
		OPENCODE_SERVER_PASSWORD: PASSWORD,
		OPENCODE_PASSWORD: PASSWORD,
		TMUX_TMPDIR: sockets,
		OMO_LSP_DAEMON_DIR: lspDaemonDir,
		LSP_TOOLS_MCP_USER_CONFIG: join(lspHome, "lsp.json"),
		LSP_TOOLS_MCP_INSTALL_DECISIONS: join(lspHome, "install-decisions.json"),
	}
	const versionResult = Bun.spawnSync([CLI, "--version"], { cwd: serverCwd, env, stdout: "pipe", stderr: "pipe" })
	const version = versionResult.stdout.toString().trim() || versionResult.stderr.toString().trim()
	assert(versionResult.exitCode === 0 && version.includes("2.0.22"), `Expected pinned OpenCode 2.0.22; got ${version}`)
	const portReservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("reserved") })
	const port = portReservation.port
	portReservation.stop(true)
	assert(typeof port === "number", "Could not reserve OpenCode host port")
	const hostProcess = Bun.spawn([CLI, "--print-logs", "--log-level", "debug", "serve", "--hostname", "127.0.0.1", "--port", String(port)], {
		cwd: serverCwd,
		env,
		stdout: "pipe",
		stderr: "pipe",
	})
	const host: Host = {
		port,
		process: hostProcess,
		client: OpenCode.make({
			baseUrl: `http://127.0.0.1:${port}`,
			headers: {
				Authorization: `Basic ${Buffer.from(`opencode:${PASSWORD}`).toString("base64")}`,
				"x-opencode-directory": projectDirectory,
			},
		}),
		stdout: "",
		stderr: "",
		stdoutTask: Promise.resolve(),
		stderrTask: Promise.resolve(),
	}
	const readProcessOutput = (output: ReadableStream<Uint8Array> | number | undefined) =>
		typeof output === "number" || output === undefined ? Promise.resolve("") : new Response(output).text()
	host.stdoutTask = readProcessOutput(host.process.stdout).then((value) => { host.stdout = value })
	host.stderrTask = readProcessOutput(host.process.stderr).then((value) => { host.stderr = value })

	const requests: RequestRecord[] = []
	const routeFailures: unknown[] = []
	const originFailures: unknown[] = []
	const childImageFailures: unknown[] = []
	const toolResultFailures: unknown[] = []
			const stages = new Map<string, number>()
			const childMarkers = new Map<string, ToolMarker>()
	const checks: Record<string, boolean> = {}
	let parentSessionID: string | undefined
	let sessionCountBefore = -1
	let sessionCountAfter = -1
	let mcpNames: string[] = []
	let providerIDs: string[] = []
	let modelIDs: string[] = []
	let defaultModel = ""
	let agentPermissionEffects: Record<string, string | undefined> = {}
	let pluginActive = false
	let originProbeActive = false
	let failure: string | undefined
	let mockStopped = false
	let cleanupHostExitCode: number | null | undefined

	try {
		const readyBy = Date.now() + 25_000
		let ready = false
		while (Date.now() < readyBy && !ready) {
			if (host.process.exitCode !== null) throw new Error(`OpenCode exited during startup: ${host.process.exitCode}`)
			try {
				await host.client.server.info()
				ready = true
			} catch {
				await Bun.sleep(100)
			}
		}
		assert(ready, "OpenCode server readiness timed out")

		const activatedBy = Date.now() + 45_000
		let active = false
		let preflightState: unknown
		while (Date.now() < activatedBy && !active) {
			const [plugins, agents] = await Promise.all([host.client.plugin.list(), host.client.agent.list()])
			const failedPlugin = plugins.data.find((entry) => entry.state.status === "failed")
			assert(!failedPlugin, `Plugin setup failed: ${JSON.stringify(failedPlugin)}`)
			pluginActive = plugins.data.some((entry) => entry.id === "oh-my-openagent" && entry.state.status === "active")
			originProbeActive = plugins.data.some((entry) => entry.id === PROBE_ID && entry.state.status === "active")
			active = pluginActive && originProbeActive && agents.data.some((entry) => entry.id === "hephaestus")
			if (!active) await Bun.sleep(150)
		}
		assert(active, "OMO and local origin-probe plugins did not activate")

		const [providers, models, modelDefault, mcps, hephaestus, looker] = await Promise.all([
			host.client.provider.list(), host.client.model.list(), host.client.model.default(), host.client.mcp.list(),
			host.client.agent.get({ agentID: "hephaestus" }), host.client.agent.get({ agentID: "multimodal-looker" }),
		])
		providerIDs = providers.data.map((provider) => provider.id).sort()
		modelIDs = models.data.map((model) => `${model.providerID}/${model.id}`).sort()
		mcpNames = mcps.data.map((mcp) => mcp.name).sort()
		defaultModel = modelRef(modelDefault.data) ?? ""
		assert(providerIDs.length === 1 && providerIDs[0] === PROVIDER, `Unexpected local provider catalog: ${JSON.stringify(providerIDs)}`)
		assert(modelIDs.length === 1 && modelIDs[0] === `${PROVIDER}/${MODEL}`, `Unexpected local model catalog: ${JSON.stringify(modelIDs)}`)
		assert(defaultModel === `${PROVIDER}/${MODEL}`, `Default model escaped local mock: ${defaultModel}`)
		assert(mcpNames.length === 1 && mcpNames[0] === "lsp", `Expected only the local LSP MCP, found ${JSON.stringify(mcpNames)}`)
		assert(modelRef(hephaestus.data.model) === `${PROVIDER}/${MODEL}`, `Hephaestus was not pinned to supported local model: ${JSON.stringify(hephaestus.data.model)}`)
		assert(modelRef(looker.data.model) === `${PROVIDER}/${MODEL}`, `Multimodal looker was not pinned to local image-capable model: ${JSON.stringify(looker.data.model)}`)
		const permissionActions = ["read", "edit", "shell", "subagent", "task", "execute", "interactive_bash", "lsp_diagnostics"]
		agentPermissionEffects = Object.fromEntries(permissionActions.map((action) => [action, effectivePermission(hephaestus.data, action)]))
		for (const action of permissionActions) {
			assert(agentPermissionEffects[action] === "allow", `Native Hephaestus ${action} permission did not resolve to allow: ${JSON.stringify(agentPermissionEffects)}`)
		}

		sessionCountBefore = databaseSessionCount(databasePath)
		assert(sessionCountBefore === 0, `Isolated database was not empty before the test: ${sessionCountBefore}`)
		const created = await host.client.session.create({ title: "Hephaestus native tool surfaces QA", location: { directory: projectDirectory } })
		parentSessionID = created.id
		await host.client.session.switchAgent({ sessionID: created.id, agent: "hephaestus" })
		await host.client.session.switchModel({ sessionID: created.id, model: { providerID: PROVIDER, id: MODEL } })
		const parent = await host.client.session.get({ sessionID: created.id })
		assert(parent.location.directory === projectDirectory && parent.agent === "hephaestus" && modelRef(parent.model) === `${PROVIDER}/${MODEL}`,
			"Root session is not a location-scoped Hephaestus session on the local model")

		const sendPrompt = async (marker: ToolMarker, text: string) => {
			await within(`${marker} prompt admission`, host.client.session.prompt({ sessionID: created.id, text: `${marker}: ${text}` }))
			await within(`${marker} session completion`, host.client.session.wait({ sessionID: created.id }))
		}
		await sendPrompt("OMO_QA_HASHLINE_RENAME", "Safely rename and update the fixture file through the checked hashline path.")
		await sendPrompt("OMO_QA_HASHLINE_DELETE", "Delete only the designated fixture file using the same checked file tools.")
		await sendPrompt("OMO_QA_LOOK_AT", "Use the multimodal reader to inspect the local PNG and report its requested pixel marker.")
		await sendPrompt("OMO_QA_INTERACTIVE_BASH", "Use one isolated tmux socket to create a pane and print a marker. Attempt capture-pane and kill-server through interactive_bash, then report each response.")
		await sendPrompt("OMO_QA_LSP_DIAGNOSTICS", "Run TypeScript diagnostics on the local fixture and report the type error.")
		await sendPrompt("OMO_QA_LOOK_AT_PDF", "Use the multimodal reader to inspect the local one-page PDF and report its requested marker.")

		const parentMessages = await host.client.message.list({ sessionID: created.id })
		const parentTools = toolStates(parentMessages.data)
		const children = childRows(databasePath, created.id)
		const childEvidence = await Promise.all(children.map(async (child) => {
			const [info, messages] = await Promise.all([
				host.client.session.get({ sessionID: child.id }),
				host.client.message.list({ sessionID: child.id }),
			])
			return {
				id: child.id,
				parentID: info.parentID,
				agent: info.agent,
				model: modelRef(info.model),
				outcome: info.outcome,
				tools: toolStates(messages.data).map((tool) => ({ name: tool.name, status: tool.status, input: tool.input, text: tool.text })),
				transcript: textOf(messages.data),
			}
		}))
		const parentRow = await host.client.session.get({ sessionID: created.id })
		const renamedBytes = await readFile(renameTarget).catch(() => Buffer.alloc(0))
		const sourceExists = existsSync(renameSource)
		const deleteExists = existsSync(deleteTarget)
		const parentText = textOf(parentMessages.data)
		const child = childEvidence.find((entry) => entry.agent?.toLowerCase() === "multimodal-looker" && entry.tools.some((tool) => tool.name === "read" && JSON.stringify(tool.input).includes(imagePath)))
		const pdfChild = childEvidence.find((entry) => entry.agent?.toLowerCase() === "multimodal-looker" && entry.tools.some((tool) => tool.name === "read" && JSON.stringify(tool.input).includes(pdfPath)))
		const childImageRead = child?.tools.some((tool) => tool.name === "read" && JSON.stringify(tool.input).includes(imagePath)) === true
		const childPdfRead = pdfChild?.tools.some((tool) => tool.name === "read" && JSON.stringify(tool.input).includes(pdfPath)) === true
		const siblingRead = [...parentTools, ...(child?.tools ?? []), ...(pdfChild?.tools ?? [])].some((tool) => JSON.stringify(tool.input).includes(siblingImagePath))
		const renameTool = parentTools.find((tool) => tool.name === "hashline_edit" && JSON.stringify(tool.input).includes(renameSource))
		const deleteTool = parentTools.find((tool) => tool.name === "hashline_edit" && JSON.stringify(tool.input).includes(deleteTarget))
		const lookTool = parentTools.find((tool) => tool.name === "look_at" && JSON.stringify(tool.input).includes(imagePath))
		const pdfLookTool = parentTools.find((tool) => tool.name === "look_at" && JSON.stringify(tool.input).includes(pdfPath))
		const interactiveTools = parentTools.filter((tool) => tool.name === "interactive_bash")
		const lspTool = parentTools.find((tool) => tool.name === "execute" && String((tool.input as Record<string, unknown> | undefined)?.code).includes("tools.lsp.diagnostics"))
		const imageRequests = requests.filter((request) => request.role === "child" && request.marker === "OMO_QA_LOOK_AT" && request.childReadHasImageBytes)
		const pdfRequests = requests.filter((request) => request.role === "child" && request.marker === "OMO_QA_LOOK_AT_PDF" && request.childMedia.some((part) => part.mime === "application/pdf"))
		const imageSourceSha256 = createHash("sha256").update(imageBytes).digest("hex")
		const pdfSourceSha256 = createHash("sha256").update(pdfBytes).digest("hex")
		const exactImageHashReachedChild = imageRequests.some((request) => request.childMedia.some((part) => part.mime === "image/png" && part.sha256 === imageSourceSha256))
		const exactPdfHashReachedChild = pdfRequests.some((request) => request.childMedia.some((part) => part.sha256 === pdfSourceSha256))
		const diagnostic = lspTool?.text ?? ""
		const interactiveText = interactiveTools.map((tool) => tool.text).join("\n")
		const paneCapture = Bun.spawnSync([tmuxPath, "-L", tmuxSocket, "capture-pane", "-p", "-t", tmuxSession], { env: { ...env, TMUX_TMPDIR: sockets }, stdout: "pipe", stderr: "pipe" })
		const paneText = paneCapture.exitCode === 0 ? paneCapture.stdout.toString() : ""
		const requestOriginsValid = requests.length >= 10 && requests.every((request) => request.originValid) && originFailures.length === 0
		const assistantMarker = ["HASHLINE_RENAME_RESULT", "HASHLINE_DELETE_RESULT", "LOOK_AT_RESULT_CONSUMED", "INTERACTIVE_BASH_RESULT_CONSUMED", "LSP_DIAGNOSTIC_RESULT_CONSUMED", "LOOK_AT_PDF_RESULT_CONSUMED"]
			.every((marker) => parentText.includes(marker))
		const expectedChildRead = child?.tools.some((tool) => tool.name === "read" && tool.status === "completed") === true

		checks.frozenRuntimeAndLocalOnlyCatalog = version.includes("2.0.22") && bundleSha256 === EXPECTED_SERVER_SHA256 &&
			providerIDs.join() === PROVIDER && modelIDs.join() === `${PROVIDER}/${MODEL}` && defaultModel === `${PROVIDER}/${MODEL}` &&
			mcpNames.join() === "lsp" && pluginActive && originProbeActive
		checks.hephaestusPrimaryAndNativeAgentsContext = parentRow.agent === "hephaestus" && modelRef(parentRow.model) === `${PROVIDER}/${MODEL}` &&
			requests.some((request) => request.role === "parent" && request.kind === "primary" && request.hasHephaestus56Identity && request.hasProjectAgentsMarker)
		checks.hashlineRenameUsedNativeAliasAndPreservedContent = Boolean(renameTool && renameTool.status === "completed") &&
			!sourceExists && renamedBytes.toString("utf8") === `${renamedText}\n`
		checks.hashlineDeleteUsedNativeAlias = Boolean(deleteTool && deleteTool.status === "completed") && !deleteExists
		checks.lookAtOwnedChildReadActualImageBytes = Boolean(lookTool && lookTool.status === "completed" && child && child.parentID === created.id &&
			child.model === `${PROVIDER}/${MODEL}` && child.outcome === "succeeded" && expectedChildRead && childImageRead &&
			imageRequests.some((request) => request.childMedia.some((part) => part.mime === "image/png" && part.byteLength > 0)) &&
			!siblingRead && parentTools.some((tool) => tool.name === "look_at" && tool.text.includes("OMO_QA_PIXEL_READ")))
		checks.lookAtPdfChildReceivesDocument = Boolean(pdfLookTool && pdfLookTool.status === "completed" && pdfChild && pdfChild.parentID === created.id &&
			pdfChild.model === `${PROVIDER}/${MODEL}` && pdfChild.outcome === "succeeded" && childPdfRead && pdfRequests.length > 0 &&
			parentTools.some((tool) => tool.name === "look_at" && JSON.stringify(tool.input).includes(pdfPath) && tool.text.includes("OMO_QA_PDF_READ")))
		checks.interactiveBashUsesTaskLocalTmuxAndPreservesPane = interactiveTools.length >= 4 &&
			interactiveTools.some((tool) => tool.status === "completed" && JSON.stringify(tool.input).includes(tmuxSocket)) &&
			interactiveText.includes("capture-pane' is blocked") && interactiveText.includes("kill-server' is prohibited") &&
			paneCapture.exitCode === 0 && paneText.includes("INTERACTIVE_PANE_MARKER")
		checks.lspUsesLocalLanguageServerForRealDiagnostics = requests.some((request) => request.codeModePaths.includes("lsp.diagnostics")) &&
			Boolean(lspTool && lspTool.status === "completed" &&
			(diagnostic.includes("LSP_QA_TYPE_MISMATCH") || diagnostic.includes("Type 'string' is not assignable to type 'number'")))
		checks.allRequestsHaveExactNativeOrigins = requestOriginsValid
		checks.noUnrequestedSiblingOrOutsideWrite = !siblingRead && !existsSync(join(projectDirectory, "src", "unexpected-write.txt"))
		checks.onlyFixtureSessionsInIsolatedDatabase = sessionCountBefore === 0 && databaseSessionCount(databasePath) === 1 + children.length
		checks.fixtureRepliesWereConsumed = assistantMarker && child?.transcript.includes("LOOKER_READ_IMAGE_BYTES") === true &&
			pdfChild?.transcript.includes("LOOKER_READ_PDF_BYTES") === true

		sessionCountAfter = databaseSessionCount(databasePath)
		const summary = {
			gitHead: Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: ROOT, stdout: "pipe", stderr: "pipe" }).stdout.toString().trim(),
			runtime: version,
			serverBundleSha256: bundleSha256,
			expectedServerSha256: EXPECTED_SERVER_SHA256,
			driverSha256: createHash("sha256").update(await readFile(join(import.meta.dir, "opencode2-hephaestus-tool-surfaces-qa.ts"))).digest("hex"),
			projectDirectory,
			tempRoot,
			databasePath,
			taskLocalTmux: { path: tmuxPath, version: Bun.spawnSync([tmuxPath, "-V"], { env, stdout: "pipe", stderr: "pipe" }).stdout.toString().trim(), socketName: tmuxSocket, sessionName: tmuxSession },
			taskLocalLsp: { binary: lspBinary, version: Bun.spawnSync([lspBinary, "--version"], { env, stdout: "pipe", stderr: "pipe" }).stdout.toString().trim(), node: Bun.spawnSync(["node", "--version"], { env, stdout: "pipe", stderr: "pipe" }).stdout.toString().trim() },
			providerIDs, modelIDs, defaultModel, mcpNames, pluginActive, originProbeActive,
			agentPermissionEffects,
			runtimeToolRegistry: [...new Set(requests.flatMap((request) => request.registeredTools))].sort(),
			codeModePaths: [...new Set(requests.flatMap((request) => request.codeModePaths))].sort(),
			parentSession: { id: created.id, agent: parentRow.agent, model: modelRef(parentRow.model), outcome: parentRow.outcome },
			children: childEvidence.map((entry) => ({ id: entry.id, parentID: entry.parentID, agent: entry.agent, model: entry.model, outcome: entry.outcome, tools: entry.tools.map(({ name, status, input, text }) => ({ name, status, input, text: text.slice(0, 250) })) })),
			parentToolResults: parentTools.map(({ name, status, input, text }) => ({ name, status, input, text: text.slice(0, 350) })),
			observed: {
				childImageRead,
				imageSourceSha256,
				imageWireMedia: imageRequests.flatMap((request) => request.childMedia),
				exactImageHashReachedChild,
				childPdfRead,
				pdfSourceSha256,
				pdfWireMedia: pdfRequests.flatMap((request) => request.childMedia),
				exactPdfHashReachedChild,
				siblingRead,
				tmuxPaneCaptureExitCode: paneCapture.exitCode,
				tmuxPaneMarker: paneText.includes("INTERACTIVE_PANE_MARKER"),
				lspDiagnostic: diagnostic.slice(0, 800),
				renamedBytes: renamedBytes.toString("utf8"),
				sourceExists,
				deleteExists,
			},
			requests,
			originFailures,
			routeFailures,
			childImageFailures,
			toolResultFailures,
			sessionCountBefore,
			sessionCountAfter,
			checks: Object.fromEntries(Object.entries(checks).map(([name, passed]) => [name, { passed }])),
			passed: Object.values(checks).every(Boolean),
			createdAt: new Date().toISOString(),
		}
		await writeFile(join(runDirectory, "runtime.json"), JSON.stringify(summary, null, 2) + "\n")
		await writeFile(join(runDirectory, "provider-requests.json"), JSON.stringify(requests, null, 2) + "\n")
		if (!summary.passed) throw new Error(`Hephaestus tool-surface checks failed: ${JSON.stringify(Object.fromEntries(Object.entries(checks).filter(([, passed]) => !passed)))}`)
	} catch (error) {
		failure = error instanceof Error ? error.message : String(error)
	} finally {
		cleanupHostExitCode = await stopHost(host)
		let lspDaemonLog = ""
		const lspLogPath = join(lspDaemonDir, "v0.1.0", "daemon.log")
		if (existsSync(lspLogPath)) lspDaemonLog = await readFile(lspLogPath, "utf8")
		const lspCleanup = await stopOwnedLspDaemon(lspDaemonDir)
		localModel.stop(true)
		mockStopped = true
		const tmuxCleanup = Bun.spawnSync([tmuxPath, "-L", tmuxSocket, "kill-server"], { env: { ...env, TMUX_TMPDIR: sockets }, stdout: "pipe", stderr: "pipe" })
			let tmuxSocketDirectoryRemoved = false
			if (tmuxCleanup.exitCode === 0) {
				await rm(tmuxRoot, { recursive: true, force: true })
				tmuxSocketDirectoryRemoved = true
			}
			const cleanup = {
				hostExitCode: cleanupHostExitCode,
				mockStopped,
				taskLocalLspCleanup: lspCleanup,
				 taskLocalTmuxCleanupExitCode: tmuxCleanup.exitCode,
				tmuxSocketDirectoryRemoved,
			taskLocalTmuxCleanupStderr: tmuxCleanup.exitCode === 0 ? "" : tmuxCleanup.stderr.toString().slice(0, 500),
			tempRootRetained: existsSync(tempRoot),
		}
		await Promise.all([
			writeFile(join(runDirectory, "server.stdout.log"), (host.stdout ?? "").replaceAll(PASSWORD, "[redacted-test-password]").replaceAll(API_KEY, "[redacted-fake-key]")),
			writeFile(join(runDirectory, "server.stderr.log"), (host.stderr ?? "").replaceAll(PASSWORD, "[redacted-test-password]").replaceAll(API_KEY, "[redacted-fake-key]")),
			...(lspDaemonLog ? [writeFile(join(runDirectory, "lsp-daemon.log"), lspDaemonLog)] : []),
			writeFile(join(runDirectory, "cleanup.json"), JSON.stringify(cleanup, null, 2) + "\n"),
		])
		if (failure) {
			const base = {
				gitHead: Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: ROOT, stdout: "pipe", stderr: "pipe" }).stdout.toString().trim(),
				runtime: version,
				serverBundleSha256: bundleSha256,
				expectedServerSha256: EXPECTED_SERVER_SHA256,
				projectDirectory,
				tempRoot,
				databasePath,
				requests,
				originFailures,
				routeFailures,
				childImageFailures,
				toolResultFailures,
				sessionCountBefore,
				sessionCountAfter,
				providerIDs,
				modelIDs,
				defaultModel,
				mcpNames,
				agentPermissionEffects,
				pluginActive,
				originProbeActive,
				checks,
				cleanup,
				failure,
			}
			await writeFile(join(runDirectory, "runtime.json"), JSON.stringify(base, null, 2) + "\n")
			await writeFile(join(runDirectory, "failure.txt"), failure + "\n")
		}
	}
	if (failure) throw new Error(`${failure}\nEvidence: ${runDirectory}`)
	console.log(`Hephaestus tool-surface QA passed. Evidence: ${runDirectory}`)
}

await main()
