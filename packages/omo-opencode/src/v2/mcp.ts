import type { Plugin } from "@opencode/plugin"
import type { MCPEditor } from "@opencode/plugin/promise/mcp"
import type * as Mcp from "@opencode/schema/mcp"
import { loadMcpConfigs } from "../features/claude-code-mcp-loader"
import type { McpServerConfig } from "@oh-my-opencode/claude-code-compat-core/claude-code-mcp-loader/types"
import { createBuiltinMcps } from "../mcp"
import type { OhMyOpenCodeConfig } from "../config"

type NativeMcpConfig = Mcp.ServerConfig
type BuiltinMcpSource = {
  type: "local" | "remote"
  command?: string[]
  cwd?: string
  environment?: Record<string, string>
  url?: string
  headers?: Record<string, string>
  oauth?: false | { clientId?: string; scopes?: string[] }
  enabled?: boolean
}

export function toV2McpConfig(source: McpServerConfig | BuiltinMcpSource): NativeMcpConfig {
  if (source.type === "local") {
    if (!source.command?.length) throw new Error("OpenCode v2 local MCP config requires a command")
    const cwd = "cwd" in source && typeof source.cwd === "string" ? source.cwd : undefined
    return {
      type: "local",
      command: source.command,
      ...(cwd ? { cwd } : {}),
      ...(source.environment ? { environment: source.environment } : {}),
      ...(source.enabled === false ? { disabled: true } : {}),
    }
  }
  if (!source.url) throw new Error("OpenCode v2 remote MCP config requires a URL")
  const oauth = source.oauth === false
    ? false
    : source.oauth
      ? {
        ...(source.oauth.clientId ? { client_id: source.oauth.clientId } : {}),
        ...(source.oauth.scopes?.length ? { scope: source.oauth.scopes.join(" ") } : {}),
      }
      : undefined
  return {
    type: "remote",
    url: source.url,
    ...(source.headers ? { headers: source.headers } : {}),
    ...(oauth !== undefined ? { oauth } : {}),
    ...(source.enabled === false ? { disabled: true } : {}),
  }
}

export async function loadV2McpConfigs(
  config: OhMyOpenCodeConfig,
  directory: string,
): Promise<Record<string, NativeMcpConfig>> {
  const disabledNames = config.disabled_mcps ?? []
  const builtin = createBuiltinMcps(disabledNames, config, { cwd: directory })
  const claude = config.claude_code?.mcp === false
    ? { servers: {} }
    : await loadMcpConfigs(disabledNames, { cwd: directory })
  const result: Record<string, NativeMcpConfig> = {}

  for (const [name, server] of Object.entries(builtin)) {
    result[name] = toV2McpConfig(server as BuiltinMcpSource)
  }
  for (const [name, server] of Object.entries(claude.servers)) {
    result[name] = toV2McpConfig(server)
  }
  return result
}

export async function registerV2Mcp(
  ctx: Plugin.Context,
  config: OhMyOpenCodeConfig,
  directory: string,
): Promise<() => Promise<void>> {
  const configs = await loadV2McpConfigs(config, directory)
  const disabledNames = config.disabled_mcps ?? []
  const registration = await ctx.mcp.transform((editor) => {
    applyV2McpConfigs(editor, configs, disabledNames)
  })
  return async () => registration.dispose()
}

/** Apply OMO MCP defaults without overwriting native OpenCode user settings. */
export function applyV2McpConfigs(
  editor: MCPEditor,
  configs: Record<string, NativeMcpConfig>,
  disabledNames: readonly string[],
): void {
  const disabled = new Set(disabledNames)
  for (const name of disabled) editor.remove(name)
  for (const [name, server] of Object.entries(configs)) {
    if (disabled.has(name)) continue
    // Native OpenCode config is the user's source of truth, including an
    // existing disabled/auth-configured entry. OMO contributes defaults only
    // where the host has no entry.
    if (!editor.get(name)) editor.set(name, server)
  }
}
