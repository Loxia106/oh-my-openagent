import type { OhMyOpenCodeConfig } from "../config"
import { validatePluginConfig } from "../config/validate"
import { initConfigContext } from "../cli/config-manager/config-context"
import { runOpenCodeStartupMigration } from "../startup-migration"
import { log } from "../shared/logger"

const migratedDirectories = new Set<string>()

/** Load the same merged, migrated, and validated OMO config used by the v1 adapter. */
export function loadV2Config(directory: string): OhMyOpenCodeConfig {
  if (!migratedDirectories.has(directory)) {
    initConfigContext("opencode", null)
    const migration = runOpenCodeStartupMigration({ cwd: directory })
    if (migration.error) {
      throw new Error(`[v2 config] Legacy configuration migration failed: ${migration.error}`)
    }
    migratedDirectories.add(directory)
    if (migration.migratedFrom.length > 0) {
      log(`[v2 config] Migrated ${migration.migratedFrom.length} legacy configuration source(s).`)
    }
  }
  const result = validatePluginConfig(directory)
  for (const message of result.messages) {
    log(`[v2 config] ${message}`)
  }
  return result.config
}
