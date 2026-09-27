/** Isolated OpenCode 2.0.18 runtime proof for project-wide session listing/search through the OMO session index. */
import { mkdir, mkdtemp, readFile, realpath } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import {
	ROOT, createRootSession, gitState, preflight, prepareIsolation, promptAndWait,
	sha256, sse, startHost, startMock, stopHost, toolSse, verifyArtifact, writeEvidence, writeHostConfig, writeOriginProbe,
	type Check, type Host, type QaModel,
} from "./opencode2-qa-harness"

const EVIDENCE = resolve(process.env.OPENCODE2_QA_EVIDENCE_DIR ?? join(ROOT, ".omo/evidence/20260927-session-index"))
const PLUGIN_DIR = resolve(process.env.OPENCODE2_PLUGIN_DIR ?? join(ROOT, "dist/opencode2"))
const CLI = process.env.OPENCODE2_CLI?.trim() ? resolve(process.env.OPENCODE2_CLI.trim()) : ""
const EXPECTED_SHA = process.env.OPENCODE2_EXPECTED_SERVER_SHA256 ?? ""
const PASSWORD = "session-index-local-qa-only"
const PROBE_ID = "omo-session-index-origin-probe"
const MODELS: QaModel[] = [{ id: "qa-model", context: 200_000, output: 8_192 }]

