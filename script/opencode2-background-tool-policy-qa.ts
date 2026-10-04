import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { Database, type SQLQueryBindings } from "bun:sqlite"
import { OpenCode } from "@opencode/client"
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises"
import { isAbsolute, join, resolve } from "node:path"
import { tmpdir } from "node:os"

const ROOT = resolve(import.meta.dir, "..")
const EVIDENCE_ROOT = resolve(
  process.env.OPENCODE2_BACKGROUND_POLICY_EVIDENCE_DIR ??
    join(ROOT, ".omo", "evidence", "20260927-opencode2-background-tool-policy"),
)
const PLUGIN_DIR = resolve(process.env.OPENCODE2_PLUGIN_DIR ?? join(ROOT, "dist", "opencode2"))
const OPENCODE_BIN = process.env.OPENCODE2_CLI?.trim() ?? ""
const EXPECTED_BUNDLE_SHA256 = process.env.OPENCODE2_EXPECTED_BUNDLE_SHA256 ?? ""
const EXPECTED_VERSION = "2.0.22"
const EXPECTED_PROVIDER = "omoqa"
const EXPECTED_MODEL_ID = "background-policy-qa-model"
const EXPECTED_MODEL = EXPECTED_PROVIDER + "/" + EXPECTED_MODEL_ID
const PLUGIN_ID = "oh-my-openagent"
const PROBE_ID = "omo-background-tool-policy-qa-probe"
const PASSWORD = "omo-background-policy-qa-only-password"
const API_KEY = "omo-background-policy-qa-only-fake-key"
const CHILD_AGENT = "sisyphus-junior"
const POLICY_KEY_PREFIX = "oh-my-openagent:v2:background-tool-policy:"
const PLUGIN_STORAGE_PREFIX =
  "plugin:" +
  PLUGIN_ID.split("").map((character) => character.charCodeAt(0).toString(16).padStart(4, "0")).join("") +
  ":"

type CaseName = "probe" | "alias_repeat" | "native_changed" | "native_hardcap" | "parent_shell"
type LaunchTool = "task" | "subagent" | "bash"
type ToolCall = { readonly name: string; readonly input: Record<string, unknown> }
type ChildPlan = {
  readonly launchTool: "task" | "subagent"
  readonly marker: string
  readonly commands: readonly string[]
  sent: boolean
}

type ParentPlan = {
  readonly sessionID: string
  readonly caseName: CaseName
  launchTool?: LaunchTool
  childPromptMarker?: string
  parentCommands?: readonly string[]
  launchSent: boolean
  parentToolCalls: number
  activeChild?: ChildPlan
  follower?: ChildPlan
  followups: Array<{ at: number; childMarkerPresent: boolean; route: string }>
  readonly childRequests: Map<string, number>
}

type ProviderObservation = {
  readonly at: number
  readonly sessionID: string
  readonly parentID?: string
  readonly agent?: string
  readonly model?: string
  readonly wireModel: string
  readonly kind: string
  readonly requestNumber: number
  readonly route: string
  readonly toolCall?: string
  readonly toolIndex?: number
  readonly childPromptMarkerPresent: boolean
}

type SessionRow = { id: string; parentID?: string; agent?: string }

type PolicyState = {
  readonly sessionID?: string
  readonly toolCalls?: number
  readonly consecutiveCount?: number
  readonly lastTrigger?: {
    readonly type?: string
    readonly tool?: string
    readonly count?: number
    readonly limit?: number
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function dataOf(value: unknown): unknown {
  if (isRecord(value) && "data" in value) return value.data
  return value
}

function modelRef(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined
  return typeof value.providerID === "string" && typeof value.id === "string"
    ? value.providerID + "/" + value.id
    : undefined
}

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex")
}

function redact(value: string): string {
  return value.replaceAll(PASSWORD, "[redacted-qa-password]").replaceAll(API_KEY, "[redacted-fake-api-key]")
}

function basicAuth(): string {
  return "Basic " + Buffer.from("opencode:" + PASSWORD).toString("base64")
}

function shellQuote(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'"
}

function appendLineCommand(file: string, line: string): string {
  return "printf '" + line.replaceAll("'", "'\\''") + "\\n' >> " + shellQuote(file)
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

function requestBodyText(body: Record<string, unknown>): string {
  return Array.isArray(body.messages) ? JSON.stringify(body.messages) : ""
}

function toolCallResponse(call: ToolCall, id: string, model: string, streaming: boolean): Response {
  const created = Math.floor(Date.now() / 1000)
  const toolCall = {
    index: 0,
    id,
    type: "function",
    function: { name: call.name, arguments: JSON.stringify(call.input) },
  }
  if (!streaming) {
    return Response.json({
      id: "chatcmpl-" + id,
      object: "chat.completion",
      created,
      model,
      choices: [{ index: 0, message: { role: "assistant", content: null, tool_calls: [toolCall] }, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 },
    })
  }
  const chunks = [
    {
      id: "chatcmpl-" + id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta: { role: "assistant", tool_calls: [toolCall] }, finish_reason: null }],
    },
    {
      id: "chatcmpl-" + id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
    },
  ]
  return new Response(
    chunks.map((chunk) => "data: " + JSON.stringify(chunk) + "\n\n").join("") + "data: [DONE]\n\n",
    { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" } },
  )
}

function textResponse(text: string, id: string, model: string, streaming: boolean): Response {
  const created = Math.floor(Date.now() / 1000)
  if (!streaming) {
    return Response.json({
      id: "chatcmpl-" + id,
      object: "chat.completion",
      created,
      model,
      choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
      usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
    })
  }
  const chunks = [
    {
      id: "chatcmpl-" + id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }],
    },
    {
      id: "chatcmpl-" + id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    },
  ]
  return new Response(
    chunks.map((chunk) => "data: " + JSON.stringify(chunk) + "\n\n").join("") + "data: [DONE]\n\n",
    { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" } },
  )
}

async function within<T>(label: string, promise: Promise<T>, timeoutMs = 90_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(label + " timed out after " + timeoutMs + "ms.")), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function waitForServer(client: ReturnType<typeof OpenCode.make>, process: Bun.Subprocess): Promise<void> {
  const deadline = Date.now() + 30_000
  let lastError: unknown
  while (Date.now() < deadline) {
    if (process.exitCode !== null) throw new Error("OpenCode exited before server readiness (code " + process.exitCode + ").")
    try {
      await client.server.info()
      return
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 150))
    }
  }
  throw new Error("OpenCode server did not become ready: " + (lastError instanceof Error ? lastError.message : String(lastError)))
}

async function stopProcess(process: Bun.Subprocess | undefined): Promise<boolean> {
  if (!process) return true
  if (process.exitCode !== null) return true
  process.kill("SIGTERM")
  const graceful = await Promise.race([
    process.exited.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5_000)),
  ])
  if (graceful) return true
  if (process.exitCode === null) process.kill("SIGKILL")
  await process.exited
  return process.exitCode !== null
}

function readOnlyRows(databasePath: string, sql: string, ...args: SQLQueryBindings[]): unknown[] {
  if (!existsSync(databasePath)) return []
  const database = new Database(databasePath, { readonly: true, create: false })
  try {
    return database.query(sql).all(...args)
  } finally {
    database.close()
  }
}

function projectSessions(databasePath: string, directory: string, parentID: string): SessionRow[] {
  return readOnlyRows(
    databasePath,
    "SELECT id, parent_id AS parentID, agent FROM session_v2 WHERE directory = ? AND parent_id = ? ORDER BY time_created ASC",
    directory,
    parentID,
  ) as SessionRow[]
}

