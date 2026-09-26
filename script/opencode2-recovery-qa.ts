import { existsSync } from "node:fs"
import { Database } from "bun:sqlite"
import { OpenCode } from "@opencode/client"
import { mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"

const ROOT = resolve(import.meta.dir, "..")
const PLUGIN_DIR = resolve(process.env.OPENCODE2_PLUGIN_DIR ?? join(ROOT, "dist", "opencode2"))
const OPENCODE_BIN = process.env.OPENCODE2_CLI ? resolve(process.env.OPENCODE2_CLI) : ""
const EXPECTED_MODEL = "omoqa/qa-model"
const EXPECTED_PROVIDER = "omoqa"
const EXPECTED_MODEL_ID = "qa-model"
const PASSWORD = "omo-recovery-qa-only-password"
const API_KEY = "omo-recovery-qa-only-fake-key"
const EDIT_MARKER = "[EDIT ERROR - IMMEDIATE ACTION REQUIRED]"
const JSON_MARKER = "[JSON PARSE ERROR - IMMEDIATE ACTION REQUIRED]"
const EMPTY_MARKER = "[Task Empty Response Warning]"
const NO_TEXT = "Subagent completed without a text response."
const EDIT_PROMPT = "OMO_RECOVERY_EDIT_CASE"
const SUBAGENT_PROMPT = "OMO_RECOVERY_SUBAGENT_CASE"
const CHILD_PROMPT = "OMO_RECOVERY_CHILD_NO_TEXT"
const JSON_PROMPT = "OMO_RECOVERY_JSON_CASE"
const WRITE_PROMPT = "OMO_RECOVERY_NOTEPAD_GUARD_CASE"
const WRITE_GUARD_MARKER = "Refused: Write to"

type ProviderObservation = {
  index: number
  model: string
  tools: string[]
  latestUser: string
  responsePlan: string
  sawEditGuidance: boolean
  sawJsonGuidance: boolean
  sawEmptyGuidance: boolean
  sawWriteGuardGuidance: boolean
}

type ProjectSession = { id: string; parentID?: string; agent?: string }

function redact(value: string): string {
  return value.replaceAll(PASSWORD, "[redacted-test-password]").replaceAll(API_KEY, "[redacted-test-api-key]")
}

function basicAuth(): string {
  return "Basic " + Buffer.from("opencode:" + PASSWORD).toString("base64")
}

function toolNames(body: Record<string, unknown>): string[] {
  if (!Array.isArray(body.tools)) return []
  return body.tools.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return []
    const item = entry as Record<string, unknown>
    const fn = item.function && typeof item.function === "object" ? item.function as Record<string, unknown> : undefined
    const name = typeof item.name === "string" ? item.name : typeof fn?.name === "string" ? fn.name : undefined
    return name ? [name] : []
  })
}

function findTool(body: Record<string, unknown>, expected: string): string | undefined {
  return toolNames(body).find((name) => name.toLowerCase() === expected.toLowerCase())
}

function messageRecords(body: Record<string, unknown>): Array<Record<string, unknown>> {
  return Array.isArray(body.messages)
    ? body.messages.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    : []
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content.flatMap((part) => {
    if (!part || typeof part !== "object") return []
    const item = part as Record<string, unknown>
    return item.type === "text" && typeof item.text === "string" ? [item.text] : []
  }).join("\n")
}

function latestUser(body: Record<string, unknown>): string {
  const messages = messageRecords(body)
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role === "user") return contentText(message.content)
  }
  return ""
}

function allMessageText(body: Record<string, unknown>): string {
  return JSON.stringify(messageRecords(body))
}

function hasToolResult(body: Record<string, unknown>): boolean {
  return messageRecords(body).some((message) => message.role === "tool")
}

function toolCallResponse(name: string, args: unknown, id: string, model: string, streaming: boolean): Response {
  const created = Math.floor(Date.now() / 1000)
  const call = { index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } }
  if (!streaming) {
    return Response.json({
      id: "chatcmpl-" + id,
      object: "chat.completion",
      created,
      model,
      choices: [{ index: 0, message: { role: "assistant", content: null, tool_calls: [call] }, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
    })
  }
  const chunks = [
    { id: "chatcmpl-" + id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [call] }, finish_reason: null }] },
    { id: "chatcmpl-" + id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
  ]
  return new Response(chunks.map((chunk) => "data: " + JSON.stringify(chunk) + "\n\n").join("") + "data: [DONE]\n\n", {
    headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive" },
  })
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
      usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
    })
  }
  const chunks = [
    { id: "chatcmpl-" + id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] },
    { id: "chatcmpl-" + id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
  ]
  return new Response(chunks.map((chunk) => "data: " + JSON.stringify(chunk) + "\n\n").join("") + "data: [DONE]\n\n", {
    headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive" },
  })
}

