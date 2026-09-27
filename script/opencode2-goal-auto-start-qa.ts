/**
 * Local-only native QA for first-turn default goal auto-start.
 * Requires an explicit pinned CLI and frozen server bundle hash.
 */
import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { chmod, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { tmpdir } from "node:os"
import { Database } from "bun:sqlite"
import { OpenCode } from "@opencode/client"

const ROOT = resolve(import.meta.dir, "..")
const EVIDENCE_ROOT = join(ROOT, ".omo", "evidence")
const EVIDENCE = resolve(process.env.OPENCODE2_GOAL_AUTO_START_EVIDENCE_DIR
  ?? process.env.OPENCODE2_QA_EVIDENCE_DIR
  ?? join(EVIDENCE_ROOT, "20260927-goal-auto-start"))
const PLUGIN_DIR = resolve(process.env.OPENCODE2_PLUGIN_DIR ?? join(ROOT, "dist", "opencode2"))
const CLI_INPUT = process.env.OPENCODE2_CLI?.trim() ?? ""
const CLI = CLI_INPUT ? resolve(CLI_INPUT) : ""
const EXPECTED_SHA = process.env.OPENCODE2_EXPECTED_SERVER_SHA256 ?? ""
const PROVIDER = "omoqa"
const MODEL = "goal-auto-qa-model"
const API_KEY = "goal-auto-local-fake-key"
const PASSWORD = "goal-auto-local-fake-password"
const PROBE_ID = "omo-goal-auto-origin-probe"

type Origin = { id: string; parentID: string | null; directory: string; agent: string | null; model?: string }
type GoalSnapshot = { id: string; objective: string; status: string }
type RequestRecord = {
  sessionID?: string
  parentID?: string | null
  agent?: string | null
  kind?: string
  model: string
  role: "root" | "child" | "unknown"
  users: string[]
  tools: string[]
  originErrors: string[]
  receivedAt: number
  responseAt: number
  responseKind: "text" | "tool"
  goalPromptVisible: boolean
}
type Check = { name: string; passed: boolean; detail?: unknown }
type Host = {
  port: number
  process: Bun.Subprocess
  client: ReturnType<typeof OpenCode.make>
  stdout: string
  stderr: string
  stdoutTask: Promise<void>
  stderrTask: Promise<void>
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
function redact(value: string): string {
  return value.replaceAll(API_KEY, "[redacted-fake-key]").replaceAll(PASSWORD, "[redacted-test-password]")
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
async function within<T>(label: string, promise: Promise<T>, timeoutMs = 60_000): Promise<T> {
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
function contentText(value: unknown): string {
  if (typeof value === "string") return value
  if (Array.isArray(value)) return value.map(contentText).filter(Boolean).join("\n")
  if (!isRecord(value)) return ""
  return typeof value.text === "string" ? value.text : contentText(value.content ?? value.parts ?? value.output)
}
function bodyMessages(body: Record<string, unknown>): Array<Record<string, unknown>> {
  return Array.isArray(body.messages) ? body.messages.filter(isRecord) : []
}
function userTexts(body: Record<string, unknown>): string[] {
  return bodyMessages(body).filter((message) => message.role === "user")
    .map((message) => contentText(message.content ?? message.parts ?? message.text))
}
function systemText(body: Record<string, unknown>): string {
  return bodyMessages(body).filter((message) => message.role === "system" || message.role === "developer")
    .map((message) => contentText(message.content ?? message.parts ?? message.text)).join("\n")
}
function toolNames(body: Record<string, unknown>): string[] {
  if (!Array.isArray(body.tools)) return []
  return body.tools.flatMap((entry) => {
    if (!isRecord(entry)) return []
    const fn = isRecord(entry.function) ? entry.function : entry
    return typeof fn.name === "string" ? [fn.name] : []
  })
}
function sessionOrigin(databasePath: string, sessionID: string | undefined): Origin | undefined {
  if (!sessionID || !existsSync(databasePath)) return undefined
  try {
    const database = new Database(databasePath, { readonly: true, create: false })
    try {
      const row = database.query(
        "SELECT id, parent_id AS parentID, directory, agent, model FROM session_v2 WHERE id = ?",
      ).get(sessionID) as {
        id?: string; parentID?: string | null; directory?: string; agent?: string | null; model?: string | null
      } | null
      if (!row || typeof row.id !== "string" || typeof row.directory !== "string") return undefined
      let model: string | undefined
      if (typeof row.model === "string") {
        try {
          const parsed = JSON.parse(row.model) as Record<string, unknown>
          if (typeof parsed.providerID === "string" && typeof parsed.id === "string") model = parsed.providerID + "/" + parsed.id
        } catch {
          model = undefined
        }
      }
      return { id: row.id, parentID: row.parentID ?? null, directory: row.directory, agent: row.agent ?? null, model }
    } finally {
      database.close()
    }
  } catch {
    return undefined
  }
}
function goalPath(project: string, sessionID: string): string {
  return join(project, ".omo", "goal", encodeURIComponent(sessionID) + ".json")
}
async function readGoal(project: string, sessionID: string): Promise<GoalSnapshot | undefined> {
  try {
    const parsed = JSON.parse(await readFile(goalPath(project, sessionID), "utf8")) as unknown
    if (!isRecord(parsed) || !isRecord(parsed.goal)) return undefined
    const goal = parsed.goal
    return typeof goal.id === "string" && typeof goal.objective === "string" && typeof goal.status === "string"
      ? { id: goal.id, objective: goal.objective, status: goal.status }
      : undefined
  } catch {
    return undefined
  }
}
function response(
  body: Record<string, unknown>,
  id: string,
  model: string,
  text: string,
  calls: Array<{ name: string; args: unknown }> = [],
): Response {
  const created = Math.floor(Date.now() / 1000)
  const streaming = body.stream === true
  const toolCalls = calls.map((call, index) => ({
    index,
    id: id + "-tool-" + index,
    type: "function",
    function: { name: call.name, arguments: JSON.stringify(call.args) },
  }))
  if (!streaming) {
    return Response.json({
      id: "chatcmpl-" + id, object: "chat.completion", created, model,
      choices: [{
        index: 0,
        message: calls.length ? { role: "assistant", content: null, tool_calls: toolCalls } : { role: "assistant", content: text },
        finish_reason: calls.length ? "tool_calls" : "stop",
      }],
      usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 },
    })
  }
  const delta: Record<string, unknown> = { role: "assistant" }
  if (calls.length) delta.tool_calls = toolCalls
  else delta.content = text
  const chunks = [
    { id: "chatcmpl-" + id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta, finish_reason: null }] },
    { id: "chatcmpl-" + id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: {}, finish_reason: calls.length ? "tool_calls" : "stop" }] },
  ]
  return new Response(chunks.map((chunk) => "data: " + JSON.stringify(chunk) + "\n\n").join("") + "data: [DONE]\n\n", {
    headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive" },
  })
}
function originProbeSource(mockOrigin: string): string {
  return [
    "export default {",
    " id: " + JSON.stringify(PROBE_ID) + ",",
    " async setup({ session }) {",
    "  const expectedOrigin = " + JSON.stringify(mockOrigin) + ";",
    "  const model = await session.hook('model.request', (event) => {",
    "   if (event.model.providerID !== " + JSON.stringify(PROVIDER) + " || event.model.id !== " + JSON.stringify(MODEL) + ") throw new Error('QA blocked non-local model');",
    "   if (!['primary','title','compaction','generate'].includes(event.kind)) throw new Error('QA blocked unknown model request kind');",
    "  });",
    "  const http = await session.hook('http.request', (event) => {",
    "   if (new URL(event.request.url).origin !== expectedOrigin) throw new Error('QA blocked non-local HTTP destination');",
    "   const headers = new Headers(event.request.headers);",
    "   headers.set('x-omo-qa-session-id', event.sessionID);",
    "   headers.set('x-omo-qa-agent', event.agent);",
    "   headers.set('x-omo-qa-kind', event.kind);",
    "   headers.set('x-omo-qa-provider', event.model.providerID);",
    "   headers.set('x-omo-qa-model', event.model.id);",
    "   event.request = new Request(event.request, { headers });",
    "  });",
    "  return async () => { await Promise.all([http.dispose(), model.dispose()]); };",
    " },",
    "}",
    "",
  ].join("\n")
}
async function waitForHost(client: ReturnType<typeof OpenCode.make>, process: Bun.Subprocess): Promise<void> {
  const deadline = Date.now() + 25_000
  while (Date.now() < deadline) {
    if (process.exitCode !== null) throw new Error("OpenCode exited before startup: " + process.exitCode)
    try {
      await client.server.info()
      return
    } catch {
      await Bun.sleep(150)
    }
  }
  throw new Error("OpenCode server did not become ready")
}
async function waitForActivation(client: ReturnType<typeof OpenCode.make>, process: Bun.Subprocess): Promise<unknown> {
  const deadline = Date.now() + 40_000
  let latest: unknown = {}
  while (Date.now() < deadline) {
    if (process.exitCode !== null) throw new Error("OpenCode exited during plugin activation: " + process.exitCode)
    const [plugins, agents] = await Promise.all([client.plugin.list(), client.agent.list()])
    latest = {
      plugins: plugins.data.map((plugin) => ({ id: plugin.id, status: plugin.state.status })),
      agents: agents.data.map((agent) => agent.id),
    }
    const failed = plugins.data.find((plugin) => plugin.state.status === "failed")
    if (failed) throw new Error("Plugin failed during setup: " + JSON.stringify({ id: failed.id, state: failed.state }))
    if (plugins.data.some((plugin) => plugin.id === "oh-my-openagent" && plugin.state.status === "active")
      && plugins.data.some((plugin) => plugin.id === PROBE_ID && plugin.state.status === "active")
      && agents.data.some((agent) => agent.id === "sisyphus")
      && agents.data.some((agent) => agent.id === "explore")) return latest
    await Bun.sleep(150)
  }
  throw new Error("OMO/probe activation did not finish: " + JSON.stringify(latest))
}
async function preflight(
  client: ReturnType<typeof OpenCode.make>,
  project: string,
  checks: Check[],
  label: string,
): Promise<void> {
  const [providers, models, defaultModel, mcps] = await Promise.all([
    client.provider.list(), client.model.list(), client.model.default(), client.mcp.list(),
  ])
  const providerIDs = providers.data.map((entry) => entry.id).sort()
  const modelIDs = models.data.map((entry) => entry.providerID + "/" + entry.id).sort()
  const defaultRef = isRecord(defaultModel.data)
    && typeof defaultModel.data.providerID === "string" && typeof defaultModel.data.id === "string"
    ? defaultModel.data.providerID + "/" + defaultModel.data.id
    : ""
  const mcpNames = mcps.data.map((entry) => entry.name).sort()
  const localProvider = providerIDs.length === 1 && providerIDs[0] === PROVIDER
  const localModel = modelIDs.length === 1 && modelIDs[0] === PROVIDER + "/" + MODEL
  const localDefault = defaultRef === PROVIDER + "/" + MODEL
  const noMcp = Array.isArray(mcps.data) && mcpNames.length === 0
  checks.push({ name: label + ": exact single local provider", passed: localProvider, detail: providerIDs })
  checks.push({ name: label + ": exact single local model", passed: localModel, detail: modelIDs })
  checks.push({ name: label + ": local default model", passed: localDefault, detail: defaultRef })
  checks.push({ name: label + ": no enabled MCP servers", passed: noMcp, detail: mcpNames })
  assert(providers.location.directory === project, label + ": provider list resolved a different project")
  assert(localProvider && localModel && localDefault && noMcp, label + ": local-only preflight failed")
}
function addCheck(checks: Check[], name: string, passed: boolean, detail?: unknown): void {
  checks.push({ name, passed, ...(detail === undefined ? {} : { detail }) })
  assert(passed, name + " failed" + (detail === undefined ? "" : ": " + JSON.stringify(detail)))
}
async function waitFor(label: string, predicate: () => boolean | Promise<boolean>, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await Bun.sleep(50)
  }
  throw new Error(label + " was not observed within " + timeoutMs + "ms")
}
async function stopProcess(process: Bun.Subprocess | undefined): Promise<number | null> {
  if (!process) return null
  if (process.exitCode === null) {
    process.kill("SIGTERM")
    const stopped = await Promise.race([
      process.exited.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5_000)),
    ])
    if (!stopped && process.exitCode === null) {
      process.kill("SIGKILL")
      await process.exited
    }
  }
  return process.exitCode
}
function quoteShell(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'"
}
async function main(): Promise<void> {
  assert(CLI && isAbsolute(CLI_INPUT) && existsSync(CLI), "Set OPENCODE2_CLI to an explicit absolute path")
  assert(/^[a-f0-9]{64}$/i.test(EXPECTED_SHA), "Set OPENCODE2_EXPECTED_SERVER_SHA256 to the expected frozen server hash")
  const relativeEvidence = relative(EVIDENCE_ROOT, EVIDENCE)
  assert(relativeEvidence !== "" && !relativeEvidence.startsWith("..") && !isAbsolute(relativeEvidence) && !relativeEvidence.includes(sep),
    "Evidence must be a direct child of " + EVIDENCE_ROOT)
  await mkdir(EVIDENCE_ROOT, { recursive: true })
  const canonicalEvidenceRoot = await realpath(EVIDENCE_ROOT)
  await mkdir(EVIDENCE, { recursive: true })
  assert(dirname(await realpath(EVIDENCE)) === canonicalEvidenceRoot, "Evidence path escaped .omo/evidence")
  const serverPath = join(PLUGIN_DIR, "server.js")
  assert(existsSync(serverPath), "Missing frozen OMO bundle: " + serverPath)
  const serverHash = createHash("sha256").update(await readFile(serverPath)).digest("hex")
  assert(serverHash === EXPECTED_SHA, "Frozen bundle hash mismatch: " + serverHash)

  const tempRoot = await realpath(await mkdtemp(join(tmpdir(), "omo-goal-auto-qa-")))
  const project = join(tempRoot, "project")
  const home = join(tempRoot, "home")
  const xdgData = join(tempRoot, "xdg-data")
  const xdgConfig = join(tempRoot, "xdg-config")
  const xdgState = join(tempRoot, "xdg-state")
  const xdgCache = join(tempRoot, "xdg-cache")
  const omoHome = join(tempRoot, "omo-home")
  const claudeHome = join(tempRoot, "claude-home")
  const claudePlugins = join(tempRoot, "claude-plugins")
  const databasePath = join(tempRoot, "opencode.db")
  const probeDir = join(tempRoot, "origin-probe")
  const rejectScript = join(tempRoot, "reject-first-prompt.sh")
  const hookLog = join(tempRoot, "prompt-hook.log")
  await Promise.all([
    project, home, xdgData, xdgConfig, xdgState, xdgCache, omoHome, claudeHome, claudePlugins,
    join(project, ".omo"), join(project, ".claude"), probeDir,
  ].map((path) => mkdir(path, { recursive: true })))
  const canonicalProject = await realpath(project)
  assert(!canonicalProject.startsWith(ROOT + sep), "QA project must be outside the repository")

  const requests: RequestRecord[] = []
  const roots = new Set<string>()
  const scenarios = new Map<string, "auto" | "existing" | "child" | "blocked">()
  const requestCounts = new Map<string, number>()
  const childParentCompletionSent = new Set<string>()
  const unexpectedRequests: unknown[] = []
  const inboxEvents: Array<{ sessionID: string; inboxID: string; at: number; itemType: string; goalMarker: boolean }> = []
  let mockIndex = 0
  const mock = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      if (url.pathname === "/v1/models") {
        return Response.json({ data: [{ id: MODEL, object: "model", created: 0, owned_by: "local-goal-qa" }] })
      }
      if (url.pathname !== "/v1/chat/completions" || request.method !== "POST") {
        unexpectedRequests.push({ method: request.method, path: url.pathname })
        return new Response("unexpected mock endpoint", { status: 404 })
      }
      const body = await request.json() as Record<string, unknown>
      const receivedAt = Date.now()
      const sessionID = request.headers.get("x-omo-qa-session-id") ?? undefined
      const agentHeader = request.headers.get("x-omo-qa-agent") ?? undefined
      const kind = request.headers.get("x-omo-qa-kind") ?? undefined
      const model = typeof body.model === "string" ? body.model : ""
      const source = sessionOrigin(databasePath, sessionID)
      const role: RequestRecord["role"] = source?.parentID
        ? roots.has(source.parentID) ? "child" : "unknown"
        : source && roots.has(source.id) ? "root" : "unknown"
      const errors: string[] = []
      if (!sessionID || !source || source.id !== sessionID) errors.push("native session row missing")
      if (!source || source.directory !== canonicalProject) errors.push("native session is outside isolated project")
      if (model !== MODEL || request.headers.get("x-omo-qa-provider") !== PROVIDER
        || request.headers.get("x-omo-qa-model") !== MODEL) errors.push("request was not pinned to local model")
      if (!kind || !["primary", "title", "compaction", "generate"].includes(kind)) errors.push("unknown request kind")
      if (role === "unknown") errors.push("request has no known isolated root/child owner")
      if (role === "root" && (source?.parentID !== null || source.agent !== "sisyphus" || agentHeader !== "sisyphus")) {
        errors.push("root request agent or ownership mismatch")
      }
      if (role === "child" && (source?.agent !== "explore" || agentHeader !== "explore"
        || source.model !== PROVIDER + "/" + MODEL)) errors.push("child request is not the expected local Explore child")
      const users = userTexts(body)
      const tools = toolNames(body)
      const goalPromptVisible = systemText(body).includes("Continue working toward the active thread goal")
        || users.some((text) => text.includes("Continue working toward the active thread goal")
          || text.includes("A paused goal is being resumed."))
      const base: Omit<RequestRecord, "responseAt" | "responseKind"> = {
        ...(sessionID ? { sessionID } : {}),
        ...(source ? { parentID: source.parentID, agent: source.agent } : {}),
        ...(kind ? { kind } : {}),
        model, role, users: users.map((text) => text.slice(0, 140)), tools,
        originErrors: errors, receivedAt, goalPromptVisible,
      }
      if (errors.length) {
        unexpectedRequests.push(base)
        requests.push({ ...base, responseAt: Date.now(), responseKind: "text" })
        return Response.json({ error: { message: "QA rejected an unattributed/nonlocal request", errors } }, { status: 403 })
      }
      assert(sessionID, "Missing QA session origin")
      let calls: Array<{ name: string; args: unknown }> = []
      let text = "GOAL_QA_DETERMINISTIC_RESPONSE"
      if (kind !== "primary") {
        text = "GOAL_QA_AUXILIARY_REQUEST_COMPLETED"
      } else if (role === "child") {
        text = "GOAL_QA_CHILD_COMPLETED"
      } else {
        const scenario = scenarios.get(sessionID)
        const number = (requestCounts.get(sessionID) ?? 0) + 1
        requestCounts.set(sessionID, number)
        if (scenario === "auto") {
          if (number === 1) {
            // Intentionally immediate: this catches inbox/history races.
            text = "GOAL_QA_FIRST_TURN_COMPLETED_IMMEDIATELY"
          } else if (number === 2) {
            const update = tools.find((name) => name === "update_goal")
            if (!update) errors.push("automatic continuation omitted update_goal")
            else calls = [{ name: update, args: { status: "paused" } }]
          } else if (number === 4) {
            const update = tools.find((name) => name === "update_goal")
            if (!update) errors.push("resumed continuation omitted update_goal")
            else calls = [{ name: update, args: { status: "complete" } }]
          } else text = "GOAL_QA_AUTO_FLOW_FINISHED"
        } else if (scenario === "existing" && number === 1) {
          const update = tools.find((name) => name === "update_goal")
          if (!update) errors.push("existing goal turn omitted update_goal")
          else calls = [{ name: update, args: { status: "paused" } }]
        } else if (scenario === "child" && number === 1) {
          const task = tools.find((name) => name === "task")
          if (!task) errors.push("parent first turn omitted the OMO task tool")
          else calls = [{
            name: task,
            args: {
              subagent_type: "explore",
              description: "Goal auto-start child exclusion fixture",
              prompt: "GOAL_QA_CHILD_PROMPT Return GOAL_QA_CHILD_COMPLETED.",
              run_in_background: false,
            },
          }]
        } else if (scenario === "child" && number >= 2 && !childParentCompletionSent.has(sessionID)
          && existsSync(goalPath(project, sessionID))) {
          const update = tools.find((name) => name === "update_goal")
          if (update) {
            calls = [{ name: update, args: { status: "complete" } }]
            childParentCompletionSent.add(sessionID)
          }
        }
      }
      if (errors.length) {
        unexpectedRequests.push({ ...base, actionErrors: errors })
        requests.push({ ...base, responseAt: Date.now(), responseKind: "text" })
        return Response.json({ error: { message: "QA model action could not be satisfied", errors } }, { status: 403 })
      }
      const responseAt = Date.now()
      requests.push({ ...base, responseAt, responseKind: calls.length ? "tool" : "text" })
      return response(body, "goal-auto-" + (++mockIndex), model, text, calls)
    },
  })

  const projectConfig = {
    $schema: "https://opencode.ai/config.json",
    plugins: [probeDir, PLUGIN_DIR],
    enabled_providers: [PROVIDER],
    model: PROVIDER + "/" + MODEL,
    default_agent: "sisyphus",
    provider: {
      [PROVIDER]: {
        name: "Local goal auto-start QA mock",
        npm: "@ai-sdk/openai-compatible",
        options: { baseURL: "http://127.0.0.1:" + mock.port + "/v1", apiKey: API_KEY },
        models: { [MODEL]: { name: "Goal auto-start QA model", tool_call: true, limit: { context: 200_000, output: 8_192 } } },
      },
    },
    mcp: {},
    telemetry: false,
    permission: { read: "allow", grep: "allow", glob: "allow", task: "allow", subagent: "allow", background_output: "allow", edit: "deny", shell: "deny" },
  }
  const omoConfig = {
    telemetry: { enabled: false },
    "[opencode]": {
      telemetry: false,
      goal: { enabled: true, auto_start: false },
      default_mode: { goal: true },
      disabled_hooks: [],
      disabled_mcps: ["websearch", "context7", "grep_app", "lsp"],
      mcp_env_allowlist: [],
      claude_code: { mcp: false, agents: false, skills: false, commands: false, plugins: false, hooks: true },
      agents: {
        sisyphus: { model: PROVIDER + "/" + MODEL },
        explore: { model: PROVIDER + "/" + MODEL },
      },
    },
  }
  await writeFile(join(probeDir, "index.js"), originProbeSource("http://127.0.0.1:" + mock.port), "utf8")
  await writeFile(join(project, "opencode.json"), JSON.stringify(projectConfig, null, 2) + "\n", "utf8")
  await writeFile(join(project, ".omo", "omo.jsonc"), JSON.stringify(omoConfig, null, 2) + "\n", "utf8")
  await writeFile(rejectScript, [
    "#!/bin/sh",
    "input=$(cat)",
    "printf '%s\\n' \"$input\" >> " + quoteShell(hookLog),
    "case \"$input\" in",
    "  *GOAL_QA_REJECTED_FIRST_PROMPT*) printf '%s\\n' '{\"decision\":\"block\",\"reason\":\"GOAL_QA_REJECTED_BY_HOOK\"}'; exit 2 ;;",
    "esac",
    "exit 0",
    "",
  ].join("\n"), "utf8")
  await chmod(rejectScript, 0o755)
  await writeFile(join(project, ".claude", "settings.json"), JSON.stringify({
    hooks: { UserPromptSubmit: [{ matcher: "*", hooks: [{ type: "command", command: quoteShell(rejectScript) }] }] },
  }, null, 2) + "\n", "utf8")

  const env = {
    PATH: ["/tmp/omo-bun-runtime-1.4.2", "/usr/local/bin", "/opt/homebrew/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":"),
    TMPDIR: tempRoot,
    HOME: home,
    XDG_DATA_HOME: xdgData,
    XDG_CONFIG_HOME: xdgConfig,
    XDG_STATE_HOME: xdgState,
    XDG_CACHE_HOME: xdgCache,
    OPENCODE_DB: join(tempRoot, "opencode.db"),
    OMO_HOME: omoHome,
    CLAUDE_CONFIG_DIR: claudeHome,
    CLAUDE_PLUGINS_HOME: claudePlugins,
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_TELEMETRY_DISABLED: "1",
    OPENCODE_SERVER_PASSWORD: PASSWORD,
    OPENCODE_PASSWORD: PASSWORD,
  }
  const versionResult = Bun.spawnSync([CLI, "--version"], { cwd: project, env, stdout: "pipe", stderr: "pipe" })
  const version = new TextDecoder().decode(versionResult.stdout).trim()
  const checks: Check[] = []
  const nativeRoots: string[] = []
  const sessionEvidence: Record<string, unknown> = {}
  const sessionEvents: Array<Record<string, unknown>> = []
  let host: Host | undefined
  let eventAbort: AbortController | undefined
  let eventTask: Promise<void> | undefined
  let failure: unknown
  const startedAt = new Date().toISOString()
  try {
    addCheck(checks, "pinned OpenCode 2.0.18 CLI", versionResult.exitCode === 0 && version.includes("2.0.18"), version)
    await writeFile(join(EVIDENCE, "fixture-config-redacted.json"), JSON.stringify({
      opencode: {
        ...projectConfig,
        provider: { [PROVIDER]: { ...projectConfig.provider[PROVIDER], options: { baseURL: "localhost-only", apiKey: "[redacted-fake-key]" } } },
      },
      omo: omoConfig,
      claudePromptGate: "blocks only GOAL_QA_REJECTED_FIRST_PROMPT",
      bundle: { serverPath, serverSha256: serverHash, expectedServerSha256: EXPECTED_SHA },
    }, null, 2) + "\n")
    const serverPort = reservePort()
    const process = Bun.spawn([CLI, "--print-logs", "--log-level", "debug", "serve", "--hostname", "127.0.0.1", "--port", String(serverPort)], {
      cwd: project, env, stdout: "pipe", stderr: "pipe",
    })
    host = {
      port: serverPort,
      process,
      client: OpenCode.make({
        baseUrl: "http://127.0.0.1:" + serverPort,
        headers: { Authorization: basicAuth(), "x-opencode-directory": canonicalProject },
      }),
      stdout: "",
      stderr: "",
      stdoutTask: Promise.resolve(),
      stderrTask: Promise.resolve(),
    }
    host.stdoutTask = new Response(process.stdout as ReadableStream<Uint8Array>).text().then((text) => { host!.stdout = text })
    host.stderrTask = new Response(process.stderr as ReadableStream<Uint8Array>).text().then((text) => { host!.stderr = text })
    await waitForHost(host.client, process)
    const activation = await waitForActivation(host.client, process)
    addCheck(checks, "OMO and localhost-origin probe are active before prompts", true, activation)
    await preflight(host.client, canonicalProject, checks, "startup")
    eventAbort = new AbortController()
    eventTask = (async () => {
      try {
        for await (const event of host!.client.event.subscribe({ signal: eventAbort!.signal })) {
          if (event.type === "session.inbox.enqueued") {
            const item = event.data.item
            sessionEvents.push({
              type: event.type,
              sessionID: event.data.sessionID,
              inboxID: event.data.inboxID,
              at: Date.now(),
              itemType: item.type,
              marker: item.type === "user" && item.payload.text.includes("GOAL_QA_"),
            })
            if (item.type === "user") {
              inboxEvents.push({
                sessionID: event.data.sessionID,
                inboxID: event.data.inboxID,
                at: Date.now(),
                itemType: item.type,
                goalMarker: item.payload.text.includes("GOAL_QA_"),
              })
            }
          } else if (event.type === "session.created") {
            sessionEvents.push({
              type: event.type,
              sessionID: event.data.sessionID,
              parentID: event.data.parentID ?? null,
              at: Date.now(),
            })
          }
        }
      } catch (error) {
        if (!eventAbort?.signal.aborted) throw error
      }
    })()

    const createRoot = async (title: string, scenario: "auto" | "existing" | "child" | "blocked"): Promise<string> => {
      await preflight(host!.client, canonicalProject, checks, "before " + scenario)
      const session = await host!.client.session.create({ title, location: { directory: canonicalProject } })
      nativeRoots.push(session.id)
      roots.add(session.id)
      scenarios.set(session.id, scenario)
      await host!.client.session.switchAgent({ sessionID: session.id, agent: "sisyphus" })
      await host!.client.session.switchModel({ sessionID: session.id, model: { providerID: PROVIDER, id: MODEL } })
      const selected = await host!.client.session.get({ sessionID: session.id })
      assert(selected.location.directory === canonicalProject && selected.agent === "sisyphus"
        && selected.model?.providerID === PROVIDER && selected.model.id === MODEL && !selected.parentID,
      "Root session did not retain its isolated directory, agent, and local model")
      return session.id
    }

    const autoSessionID = await createRoot("First-admitted goal auto-start", "auto")
    const objective = "GOAL_QA_FIRST_ADMITTED_OBJECTIVE: verify a first-turn goal with an immediate model response."
    const firstRequestStart = requests.length
    const firstPromptAt = Date.now()
    await within("first admitted user prompt", host.client.session.prompt({ sessionID: autoSessionID, text: objective }))
    await within("first immediate model execution", host.client.session.wait({ sessionID: autoSessionID }))
    const firstRequest = requests.slice(firstRequestStart).find((item) => item.sessionID === autoSessionID && item.kind === "primary")
    console.log(JSON.stringify({
      phase: "first-native-result",
      evidence: EVIDENCE,
      sessionID: autoSessionID,
      submittedAt: firstPromptAt,
      requestAt: firstRequest?.receivedAt,
      immediateResponseAt: firstRequest?.responseAt,
      inboxEvent: inboxEvents.find((event) => event.sessionID === autoSessionID && event.goalMarker),
      requestErrors: firstRequest?.originErrors,
      requestGoalPromptVisible: firstRequest?.goalPromptVisible,
    }))
    addCheck(checks, "first model response was immediate and deterministic",
      Boolean(firstRequest && firstRequest.responseAt - firstRequest.receivedAt < 250),
      firstRequest ? { responseLatencyMs: firstRequest.responseAt - firstRequest.receivedAt } : "request missing")
    await waitFor("first admitted default goal", async () => (await readGoal(canonicalProject, autoSessionID))?.objective === objective)
    const activeGoal = await readGoal(canonicalProject, autoSessionID)
    addCheck(checks, "first admitted real user turn created its exact active goal",
      activeGoal?.objective === objective && activeGoal.status === "active",
      { sessionID: autoSessionID, goal: activeGoal })
    await waitFor("goal continuation pauses via update_goal", async () => (await readGoal(canonicalProject, autoSessionID))?.status === "paused", 25_000)
    await within("automatic goal continuation settled", host.client.session.wait({ sessionID: autoSessionID }))
    const pausedGoal = await readGoal(canonicalProject, autoSessionID)
    const autoRequests = requests.filter((item) => item.sessionID === autoSessionID && item.kind === "primary")
    addCheck(checks, "active goal produced a continuation and native update_goal paused it",
      pausedGoal?.status === "paused" && autoRequests.some((item) => item.goalPromptVisible && item.responseKind === "tool"),
      { goal: pausedGoal, primaryRequests: autoRequests })

    const pauseRequestCount = requests.length
    await within("public /goal pause", host.client.session.command({ sessionID: autoSessionID, name: "goal", text: "pause" }))
    const pauseInbox = await host.client.session.inbox.list({ sessionID: autoSessionID })
    addCheck(checks, "/goal pause is an immediate notice with no provider turn",
      requests.length === pauseRequestCount && pauseInbox.some((item) => item.type === "synthetic" && item.payload.text.includes("paused")),
      { requestsBefore: pauseRequestCount, requestsAfter: requests.length })

    const resumeIndex = requests.filter((item) => item.sessionID === autoSessionID && item.kind === "primary").length
    await within("public /goal resume", host.client.session.command({ sessionID: autoSessionID, name: "goal", text: "resume" }))
    await within("resumed goal execution", host.client.session.wait({ sessionID: autoSessionID }))
    const resumedRequests = requests.filter((item) => item.sessionID === autoSessionID && item.kind === "primary").slice(resumeIndex)
    const completedGoal = await readGoal(canonicalProject, autoSessionID)
    addCheck(checks, "resume dispatched goal work and completed the same goal",
      resumedRequests.some((item) => item.goalPromptVisible && item.responseKind === "tool")
        && completedGoal?.status === "complete" && completedGoal.id === activeGoal?.id,
      { requests: resumedRequests, goal: completedGoal })

    await within("post-completion follow-up", host.client.session.prompt({
      sessionID: autoSessionID,
      text: "GOAL_QA_AFTER_COMPLETION: preserve the original completed objective.",
    }))
    await within("post-completion turn settles", host.client.session.wait({ sessionID: autoSessionID }))
    const preservedGoal = await readGoal(canonicalProject, autoSessionID)
    addCheck(checks, "later input does not replace the durable original goal",
      preservedGoal !== undefined && preservedGoal.id === completedGoal?.id
        && preservedGoal.objective === objective && preservedGoal.status === "complete",
      { before: completedGoal, after: preservedGoal })

    const blockedSessionID = await createRoot("Rejected first prompt must not create goal", "blocked")
    let promptRejected = false
    let rejectError = ""
    const requestsBeforeReject = requests.length
    try {
      await within("blocked first prompt", host.client.session.prompt({
        sessionID: blockedSessionID,
        text: "GOAL_QA_REJECTED_FIRST_PROMPT must not start a goal or model request.",
      }))
    } catch (error) {
      promptRejected = true
      rejectError = error instanceof Error ? error.message : String(error)
    }
    await waitFor("project Claude UserPromptSubmit hook", async () => {
      try { return (await readFile(hookLog, "utf8")).includes("GOAL_QA_REJECTED_FIRST_PROMPT") } catch { return false }
    }, 10_000)
    await Bun.sleep(200)
    const rejectedGoal = await readGoal(canonicalProject, blockedSessionID)
    addCheck(checks, "blocked first prompt is rejected before goal creation", promptRejected && !rejectedGoal,
      { promptRejected, error: rejectError, goal: rejectedGoal })
    addCheck(checks, "blocked first prompt never reaches the local model",
      requests.length === requestsBeforeReject && !requests.some((item) => item.sessionID === blockedSessionID),
      { before: requestsBeforeReject, after: requests.length })

    const existingSessionID = await createRoot("Existing goal before first real prompt", "existing")
    await within("set goal before first real user prompt", host.client.session.command({
      sessionID: existingSessionID,
      name: "goal",
      text: "GOAL_QA_EXISTING_OBJECTIVE: preserve this already saved goal.",
    }))
    await within("existing goal initial command turn", host.client.session.wait({ sessionID: existingSessionID }))
    const beforeExistingInput = await readGoal(canonicalProject, existingSessionID)
    assert(beforeExistingInput, "Public goal command failed to create the pre-existing goal")
    await within("first real user after existing goal", host.client.session.prompt({
      sessionID: existingSessionID,
      text: "GOAL_QA_EXISTING_FIRST_USER: do not replace the goal already saved.",
    }))
    await within("existing goal user turn settles", host.client.session.wait({ sessionID: existingSessionID }))
    const afterExistingInput = await readGoal(canonicalProject, existingSessionID)
    addCheck(checks, "a pre-existing goal is preserved on the first real user turn",
      afterExistingInput?.id === beforeExistingInput.id && afterExistingInput.objective === beforeExistingInput.objective,
      { before: beforeExistingInput, after: afterExistingInput })

    const childParentID = await createRoot("Native child must not get a goal", "child")
    await within("parent first turn delegates to Explore", host.client.session.prompt({
      sessionID: childParentID,
      text: "GOAL_QA_CHILD_ROOT: delegate once to Explore, then finish.",
    }))
    await within("parent delegation turn settles", host.client.session.wait({ sessionID: childParentID }))
    const database = new Database(databasePath, { readonly: true, create: false })
    let childRows: Array<{ id: string; parentID: string; agent: string | null; model: string | null }>
    try {
      childRows = database.query(
        "SELECT id, parent_id AS parentID, agent, model FROM session_v2 WHERE parent_id = ? ORDER BY time_created",
      ).all(childParentID) as Array<{ id: string; parentID: string; agent: string | null; model: string | null }>
    } finally {
      database.close()
    }
    assert(childRows.length === 1, "Native task did not create exactly one child session")
    await waitFor("native child user inbox", async () =>
      inboxEvents.some((event) => event.sessionID === childRows[0]?.id && event.goalMarker), 10_000)
    await Bun.sleep(250)
    const childGoals = await Promise.all(childRows.map(async (child) => ({
      id: child.id,
      parentID: child.parentID,
      agent: child.agent,
      model: child.model,
      goal: await readGoal(canonicalProject, child.id),
    })))
    await waitFor("parent goal after first user", async () => Boolean(await readGoal(canonicalProject, childParentID)))
    const parentGoal = await readGoal(canonicalProject, childParentID)
    addCheck(checks, "native Explore child is correctly parented and uses local model",
      childRows.length === 1 && childRows[0]?.parentID === childParentID
        && childRows[0]?.agent === "explore" && childRows[0]?.model?.includes(MODEL) === true,
      childRows)
    addCheck(checks, "native child is excluded from default goal auto-start",
      childGoals.length === 1 && childGoals[0]?.goal === undefined,
      childGoals)
    addCheck(checks, "parent first input still receives its own goal",
      parentGoal?.objective.includes("GOAL_QA_CHILD_ROOT") === true,
      parentGoal)

    const firstInbox = inboxEvents.find((event) => event.sessionID === autoSessionID && event.goalMarker)
    const history = await host.client.message.list({ sessionID: autoSessionID })
    const historySummary = history.data.map((message) => {
      const row: Record<string, unknown> = isRecord(message) ? message : {}
      const info: Record<string, unknown> = isRecord(row.info) ? row.info : {}
      const text = contentText(row.parts ?? row.content ?? row.text ?? info.text ?? info.content)
      const time = isRecord(info.time) ? info.time : isRecord(row.time) ? row.time : {}
      const created = typeof time.created === "number"
        ? time.created
        : typeof info.created === "number" ? info.created
          : typeof row.created === "number" ? row.created : undefined
      return {
        id: typeof info.id === "string" ? info.id : typeof row.id === "string" ? row.id : undefined,
        role: typeof info.role === "string" ? info.role
          : typeof info.type === "string" ? info.type
            : typeof row.type === "string" ? row.type : undefined,
        created,
        hasFirstInput: text.includes(objective),
        hasImmediateResponse: text.includes("GOAL_QA_FIRST_TURN_COMPLETED_IMMEDIATELY"),
      }
    })
    const inputIndex = historySummary.findIndex((message) =>
      message.id === firstInbox?.inboxID && message.role === "user" && message.hasFirstInput)
    const responseIndex = historySummary.findIndex((message) =>
      message.role === "assistant" && message.hasImmediateResponse)
    const firstInputMessage = historySummary[inputIndex]
    const immediateResponseMessage = historySummary[responseIndex]
    addCheck(checks, "native history places first admitted user input before its immediate assistant response",
      inputIndex >= 0 && responseIndex >= 0 && responseIndex < inputIndex
        && typeof firstInputMessage?.created === "number"
        && typeof immediateResponseMessage?.created === "number"
        && firstInputMessage.created <= immediateResponseMessage.created,
      { input: firstInputMessage, immediateAssistant: immediateResponseMessage, newestFirstHistory: historySummary })
    addCheck(checks, "all model traffic has a validated local native-session origin",
      requests.length > 0 && requests.every((item) => item.originErrors.length === 0 && item.model === MODEL),
      requests.map((item) => ({
        sessionID: item.sessionID, parentID: item.parentID, agent: item.agent, kind: item.kind,
        role: item.role, model: item.model, originErrors: item.originErrors,
      })))
    addCheck(checks, "no unexpected provider paths or origins were attempted", unexpectedRequests.length === 0, unexpectedRequests)

    Object.assign(sessionEvidence, {
      firstTurn: {
        sessionID: autoSessionID,
        submittedAt: firstPromptAt,
        inboxEnqueuedAt: firstInbox?.at,
        inboxID: firstInbox?.inboxID,
        firstModelRequestAt: firstRequest?.receivedAt,
        immediateResponseAt: firstRequest?.responseAt,
        inboxPrecededModelRequest: firstInbox && firstRequest ? firstInbox.at <= firstRequest.receivedAt : undefined,
        goalPromptInFirstContext: firstRequest?.goalPromptVisible,
        initialActiveGoal: activeGoal,
        historyAfterFastExecution: historySummary,
      },
      autoContinuationRequests: autoRequests,
      completedGoal: preservedGoal,
      rejectedFirstInput: { sessionID: blockedSessionID, promptRejected, error: rejectError, goal: rejectedGoal },
      preExistingGoal: { sessionID: existingSessionID, before: beforeExistingInput, after: afterExistingInput },
      childExclusion: { parentSessionID: childParentID, parentGoal, children: childGoals },
      nativeRootSessions: nativeRoots,
    })
  } catch (error) {
    failure = error
  } finally {
    eventAbort?.abort()
    await eventTask?.catch(() => undefined)
    const serverExitCode = await stopProcess(host?.process)
    if (host) {
      await Promise.allSettled([host.stdoutTask, host.stderrTask])
      host.stdout = redact(host.stdout)
      host.stderr = redact(host.stderr)
      await Promise.all([
        writeFile(join(EVIDENCE, "server.stdout.log"), host.stdout),
        writeFile(join(EVIDENCE, "server.stderr.log"), host.stderr),
      ])
    }
    mock.stop(true)
    const output = {
      status: failure ? "failed" : "passed",
      ...(failure ? { failure: failure instanceof Error
        ? { name: failure.name, message: redact(failure.message), stack: redact(failure.stack ?? "") }
        : redact(String(failure)) } : {}),
      cli: CLI,
      version,
      bundle: { serverPath, serverSha256: serverHash, expectedSha: EXPECTED_SHA },
      startedAt,
      finishedAt: new Date().toISOString(),
      projectDirectory: canonicalProject,
      projectOutsideRepository: !canonicalProject.startsWith(ROOT + sep),
      databasePath,
      isolatedTempRoot: tempRoot,
      checks,
      sessions: sessionEvidence,
      requestSummaries: requests,
      inboxEvents,
      sessionEvents: sessionEvents.slice(0, 200),
      unexpectedRequests,
      cleanup: {
        openCodeExitCode: serverExitCode,
        mockProviderStopped: true,
        fixturePreserved: existsSync(tempRoot),
        evidenceDirectory: EVIDENCE,
      },
    }
    await writeFile(join(EVIDENCE, "runtime.json"), JSON.stringify(output, null, 2) + "\n")
    await writeFile(join(EVIDENCE, "summary.txt"), [
      "WHAT WAS TESTED: Immediate first-user default goal start; automatic continuation pause/resume/completion; rejected first input; existing goal preservation; native child exclusion.",
      "SAFETY: Pinned OpenCode 2.0.18 bundle, exact localhost-only provider/model/default/MCP preflight, isolated HOME/XDG/OMO/SQLite/project, fake credential only.",
      "TIMING: The initial model response is immediate (no artificial delay). runtime.json records the inbox event, provider request/response timestamps, and message history after execution.",
      "LIMIT: Deterministic localhost mock responses do not measure model quality. Full prompts and provider request bodies are not persisted.",
      "Evidence directory: " + EVIDENCE,
    ].join("\n") + "\n")
  }
  console.log(JSON.stringify({ status: failure ? "failed" : "passed", evidence: EVIDENCE, bundleSha256: serverHash, checks: checks.length }))
  if (failure) process.exitCode = 1
}

const inboxEvents: Array<{ sessionID: string; inboxID: string; at: number; itemType: string; goalMarker: boolean }> = []
await main()
