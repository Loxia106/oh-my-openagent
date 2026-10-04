/** Isolated OpenCode 2.0.22 runtime proof for OMO model policies: retry-time fallback, timeout watchdog, ultrawork and model_fallback. */
import { readFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import {
	PROVIDER, ROOT, asRecord, contentText, createRootSession, gitState, modelRef, preflight, prepareIsolation, promptAndWait,
	sha256, sse, startHost, startMock, stopHost, verifyArtifact, waitFor, within, writeEvidence, writeHostConfig, writeOriginProbe,
	type Check, type Host, type MockRequest, type QaModel,
} from "./opencode2-qa-harness"

const EVIDENCE = resolve(process.env.OPENCODE2_QA_EVIDENCE_DIR ?? join(ROOT, ".omo/evidence/20260927-model-policy"))
const PLUGIN_DIR = resolve(process.env.OPENCODE2_PLUGIN_DIR ?? join(ROOT, "dist/opencode2"))
const CLI = process.env.OPENCODE2_CLI?.trim() ? resolve(process.env.OPENCODE2_CLI.trim()) : ""
const EXPECTED_SHA = process.env.OPENCODE2_EXPECTED_SERVER_SHA256 ?? ""
const PASSWORD = "model-policy-local-qa-only"
const PROBE_ID = "omo-model-policy-origin-probe"
const MODELS: QaModel[] = [
	{ id: "qa-model", context: 200_000, output: 8_192 },
	{ id: "qa-backup", context: 200_000, output: 8_192 },
	{ id: "qa-backup2", context: 200_000, output: 8_192 },
	{ id: "qa-ultra", context: 200_000, output: 8_192 },
]
const WATCHDOG_SECONDS = 3

async function assistantText(host: Host, sessionID: string): Promise<string> {
	return (await host.client.message.list({ sessionID })).data.flatMap((item) => {
		const row = asRecord(item)
		return row?.type === "assistant" ? [contentText(row.content)] : []
	}).join("\n")
}

async function main(): Promise<void> {
	const { actualSHA, cliVersion } = await verifyArtifact(PLUGIN_DIR, EXPECTED_SHA, CLI)
	const isolation = await prepareIsolation(EVIDENCE, "omo-model-policy-qa-")
	const checks: Check[] = []
	const check = (name: string, passed: boolean, detail?: unknown) => checks.push({ name, passed, ...(detail === undefined ? {} : { detail }) })
	const ids: Record<string, string | undefined> = {}
	const hanging = new Set<ReadableStreamDefaultController<Uint8Array>>()
	const statusFor = (request: MockRequest): number | "hang" | undefined => {
		const session = request.sessionID
		if (request.kind !== "primary") return undefined
		if (session === ids.rate && request.model === "qa-model") return 429
		if (session === ids.hang && request.model === "qa-model") return 429
		if (session === ids.hang && request.model === "qa-backup") return "hang"
		if (session === ids.modelFallback && request.model === "qa-model") return 503
		return undefined
	}
	const mock = startMock(MODELS, (request) => {
		const id = `mp-${request.index}`
		if (request.kind !== "primary") return sse("MP auxiliary", id, request.model)
		const status = statusFor(request)
		if (status === 429) return Response.json({ error: { message: "Fixture rate limit", type: "rate_limit_error", code: "rate_limit_exceeded" } }, { status: 429 })
		if (status === 503) return Response.json({ error: { message: "Fixture service overloaded", type: "server_error" } }, { status: 503 })
		if (status === "hang") {
			const stream = new ReadableStream<Uint8Array>({ start(controller) { hanging.add(controller) } })
			return new Response(stream, { headers: { "content-type": "text/event-stream; charset=utf-8" } })
		}
		const text = request.users.at(-1) ?? ""
		if (text.includes("MP_ULW")) return sse(`MP_ULW_DONE ${request.model}`, id, request.model)
		if (text.includes("MP_AFTER")) return sse(`MP_AFTER_DONE ${request.model}`, id, request.model)
		return sse(`MP_DONE ${request.model}`, id, request.model)
	})
	await writeOriginProbe(isolation.probeDirectory, PROBE_ID, mock.origin, MODELS)

	let host: Host | undefined
	let failure: string | undefined
	const exits: Array<number | null> = []
	const state: Record<string, unknown> = {}
	try {
		// Phase A: runtime_fallback with the default early-switch and a short timeout watchdog, plus ultrawork.
		state.phaseA = await writeHostConfig({
			isolation, pluginDir: PLUGIN_DIR, probeID: PROBE_ID, mockOrigin: mock.origin, models: MODELS, defaultModel: "qa-model",
			omo: {
				runtime_fallback: { enabled: true, retry_on_errors: [429], max_fallback_attempts: 3, cooldown_seconds: 0, timeout_seconds: WATCHDOG_SECONDS },
				// Without an explicit model, config migration promotes the first fallback entry to the primary model.
				agents: { sisyphus: { model: `${PROVIDER}/qa-model`, fallback_models: [`${PROVIDER}/qa-backup`, `${PROVIDER}/qa-backup2`], ultrawork: { model: `${PROVIDER}/qa-ultra` } } },
			},
		})
		host = await startHost(CLI, isolation, PASSWORD)
		state.phaseARegistry = await preflight(host, PROBE_ID, MODELS, "qa-model")

		ids.rate = await createRootSession(host.client, isolation.project, "MP retry-time fallback", "sisyphus", "qa-model")
		const rateStarted = Date.now()
		await promptAndWait(host.client, ids.rate, "MP_RATE answer with the configured model.", "rate")
		const rateDone = await waitFor("rate fallback completion", async () => (await assistantText(host!, ids.rate!)).includes("MP_DONE qa-backup") ? true : undefined, 30_000).catch(() => false)
		const rateElapsed = Date.now() - rateStarted
		const rateRequests = mock.requests.filter((item) => item.sessionID === ids.rate && item.kind === "primary")
		check("a 429 stops host retries immediately and the same request continues on the first fallback",
			rateDone === true && rateRequests.filter((item) => item.model === "qa-model").length === 1 &&
			rateRequests.some((item) => item.model === "qa-backup") && rateElapsed < 30_000 &&
			rateRequests.filter((item) => item.model === "qa-backup").every((item) => item.users.filter((value) => value.includes("MP_RATE")).length === 1),
			{ elapsedMs: rateElapsed, sequence: rateRequests.map((item) => item.model) })

		ids.hang = await createRootSession(host.client, isolation.project, "MP watchdog", "sisyphus", "qa-model")
		const hangStarted = Date.now()
		await within("hang prompt", host.client.session.prompt({ sessionID: ids.hang, text: "MP_HANG answer even if a fallback stalls." }))
		const hangDone = await waitFor("watchdog advance", async () => (await assistantText(host!, ids.hang!)).includes("MP_DONE qa-backup2") ? true : undefined, 45_000).catch(() => false)
		const hangElapsed = Date.now() - hangStarted
		const hangRequests = mock.requests.filter((item) => item.sessionID === ids.hang && item.kind === "primary")
		const backupAt = hangRequests.find((item) => item.model === "qa-backup")?.at
		const backup2At = hangRequests.find((item) => item.model === "qa-backup2")?.at
		const hangSession = await host.client.session.get({ sessionID: ids.hang })
		check("a silent fallback is interrupted after timeout_seconds and the next fallback completes the request",
			hangDone === true && hangRequests.map((item) => item.model).join(",").startsWith("qa-model,qa-backup,qa-backup2") &&
			backupAt !== undefined && backup2At !== undefined && backup2At - backupAt >= WATCHDOG_SECONDS * 1000 - 250 &&
			modelRef(hangSession.model) === `${PROVIDER}/qa-backup2`,
			{ elapsedMs: hangElapsed, sequence: hangRequests.map((item) => ({ model: item.model, at: item.at })), watchdogGapMs: backupAt && backup2At ? backup2At - backupAt : null, model: modelRef(hangSession.model) })

		ids.ulw = await createRootSession(host.client, isolation.project, "MP ultrawork", "sisyphus", "qa-model")
		await promptAndWait(host.client, ids.ulw, "ulw MP_ULW implement the change.", "ultrawork")
		const afterUlw = await waitFor("ultrawork restore", async () => {
			const session = await host!.client.session.get({ sessionID: ids.ulw! })
			return modelRef(session.model) === `${PROVIDER}/qa-model` ? session : undefined
		}, 10_000).catch(() => undefined)
		await promptAndWait(host.client, ids.ulw, "MP_AFTER a normal turn.", "after ultrawork")
		const ulwRequests = mock.requests.filter((item) => item.sessionID === ids.ulw && item.kind === "primary")
		const ulwTurn = ulwRequests.find((item) => (item.users.at(-1) ?? "").includes("MP_ULW"))
		const nextTurn = ulwRequests.find((item) => (item.users.at(-1) ?? "").includes("MP_AFTER"))
		check("an ultrawork turn runs on agents.sisyphus.ultrawork.model and the next normal turn returns to the session model",
			ulwTurn?.model === "qa-ultra" && nextTurn?.model === "qa-model" && afterUlw !== undefined,
			{ sequence: ulwRequests.map((item) => ({ model: item.model, user: (item.users.at(-1) ?? "").slice(0, 60) })) })
		exits.push(await stopHost(host))
		await writeEvidence(isolation.attempt, "phaseA.server.stdout.log", host.stdout)
		await writeEvidence(isolation.attempt, "phaseA.server.stderr.log", host.stderr)
		host = undefined

		// Phase B: legacy model_fallback without runtime_fallback.
		state.phaseB = await writeHostConfig({
			isolation, pluginDir: PLUGIN_DIR, probeID: PROBE_ID, mockOrigin: mock.origin, models: MODELS, defaultModel: "qa-model",
			omo: { model_fallback: true, agents: { sisyphus: { model: `${PROVIDER}/qa-model`, fallback_models: [`${PROVIDER}/qa-backup`] } } },
		})
		host = await startHost(CLI, isolation, PASSWORD)
		state.phaseBRegistry = await preflight(host, PROBE_ID, MODELS, "qa-model")
		ids.modelFallback = await createRootSession(host.client, isolation.project, "MP model_fallback", "sisyphus", "qa-model")
		const mfStarted = Date.now()
		await promptAndWait(host.client, ids.modelFallback, "MP_MODEL_FALLBACK answer.", "model fallback")
		const mfDone = await waitFor("model_fallback completion", async () => (await assistantText(host!, ids.modelFallback!)).includes("MP_DONE qa-backup") ? true : undefined, 30_000).catch(() => false)
		const mfRequests = mock.requests.filter((item) => item.sessionID === ids.modelFallback && item.kind === "primary")
		check("model_fallback: true switches a 503 primary failure to the configured fallback without host retry backoff",
			mfDone === true && mfRequests.filter((item) => item.model === "qa-model").length === 1 && mfRequests.some((item) => item.model === "qa-backup") &&
			Date.now() - mfStarted < 30_000,
			{ elapsedMs: Date.now() - mfStarted, sequence: mfRequests.map((item) => item.model) })

		check("all model requests were local and attributed to fixture sessions",
			mock.requests.length > 0 && mock.originFailures.length === 0 && mock.unexpectedPaths.length === 0 && mock.requests.every((item) => item.originValid),
			{ total: mock.requests.length, originFailures: mock.originFailures, unexpectedPaths: mock.unexpectedPaths })
	} catch (error) {
		failure = error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ""}` : String(error)
	} finally {
		exits.push(await stopHost(host))
		for (const controller of hanging) { try { controller.close() } catch { /* already cancelled by the host */ } }
		mock.stop()
		const driverSHA = sha256(await readFile(join(import.meta.dir, "opencode2-model-policy-qa.ts")))
		const harnessSHA = sha256(await readFile(join(import.meta.dir, "opencode2-qa-harness.ts")))
		const result = {
			startedAt: new Date().toISOString(),
			productionSource: gitState(),
			bundle: { serverPath: join(PLUGIN_DIR, "server.js"), expectedSHA: EXPECTED_SHA, actualSHA, driverSHA, harnessSHA },
			cli: { path: CLI, version: cliVersion },
			isolation, ids, state, checks,
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
	if (checks.some((item) => !item.passed)) throw new Error("Model policy native QA checks failed")
}

main().catch((error) => {
	console.error(error)
	process.exitCode = 1
})
