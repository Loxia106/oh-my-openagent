import type { PluginModule } from "@opencode-ai/plugin"
import type { Plugin } from "@opencode/plugin"
import type { Plugin as NativePlugin } from "@opencode/plugin/effect/plugin"
import { createPluginModule } from "./testing/create-plugin-module"
import { opencode2EffectPlugin } from "./v2/effect-entry"
import { setupV2 } from "./v2/setup"

const legacyModule = createPluginModule()
const pluginModule: PluginModule & Plugin.Plugin & NativePlugin = {
  ...legacyModule,
  id: "oh-my-openagent",
  setup: setupV2,
  effect: opencode2EffectPlugin.effect,
}

export const omoPlugin = legacyModule.server

export default pluginModule

export type {
  AgentName,
  AgentOverrideConfig,
  AgentOverrides,
  BuiltinCommandName,
  HookName,
  McpName,
  OhMyOpenCodeConfig,
} from "./config"

export type { ConfigLoadError } from "./shared/config-errors"
