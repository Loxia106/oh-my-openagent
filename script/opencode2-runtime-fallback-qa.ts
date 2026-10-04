/**
 * Isolated real-host primary runtime-fallback smoke against a local OpenAI-compatible mock.
 * Run after the native bundle is frozen:
 * OPENCODE2_CLI=/absolute/path/opencode OPENCODE2_EXPECTED_SERVER_SHA256=<sha256> \
 * OPENCODE2_QA_EVIDENCE_DIR=<direct child of .omo/evidence> bun script/opencode2-runtime-fallback-qa.ts
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
const EVIDENCE = resolve(process.env.OPENCODE2_QA_EVIDENCE_DIR ?? join(EVIDENCE_ROOT, `runtime-fallback-${new Date().toISOString().replaceAll(":", "-")}`))
const PLUGIN_DIR = resolve(process.env.OPENCODE2_PLUGIN_DIR ?? join(ROOT, "dist", "opencode2"))
const CLI_INPUT = process.env.OPENCODE2_CLI?.trim() ?? ""
const CLI = CLI_INPUT ? resolve(CLI_INPUT) : ""
const EXPECTED_SERVER_SHA256 = process.env.OPENCODE2_EXPECTED_SERVER_SHA256 ?? ""
const PROVIDER = "omoqa"
const PRIMARY_MODEL = "primary"
const FIRST_FALLBACK_MODEL = "backup"
const SECOND_FALLBACK_MODEL = "backup2"
const MODELS = [PRIMARY_MODEL, FIRST_FALLBACK_MODEL, SECOND_FALLBACK_MODEL] as const
const PROBE_ID = "omo-runtime-fallback-origin-probe"
const API_KEY = "runtime-fallback-local-qa-fake-key"
const PASSWORD = "runtime-fallback-local-qa-password"
const MARKER = "OMO_RUNTIME_FALLBACK_PRIMARY_429"
const EXHAUSTION_MARKER = "OMO_RUNTIME_FALLBACK_EXHAUSTION"
const NO_CHAIN_MARKER = "OMO_RUNTIME_FALLBACK_NO_CHAIN"
const SUCCESS = "OMO_RUNTIME_FALLBACK_QA_OK"
const TIMEOUT_MS = 75_000

type RecordValue = Record<string, unknown>
type Check = { name: string; passed: boolean; detail?: unknown }
type MockRequest = {
  sessionID?: string
  kind?: string
  agent?: string
  provider?: string
  model?: string
  bodyModel?: string
  marker?: string
  maxTokens?: number
  status: number
  originValid: boolean
}
type Host = {
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

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function redact(value: string): string {
  return value.replaceAll(API_KEY, "[redacted-fake-key]").replaceAll(PASSWORD, "[redacted-test-password]")
}

function basicAuth(): string {
  return "Basic " + Buffer.from("opencode:" + PASSWORD).toString("base64")
}

function reservePort(): number {
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("reserved") })
  const port = reservation.port
  reservation.stop(true)
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

function userMessages(body: RecordValue): string[] {
  const messages = Array.isArray(body.messages) ? body.messages : []
  return messages.filter(isRecord).filter((message) => message.role === "user")
    .map((message) => typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? ""))
}

function userText(body: RecordValue): string {
  return userMessages(body).join("\n")
}

function assistantText(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter(isRecord).filter((message) => message.type === "assistant")
    .flatMap((message) => Array.isArray(message.content) ? message.content : [])
    .filter(isRecord).filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => String(part.text))
}

function countReadonlySessions(databasePath: string): number | null {
  if (!existsSync(databasePath)) return 0
  try {
    const database = new Database(databasePath, { readonly: true, create: false })
    try {
      const row = database.query("SELECT COUNT(*) AS count FROM session_v2").get() as { count?: number } | null
      return typeof row?.count === "number" ? row.count : null
    } finally { database.close() }
  } catch { return null }
}

function sessionRow(databasePath: string, sessionID: string): RecordValue | undefined {
  if (!existsSync(databasePath)) return undefined
  try {
    const database = new Database(databasePath, { readonly: true, create: false })
    try {
      const row = database.query("SELECT id, parent_id AS parentID, directory, agent, model, idle_outcome AS idleOutcome, time_idle AS idleAt FROM session_v2 WHERE id = ?").get(sessionID)
      return isRecord(row) ? row : undefined
    } finally { database.close() }
  } catch { return undefined }
}

function streamedCompletion(text: string, model: string): Response {
  const id = `chatcmpl-runtime-fallback-${Date.now()}`
  const created = Math.floor(Date.now() / 1000)
  const chunks = [
    { id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] },
    { id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
  ]
  return new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", {
    headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive" },
  })
}

function completion(body: RecordValue, text: string, model: string): Response {
  if (body.stream === true) return streamedCompletion(text, model)
  return Response.json({
    id: `chatcmpl-runtime-fallback-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  })
}

function makeProbeSource(mockOrigin: string): string {
  return `export default {
  id: ${JSON.stringify(PROBE_ID)},
  async setup({ session }) {
    const current = new Map()
    const model = await session.hook("model.request", (event) => {
      if (event.model.providerID !== ${JSON.stringify(PROVIDER)} || !${JSON.stringify(MODELS)}.includes(event.model.id)) throw new Error("QA blocked nonlocal model")
      current.set(event.sessionID, { model: event.model.id, kind: event.kind })
      event.headers["x-omo-qa-agent"] = String(event.agent)
      event.headers["x-omo-qa-provider"] = String(event.model.providerID)
      event.headers["x-omo-qa-model"] = String(event.model.id)
    })
    const http = await session.hook("http.request", (event) => {
      if (new URL(event.request.url).origin !== ${JSON.stringify(mockOrigin)}) throw new Error("QA blocked nonlocal HTTP destination")
      const headers = new Headers(event.request.headers)
      headers.set("x-omo-qa-session-id", event.sessionID)
      headers.set("x-omo-qa-kind", event.kind)
      event.request = new Request(event.request, { headers })
    })
    const retry = await session.hook("retry", (event) => {
      const active = current.get(event.sessionID)
      if (active?.kind === "primary" && ${JSON.stringify(MODELS)}.includes(active.model)) event.decision = { retry: false }
    })
    return async () => { await Promise.all([retry.dispose(), http.dispose(), model.dispose()]) }
  }
}\n`
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

async function waitForHost(host: Host, directory: string): Promise<void> {
  const deadline = Date.now() + 30_000
  let lastError = ""
  while (Date.now() < deadline) {
    if (host.process.exitCode !== null) throw new Error(`OpenCode exited during startup (${host.process.exitCode}): ${redact(host.stderr)}`)
    try {
      const response = await host.client.server.info()
      if (response.version.includes("2.0.22")) return
      lastError = JSON.stringify(response)
    } catch (error) { lastError = error instanceof Error ? error.message : String(error) }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`OpenCode host did not become healthy for ${directory}: ${lastError}`)
}

async function main(): Promise<void> {
  assert(CLI && existsSync(CLI) && isAbsolute(CLI_INPUT), "Set OPENCODE2_CLI to an explicit absolute OpenCode CLI path")
  assert(/^[a-f0-9]{64}$/i.test(EXPECTED_SERVER_SHA256), "Set OPENCODE2_EXPECTED_SERVER_SHA256 to the frozen server bundle hash")
  const relativeEvidence = relative(EVIDENCE_ROOT, EVIDENCE)
  assert(relativeEvidence !== "" && relativeEvidence !== ".." && !relativeEvidence.startsWith(".." + sep)
    && !isAbsolute(relativeEvidence) && !relativeEvidence.includes(sep), `Evidence must be one direct child of ${EVIDENCE_ROOT}`)
  await mkdir(EVIDENCE_ROOT, { recursive: true })
  const canonicalEvidenceRoot = await realpath(EVIDENCE_ROOT)
  await mkdir(EVIDENCE, { recursive: true })
  const canonicalEvidence = await realpath(EVIDENCE)
  assert(dirname(canonicalEvidence) === canonicalEvidenceRoot, "Evidence directory escaped the evidence root")
  const serverPath = join(PLUGIN_DIR, "server.js")
  assert(existsSync(serverPath), `Frozen native plugin server is missing: ${serverPath}`)
  const serverHash = createHash("sha256").update(await readFile(serverPath)).digest("hex")
  assert(serverHash === EXPECTED_SERVER_SHA256, `Frozen server hash mismatch: ${serverHash}`)

  const tempRoot = await realpath(await mkdtemp(join(tmpdir(), "omo-runtime-fallback-qa-")))
  const project = join(tempRoot, "project")
  const hostCwd = join(tempRoot, "server-cwd")
  const home = join(tempRoot, "home")
  const xdgData = join(tempRoot, "xdg-data")
  const xdgConfig = join(tempRoot, "xdg-config")
  const xdgState = join(tempRoot, "xdg-state")
  const xdgCache = join(tempRoot, "xdg-cache")
  const omoHome = join(tempRoot, "omo-home")
  const claudeConfig = join(tempRoot, "claude-config")
  const claudePlugins = join(tempRoot, "claude-plugins")
  const probeDirectory = join(tempRoot, "runtime-fallback-probe")
  const databasePath = join(tempRoot, "opencode.db")
  await Promise.all([project, hostCwd, home, xdgData, xdgConfig, xdgState, xdgCache, omoHome, claudeConfig, claudePlugins, probeDirectory,
    join(project, ".omo")].map((path) => mkdir(path, { recursive: true })))
  const canonicalProject = await realpath(project)
  assert(!canonicalProject.startsWith(ROOT + sep), "QA project must be outside the repository")
  const modelCalls: MockRequest[] = []
  const expectedSessions = new Map<string, string>()
  const checks: Check[] = []
  let host: Host | undefined
  let mock: ReturnType<typeof Bun.serve> | undefined
  let failure: string | undefined
  let version = ""
  let beforeSessions = countReadonlySessions(databasePath)
  let afterSessions: number | null = null
  let stoppedCode: number | null = null
  let mockStopped = false
  const startTime = new Date().toISOString()
  let sessionID: string | undefined
  const output: RecordValue = {
    startTime,
    cli: CLI,
    serverPath,
    serverSha256: serverHash,
    expectedServerSha256: EXPECTED_SERVER_SHA256,
    gitHead: Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: ROOT, stdout: "pipe", stderr: "pipe" }).stdout.toString().trim(),
    projectDirectory: canonicalProject,
    isolatedTempRoot: tempRoot,
    databasePath,
    expectedProvider: PROVIDER,
    expectedPrimaryModel: PRIMARY_MODEL,
    expectedFallbackModels: [FIRST_FALLBACK_MODEL, SECOND_FALLBACK_MODEL],
    sourceFileSha256: createHash("sha256").update(await readFile(join(ROOT, "packages/omo-opencode/src/v2/runtime-fallback.ts"))).digest("hex"),
  }
  let projectConfig: RecordValue | undefined
  let omoConfig: RecordValue | undefined
  let mockOrigin = ""
  let serverPort = 0

  try {
    mock = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const url = new URL(request.url)
        if (url.pathname.endsWith("/models")) {
          return Response.json({ data: MODELS.map((id) => ({ id, object: "model", created: 0, owned_by: "local-qa" })) })
        }
        if (!url.pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 })
        const body = await request.json() as RecordValue
        const bodyModel = typeof body.model === "string" ? body.model : ""
        const headerSession = request.headers.get("x-omo-qa-session-id") ?? undefined
        const headerKind = request.headers.get("x-omo-qa-kind") ?? undefined
        const headerAgent = request.headers.get("x-omo-qa-agent") ?? undefined
        const headerProvider = request.headers.get("x-omo-qa-provider") ?? undefined
        const headerModel = request.headers.get("x-omo-qa-model") ?? undefined
        const text = userText(body)
        const marker = text.includes(EXHAUSTION_MARKER) ? EXHAUSTION_MARKER
          : text.includes(NO_CHAIN_MARKER) ? NO_CHAIN_MARKER
            : text.includes(MARKER) ? MARKER : undefined
        const expectedAgent = headerSession ? expectedSessions.get(headerSession) : undefined
        const originValid = Boolean(headerSession && expectedAgent && headerKind && headerAgent === expectedAgent
          && headerProvider === PROVIDER && headerModel === bodyModel && MODELS.includes(bodyModel as (typeof MODELS)[number]))
        const maxTokensValue = body.max_completion_tokens ?? body.max_tokens ?? body.maxOutputTokens
        const intendedStatus = headerKind === "primary" && (
          (marker === MARKER && (bodyModel === PRIMARY_MODEL || bodyModel === FIRST_FALLBACK_MODEL)) ||
          (marker === EXHAUSTION_MARKER && bodyModel === SECOND_FALLBACK_MODEL) ||
          (marker === NO_CHAIN_MARKER && bodyModel === PRIMARY_MODEL)
        ) ? 429 : 200
        const status = originValid ? intendedStatus : 403
        const entry: MockRequest = {
          ...(headerSession ? { sessionID: headerSession } : {}),
          ...(headerKind ? { kind: headerKind } : {}),
          ...(headerAgent ? { agent: headerAgent } : {}),
          ...(headerProvider ? { provider: headerProvider } : {}),
          ...(headerModel ? { model: headerModel } : {}),
          ...(bodyModel ? { bodyModel } : {}),
          ...(marker ? { marker } : {}),
          ...(typeof maxTokensValue === "number" ? { maxTokens: maxTokensValue } : {}),
          status,
          originValid,
        }
        modelCalls.push(entry)
        if (!originValid) return Response.json({ error: { message: "QA blocked unexpected model request origin" } }, { status: 403 })
        if (status === 429) {
          return Response.json({ error: { message: "Fixture rate limit", type: "rate_limit_error", code: "rate_limit_exceeded" } }, { status: 429 })
        }
        return completion(body, SUCCESS, bodyModel)
      },
    })
    mockOrigin = `http://127.0.0.1:${mock.port}`
    await writeFile(join(probeDirectory, "index.js"), makeProbeSource(mockOrigin), "utf8")
    projectConfig = {
      $schema: "https://opencode.ai/config.json",
      plugins: [probeDirectory, PLUGIN_DIR],
      enabled_providers: [PROVIDER],
      model: `${PROVIDER}/${PRIMARY_MODEL}`,
      default_agent: "sisyphus",
      provider: {
        [PROVIDER]: {
          name: "Local runtime fallback QA mock",
          npm: "@ai-sdk/openai-compatible",
          options: { baseURL: `${mockOrigin}/v1`, apiKey: API_KEY },
          models: {
            [PRIMARY_MODEL]: { name: "Local QA primary", tool_call: true, limit: { context: 200_000, output: 8_192 } },
            [FIRST_FALLBACK_MODEL]: { name: "Local QA first backup", tool_call: true, limit: { context: 200_000, output: 8_192 } },
            [SECOND_FALLBACK_MODEL]: { name: "Local QA second backup", tool_call: true, limit: { context: 200_000, output: 8_192 } },
          },
        },
      },
      mcp: {},
      telemetry: false,
      permission: { edit: "deny", shell: "deny", task: "deny", subagent: "deny" },
    }
    omoConfig = {
      telemetry: { enabled: false },
      "[opencode]": {
        telemetry: false,
        disabled_mcps: ["websearch", "context7", "grep_app", "lsp"],
        claude_code: { mcp: false, agents: false, skills: false, commands: false, plugins: false, hooks: false },
        runtime_fallback: { enabled: true, retry_on_errors: [429], max_fallback_attempts: 2, cooldown_seconds: 0 },
        agents: { sisyphus: { model: `${PROVIDER}/${PRIMARY_MODEL}`, fallback_models: [
          { model: `${PROVIDER}/${FIRST_FALLBACK_MODEL}`, maxTokens: 317 },
          { model: `${PROVIDER}/${SECOND_FALLBACK_MODEL}`, maxTokens: 617 },
        ] }, prometheus: { model: `${PROVIDER}/${PRIMARY_MODEL}`, fallback_models: [] } },
      },
    }
    await writeFile(join(project, "opencode.json"), JSON.stringify(projectConfig, null, 2) + "\n")
    await writeFile(join(project, ".omo", "omo.jsonc"), JSON.stringify(omoConfig, null, 2) + "\n")

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
      CLAUDE_CONFIG_DIR: claudeConfig,
      CLAUDE_PLUGINS_HOME: claudePlugins,
      OPENCODE_DISABLE_MODELS_FETCH: "1",
      OPENCODE_TELEMETRY_DISABLED: "1",
      OPENCODE_SERVER_PASSWORD: PASSWORD,
      OPENCODE_PASSWORD: PASSWORD,
    }
    const versionResult = Bun.spawnSync([CLI, "--version"], { cwd: hostCwd, env: cliEnvironment, stdout: "pipe", stderr: "pipe" })
    version = new TextDecoder().decode(versionResult.stdout).trim()
    assert(versionResult.exitCode === 0 && version.includes("2.0.22"), `Expected pinned OpenCode 2.0.22; got ${version}`)
    const serverHashAtLaunch = createHash("sha256").update(await readFile(serverPath)).digest("hex")
    assert(serverHashAtLaunch === EXPECTED_SERVER_SHA256, "Frozen server bundle changed before launch")
    await writeFile(join(EVIDENCE, "project-config-redacted.json"), JSON.stringify({
      opencode: { ...projectConfig, provider: { [PROVIDER]: { ...((projectConfig.provider as RecordValue)[PROVIDER] as RecordValue), options: { baseURL: `${mockOrigin}/v1`, apiKey: "[redacted-fake-key]" } } } },
      omo: omoConfig,
    }, null, 2) + "\n")

    serverPort = reservePort()
    host = {
      process: Bun.spawn([CLI, "--print-logs", "--log-level", "debug", "serve", "--hostname", "127.0.0.1", "--port", String(serverPort)], {
        cwd: hostCwd,
        env: cliEnvironment,
        stdout: "pipe",
        stderr: "pipe",
      }),
      client: OpenCode.make({
        baseUrl: `http://127.0.0.1:${serverPort}`,
        headers: { Authorization: basicAuth(), "x-opencode-directory": canonicalProject },
      }),
      stdout: "",
      stderr: "",
      stdoutTask: Promise.resolve(),
      stderrTask: Promise.resolve(),
    }
    host.stdoutTask = new Response(host.process.stdout as ReadableStream<Uint8Array>).text().then((value) => { host!.stdout = value })
    host.stderrTask = new Response(host.process.stderr as ReadableStream<Uint8Array>).text().then((value) => { host!.stderr = value })
    await waitForHost(host, canonicalProject)

    const activationDeadline = Date.now() + 35_000
    let activePlugins: Array<{ id: string | undefined; status: string }> = []
    while (Date.now() < activationDeadline) {
      if (host.process.exitCode !== null) throw new Error(`OpenCode exited during plugin activation: ${host.process.exitCode}`)
      const plugins = await host.client.plugin.list()
      activePlugins = plugins.data.map(({ id, state }) => ({ id, status: state.status }))
      const failed = activePlugins.find((plugin) => plugin.status === "failed")
      if (failed) throw new Error(`Plugin activation failed: ${JSON.stringify(failed)}`)
      if (activePlugins.some((plugin) => plugin.id === PROBE_ID && plugin.status === "active") &&
        activePlugins.some((plugin) => plugin.id === "oh-my-openagent" && plugin.status === "active")) break
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    assert(activePlugins.some((plugin) => plugin.id === PROBE_ID && plugin.status === "active"), "Origin probe plugin did not activate")
    assert(activePlugins.some((plugin) => plugin.id === "oh-my-openagent" && plugin.status === "active"), "OMO native plugin did not activate")
    checks.push({ name: "native OMO and local origin probe are active", passed: true, detail: activePlugins })
    const providers = await host.client.provider.list()
    const models = await host.client.model.list()
    const defaultModel = await host.client.model.default()
    const mcps = await host.client.mcp.list()
    const nativeAgents = await host.client.agent.list()
    const providerIDs = providers.data.map((provider) => provider.id)
    const modelIDs = models.data.map((model) => `${model.providerID}/${model.id}`).sort()
    const modelStates = models.data.map((model) => ({ id: `${model.providerID}/${model.id}`, enabled: model.enabled }))
    const expectedModelIDs = MODELS.map((id) => `${PROVIDER}/${id}`).sort()
    assert(providerIDs.length === 1 && providerIDs[0] === PROVIDER, `Unexpected enabled provider catalog: ${JSON.stringify(providerIDs)}`)
    assert(JSON.stringify(modelIDs) === JSON.stringify(expectedModelIDs), `Unexpected model catalog: ${JSON.stringify(modelIDs)}`)
    assert(defaultModel.data?.providerID === PROVIDER && defaultModel.data.id === PRIMARY_MODEL, `Unexpected native default: ${JSON.stringify(defaultModel.data)}`)
    assert(mcps.data.length === 0, `Unexpected active MCPs: ${JSON.stringify(mcps.data.map((item) => item.name))}`)
    const prometheus = nativeAgents.data.find((agent) => agent.id === "prometheus")
    assert(prometheus?.mode === "primary" || prometheus?.mode === "all", `No-chain agent is not a native primary agent: ${JSON.stringify(prometheus)}`)
    checks.push({ name: "provider/model/default/MCP preflight is local-only", passed: true, detail: { providerIDs, modelIDs, modelStates, default: `${defaultModel.data.providerID}/${defaultModel.data.id}`, mcps: mcps.data.map((item) => item.name), noChainAgent: { id: prometheus.id, mode: prometheus.mode } } })

    const session = await host.client.session.create({ title: `Runtime fallback ${MARKER}`, location: { directory: canonicalProject } })
    sessionID = session.id
    expectedSessions.set(session.id, "sisyphus")
    assert(session.location.directory === canonicalProject, "Native session did not retain the isolated project location")
    await host.client.session.switchAgent({ sessionID: session.id, agent: "sisyphus" })
    await host.client.session.switchModel({ sessionID: session.id, model: { providerID: PROVIDER, id: PRIMARY_MODEL } })
    const selected = await host.client.session.get({ sessionID: session.id })
    assert(selected.agent === "sisyphus", `Unexpected primary agent: ${String(selected.agent)}`)
    assert(selected.model?.providerID === PROVIDER && selected.model.id === PRIMARY_MODEL, `Unexpected primary session model: ${JSON.stringify(selected.model)}`)
    const selectedRow = sessionRow(databasePath, session.id)
    assert(selectedRow && selectedRow.parentID == null && selectedRow.directory === canonicalProject, `Session row escaped isolated root: ${JSON.stringify(selectedRow)}`)
    const beforeRequestCount = modelCalls.length
    await within("primary prompt admission", host.client.session.prompt({
      sessionID: session.id,
      text: `${MARKER} Execute one local request. If the primary model fails, continue with the configured fallback and finish with ${SUCCESS}.`,
    }))

    const finishDeadline = Date.now() + TIMEOUT_MS
    let finalSession = await host.client.session.get({ sessionID: session.id })
    while (Date.now() < finishDeadline) {
      const calls = modelCalls.slice(beforeRequestCount).filter((call) => call.sessionID === session.id)
      const finalFallbackObserved = calls.some((call) => call.model === SECOND_FALLBACK_MODEL && call.status === 200)
      finalSession = await host.client.session.get({ sessionID: session.id })
      if (finalFallbackObserved && finalSession.outcome === "succeeded") break
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    const finalCalls = modelCalls.slice(beforeRequestCount).filter((call) => call.sessionID === session.id)
    const primaryCalls = finalCalls.filter((call) => call.kind === "primary" && call.model === PRIMARY_MODEL)
    const firstFallbackCalls = finalCalls.filter((call) => call.kind === "primary" && call.model === FIRST_FALLBACK_MODEL)
    const secondFallbackCalls = finalCalls.filter((call) => call.kind === "primary" && call.model === SECOND_FALLBACK_MODEL)
    const contextValue = await host.client.session.context({ sessionID: session.id })
    const contextText = JSON.stringify(contextValue)
    const markerCount = contextText.split(MARKER).length - 1
    const assistantTexts = assistantText(contextValue)
    const currentRow = sessionRow(databasePath, session.id)
    checks.push({ name: "primary provider returned only one fixture 429", passed: primaryCalls.length === 1, detail: primaryCalls })
    checks.push({ name: "first configured fallback failed before the second fallback succeeded", passed:
      firstFallbackCalls.length === 1 && firstFallbackCalls[0]?.status === 429 &&
      secondFallbackCalls.length === 1 && secondFallbackCalls[0]?.status === 200 && finalSession.outcome === "succeeded",
    detail: { firstFallbackCalls, secondFallbackCalls, outcome: finalSession.outcome, model: finalSession.model } })
    checks.push({ name: "each fallback carried its own configured token limit", passed:
      firstFallbackCalls.some((call) => call.maxTokens === 317) && secondFallbackCalls.some((call) => call.maxTokens === 617),
    detail: [firstFallbackCalls, secondFallbackCalls].flat().map((call) => ({ model: call.model, maxTokens: call.maxTokens })) })
    checks.push({ name: "one original user marker remains in native session context", passed: markerCount === 1, detail: { markerCount } })
    checks.push({ name: "fallback completion text was committed in the native assistant context", passed: assistantTexts.some((text) => text.includes(SUCCESS)), detail: assistantTexts })
    checks.push({ name: "effective session persisted the fallback model without changing ownership/location", passed:
      finalSession.id === session.id && finalSession.agent === "sisyphus" && finalSession.location.directory === canonicalProject &&
      finalSession.model?.providerID === PROVIDER && finalSession.model.id === SECOND_FALLBACK_MODEL && Boolean(currentRow && currentRow.parentID == null && currentRow.directory === canonicalProject),
    detail: { id: finalSession.id, agent: finalSession.agent, model: finalSession.model, parentID: currentRow?.parentID, directory: currentRow?.directory } })
    checks.push({ name: "all observed provider requests were tagged to this local session and origin", passed:
      finalCalls.length > 0 && finalCalls.every((call) => call.originValid), detail: finalCalls })

    const beforeExhaustion = modelCalls.length
    await within("fallback exhaustion prompt admission", host.client.session.prompt({
      sessionID: session.id,
      text: `${EXHAUSTION_MARKER} Make one local request. This configured chain has already used both fallback attempts.`,
    }))
    const exhaustionDeadline = Date.now() + TIMEOUT_MS
    let exhaustedSession = await host.client.session.get({ sessionID: session.id })
    while (Date.now() < exhaustionDeadline) {
      exhaustedSession = await host.client.session.get({ sessionID: session.id })
      if (exhaustedSession.outcome === "failed") break
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    const exhaustionCalls = modelCalls.slice(beforeExhaustion).filter((call) => call.sessionID === session.id)
    const exhaustionPrimary = exhaustionCalls.filter((call) => call.kind === "primary")
    checks.push({ name: "exhausted chain makes one current-model request and does not cycle back", passed:
      exhaustedSession.outcome === "failed" && exhaustionPrimary.length === 1 && exhaustionPrimary[0]?.model === SECOND_FALLBACK_MODEL && exhaustionPrimary[0]?.status === 429,
    detail: { outcome: exhaustedSession.outcome, model: exhaustedSession.model, calls: exhaustionPrimary } })

    const noChain = await host.client.session.create({ title: `Runtime fallback ${NO_CHAIN_MARKER}`, location: { directory: canonicalProject } })
    expectedSessions.set(noChain.id, "prometheus")
    await host.client.session.switchAgent({ sessionID: noChain.id, agent: "prometheus" })
    await host.client.session.switchModel({ sessionID: noChain.id, model: { providerID: PROVIDER, id: PRIMARY_MODEL } })
    const noChainSelected = await host.client.session.get({ sessionID: noChain.id })
    assert(noChainSelected.location.directory === canonicalProject && noChainSelected.agent === "prometheus", "No-chain session was not isolated and assigned to Prometheus")
    const noChainStart = modelCalls.length
    await within("no-chain prompt admission", host.client.session.prompt({
      sessionID: noChain.id,
      text: `${NO_CHAIN_MARKER} Make one local request without a configured fallback chain.`,
    }))
    const noChainDeadline = Date.now() + TIMEOUT_MS
    let noChainFinal = await host.client.session.get({ sessionID: noChain.id })
    while (Date.now() < noChainDeadline) {
      noChainFinal = await host.client.session.get({ sessionID: noChain.id })
      if (noChainFinal.outcome === "failed") break
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    const noChainCalls = modelCalls.slice(noChainStart).filter((call) => call.sessionID === noChain.id && call.kind === "primary")
    const noChainRow = sessionRow(databasePath, noChain.id)
    checks.push({ name: "agent without an explicit chain stays on its original model after provider failure", passed:
      noChainFinal.outcome === "failed" && noChainFinal.model?.providerID === PROVIDER && noChainFinal.model.id === PRIMARY_MODEL &&
      noChainCalls.length === 1 && noChainCalls[0]?.status === 429 && noChainCalls[0]?.originValid === true && noChainRow?.agent === "prometheus",
    detail: { outcome: noChainFinal.outcome, model: noChainFinal.model, calls: noChainCalls, row: noChainRow } })
    checks.push({ name: "no-chain fixture did not invoke configured backup models", passed:
      !modelCalls.slice(noChainStart).some((call) => call.sessionID === noChain.id && call.model !== PRIMARY_MODEL),
    detail: modelCalls.slice(noChainStart).filter((call) => call.sessionID === noChain.id) })
    for (const check of checks) assert(check.passed, `${check.name} failed: ${JSON.stringify(check.detail)}`)
  } catch (error) {
    failure = error instanceof Error ? error.stack ?? error.message : String(error)
  } finally {
    stoppedCode = await stopProcess(host?.process)
    if (mock) { mock.stop(true); mockStopped = true }
    await host?.stdoutTask
    await host?.stderrTask
    afterSessions = countReadonlySessions(databasePath)
  }

  const runtime = {
    ...output,
    finishTime: new Date().toISOString(),
    runtime: version,
    mockOrigin,
    serverPort,
    sessionID,
    tempRootRetained: existsSync(tempRoot),
    projectConfigRedacted: projectConfig ? {
      model: projectConfig.model,
      default_agent: projectConfig.default_agent,
      enabled_providers: projectConfig.enabled_providers,
      mcp: projectConfig.mcp,
      provider: { [PROVIDER]: { options: { baseURL: `${mockOrigin}/v1`, apiKey: "[redacted-fake-key]" }, models: MODELS } },
    } : undefined,
    omoConfig,
    mockRequests: modelCalls,
    checks,
    checkCount: checks.length,
    allChecksPassed: checks.length > 0 && checks.every((check) => check.passed),
    isolatedSessionCountBefore: beforeSessions,
    isolatedSessionCountAfter: afterSessions,
    isolatedSessionCountChangedByFixture: beforeSessions !== null && afterSessions !== null && afterSessions > beforeSessions,
    cleanup: { serverExitCode: stoppedCode, mockStopped },
    ...(failure ? { failure } : {}),
  }
  await writeFile(join(EVIDENCE, "runtime.json"), JSON.stringify(runtime, null, 2) + "\n")
  await writeFile(join(EVIDENCE, "server.log"), redact((host?.stdout ?? "") + "\n" + (host?.stderr ?? "")), "utf8")
  await writeFile(join(EVIDENCE, "mock-requests.json"), JSON.stringify(modelCalls, null, 2) + "\n")
  await writeFile(join(EVIDENCE, "commands.txt"), [
    `OPENCODE2_CLI=${CLI}`,
    `OPENCODE2_EXPECTED_SERVER_SHA256=${EXPECTED_SERVER_SHA256}`,
    `OPENCODE2_PLUGIN_DIR=${PLUGIN_DIR}`,
    `OPENCODE2_QA_EVIDENCE_DIR=${EVIDENCE}`,
    `serverHash=${serverHash}`,
    `runtimeVersion=${version}`,
    `tempRoot=${tempRoot}`,
    `project=${canonicalProject}`,
    `database=${databasePath}`,
    "Only an allowlisted isolated HOME/XDG/OMO/Claude environment and fake credentials were passed to OpenCode.",
  ].join("\n") + "\n")
  assert(!failure && checks.length > 0 && checks.every((check) => check.passed), `Runtime fallback QA failed; evidence: ${EVIDENCE}${failure ? `\n${failure}` : ""}`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error)
  process.exitCode = 1
})
