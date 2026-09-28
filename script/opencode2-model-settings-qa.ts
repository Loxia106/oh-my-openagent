/** Isolated OpenCode 2.0.18 proof that Sisyphus sends no enabled-thinking budget to adaptive-only Claude models. */
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import {
	PROVIDER, ROOT, createRootSession, gitState, preflight, prepareIsolation, promptAndWait,
	sha256, sse, startHost, startMock, stopHost, verifyArtifact, writeEvidence, writeHostConfig, writeOriginProbe,
	type Check, type Host, type QaModel,
} from "./opencode2-qa-harness"

const EVIDENCE = resolve(process.env.OPENCODE2_QA_EVIDENCE_DIR ?? join(ROOT, ".omo/evidence/20260928-claude-thinking"))
const PLUGIN_DIR = resolve(process.env.OPENCODE2_PLUGIN_DIR ?? join(ROOT, "dist/opencode2"))
const CLI = process.env.OPENCODE2_CLI?.trim() ? resolve(process.env.OPENCODE2_CLI.trim()) : ""
const EXPECTED_SHA = process.env.OPENCODE2_EXPECTED_SERVER_SHA256 ?? ""
const PROBE_ID = "omo-claude-thinking-origin-probe"
const MODELS: QaModel[] = [
	{ id: "claude-sonnet-5", context: 200_000, output: 8_192 },
	{ id: "claude-sonnet-4-6", context: 200_000, output: 8_192 },
]

async function main(): Promise<void> {
	const { actualSHA, cliVersion } = await verifyArtifact(PLUGIN_DIR, EXPECTED_SHA, CLI)
	const isolation = await prepareIsolation(EVIDENCE, "omo-claude-thinking-qa-")
	const checks: Check[] = []
	const check = (name: string, passed: boolean, detail?: unknown) => checks.push({ name, passed, ...(detail === undefined ? {} : { detail }) })
	const mock = startMock(MODELS, (request) => sse("CT_OK", `ct-${request.index}`, request.model))
	await writeOriginProbe(isolation.probeDirectory, PROBE_ID, mock.origin, MODELS)
	// Loaded after OMO, this observer records the final request options each context hook chain produced.
	const observerDir = join(isolation.tempRoot, "options-observer")
	const observed = join(isolation.tempRoot, "observed-options.jsonl")
	await mkdir(observerDir, { recursive: true })
	await writeFile(join(observerDir, "index.js"), `import { appendFileSync } from "node:fs"
export default { id: "omo-options-observer", setup: async (ctx) => {
  await ctx.session.hook("context", async (input) => {
    appendFileSync(${JSON.stringify(observed)}, JSON.stringify({ sessionID: input.sessionID, model: input.model?.id, agent: input.agent, thinking: input.options?.thinking ?? null, temperature: input.options?.temperature ?? null }) + "\\n")
  })
} }
`)
	let host: Host | undefined
	let failure: string | undefined
	const state: Record<string, unknown> = {}
	try {
		// Sisyphus is registered for claude-sonnet-4-6, so its request settings carry an enabled-thinking budget.
		await writeHostConfig({ isolation, pluginDir: PLUGIN_DIR, probeID: PROBE_ID, mockOrigin: mock.origin, models: MODELS, defaultModel: "claude-sonnet-4-6",
			omo: { agents: { sisyphus: { model: `${PROVIDER}/claude-sonnet-4-6` } } },
			extraOpencode: { plugins: [isolation.probeDirectory, PLUGIN_DIR, observerDir] } })
		host = await startHost(CLI, isolation, "claude-thinking-local-qa-only")
		await preflight(host, PROBE_ID, MODELS, "claude-sonnet-4-6")
		const results: Record<string, unknown> = {}
		for (const model of ["claude-sonnet-5", "claude-sonnet-4-6"]) {
			const sessionID = await createRootSession(host.client, isolation.project, `CT ${model}`, "sisyphus", model)
			await promptAndWait(host.client, sessionID, `CT ${model}`, model)
			const lines = (await readFile(observed, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
			const entry = lines.filter((line) => line.sessionID === sessionID).at(-1)
			results[model] = { seen: Boolean(entry), requestModel: entry?.model, thinking: entry?.thinking, temperature: entry?.temperature }
		}
		state.results = results
		const sonnet5 = results["claude-sonnet-5"] as { seen: boolean; requestModel?: string; thinking: unknown; temperature: unknown }
		const sonnet46 = results["claude-sonnet-4-6"] as { seen: boolean; requestModel?: string; thinking: unknown; temperature: unknown }
		check("a session on claude-sonnet-5 sends no enabled-thinking budget even though Sisyphus was registered for claude-sonnet-4-6",
			sonnet5.seen && sonnet5.requestModel === "claude-sonnet-5" && !JSON.stringify(sonnet5.thinking ?? null).includes("enabled") && sonnet5.temperature === null, sonnet5)
		check("control: the same agent on claude-sonnet-4-6 keeps its enabled-thinking budget",
			sonnet46.seen && JSON.stringify(sonnet46.thinking ?? null).includes("enabled"), sonnet46)
	} catch (error) {
		failure = error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ""}` : String(error)
	} finally {
		const exit = await stopHost(host)
		mock.stop()
		const result = {
			startedAt: new Date().toISOString(), productionSource: gitState(),
			bundle: { expectedSHA: EXPECTED_SHA, actualSHA, driverSHA: sha256(await readFile(join(import.meta.dir, "opencode2-claude-thinking-qa.ts"))) },
			cli: { path: CLI, version: cliVersion }, state, checks, allChecksPassed: checks.length > 0 && checks.every((item) => item.passed), failure,
			cleanup: { opencodeExitCode: exit, mockStopped: true },
		}
		await writeEvidence(isolation.attempt, "runtime.json", result)
		process.stdout.write(JSON.stringify({ evidence: isolation.attempt, state, checks: checks.map(({ name, passed }) => ({ name, passed })), failure }, null, 2) + "\n")
	}
	if (failure) throw new Error(failure)
	if (checks.some((item) => !item.passed)) throw new Error("Claude thinking native QA checks failed")
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
