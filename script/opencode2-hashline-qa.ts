/** Isolated OpenCode 2.0.18 runtime proof for hashline mode: LINE#ID read, edit, write summary and string edits. */
import { readFile, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import {
	ROOT, createRootSession, gitState, preflight, prepareIsolation, promptAndWait,
	sha256, sse, startHost, startMock, stopHost, toolSse, verifyArtifact, writeEvidence, writeHostConfig, writeOriginProbe,
	type Check, type Host, type QaModel,
} from "./opencode2-qa-harness"

const EVIDENCE = resolve(process.env.OPENCODE2_QA_EVIDENCE_DIR ?? join(ROOT, ".omo/evidence/20260927-hashline"))
const PLUGIN_DIR = resolve(process.env.OPENCODE2_PLUGIN_DIR ?? join(ROOT, "dist/opencode2"))
const CLI = process.env.OPENCODE2_CLI?.trim() ? resolve(process.env.OPENCODE2_CLI.trim()) : ""
const EXPECTED_SHA = process.env.OPENCODE2_EXPECTED_SERVER_SHA256 ?? ""
const PASSWORD = "hashline-local-qa-only"
const PROBE_ID = "omo-hashline-origin-probe"
const MODELS: QaModel[] = [{ id: "qa-model", context: 200_000, output: 8_192 }]

async function main(): Promise<void> {
	const { actualSHA, cliVersion } = await verifyArtifact(PLUGIN_DIR, EXPECTED_SHA, CLI)
	const isolation = await prepareIsolation(EVIDENCE, "omo-hashline-qa-")
	const checks: Check[] = []
	const check = (name: string, passed: boolean, detail?: unknown) => checks.push({ name, passed, ...(detail === undefined ? {} : { detail }) })
	const target = join(isolation.project, "target.txt")
	const created = join(isolation.project, "created.txt")
	await writeFile(target, "alpha\nbeta\ngamma\n")
	let sessionID: string | undefined
	const mock = startMock(MODELS, (request, context) => {
		const id = `hl-${request.index}`
		if (request.kind !== "primary" || request.sessionID !== sessionID) return sse("HL auxiliary", id, request.model)
		const turn = context.turn("hashline")
		if (turn === 1) return toolSse([{ name: "read", args: { filePath: target } }], id, request.model)
		if (turn === 2) {
			const anchor = /(\d+#[A-Z0-9]+)\|beta/.exec(request.toolResults.join("\n"))?.[1] ?? "missing"
			return toolSse([{ name: "edit", args: { filePath: target, edits: [{ op: "replace", pos: anchor, lines: ["BETA_BY_HASHLINE"] }] } }], id, request.model)
		}
		if (turn === 3) return toolSse([{ name: "write", args: { filePath: created, content: "one\ntwo\nthree" } }], id, request.model)
		if (turn === 4) return toolSse([{ name: "edit", args: { filePath: target, oldString: "gamma", newString: "GAMMA_BY_STRING" } }], id, request.model)
		return sse("HL_DONE", id, request.model)
	})
	await writeOriginProbe(isolation.probeDirectory, PROBE_ID, mock.origin, MODELS)
	let host: Host | undefined
	let failure: string | undefined
	const state: Record<string, unknown> = {}
	try {
		state.config = await writeHostConfig({ isolation, pluginDir: PLUGIN_DIR, probeID: PROBE_ID, mockOrigin: mock.origin, models: MODELS, defaultModel: "qa-model", omo: { hashline_edit: true } })
		host = await startHost(CLI, isolation, PASSWORD)
		await preflight(host, PROBE_ID, MODELS, "qa-model")
		sessionID = await createRootSession(host.client, isolation.project, "HL hashline", "sisyphus", "qa-model")
		await promptAndWait(host.client, sessionID, "HL_RUN edit the files.", "hashline")
		const requests = mock.requests.filter((item) => item.sessionID === sessionID && item.kind === "primary")
		const results = requests.at(-1)?.toolResults ?? []
		state.results = results
		const finalTarget = await readFile(target, "utf8")
		check("read returns LINE#ID anchors in hashline mode", results.some((value) => /\d+#[A-Z0-9]+\|alpha/.test(value)), { first: results[0]?.slice(0, 300) })
		check("edit accepts LINE#ID anchors and a plain string replacement in hashline mode",
			finalTarget === "alpha\nBETA_BY_HASHLINE\nGAMMA_BY_STRING\n", { finalTarget, results })
		check("write reports the legacy hashline line-count summary", results.some((value) => value.includes("File written successfully. 3 lines written.")) &&
			(await readFile(created, "utf8")) === "one\ntwo\nthree", { results })
		check("the edit tool advertised to the model is the hashline editor", requests[0]!.toolNames.includes("edit") && JSON.stringify(requests[0]!.body.tools).includes("LINE#ID"),
			{ tools: requests[0]!.toolNames })
		check("all model requests were local and attributed",
			mock.requests.length > 0 && mock.originFailures.length === 0 && mock.unexpectedPaths.length === 0 && mock.requests.every((item) => item.originValid),
			{ total: mock.requests.length, originFailures: mock.originFailures })
	} catch (error) {
		failure = error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ""}` : String(error)
	} finally {
		const exit = await stopHost(host)
		mock.stop()
		const driverSHA = sha256(await readFile(join(import.meta.dir, "opencode2-hashline-qa.ts")))
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
	if (checks.some((item) => !item.passed)) throw new Error("Hashline native QA checks failed")
}

main().catch((error) => {
	console.error(error)
	process.exitCode = 1
})
