import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs"
import { basename, dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const outputDirectory = join(repoRoot, "dist", "opencode2")
const sharedSkillsDirectory = join(repoRoot, "packages", "shared-skills", "skills")
const lspToolsDirectory = join(repoRoot, "packages", "lsp-tools-mcp")
const lspDaemonDirectory = join(repoRoot, "packages", "lsp-daemon")

const external = [
  "@opencode/plugin", "@opencode/plugin/*",
  "@opencode/client", "@opencode/client/*",
  "@opencode/schema", "@opencode/schema/*",
  "@opencode/ai", "@opencode/ai/*",
  "@opencode-ai/plugin", "@opencode-ai/plugin/*",
  "@opencode-ai/sdk", "@opencode-ai/sdk/*",
  "@opentui/core", "@opentui/solid", "@opentui/keymap",
  "solid-js", "solid-js/*",
]

function runBunScript(script: string): void {
  const result = Bun.spawnSync([process.execPath, "run", script], {
    cwd: repoRoot,
    stdout: "inherit",
    stderr: "inherit",
  })
  if (result.exitCode !== 0) throw new Error(`bun run ${script} failed with exit code ${result.exitCode}`)
}

function ensureLspArtifacts(): void {
  if (!existsSync(join(lspToolsDirectory, "dist", "cli.js"))) runBunScript("build:lsp-tools-mcp")
  if (!existsSync(join(lspDaemonDirectory, "dist", "cli.js"))) runBunScript("build:lsp-daemon")
}

/** Copy runtime files that remain file-backed after the native plugin bundle is loaded. */
export function stageOpencode2Assets(output: string, inputs: {
  readonly sharedSkills: string
  readonly lspTools: string
  readonly lspDaemon: string
}): void {
  if (!existsSync(join(inputs.sharedSkills, "frontend", "SKILL.md"))) {
    throw new Error(`Required shared skill is missing: ${join(inputs.sharedSkills, "frontend", "SKILL.md")}`)
  }
  for (const [name, source] of [["lsp-tools-mcp", inputs.lspTools], ["lsp-daemon", inputs.lspDaemon]] as const) {
    if (!existsSync(join(source, "package.json")) || !existsSync(join(source, "dist", "cli.js"))) {
      throw new Error(`Required ${name} runtime is missing its package.json or dist/cli.js; run the scoped LSP build first.`)
    }
  }

  cpSync(inputs.sharedSkills, join(output, "skills"), { recursive: true })
  for (const [name, source] of [["lsp-tools-mcp", inputs.lspTools], ["lsp-daemon", inputs.lspDaemon]] as const) {
    const destination = join(output, "packages", name)
    mkdirSync(destination, { recursive: true })
    cpSync(join(source, "package.json"), join(destination, "package.json"))
    cpSync(join(source, "dist"), join(destination, "dist"), { recursive: true })
  }
}

async function bundle(entrypoint: string, outfile: string): Promise<void> {
  const result = await Bun.build({
    entrypoints: [entrypoint],
    outdir: dirname(outfile),
    naming: { entry: basename(outfile) },
    target: "bun",
    format: "esm",
    external,
    loader: { ".md": "text" },
  })
  if (!result.success) {
    for (const log of result.logs) console.error(log)
    throw new Error(`Could not bundle ${entrypoint}`)
  }
  if (!existsSync(outfile)) throw new Error(`Build completed without creating ${outfile}`)
  console.log(`built ${outfile}`)
}

export async function buildOpencode2(): Promise<void> {
  ensureLspArtifacts()
  rmSync(outputDirectory, { recursive: true, force: true })
  mkdirSync(outputDirectory, { recursive: true })

  await bundle(
    join(repoRoot, "packages", "omo-opencode", "src", "v2", "server-entry.ts"),
    join(outputDirectory, "server.js"),
  )
  await bundle(
    join(repoRoot, "packages", "omo-opencode", "src", "tui.ts"),
    join(outputDirectory, "tui.js"),
  )
  stageOpencode2Assets(outputDirectory, {
    sharedSkills: sharedSkillsDirectory,
    lspTools: lspToolsDirectory,
    lspDaemon: lspDaemonDirectory,
  })
  console.log(`OpenCode 2 plugin directory is ready: ${outputDirectory}`)
}

if (import.meta.main) {
  await buildOpencode2().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