function parseSqlValue(value: unknown): unknown {
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as unknown
    } catch {
      return value
    }
  }
  if (value instanceof Uint8Array) {
    try {
      return JSON.parse(new TextDecoder().decode(value)) as unknown
    } catch {
      return value
    }
  }
  return value
}

function storedPolicyStates(databasePath: string): PolicyState[] {
  const prefix = PLUGIN_STORAGE_PREFIX + POLICY_KEY_PREFIX
  const rows = readOnlyRows(databasePath, "SELECT key, value FROM kv WHERE key LIKE ?", prefix + "%") as Array<{
    key?: string
    value?: unknown
  }>
  return rows.flatMap((row) => {
    const value = parseSqlValue(row.value)
    return isRecord(value) && typeof value.sessionID === "string" ? [value as PolicyState] : []
  })
}

function fileLines(path: string): string[] {
  if (!existsSync(path)) return []
  return readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean)
}

function sessionDirectory(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined
  const location = value.location
  if (!isRecord(location) || typeof location.directory !== "string") return undefined
  return resolve(location.directory)
}

function sessionOutcome(value: unknown): string | undefined {
  return isRecord(value) && typeof value.outcome === "string" ? value.outcome : undefined
}

function makeProbeSource(): string {
  return [
    "export default {",
    "  id: " + JSON.stringify(PROBE_ID) + ",",
    "  async setup(ctx) {",
    "    const modelGuard = await ctx.session.hook('model.request', (event) => {",
    "      if (event.model.providerID !== " + JSON.stringify(EXPECTED_PROVIDER) + " || event.model.id !== " + JSON.stringify(EXPECTED_MODEL_ID) + ") {",
    "        throw new Error('QA stopped a non-local model request before provider dispatch')",
    "      }",
    "    })",
    "    const identity = await ctx.session.hook('http.request', (event) => {",
    "      const headers = new Headers(event.request.headers)",
    "      headers.set('x-omo-qa-session-id', event.sessionID)",
    "      headers.set('x-omo-qa-kind', event.kind)",
    "      event.request = new Request(event.request, { headers })",
    "    })",
    "    return async () => { await Promise.all([identity.dispose(), modelGuard.dispose()]) }",
    "  },",
    "}",
    "",
  ].join("\n")
}

function exactCatalogRecord(models: readonly unknown[], defaultModel: unknown, providersValue: unknown): Record<string, unknown> {
  const refs = models.map((model) => modelRef(model)).filter((ref): ref is string => Boolean(ref)).sort()
  const defaultRef = modelRef(defaultModel)
  const providers = Array.isArray(providersValue)
    ? providersValue.flatMap((provider) => isRecord(provider) && typeof provider.id === "string" ? [provider.id] : [])
    : []
  return { models: refs, defaultModel: defaultRef ?? null, providers: providers.sort() }
}

async function assertLocalCatalog(
  client: ReturnType<typeof OpenCode.make>,
  phase: string,
  evidence: Array<Record<string, unknown>>,
): Promise<void> {
  const [modelsResponse, defaultResponse, providerResponse, mcpResponse] = await Promise.all([
    client.model.list(),
    client.model.default(),
    client.provider.list(),
    client.mcp.list(),
  ])
  const models = ((modelsResponse as unknown as { data?: unknown[] }).data ?? []) as unknown[]
  const defaultModel = dataOf(defaultResponse)
  const providers = dataOf(providerResponse)
  const mcpValue = dataOf(mcpResponse)
  const catalog = exactCatalogRecord(models, defaultModel, providers)
  const mcpIsArray = Array.isArray(mcpValue)
  const mcpEntries = mcpIsArray ? mcpValue : []
  const valid =
    JSON.stringify(catalog.models) === JSON.stringify([EXPECTED_MODEL]) &&
    catalog.defaultModel === EXPECTED_MODEL &&
    Array.isArray(providers) &&
    JSON.stringify(catalog.providers) === JSON.stringify([EXPECTED_PROVIDER]) &&
    mcpIsArray && mcpEntries.length === 0
  evidence.push({
    phase,
    ...catalog,
    mcpServers: mcpEntries.flatMap((server) => isRecord(server) && typeof server.name === "string" ? [server.name] : []),
    valid,
  })
  if (!valid) throw new Error("Local-only catalog preflight failed at " + phase + ": " + JSON.stringify(evidence.at(-1)))
}

async function waitForPluginActivation(
  client: ReturnType<typeof OpenCode.make>,
  process: Bun.Subprocess,
): Promise<{ pluginList: unknown[]; agents: unknown[]; activeIds: string[]; childAgent: unknown; pollCount: number; readyAfterMs: number }> {
  const startedAt = Date.now()
  const deadline = Date.now() + 30_000
  let lastPlugins: unknown[] = []
  let lastAgents: unknown[] = []
  let pollCount = 0
  while (Date.now() < deadline) {
    if (process.exitCode !== null) throw new Error("OpenCode exited during plugin activation.")
    pollCount += 1
    const [pluginResponse, agentsResponse] = await Promise.all([client.plugin.list(), client.agent.list()])
    const pluginValue = dataOf(pluginResponse)
    const agentsValue = dataOf(agentsResponse)
    if (!Array.isArray(pluginValue) || !Array.isArray(agentsValue)) {
      throw new Error("Native plugin/agent registry returned an unexpected response shape during startup.")
    }
    lastPlugins = pluginValue
    lastAgents = agentsValue
    const failedPlugins = lastPlugins.filter((plugin) => isRecord(plugin) && isRecord(plugin.state) && plugin.state.status === "failed")
    if (failedPlugins.length) throw new Error("Native plugin setup failed: " + JSON.stringify(failedPlugins))
    const activeIds = lastPlugins.flatMap((plugin) =>
      isRecord(plugin) && typeof plugin.id === "string" && isRecord(plugin.state) && plugin.state.status === "active"
        ? [plugin.id]
        : [],
    )
    const childAgent = lastAgents.find((agent) => isRecord(agent) && agent.id === CHILD_AGENT)
    if (
      activeIds.includes(PROBE_ID) &&
      activeIds.includes(PLUGIN_ID) &&
      childAgent &&
      modelRef((childAgent as Record<string, unknown>).model) === EXPECTED_MODEL
    ) {
      return { pluginList: lastPlugins, agents: lastAgents, activeIds, childAgent, pollCount, readyAfterMs: Date.now() - startedAt }
    }
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  const activeIds = lastPlugins.flatMap((plugin) =>
    isRecord(plugin) && typeof plugin.id === "string" && isRecord(plugin.state) && plugin.state.status === "active"
      ? [plugin.id]
      : [],
  )
  throw new Error("Native OMO/probe plugins and configured child agent did not activate: " + JSON.stringify({
    activeIds,
    agentIDs: lastAgents.flatMap((agent) => isRecord(agent) && typeof agent.id === "string" ? [agent.id] : []),
  }))
}

async function assertSessionScope(
  client: ReturnType<typeof OpenCode.make>,
  sessionID: string,
  projectID: string,
  projectDirectory: string,
  phase: string,
): Promise<Record<string, unknown>> {
  const info = await client.session.get({ sessionID })
  const actual = {
    id: info.id,
    parentID: info.parentID,
    projectID: info.projectID,
    agent: info.agent,
    model: modelRef(info.model),
    directory: sessionDirectory(info),
  }
  if (
    actual.id !== sessionID ||
    actual.projectID !== projectID ||
    actual.directory !== projectDirectory ||
    actual.model !== EXPECTED_MODEL
  ) {
    throw new Error("Session failed local project/model preflight at " + phase + ": " + JSON.stringify(actual))
  }
  return actual
}

function shellPermissionRules(commands: readonly string[]): Array<{ action: string; resource: string; effect: "allow" | "deny" }> {
  const exactCommands = [...new Set(commands)]
  return [
    { action: "shell", resource: "*", effect: "deny" },
    ...exactCommands.map((command) => ({ action: "shell", resource: command, effect: "allow" as const })),
    { action: "task", resource: "*", effect: "allow" },
    { action: "subagent", resource: CHILD_AGENT, effect: "allow" },
  ]
}

function childLaunchCall(plan: ChildPlan): ToolCall {
  const prompt = plan.marker + ": make only the requested exact shell calls, then return a short final response."
  if (plan.launchTool === "task") {
    return {
      name: "task",
      input: {
        description: "Local background policy QA",
        prompt,
        subagent_type: CHILD_AGENT,
        run_in_background: true,
      },
    }
  }
  return {
    name: "subagent",
    input: {
      agent: CHILD_AGENT,
      description: "Local background policy QA",
      prompt,
      background: true,
    },
  }
}

async function waitForChild(
  databasePath: string,
  directory: string,
  parentID: string,
  timeoutMs = 25_000,
  exclude: ReadonlySet<string> = new Set(),
): Promise<SessionRow> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const rows = projectSessions(databasePath, directory, parentID).filter((row) => !exclude.has(row.id))
    if (rows.length > 1) throw new Error("Expected one native child, found " + rows.length + " under " + parentID)
    if (rows.length === 1) return rows[0]!
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error("Native child session did not appear for parent " + parentID)
}

