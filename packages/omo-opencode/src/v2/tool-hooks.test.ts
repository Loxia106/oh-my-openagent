import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Plugin } from "@opencode/plugin"
import type { OhMyOpenCodeConfig } from "../config"
import { computeLineHash } from "../tools/hashline-edit/hash-computation"
import { registerV2ToolHooks } from "./tool-hooks"

const roots: string[] = []
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function mockContext(directory: string, failAfterHook = false) {
	let permissionCallback: ((event: any) => unknown) | undefined
	let afterCallback: ((event: any) => unknown) | undefined
	const disposed: string[] = []
	const ctx = {
		location: { directory },
		permission: {
		hook: async (_name: string, callback: (event: any) => unknown) => {
				permissionCallback = callback
				return { dispose: async () => { disposed.push("permission") } }
			},
		},
		tool: {
			hook: async (_name: string, callback: (event: any) => unknown) => {
				if (failAfterHook) throw new Error("after-hook registration failure")
				afterCallback = callback
				return { dispose: async () => { disposed.push("after") } }
			},
		},
	}
	return { ctx: ctx as unknown as Plugin.Context, permissionCallback: () => permissionCallback, afterCallback: () => afterCallback, disposed }
}

describe("native v2 tool hooks", () => {
	test("blocks Prometheus edit permission for paths outside workspace .omo Markdown", async () => {
		const directory = await mkdtemp(join(tmpdir(), "omo-v2-tools-test-"))
		roots.push(directory)
		const omo = join(directory, ".omo")
		await mkdir(omo)
		const approved = join(omo, "plan.md")
		const outside = join(directory, "notes.md")
		await writeFile(approved, "# Plan\n")
		await writeFile(outside, "# Outside\n")
		const { ctx, permissionCallback } = mockContext(directory)
		const cleanup = await registerV2ToolHooks(ctx, {} as OhMyOpenCodeConfig)
		const callback = permissionCallback()
		expect(callback).toBeDefined()

		const allowed = { agent: "prometheus", action: "edit", resources: [approved], effect: "allow" }
		await callback?.(allowed)
		expect(allowed.effect).toBe("allow")
		const denied = { agent: "prometheus", action: "edit", resources: [outside], effect: "allow" }
		await callback?.(denied)
		expect(denied.effect).toBe("deny")
		expect(denied.message).toContain("Prometheus may edit only Markdown files")
		const unrelatedAgent = { agent: "custom-prometheus-helper", action: "edit", resources: [outside], effect: "allow" }
		await callback?.(unrelatedAgent)
		expect(unrelatedAgent.effect).toBe("allow")
		await cleanup()
	})

	test("rejects an in-workspace .omo Markdown symlink that escapes the workspace", async () => {
		const directory = await mkdtemp(join(tmpdir(), "omo-v2-tools-test-"))
		roots.push(directory)
		const omo = join(directory, ".omo")
		await mkdir(omo)
		const outside = join(directory, "outside.md")
		const link = join(omo, "plan.md")
		await writeFile(outside, "# Outside\n")
		await symlink(outside, link)
		const { ctx, permissionCallback } = mockContext(directory)
		const cleanup = await registerV2ToolHooks(ctx, {} as OhMyOpenCodeConfig)
		const denied = { agent: "prometheus", action: "edit", resources: [link], effect: "allow" }
		await permissionCallback()?.(denied)
		expect(denied.effect).toBe("deny")
		await cleanup()
	})

	test("adds hashline IDs to native read output while preserving its structure", async () => {
		const directory = await mkdtemp(join(tmpdir(), "omo-v2-tools-test-"))
		roots.push(directory)
		const { ctx, afterCallback } = mockContext(directory)
		const cleanup = await registerV2ToolHooks(ctx, { hashline_edit: true } as OhMyOpenCodeConfig)
		const callback = afterCallback()
		expect(callback).toBeDefined()
		const original = {
			status: "completed",
			tool: "read",
			result: { title: "Read", content: [{ type: "text", text: "Read file /tmp/sample.txt, lines 1-1\n1: alpha" }], extra: "kept" },
		}
		await callback?.(original)
		expect(original.result.extra).toBe("kept")
		expect(original.result.content[0]?.text).toBe(`Read file /tmp/sample.txt, lines 1-1\n1#${computeLineHash(1, "alpha")}|alpha`)
		await cleanup()
	})

	test("unwinds the permission registration when a later read hook registration fails", async () => {
		const directory = await mkdtemp(join(tmpdir(), "omo-v2-tools-test-"))
		roots.push(directory)
		const { ctx, disposed } = mockContext(directory, true)
		await expect(registerV2ToolHooks(ctx, { hashline_edit: true } as OhMyOpenCodeConfig)).rejects.toThrow("after-hook registration failure")
		expect(disposed).toEqual(["permission"])
	})
})
