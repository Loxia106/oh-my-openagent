import { describe, expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin"
import type * as Skill from "@opencode/schema/skill"
import type { LoadedSkill } from "../features/opencode-skill-loader/types"
import { filterUnsupportedTeamBuiltinSkills, registerV2Skills, toV2SkillInfo, type V2SkillCatalog } from "./skills"

function loadedSkill(name: string, overrides: Partial<LoadedSkill> = {}): LoadedSkill {
  return {
    name,
    definition: {
      name,
      description: `${name} description`,
      template: `${name} instructions`,
    },
    scope: "builtin",
    ...overrides,
  }
}

describe("native v2 skill visibility", () => {
  test("exposes legacy skills for automatic discovery by default", () => {
    expect(toV2SkillInfo(loadedSkill("frontend"), "/project")).toMatchObject({
      id: "frontend",
      description: "frontend description",
      autoinvoke: true,
      content: "frontend instructions",
    })
  })

  test("honors Claude disable-model-invocation and OpenCode autoinvoke=false metadata", () => {
    expect(toV2SkillInfo(loadedSkill("manual-only", { disableModelInvocation: true }), "/project").autoinvoke).toBe(false)
    expect(toV2SkillInfo(loadedSkill("metadata-manual-only", { metadata: { "opencode/autoinvoke": "false" } }), "/project").autoinvoke).toBe(false)
    expect(toV2SkillInfo(loadedSkill("boolean-metadata-manual-only", { metadata: { "opencode/autoinvoke": false } as unknown as Record<string, string> }), "/project").autoinvoke).toBe(false)
  })

  test("filters team-dependent built-ins from both catalogs while preserving same-name project skills", () => {
    const builtinSkills = ["security-research", "security-review", "team-mode", "frontend"]
      .map((name) => loadedSkill(name))
    const filtered = filterUnsupportedTeamBuiltinSkills({
      loaded: builtinSkills,
      skills: builtinSkills.map((skill) => toV2SkillInfo(skill, "/project")),
    })

    expect(filtered.loaded.map((skill) => skill.name)).toEqual(["frontend"])
    expect(filtered.skills.map((skill) => String(skill.name))).toEqual(["frontend"])

    const enabledCatalog = { loaded: builtinSkills, skills: builtinSkills.map((skill) => toV2SkillInfo(skill, "/project")) }
    expect(filterUnsupportedTeamBuiltinSkills(enabledCatalog, true)).toBe(enabledCatalog)

    const customSameName = loadedSkill("security-review", {
      scope: "project",
      definition: { name: "security-review", description: "Local review checklist", template: "Local instructions" },
    })
    const customCatalog = filterUnsupportedTeamBuiltinSkills({
      loaded: [customSameName],
      skills: [toV2SkillInfo(customSameName, "/project")],
    })
    expect(customCatalog.loaded).toEqual([customSameName])
    expect(customCatalog.skills.map((skill) => String(skill.name))).toEqual(["security-review"])
    expect(customCatalog.skills[0]?.description).toBe("Local review checklist")
  })
})

function info(id: string, autoinvoke: boolean): Skill.Info {
  return {
    id: id as Skill.Info["id"],
    name: id as Skill.Info["name"],
    description: id,
    autoinvoke,
    path: `/project/.opencode/skills/${id}/SKILL.md` as Skill.Info["path"],
    content: `${id} content`,
  }
}

function eventStream() {
  const queue: unknown[] = []
  const waiters: Array<(event: unknown) => void> = []
  return {
    push(event: unknown) {
      const waiter = waiters.shift()
      if (waiter) waiter(event)
      else queue.push(event)
    },
    subscribe({ signal }: { signal?: AbortSignal } = {}) {
      return {
        [Symbol.asyncIterator]() {
          return {
            next() {
              if (signal?.aborted) return Promise.resolve({ done: true as const, value: undefined })
              const event = queue.shift()
              if (event !== undefined) return Promise.resolve({ done: false as const, value: event })
              return new Promise<IteratorResult<unknown>>((resolve) => {
                waiters.push((value) => resolve({ done: false, value }))
                signal?.addEventListener("abort", () => resolve({ done: true, value: undefined }), { once: true })
              })
            },
          }
        },
      }
    },
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for skill policy reconciliation")
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

describe("native skill invocation policy reconciliation", () => {
  test("corrects late host skill transforms, respects disabled skills, and cleans up without looping", async () => {
    const events = eventStream()
    const transforms: Array<(editor: any) => void> = []
    let current: Skill.Info[] = []
    let transformCount = 0
    const rebuild = () => {
      const values = new Map<string, Skill.Info>()
      const editor = {
        list: () => [...values.values()],
        get: (id: string) => values.get(id),
        add: (skill: Skill.Info) => values.set(String(skill.id), { ...skill }),
        update: (id: string, update: (skill: any) => void) => {
          const skill = values.get(id)
          if (skill) update(skill as any)
        },
        remove: (id: string) => values.delete(id),
      }
      for (const transform of transforms) transform(editor)
      current = [...values.values()]
    }
    const context = {
      location: { directory: "/project" },
      event: { subscribe: events.subscribe },
      skill: {
        list: async () => ({ data: current }),
        transform: async (callback: (editor: any) => void) => {
          transforms.push(callback)
          transformCount++
          rebuild()
          events.push({ type: "skill.updated", location: { directory: "/project" } })
          return {
            dispose: async () => {
              const index = transforms.indexOf(callback)
              if (index >= 0) transforms.splice(index, 1)
              rebuild()
              events.push({ type: "skill.updated", location: { directory: "/project" } })
            },
          }
        },
      },
    } as unknown as Plugin.Context
    const catalog: V2SkillCatalog = {
      skills: [info("qa-manual-only", false)],
      loaded: [],
    }

    const cleanup = await registerV2Skills(context, catalog, { disabled_skills: ["qa-disabled"] } as any)
    await context.skill.transform((editor) => {
      editor.add(info("qa-manual-only", true))
      editor.add(info("qa-disabled", true))
    })
    await waitFor(() => current.some((skill) => skill.id === "qa-manual-only" && skill.autoinvoke === false) &&
      !current.some((skill) => skill.id === "qa-disabled"))
    const settledCount = transformCount
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(transformCount).toBe(settledCount)

    await cleanup()
    const afterCleanupCount = transformCount
    await context.skill.transform((editor) => editor.add(info("qa-disabled", true)))
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(transformCount).toBe(afterCleanupCount + 1)
    expect(current.some((skill) => skill.id === "qa-disabled")).toBe(true)
  })
})
