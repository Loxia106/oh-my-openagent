/**
 * Isolated OpenCode 2.0.22 QA for native conversation advisory hooks.
 * Full mode requires explicit OPENCODE2_CLI and OPENCODE2_EXPECTED_SERVER_SHA256.
 * Set OPENCODE2_QA_PROVISION_ONLY=1 to provision and offline-smoke the pinned
 * comment-checker binary without starting OpenCode.
 */
import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { tmpdir } from "node:os"
import { Database } from "bun:sqlite"
import { OpenCode } from "@opencode/client"
import {
  COMMENT_CHECKER_RELEASE_VERSION,
  commentCheckerBinaryName,
  commentCheckerCacheDir,
  recordCachedCommentCheckerRelease,
  resolveCommentCheckerReleaseAsset,
} from "../packages/comment-checker-core/src"
import {
  cleanupArchive,
  downloadArchive,
  ensureCacheDir,
  ensureExecutable,
  extractTarGz,
  extractZipArchive,
} from "../packages/omo-opencode/src/shared/binary-downloader"

const ROOT = resolve(import.meta.dir, "..")
const EVIDENCE_ROOT = join(ROOT, ".omo", "evidence")
const EVIDENCE = resolve(process.env.OPENCODE2_QA_EVIDENCE_DIR ?? join(EVIDENCE_ROOT, "20260927-conversation-advisory"))
const PLUGIN_DIR = resolve(process.env.OPENCODE2_PLUGIN_DIR ?? join(ROOT, "dist", "opencode2"))
const CLI_INPUT = process.env.OPENCODE2_CLI?.trim() ?? ""
const CLI = CLI_INPUT ? resolve(CLI_INPUT) : ""
const EXPECTED_SERVER_SHA256 = process.env.OPENCODE2_EXPECTED_SERVER_SHA256 ?? ""
const PASSWORD = "conversation-advisory-local-qa-only"
const API_KEY = "conversation-advisory-fake-key-only"
const PROVIDER = "omoqa"
const MODEL = "qa-model"
const TIMEOUT_MS = 60_000
const REQUEST_KINDS = new Set(["primary", "compaction", "title", "generate"])
const CATEGORY_MARKER = "[Category+Skill Reminder]"
const TASK_RETRY_MARKER = "[task CALL FAILED - IMMEDIATE RETRY REQUIRED]"
const COMMENT_MARKER = "OMO_QA_COMMENT_FOUND"

type RequestRecord = {
  sessionID?: string
  kind?: string
  marker: string
  role: "parent" | "child" | "auxiliary" | "other"
  model: string
  sessionModel?: string
  sessionDirectory?: string
  parentID?: string | null
  agent?: string | null
  effectiveAgent?: string
  effectiveProvider?: string
  effectiveModel?: string
  systemText: string
  toolResultTexts: string[]
  toolNames: string[]
  originValid: boolean
  action: string
}

type ToolState = { name: string; status: string; text: string }
type SessionRun = { marker: string; sessionID: string; outcome: string | undefined; requests: RequestRecord[]; tools: ToolState[]; transcriptText: string }
type Scenario = { marker: string; step: number }
type Host = {
  phase: "enabled" | "disabled"
  port: number
  databasePath: string
  child: Bun.Subprocess
  client: ReturnType<typeof OpenCode.make>
  command: string[]
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
        timer = setTimeout(() => reject(new Error(label + " timed out after " + timeoutMs + "ms")), timeoutMs)
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
  assert(typeof port === "number", "Could not reserve isolated localhost port")
  return port
}

function selectedModel(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined
  const model = value as { providerID?: unknown; id?: unknown }
  return typeof model.providerID === "string" && typeof model.id === "string" ? model.providerID + "/" + model.id : undefined
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(stableJson).join(",") + "]"
  if (typeof value === "object" && value !== null) {
    const row = value as Record<string, unknown>
    return "{" + Object.keys(row).sort().map((key) => JSON.stringify(key) + ":" + stableJson(row[key])).join(",") + "}"
  }
  return JSON.stringify(value) ?? "undefined"
}

function contentText(value: unknown): string {
  if (typeof value === "string") return value
  if (!Array.isArray(value)) return ""
  return value.flatMap((part) => part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
    ? [(part as { text: string }).text] : []).join("\n")
}

function toolNames(body: Record<string, unknown>): string[] {
  if (!Array.isArray(body.tools)) return []
  return body.tools.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return []
    const row = entry as Record<string, unknown>
    const fn = row.function && typeof row.function === "object" ? row.function as Record<string, unknown> : row
    return typeof fn.name === "string" ? [fn.name] : []
  })
}

function findTool(body: Record<string, unknown>, name: string): string | undefined {
  return toolNames(body).find((candidate) => candidate.toLowerCase() === name.toLowerCase())
}

function toolResultTexts(body: Record<string, unknown>): string[] {
  if (!Array.isArray(body.messages)) return []
  return body.messages.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return []
    const row = entry as Record<string, unknown>
    return row.role === "tool" ? [contentText(row.content)] : []
  })
}

function toolStates(messages: unknown): ToolState[] {
  if (!Array.isArray(messages)) return []
  return messages.flatMap((message) => {
    if (!message || typeof message !== "object") return []
    const parts = (message as Record<string, unknown>).content
    if (!Array.isArray(parts)) return []
    return parts.flatMap((part) => {
      if (!part || typeof part !== "object") return []
      const row = part as Record<string, unknown>
      if (row.type !== "tool" || typeof row.name !== "string" || !row.state || typeof row.state !== "object") return []
      const state = row.state as Record<string, unknown>
      return [{ name: row.name, status: typeof state.status === "string" ? state.status : "unknown", text: contentText(state.output ?? state.error ?? state.content) }]
    })
  })
}

function sse(items: unknown[]): Response {
  return new Response(items.map((item) => "data: " + JSON.stringify(item) + "\n\n").join("") + "data: [DONE]\n\n", {
    headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive" },
  })
}

