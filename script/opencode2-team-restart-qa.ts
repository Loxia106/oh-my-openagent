/** Isolated OpenCode 2.0.22 runtime proof that an active Team recovers after the host process is killed. */
import { readFile, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import {
	ROOT, asRecord, contentText, createRootSession, gitState, preflight, prepareIsolation, promptAndWait,
	sha256, sse, startHost, startMock, stopHost, toolSse, verifyArtifact, waitFor, within, writeEvidence, writeHostConfig, writeOriginProbe,
	type Check, type Host, type MockRequest, type QaModel,
} from "./opencode2-qa-harness"

const EVIDENCE = resolve(process.env.OPENCODE2_QA_EVIDENCE_DIR ?? join(ROOT, ".omo/evidence/20260927-team-restart"))
const PLUGIN_DIR = resolve(process.env.OPENCODE2_PLUGIN_DIR ?? join(ROOT, "dist/opencode2"))
const CLI = process.env.OPENCODE2_CLI?.trim() ? resolve(process.env.OPENCODE2_CLI.trim()) : ""
const EXPECTED_SHA = process.env.OPENCODE2_EXPECTED_SERVER_SHA256 ?? ""
const PASSWORD = "team-restart-local-qa-only"
const PROBE_ID = "omo-team-restart-origin-probe"
// OPENCODE2_QA_TEAM_WORKTREE=1 runs both members in isolated native worktrees.
const WORKTREE = process.env.OPENCODE2_QA_TEAM_WORKTREE === "1"
// Built-in categories request max/medium variants; expose both so routing stays local.
const MODELS: QaModel[] = [{ id: "qa-model", context: 200_000, output: 8_192, variants: { max: {}, medium: {} } }]

function teamRunIdIn(request: MockRequest): string | undefined {
	return /"teamRunId"\s*:\s*"([0-9a-f-]{36})"/i.exec([...request.toolResults, ...request.users].join("\n"))?.[1]
}

async function main(): Promise<void> {
	const { actualSHA, cliVersion } = await verifyArtifact(PLUGIN_DIR, EXPECTED_SHA, CLI)
	const isolation = await prepareIsolation(EVIDENCE, "omo-team-restart-qa-")
	if (WORKTREE) {
		await writeFile(join(isolation.project, "README.md"), "restart\n")
		for (const args of [["init", "-q"], ["add", "README.md"], ["commit", "-q", "-m", "init"]]) {
			const proc = Bun.spawn(["git", ...args], { cwd: isolation.project, stdout: "ignore", stderr: "pipe", env: { PATH: "/usr/bin:/bin", HOME: isolation.project, GIT_AUTHOR_NAME: "qa", GIT_AUTHOR_EMAIL: "qa@example.invalid", GIT_COMMITTER_NAME: "qa", GIT_COMMITTER_EMAIL: "qa@example.invalid" } })
			if ((await proc.exited) !== 0) throw new Error(`git ${args.join(" ")} failed`)
		}
	}
	const checks: Check[] = []
	const check = (name: string, passed: boolean, detail?: unknown) => checks.push({ name, passed, ...(detail === undefined ? {} : { detail }) })
	const hanging = new Set<ReadableStreamDefaultController<Uint8Array>>()
	let phase = 1
	let leadID: string | undefined
	let teamRunId: string | undefined
	const mock = startMock(MODELS, (request, context) => {
		const id = `tr-${request.index}`
		if (request.kind !== "primary") return sse("TR auxiliary", id, request.model)
		const conversation = [...request.system, ...request.users, ...request.toolResults].join("\n")
		const latest = request.users.at(-1) ?? ""
		if (request.sessionID === leadID) {
			teamRunId ??= teamRunIdIn(request)
			if (latest.includes("TR_CREATE") && context.turn("create") === 1) {
				return toolSse([{ name: "team_create", args: { inline_spec: {
					version: 1, name: "restart-team", leadAgentId: "lead",
					members: [
						{ kind: "subagent_type", name: "lead", subagent_type: "atlas" },
						{ kind: "category", name: "alpha", category: "unspecified-low", prompt: "TR_ALPHA_ROLE inspect the parser.", ...(WORKTREE ? { worktree: true } : {}) },
						{ kind: "category", name: "beta", category: "unspecified-low", prompt: "TR_BETA_ROLE review the tests.", ...(WORKTREE ? { worktree: true } : {}) },
					],
				} } }], id, request.model)
			}
			if (latest.includes("TR_SEND") && teamRunId && context.turn("send") === 1) {
				return toolSse([{ name: "team_send_message", args: { teamRunId, to: "beta", body: "TR_MAIL_BODY after restart", kind: "message" } }], id, request.model)
			}
			if (latest.includes("TR_STATUS") && teamRunId && context.turn("status") === 1) {
				return toolSse([{ name: "team_status", args: { teamRunId } }], id, request.model)
			}
			if (latest.includes("TR_DELETE") && teamRunId && context.turn("delete") === 1) {
				return toolSse([{ name: "team_delete", args: { teamRunId, force: true } }], id, request.model)
			}
			return sse("TR_LEAD_ACK", id, request.model)
		}
		if (conversation.includes("TR_MAIL_BODY") && conversation.includes("TR_BETA_ROLE")) {
			if (teamRunId && context.turn(`${request.sessionID}:reply`) === 1) {
				return toolSse([{ name: "team_send_message", args: { teamRunId, to: "lead", body: "TR_BETA_REPLY", kind: "message" } }], id, request.model)
			}
			return sse("TR_BETA_HANDLED", id, request.model)
		}
		if (conversation.includes("TR_ALPHA_ROLE") && phase === 1) {
			// Alpha holds the only member slot and stalls until the host is killed.
			const stream = new ReadableStream<Uint8Array>({ start(controller) { hanging.add(controller) } })
			return new Response(stream, { headers: { "content-type": "text/event-stream; charset=utf-8" } })
		}
		if (conversation.includes("TR_ALPHA_ROLE")) return sse("TR_ALPHA_READY", id, request.model)
		if (conversation.includes("TR_BETA_ROLE")) return sse("TR_BETA_READY", id, request.model)
		return sse("TR_DEFAULT", id, request.model)
	})
	await writeOriginProbe(isolation.probeDirectory, PROBE_ID, mock.origin, MODELS)
	let host: Host | undefined
	let failure: string | undefined
	const state: Record<string, unknown> = {}
	const exits: Array<number | null> = []
	const memberRequests = (marker: string) => mock.requests.filter((item) => item.kind === "primary" && item.sessionID !== leadID && [...item.system, ...item.users].join("\n").includes(marker))
	try {
		state.config = await writeHostConfig({
			isolation, pluginDir: PLUGIN_DIR, probeID: PROBE_ID, mockOrigin: mock.origin, models: MODELS, defaultModel: "qa-model",
			omo: {
				agents: { atlas: { model: "omoqa/qa-model" }, "sisyphus-junior": { model: "omoqa/qa-model" } },
				categories: { "unspecified-low": { models: ["omoqa/qa-model"] } },
				team_mode: { enabled: true, base_dir: join(isolation.tempRoot, "teams"), max_parallel_members: 1, max_members: 4, max_wall_clock_minutes: 10, max_member_turns: 30 } },
		})
		host = await startHost(CLI, isolation, PASSWORD)
		await preflight(host, PROBE_ID, MODELS, "qa-model", "atlas")
		leadID = await createRootSession(host.client, isolation.project, "TR lead", "atlas", "qa-model")
		await promptAndWait(host.client, leadID, "TR_CREATE create the team.", "team create")
		await waitFor("alpha started", () => memberRequests("TR_ALPHA_ROLE").length > 0 ? true : undefined, 30_000)
		await Bun.sleep(1_000)
		const betaBeforeKill = memberRequests("TR_BETA_ROLE").length
		state.beforeKill = { teamRunId, alpha: memberRequests("TR_ALPHA_ROLE").length, beta: betaBeforeKill }
		host.process.kill("SIGKILL")
		await host.process.exited
		exits.push(host.process.exitCode)
		await Promise.all([host.stdoutTask, host.stderrTask])
		await writeEvidence(isolation.attempt, "phase1.server.stderr.log", host.stderr)
		host = undefined
		for (const controller of hanging) { try { controller.close() } catch { /* killed */ } }
		phase = 2

		const stateFile = join(isolation.tempRoot, "teams", "runtime", teamRunId ?? "missing", "state.json")
		state.stateBeforeRestart = JSON.parse(await readFile(stateFile, "utf8").catch(() => "null"))
		const restartAt = Date.now()
		host = await startHost(CLI, isolation, PASSWORD)
		await preflight(host, PROBE_ID, MODELS, "qa-model", "atlas")
		await Bun.sleep(8_000)
		state.stateAfterRecoveryGrace = JSON.parse(await readFile(stateFile, "utf8").catch(() => "null"))
		state.alphaSessionAfterRestart = await host.client.session.get({ sessionID: (state.stateBeforeRestart as { members?: Array<{ name: string; sessionId?: string }> })?.members?.find((member) => member.name === "alpha")?.sessionId ?? "missing" }).catch((error) => String(error))
		const betaStarted = await waitFor("pending beta launched after restart", () => memberRequests("TR_BETA_ROLE").some((item) => item.at >= restartAt) ? true : undefined, 60_000).catch(() => false)
		const alphaResume = memberRequests("TR_ALPHA_ROLE").find((item) => item.at >= restartAt && (item.users.at(-1) ?? "").includes("The server restarted while you were working"))
		check("the member whose turn the crash orphaned is resumed once after restart", Boolean(alphaResume) &&
			memberRequests("TR_ALPHA_ROLE").filter((item) => item.at >= restartAt && (item.users.at(-1) ?? "").includes("The server restarted")).length === 1,
			{ alphaAfter: memberRequests("TR_ALPHA_ROLE").filter((item) => item.at >= restartAt).map((item) => ({ at: item.at - restartAt, user: (item.users.at(-1) ?? "").slice(0, 100) })) })
		check("the member queued behind a stalled member before the crash is launched after restart",
			betaBeforeKill === 0 && betaStarted === true && Boolean(teamRunId),
			{ ...state.beforeKill as object, betaAfter: memberRequests("TR_BETA_ROLE").map((item) => item.at - restartAt) })
		await promptAndWait(host.client, leadID, "TR_STATUS show the team.", "team status")
		const statusResult = mock.requests.filter((item) => item.sessionID === leadID).flatMap((item) => item.toolResults).find((value) => value.includes("alpha") && value.includes("beta")) ?? ""
		check("team_status after restart still reports the persisted run and both members", statusResult.includes(teamRunId ?? "missing"), { statusResult: statusResult.slice(0, 1200) })
		await promptAndWait(host.client, leadID, "TR_SEND message beta.", "team send")
		const reply = await waitFor("beta reply delivered to lead", async () => JSON.stringify((await host!.client.message.list({ sessionID: leadID! })).data).includes("TR_BETA_REPLY") ? true : undefined, 60_000).catch(() => false)
		check("mailbox delivery works after restart in both directions", reply === true && memberRequests("TR_MAIL_BODY").length > 0, { reply })
		await promptAndWait(host.client, leadID, "TR_DELETE close the team.", "team delete")
		const deleteResult = mock.requests.filter((item) => item.sessionID === leadID).flatMap((item) => item.toolResults).at(-1) ?? ""
		check("team_delete closes the recovered run", /deleted|closed|shutdown/i.test(deleteResult) && !/error/i.test(deleteResult.slice(0, 40)), { deleteResult: deleteResult.slice(0, 600) })
		check("all model requests were local and attributed",
			mock.requests.length > 0 && mock.originFailures.length === 0 && mock.unexpectedPaths.length === 0 && mock.requests.every((item) => item.originValid),
			{ total: mock.requests.length, originFailures: mock.originFailures })
		const leadText = (await host.client.message.list({ sessionID: leadID })).data.flatMap((row) => asRecord(row)?.type === "assistant" ? [contentText(asRecord(row)?.content)] : [])
		state.leadAssistant = leadText
	} catch (error) {
		failure = error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ""}` : String(error)
	} finally {
		exits.push(await stopHost(host))
		for (const controller of hanging) { try { controller.close() } catch { /* cancelled */ } }
		mock.stop()
		const driverSHA = sha256(await readFile(join(import.meta.dir, "opencode2-team-restart-qa.ts")))
		const result = {
			startedAt: new Date().toISOString(), productionSource: gitState(),
			bundle: { serverPath: join(PLUGIN_DIR, "server.js"), expectedSHA: EXPECTED_SHA, actualSHA, driverSHA },
			cli: { path: CLI, version: cliVersion }, isolation, leadID, teamRunId, state, checks,
			allChecksPassed: checks.length > 0 && checks.every((item) => item.passed), failure,
			cleanup: { opencodeExitCodes: exits, mockStopped: true, tempRetained: true },
		}
		await writeEvidence(isolation.attempt, "runtime.json", result)
		await writeEvidence(isolation.attempt, "requests.json", mock.requests.map((item) => ({ ...item, body: undefined })))
		if (host) await writeEvidence(isolation.attempt, "server.stderr.log", host.stderr)
		await writeEvidence(isolation.attempt, "summary.txt", `${failure ? `FAILURE\n${failure}\n` : ""}checks=${checks.filter((item) => item.passed).length}/${checks.length}\nserverSHA=${actualSHA}\n`)
		process.stdout.write(JSON.stringify({ evidence: isolation.attempt, allChecksPassed: result.allChecksPassed, checks: checks.map(({ name, passed }) => ({ name, passed })), failure }, null, 2) + "\n")
	}
	if (failure) throw new Error(failure)
	if (checks.some((item) => !item.passed)) throw new Error("Team restart native QA checks failed")
}

main().catch((error) => {
	console.error(error)
	process.exitCode = 1
})
