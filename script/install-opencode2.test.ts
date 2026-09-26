import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { parse } from "jsonc-parser"
import {
  parseInstallArgs,
  updateOpenCodeConfigFile,
  updateOpenCodeConfigText,
} from "./install-opencode2"

const temporaryDirectories: string[] = []

function tempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "opencode2-install-"))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe("OpenCode 2 explicit installer", () => {
  test("requires one explicit config directory or project target", () => {
    expect(() => parseInstallArgs([])).toThrow(/explicit target/)
    expect(() => parseInstallArgs(["--config-dir", "/tmp/a", "--project", "/tmp/b"])).toThrow(/only one target/)
    expect(parseInstallArgs(["--project=/tmp/project"])).toEqual({ kind: "project", directory: "/tmp/project" })
    expect(parseInstallArgs(["--", "--project", "/tmp/project=with=equals"])).toEqual({
      kind: "project",
      directory: "/tmp/project=with=equals",
    })
    expect(parseInstallArgs(["--help"])).toBe("help")
  })

  test("replaces only OMO plugin entries, preserves unrelated config/comments, and adds default_agent when absent", () => {
    const source = `{
  // Preserve user tools and unrelated plugin settings.
  "tools": { "custom": { "enabled": true } },
  "plugins": [
    "unrelated-plugin",
    "oh-my-openagent@latest",
    { "package": "oh-my-opencode@4", "options": { "keep": false } }
  ]
}\n`
    const targetDirectory = tempDirectory()
    const pluginDirectory = join(targetDirectory, "fork", "dist", "opencode2")
    const output = updateOpenCodeConfigText(source, "opencode.jsonc", pluginDirectory)
    const parsed = parse(output.text) as Record<string, unknown>

    expect(output.changed).toBe(true)
    expect(output.text).toContain("// Preserve user tools and unrelated plugin settings.")
    expect(parsed.tools).toEqual({ custom: { enabled: true } })
    expect(parsed.plugins).toEqual(["unrelated-plugin", pluginDirectory])
    expect(parsed.default_agent).toBe("sisyphus")

    const emptyOutput = updateOpenCodeConfigText("{}\n", "opencode.jsonc", pluginDirectory)
    expect((parse(emptyOutput.text) as { plugins: string[] }).plugins).toEqual([pluginDirectory])
  })

  test("preserves an explicitly configured default and does not duplicate its absolute plugin path", () => {
    const directory = tempDirectory()
    const source = JSON.stringify({
      default_agent: "my-agent",
      plugins: ["unrelated-plugin", join(directory, "plugin")],
    }, null, 2)
    const first = updateOpenCodeConfigText(source, "opencode.json", join(directory, "plugin"))
    const second = updateOpenCodeConfigText(first.text, "opencode.json", join(directory, "plugin"))
    expect((parse(first.text) as Record<string, unknown>).default_agent).toBe("my-agent")
    expect((parse(first.text) as { plugins: string[] }).plugins).toEqual(["unrelated-plugin", join(directory, "plugin")])
    expect(second.changed).toBe(false)
  })

  test("migrates OMO from both legacy plugin and native plugins while preserving unrelated entries and options", () => {
    const directory = tempDirectory()
    const filePath = join(directory, "opencode.jsonc")
    const pluginDirectory = join(directory, "fork=checkout", "dist", "opencode2")
    const source = `{
  "plugin": [
    ["oh-my-openagent@latest", { "telemetry": false }],
    "unrelated-legacy",
    "../oh-my-opencode/dist/index.js"
  ],
  "plugins": [
    { "package": "oh-my-opencode@beta", "options": { "preserve": true } },
    "unrelated-native"
  ]
}\n`
    const output = updateOpenCodeConfigText(source, filePath, pluginDirectory)
    const parsed = parse(output.text) as Record<string, unknown>

    expect(parsed.plugin).toEqual([
      [pluginDirectory, { telemetry: false }],
      "unrelated-legacy",
    ])
    expect(parsed.plugins).toEqual(["unrelated-native"])
  })

  test("backs up an existing target before atomically replacing it", () => {
    const directory = tempDirectory()
    const config = join(directory, "opencode.jsonc")
    const original = `{
  "plugins": ["oh-my-opencode"],
  "default_agent": "custom"
}\n`
    writeFileSync(config, original)
    const result = updateOpenCodeConfigFile(config, join(directory, "plugin"), new Date("2026-09-26T12:00:00.000Z"))

    expect(result.changed).toBe(true)
    expect(result.backupPath).toBe(`${config}.bak-2026-09-26T12-00-00-000Z`)
    expect(readFileSync(result.backupPath!, "utf8")).toBe(original)
    const updated = parse(readFileSync(config, "utf8")) as Record<string, unknown>
    expect(updated.default_agent).toBe("custom")
    expect(updated.plugins).toEqual([join(directory, "plugin")])
  })
})
