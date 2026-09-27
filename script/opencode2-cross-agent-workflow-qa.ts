/**
 * Isolated OpenCode 2.0.18 cross-agent workflow QA.
 * Requires explicit OPENCODE2_CLI and OPENCODE2_EXPECTED_SERVER_SHA256.
 * Evidence directory must be one direct child of .omo/evidence/.
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
const EVIDENCE = resolve(process.env.OPENCODE2_QA_EVIDENCE_DIR ?? join(EVIDENCE_ROOT, "20260927-cross-agent-workflow"))
const PLUGIN_DIR = resolve(process.env.OPENCODE2_PLUGIN_DIR ?? join(ROOT, "dist", "opencode2"))
const CLI_INPUT = process.env.OPENCODE2_CLI?.trim() ?? ""
const CLI = CLI_INPUT ? resolve(CLI_INPUT) : ""
const EXPECTED_SERVER_SHA256 = process.env.OPENCODE2_EXPECTED_SERVER_SHA256 ?? ""
const PROVIDER = "omoqa"
const MODEL = "qa-model"
const API_KEY = "cross-agent-workflow-local-fake-key"
const PASSWORD = "cross-agent-workflow-local-fake-password"
const SKILL_ID = "workflow-qa-specialized"
const SKILL_BODY = "WORKFLOW_QA_SPECIALIZED_SKILL_BODY"
const TIMEOUT_MS = 90_000
const REQUEST_KINDS = new Set(["primary", "title", "compaction", "generate"])

type SessionRow = { id: string; parentID: string | null; directory: string; model: string | null; agent: string | null }
type ChildRow = { id: string; parentID: string; agent: string | null }
type Role = "parent" | "child" | "other"
type ToolCall = { name: string; args: unknown }
type RequestRecord = {
  sessionID?: string
  kind?: string
  role: Role
  parentID?: string | null
  agent?: string | null
  effectiveAgent?: string
  selectedModel?: string
  requestModel: string
  originValid: boolean
  originErrors: string[]
  tools: string[]
  toolResults: string[]
  scenarioMarkers: string[]
  hasExploreResult: boolean
  hasLibrarianResult: boolean
  hasJuniorResult: boolean
  hasOracleResult: boolean
  hasSpecializedSkill: boolean
  action: string
}
type ToolState = { name: string; status: string; input?: unknown; text: string }
type ChildEvidence = {
  id: string
  parentID: string
  agent: string | null
  outcome: string
  model: string
  assistantMarkers: string[]
  tools: Array<{ name: string; status: string; input: unknown; hasFixtureRead: boolean; hasJuniorFile: boolean; hasAtlasOutput: boolean }>
  hasSpecializedSkill: boolean
}
type PlanScenario = {
  planningStage: number
  atlasStage: number
  atlasReviewRound: 1 | 2
  planReady: boolean
  questionFormID?: string
  questionAnswered: boolean
  atlasCommandContextValid: boolean
}
type Host = {
  port: number
  databasePath: string
  process: Bun.Subprocess
  client: ReturnType<typeof OpenCode.make>
  stdout: string
  stderr: string
  stdoutTask: Promise<void>
  stderrTask: Promise<void>
}
type ParentScenario = { stage: number }

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(stableJson).join(",") + "]"
  if (isRecord(value)) return "{" + Object.keys(value).sort().map((key) => JSON.stringify(key) + ":" + stableJson(value[key])).join(",") + "}"
  return JSON.stringify(value) ?? "undefined"
}

function contentText(value: unknown): string {
  if (typeof value === "string") return value
  if (Array.isArray(value)) return value.map(contentText).filter(Boolean).join("\n")
  if (!isRecord(value)) return ""
  if (typeof value.text === "string") return value.text
  return contentText(value.content ?? value.parts ?? value.output)
}

function messagesOf(body: Record<string, unknown>): Array<Record<string, unknown>> {
  return Array.isArray(body.messages) ? body.messages.filter(isRecord) : []
}

function allText(body: Record<string, unknown>): string {
  return [contentText(body.system), contentText(body.prompt), ...messagesOf(body).map((message) => contentText(message.content ?? message.text ?? message.parts))].filter(Boolean).join("\n")
}

function userText(body: Record<string, unknown>): string {
  return messagesOf(body).filter((message) => message.role === "user").map((message) => contentText(message.content)).join("\n")
}

function toolNames(body: Record<string, unknown>): string[] {
  if (!Array.isArray(body.tools)) return []
  return body.tools.flatMap((entry) => {
    if (!isRecord(entry)) return []
    const fn = isRecord(entry.function) ? entry.function : entry
    return typeof fn.name === "string" ? [fn.name] : []
  })
}

function findTool(body: Record<string, unknown>, name: string): string | undefined {
  return toolNames(body).find((candidate) => candidate.toLowerCase() === name.toLowerCase())
}

function toolResultTexts(body: Record<string, unknown>): string[] {
  return messagesOf(body).flatMap((message) => message.role === "tool" ? [contentText(message.content)] : [])
}

function nativeSubagentAnswer(text: string): string {
	return /<subagent\b[^>]*>([\s\S]*?)<\/subagent>/.exec(text)?.[1]?.trim() ?? ""
}

function hasCompletedTodoAndOpenFinalWave(plan: string): { taskOneChecked: boolean; finalWaveItemsOpen: boolean } {
	return {
		taskOneChecked: plan.includes("- [x] 1. Implement the verified fixture output"),
		finalWaveItemsOpen: plan.includes("- [ ] F1.") && plan.includes("- [ ] F2."),
	}
}

function initialPlanText(): string {
  return `# Isolated workflow plan\n\n## TODOs\n- [ ] 1. Implement the verified fixture output\n\n## Final Verification Wave\n- [ ] F1. Verify implementation output and test evidence\n- [ ] F2. Review the plan and safety of the change\n`
}

function revisedPlanText(): string {
  return `# Isolated workflow plan\n\n## TODOs\n- [ ] 1. Implement the verified fixture output\n\n## Revision Notes\n- Add an explicit read-back check and preserve the completed checklist state.\n\n## Final Verification Wave\n- [ ] F1. Verify implementation output, read-back, and test evidence\n- [ ] F2. Review the revised plan and safety of the change\n`
}

function todoCheckedPlanText(): string {
  return revisedPlanText().replace("- [ ] 1. Implement", "- [x] 1. Implement")
}

function finalCheckedPlanText(): string {
  return todoCheckedPlanText()
    .replace("- [ ] F1.", "- [x] F1.")
    .replace("- [ ] F2.", "- [x] F2.")
}

function responseText(text: string, id: string, model: string, stream: boolean): Response {
  const created = Math.floor(Date.now() / 1000)
  if (!stream) return Response.json({
    id: "chatcmpl-" + id, object: "chat.completion", created, model,
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
    usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
  })
  return sse([
    { id: "chatcmpl-" + id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] },
    { id: "chatcmpl-" + id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
  ])
}

function toolCallResponse(calls: ToolCall[], id: string, model: string, stream: boolean): Response {
  const created = Math.floor(Date.now() / 1000)
  const toolCalls = calls.map((call, index) => ({
    index,
    id: id + "-tool-" + index,
    type: "function",
    function: { name: call.name, arguments: JSON.stringify(call.args) },
  }))
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

function sse(items: unknown[]): Response {
  return new Response(items.map((item) => "data: " + JSON.stringify(item) + "\n\n").join("") + "data: [DONE]\n\n", {
    headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive" },
  })
}

function sessionRow(databasePath: string, sessionID: string | undefined): SessionRow | undefined {
  if (!sessionID || !existsSync(databasePath)) return undefined
  try {
    const db = new Database(databasePath, { readonly: true, create: false })
    try { return db.query("SELECT id, parent_id AS parentID, directory, model, agent FROM session_v2 WHERE id = ?").get(sessionID) as SessionRow | undefined }
    finally { db.close() }
  } catch { return undefined }
}

function childRows(databasePath: string, parentID: string): ChildRow[] {
  if (!existsSync(databasePath)) return []
  try {
    const db = new Database(databasePath, { readonly: true, create: false })
    try { return db.query("SELECT id, parent_id AS parentID, agent FROM session_v2 WHERE parent_id = ? ORDER BY time_created").all(parentID) as ChildRow[] }
    finally { db.close() }
  } catch { return [] }
}

function modelFromRow(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined
  try {
    const parsed = JSON.parse(raw) as { providerID?: unknown; id?: unknown }
    return typeof parsed.providerID === "string" && typeof parsed.id === "string" ? parsed.providerID + "/" + parsed.id : undefined
  } catch { return raw }
}

function toolStates(messages: unknown): ToolState[] {
  if (!Array.isArray(messages)) return []
  return messages.flatMap((message) => {
    if (!isRecord(message) || !Array.isArray(message.content)) return []
    return message.content.flatMap((part) => {
      if (!isRecord(part) || part.type !== "tool" || typeof part.name !== "string" || !isRecord(part.state)) return []
      const state = part.state
      return [{ name: part.name, status: typeof state.status === "string" ? state.status : "unknown", input: state.input, text: contentText(state.output ?? state.error ?? state.content) }]
    })
  })
}

function assistantTexts(messages: unknown): string[] {
  if (!Array.isArray(messages)) return []
  return messages.flatMap((message) => {
    if (!isRecord(message)) return []
    const role = message.role ?? message.type ?? (isRecord(message.info) ? message.info.role : undefined)
    return role === "assistant" ? [contentText(message.content ?? message.parts ?? message.text)] : []
  })
}

function transcriptTexts(messages: unknown): string[] {
  if (!Array.isArray(messages)) return []
  return messages.flatMap((message) => {
    if (!isRecord(message)) return []
    return [contentText(message.content ?? message.parts ?? message.text)].filter(Boolean)
  })
}

function reservePort(): number {
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("reserved") })
  const port = reservation.port
  reservation.stop(true)
  assert(typeof port === "number", "Could not reserve a localhost port")
  return port
}

async function within<T>(label: string, promise: Promise<T>, timeout = TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([promise, new Promise<T>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(label + " timed out after " + timeout + "ms")), timeout)
    })])
  } finally { if (timer) clearTimeout(timer) }
}

async function waitForQuestionForm(host: Host, sessionID: string): Promise<Awaited<ReturnType<Host["client"]["session"]["form"]["list"]>>[number]> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const forms = await host.client.session.form.list({ sessionID })
    const question = forms.find((form) => form.title === "Questions" && isRecord(form.metadata) && form.metadata.kind === "question")
    if (question) return question
    await Bun.sleep(100)
  }
  throw new Error("Timed out waiting for Prometheus's native question form")
}

async function stopHost(host: Host | undefined): Promise<number | null | undefined> {
  if (!host) return undefined
  if (host.process.exitCode === null) {
    host.process.kill("SIGTERM")
    const stopped = await Promise.race([host.process.exited.then(() => true), Bun.sleep(5_000).then(() => false)])
    if (!stopped && host.process.exitCode === null) { host.process.kill("SIGKILL"); await host.process.exited }
  }
  await Promise.all([host.stdoutTask, host.stderrTask])
  return host.process.exitCode
}

async function main(): Promise<void> {
  assert(CLI_INPUT && isAbsolute(CLI_INPUT) && existsSync(CLI), "Set OPENCODE2_CLI to an explicit absolute pinned OpenCode executable")
  assert(/^[a-f0-9]{64}$/i.test(EXPECTED_SERVER_SHA256), "Set OPENCODE2_EXPECTED_SERVER_SHA256 to the frozen server bundle SHA-256")
  const relativeEvidence = relative(EVIDENCE_ROOT, EVIDENCE)
  assert(relativeEvidence && relativeEvidence !== ".." && !relativeEvidence.startsWith(".." + sep) && !relativeEvidence.includes(sep),
    "Evidence directory must be one direct child of " + EVIDENCE_ROOT)
  await mkdir(EVIDENCE_ROOT, { recursive: true })
  const evidenceRoot = await realpath(EVIDENCE_ROOT)
  await mkdir(EVIDENCE, { recursive: true })
  assert(dirname(await realpath(EVIDENCE)) === evidenceRoot, "Evidence directory escaped .omo/evidence")
  const serverPath = join(PLUGIN_DIR, "server.js")
  assert(existsSync(serverPath), "Missing frozen server bundle: " + serverPath)
  const bundleSha256 = createHash("sha256").update(await readFile(serverPath)).digest("hex")
  assert(bundleSha256 === EXPECTED_SERVER_SHA256, "Frozen server hash mismatch: " + bundleSha256)

  const runDirectory = join(EVIDENCE, "attempt-" + Date.now())
  await mkdir(runDirectory, { recursive: true })
  const tempRoot = await realpath(await mkdtemp(join(tmpdir(), "omo-cross-agent-workflow-qa-")))
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
  await Promise.all([
    project, serverCwd, home, xdgData, xdgConfig, xdgState, xdgCache, omoHome, claudeHome, claudePlugins,
    join(project, ".omo", "plans"), join(project, ".agents", "skills", SKILL_ID), join(project, "src"),
  ].map((path) => mkdir(path, { recursive: true })))
  const projectDirectory = await realpath(project)
  assert(!projectDirectory.startsWith(ROOT + sep), "QA project must be outside the checkout")
  await writeFile(claudeSettings, "{}\n")
  const sourceFixture = join(projectDirectory, "src", "fixture.ts")
  const juniorOutput = join(projectDirectory, "src", "junior-output.ts")
  const planPath = join(projectDirectory, ".omo", "plans", "qa-plan.md")
  const atlasOutput = join(projectDirectory, "src", "atlas-output.ts")
  await writeFile(sourceFixture, "export const fixture = 'WORKFLOW_FIXTURE_READ_MARKER'\n")
  await writeFile(join(projectDirectory, ".agents", "skills", SKILL_ID, "SKILL.md"), `---\nname: ${SKILL_ID}\ndescription: local cross-agent workflow QA skill\n---\n${SKILL_BODY}\nUse this instruction only in the Junior child assigned this skill.\n`)

  const probeDirectory = join(tempRoot, "origin-probe")
  const localModelServer = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      if (url.pathname.endsWith("/models")) return Response.json({ data: [{ id: MODEL, object: "model", created: 0, owned_by: "cross-agent-workflow-qa" }] })
      if (!url.pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 })
      const body = await request.json() as Record<string, unknown>
      const requestModel = typeof body.model === "string" ? body.model : ""
      const sessionID = request.headers.get("x-omo-qa-session-id") ?? undefined
      const kind = request.headers.get("x-omo-qa-kind") ?? undefined
      const effectiveAgent = request.headers.get("x-omo-qa-agent") ?? undefined
      const effectiveProvider = request.headers.get("x-omo-qa-provider") ?? undefined
      const effectiveModel = request.headers.get("x-omo-qa-model") ?? undefined
      const info = sessionRow(databasePath, sessionID)
      const selectedModel = modelFromRow(info?.model)
      const isRootParent = sessionID === parentSessionID || sessionID === planSessionID
      const ownsChild = info?.parentID === parentSessionID || info?.parentID === planSessionID
      const role: Role = isRootParent ? "parent" : ownsChild ? "child" : "other"
      const expectedAgent = role === "parent" || role === "child" ? info?.agent?.toLowerCase() : undefined
      const allConversationText = allText(body)
      const record: RequestRecord = {
        ...(sessionID ? { sessionID } : {}), ...(kind ? { kind } : {}), role,
        ...(info ? { parentID: info.parentID, agent: info.agent } : {}),
        ...(effectiveAgent ? { effectiveAgent } : {}), ...(selectedModel ? { selectedModel } : {}),
        requestModel,
        originValid: Boolean(sessionID && kind && REQUEST_KINDS.has(kind) && info && info.directory === projectDirectory
          && selectedModel === PROVIDER + "/" + MODEL && requestModel === MODEL
          && effectiveProvider === PROVIDER && effectiveModel === MODEL && effectiveAgent?.toLowerCase() === expectedAgent),
        originErrors: [],
        tools: toolNames(body),
        toolResults: toolResultTexts(body),
        scenarioMarkers: [...new Set(allConversationText.match(/\b(?:WORKFLOW|PROMETHEUS|ATLAS)_[A-Z0-9_]+\b/g) ?? [])].sort(),
        hasExploreResult: allConversationText.includes("WORKFLOW_EXPLORE_RESULT"),
        hasLibrarianResult: allConversationText.includes("WORKFLOW_LIBRARIAN_RESULT"),
        hasJuniorResult: allConversationText.includes("WORKFLOW_JUNIOR_RESULT"),
        hasOracleResult: allConversationText.includes("WORKFLOW_ORACLE_APPROVED"),
        hasSpecializedSkill: allConversationText.includes(SKILL_BODY),
        action: "completion",
      }
      if (!record.originValid) {
        record.originErrors.push("session/kind/provider/model/agent/directory mismatch")
        requestFailures.push({ sessionID, kind, role, agent: info?.agent, selectedModel, requestModel, effectiveAgent, effectiveProvider, effectiveModel })
        return Response.json({ error: { message: "Rejected nonlocal or misattributed QA request" } }, { status: 403 })
      }
      requests.push(record)
      const id = "workflow-" + requests.length
      const stream = body.stream === true
      const toolCall = (name: string, args: unknown) => {
        const actual = findTool(body, name)
        if (!actual) {
          routeFailures.push({ sessionID, expectedTool: name, available: record.tools, role, agent: effectiveAgent })
          record.action = "missing-tool:" + name
          return Response.json({ error: { message: "Expected tool absent: " + name } }, { status: 500 })
        }
        record.action = "tool:" + actual
        return toolCallResponse([{ name: actual, args }], id, requestModel, stream)
      }
      const parentToolCall = (name: string, args: unknown) => {
        const result = toolCall(name, args)
        if (result.status !== 500) parentScenario.stage += 1
        return result
      }

      if (role === "parent" && kind === "primary") {
        if (sessionID === planSessionID) {
          const resultTexts = toolResultTexts(body)
          const planToolCall = (name: string, args: unknown, nextStage: number) => {
            const result = toolCall(name, args)
            if (result.status !== 500) planScenario.atlasStage = nextStage
            return result
          }

          if (effectiveAgent?.toLowerCase() === "prometheus") {
            const stage = planScenario.planningStage
            if (stage === 0) {
              const result = toolCall("question", {
                questions: [{
                  question: "Which project should this isolated plan cover?",
                  header: "Plan scope",
                  options: [{ label: "Local fixture", description: "Use only the temporary QA project." }, { label: "Other project", description: "Do not select for this isolated test." }],
              }] })
              if (result.status !== 500) planScenario.planningStage = 1
              return result
            }
            if (stage === 1) {
              if (!resultTexts.some((text) => text.includes("Local fixture"))) {
                routeFailures.push({ scenario: "prometheus", stage, error: "public question answer missing from native tool result", resultTexts })
                return Response.json({ error: { message: "Prometheus did not receive the public question answer" } }, { status: 500 })
              }
              const result = toolCall("task", { subagent_type: "explore", description: "Discover the isolated fixture", prompt: "PROMETHEUS_DISCOVERY_CHILD Read src/fixture.ts and report PROMETHEUS_DISCOVERY_RESULT.", load_skills: [], run_in_background: false })
              if (result.status !== 500) planScenario.planningStage = 2
              return result
            }
            if (stage === 2) {
              if (!resultTexts.some((text) => text.includes("PROMETHEUS_DISCOVERY_RESULT"))) {
                routeFailures.push({ scenario: "prometheus", stage, error: "actual Explore result was not consumed", resultTexts })
                return Response.json({ error: { message: "Prometheus did not consume Explore result" } }, { status: 500 })
              }
              const result = toolCall("task", { subagent_type: "metis", description: "Analyze the plan requirements", prompt: "PROMETHEUS_METIS_CHILD Analyze the discovered local fixture and return PROMETHEUS_METIS_RESULT with a missing-test recommendation.", load_skills: [], run_in_background: false })
              if (result.status !== 500) planScenario.planningStage = 3
              return result
            }
            if (stage === 3) {
              if (!resultTexts.some((text) => text.includes("PROMETHEUS_METIS_RESULT"))) {
                routeFailures.push({ scenario: "prometheus", stage, error: "actual Metis result was not consumed", resultTexts })
                return Response.json({ error: { message: "Prometheus did not consume Metis result" } }, { status: 500 })
              }
              const result = toolCall("write", { path: planPath, content: initialPlanText() })
              if (result.status !== 500) planScenario.planningStage = 4
              return result
            }
            if (stage === 4) {
              const written = await readFile(planPath, "utf8").catch(() => "")
              if (written !== initialPlanText()) {
                routeFailures.push({ scenario: "prometheus", stage, error: "initial plan file did not match the requested native write", resultTexts, actualPlan: written })
                return Response.json({ error: { message: "Initial plan write was not confirmed" } }, { status: 500 })
              }
              const result = toolCall("task", { subagent_type: "momus", description: "Review the first plan draft", prompt: "PROMETHEUS_MOMUS_FIRST Review .omo/plans/qa-plan.md and return concrete missing coverage as PROMETHEUS_MOMUS_FIRST_NEEDS_REVISION. Do not approve an incomplete plan.", load_skills: [], run_in_background: false })
              if (result.status !== 500) planScenario.planningStage = 5
              return result
            }
            if (stage === 5) {
              if (!resultTexts.some((text) => text.includes("PROMETHEUS_MOMUS_FIRST_NEEDS_REVISION"))) {
                routeFailures.push({ scenario: "prometheus", stage, error: "Momus revision feedback was not consumed", resultTexts })
                return Response.json({ error: { message: "Prometheus did not consume first Momus review" } }, { status: 500 })
              }
              const result = toolCall("write", { path: planPath, content: revisedPlanText() })
              if (result.status !== 500) planScenario.planningStage = 6
              return result
            }
            if (stage === 6) {
              const written = await readFile(planPath, "utf8").catch(() => "")
              if (written !== revisedPlanText()) {
                routeFailures.push({ scenario: "prometheus", stage, error: "revised plan file did not match the requested native write", resultTexts, actualPlan: written })
                return Response.json({ error: { message: "Revised plan write was not confirmed" } }, { status: 500 })
              }
              const result = toolCall("task", { subagent_type: "momus", description: "Review the revised plan", prompt: "PROMETHEUS_MOMUS_SECOND Review the revised .omo/plans/qa-plan.md and return PROMETHEUS_MOMUS_SECOND_OKAY only if the missing coverage is now explicit.", load_skills: [], run_in_background: false })
              if (result.status !== 500) planScenario.planningStage = 7
              return result
            }
            if (stage === 7) {
              if (!resultTexts.some((text) => text.includes("PROMETHEUS_MOMUS_SECOND_OKAY"))) {
                routeFailures.push({ scenario: "prometheus", stage, error: "second Momus approval was not consumed", resultTexts })
                return Response.json({ error: { message: "Prometheus did not consume final Momus approval" } }, { status: 500 })
              }
              planScenario.planReady = true
              return responseText("PROMETHEUS_PLAN_READY: discovery, Metis analysis, plan revision, and final Momus approval were consumed.", id, requestModel, stream)
            }
          }

          if (effectiveAgent?.toLowerCase() === "atlas") {
            const stage = planScenario.atlasStage
            if (stage === 0) {
              const context = allText(body)
              planScenario.atlasCommandContextValid = context.includes(planPath) && context.includes("omo-ulw-execute-context")
              if (!planScenario.atlasCommandContextValid) {
                routeFailures.push({ scenario: "atlas", stage, error: "public /ulw-execute context omitted the selected plan path" })
                return Response.json({ error: { message: "Atlas did not receive the selected plan context" } }, { status: 500 })
              }
              return planToolCall("task", {
                category: "quick", description: "Implement the reviewed plan's first task",
                prompt: "## 1. TASK\n- [ ] 1. Implement the small verified workflow fixture output\n\nATLAS_TODO_IMPLEMENTATION Write src/atlas-output.ts with the workflow result marker and report ATLAS_JUNIOR_IMPLEMENTED.",
                load_skills: [], run_in_background: false,
              }, 1)
            }
            if (stage === 1) {
              if (!resultTexts.some((text) => text.includes("ATLAS_JUNIOR_IMPLEMENTED"))) {
                routeFailures.push({ scenario: "atlas", stage, error: "Junior implementation result was not consumed", resultTexts })
                return Response.json({ error: { message: "Atlas did not consume Junior implementation result" } }, { status: 500 })
              }
              return planToolCall("write", { path: planPath, content: todoCheckedPlanText() }, 2)
            }
            if (stage === 2 || stage === 5) {
              planScenario.atlasReviewRound = stage === 2 ? 1 : 2
              const round = planScenario.atlasReviewRound === 1 ? "FIRST" : "SECOND"
              const calls = [
                { name: findTool(body, "task") ?? "task", args: { subagent_type: "momus", description: round + " final-wave verification F1", prompt: `## 1. TASK\n- [ ] F1. Verify the local implementation and test evidence\n\nATLAS_FINAL_WAVE_${round}_F1 Plan: ${planPath}. Read the plan before verdict.`, load_skills: [], run_in_background: false } },
                { name: findTool(body, "task") ?? "task", args: { subagent_type: "oracle", description: round + " final-wave review F2", prompt: `## 1. TASK\n- [ ] F2. Independently review plan completion and safety\n\nATLAS_FINAL_WAVE_${round}_F2 Plan: ${planPath}. Read the plan before verdict.`, load_skills: [], run_in_background: false } },
              ]
              if (!findTool(body, "task")) {
                routeFailures.push({ scenario: "atlas", stage, error: "native task tool unavailable" })
                return Response.json({ error: { message: "Native task tool unavailable" } }, { status: 500 })
              }
              record.action = "tool:atlas-final-wave-round-" + planScenario.atlasReviewRound
              planScenario.atlasStage = stage === 2 ? 3 : 6
              return toolCallResponse(calls, id, requestModel, stream)
            }
            if (stage === 3) {
              const rejected = resultTexts.some((text) => text.includes("VERDICT: REJECT"))
              const missing = resultTexts.some((text) => text.includes("FINAL REVIEW INCOMPLETE - BOULDER PAUSED"))
              const rejectNotice = resultTexts.some((text) => text.includes("FINAL REVIEW REJECTED - BOULDER PAUSED"))
              const currentPlan = await readFile(planPath, "utf8").catch(() => "")
              const planState = hasCompletedTodoAndOpenFinalWave(currentPlan)
              if (!rejected || !missing || !rejectNotice || !planState.taskOneChecked || !planState.finalWaveItemsOpen) {
                routeFailures.push({ scenario: "atlas", stage, error: "reject/missing final-wave results or open final-wave checklist were not observed", rejected, missing, rejectNotice, ...planState, resultTexts })
                return Response.json({ error: { message: "Negative final-wave verdicts were not preserved" } }, { status: 500 })
              }
              planScenario.atlasStage = 4
              return responseText("ATLAS_NEGATIVE_FINAL_WAVE_BLOCKED: reject and missing verdict both require review before completion.", id, requestModel, stream)
            }
            if (stage === 4) {
              return planToolCall("write", { path: planPath, content: todoCheckedPlanText() }, 5)
            }
            if (stage === 6) {
              const approvals = resultTexts.map(nativeSubagentAnswer).filter((text) => /^VERDICT:\s*APPROVE\b/m.test(text)).length
              const reminder = resultTexts.some((text) => text.includes("FINAL WAVE APPROVAL GATE"))
              const currentPlan = await readFile(planPath, "utf8").catch(() => "")
              const planState = hasCompletedTodoAndOpenFinalWave(currentPlan)
              if (approvals !== 2 || !reminder || !planState.taskOneChecked || !planState.finalWaveItemsOpen) {
                routeFailures.push({ scenario: "atlas", stage, error: "two child approvals, explicit user-approval reminder, completed TODO, or open final-wave items missing", approvals, reminder, ...planState, resultTexts })
                return Response.json({ error: { message: "Final-wave approvals did not establish the user gate" } }, { status: 500 })
              }
              planScenario.atlasStage = 7
              return responseText("ATLAS_APPROVALS_WAITING_FOR_USER: all exact reviewers approved; wait for explicit user authorization before marking checkboxes.", id, requestModel, stream)
            }
            if (stage === 7) {
              if (!userText(body).includes("USER_APPROVED_FINAL_WAVE")) {
                routeFailures.push({ scenario: "atlas", stage, error: "final-wave checklist turn did not follow explicit user prompt" })
                return Response.json({ error: { message: "Final wave is still awaiting user approval" } }, { status: 500 })
              }
              return planToolCall("read", { path: planPath }, 8)
            }
            if (stage === 8) {
              const readBack = resultTexts.some((text) => text.includes("Final Verification Wave") && text.includes("- [ ] F1.") && text.includes("- [ ] F2."))
              if (!readBack) {
                routeFailures.push({ scenario: "atlas", stage, error: "approved plan was not re-read after user prompt", resultTexts })
                return Response.json({ error: { message: "Atlas did not re-read the approved plan" } }, { status: 500 })
              }
              return planToolCall("write", { path: planPath, content: finalCheckedPlanText() }, 9)
            }
            if (stage === 9) {
              const written = await readFile(planPath, "utf8").catch(() => "")
              if (written !== finalCheckedPlanText()) {
                routeFailures.push({ scenario: "atlas", stage, error: "final checked checklist was not persisted", actualPlan: written })
                return Response.json({ error: { message: "Final checked plan was not persisted after user approval" } }, { status: 500 })
              }
              return responseText("ATLAS_CHECKLIST_COMPLETED_AFTER_USER_APPROVAL", id, requestModel, stream)
            }
          }
          routeFailures.push({ scenario: "plan-parent", agent: effectiveAgent, error: "unexpected primary agent for plan workflow" })
          return Response.json({ error: { message: "Unexpected plan workflow agent: " + String(effectiveAgent) } }, { status: 500 })
        }
        const children = childRows(databasePath, parentSessionID!)
        const byAgent = (agent: string) => children.find((child) => child.agent?.toLowerCase() === agent)
        if (parentScenario.stage === 0) {
          const taskName = findTool(body, "task")
          if (!taskName) return toolCall("task", {})
          record.action = "tool:task:explore+librarian-background"
          parentScenario.stage = 1
          return toolCallResponse([
            { name: taskName, args: { subagent_type: "explore", description: "Inspect one local fixture", prompt: "WORKFLOW_EXPLORE_CHILD Read src/fixture.ts and report WORKFLOW_EXPLORE_RESULT.", load_skills: [], run_in_background: false } },
            { name: taskName, args: { subagent_type: "librarian", description: "Find local fixture context", prompt: "WORKFLOW_LIBRARIAN_CHILD Return WORKFLOW_LIBRARIAN_RESULT after checking the local context.", load_skills: [], run_in_background: true } },
          ], id, requestModel, stream)
        }
        if (parentScenario.stage === 1) {
          const librarian = byAgent("librarian")
          if (!librarian) { routeFailures.push({ stage: 1, error: "native librarian child not found", children }); return Response.json({ error: { message: "native librarian child not found" } }, { status: 500 }) }
          return parentToolCall("background_output", { task_id: librarian.id, block: true, timeout: 30_000 })
        }
        if (parentScenario.stage === 2) {
          return parentToolCall("task", {
            category: "quick", description: "Make and verify a small safe fixture change",
            prompt: "WORKFLOW_JUNIOR_CHILD Use the assigned workflow QA skill, write src/junior-output.ts with a result marker, then report WORKFLOW_JUNIOR_RESULT.",
            load_skills: [SKILL_ID], run_in_background: false,
          })
        }
        if (parentScenario.stage === 3) {
          const junior = byAgent("sisyphus-junior")
          if (!junior) { routeFailures.push({ stage: 3, error: "native Junior child not found", children }); return Response.json({ error: { message: "native Junior child not found" } }, { status: 500 }) }
          return parentToolCall("task", { task_id: junior.id, description: "Resume this exact Junior child", prompt: "WORKFLOW_JUNIOR_RESUME Read src/junior-output.ts, verify its marker, and report WORKFLOW_JUNIOR_RESUMED_RESULT.", run_in_background: false })
        }
        if (parentScenario.stage === 4) {
          const priorToolResults = toolResultTexts(body)
          const consumedResults = priorToolResults.filter((text) =>
            text.includes("WORKFLOW_EXPLORE_RESULT") || text.includes("WORKFLOW_LIBRARIAN_RESULT") ||
            text.includes("WORKFLOW_JUNIOR_RESULT") || text.includes("WORKFLOW_JUNIOR_RESUMED_RESULT"),
          ).join("\n\n")
          const requiredResults = ["WORKFLOW_EXPLORE_RESULT", "WORKFLOW_LIBRARIAN_RESULT", "WORKFLOW_JUNIOR_RESULT", "WORKFLOW_JUNIOR_RESUMED_RESULT"]
          const missingResults = requiredResults.filter((marker) => !consumedResults.includes(marker))
          if (missingResults.length > 0) {
            routeFailures.push({ stage: 4, error: "Parent did not consume actual child results before Oracle review", missingResults })
            return Response.json({ error: { message: "Missing actual prior tool results for Oracle: " + missingResults.join(", ") } }, { status: 500 })
          }
          return parentToolCall("task", {
            subagent_type: "oracle", description: "Review verified cross-agent results",
            prompt: "WORKFLOW_ORACLE_CHILD Review these actual prior native task results and the Junior verification. Return WORKFLOW_ORACLE_APPROVED only if the child outputs and verified file result are consistent.\n\n" + consumedResults,
            load_skills: [], run_in_background: false,
          })
        }
        record.action = "parent-final-completion"
        return responseText("WORKFLOW_CROSS_CHAIN_PARENT_OK: Explore, Librarian, Junior, resumed Junior, and Oracle results were consumed.", id, requestModel, stream)
      }

      if (role === "child" && kind === "primary") {
        const agent = effectiveAgent?.toLowerCase()
        const childPrompt = allText(body)
        const priorCalls = childPrimaryCounts.get(sessionID!) ?? 0
        childPrimaryCounts.set(sessionID!, priorCalls + 1)
        if (agent === "explore" && priorCalls === 0) return toolCall("read", { path: sourceFixture })
        if (agent === "explore" && childPrompt.includes("PROMETHEUS_DISCOVERY_CHILD")) return responseText("PROMETHEUS_DISCOVERY_RESULT: WORKFLOW_FIXTURE_READ_MARKER was observed.", id, requestModel, stream)
        if (agent === "explore") return responseText("WORKFLOW_EXPLORE_RESULT: WORKFLOW_FIXTURE_READ_MARKER was observed.", id, requestModel, stream)
        if (agent === "librarian") return responseText("WORKFLOW_LIBRARIAN_RESULT: local context is available.", id, requestModel, stream)
        if (agent === "metis") return responseText("PROMETHEUS_METIS_RESULT: add an explicit read-back check and preserve final checklist state.", id, requestModel, stream)
        if (agent === "sisyphus-junior" && childPrompt.includes("ATLAS_TODO_IMPLEMENTATION") && priorCalls === 0) return toolCall("write", { path: atlasOutput, content: "export const result = 'ATLAS_OUTPUT_VERIFIED'\n" })
        if (agent === "sisyphus-junior" && childPrompt.includes("ATLAS_TODO_IMPLEMENTATION")) return responseText("ATLAS_JUNIOR_IMPLEMENTED: wrote src/atlas-output.ts with ATLAS_OUTPUT_VERIFIED.", id, requestModel, stream)
        if (agent === "sisyphus-junior" && priorCalls === 0) return toolCall("write", { path: juniorOutput, content: "export const result = 'WORKFLOW_JUNIOR_FILE_VERIFIED'\n" })
        if (agent === "sisyphus-junior" && priorCalls === 1) return responseText("WORKFLOW_JUNIOR_RESULT: wrote the assigned result file.", id, requestModel, stream)
        if (agent === "sisyphus-junior" && priorCalls === 2) return toolCall("read", { path: juniorOutput })
        if (agent === "sisyphus-junior") return responseText("WORKFLOW_JUNIOR_RESUMED_RESULT: WORKFLOW_JUNIOR_FILE_VERIFIED was read and checked.", id, requestModel, stream)
        if (agent === "momus") {
          if (priorCalls === 0) return toolCall("read", { path: planPath })
          if (childPrompt.includes("PROMETHEUS_MOMUS_FIRST")) return responseText("PROMETHEUS_MOMUS_FIRST_NEEDS_REVISION: add a read-back check and preserve final checklist state.", id, requestModel, stream)
          if (childPrompt.includes("PROMETHEUS_MOMUS_SECOND")) return responseText("PROMETHEUS_MOMUS_SECOND_OKAY: the revised plan covers the missing review feedback.", id, requestModel, stream)
          if (childPrompt.includes("ATLAS_FINAL_WAVE_SECOND_F1")) return responseText("VERDICT: APPROVE\nThe implementation output and plan checklist match.", id, requestModel, stream)
          if (childPrompt.includes("ATLAS_FINAL_WAVE_FIRST_F1")) return responseText("VERDICT: REJECT\nThe final plan needs a documented read-back check.", id, requestModel, stream)
        }
        if (agent === "oracle") {
          if (childPrompt.includes("ATLAS_FINAL_WAVE_FIRST_F2") || childPrompt.includes("ATLAS_FINAL_WAVE_SECOND_F2")) {
            if (priorCalls === 0) return toolCall("read", { path: planPath })
            if (childPrompt.includes("ATLAS_FINAL_WAVE_SECOND_F2")) return responseText("VERDICT: APPROVE\nThe revised plan and checked implementation are consistent.", id, requestModel, stream)
            return responseText("The plan has no independent final verdict yet; this review is incomplete.", id, requestModel, stream)
          }
          return responseText("WORKFLOW_ORACLE_APPROVED: all child results and the verified file are consistent.", id, requestModel, stream)
        }
        routeFailures.push({ role, agent, sessionID, error: "unexpected child agent" })
        return Response.json({ error: { message: "Unexpected native child agent: " + String(agent) } }, { status: 500 })
      }
      record.action = role === "other" ? "unexpected-session" : "auxiliary-completion"
      if (role === "other" && kind === "primary") {
        routeFailures.push({ role, kind, sessionID, error: "primary request outside root-owned child tree" })
        return Response.json({ error: { message: "Unexpected primary session" } }, { status: 500 })
      }
      return responseText("WORKFLOW_AUXILIARY_OK", id, requestModel, body.stream === true)
    },
  })
  const mockOrigin = "http://127.0.0.1:" + localModelServer.port
  await mkdir(probeDirectory, { recursive: true })
  await writeFile(join(probeDirectory, "index.js"), `export default { id: "omo-cross-agent-workflow-origin", setup: async ({ session }) => { const model = await session.hook("model.request", (event) => { if (event.model.providerID !== ${JSON.stringify(PROVIDER)} || event.model.id !== ${JSON.stringify(MODEL)}) throw new Error("QA blocked nonlocal model request"); event.headers["x-omo-qa-agent"] = String(event.agent); event.headers["x-omo-qa-provider"] = String(event.model.providerID); event.headers["x-omo-qa-model"] = String(event.model.id); }); const http = await session.hook("http.request", (event) => { if (new URL(event.request.url).origin !== ${JSON.stringify(mockOrigin)}) throw new Error("QA blocked nonlocal HTTP destination"); const headers = new Headers(event.request.headers); headers.set("x-omo-qa-session-id", event.sessionID); headers.set("x-omo-qa-kind", event.kind); event.request = new Request(event.request, { headers }); }); return async () => { await Promise.all([model.dispose(), http.dispose()]); }; } }\n`)

  const providerConfig = {
    name: "Isolated native cross-agent workflow QA provider",
    npm: "@ai-sdk/openai-compatible",
    options: { baseURL: mockOrigin + "/v1", apiKey: API_KEY },
    models: { [MODEL]: { name: "Workflow QA local model", tool_call: true, limit: { context: 200_000, output: 8_192 } } },
  }
  const projectConfig = {
    $schema: "https://opencode.ai/config.json",
    plugins: [probeDirectory, PLUGIN_DIR],
    enabled_providers: [PROVIDER],
    model: PROVIDER + "/" + MODEL,
    default_agent: "sisyphus",
    provider: { [PROVIDER]: providerConfig },
    mcp: {},
    telemetry: false,
    permission: { read: "allow", grep: "allow", glob: "allow", write: "allow", edit: "allow", task: "allow", subagent: "allow", background_output: "allow", question: "allow" },
  }
  const agentOverrides = Object.fromEntries([
    "sisyphus", "hephaestus", "prometheus", "atlas", "sisyphus-junior", "explore", "librarian", "oracle", "multimodal-looker", "metis", "momus",
  ].map((name) => [name, { model: PROVIDER + "/" + MODEL }]))
  const omoConfig = {
    telemetry: { enabled: false },
    "[opencode]": {
      telemetry: false,
      agents: agentOverrides,
      categories: { quick: { model: PROVIDER + "/" + MODEL } },
      disabled_hooks: ["comment-checker"],
      disabled_mcps: ["websearch", "context7", "grep_app", "lsp"],
      mcp_env_allowlist: [],
      claude_code: { mcp: false, agents: false, skills: false, commands: false, plugins: false, hooks: false },
    },
  }
  await writeFile(join(projectDirectory, "opencode.json"), JSON.stringify(projectConfig, null, 2) + "\n")
  await writeFile(join(projectDirectory, ".omo", "omo.jsonc"), JSON.stringify(omoConfig, null, 2) + "\n")
  await writeFile(join(runDirectory, "config-redacted.json"), JSON.stringify({
    opencode: { ...projectConfig, provider: { [PROVIDER]: { ...providerConfig, options: { baseURL: mockOrigin + "/v1", apiKey: "[redacted-fake-key]" } } } },
    omo: omoConfig,
  }, null, 2) + "\n")

  const env = {
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

  const requests: RequestRecord[] = []
  const requestFailures: unknown[] = []
  const routeFailures: unknown[] = []
  const childPrimaryCounts = new Map<string, number>()
  const parentScenario: ParentScenario = { stage: 0 }
  const planScenario: PlanScenario = { planningStage: 0, atlasStage: 0, atlasReviewRound: 1, planReady: false, questionAnswered: false, atlasCommandContextValid: false }
  const checks: Record<string, boolean> = {}
  const cleanup: { serverExitCode?: number | null; mockStopped: boolean; tempRootRetained: boolean } = { mockStopped: false, tempRootRetained: true }
  let parentSessionID: string | undefined
  let planSessionID: string | undefined
  let host: Host | undefined
  let version = ""
  let failure: string | undefined
  let messages: unknown
  let childrenEvidence: ChildEvidence[] = []
  let finalOutcome: string | undefined
  let probePluginActive = false
  let omoPluginActive = false
  let providerIDs: string[] = []
  let modelIDs: string[] = []
  let mcpNames: string[] = []
  let defaultModel: string | undefined
  let sessionCountBefore: number | null = null
  let sessionCountAfter: number | null = null
  let planQuestionEvidence: Record<string, unknown> | undefined
  let planParentOutcome: string | undefined
  let planParentTexts: string[] = []
  let planParentTools: ToolState[] = []
  let planChildrenEvidence: ChildEvidence[] = []
  let atlasOutputText = ""
  let planContentsAfterFinalWave = ""

  const versionResult = Bun.spawnSync([CLI, "--version"], { cwd: serverCwd, env, stdout: "pipe", stderr: "pipe" })
  version = versionResult.stdout.toString().trim()
  const startedAt = new Date().toISOString()
  try {
    assert(versionResult.exitCode === 0 && version.includes("2.0.18"), "Expected pinned OpenCode 2.0.18; got " + version)
    const port = reservePort()
    const serverCommand = [CLI, "--print-logs", "--log-level", "debug", "serve", "--hostname", "127.0.0.1", "--port", String(port)]
    const process = Bun.spawn(serverCommand, { cwd: serverCwd, env, stdout: "pipe", stderr: "pipe" })
    const password = Buffer.from("opencode:" + PASSWORD).toString("base64")
    host = {
      port,
      databasePath,
      process,
      client: OpenCode.make({ baseUrl: "http://127.0.0.1:" + port, headers: { Authorization: "Basic " + password, "x-opencode-directory": projectDirectory } }),
      stdout: "",
      stderr: "",
      stdoutTask: Promise.resolve(),
      stderrTask: Promise.resolve(),
    }
    host.stdoutTask = new Response(process.stdout as ReadableStream<Uint8Array>).text().then((value) => { host!.stdout = value })
    host.stderrTask = new Response(process.stderr as ReadableStream<Uint8Array>).text().then((value) => { host!.stderr = value })
    const readyUntil = Date.now() + 20_000
    let ready = false
    while (Date.now() < readyUntil && !ready) {
      if (process.exitCode !== null) throw new Error("Native server exited during startup: " + process.exitCode)
      try { await host.client.server.info(); ready = true } catch { await Bun.sleep(100) }
    }
    assert(ready, "Native server readiness timed out")
    const activeUntil = Date.now() + 35_000
    let activated = false
    while (Date.now() < activeUntil && !activated) {
      const [plugins, agents] = await Promise.all([host.client.plugin.list(), host.client.agent.list()])
      const failedPlugin = plugins.data.find((plugin) => plugin.state.status === "failed")
      assert(!failedPlugin, "Native plugin failed: " + JSON.stringify(failedPlugin))
      omoPluginActive = plugins.data.some((plugin) => plugin.id === "oh-my-openagent" && plugin.state.status === "active")
      probePluginActive = plugins.data.some((plugin) => plugin.id === "omo-cross-agent-workflow-origin" && plugin.state.status === "active")
      activated = omoPluginActive && probePluginActive && agents.data.some((agent) => agent.id === "sisyphus")
      if (!activated) await Bun.sleep(150)
    }
    assert(activated, "OMO and local origin probe did not activate")
    const [agents, providers, models, mcps, modelDefault] = await Promise.all([
      host.client.agent.list(), host.client.provider.list(), host.client.model.list(), host.client.mcp.list(), host.client.model.default(),
    ])
    providerIDs = providers.data.map((provider) => provider.id).sort()
    modelIDs = models.data.map((model) => model.providerID + "/" + model.id).sort()
    mcpNames = mcps.data.map((mcp) => mcp.name)
    assert(modelDefault.data, "Native model.default returned no model")
    defaultModel = modelDefault.data.providerID + "/" + modelDefault.data.id
    assert(stableJson(providerIDs) === stableJson([PROVIDER]), "Unexpected enabled providers: " + stableJson(providerIDs))
    assert(stableJson(modelIDs) === stableJson([PROVIDER + "/" + MODEL]), "Unexpected model catalog: " + stableJson(modelIDs))
    assert(mcpNames.length === 0, "Unexpected MCP servers: " + stableJson(mcpNames))
    assert(defaultModel === PROVIDER + "/" + MODEL, "Default model is not the local mock")
    assert(agents.data.some((agent) => agent.id === "sisyphus") && agents.data.some((agent) => agent.id === "sisyphus-junior")
      && agents.data.some((agent) => agent.id === "explore") && agents.data.some((agent) => agent.id === "librarian")
      && agents.data.some((agent) => agent.id === "oracle") && agents.data.some((agent) => agent.id === "prometheus")
      && agents.data.some((agent) => agent.id === "atlas") && agents.data.some((agent) => agent.id === "metis")
      && agents.data.some((agent) => agent.id === "momus"), "Required OMO agents did not register")

    sessionCountBefore = (() => {
      const db = new Database(databasePath, { readonly: true, create: false })
      try { return (db.query("SELECT COUNT(*) AS count FROM session_v2").get() as { count: number }).count }
      finally { db.close() }
    })()
    const session = await host.client.session.create({ title: "Native Sisyphus cross-agent workflow QA", location: { directory: projectDirectory } })
    parentSessionID = session.id
    assert(session.location.directory === projectDirectory, "Parent session escaped fixture project")
    await host.client.session.switchAgent({ sessionID: session.id, agent: "sisyphus" })
    await host.client.session.switchModel({ sessionID: session.id, model: { providerID: PROVIDER, id: MODEL } })
    const parent = await host.client.session.get({ sessionID: session.id })
    assert(parent.location.directory === projectDirectory && parent.agent === "sisyphus" && parent.model?.providerID === PROVIDER && parent.model.id === MODEL,
      "Parent is not pinned to the isolated Sisyphus/local model")
    const promptMarker = "WORKFLOW_SISYPHUS_PARENT"
    await within("Sisyphus cross-agent parent prompt", host.client.session.prompt({ sessionID: session.id, text: promptMarker + " Start the checked native Explore/Librarian/Junior/Oracle workflow." }))
    await within("Sisyphus cross-agent workflow completion", host.client.session.wait({ sessionID: session.id }))
    const completed = await host.client.session.get({ sessionID: session.id })
    finalOutcome = completed.outcome
    messages = await host.client.message.list({ sessionID: session.id })
    const parentText = assistantTexts((messages as { data?: unknown }).data).join("\n")
    const parentTools = toolStates((messages as { data?: unknown }).data)
    const children = childRows(databasePath, session.id)
    childrenEvidence = await Promise.all(children.map(async (row): Promise<ChildEvidence> => {
      const child = await host!.client.session.get({ sessionID: row.id })
      const childMessages = await host!.client.message.list({ sessionID: row.id })
      const transcript = [...transcriptTexts(childMessages.data), ...toolStates(childMessages.data).map((tool) => tool.text)].join("\n")
      return {
        id: row.id,
        parentID: row.parentID,
        agent: row.agent,
        outcome: child.outcome ?? "unknown",
        model: child.model ? child.model.providerID + "/" + child.model.id : "",
        assistantMarkers: assistantTexts(childMessages.data).filter((text) => text.includes("WORKFLOW_")),
        tools: toolStates(childMessages.data).map((tool) => ({ name: tool.name, status: tool.status, input: tool.input, hasFixtureRead: tool.text.includes("WORKFLOW_FIXTURE_READ_MARKER"), hasJuniorFile: tool.text.includes("WORKFLOW_JUNIOR_FILE_VERIFIED"), hasAtlasOutput: contentText(tool.input).includes("ATLAS_OUTPUT_VERIFIED") })),
        hasSpecializedSkill: transcript.includes(SKILL_BODY),
      }
    }))
    const childByAgent = new Map(childrenEvidence.map((row) => [row.agent?.toLowerCase() ?? "", row]))
    const explore = childByAgent.get("explore")
    const librarian = childByAgent.get("librarian")
    const junior = childByAgent.get("sisyphus-junior")
    const oracle = childByAgent.get("oracle")
    const juniorRead = childrenEvidence.find((row) => row.agent?.toLowerCase() === "sisyphus-junior")
      ?.tools.some((tool) => tool.name === "read" && tool.status === "completed" && tool.hasJuniorFile) === true
    const juniorWrites = childrenEvidence.find((row) => row.agent?.toLowerCase() === "sisyphus-junior")
      ?.tools.filter((tool) => tool.name === "write" && tool.status === "completed").length ?? 0
    const parentToolText = parentTools.map((tool) => tool.text).join("\n")
    const juniorOutputText = await readFile(juniorOutput, "utf8").catch(() => "")
    const parentRequests = requests.filter((request) => request.sessionID === session.id && request.kind === "primary")
    const childRequests = requests.filter((request) => request.role === "child" && request.kind === "primary")
    checks.hostAndLocalBundle = version.includes("2.0.18") && bundleSha256 === EXPECTED_SERVER_SHA256
    checks.localOnlyPreflight = providerIDs.length === 1 && providerIDs[0] === PROVIDER && modelIDs.length === 1 && modelIDs[0] === PROVIDER + "/" + MODEL
      && defaultModel === PROVIDER + "/" + MODEL && mcpNames.length === 0 && probePluginActive && omoPluginActive
    checks.nativeParentOutcome = completed.outcome === "succeeded" && parentText.includes("WORKFLOW_CROSS_CHAIN_PARENT_OK")
    checks.exploreForegroundChild = Boolean(explore && explore.parentID === session.id && explore.outcome === "succeeded" && explore.model === PROVIDER + "/" + MODEL
      && explore.assistantMarkers.some((text) => text.includes("WORKFLOW_EXPLORE_RESULT")))
    checks.librarianBackgroundChildConsumed = Boolean(librarian && librarian.parentID === session.id && librarian.outcome === "succeeded" && librarian.model === PROVIDER + "/" + MODEL
      && librarian.assistantMarkers.some((text) => text.includes("WORKFLOW_LIBRARIAN_RESULT"))
      && parentTools.some((tool) => tool.name === "background_output" && tool.status === "completed" && tool.text.includes("WORKFLOW_LIBRARIAN_RESULT")))
    checks.categoryJuniorSkillAndSafeWrite = Boolean(junior && junior.parentID === session.id && junior.outcome === "succeeded" && junior.model === PROVIDER + "/" + MODEL
      && junior.hasSpecializedSkill && juniorWrites === 1 && juniorOutputText.includes("WORKFLOW_JUNIOR_FILE_VERIFIED")
      && childRequests.some((request) => request.sessionID === (junior as { id: string }).id && request.hasSpecializedSkill))
    checks.juniorResumeReusedSameSession = Boolean(junior && children.filter((row) => row.agent?.toLowerCase() === "sisyphus-junior").length === 1
      && juniorRead && parentTools.filter((tool) => tool.name === "task" && tool.status === "completed" && tool.text.includes("WORKFLOW_JUNIOR_RESUMED_RESULT")).length === 1
      && junior.assistantMarkers.some((text) => text.includes("WORKFLOW_JUNIOR_RESUMED_RESULT")))
    checks.oracleReceivedAndReturnedActualResults = Boolean(oracle && oracle.parentID === session.id && oracle.outcome === "succeeded" && oracle.model === PROVIDER + "/" + MODEL
      && requests.some((request) => request.sessionID === (oracle as { id: string }).id && request.hasExploreResult && request.hasLibrarianResult && request.hasJuniorResult)
      && parentToolText.includes("WORKFLOW_ORACLE_APPROVED") && parentText.includes("WORKFLOW_CROSS_CHAIN_PARENT_OK"))
    checks.allProviderRequestsHaveVerifiedNativeOrigins = requests.length >= 8 && requests.every((request) => request.originValid)
      && requestFailures.length === 0 && routeFailures.length === 0 && parentRequests.length > 0 && childRequests.length >= 6
    checks.childrenBelongOnlyToThisParent = children.length === 4 && children.every((child) => child.parentID === session.id)
      && [explore, librarian, junior, oracle].every(Boolean)
    sessionCountAfter = (() => {
      const db = new Database(databasePath, { readonly: true, create: false })
      try { return (db.query("SELECT COUNT(*) AS count FROM session_v2").get() as { count: number }).count }
      finally { db.close() }
    })()
    checks.onlyFixtureSessionsInIsolatedDatabase = sessionCountBefore === 0 && sessionCountAfter === 5
    const sisySessionCountAfter = sessionCountAfter

    const planSession = await host.client.session.create({ title: "Native Prometheus to Atlas workflow QA", location: { directory: projectDirectory } })
    planSessionID = planSession.id
    assert(planSession.location.directory === projectDirectory, "Prometheus plan session escaped fixture project")
    await host.client.session.switchAgent({ sessionID: planSession.id, agent: "prometheus" })
    await host.client.session.switchModel({ sessionID: planSession.id, model: { providerID: PROVIDER, id: MODEL } })
    const prometheusSession = await host.client.session.get({ sessionID: planSession.id })
    assert(prometheusSession.location.directory === projectDirectory && prometheusSession.agent === "prometheus"
      && prometheusSession.model?.providerID === PROVIDER && prometheusSession.model.id === MODEL,
    "Planning parent is not pinned to Prometheus and the isolated local model")

    const questionPromptResult = host.client.session.prompt({
      sessionID: planSession.id,
      text: "PROMETHEUS_PLAN_PARENT Ask me which project scope to use, then discover, plan, revise from review feedback, and get a final Momus review.",
    }).then((value) => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error: String(error) }))
    const questionForm = await within("Prometheus native question form", waitForQuestionForm(host, planSession.id), 35_000)
    const questionField = questionForm.fields.find((field) => field.key === "q0")
    assert(questionForm.sessionID === planSession.id && questionForm.title === "Questions" && questionField?.type === "string"
      && questionField.options?.some((option) => option.value === "Local fixture"),
    "Prometheus question form did not expose the expected local-only choice")
    const primaryRequestsBeforeAnswer = requests.filter((request) => request.sessionID === planSession.id && request.kind === "primary").length
    const childCountBeforeAnswer = childRows(databasePath, planSession.id).length
    assert(primaryRequestsBeforeAnswer === 1 && childCountBeforeAnswer === 0, "Prometheus asked before any child work started")
    await host.client.session.form.reply({ sessionID: planSession.id, formID: questionForm.id, answer: { q0: "Local fixture" } })
    planScenario.questionAnswered = true
    planScenario.questionFormID = questionForm.id
    planQuestionEvidence = {
      id: questionForm.id,
      title: questionForm.title,
      metadataKind: isRecord(questionForm.metadata) ? questionForm.metadata.kind : undefined,
      fieldKeys: questionForm.fields.map((field) => field.key),
      selectedAnswer: "Local fixture",
      primaryRequestsBeforeAnswer,
      childCountBeforeAnswer,
    }
    const questionPromptResponse = await within("Prometheus question prompt request completion", questionPromptResult)
    assert(questionPromptResponse.ok, "Prometheus question prompt failed: " + (questionPromptResponse.ok ? "" : questionPromptResponse.error))
    await within("Prometheus planning completion", host.client.session.wait({ sessionID: planSession.id }))
    let planSessionInfo = await host.client.session.get({ sessionID: planSession.id })
    planParentOutcome = planSessionInfo.outcome
    let planMessages = await host.client.message.list({ sessionID: planSession.id })
    planParentTexts = assistantTexts(planMessages.data)
    planParentTools = toolStates(planMessages.data)

    assert(planScenario.planReady && planParentTexts.join("\n").includes("PROMETHEUS_PLAN_READY"), "Prometheus did not finish discovery and plan approval")
    const planInitialContents = await readFile(planPath, "utf8")
    assert(planInitialContents === revisedPlanText(), "Momus-approved plan file did not preserve the requested revision")
    const beforeExecuteAgent = planSessionInfo.agent
    planScenario.atlasStage = 0
    await within("native ulw-execute command", host.client.session.command({ sessionID: planSession.id, name: "ulw-execute", text: "qa-plan" }))
    await within("first Atlas final-wave attempt", host.client.session.wait({ sessionID: planSession.id }))
    planSessionInfo = await host.client.session.get({ sessionID: planSession.id })
    assert(planSessionInfo.agent === "atlas", "/ulw-execute did not hand the selected native session to Atlas")
    planMessages = await host.client.message.list({ sessionID: planSession.id })
    planParentTexts = assistantTexts(planMessages.data)
    planParentTools = toolStates(planMessages.data)
    const planAfterRejectedWave = await readFile(planPath, "utf8")
    assert(planParentTexts.join("\n").includes("ATLAS_NEGATIVE_FINAL_WAVE_BLOCKED"), "Atlas did not stop after REJECT and missing final verdicts")
    assert(planAfterRejectedWave.includes("- [x] 1.") && planAfterRejectedWave.includes("- [ ] F1.") && planAfterRejectedWave.includes("- [ ] F2."),
      "The rejected/missing final wave must leave both final checkboxes open")

    const identicalCommandDebounceWaitMs = 1_100
    await Bun.sleep(identicalCommandDebounceWaitMs)
    planScenario.atlasStage = 4
    await within("native ulw-execute retry command", host.client.session.command({ sessionID: planSession.id, name: "ulw-execute", text: "qa-plan" }))
    await within("Atlas approved final-wave gate", host.client.session.wait({ sessionID: planSession.id }))
    planSessionInfo = await host.client.session.get({ sessionID: planSession.id })
    assert(planSessionInfo.agent === "atlas", "second /ulw-execute command did not retain Atlas")
    planMessages = await host.client.message.list({ sessionID: planSession.id })
    planParentTexts = assistantTexts(planMessages.data)
    planParentTools = toolStates(planMessages.data)
    const planAfterApprovals = await readFile(planPath, "utf8")
    assert(planParentTexts.join("\n").includes("ATLAS_APPROVALS_WAITING_FOR_USER"), "Atlas did not stop at the user-approval boundary")
    assert(planAfterApprovals.includes("- [x] 1.") && planAfterApprovals.includes("- [ ] F1.") && planAfterApprovals.includes("- [ ] F2."),
      "Reviewer approvals alone must not check final-wave items")

    await within("explicit final-wave user approval prompt", host.client.session.prompt({
      sessionID: planSession.id,
      text: "USER_APPROVED_FINAL_WAVE You may now mark the final checklist complete because I have reviewed and approved the exact two reviewer verdicts.",
    }))
    await within("Atlas user-approved checklist completion", host.client.session.wait({ sessionID: planSession.id }))
    planSessionInfo = await host.client.session.get({ sessionID: planSession.id })
    planMessages = await host.client.message.list({ sessionID: planSession.id })
    planParentTexts = assistantTexts(planMessages.data)
    planParentTools = toolStates(planMessages.data)
    planParentOutcome = planSessionInfo.outcome
    planContentsAfterFinalWave = await readFile(planPath, "utf8")
    atlasOutputText = await readFile(atlasOutput, "utf8").catch(() => "")
    const planChildren = childRows(databasePath, planSession.id)
    planChildrenEvidence = await Promise.all(planChildren.map(async (row): Promise<ChildEvidence> => {
      const child = await host!.client.session.get({ sessionID: row.id })
      const childMessages = await host!.client.message.list({ sessionID: row.id })
      const transcript = [...transcriptTexts(childMessages.data), ...toolStates(childMessages.data).map((tool) => tool.text)].join("\n")
      return {
        id: row.id,
        parentID: row.parentID,
        agent: row.agent,
        outcome: child.outcome ?? "unknown",
        model: child.model ? child.model.providerID + "/" + child.model.id : "",
        assistantMarkers: assistantTexts(childMessages.data).filter((text) => /(?:WORKFLOW|PROMETHEUS|ATLAS)_/.test(text)),
        tools: toolStates(childMessages.data).map((tool) => ({ name: tool.name, status: tool.status, input: tool.input, hasFixtureRead: tool.text.includes("WORKFLOW_FIXTURE_READ_MARKER"), hasJuniorFile: tool.text.includes("WORKFLOW_JUNIOR_FILE_VERIFIED"), hasAtlasOutput: contentText(tool.input).includes("ATLAS_OUTPUT_VERIFIED") })),
        hasSpecializedSkill: transcript.includes(SKILL_BODY),
      }
    }))
    const planChildCounts = Object.fromEntries(["explore", "metis", "momus", "sisyphus-junior", "oracle"].map((agent) => [
      agent,
      planChildrenEvidence.filter((child) => child.agent?.toLowerCase() === agent).length,
    ]))
    const planParentRequestRecords = requests.filter((request) => request.sessionID === planSession.id && request.kind === "primary")
    const planToolText = planParentTools.map((tool) => tool.text).join("\n")
    const finalWaveApprovals = planParentTools
      .filter((tool) => tool.name === "task")
      .map((tool) => nativeSubagentAnswer(tool.text))
      .filter((answer) => /^VERDICT:\s*APPROVE\b/m.test(answer)).length
    const planUserTranscript = transcriptTexts(planMessages.data).join("\n")
    const finalMarkerCount = planParentTexts.join("\n").split("ATLAS_CHECKLIST_COMPLETED_AFTER_USER_APPROVAL").length - 1

    checks.prometheusQuestionAnsweredBeforePlanning = Boolean(planQuestionEvidence && planScenario.questionAnswered && planParentTools.some((tool) => tool.name === "question" && tool.status === "completed" && tool.text.includes("Local fixture"))
      && planParentRequestRecords.some((request) => request.scenarioMarkers.includes("PROMETHEUS_PLAN_PARENT")) && childCountBeforeAnswer === 0)
    checks.prometheusConsumedExploreMetisAndMomusRevision = planScenario.planningStage === 7 && planScenario.planReady
      && planParentRequestRecords.some((request) => request.scenarioMarkers.includes("PROMETHEUS_DISCOVERY_RESULT"))
      && planParentRequestRecords.some((request) => request.scenarioMarkers.includes("PROMETHEUS_METIS_RESULT"))
      && planParentRequestRecords.some((request) => request.scenarioMarkers.includes("PROMETHEUS_MOMUS_FIRST_NEEDS_REVISION"))
      && planParentRequestRecords.some((request) => request.scenarioMarkers.includes("PROMETHEUS_MOMUS_SECOND_OKAY"))
      && planParentTexts.join("\n").includes("PROMETHEUS_PLAN_READY")
    checks.ulwExecuteHandsPlanSessionToAtlas = beforeExecuteAgent === "prometheus" && planScenario.atlasCommandContextValid
      && planSessionInfo.agent === "atlas"
    const afterRejectedState = hasCompletedTodoAndOpenFinalWave(planAfterRejectedWave)
    const afterApprovalsState = hasCompletedTodoAndOpenFinalWave(planAfterApprovals)
    checks.atlasBlocksRejectedAndMissingFinalWave = planParentTexts.join("\n").includes("ATLAS_NEGATIVE_FINAL_WAVE_BLOCKED")
      && planToolText.includes("VERDICT: REJECT") && planToolText.includes("FINAL REVIEW REJECTED - BOULDER PAUSED")
      && planToolText.includes("FINAL REVIEW INCOMPLETE - BOULDER PAUSED")
      && afterRejectedState.taskOneChecked && afterRejectedState.finalWaveItemsOpen
    checks.atlasWaitsForUserAfterBothApprovals = planParentTexts.join("\n").includes("ATLAS_APPROVALS_WAITING_FOR_USER")
      && finalWaveApprovals === 2 && planToolText.includes("FINAL WAVE APPROVAL GATE")
      && afterApprovalsState.taskOneChecked && afterApprovalsState.finalWaveItemsOpen
    checks.atlasCompletesOnlyAfterExplicitUserPrompt = planParentOutcome === "succeeded" && planUserTranscript.includes("USER_APPROVED_FINAL_WAVE")
      && planContentsAfterFinalWave === finalCheckedPlanText() && finalMarkerCount === 1
    checks.atlasJuniorWroteActualOutput = planChildCounts["sisyphus-junior"] === 1 && atlasOutputText.includes("ATLAS_OUTPUT_VERIFIED")
      && planChildrenEvidence.some((child) => child.agent?.toLowerCase() === "sisyphus-junior" && child.outcome === "succeeded" && child.parentID === planSession.id
        && child.tools.some((tool) => tool.name === "write" && tool.status === "completed" && tool.hasAtlasOutput))
    checks.prometheusAtlasChildrenSucceededUnderExactParent = planChildrenEvidence.length === 9
      && planChildrenEvidence.every((child) => child.parentID === planSession.id && child.outcome === "succeeded" && child.model === PROVIDER + "/" + MODEL)
      && stableJson(planChildCounts) === stableJson({ explore: 1, metis: 1, momus: 4, "sisyphus-junior": 1, oracle: 2 })
    checks.nativeQuestionReviewAndFinalResultsWereConsumed = planParentTools.some((tool) => tool.name === "task" && tool.text.includes("PROMETHEUS_DISCOVERY_RESULT"))
      && planParentTools.some((tool) => tool.name === "task" && tool.text.includes("PROMETHEUS_METIS_RESULT"))
      && planParentTools.some((tool) => tool.name === "task" && tool.text.includes("PROMETHEUS_MOMUS_FIRST_NEEDS_REVISION"))
      && planParentTools.some((tool) => tool.name === "task" && tool.text.includes("PROMETHEUS_MOMUS_SECOND_OKAY"))
      && planParentTools.some((tool) => tool.name === "task" && tool.text.includes("ATLAS_JUNIOR_IMPLEMENTED"))
    checks.allProviderRequestsHaveVerifiedNativeOrigins = requests.length >= 20 && requests.every((request) => request.originValid)
      && requestFailures.length === 0 && routeFailures.length === 0
    sessionCountAfter = (() => {
      const db = new Database(databasePath, { readonly: true, create: false })
      try { return (db.query("SELECT COUNT(*) AS count FROM session_v2").get() as { count: number }).count }
      finally { db.close() }
    })()
    checks.onlyFixtureSessionsInIsolatedDatabase = sessionCountBefore === 0 && sessionCountAfter === 15

    const summary = {
      gitHead: Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: ROOT, stdout: "pipe", stderr: "pipe" }).stdout.toString().trim(),
      runtime: version,
      serverBundleSha256: bundleSha256,
      expectedServerSha256: EXPECTED_SERVER_SHA256,
      driverSha256: createHash("sha256").update(await readFile(join(import.meta.dir, "opencode2-cross-agent-workflow-qa.ts"))).digest("hex"),
      projectDirectory,
      tempRoot,
      tempRootRetained: existsSync(tempRoot),
      databasePath,
      envKeys: Object.keys(env),
      providerIDs,
      modelIDs,
      defaultModel,
      mcpNames,
      pluginActive: { omoPluginActive, probePluginActive },
      parentSessionID: session.id,
      parentOutcome: completed.outcome,
      parentStageCount: parentScenario.stage,
      parentFinalMarker: parentText.includes("WORKFLOW_CROSS_CHAIN_PARENT_OK"),
      parentToolResults: parentTools.map((tool) => ({ name: tool.name, status: tool.status, hasExplore: tool.text.includes("WORKFLOW_EXPLORE_RESULT"), hasLibrarian: tool.text.includes("WORKFLOW_LIBRARIAN_RESULT"), hasJunior: tool.text.includes("WORKFLOW_JUNIOR_RESULT"), hasResumedJunior: tool.text.includes("WORKFLOW_JUNIOR_RESUMED_RESULT"), hasOracle: tool.text.includes("WORKFLOW_ORACLE_APPROVED") })),
      juniorOutputText,
      children: childrenEvidence,
      planScenario,
      planSessionID: planSession.id,
      planParentOutcome,
      identicalCommandDebounceWaitMs,
      planQuestionEvidence,
      planParentTexts,
      planParentTools: planParentTools.map((tool) => ({ name: tool.name, status: tool.status, input: tool.input, text: tool.text })),
      planAfterRejectedWave,
      planAfterApprovals,
      finalWaveApprovals,
      planChildrenEvidence,
      planChildCounts,
      atlasOutputText,
      planContentsAfterFinalWave,
      initialSisySessionCountAfter: sisySessionCountAfter,
      requests,
      requestFailures,
      routeFailures,
      sessionCountBefore,
      sessionCountAfter,
      checks,
      passed: Object.values(checks).every(Boolean),
      startedAt,
      completedAt: new Date().toISOString(),
    }
    await writeFile(join(runDirectory, "runtime.json"), JSON.stringify(summary, null, 2) + "\n")
    await writeFile(join(runDirectory, "provider-requests.json"), JSON.stringify(requests, null, 2) + "\n")
    if (!summary.passed) throw new Error("Cross-agent workflow QA checks failed: " + JSON.stringify(checks))
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error)
  } finally {
    const serverExitCode = await stopHost(host)
    cleanup.serverExitCode = serverExitCode
    localModelServer.stop(true)
    cleanup.mockStopped = true
    cleanup.tempRootRetained = existsSync(tempRoot)
    await Promise.all([
      writeFile(join(runDirectory, "server.stdout.log"), (host?.stdout ?? "").replaceAll(PASSWORD, "[redacted-test-password]").replaceAll(API_KEY, "[redacted-test-key]")),
      writeFile(join(runDirectory, "server.stderr.log"), (host?.stderr ?? "").replaceAll(PASSWORD, "[redacted-test-password]").replaceAll(API_KEY, "[redacted-test-key]")),
      writeFile(join(runDirectory, "cleanup.json"), JSON.stringify(cleanup, null, 2) + "\n"),
    ])
    if (failure) {
      const existing = await readFile(join(runDirectory, "runtime.json"), "utf8").catch(() => "{}")
      let base: Record<string, unknown> = {}
      try { base = JSON.parse(existing) as Record<string, unknown> } catch { /* preserve a malformed artifact separately via failure text */ }
      await writeFile(join(runDirectory, "runtime.json"), JSON.stringify({
        ...base,
        gitHead: Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: ROOT, stdout: "pipe", stderr: "pipe" }).stdout.toString().trim(),
        runtime: version,
        serverBundleSha256: bundleSha256,
        expectedServerSha256: EXPECTED_SERVER_SHA256,
        driverSha256: createHash("sha256").update(await readFile(join(import.meta.dir, "opencode2-cross-agent-workflow-qa.ts"))).digest("hex"),
        tempRoot,
        projectDirectory,
        parentSessionID,
        planSessionID,
        parentOutcome: finalOutcome,
        planParentOutcome,
        planQuestionEvidence,
        planScenario,
        planParentTexts,
        planParentTools: planParentTools.map((tool) => ({ name: tool.name, status: tool.status, input: tool.input, text: tool.text })),
        children: childrenEvidence,
        planChildrenEvidence,
        atlasOutputText,
        planContentsAfterFinalWave,
        requests,
        requestFailures,
        routeFailures,
        sessionCountBefore,
        sessionCountAfter,
        probePluginActive,
        omoPluginActive,
        providerIDs,
        modelIDs,
        defaultModel,
        mcpNames,
        checks,
        cleanup,
        failure,
      }, null, 2) + "\n")
      await writeFile(join(runDirectory, "failure.txt"), failure + "\n")
    }
  }

  const existingRuntime = await readFile(join(runDirectory, "runtime.json"), "utf8")
  await writeFile(join(runDirectory, "runtime.json"), JSON.stringify({ ...(JSON.parse(existingRuntime) as Record<string, unknown>), cleanup }, null, 2) + "\n")
  const runtime = await readFile(join(runDirectory, "runtime.json"), "utf8")
  const summary = JSON.parse(runtime) as { passed?: boolean; checks?: Record<string, boolean>; failure?: string }
  process.stdout.write(JSON.stringify({ evidence: runDirectory, passed: summary.passed === true, checks: summary.checks, failure: summary.failure }, null, 2) + "\n")
  if (summary.passed !== true) throw new Error("Cross-agent workflow QA did not pass; inspect " + join(runDirectory, "runtime.json"))
}

await main()
