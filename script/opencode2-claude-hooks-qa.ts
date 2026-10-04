/** Isolated OpenCode 2.0.22 runtime proof for native Claude conversation hooks. */
import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { chmod, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises"
import { isAbsolute, join, resolve, sep } from "node:path"
import { tmpdir } from "node:os"
import { OpenCode } from "@opencode/client"

const ROOT = resolve(import.meta.dir, "..")
const EVIDENCE = resolve(process.env.OPENCODE2_QA_EVIDENCE_DIR ?? join(ROOT, ".omo/evidence/20260927-opencode2-claude-hooks"))
const PLUGIN_DIR = resolve(process.env.OPENCODE2_PLUGIN_DIR ?? join(ROOT, "dist/opencode2"))
const CLI_INPUT = process.env.OPENCODE2_CLI?.trim() ?? ""
const CLI = CLI_INPUT ? resolve(CLI_INPUT) : ""
const EXPECTED_SHA = process.env.OPENCODE2_EXPECTED_SERVER_SHA256 ?? ""
const PROVIDER = "omoqa"
const MODEL = "qa-model"
const API_KEY = "claude-hooks-fake-key-only"
const PASSWORD = "claude-hooks-local-qa-only"
const ORIGIN_PROBE_ID = "omo-claude-hooks-origin-probe"
const BLOCK_MARKER = "CLAUDE_QA_BLOCK_ORIGINAL"
const BLOCK_REASON = "CLAUDE_QA_USER_PROMPT_BLOCK_REASON"
const STOP_MARKER = "CLAUDE_QA_STOP_CONTINUE_MARKER"
const TOOL_REWRITE_PROMPT = "CLAUDE_QA_TOOL_REWRITE_PROMPT"
const TOOL_DENY_PROMPT = "CLAUDE_QA_TOOL_DENY_PROMPT"
const TOOL_ASK_PROMPT = "CLAUDE_QA_TOOL_ASK_PROMPT"
const TOOL_NATIVE_DENY_PROMPT = "CLAUDE_QA_TOOL_NATIVE_DENY_PROMPT"
const CHILD_TOOL_PROMPT = "CLAUDE_QA_CHILD_TOOL_PROMPT"
const COMPACT_MARKER = "CLAUDE_QA_PRECOMPACT_HISTORY"
const TIMEOUT_MS = 60_000

type Check = { name: string; passed: boolean; detail?: unknown }
type Request = {
	sessionID?: string
	kind?: string
	model: string
	users: string[]
	toolResults: string[]
	toolNames: string[]
	system: string[]
	originValid: boolean
	path: string
}
type Host = {
	port: number
	process: Bun.Subprocess
	client: ReturnType<typeof OpenCode.make>
	stdout: string
	stderr: string
	stdoutTask: Promise<void>
	stderrTask: Promise<void>
}

const REQUEST_KINDS = new Set(["primary", "compaction", "title", "generate"])

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message)
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

function reservePort(): number {
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("reserved") })
	const port = server.port
	server.stop(true)
	assert(typeof port === "number", "Could not reserve an isolated localhost port")
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
	return ""
}

function modelRef(value: unknown): string | undefined {
	const row = asRecord(value)
	return typeof row?.providerID === "string" && typeof row.id === "string" ? `${row.providerID}/${row.id}` : undefined
}

function userTexts(body: Record<string, unknown>): string[] {
	if (!Array.isArray(body.messages)) return []
	return body.messages.flatMap((item) => {
		const row = asRecord(item)
		return row?.role === "user" ? [contentText(row.content)] : []
	})
}

function toolResultTexts(body: Record<string, unknown>): string[] {
	if (!Array.isArray(body.messages)) return []
	return body.messages.flatMap((item) => {
		const row = asRecord(item)
		return row?.role === "tool" ? [contentText(row.content)] : []
	})
}

function toolNames(body: Record<string, unknown>): string[] {
	if (!Array.isArray(body.tools)) return []
	return body.tools.flatMap((item) => {
		const row = asRecord(item)
		const fn = asRecord(row?.function) ?? row
		return typeof fn?.name === "string" ? [fn.name] : []
	})
}

function systemTexts(body: Record<string, unknown>): string[] {
	const messages = Array.isArray(body.messages) ? body.messages : []
	return messages.flatMap((item) => {
		const row = asRecord(item)
		return row?.role === "system" ? [contentText(row.content)] : []
	})
}

function sse(text: string, id: string, model: string): Response {
	const created = Math.floor(Date.now() / 1000)
	const chunks = [
		{ id: `chatcmpl-${id}`, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] },
		{ id: `chatcmpl-${id}`, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
	]
	return new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", {
		headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive" },
	})
}

function toolSse(name: string, args: Record<string, unknown>, id: string, model: string): Response {
	const created = Math.floor(Date.now() / 1000)
	const call = { index: 0, id: `${id}-tool`, type: "function", function: { name, arguments: JSON.stringify(args) } }
	const chunks = [
		{ id: `chatcmpl-${id}`, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [call] }, finish_reason: null }] },
		{ id: `chatcmpl-${id}`, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
	]
	return new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", {
		headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive" },
	})
}

function requiredTool(body: Record<string, unknown>, name: string, failures: unknown[]): string | undefined {
	const found = toolNames(body).find((candidate) => candidate === name)
	if (found) return found
	failures.push({ expectedTool: name, availableTools: toolNames(body) })
	return undefined
}

async function stopHost(host: Host | undefined): Promise<number | null> {
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

async function waitForInboxNotice(
	client: ReturnType<typeof OpenCode.make>,
	sessionID: string,
	marker: string,
): Promise<Awaited<ReturnType<typeof client.session.inbox.list>>> {
	const deadline = Date.now() + 5_000
	let latest: Awaited<ReturnType<typeof client.session.inbox.list>> = []
	while (Date.now() < deadline) {
		latest = await client.session.inbox.list({ sessionID })
		if (latest.some((item) => item.type === "synthetic" && item.payload.text.includes(marker))) return latest
		await Bun.sleep(50)
	}
	return latest
}

async function waitForPermissionRequest(client: ReturnType<typeof OpenCode.make>, sessionID: string, predicate: (item: { action: string; message?: string; resources: string[] }) => boolean) {
	const deadline = Date.now() + 15_000
	let latest: Awaited<ReturnType<typeof client.permission.list>> = []
	while (Date.now() < deadline) {
		latest = await client.permission.list({ sessionID })
		const found = latest.find(predicate)
		if (found) return { found, latest }
		await Bun.sleep(50)
	}
	throw new Error(`Expected native permission request was not created: ${JSON.stringify(latest)}`)
}

async function waitForPredicate<T>(label: string, predicate: () => Promise<T | undefined>, timeoutMs = 15_000): Promise<T> {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		const value = await predicate()
		if (value !== undefined) return value
		await Bun.sleep(50)
	}
	throw new Error(`${label} did not become true before timeout`)
}