async function waitForPolicyState(
  databasePath: string,
  sessionID: string,
  predicate: (state: PolicyState | undefined) => boolean,
  timeoutMs = 35_000,
): Promise<PolicyState | undefined> {
  const deadline = Date.now() + timeoutMs
  let latest: PolicyState | undefined
  while (Date.now() < deadline) {
    latest = storedPolicyStates(databasePath).find((state) => state.sessionID === sessionID)
    if (predicate(latest)) return latest
    await new Promise((resolve) => setTimeout(resolve, 60))
  }
  throw new Error("Persisted background policy state did not reach its expected condition for " + sessionID + ": " + JSON.stringify(latest))
}

async function waitForParentAck(
  plan: ParentPlan,
  after: number,
  requireMarker: boolean,
  timeoutMs = 8_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (plan.followups.some((item) => item.at >= after && item.route === "parent_ack" && (!requireMarker || item.childMarkerPresent))) return
    await new Promise((resolve) => setTimeout(resolve, 60))
  }
  throw new Error("Parent follow-up was not plainly acknowledged by its actual session identity: " + JSON.stringify(plan.followups))
}

async function waitForSessionIdle(client: ReturnType<typeof OpenCode.make>, sessionID: string, label: string): Promise<void> {
  await within(label, client.session.wait({ sessionID }), 45_000)
}

