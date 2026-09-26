import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { basename, dirname, isAbsolute, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser"

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const pluginDirectory = join(repoRoot, "dist", "opencode2")
const formattingOptions = { insertSpaces: true, tabSize: 2, eol: "\n" } as const

export type InstallTarget =
  | { readonly kind: "config-dir"; readonly directory: string }
  | { readonly kind: "project"; readonly directory: string }

export function parseInstallArgs(args: readonly string[]): InstallTarget | "help" {
  let target: InstallTarget | undefined
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === "--") continue
    if (argument === "--help" || argument === "-h") return "help"
    const equals = argument.indexOf("=")
    const flag = equals < 0 ? argument : argument.slice(0, equals)
    const inlineValue = equals < 0 ? undefined : argument.slice(equals + 1)
    if (flag !== "--config-dir" && flag !== "--project") {
      throw new Error(`Unknown option: ${argument}`)
    }
    const value = inlineValue ?? args[++index]
    if (!value || value.startsWith("--")) throw new Error(`${flag} requires a directory path`)
    if (target) throw new Error("Choose only one target: --config-dir or --project")
    target = { kind: flag === "--config-dir" ? "config-dir" : "project", directory: resolve(value) }
  }
  if (!target) throw new Error("Choose an explicit target with --config-dir <dir> or --project <dir>")
  return target
}

function targetFile(target: InstallTarget): string {
  const candidates = ["opencode.jsonc", "opencode.json"]
  const existing = candidates.find((name) => existsSync(join(target.directory, name)))
  return join(target.directory, existing ?? "opencode.jsonc")
}

function packageTarget(value: unknown): string {
  if (typeof value === "string") return value.startsWith("-") ? value.slice(1) : value
  if (Array.isArray(value) && typeof value[0] === "string") return value[0]
  if (value && typeof value === "object" && !Array.isArray(value) && "package" in value) {
    return String((value as { package?: unknown }).package ?? "")
  }
  return ""
}

function isOmoTarget(value: unknown, configDirectory: string): boolean {
  const target = packageTarget(value)
  if (/^(?:oh-my-openagent|oh-my-opencode)(?:@.*)?$/i.test(target)) return true
  if (target.startsWith("file:")) {
    try {
      return isKnownOmoPath(fileURLToPath(target), configDirectory)
    } catch {
      return false
    }
  }
  if (isAbsolute(target) || target.startsWith(".")) return isKnownOmoPath(target, configDirectory)
  return false
}

function isKnownOmoPath(path: string, configDirectory: string): boolean {
  const absolute = isAbsolute(path) ? resolve(path) : resolve(configDirectory, path)
  if (absolute === resolve(repoRoot, "dist", "index.js") || absolute === resolve(repoRoot, "dist", "tui.js")) return true
  if (absolute === resolve(pluginDirectory) || /[\\/]dist[\\/]opencode2$/i.test(absolute)) {
    const pieces = absolute.split(/[\\/]+/).map((piece) => piece.toLowerCase())
    if (pieces.some((piece) => piece === "oh-my-openagent" || piece === "oh-my-opencode")) return true
    if (absolute === resolve(pluginDirectory)) return true
  }
  const pieces = absolute.split(/[\\/]+/).map((piece) => piece.toLowerCase())
  return pieces.some((piece) => piece === "oh-my-openagent" || piece === "oh-my-opencode") &&
    ["index.js", "server.js", "tui.js"].includes(basename(absolute).toLowerCase())
}

function sameLocalPluginPath(value: unknown, localPluginDirectory: string): boolean {
  const target = packageTarget(value)
  if (!isAbsolute(target)) return false
  return resolve(target) === resolve(localPluginDirectory)
}

function parseConfig(source: string, filePath: string): Record<string, unknown> {
  const errors: ParseError[] = []
  const value = parse(source, errors, { allowTrailingComma: true })
  if (errors.length > 0) throw new Error(`Invalid JSONC in ${filePath}; refusing to modify it.`)
  if (value === undefined) return {}
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`OpenCode config at ${filePath} must contain an object.`)
  }
  return value as Record<string, unknown>
}

