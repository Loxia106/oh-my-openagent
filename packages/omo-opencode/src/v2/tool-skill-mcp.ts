import { isDeepStrictEqual } from "node:util"
import type { Plugin } from "@opencode/plugin"
import { Error as ToolError } from "@opencode/plugin/promise/tool"
import type { ToolContext, ToolEditor } from "@opencode/plugin/promise/tool"
import type { Mcp as McpSchema } from "@opencode/schema/mcp"
import { transformMcpServer } from "@oh-my-opencode/claude-code-compat-core/claude-code-mcp-loader/transformer"
import { z } from "zod"
import type { OhMyOpenCodeConfig } from "../config"
import type { LoadedSkill } from "../features/opencode-skill-loader/types"
import { loadV2SkillCatalog } from "./skills"
import { toV2McpConfig } from "./mcp"
import { addV2Tool } from "./tool-adapter"
import { BUILTIN_MCP_TOOL_HINTS, SKILL_MCP_DESCRIPTION } from "../tools/skill-mcp/constants"
import { parseSkillMcpArguments } from "../tools/skill-mcp/parse-skill-mcp-arguments"
import { log } from "../shared/logger"

const NATIVE_TOOL_WAIT_MS = 5000
const POLL_INTERVAL_MS = 50

const skillMcpInput = z.object({
	mcp_name: z.string().describe("MCP server name declared by a loaded skill"),
	tool_name: z.string().optional().describe("MCP tool to call"),
	resource_name: z.string().optional().describe("Exact MCP resource URI to read"),
	prompt_name: z.string().optional().describe("MCP prompt name (unsupported by the native v2 plugin API)"),
	arguments: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
	grep: z.string().optional().describe("Regex filter for returned text"),
	cdp_url: z.string().optional().describe("Unsupported by the native v2 MCP server API"),
})

type SkillServer = {
	skill: LoadedSkill
	name: string
	config: NonNullable<LoadedSkill["mcpConfig"]>[string]
}

type NativeServer = {
	name: string
	config: McpSchema.ServerConfig
}

type V2SkillMcpRuntime = {
	addTool: (editor: ToolEditor) => void
	cleanup: () => Promise<void>
}

function isDisabled(config: OhMyOpenCodeConfig, tool: string): boolean {
	return config.disabled_tools?.some((entry) => entry.trim().toLowerCase() === tool) ?? false
}

function formatAvailableMcps(skills: readonly LoadedSkill[]): string {
	const entries = skills.flatMap((skill) =>
		Object.keys(skill.mcpConfig ?? {}).map((name) => `  - "${name}" from skill "${skill.name}"`),
	)
	return entries.length === 0 ? "  (none found)" : entries.join("\n")
}

function findSkillServer(name: string, skills: readonly LoadedSkill[]): SkillServer | undefined {
	for (const skill of skills) {
		const config = skill.mcpConfig?.[name]
		if (config) return { skill, name, config }
	}
	return undefined
}

function validateOperation(input: z.infer<typeof skillMcpInput>): "tool" | "resource" | "prompt" {
	const operations = [
		input.tool_name ? "tool" : undefined,
		input.resource_name ? "resource" : undefined,
		input.prompt_name ? "prompt" : undefined,
	].filter((value): value is "tool" | "resource" | "prompt" => value !== undefined)
	if (operations.length !== 1) {
		throw new Error("Exactly one of tool_name, resource_name, or prompt_name must be specified.")
	}
	return operations[0]!
}

function toNativeSkillServerConfig(
	serverName: string,
	config: NonNullable<LoadedSkill["mcpConfig"]>[string],
): McpSchema.ServerConfig {
	if (config.disabled) throw new Error(`MCP server "${serverName}" is disabled in its skill configuration.`)
	const transformed = transformMcpServer(serverName, config)
	const native = toV2McpConfig(transformed)
	// Keep skill MCP tools callable only through skill_mcp. The session context hook
	// hides direct native names, and execute.before blocks callers that guess them.
	return { ...native, codemode: false } as McpSchema.ServerConfig
}

function matchingToolId(serverName: string, toolName: string): string {
	const namespace = nativeNamespace(serverName)
	const tool = toolName.replace(/[^a-zA-Z0-9_-]/g, "_")
	return `${namespace}_${tool}`
}