async function runHostAttempt(
  attemptName: "repeat-enabled" | "repeat-disabled-hardcap",
  evidenceDirectory: string,
  cases: readonly CaseName[],
): Promise<Record<string, unknown>> {
  const evidence = join(evidenceDirectory, attemptName)
  await mkdir(evidence, { recursive: true })
  const tempRoot = await realpath(await mkdtemp(join(tmpdir(), "omo-background-policy-qa-")))
  const project = join(tempRoot, "project")
  const home = join(tempRoot, "home")
  const xdgData = join(tempRoot, "xdg-data")
  const xdgConfig = join(tempRoot, "xdg-config")
  const xdgState = join(tempRoot, "xdg-state")
  const xdgCache = join(tempRoot, "xdg-cache")
  const omoHome = join(tempRoot, "omo-home")
  const databasePath = join(tempRoot, "opencode.db")
  const outputDirectory = join(project, ".qa-output")
  await Promise.all([project, home, xdgData, xdgConfig, xdgState, xdgCache, omoHome, outputDirectory].map((path) => mkdir(path, { recursive: true })))
  const env = {
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    TMPDIR: tempRoot,
    HOME: home,
    XDG_DATA_HOME: xdgData,
    XDG_CONFIG_HOME: xdgConfig,
    XDG_STATE_HOME: xdgState,
    XDG_CACHE_HOME: xdgCache,
    OPENCODE_DB: databasePath,
    OMO_HOME: omoHome,
    CLAUDE_CONFIG_DIR: join(home, ".claude"),
    CLAUDE_HOME: join(home, ".claude"),
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_TELEMETRY_DISABLED: "1",
    OPENCODE_SERVER_PASSWORD: PASSWORD,
    OPENCODE_PASSWORD: PASSWORD,
  }
  const canonicalProject = await realpath(project)
  const outFiles = {
    alias_repeat: join(outputDirectory, "alias-repeat.txt"),
    native_changed: join(outputDirectory, "native-changed.txt"),
    native_hardcap: join(outputDirectory, "native-hardcap.txt"),
    native_hardcap_follower: join(outputDirectory, "native-hardcap-follower.txt"),
    parent_shell: join(outputDirectory, "parent-shell.txt"),
  }
  await Promise.all(Object.values(outFiles).map((path) => writeFile(path, "", "utf8")))

  const aliasRepeatedCommand = appendLineCommand(outFiles.alias_repeat, "alias-repeat")
  const changedA = appendLineCommand(outFiles.native_changed, "changed-a")
  const changedB = appendLineCommand(outFiles.native_changed, "changed-b")
  const hardcapCommands = Array.from({ length: 10 }, (_unused, index) =>
    appendLineCommand(outFiles.native_hardcap, "hardcap-" + String(index + 1).padStart(2, "0")),
  )
  const followerCommand = appendLineCommand(outFiles.native_hardcap_follower, "follower-after-interrupt")
  const parentCommand = appendLineCommand(outFiles.parent_shell, "unmanaged-parent")
  const parentCommands = Array.from({ length: 6 }, () => parentCommand)
  const exactCommands = [
    aliasRepeatedCommand,
    changedA,
    changedB,
    ...hardcapCommands,
    followerCommand,
    ...parentCommands,
  ]
  const projectConfig = {
    $schema: "https://opencode.ai/config.json",
    plugins: [PLUGIN_DIR, join(project, ".qa-plugin")],
    enabled_providers: [EXPECTED_PROVIDER],
    model: EXPECTED_MODEL,
    default_agent: "sisyphus",
    provider: {
      [EXPECTED_PROVIDER]: {
        name: "OMO background policy isolated localhost provider",
        npm: "@ai-sdk/openai-compatible",
        options: { baseURL: "http://127.0.0.1:0/v1", apiKey: API_KEY },
        models: {
          [EXPECTED_MODEL_ID]: {
            name: "OMO background policy QA model",
            tool_call: true,
            limit: { context: 200_000, output: 8_192 },
          },
        },
      },
    },
    permissions: shellPermissionRules(exactCommands),
    mcp: {},
  }
  const pluginConfig = {
    telemetry: { enabled: false },
    "[opencode]": {
      default_agent: "sisyphus",
      agents: {
        sisyphus: { model: EXPECTED_MODEL },
        [CHILD_AGENT]: { model: EXPECTED_MODEL },
      },
      background_task: {
        defaultConcurrency: 1,
        maxToolCalls: 10,
        circuitBreaker: {
          enabled: attemptName === "repeat-enabled",
          maxToolCalls: 10,
          consecutiveThreshold: 5,
        },
      },
      disabled_hooks: [
        "goal",
        "todo-continuation-enforcer",
        "atlas",
        "directory-readme-injector",
        "rules-injector",
      ],
      disabled_mcps: ["websearch", "context7", "grep_app", "lsp"],
      disabled_providers: [],
      claude_code: {
        mcp: false,
        commands: false,
        skills: false,
        agents: false,
        hooks: false,
        plugins: false,
        plugins_override: {},
      },
      telemetry: false,
      auto_update: false,
    },
  }
  const projectConfigPath = join(project, "opencode.json")
  const pluginConfigPath = join(project, ".omo", "omo.jsonc")
  const probeDirectory = join(project, ".qa-plugin")
  await mkdir(join(project, ".omo"), { recursive: true })
  await mkdir(probeDirectory, { recursive: true })
  await writeFile(projectConfigPath, JSON.stringify({
    ...projectConfig,
    provider: {
      [EXPECTED_PROVIDER]: {
        ...projectConfig.provider[EXPECTED_PROVIDER],
        options: { baseURL: "http://127.0.0.1:MOCK_PORT/v1", apiKey: API_KEY },
      },
    },
  }, null, 2) + "\n", "utf8")
  await writeFile(pluginConfigPath, JSON.stringify(pluginConfig, null, 2) + "\n", "utf8")
  await writeFile(join(probeDirectory, "package.json"), JSON.stringify({
    name: PROBE_ID,
    private: true,
    type: "module",
    main: "index.js",
  }, null, 2) + "\n", "utf8")
  await writeFile(join(probeDirectory, "index.js"), makeProbeSource(), "utf8")
  await writeFile(join(evidence, "omo.jsonc"), JSON.stringify(pluginConfig, null, 2) + "\n", "utf8")

  const preflights: Array<Record<string, unknown>> = []
  const observations: ProviderObservation[] = []
  const routeFailures: string[] = []
  const headerFailures: string[] = []
  const parentPlans = new Map<string, ParentPlan>()
  const rootProjectIDs = new Set<string>()
  let projectID: string | undefined
  let client: ReturnType<typeof OpenCode.make> | undefined
  let serverProcess: Bun.Subprocess | undefined
  let stdoutText = ""
  let stderrText = ""
  let stdoutTask: Promise<void> = Promise.resolve()
  let stderrTask: Promise<void> = Promise.resolve()
  let opencodeStopped = false
  let mockStopped = false
  let mockProvider: ReturnType<typeof Bun.serve> | undefined
  let failure: unknown
  let modelCallID = 0
  let localModelRequests = 0
  let uncategorizedProviderRequests = 0
  let phaseResult: Record<string, unknown> = {}

  try {
    if (!existsSync(join(PLUGIN_DIR, "server.js"))) throw new Error("Native plugin bundle is missing server.js: " + PLUGIN_DIR)
    const sourceHash = sha256(await readFile(join(ROOT, "script", "opencode2-background-tool-policy-qa.ts")))
    const bundleHash = sha256(await readFile(join(PLUGIN_DIR, "server.js")))
    if (!EXPECTED_BUNDLE_SHA256 || !/^[a-f0-9]{64}$/i.test(EXPECTED_BUNDLE_SHA256)) {
      throw new Error("Set OPENCODE2_EXPECTED_BUNDLE_SHA256 to the reviewed server.js SHA-256 before running this QA.")
    }
    if (bundleHash !== EXPECTED_BUNDLE_SHA256.toLowerCase()) {
      throw new Error("Bundle SHA-256 mismatch; expected " + EXPECTED_BUNDLE_SHA256 + ", got " + bundleHash)
    }
    const versionResult = Bun.spawnSync([OPENCODE_BIN, "--version"], { stdout: "pipe", stderr: "pipe", env })
    const version = new TextDecoder().decode(versionResult.stdout).trim()
    if (versionResult.exitCode !== 0 || !version.includes(EXPECTED_VERSION)) {
      throw new Error("Expected pinned OpenCode " + EXPECTED_VERSION + ", got " + version)
    }

    mockProvider = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const url = new URL(request.url)
        if (url.pathname.endsWith("/models")) {
          return Response.json({
            data: [{
              id: EXPECTED_MODEL_ID,
              object: "model",
              created: 0,
              owned_by: "omo-background-policy-qa",
            }],
          })
        }
        if (!url.pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 })
        localModelRequests += 1
        const sessionID = request.headers.get("x-omo-qa-session-id") ?? ""
        const kind = request.headers.get("x-omo-qa-kind") ?? ""
        if (!sessionID || !kind) {
          headerFailures.push("chat/completions request arrived without both probe headers")
          return Response.json({ error: "QA request identity probe was not active." }, { status: 400 })
        }
        const activeClient = client
        if (!activeClient) {
          routeFailures.push("provider request arrived before SDK client initialization")
          return Response.json({ error: "QA SDK client was not ready." }, { status: 500 })
        }

        let session: Awaited<ReturnType<typeof activeClient.session.get>>
        try {
          session = await activeClient.session.get({ sessionID })
        } catch (error) {
          routeFailures.push("session.get failed for tagged provider request: " + (error instanceof Error ? error.message : String(error)))
          return Response.json({ error: "Unknown QA session identity." }, { status: 500 })
        }
        const actualModel = modelRef(session.model)
        if (
          session.id !== sessionID ||
          !rootProjectIDs.has(session.projectID) ||
          sessionDirectory(session) !== canonicalProject ||
          actualModel !== EXPECTED_MODEL
        ) {
          routeFailures.push("tagged request did not match exact project/model session scope: " + JSON.stringify({
            sessionID,
            actualID: session.id,
            projectID: session.projectID,
            agent: session.agent,
            model: actualModel,
            directory: sessionDirectory(session),
          }))
          return Response.json({ error: "QA request failed session scope/model preflight." }, { status: 500 })
        }
        if (kind !== "primary" && kind !== "compaction" && kind !== "title" && kind !== "generate") {
          headerFailures.push("unexpected session request kind " + kind)
          return Response.json({ error: "QA request kind was invalid." }, { status: 400 })
        }

        let body: Record<string, unknown>
        try {
          body = await request.json() as Record<string, unknown>
        } catch {
          routeFailures.push("provider request JSON body was not parseable")
          return Response.json({ error: "Bad local QA request JSON." }, { status: 400 })
        }
        const streaming = body.stream === true
        const wireModel = typeof body.model === "string" ? body.model : ""
        if (wireModel !== EXPECTED_MODEL_ID && wireModel !== EXPECTED_MODEL) {
          routeFailures.push("provider request carried an unexpected or missing wire model: " + JSON.stringify({ sessionID, wireModel }))
          return Response.json({ error: "QA provider request did not select the pinned local model." }, { status: 400 })
        }
        const rawModel = wireModel
        const markerText = requestBodyText(body)
        const childPlanMarker = [...parentPlans.values()].find((plan) => plan.childPromptMarker && markerText.includes(plan.childPromptMarker))
        const requestNumber = (observations.filter((item) => item.sessionID === sessionID).at(-1)?.requestNumber ?? 0) + 1
        let route = "unhandled"
        let call: ToolCall | undefined
        let plainText = "QA_DONE"

        const rootPlan = parentPlans.get(sessionID)
        if (kind !== "primary") {
          route = "nonprimary_ack"
          plainText = "QA_NONPRIMARY_ACK"
        } else if (rootPlan) {
          if (rootPlan.caseName === "probe") {
            route = "probe_preflight_ack"
          } else if (rootPlan.caseName === "parent_shell" && rootPlan.parentToolCalls < (rootPlan.parentCommands?.length ?? 0)) {
            if (!toolNames(body).some((name) => name.toLowerCase() === "bash")) {
              routeFailures.push("root session did not receive the OMO bash alias")
            } else {
              rootPlan.parentToolCalls += 1
              route = "parent_shell_call"
              call = { name: "bash", input: { command: rootPlan.parentCommands?.[rootPlan.parentToolCalls - 1] ?? "", workdir: canonicalProject } }
            }
          } else if (rootPlan.launchTool && !rootPlan.launchSent) {
            if (!toolNames(body).some((name) => name.toLowerCase() === rootPlan.launchTool!.toLowerCase())) {
              routeFailures.push("root session did not receive expected delegation tool " + rootPlan.launchTool)
            } else {
              rootPlan.launchSent = true
              route = "launch_" + rootPlan.launchTool
              if (!rootPlan.activeChild) {
                routeFailures.push("root launch was requested without an active child fixture")
              } else {
                rootPlan.activeChild.sent = true
                call = childLaunchCall(rootPlan.activeChild)
              }
            }
          } else if (rootPlan.follower && !rootPlan.follower.sent) {
            if (!toolNames(body).some((name) => name.toLowerCase() === "subagent")) {
              routeFailures.push("root session did not receive native subagent tool for the post-interrupt follower")
            } else {
              rootPlan.follower.sent = true
              rootPlan.activeChild = rootPlan.follower
              rootPlan.childPromptMarker = rootPlan.follower.marker
              route = "launch_follower"
              call = childLaunchCall(rootPlan.follower)
            }
          } else {
            rootPlan.followups.push({
              at: Date.now(),
              childMarkerPresent: Boolean(rootPlan.childPromptMarker && markerText.includes(rootPlan.childPromptMarker)),
              route: "parent_ack",
            })
            route = "parent_ack"
          }
        } else if (session.parentID) {
          const parentPlan = parentPlans.get(session.parentID)
          const childPlan = parentPlan?.activeChild
          if (!parentPlan || !childPlan || session.agent !== CHILD_AGENT) {
            routeFailures.push("provider request was tagged as a child but does not belong to a registered QA parent: " + JSON.stringify({
              sessionID,
              parentID: session.parentID,
              agent: session.agent,
            }))
          } else {
            const childRequestNumber = (parentPlan.childRequests.get(sessionID) ?? 0) + 1
            parentPlan.childRequests.set(sessionID, childRequestNumber)
            if (childRequestNumber <= childPlan.commands.length) {
              if (!toolNames(body).some((name) => name.toLowerCase() === "bash")) {
                routeFailures.push("native child session did not receive the OMO bash alias: " + sessionID)
              } else {
                route = "child_shell_call"
                call = {
                  name: "bash",
                  input: { command: childPlan.commands[childRequestNumber - 1], workdir: canonicalProject },
                }
              }
            } else {
              route = "child_final_text"
              plainText = "OMO_BACKGROUND_POLICY_QA_CHILD_DONE"
            }
          }
        } else {
          uncategorizedProviderRequests += 1
          routeFailures.push("tagged session is neither an expected root session nor one of its native children: " + sessionID)
        }

        if (route === "unhandled") {
          route = "routing_failure_ack"
          plainText = "QA_FIXTURE_ROUTING_FAILURE"
        }
        const observation: ProviderObservation = {
          at: Date.now(),
          sessionID,
          ...(session.parentID ? { parentID: session.parentID } : {}),
          ...(session.agent ? { agent: session.agent } : {}),
          ...(actualModel ? { model: actualModel } : {}),
          wireModel,
          kind,
          requestNumber,
          route,
          ...(call ? { toolCall: call.name } : {}),
          ...(route === "child_shell_call" ? { toolIndex: (parentPlans.get(session.parentID!)?.childRequests.get(sessionID) ?? 0) } : {}),
          childPromptMarkerPresent: Boolean(childPlanMarker),
        }
        observations.push(observation)
        modelCallID += 1
        if (call) {
          return toolCallResponse(call, "omo-bg-policy-qa-" + String(modelCallID), rawModel, streaming)
        }
        return textResponse(plainText, "omo-bg-policy-qa-" + String(modelCallID), rawModel, streaming)
      },
    })

    const providerBaseURL = "http://127.0.0.1:" + mockProvider.port + "/v1"
    const onDiskConfig = {
      ...projectConfig,
      provider: {
        [EXPECTED_PROVIDER]: {
          ...projectConfig.provider[EXPECTED_PROVIDER],
          options: { baseURL: providerBaseURL, apiKey: API_KEY },
        },
      },
    }
    await writeFile(projectConfigPath, JSON.stringify(onDiskConfig, null, 2) + "\n", "utf8")
    await writeFile(join(evidence, "opencode.json"), JSON.stringify({
      ...onDiskConfig,
      provider: { [EXPECTED_PROVIDER]: { ...onDiskConfig.provider[EXPECTED_PROVIDER], options: { baseURL: providerBaseURL, apiKey: "[fake QA key]" } } },
    }, null, 2) + "\n", "utf8")
    await writeFile(join(evidence, "probe-plugin.js"), makeProbeSource(), "utf8")

    const portReservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("reserved") })
    const serverPort = portReservation.port
    portReservation.stop(true)
    client = OpenCode.make({
      baseUrl: "http://127.0.0.1:" + serverPort,
      headers: { Authorization: basicAuth(), "x-opencode-directory": canonicalProject },
    })
    serverProcess = Bun.spawn(
      [OPENCODE_BIN, "--print-logs", "--log-level", "debug", "serve", "--hostname", "127.0.0.1", "--port", String(serverPort)],
      { cwd: canonicalProject, env, stdout: "pipe", stderr: "pipe" },
    )
    stdoutTask = new Response(serverProcess.stdout as ReadableStream<Uint8Array>).text().then((text) => { stdoutText += text })
    stderrTask = new Response(serverProcess.stderr as ReadableStream<Uint8Array>).text().then((text) => { stderrText += text })
    await waitForServer(client, serverProcess)

    const registration = await waitForPluginActivation(client, serverProcess)
    const { agents, activeIds, childAgent } = registration
    const preflightAgentIDs = agents.flatMap((agent) => isRecord(agent) && typeof agent.id === "string" ? [agent.id] : [])
    phaseResult = {
      attemptName,
      version: EXPECTED_VERSION,
      bundleSHA256: sha256(await readFile(join(PLUGIN_DIR, "server.js"))),
      probeActive: activeIds.includes(PROBE_ID),
      omoPluginActive: activeIds.includes(PLUGIN_ID),
      pluginActivationPollCount: registration.pollCount,
      pluginReadyAfterMs: registration.readyAfterMs,
      childAgent: { id: CHILD_AGENT, model: modelRef((childAgent as Record<string, unknown>).model) },
      agentIDs: preflightAgentIDs,
      providerBaseURL,
      allowedProvider: EXPECTED_PROVIDER,
      expectedModel: EXPECTED_MODEL,
      circuitBreakerEnabled: attemptName === "repeat-enabled",
      tempRoot,
      canonicalProject,
      databasePath,
      externalCredentialsForwarded: false,
      claudeConfigDirectory: env.CLAUDE_CONFIG_DIR,
    }

    async function newParent(caseName: CaseName, title: string): Promise<ParentPlan> {
      await assertLocalCatalog(client!, title + "-before-create", preflights)
      const session = await client!.session.create({ title, location: { directory: canonicalProject } })
      const createdInfo = await client!.session.get({ sessionID: session.id })
      if (projectID === undefined) projectID = createdInfo.projectID
      if (createdInfo.projectID !== projectID || sessionDirectory(createdInfo) !== canonicalProject) {
        throw new Error("Explicitly located parent session was created outside the fixture project: " + JSON.stringify({
          sessionID: session.id,
          projectID: createdInfo.projectID,
          directory: sessionDirectory(createdInfo),
        }))
      }
      rootProjectIDs.add(createdInfo.projectID)
      await client!.session.switchAgent({ sessionID: session.id, agent: "sisyphus" })
      await client!.session.switchModel({
        sessionID: session.id,
        model: { providerID: EXPECTED_PROVIDER, id: EXPECTED_MODEL_ID },
      })
      const info = await assertSessionScope(client!, session.id, projectID!, canonicalProject, title + "-before-prompt")
      if (info.agent !== "sisyphus") throw new Error("Expected Sisyphus parent session, got " + String(info.agent))
      const plan: ParentPlan = {
        sessionID: session.id,
        caseName,
        launchSent: false,
        parentToolCalls: 0,
        followups: [],
        childRequests: new Map(),
      }
      parentPlans.set(session.id, plan)
      return plan
    }

    async function prompt(plan: ParentPlan, userText: string): Promise<void> {
      await assertLocalCatalog(client!, plan.caseName + "-before-prompt", preflights)
      await assertSessionScope(client!, plan.sessionID, projectID!, canonicalProject, plan.caseName + "-before-prompt")
      await within("Prompt " + plan.caseName, (async () => {
        await client!.session.prompt({ sessionID: plan.sessionID, text: userText })
        await client!.session.wait({ sessionID: plan.sessionID })
      })(), 60_000)
    }

    async function runChildCase(input: {
      caseName: "alias_repeat" | "native_changed" | "native_hardcap"
      launchTool: "task" | "subagent"
      commands: readonly string[]
      marker: string
      title: string
    }): Promise<{ parent: ParentPlan; childID: string; child: Record<string, unknown>; policy?: PolicyState; lines: string[] }> {
      const plan = await newParent(input.caseName, input.title)
      plan.launchTool = input.launchTool
      plan.childPromptMarker = input.marker
      plan.activeChild = {
        launchTool: input.launchTool,
        marker: input.marker,
        commands: input.commands,
        sent: false,
      }
      const launchStartedAt = Date.now()
      const launchUserText = "QA request " + input.caseName + "; launch one background child for the exact shell calls described in its task prompt."
      await prompt(plan, launchUserText)
      if (!plan.launchSent) throw new Error("Provider did not launch the requested child through " + input.launchTool)
      const childRow = await waitForChild(databasePath, canonicalProject, plan.sessionID)
      const childID = childRow.id
      const childInfo = await client!.session.get({ sessionID: childID })
      const parentInfo = await client!.session.get({ sessionID: plan.sessionID })
      if (
        childInfo.id !== childID ||
        childInfo.parentID !== plan.sessionID ||
        childInfo.projectID !== parentInfo.projectID ||
        childInfo.agent !== CHILD_AGENT ||
        modelRef(childInfo.model) !== EXPECTED_MODEL ||
        sessionDirectory(childInfo) !== canonicalProject
      ) {
        throw new Error("Native child failed parent/location/agent/model preflight: " + JSON.stringify({
          id: childInfo.id,
          parentID: childInfo.parentID,
          agent: childInfo.agent,
          model: modelRef(childInfo.model),
          directory: sessionDirectory(childInfo),
        }))
      }
      rootProjectIDs.add(childInfo.projectID)
      const minProviderRequests = input.caseName === "native_changed" ? input.commands.length + 1 : input.commands.length
      const deadline = Date.now() + 30_000
      while (Date.now() < deadline) {
        if ((plan.childRequests.get(childID) ?? 0) >= minProviderRequests) break
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      const policy = input.caseName === "native_changed"
        ? await waitForPolicyState(databasePath, childID, (state) =>
            Boolean(state && state.toolCalls === input.commands.length && !state.lastTrigger),
          )
        : await waitForPolicyState(databasePath, childID, (state) =>
            Boolean(state?.lastTrigger && (state.lastTrigger.count ?? -1) >= input.commands.length),
          )
      await waitForSessionIdle(client!, childID, "Child execution " + input.caseName)
      const terminalInfo = await client!.session.get({ sessionID: childID })
      const expectedOutcome = input.caseName === "native_changed" ? "succeeded" : "interrupted"
      const outcome = sessionOutcome(terminalInfo)
      if (outcome !== expectedOutcome) {
        throw new Error("Native child reached an unexpected terminal outcome: " + JSON.stringify({ childID, outcome, expectedOutcome }))
      }
      await waitForParentAck(plan, launchStartedAt, true)
      return { parent: plan, childID, child: terminalInfo as unknown as Record<string, unknown>, policy, lines: fileLines(outFiles[input.caseName]) }
    }

    async function launchFollowerAfterInterrupt(
      plan: ParentPlan,
      interruptedChildID: string,
    ): Promise<{ childID: string; outcome: string | undefined; policy?: PolicyState; lines: string[] }> {
      const marker = "OMO_QA_CHILD_native_hardcap_follower"
      const command = appendLineCommand(outFiles.native_hardcap_follower, "follower-after-interrupt")
      const follower: ChildPlan = { launchTool: "subagent", marker, commands: [command], sent: false }
      plan.follower = follower
      plan.childPromptMarker = marker
      const promptStartedAt = Date.now()
      await prompt(plan, "The previous child has been interrupted. Launch one new native background child to run the single follower fixture command.")
      if (!follower.sent || plan.activeChild !== follower) {
        throw new Error("The parent did not launch the follower child after the previous child interrupted.")
      }
      const row = await waitForChild(databasePath, canonicalProject, plan.sessionID, 25_000, new Set([interruptedChildID]))
      const childID = row.id
      const childInfo = await client!.session.get({ sessionID: childID })
      const parentInfo = await client!.session.get({ sessionID: plan.sessionID })
      if (
        childInfo.id !== childID ||
        childInfo.parentID !== plan.sessionID ||
        childInfo.projectID !== parentInfo.projectID ||
        childInfo.agent !== CHILD_AGENT ||
        modelRef(childInfo.model) !== EXPECTED_MODEL ||
        sessionDirectory(childInfo) !== canonicalProject
      ) {
        throw new Error("Post-interrupt follower failed native child scope/model preflight: " + JSON.stringify({
          id: childInfo.id,
          parentID: childInfo.parentID,
          agent: childInfo.agent,
          model: modelRef(childInfo.model),
          directory: sessionDirectory(childInfo),
        }))
      }
      rootProjectIDs.add(childInfo.projectID)
      const policy = await waitForPolicyState(databasePath, childID, (state) =>
        Boolean(state && state.toolCalls === 1 && !state.lastTrigger),
      )
      const requestDeadline = Date.now() + 30_000
      while (Date.now() < requestDeadline && (plan.childRequests.get(childID) ?? 0) < 2) {
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      await waitForSessionIdle(client!, childID, "Post-interrupt follower execution")
      const terminalInfo = await client!.session.get({ sessionID: childID })
      const outcome = sessionOutcome(terminalInfo)
      if (outcome !== "succeeded") {
        throw new Error("Post-interrupt follower did not complete successfully: " + JSON.stringify({ childID, outcome }))
      }
      await waitForParentAck(plan, promptStartedAt, true)
      return { childID, outcome, policy, lines: fileLines(outFiles.native_hardcap_follower) }
    }

    const initialPlan = await newParent("probe", "QA identity-header probe")
    initialPlan.launchSent = true
    await prompt(initialPlan, "Local provider identity preflight. Return a short acknowledgement.")
    const probeObservations = observations.filter((item) => item.sessionID === initialPlan.sessionID)
    if (!probeObservations.some((item) => item.kind === "primary" && item.route === "probe_preflight_ack")) {
      throw new Error("The first local model request did not prove the HTTP probe headers are active.")
    }

    const checks: Record<string, boolean> = {
      catalogExactlyLocalBeforePrompt: preflights.length > 0 && preflights.every((entry) => entry.valid === true),
      probeLoadedAndTagged: activeIds.includes(PROBE_ID) && probeObservations.some((item) => item.kind === "primary"),
      childAgentPinnedLocal: modelRef((childAgent as Record<string, unknown>).model) === EXPECTED_MODEL,
    }

    if (cases.includes("alias_repeat")) {
      const file = outFiles.alias_repeat
      const command = appendLineCommand(file, "alias-repeat")
      const result = await runChildCase({
        caseName: "alias_repeat",
        launchTool: "task",
        commands: Array.from({ length: 5 }, () => command),
        marker: "OMO_QA_CHILD_alias_repeat",
        title: "Background policy: OMO task alias repeat",
      })
      checks.taskAliasCreatedOneLocalChild =
        result.child.parentID === result.parent.sessionID &&
        result.child.agent === CHILD_AGENT &&
        modelRef(result.child.model) === EXPECTED_MODEL
      checks.repeatThresholdPersisted = result.policy?.toolCalls === 5 &&
        result.policy.lastTrigger?.type === "repeated_tool_use" &&
        result.policy.lastTrigger.count === 5 &&
        result.policy.lastTrigger.limit === 5
      checks.repeatThresholdCallHadNoSideEffect = result.lines.length === 4 &&
        result.lines.every((line) => line === "alias-repeat")
      checks.repeatTriggeredChildWasInterrupted = sessionOutcome(result.child) === "interrupted"
      checks.parentFollowupWithChildPromptMarkerWasAcknowledged =
        result.parent.followups.some((item) => item.childMarkerPresent && item.route === "parent_ack")
      phaseResult.aliasRepeat = {
        parentSessionID: result.parent.sessionID,
        childSessionID: result.childID,
        childAgent: result.child.agent,
        childModel: modelRef(result.child.model),
        childProviderRequests: result.parent.childRequests.get(result.childID) ?? 0,
        persistedPolicy: result.policy,
        sideEffectLines: result.lines.length,
        parentFollowups: result.parent.followups,
      }
    }

    if (cases.includes("native_changed")) {
      const file = outFiles.native_changed
      const commandA = appendLineCommand(file, "changed-a")
      const commandB = appendLineCommand(file, "changed-b")
      const commands = [...Array.from({ length: 4 }, () => commandA), ...Array.from({ length: 4 }, () => commandB)]
      const result = await runChildCase({
        caseName: "native_changed",
        launchTool: "subagent",
        commands,
        marker: "OMO_QA_CHILD_native_changed",
        title: "Background policy: direct native subagent input changes",
      })
      checks.nativeSubagentInputChangeResetsRepeatStreak =
        result.policy?.toolCalls === 8 &&
        result.policy.consecutiveCount === 4 &&
        result.policy.lastTrigger === undefined &&
        result.lines.length === 8
      checks.nativeSubagentWasTrackedFromActualSession =
        result.child.parentID === result.parent.sessionID &&
        result.child.agent === CHILD_AGENT &&
        modelRef(result.child.model) === EXPECTED_MODEL
      checks.changedInputChildCompleted = sessionOutcome(result.child) === "succeeded"
      phaseResult.nativeChanged = {
        parentSessionID: result.parent.sessionID,
        childSessionID: result.childID,
        childAgent: result.child.agent,
        childModel: modelRef(result.child.model),
        childProviderRequests: result.parent.childRequests.get(result.childID) ?? 0,
        persistedPolicy: result.policy,
        sideEffectLines: result.lines.length,
        parentFollowups: result.parent.followups,
      }
    }

    if (cases.includes("native_hardcap")) {
      const file = outFiles.native_hardcap
      const commands = Array.from({ length: 10 }, (_unused, index) =>
        appendLineCommand(file, "hardcap-" + String(index + 1).padStart(2, "0")),
      )
      const result = await runChildCase({
        caseName: "native_hardcap",
        launchTool: "subagent",
        commands,
        marker: "OMO_QA_CHILD_native_hardcap",
        title: "Background policy: native child hard call cap",
      })
      checks.hardCapPersistedWhileRepeatDetectionDisabled =
        result.policy?.toolCalls === 10 &&
        result.policy.lastTrigger?.type === "max_tool_calls" &&
        result.policy.lastTrigger.count === 10 &&
        result.policy.lastTrigger.limit === 10
      checks.hardCapThresholdCallHadNoSideEffect =
        result.lines.length === 9 &&
        result.lines.join("|") === Array.from({ length: 9 }, (_unused, index) => "hardcap-" + String(index + 1).padStart(2, "0")).join("|")
      checks.repeatDetectionWasDisabled = attemptName === "repeat-disabled-hardcap" && pluginConfig["[opencode]"].background_task.circuitBreaker.enabled === false
      checks.hardCapChildWasInterrupted = sessionOutcome(result.child) === "interrupted"
      const follower = await launchFollowerAfterInterrupt(result.parent, result.childID)
      checks.followerWasAdmittedAfterInterrupt = follower.outcome === "succeeded" && follower.policy?.toolCalls === 1 && !follower.policy.lastTrigger
      checks.followerSideEffectOccurredOnce = follower.lines.length === 1 && follower.lines[0] === "follower-after-interrupt"
      phaseResult.nativeHardcap = {
        parentSessionID: result.parent.sessionID,
        childSessionID: result.childID,
        childAgent: result.child.agent,
        childModel: modelRef(result.child.model),
        childProviderRequests: result.parent.childRequests.get(result.childID) ?? 0,
        persistedPolicy: result.policy,
        sideEffectLines: result.lines.length,
        interruptedOutcome: sessionOutcome(result.child),
        parentFollowups: result.parent.followups,
        follower: {
          childSessionID: follower.childID,
          outcome: follower.outcome,
          policy: follower.policy,
          sideEffectLines: follower.lines.length,
        },
      }
    }

    if (cases.includes("parent_shell")) {
      const plan = await newParent("parent_shell", "Background policy: unmanaged parent exclusion")
      plan.parentCommands = parentCommands
      await prompt(plan, "Run the six preapproved identical parent-only fixture shell calls, each as a separate tool call.")
      const states = storedPolicyStates(databasePath)
      checks.unmanagedParentShellSucceeded = plan.parentToolCalls === parentCommands.length && fileLines(outFiles.parent_shell).length === parentCommands.length
      checks.unmanagedParentDidNotAccumulateChildPolicy = !states.some((state) => state.sessionID === plan.sessionID)
      checks.parentRequestsNeverRoutedAsChild = observations
        .filter((item) => item.sessionID === plan.sessionID)
        .every((item) => item.parentID === undefined && item.route !== "child_shell_call")
      phaseResult.parentExclusion = {
        parentSessionID: plan.sessionID,
        agent: "sisyphus",
        providerRequests: observations.filter((item) => item.sessionID === plan.sessionID),
        policyStateFound: states.some((state) => state.sessionID === plan.sessionID),
        identicalParentCalls: plan.parentToolCalls,
        sideEffectLines: fileLines(outFiles.parent_shell).length,
      }
    }

    checks.allProviderRequestsTagged = localModelRequests > 0 && headerFailures.length === 0
    checks.noUnexpectedProviderRequests = uncategorizedProviderRequests === 0 && routeFailures.length === 0
    checks.everyChildRequestWasSessionScoped = observations
      .filter((item) => item.parentID)
      .every((item) => item.agent === CHILD_AGENT && item.model === EXPECTED_MODEL)
    checks.nonPrimaryRequestsNeverReceiveTools = observations
      .filter((item) => item.kind !== "primary")
      .every((item) => item.toolCall === undefined && item.route === "nonprimary_ack")
    const scopedRootPlans = [...parentPlans.values()]
    checks.parentChildPromptMarkersWereNeverClassifiers = scopedRootPlans
      .filter((plan) => plan.launchTool)
      .every((plan) => plan.followups.every((item) => item.route === "parent_ack"))
    checks.mcpWasActuallyEmpty = preflights.every((item) => Array.isArray(item.mcpServers) && item.mcpServers.length === 0)
    checks.cleanupPathsAreIsolated = [home, xdgData, xdgConfig, xdgState, xdgCache, omoHome, project, databasePath]
      .every((path) => resolve(path).startsWith(tempRoot + "/"))
    const failedChecks = Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name)
    if (headerFailures.length || routeFailures.length || failedChecks.length) {
      throw new Error("Background policy QA assertions failed: " + JSON.stringify({ failedChecks, headerFailures, routeFailures }))
    }
    phaseResult.checks = checks
    phaseResult.providerRequestCount = localModelRequests
    phaseResult.observationCount = observations.length
    phaseResult.modelListPreflightCount = preflights.length
  } catch (error) {
    failure = error
  } finally {
    opencodeStopped = await stopProcess(serverProcess)
    await Promise.all([stdoutTask.catch(() => undefined), stderrTask.catch(() => undefined)])
    if (mockProvider) {
      mockProvider.stop(true)
      mockStopped = true
    }
    const sourcePath = join(ROOT, "script", "opencode2-background-tool-policy-qa.ts")
    const sourceHash = existsSync(sourcePath) ? sha256(await readFile(sourcePath)) : undefined
    const bundleHash = existsSync(join(PLUGIN_DIR, "server.js")) ? sha256(await readFile(join(PLUGIN_DIR, "server.js"))) : undefined
    const runtime = {
      attemptName,
      result: failure ? "failed" : "passed",
      error: failure instanceof Error ? redact(failure.message) : failure ? redact(String(failure)) : null,
      version: EXPECTED_VERSION,
      expectedBundleSHA256: EXPECTED_BUNDLE_SHA256 || null,
      bundleSHA256: bundleHash ?? null,
      sourceSHA256: sourceHash ?? null,
      ...phaseResult,
      providerRequestCount: localModelRequests,
      providerObservations: observations.length,
      headerFailures,
      routeFailures: routeFailures.map(redact),
      preflights,
      observations,
      cleanup: {
        opencodeStopped,
        opencodeExitCode: serverProcess?.exitCode ?? null,
        localhostMockStopped: mockStopped,
      },
      isolation: {
        tempRoot,
        canonicalProject,
        databasePath,
        realDatabaseInspected: false,
        realProjectFilesReadOrChanged: false,
        externalCredentialsForwarded: false,
        externalProviderConfigured: false,
        providerRequestsAllowlistedToLocalHost: true,
        mcpListCalledAndEmpty: preflights.length > 0 && preflights.every((item) => Array.isArray(item.mcpServers) && item.mcpServers.length === 0),
        claudeConfigDirectory: join(home, ".claude"),
        fixtureStateRetainedForInspection: true,
      },
    }
    await writeFile(join(evidence, "runtime.json"), JSON.stringify(runtime, null, 2) + "\n", "utf8")
    await writeFile(join(evidence, "provider-observations.json"), JSON.stringify(observations, null, 2) + "\n", "utf8")
    await writeFile(join(evidence, "preflights.json"), JSON.stringify(preflights, null, 2) + "\n", "utf8")
    await writeFile(join(evidence, "server.log"), redact(stdoutText + "\n" + stderrText), "utf8")
    await writeFile(join(evidence, "checks.json"), JSON.stringify(phaseResult.checks ?? {}, null, 2) + "\n", "utf8")
  }

  if (failure) throw failure
  return { attemptName, evidence, ...phaseResult }
}