export function updateOpenCodeConfigText(
  source: string,
  filePath: string,
  localPluginDirectory: string,
): { readonly text: string; readonly changed: boolean } {
  const config = parseConfig(source, filePath)
  const configDirectory = resolve(dirname(resolve(filePath)))
  const fields = ["plugin", "plugins"] as const
  for (const key of fields) {
    if (config[key] !== undefined && !Array.isArray(config[key])) {
      throw new Error(`OpenCode config "${key}" must be an array in ${filePath}.`)
    }
  }
  const arrays = fields.map((key) => ({ key, values: (config[key] ?? []) as unknown[] }))
  const candidates = arrays.flatMap(({ key, values }) => values.map((value, index) => ({ key, index, value })))
  const selected = candidates.find(({ value }) => sameLocalPluginPath(value, localPluginDirectory)) ??
    candidates.find(({ value }) => isOmoTarget(value, configDirectory))
  let text = source

  if (selected) {
    const { key, index, value } = selected
    if (!sameLocalPluginPath(value, localPluginDirectory)) {
      if (Array.isArray(value) && typeof value[0] === "string") {
        text = applyEdits(text, modify(text, [key, index, 0], localPluginDirectory, { formattingOptions }))
      } else if (value && typeof value === "object" && !Array.isArray(value) && "package" in value) {
        text = applyEdits(text, modify(text, [key, index, "package"], localPluginDirectory, { formattingOptions }))
      } else {
        text = applyEdits(text, modify(text, [key, index], localPluginDirectory, { formattingOptions }))
      }
    }
    for (const { key: arrayKey, values } of arrays) {
      for (let index = values.length - 1; index >= 0; index -= 1) {
        const isSelected = arrayKey === key && index === selected.index
        if (!isSelected && (isOmoTarget(values[index], configDirectory) || sameLocalPluginPath(values[index], localPluginDirectory))) {
          text = applyEdits(text, modify(text, [arrayKey, index], undefined, { formattingOptions }))
        }
      }
    }
  } else {
    text = applyEdits(text, modify(text, ["plugins", -1], localPluginDirectory, { formattingOptions }))
  }

  if (!Object.hasOwn(config, "default_agent")) {
    text = applyEdits(text, modify(text, ["default_agent"], "sisyphus", { formattingOptions }))
  }
  return { text, changed: text !== source }
}

export function updateOpenCodeConfigFile(
  filePath: string,
  localPluginDirectory: string,
  now = new Date(),
): { readonly changed: boolean; readonly backupPath?: string } {
  const directory = dirname(filePath)
  mkdirSync(directory, { recursive: true })
  const existed = existsSync(filePath)
  if (existed && !statSync(filePath).isFile()) throw new Error(`Config path is not a regular file: ${filePath}`)
  const source = existed ? readFileSync(filePath, "utf8") : "{}\n"
  const output = updateOpenCodeConfigText(source, filePath, localPluginDirectory)
  if (!output.changed) return { changed: false }

  let backupPath: string | undefined
  if (existed) {
    const stamp = now.toISOString().replace(/[:.]/g, "-")
    backupPath = `${filePath}.bak-${stamp}`
    let suffix = 1
    while (existsSync(backupPath)) backupPath = `${filePath}.bak-${stamp}-${suffix++}`
    copyFileSync(filePath, backupPath)
  }

  const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}`
  try {
    writeFileSync(temporaryPath, output.text, { encoding: "utf8", mode: existed ? statSync(filePath).mode & 0o777 : 0o600 })
    renameSync(temporaryPath, filePath)
  } catch (error) {
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath)
    throw error
  }
  return { changed: true, ...(backupPath ? { backupPath } : {}) }
}

export function installOpencode2(target: InstallTarget, localPluginDirectory = pluginDirectory): {
  readonly filePath: string
  readonly changed: boolean
  readonly backupPath?: string
} {
  if (!existsSync(join(localPluginDirectory, "server.js")) || !existsSync(join(localPluginDirectory, "tui.js"))) {
    throw new Error("OpenCode 2 distribution is missing. Run `bun run build:opencode2` first.")
  }
  const filePath = targetFile(target)
  const result = updateOpenCodeConfigFile(filePath, resolve(localPluginDirectory))
  return { filePath, ...result }
}

function usage(): string {
  return [
    "Install the local OpenCode 2 plugin directory into an explicit config target.",
    "",
    "Usage:",
    "  bun run install:opencode2 -- --config-dir <opencode-config-directory>",
    "  bun run install:opencode2 -- --project <project-directory>",
  ].join("\n")
}

if (import.meta.main) {
  try {
    const target = parseInstallArgs(process.argv.slice(2))
    if (target === "help") {
      console.log(usage())
    } else {
      const result = installOpencode2(target)
      console.log(`${result.changed ? "Updated" : "Already configured"} ${result.filePath}`)
      console.log(`Plugin directory: ${resolve(pluginDirectory)}`)
      if (result.backupPath) console.log(`Backup: ${result.backupPath}`)
      if (!Object.hasOwn(parseConfig(readFileSync(result.filePath, "utf8"), result.filePath), "default_agent")) {
        throw new Error("Installer failed to set default_agent.")
      }
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    console.error(usage())
    process.exitCode = 1
  }
}