type ToolCall = { name: string; args: unknown }
function toolCallResponse(calls: ToolCall[], id: string, model: string, stream: boolean): Response {
  const created = Math.floor(Date.now() / 1000)
  const toolCalls = calls.map((call, index) => ({ index, id: id + "-tool-" + index, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args) } }))
  if (!stream) return Response.json({
    id: "chatcmpl-" + id, object: "chat.completion", created, model,
    choices: [{ index: 0, message: { role: "assistant", content: null, tool_calls: toolCalls }, finish_reason: "tool_calls" }],
    usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
  })
  return sse([
    { id: "chatcmpl-" + id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { role: "assistant", tool_calls: toolCalls }, finish_reason: null }] },
    { id: "chatcmpl-" + id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
  ])
}

function textResponse(value: string, id: string, model: string, stream: boolean): Response {
  const created = Math.floor(Date.now() / 1000)
  if (!stream) return Response.json({
    id: "chatcmpl-" + id, object: "chat.completion", created, model,
    choices: [{ index: 0, message: { role: "assistant", content: value }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  })
  return sse([
    { id: "chatcmpl-" + id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { role: "assistant", content: value }, finish_reason: null }] },
    { id: "chatcmpl-" + id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
  ])
}

function sessionInfo(databasePath: string, sessionID: string | undefined): { id: string; parentID: string | null; directory: string; model: string | null; agent: string | null } | undefined {
  if (!sessionID || !existsSync(databasePath)) return undefined
  try {
    const db = new Database(databasePath, { readonly: true, create: false })
    try { return db.query("SELECT id, parent_id AS parentID, directory, model, agent FROM session_v2 WHERE id = ?").get(sessionID) as ReturnType<typeof sessionInfo> }
    finally { db.close() }
  } catch { return undefined }
}

function nativeChildren(databasePath: string, parentID: string): Array<{ id: string; parentID: string; agent: string | null }> {
  if (!existsSync(databasePath)) return []
  try {
    const db = new Database(databasePath, { readonly: true, create: false })
    try { return db.query("SELECT id, parent_id AS parentID, agent FROM session_v2 WHERE parent_id = ? ORDER BY time_created").all(parentID) as Array<{ id: string; parentID: string; agent: string | null }> }
    finally { db.close() }
  } catch { return [] }
}

async function writeOmoConfig(project: string, disabledHooks: string[]): Promise<void> {
  const config = {
    telemetry: { enabled: false },
    "[opencode]": {
      telemetry: false,
      comment_checker: { custom_prompt: COMMENT_MARKER + ": {{comments}}" },
      disabled_hooks: disabledHooks,
      disabled_mcps: ["websearch", "context7", "grep_app", "lsp"],
      mcp_env_allowlist: [],
      claude_code: { mcp: false },
    },
  }
  await writeFile(join(project, ".omo", "omo.jsonc"), JSON.stringify(config, null, 2) + "\n")
}

async function provisionCommentChecker(xdgCache: string, directory: string): Promise<Record<string, unknown>> {
  const asset = resolveCommentCheckerReleaseAsset(process.platform, process.arch, COMMENT_CHECKER_RELEASE_VERSION)
  assert(asset, "No pinned comment-checker asset for " + process.platform + "-" + process.arch)
  const cacheDir = commentCheckerCacheDir({ platform: process.platform, env: { XDG_CACHE_HOME: xdgCache }, homedir: directory, cacheDirName: "oh-my-opencode" })
  ensureCacheDir(cacheDir)
  const binaryName = commentCheckerBinaryName(process.platform)
  const wrapperPath = join(cacheDir, binaryName)
  const realBinaryPath = join(cacheDir, binaryName + ".v" + COMMENT_CHECKER_RELEASE_VERSION + ".pinned")
  const archivePath = join(directory, asset.assetName)
  await downloadArchive(asset.url, archivePath)
  const archiveSha256 = createHash("sha256").update(await readFile(archivePath)).digest("hex")
  if (asset.ext === "tar.gz") await extractTarGz(archivePath, cacheDir)
  else await extractZipArchive(archivePath, cacheDir)
  cleanupArchive(archivePath)
  ensureExecutable(wrapperPath)
  assert(existsSync(wrapperPath), "Pinned checker extraction did not create " + wrapperPath)
  await copyFile(wrapperPath, realBinaryPath)
  await chmod(realBinaryPath, 0o755)
  const binarySha256 = createHash("sha256").update(await readFile(realBinaryPath)).digest("hex")
  const invocationLog = join(directory, "checker-invocations.log")
  const wrapperSource = "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$COMMENT_CHECKER_QA_LOG\"\nexec \"$COMMENT_CHECKER_QA_REAL\" \"$@\"\n"
  await writeFile(wrapperPath, wrapperSource, { mode: 0o755 })
  // Since v5.1 the plugin trusts the cached slot only beside a release marker (#8850); without it the
  // plugin downloads the pinned release over the wrapper and the invocation log stays empty.
  recordCachedCommentCheckerRelease(cacheDir)
  const smokeInput = JSON.stringify({
    session_id: "qa-provision-smoke", tool_name: "Write", transcript_path: "", cwd: directory,
    hook_event_name: "PostToolUse",
    tool_input: { file_path: "smoke.ts", content: "// obviously restates the implementation\nexport const answer = 42\n" },
  })
  const smoke = Bun.spawnSync([realBinaryPath, "check", "--prompt", COMMENT_MARKER + ": {{comments}}"], {
    cwd: directory, stdin: new TextEncoder().encode(smokeInput), stdout: "pipe", stderr: "pipe",
    env: { PATH: "/usr/bin:/bin", HOME: directory, TMPDIR: directory },
  })
  const smokeOutput = smoke.stderr.toString()
  assert(smoke.exitCode === 2 && smokeOutput.includes(COMMENT_MARKER), "Pinned comment-checker smoke failed (exit " + smoke.exitCode + "): " + smokeOutput)
  return {
    version: COMMENT_CHECKER_RELEASE_VERSION,
    repository: "code-yeongyu/go-claude-code-comment-checker",
    asset: asset.assetName,
    url: asset.url,
    archiveSha256,
    binaryPath: realBinaryPath,
    binarySha256,
    cacheWrapperPath: wrapperPath,
    invocationLog,
    smokeExitCode: smoke.exitCode,
    smokeMarkerObserved: smokeOutput.includes(COMMENT_MARKER),
    xdgCacheHome: xdgCache,
  }
}

async function listFiles(root: string): Promise<string[]> {
  let entries
  try { entries = await readdir(root, { withFileTypes: true }) } catch { return [] }
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(root, entry.name)
    if (entry.isDirectory()) return listFiles(path)
    return [path]
  }))
  return nested.flat()
}

