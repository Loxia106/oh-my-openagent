/** Isolated OpenCode 2.0.18 runtime proof for imported command semantics and free-text slash expansion. */
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import {
	ROOT, asRecord, contentText, createRootSession, gitState, preflight, prepareIsolation, promptAndWait,
	sha256, sse, startHost, startMock, stopHost, verifyArtifact, waitFor, within, writeEvidence, writeHostConfig, writeOriginProbe,
	type Check, type Host, type MockRequest, type QaModel,
} from "./opencode2-qa-harness"

const EVIDENCE = resolve(process.env.OPENCODE2_QA_EVIDENCE_DIR ?? join(ROOT, ".omo/evidence/20260927-command-semantics"))
const PLUGIN_DIR = resolve(process.env.OPENCODE2_PLUGIN_DIR ?? join(ROOT, "dist/opencode2"))
const CLI = process.env.OPENCODE2_CLI?.trim() ? resolve(process.env.OPENCODE2_CLI.trim()) : ""
const EXPECTED_SHA = process.env.OPENCODE2_EXPECTED_SERVER_SHA256 ?? ""
const PASSWORD = "command-semantics-local-qa-only"
const PROBE_ID = "omo-command-semantics-origin-probe"
const MODELS: QaModel[] = [{ id: "qa-model", context: 200_000, output: 8_192 }]

function latestUser(request: MockRequest): string {
	return request.users.at(-1) ?? ""
}

async function assistantText(host: Host, sessionID: string): Promise<string> {
	return (await host.client.message.list({ sessionID })).data.flatMap((item) => {
		const row = asRecord(item)
		return row?.type === "assistant" ? [contentText(row.content)] : []
	}).join("\n")
}