async function createRootSession(client: ReturnType<typeof OpenCode.make>, directory: string, title: string): Promise<string> {
	const created = await client.session.create({ title, location: { directory } })
	assert(created.location.directory === directory, `Session ${created.id} escaped the isolated project`)
	await client.session.switchAgent({ sessionID: created.id, agent: "sisyphus" })
	await client.session.switchModel({ sessionID: created.id, model: { providerID: PROVIDER, id: MODEL } })
	const session = await client.session.get({ sessionID: created.id })
	assert(session.location.directory === directory && session.agent === "sisyphus" && modelRef(session.model) === `${PROVIDER}/${MODEL}` && !session.parentID,
		`Session ownership/model preflight failed: ${JSON.stringify({ directory: session.location.directory, agent: session.agent, model: modelRef(session.model), parentID: session.parentID })}`)
	return created.id
}

async function main(): Promise<void> {
	assert(CLI_INPUT && isAbsolute(CLI_INPUT) && existsSync(CLI), "Set OPENCODE2_CLI to an explicit absolute OpenCode 2.0.22 executable")
	assert(/^[a-f0-9]{64}$/i.test(EXPECTED_SHA), "Set OPENCODE2_EXPECTED_SERVER_SHA256 to the frozen server SHA-256")
	assert(existsSync(join(PLUGIN_DIR, "server.js")), `Missing frozen server bundle at ${PLUGIN_DIR}`)
	const actualSHA = createHash("sha256").update(await readFile(join(PLUGIN_DIR, "server.js"))).digest("hex")
	assert(actualSHA === EXPECTED_SHA, `Frozen bundle hash mismatch: expected ${EXPECTED_SHA}, got ${actualSHA}`)
	const version = Bun.spawnSync([CLI, "--version"], { stdout: "pipe", stderr: "pipe" })
	assert(version.exitCode === 0 && version.stdout.toString().includes("2.0.22"), `Expected OpenCode 2.0.22: ${version.stdout.toString()} ${version.stderr.toString()}`)

	const evidenceRoot = join(ROOT, ".omo/evidence")
	const evidence = await realpath(EVIDENCE).catch(async () => { await mkdir(EVIDENCE, { recursive: true }); return realpath(EVIDENCE) })
	const relativeEvidence = evidence.slice(evidenceRoot.length + 1)
	assert(evidence.startsWith(evidenceRoot + sep) && !relativeEvidence.includes(sep), "Evidence must be one direct child under .omo/evidence")
	const attempt = join(evidence, `attempt-${Date.now()}`)
	await mkdir(attempt, { recursive: true })
	const tempRoot = await realpath(await mkdtemp(join(tmpdir(), "omo-claude-hooks-qa-")))
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
	const claudeSettings = join(project, ".claude", "settings.json")
	const probeDirectory = join(tempRoot, "origin-probe")
	const databasePath = join(tempRoot, "opencode.db")
	await Promise.all([project, serverCwd, home, xdgData, xdgConfig, xdgState, xdgCache, omoHome, claudeHome, claudePlugins, join(project, ".omo"), join(project, ".claude"), probeDirectory]
		.map((path) => mkdir(path, { recursive: true })))
	const projectDirectory = await realpath(project)
	assert(!projectDirectory.startsWith(ROOT + sep), "QA project must be outside the checkout")
	const userHookLog = join(tempRoot, "user-prompt-hook.jsonl")
	const stopHookLog = join(tempRoot, "stop-hook.jsonl")
	const stopHookCount = join(tempRoot, "stop-hook-count.txt")
	const preToolHookLog = join(tempRoot, "pre-tool-hook.jsonl")
	const preToolTranscriptLog = join(tempRoot, "pre-tool-transcripts.log")
	const postToolHookLog = join(tempRoot, "post-tool-hook.jsonl")
	const postToolTranscriptLog = join(tempRoot, "post-tool-transcripts.log")
	const postFailureHookLog = join(tempRoot, "post-tool-failure-hook.jsonl")
	const preCompactHookLog = join(tempRoot, "pre-compact-hook.jsonl")
	const preCompactTranscriptLog = join(tempRoot, "pre-compact-transcripts.log")
	const preCompactCount = join(tempRoot, "pre-compact-count.txt")
	const rewriteSideEffect = join(tempRoot, "rewrite-side-effect.txt")
	const denySideEffect = join(tempRoot, "deny-side-effect.txt")
	const askSideEffect = join(tempRoot, "ask-side-effect.txt")
	const nativeDenySideEffect = join(tempRoot, "native-deny-side-effect.txt")
		const childReadableFile = join(project, "child-readable.txt")
	const childReadableMarker = "CLAUDE_QA_CHILD_READ_RESULT"
	const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`
	const userHookPath = join(tempRoot, "user-prompt-hook.sh")
	const stopHookPath = join(tempRoot, "stop-hook.sh")
	const preToolHookPath = join(tempRoot, "pre-tool-hook.sh")
	const postToolHookPath = join(tempRoot, "post-tool-hook.sh")
	const postFailureHookPath = join(tempRoot, "post-tool-failure-hook.sh")
	const preCompactHookPath = join(tempRoot, "pre-compact-hook.sh")
	await writeFile(userHookPath, `#!/bin/sh\ninput=$(cat)\nprintf '%s\\n' "$input" >> ${quote(userHookLog)}\ncase "$input" in\n  *${BLOCK_MARKER}*) printf '%s\\n' '{"decision":"block","reason":"${BLOCK_REASON}"}'; exit 2 ;;\nesac\nexit 0\n`)
	await writeFile(stopHookPath, `#!/bin/sh\ninput=$(cat)\nprintf '%s\\n' "$input" >> ${quote(stopHookLog)}\ncount=$(cat ${quote(stopHookCount)} 2>/dev/null || printf '0')\ncount=$((count + 1))\nprintf '%s\\n' "$count" > ${quote(stopHookCount)}\nif [ "$count" -eq 1 ]; then printf '%s\\n' '{"decision":"block","reason":"QA stop requested one continuation","inject_prompt":"${STOP_MARKER}"}'; else printf '%s\\n' '{"stop_hook_active":true}'; fi\nexit 0\n`)
	await Promise.all([chmod(userHookPath, 0o755), chmod(stopHookPath, 0o755)])
	await writeFile(childReadableFile, `${childReadableMarker}\n`)
	const preToolHook = `#!/bin/sh\ninput=$(cat)\nprintf '%s\\n' "$input" >> ${quote(preToolHookLog)}\ntranscript=$(printf '%s' "$input" | sed -n 's/.*"transcript_path":"\\([^\"]*\\)".*/\\1/p')\nif [ -n "$transcript" ]; then cat "$transcript" >> ${quote(preToolTranscriptLog)}; printf '\\n---END---\\n' >> ${quote(preToolTranscriptLog)}; fi\ncase "$input" in\n  *CLAUDE_QA_TOOL_DENY_TOKEN*) printf '%s\\n' '{"decision":"deny","reason":"CLAUDE_QA_PRETOOL_DENY_REASON"}'; exit 2 ;;\n  *CLAUDE_QA_TOOL_ASK_TOKEN*|*CLAUDE_QA_TOOL_NATIVE_DENY_TOKEN*) printf '%s\\n' 'CLAUDE_QA_PRETOOL_ASK_REASON' >&2; exit 1 ;;\n  *CLAUDE_QA_TOOL_REWRITE_TOKEN*) printf '%s\\n' ${quote(JSON.stringify({ decision: "allow", hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: { command: `printf 'CLAUDE_QA_REWRITE_EXECUTED' > ${quote(rewriteSideEffect)}` } } }))} ;;\nesac\nexit 0\n`
	const postToolHook = `#!/bin/sh\ninput=$(cat)\nprintf '%s\\n' "$input" >> ${quote(postToolHookLog)}\ntranscript=$(printf '%s' "$input" | sed -n 's/.*"transcript_path":"\\([^\"]*\\)".*/\\1/p')\nif [ -n "$transcript" ]; then cat "$transcript" >> ${quote(postToolTranscriptLog)}; printf '\\n---END---\\n' >> ${quote(postToolTranscriptLog)}; fi\nprintf '%s\\n' ${quote(JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: "CLAUDE_QA_POST_TOOL_CONTEXT" }, continue: false, stopReason: "CLAUDE_QA_POST_TOOL_ADVISORY" }))}\n`
	const postFailureHook = `#!/bin/sh\ninput=$(cat)\nprintf '%s\\n' "$input" >> ${quote(postFailureHookLog)}\nprintf '%s\\n' ${quote(JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUseFailure", additionalContext: "CLAUDE_QA_POST_FAILURE_CONTEXT" } }))}\n`
	const preCompactHook = `#!/bin/sh\ninput=$(cat)\nprintf '%s\\n' "$input" >> ${quote(preCompactHookLog)}\ntranscript=$(printf '%s' "$input" | sed -n 's/.*"transcript_path":"\\([^\"]*\\)".*/\\1/p')\nif [ -n "$transcript" ]; then cat "$transcript" >> ${quote(preCompactTranscriptLog)}; printf '\\n---END---\\n' >> ${quote(preCompactTranscriptLog)}; fi\ncount=$(cat ${quote(preCompactCount)} 2>/dev/null || printf '0')\ncount=$((count + 1))\nprintf '%s\\n' "$count" > ${quote(preCompactCount)}\nif [ "$count" -eq 1 ]; then printf '%s\\n' ${quote(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreCompact", additionalContext: ["CLAUDE_QA_PRECOMPACT_CONTEXT"] } }))}; else printf '%s\\n' ${quote(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreCompact", additionalContext: ["CLAUDE_QA_PRECOMPACT_BLOCK_CONTEXT"] }, continue: false, stopReason: "CLAUDE_QA_PRECOMPACT_BLOCK_REASON" }))}; fi\n`
	await Promise.all([
		writeFile(preToolHookPath, preToolHook), writeFile(postToolHookPath, postToolHook),
		writeFile(postFailureHookPath, postFailureHook), writeFile(preCompactHookPath, preCompactHook),
	])
	await Promise.all([chmod(preToolHookPath, 0o755), chmod(postToolHookPath, 0o755), chmod(postFailureHookPath, 0o755), chmod(preCompactHookPath, 0o755)])
	await writeFile(claudeSettings, JSON.stringify({
		hooks: {
			UserPromptSubmit: [{ matcher: "*", hooks: [{ type: "command", command: quote(userHookPath) }] }],
			Stop: [{ matcher: "*", hooks: [{ type: "command", command: quote(stopHookPath) }] }],
			PreToolUse: ["Bash", "Read"].map((matcher) => ({ matcher, hooks: [{ type: "command", command: quote(preToolHookPath) }] })),
			PostToolUse: ["Bash", "Read"].map((matcher) => ({ matcher, hooks: [{ type: "command", command: quote(postToolHookPath) }] })),
			PostToolUseFailure: [{ matcher: "Bash", hooks: [{ type: "command", command: quote(postFailureHookPath) }] }],
			PreCompact: [{ matcher: "*", hooks: [{ type: "command", command: quote(preCompactHookPath) }] }],
		},
	}, null, 2) + "\n")
	await writeFile(join(project, ".omo", "omo.jsonc"), JSON.stringify({
		telemetry: { enabled: false },
		"[opencode]": {
			telemetry: false,
			disabled_hooks: [],
			disabled_mcps: ["websearch", "context7", "grep_app", "lsp"],
			mcp_env_allowlist: [],
			claude_code: { mcp: false, agents: false, skills: false, commands: false, plugins: false, hooks: true },
		},
	}, null, 2) + "\n")

	const requests: Request[] = []
	const originFailures: unknown[] = []
	const unexpectedPaths: string[] = []
	const requiredToolFailures: unknown[] = []
	const scenarioTurns = new Map<string, number>()
	let host: Host | undefined
	let rootSessionID: string | undefined
	let childPipelineRootID: string | undefined
	let mockStopped = false
	const mock = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const url = new URL(request.url)
			if (url.pathname === "/v1/models") return Response.json({ data: [{ id: MODEL, object: "model", created: 0, owned_by: "claude-hooks-qa" }] })
			if (url.pathname !== "/v1/chat/completions" || request.method !== "POST") {
				unexpectedPaths.push(`${request.method} ${url.pathname}`)
				return new Response("unexpected path", { status: 404 })
			}
			const body = await request.json() as Record<string, unknown>
			const sessionID = request.headers.get("x-omo-qa-session-id") ?? undefined
			const kind = request.headers.get("x-omo-qa-kind") ?? undefined
			const requestModel = typeof body.model === "string" ? body.model : ""
			const users = userTexts(body)
			const outputs = toolResultTexts(body)
			const originValid = Boolean(sessionID && kind && REQUEST_KINDS.has(kind) && requestModel === MODEL)
			const row = { sessionID, kind, model: requestModel, users, toolResults: outputs, toolNames: toolNames(body), system: systemTexts(body), originValid, path: url.pathname }
			requests.push(row)
			if (!originValid) {
				originFailures.push(row)
				return Response.json({ error: { message: "Rejected nonlocal or unattributed QA request" } }, { status: 400 })
			}
				if (kind === "compaction") return sse([
					"## Objective",
					"- Verify Claude hook behavior on the local QA session.",
					"## Requirements",
					"- Use only the isolated local mock provider.",
					"## Decisions",
					"- Keep the scenario bounded and preserve the native transcript.",
					"## Work State",
					"### Completed",
					"- First compaction completed.",
					"### Active",
					"- Verify the blocked second compaction.",
					"### Blocked",
					"- (none)",
					"## Next Move",
					"1. Continue the isolated QA.",
				].join("\n"), `claude-hooks-${requests.length}`, requestModel)
			if (kind !== "primary") return sse("CLAUDE_QA_AUXILIARY_RESPONSE", `claude-hooks-${requests.length}`, requestModel)
			const latestUser = users.at(-1) ?? ""
			const respondToolScenario = (marker: string, toolName: string, args: Record<string, unknown>, done: string): Response | undefined => {
				if (!latestUser.includes(marker)) return undefined
				const routeKey = `${sessionID ?? "unknown"}\0${marker}`
				const turn = (scenarioTurns.get(routeKey) ?? 0) + 1
				scenarioTurns.set(routeKey, turn)
				if (turn > 1) return sse(done, `claude-hooks-${requests.length}`, requestModel)
				const actual = requiredTool(body, toolName, requiredToolFailures)
				if (!actual) return Response.json({ error: { message: `Required tool ${toolName} is not available` } }, { status: 500 })
				return toolSse(actual, args, `claude-hooks-${requests.length}`, requestModel)
			}
			if (latestUser.includes(CHILD_TOOL_PROMPT)) {
				if (sessionID === childPipelineRootID) {
					const routeKey = `${sessionID}\0${CHILD_TOOL_PROMPT}`
					const turn = (scenarioTurns.get(routeKey) ?? 0) + 1
					scenarioTurns.set(routeKey, turn)
					if (turn === 1) {
						const actual = requiredTool(body, "subagent", requiredToolFailures)
						if (!actual) return Response.json({ error: { message: "Required native subagent tool is not available" } }, { status: 500 })
						return toolSse(actual, {
							agent: "explore",
							description: "Claude hook child QA",
							prompt: `Read ${childReadableFile}; include ${CHILD_TOOL_PROMPT} in your work marker.`,
							background: false,
						}, `claude-hooks-${requests.length}`, requestModel)
					}
					return sse("CLAUDE_QA_CHILD_PARENT_COMPLETED", `claude-hooks-${requests.length}`, requestModel)
				}
				const routeKey = `${sessionID ?? "unknown"}\0${CHILD_TOOL_PROMPT}`
				const turn = (scenarioTurns.get(routeKey) ?? 0) + 1
				scenarioTurns.set(routeKey, turn)
				if (turn === 1) {
					const actual = requiredTool(body, "read", requiredToolFailures)
					if (!actual) return Response.json({ error: { message: "Required native read tool is not available in child" } }, { status: 500 })
					return toolSse(actual, { path: childReadableFile }, `claude-hooks-${requests.length}`, requestModel)
				}
				return sse("CLAUDE_QA_CHILD_READ_COMPLETED", `claude-hooks-${requests.length}`, requestModel)
			}
			const rewriteResponse = respondToolScenario(TOOL_REWRITE_PROMPT, "shell", { command: `printf 'CLAUDE_QA_TOOL_REWRITE_TOKEN'` }, "CLAUDE_QA_TOOL_REWRITE_COMPLETED")
			if (rewriteResponse) return rewriteResponse
			const denyResponse = respondToolScenario(TOOL_DENY_PROMPT, "shell", { command: `printf DENIED > ${quote(denySideEffect)} # CLAUDE_QA_TOOL_DENY_TOKEN` }, "CLAUDE_QA_TOOL_DENY_COMPLETED")
			if (denyResponse) return denyResponse
			const askResponse = respondToolScenario(TOOL_ASK_PROMPT, "shell", { command: `printf ASKED > ${quote(askSideEffect)} # CLAUDE_QA_TOOL_ASK_TOKEN` }, "CLAUDE_QA_TOOL_ASK_COMPLETED")
			if (askResponse) return askResponse
			const nativeDenyResponse = respondToolScenario(TOOL_NATIVE_DENY_PROMPT, "shell", { command: `printf CLAUDE_QA_TOOL_NATIVE_DENY_TOKEN > ${quote(nativeDenySideEffect)}` }, "CLAUDE_QA_TOOL_NATIVE_DENY_COMPLETED")
			if (nativeDenyResponse) return nativeDenyResponse
			const text = users.some((value) => value.includes(STOP_MARKER))
				? "CLAUDE_QA_STOP_CONTINUATION_COMPLETED"
				: users.some((value) => value.includes("CLAUDE_QA_STOP_ROOT_TURN"))
					? "CLAUDE_QA_STOP_ROOT_COMPLETED"
					: "CLAUDE_QA_ALLOWED_NEXT_PROMPT_COMPLETED"
			return sse(text, `claude-hooks-${requests.length}`, requestModel)
		},
	})
	const mockOrigin = `http://127.0.0.1:${mock.port}`
	const probeSource = `export default { id: ${JSON.stringify(ORIGIN_PROBE_ID)}, setup: async ({ session }) => {
	const origin = ${JSON.stringify(mockOrigin)};
	const model = await session.hook("model.request", (event) => {
		if (event.model.providerID !== ${JSON.stringify(PROVIDER)} || event.model.id !== ${JSON.stringify(MODEL)}) throw new Error("QA blocked nonlocal model");
	});
	const http = await session.hook("http.request", (event) => {
		if (new URL(event.request.url).origin !== origin) throw new Error("QA blocked nonlocal HTTP destination");
		const headers = new Headers(event.request.headers);
		if (event.sessionID) headers.set("x-omo-qa-session-id", event.sessionID);
		if (event.kind) headers.set("x-omo-qa-kind", event.kind);
		event.request = new Request(event.request, { headers });
	});
	return async () => { await Promise.all([model.dispose(), http.dispose()]); };
} }\n`
	await writeFile(join(probeDirectory, "index.js"), probeSource)
	const providerConfig = {
		name: "Isolated Claude hooks QA mock",
		npm: "@ai-sdk/openai-compatible",
		options: { baseURL: `${mockOrigin}/v1`, apiKey: API_KEY },
				models: { [MODEL]: { name: "Local fake model", tool_call: true, limit: { context: 200_000, output: 8_192 } } },
	}
	const opencodeConfig = {
		$schema: "https://opencode.ai/config.json",
		plugins: [probeDirectory, PLUGIN_DIR],
		enabled_providers: [PROVIDER],
		model: `${PROVIDER}/${MODEL}`,
		default_agent: "sisyphus",
		provider: { [PROVIDER]: providerConfig },
		mcp: {},
		telemetry: false,
		permission: { read: "allow", edit: "allow", grep: "allow", shell: "allow", task: "allow", subagent: "allow" },
	}
	await writeFile(join(project, "opencode.json"), JSON.stringify(opencodeConfig, null, 2) + "\n")
	const redact = { ...opencodeConfig, provider: { [PROVIDER]: { ...providerConfig, options: { baseURL: `${mockOrigin}/v1`, apiKey: "[redacted fake key]" } } } }
	await writeFile(join(attempt, "config-redacted.json"), JSON.stringify({ opencode: redact, claudeSettings: JSON.parse(await readFile(claudeSettings, "utf8")), omo: JSON.parse(await readFile(join(project, ".omo/omo.jsonc"), "utf8")) }, null, 2) + "\n")

	const env: Record<string, string> = {
		PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
		TMPDIR: tempRoot, HOME: home, XDG_DATA_HOME: xdgData, XDG_CONFIG_HOME: xdgConfig,
		XDG_STATE_HOME: xdgState, XDG_CACHE_HOME: xdgCache, OMO_HOME: omoHome,
		CLAUDE_CONFIG_DIR: claudeHome, CLAUDE_PLUGINS_HOME: claudePlugins,
		OPENCODE_DB: databasePath, OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_TELEMETRY_DISABLED: "1",
		OPENCODE_SERVER_PASSWORD: PASSWORD, OPENCODE_PASSWORD: PASSWORD,
	}
	const checks: Check[] = []
	const check = (name: string, passed: boolean, detail?: unknown) => checks.push({ name, passed, ...(detail === undefined ? {} : { detail }) })
	let failure: string | undefined
	let registry: unknown
	let sessionID: string | undefined
	let blockedPromptError: string | undefined
	let blockedTranscript: unknown
	let successfulTranscript: unknown
	let cleanupExitCode: number | null = null
	const cliVersion = version.stdout.toString().trim()

	try {
		const port = reservePort()
		const command = [CLI, "--print-logs", "--log-level", "debug", "serve", "--hostname", "127.0.0.1", "--port", String(port)]
		const process = Bun.spawn(command, { cwd: serverCwd, env, stdout: "pipe", stderr: "pipe" })
		const auth = Buffer.from(`opencode:${PASSWORD}`).toString("base64")
		host = {
			port, process,
			client: OpenCode.make({ baseUrl: `http://127.0.0.1:${port}`, headers: { Authorization: `Basic ${auth}`, "x-opencode-directory": projectDirectory } }),
			stdout: "", stderr: "", stdoutTask: Promise.resolve(), stderrTask: Promise.resolve(),
		}
		host.stdoutTask = new Response(process.stdout as ReadableStream<Uint8Array>).text().then((text) => { host!.stdout = text })
		host.stderrTask = new Response(process.stderr as ReadableStream<Uint8Array>).text().then((text) => { host!.stderr = text })
		const readyBy = Date.now() + 25_000
		while (Date.now() < readyBy) {
			if (process.exitCode !== null) throw new Error(`OpenCode exited early (${process.exitCode})`)
			try { await host.client.server.info(); break } catch { await Bun.sleep(100) }
		}
		await within("OpenCode server ready", host.client.server.info(), 1_000)

		const activeBy = Date.now() + 45_000
		let active = false
		let pluginStates: unknown[] = []
		let registryRows: Record<string, unknown> = {}
		while (Date.now() < activeBy && !active) {
			const [plugins, agents] = await Promise.all([host.client.plugin.list(), host.client.agent.list()])
			pluginStates = plugins.data.map(({ id, state }) => ({ id, status: state.status }))
			const failed = plugins.data.find((item) => item.state.status === "failed")
			assert(!failed, `Plugin failed before prompts: ${JSON.stringify({ id: failed?.id, state: failed?.state })}`)
			const omo = plugins.data.some((item) => item.id === "oh-my-openagent" && item.state.status === "active")
			const probe = plugins.data.some((item) => item.id === ORIGIN_PROBE_ID && item.state.status === "active")
			if (omo && probe && agents.data.some((agent) => agent.id === "sisyphus")) {
				const [models, providers, defaultModel, mcps] = await Promise.all([host.client.model.list(), host.client.provider.list(), host.client.model.default(), host.client.mcp.list()])
				const modelIDs = models.data.map((entry) => `${entry.providerID}/${entry.id}`).sort()
				const providerIDs = providers.data.map((entry) => entry.id).sort()
				const mcpIDs = mcps.data.map((entry) => entry.name).sort()
				registryRows = { pluginStates, agents: agents.data.map((item) => item.id).sort(), modelIDs, providerIDs, defaultModel: modelRef(defaultModel.data), mcpIDs }
				active = modelIDs.join("\n") === `${PROVIDER}/${MODEL}` && providerIDs.join("\n") === PROVIDER &&
					modelRef(defaultModel.data) === `${PROVIDER}/${MODEL}` && mcpIDs.length === 0
			}
			if (!active) await Bun.sleep(150)
		}
		assert(active, `Native isolated preflight failed: ${JSON.stringify(registryRows)}`)
		registry = registryRows
		check("r9 artifact and OpenCode version are exact", actualSHA === EXPECTED_SHA && cliVersion.includes("2.0.22"), { actualSHA, cliVersion })
		check("both plugins active with exactly one local model/provider and no MCP", active, registryRows)

		sessionID = await createRootSession(host.client, projectDirectory, "Claude hooks isolated QA")
		rootSessionID = sessionID

		let blockedRejected = false
		const blockedRequestBaseline = requests.length
		try { await within("blocked original prompt", host.client.session.prompt({ sessionID, text: `Please process ${BLOCK_MARKER}.` })) }
		catch (error) { blockedRejected = true; blockedPromptError = String(error) }
		await Bun.sleep(250)
		const blockedMessageList = await host.client.message.list({ sessionID })
		blockedTranscript = blockedMessageList.data
		const blockedInbox = await waitForInboxNotice(host.client, sessionID, BLOCK_REASON)
		const blockedInboxSerialized = JSON.stringify(blockedInbox)
		const blockedHookLines = await readFile(userHookLog, "utf8").catch(() => "")
		check("UserPromptSubmit hook fired with the marked real prompt", blockedHookLines.includes("UserPromptSubmit") && blockedHookLines.includes(BLOCK_MARKER), blockedHookLines)
		check("blocked user prompt rejects original admission", blockedRejected, blockedPromptError)
		check("blocked reason is visible in the native pending inbox", blockedInboxSerialized.includes(BLOCK_REASON) && blockedInboxSerialized.includes("Claude UserPromptSubmit hook blocked this prompt"), blockedInbox)
		check("blocked original prompt produced no provider request", requests.length === blockedRequestBaseline, { requestsBefore: blockedRequestBaseline, requestsAfter: requests })

		const allowedBaseline = requests.length
		await within("allowed follow-up prompt", host.client.session.prompt({ sessionID, text: `Run the allowed turn ${"CLAUDE_QA_STOP_ROOT_TURN"} and finish.` }))
		await within("allowed follow-up execution", host.client.session.wait({ sessionID }))
		const doneBy = Date.now() + 20_000
		let finalSession = await host.client.session.get({ sessionID })
		let finalMessages = await host.client.message.list({ sessionID })
		const hasStopCompletion = (rows: readonly unknown[]) => rows.some((item) => {
			const row = asRecord(item)
			return row?.type === "assistant" && contentText(row.content).includes("CLAUDE_QA_STOP_CONTINUATION_COMPLETED")
		})
		while (Date.now() < doneBy) {
			finalSession = await host.client.session.get({ sessionID })
			finalMessages = await host.client.message.list({ sessionID })
			const allowedRequests = requests.slice(allowedBaseline).filter((item) => item.sessionID === sessionID)
			if (allowedRequests.some((item) => item.users.some((text) => text.includes(STOP_MARKER))) &&
				finalSession.outcome === "succeeded" && hasStopCompletion(finalMessages.data)) break
			await Bun.sleep(100)
		}
		successfulTranscript = finalMessages.data
		const allowedRequests = requests.slice(allowedBaseline).filter((item) => item.sessionID === sessionID)
		const finalRows = finalMessages.data.map(asRecord).filter((item): item is Record<string, unknown> => item !== undefined)
		const blockedInboxItem = blockedInbox.find((item) => item.type === "synthetic" && item.payload.text.includes(BLOCK_REASON))
		const deliveredBlockNotice = blockedInboxItem !== undefined && finalRows.some((row) => {
			const metadata = asRecord(row.metadata)
			return row.id === blockedInboxItem.id && row.type === "synthetic" && contentText(row.text).includes(BLOCK_REASON) &&
				metadata?.omoClaudeHookBlock === true && metadata.hook === "UserPromptSubmit"
		})
		const postTurnInbox = await host.client.session.inbox.list({ sessionID })
		const blockedNoticeStillPending = blockedInboxItem !== undefined && postTurnInbox.some((item) => item.id === blockedInboxItem.id)
		const stopSyntheticRows = finalRows.filter((row) => row.type === "synthetic" && contentText(row.text).includes(STOP_MARKER))
		const stopMarkerRequests = allowedRequests.filter((item) => item.users.some((text) => text.includes(STOP_MARKER)))
		const stopSyntheticCreated = Number(asRecord(stopSyntheticRows[0]?.time)?.created)
		const terminalAfterStopSynthetic = stopSyntheticRows.length === 1 && Number.isFinite(stopSyntheticCreated) && finalRows.some((row) => {
			const created = Number(asRecord(row.time)?.created)
			return row.type === "idle" && row.outcome === "succeeded" && Number.isFinite(created) && created > stopSyntheticCreated
		})
		const stopLog = await readFile(stopHookLog, "utf8").catch(() => "")
		const stopInputs = stopLog.split("\n").filter(Boolean).flatMap((line) => {
			try { return [JSON.parse(line) as Record<string, unknown>] } catch { return [] }
		})
		const stopActive = stopInputs.map((item) => item.stop_hook_active)
		const allProviderRequestsLocal = requests.length > 0 && requests.every((item) => item.originValid && item.path === "/v1/chat/completions")
		check("Stop hook ran on the successful root turn", stopInputs.length >= 1 && stopActive[0] === false, stopInputs)
		check("Stop hook emitted exactly one continuation and its execution completed", allowedRequests.length === 3 &&
			allowedRequests[0]?.users.some((text) => text.includes("CLAUDE_QA_STOP_ROOT_TURN")) === true &&
			allowedRequests[1]?.users.some((text) => text.includes(BLOCK_REASON)) === true &&
			stopMarkerRequests.length === 1 && stopSyntheticRows.length === 1 && terminalAfterStopSynthetic &&
			stopActive.length === 2 && stopActive[0] === false && stopActive[1] === true,
			{ allowedRequests, stopActive, stopMarkerRequests, stopSyntheticRows, terminalAfterStopSynthetic })
		check("native follow-up session remains usable after rejected prompt", finalSession.outcome === "succeeded" && JSON.stringify(finalMessages.data).includes("CLAUDE_QA_STOP_CONTINUATION_COMPLETED"),
			{ outcome: finalSession.outcome, transcript: finalMessages.data })
		check("all observed provider requests stayed on the exact local session/model origin", allProviderRequestsLocal && originFailures.length === 0 && unexpectedPaths.length === 0,
			{ requests, originFailures, unexpectedPaths })
		check("blocked inbox notice was delivered once and both hook messages remain observable", blockedInboxSerialized.includes(BLOCK_REASON) &&
			deliveredBlockNotice && !blockedNoticeStillPending && stopSyntheticRows.length === 1 &&
			contentText(stopSyntheticRows[0]?.text).includes(STOP_MARKER),
			{ blockedInbox, deliveredBlockNotice, blockedNoticeStillPending, postTurnInbox, stopSyntheticRows })

		const runScenario = async (title: string, marker: string): Promise<{ sessionID: string; messages: unknown[] }> => {
			const id = await createRootSession(host!.client, projectDirectory, title)
			await within(marker + " prompt", host!.client.session.prompt({ sessionID: id, text: "Run the requested local hook scenario " + marker + "." }))
			await within(marker + " execution", host!.client.session.wait({ sessionID: id }))
			const messages = (await host!.client.message.list({ sessionID: id })).data
			return { sessionID: id, messages }
		}

		const rewriteScenario = await runScenario("Claude Pre/Post tool rewrite", TOOL_REWRITE_PROMPT)
		const rewriteRequests = requests.filter((item) => item.sessionID === rewriteScenario.sessionID && item.kind === "primary")
		const rewriteToolContextObserved = rewriteRequests.some((item) => item.toolResults.some((value) => value.includes("CLAUDE_QA_POST_TOOL_CONTEXT")))
		const rewriteSideEffectText = await readFile(rewriteSideEffect, "utf8").catch(() => "")
		check("PreToolUse rewrite changes native shell execution and PostToolUse context reaches the next model call",
			rewriteSideEffectText.trim() === "CLAUDE_QA_REWRITE_EXECUTED" && rewriteToolContextObserved &&
			JSON.stringify(rewriteScenario.messages).includes("CLAUDE_QA_TOOL_REWRITE_COMPLETED"),
			{ sessionID: rewriteScenario.sessionID, rewriteSideEffect: rewriteSideEffectText, rewriteRequests })

		const denyScenario = await runScenario("Claude PreTool deny", TOOL_DENY_PROMPT)
		const denyToolErrors = denyScenario.messages.flatMap((item) => {
			const row = asRecord(item)
			return row?.type === "assistant" && Array.isArray(row.content)
				? row.content.flatMap((part) => {
					const tool = asRecord(part)
					const state = asRecord(tool?.state)
					const error = asRecord(state?.error)
					return state?.status === "error" && typeof error?.message === "string" ? [error.message] : []
				})
				: []
		})
		check("PreToolUse deny reaches the model as a failed tool and prevents the shell side effect",
			!existsSync(denySideEffect) && denyToolErrors.some((message) => message.includes("CLAUDE_QA_PRETOOL_DENY_REASON")),
			{ sessionID: denyScenario.sessionID, toolErrors: denyToolErrors, messages: denyScenario.messages, sideEffectExists: existsSync(denySideEffect) })

		const askSessionID = await createRootSession(host.client, projectDirectory, "Claude PreTool ask")
		const askPromptSettled = host.client.session.prompt({ sessionID: askSessionID, text: "Request approval for the local tool " + TOOL_ASK_PROMPT + "." })
			.then(() => ({ rejected: false, error: undefined }), (error) => ({ rejected: true, error: String(error) }))
		const askRequest = await waitForPermissionRequest(host.client, askSessionID, (item) =>
			item.action === "shell" && item.message?.includes("CLAUDE_QA_PRETOOL_ASK_REASON") === true)
		await host.client.permission.reply({ sessionID: askSessionID, requestID: askRequest.found.id, decision: "reject", message: "Claude hook QA rejects this request" })
		const askPromptResult = await within("ask prompt after rejection", askPromptSettled)
		await within("ask session after rejection", host.client.session.wait({ sessionID: askSessionID }))
		const askMessages = (await host.client.message.list({ sessionID: askSessionID })).data
		check("PreToolUse ask becomes a native permission request and rejected approval prevents execution",
			askRequest.found.message?.includes("CLAUDE_QA_PRETOOL_ASK_REASON") === true && askPromptResult.rejected === false &&
			!existsSync(askSideEffect) && JSON.stringify(askMessages).includes("CLAUDE_QA_TOOL_ASK_COMPLETED"),
			{ sessionID: askSessionID, request: askRequest.found, prompt: askPromptResult, messages: askMessages, sideEffectExists: existsSync(askSideEffect) })

		const nativeDenySessionID = await createRootSession(host.client, projectDirectory, "Claude hook native deny")
		// Keep the exact parsed shell resource identical to the session deny rule;
		// a trailing shell comment is not part of ShellParse's permission resource.
		const nativeDenyCommand = "printf CLAUDE_QA_TOOL_NATIVE_DENY_TOKEN > " + quote(nativeDenySideEffect)
		await host.client.session.update({ sessionID: nativeDenySessionID, permissions: [{ action: "shell", resource: nativeDenyCommand, effect: "deny" }] })
		const nativeDenyPrompt = host.client.session.prompt({ sessionID: nativeDenySessionID, text: "Attempt the explicitly denied tool " + TOOL_NATIVE_DENY_PROMPT + "." })
			.then(() => ({ status: "resolved" as const }), (error) => ({ status: "rejected" as const, error: String(error) }))
		let nativeDenyPromptResult: Awaited<typeof nativeDenyPrompt> | undefined
		let unexpectedNativeAsk: Awaited<ReturnType<typeof host.client.permission.list>>[number] | undefined
		const nativeDenyDeadline = Date.now() + 15_000
		while (Date.now() < nativeDenyDeadline && !nativeDenyPromptResult && !unexpectedNativeAsk) {
			unexpectedNativeAsk = (await host.client.permission.list({ sessionID: nativeDenySessionID }))
				.find((item) => item.action === "shell")
			if (!unexpectedNativeAsk) {
				nativeDenyPromptResult = await Promise.race([nativeDenyPrompt, Bun.sleep(50).then(() => undefined)])
			}
		}
		if (unexpectedNativeAsk) {
			await host.client.permission.reply({ sessionID: nativeDenySessionID, requestID: unexpectedNativeAsk.id, decision: "reject", message: "QA cleanup for unexpected permission under an explicit native deny" })
			throw new Error(`Explicit native deny incorrectly became a pending Claude approval: ${JSON.stringify(unexpectedNativeAsk)}`)
		}
		assert(nativeDenyPromptResult, "Native-deny prompt did not settle or create an observable permission request")
		await within("native deny execution", host.client.session.wait({ sessionID: nativeDenySessionID }), 15_000)
		const nativeDenyMessages = (await host.client.message.list({ sessionID: nativeDenySessionID })).data
		const nativeDenyPermissions = await host.client.permission.list({ sessionID: nativeDenySessionID })
		check("Claude ask cannot weaken an explicit native deny",
			!existsSync(nativeDenySideEffect) && nativeDenyPermissions.length === 0 &&
			JSON.stringify(nativeDenyMessages).includes("CLAUDE_QA_POST_FAILURE_CONTEXT"),
			{ sessionID: nativeDenySessionID, prompt: nativeDenyPromptResult, messages: nativeDenyMessages, pendingPermissions: nativeDenyPermissions, sideEffectExists: existsSync(nativeDenySideEffect) })

		const compactSessionID = await createRootSession(host.client, projectDirectory, "Claude PreCompact context")
		await within("precompact history prompt", host.client.session.prompt({ sessionID: compactSessionID, text: "Keep this history for compaction: " + COMPACT_MARKER + "." }))
		await within("precompact history execution", host.client.session.wait({ sessionID: compactSessionID }))
		await within("first native compaction", host.client.session.compact({ sessionID: compactSessionID }))
		await within("first compaction execution", host.client.session.wait({ sessionID: compactSessionID }))
		await within("post-compaction history prompt", host.client.session.prompt({ sessionID: compactSessionID, text: "Add one fresh exchange after the first compact: CLAUDE_QA_POST_COMPACTION_HISTORY." }))
		await within("post-compaction history execution", host.client.session.wait({ sessionID: compactSessionID }))
		const preCompactWire = requests.filter((item) => item.sessionID === compactSessionID && item.kind === "compaction")
		const compactBeforeBlock = preCompactWire.length
		await within("second native compaction enqueue", host.client.session.compact({ sessionID: compactSessionID }))
		let blockedCompactionFailure: string | undefined
		try { await within("blocked compaction execution", host.client.session.wait({ sessionID: compactSessionID })) }
		catch (error) { blockedCompactionFailure = String(error) }
		const preCompactLines = (await readFile(preCompactHookLog, "utf8").catch(() => "")).trim().split("\n").filter(Boolean)
		const preCompactTranscripts = await readFile(preCompactTranscriptLog, "utf8").catch(() => "")
		const compactMessages = (await host.client.message.list({ sessionID: compactSessionID })).data
		const compactionsAfterBlock = requests.filter((item) => item.sessionID === compactSessionID && item.kind === "compaction")
		check("PreCompact receives native transcript and adds its context to the real compaction request",
			preCompactLines.length >= 1 && preCompactTranscripts.includes(COMPACT_MARKER) && preCompactWire.length === 1 &&
			preCompactWire[0]?.system.some((value) => value.includes("CLAUDE_QA_PRECOMPACT_CONTEXT")),
			{ sessionID: compactSessionID, preCompactLines: preCompactLines.length, wire: preCompactWire })
		check("PreCompact continue=false fails native compaction without a second provider summary",
			preCompactLines.length >= 2 && compactionsAfterBlock.length === compactBeforeBlock &&
			(JSON.stringify(compactMessages).includes("CLAUDE_QA_PRECOMPACT_BLOCK_REASON") || blockedCompactionFailure !== undefined),
			{ sessionID: compactSessionID, preCompactLines: preCompactLines.length, compactionsBefore: compactBeforeBlock, compactionsAfter: compactionsAfterBlock.length, blockedCompactionFailure, messages: compactMessages })

		const childRootID = await createRootSession(host.client, projectDirectory, "Claude child tool hooks")
		childPipelineRootID = childRootID
		await within("native child hook prompt", host.client.session.prompt({ sessionID: childRootID, text: "Delegate the read check now: " + CHILD_TOOL_PROMPT + "." }))
		await within("native child hook execution", host.client.session.wait({ sessionID: childRootID }))
		const childRows = (await host.client.session.list({ directory: projectDirectory, parentID: childRootID, limit: 20 })).data
		const childRow = childRows.find((row) => row.parentID === childRootID)
		const childMessages = childRow ? (await host.client.message.list({ sessionID: childRow.id })).data : []
		const preToolRows = (await readFile(preToolHookLog, "utf8")).trim().split("\n").filter(Boolean).flatMap((line) => {
			try { return [JSON.parse(line) as Record<string, unknown>] } catch { return [] }
		})
		const postToolRows = (await readFile(postToolHookLog, "utf8")).trim().split("\n").filter(Boolean).flatMap((line) => {
			try { return [JSON.parse(line) as Record<string, unknown>] } catch { return [] }
		})
		const childPrimaryRequests = requests.filter((item) => item.sessionID === childRow?.id && item.kind === "primary")
		check("native child session runs PreToolUse/PostToolUse hooks with its own transcript and tool result",
			Boolean(childRow && childRow.agent === "explore" && childPrimaryRequests.length >= 2 &&
				preToolRows.some((item) => item.session_id === childRow.id && item.tool_name === "Read") &&
				postToolRows.some((item) => item.session_id === childRow.id && item.tool_name === "Read") &&
				JSON.stringify(childMessages).includes(childReadableMarker) && JSON.stringify(childMessages).includes("CLAUDE_QA_POST_TOOL_CONTEXT")),
			{ childRow, childRows, childMessages, childPrimaryRequests, preToolRows: preToolRows.filter((item) => item.session_id === childRow?.id), postToolRows: postToolRows.filter((item) => item.session_id === childRow?.id) })

		check("all Claude phase model requests remained attributed to the exact local provider",
			requests.length > 0 && requests.every((item) => item.originValid && item.path === "/v1/chat/completions") &&
			originFailures.length === 0 && requiredToolFailures.length === 0 && unexpectedPaths.length === 0,
			{ requests, originFailures, requiredToolFailures, unexpectedPaths })
	} catch (error) {
		failure = error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ""}` : String(error)
	} finally {
		cleanupExitCode = await stopHost(host)
		mock.stop(true)
		mockStopped = true
		const gitHead = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: ROOT, stdout: "pipe", stderr: "pipe" }).stdout.toString().trim()
		const finalSHA = existsSync(join(PLUGIN_DIR, "server.js"))
			? createHash("sha256").update(await readFile(join(PLUGIN_DIR, "server.js"))).digest("hex")
			: "missing"
		const driverSHA = createHash("sha256").update(await readFile(join(import.meta.dir, "opencode2-claude-hooks-qa.ts"))).digest("hex")
		const hookInputs = {
			userPromptSubmit: await readFile(userHookLog, "utf8").catch(() => ""),
			stop: await readFile(stopHookLog, "utf8").catch(() => ""),
			stopCallCount: await readFile(stopHookCount, "utf8").catch(() => ""),
			preToolUse: await readFile(preToolHookLog, "utf8").catch(() => ""),
			preToolTranscript: await readFile(preToolTranscriptLog, "utf8").catch(() => ""),
			postToolUse: await readFile(postToolHookLog, "utf8").catch(() => ""),
			postToolTranscript: await readFile(postToolTranscriptLog, "utf8").catch(() => ""),
			postToolUseFailure: await readFile(postFailureHookLog, "utf8").catch(() => ""),
			preCompact: await readFile(preCompactHookLog, "utf8").catch(() => ""),
			preCompactTranscript: await readFile(preCompactTranscriptLog, "utf8").catch(() => ""),
		}
		const result = {
			startedAt: new Date().toISOString(),
			productionSource: { gitHead, dirtyTree: Bun.spawnSync(["git", "status", "--short"], { cwd: ROOT, stdout: "pipe", stderr: "pipe" }).stdout.toString().trim().length > 0 },
			bundle: { serverPath: join(PLUGIN_DIR, "server.js"), expectedSHA: EXPECTED_SHA, actualSHA: finalSHA, driverSHA },
			cli: { path: CLI, version: cliVersion, exitCode: version.exitCode },
			isolation: { tempRoot, projectDirectory, home, xdgData, xdgConfig, xdgState, xdgCache, omoHome, claudeHome, claudePlugins, databasePath, projectOutsideRepository: !projectDirectory.startsWith(ROOT + sep) },
			registry,
			sessionID,
			blockedPromptError,
			blockedTranscript,
			successfulTranscript,
			hookInputs,
			requests,
			originFailures,
			requiredToolFailures,
			unexpectedPaths,
			checks,
			allChecksPassed: checks.length > 0 && checks.every((item) => item.passed),
			failure,
			cleanup: { opencodeExitCode: cleanupExitCode, mockStopped, tempRetained: true },
		}
		await writeFile(join(attempt, "runtime.json"), JSON.stringify(result, null, 2) + "\n")
		await writeFile(join(attempt, "requests.json"), JSON.stringify(requests, null, 2) + "\n")
		await writeFile(join(attempt, "hook-inputs.json"), JSON.stringify(hookInputs, null, 2) + "\n")
		if (host) {
			await writeFile(join(attempt, "server.stdout.log"), host.stdout)
			await writeFile(join(attempt, "server.stderr.log"), host.stderr)
		}
		await writeFile(join(attempt, "summary.txt"), `${failure ? `FAILURE\n${failure}\n` : ""}checks=${checks.filter((item) => item.passed).length}/${checks.length}\nserverSHA=${finalSHA}\ndriverSHA=${driverSHA}\ntempRoot=${tempRoot}\nserverExit=${cleanupExitCode}\nmockStopped=${mockStopped}\n`)
		process.stdout.write(JSON.stringify({ evidence: attempt, allChecksPassed: result.allChecksPassed, checks: result.checks, failure, cleanup: result.cleanup, serverSHA: finalSHA, driverSHA }, null, 2) + "\n")
	}
	if (failure) throw new Error(failure)
	if (checks.some((item) => !item.passed)) throw new Error("Claude hooks native QA checks failed")
}

main().catch((error) => {
	console.error(error)
	process.exitCode = 1
})