function nativeNamespace(serverName: string): string {
	return serverName.replace(/[^a-zA-Z0-9_-]/g, "_")
}

function isNativeSkillToolId(toolID: string, serverNames: Iterable<string>): boolean {
	for (const serverName of serverNames) {
		if (toolID.startsWith(`${nativeNamespace(serverName)}_`)) return true
	}
	return false
}

function logicalServerKey(skillServer: SkillServer): string {
	return `${skillServer.skill.name}\0${skillServer.name}`
}

function stringifyNativeResult(result: { output?: unknown; content?: unknown }): string {
	const value = result.output !== undefined ? result.output : result.content
	if (typeof value === "string") return value
	return JSON.stringify(value ?? null, null, 2)
}

function filterText(output: string, pattern: string | undefined): string {
	if (!pattern) return output
	try {
		const regex = new RegExp(pattern, "i")
		const lines = output.split("\n").filter((line) => regex.test(line))
		return lines.length > 0 ? lines.join("\n") : `[grep] No lines matched pattern: ${pattern}`
	} catch {
		return output
	}
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

function withAbort<T>(promise: Promise<T>, signal: AbortSignal, message: string): Promise<T> {
	if (signal.aborted) return Promise.reject(new Error(message))
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(new Error(message))
		signal.addEventListener("abort", onAbort, { once: true })
		promise.then(
			(value) => {
				signal.removeEventListener("abort", onAbort)
				resolve(value)
			},
			(error) => {
				signal.removeEventListener("abort", onAbort)
				reject(error)
			},
		)
	})
}

async function currentServers(ctx: Plugin.Context): Promise<readonly { name: string; status: { status: string; error?: string } }[]> {
	const response = await ctx.mcp.list({})
	return response.data as readonly { name: string; status: { status: string; error?: string } }[]
}