async function main(): Promise<void> {
	const { actualSHA, cliVersion } = await verifyArtifact(PLUGIN_DIR, EXPECTED_SHA, CLI)
	const isolation = await prepareIsolation(EVIDENCE, "omo-command-semantics-qa-")
	const checks: Check[] = []
	const check = (name: string, passed: boolean, detail?: unknown) => checks.push({ name, passed, ...(detail === undefined ? {} : { detail }) })
	const commandsDir = join(isolation.project, ".claude", "commands")
	const skillDir = join(isolation.project, ".claude", "skills", "qa-skill")
	await mkdir(commandsDir, { recursive: true })
	await mkdir(skillDir, { recursive: true })
	await mkdir(join(isolation.project, "notes"), { recursive: true })
	await writeFile(join(isolation.project, "notes", "ref.md"), "CMD_REF_FILE_CONTENT\n")
	await writeFile(join(commandsDir, "qa-shell.md"), "---\ndescription: QA shell interpolation\n---\nCMD_SHELL !`printf CMD_SHELL_OUTPUT_$((6*7))` file=@notes/ref.md first=$ARGUMENTS[0] second=$ARGUMENTS[1]\n")
	await writeFile(join(commandsDir, "qa-subtask.md"), "---\ndescription: QA subtask\nagent: explore\nsubtask: true\n---\nCMD_SUBTASK investigate $ARGUMENTS\n")
	await writeFile(join(commandsDir, "qa-handoff.md"), [
		"---",
		"description: QA handoff",
		"handoffs:",
		"  - label: Continue with the next command",
		"    agent: qa-next",
		"    prompt: CMD_HANDOFF_PROMPT",
		"    send: true",
		"---",
		"CMD_HANDOFF_BODY $ARGUMENTS",
		"",
	].join("\n"))
	await writeFile(join(commandsDir, "qa-next.md"), "---\ndescription: QA next\n---\nCMD_NEXT_BODY $ARGUMENTS\n")
	await writeFile(join(skillDir, "SKILL.md"), "---\nname: qa-skill\ndescription: QA free-text skill\n---\nCMD_SKILL_BODY for $ARGUMENTS\n")

	const ids: Record<string, string | undefined> = {}
	const mock = startMock(MODELS, (request) => {
		const id = `cs-${request.index}`
		if (request.kind !== "primary") return sse("CS auxiliary", id, request.model)
		const user = latestUser(request)
		const all = request.users.join("\n")
		if (all.includes("You are a subagent spawned by another session") && all.includes("CMD_SUBTASK")) return sse("CMD_SUBTASK_RESULT from explore", id, request.model)
		if (request.sessionID === ids.subtask && all.includes("CMD_SUBTASK_RESULT")) return sse("CMD_PARENT_AFTER_SUBTASK", id, request.model)
		if (user.includes("CMD_NEXT_BODY")) return sse("CMD_NEXT_DONE", id, request.model)
		if (user.includes("CMD_HANDOFF_BODY")) return sse("CMD_HANDOFF_DONE", id, request.model)
		if (user.includes("CMD_SKILL_BODY")) return sse("CMD_SKILL_DONE", id, request.model)
		if (user.includes("CMD_SHELL")) return sse("CMD_SHELL_DONE", id, request.model)
		return sse("CS_DEFAULT", id, request.model)
	})
	await writeOriginProbe(isolation.probeDirectory, PROBE_ID, mock.origin, MODELS)

	let host: Host | undefined
	let failure: string | undefined
	const state: Record<string, unknown> = {}
	try {
		state.config = await writeHostConfig({
			isolation, pluginDir: PLUGIN_DIR, probeID: PROBE_ID, mockOrigin: mock.origin, models: MODELS, defaultModel: "qa-model",
			omo: { claude_code: { mcp: false, agents: false, skills: true, commands: true, plugins: false, hooks: false } },
		})
		host = await startHost(CLI, isolation, PASSWORD)
		state.registry = await preflight(host, PROBE_ID, MODELS, "qa-model")
		const commands = (await host.client.command.list({})).data.map((item) => item.name)
		state.commands = commands
		check("imported project commands are registered natively", ["qa-shell", "qa-subtask", "qa-handoff", "qa-next"].every((name) => commands.includes(name)), commands)

		ids.shell = await createRootSession(host.client, isolation.project, "CS shell", "sisyphus", "qa-model")
		const beforeShell = mock.requests.length
		await within("shell command", host.client.session.command({ sessionID: ids.shell, name: "qa-shell", text: "alpha beta" }))
		await within("shell execution", host.client.session.wait({ sessionID: ids.shell }))
		const shellRequest = mock.requests.slice(beforeShell).find((item) => item.sessionID === ids.shell && item.kind === "primary")
		const shellText = shellRequest ? latestUser(shellRequest) : ""
		check("command templates evaluate !`shell`, inline @path and zero-based $ARGUMENTS[N] before the model request",
			shellText.includes("CMD_SHELL_OUTPUT_42") && shellText.includes("CMD_REF_FILE_CONTENT") && shellText.includes("first=alpha second=beta") &&
			!shellText.includes("!`printf"), { shellText })

		ids.subtask = await createRootSession(host.client, isolation.project, "CS subtask", "sisyphus", "qa-model")
		await within("subtask command", host.client.session.command({ sessionID: ids.subtask, name: "qa-subtask", text: "the tree" }))
		const child = await waitFor("subtask child", async () => {
			const rows = (await host!.client.session.list({ directory: isolation.project, parentID: ids.subtask, limit: 10 })).data
			return rows.find((row) => row.agent === "explore")
		}, 20_000).catch(() => undefined)
		ids.subtaskChild = child?.id
		const parentAfter = await waitFor("parent processes subtask result", async () =>
			(await assistantText(host!, ids.subtask!)).includes("CMD_PARENT_AFTER_SUBTASK") ? true : undefined, 30_000).catch(() => false)
		const childRequests = mock.requests.filter((item) => item.sessionID === child?.id && item.kind === "primary")
		const parentMessages = JSON.stringify((await host.client.message.list({ sessionID: ids.subtask })).data)
		check("subtask: true runs the evaluated template in a native explore child and the parent is woken with its result",
			Boolean(child) && childRequests.some((item) => item.users.join("\n").includes("CMD_SUBTASK investigate the tree")) &&
			parentAfter === true && parentMessages.includes(`task_id: ${child!.id}`),
			{ child: child ? { id: child.id, agent: child.agent, parentID: child.parentID } : null, childUsers: childRequests.map((item) => item.users.map((value) => value.slice(0, 160))) })

		ids.handoff = await createRootSession(host.client, isolation.project, "CS handoff", "sisyphus", "qa-model")
		await within("handoff command", host.client.session.command({ sessionID: ids.handoff, name: "qa-handoff", text: "the plan" }))
		const handoffDone = await waitFor("handoff dispatch", async () =>
			(await assistantText(host!, ids.handoff!)).includes("CMD_NEXT_DONE") ? true : undefined, 30_000).catch(() => false)
		const handoffRequests = mock.requests.filter((item) => item.sessionID === ids.handoff && item.kind === "primary")
		const handoffMessages = JSON.stringify((await host.client.message.list({ sessionID: ids.handoff })).data)
		check("command handoffs are listed after the turn and the send:true target command runs with its prompt",
			handoffDone === true && handoffMessages.includes("suggested handoffs") &&
			handoffRequests.some((item) => latestUser(item).includes("CMD_NEXT_BODY CMD_HANDOFF_PROMPT")),
			{ users: handoffRequests.map((item) => latestUser(item).slice(0, 160)) })

		ids.slash = await createRootSession(host.client, isolation.project, "CS free-text slash", "sisyphus", "qa-model")
		const beforeSlash = mock.requests.length
		await promptAndWait(host.client, ids.slash, "/qa-skill the release", "free-text skill")
		await promptAndWait(host.client, ids.slash, "/qa-shell gamma delta", "free-text command")
		const slashRequests = mock.requests.slice(beforeSlash).filter((item) => item.sessionID === ids.slash && item.kind === "primary")
		const skillTurn = slashRequests.find((item) => latestUser(item).includes("CMD_SKILL_BODY"))
		const commandTurn = slashRequests.find((item) => latestUser(item).includes("CMD_SHELL "))
		check("free-text /skill and /command prompts are expanded once into tagged templates",
			Boolean(skillTurn) && latestUser(skillTurn!).includes("<auto-slash-command>") && latestUser(skillTurn!).includes("CMD_SKILL_BODY for the release") &&
			Boolean(commandTurn) && latestUser(commandTurn!).includes("CMD_SHELL_OUTPUT_42") && latestUser(commandTurn!).includes("first=gamma second=delta"),
			{ users: slashRequests.map((item) => latestUser(item).slice(0, 300)) })

		check("all model requests were local and attributed",
			mock.requests.length > 0 && mock.originFailures.length === 0 && mock.unexpectedPaths.length === 0 && mock.requests.every((item) => item.originValid),
			{ total: mock.requests.length, originFailures: mock.originFailures })
	} catch (error) {
		failure = error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ""}` : String(error)
	} finally {
		const exit = await stopHost(host)
		mock.stop()
		const driverSHA = sha256(await readFile(join(import.meta.dir, "opencode2-command-semantics-qa.ts")))
		const harnessSHA = sha256(await readFile(join(import.meta.dir, "opencode2-qa-harness.ts")))
		const result = {
			startedAt: new Date().toISOString(),
			productionSource: gitState(),
			bundle: { serverPath: join(PLUGIN_DIR, "server.js"), expectedSHA: EXPECTED_SHA, actualSHA, driverSHA, harnessSHA },
			cli: { path: CLI, version: cliVersion },
			isolation, ids, state, checks,
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
	if (checks.some((item) => !item.passed)) throw new Error("Command semantics native QA checks failed")
}

main().catch((error) => {
	console.error(error)
	process.exitCode = 1
})
