/** Isolated OpenCode 2.0.18 runtime proof for OMO long-conversation behavior (compaction context, limits, recovery). */
import { readFile, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import {
	PROVIDER, ROOT, asRecord, contentText, createRootSession, gitState, preflight, prepareIsolation, promptAndWait,
	sha256, sse, startHost, startMock, stopHost, toolSse, verifyArtifact, waitFor, within, writeEvidence, writeHostConfig, writeOriginProbe,
	type Check, type Host, type MockRequest, type QaModel,
} from "./opencode2-qa-harness"

const EVIDENCE = resolve(process.env.OPENCODE2_QA_EVIDENCE_DIR ?? join(ROOT, ".omo/evidence/20260927-long-conversation"))
const PLUGIN_DIR = resolve(process.env.OPENCODE2_PLUGIN_DIR ?? join(ROOT, "dist/opencode2"))
const CLI = process.env.OPENCODE2_CLI?.trim() ? resolve(process.env.OPENCODE2_CLI.trim()) : ""
const EXPECTED_SHA = process.env.OPENCODE2_EXPECTED_SERVER_SHA256 ?? ""
const PASSWORD = "long-conversation-local-qa-only"
const PROBE_ID = "omo-long-conversation-origin-probe"
const MODEL = "qa-model"
const COMPACTOR = "qa-compactor"
const SMALL = "qa-small"
const MODELS: QaModel[] = [
	{ id: MODEL, context: 200_000, output: 8_192 },
	{ id: COMPACTOR, context: 100_000, output: 4_096 },
	{ id: SMALL, context: 60_000, output: 4_096 },
]
const PHASE1_MODELS: QaModel[] = [MODELS[0]!]

const SUMMARY = (marker: string) => [
	"## Objective",
	`- Continue the isolated long-conversation QA (${marker}).`,
	"## Work State",
	"### Completed",
	"- Earlier turns completed.",
	"### Active",
	"- Continue with the next local prompt.",
	"## Next Move",
	"1. Answer the next prompt.",
].join("\n")

function latestUser(request: MockRequest): string {
	return request.users.at(-1) ?? ""
}

function joined(request: MockRequest): string {
	return [...request.system, ...request.users, ...request.toolResults].join("\n")
}

async function sessionAssistantText(host: Host, sessionID: string): Promise<string> {
	const messages = (await host.client.message.list({ sessionID })).data
	return messages.flatMap((item) => {
		const row = asRecord(item)
		return row?.type === "assistant" ? [contentText(row.content)] : []
	}).join("\n")
}

async function main(): Promise<void> {
	const { actualSHA, cliVersion } = await verifyArtifact(PLUGIN_DIR, EXPECTED_SHA, CLI)
	const isolation = await prepareIsolation(EVIDENCE, "omo-long-conversation-qa-")
	const checks: Check[] = []
	const check = (name: string, passed: boolean, detail?: unknown) => checks.push({ name, passed, ...(detail === undefined ? {} : { detail }) })
	const state: Record<string, unknown> = {}
	const bigFiles = Array.from({ length: 5 }, (_, index) => join(isolation.project, `big-output-${index}.txt`))
	const bigLine = (index: number, line: number) => `LC_BIG_${index}_${String(line).padStart(4, "0")} ${"b".repeat(84)}`
	await Promise.all(bigFiles.map((path, index) => writeFile(path, Array.from({ length: 500 }, (_, line) => bigLine(index, line)).join("\n") + "\n")))
	const grepFile = join(isolation.project, "grep-target.txt")
	await writeFile(grepFile, Array.from({ length: 1_200 }, (_, line) => `LC_GREP_MATCH ${String(line).padStart(5, "0")} ${"g".repeat(180)}`).join("\n") + "\n")
	const ids: { parent?: string; child?: string; atlas?: string; overflow?: string; small?: string; grep?: string; preempt?: string } = {}
	let overflowServed = false

	const mock = startMock(MODELS, (request, context) => {
		const id = `lc-${request.index}`
		const text = latestUser(request)
		if (request.kind === "unattributed") {
			// ctx.generate.text from the compaction-model override is not session-bound.
			return sse(SUMMARY("LC_COMPACTOR_SUMMARY"), id, request.model)
		}
		if (request.kind === "title" || request.kind === "generate") return sse("LC auxiliary", id, request.model)
		if (request.kind === "compaction") return sse(SUMMARY(`LC_HOST_SUMMARY ${request.sessionID}`), id, request.model)
		const session = request.sessionID ?? "unknown"
		// A checkpoint replays earlier user text, so match the later marker first.
		if (text.includes("LC_PREEMPT_TWO")) return sse("LC_PREEMPT_TWO_DONE", id, request.model, { prompt: 20_000, completion: 100 })
		if (text.includes("LC_PREEMPT_ONE")) return sse("LC_PREEMPT_ONE_DONE", id, request.model, { prompt: 160_000, completion: 100 })
		if (text.includes("LC_ORACLE_REVIEW")) return sse("VERDICT: REJECT - LC_REJECT_REASON the parser lacks an empty-input test", id, request.model)
		if (text.includes("LC_ORACLE_RESUME")) return sse("VERDICT: APPROVE LC_APPROVED", id, request.model)
		if (text.includes("LC_DELEGATE")) {
			if (context.turn(`${session}:delegate`) === 1) {
				return toolSse([{ name: "task", args: { subagent_type: "oracle", description: "LC review the parser", prompt: "LC_ORACLE_REVIEW Review the parser change.", run_in_background: false } }], id, request.model)
			}
			return sse("LC_DELEGATE_DONE", id, request.model)
		}
		if (text.includes("LC_AFTER_COMPACT")) {
			if (context.turn(`${session}:after`) === 1 && ids.child) {
				return toolSse([{ name: "task", args: { task_id: ids.child, description: "LC resume the same reviewer", prompt: "LC_ORACLE_RESUME Re-review after the fix.", run_in_background: false } }], id, request.model)
			}
			return sse("LC_RESUME_DONE", id, request.model)
		}
		if (text.includes("LC_ATLAS_HISTORY")) return sse("LC_ATLAS_ACK", id, request.model)
		if (text.includes("LC_ATLAS_NEXT")) return sse("LC_ATLAS_NEXT_DONE", id, request.model)
		if (session === ids.overflow) {
			if (!overflowServed) {
				overflowServed = true
				return Response.json({ error: { message: "This model's maximum context length is 200000 tokens. However, your messages resulted in 250000 tokens.", type: "invalid_request_error", code: "context_length_exceeded" } }, { status: 400 })
			}
			return sse("LC_OVERFLOW_RECOVERED", id, request.model)
		}
		// Mid-turn auto-compaction may fold the only user request into the summary; route by session.
		if (session === ids.small) {
			if (context.turn(`${session}:big`) === 1) {
				return toolSse(bigFiles.map((path) => ({ name: "shell", args: { command: `cat '${path}'`, description: "print a large fixture" } })), id, request.model, { prompt: 5_000, completion: 50 })
			}
			return sse("LC_BIG_DONE", id, request.model)
		}
		if (session === ids.grep) {
			// The in-flight step records usage only at settlement; the truncator uses the latest completed usage.
			if (text.includes("LC_GREP_WARMUP")) return sse("LC_GREP_WARMED", id, request.model, { prompt: 150_000, completion: 10 })
			if (context.turn(`${session}:grep`) === 1) {
				return toolSse([{ name: "grep", args: { pattern: "LC_GREP_MATCH", path: isolation.project, limit: 5_000 } }], id, request.model, { prompt: 150_000, completion: 10 })
			}
			return sse("LC_GREP_DONE", id, request.model, { prompt: 150_000, completion: 10 })
		}
		return sse("LC_DEFAULT", id, request.model)
	}, { allowUnattributed: [COMPACTOR] })
	await writeOriginProbe(isolation.probeDirectory, PROBE_ID, mock.origin, MODELS)

	let host: Host | undefined
	let failure: string | undefined
	const exits: Array<number | null> = []
	try {
		// Phase 1: opt-in preemptive compaction on the default 200k model.
		const phase1Config = await writeHostConfig({
			isolation, pluginDir: PLUGIN_DIR, probeID: PROBE_ID, mockOrigin: mock.origin, models: PHASE1_MODELS, defaultModel: MODEL,
			omo: { experimental: { preemptive_compaction: true } },
		})
		host = await startHost(CLI, isolation, PASSWORD)
		state.phase1Registry = await preflight(host, PROBE_ID, PHASE1_MODELS, MODEL)
		const limit = await waitFor("preemptive model limit", async () => {
			const listed = (await host!.client.model.list()).data.find((entry) => entry.providerID === PROVIDER && entry.id === MODEL)
			return listed?.limit?.input === 176_000 ? listed.limit : undefined
		}, 15_000).catch(() => undefined)
		check("preemptive_compaction sets the native input limit to 78% of context plus the host buffer", limit?.input === 176_000, limit)
		ids.preempt = await createRootSession(host.client, isolation.project, "LC preemptive", "sisyphus", MODEL)
		await promptAndWait(host.client, ids.preempt, "LC_PREEMPT_ONE fill the context to 160k tokens.", "preempt one")
		const beforeSecond = mock.requests.length
		await promptAndWait(host.client, ids.preempt, "LC_PREEMPT_TWO continue.", "preempt two")
		const secondRequests = mock.requests.slice(beforeSecond).filter((item) => item.sessionID === ids.preempt)
		const compactionIndex = secondRequests.findIndex((item) => item.kind === "compaction")
		const primaryAfter = secondRequests.findIndex((item, index) => index > compactionIndex && item.kind === "primary")
		check("usage at 80% (below the host default 90% ceiling) triggers native auto-compaction before the next primary request",
			compactionIndex >= 0 && primaryAfter > compactionIndex && secondRequests[primaryAfter]!.users.some((value) => value.includes("<conversation-checkpoint>")),
			secondRequests.map((item) => ({ kind: item.kind, model: item.model, users: item.users.map((value) => value.slice(0, 120)) })))
		exits.push(await stopHost(host))
		await writeEvidence(isolation.attempt, "phase1.server.stdout.log", host.stdout)
		await writeEvidence(isolation.attempt, "phase1.server.stderr.log", host.stderr)
		host = undefined

		// Phase 2: compaction context, compaction model, overflow recovery, aggressive truncation, output truncator.
		const phase2Config = await writeHostConfig({
			isolation, pluginDir: PLUGIN_DIR, probeID: PROBE_ID, mockOrigin: mock.origin, models: MODELS, defaultModel: MODEL,
			omo: {
				experimental: { aggressive_truncation: true },
				agents: { atlas: { compaction: { model: `${PROVIDER}/${COMPACTOR}` } } },
			},
		})
		state.config = { phase1: phase1Config, phase2: phase2Config }
		host = await startHost(CLI, isolation, PASSWORD)
		state.phase2Registry = await preflight(host, PROBE_ID, MODELS, MODEL)
		const phase2Limit = (await host.client.model.list()).data.find((entry) => entry.id === MODEL)?.limit
		check("preemptive threshold is absent when experimental.preemptive_compaction is not enabled", phase2Limit?.input === undefined, phase2Limit)

		// S1: delegated reviewer state survives compaction and the same child is resumed.
		ids.parent = await createRootSession(host.client, isolation.project, "LC compaction context", "sisyphus", MODEL)
		await promptAndWait(host.client, ids.parent, "LC_DELEGATE ask Oracle to review the parser.", "delegate")
		const children = (await host.client.session.list({ directory: isolation.project, parentID: ids.parent, limit: 20 })).data
		ids.child = children.find((row) => row.agent === "oracle")?.id
		check("Sisyphus delegated one Oracle reviewer child that rejected the work", Boolean(ids.child) && children.length === 1 &&
			(await sessionAssistantText(host, ids.child!)).includes("LC_REJECT_REASON"), children.map((row) => ({ id: row.id, agent: row.agent })))
		const beforeCompact = mock.requests.length
		await within("parent compaction", host.client.session.compact({ sessionID: ids.parent }))
		await within("parent compaction execution", host.client.session.wait({ sessionID: ids.parent }))
		const compactionRequest = mock.requests.slice(beforeCompact).find((item) => item.sessionID === ids.parent && item.kind === "compaction")
		const compactionText = compactionRequest ? joined(compactionRequest) : ""
		check("the native compaction request carries OMO guidance, the reviewer task_id and its rejection",
			Boolean(compactionRequest) && compactionText.includes("<omo_compaction_guidance>") && compactionText.includes("RESUME, DON'T RESTART") &&
			compactionText.includes(`task_id: \`${ids.child}\``) && compactionText.includes("LC_REJECT_REASON") && compactionText.includes("<current_agent>sisyphus</current_agent>"),
			compactionRequest ? { model: compactionRequest.model, system: compactionRequest.system.filter((value) => value.includes("omo_")) } : null)
		const beforeAfter = mock.requests.length
		await promptAndWait(host.client, ids.parent, "LC_AFTER_COMPACT continue the review work.", "after compaction")
		const afterRequests = mock.requests.slice(beforeAfter)
		const firstParent = afterRequests.find((item) => item.sessionID === ids.parent && item.kind === "primary")
		check("the next primary request after compaction re-injects OMO state with the reviewer task_id although the summary omitted it",
			Boolean(firstParent) && firstParent!.users.some((value) => value.includes("<conversation-checkpoint>") && !value.includes(ids.child!)) &&
			firstParent!.system.some((value) => value.includes("<omo_post_compaction_state>") && value.includes(`task_id: \`${ids.child}\``) && value.includes("LC_REJECT_REASON")),
			firstParent ? { system: firstParent.system.filter((value) => value.includes("omo_")), users: firstParent.users.map((value) => value.slice(0, 300)) } : null)
		const childResume = afterRequests.filter((item) => item.sessionID === ids.child && item.kind === "primary")
		const childrenAfter = (await host.client.session.list({ directory: isolation.project, parentID: ids.parent, limit: 20 })).data
		const parentText = await sessionAssistantText(host, ids.parent)
		check("the parent resumed the same reviewer with task_id after compaction and received its new verdict",
			childResume.some((item) => latestUser(item).includes("LC_ORACLE_RESUME")) && childrenAfter.length === 1 && childrenAfter[0]!.id === ids.child &&
			parentText.includes("LC_RESUME_DONE") && JSON.stringify((await host.client.message.list({ sessionID: ids.parent })).data).includes("LC_APPROVED"),
			{ childResume: childResume.map((item) => latestUser(item).slice(0, 200)), childrenAfter: childrenAfter.map((row) => row.id) })

		// S2: per-agent compaction model.
		ids.atlas = await createRootSession(host.client, isolation.project, "LC compaction model", "atlas", MODEL)
		await promptAndWait(host.client, ids.atlas, "LC_ATLAS_HISTORY remember LC_ATLAS_FACT.", "atlas history")
		const beforeAtlasCompact = mock.requests.length
		await within("atlas compaction", host.client.session.compact({ sessionID: ids.atlas }))
		await within("atlas compaction execution", host.client.session.wait({ sessionID: ids.atlas }))
		const atlasCompact = mock.requests.slice(beforeAtlasCompact)
		const compactorCall = atlasCompact.find((item) => item.kind === "unattributed" && item.model === COMPACTOR)
		check("Atlas compaction is generated by agents.atlas.compaction.model instead of the session model",
			Boolean(compactorCall) && joined(compactorCall!).includes("LC_ATLAS_HISTORY") && joined(compactorCall!).includes("You MUST summarize the conversation above") &&
			!atlasCompact.some((item) => item.sessionID === ids.atlas && item.kind === "compaction"),
			atlasCompact.map((item) => ({ kind: item.kind, model: item.model, sessionID: item.sessionID })))
		const beforeAtlasNext = mock.requests.length
		await promptAndWait(host.client, ids.atlas, "LC_ATLAS_NEXT continue.", "atlas next")
		const atlasNext = mock.requests.slice(beforeAtlasNext).find((item) => item.sessionID === ids.atlas && item.kind === "primary")
		check("the compaction-model summary becomes the native checkpoint for the next Atlas request",
			Boolean(atlasNext) && atlasNext!.model === MODEL && atlasNext!.users.some((value) => value.includes("<conversation-checkpoint>") && value.includes("LC_COMPACTOR_SUMMARY")),
			atlasNext ? { model: atlasNext.model, users: atlasNext.users.map((value) => value.slice(0, 300)) } : null)

		// S3: native context-overflow recovery.
		ids.overflow = await createRootSession(host.client, isolation.project, "LC overflow", "sisyphus", MODEL)
		const beforeOverflow = mock.requests.length
		await promptAndWait(host.client, ids.overflow, "LC_OVERFLOW trigger a provider context overflow.", "overflow")
		const overflowRequests = mock.requests.slice(beforeOverflow).filter((item) => item.sessionID === ids.overflow && item.kind !== "title")
		const overflowSession = await host.client.session.get({ sessionID: ids.overflow })
		check("a provider context-length 400 is recovered by native compaction and a retried primary request in the same turn",
			overflowRequests.length >= 3 && overflowRequests[0]!.kind === "primary" && overflowRequests.some((item) => item.kind === "compaction") &&
			overflowRequests.at(-1)!.kind === "primary" && overflowSession.outcome === "succeeded" && (await sessionAssistantText(host, ids.overflow)).includes("LC_OVERFLOW_RECOVERED"),
			{ sequence: overflowRequests.map((item) => item.kind), outcome: overflowSession.outcome })

		// S4: aggressive truncation bounds the compaction request on a 60k-token model.
		ids.small = await createRootSession(host.client, isolation.project, "LC aggressive truncation", "sisyphus", SMALL)
		const beforeSmall = mock.requests.length
		await promptAndWait(host.client, ids.small, "LC_BIG_OUTPUTS print the five large fixtures.", "big outputs", 120_000)
		const smallRequests = mock.requests.slice(beforeSmall).filter((item) => item.sessionID === ids.small)
		const smallCompaction = smallRequests.find((item) => item.kind === "compaction")
		const truncatedResults = smallCompaction?.toolResults.filter((value) => value.includes("Tool output truncated from")) ?? []
		const smallText = smallCompaction ? [...smallCompaction.system, ...smallCompaction.users, ...smallCompaction.toolResults].join("").length : 0
		check("experimental.aggressive_truncation bounds large tool results inside the automatic compaction request",
			Boolean(smallCompaction) && truncatedResults.length >= 1 && smallText <= (60_000 - 4_096) * 4 &&
			(await sessionAssistantText(host, ids.small)).includes("LC_BIG_DONE"),
			{ sequence: smallRequests.map((item) => item.kind), truncatedResults: truncatedResults.length, compactionChars: smallText, budget: (60_000 - 4_096) * 4 })

		// S5: dynamic tool-output truncation from remaining context.
		ids.grep = await createRootSession(host.client, isolation.project, "LC output truncator", "sisyphus", MODEL)
		await promptAndWait(host.client, ids.grep, "LC_GREP_WARMUP establish a 150k-token context.", "grep warmup")
		const beforeGrep = mock.requests.length
		await promptAndWait(host.client, ids.grep, "LC_GREP search the large fixture.", "grep")
		const grepRequests = mock.requests.slice(beforeGrep).filter((item) => item.sessionID === ids.grep)
		const grepPart = (await host.client.message.list({ sessionID: ids.grep })).data.flatMap((item) => {
			const row = asRecord(item)
			return row?.type === "assistant" && Array.isArray(row.content) ? row.content : []
		}).map(asRecord).find((part) => part?.type === "tool" && part.name === "grep")
		const grepState = asRecord(grepPart?.state)
		const grepResult = contentText(grepState?.content)
		const savedPath = /full output saved to (\S+)\]/.exec(grepResult)?.[1]
		const saved = savedPath ? await readFile(savedPath, "utf8").catch(() => "") : ""
		const fullGrepChars = (await readFile(grepFile, "utf8")).length
		// Usage 150,010 of 200,000 leaves 49,990 tokens; half is 24,995 tokens (~99,980 chars), below the static 50k target.
		check("grep output is truncated to half of the remaining context (not the static 50k-token target) and the full output is retained",
			grepState?.status === "completed" && grepResult.includes("OMO dynamic truncation") && grepResult.length <= 24_995 * 4 + 1_000 &&
			grepResult.length > 90_000 && saved.length > fullGrepChars && saved.includes("LC_GREP_MATCH 01199") && !grepResult.includes("LC_GREP_MATCH 01199") &&
			(await sessionAssistantText(host, ids.grep)).includes("LC_GREP_DONE"),
			{ resultChars: grepResult.length, savedChars: saved.length, fullGrepChars, tail: grepResult.slice(-240), sequence: grepRequests.map((item) => item.kind) })

		check("all model requests were local, attributed and on the fixture models",
			mock.requests.length > 0 && mock.originFailures.length === 0 && mock.unexpectedPaths.length === 0 &&
			mock.requests.every((item) => item.originValid) &&
			mock.requests.filter((item) => item.kind === "unattributed").every((item) => item.model === COMPACTOR),
			{ total: mock.requests.length, originFailures: mock.originFailures, unexpectedPaths: mock.unexpectedPaths })
	} catch (error) {
		failure = error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ""}` : String(error)
	} finally {
		exits.push(await stopHost(host))
		mock.stop()
		const driverSHA = sha256(await readFile(join(import.meta.dir, "opencode2-long-conversation-qa.ts")))
		const harnessSHA = sha256(await readFile(join(import.meta.dir, "opencode2-qa-harness.ts")))
		const result = {
			startedAt: new Date().toISOString(),
			productionSource: gitState(),
			bundle: { serverPath: join(PLUGIN_DIR, "server.js"), expectedSHA: EXPECTED_SHA, actualSHA, driverSHA, harnessSHA },
			cli: { path: CLI, version: cliVersion },
			isolation,
			ids,
			state,
			checks,
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
	if (checks.some((item) => !item.passed)) throw new Error("Long-conversation native QA checks failed")
}

main().catch((error) => {
	console.error(error)
	process.exitCode = 1
})
