/** Isolated OpenCode 2.0.22 runtime proof for the OMO monitor tools and status injection. */
import { readFile, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import {
	ROOT, asRecord, contentText, createRootSession, gitState, preflight, prepareIsolation, promptAndWait,
	sha256, sse, startHost, startMock, stopHost, toolSse, verifyArtifact, waitFor, writeEvidence, writeHostConfig, writeOriginProbe,
	type Check, type Host, type QaModel,
} from "./opencode2-qa-harness"

const EVIDENCE = resolve(process.env.OPENCODE2_QA_EVIDENCE_DIR ?? join(ROOT, ".omo/evidence/20260927-monitor"))
const PLUGIN_DIR = resolve(process.env.OPENCODE2_PLUGIN_DIR ?? join(ROOT, "dist/opencode2"))
const CLI = process.env.OPENCODE2_CLI?.trim() ? resolve(process.env.OPENCODE2_CLI.trim()) : ""
const EXPECTED_SHA = process.env.OPENCODE2_EXPECTED_SERVER_SHA256 ?? ""
const PASSWORD = "monitor-local-qa-only"
const PROBE_ID = "omo-monitor-origin-probe"
const MODELS: QaModel[] = [{ id: "qa-model", context: 200_000, output: 8_192 }]

async function main(): Promise<void> {
	const { actualSHA, cliVersion } = await verifyArtifact(PLUGIN_DIR, EXPECTED_SHA, CLI)
	const isolation = await prepareIsolation(EVIDENCE, "omo-monitor-qa-")
	const checks: Check[] = []
	const check = (name: string, passed: boolean, detail?: unknown) => checks.push({ name, passed, ...(detail === undefined ? {} : { detail }) })
	const script = join(isolation.tempRoot, "watch.sh")
	await writeFile(script, "echo MON_KEEP_FIRST\nsleep 3\necho MON_SKIP_NOISE\necho MON_KEEP_SECOND\nsleep 2\n")
	let sessionID: string | undefined
	const mock = startMock(MODELS, (request, context) => {
		const id = `mo-${request.index}`
		if (request.kind !== "primary") return sse("MO auxiliary", id, request.model)
		if (request.sessionID === sessionID) {
			if (request.users.some((value) => value.includes("[OMO MONITOR OUTPUT]"))) return sse(`MON_SEEN ${context.turn("seen")}`, id, request.model)
			if (context.turn("start") === 1) return toolSse([{ name: "monitor_start", args: { command: `sh ${script}`, label: "watcher", match_pattern: "MON_KEEP" } }], id, request.model)
			return sse("MON_STARTED", id, request.model)
		}
		return sse("MO_DEFAULT", id, request.model)
	})
	await writeOriginProbe(isolation.probeDirectory, PROBE_ID, mock.origin, MODELS)
	let host: Host | undefined
	let failure: string | undefined
	const state: Record<string, unknown> = {}
	try {
		state.config = await writeHostConfig({
			isolation, pluginDir: PLUGIN_DIR, probeID: PROBE_ID, mockOrigin: mock.origin, models: MODELS, defaultModel: "qa-model",
			omo: { monitor: { enabled: true, flush_interval_ms: 250 } },
		})
		host = await startHost(CLI, isolation, PASSWORD)
		state.registry = await preflight(host, PROBE_ID, MODELS, "qa-model")
		sessionID = await createRootSession(host.client, isolation.project, "MO monitor", "sisyphus", "qa-model")
		await promptAndWait(host.client, sessionID, "MON_RUN watch the build output.", "monitor start")
		await waitFor("monitor output processed", async () => {
			const text = JSON.stringify((await host!.client.message.list({ sessionID: sessionID! })).data)
			return text.includes("MON_KEEP_SECOND") && text.includes("Status: exited") ? true : undefined
		}, 30_000).catch(() => undefined)
		await Bun.sleep(1_500)
		const requests = mock.requests.filter((item) => item.sessionID === sessionID && item.kind === "primary")
		const delivered = requests.flatMap((item) => item.users).filter((value) => value.includes("[OMO MONITOR OUTPUT]"))
		const firstResult = requests.flatMap((item) => item.toolResults).find((value) => value.includes("Monitor started successfully")) ?? ""
		state.delivered = delivered
		check("monitor_start runs the watcher and returns a monitor ID", /monitor_id: mon_/.test(firstResult), { firstResult })
		check("matched output is delivered to the idle parent as untrusted monitor output and unmatched lines are withheld",
			delivered.some((value) => value.includes("MON_KEEP_FIRST")) && delivered.some((value) => value.includes("MON_KEEP_SECOND")) &&
			!delivered.some((value) => value.includes("MON_SKIP_NOISE")) && delivered.every((value) => value.includes("stream_policy: untrusted_observation")),
			{ delivered })
		const withStatus = requests.find((item) => item.system.some((value) => value.includes("Active monitors: mon_") && value.includes("watcher")))
		check("a turn while the monitor runs carries the active monitor status", Boolean(withStatus),
			requests.map((item) => item.system.filter((value) => value.includes("Active monitors")).map((value) => value.slice(0, 160))))
		const messages = (await host.client.message.list({ sessionID })).data
		check("the parent processed monitor output turns", messages.some((row) => asRecord(row)?.type === "assistant" && contentText(asRecord(row)?.content).includes("MON_SEEN")), { count: messages.length })
		check("all model requests were local and attributed",
			mock.requests.length > 0 && mock.originFailures.length === 0 && mock.unexpectedPaths.length === 0 && mock.requests.every((item) => item.originValid),
			{ total: mock.requests.length, originFailures: mock.originFailures })
	} catch (error) {
		failure = error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ""}` : String(error)
	} finally {
		const exit = await stopHost(host)
		mock.stop()
		const driverSHA = sha256(await readFile(join(import.meta.dir, "opencode2-monitor-qa.ts")))
		const result = {
			startedAt: new Date().toISOString(), productionSource: gitState(),
			bundle: { serverPath: join(PLUGIN_DIR, "server.js"), expectedSHA: EXPECTED_SHA, actualSHA, driverSHA },
			cli: { path: CLI, version: cliVersion }, isolation, sessionID, state, checks,
			allChecksPassed: checks.length > 0 && checks.every((item) => item.passed), failure,
			cleanup: { opencodeExitCode: exit, mockStopped: true, tempRetained: true },
		}
		await writeEvidence(isolation.attempt, "runtime.json", result)
		await writeEvidence(isolation.attempt, "requests.json", mock.requests.map((item) => ({ ...item, body: undefined })))
		if (host) await writeEvidence(isolation.attempt, "server.stderr.log", host.stderr)
		await writeEvidence(isolation.attempt, "summary.txt", `${failure ? `FAILURE\n${failure}\n` : ""}checks=${checks.filter((item) => item.passed).length}/${checks.length}\nserverSHA=${actualSHA}\n`)
		process.stdout.write(JSON.stringify({ evidence: isolation.attempt, allChecksPassed: result.allChecksPassed, checks: checks.map(({ name, passed }) => ({ name, passed })), failure }, null, 2) + "\n")
	}
	if (failure) throw new Error(failure)
	if (checks.some((item) => !item.passed)) throw new Error("Monitor native QA checks failed")
}

main().catch((error) => {
	console.error(error)
	process.exitCode = 1
})