function projectSessions(databasePath: string, directory: string): ProjectSession[] {
  if (!existsSync(databasePath)) return []
  const database = new Database(databasePath, { readonly: true, create: false })
  try {
    return database.query(
      "SELECT id, parent_id AS parentID, agent FROM session_v2 WHERE directory = ? ORDER BY time_created ASC",
    ).all(directory) as ProjectSession[]
  } finally {
    database.close()
  }
}

function modelRef(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined
  const model = value as Record<string, unknown>
  return typeof model.providerID === "string" && typeof model.id === "string"
    ? model.providerID + "/" + model.id
    : undefined
}

function toolParts(messages: readonly unknown[]): Array<Record<string, unknown>> {
  return messages.flatMap((message) => {
    if (!message || typeof message !== "object") return []
    const content = (message as Record<string, unknown>).content
    if (!Array.isArray(content)) return []
    return content.filter((part): part is Record<string, unknown> =>
      Boolean(part) && typeof part === "object" && (part as Record<string, unknown>).type === "tool",
    )
  })
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
  const deadline = Date.now() + 20_000
  let lastError: unknown
  while (Date.now() < deadline) {
    if (process.exitCode !== null) throw new Error("OpenCode exited before ready (code " + process.exitCode + ").")
    try {
      await client.server.info()
      return
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 150))
    }
  }
  throw new Error("OpenCode did not become ready: " + String(lastError))
}

async function waitForPluginActivation(client: ReturnType<typeof OpenCode.make>, process: Bun.Subprocess): Promise<void> {
  const deadline = Date.now() + 30_000
  let lastPlugins: Awaited<ReturnType<typeof client.plugin.list>> | undefined
  let lastAgents: Awaited<ReturnType<typeof client.agent.list>> | undefined
  while (Date.now() < deadline) {
    if (process.exitCode !== null) throw new Error("OpenCode exited during plugin activation.")
    lastPlugins = await client.plugin.list()
    lastAgents = await client.agent.list()
    const failed = lastPlugins.data.filter((plugin) => plugin.state.status === "failed")
    if (failed.length) throw new Error("Plugin setup failed: " + JSON.stringify(failed))
    const ids = new Set(lastAgents.data.map((agent) => agent.id))
    if (ids.has("sisyphus") && ids.has("explore")) return
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error("Expected native agents were not registered: " + JSON.stringify(lastAgents?.data.map((agent) => agent.id) ?? []))
}

async function stopProcess(process: Bun.Subprocess | undefined): Promise<boolean> {
  if (!process) return true
  if (process.exitCode !== null) return true
  process.kill("SIGTERM")
  const stopped = await Promise.race([
    process.exited.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5_000)),
  ])
  if (stopped) return true
  if (process.exitCode === null) process.kill("SIGKILL")
  await process.exited
  return false
}

function fixturePluginSource(): string {
  return [
    "import { appendFileSync } from 'node:fs'",
    "import { Effect, Schema } from 'effect'",
    "import { Error as ToolError } from '@opencode/schema/tool'",
    "const outputFile = process.env.OMO_RECOVERY_QA_OBSERVER_FILE",
    "const text = (content) => typeof content === 'string' ? content : Array.isArray(content) ? content.filter((part) => part && part.type === 'text').map((part) => part.text).join('\\n') : ''",
    "export default {",
    "  id: 'omo-opencode2-recovery-qa-fixture',",
    "  effect: (ctx) => Effect.gen(function* () {",
    "    yield* ctx.tool.transform((editor) => {",
    "      editor.add({",
    "        name: 'recovery_json_failure',",
    "        description: 'QA-only native Tool.Error fixture for execute.after recovery.',",
    "        input: Schema.Struct({}),",
    "        options: { codemode: false },",
    "        execute: () => Effect.fail(new ToolError({ message: 'JSON parse error: QA-only Tool.Error fixture' })),",
    "      })",
    "    })",
    "    yield* ctx.tool.hook('execute.after', (event) => Effect.sync(() => {",
    "      if (!outputFile || !['edit', 'write', 'subagent', 'recovery_json_failure'].includes(event.tool)) return",
    "      const record = { tool: event.tool, status: event.status }",
    "      if (event.status === 'error') record.error = event.error.message",
    "      if (event.status === 'completed') {",
    "        record.output = event.result.output ?? null",
    "        record.content = text(event.result.content)",
    "      }",
    "      appendFileSync(outputFile, JSON.stringify(record) + '\\n')",
    "    }))",
    "  }),",
    "}",
  ].join("\n")
}

