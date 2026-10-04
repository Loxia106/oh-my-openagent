/** Isolated OpenCode 2.0.22 runtime proof for the unstable-agent babysitter. */
import { readFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import {
	PROVIDER, ROOT, asRecord, contentText, createRootSession, gitState, preflight, prepareIsolation, promptAndWait,
	sha256, sse, startHost, startMock, stopHost, toolSse, verifyArtifact, waitFor, within, writeEvidence, writeHostConfig, writeOriginProbe,
	type Check, type Host, type QaModel,
} from "./opencode2-qa-harness"

const EVIDENCE = resolve(process.env.OPENCODE2_QA_EVIDENCE_DIR ?? join(ROOT, ".omo/evidence/20260927-babysitter"))
const PLUGIN_DIR = resolve(process.env.OPENCODE2_PLUGIN_DIR ?? join(ROOT, "dist/opencode2"))
const CLI = process.env.OPENCODE2_CLI?.trim() ? resolve(process.env.OPENCODE2_CLI.trim()) : ""
const EXPECTED_SHA = process.env.OPENCODE2_EXPECTED_SERVER_SHA256 ?? ""
const PASSWORD = "babysitter-local-qa-only"
const PROBE_ID = "omo-babysitter-origin-probe"
const MODELS: QaModel[] = [{ id: "qa-model", context: 200_000, output: 8_192 }, { id: "qa-gemini-flash", context: 200_000, output: 8_192 }]
const TIMEOUT_MS = 3_000

async function main(): Promise<void> {
	const { actualSHA, cliVersion } = await verifyArtifact(PLUGIN_DIR, EXPECTED_SHA, CLI)
	const isolation = await prepareIsolation(EVIDENCE, "omo-babysitter-qa-")
	const checks: Check[] = []
	const check = (name: string, passed: boolean, detail?: unknown) => checks.push({ name, passed, ...(detail === undefined ? {} : { detail }) })
	const hanging = new Set<ReadableStreamDefaultController<Uint8Array>>()
	let parentID: string | undefined
	const mock = startMock(MODELS, (request, context) => {
		const id = `bs-${request.index}`
		if (request.kind !== "primary") return sse("BS auxiliary", id, request.model)
		if (request.model === "qa-gemini-flash") {
			// The unstable child starts a response and then goes silent.
			const stream = new ReadableStream<Uint8Array>({ start(controller) { hanging.add(controller) } })
			return new Response(stream, { headers: { "content-type": "text/event-stream; charset=utf-8" } })
		}
		if (request.sessionID === parentID) {
			if (request.users.some((value) => value.includes("Unstable background agent appears idle"))) return sse("BS_REMINDER_SEEN", id, request.model)
			if (context.turn(`${parentID}:launch`) === 1) {
				return toolSse([{ name: "task", args: { subagent_type: "librarian", description: "BS research", prompt: "BS_CHILD research the API history.", run_in_background: true } }], id, request.model)
			}
			return sse("BS_LAUNCHED", id, request.model)
		}
		return sse("BS_DEFAULT", id, request.model)
	})
	await writeOriginProbe(isolation.probeDirectory, PROBE_ID, mock.origin, MODELS)

	let host: Host | undefined
	let failure: string | undefined
	const state: Record<string, unknown> = {}
	try {
		state.config = await writeHostConfig({
			isolation, pluginDir: PLUGIN_DIR, probeID: PROBE_ID, mockOrigin: mock.origin, models: MODELS, defaultModel: "qa-model",
			omo: { babysitting: { timeout_ms: TIMEOUT_MS }, agents: { librarian: { model: `${PROVIDER}/qa-gemini-flash` } } },
		})
		host = await startHost(CLI, isolation, PASSWORD)
		state.registry = await preflight(host, PROBE_ID, MODELS, "qa-model")
		parentID = await createRootSession(host.client, isolation.project, "BS parent", "sisyphus", "qa-model")
		const launchedAt = Date.now()
		await promptAndWait(host.client, parentID, "BS_START research in the background.", "launch")
		const child = await waitFor("background child", async () =>
			(await host!.client.session.list({ directory: isolation.project, parentID, limit: 10 })).data.find((row) => row.agent === "librarian"), 15_000)
		const reminder = await waitFor("babysitter reminder", async () => {
			const messages = (await host!.client.message.list({ sessionID: parentID! })).data
			return messages.map(asRecord).find((row) => row?.type === "synthetic" && contentText(row.text).includes("Unstable background agent appears idle"))
		}, 30_000).catch(() => undefined)
		const reminderAt = typeof asRecord(reminder?.time)?.created === "number" ? asRecord(reminder?.time)!.created as number : undefined
		const processed = await waitFor("parent processed reminder", async () => {
			const messages = (await host!.client.message.list({ sessionID: parentID! })).data
			return messages.some((row) => asRecord(row)?.type === "assistant" && contentText(asRecord(row)?.content).includes("BS_REMINDER_SEEN")) ? true : undefined
		}, 20_000).catch(() => false)
		const reminderText = reminder ? contentText(reminder.text) : ""
		check("a silent background child on an unstable model triggers one parent reminder after babysitting.timeout_ms",
			Boolean(reminder) && reminderText.includes(`Task ID: ${child.id}`) && reminderText.includes("Agent: librarian") &&
			reminderText.includes(`background_output task_id="${child.id}"`) && reminderText.includes(`background_cancel taskId="${child.id}"`) &&
			reminderAt !== undefined && reminderAt - launchedAt >= TIMEOUT_MS - 500 && processed === true,
			{ childID: child.id, reminderText, delayMs: reminderAt !== undefined ? reminderAt - launchedAt : null, processed })
		await Bun.sleep(TIMEOUT_MS * 2)
		const reminders = (await host.client.message.list({ sessionID: parentID })).data
			.filter((row) => asRecord(row)?.type === "synthetic" && contentText(asRecord(row)?.text).includes("Unstable background agent appears idle"))
		check("the reminder is not repeated within the cooldown while the child stays silent", reminders.length === 1, { reminders: reminders.length })
		const childRequests = mock.requests.filter((item) => item.sessionID === child.id && item.kind === "primary")
		check("the child really ran on the unstable model and the babysitter took no automatic action",
			childRequests.length >= 1 && childRequests.every((item) => item.model === "qa-gemini-flash") &&
			(await host.client.session.get({ sessionID: child.id })).outcome === undefined,
			{ childRequests: childRequests.map((item) => item.model), childOutcome: (await host.client.session.get({ sessionID: child.id })).outcome })
		await within("interrupt child", host.client.session.interrupt({ sessionID: child.id }))
		check("all model requests were local and attributed",
			mock.requests.length > 0 && mock.originFailures.length === 0 && mock.unexpectedPaths.length === 0 && mock.requests.every((item) => item.originValid),
			{ total: mock.requests.length, originFailures: mock.originFailures })
	} catch (error) {
		failure = error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ""}` : String(error)
	} finally {
		const exit = await stopHost(host)
		for (const controller of hanging) { try { controller.close() } catch { /* already cancelled */ } }
		mock.stop()
		const driverSHA = sha256(await readFile(join(import.meta.dir, "opencode2-babysitter-qa.ts")))
		const harnessSHA = sha256(await readFile(join(import.meta.dir, "opencode2-qa-harness.ts")))
		const result = {
			startedAt: new Date().toISOString(),
			productionSource: gitState(),
			bundle: { serverPath: join(PLUGIN_DIR, "server.js"), expectedSHA: EXPECTED_SHA, actualSHA, driverSHA, harnessSHA },
			cli: { path: CLI, version: cliVersion },
			isolation, parentID, state, checks,
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
	if (checks.some((item) => !item.passed)) throw new Error("Babysitter native QA checks failed")
}

main().catch((error) => {
	console.error(error)
	process.exitCode = 1
})
