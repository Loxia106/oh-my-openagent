import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type { MCPEditor } from "@opencode/plugin/promise/mcp"
import type { OhMyOpenCodeConfig } from "../config"
import {
  resetAdditionalAllowedMcpEnvVars,
  setAdditionalAllowedMcpEnvVars,
} from "../features/claude-code-mcp-loader"
import { applyV2McpConfigs, loadV2McpConfigs, toV2McpConfig } from "./mcp"

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

  test("expands only the validated per-config allowlist for native Claude MCPs", async () => {
    const directory = mkdtempSync(join(tmpdir(), "omo-v2-mcp-allowlist-"))
    const project = join(directory, "project")
    const home = join(directory, "home")
    const claudeConfigDir = join(home, ".claude")
    const variableNames = [
      "OMO_V2_ALLOWED_API_TOKEN",
      "OMO_V2_UNLISTED_API_TOKEN",
      "OMO_V2_LEGACY_ONLY_API_TOKEN",
      "HOME",
      "PATH",
    ] as const
    const originalValues = new Map(variableNames.map((name) => [name, process.env[name]]))

    try {
      mkdirSync(project, { recursive: true })
      mkdirSync(claudeConfigDir, { recursive: true })
      process.env.OMO_V2_ALLOWED_API_TOKEN = "user-approved-secret"
      process.env.OMO_V2_UNLISTED_API_TOKEN = "must-not-expand"
      process.env.OMO_V2_LEGACY_ONLY_API_TOKEN = "must-not-leak-from-legacy"
      process.env.HOME = "/tmp/omo-v2-home"
      process.env.PATH = "/tmp/omo-v2-path"
      // Legacy config loading still has a process-wide addition for v1 callers.
      // The native v2 load must use the explicit validated config instead.
      setAdditionalAllowedMcpEnvVars(["OMO_V2_LEGACY_ONLY_API_TOKEN"])
      writeFileSync(join(project, ".mcp.json"), JSON.stringify({
        mcpServers: {
          "v2-allowlist-local": {
            command: "node",
            args: ["${OMO_V2_ALLOWED_API_TOKEN}|${OMO_V2_UNLISTED_API_TOKEN}|${OMO_V2_LEGACY_ONLY_API_TOKEN}"],
            env: { API_TOKEN: "${OMO_V2_ALLOWED_API_TOKEN}" },
          },
          "v2-allowlist-remote": {
            type: "http",
            url: "https://mcp.example.test/${OMO_V2_ALLOWED_API_TOKEN}/${OMO_V2_UNLISTED_API_TOKEN}",
            headers: { Authorization: "Bearer ${OMO_V2_ALLOWED_API_TOKEN}|${OMO_V2_UNLISTED_API_TOKEN}" },
          },
          "v2-allowlist-builtins": {
            command: "node",
            args: ["${HOME}|${PATH}"],
          },
        },
      }))

      const configs = await loadV2McpConfigs({
        mcp_env_allowlist: ["OMO_V2_ALLOWED_API_TOKEN"],
      } as OhMyOpenCodeConfig, project, { homeDir: home, claudeConfigDir })

      expect(configs["v2-allowlist-local"]).toEqual({
        type: "local",
        command: ["node", "user-approved-secret||"],
        environment: { API_TOKEN: "user-approved-secret" },
      })
      expect(configs["v2-allowlist-remote"]).toEqual({
        type: "remote",
        url: "https://mcp.example.test/user-approved-secret/",
        headers: { Authorization: "Bearer user-approved-secret|" },
      })

      const emptyAllowlistConfigs = await loadV2McpConfigs({
        mcp_env_allowlist: [],
      } as OhMyOpenCodeConfig, project, { homeDir: home, claudeConfigDir })
      expect(emptyAllowlistConfigs["v2-allowlist-local"]).toEqual({
        type: "local",
        command: ["node", "||"],
        environment: { API_TOKEN: "" },
      })
      expect(emptyAllowlistConfigs["v2-allowlist-builtins"]).toEqual({
        type: "local",
        command: ["node", "/tmp/omo-v2-home|/tmp/omo-v2-path"],
      })
    } finally {
      resetAdditionalAllowedMcpEnvVars()
      for (const [name, value] of originalValues) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