async function main(): Promise<void> {
	const { actualSHA, cliVersion } = await verifyArtifact(PLUGIN_DIR, EXPECTED_SHA, CLI)
	const isolation = await prepareIsolation(EVIDENCE, "omo-session-index-qa-")
	const foreignRoot = await realpath(await mkdtemp(join(tmpdir(), "omo-session-index-foreign-")))
	await mkdir(join(foreignRoot, ".git"), { recursive: true })
	const checks: Check[] = []
	const check = (name: string, passed: boolean, detail?: unknown) => checks.push({ name, passed, ...(detail === undefined ? {} : { detail }) })
	let querySession: string | undefined
	const mock = startMock(MODELS, (request, context) => {
		const id = `si-${request.index}`
		if (request.kind !== "primary") return sse("SI auxiliary", id, request.model)
		if (request.sessionID === querySession) {
			const turn = context.turn(`${querySession}:query`)
			if (turn === 1) return toolSse([{ name: "session_list", args: { limit: 20 } }], id, request.model)
			if (turn === 2) return toolSse([{ name: "session_search", args: { query: "IDX_ALPHA_MARKER" } }], id, request.model)
			return sse("SI_QUERY_DONE", id, request.model)
		}
		return sse("SI_ACK", id, request.model)
	})
	await writeOriginProbe(isolation.probeDirectory, PROBE_ID, mock.origin, MODELS)

	let host: Host | undefined
	let failure: string | undefined
	const exits: Array<number | null> = []
	const ids: Record<string, string | undefined> = {}
	const state: Record<string, unknown> = {}
	try {
		state.config = await writeHostConfig({ isolation, pluginDir: PLUGIN_DIR, probeID: PROBE_ID, mockOrigin: mock.origin, models: MODELS, defaultModel: "qa-model", omo: {} })
		host = await startHost(CLI, isolation, PASSWORD)
		state.registry = await preflight(host, PROBE_ID, MODELS, "qa-model")
		ids.alpha = await createRootSession(host.client, isolation.project, "IDX alpha design", "sisyphus", "qa-model")
		await promptAndWait(host.client, ids.alpha, "Remember IDX_ALPHA_MARKER for the importer design.", "alpha")
		ids.beta = await createRootSession(host.client, isolation.project, "IDX beta chores", "sisyphus", "qa-model")
		await promptAndWait(host.client, ids.beta, "Unrelated IDX_BETA request.", "beta")
		const foreign = await host.client.session.create({ title: "IDX foreign project", location: { directory: foreignRoot } })
		ids.foreign = foreign.id
		state.foreignProject = { directory: foreign.location.directory, projectID: (await host.client.session.get({ sessionID: foreign.id })).projectID }
		await Bun.sleep(1_000)
		exits.push(await stopHost(host))
		host = undefined

		// A fresh host process: the listing must come from durable OMO state, not memory.
		host = await startHost(CLI, isolation, PASSWORD)
		await preflight(host, PROBE_ID, MODELS, "qa-model")
		querySession = await createRootSession(host.client, isolation.project, "IDX query", "sisyphus", "qa-model")
		await promptAndWait(host.client, querySession, "IDX_QUERY find the earlier design discussion.", "query")
		const requests = mock.requests.filter((item) => item.sessionID === querySession && item.kind === "primary")
		const results = requests.at(-1)?.toolResults ?? []
		state.results = results
		const listing = results.find((value) => value.includes(ids.alpha!) && value.includes("\"message_count\"")) ?? ""
		check("session_list after a host restart includes earlier sessions of this project that were never inspected",
			listing.includes(ids.alpha!) && listing.includes(ids.beta!) && listing.includes(querySession) && listing.includes("IDX alpha design"),
			{ listing: listing.slice(0, 1500) })
		check("sessions from another project are not listed", !results.some((value) => value.includes(ids.foreign!)), state.foreignProject)
		const search = results.find((value) => value.includes("IDX_ALPHA_MARKER")) ?? ""
		check("session_search finds text in an earlier indexed session of this project",
			search.includes(`[${ids.alpha}] user: Remember IDX_ALPHA_MARKER`) && !search.includes(`[${ids.beta}]`), { search })
		check("all model requests were local and attributed",
			mock.requests.length > 0 && mock.originFailures.length === 0 && mock.unexpectedPaths.length === 0 && mock.requests.every((item) => item.originValid),
			{ total: mock.requests.length, originFailures: mock.originFailures })
	} catch (error) {
		failure = error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ""}` : String(error)
	} finally {
		exits.push(await stopHost(host))
		mock.stop()
		const driverSHA = sha256(await readFile(join(import.meta.dir, "opencode2-session-index-qa.ts")))
		const harnessSHA = sha256(await readFile(join(import.meta.dir, "opencode2-qa-harness.ts")))
		const result = {
			startedAt: new Date().toISOString(),
			productionSource: gitState(),
			bundle: { serverPath: join(PLUGIN_DIR, "server.js"), expectedSHA: EXPECTED_SHA, actualSHA, driverSHA, harnessSHA },
			cli: { path: CLI, version: cliVersion },
			isolation, foreignRoot, ids, querySession, state, checks,
			allChecksPassed: checks.length > 0 && checks.every((item) => item.passed),
			failure,
			cleanup: { opencodeExitCodes: exits, mockStopped: true, tempRetained: true },
		}
		await writeEvidence(isolation.attempt, "runtime.json", result)
		await writeEvidence(isolation.attempt, "requests.json", mock.requests.map((item) => ({ ...item, body: undefined })))
		if (host) {
			await writeEvidence(isolation.attempt, "server.stdout.log", host.stdout)
			await writeEvidence(isolation.attempt, "server.stderr.log", host.stderr)
		}
		await writeEvidence(isolation.attempt, "summary.txt", `${failure ? `FAILURE\n${failure}\n` : ""}checks=${checks.filter((item) => item.passed).length}/${checks.length}\nserverSHA=${actualSHA}\ndriverSHA=${driverSHA}\ntempRoot=${isolation.tempRoot}\nexits=${exits.join(",")}\n`)
		process.stdout.write(JSON.stringify({ evidence: isolation.attempt, allChecksPassed: result.allChecksPassed, checks: checks.map(({ name, passed }) => ({ name, passed })), failure, serverSHA: actualSHA }, null, 2) + "\n")
	}
	if (failure) throw new Error(failure)
	if (checks.some((item) => !item.passed)) throw new Error("Session index native QA checks failed")
}

main().catch((error) => {
	console.error(error)
	process.exitCode = 1
})
