/**
 * Isolated OpenCode 2.0 Team/Hyperplan pipeline QA against a frozen native bundle.
 * Run after the integrated bundle is frozen:
 *   OPENCODE2_CLI=/absolute/path/to/opencode \
 *   OPENCODE2_EXPECTED_SERVER_SHA256=<64-hex-sha256> \
 *   bun script/opencode2-team-pipeline-qa.ts
 *
 * This uses one local fake OpenAI-compatible provider and retains its isolated DB,
 * team state, logs, and checks under the selected evidence directory.
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
const EVIDENCE = resolve(process.env.OPENCODE2_QA_EVIDENCE_DIR ?? join(EVIDENCE_ROOT, "20260927-team-pipeline"))
const PLUGIN_DIR = resolve(process.env.OPENCODE2_PLUGIN_DIR ?? join(ROOT, "dist", "opencode2"))
const CLI_INPUT = process.env.OPENCODE2_CLI?.trim() ?? ""
const CLI = CLI_INPUT ? resolve(CLI_INPUT) : ""
const EXPECTED_SERVER_SHA256 = process.env.OPENCODE2_EXPECTED_SERVER_SHA256 ?? ""
const PROVIDER = "omoqa"
const MODEL = "team-pipeline-qa"
const API_KEY = "team-pipeline-fake-api-key-only"
const PASSWORD = "team-pipeline-local-qa-only"
const PROBE_ID = "omo-native-team-pipeline-origin-probe"
const ALLOWED_AGENTS = ["atlas", "sisyphus-junior"] as const
const CATEGORY_NAMES = ["unspecified-low", "unspecified-high", "ultrabrain", "artistry", "deep-low"] as const
const CHILD_ROLES = ["skeptic", "validator", "architect", "creative", "researcher"] as const
const MAILBOX_BODY = "OMO_TEAM_QA_MAILBOX_TO_ARCHITECT"
const CHILD_REPLY = "OMO_TEAM_QA_ARCHITECT_REPLY"
const TIMEOUT_MS = 90_000

type Check = { name: string; passed: boolean; detail?: unknown }
type DbSession = { id: string; parentID: string | null; directory: string; agent: string | null; title: string | null; model: string | null }
type CapturedRequest = {
  sessionID?: string
  agent?: string
  kind?: string
  provider?: string
  model: string
  parentID?: string | null
  directory?: string
  userText: string
  conversationText: string
  systemText: string
  tools: string[]
  originErrors: string[]
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
type ToolCall = { name: string; args: unknown }

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
function basicAuth(): string {
  return "Basic " + Buffer.from("opencode:" + PASSWORD).toString("base64")
}
function reservePort(): number {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("reserved") })
  const port = server.port
  server.stop(true)
  assert(typeof port === "number", "Could not reserve an isolated localhost port")
  return port
}
async function within<T>(label: string, promise: Promise<T>, timeoutMs = TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(label + " timed out after " + timeoutMs + "ms")), timeoutMs) }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
function asText(value: unknown): string {
  if (typeof value === "string") return value
  if (Array.isArray(value)) return value.map(asText).filter(Boolean).join("\n")
  if (isRecord(value)) {
    if (typeof value.text === "string") return value.text
    if (typeof value.content === "string") return value.content
    if (typeof value.output === "string") return value.output
  }
  return ""
}
function messagesOf(body: Record<string, unknown>): Array<Record<string, unknown>> {
  return Array.isArray(body.messages) ? body.messages.filter(isRecord) : []
}
function latestUserText(body: Record<string, unknown>): string {
  const message = messagesOf(body).findLast((entry) => entry.role === "user")
  return message ? asText(message.content) : ""
}
function allMessageText(body: Record<string, unknown>): string {
  return messagesOf(body).map((entry) => asText(entry.content)).join("\n")
}
function systemText(body: Record<string, unknown>): string {
  return messagesOf(body).filter((entry) => entry.role === "system" || entry.role === "developer").map((entry) => asText(entry.content)).join("\n")
}
function toolNames(body: Record<string, unknown>): string[] {
  if (!Array.isArray(body.tools)) return []
  return body.tools.flatMap((entry) => {
    if (!isRecord(entry)) return []
    const fn = isRecord(entry.function) ? entry.function : undefined
    const name = typeof entry.name === "string" ? entry.name : typeof fn?.name === "string" ? fn.name : undefined
    return name ? [name] : []
  })
}
function stringsIn(value: unknown): string[] {
  if (typeof value === "string") return [value]
  if (Array.isArray(value)) return value.flatMap(stringsIn)
  if (!isRecord(value)) return []
  return Object.values(value).flatMap(stringsIn)
}
function parseDiscoveredIDs(value: unknown): { teamRunId?: string; taskId?: string } {
  const text = stringsIn(value).join("\n")
  return {
    teamRunId: text.match(/"teamRunId"\s*:\s*"([0-9a-f-]{36})"/i)?.[1],
    taskId: text.match(/"taskId"\s*:\s*"([^"]+)"/)?.[1],
  }
}
function nativeToolStates(value: unknown, name: string): Array<Record<string, unknown>> {
  const data = isRecord(value) && Array.isArray(value.data) ? value.data : Array.isArray(value) ? value : []
  return data.flatMap((message) => {
    if (!isRecord(message) || !Array.isArray(message.content)) return []
    return message.content.flatMap((part) => {
      if (!isRecord(part) || part.type !== "tool" || String(part.name).toLowerCase() !== name.toLowerCase()) return []
      return isRecord(part.state) ? [part.state] : []
    })
  })
}
function latestNativeToolState(value: unknown, name: string): Record<string, unknown> | undefined {
  return nativeToolStates(value, name).at(-1)
}
function legacyPositiveSetupLines(text: string): string[] {
  const legacyPositiveDirective = /--no-omo-task|(?:senpi|omo-senpi)\s+(?:install|setup|enable)|\btmux\s+(?:new-session|split-window)\b|\b(?:create|open|start|use|attach|select|request)\b.{0,80}\btmux\s+(?:pane|session)\b|\b(?:create|use|switch to|enable)\b.{0,80}\bworktree\s+mode\b/i
  return text.split(/\r?\n/).filter((line) => legacyPositiveDirective.test(line) && !/\b(?:do not|don't|without|no)\b.{0,80}\b(?:tmux|worktree|senpi)\b/i.test(line))
}
function toolCallResponse(calls: readonly ToolCall[], id: string, model: string, stream: boolean): Response {
  const created = Math.floor(Date.now() / 1000)
  const toolCalls = calls.map((call, index) => ({
    index,
    id: `${id}-tool-${index}`,
    type: "function",
    function: { name: call.name, arguments: JSON.stringify(call.args) },
  }))
  if (!stream) return Response.json({
    id: `chatcmpl-${id}`, object: "chat.completion", created, model,
    choices: [{ index: 0, message: { role: "assistant", content: null, tool_calls: toolCalls }, finish_reason: "tool_calls" }],
    usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
  })
  const chunks = [
    { id: `chatcmpl-${id}`, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { role: "assistant", tool_calls: toolCalls }, finish_reason: null }] },
    { id: `chatcmpl-${id}`, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
  ]
  return new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", {
    headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive" },
  })
}
function textResponse(text: string, id: string, model: string, stream: boolean): Response {
  const created = Math.floor(Date.now() / 1000)
  if (!stream) return Response.json({
    id: `chatcmpl-${id}`, object: "chat.completion", created, model,
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  })
  const chunks = [
    { id: `chatcmpl-${id}`, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] },
    { id: `chatcmpl-${id}`, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
  ]
  return new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", {
    headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive" },
  })
}
function toolCallName(available: readonly string[], expected: string): string {
  const found = available.find((name) => name.toLowerCase() === expected.toLowerCase())
  if (!found) throw new Error(`Model request did not advertise required native Team tool ${expected}; saw ${available.join(", ")}`)
  return found
}
function readSession(databasePath: string, sessionID: string): DbSession | undefined {
  if (!existsSync(databasePath)) return undefined
  const db = new Database(databasePath, { readonly: true, create: false })
  try {
    const row = db.query("SELECT id, parent_id AS parentID, directory, agent, title, model FROM session_v2 WHERE id = ?").get(sessionID) as DbSession | null
    return row ?? undefined
  } finally { db.close() }
}
function projectSessions(databasePath: string, directory: string): DbSession[] {
  if (!existsSync(databasePath)) return []
  const db = new Database(databasePath, { readonly: true, create: false })
  try {
    return db.query("SELECT id, parent_id AS parentID, directory, agent, title, model FROM session_v2 WHERE directory = ? ORDER BY time_created ASC").all(directory) as DbSession[]
  } finally { db.close() }
}
function selectedModel(value: unknown): string | undefined {
  if (!isRecord(value) || typeof value.providerID !== "string") return undefined
  const id = typeof value.id === "string" ? value.id : typeof value.modelID === "string" ? value.modelID : undefined
  return id ? `${value.providerID}/${id}` : undefined
}
function recordCheck(checks: Check[], name: string, passed: boolean, detail?: unknown): void {
  checks.push({ name, passed, ...(detail === undefined ? {} : { detail }) })
  assert(passed, `${name} failed${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`)
}
async function stopProcess(process: Bun.Subprocess | undefined): Promise<number | null> {
  if (!process) return null
  if (process.exitCode === null) {
    process.kill("SIGTERM")
    const stopped = await Promise.race([process.exited.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5_000))])
    if (!stopped && process.exitCode === null) { process.kill("SIGKILL"); await process.exited }
  }
  return process.exitCode
}
async function waitForHost(host: Host): Promise<void> {
  await within("OpenCode HTTP readiness", (async () => {
    const deadline = Date.now() + 25_000
    while (Date.now() < deadline) {
      if (host.process.exitCode !== null) throw new Error(`OpenCode exited before ready (${host.process.exitCode})`)
      try { await host.client.server.info(); return } catch { await new Promise((resolve) => setTimeout(resolve, 150)) }
    }
    throw new Error("OpenCode server did not become ready")
  })(), 28_000)
}
async function waitForPlugin(host: Host, checks: Check[]): Promise<void> {
  await within("OMO Team plugin activation", (async () => {
    const deadline = Date.now() + 40_000
    while (Date.now() < deadline) {
      if (host.process.exitCode !== null) throw new Error(`OpenCode exited during plugin activation (${host.process.exitCode})`)
      const response = await host.client.plugin.list()
      const list = response.data.map(({ id, state }) => ({ id, status: state.status }))
      const failed = response.data.find((plugin) => plugin.state.status === "failed")
      if (failed) throw new Error(`Plugin load failed: ${failed.id} ${JSON.stringify(failed.state)}`)
      if (response.data.some((plugin) => plugin.id === "oh-my-openagent" && plugin.state.status === "active") &&
          response.data.some((plugin) => plugin.id === PROBE_ID && plugin.state.status === "active")) {
        recordCheck(checks, "native OMO and request-origin guard plugins are active", true, list)
        return
      }
      await new Promise((resolve) => setTimeout(resolve, 150))
    }
    throw new Error("OMO Team plugin or QA origin probe did not become active")
  })(), 42_000)
}
async function waitForCapturedRequest(
  host: Host,
  requests: readonly CapturedRequest[],
  sessionID: string,
  marker: string,
  label: string,
): Promise<CapturedRequest> {
  return within(label, (async () => {
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
      if (host.process.exitCode !== null) throw new Error(`OpenCode exited before ${label} (${host.process.exitCode})`)
      const request = requests.find((item) => item.sessionID === sessionID && item.kind === "primary" && item.conversationText.includes(marker))
      if (request) return request
      await new Promise((resolve) => setTimeout(resolve, 40))
    }
    throw new Error(`No primary model request for ${label} was observed; session=${sessionID}; marker=${marker}`)
  })(), 32_000)
}
function makeProbeSource(mockOrigin: string): string {
  return [
    "export default {",
    `  id: ${JSON.stringify(PROBE_ID)},`,
    "  async setup({ session }) {",
    `    const allowedAgents = ${JSON.stringify(ALLOWED_AGENTS)};`,
    `    const allowedModels = ${JSON.stringify([MODEL])};`,
    `    const guard = await session.hook('model.request', (event) => {`,
    `      if (event.model.providerID !== ${JSON.stringify(PROVIDER)} || !allowedModels.includes(event.model.id)) throw new Error('Team QA blocked an out-of-catalog model request');`,
    `      if (!['primary', 'title', 'compaction', 'generate'].includes(event.kind) || !allowedAgents.includes(event.agent)) throw new Error('Team QA blocked unknown agent/request origin');`,
    "    })",
    "    const identity = await session.hook('http.request', (event) => {",
    `      if (new URL(event.request.url).origin !== ${JSON.stringify(mockOrigin)}) throw new Error('Team QA blocked an HTTP request outside the local mock origin');`,
    "      const headers = new Headers(event.request.headers)",
    "      headers.set('x-omo-team-session-id', event.sessionID)",
    "      headers.set('x-omo-team-agent', event.agent)",
    "      headers.set('x-omo-team-kind', event.kind)",
    "      headers.set('x-omo-team-provider', event.model.providerID)",
    "      headers.set('x-omo-team-model', event.model.id)",
    "      event.request = new Request(event.request, { headers })",
    "    })",
    "    return async () => { await Promise.all([guard.dispose(), identity.dispose()]) }",
    "  },",
    "}",
    "",
  ].join("\n")
}
function teamSpec(): Record<string, unknown> {
  const specs: Record<string, string> = {
    skeptic: "Challenge the main claim and expose hidden assumptions.",
    validator: "Validate factual claims and identify concrete evidence gaps.",
    architect: "Assess the design and propose its clearest structure.",
    creative: "Find a distinct useful alternative and explain its tradeoffs.",
    researcher: "Find relevant information and report useful evidence.",
  }
  const categories = ["unspecified-low", "unspecified-high", "ultrabrain", "artistry", "deep-low"] as const
  return {
    version: 1,
    name: "hyperplan",
    leadAgentId: "lead",
    members: [
      { kind: "subagent_type", name: "lead", subagent_type: "atlas" },
      ...CHILD_ROLES.map((name, index) => ({ kind: "category", name, category: categories[index], prompt: specs[name] })),
    ],
  }
}

async function main(): Promise<void> {
  assert(CLI && existsSync(CLI) && isAbsolute(CLI_INPUT), "Set OPENCODE2_CLI to an existing absolute path to the pinned OpenCode CLI")
  assert(/^[a-f0-9]{64}$/i.test(EXPECTED_SERVER_SHA256), "Set OPENCODE2_EXPECTED_SERVER_SHA256 to the frozen server bundle hash")
  const relativeEvidence = relative(EVIDENCE_ROOT, EVIDENCE)
  assert(relativeEvidence && relativeEvidence !== ".." && !relativeEvidence.startsWith(".." + sep) && !isAbsolute(relativeEvidence) && !relativeEvidence.includes(sep),
    `Evidence must be one direct child of ${EVIDENCE_ROOT}`)
  await mkdir(EVIDENCE_ROOT, { recursive: true })
  const canonicalEvidenceRoot = await realpath(EVIDENCE_ROOT)
  await mkdir(EVIDENCE, { recursive: true })
  const canonicalEvidence = await realpath(EVIDENCE)
  assert(dirname(canonicalEvidence) === canonicalEvidenceRoot, "Evidence path escaped its direct-child boundary")
  const serverPath = join(PLUGIN_DIR, "server.js")
  assert(existsSync(serverPath), `Native bundle is missing: ${serverPath}`)
  const serverHash = createHash("sha256").update(await readFile(serverPath)).digest("hex")
  assert(serverHash === EXPECTED_SERVER_SHA256, `Frozen bundle hash mismatch: got ${serverHash}`)

  const tempRoot = await realpath(await mkdtemp(join(tmpdir(), "omo-team-pipeline-qa-")))
  const project = join(tempRoot, "project")
  const serverCwd = join(tempRoot, "server-cwd")
  const home = join(tempRoot, "home")
  const xdgData = join(tempRoot, "xdg-data")
  const xdgConfig = join(tempRoot, "xdg-config")
  const xdgState = join(tempRoot, "xdg-state")
  const xdgCache = join(tempRoot, "xdg-cache")
  const omoHome = join(tempRoot, "omo-home")
  const teamBase = join(tempRoot, "team-state")
  const probeDirectory = join(tempRoot, "team-origin-probe")
  const databasePath = join(tempRoot, "opencode.db")
  await Promise.all([project, serverCwd, home, xdgData, xdgConfig, xdgState, xdgCache, omoHome, teamBase, probeDirectory].map((path) => mkdir(path, { recursive: true })))
  const canonicalProject = await realpath(project)
  assert(!canonicalProject.startsWith(ROOT + sep), "QA project must be outside the repository")

  const checks: Check[] = []
  const requests: CapturedRequest[] = []
  const seenActions = new Set<string>()
  const childInitialSessions = new Set<string>()
  const childPrimaryInFlight = new Set<string>()
  const mailboxStages = new Map<string, number>()
  let maxChildPrimaryInFlight = 0
  let releaseInitialWave!: () => void
  let initialWaveReleased = false
  const initialWave = new Promise<void>((resolve) => { releaseInitialWave = resolve })
  let teamRunId: string | undefined
  let taskId: string | undefined
  let sequence = 0
  const mock = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      if (url.pathname.endsWith("/models")) return Response.json({ data: [{ id: MODEL, object: "model", created: 0, owned_by: "team-qa" }] })
      if (!url.pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 })
      const body = await request.json() as Record<string, unknown>
      const model = typeof body.model === "string" ? body.model : ""
      const sessionID = request.headers.get("x-omo-team-session-id") ?? undefined
      const agent = request.headers.get("x-omo-team-agent") ?? undefined
      const kind = request.headers.get("x-omo-team-kind") ?? undefined
      const provider = request.headers.get("x-omo-team-provider") ?? undefined
      const headerModel = request.headers.get("x-omo-team-model") ?? undefined
      const row = sessionID ? readSession(databasePath, sessionID) : undefined
      const originErrors: string[] = []
      if (!sessionID || !row) originErrors.push("missing native session origin")
      if (!agent || !ALLOWED_AGENTS.includes(agent as (typeof ALLOWED_AGENTS)[number])) originErrors.push("unknown agent identity")
      if (provider !== PROVIDER || headerModel !== model || model !== MODEL) originErrors.push("provider/model differs from the exact local catalog")
      if (!kind || !["primary", "title", "compaction", "generate"].includes(kind)) originErrors.push("unknown native request kind")
      if (row) {
        if (row.directory !== canonicalProject) originErrors.push("native request escaped isolated project location")
        if (row.parentID !== null) originErrors.push("Team member unexpectedly has a native parent")
        if (row.agent !== agent) originErrors.push("request agent header differs from native session row")
      }
      const userText = latestUserText(body)
      const conversationText = allMessageText(body)
      const system = systemText(body)
      const tools = toolNames(body)
      const discovered = parseDiscoveredIDs(body.messages)
      teamRunId ??= discovered.teamRunId
      taskId ??= discovered.taskId
      requests.push({ sessionID, agent, kind, provider, model, parentID: row?.parentID, directory: row?.directory, userText, conversationText, systemText: system, tools, originErrors })
      if (model !== MODEL || originErrors.length > 0) {
        return Response.json({ error: { message: "Team QA rejected a nonlocal or unverifiable model request", originErrors } }, { status: 403 })
      }

      const id = `teamqa-${++sequence}`
      const stream = body.stream === true
      const call = (name: string, args: unknown) => toolCallResponse([{ name, args }], id, model, stream)
      const finish = (text: string) => textResponse(text, id, model, stream)
      const actionMarker = userText.match(/OMO_QA_TEAM_(CREATE|TASK_CREATE|TASK_CLAIM|MAIL_SEND|DELETE)/)?.[0]
      if (agent === "atlas" && actionMarker) {
        const key = `${sessionID}:${actionMarker}`
        if (!seenActions.has(key)) {
          seenActions.add(key)
          if (actionMarker === "OMO_QA_TEAM_CREATE") {
            const name = toolCallName(tools, "team_create")
            return call(name, { inline_spec: teamSpec() })
          }
          if (!teamRunId) return Response.json({ error: { message: "QA has not recovered the Team run ID from native tool output" } }, { status: 500 })
          if (actionMarker === "OMO_QA_TEAM_TASK_CREATE") {
            const name = toolCallName(tools, "team_task_create")
            return call(name, { teamRunId, subject: "Verify native Team handoff", description: "Check durable task ownership and mailbox delivery." })
          }
          if (actionMarker === "OMO_QA_TEAM_TASK_CLAIM") {
            if (!taskId) return Response.json({ error: { message: "QA has not recovered the task ID from native tool output" } }, { status: 500 })
            const name = toolCallName(tools, "team_task_update")
            return call(name, { teamRunId, taskId, status: "claimed", owner: "architect" })
          }
          if (actionMarker === "OMO_QA_TEAM_MAIL_SEND") {
            const name = toolCallName(tools, "team_send_message")
            return call(name, { teamRunId, to: "architect", body: MAILBOX_BODY, kind: "message" })
          }
          if (actionMarker === "OMO_QA_TEAM_DELETE") {
            const name = toolCallName(tools, "team_delete")
            return call(name, { teamRunId, force: true })
          }
        }
      }

      if (agent === "sisyphus-junior" && sessionID) {
        if (conversationText.includes(MAILBOX_BODY)) {
          const stage = mailboxStages.get(sessionID) ?? 0
          if (stage === 0) {
            if (!teamRunId || !taskId) return Response.json({ error: { message: "Team mailbox arrived before task fixture IDs were available" } }, { status: 500 })
            mailboxStages.set(sessionID, 1)
            const name = toolCallName(tools, "team_task_update")
            return call(name, { teamRunId, taskId, status: "in_progress", owner: "architect" })
          }
          if (stage === 1) {
            mailboxStages.set(sessionID, 2)
            const name = toolCallName(tools, "team_task_update")
            return call(name, { teamRunId, taskId, status: "completed", owner: "architect" })
          }
          if (stage === 2) {
            mailboxStages.set(sessionID, 3)
            const name = toolCallName(tools, "team_send_message")
            return call(name, { teamRunId, to: "lead", body: CHILD_REPLY, kind: "message" })
          }
          return finish("OMO_TEAM_QA_MAILBOX_HANDLED")
        }
        const isFirst = !childInitialSessions.has(sessionID)
        if (isFirst && kind === "primary") {
          childInitialSessions.add(sessionID)
          childPrimaryInFlight.add(sessionID)
          maxChildPrimaryInFlight = Math.max(maxChildPrimaryInFlight, childPrimaryInFlight.size)
          await initialWave
          childPrimaryInFlight.delete(sessionID)
        }
      }
      const text = system.includes("Native OpenCode Team adapter") ? "OMO_TEAM_QA_CHILD_READY" : "OMO_TEAM_QA_RESPONSE"
      return finish(text)
    },
  })
  await writeFile(join(probeDirectory, "index.js"), makeProbeSource(`http://127.0.0.1:${mock.port}`), "utf8")

  const projectConfig = {
    $schema: "https://opencode.ai/config.json",
    plugins: [PLUGIN_DIR, probeDirectory],
    enabled_providers: [PROVIDER],
    model: `${PROVIDER}/${MODEL}`,
    default_agent: "atlas",
    provider: {
      [PROVIDER]: {
        name: "Local Team pipeline QA mock",
        npm: "@ai-sdk/openai-compatible",
        options: { baseURL: `http://127.0.0.1:${mock.port}/v1`, apiKey: API_KEY },
        models: { [MODEL]: {
          name: "Local Team QA model",
          tool_call: true,
          limit: { context: 200_000, output: 8_192 },
          // Builtin OMO categories contribute max/medium variants. Expose both
          // in this one fake model so category routing stays strictly local.
          variants: { max: {}, medium: {} },
        } },
      },
    },
    mcp: {},
    telemetry: false,
  }
  await writeFile(join(project, "opencode.json"), JSON.stringify(projectConfig, null, 2) + "\n")
  const categories = Object.fromEntries(CATEGORY_NAMES.map((category) => [category, { models: [`${PROVIDER}/${MODEL}`] }]))
  const omoConfig = {
    telemetry: { enabled: false },
    "[opencode]": {
      telemetry: false,
      agents: { atlas: { model: `${PROVIDER}/${MODEL}` }, "sisyphus-junior": { model: `${PROVIDER}/${MODEL}` } },
      categories,
      team_mode: { enabled: true, base_dir: teamBase, max_parallel_members: 2, max_members: 8, max_wall_clock_minutes: 10, max_member_turns: 30 },
      disabled_mcps: ["websearch", "context7", "grep_app", "lsp"],
      mcp_env_allowlist: [],
      claude_code: { mcp: false, agents: false, skills: false, commands: false, plugins: false, hooks: false },
    },
  }
  await mkdir(join(project, ".omo"), { recursive: true })
  await writeFile(join(project, ".omo", "omo.jsonc"), JSON.stringify(omoConfig, null, 2) + "\n")

  let host: Host | undefined
  let failure: unknown
  let teamID: string | undefined
  let leadSessionID: string | undefined
  let childSessions: DbSession[] = []
  let memberTranscript: unknown
  let leadTranscript: unknown
  let deleteTranscript: unknown
  const status: Record<string, unknown> = {
    sourceServerSHA256: serverHash,
    cli: CLI,
    pluginDirectory: PLUGIN_DIR,
    projectDirectory: canonicalProject,
    databasePath,
    teamBase,
    startedAt: new Date().toISOString(),
  }
  try {
    const port = reservePort()
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      TMPDIR: tempRoot,
      HOME: home,
      XDG_DATA_HOME: xdgData,
      XDG_CONFIG_HOME: xdgConfig,
      XDG_STATE_HOME: xdgState,
      XDG_CACHE_HOME: xdgCache,
      OPENCODE_DB: databasePath,
      OMO_HOME: omoHome,
      OPENCODE_DISABLE_MODELS_FETCH: "1",
      OPENCODE_TELEMETRY_DISABLED: "1",
      OPENCODE_SERVER_PASSWORD: PASSWORD,
      OPENCODE_PASSWORD: PASSWORD,
    }
    const serverProcess = Bun.spawn([CLI, "--print-logs", "--log-level", "debug", "serve", "--hostname", "127.0.0.1", "--port", String(port)], {
      cwd: serverCwd, env, stdout: "pipe", stderr: "pipe",
    })
    host = {
      port,
      process: serverProcess,
      client: OpenCode.make({ baseUrl: `http://127.0.0.1:${port}`, headers: { Authorization: basicAuth(), "x-opencode-directory": canonicalProject } }),
      stdout: "",
      stderr: "",
      stdoutTask: Promise.resolve(),
      stderrTask: Promise.resolve(),
    }
    host.stdoutTask = new Response(serverProcess.stdout as ReadableStream<Uint8Array>).text().then((text) => { host!.stdout = text })
    host.stderrTask = new Response(serverProcess.stderr as ReadableStream<Uint8Array>).text().then((text) => { host!.stderr = text })
    await waitForHost(host)
    await waitForPlugin(host, checks)

    const [providers, models, defaultModel, mcp] = await Promise.all([
      host.client.provider.list(), host.client.model.list(), host.client.model.default(), host.client.mcp.list(),
    ])
    const modelIDs = models.data.map((entry) => `${entry.providerID}/${entry.id}`).sort()
    recordCheck(checks, "only the configured local mock provider is enabled", providers.data.length === 1 && providers.data[0]?.id === PROVIDER, providers.data.map((entry) => entry.id))
    recordCheck(checks, "the exact local model catalog is active", modelIDs.length === 1 && modelIDs[0] === `${PROVIDER}/${MODEL}`, modelIDs)
    recordCheck(checks, "native default model is the local mock", selectedModel(defaultModel.data) === `${PROVIDER}/${MODEL}`, defaultModel.data)
    recordCheck(checks, "no MCP server is active", mcp.data.length === 0, mcp.data.map((entry) => entry.name))
    const skills = await host.client.skill.list()
    const skillIDs = skills.data.map((skill) => skill.id)
    recordCheck(checks, "native Team and Hyperplan skills are registered", skillIDs.includes("team-mode") && skillIDs.includes("hyperplan"), skillIDs.filter((id) => id === "team-mode" || id === "hyperplan"))

    const lead = await host.client.session.create({ title: "Native Team pipeline QA lead", agent: "atlas", model: { providerID: PROVIDER, id: MODEL }, location: { directory: canonicalProject } })
    leadSessionID = lead.id
    assert(lead.location.directory === canonicalProject && !lead.parentID && lead.agent === "atlas", "Native lead session was not created in the isolated project as Atlas")
    await host.client.session.prompt({ sessionID: lead.id, text: "OMO_QA_TEAM_CREATE Start the native Team pipeline using the loaded Hyperplan skill.", skills: [{ id: "hyperplan" }] })
    await within("lead Team creation turn", host.client.session.wait({ sessionID: lead.id }))
    const leadMessages = await host.client.message.list({ sessionID: lead.id })
    const teamCreateState = latestNativeToolState(leadMessages.data, "team_create")
    assert(teamCreateState?.status === "completed", `Native team_create did not complete: ${JSON.stringify(teamCreateState ?? leadMessages.data)}`)
    teamID = parseDiscoveredIDs(leadMessages).teamRunId
    assert(teamID, "Could not recover teamRunId from the native team_create tool result")
    teamRunId = teamID
    const leadCreateRequest = requests.find((request) => request.sessionID === lead.id && request.userText.includes("OMO_QA_TEAM_CREATE") && request.kind === "primary")
    const systemAndUser = `${leadCreateRequest?.systemText ?? ""}\n${leadCreateRequest?.userText ?? ""}`
    recordCheck(checks, "Hyperplan skill was loaded into the lead model request", systemAndUser.includes("NATIVE TEAM ADAPTER") || systemAndUser.includes("Native Team adapter"), { systemChars: systemAndUser.length })
    recordCheck(checks, "lead model request advertised required Team pipeline tools",
      ["team_create", "team_send_message", "team_task_create", "team_task_update", "team_status", "team_delete"].every((name) => leadCreateRequest?.tools.some((entry) => entry.toLowerCase() === name)),
      leadCreateRequest?.tools)
    const legacySetupLines = legacyPositiveSetupLines(systemAndUser)
    recordCheck(checks, "Hyperplan prompt contains no legacy positive Senpi/tmux/worktree setup directions",
      legacySetupLines.length === 0, legacySetupLines)

    await within("two first-wave Team children reach the local model", (async () => {
      const deadline = Date.now() + 30_000
      while (Date.now() < deadline) {
        if (childInitialSessions.size >= 2) return
        if (host!.process.exitCode !== null) throw new Error(`OpenCode exited during first Team wave (${host!.process.exitCode})`)
        await new Promise((resolve) => setTimeout(resolve, 40))
      }
      throw new Error(`Only ${childInitialSessions.size} first-wave child sessions reached the mock`)
    })(), 32_000)
    childSessions = projectSessions(databasePath, canonicalProject).filter((row) => row.title?.startsWith("hyperplan / "))
    recordCheck(checks, "parallel cap starts exactly two native Team sessions in the first wave", childSessions.length === 2, childSessions.map(({ id, title, agent, parentID }) => ({ id, title, agent, parentID })))
    recordCheck(checks, "first-wave children are native parentless junior sessions", childSessions.length === 2 && childSessions.every((row) => row.agent === "sisyphus-junior" && row.parentID === null), childSessions)
    releaseInitialWave()
    initialWaveReleased = true
    await within("all five native Team member sessions complete", (async () => {
      const deadline = Date.now() + 75_000
      while (Date.now() < deadline) {
        childSessions = projectSessions(databasePath, canonicalProject).filter((row) => row.title?.startsWith("hyperplan / "))
        if (childSessions.length === 5) {
          const states = await Promise.all(childSessions.map((row) => host!.client.session.get({ sessionID: row.id })))
          if (states.every((state) => state.outcome === "succeeded")) return
        }
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      throw new Error(`Team child sessions did not all complete: ${JSON.stringify(childSessions.map(({ id, title }) => ({ id, title })))}`)
    })(), 78_000)
    recordCheck(checks, "five Hyperplan roles reached native sessions", childSessions.length === 5 && CHILD_ROLES.every((role) => childSessions.some((row) => row.title === `hyperplan / ${role}`)), childSessions.map(({ title, agent, parentID }) => ({ title, agent, parentID })))
    recordCheck(checks, "native child provider concurrency respects max_parallel_members=2", maxChildPrimaryInFlight === 2, { peak: maxChildPrimaryInFlight, firstWaveSessions: [...childInitialSessions] })
    recordCheck(checks, "every observed model request matches its parentless native session and local catalog", requests.length > 0 && requests.every((request) => request.originErrors.length === 0), requests.filter((request) => request.originErrors.length > 0))

    await host.client.session.prompt({ sessionID: lead.id, text: "OMO_QA_TEAM_TASK_CREATE Create a shared task for the architect." })
    await within("Team task creation turn", host.client.session.wait({ sessionID: lead.id }))
    leadTranscript = await host.client.message.list({ sessionID: lead.id })
    taskId = parseDiscoveredIDs(leadTranscript).taskId
    assert(taskId, "Could not recover taskId from native team_task_create result")
    const taskCreateState = latestNativeToolState(leadTranscript, "team_task_create")
    assert(taskCreateState?.status === "completed", `team_task_create did not complete: ${JSON.stringify(taskCreateState)}`)
    await host.client.session.prompt({ sessionID: lead.id, text: "OMO_QA_TEAM_TASK_CLAIM Assign that pending task to the architect." })
    await within("Team task claim turn", host.client.session.wait({ sessionID: lead.id }))
    leadTranscript = await host.client.message.list({ sessionID: lead.id })
    const leadTaskUpdates = nativeToolStates(leadTranscript, "team_task_update")
    assert(leadTaskUpdates.some((state) => state.status === "completed"), `Lead task claim did not complete: ${JSON.stringify(leadTaskUpdates)}`)
    await host.client.session.prompt({ sessionID: lead.id, text: "OMO_QA_TEAM_MAIL_SEND Send the architect the next-round message." })
    await within("Team mailbox send turn", host.client.session.wait({ sessionID: lead.id }))
    const sendState = latestNativeToolState(await host.client.message.list({ sessionID: lead.id }), "team_send_message")
    assert(sendState?.status === "completed", `Lead mailbox send did not complete: ${JSON.stringify(sendState)}`)

    const architect = childSessions.find((row) => row.title === "hyperplan / architect")
    assert(architect, "The architect native session is missing")
    await waitForCapturedRequest(host, requests, architect.id, MAILBOX_BODY, "architect mailbox wakeup")
    await within("architect mailbox task and reply turn", host.client.session.wait({ sessionID: architect.id }))
    await waitForCapturedRequest(host, requests, lead.id, CHILD_REPLY, "lead mailbox reply wakeup")
    await within("lead receives architect mailbox reply", host.client.session.wait({ sessionID: lead.id }))
    memberTranscript = await host.client.message.list({ sessionID: architect.id })
    leadTranscript = await host.client.message.list({ sessionID: lead.id })
    const architectMessageText = JSON.stringify(memberTranscript)
    const leadMessageText = JSON.stringify(leadTranscript)
    const architectTaskUpdates = nativeToolStates(memberTranscript, "team_task_update")
    const taskPath = join(teamBase, "runtime", teamID, "tasks", `${taskId}.json`)
    const persistedTask = JSON.parse(await readFile(taskPath, "utf8")) as { id?: string; status?: string; owner?: string }
    recordCheck(checks, "lead mailbox message is delivered through a native child session prompt", requests.some((request) => request.sessionID === architect.id && request.kind === "primary" && request.userText.includes(MAILBOX_BODY)), requests.filter((request) => request.sessionID === architect.id).map((request) => request.userText))
    recordCheck(checks, "member task completion and report tools finish successfully", architectTaskUpdates.some((state) => state.status === "completed") && nativeToolStates(memberTranscript, "team_send_message").some((state) => state.status === "completed") && architectMessageText.includes(CHILD_REPLY), { taskUpdates: architectTaskUpdates, sendStates: nativeToolStates(memberTranscript, "team_send_message"), excerpt: architectMessageText.slice(-2000) })
    recordCheck(checks, "child mailbox reply is delivered to the lead session", requests.some((request) => request.sessionID === lead.id && request.userText.includes(CHILD_REPLY)) && leadMessageText.includes(CHILD_REPLY), requests.filter((request) => request.sessionID === lead.id).map((request) => request.userText))
    recordCheck(checks, "Team members are not offered question, nested Team, or delegation tools",
      requests.filter((request) => request.agent === "sisyphus-junior").every((request) => !request.tools.some((name) => ["question", "team_create", "subagent", "task", "call_omo_agent"].includes(name.toLowerCase()))),
      [...new Set(requests.filter((request) => request.agent === "sisyphus-junior").flatMap((request) => request.tools))])
    recordCheck(checks, "task create, claim, and completion persist for the architect", taskCreateState.status === "completed" && leadTaskUpdates.some((state) => state.status === "completed") && architectTaskUpdates.some((state) => state.status === "completed") && persistedTask.id === taskId && persistedTask.status === "completed" && persistedTask.owner === "architect", { taskCreateState, leadTaskUpdates, architectTaskUpdates, persistedTask })

    await host.client.session.prompt({ sessionID: lead.id, text: "OMO_QA_TEAM_DELETE Close this terminal Team run." })
    await within("terminal Team deletion turn", host.client.session.wait({ sessionID: lead.id }))
    deleteTranscript = await host.client.message.list({ sessionID: lead.id })
    const membershipPath = join(teamBase, "team-memberships", `${encodeURIComponent(teamID)}.json`)
    const membership = JSON.parse(await readFile(membershipPath, "utf8")) as { closedAt?: number | null; members?: Array<{ name: string; sessionID?: string }> }
    recordCheck(checks, "team_delete closes the run after terminal members while retaining ancestry identity", typeof membership.closedAt === "number" && membership.members?.length === 6, { closedAt: membership.closedAt, members: membership.members })
    recordCheck(checks, "native Team sessions remain intact and parentless after logical deletion", childSessions.every((row) => readSession(databasePath, row.id)?.parentID === null), childSessions.map(({ id, parentID }) => ({ id, parentID })))
    recordCheck(checks, "delete tool completed in lead transcript", JSON.stringify(deleteTranscript).includes("ancestryRetained") && JSON.stringify(deleteTranscript).includes("deleted"), JSON.stringify(deleteTranscript).slice(-2500))

    status.teamRunId = teamID
    status.taskId = taskId
    status.leadSessionID = lead.id
    status.childSessions = childSessions
    status.peakDistinctChildPrimaryRequests = maxChildPrimaryInFlight
    status.membership = membership
  } catch (error) {
    failure = error
  } finally {
    if (!initialWaveReleased) releaseInitialWave()
    const serverExit = await stopProcess(host?.process)
    mock.stop(true)
    if (host) await Promise.allSettled([host.stdoutTask, host.stderrTask])
    status.finishedAt = new Date().toISOString()
    status.serverExitCode = serverExit
    status.mockStopped = true
    status.serverLog = host?.stdout ?? ""
    status.serverErrorLog = host?.stderr ?? ""
    status.checks = checks
    status.passedChecks = checks.filter((check) => check.passed).length
    status.failedChecks = checks.filter((check) => !check.passed)
    status.modelRequests = requests
    status.taskTranscript = memberTranscript
    status.leadTranscript = leadTranscript
    status.deleteTranscript = deleteTranscript
    status.error = failure instanceof Error ? { name: failure.name, message: failure.message, stack: failure.stack } : failure === undefined ? undefined : String(failure)
    status.cleanup = { serverStopped: serverExit !== null, mockStopped: true, retainedTemporaryRoot: tempRoot, databasePath }
    await writeFile(join(EVIDENCE, "runtime.json"), JSON.stringify(status, null, 2) + "\n")
    await writeFile(join(EVIDENCE, "server.log"), `${host?.stdout ?? ""}\n--- STDERR ---\n${host?.stderr ?? ""}`)
    await writeFile(join(EVIDENCE, "requests.json"), JSON.stringify(requests, null, 2) + "\n")
    await writeFile(join(EVIDENCE, "checks.json"), JSON.stringify(checks, null, 2) + "\n")
    await writeFile(join(EVIDENCE, "README.txt"), [
      `source server SHA256: ${serverHash}`,
      `CLI: ${CLI}`,
      `project: ${canonicalProject}`,
      `temporary root retained: ${tempRoot}`,
      `database: ${databasePath}`,
      `Team state: ${teamBase}`,
      `checks: ${checks.filter((check) => check.passed).length}/${checks.length}`,
      `error: ${failure instanceof Error ? failure.message : failure === undefined ? "none" : String(failure)}`,
      "The probe rejects model requests outside the configured provider/model and HTTP requests outside the exact local mock origin.",
    ].join("\n") + "\n")
  }
  if (failure) throw failure
  assert(checks.length >= 15 && checks.every((check) => check.passed), `Team pipeline QA incomplete; inspect ${join(EVIDENCE, "runtime.json")}`)
  console.log(JSON.stringify({ evidence: EVIDENCE, sourceServerSHA256: serverHash, passed: checks.length, tempRoot }, null, 2))
}

await main()
