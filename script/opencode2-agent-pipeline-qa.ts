/**
 * Local-only native QA for the V2 builtin-agent conversation pipeline.
 *
 * Run only after the integrated OpenCode bundle is frozen:
 * OPENCODE2_CLI=/absolute/path/to/opencode \
 * OPENCODE2_EXPECTED_SERVER_SHA256=<64-hex-sha256> \
 * bun script/opencode2-agent-pipeline-qa.ts
 *
 * Optionally set OPENCODE2_QA_EVIDENCE_DIR to one direct child of .omo/evidence/.
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
const EVIDENCE = resolve(process.env.OPENCODE2_QA_EVIDENCE_DIR ?? join(EVIDENCE_ROOT, "20260927-agent-pipeline"))
const PLUGIN_DIR = resolve(process.env.OPENCODE2_PLUGIN_DIR ?? join(ROOT, "dist", "opencode2"))
const CLI_INPUT = process.env.OPENCODE2_CLI?.trim() ?? ""
const CLI = CLI_INPUT ? resolve(CLI_INPUT) : ""
const EXPECTED_SERVER_SHA256 = process.env.OPENCODE2_EXPECTED_SERVER_SHA256 ?? ""
const PASSWORD = "agent-pipeline-local-qa-only"
const API_KEY = "agent-pipeline-mock-key-only"
const PROVIDER = "omoqa"
const PROBE_ID = "omo-agent-pipeline-origin-probe"
const DEFAULT_MODEL = "gpt-5.5"
const MODELS = ["gpt-5.4", "gpt-5.5", "gpt-5.6", "gpt-4o", "claude-opus-4-8"] as const
const BUILTIN_AGENTS = [
  "sisyphus", "hephaestus", "prometheus", "atlas", "sisyphus-junior",
  "explore", "librarian", "oracle", "multimodal-looker", "metis", "momus",
] as const
const TIMEOUT_MS = 60_000
const SISYPHUS_SKILL = "qa-sisyphus-only"
const HEPHAESTUS_SKILL = "qa-hephaestus-only"
const SISYPHUS_SKILL_BODY = "SISYPHUS_PRIVATE_SKILL_BODY_DO_NOT_SHARE"
const HEPHAESTUS_SKILL_BODY = "HEPHAESTUS_PRIVATE_SKILL_BODY_DO_NOT_SHARE"

type ExpectedOrigin = { marker: string; agent: string; model: string }
type SessionOrigin = { id: string; parentID: string | null; directory: string; agent: string; model?: string }

type Check = { name: string; passed: boolean; detail?: unknown }
type CapturedRequest = {
  model: string
  originSessionID?: string
  originAgent?: string
  originKind?: string
  originProvider?: string
  originModel?: string
  originParentID?: string | null
  originValid: boolean
  originErrors: string[]
  marker?: string
  stream: boolean
  systemChars: number
  agentAppendMarkers: string[]
  systemHasSisyphusSkill: boolean
  systemHasHephaestusSkill: boolean
  systemHasSisyphusSkillBody: boolean
  systemHasHephaestusSkillBody: boolean
  hephaestus56Identity: boolean
  sisyphus54Identity: boolean
}
type Observation = {
  name: string
  selectedAgent: string
  expectedAgent: string
  selectedModel: string
  marker: string
  providerRequestFound: boolean
  providerModel?: string
  agentAppendFound: boolean
  systemHasSisyphusSkill: boolean
  systemHasHephaestusSkill: boolean
  systemHasSisyphusSkillBody: boolean
  systemHasHephaestusSkillBody: boolean
  originValid: boolean
  originSessionID?: string
  originAgent?: string
  originKind?: string
  originParentID?: string | null
  outcome?: string
  sessionID?: string
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

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function redact(value: string): string {
  return value
    .replaceAll(PASSWORD, "[redacted-test-password]")
    .replaceAll(API_KEY, "[redacted-test-api-key]")
}

function basicAuth(): string {
  return "Basic " + Buffer.from("opencode:" + PASSWORD).toString("base64")
}

function reservePort(): number {
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("reserved") })
  const port = reservation.port
  reservation.stop(true)
  assert(typeof port === "number", "Could not reserve an isolated localhost port")
  return port
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

function textOf(value: unknown): string {
  if (typeof value === "string") return value
  if (Array.isArray(value)) {
    return value.map((part) => isRecord(part) ? textOf(part.text ?? part.content) : "").filter(Boolean).join("\n")
  }
  if (isRecord(value)) {
    if (typeof value.text === "string") return value.text
    if (typeof value.content === "string") return value.content
    return ""
  }
  return ""
}

function requestMessages(body: Record<string, unknown>): Array<Record<string, unknown>> {
  return Array.isArray(body.messages) ? body.messages.filter(isRecord) : []
}

function systemText(body: Record<string, unknown>): string {
  return requestMessages(body)
    .filter((message) => message.role === "system" || message.role === "developer")
    .map((message) => textOf(message.content))
    .join("\n")
}

function userText(body: Record<string, unknown>): string {
  return requestMessages(body)
    .filter((message) => message.role === "user")
    .map((message) => textOf(message.content))
    .join("\n")
}

function streamedText(text: string, requestID: string, model: string): Response {
  const created = Math.floor(Date.now() / 1000)
  const chunks = [
    { id: "chatcmpl-" + requestID, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] },
    { id: "chatcmpl-" + requestID, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
  ]
  return new Response(chunks.map((chunk) => "data: " + JSON.stringify(chunk) + "\n\n").join("") + "data: [DONE]\n\n", {
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

function readSessionOrigin(databasePath: string, sessionID: string): SessionOrigin | undefined {
  if (!existsSync(databasePath)) return undefined
  try {
    const database = new Database(databasePath, { readonly: true, create: false })
    try {
      const row = database.query(`
        SELECT id, parent_id AS parentID, directory, agent, model
        FROM session_v2 WHERE id = ?
      `).get(sessionID) as {
        id?: string
        parentID?: string | null
        directory?: string
        agent?: string
        model?: string | Record<string, unknown> | null
      } | null
      if (!row || typeof row.id !== "string" || typeof row.directory !== "string" || typeof row.agent !== "string") return undefined
      let modelValue: unknown = row.model
      if (typeof modelValue === "string") {
        try { modelValue = JSON.parse(modelValue) } catch { modelValue = undefined }
      }
      return {
        id: row.id,
        parentID: row.parentID ?? null,
        directory: row.directory,
        agent: row.agent,
        model: modelRef(modelValue),
      }
    } finally {
      database.close()
    }
  } catch {
    return undefined
  }
}

function makeOriginProbeSource(): string {
  return [
    "export default {",
    "  id: " + JSON.stringify(PROBE_ID) + ",",
    "  async setup({ session }) {",
    "    const modelGuard = await session.hook('model.request', (event) => {",
    "      if (event.model.providerID !== " + JSON.stringify(PROVIDER) + " || !" + JSON.stringify(MODELS) + ".includes(event.model.id)) {",
    "        throw new Error('QA blocked a model request outside the local pipeline catalog')",
    "      }",
    "      if (![ 'primary', 'title', 'compaction', 'generate' ].includes(event.kind) || !" + JSON.stringify(BUILTIN_AGENTS) + ".includes(event.agent)) {",
    "        throw new Error('QA blocked an unknown model request origin')",
    "      }",
    "    })",
    "    const identity = await session.hook('http.request', (event) => {",
    "      const headers = new Headers(event.request.headers)",
    "      headers.set('x-omo-qa-session-id', event.sessionID)",
    "      headers.set('x-omo-qa-agent', event.agent)",
    "      headers.set('x-omo-qa-kind', event.kind)",
    "      headers.set('x-omo-qa-provider', event.model.providerID)",
    "      headers.set('x-omo-qa-model', event.model.id)",
    "      event.request = new Request(event.request, { headers })",
    "    })",
    "    return async () => { await Promise.all([identity.dispose(), modelGuard.dispose()]) }",
    "  },",
    "}",
    "",
  ].join("\n")
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

function modelRef(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined
  const providerID = value.providerID
  const modelID = value.id ?? value.modelID
  return typeof providerID === "string" && typeof modelID === "string" ? providerID + "/" + modelID : undefined
}

function addCheck(checks: Check[], name: string, passed: boolean, detail?: unknown): void {
  checks.push({ name, passed, ...(detail === undefined ? {} : { detail }) })
  assert(passed, name + " failed" + (detail === undefined ? "" : ": " + JSON.stringify(detail)))
}

async function waitForHost(host: Host): Promise<void> {
  await within("OpenCode HTTP readiness", (async () => {
    const deadline = Date.now() + 20_000
    while (Date.now() < deadline) {
      if (host.process.exitCode !== null) throw new Error("OpenCode exited before ready with code " + host.process.exitCode)
      try {
        await host.client.server.info()
        return
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 150))
      }
    }
    throw new Error("OpenCode server did not become ready")
  })(), 22_000)
}

async function waitForPluginAndAgents(host: Host): Promise<{ pluginStates: unknown[]; agentIDs: string[] }> {
  return within("OMO plugin and builtin agent activation", (async () => {
    const deadline = Date.now() + 40_000
    let pluginStates: unknown[] = []
    let agentIDs: string[] = []
    while (Date.now() < deadline) {
      if (host.process.exitCode !== null) throw new Error("OpenCode exited during plugin activation with code " + host.process.exitCode)
      const [plugins, agents] = await Promise.all([host.client.plugin.list(), host.client.agent.list()])
      pluginStates = plugins.data.map(({ id, state }) => ({ id, status: state.status }))
      agentIDs = agents.data.map((agent) => agent.id)
      const failed = plugins.data.find((plugin) => plugin.state.status === "failed")
      if (failed) throw new Error("Native plugin failed to load: " + JSON.stringify({ id: failed.id, state: failed.state }))
      if (plugins.data.some((plugin) => plugin.id === "oh-my-openagent" && plugin.state.status === "active")
        && plugins.data.some((plugin) => plugin.id === PROBE_ID && plugin.state.status === "active")
        && BUILTIN_AGENTS.every((name) => agentIDs.includes(name))) return { pluginStates, agentIDs }
      await new Promise((resolve) => setTimeout(resolve, 150))
    }
    throw new Error("OMO did not activate all builtin agents; agents=" + JSON.stringify(agentIDs) + ", plugins=" + JSON.stringify(pluginStates))
  })(), 42_000)
}

async function assertLocalPreflight(
  client: ReturnType<typeof OpenCode.make>,
  project: string,
  phase: string,
  checks: Check[],
): Promise<void> {
  const [providersResponse, modelsResponse, defaultResponse, mcpResponse] = await Promise.all([
    client.provider.list(),
    client.model.list(),
    client.model.default(),
    client.mcp.list(),
  ])
  const providers = providersResponse.data
  const models = modelsResponse.data.map((item) => item.providerID + "/" + item.id).sort()
  const defaultModel = modelRef(defaultResponse.data)
  const mcps = mcpResponse.data.map((item) => item.name).sort()
  const expectedModels = MODELS.map((id) => PROVIDER + "/" + id).sort()
  addCheck(checks, phase + ": only localhost mock provider is enabled",
    Array.isArray(providers) && providers.length === 1 && providers[0]?.id === PROVIDER,
    providers.map((provider) => provider.id))
  addCheck(checks, phase + ": exact local model catalog is active",
    JSON.stringify(models) === JSON.stringify(expectedModels), models)
  addCheck(checks, phase + ": native default model is local",
    defaultModel === PROVIDER + "/" + DEFAULT_MODEL, defaultModel)
  addCheck(checks, phase + ": no MCP server is active", Array.isArray(mcpResponse.data) && mcps.length === 0, mcps)
  assert(providersResponse.location.directory === project, phase + ": provider API resolved a different project directory")
}

async function waitForModelMarker(requests: CapturedRequest[], marker: string, start: number): Promise<CapturedRequest> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const request = requests.slice(start).find((entry) => entry.marker === marker)
    if (request) return request
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error("No localhost model request contained the expected user marker " + marker)
}

function skillRule(info: unknown, skillID: string, effect: string): boolean {
  if (!isRecord(info) || !Array.isArray(info.permissions)) return false
  return info.permissions.some((rule) =>
    isRecord(rule) && rule.action === "skill" && rule.resource === skillID && rule.effect === effect)
}

async function main(): Promise<void> {
  assert(CLI && existsSync(CLI), "Set OPENCODE2_CLI to an explicit absolute path to OpenCode 2.0.18")
  assert(isAbsolute(CLI_INPUT), "OPENCODE2_CLI must be absolute")
  assert(/^[a-f0-9]{64}$/i.test(EXPECTED_SERVER_SHA256), "Set OPENCODE2_EXPECTED_SERVER_SHA256 to the expected frozen bundle hash")
  const relativeEvidence = relative(EVIDENCE_ROOT, EVIDENCE)
  assert(relativeEvidence !== "" && relativeEvidence !== ".." && !relativeEvidence.startsWith(".." + sep)
    && !isAbsolute(relativeEvidence) && !relativeEvidence.includes(sep), "Evidence must be one direct child of " + EVIDENCE_ROOT)
  await mkdir(EVIDENCE_ROOT, { recursive: true })
  const canonicalEvidenceRoot = await realpath(EVIDENCE_ROOT)
  await mkdir(EVIDENCE, { recursive: true })
  const canonicalEvidence = await realpath(EVIDENCE)
  assert(dirname(canonicalEvidence) === canonicalEvidenceRoot, "Evidence path escaped its direct-child boundary")
  assert(existsSync(join(PLUGIN_DIR, "server.js")), "Native OpenCode bundle is absent at " + PLUGIN_DIR)
  const serverPath = join(PLUGIN_DIR, "server.js")
  const serverHash = createHash("sha256").update(await readFile(serverPath)).digest("hex")
  assert(serverHash === EXPECTED_SERVER_SHA256, "Bundle hash does not match the requested frozen artifact: " + serverHash)

  const tempRoot = await realpath(await mkdtemp(join(tmpdir(), "omo-agent-pipeline-qa-")))
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
  const claudeSettings = join(tempRoot, "claude-settings.json")
  const originProbeDirectory = join(tempRoot, "agent-pipeline-origin-probe")
  const databasePath = join(tempRoot, "opencode.db")
  await Promise.all([
    project, hostCwd, home, xdgData, xdgConfig, xdgState, xdgCache, omoHome, claudeHome, claudePlugins, originProbeDirectory,
    join(project, ".omo"), join(project, ".agents", "skills", SISYPHUS_SKILL), join(project, ".agents", "skills", HEPHAESTUS_SKILL),
  ].map((path) => mkdir(path, { recursive: true })))
  const canonicalProject = await realpath(project)
  assert(!canonicalProject.startsWith(ROOT + sep), "The QA project must be outside the repository")

  await writeFile(join(project, ".agents", "skills", SISYPHUS_SKILL, "SKILL.md"), [
    "---",
    "name: " + SISYPHUS_SKILL,
    "description: Native pipeline QA skill restricted to Sisyphus",
    "agent: sisyphus",
    "---",
    SISYPHUS_SKILL_BODY,
    "",
  ].join("\n"))
  await writeFile(join(project, ".agents", "skills", HEPHAESTUS_SKILL, "SKILL.md"), [
    "---",
    "name: " + HEPHAESTUS_SKILL,
    "description: Native pipeline QA skill restricted to Hephaestus",
    "agent: hephaestus",
    "---",
    HEPHAESTUS_SKILL_BODY,
    "",
  ].join("\n"))
  await writeFile(join(originProbeDirectory, "index.js"), makeOriginProbeSource(), "utf8")

  const mockRequests: CapturedRequest[] = []
  const expectedOrigins = new Map<string, ExpectedOrigin>()
  let requestSequence = 0
  const mock = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      if (url.pathname.endsWith("/models")) {
        return Response.json({ data: MODELS.map((id) => ({ id, object: "model", created: 0, owned_by: "local-qa" })) })
      }
      if (!url.pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 })
      const body = await request.json() as Record<string, unknown>
      const model = typeof body.model === "string" ? body.model : ""
      const sys = systemText(body)
      const users = userText(body)
      const originSessionID = request.headers.get("x-omo-qa-session-id") ?? undefined
      const originAgent = request.headers.get("x-omo-qa-agent") ?? undefined
      const originKind = request.headers.get("x-omo-qa-kind") ?? undefined
      const originProvider = request.headers.get("x-omo-qa-provider") ?? undefined
      const originModel = request.headers.get("x-omo-qa-model") ?? undefined
      const marker = originKind === "primary" ? users.match(/OMO_AGENT_PIPELINE_[A-Z0-9_]+/)?.[0] : undefined
      const expectedOrigin = originSessionID ? expectedOrigins.get(originSessionID) : undefined
      const sessionOrigin = originSessionID ? readSessionOrigin(databasePath, originSessionID) : undefined
      const originErrors: string[] = []
      if (!originSessionID || !expectedOrigin) originErrors.push("unregistered or missing session origin")
      if (!originAgent || !BUILTIN_AGENTS.includes(originAgent as (typeof BUILTIN_AGENTS)[number])) originErrors.push("unknown or missing agent origin")
      if (!originKind || !["primary", "title", "compaction", "generate"].includes(originKind)) originErrors.push("unknown or missing request kind")
      if (originProvider !== PROVIDER || originModel !== model || !MODELS.includes(originModel as (typeof MODELS)[number])) {
        originErrors.push("request hook model headers do not match the local provider body/catalog")
      }
      if (!sessionOrigin) originErrors.push("native session row was absent from isolated database")
      else {
        if (sessionOrigin.id !== originSessionID) originErrors.push("native session ID mismatch")
        if (sessionOrigin.parentID !== null) originErrors.push("direct pipeline fixture unexpectedly used a child session")
        if (sessionOrigin.directory !== canonicalProject) originErrors.push("native session directory escaped isolated project")
        if (sessionOrigin.agent !== originAgent) originErrors.push("request agent header differs from native session agent")
        if (expectedOrigin && sessionOrigin.model !== PROVIDER + "/" + expectedOrigin.model) {
          originErrors.push("native session selection differs from the expected primary model")
        }
      }
      if (expectedOrigin) {
        if (expectedOrigin.agent !== originAgent) originErrors.push("agent differs from expected effective primary agent")
        if (originKind === "primary" && expectedOrigin.model !== model) originErrors.push("primary model differs from expected session model")
        if (marker && marker !== expectedOrigin.marker) originErrors.push("prompt marker belongs to a different expected session")
      }
      const requestID = "agent-pipeline-" + (++requestSequence)
      mockRequests.push({
        model,
        ...(originSessionID ? { originSessionID } : {}),
        ...(originAgent ? { originAgent } : {}),
        ...(originKind ? { originKind } : {}),
        ...(originProvider ? { originProvider } : {}),
        ...(originModel ? { originModel } : {}),
        ...(sessionOrigin ? { originParentID: sessionOrigin.parentID } : {}),
        originValid: originErrors.length === 0,
        originErrors,
        ...(marker ? { marker } : {}),
        stream: body.stream === true,
        systemChars: sys.length,
        agentAppendMarkers: Array.from(sys.matchAll(/OMO_QA_AGENT_APPEND:([a-z0-9-]+)/g), (match) => match[1]!),
        systemHasSisyphusSkill: sys.includes(SISYPHUS_SKILL),
        systemHasHephaestusSkill: sys.includes(HEPHAESTUS_SKILL),
        systemHasSisyphusSkillBody: sys.includes(SISYPHUS_SKILL_BODY),
        systemHasHephaestusSkillBody: sys.includes(HEPHAESTUS_SKILL_BODY),
        hephaestus56Identity: sys.includes("You are Hephaestus, an autonomous deep worker based on GPT-5.6."),
        sisyphus54Identity: sys.includes("You are Sisyphus - an AI orchestrator from OhMyOpenCode."),
      })
      if (!MODELS.includes(model as (typeof MODELS)[number])) {
        return Response.json({ error: { message: "Model not in local QA catalog" } }, { status: 400 })
      }
      if (originErrors.length > 0) {
        return Response.json({ error: { message: "QA rejected unverified request origin", originErrors } }, { status: 403 })
      }
      return streamedText("AGENT_PIPELINE_QA_OK", requestID, model)
    },
  })

  const agentOverrides = Object.fromEntries(BUILTIN_AGENTS.map((name) => [
    name,
    {
      model: PROVIDER + "/" + DEFAULT_MODEL,
      prompt_append: "OMO_QA_AGENT_APPEND:" + name,
      ...(name === "sisyphus" ? { skills: [SISYPHUS_SKILL] } : {}),
      ...(name === "hephaestus" ? { skills: [HEPHAESTUS_SKILL] } : {}),
    },
  ]))
  const projectConfig = {
    $schema: "https://opencode.ai/config.json",
    plugins: [originProbeDirectory, PLUGIN_DIR],
    enabled_providers: [PROVIDER],
    model: PROVIDER + "/" + DEFAULT_MODEL,
    default_agent: "sisyphus",
    provider: {
      [PROVIDER]: {
        name: "Local agent pipeline QA mock",
        npm: "@ai-sdk/openai-compatible",
        options: { baseURL: "http://127.0.0.1:" + mock.port + "/v1", apiKey: API_KEY },
        models: Object.fromEntries(MODELS.map((id) => [
          id,
          { name: "Local QA " + id, tool_call: true, limit: { context: 200_000, output: 8_192 } },
        ])),
      },
    },
    mcp: {},
    telemetry: false,
    permission: { edit: "deny", shell: "deny", task: "deny", subagent: "deny" },
  }
  const omoProjectConfig = {
    telemetry: { enabled: false },
    "[opencode]": {
      telemetry: false,
      agents: agentOverrides,
      disabled_mcps: ["websearch", "context7", "grep_app", "lsp"],
      claude_code: { mcp: false, agents: false, skills: false, commands: false, plugins: false, hooks: false },
    },
  }
  await writeFile(join(project, "opencode.json"), JSON.stringify(projectConfig, null, 2) + "\n")
  await writeFile(join(project, ".omo", "omo.jsonc"), JSON.stringify(omoProjectConfig, null, 2) + "\n")

  const cliEnvironment = {
    PATH: ["/tmp/omo-bun-runtime-1.4.2", "/usr/local/bin", "/opt/homebrew/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":"),
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
  }
  const versionResult = Bun.spawnSync([CLI, "--version"], { cwd: hostCwd, env: cliEnvironment, stdout: "pipe", stderr: "pipe" })
  const version = new TextDecoder().decode(versionResult.stdout).trim()
  const checks: Check[] = []
  const observations: Observation[] = []
  const sessions: string[] = []
  let host: Host | undefined
  let failure: string | undefined
  const beforeSessionCount = countSessions(databasePath)
  const output: Record<string, unknown> = {
    runtime: version,
    gitHead: Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: ROOT, stdout: "pipe", stderr: "pipe" }).stdout.toString().trim(),
    bundle: { serverPath, serverSha256: serverHash, expectedServerSha256: EXPECTED_SERVER_SHA256 },
    cli: CLI,
    projectDirectory: canonicalProject,
    projectIsOutsideRepository: !canonicalProject.startsWith(ROOT + sep),
    isolatedTempRoot: tempRoot,
    databasePath,
    modelProvider: PROVIDER,
  }
  const startedAt = new Date().toISOString()
  const serverPort = reservePort()
  const serverCommand = [CLI, "--print-logs", "--log-level", "debug", "serve", "--hostname", "127.0.0.1", "--port", String(serverPort)]

  try {
    assert(versionResult.exitCode === 0 && version.includes("2.0.18"), "Expected pinned OpenCode 2.0.18; got " + version)
    const redactedProjectConfig = {
      ...projectConfig,
      provider: {
        [PROVIDER]: {
          ...projectConfig.provider[PROVIDER],
          options: { baseURL: "http://127.0.0.1:" + mock.port + "/v1", apiKey: "[redacted-fake-key]" },
        },
      },
    }
    await writeFile(join(EVIDENCE, "project-config-redacted.json"), JSON.stringify({
      opencode: redactedProjectConfig,
      omo: omoProjectConfig,
      skillIDs: [SISYPHUS_SKILL, HEPHAESTUS_SKILL],
    }, null, 2) + "\n")
    host = {
      port: serverPort,
      process: Bun.spawn(serverCommand, { cwd: hostCwd, env: cliEnvironment, stdout: "pipe", stderr: "pipe" }),
      client: OpenCode.make({
        baseUrl: "http://127.0.0.1:" + serverPort,
        headers: { Authorization: basicAuth(), "x-opencode-directory": canonicalProject },
      }),
      stdout: "",
      stderr: "",
      stdoutTask: Promise.resolve(),
      stderrTask: Promise.resolve(),
    }
    host.stdoutTask = new Response(host.process.stdout as ReadableStream<Uint8Array>).text().then((value) => { host!.stdout = value })
    host.stderrTask = new Response(host.process.stderr as ReadableStream<Uint8Array>).text().then((value) => { host!.stderr = value })
    await waitForHost(host)
    const activation = await waitForPluginAndAgents(host)
    addCheck(checks, "all 11 builtin agents are registered", BUILTIN_AGENTS.every((name) => activation.agentIDs.includes(name)), activation.agentIDs)
    addCheck(checks, "request-origin probe is active before prompts", activation.pluginStates.some((plugin) =>
      isRecord(plugin) && plugin.id === PROBE_ID && plugin.status === "active"), activation.pluginStates)

    const skillsResponse = await host.client.skill.list()
    assert(Array.isArray(skillsResponse.data), "Native skill list was not an array")
    const skillIDs = skillsResponse.data.map((skill) => skill.id)
    addCheck(checks, "both fixture skills loaded by the native registry",
      skillIDs.includes(SISYPHUS_SKILL) && skillIDs.includes(HEPHAESTUS_SKILL), skillIDs.filter((id) => id.startsWith("qa-")))

    const sisyphusAgent = (await host.client.agent.get({ agentID: "sisyphus" })).data
    const hephaestusAgent = (await host.client.agent.get({ agentID: "hephaestus" })).data
    addCheck(checks, "Sisyphus denies use of the Hephaestus-only skill",
      skillRule(sisyphusAgent, HEPHAESTUS_SKILL, "deny"), sisyphusAgent.permissions.filter((rule) => rule.action === "skill"))
    addCheck(checks, "Hephaestus denies use of the Sisyphus-only skill",
      skillRule(hephaestusAgent, SISYPHUS_SKILL, "deny"), hephaestusAgent.permissions.filter((rule) => rule.action === "skill"))

    const promptOne = async (input: {
      name: string
      model: string
      marker: string
      expectedAgent?: string
    }): Promise<{ sessionID: string; observation: Observation; request: CapturedRequest }> => {
      await assertLocalPreflight(host!.client, canonicalProject, "before " + input.marker, checks)
      const expectedAgent = input.expectedAgent ?? input.name
      const session = await host!.client.session.create({
        title: "Agent pipeline QA " + input.marker,
        location: { directory: canonicalProject },
      })
      sessions.push(session.id)
      assert(session.location.directory === canonicalProject, "Created session escaped the isolated project")
      await host!.client.session.switchAgent({ sessionID: session.id, agent: input.name })
      await host!.client.session.switchModel({ sessionID: session.id, model: { providerID: PROVIDER, id: input.model } })
      const selected = await host!.client.session.get({ sessionID: session.id })
      assert(selected.location.directory === canonicalProject, "Selected session changed its project directory")
      assert(!selected.parentID, "Direct agent-pipeline session unexpectedly has a parent: " + String(selected.parentID))
      assert(selected.agent === input.name, "Session did not select the requested agent: " + JSON.stringify({ requested: input.name, actual: selected.agent }))
      assert(selected.model?.providerID === PROVIDER && selected.model.id === input.model,
        "Session model was not pinned to the local QA catalog: " + JSON.stringify(selected.model))
      expectedOrigins.set(session.id, { marker: input.marker, agent: expectedAgent, model: input.model })
      const beforeRequests = mockRequests.length
      await within(input.marker + " prompt admission", host!.client.session.prompt({
        sessionID: session.id,
        text: input.marker + " Return the exact short response AGENT_PIPELINE_QA_OK.",
      }))
      await within(input.marker + " model completion", host!.client.session.wait({ sessionID: session.id }))
      const finalSession = await host!.client.session.get({ sessionID: session.id })
      const request = await waitForModelMarker(mockRequests, input.marker, beforeRequests)
      const observation: Observation = {
        name: input.name,
        selectedAgent: String(finalSession.agent ?? ""),
        expectedAgent,
        selectedModel: modelRef(finalSession.model) ?? "",
        marker: input.marker,
        providerRequestFound: request.marker === input.marker,
        providerModel: request.model,
        agentAppendFound: request.agentAppendMarkers.includes(expectedAgent),
        systemHasSisyphusSkill: request.systemHasSisyphusSkill,
        systemHasHephaestusSkill: request.systemHasHephaestusSkill,
        systemHasSisyphusSkillBody: request.systemHasSisyphusSkillBody,
        systemHasHephaestusSkillBody: request.systemHasHephaestusSkillBody,
        originValid: request.originValid,
        originSessionID: request.originSessionID,
        originAgent: request.originAgent,
        originKind: request.originKind,
        originParentID: request.originParentID,
        outcome: finalSession.outcome,
        sessionID: session.id,
      }
      observations.push(observation)
      addCheck(checks, input.marker + ": model request reached the local provider",
        observation.providerRequestFound && request.model === input.model, { observed: request.model, expected: input.model })
      addCheck(checks, input.marker + ": request origin matches its native session, agent, kind, and parent",
        observation.originValid && observation.originSessionID === session.id && observation.originAgent === expectedAgent
          && observation.originKind === "primary" && observation.originParentID === null,
        { sessionID: observation.originSessionID, expectedSessionID: session.id, agent: observation.originAgent, expectedAgent,
          kind: observation.originKind, parentID: observation.originParentID, originErrors: request.originErrors })
      addCheck(checks, input.marker + ": conversation completed under expected native agent",
        observation.selectedAgent === expectedAgent && observation.selectedModel === PROVIDER + "/" + input.model && observation.outcome === "succeeded",
        { agent: observation.selectedAgent, model: observation.selectedModel, outcome: observation.outcome, expectedAgent })
      addCheck(checks, input.marker + ": custom prompt append is preserved",
        request.agentAppendMarkers.includes(expectedAgent) && request.systemChars > 0,
        { expectedAgent, observedAppendAgents: request.agentAppendMarkers, systemChars: request.systemChars })
      if (expectedAgent === "sisyphus") {
        addCheck(checks, input.marker + ": only the Sisyphus dedicated skill body is present",
          request.systemHasSisyphusSkillBody && !request.systemHasHephaestusSkillBody,
          { sisyphusBody: request.systemHasSisyphusSkillBody, hephaestusBody: request.systemHasHephaestusSkillBody })
      } else if (expectedAgent === "hephaestus") {
        addCheck(checks, input.marker + ": only the Hephaestus dedicated skill body is present",
          request.systemHasHephaestusSkillBody && !request.systemHasSisyphusSkillBody,
          { sisyphusBody: request.systemHasSisyphusSkillBody, hephaestusBody: request.systemHasHephaestusSkillBody })
      }
      return { sessionID: session.id, observation, request }
    }

    for (const name of BUILTIN_AGENTS) {
      await promptOne({ name, model: DEFAULT_MODEL, marker: "OMO_AGENT_PIPELINE_" + name.toUpperCase().replaceAll("-", "_") })
    }

    const sisyphusDefault = observations.find((item) => item.marker === "OMO_AGENT_PIPELINE_SISYPHUS")
    const hephaestusDefault = observations.find((item) => item.marker === "OMO_AGENT_PIPELINE_HEPHAESTUS")
    addCheck(checks, "Sisyphus prompt lists its dedicated skill and excludes Hephaestus-only skill",
      sisyphusDefault?.systemHasSisyphusSkill === true && sisyphusDefault.systemHasHephaestusSkill === false
        && sisyphusDefault.systemHasSisyphusSkillBody === true && sisyphusDefault.systemHasHephaestusSkillBody === false,
      sisyphusDefault)
    addCheck(checks, "Hephaestus prompt lists its dedicated skill and excludes Sisyphus-only skill",
      hephaestusDefault?.systemHasHephaestusSkill === true && hephaestusDefault.systemHasSisyphusSkill === false
        && hephaestusDefault.systemHasHephaestusSkillBody === true && hephaestusDefault.systemHasSisyphusSkillBody === false,
      hephaestusDefault)

    const sisyphus54 = await promptOne({
      name: "sisyphus", model: "gpt-5.4", marker: "OMO_AGENT_PIPELINE_SISYPHUS_GPT54",
    })
    const hephaestus56 = await promptOne({
      name: "hephaestus", model: "gpt-5.6", marker: "OMO_AGENT_PIPELINE_HEPHAESTUS_GPT56",
    })
    addCheck(checks, "Sisyphus context uses its GPT-5.4 prompt family for the actual session model",
      sisyphus54.request.sisyphus54Identity, { systemChars: sisyphus54.request.systemChars, familyMarker: sisyphus54.request.sisyphus54Identity })
    addCheck(checks, "Hephaestus context uses its GPT-5.6 prompt for the actual session model",
      hephaestus56.request.hephaestus56Identity, { systemChars: hephaestus56.request.systemChars, familyMarker: hephaestus56.request.hephaestus56Identity })

    const sisyphusGenericGpt = await promptOne({
      name: "sisyphus", model: "gpt-4o", marker: "OMO_AGENT_PIPELINE_POLICY_SISYPHUS_GPT4O", expectedAgent: "hephaestus",
    })
    const hephaestusNonGpt = await promptOne({
      name: "hephaestus", model: "claude-opus-4-8", marker: "OMO_AGENT_PIPELINE_POLICY_HEPHAESTUS_CLAUDE", expectedAgent: "sisyphus",
    })
    addCheck(checks, "no-sisyphus-gpt redirects only the primary session agent",
      sisyphusGenericGpt.observation.selectedAgent === "hephaestus"
        && sisyphusGenericGpt.observation.selectedModel === PROVIDER + "/gpt-4o",
      { agent: sisyphusGenericGpt.observation.selectedAgent, model: sisyphusGenericGpt.observation.selectedModel })
    addCheck(checks, "no-hephaestus-non-gpt redirects only the primary session agent",
      hephaestusNonGpt.observation.selectedAgent === "sisyphus"
        && hephaestusNonGpt.observation.selectedModel === PROVIDER + "/claude-opus-4-8",
      { agent: hephaestusNonGpt.observation.selectedAgent, model: hephaestusNonGpt.observation.selectedModel })

    const finalSessionCount = countSessions(databasePath)
    addCheck(checks, "all OMO conversation sessions remain in the isolated database",
      beforeSessionCount === 0 && finalSessionCount === sessions.length,
      { beforeSessionCount, finalSessionCount, expectedSessions: sessions.length })
    addCheck(checks, "all provider requests used the exact local model catalog",
      mockRequests.length >= sessions.length && mockRequests.every((request) => MODELS.includes(request.model as (typeof MODELS)[number])),
      mockRequests.map(({ model, marker }) => ({ model, marker }))
    )

    Object.assign(output, {
      status: "passed",
      checks,
      observations,
      modelCatalog: MODELS.map((id) => PROVIDER + "/" + id).sort(),
      nativeSessionIDs: sessions,
      mockRequestSummaries: mockRequests,
      sessionCountBefore: beforeSessionCount,
      sessionCountAfter: finalSessionCount,
      localOnly: true,
      noFullPromptBodiesPersisted: true,
    })
  } catch (error) {
    failure = error instanceof Error ? error.stack ?? error.message : String(error)
    Object.assign(output, { status: "failed", failure, checks, observations, mockRequestSummaries: mockRequests })
  } finally {
    const serverExitCode = await stopProcess(host?.process)
    if (host) {
      await Promise.allSettled([host.stdoutTask, host.stderrTask])
      host.stdout = redact(host.stdout)
      host.stderr = redact(host.stderr)
      await writeFile(join(EVIDENCE, "server.stdout.log"), host.stdout)
      await writeFile(join(EVIDENCE, "server.stderr.log"), host.stderr)
    }
    mock.stop(true)
    const finalCount = countSessions(databasePath)
    Object.assign(output, {
      ...(output.status === undefined ? { status: failure ? "failed" : "passed" } : {}),
      finishedAt: new Date().toISOString(),
      startedAt,
      checks,
      observations,
      mockRequestSummaries: mockRequests,
      databasePath,
      sessionCountBefore: beforeSessionCount,
      sessionCountAfter: finalCount,
      cleanup: { serverExitCode, mockStopped: true, tempRootPreserved: existsSync(tempRoot), retainedProject: canonicalProject },
    })
    await writeFile(join(EVIDENCE, "runtime.json"), JSON.stringify(output, null, 2) + "\n")
    await writeFile(join(EVIDENCE, "summary.txt"), [
      "WHAT WAS TESTED: Native OpenCode 2.0.18 direct primary conversations for all eleven OMO builtin agents, actual model-family prompt rendering, per-agent skill-body isolation, and primary model-policy redirects.",
      "REQUEST ORIGIN: A temporary observer tags native session, agent, model, and request kind; the localhost mock cross-checks these against the expected prompt and isolated native session row, including parent ID.",
      "SCOPE LIMIT: This driver does not claim cross-agent delegation coverage; that is covered by separate delegation/workflow QA receipts.",
      "WHAT WAS OBSERVED: See runtime.json for pass/fail checks and sanitized request summaries; see server.stdout.log and server.stderr.log for redacted host diagnostics.",
      "WHY IT IS ENOUGH: Every prompt is sent only after exact localhost-only provider/model/default/MCP preflight; the project and database are isolated outside the repository.",
      "WHAT WAS OMITTED: Full system prompts, request bodies, credentials, and real user data are not persisted.",
      "Evidence directory: " + EVIDENCE,
    ].join("\n") + "\n")
  }
  console.log(JSON.stringify({ status: output.status, evidence: EVIDENCE, bundleSha256: serverHash, checks: checks.length }))
  if (failure) process.exitCode = 1
}

await main()
