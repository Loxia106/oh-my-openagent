/** Isolated OpenCode 2.0.22 runtime proof for the delegated-child fallback watchdog (legacy first-prompt watchdog). */
import { readFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import {
	PROVIDER, ROOT, asRecord, contentText, createRootSession, gitState, preflight, prepareIsolation,
	sha256, sse, startHost, startMock, stopHost, toolSse, verifyArtifact, waitFor, within, writeEvidence, writeHostConfig, writeOriginProbe,
	type Check, type Host, type QaModel,
} from "./opencode2-qa-harness"

const EVIDENCE = resolve(process.env.OPENCODE2_QA_EVIDENCE_DIR ?? join(ROOT, ".omo/evidence/20260927-child-watchdog"))
const PLUGIN_DIR = resolve(process.env.OPENCODE2_PLUGIN_DIR ?? join(ROOT, "dist/opencode2"))
const CLI = process.env.OPENCODE2_CLI?.trim() ? resolve(process.env.OPENCODE2_CLI.trim()) : ""
const EXPECTED_SHA = process.env.OPENCODE2_EXPECTED_SERVER_SHA256 ?? ""
const PASSWORD = "child-watchdog-local-qa-only"
const PROBE_ID = "omo-child-watchdog-origin-probe"
const MODELS: QaModel[] = [{ id: "qa-model", context: 200_000, output: 8_192 }, { id: "qa-backup", context: 200_000, output: 8_192 }]
const WATCHDOG_MS = 90_000

async function assistantText(host: Host, sessionID: string): Promise<string> {
	return (await host.client.message.list({ sessionID })).data.flatMap((row) => asRecord(row)?.type === "assistant" ? [contentText(asRecord(row)?.content)] : []).join("\n")
}

async function main(): Promise<void> {
	const { actualSHA, cliVersion } = await verifyArtifact(PLUGIN_DIR, EXPECTED_SHA, CLI)
	const isolation = await prepareIsolation(EVIDENCE, "omo-child-watchdog-qa-")
	const checks: Check[] = []
	const check = (name: string, passed: boolean, detail?: unknown) => checks.push({ name, passed, ...(detail === undefined ? {} : { detail }) })
	const hanging = new Set<ReadableStreamDefaultController<Uint8Array>>()
	const ids: Record<string, string | undefined> = {}
	const mock = startMock(MODELS, (request, context) => {
		const id = `cw-${request.index}`
		if (request.kind !== "primary") return sse("CW auxiliary", id, request.model)
		const users = request.users.join("\n")
		if (users.includes("You are a subagent spawned by another session") || users.includes("Continue the existing child task")) {
			if (request.model === "qa-model") {
				const stream = new ReadableStream<Uint8Array>({ start(controller) { hanging.add(controller) } })
				return new Response(stream, { headers: { "content-type": "text/event-stream; charset=utf-8" } })
			}
			return sse(`CW_CHILD_DONE on ${request.model}`, id, request.model)
		}
		if (request.sessionID === ids.foreground) {
			if (context.turn("fg") === 1) return toolSse([{ name: "task", args: { subagent_type: "explore", description: "CW foreground", prompt: "CW_FOREGROUND inspect", run_in_background: false } }], id, request.model)
			return sse("CW_FOREGROUND_PARENT_DONE", id, request.model)
		}
		if (request.sessionID === ids.background) {
			const latest = request.users.at(-1) ?? ""
			if (request.toolResults.some((value) => value.includes("CW_CHILD_DONE"))) return sse("CW_RESUME_PARENT_DONE", id, request.model)
			if (latest.includes("CW_RESUME_REQUEST") && ids.bgChild && context.turn("resume") === 1) {
				return toolSse([{ name: "task", args: { task_id: ids.bgChild, description: "CW resume", prompt: "CW_BG_RESUME continue", run_in_background: false } }], id, request.model)
			}
			if (context.turn("bg") === 1) return toolSse([{ name: "task", args: { subagent_type: "explore", description: "CW background", prompt: "CW_BACKGROUND inspect", run_in_background: true } }], id, request.model)
			return sse("CW_BACKGROUND_PARENT_IDLE", id, request.model)
		}
		return sse("CW_DEFAULT", id, request.model)
	})
	await writeOriginProbe(isolation.probeDirectory, PROBE_ID, mock.origin, MODELS)
	let host: Host | undefined
	let failure: string | undefined
	const state: Record<string, unknown> = {}
	try {
		state.config = await writeHostConfig({
			isolation, pluginDir: PLUGIN_DIR, probeID: PROBE_ID, mockOrigin: mock.origin, models: MODELS, defaultModel: "qa-model",
			omo: {
				runtime_fallback: { enabled: true, retry_on_errors: [429], max_fallback_attempts: 2, cooldown_seconds: 0 },
				agents: { explore: { model: `${PROVIDER}/qa-model`, fallback_models: [`${PROVIDER}/qa-backup`] } },
			},
		})
		host = await startHost(CLI, isolation, PASSWORD)
		state.registry = await preflight(host, PROBE_ID, MODELS, "qa-model")
		ids.foreground = await createRootSession(host.client, isolation.project, "CW foreground", "sisyphus", "qa-model")
		ids.background = await createRootSession(host.client, isolation.project, "CW background", "sisyphus", "qa-model")
		const started = Date.now()
		await within("foreground prompt", host.client.session.prompt({ sessionID: ids.foreground, text: "CW_FG start" }))
		await within("background prompt", host.client.session.prompt({ sessionID: ids.background, text: "CW_BG start" }))
		const fgDone = await waitFor("foreground parent done", async () => (await assistantText(host!, ids.foreground!)).includes("CW_FOREGROUND_PARENT_DONE") ? true : undefined, WATCHDOG_MS + 60_000).catch(() => false)
		const fgElapsed = Date.now() - started
		const fgChild = (await host.client.session.list({ directory: isolation.project, parentID: ids.foreground, limit: 5 })).data[0]
		const fgChildRequests = mock.requests.filter((item) => item.sessionID === fgChild?.id && item.kind === "primary")
		const fgChildSession = fgChild ? await host.client.session.get({ sessionID: fgChild.id }) : undefined
		check("a silent foreground child is interrupted after the 90s watchdog and the same child finishes on the fallback model",
			// The host retries a stalled stream on its own; every attempt before the switch stays on qa-model.
			fgDone === true && fgElapsed >= WATCHDOG_MS - 2_000 && fgChildRequests.at(-1)?.model === "qa-backup" &&
			fgChildRequests.slice(0, -1).length >= 1 && fgChildRequests.slice(0, -1).every((item) => item.model === "qa-model") &&
			(fgChildRequests.at(-1)!.at - fgChildRequests[0]!.at) >= WATCHDOG_MS - 2_000 &&
			(await host.client.session.list({ directory: isolation.project, parentID: ids.foreground, limit: 5 })).data.length === 1 &&
			JSON.stringify((await host.client.message.list({ sessionID: ids.foreground })).data).includes("CW_CHILD_DONE on qa-backup"),
			{ fgElapsed, childID: fgChild?.id, sequence: fgChildRequests.map((item) => ({ model: item.model, at: item.at - started })), childModel: fgChildSession?.model })

		const bgChild = (await host.client.session.list({ directory: isolation.project, parentID: ids.background, limit: 5 })).data[0]
		ids.bgChild = bgChild?.id
		await waitFor("background child interrupted", async () => bgChild && (await host!.client.session.get({ sessionID: bgChild.id })).outcome === "interrupted" ? true : undefined, 30_000).catch(() => undefined)
		const bgRequestsBefore = mock.requests.filter((item) => item.sessionID === bgChild?.id && item.kind === "primary").map((item) => item.model)
		check("a silent background child is interrupted by the watchdog without a detached retry",
			Boolean(bgChild) && (await host.client.session.get({ sessionID: bgChild!.id })).outcome === "interrupted" &&
			bgRequestsBefore.length >= 1 && bgRequestsBefore.every((model) => model === "qa-model"),
			{ bgChild: bgChild?.id, requests: bgRequestsBefore })
		const beforeResume = mock.requests.length
		await within("explicit resume prompt", host.client.session.prompt({ sessionID: ids.background, text: "CW_RESUME_REQUEST resume the interrupted child" }))
		await waitFor("background resumed", async () => (await assistantText(host!, ids.background!)).includes("CW_RESUME_PARENT_DONE") ? true : undefined, 60_000).catch(() => undefined)
		const resumeRequests = mock.requests.slice(beforeResume).filter((item) => item.sessionID === bgChild?.id && item.kind === "primary").map((item) => item.model)
		check("an explicit task_id resume continues the timed-out background child on its fallback model",
			resumeRequests.join(",") === "qa-backup" && (await assistantText(host, bgChild!.id)).includes("CW_CHILD_DONE on qa-backup"),
			{ resumeRequests })
		check("all model requests were local and attributed",
			mock.requests.length > 0 && mock.originFailures.length === 0 && mock.unexpectedPaths.length === 0 && mock.requests.every((item) => item.originValid),
			{ total: mock.requests.length, originFailures: mock.originFailures })
	} catch (error) {
		failure = error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ""}` : String(error)
	} finally {
		const exit = await stopHost(host)
		for (const controller of hanging) { try { controller.close() } catch { /* cancelled */ } }
		mock.stop()
		const driverSHA = sha256(await readFile(join(import.meta.dir, "opencode2-child-watchdog-qa.ts")))
		const result = {
			startedAt: new Date().toISOString(), productionSource: gitState(),
			bundle: { serverPath: join(PLUGIN_DIR, "server.js"), expectedSHA: EXPECTED_SHA, actualSHA, driverSHA },
			cli: { path: CLI, version: cliVersion }, isolation, ids, state, checks,
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
	if (checks.some((item) => !item.passed)) throw new Error("Child watchdog native QA checks failed")
}

main().catch((error) => {
	console.error(error)
	process.exitCode = 1
})
