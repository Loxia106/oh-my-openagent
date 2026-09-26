import { describe, expect, test } from "bun:test"
import type { AgentConfig } from "@opencode-ai/sdk"
import type { AgentEditor } from "@opencode/plugin/promise/agent"
import type { Plugin } from "@opencode/plugin"
import type { OhMyOpenCodeConfig } from "../config"
import { createSisyphusAgent } from "../agents/sisyphus-agent-factory"
import { createSisyphusJuniorAgentWithOverrides } from "../agents/sisyphus-junior"
import { buildV2AgentConfigs, registerV2Agents, toV2PermissionRules } from "./agents"
import { V2ModelCatalog } from "./model-resolution"

describe("native v2 agents", () => {
  test("registers the complete built-in set, including Prometheus, without choosing unavailable models", () => {
    const configs = buildV2AgentConfigs({
      config: {} as OhMyOpenCodeConfig,
      catalog: new V2ModelCatalog().snapshot,
      loadedSkills: [],
      directory: process.cwd(),
    })

    expect(Object.keys(configs)).toHaveLength(11)
    expect(configs.prometheus).toBeDefined()
    for (const config of Object.values(configs)) expect(config.model).toBeUndefined()
  })

  test("adapts only the native multimodal looker from attached files to caller-authorized native reads", () => {
    const configs = buildV2AgentConfigs({
      config: {} as OhMyOpenCodeConfig,
      catalog: new V2ModelCatalog().snapshot,
      loadedSkills: [],
      directory: process.cwd(),
    })
    const looker = configs["multimodal-looker"]
    expect(looker.prompt).toContain("file bytes are not attached to this conversation")
    expect(looker.prompt).toContain("Use the native read tool only for the exact caller-provided paths")
    expect(looker.prompt).not.toContain("Never call tools")
    expect(toV2PermissionRules(looker)).toContainEqual({
      action: "read",
      resource: "*",
      effect: "allow",
    })
  })

  test("translates action aliases in authored order and restricts irreducible alias conflicts", () => {
    const config = {
      permission: {
        bash: { "*": "allow", "rg *": "deny" },
        write: "deny",
        edit: "allow",
      },
      tools: { apply_patch: true },
    } as AgentConfig

    const conflicts: string[] = []
    expect(toV2PermissionRules(config, "metis", (conflict) => conflicts.push(conflict.selected))).toEqual([
      { action: "shell", resource: "*", effect: "allow" },
      { action: "shell", resource: "rg *", effect: "deny" },
      { action: "edit", resource: "*", effect: "deny" },
    ])
    expect(conflicts).toEqual(["deny", "deny"])
  })

  test("keeps task and call_omo_agent policies separate for Sisyphus and Sisyphus-Junior", () => {
    const sisyphus = toV2PermissionRules(createSisyphusAgent("openai/gpt-5.5"), "sisyphus")
    expect(sisyphus).toContainEqual({ action: "call_omo_agent", resource: "*", effect: "deny" })
    expect(sisyphus.some((rule) => rule.action === "subagent" && rule.effect === "deny")).toBe(false)

    const junior = toV2PermissionRules(
      createSisyphusJuniorAgentWithOverrides(undefined, "openai/gpt-5.5", false),
      "sisyphus-junior",
    )
    expect(junior).toContainEqual({ action: "task", resource: "*", effect: "deny" })
    expect(junior).toContainEqual({ action: "call_omo_agent", resource: "*", effect: "allow" })
    expect(junior.some((rule) => rule.action === "subagent")).toBe(false)

    expect(toV2PermissionRules({ permission: { task: "allow", delegate_task: "deny", call_omo_agent: "allow" } } as AgentConfig))
      .toEqual([
        { action: "task", resource: "*", effect: "deny" },
        { action: "call_omo_agent", resource: "*", effect: "allow" },
      ])
  })

  test("does not add broad restrictions based on agent name", () => {
    expect(toV2PermissionRules({} as AgentConfig, "oracle")).toEqual([])
    expect(toV2PermissionRules({ permission: { bash: "allow" } } as AgentConfig, "librarian")).toEqual([
      { action: "shell", resource: "*", effect: "allow" },
    ])
  })

  test("preserves the host default unless an enabled OMO primary agent is explicitly selected", async () => {
    const defaultCalls: Array<string | undefined> = []
    let transform: ((editor: AgentEditor) => void) | undefined
    const ctx = {
      location: { directory: "/tmp/omo-v2-agent-test" },
      agent: {
        transform: async (callback: (editor: AgentEditor) => void) => {
          transform = callback
          return { dispose: async () => undefined }
        },
      },
    } as unknown as Plugin.Context
    const catalog = new V2ModelCatalog()
    const makeEditor = (): AgentEditor => {
      const agents = new Map<string, any>()
      return {
        list: () => Array.from(agents.values()),
        get: (id: string) => agents.get(id),
        default: (id: string | undefined) => defaultCalls.push(id),
        remove: (id: string) => { agents.delete(id) },
        update: (id: string, update: (agent: any) => void) => {
          const agent = agents.get(id) ?? {
            id,
            name: id,
            request: { settings: {}, headers: {}, body: {} },
            permissions: [],
            mode: "primary",
            hidden: false,
          }
          update(agent)
          agents.set(id, agent)
        },
      } as unknown as AgentEditor
    }

    await registerV2Agents(ctx, {} as OhMyOpenCodeConfig, [], catalog)
    transform!(makeEditor())
    expect(defaultCalls).toEqual([])

    const explicitlyConfigured = { default_run_agent: "atlas" } as OhMyOpenCodeConfig
    await registerV2Agents(ctx, explicitlyConfigured, [], catalog)
    transform!(makeEditor())
    expect(defaultCalls).toEqual(["atlas"])

    const invalidDefault = { default_run_agent: "oracle" } as OhMyOpenCodeConfig
    await registerV2Agents(ctx, invalidDefault, [], catalog)
    transform!(makeEditor())
    expect(defaultCalls).toEqual(["atlas"])
  })
})
