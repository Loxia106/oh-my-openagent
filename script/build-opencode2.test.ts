import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { stageOpencode2Assets } from "./build-opencode2"

const temporaryDirectories: string[] = []

function makeFixture(): { output: string; skills: string; tools: string; daemon: string } {
  const root = mkdtempSync(join(tmpdir(), "opencode2-stage-"))
  temporaryDirectories.push(root)
  const paths = {
    output: join(root, "out"),
    skills: join(root, "shared-skills"),
    tools: join(root, "lsp-tools-mcp"),
    daemon: join(root, "lsp-daemon"),
  }
  mkdirSync(join(paths.skills, "frontend"), { recursive: true })
  writeFileSync(join(paths.skills, "frontend", "SKILL.md"), "# Frontend")
  for (const packageDirectory of [paths.tools, paths.daemon]) {
    mkdirSync(join(packageDirectory, "dist"), { recursive: true })
    writeFileSync(join(packageDirectory, "package.json"), JSON.stringify({ name: "fixture" }))
    writeFileSync(join(packageDirectory, "dist", "cli.js"), "process.exit(0)")
  }
  return paths
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe("OpenCode 2 build asset staging", () => {
  test("copies shared skill files and both self-contained LSP runtimes beneath the plugin directory", () => {
    const fixture = makeFixture()
    stageOpencode2Assets(fixture.output, {
      sharedSkills: fixture.skills,
      lspTools: fixture.tools,
      lspDaemon: fixture.daemon,
    })

    expect(readFileSync(join(fixture.output, "skills", "frontend", "SKILL.md"), "utf8")).toContain("Frontend")
    expect(readFileSync(join(fixture.output, "packages", "lsp-tools-mcp", "dist", "cli.js"), "utf8")).toContain("exit")
    expect(readFileSync(join(fixture.output, "packages", "lsp-daemon", "package.json"), "utf8")).toContain("fixture")
  })

  test("fails early when the skill tree is missing a required bundled skill", () => {
    const fixture = makeFixture()
    rmSync(join(fixture.skills, "frontend", "SKILL.md"))
    expect(() => stageOpencode2Assets(fixture.output, {
      sharedSkills: fixture.skills,
      lspTools: fixture.tools,
      lspDaemon: fixture.daemon,
    })).toThrow(/Required shared skill is missing/)
  })
})