async function main(): Promise<void> {
  if (!OPENCODE_BIN || !existsSync(OPENCODE_BIN)) throw new Error("Set OPENCODE2_CLI to the pinned OpenCode 2.0.18 binary.")
  if (!existsSync(join(PLUGIN_DIR, "server.js"))) throw new Error("Native bundle missing at " + PLUGIN_DIR)
  const versionResult = Bun.spawnSync([OPENCODE_BIN, "--version"], { stdout: "pipe", stderr: "pipe" })
  const version = new TextDecoder().decode(versionResult.stdout).trim()
  if (!version.includes("2.0.18")) throw new Error("Expected OpenCode 2.0.18, got " + version)

  const stamp = new Date().toISOString().replaceAll(":", "-")
  const evidence = resolve(process.env.OPENCODE2_RECOVERY_EVIDENCE_DIR ?? join(ROOT, ".omo", "evidence", "20260927-opencode2-recovery-hooks", "runtime-" + stamp))
  await mkdir(evidence, { recursive: true })
  const tempRoot = await realpath(await mkdtemp(join(tmpdir(), "omo-opencode2-recovery-qa-")))
  const project = join(tempRoot, "project")
  const home = join(tempRoot, "home")
  const xdgData = join(tempRoot, "xdg-data")
  const xdgConfig = join(tempRoot, "xdg-config")
  const xdgState = join(tempRoot, "xdg-state")
  const xdgCache = join(tempRoot, "xdg-cache")
  const omoHome = join(tempRoot, "omo-home")
  const databasePath = join(tempRoot, "opencode.sqlite")
  const observerPath = join(evidence, "observer.jsonl")
  await Promise.all([project, home, xdgData, xdgConfig, xdgState, xdgCache, omoHome].map((path) => mkdir(path, { recursive: true })))
  const canonicalProject = await realpath(project)
  const fixtureDir = join(project, "recovery-fixture-plugin")
  const fixturePlugin = join(fixtureDir, "index.mjs")
  const fixtureFile = join(project, "edit-fixture.txt")
  const notepadPath = ".omo/notepads/qa/decisions.md"
  const notepadFile = join(project, notepadPath)
  const initialFileContents = "RECOVERY_FIXTURE_ORIGINAL_BYTES\n"
  const initialNotepadContents = "NOTEPAD_APPEND_ONLY_ORIGINAL_BYTES\n"
  await mkdir(fixtureDir, { recursive: true })
  await mkdir(join(project, "node_modules", "@opencode"), { recursive: true })
  await symlink(await realpath(join(ROOT, "packages", "omo-opencode", "node_modules", "@opencode", "plugin")), join(project, "node_modules", "@opencode", "plugin"))
  await symlink(await realpath(join(ROOT, "packages", "omo-opencode", "node_modules", "@opencode", "schema")), join(project, "node_modules", "@opencode", "schema"))
  await symlink(await realpath(join(ROOT, "node_modules", ".bun", "effect@4.0.0-rc.112", "node_modules", "effect")), join(project, "node_modules", "effect"))
  await writeFile(fixturePlugin, fixturePluginSource(), "utf8")
  await writeFile(fixtureFile, initialFileContents, "utf8")
  await mkdir(join(project, ".omo", "notepads", "qa"), { recursive: true })
  await writeFile(notepadFile, initialNotepadContents, "utf8")

  const observations: ProviderObservation[] = []
  const routeFailures: string[] = []
  const preflights: Array<Record<string, unknown>> = []
  let modelCall = 0
  let client: ReturnType<typeof OpenCode.make> | undefined
  let subagentParentID: string | undefined
  let serverProcess: Bun.Subprocess | undefined
  let serverStdout = ""
  let serverStderr = ""
  let stdoutTask: Promise<void> = Promise.resolve()
  let stderrTask: Promise<void> = Promise.resolve()
  let mockStopped = false
  let opencodeStopped = false
  const mockProvider = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      if (url.pathname.endsWith("/models")) {
        return Response.json({ data: [{ id: EXPECTED_MODEL_ID, object: "model", created: 0, owned_by: "omo-recovery-qa" }] })
      }
      if (!url.pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 })
      const body = await request.json() as Record<string, unknown>
      modelCall += 1
      const model = typeof body.model === "string" ? body.model : ""
      const streaming = body.stream === true
      const names = toolNames(body)
      const user = latestUser(body)
      const serialized = allMessageText(body)
      const observation: ProviderObservation = {
        index: modelCall,
        model,
        tools: names,
        latestUser: user,
        responsePlan: "unexpected request",
        sawEditGuidance: serialized.includes(EDIT_MARKER),
        sawJsonGuidance: serialized.includes(JSON_MARKER),
        sawEmptyGuidance: serialized.includes(EMPTY_MARKER),
        sawWriteGuardGuidance: serialized.includes(WRITE_GUARD_MARKER),
      }
      observations.push(observation)
      if (model !== EXPECTED_MODEL_ID && model !== EXPECTED_MODEL) {
        const failure = "provider request used non-local model identifier: " + model
        routeFailures.push(failure)
        observation.responsePlan = "rejected non-local model"
        return Response.json({ error: failure }, { status: 400 })
      }

      try {
        if (user.includes(CHILD_PROMPT)) {
          if (!client || !subagentParentID) throw new Error("child model request arrived before parent tracking was ready")
          await assertCatalog(client, preflights, "child-before-response")
          const child = await waitForChildSession(client, databasePath, canonicalProject, subagentParentID)
          await assertSessionModel(client, child.id, preflights, "child-before-response")
          observation.responsePlan = "complete child with whitespace to produce native no-text sentinel"
          return textResponse("   ", "recovery-qa-" + modelCall, model, streaming)
        }

        if (serialized.includes(EDIT_MARKER)) {
          observation.responsePlan = "parent observes edit recovery error and completes"
          return textResponse("EDIT_RECOVERY_GUIDANCE_OBSERVED", "recovery-qa-" + modelCall, model, streaming)
        }
        if (serialized.includes(EMPTY_MARKER)) {
          observation.responsePlan = "parent observes empty-subagent guidance and completes"
          return textResponse("EMPTY_SUBAGENT_GUIDANCE_OBSERVED", "recovery-qa-" + modelCall, model, streaming)
        }
        if (serialized.includes(JSON_MARKER)) {
          observation.responsePlan = "parent observes JSON Tool.Error guidance and completes"
          return textResponse("JSON_RECOVERY_GUIDANCE_OBSERVED", "recovery-qa-" + modelCall, model, streaming)
        }
        if (serialized.includes(WRITE_GUARD_MARKER)) {
          observation.responsePlan = "parent observes notepad write guard error and completes"
          return textResponse("NOTEPAD_WRITE_GUARD_OBSERVED", "recovery-qa-" + modelCall, model, streaming)
        }

        if (user.includes(EDIT_PROMPT)) {
          if (hasToolResult(body)) {
            observation.responsePlan = "edit recovery marker missing from tool error"
            return textResponse("EDIT_RECOVERY_MISSING", "recovery-qa-" + modelCall, model, streaming)
          }
          const name = findTool(body, "edit")
          if (!name) throw new Error("native edit tool was not advertised to the model")
          observation.responsePlan = "invoke native edit with unmatched oldString"
          return toolCallResponse(name, {
            path: fixtureFile,
            oldString: "THIS_TEXT_DOES_NOT_EXIST",
            newString: "MUST_NOT_APPEAR",
          }, "recovery-qa-" + modelCall, model, streaming)
        }

        if (user.includes(SUBAGENT_PROMPT)) {
          if (hasToolResult(body)) {
            observation.responsePlan = "empty-subagent marker missing from tool content"
            return textResponse("EMPTY_SUBAGENT_GUIDANCE_MISSING", "recovery-qa-" + modelCall, model, streaming)
          }
          const name = findTool(body, "subagent")
          if (!name) throw new Error("native subagent tool was not advertised to the model")
          observation.responsePlan = "invoke native foreground subagent with explicit local model"
          return toolCallResponse(name, {
            agent: "explore",
            description: "empty response QA",
            prompt: CHILD_PROMPT,
            model: EXPECTED_MODEL,
            background: false,
          }, "recovery-qa-" + modelCall, model, streaming)
        }

        if (user.includes(JSON_PROMPT)) {
          if (hasToolResult(body)) {
            observation.responsePlan = "JSON recovery marker missing from Tool.Error"
            return textResponse("JSON_RECOVERY_GUIDANCE_MISSING", "recovery-qa-" + modelCall, model, streaming)
          }
          const name = findTool(body, "recovery_json_failure")
          if (!name) throw new Error("QA-only native Tool.Error fixture tool was not advertised")
          observation.responsePlan = "invoke QA-only native Tool.Error fixture"
          return toolCallResponse(name, {}, "recovery-qa-" + modelCall, model, streaming)
        }

        if (user.includes(WRITE_PROMPT)) {
          if (hasToolResult(body)) {
            observation.responsePlan = "notepad write guard guidance missing from failed tool result"
            return textResponse("NOTEPAD_WRITE_GUARD_MISSING", "recovery-qa-" + modelCall, model, streaming)
          }
          const name = findTool(body, "write")
          if (!name) throw new Error("native write tool was not advertised to the model")
          observation.responsePlan = "attempt destructive native write to owned append-only notepad fixture"
          return toolCallResponse(name, {
            path: notepadPath,
            content: "MUST_NOT_OVERWRITE_APPEND_ONLY_NOTEPAD",
          }, "recovery-qa-" + modelCall, model, streaming)
        }
        observation.responsePlan = "unexpected prompt completed without requested case"
        return textResponse("UNEXPECTED_RECOVERY_QA_RESPONSE", "recovery-qa-" + modelCall, model, streaming)
      } catch (error) {
        routeFailures.push(error instanceof Error ? error.message : String(error))
        observation.responsePlan = "fixture routing/preflight failed"
        return Response.json({ error: String(error) }, { status: 500 })
      }
    },
  })

  const projectConfig = {
    $schema: "https://opencode.ai/config.json",
    plugins: [PLUGIN_DIR, fixtureDir],
    enabled_providers: [EXPECTED_PROVIDER],
    model: EXPECTED_MODEL,
    provider: {
      omoqa: {
        name: "OMO recovery QA local mock",
        npm: "@ai-sdk/openai-compatible",
        options: { baseURL: "http://127.0.0.1:" + mockProvider.port + "/v1", apiKey: API_KEY },
        models: {
          "qa-model": { name: "OMO recovery QA model", tool_call: true, limit: { context: 200_000, output: 8_192 } },
        },
      },
    },
    mcp: {},
    permission: { edit: "allow", subagent: "allow", shell: "deny" },
  }
  const omoConfig = {
    telemetry: { enabled: false },
    "[opencode]": {
      agents: {
        sisyphus: { model: EXPECTED_MODEL },
        explore: { model: EXPECTED_MODEL },
      },
      disabled_mcps: ["websearch", "context7", "grep_app", "lsp"],
      disabled_providers: [],
      runtime_fallback: { enabled: false },
      claude_code: { mcp: false },
      telemetry: false,
      auto_update: false,
    },
  }
  await writeFile(join(project, "opencode.json"), JSON.stringify(projectConfig, null, 2) + "\n", "utf8")
  await mkdir(join(project, ".omo"), { recursive: true })
  await writeFile(join(project, ".omo", "omo.jsonc"), JSON.stringify(omoConfig, null, 2) + "\n", "utf8")
  await writeFile(join(evidence, "opencode.json"), JSON.stringify(projectConfig, null, 2) + "\n", "utf8")
  await writeFile(join(evidence, "omo.jsonc"), JSON.stringify(omoConfig, null, 2) + "\n", "utf8")

  let failure: unknown
  const checks: Record<string, boolean> = {}
  const assertionFailures: string[] = []
  let sessionIDs: Record<string, string> = {}
  try {
    const env = {
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
      OMO_RECOVERY_QA_OBSERVER_FILE: observerPath,
    }
    const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("reserved") })
    const hostPort = reservation.port
    reservation.stop(true)
    serverProcess = Bun.spawn([OPENCODE_BIN, "--print-logs", "--log-level", "debug", "serve", "--hostname", "127.0.0.1", "--port", String(hostPort)], {
      cwd: canonicalProject,
      env,
      stdout: "pipe",
      stderr: "pipe",
    })
    stdoutTask = new Response(serverProcess.stdout as ReadableStream<Uint8Array>).text().then((text) => { serverStdout += text })
    stderrTask = new Response(serverProcess.stderr as ReadableStream<Uint8Array>).text().then((text) => { serverStderr += text })
    client = OpenCode.make({
      baseUrl: "http://127.0.0.1:" + hostPort,
      headers: { Authorization: basicAuth(), "x-opencode-directory": canonicalProject },
    })

    await waitForServer(client, serverProcess)
    await waitForPluginActivation(client, serverProcess)
    const initialCatalog = await assertCatalog(client, preflights, "server-ready")
    checks.catalogIsExactlyLocal = initialCatalog.length === 1 && initialCatalog[0] === EXPECTED_MODEL
    if (!checks.catalogIsExactlyLocal) throw new Error("Model catalog preflight failed; no session prompt was sent.")

    sessionIDs.edit = await createPinnedSession(client, "recovery edit error", preflights)
    await promptSession(client, sessionIDs.edit, EDIT_PROMPT + ": cause an unmatched native edit, then inspect its error.", preflights)
    const editMessages = (await client.message.list({ sessionID: sessionIDs.edit })).data
    const editTool = findToolState(editMessages, "edit")
    const editState = editTool?.state as Record<string, unknown> | undefined
    const editErrorText = JSON.stringify(editState ?? {})
    const finalFileContents = await readFile(fixtureFile, "utf8")
    checks.editStayedFailed = editState?.status === "error"
    checks.editGuidancePresent = editState?.status === "error" && editErrorText.includes(EDIT_MARKER)
    checks.editFileUnchanged = finalFileContents === initialFileContents
    checks.editFollowupSawGuidance = observations.some((item) => item.responsePlan.includes("edit recovery") && item.sawEditGuidance)
    if (!checks.editStayedFailed || !checks.editGuidancePresent || !checks.editFileUnchanged || !checks.editFollowupSawGuidance) {
      assertionFailures.push("native edit failure/guidance assertions")
    }

    sessionIDs.subagent = await createPinnedSession(client, "recovery no-text subagent", preflights)
    // The provider request body is model context, not a reliable source of host session identity.
    // Bind the driver-created parent session before the native tool creates its actual child.
    subagentParentID = sessionIDs.subagent
    await promptSession(client, sessionIDs.subagent, SUBAGENT_PROMPT + ": delegate one foreground explore subagent with no textual response.", preflights)
    const subagentMessages = (await client.message.list({ sessionID: sessionIDs.subagent })).data
    const subagentTool = findToolState(subagentMessages, "subagent")
    const subagentToolState = subagentTool?.state as Record<string, unknown> | undefined
    const childRows = projectSessions(databasePath, canonicalProject).filter((row) => row.parentID === sessionIDs.subagent)
    const childInfo = childRows[0] ? await client.session.get({ sessionID: childRows[0].id }) : undefined
    const observerRecords = await readObserverRecords(observerPath)
    const subagentObservation = observerRecords.find((record) => record.tool === "subagent")
    const toolSerialized = JSON.stringify(subagentToolState ?? {})
    checks.childCreatedWithCorrectParent = childRows.length === 1 && childInfo?.parentID === sessionIDs.subagent
    checks.childModelWasPinned = childInfo !== undefined && modelRef(childInfo.model) === EXPECTED_MODEL
    checks.subagentCompleted = subagentToolState?.status === "completed"
    checks.subagentGuidanceReachedModel = observations.some((item) => item.responsePlan.includes("empty-subagent") && item.sawEmptyGuidance)
    checks.subagentStructuredOutputPreserved = subagentObservation?.status === "completed" &&
      isNoTextOutput(subagentObservation.output, childRows[0]?.id) && typeof subagentObservation.content === "string" &&
      subagentObservation.content.includes(EMPTY_MARKER)
    checks.subagentToolResultHasGuidance = toolSerialized.includes(EMPTY_MARKER)
    if (!checks.childCreatedWithCorrectParent || !checks.childModelWasPinned || !checks.subagentCompleted ||
        !checks.subagentGuidanceReachedModel || !checks.subagentStructuredOutputPreserved || !checks.subagentToolResultHasGuidance) {
      assertionFailures.push("native no-text subagent assertions")
    }

    sessionIDs.json = await createPinnedSession(client, "recovery JSON Tool.Error", preflights)
    await promptSession(client, sessionIDs.json, JSON_PROMPT + ": invoke the QA-only Tool.Error fixture.", preflights)
    const jsonMessages = (await client.message.list({ sessionID: sessionIDs.json })).data
    const jsonTool = findToolState(jsonMessages, "recovery_json_failure")
    const jsonState = jsonTool?.state as Record<string, unknown> | undefined
    const jsonErrorText = JSON.stringify(jsonState ?? {})
    const jsonObserverRecords = await readObserverRecords(observerPath)
    const jsonObserver = jsonObserverRecords.find((record) => record.tool === "recovery_json_failure")
    checks.jsonFixtureStayedFailed = jsonState?.status === "error" && jsonErrorText.includes(JSON_MARKER)
    checks.jsonFollowupSawGuidance = observations.some((item) => item.responsePlan.includes("JSON Tool.Error guidance") && item.sawJsonGuidance)
    checks.jsonFixtureWasNativeToolError = jsonObserver?.status === "error" &&
      typeof jsonObserver.error === "string" && jsonObserver.error.includes("JSON parse error") &&
      jsonObserver.error.includes(JSON_MARKER)
    if (!checks.jsonFixtureStayedFailed || !checks.jsonFollowupSawGuidance || !checks.jsonFixtureWasNativeToolError) {
      assertionFailures.push("QA-only native Tool.Error assertions")
    }

    sessionIDs.notepadGuard = await createPinnedSession(client, "recovery notepad write guard", preflights)
    await promptSession(client, sessionIDs.notepadGuard, WRITE_PROMPT + ": attempt a destructive Write to the append-only notepad and inspect the rejection.", preflights)
    const notepadMessages = (await client.message.list({ sessionID: sessionIDs.notepadGuard })).data
    const writeTool = findToolState(notepadMessages, "write")
    const writeState = writeTool?.state as Record<string, unknown> | undefined
    const writeErrorText = JSON.stringify(writeState ?? {})
    const finalNotepadContents = await readFile(notepadFile, "utf8")
    checks.notepadWriteStayedFailed = writeState?.status === "error" && writeErrorText.includes(WRITE_GUARD_MARKER)
    checks.notepadWriteFileUnchanged = finalNotepadContents === initialNotepadContents
    checks.notepadGuardReachedModel = observations.some((item) => item.responsePlan.includes("notepad write guard") && item.sawWriteGuardGuidance)
    if (!checks.notepadWriteStayedFailed || !checks.notepadWriteFileUnchanged || !checks.notepadGuardReachedModel) {
      assertionFailures.push("native notepad write guard assertions")
    }

    if (assertionFailures.length > 0) {
      throw new Error("Recovery QA assertions failed: " + assertionFailures.join(", "))
    }
  } catch (error) {
    failure = error
  } finally {
    opencodeStopped = await stopProcess(serverProcess)
    await Promise.all([stdoutTask, stderrTask])
    mockProvider.stop(true)
    mockStopped = true
    const logs = redact(serverStdout + "\n" + serverStderr)
    await writeFile(join(evidence, "server.log"), logs, "utf8")
    await writeFile(join(evidence, "mock-requests.json"), JSON.stringify(observations, null, 2) + "\n", "utf8")
    await writeFile(join(evidence, "observer.jsonl"), existsSync(observerPath) ? await readFile(observerPath, "utf8") : "", "utf8")
    const summary = {
      opencodeVersion: version,
      sourceRoot: ROOT,
      pluginDirectory: PLUGIN_DIR,
      pluginServerSha256: await fileHash(join(PLUGIN_DIR, "server.js")),
      tuiBundleSha256: await fileHash(join(PLUGIN_DIR, "tui.js")),
      canonicalTempRoot: tempRoot,
      canonicalProject,
      isolatedHome: home,
      isolatedXdgData: xdgData,
      isolatedXdgConfig: xdgConfig,
      isolatedXdgState: xdgState,
      isolatedXdgCache: xdgCache,
      isolatedDatabase: databasePath,
      projectConfig: join(evidence, "opencode.json"),
      pluginConfig: join(evidence, "omo.jsonc"),
      sessions: sessionIDs,
      modelPreflights: preflights,
      modelRequests: modelCall,
      routeFailures,
      checks,
      failed: failure instanceof Error ? { name: failure.name, message: redact(failure.message) } : failure ? redact(String(failure)) : null,
      cleanup: { opencodeStopped, mockProviderStopped: mockStopped },
      externalRealCredentialsPassed: false,
      externalProviderConfigured: false,
      mcpConfigured: false,
      realProjectFilesReadOrChanged: false,
      tempRootRetainedForInspection: true,
    }
    await writeFile(join(evidence, "runtime.json"), JSON.stringify(summary, null, 2) + "\n", "utf8")
  }

  if (failure) throw failure
  console.log("OpenCode " + version + " bounded recovery QA passed; evidence: " + evidence)
}

