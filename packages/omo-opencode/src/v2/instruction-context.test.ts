import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Plugin } from "@opencode/plugin"
import {
	canonicalizeTarget,
	createV2InstructionContext,
	INSTRUCTION_RESULT_METADATA_KEY,
	readInstructionMarkers,
} from "./instruction-context"

function makeHistoryTool(input: {
	location: string
	rules?: string[]
	readmes?: string[]
	payload: string
	storedPayload?: string
}) {
	const storedPayload = input.storedPayload ?? input.payload
	return {
		type: "assistant",
		content: [{
			type: "tool",
			name: "read",
			state: {
				status: "completed",
				content: [{ type: "text", text: storedPayload }],
				metadata: {
					[INSTRUCTION_RESULT_METADATA_KEY]: {
						version: 1,
						location: input.location,
						payloadHash: createHash("sha256").update(input.payload).digest("hex"),
						payloadLength: input.payload.length,
						rules: input.rules ?? [],
						readmes: input.readmes ?? [],
					},
				},
			},
		}],
	}
}

function makeContext(directory: string, options: {
	history?: unknown[]
	models?: unknown[]
	context?: () => Promise<unknown[]>
	list?: () => Promise<unknown>
} = {}) {
	let contextCalls = 0
	let modelCalls = 0
	const ctx = {
		location: { directory, workspaceID: "instruction-test" },
		session: {
			context: async () => {
				contextCalls += 1
				return options.context ? options.context() : options.history ?? []
			},
		},
		model: {
			list: async () => {
				modelCalls += 1
				return options.list ? options.list() : { data: options.models ?? [] }
			},
		},
	}
	return {
		ctx: ctx as unknown as Plugin.Context,
		calls: () => ({ contextCalls, modelCalls }),
	}
}

describe("native instruction context", () => {
	test("rehydrates only persisted, location-matched markers with an intact payload", () => {
		const payload = "\n\n[Rule: .omo/rules/base.md]\n[Match: alwaysApply]\nDo this."
		const intact = makeHistoryTool({ location: "/workspace/a", rules: [".omo/rules/base.md"], readmes: ["/workspace/a/README.md"], payload })
		const truncated = makeHistoryTool({ location: "/workspace/a", rules: [".omo/rules/hidden.md"], payload, storedPayload: "short host-truncated output" })
		const otherLocation = makeHistoryTool({ location: "/workspace/b", rules: [".omo/rules/other.md"], payload })
		const pending = { type: "assistant", content: [{ type: "tool", name: "read", state: { status: "running", metadata: intact.content[0].state.metadata } }] }
		const markers = readInstructionMarkers([intact, truncated, otherLocation, pending], "/workspace/a")
		expect(markers.complete).toBe(true)
		expect([...markers.ruleRelativePaths]).toEqual([".omo/rules/base.md"])
		expect([...markers.readmePaths]).toEqual(["/workspace/a/README.md"])
	})

	test("scans the bounded history tail instead of aborting when earlier messages exist", () => {
		const payload = "\n\n[Project README: /workspace/a/README.md]\nProject info"
		const history = Array.from({ length: 4_010 }, (_, index) => ({ type: "user", id: `msg-${index}` }))
		history[4_009] = makeHistoryTool({ location: "/workspace/a", readmes: ["/workspace/a/README.md"], payload })
		const markers = readInstructionMarkers(history, "/workspace/a")
		expect(markers.complete).toBe(false)
		expect([...markers.readmePaths]).toEqual(["/workspace/a/README.md"])
	})

	test("budgets from latest completed assistant input, cache.read, and output against the matching model", async () => {
		const directory = await mkdtemp(join(tmpdir(), "omo-v2-instruction-context-"))
		try {
			const history = [{
				type: "assistant",
				time: { created: 1, completed: 2 },
				model: { providerID: "provider-a", id: "model-a" },
				tokens: { input: 100, output: 10, reasoning: 2, cache: { read: 20, write: 999 } },
				content: [],
			}]
			const harness = makeContext(directory, {
				history,
				models: [
					{ providerID: "provider-a", id: "other", limit: { context: 20_000 } },
					{ providerID: "provider-a", id: "model-a", limit: { context: 1_000 } },
				],
			})
			const native = createV2InstructionContext(harness.ctx, 100)
			const first = await native.load("ses-a")
			const second = await native.load("ses-b")
			expect(first?.maxTokens).toBe(435)
			expect(second?.maxTokens).toBe(435)
			expect(harness.calls()).toEqual({ contextCalls: 2, modelCalls: 1 })
			native.invalidateModelList()
			await native.load("ses-c")
			expect(harness.calls().modelCalls).toBe(2)
		} finally {
			await rm(directory, { recursive: true, force: true })
		}
	})

	test("falls back to 50k tokens when usage or the matching model limit is unavailable", async () => {
		const directory = await mkdtemp(join(tmpdir(), "omo-v2-instruction-fallback-"))
		try {
			const harness = makeContext(directory, { history: [], models: [] })
			const native = createV2InstructionContext(harness.ctx, 100)
			expect((await native.load("ses-a"))?.maxTokens).toBe(50_000)
		} finally {
			await rm(directory, { recursive: true, force: true })
		}
	})

	test("bounds a stalled native context request by the configured timeout", async () => {
		const directory = await mkdtemp(join(tmpdir(), "omo-v2-instruction-timeout-"))
		try {
			const never = new Promise<unknown[]>(() => undefined)
			const harness = makeContext(directory, { context: () => never })
			const native = createV2InstructionContext(harness.ctx, 10)
			const started = Date.now()
			expect(await native.load("ses-a")).toBeUndefined()
			expect(Date.now() - started).toBeLessThan(250)
		} finally {
			await rm(directory, { recursive: true, force: true })
		}
	})

	test("rejects external paths and symlinks that resolve outside the workspace", async () => {
		const parent = await mkdtemp(join(tmpdir(), "omo-v2-instruction-paths-"))
		const root = join(parent, "workspace")
		const sibling = join(parent, "workspace-copy")
		const outside = join(parent, "outside.txt")
		try {
			await mkdir(root)
			await mkdir(sibling)
			await writeFile(join(root, "inside.txt"), "inside")
			await writeFile(join(sibling, "sibling.txt"), "sibling")
			await writeFile(outside, "outside")
			await symlink(outside, join(root, "escape.txt"))
			expect(await canonicalizeTarget(root, join(root, "inside.txt"))).toMatchObject({ isDirectory: false })
			expect(await canonicalizeTarget(root, join(sibling, "sibling.txt"))).toBeUndefined()
			expect(await canonicalizeTarget(root, join(root, "escape.txt"))).toBeUndefined()
		} finally {
			await rm(parent, { recursive: true, force: true })
		}
	})
})