async function stopHost(host: Host | undefined): Promise<{ phase: string; exitCode: number | null } | undefined> {
  if (!host) return undefined
  if (host.child.exitCode === null) {
    host.child.kill("SIGTERM")
    const ended = await Promise.race([host.child.exited.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5000))])
    if (!ended && host.child.exitCode === null) { host.child.kill("SIGKILL"); await host.child.exited }
  }
  await Promise.all([host.stdoutTask, host.stderrTask])
  return { phase: host.phase, exitCode: host.child.exitCode }
}

async function main(): Promise<void> {
  const provisionOnly = process.env.OPENCODE2_QA_PROVISION_ONLY === "1"
  if (!provisionOnly) {
    assert(CLI_INPUT && isAbsolute(CLI_INPUT) && existsSync(CLI), "Set OPENCODE2_CLI to an explicit absolute pinned OpenCode executable")
    assert(/^[a-f0-9]{64}$/i.test(EXPECTED_SERVER_SHA256), "Set OPENCODE2_EXPECTED_SERVER_SHA256 to the frozen server bundle SHA-256")
  }
  const relativeEvidence = relative(EVIDENCE_ROOT, EVIDENCE)
  assert(relativeEvidence !== "" && relativeEvidence !== ".." && !relativeEvidence.startsWith(".." + sep) && !isAbsolute(relativeEvidence) && !relativeEvidence.includes(sep),
    "Evidence directory must be one direct child of " + EVIDENCE_ROOT)
  await mkdir(EVIDENCE_ROOT, { recursive: true })
  const evidenceRoot = await realpath(EVIDENCE_ROOT)
  await mkdir(EVIDENCE, { recursive: true })
  const evidencePath = await realpath(EVIDENCE)
  assert(dirname(evidencePath) === evidenceRoot, "Evidence directory escaped repository evidence root")
  if (!provisionOnly) {
    assert(existsSync(join(PLUGIN_DIR, "server.js")), "Missing frozen server bundle " + join(PLUGIN_DIR, "server.js"))
    const actual = createHash("sha256").update(await readFile(join(PLUGIN_DIR, "server.js"))).digest("hex")
    assert(actual === EXPECTED_SERVER_SHA256, "Frozen server hash mismatch: " + actual)
  }

  const runDirectory = join(EVIDENCE, "attempt-" + Date.now())
  await mkdir(runDirectory, { recursive: true })
  const tempRoot = await realpath(await mkdtemp(join(tmpdir(), "omo-conversation-advisory-qa-")))
  const project = join(tempRoot, "project")
  const hostCwd = join(tempRoot, "server-cwd")
  const home = join(tempRoot, "home")
  const xdgData = join(tempRoot, "xdg-data")
  const xdgConfig = join(tempRoot, "xdg-config")
  const xdgState = join(tempRoot, "xdg-state")
  const xdgCacheEnabled = join(tempRoot, "xdg-cache-enabled")
  const xdgCacheDisabled = join(tempRoot, "xdg-cache-disabled")
  const omoHome = join(tempRoot, "omo-home")
  const claudeHome = join(tempRoot, "claude-home")
  const claudePlugins = join(tempRoot, "claude-plugins")
  const settingsPath = join(tempRoot, "claude-settings.json")
  const databases = { enabled: join(tempRoot, "enabled.db"), disabled: join(tempRoot, "disabled.db") }
  await Promise.all([project, hostCwd, home, xdgData, xdgConfig, xdgState, xdgCacheEnabled, xdgCacheDisabled, omoHome, claudeHome, claudePlugins,
    join(project, ".omo"), join(project, ".agents", "skills", "qa-visible"), join(project, "src")].map((path) => mkdir(path, { recursive: true })))
  const projectDirectory = await realpath(project)
  assert(!projectDirectory.startsWith(ROOT + sep), "Canonical QA project must be outside the checkout")
  await writeFile(settingsPath, "{}\n")
  await writeFile(join(projectDirectory, ".agents", "skills", "qa-visible", "SKILL.md"), "---\nname: qa-visible\ndescription: visible local fixture skill\n---\nUse this local fixture skill when relevant.\n")

  const checkerProvisionDir = join(tempRoot, "checker-provision")
  await mkdir(checkerProvisionDir, { recursive: true })
  const provision = await provisionCommentChecker(xdgCacheEnabled, checkerProvisionDir)
  const provisionRecord = {
    gitHead: Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: ROOT, stdout: "pipe", stderr: "pipe" }).stdout.toString().trim(),
    tempRoot, projectDirectory, projectOutsideRepository: true, provision,
  }
  await writeFile(join(runDirectory, "provision.json"), JSON.stringify(provisionRecord, null, 2) + "\n")
  if (provisionOnly) {
    process.stdout.write(JSON.stringify({ evidence: runDirectory, provision: provisionRecord }, null, 2) + "\n")
    return
  }

  const sourcePaths = [
    "packages/omo-opencode/src/v2/conversation-advisory-hooks.ts",
    "packages/omo-opencode/src/v2/conversation-advisory-hooks.test.ts",
    "packages/omo-opencode/src/v2/hooks.ts",
    "packages/delegate-core/src/retry-patterns.ts",
    "packages/omo-opencode/src/hooks/delegate-task-retry/hook.ts",
    "packages/omo-opencode/src/hooks/category-skill-reminder/formatter.ts",
    "packages/omo-opencode/src/hooks/comment-checker/cli.ts",
    "packages/comment-checker-core/src/release.ts",
  ]
  const sourceHashes = Object.fromEntries(await Promise.all(sourcePaths.map(async (path) => [path, createHash("sha256").update(await readFile(join(ROOT, path))).digest("hex")] as const)))
  const driverSha256 = createHash("sha256").update(await readFile(join(import.meta.dir, "opencode2-conversation-advisory-qa.ts"))).digest("hex")
  const gitHead = provisionRecord.gitHead
  const probeDirectory = join(tempRoot, "origin-probe")

  const readPath = join(projectDirectory, "src", "fixture.ts")
  const commentGatePath = join(projectDirectory, "src", "comment-gate.ts")
  const editPath = join(projectDirectory, "src", "edit-positive.ts")
  const patchPath = join(projectDirectory, "src", "patch-positive.ts")
  await writeFile(readPath, "export const fixture = 1\n")
  await writeFile(commentGatePath, "// unchanged useful note\nexport const value = 1\n")
  await writeFile(editPath, "export const value = 1\n")
  await writeFile(patchPath, "export const value = 1\n")

  const sessions = new Map<string, Scenario>()
  const parentIDs = new Set<string>()
  const requests: RequestRecord[] = []
  const originFailures: unknown[] = []
  const routeFailures: unknown[] = []
  const scenarios: Record<string, SessionRun> = {}
  const catalog: Record<string, unknown> = {}
  const defaultModels: Record<string, string | undefined> = {}
  const disabledConfig: Record<string, string[]> = {}
  const checkerInvocationLog = String(provision.invocationLog)
  const checkerFindings: Record<string, boolean> = {}
  let checkerCalls: string[] = []
  let currentHost: Host | undefined
  const hosts: Host[] = []
  const cleanup: Array<{ phase: string; exitCode: number | null }> = []
  const checks: Record<string, boolean> = {}
  let mockStopped = false
  let failure: string | undefined
  let version = ""

  const mock = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      if (url.pathname.endsWith("/models")) return Response.json({ data: [{ id: MODEL, object: "model", created: 0, owned_by: "conversation-advisory-qa" }] })
      if (!url.pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 })
      const body = await request.json() as Record<string, unknown>
      const model = typeof body.model === "string" ? body.model : ""
      const sessionID = request.headers.get("x-omo-qa-session-id") ?? undefined
      const kind = request.headers.get("x-omo-qa-kind") ?? undefined
      const effectiveAgent = request.headers.get("x-omo-qa-agent") ?? undefined
      const effectiveProvider = request.headers.get("x-omo-qa-provider") ?? undefined
      const effectiveModel = request.headers.get("x-omo-qa-model") ?? undefined
      const info = sessionInfo(currentHost?.databasePath ?? "", sessionID)
      let sessionModel: string | undefined
      if (info?.model) try { sessionModel = selectedModel(JSON.parse(info.model)) } catch { sessionModel = undefined }
      const scenario = sessionID ? sessions.get(sessionID) : undefined
      const child = info?.parentID != null && parentIDs.has(info.parentID)
      const role: RequestRecord["role"] = child ? "child" : kind === "primary" && info?.parentID == null && scenario ? "parent" : kind === "primary" ? "other" : info ? "auxiliary" : "other"
      const expectedRoleAgent = kind === "primary" && role === "parent" ? "sisyphus"
        : kind === "primary" && role === "child" ? "explore"
        : undefined
      const roleAgentMatches = expectedRoleAgent === undefined || effectiveAgent?.toLowerCase() === expectedRoleAgent
      const messages = Array.isArray(body.messages) ? body.messages as Array<Record<string, unknown>> : []
      const systemText = messages.filter((message) => message.role === "system").map((message) => contentText(message.content)).join("\n")
      const record: RequestRecord = {
        ...(sessionID ? { sessionID } : {}), ...(kind ? { kind } : {}), marker: scenario?.marker ?? "", role, model,
        ...(sessionModel ? { sessionModel } : {}), ...(info ? { sessionDirectory: info.directory, parentID: info.parentID, agent: info.agent } : {}),
        ...(effectiveAgent ? { effectiveAgent } : {}), ...(effectiveProvider ? { effectiveProvider } : {}), ...(effectiveModel ? { effectiveModel } : {}),
        systemText, toolResultTexts: toolResultTexts(body), toolNames: toolNames(body),
        originValid: Boolean(sessionID && kind && REQUEST_KINDS.has(kind) && info && info.directory === projectDirectory
          && sessionModel === PROVIDER + "/" + MODEL && model === MODEL
          && effectiveAgent && effectiveProvider === PROVIDER && effectiveModel === MODEL && roleAgentMatches),
        action: "completion",
      }
      requests.push(record)
      const id = "conv-" + requests.length
      if (!record.originValid) {
        originFailures.push({ sessionID, kind, directory: info?.directory, sessionModel, model, role, effectiveAgent, effectiveProvider, effectiveModel, expectedRoleAgent })
        return Response.json({ error: { message: "Rejected nonlocal QA request" } }, { status: 400 })
      }
      if (role === "child") { record.action = "child-completion"; return textResponse("CONVERSATION_ADVISORY_CHILD_OK", id, model, body.stream === true) }
      if (role !== "parent" || kind !== "primary" || !scenario) { record.action = "auxiliary-completion"; return textResponse("CONVERSATION_ADVISORY_AUX_OK", id, model, body.stream === true) }
      const step = scenario.step++
      const toolCall = (name: string, args: unknown) => {
        const actual = findTool(body, name)
        if (!actual) { routeFailures.push({ marker: scenario.marker, sessionID, expected: name, available: record.toolNames, step }); return textResponse("EXPECTED_TOOL_MISSING", id, model, body.stream === true) }
        record.action = "tool:" + actual + ":step-" + step
        return toolCallResponse([{ name: actual, args }], id, model, body.stream === true)
      }
      const read = () => toolCall("read", { path: readPath })
      if (scenario.marker === "TASK_RETRY" && step === 0) return toolCall("task", {
        subagent_type: "missing-agent", description: "intentional native missing-agent failure", prompt: "This must fail without making a child.", load_skills: [], run_in_background: false,
      })
      if (scenario.marker === "CATEGORY_VISIBLE" && step < 3) return read()
      if (scenario.marker === "CATEGORY_SUPPRESS" && step === 0) {
        const readName = findTool(body, "read")
        const taskName = findTool(body, "task")
        if (!readName || !taskName) { routeFailures.push({ marker: scenario.marker, sessionID, available: record.toolNames }); return textResponse("CATEGORY_TOOLS_MISSING", id, model, body.stream === true) }
        record.action = "tool:readx3+task"
        return toolCallResponse([
          { name: readName, args: { path: readPath } },
          { name: readName, args: { path: readPath } },
          { name: readName, args: { path: readPath } },
          { name: taskName, args: { subagent_type: "explore", description: "advisory suppression QA", prompt: "Return the fixed child marker.", load_skills: [], run_in_background: false } },
        ], id, model, body.stream === true)
      }
      if (scenario.marker === "CATEGORY_DISABLED" && step < 3) return read()
      if (scenario.marker === "COMMENT_GATE" && step === 0) return toolCall("edit", {
        path: commentGatePath,
        oldString: "// unchanged useful note\nexport const value = 1\n",
        newString: "// unchanged useful note\nexport const value = 2\n",
      })
      if (scenario.marker === "COMMENT_GATE" && step === 1) return toolCall("edit", { path: commentGatePath, oldString: "export const value = 2\n", newString: "export const value = 3\n" })
      if (scenario.marker === "COMMENT_WRITE" && step === 0) return toolCall("write", {
        path: join(projectDirectory, "src", "write-positive.ts"), content: "// obviously repeats the next line\nexport const value = 1\n",
      })
      if (scenario.marker === "COMMENT_EDIT" && step === 0) return toolCall("edit", {
        path: editPath, oldString: "export const value = 1\n", newString: "// obviously repeats the next line\nexport const value = 2\n",
      })
      if (scenario.marker === "COMMENT_PATCH" && step === 0) {
        const patchText = "*** Begin Patch\n*** Update File: " + relative(projectDirectory, patchPath) + "\n@@\n-export const value = 1\n+// obviously repeats the next line\n+export const value = 2\n*** End Patch"
        return toolCall("apply_patch", { patchText })
      }
      if (scenario.marker === "TASK_DISABLED" && step === 0) return toolCall("task", {
        subagent_type: "missing-agent", description: "disabled guidance", prompt: "This should fail.", load_skills: [], run_in_background: false,
      })
      if (scenario.marker === "COMMENT_DISABLED" && step === 0) return toolCall("write", {
        path: join(projectDirectory, "src", "disabled-comment.ts"), content: "// obviously repeats the next line\nexport const value = 1\n",
      })
      record.action = "text-completion"
      return textResponse("CONVERSATION_ADVISORY_QA_OK", id, model, body.stream === true)
    },
  })

  const mockOrigin = "http://127.0.0.1:" + mock.port
  await mkdir(probeDirectory, { recursive: true })
  await writeFile(join(probeDirectory, "index.js"), `export default { id: "omo-conversation-advisory-origin", setup: async ({ session }) => { const model = await session.hook("model.request", (event) => { if (event.model.providerID !== ${JSON.stringify(PROVIDER)} || event.model.id !== ${JSON.stringify(MODEL)}) throw new Error("QA blocked nonlocal provider/model request"); event.headers["x-omo-qa-agent"] = String(event.agent); event.headers["x-omo-qa-provider"] = String(event.model.providerID); event.headers["x-omo-qa-model"] = String(event.model.id); }); const http = await session.hook("http.request", (event) => { if (new URL(event.request.url).origin !== ${JSON.stringify(mockOrigin)}) throw new Error("QA blocked nonlocal HTTP destination"); const headers = new Headers(event.request.headers); headers.set("x-omo-qa-session-id", event.sessionID); headers.set("x-omo-qa-kind", event.kind); event.request = new Request(event.request, { headers }); }); return async () => { await Promise.all([model.dispose(), http.dispose()]); }; } }\n`)

  const projectConfig = {
    $schema: "https://opencode.ai/config.json",
    plugins: [probeDirectory, PLUGIN_DIR],
    enabled_providers: [PROVIDER],
    model: PROVIDER + "/" + MODEL,
    default_agent: "sisyphus",
    provider: {
      [PROVIDER]: {
        name: "Local conversation advisory QA mock", npm: "@ai-sdk/openai-compatible",
        options: { baseURL: "http://127.0.0.1:" + mock.port + "/v1", apiKey: API_KEY },
        models: { [MODEL]: { name: "Local conversation advisory QA model", tool_call: true, limit: { context: 200_000, output: 8_192 } } },
      },
    },
    mcp: {}, telemetry: false,
    permission: { read: "allow", edit: "allow", grep: "allow", task: "allow", subagent: "allow" },
  }
  await writeFile(join(projectDirectory, "opencode.json"), JSON.stringify(projectConfig, null, 2) + "\n")
  await writeFile(join(runDirectory, "opencode-config-redacted.json"), JSON.stringify({
    ...projectConfig,
    provider: { [PROVIDER]: { ...projectConfig.provider[PROVIDER], options: { baseURL: "http://127.0.0.1:" + mock.port + "/v1", apiKey: "[redacted-fake-key]" } } },
  }, null, 2) + "\n")

  const envBase = {
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    TMPDIR: tempRoot, HOME: home, XDG_DATA_HOME: xdgData, XDG_CONFIG_HOME: xdgConfig, XDG_STATE_HOME: xdgState,
    XDG_CACHE_HOME: xdgCacheEnabled, OMO_HOME: omoHome, CLAUDE_CONFIG_DIR: claudeHome, CLAUDE_PLUGINS_HOME: claudePlugins,
    CLAUDE_SETTINGS_PATH: settingsPath, OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_TELEMETRY_DISABLED: "1",
    OPENCODE_SERVER_PASSWORD: PASSWORD, OPENCODE_PASSWORD: PASSWORD,
    COMMENT_CHECKER_QA_REAL: String(provision.binaryPath), COMMENT_CHECKER_QA_LOG: String(provision.invocationLog),
  }
  const hostDatabase = (phase: "enabled" | "disabled") => databases[phase]
  const startHost = async (phase: "enabled" | "disabled"): Promise<Host> => {
    const port = reservePort()
    const env = {
      ...envBase,
      XDG_CACHE_HOME: phase === "enabled" ? xdgCacheEnabled : xdgCacheDisabled,
      COMMENT_CHECKER_QA_REAL: phase === "enabled" ? String(provision.binaryPath) : "",
      COMMENT_CHECKER_QA_LOG: phase === "enabled" ? String(provision.invocationLog) : join(tempRoot, "disabled-checker-invocations.log"),
      OPENCODE_DB: hostDatabase(phase),
    }
    const command = [CLI, "--print-logs", "--log-level", "debug", "serve", "--hostname", "127.0.0.1", "--port", String(port)]
    const child = Bun.spawn(command, { cwd: hostCwd, env, stdout: "pipe", stderr: "pipe" })
    const password = Buffer.from("opencode:" + PASSWORD).toString("base64")
    const host: Host = {
      phase, port, databasePath: hostDatabase(phase), child, command,
      client: OpenCode.make({ baseUrl: "http://127.0.0.1:" + port, headers: { Authorization: "Basic " + password, "x-opencode-directory": projectDirectory } }),
      stdout: "", stderr: "", stdoutTask: Promise.resolve(), stderrTask: Promise.resolve(),
    }
    host.stdoutTask = new Response(child.stdout as ReadableStream<Uint8Array>).text().then((value) => { host.stdout = value })
    host.stderrTask = new Response(child.stderr as ReadableStream<Uint8Array>).text().then((value) => { host.stderr = value })
    hosts.push(host)
    currentHost = host
    const versionResult = Bun.spawnSync([CLI, "--version"], { cwd: hostCwd, env, stdout: "pipe", stderr: "pipe" })
    version = versionResult.stdout.toString().trim()
    assert(versionResult.exitCode === 0 && version.includes("2.0.22"), "Expected OpenCode 2.0.22, got " + version)
    const readyUntil = Date.now() + 20_000
    let ready = false
    while (Date.now() < readyUntil && !ready) {
      if (child.exitCode !== null) throw new Error(phase + " host exited early with " + child.exitCode)
      try { await host.client.server.info(); ready = true } catch { await Bun.sleep(100) }
    }
    assert(ready, phase + " native host readiness timed out")
    const activationUntil = Date.now() + 35_000
    let active = false
    let pluginStates: unknown[] = []
    let models: string[] = []
    let providers: string[] = []
    let mcpNames: string[] = []
    while (Date.now() < activationUntil && !active) {
      const [plugins, agents] = await Promise.all([host.client.plugin.list(), host.client.agent.list()])
      pluginStates = plugins.data.map(({ id, state }) => ({ id, state }))
      const failed = plugins.data.find((plugin) => plugin.state.status === "failed")
      assert(!failed, phase + " plugin failed: " + JSON.stringify(failed))
      const omo = plugins.data.some((plugin) => plugin.id === "oh-my-openagent" && plugin.state.status === "active")
      const origin = plugins.data.some((plugin) => plugin.id === "omo-conversation-advisory-origin" && plugin.state.status === "active")
      if (omo && origin && agents.data.some((agent) => agent.id === "sisyphus")) {
        const [modelList, providerList, mcpList] = await Promise.all([host.client.model.list(), host.client.provider.list(), host.client.mcp.list()])
        models = modelList.data.map((entry) => entry.providerID + "/" + entry.id).sort()
        providers = providerList.data.map((entry) => entry.id).sort()
        mcpNames = mcpList.data.map((entry) => entry.name)
        active = true
      }
      if (!active) await Bun.sleep(150)
    }
    assert(active, phase + " OMO/plugin origin activation timed out: " + JSON.stringify(pluginStates))
    assert(stableJson(models) === stableJson([PROVIDER + "/" + MODEL]), phase + " catalog is not local-only: " + JSON.stringify(models))
    assert(stableJson(providers) === stableJson([PROVIDER]), phase + " providers are not local-only: " + JSON.stringify(providers))
    assert(mcpNames.length === 0, phase + " unexpectedly has MCPs: " + JSON.stringify(mcpNames))
    const modelDefault = await host.client.model.default()
    const defaultModel = selectedModel(modelDefault.data)
    assert(defaultModel === PROVIDER + "/" + MODEL, phase + " default model is not local-only")
    catalog[phase] = { models, providers, mcpNames, pluginStates }
    defaultModels[phase] = defaultModel
    const omoConfig = JSON.parse(await readFile(join(projectDirectory, ".omo", "omo.jsonc"), "utf8")) as { "[opencode]"?: { disabled_hooks?: string[] } }
    disabledConfig[phase] = omoConfig["[opencode]"]?.disabled_hooks ?? []
    return host
  }

  const closeHost = async (host: Host) => {
    const stopped = await stopHost(host)
    if (stopped) cleanup.push(stopped)
    if (currentHost === host) currentHost = undefined
  }

  const runSession = async (host: Host, marker: string, instruction: string): Promise<SessionRun> => {
    const created = await host.client.session.create({ title: "Conversation advisory " + marker, location: { directory: projectDirectory } })
    assert(created.location.directory === projectDirectory, marker + " session escaped isolated project")
    await host.client.session.switchModel({ sessionID: created.id, model: { providerID: PROVIDER, id: MODEL } })
    const selected = await host.client.session.get({ sessionID: created.id })
    assert(selected.location.directory === projectDirectory && selected.model?.providerID === PROVIDER && selected.model.id === MODEL, marker + " session scope/model mismatch")
    if (selected.parentID == null) parentIDs.add(created.id)
    sessions.set(created.id, { marker, step: 0 })
    await within(marker + " prompt", host.client.session.prompt({ sessionID: created.id, text: instruction + " Fixture marker: " + marker }))
    await within(marker + " wait", host.client.session.wait({ sessionID: created.id }))
    const finished = await host.client.session.get({ sessionID: created.id })
    const transcript = await host.client.message.list({ sessionID: created.id })
    const runRequests = requests.filter((entry) => entry.sessionID === created.id)
    const primaryRequest = [...runRequests].reverse().find((entry) => entry.kind === "primary")
    assert(primaryRequest?.systemText.includes('Your designated identity for this session is "Sisyphus".') === true,
      marker + " native prompt did not use configured default agent identity")
    return {
      marker, sessionID: created.id, outcome: finished.outcome,
      requests: runRequests,
      tools: toolStates(transcript.data), transcriptText: JSON.stringify(transcript.data),
    }
  }

  let passed = false
  try {
    const bundleHash = createHash("sha256").update(await readFile(join(PLUGIN_DIR, "server.js"))).digest("hex")
    assert(bundleHash === EXPECTED_SERVER_SHA256, "Server bundle no longer matches the frozen hash")
    await writeOmoConfig(projectDirectory, [])
    const active = await startHost("enabled")
    const taskRetry = await runSession(active, "TASK_RETRY", "Call the OMO task tool once using a nonexistent agent, then stop.")
    const taskState = taskRetry.tools.find((entry) => entry.name === "task")
    const taskGuidanceObserved = taskRetry.requests.some((entry) => entry.toolResultTexts.some((value) => value.includes(TASK_RETRY_MARKER)))
    const visibleCategory = await runSession(active, "CATEGORY_VISIBLE", "Read the provided fixture three times and then finish.")
    const visibleCategoryRequest = [...visibleCategory.requests].reverse().find((entry) => entry.kind === "primary" && entry.action === "text-completion")
    const suppressedCategory = await runSession(active, "CATEGORY_SUPPRESS", "Read three times and delegate a final verification task to explore.")
    const suppressedCategoryRequest = [...suppressedCategory.requests].reverse().find((entry) => entry.kind === "primary" && entry.action === "text-completion")
    const commentGate = await runSession(active, "COMMENT_GATE", "Preserve the existing comment while changing code, then change code without adding a comment.")
    const noCommentCheckerInvocations = (await readFile(String(provision.invocationLog), "utf8").catch(() => "")).trim().split(/\r?\n/).filter(Boolean).length
    const commentWrite = await runSession(active, "COMMENT_WRITE", "Write the comment-containing fixture file, then finish.")
    const commentEdit = await runSession(active, "COMMENT_EDIT", "Add the comment to the existing fixture with edit, then finish.")
    const commentPatch = await runSession(active, "COMMENT_PATCH", "Add the comment using the supplied patch, then finish.")
    const enabledRuns = [taskRetry, visibleCategory, suppressedCategory, commentGate, commentWrite, commentEdit, commentPatch]
    for (const run of enabledRuns) scenarios[run.marker] = run
    checkerCalls = (await readFile(String(provision.invocationLog), "utf8").catch(() => "")).trim().split(/\r?\n/).filter(Boolean)
    for (const [name, run] of [["write", commentWrite], ["edit", commentEdit], ["patch", commentPatch]] as const) {
      const finalRequest = [...run.requests].reverse().find((entry) => entry.kind === "primary" && entry.action === "text-completion")
      checkerFindings[name] = Boolean(finalRequest?.toolResultTexts.some((value) => value.includes(COMMENT_MARKER)))
    }
    const children = nativeChildren(active.databasePath, suppressedCategory.sessionID)
    const childChecks = await Promise.all(children.map(async (row) => {
      const child = await active.client.session.get({ sessionID: row.id })
      const messages = await active.client.message.list({ sessionID: row.id })
      return { row, outcome: child.outcome, parentID: child.parentID, model: selectedModel(child.model), transcript: JSON.stringify(messages.data) }
    }))
    const childSucceeded = childChecks.length === 1 && childChecks[0]?.row.agent === "explore"
      && childChecks[0]?.parentID === suppressedCategory.sessionID && childChecks[0]?.outcome === "succeeded"
      && childChecks[0]?.model === PROVIDER + "/" + MODEL && childChecks[0]?.transcript.includes("CONVERSATION_ADVISORY_CHILD_OK")
    const closeOutput = async () => closeHost(active)
    await closeOutput()

    await writeOmoConfig(projectDirectory, ["delegate-task-retry", "category-skill-reminder", "comment-checker"])
    const disabled = await startHost("disabled")
    const disabledTask = await runSession(disabled, "TASK_DISABLED", "Call task once with a nonexistent agent, then stop.")
    const disabledCategory = await runSession(disabled, "CATEGORY_DISABLED", "Read the fixture three times and finish.")
    const disabledComment = await runSession(disabled, "COMMENT_DISABLED", "Write the comment-containing fixture and finish.")
    for (const run of [disabledTask, disabledCategory, disabledComment]) scenarios[run.marker] = run
    const disabledTaskGuidance = disabledTask.requests.some((entry) => entry.toolResultTexts.some((value) => value.includes(TASK_RETRY_MARKER)))
    const disabledCategoryRequest = [...disabledCategory.requests].reverse().find((entry) => entry.kind === "primary" && entry.action === "text-completion")
    const disabledCommentRequest = [...disabledComment.requests].reverse().find((entry) => entry.kind === "primary" && entry.action === "text-completion")
    const disabledCacheFiles = await listFiles(join(xdgCacheDisabled, "oh-my-opencode"))
    const disabledInvocation = await readFile(join(tempRoot, "disabled-checker-invocations.log"), "utf8").catch(() => "")
    await closeHost(disabled)
    mock.stop(true)
    mockStopped = true

    const allScenarioRuns = Object.values(scenarios)
    checks.pinnedHostAndBundle = version.includes("2.0.22") && bundleHash === EXPECTED_SERVER_SHA256
    checks.localOnlyProviderCatalogAndNoMcp = Object.keys(catalog).length === 2 && Object.values(catalog).every((value) => {
      const row = value as { models: string[]; providers: string[]; mcpNames: string[] }
      return stableJson(row.models) === stableJson([PROVIDER + "/" + MODEL]) && stableJson(row.providers) === stableJson([PROVIDER]) && row.mcpNames.length === 0
    })
    checks.defaultAgentAndModelPreflight = Object.values(defaultModels).length === 2 && Object.values(defaultModels).every((value) => value === PROVIDER + "/" + MODEL)
      && allScenarioRuns.every((run) => run.outcome === "succeeded")
    checks.taskFailureVisibleWithGuidance = taskRetry.outcome === "succeeded" && taskState?.status === "error" && taskGuidanceObserved
      && taskRetry.tools.filter((entry) => entry.name === "task").length === 1
      && !taskRetry.transcriptText.includes("CONVERSATION_ADVISORY_CHILD_OK")
    checks.categoryReminderAfterThreeWorkCalls = visibleCategory.outcome === "succeeded"
      && visibleCategory.tools.filter((entry) => entry.name === "read" && entry.status === "completed").length === 3
      && visibleCategoryRequest?.systemText.includes(CATEGORY_MARKER) === true
      && visibleCategoryRequest.systemText.includes("qa-visible")
    checks.categoryReminderSuppressedAfterSuccessfulDelegation = suppressedCategory.outcome === "succeeded"
      && suppressedCategory.tools.filter((entry) => entry.name === "read" && entry.status === "completed").length === 3
      && suppressedCategory.tools.some((entry) => entry.name === "task" && entry.status === "completed")
      && suppressedCategoryRequest?.systemText.includes(CATEGORY_MARKER) === false
      && childSucceeded
    checks.commentCheckerSkipsUnchangedAndNoCommentEdits = commentGate.outcome === "succeeded" && noCommentCheckerInvocations === 0
      && !commentGate.requests.some((entry) => entry.toolResultTexts.some((value) => value.includes(COMMENT_MARKER)))
    checks.commentCheckerFeedbackForWriteEditPatch = commentWrite.outcome === "succeeded" && commentEdit.outcome === "succeeded" && commentPatch.outcome === "succeeded"
      && checkerFindings.write === true && checkerFindings.edit === true && checkerFindings.patch === true && checkerCalls.length === 3
    checks.disabledHookGatesPreventBehaviorAndResolution = disabledTask.outcome === "succeeded" && disabledCategory.outcome === "succeeded" && disabledComment.outcome === "succeeded"
      && disabledTask.tools.some((entry) => entry.name === "task" && entry.status === "error")
      && !disabledTaskGuidance && disabledCategoryRequest?.systemText.includes(CATEGORY_MARKER) === false
      && !disabledCommentRequest?.toolResultTexts.some((value) => value.includes(COMMENT_MARKER))
      && disabledCacheFiles.length === 0 && disabledInvocation.trim() === ""
    checks.realPinnedCheckerProvisionedAndInvoked = provision.version === COMMENT_CHECKER_RELEASE_VERSION
      && typeof provision.archiveSha256 === "string" && typeof provision.binarySha256 === "string" && checkerCalls.length === 3
    checks.allRequestsUseValidLocalSessionOrigins = requests.length > 0 && requests.every((entry) => entry.originValid)
      && originFailures.length === 0 && routeFailures.length === 0
    const primaryParentRequests = requests.filter((entry) => entry.kind === "primary" && entry.role === "parent")
    const primaryChildRequests = requests.filter((entry) => entry.kind === "primary" && entry.role === "child")
    checks.effectiveNativeParentAndChildAgentsVerified = primaryParentRequests.length > 0 && primaryChildRequests.length > 0
      && primaryParentRequests.every((entry) => entry.effectiveAgent?.toLowerCase() === "sisyphus")
      && primaryChildRequests.every((entry) => entry.effectiveAgent?.toLowerCase() === "explore")
    checks.ownedProcessesStoppedAndDatabasesRetained = cleanup.length === hosts.length && cleanup.every((entry) => entry.exitCode !== null)
      && mockStopped && existsSync(databases.enabled) && existsSync(databases.disabled) && existsSync(tempRoot)
    passed = Object.values(checks).every(Boolean)
    Object.assign(scenarios, {
      nativeChildren: childChecks,
      checkerFindings,
      checkerCalls,
      noCommentCheckerInvocations,
      disabledCheckerCacheFiles: disabledCacheFiles,
      disabledCheckerInvocation: disabledInvocation,
    })
    assert(passed, "One or more conversation advisory checks failed: " + JSON.stringify(checks))
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error)
  } finally {
    for (const host of hosts) {
      if (!cleanup.some((entry) => entry.phase === host.phase)) {
        const stopped = await stopHost(host)
        if (stopped) cleanup.push(stopped)
      }
    }
    if (!mockStopped) { mock.stop(true); mockStopped = true }
    const results = {
      gitHead, version, cli: CLI, pluginDirectory: PLUGIN_DIR, expectedServerSha256: EXPECTED_SERVER_SHA256,
      serverBundleSha256: existsSync(join(PLUGIN_DIR, "server.js")) ? createHash("sha256").update(await readFile(join(PLUGIN_DIR, "server.js"))).digest("hex") : undefined,
      driverSha256, sourceHashes, tempRoot, tempRootRetained: existsSync(tempRoot), projectDirectory,
      projectOutsideRepository: !projectDirectory.startsWith(ROOT + sep),
      policy: "Only enabled local mock provider/model; every session pinned; MCP catalog empty; fake credentials; isolated HOME/XDG/OMO/Claude/DB paths.",
      envKeys: ["PATH", "TMPDIR", "HOME", "XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "OPENCODE_DB", "OMO_HOME", "CLAUDE_CONFIG_DIR", "CLAUDE_PLUGINS_HOME", "CLAUDE_SETTINGS_PATH", "OPENCODE_DISABLE_MODELS_FETCH", "OPENCODE_TELEMETRY_DISABLED", "OPENCODE_SERVER_PASSWORD", "OPENCODE_PASSWORD", "COMMENT_CHECKER_QA_REAL", "COMMENT_CHECKER_QA_LOG"],
      provision, catalog, defaultModels, disabledConfig, requests, originFailures, routeFailures, scenarios, checkerFindings, checkerCalls,
      cleanup, cleanupAllStopped: cleanup.length === hosts.length && cleanup.every((entry) => entry.exitCode !== null), mockStopped,
      databases, cacheDirectories: { enabled: xdgCacheEnabled, disabled: xdgCacheDisabled }, checks, passed, failure,
      serverCommands: Object.fromEntries(hosts.map((host) => [host.phase, host.command])),
    }
    await Promise.all([
      writeFile(join(runDirectory, "runtime.json"), JSON.stringify(results, null, 2) + "\n"),
      writeFile(join(runDirectory, "provider-requests.json"), JSON.stringify(requests, null, 2) + "\n"),
      ...hosts.map((host) => writeFile(join(runDirectory, host.phase + "-server.log"), (host.stdout + "\n--- stderr ---\n" + host.stderr)
        .replaceAll(PASSWORD, "[redacted-test-password]").replaceAll(API_KEY, "[redacted-test-key]"))),
    ])
  }
  if (failure) throw new Error("Conversation advisory QA failed; inspect " + join(runDirectory, "runtime.json") + ": " + failure)
  process.stdout.write(JSON.stringify({ evidence: runDirectory, passed, checks, cleanup }, null, 2) + "\n")
}

await main()