async function assertCatalog(
  client: ReturnType<typeof OpenCode.make>,
  preflights: Array<Record<string, unknown>>,
  phase: string,
): Promise<string[]> {
  const result = await client.model.list()
  const models = result.data.map((model) => model.providerID + "/" + model.id).sort()
  preflights.push({ phase, models })
  if (models.length !== 1 || models[0] !== EXPECTED_MODEL) {
    throw new Error("Expected only " + EXPECTED_MODEL + " in model catalog at " + phase + "; got " + JSON.stringify(models))
  }
  return models
}

async function assertSessionModel(
  client: ReturnType<typeof OpenCode.make>,
  sessionID: string,
  preflights: Array<Record<string, unknown>>,
  phase: string,
): Promise<void> {
  const info = await client.session.get({ sessionID })
  const selected = modelRef(info.model)
  preflights.push({ phase, sessionID, selectedModel: selected })
  if (selected !== EXPECTED_MODEL) {
    throw new Error("Session " + sessionID + " selected non-local model at " + phase + ": " + String(selected))
  }
}

async function createPinnedSession(
  client: ReturnType<typeof OpenCode.make>,
  title: string,
  preflights: Array<Record<string, unknown>>,
): Promise<string> {
  await assertCatalog(client, preflights, title + "-before-create")
  const session = await client.session.create({ title })
  await client.session.switchAgent({ sessionID: session.id, agent: "sisyphus" })
  await client.session.switchModel({ sessionID: session.id, model: { providerID: EXPECTED_PROVIDER, id: EXPECTED_MODEL_ID } })
  await assertSessionModel(client, session.id, preflights, title + "-before-prompt")
  return session.id
}