async function main(): Promise<void> {
  const attemptDirectory = join(EVIDENCE_ROOT, "attempt-" + new Date().toISOString().replaceAll(":", "-"))
  await mkdir(attemptDirectory, { recursive: true })
  let failure: unknown
  let attempts: Record<string, unknown>[] = []
  const scriptPath = join(ROOT, "script", "opencode2-background-tool-policy-qa.ts")
  const summary: Record<string, unknown> = {
    startedAt: new Date().toISOString(),
    opencodeBinary: OPENCODE_BIN,
    pluginDirectory: PLUGIN_DIR,
    expectedBundleSHA256: EXPECTED_BUNDLE_SHA256 || null,
    sourceSHA256: existsSync(scriptPath) ? sha256(await readFile(scriptPath)) : null,
    evidenceDirectory: attemptDirectory,
    hostRuns: ["repeat-enabled", "repeat-disabled-hardcap"],
  }
  try {
    if (!OPENCODE_BIN || !isAbsolute(OPENCODE_BIN) || !existsSync(OPENCODE_BIN)) {
      throw new Error("Set OPENCODE2_CLI to an existing absolute path for the pinned OpenCode 2.0.22 binary.")
    }
    if (!existsSync(join(PLUGIN_DIR, "server.js"))) throw new Error("Native plugin bundle is missing server.js: " + PLUGIN_DIR)
    attempts.push(await runHostAttempt(
      "repeat-enabled",
      attemptDirectory,
      ["alias_repeat", "native_changed", "parent_shell"],
    ))
    attempts.push(await runHostAttempt(
      "repeat-disabled-hardcap",
      attemptDirectory,
      ["native_hardcap"],
    ))
    summary.result = "passed"
  } catch (error) {
    failure = error
    summary.result = "failed"
    summary.error = error instanceof Error ? redact(error.message) : redact(String(error))
  } finally {
    summary.finishedAt = new Date().toISOString()
    summary.attempts = attempts
    summary.temporaryRootsRetained = true
    summary.networkBoundary = {
      configuredProvider: EXPECTED_PROVIDER,
      configuredModel: EXPECTED_MODEL,
      providerEndpoint: "127.0.0.1 only",
      enabledProviders: [EXPECTED_PROVIDER],
      externalCredentialsForwarded: false,
      probeRejectsNonLocalModelBeforeProviderDispatch: true,
    }
    await writeFile(join(attemptDirectory, "summary.json"), JSON.stringify(summary, null, 2) + "\n", "utf8")
  }
  if (failure) throw failure
  console.log("Native OpenCode " + EXPECTED_VERSION + " background tool-policy QA passed; evidence: " + attemptDirectory)
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