/** Register the legacy skill_mcp surface using native MCP transforms and executors. */
export async function registerV2SkillMcpRuntime(
	ctx: Plugin.Context,
	config: OhMyOpenCodeConfig,
	loadedSkills?: readonly LoadedSkill[],
): Promise<V2SkillMcpRuntime | undefined> {
	if (isDisabled(config, "skill_mcp") || config.claude_code?.mcp === false) return undefined
	const skills = loadedSkills ?? (await loadV2SkillCatalog(config, String(ctx.location.directory))).loaded
	const disabledMcps = new Set((config.disabled_mcps ?? []).map((name) => name.trim().toLowerCase()))
	// Native MCP permissions and tool IDs are keyed by the declared server name. Keep
	// these names stable so existing `sqlite_query`-style permission rules still apply.
	const activeServers = new Map<string, NativeServer>()
	const loadedServerNames = new Map<string, string>()
	const pendingServerLoads = new Map<string, Promise<string>>()
	const pendingCleanupTasks = new Set<Promise<void>>()
	const backgroundCleanupErrors: unknown[] = []
	let active = true
	let inflight = 0
	let idleResolve: (() => void) | undefined
	let reloadQueue = Promise.resolve()
	let cleanupPromise: Promise<void> | undefined
	const toolContextRegistration: Array<{ dispose: () => Promise<void> }> = []
	let mcpRegistration: { dispose: () => Promise<void> } | undefined

	const serializeReload = <T>(operation: () => Promise<T>): Promise<T> => {
		const run = reloadQueue.then(operation, operation)
		reloadQueue = run.then(() => undefined, () => undefined)
		return run
	}

	try {
		mcpRegistration = await ctx.mcp.transform((editor) => {
			for (const server of activeServers.values()) {
				const current = editor.get(server.name)
				if (current && !isDeepStrictEqual(current, server.config)) {
					throw new Error(`Skill MCP server "${server.name}" conflicts with an existing native MCP configuration; the existing server was left unchanged.`)
				}
				if (!current) editor.set(server.name, server.config)
			}
		})
		toolContextRegistration.push(await ctx.session.hook("context", (event) => {
			for (const name of Object.keys(event.tools)) {
				if (isNativeSkillToolId(name, activeServers.keys())) delete event.tools[name]
			}
		}))
		toolContextRegistration.push(await ctx.tool.hook("execute.before", (event) => {
			if (isNativeSkillToolId(event.tool, activeServers.keys())) {
				throw new ToolError({ message: "Skill MCP tools can only be called through skill_mcp." })
			}
		}))
	} catch (error) {
		await Promise.allSettled([
			...toolContextRegistration.map((registration) => registration.dispose()),
			...(mcpRegistration ? [mcpRegistration.dispose()] : []),
		])
		throw error
	}

	const ensureServer = async (skillServer: SkillServer, signal: AbortSignal): Promise<string> => {
		const key = logicalServerKey(skillServer)
		const loaded = loadedServerNames.get(key)
		if (loaded) return loaded
		const pending = pendingServerLoads.get(key)
		if (pending) return pending

		const promise = serializeReload(async () => {
			if (!active) throw new Error("skill_mcp is shutting down")
			const alreadyLoaded = loadedServerNames.get(key)
			if (alreadyLoaded) return alreadyLoaded
			if (signal.aborted) throw new Error("skill_mcp call was cancelled before the MCP server started")

			const nativeName = skillServer.name
			const nativeConfig = toNativeSkillServerConfig(skillServer.name, skillServer.config)
			const alreadyActive = activeServers.get(nativeName)
			if (alreadyActive) {
				if (!isDeepStrictEqual(alreadyActive.config, nativeConfig)) {
					throw new Error(`Skill MCP server name "${nativeName}" is used by multiple loaded skills with different configurations.`)
				}
				loadedServerNames.set(key, nativeName)
				return nativeName
			}
			if ((await currentServers(ctx)).some((server) => server.name === nativeName)) {
				throw new Error(`Skill MCP server "${nativeName}" already exists in native OpenCode configuration; refusing to replace or shadow it.`)
			}
			const registration = { name: nativeName, config: nativeConfig }
			activeServers.set(nativeName, registration)
			let reload: Promise<void> | undefined
			try {
				reload = ctx.mcp.reload()
				await withAbort(reload, signal, "skill_mcp call was cancelled while the MCP server was starting")
				await waitForNativeServer(ctx, nativeName, signal)
				loadedServerNames.set(key, nativeName)
				return nativeName
			} catch (error) {
				if (activeServers.get(nativeName) === registration) activeServers.delete(nativeName)
				if (signal.aborted && reload) {
					const cleanup = reload.catch(() => undefined).then(() => serializeReload(() => ctx.mcp.reload()))
					pendingCleanupTasks.add(cleanup)
					void cleanup.then(
						() => pendingCleanupTasks.delete(cleanup),
						(cleanupError) => {
							pendingCleanupTasks.delete(cleanup)
							backgroundCleanupErrors.push(cleanupError)
							log("[v2 skill_mcp] Failed to remove a cancelled native MCP server.", cleanupError)
						},
					)
					throw error
				}
				try {
					await ctx.mcp.reload()
				} catch (cleanupError) {
					throw new AggregateError([error, cleanupError], "Native MCP setup failed and its registration could not be removed")
				}
				throw error
			}
		})
		pendingServerLoads.set(key, promise)
		try {
			return await promise
		} finally {
			pendingServerLoads.delete(key)
		}
	}

	const waitForNativeServer = async (ctx: Plugin.Context, name: string, signal: AbortSignal): Promise<void> => {
		const deadline = Date.now() + NATIVE_TOOL_WAIT_MS
		let lastStatus = "not listed"
		do {
			if (signal.aborted) throw new Error("skill_mcp call was cancelled while the MCP server was starting")
			const server = (await currentServers(ctx)).find((entry) => entry.name === name)
			lastStatus = server?.status.status ?? "not listed"
			if (server?.status.status === "connected") return
			if (server?.status.status === "failed") {
				throw new Error(`Native MCP server "${name}" failed to connect: ${server.status.error ?? "unknown error"}`)
			}
			await delay(POLL_INTERVAL_MS)
		} while (Date.now() < deadline)
		throw new Error(`Native MCP server "${name}" did not connect within ${NATIVE_TOOL_WAIT_MS} ms (status: ${lastStatus}).`)
	}

	const getNativeTool = async (id: string, signal: AbortSignal) => {
		const deadline = Date.now() + NATIVE_TOOL_WAIT_MS
		do {
			if (signal.aborted) throw new Error("skill_mcp call was cancelled while waiting for the native MCP tool")
			await ctx.tool.reload()
			const native = (await ctx.tool.list()).find((tool) => tool.id === id)
			if (native) return native
			await delay(POLL_INTERVAL_MS)
		} while (Date.now() < deadline)
		throw new Error(`Native MCP tool "${id}" was not registered after the server connected.`)
	}

	const invoke = async (input: z.infer<typeof skillMcpInput>, context: ToolContext) => {
		if (!active) throw new Error("skill_mcp is shutting down")
		inflight += 1
		try {
			const operation = validateOperation(input)
			if (operation === "prompt") {
				throw new Error("MCP prompt execution is unavailable in OpenCode v2's public plugin API; use a native MCP tool or resource instead.")
			}
			if (input.cdp_url) {
				throw new Error("cdp_url per-call MCP instances are not available through OpenCode v2's public plugin API.")
			}
			const skillServer = findSkillServer(input.mcp_name, skills)
			if (!skillServer) {
				const builtin = BUILTIN_MCP_TOOL_HINTS[input.mcp_name]
				if (builtin) {
					throw new Error(`"${input.mcp_name}" is a builtin MCP, not a skill MCP. Use the native tools: ${builtin.join(", ")}.`)
				}
				throw new Error(`MCP server "${input.mcp_name}" was not found in loaded skills. Available skill MCPs:\n${formatAvailableMcps(skills)}`)
			}
			if (disabledMcps.has(input.mcp_name.trim().toLowerCase())) {
				throw new Error(`MCP server "${input.mcp_name}" is disabled by disabled_mcps.`)
			}
			const nativeServer = await ensureServer(skillServer, context.signal)
			const args = parseSkillMcpArguments(input.arguments)
			if (operation === "tool") {
				const requestedTool = input.tool_name!
				const native = await getNativeTool(matchingToolId(nativeServer, requestedTool), context.signal)
				if (isDisabled(config, String(native.id).toLowerCase())) {
					throw new Error(`MCP tool "${native.id}" is disabled by disabled_tools.`)
				}
				const result = await native.execute(args, context)
				return {
					content: filterText(stringifyNativeResult(result), input.grep),
					metadata: { mcp_name: input.mcp_name, skill: skillServer.skill.name, tool_name: requestedTool },
				}
			}

			if (isDisabled(config, "read_mcp_resource")) {
				throw new Error('MCP resource reads are disabled by disabled_tools: "read_mcp_resource".')
			}
			const resourceReader = await getNativeTool("opencode_read_mcp_resource", context.signal)
			const result = await resourceReader.execute({ server: nativeServer, uri: input.resource_name! }, context)
			const response = stringifyNativeResult(result)
			const files = Array.isArray(result.content) ? result.content.filter((part) => part.type === "file") : []
			return {
				content: [
					{ type: "text" as const, text: filterText(response, input.grep) },
					...files,
				],
				metadata: { mcp_name: input.mcp_name, skill: skillServer.skill.name, resource_name: input.resource_name },
			}
		} finally {
			inflight -= 1
			if (inflight === 0) {
				const resolve = idleResolve
				idleResolve = undefined
				resolve?.()
			}
		}
	}

	let disposed = false
	const runtime: V2SkillMcpRuntime = {
		addTool(editor) {
			addV2Tool(editor, {
				name: "skill_mcp",
				description: `${SKILL_MCP_DESCRIPTION} Tool and resource operations use native OpenCode MCP executors. MCP prompts and per-call cdp_url are unavailable through the v2 public plugin API.`,
				input: skillMcpInput,
				options: { codemode: false },
				execute: invoke,
			})
		},
		cleanup() {
			cleanupPromise ??= (async () => {
				if (disposed) return
				disposed = true
				active = false
				if (inflight > 0) await new Promise<void>((resolve) => { idleResolve = resolve })
				await Promise.allSettled([...pendingCleanupTasks])
				await reloadQueue
				const errors: unknown[] = [...backgroundCleanupErrors]
				for (const registration of [...toolContextRegistration].reverse()) {
					try { await registration.dispose() } catch (error) { errors.push(error) }
				}
				try { await mcpRegistration?.dispose() } catch (error) { errors.push(error) }
				if (errors.length > 0) throw new AggregateError(errors, "skill_mcp cleanup failed")
			})()
			return cleanupPromise
		},
	}
	return runtime
}

export function addV2SkillMcpTool(editor: ToolEditor, runtime: V2SkillMcpRuntime | undefined): void {
	runtime?.addTool(editor)
}
