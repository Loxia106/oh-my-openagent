import { describe, expect, test } from "bun:test"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Plugin } from "@opencode/plugin"
import type { ToolContext, ToolEditor } from "@opencode/plugin/promise/tool"
import type { OhMyOpenCodeConfig } from "../config"
import type { LoadedSkill } from "../features/opencode-skill-loader/types"
import { cdpServerName, registerV2SkillMcpRuntime } from "./tool-skill-mcp"

type NativeTool = {
	id: string
	name: string
	options?: { namespace?: string }
	execute: (input: unknown, context: ToolContext) => Promise<any>
}

function skill(mcpConfig: Record<string, unknown>): LoadedSkill {
	return {
		name: "sample-skill",
		scope: "project",
		definition: { name: "sample-skill", description: "test", template: "skill" },
		mcpConfig: mcpConfig as LoadedSkill["mcpConfig"],
	}
}

function harness(initialConfig: Record<string, unknown> = {}) {
	const transforms: Array<(editor: any) => void> = []
	const sessionHooks = new Map<string, (event: any) => unknown>()
	const permissionHooks = new Map<string, (event: any) => unknown>()
	const agentPermissions: Array<{ action: string; resource: string; effect: string }> = []
	const sessionPermissions: Array<{ action: string; resource: string; effect: string }> = []
	const toolHooks = new Map<string, (event: any) => unknown>()
	const baseConfig = new Map<string, unknown>(Object.entries(initialConfig))
	let currentConfig = new Map<string, any>(baseConfig)
	let tools: NativeTool[] = []
	let toolListTransform: (listed: NativeTool[]) => NativeTool[] = (listed) => listed
	let reloadCount = 0
	const failedNativeServers = new Set<string>()
	let firstReloadGate: Promise<void> | undefined
	const disposed: string[] = []

	const makeEditor = (draft: Map<string, any>) => ({
		list: () => Array.from(draft.entries()),
		get: (name: string) => draft.get(name),
		set: (name: string, value: unknown) => draft.set(name, value),
		update: () => undefined,
		remove: (name: string) => draft.delete(name),
	})

	const addDynamicTools = () => {
		const dynamic = Array.from(currentConfig.entries())
		const reader: NativeTool = {
			id: "opencode_read_mcp_resource",
			name: "read_mcp_resource",
			options: { namespace: "opencode" },
			execute: async (input, context) => ({
				output: { input, sessionID: context.sessionID },
				content: [{ type: "file", uri: "data:image/png;base64,aGVsbG8=", mime: "image/png" }],
			}),
		}
		tools = [reader, ...dynamic.map(([serverName]) => ({
			id: `${serverName}_query`,
			name: "query",
			options: { namespace: serverName },
			execute: async (input, context) => ({
				content: JSON.stringify({ input, sessionID: context.sessionID, signal: context.signal.aborted }),
			}),
		}))]
	}

	const ctx = {
		location: { directory: "/workspace" },
		mcp: {
			transform: async (callback: (editor: any) => void) => {
				transforms.push(callback)
				callback(makeEditor(new Map(baseConfig)))
				return { dispose: async () => { disposed.push("mcp") } }
			},
			list: async () => ({ data: Array.from(currentConfig.keys()).map((name) => ({
				name,
				status: failedNativeServers.has(name)
					? { status: "failed", error: "test connection failure" }
					: { status: "connected" },
			})) }),
			reload: async () => {
				reloadCount += 1
				const draft = new Map(baseConfig)
				for (const transform of transforms) transform(makeEditor(draft))
				currentConfig = draft
				addDynamicTools()
				if (reloadCount === 1) await firstReloadGate
			},
		},
		tool: {
			reload: async () => undefined,
			list: async () => toolListTransform(tools),
			hook: async (name: string, callback: (event: any) => unknown) => {
				toolHooks.set(name, callback)
				return { dispose: async () => { toolHooks.delete(name); disposed.push("tool") } }
			},
		},
		session: {
			hook: async (name: string, callback: (event: any) => unknown) => {
				sessionHooks.set(name, callback)
				return { dispose: async () => { sessionHooks.delete(name); disposed.push("session") } }
			},
			get: async ({ sessionID }: { sessionID: string }) => ({ id: sessionID, agent: "sisyphus", permissions: sessionPermissions }),
		},
		agent: { list: async () => ({ data: [{ id: "sisyphus", permissions: agentPermissions }] }) },
		permission: {
			hook: async (name: string, callback: (event: any) => unknown) => {
				permissionHooks.set(name, callback)
				return { dispose: async () => { permissionHooks.delete(name); disposed.push("permission") } }
			},
		},
	} as unknown as Plugin.Context

	return {
		ctx,
		sessionHooks,
		permissionHooks,
		agentPermissions,
		sessionPermissions,
		toolHooks,
		get currentConfig() { return currentConfig },
		get reloadCount() { return reloadCount },
		transformToolList(transform: (listed: NativeTool[]) => NativeTool[]) { toolListTransform = transform },
		disposed,
		failServer(name: string) { failedNativeServers.add(name) },
		gateFirstReload(promise: Promise<void>) { firstReloadGate = promise },
	}
}