async function promptSession(
  client: ReturnType<typeof OpenCode.make>,
  sessionID: string,
  text: string,
  preflights: Array<Record<string, unknown>>,
): Promise<void> {
  await assertCatalog(client, preflights, "prompt-" + sessionID)
  await assertSessionModel(client, sessionID, preflights, "prompt-" + sessionID)
  await within("Prompt " + sessionID, (async () => {
    await client.session.prompt({ sessionID, text })
    await client.session.wait({ sessionID })
  })())
}

async function waitForChildSession(
  client: ReturnType<typeof OpenCode.make>,
  databasePath: string,
  directory: string,
  parentID: string,
): Promise<ProjectSession> {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const child = projectSessions(databasePath, directory).find((row) => row.parentID === parentID)
    if (child) return child
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error("Native subagent child session did not appear before local provider response.")
}

function findToolState(messages: readonly unknown[], name: string): Record<string, unknown> | undefined {
  return toolParts(messages).find((part) => String(part.name).toLowerCase() === name.toLowerCase())
}

function isNoTextOutput(value: unknown, expectedSessionID?: string): boolean {
  if (!value || typeof value !== "object") return false
  const output = value as Record<string, unknown>
  return output.status === "completed" &&
    (expectedSessionID === undefined || output.sessionID === expectedSessionID) &&
    typeof output.output === "string" && (output.output.trim() === "" || output.output.trim() === NO_TEXT)
}

async function readObserverRecords(path: string): Promise<Array<Record<string, unknown>>> {
  if (!existsSync(path)) return []
  const raw = await readFile(path, "utf8")
  return raw.split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>)
}

async function fileHash(path: string): Promise<string | null> {
  if (!existsSync(path)) return null
  const crypto = await import("node:crypto")
  return crypto.createHash("sha256").update(await readFile(path)).digest("hex")
}

async function mainWithSavedAttempt(): Promise<void> {
  try {
    await main()
  } catch (error) {
    const message = error instanceof Error ? error.stack ?? error.message : String(error)
    console.error(message)
    process.exitCode = 1
  }
}

await mainWithSavedAttempt()
