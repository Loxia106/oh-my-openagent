/** Isolated OpenCode 2.0.22 runtime proof for legacy bg_ background task IDs and supervised unstable-model tasks. */
import { readFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import {
	PROVIDER, ROOT, asRecord, contentText, createRootSession, gitState, preflight, prepareIsolation,
	sha256, sse, startHost, startMock, stopHost, toolSse, verifyArtifact, waitFor, within, writeEvidence, writeHostConfig, writeOriginProbe,
	type Check, type Host, type QaModel,
} from "./opencode2-qa-harness"

const EVIDENCE = resolve(process.env.OPENCODE2_QA_EVIDENCE_DIR ?? join(ROOT, ".omo/evidence/20260928-background-task-id"))
const PLUGIN_DIR = resolve(process.env.OPENCODE2_PLUGIN_DIR ?? join(ROOT, "dist/opencode2"))
const CLI = process.env.OPENCODE2_CLI?.trim() ? resolve(process.env.OPENCODE2_CLI.trim()) : ""
const EXPECTED_SHA = process.env.OPENCODE2_EXPECTED_SERVER_SHA256 ?? ""
const PASSWORD = "background-task-id-local-qa-only"
const PROBE_ID = "omo-background-task-id-origin-probe"
// Built-in categories request max/medium variants; expose both so routing stays local.
const MODELS: QaModel[] = [
	{ id: "qa-model", context: 200_000, output: 8_192, variants: { max: {}, medium: {} } },
	{ id: "qa-gemini", context: 200_000, output: 8_192, variants: { max: {}, medium: {} } },
]
const BG_ID = /Background Task ID: (bg_[0-9a-f]{8})/

async function assistantText(host: Host, sessionID: string): Promise<string> {
	return (await host.client.message.list({ sessionID })).data.flatMap((row) => asRecord(row)?.type === "assistant" ? [contentText(asRecord(row)?.content)] : []).join("\n")
}

async function main(): Promise<void> {
	const { actualSHA, cliVersion } = await verifyArtifact(PLUGIN_DIR, EXPECTED_SHA, CLI)
	const isolation = await prepareIsolation(EVIDENCE, "omo-background-task-id-qa-")
	const checks: Check[] = []
	const check = (name: string, passed: boolean, detail?: unknown) => checks.push({ name, passed, ...(detail === undefined ? {} : { detail }) })
	const hanging = new Set<ReadableStreamDefaultController<Uint8Array>>()
	const ids: Record<string, string | undefined> = {}
	const mock = startMock(MODELS, (request, context) => {
		const id = `bt-${request.index}`
		if (request.kind !== "primary") return sse("BT auxiliary", id, request.model)
		const users = request.users.join("\n")
		if (users.includes("You are a subagent spawned by another session")) {
			if (users.includes("BT_HANG")) {
				const stream = new ReadableStream<Uint8Array>({ start(controller) { hanging.add(controller) } })
				return new Response(stream, { headers: { "content-type": "text/event-stream; charset=utf-8" } })
			}
			if (users.includes("BT_QUICK")) return sse("BT_QUICK_CHILD_DONE", id, request.model)
			if (users.includes("BT_SUP")) return sse(`BT_SUP_CHILD_DONE on ${request.model}`, id, request.model)
			return sse("BT_CHILD_DEFAULT", id, request.model)
		}
		const latest = request.users.at(-1) ?? ""
		if (request.sessionID === ids.background) {
			if (latest.includes("<subagent")) return sse("BT_NOTICE_ACK", id, request.model)
			if (context.turn("bg-launch") === 1) {
				return toolSse([
					{ name: "task", args: { subagent_type: "explore", description: "BT quick", prompt: "BT_QUICK research", run_in_background: true } },
					{ name: "task", args: { subagent_type: "librarian", description: "BT hang", prompt: "BT_HANG research", run_in_background: true } },
				], id, request.model)
			}
			const results = request.toolResults
			const quick = results.find((value) => value.includes("subagent: explore"))
			const hang = results.find((value) => value.includes("subagent: librarian"))
			ids.quickBg = quick ? BG_ID.exec(quick)?.[1] : undefined
			ids.hangBg = hang ? BG_ID.exec(hang)?.[1] : undefined
			if (ids.quickBg && ids.hangBg && context.turn("bg-collect") === 1) {
				return toolSse([
					{ name: "background_output", args: { task_id: ids.quickBg, block: true, timeout: 30_000 } },
					{ name: "background_cancel", args: { taskId: ids.hangBg } },
				], id, request.model)
			}
			return sse("BT_BG_PARENT_DONE", id, request.model)
		}
		if (request.sessionID === ids.supervised) {
			if (latest.includes("<subagent")) return sse("BT_SUP_UNEXPECTED_NOTICE", id, request.model)
			if (context.turn("sup") === 1) {
				return toolSse([{ name: "task", args: { category: "unspecified-low", description: "BT supervised", prompt: "BT_SUP build it", run_in_background: false } }], id, request.model)
			}
			return sse("BT_SUP_PARENT_DONE", id, request.model)
		}
		return sse("BT_DEFAULT", id, request.model)
	})
	await writeOriginProbe(isolation.probeDirectory, PROBE_ID, mock.origin, MODELS)
	let host: Host | undefined
	let failure: string | undefined
	const state: Record<string, unknown> = {}
	try {
		state.config = await writeHostConfig({
			isolation, pluginDir: PLUGIN_DIR, probeID: PROBE_ID, mockOrigin: mock.origin, models: MODELS, defaultModel: "qa-model",
			omo: {
				agents: { explore: { model: `${PROVIDER}/qa-model` }, librarian: { model: `${PROVIDER}/qa-model` } },
				categories: { "unspecified-low": { models: [`${PROVIDER}/qa-gemini`] } },
			},
		})
		host = await startHost(CLI, isolation, PASSWORD)
		state.registry = await preflight(host, PROBE_ID, MODELS, "qa-model")
		ids.background = await createRootSession(host.client, isolation.project, "BT background", "sisyphus", "qa-model")
		ids.supervised = await createRootSession(host.client, isolation.project, "BT supervised", "sisyphus", "qa-model")

		await within("background prompt", host.client.session.prompt({ sessionID: ids.background, text: "BT_BG launch two researchers" }))
		await waitFor("background parent done", async () => (await assistantText(host!, ids.background!)).includes("BT_BG_PARENT_DONE") ? true : undefined, 90_000).catch(() => undefined)
		const bgRequests = mock.requests.filter((item) => item.sessionID === ids.background && item.kind === "primary")
		const launchResults = bgRequests.flatMap((item) => item.toolResults).filter((value) => BG_ID.test(value))
		const children = (await host.client.session.list({ directory: isolation.project, parentID: ids.background, limit: 10 })).data
		const quickChild = children.find((child) => asRecord(child)?.agent === "explore")
		const hangChild = children.find((child) => asRecord(child)?.agent === "librarian")
		state.launchResults = launchResults
		check("background task launches return a legacy bg_ ID with the child session in task metadata",
			Boolean(ids.quickBg && ids.hangBg && quickChild && hangChild) &&
			launchResults.some((value) => value.includes(`session_id: ${quickChild!.id}`) && value.includes(`background_task_id: ${ids.quickBg}`)) &&
			launchResults.some((value) => value.includes(`session_id: ${hangChild!.id}`) && value.includes(`background_task_id: ${ids.hangBg}`)),
			{ quickBg: ids.quickBg, hangBg: ids.hangBg, children: children.map((child) => ({ id: child.id, agent: asRecord(child)?.agent })), launchResults })
		const collected = bgRequests.flatMap((item) => item.toolResults)
		const outputResult = collected.find((value) => value.includes(`Background Task ID: ${ids.quickBg}`) && value.includes("Session: "))
		check("background_output(task_id=\"bg_...\") returns that child's result", Boolean(outputResult?.includes("BT_QUICK_CHILD_DONE")),
			{ outputResult: outputResult?.slice(0, 600) })
		await waitFor("hang child interrupted", async () => hangChild && (await host!.client.session.get({ sessionID: hangChild.id })).outcome === "interrupted" ? true : undefined, 30_000).catch(() => undefined)
		const cancelResult = collected.find((value) => value.includes("Interrupt requested for background task"))
		check("background_cancel(taskId=\"bg_...\") interrupts that child only",
			Boolean(hangChild && cancelResult?.includes(`${ids.hangBg} (${hangChild.id})`)) &&
			(await host.client.session.get({ sessionID: hangChild!.id })).outcome === "interrupted" &&
			(await host.client.session.get({ sessionID: quickChild!.id })).outcome !== "interrupted",
			{ cancelResult, hangOutcome: hangChild ? (await host.client.session.get({ sessionID: hangChild.id })).outcome : undefined })
		const sisyphusSystem = bgRequests[0]?.system.join("\n") ?? ""
		check("the Sisyphus prompt keeps the legacy bg_/ses_ background guidance", sisyphusSystem.includes('background_output(task_id="bg_...")') &&
			!sisyphusSystem.includes('background_output(task_id="ses_...")'))

		await within("supervised prompt", host.client.session.prompt({ sessionID: ids.supervised, text: "BT_SUP delegate the build" }))
		await waitFor("supervised parent done", async () => (await assistantText(host!, ids.supervised!)).includes("BT_SUP_PARENT_DONE") ? true : undefined, 90_000).catch(() => undefined)
		await Bun.sleep(3_000)
		const supRequests = mock.requests.filter((item) => item.sessionID === ids.supervised && item.kind === "primary")
		const supervisedResult = supRequests.flatMap((item) => item.toolResults).find((value) => value.includes("SUPERVISED TASK")) ?? ""
		const supChild = (await host.client.session.list({ directory: isolation.project, parentID: ids.supervised, limit: 5 })).data[0]
		const childModels = mock.requests.filter((item) => item.sessionID === supChild?.id && item.kind === "primary").map((item) => item.model)
		state.supervisedResult = supervisedResult
		check("an explicit foreground task on an unstable (Gemini) category model returns the legacy supervised result",
			supervisedResult.startsWith("SUPERVISED TASK COMPLETED SUCCESSFULLY") && supervisedResult.includes("BT_SUP_CHILD_DONE on qa-gemini") &&
			supervisedResult.includes("is marked as unstable/experimental") && Boolean(supChild) &&
			supervisedResult.includes(`session_id: ${supChild!.id}`) && /background_task_id: bg_[0-9a-f]{8}/.test(supervisedResult) &&
			childModels.length > 0 && childModels.every((model) => model === "qa-gemini"),
			{ supervisedResult: supervisedResult.slice(0, 1200), childModels })
		const notices = supRequests.flatMap((item) => item.users).filter((value) => value.includes("<subagent"))
		check("the supervised parent receives the result once, with no extra background completion notice",
			notices.length === 0 && !(await assistantText(host, ids.supervised)).includes("BT_SUP_UNEXPECTED_NOTICE"), { notices })
		check("all model requests were local and attributed",
			mock.requests.length > 0 && mock.originFailures.length === 0 && mock.unexpectedPaths.length === 0 && mock.requests.every((item) => item.originValid),
			{ total: mock.requests.length, originFailures: mock.originFailures })
	} catch (error) {
		failure = error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ""}` : String(error)
	} finally {
		const exit = await stopHost(host)
		for (const controller of hanging) { try { controller.close() } catch { /* cancelled */ } }
		mock.stop()
		const driverSHA = sha256(await readFile(join(import.meta.dir, "opencode2-background-task-id-qa.ts")))
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
	if (checks.some((item) => !item.passed)) throw new Error("Background task ID native QA checks failed")
}

main().catch((error) => {
	console.error(error)
	process.exitCode = 1
})
