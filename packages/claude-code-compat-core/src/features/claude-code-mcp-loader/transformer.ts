import type {
  ClaudeCodeMcpServer,
  McpLocalConfig,
  McpRemoteConfig,
  McpServerConfig,
} from "./types"
import { expandEnvVarsInObject } from "./env-expander"

export interface McpTransformOptions {
  additionalAllowedMcpEnvVars?: readonly string[]
}

export function transformMcpServer(
  name: string,
  server: ClaudeCodeMcpServer,
  options: McpTransformOptions = {}
): McpServerConfig {
  const expanded = expandEnvVarsInObject(server, options)
  const serverType = expanded.type ?? "stdio"

  if (serverType === "http" || serverType === "sse") {
    if (!expanded.url) {
      throw new Error(
        `MCP server "${name}" requires url for type "${serverType}"`
      )
    }

    const config: McpRemoteConfig = {
      type: "remote",
      url: expanded.url,
      enabled: true,
    }

    if (expanded.headers && Object.keys(expanded.headers).length > 0) {
      config.headers = expanded.headers
    }

    if (expanded.oauth && Object.keys(expanded.oauth).length > 0) {
      config.oauth = expanded.oauth
    }

    return config
  }

  if (!expanded.command) {
    throw new Error(`MCP server "${name}" requires command for stdio type`)
  }

  const commandArray = [expanded.command, ...(expanded.args ?? [])]

  const config: McpLocalConfig = {
    type: "local",
    command: commandArray,
    enabled: true,
  }

  if (expanded.env && Object.keys(expanded.env).length > 0) {
    config.environment = expanded.env
  }

  return config
}
