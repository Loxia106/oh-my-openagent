import type { Plugin } from "@opencode/plugin"
import type { ModelEditor } from "@opencode/plugin/promise/model"
import type { ProviderEditor } from "@opencode/plugin/promise/provider"
import type { OhMyOpenCodeConfig } from "../config"
import { log } from "../shared/logger"
import { registerV2Agents } from "./agents"
import { registerV2Mcp } from "./mcp"
import { V2ModelCatalog } from "./model-resolution"
import { loadV2SkillCatalog, registerV2Skills } from "./skills"

/** Register config-derived agent, model, skill, and MCP transforms for OpenCode 2. */
export async function registerV2Registries(
  ctx: Plugin.Context,
  config: OhMyOpenCodeConfig,
): Promise<() => Promise<void>> {
  const directory = String(ctx.location.directory)
  const catalog = new V2ModelCatalog()
  const cleanups: Array<() => Promise<void>> = []
  const controller = new AbortController()
  let active = true
  let reloadQueued = false
  let reloadRequestedWhileRunning = false
  let reloadInFlight: Promise<void> | undefined
  let cleanupPromise: Promise<void> | undefined

  const scheduleAgentReload = () => {
    if (!active) return
    if (reloadInFlight) {
      reloadRequestedWhileRunning = true
      return
    }
    if (reloadQueued) return
    reloadQueued = true
    queueMicrotask(() => {
      reloadQueued = false
      if (!active) return
      reloadInFlight = ctx.agent.reload()
        .catch((error) => log("[v2 registry] Agent reload after model/provider update failed.", error))
        .finally(() => {
          reloadInFlight = undefined
          if (reloadRequestedWhileRunning) {
            reloadRequestedWhileRunning = false
            scheduleAgentReload()
          }
        })
    })
  }

  const unwind = () => {
    cleanupPromise ??= (async () => {
      active = false
      controller.abort()
      await reloadInFlight?.catch(() => undefined)
      const errors: unknown[] = []
      for (const cleanup of cleanups.reverse()) {
        try {
          await cleanup()
        } catch (error) {
          errors.push(error)
        }
      }
      if (errors.length > 0) {
        log(`[v2 registry] ${errors.length} registration cleanup(s) failed.`, new AggregateError(errors))
      }
    })()
    return cleanupPromise
  }

  let catalogRefreshInFlight: Promise<void> | undefined
  let catalogRefreshRequested = false
  const refreshHostCatalog = () => {
    if (!active) return
    if (catalogRefreshInFlight) {
      catalogRefreshRequested = true
      return
    }
    catalogRefreshInFlight = Promise.all([
      ctx.model.list(),
      ctx.model.default(),
      ctx.provider.list(),
    ]).then(([models, defaultModel, providers]) => {
      if (!active) return
      if (catalog.captureHostCatalog({
        models: models.data,
        defaultModel: defaultModel.data,
        providers: providers.data,
      })) scheduleAgentReload()
    }).catch((error) => {
      if (active) log("[v2 registry] Refreshing the composed model/provider catalog failed.", error)
    }).finally(() => {
      catalogRefreshInFlight = undefined
      if (catalogRefreshRequested && active) {
        catalogRefreshRequested = false
        refreshHostCatalog()
      }
    })
  }

  try {
    const providers = await ctx.provider.transform((editor: ProviderEditor) => {
      catalog.captureProviders(editor)
    })
    cleanups.push(() => providers.dispose())

    const models = await ctx.model.transform((editor: ModelEditor) => {
      catalog.captureModels(editor)
    })
    cleanups.push(() => models.dispose())

    const skillCatalog = await loadV2SkillCatalog(config, directory)
    cleanups.push(await registerV2Skills(ctx, skillCatalog, config))
    cleanups.push(await registerV2Mcp(ctx, config, directory))
    cleanups.push(await registerV2Agents(ctx, config, skillCatalog.loaded, catalog))

    const events = ctx.event.subscribe({ signal: controller.signal })
    const eventTask = (async () => {
      try {
        for await (const event of events) {
          if (!active) break
          if (event.type !== "model.updated" && event.type !== "provider.updated") continue
          const eventDirectory = event.location?.directory
          if (eventDirectory && String(eventDirectory) !== directory) continue
          // Native config transforms run after user plugins. Query the composed
          // public catalog after the event, outside setup and transform callbacks.
          refreshHostCatalog()
        }
      } catch (error) {
        if (active && !controller.signal.aborted) {
          log("[v2 registry] Model/provider event subscription stopped unexpectedly.", error)
        }
      }
    })()
    cleanups.push(async () => {
      controller.abort()
      await eventTask
      await catalogRefreshInFlight
    })

    // The host's internal config/provider transforms are registered after this
    // setup callback. Start the first public catalog read on a detached macrotask
    // so agent selection sees the fully composed host state.
    const initialRefresh = setTimeout(refreshHostCatalog, 0)
    cleanups.push(async () => { clearTimeout(initialRefresh) })

    return unwind
  } catch (error) {
    await unwind()
    throw error
  }
}
