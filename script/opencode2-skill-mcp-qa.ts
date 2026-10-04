/** Isolated OpenCode 2.0.22 runtime proof for skill_mcp tools, per-URL cdp instances, prompts and permissions. */
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import {
	ROOT, createRootSession, gitState, preflight, prepareIsolation, promptAndWait,
	sha256, sse, startHost, startMock, stopHost, toolSse, verifyArtifact, writeEvidence, writeHostConfig, writeOriginProbe,
	type Check, type Host, type MockRequest, type QaModel,
} from "./opencode2-qa-harness"

const EVIDENCE = resolve(process.env.OPENCODE2_QA_EVIDENCE_DIR ?? join(ROOT, ".omo/evidence/20260927-skill-mcp"))
const PLUGIN_DIR = resolve(process.env.OPENCODE2_PLUGIN_DIR ?? join(ROOT, "dist/opencode2"))
const CLI = process.env.OPENCODE2_CLI?.trim() ? resolve(process.env.OPENCODE2_CLI.trim()) : ""
const EXPECTED_SHA = process.env.OPENCODE2_EXPECTED_SERVER_SHA256 ?? ""
const PASSWORD = "skill-mcp-local-qa-only"
const PROBE_ID = "omo-skill-mcp-origin-probe"
const MODELS: QaModel[] = [{ id: "qa-model", context: 200_000, output: 8_192 }]
const CDP = "http://127.0.0.1:9222"
const STEPS: Array<Record<string, unknown>> = [
	{ mcp_name: "qafixture", tool_name: "echo", arguments: { text: "hello" } },
	{ mcp_name: "qafixture", tool_name: "echo", arguments: { text: "hello" }, cdp_url: CDP },
	{ mcp_name: "qafixture", prompt_name: "summarize", arguments: { text: "notes" } },
	{ mcp_name: "qafixture", tool_name: "secret", arguments: {}, cdp_url: CDP },
	{ mcp_name: "qafixture", tool_name: "open", arguments: {}, cdp_url: CDP },
]

