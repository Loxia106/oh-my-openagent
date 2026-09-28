/** Isolated OpenCode 2.0.18 runtime proof for Team members isolated in native host-managed worktrees. */
import { readFile, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import {
	PROVIDER, ROOT, asRecord, contentText, createRootSession, gitState, preflight, prepareIsolation, promptAndWait,
	sha256, sse, startHost, startMock, stopHost, toolSse, verifyArtifact, waitFor, writeEvidence, writeHostConfig, writeOriginProbe,
	type Check, type Host, type QaModel,
} from "./opencode2-qa-harness"

const EVIDENCE = resolve(process.env.OPENCODE2_QA_EVIDENCE_DIR ?? join(ROOT, ".omo/evidence/20260928-team-worktree"))
const PLUGIN_DIR = resolve(process.env.OPENCODE2_PLUGIN_DIR ?? join(ROOT, "dist/opencode2"))
const CLI = process.env.OPENCODE2_CLI?.trim() ? resolve(process.env.OPENCODE2_CLI.trim()) : ""
const EXPECTED_SHA = process.env.OPENCODE2_EXPECTED_SERVER_SHA256 ?? ""
const PASSWORD = "team-worktree-local-qa-only"
const PROBE_ID = "omo-team-worktree-origin-probe"
// Built-in categories request max/medium variants; expose both so routing stays local.
const MODELS: QaModel[] = [{ id: "qa-model", context: 200_000, output: 8_192, variants: { max: {}, medium: {} } }]
const GIT_ENV = { PATH: "/usr/bin:/bin", GIT_AUTHOR_NAME: "qa", GIT_AUTHOR_EMAIL: "qa@example.invalid", GIT_COMMITTER_NAME: "qa", GIT_COMMITTER_EMAIL: "qa@example.invalid" }

async function git(cwd: string, ...args: string[]): Promise<string> {
	const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", env: { ...GIT_ENV, HOME: cwd } })
	const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
	if ((await proc.exited) !== 0) throw new Error(`git ${args.join(" ")}: ${err}`)
	return out.trim()
}

function field(text: string, name: string): string | undefined {
	return new RegExp(`${name}: (\\S+)`).exec(text)?.[1]
}

async function main(): Promise<void> {
	const { actualSHA, cliVersion } = await verifyArtifact(PLUGIN_DIR, EXPECTED_SHA, CLI)
	const isolation = await prepareIsolation(EVIDENCE, "omo-team-worktree-qa-")
	const checks: Check[] = []
	const check = (name: string, passed: boolean, detail?: unknown) => checks.push({ name, passed, ...(detail === undefined ? {} : { detail }) })
	await writeFile(join(isolation.project, "shared.txt"), "ORIGINAL\n")
	await git(isolation.project, "init", "-q")
	await git(isolation.project, "add", "shared.txt")
	await git(isolation.project, "commit", "-q", "-m", "init")
	let leadID: string | undefined
	let teamRunId: string | undefined
	const worktrees: Record<string, string> = {}
	const mock = startMock(MODELS, (request, context) => {
		const id = `wt-${request.index}`
		if (request.kind !== "primary") return sse("WT auxiliary", id, request.model)
		const users = request.users.join("\n")
		const latest = request.users.at(-1) ?? ""
		if (request.sessionID === leadID) {
			teamRunId ??= /"teamRunId"\s*:\s*"([0-9a-f-]{36})"/i.exec(request.toolResults.join("\n"))?.[1]
			if (latest.includes("WT_CREATE") && context.turn("create") === 1) {
				return toolSse([{ name: "team_create", args: { inline_spec: {
					version: 1, name: "wt-team", leadAgentId: "lead",
					members: [
						{ kind: "subagent_type", name: "lead", subagent_type: "atlas" },
						{ kind: "category", name: "alpha", category: "unspecified-low", prompt: "WT_ALPHA_ROLE edit shared.txt.", worktree: true },
						{ kind: "category", name: "beta", category: "unspecified-low", prompt: "WT_BETA_ROLE edit shared.txt.", worktree: true },
						{ kind: "category", name: "gamma", category: "unspecified-low", prompt: "WT_GAMMA_ROLE only read.", worktree: true },
					],
				} } }], id, request.model)
			}
			if (latest.includes("WT_ALPHA_DONE") && teamRunId && context.turn("ping") === 1) {
				return toolSse([{ name: "team_send_message", args: { teamRunId, to: "alpha", body: "WT_PING from lead", kind: "message" } }], id, request.model)
			}
			if (latest.includes("WT_STATUS") && teamRunId && context.turn("status") === 1) return toolSse([{ name: "team_status", args: { teamRunId } }], id, request.model)
			if (latest.includes("WT_DELETE") && teamRunId && context.turn("delete") === 1) {
				return toolSse([{ name: "team_delete", args: { teamRunId, force: true } }], id, request.model)
			}
			return sse("WT_LEAD_ACK", id, request.model)
		}
		const member = users.includes("WT_ALPHA_ROLE") ? "alpha" : users.includes("WT_BETA_ROLE") ? "beta" : users.includes("WT_GAMMA_ROLE") ? "gamma" : undefined
		if (!member || !request.sessionID) return sse("WT_DEFAULT", id, request.model)
		const worktree = field(users, "Worktree")
		const runId = field(users, "TeamRunId")
		if (worktree) worktrees[member] = worktree
		if (latest.includes("WT_PING") && runId && context.turn(`${member}:pong`) === 1) {
			return toolSse([{ name: "team_send_message", args: { teamRunId: runId, to: "lead", body: "WT_PONG from alpha", kind: "message" } }], id, request.model)
		}
		const turn = context.turn(`${member}:work`)
		if (member === "alpha") {
			if (turn === 1) return toolSse([{ name: "task", args: { subagent_type: "explore", description: "nested", prompt: "WT_NESTED", run_in_background: false } }], id, request.model)
			if (turn === 2 && worktree) return toolSse([{ name: "write", args: { filePath: join(worktree, "shared.txt"), content: "ALPHA\n" } }], id, request.model)
			if (turn === 3 && runId) return toolSse([{ name: "team_send_message", args: { teamRunId: runId, to: "lead", body: "WT_ALPHA_DONE", kind: "message" } }], id, request.model)
		}
		if (member === "beta") {
			if (turn === 1 && worktree) return toolSse([{ name: "write", args: { filePath: join(worktree, "shared.txt"), content: "BETA\n" } }], id, request.model)
			if (turn === 2 && runId) return toolSse([{ name: "team_send_message", args: { teamRunId: runId, to: "lead", body: "WT_BETA_DONE", kind: "message" } }], id, request.model)
		}
		return sse(`WT_${member.toUpperCase()}_IDLE`, id, request.model)
	})
	await writeOriginProbe(isolation.probeDirectory, PROBE_ID, mock.origin, MODELS)
	let host: Host | undefined
	let failure: string | undefined
	const state: Record<string, unknown> = {}
	const memberRequests = (marker: string) => mock.requests.filter((item) => item.kind === "primary" && item.sessionID !== leadID && item.users.join("\n").includes(marker))
	const leadText = async () => JSON.stringify((await host!.client.message.list({ sessionID: leadID! })).data)
	try {
		state.config = await writeHostConfig({
			isolation, pluginDir: PLUGIN_DIR, probeID: PROBE_ID, mockOrigin: mock.origin, models: MODELS, defaultModel: "qa-model",
			omo: {
				agents: { atlas: { model: `${PROVIDER}/qa-model` }, "sisyphus-junior": { model: `${PROVIDER}/qa-model` } },
				categories: { "unspecified-low": { models: [`${PROVIDER}/qa-model`] } },
				team_mode: { enabled: true, base_dir: join(isolation.tempRoot, "teams"), max_parallel_members: 3, max_members: 5, max_wall_clock_minutes: 10, max_member_turns: 30 },
			},
		})
		host = await startHost(CLI, isolation, PASSWORD)
		await preflight(host, PROBE_ID, MODELS, "qa-model", "atlas")
		leadID = await createRootSession(host.client, isolation.project, "WT lead", "atlas", "qa-model")
		await promptAndWait(host.client, leadID, "WT_CREATE create the team.", "team create")
		await waitFor("members reported", async () => {
			const text = await leadText()
			return text.includes("WT_ALPHA_DONE") && text.includes("WT_BETA_DONE") && text.includes("WT_PONG") ? true : undefined
		}, 120_000).catch(() => undefined)
		await Bun.sleep(1_500)

		const hostWorktrees = (await host.client.worktree.list({ projectID: (await host.client.session.get({ sessionID: leadID })).projectID } as never)) as Array<{ directory: string; strategy?: string }>
		const base = join(isolation.project, ".omo", "worktrees")
		state.worktrees = worktrees
		state.hostWorktrees = hostWorktrees
		const sessions = (await host.client.session.list({ directory: undefined as never, limit: 50 } as never).catch(() => ({ data: [] as never[] }))).data
		check("each worktree member runs in its own host-managed git worktree under .omo/worktrees",
			["alpha", "beta", "gamma"].every((name) => worktrees[name]?.startsWith(base)) && new Set(Object.values(worktrees)).size === 3 &&
			["alpha", "beta", "gamma"].every((name) => hostWorktrees.some((entry) => entry.directory === worktrees[name] && entry.strategy === "git")),
			{ worktrees, hostWorktrees: hostWorktrees.map((entry) => entry.directory), sessions: sessions.length })
		const alphaRequests = memberRequests("WT_ALPHA_ROLE")
		check("OMO governs the member worktree Location (Team tools and Junior prompt are present there)",
			alphaRequests.length > 0 && alphaRequests[0]!.toolNames.includes("team_send_message") && alphaRequests[0]!.system.join("\n").includes("Sisyphus-Junior"),
			{ tools: alphaRequests[0]?.toolNames.filter((name) => name.startsWith("team_")) })
		const nestedResult = alphaRequests.flatMap((item) => item.toolResults).find((value) => /denied|not allowed|cannot|forbidden|blocked/i.test(value)) ?? ""
		check("member delegation stays blocked inside the worktree Location", Boolean(nestedResult) && !mock.requests.some((item) => item.users.join("\n").includes("WT_NESTED")),
			{ nestedResult: nestedResult.slice(0, 300) })
		const alphaFile = worktrees.alpha ? await readFile(join(worktrees.alpha, "shared.txt"), "utf8").catch(() => "") : ""
		const betaFile = worktrees.beta ? await readFile(join(worktrees.beta, "shared.txt"), "utf8").catch(() => "") : ""
		const rootFile = await readFile(join(isolation.project, "shared.txt"), "utf8")
		check("members edit the same file in isolation and the lead checkout is untouched",
			alphaFile === "ALPHA\n" && betaFile === "BETA\n" && rootFile === "ORIGINAL\n", { alphaFile, betaFile, rootFile })
		const leadMessages = await leadText()
		check("mailbox works across Locations in both directions (member→lead, lead→member→lead)",
			leadMessages.includes("WT_ALPHA_DONE") && leadMessages.includes("WT_BETA_DONE") && leadMessages.includes("WT_PONG") && memberRequests("WT_PING").length > 0)

		await promptAndWait(host.client, leadID, "WT_STATUS show the team.", "team status")
		const statusResult = mock.requests.filter((item) => item.sessionID === leadID).flatMap((item) => item.toolResults).find((value) => value.includes("runtimeState")) ?? ""
		check("team_status reports each member's worktree path", ["alpha", "beta", "gamma"].every((name) => worktrees[name] && statusResult.includes(worktrees[name]!)),
			{ statusResult: statusResult.slice(0, 1500) })
		const rootStatus = await git(isolation.project, "status", "--porcelain", "--untracked-files=all")
		const exclude = await readFile(join(isolation.project, ".git", "info", "exclude"), "utf8").catch(() => "")
		check("the lead checkout stays clean: member worktrees are excluded locally, not committed",
			!rootStatus.includes(".omo/worktrees") && !rootStatus.includes("shared.txt") && exclude.includes("/.omo/worktrees/"),
			{ rootStatus, exclude: exclude.slice(-200) })

		await promptAndWait(host.client, leadID, "WT_DELETE close the team.", "team delete")
		const deleteResult = mock.requests.filter((item) => item.sessionID === leadID).flatMap((item) => item.toolResults).find((value) => value.includes("\"deleted\"")) ?? ""
		state.deleteResult = deleteResult
		const parsed = (() => { try { return JSON.parse(deleteResult) as { worktrees?: { removed: string[]; kept: Array<{ directory: string }> } } } catch { return {} } })()
		const afterList = (await host.client.worktree.list({ projectID: (await host.client.session.get({ sessionID: leadID })).projectID } as never)) as Array<{ directory: string }>
		check("team_delete (force) removes the clean worktree but never discards the ones with uncommitted work",
			Boolean(parsed.worktrees?.removed.includes(worktrees.gamma!)) &&
			["alpha", "beta"].every((name) => parsed.worktrees?.kept.some((entry) => entry.directory === worktrees[name])) &&
			!afterList.some((entry) => entry.directory === worktrees.gamma) && (await Bun.file(join(worktrees.alpha!, "shared.txt")).exists()),
			{ deleteResult: deleteResult.slice(0, 1200), afterList: afterList.map((entry) => entry.directory) })
		check("all model requests were local and attributed",
			mock.requests.length > 0 && mock.originFailures.length === 0 && mock.unexpectedPaths.length === 0 && mock.requests.every((item) => item.originValid),
			{ total: mock.requests.length, originFailures: mock.originFailures })
		state.leadAssistant = (await host.client.message.list({ sessionID: leadID })).data.flatMap((row) => asRecord(row)?.type === "assistant" ? [contentText(asRecord(row)?.content)] : [])
	} catch (error) {
		failure = error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ""}` : String(error)
	} finally {
		const exit = await stopHost(host)
		mock.stop()
		const driverSHA = sha256(await readFile(join(import.meta.dir, "opencode2-team-worktree-qa.ts")))
		const result = {
			startedAt: new Date().toISOString(), productionSource: gitState(),
			bundle: { serverPath: join(PLUGIN_DIR, "server.js"), expectedSHA: EXPECTED_SHA, actualSHA, driverSHA },
			cli: { path: CLI, version: cliVersion }, isolation, leadID, teamRunId, state, checks,
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
	if (checks.some((item) => !item.passed)) throw new Error("Team worktree native QA checks failed")
}

main().catch((error) => {
	console.error(error)
	process.exitCode = 1
})
