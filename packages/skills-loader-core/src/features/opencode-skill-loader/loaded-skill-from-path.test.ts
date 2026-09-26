import { describe, expect, it, spyOn } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import * as fs from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { loadSkillFromPath } from "./loaded-skill-from-path"

describe("loadSkillFromPath", () => {
  it("#given the skill file read throws a non-Error value #when loading a skill #then it returns the null fallback", async () => {
    // given
    const readFileSpy = spyOn(fs, "readFile").mockImplementation(() => {
      throw "read failed"
    })

    try {
      // when
      const result = await loadSkillFromPath({
        skillPath: "/tmp/example/SKILL.md",
        resolvedPath: "/tmp/example",
        defaultName: "example",
        scope: "opencode",
      })

      // then
      expect(result).toBeNull()
    } finally {
      readFileSpy.mockRestore()
    }
  })

  it("preserves Claude's disable-model-invocation frontmatter flag", async () => {
    const root = mkdtempSync(join(tmpdir(), "loaded-skill-invocation-"))
    const skillDir = join(root, "disabled-skill")
    const skillPath = join(skillDir, "SKILL.md")
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(skillPath, "---\nname: disabled-skill\ndescription: Hidden from automatic discovery\ndisable-model-invocation: true\n---\nInstructions\n")

    try {
      const loaded = await loadSkillFromPath({
        skillPath,
        resolvedPath: skillDir,
        defaultName: "disabled-skill",
        scope: "user",
      })

      expect(loaded?.disableModelInvocation).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
