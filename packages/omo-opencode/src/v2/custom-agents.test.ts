import { afterEach, describe, expect, test } from "bun:test"
import type { AgentEditor } from "@opencode/plugin/promise/agent"
import type { Plugin } from "@opencode/plugin"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type { OhMyOpenCodeConfig } from "../config"
import { loadV2Config } from "./config"
import { loadV2CustomAgentConfigs } from "./custom-agents"
import { registerV2Agents } from "./agents"
import { V2ModelCatalog } from "./model-resolution"

const roots: string[] = []
const envKeys = ["HOME", "OCX_PROFILE", "OMO_PROFILE", "OPENCODE_CONFIG_DIR"] as const
const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]])) as Record<typeof envKeys[number], string | undefined>

function fixture(name: string): { root: string; project: string } {
  const root = mkdtempSync(join(tmpdir(), `omo-v2-custom-agents-${name}-`))
  const project = join(root, "project")
  mkdirSync(project, { recursive: true })
  roots.push(root)
  process.env.HOME = root
  for (const key of envKeys.slice(1)) delete process.env[key]
  return { root, project }
}

function write(path: string, content: string): void {
  mkdirSync(join(path, ".."), { recursive: true })
  writeFileSync(path, content)
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  for (const key of envKeys) {
    const value = originalEnv[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

describe("native v2 custom agents", () => {
  test("loads user and project agents, then definition files and unified OMO overrides by precedence", () => {
    const { root, project } = fixture("source-precedence")
    write(join(root, ".claude", "agents", "shared.md"), "---\nname: shared\ndescription: user\n---\nuser prompt")
    write(join(project, ".claude", "agents", "project-only.md"), "---\nname: project-only\ndescription: project\n---\nproject prompt")
    write(join(project, "agent-definitions", "shared.md"), "---\nname: shared\ndescription: definition\n---\ndefinition prompt")
    write(join(project, "agent-definitions", "defined-only.md"), "---\nname: defined-only\n---\ndefinition-only prompt")

    const agents = loadV2CustomAgentConfigs({
      agent_definitions: ["agent-definitions/shared.md", "agent-definitions/defined-only.md"],
      agents: {
        shared: { prompt: "unified OMO prompt", model: "openai/gpt-5.6-sol", mode: "primary" },
        config_only: { prompt: "defined in OMO config", description: "Config-only custom agent", mode: "subagent" },
        oracle: { prompt: "must not replace a built-in" },
      },
    } as unknown as OhMyOpenCodeConfig, project)

    expect(agents.shared).toMatchObject({
      prompt: "unified OMO prompt",
      description: "(definition-file) definition",
      model: "openai/gpt-5.6-sol",
      mode: "primary",
    })
    expect(agents["project-only"]?.prompt).toBe("project prompt")
    expect(agents["defined-only"]?.prompt).toBe("definition-only prompt")
    expect(agents.config_only).toMatchObject({ prompt: "defined in OMO config", mode: "subagent" })
    expect(agents.oracle).toBeUndefined()
  })

  test("honors claude_code.agents=false and disabled_agents while retaining explicit definitions", () => {
    const { root, project } = fixture("source-gates")
    write(join(root, ".claude", "agents", "user-only.md"), "---\nname: user-only\n---\nuser prompt")
    write(join(project, ".claude", "agents", "project-only.md"), "---\nname: project-only\n---\nproject prompt")
    write(join(project, "definition.md"), "---\nname: definition-only\n---\ndefinition prompt")
    write(join(project, "disabled.md"), "---\nname: disabled-agent\n---\ndisabled prompt")

    const agents = loadV2CustomAgentConfigs({
      claude_code: { agents: false },
      agent_definitions: ["definition.md", "disabled.md"],
      disabled_agents: ["DISABLED-AGENT"],
    } as unknown as OhMyOpenCodeConfig, project)

    expect(agents["user-only"]).toBeUndefined()
    expect(agents["project-only"]).toBeUndefined()
    expect(agents["definition-only"]?.prompt).toBe("definition prompt")
    expect(agents["disabled-agent"]).toBeUndefined()
  })

  test("loads a unified config through validation and registers the resulting custom agent", async () => {
    const { root, project } = fixture("validated-registry")
    write(join(project, ".omo", "omo.jsonc"), JSON.stringify({
      "[opencode]": {
        default_run_agent: "integration-custom",
        agent_definitions: ["agent-definitions/from-file.md"],
        agents: {
          "integration-custom": {
            prompt: "validated unified override",
            description: "Unified config agent",
            model: "openai/gpt-5.6-sol",
            mode: "primary",
            permission: { write: "deny" },
            maxTokens: 321,
          },
        },
      },
    }, null, 2))
    write(join(project, "agent-definitions", "from-file.md"), "---\nname: from-file\ndescription: From validated file\n---\nfile prompt")

    const config = loadV2Config(project)
    expect(config.default_run_agent).toBe("integration-custom")
    expect(config.agents?.["integration-custom"]?.prompt).toBe("validated unified override")
    expect(config.agent_definitions).toEqual(["agent-definitions/from-file.md"])

    let applyTransform: ((editor: AgentEditor) => void) | undefined
    const defaults: Array<string | undefined> = []
    const agents = new Map<string, any>()
    const editor = {
      list: () => Array.from(agents.values()),
      get: (id: string) => agents.get(id),
      default: (id: string | undefined) => defaults.push(id),
      remove: (id: string) => { agents.delete(id) },
      update: (id: string, update: (agent: any) => void) => {
        const current = agents.get(id) ?? {
          id,
          name: id,
          request: { settings: {}, headers: {}, body: {} },
          permissions: [],
          mode: "primary",
          hidden: false,
        }
        update(current)
        agents.set(id, current)
      },
    } as unknown as AgentEditor
    const ctx = {
      location: { directory: project },
      agent: {
        transform: async (callback: (editor: AgentEditor) => void) => {
          applyTransform = callback
          return { dispose: async () => undefined }
        },
      },
    } as unknown as Plugin.Context

    await registerV2Agents(ctx, config, [], new V2ModelCatalog())
    applyTransform!(editor)

    expect(agents.get("integration-custom")).toMatchObject({
      id: "integration-custom",
      system: "validated unified override",
      description: "Unified config agent",
      model: { providerID: "openai", id: "gpt-5.6-sol" },
      mode: "primary",
      request: { settings: { maxTokens: 321 } },
      permissions: [{ action: "edit", resource: "*", effect: "deny" }],
    })
    expect(agents.get("from-file")).toMatchObject({
      system: "file prompt",
      description: "(definition-file) From validated file",
      mode: "subagent",
    })
    expect(defaults).toEqual(["integration-custom"])
  })
})