function addTool(runtime: NonNullable<Awaited<ReturnType<typeof registerV2SkillMcpRuntime>>>) {
	const tools: any[] = []
	runtime.addTool({ add: (definition: unknown) => tools.push(definition) } as ToolEditor)
	return tools[0] as { execute: (input: unknown, context: ToolContext) => Promise<any> }
}

function toolContext(sessionID = "ses-skill-mcp"): ToolContext {
	return toolContextWithSignal(new AbortController().signal, sessionID)
}

function toolContextWithSignal(signal: AbortSignal, sessionID = "ses-skill-mcp"): ToolContext {
	return {
		sessionID,
		agent: "sisyphus",
		messageID: "msg-skill-mcp",
		id: "call-skill-mcp",
		signal,
		progress: async () => undefined,
	}
}

describe("native v2 skill_mcp adapter", () => {
	test("routes skill tool calls through the namespaced native executor and hides direct tools", async () => {
		const host = harness()
		const runtime = await registerV2SkillMcpRuntime(host.ctx, {} as OhMyOpenCodeConfig, [skill({
			sqlite: { type: "stdio", command: "node", args: ["server.js"] },
		})])
		expect(runtime).toBeDefined()
		const call = addTool(runtime!)
		const context = toolContext()
		const result = await call.execute({ mcp_name: "sqlite", tool_name: "query", arguments: { sql: "select 1" } }, context)
		const nativeServer = Array.from(host.currentConfig.keys()).find((name) => name === "sqlite")!
		expect(host.reloadCount).toBe(1)
		expect(JSON.parse(result.content)).toEqual({ input: { sql: "select 1" }, sessionID: context.sessionID, signal: false })
		expect(result.metadata).toMatchObject({ mcp_name: "sqlite", skill: "sample-skill", tool_name: "query" })

		const nativeToolId = `${nativeServer}_query`
		const modelTools = { [nativeToolId]: {}, skill_mcp: {} }
		await host.sessionHooks.get("context")?.({ tools: modelTools })
		expect(modelTools).toEqual({ skill_mcp: {} })
		await expect(Promise.resolve().then(() => host.toolHooks.get("execute.before")?.({ tool: nativeToolId })))
			.rejects.toThrow("Skill MCP tools can only be called through skill_mcp.")
		await runtime!.cleanup()
	})

	test("routes resource reads through the native opencode resource executor", async () => {
		const host = harness()
		const runtime = await registerV2SkillMcpRuntime(host.ctx, {} as OhMyOpenCodeConfig, [skill({ memory: { command: "node" } })])
		const call = addTool(runtime!)
		const result = await call.execute({ mcp_name: "memory", resource_name: "memory://notes" }, toolContext())
		const nativeServer = "memory"
		const response = JSON.parse(result.content[0].text)
		expect(response.input).toEqual({ server: nativeServer, uri: "memory://notes" })
		expect(response.sessionID).toBe("ses-skill-mcp")
		expect(result.content[1]).toMatchObject({ type: "file", mime: "image/png" })
		await runtime!.cleanup()
	})

	test("coalesces concurrent first calls for one server and keeps stable namespaced registration", async () => {
		const host = harness()
		const runtime = await registerV2SkillMcpRuntime(host.ctx, {} as OhMyOpenCodeConfig, [skill({ sqlite: { command: "node" } })])
		const call = addTool(runtime!)
		const input = { mcp_name: "sqlite", tool_name: "query" }
		await Promise.all([call.execute(input, toolContext()), call.execute(input, toolContext())])
		expect(host.reloadCount).toBe(1)
		expect(Array.from(host.currentConfig.keys()).filter((name) => name === "sqlite")).toHaveLength(1)
		await runtime!.cleanup()
	})

	test("shares the original native server name and permission namespace across sessions", async () => {
		const host = harness()
		const runtime = await registerV2SkillMcpRuntime(host.ctx, {} as OhMyOpenCodeConfig, [skill({ sqlite: { command: "node" } })])
		const call = addTool(runtime!)
		await Promise.all([
			call.execute({ mcp_name: "sqlite", tool_name: "query" }, toolContext("ses-one")),
			call.execute({ mcp_name: "sqlite", tool_name: "query" }, toolContext("ses-two")),
		])
		const names = Array.from(host.currentConfig.keys()).filter((name) => name === "sqlite")
		expect(host.reloadCount).toBe(1)
		expect(names).toEqual(["sqlite"])
		await runtime!.cleanup()
	})

	test("fails closed when a native MCP with the declared name already exists", async () => {
		const existing = { type: "local", command: ["different-server"] }
		const host = harness({ sqlite: existing })
		const runtime = await registerV2SkillMcpRuntime(host.ctx, {} as OhMyOpenCodeConfig, [skill({ sqlite: { command: "node" } })])
		const call = addTool(runtime!)
		await expect(call.execute({ mcp_name: "sqlite", tool_name: "query" }, toolContext()))
			.rejects.toThrow("already exists in native OpenCode configuration")
		expect(host.reloadCount).toBe(0)
		expect(host.currentConfig.get("sqlite")).toEqual(existing)
		await runtime!.cleanup()
	})

	test("removes a failed native MCP registration and reports the connection error", async () => {
		const host = harness()
		const runtime = await registerV2SkillMcpRuntime(host.ctx, {} as OhMyOpenCodeConfig, [skill({ sqlite: { command: "node" } })])
		const call = addTool(runtime!)
		host.failServer("sqlite")
		const executing = call.execute({ mcp_name: "sqlite", tool_name: "query" }, toolContext())
		await expect(executing).rejects.toThrow("test connection failure")
		expect(host.reloadCount).toBe(2)
		expect(Array.from(host.currentConfig.keys()).some((name) => name === "sqlite")).toBe(false)
		await runtime!.cleanup()
	})

	test("aborts promptly while reload is pending and removes the registration before cleanup finishes", async () => {
		const host = harness()
		let releaseReload!: () => void
		host.gateFirstReload(new Promise<void>((resolve) => { releaseReload = resolve }))
		const runtime = await registerV2SkillMcpRuntime(host.ctx, {} as OhMyOpenCodeConfig, [skill({ sqlite: { command: "node" } })])
		const call = addTool(runtime!)
		const controller = new AbortController()
		const executing = call.execute({ mcp_name: "sqlite", tool_name: "query" }, toolContextWithSignal(controller.signal))
		while (host.reloadCount === 0) await new Promise((resolve) => setTimeout(resolve, 1))
		const nativeName = "sqlite"
		controller.abort()
		await expect(executing).rejects.toThrow("cancelled while the MCP server was starting")
		let cleaned = false
		const cleanup = runtime!.cleanup().then(() => { cleaned = true })
		await Promise.resolve()
		expect(cleaned).toBe(false)
		releaseReload()
		await cleanup
		expect(host.reloadCount).toBe(2)
		expect(Array.from(host.currentConfig.keys()).some((name) => name === nativeName)).toBe(false)
		expect(cleaned).toBe(true)
		expect(host.disposed).toEqual(["permission", "tool", "session", "mcp"])
	})

	test("cdp_url starts a derived local server with --cdp-endpoint whose tools keep the base permission rules", async () => {
		const host = harness()
		const runtime = await registerV2SkillMcpRuntime(host.ctx, {} as OhMyOpenCodeConfig, [skill({ sqlite: { command: "node", args: ["server.js"] } })])
		const call = addTool(runtime!)
		const result = await call.execute({ mcp_name: "sqlite", tool_name: "query", cdp_url: "http://localhost:9222" }, toolContext())
		const derived = cdpServerName("sqlite", "http://localhost:9222")
		expect(host.currentConfig.get(derived)?.command).toEqual(["node", "server.js", "--cdp-endpoint", "http://localhost:9222"])
		expect(host.currentConfig.has("sqlite")).toBe(false)
		expect(String(result.content)).toContain("sessionID")
		const hidden = { tools: { [`${derived}_query`]: {}, other: {} } }
		await host.sessionHooks.get("context")!(hidden)
		expect(Object.keys(hidden.tools)).toEqual(["other"])

		const evaluate = host.permissionHooks.get("evaluate")!
		const allowed = { sessionID: "ses-1", agent: "sisyphus", action: `${derived}_query`, resources: ["*"], effect: "allow" }
		await evaluate(allowed)
		expect(allowed.effect).toBe("allow")
		host.agentPermissions.push({ action: "sqlite_query", resource: "*", effect: "deny" })
		const denied = { sessionID: "ses-1", agent: "sisyphus", action: `${derived}_query`, resources: ["*"], effect: "allow" }
		await evaluate(denied)
		expect(denied.effect).toBe("deny")
		host.agentPermissions.length = 0
		host.sessionPermissions.push({ action: "sqlite_*", resource: "*", effect: "ask" })
		const asked = { sessionID: "ses-1", agent: "sisyphus", action: `${derived}_query`, resources: ["*"], effect: "allow" }
		await evaluate(asked)
		expect(asked.effect).toBe("ask")
		const unrelated = { sessionID: "ses-1", agent: "sisyphus", action: "other_tool", resources: ["*"], effect: "allow" }
		await evaluate(unrelated)
		expect(unrelated.effect).toBe("allow")
		await expect(call.execute({ mcp_name: "sqlite", tool_name: "query", cdp_url: "file:///etc/passwd" }, toolContext())).rejects.toThrow("cdp_url must use")
		await runtime!.cleanup()
	})

	test("prompt_name returns the MCP prompt messages through the shared skill MCP client", async () => {
		const directory = await mkdtemp(join(tmpdir(), "omo-v2-skill-mcp-prompt-"))
		const sdk = join(process.cwd(), "node_modules/@modelcontextprotocol/sdk/dist/esm/server")
		const serverPath = join(directory, "prompt-server.mjs")
		await writeFile(serverPath, [
			`import { McpServer } from ${JSON.stringify(join(sdk, "mcp.js"))}`,
			`import { StdioServerTransport } from ${JSON.stringify(join(sdk, "stdio.js"))}`,
			`import { z } from ${JSON.stringify(join(process.cwd(), "node_modules/zod/index.js"))}`,
			`const server = new McpServer({ name: "prompt-fixture", version: "1.0.0" })`,
			`server.registerPrompt("summarize", { description: "Summarize text", argsSchema: { text: z.string() } }, ({ text }) => ({ messages: [{ role: "user", content: { type: "text", text: "PROMPT_FIXTURE_SUMMARY:" + text } }] }))`,
			`await server.connect(new StdioServerTransport())`,
		].join("\n"))
		const host = harness()
		// The shared client starts stdio servers in the native project directory.
		;(host.ctx as unknown as { location: { directory: string } }).location = { directory }
		const runtime = await registerV2SkillMcpRuntime(host.ctx, {} as OhMyOpenCodeConfig, [skill({ helper: { command: process.execPath, args: [serverPath] } })])
		const call = addTool(runtime!)
		try {
			const result = await call.execute({ mcp_name: "helper", prompt_name: "summarize", arguments: { text: "release notes" } }, toolContext())
			expect(String(result.content)).toContain("PROMPT_FIXTURE_SUMMARY:release notes")
			expect(result.metadata).toMatchObject({ mcp_name: "helper", prompt_name: "summarize" })
			expect(host.reloadCount).toBe(0)
		} finally {
			await runtime!.cleanup()
		}
		const disabled = harness()
		const disabledRuntime = await registerV2SkillMcpRuntime(disabled.ctx, { disabled_mcps: ["helper"] } as unknown as OhMyOpenCodeConfig, [skill({ helper: { command: "node" } })])
		await expect(addTool(disabledRuntime!).execute({ mcp_name: "helper", prompt_name: "summarize" }, toolContext())).rejects.toThrow("disabled by disabled_mcps")
		await disabledRuntime!.cleanup()
	}, 20_000)

	test("honors skill_mcp and claude_code.mcp gates", async () => {
		const disabledTool = await registerV2SkillMcpRuntime(harness().ctx, { disabled_tools: ["skill_mcp"] } as unknown as OhMyOpenCodeConfig, [])
		const disabledMcp = await registerV2SkillMcpRuntime(harness().ctx, { claude_code: { mcp: false } } as unknown as OhMyOpenCodeConfig, [])
		expect(disabledTool).toBeUndefined()
		expect(disabledMcp).toBeUndefined()
	})

	test("waits for in-flight native execution before disposing registrations", async () => {
		const host = harness()
		let finish!: () => void
		const runtime = await registerV2SkillMcpRuntime(host.ctx, {} as OhMyOpenCodeConfig, [skill({ sqlite: { command: "node" } })])
		const call = addTool(runtime!)
		host.transformToolList((listed) => listed.map((tool) => tool.id.endsWith("_query")
			? { ...tool, execute: async () => new Promise((resolve) => { finish = () => resolve({ content: "done" }) }) }
			: tool))
		const executing = call.execute({ mcp_name: "sqlite", tool_name: "query" }, toolContext())
		while (!finish) await new Promise((resolve) => setTimeout(resolve, 1))
		let cleaned = false
		const cleanup = runtime!.cleanup().then(() => { cleaned = true })
		await Promise.resolve()
		expect(cleaned).toBe(false)
		finish()
		await executing
		await cleanup
		expect(cleaned).toBe(true)
		expect(host.disposed).toEqual(["permission", "tool", "session", "mcp"])
	})
})
