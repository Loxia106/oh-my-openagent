import { describe, expect, test } from "bun:test"
import type { MCPEditor } from "@opencode/plugin/promise/mcp"
import { applyV2McpConfigs, toV2McpConfig } from "./mcp"

describe("native v2 MCP integration", () => {
  test("maps OMO local and remote MCP settings to the v2 contract", () => {
    expect(toV2McpConfig({
      type: "local",
      command: ["node", "server.js"],
      cwd: "/repo",
      environment: { TOKEN: "test" },
      enabled: false,
    })).toEqual({
      type: "local",
      command: ["node", "server.js"],
      cwd: "/repo",
      environment: { TOKEN: "test" },
      disabled: true,
    })
    expect(toV2McpConfig({
      type: "remote",
      url: "https://mcp.example.test",
      oauth: { clientId: "client", scopes: ["read", "search"] },
    })).toEqual({
      type: "remote",
      url: "https://mcp.example.test",
      oauth: { client_id: "client", scope: "read search" },
    })
  })

  test("preserves native disabled/auth-configured entries and removes explicit OMO disabled names", () => {
    const existing = {
      type: "remote",
      url: "https://native.example.test",
      disabled: true,
      oauth: { client_id: "native-client", scope: "read" },
    } as const
    const explicitlyDisabled = { type: "local", command: ["native-server"], cwd: "/native" } as const
    const servers = new Map<string, unknown>([["context7", existing], ["claude-code", explicitlyDisabled]])
    const editor = {
      get: (name: string) => servers.get(name),
      set: (name: string, config: unknown) => servers.set(name, config),
      remove: (name: string) => servers.delete(name),
    } as unknown as MCPEditor

    applyV2McpConfigs(editor, {
      context7: { type: "remote", url: "https://omo.example.test" },
      grep_app: { type: "remote", url: "https://grep.example.test" },
    }, ["grep_app", "claude-code"])

    expect(servers.get("context7")).toBe(existing)
    expect(servers.has("grep_app")).toBe(false)
    expect(servers.has("claude-code")).toBe(false)
  })
})
