/** Isolated OpenCode 2.0.18 runtime proof that a tool call cut off by a host crash is paired before the next request. */
import { readFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import {
	ROOT, asRecord, createRootSession, gitState, preflight, prepareIsolation,
	sha256, sse, startHost, startMock, stopHost, toolSse, verifyArtifact, waitFor, within, writeEvidence, writeHostConfig, writeOriginProbe,
	type Check, type Host, type MockRequest, type QaModel,
} from "./opencode2-qa-harness"

const EVIDENCE = resolve(process.env.OPENCODE2_QA_EVIDENCE_DIR ?? join(ROOT, ".omo/evidence/20260927-tool-pair"))
const PLUGIN_DIR = resolve(process.env.OPENCODE2_PLUGIN_DIR ?? join(ROOT, "dist/opencode2"))
const CLI = process.env.OPENCODE2_CLI?.trim() ? resolve(process.env.OPENCODE2_CLI.trim()) : ""
const EXPECTED_SHA = process.env.OPENCODE2_EXPECTED_SERVER_SHA256 ?? ""
const PASSWORD = "tool-pair-local-qa-only"
const PROBE_ID = "omo-tool-pair-origin-probe"
const MODELS: QaModel[] = [{ id: "qa-model", context: 200_000, output: 8_192 }]
const INTERRUPTED = "[Tool execution was interrupted before it produced output]"

function pairing(request: MockRequest) {
	const messages = Array.isArray(request.body.messages) ? request.body.messages.map(asRecord) : []
	const calls = messages.flatMap((message) => Array.isArray(message?.tool_calls) ? message.tool_calls.map((call) => String(asRecord(call)?.id)) : [])
	const results = messages.flatMap((message) => message?.role === "tool" ? [String(message.tool_call_id)] : [])
	return { calls, results, unpaired: calls.filter((id) => !results.includes(id)) }
}

async function main(): Promise<void> {
	const { actualSHA, cliVersion } = await verifyArtifact(PLUGIN_DIR, EXPECTED_SHA, CLI)
	const isolation = await prepareIsolation(EVIDENCE, "omo-tool-pair-qa-")
	const checks: Check[] = []
	const check = (name: string, passed: boolean, detail?: unknown) => checks.push({ name, passed, ...(detail === undefined ? {} : { detail }) })
	let sessionID: string | undefined
	const started = join(isolation.tempRoot, "tool-started.txt")
	const mock = startMock(MODELS, (request, context) => {
		const id = `tp-${request.index}`
		if (request.kind !== "primary") return sse("TP auxiliary", id, request.model)
		const last = request.users.at(-1) ?? ""
		if (request.sessionID === sessionID && last.includes("TP_RUN") && context.turn("run") === 1) {
			return toolSse([{ name: "shell", args: { command: `printf started > '${started}'; sleep 60`, description: "long running fixture" } }], id, request.model)
		}
		return sse("TP_DONE", id, request.model)
	})
	await writeOriginProbe(isolation.probeDirectory, PROBE_ID, mock.origin, MODELS)

	let host: Host | undefined
	let failure: string | undefined
	const exits: Array<number | null> = []
	const state: Record<string, unknown> = {}
	try {
		state.config = await writeHostConfig({ isolation, pluginDir: PLUGIN_DIR, probeID: PROBE_ID, mockOrigin: mock.origin, models: MODELS, defaultModel: "qa-model", omo: {} })
		host = await startHost(CLI, isolation, PASSWORD)
		await preflight(host, PROBE_ID, MODELS, "qa-model")
		sessionID = await createRootSession(host.client, isolation.project, "TP crash", "sisyphus", "qa-model")
		await within("tool prompt", host.client.session.prompt({ sessionID, text: "TP_RUN start the long task." }))
		await waitFor("tool running", async () => (await readFile(started, "utf8").catch(() => "")) === "started" ? true : undefined, 20_000)
		host.process.kill("SIGKILL")
		await host.process.exited
		exits.push(host.process.exitCode)
		await Promise.all([host.stdoutTask, host.stderrTask])
		await writeEvidence(isolation.attempt, "crashed.server.stderr.log", host.stderr)
		host = undefined

		host = await startHost(CLI, isolation, PASSWORD)
		await preflight(host, PROBE_ID, MODELS, "qa-model")
		const before = mock.requests.length
		await Bun.sleep(1_500)
		await within("follow-up prompt", host.client.session.prompt({ sessionID, text: "TP_AFTER continue after the crash." }))
		await within("follow-up execution", host.client.session.wait({ sessionID }), 90_000)
		const after = mock.requests.slice(before).filter((item) => item.sessionID === sessionID && item.kind === "primary")
		const rows = after.map((item) => ({ ...pairing(item), omoRepair: item.toolResults.some((value) => value.includes(INTERRUPTED)), users: item.users.map((value) => value.slice(0, 80)) }))
		state.afterRestart = rows
		const history = (await host.client.message.list({ sessionID })).data
		const toolPart = history.flatMap((row) => Array.isArray(asRecord(row)?.content) ? asRecord(row)!.content as unknown[] : []).map(asRecord).find((part) => part?.type === "tool")
		state.storedToolState = asRecord(toolPart?.state)?.status
		check("every tool call in requests after the crash has a matching tool result",
			rows.length > 0 && rows.every((row) => row.calls.length > 0 && row.unpaired.length === 0), rows)
		check("the follow-up turn completed", JSON.stringify(history).includes("TP_DONE"), { storedToolState: state.storedToolState, omoRepaired: rows.some((row) => row.omoRepair) })
		check("all model requests were local and attributed",
			mock.requests.length > 0 && mock.originFailures.length === 0 && mock.unexpectedPaths.length === 0 && mock.requests.every((item) => item.originValid),
			{ total: mock.requests.length, originFailures: mock.originFailures })
	} catch (error) {
		failure = error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ""}` : String(error)
	} finally {
		exits.push(await stopHost(host))
		mock.stop()
		const driverSHA = sha256(await readFile(join(import.meta.dir, "opencode2-tool-pair-qa.ts")))
		const result = {
			startedAt: new Date().toISOString(), productionSource: gitState(),
			bundle: { serverPath: join(PLUGIN_DIR, "server.js"), expectedSHA: EXPECTED_SHA, actualSHA, driverSHA },
			cli: { path: CLI, version: cliVersion }, isolation, sessionID, state, checks,
			allChecksPassed: checks.length > 0 && checks.every((item) => item.passed), failure,
			cleanup: { opencodeExitCodes: exits, mockStopped: true, tempRetained: true },
		}
		await writeEvidence(isolation.attempt, "runtime.json", result)
		await writeEvidence(isolation.attempt, "requests.json", mock.requests.map((item) => ({ ...item, body: undefined })))
		if (host) await writeEvidence(isolation.attempt, "server.stderr.log", host.stderr)
		await writeEvidence(isolation.attempt, "summary.txt", `${failure ? `FAILURE\n${failure}\n` : ""}checks=${checks.filter((item) => item.passed).length}/${checks.length}\nserverSHA=${actualSHA}\n`)
		process.stdout.write(JSON.stringify({ evidence: isolation.attempt, allChecksPassed: result.allChecksPassed, checks: checks.map(({ name, passed }) => ({ name, passed })), state, failure }, null, 2) + "\n")
	}
	if (failure) throw new Error(failure)
	if (checks.some((item) => !item.passed)) throw new Error("Tool pair native QA checks failed")
}

main().catch((error) => {
	console.error(error)
	process.exitCode = 1
})