async function main(): Promise<void> {
	const { actualSHA, cliVersion } = await verifyArtifact(PLUGIN_DIR, EXPECTED_SHA, CLI)
	const isolation = await prepareIsolation(EVIDENCE, "omo-skill-mcp-qa-")
	const checks: Check[] = []
	const check = (name: string, passed: boolean, detail?: unknown) => checks.push({ name, passed, ...(detail === undefined ? {} : { detail }) })
	const skillDir = join(isolation.project, ".claude", "skills", "qa-mcp")
	await mkdir(skillDir, { recursive: true })
	const sdk = join(ROOT, "node_modules/@modelcontextprotocol/sdk/dist/esm/server")
	const serverPath = join(isolation.tempRoot, "qa-mcp-server.mjs")
	const secretMarker = join(isolation.tempRoot, "secret-called.txt")
	await writeFile(serverPath, [
		`import { writeFileSync } from "node:fs"`,
		`import { McpServer } from ${JSON.stringify(join(sdk, "mcp.js"))}`,
		`import { StdioServerTransport } from ${JSON.stringify(join(sdk, "stdio.js"))}`,
		`import { z } from ${JSON.stringify(join(ROOT, "node_modules/zod/index.js"))}`,
		`const index = process.argv.indexOf("--cdp-endpoint")`,
		`const cdp = index >= 0 ? process.argv[index + 1] : "none"`,
		`const server = new McpServer({ name: "qa-fixture", version: "1.0.0" })`,
		`server.registerTool("echo", { description: "Echo text", inputSchema: { text: z.string() } }, ({ text }) => ({ content: [{ type: "text", text: "SKILL_MCP_ECHO:" + text + " CDP:" + cdp }] }))`,
		`server.registerTool("secret", { description: "Must stay denied", inputSchema: {} }, () => { writeFileSync(${JSON.stringify(secretMarker)}, "called"); return { content: [{ type: "text", text: "SECRET_EXECUTED" }] } })`,
		`server.registerTool("open", { description: "Same shape as secret, no base deny", inputSchema: {} }, () => ({ content: [{ type: "text", text: "OPEN_EXECUTED CDP:" + cdp }] }))`,
		`server.registerPrompt("summarize", { description: "Summarize", argsSchema: { text: z.string() } }, ({ text }) => ({ messages: [{ role: "user", content: { type: "text", text: "SKILL_MCP_PROMPT_SUMMARY:" + text + " CDP:" + cdp } }] }))`,
		`await server.connect(new StdioServerTransport())`,
	].join("\n"))
	await writeFile(join(skillDir, "SKILL.md"), "---\nname: qa-mcp\ndescription: QA skill with an MCP server\n---\nUse skill_mcp with qafixture.\n")
	await writeFile(join(skillDir, "mcp.json"), JSON.stringify({ mcpServers: { qafixture: { command: process.execPath, args: [serverPath] } } }, null, 2))

	let sessionID: string | undefined
	const mock = startMock(MODELS, (request, context) => {
		const id = `sm-${request.index}`
		if (request.kind !== "primary") return sse("SM auxiliary", id, request.model)
		if (request.sessionID === sessionID && (request.users.at(-1) ?? "").includes("SKILL_MCP_RUN")) {
			const turn = context.turn(`${request.sessionID}:mcp`)
			const step = STEPS[turn - 1]
			if (step) return toolSse([{ name: "skill_mcp", args: step }], id, request.model)
			return sse("SKILL_MCP_DONE", id, request.model)
		}
		return sse("SM_DEFAULT", id, request.model)
	})
	await writeOriginProbe(isolation.probeDirectory, PROBE_ID, mock.origin, MODELS)

	let host: Host | undefined
	let failure: string | undefined
	const state: Record<string, unknown> = {}
	try {
		state.config = await writeHostConfig({
			isolation, pluginDir: PLUGIN_DIR, probeID: PROBE_ID, mockOrigin: mock.origin, models: MODELS, defaultModel: "qa-model",
			omo: { claude_code: { mcp: true, agents: false, skills: true, commands: false, plugins: false, hooks: false } },
			permission: { read: "allow", edit: "allow", shell: "allow", task: "allow", subagent: "allow", skill_mcp: "allow", "qafixture*": "allow", qafixture_secret: "deny" },
		})
		host = await startHost(CLI, isolation, PASSWORD)
		state.registry = await preflight(host, PROBE_ID, MODELS, "qa-model")
		sessionID = await createRootSession(host.client, isolation.project, "SM skill MCP", "sisyphus", "qa-model")
		await promptAndWait(host.client, sessionID, "SKILL_MCP_RUN exercise the skill MCP server.", "skill mcp", 90_000)
		const requests = mock.requests.filter((item: MockRequest) => item.sessionID === sessionID && item.kind === "primary")
		const results = requests.at(-1)?.toolResults ?? []
		const mcps = (await host.client.mcp.list()).data.map((entry) => ({ name: entry.name, status: entry.status }))
		state.results = results
		state.mcps = mcps
		const derived = mcps.find((entry) => entry.name.startsWith("qafixture-cdp-"))
		check("skill_mcp tool calls run through the native MCP server declared by the skill",
			results.some((value) => value.includes("SKILL_MCP_ECHO:hello CDP:none")) && mcps.some((entry) => entry.name === "qafixture"), { results, mcps })
		check("cdp_url starts a separate derived native instance with --cdp-endpoint",
			results.some((value) => value.includes(`SKILL_MCP_ECHO:hello CDP:${CDP}`)) && Boolean(derived), { derived, results })
		check("prompt_name returns the MCP prompt messages from the skill server",
			results.some((value) => value.includes("SKILL_MCP_PROMPT_SUMMARY:notes")), { results })
		const secretCalled = await readFile(secretMarker, "utf8").then(() => true).catch(() => false)
		// The host wildcard `qafixture*` allows every derived action. `open` has the same empty input shape as
		// `secret` and runs on the derived instance; only the base `qafixture_secret: deny` rule differs.
		check("a derived cdp tool stays denied by the base server's exact permission rule while same-shaped derived tools run",
			!secretCalled && !results.some((value) => value.includes("SECRET_EXECUTED")) && results.some((value) => value.includes("_secret")) &&
			results.some((value) => value.includes(`OPEN_EXECUTED CDP:${CDP}`)), { secretCalled, results })
		check("all model requests were local and attributed",
			mock.requests.length > 0 && mock.originFailures.length === 0 && mock.unexpectedPaths.length === 0 && mock.requests.every((item) => item.originValid),
			{ total: mock.requests.length, originFailures: mock.originFailures })
	} catch (error) {
		failure = error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ""}` : String(error)
	} finally {
		const exit = await stopHost(host)
		mock.stop()
		const driverSHA = sha256(await readFile(join(import.meta.dir, "opencode2-skill-mcp-qa.ts")))
		const harnessSHA = sha256(await readFile(join(import.meta.dir, "opencode2-qa-harness.ts")))
		const result = {
			startedAt: new Date().toISOString(),
			productionSource: gitState(),
			bundle: { serverPath: join(PLUGIN_DIR, "server.js"), expectedSHA: EXPECTED_SHA, actualSHA, driverSHA, harnessSHA },
			cli: { path: CLI, version: cliVersion },
			isolation, sessionID, state, checks,
			allChecksPassed: checks.length > 0 && checks.every((item) => item.passed),
			failure,
			cleanup: { opencodeExitCode: exit, mockStopped: true, tempRetained: true },
		}
		await writeEvidence(isolation.attempt, "runtime.json", result)
		await writeEvidence(isolation.attempt, "requests.json", mock.requests.map((item) => ({ ...item, body: undefined })))
		if (host) {
			await writeEvidence(isolation.attempt, "server.stdout.log", host.stdout)
			await writeEvidence(isolation.attempt, "server.stderr.log", host.stderr)
		}
		await writeEvidence(isolation.attempt, "summary.txt", `${failure ? `FAILURE\n${failure}\n` : ""}checks=${checks.filter((item) => item.passed).length}/${checks.length}\nserverSHA=${actualSHA}\ndriverSHA=${driverSHA}\ntempRoot=${isolation.tempRoot}\nexit=${exit}\n`)
		process.stdout.write(JSON.stringify({ evidence: isolation.attempt, allChecksPassed: result.allChecksPassed, checks: checks.map(({ name, passed }) => ({ name, passed })), failure, serverSHA: actualSHA }, null, 2) + "\n")
	}
	if (failure) throw new Error(failure)
	if (checks.some((item) => !item.passed)) throw new Error("Skill MCP native QA checks failed")
}

main().catch((error) => {
	console.error(error)
	process.exitCode = 1
})
