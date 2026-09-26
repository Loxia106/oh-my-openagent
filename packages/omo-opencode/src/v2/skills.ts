import { join } from "node:path"
import type { Plugin } from "@opencode/plugin"
import * as Skill from "@opencode/schema/skill"
import type { OhMyOpenCodeConfig } from "../config"
import type { LoadedSkill } from "../features/opencode-skill-loader/types"
import { collectDisabledSkillAliases, createSkillContext } from "../plugin/skill-context"
import { log } from "../shared/logger"

export type V2SkillCatalog = {
  readonly skills: readonly Skill.Info[]
  readonly loaded: readonly LoadedSkill[]
}

const unsupportedTeamBuiltinSkills = new Set(["security-research", "security-review", "team-mode"])

function isUnsupportedTeamBuiltin(skill: Pick<LoadedSkill, "name" | "scope">): boolean {
  return skill.scope === "builtin" && unsupportedTeamBuiltinSkills.has(skill.name.toLowerCase())
}

/**
 * Remove built-in skills whose instructions require the native OMO team
 * manager, which is not available in the OpenCode 2 adapter. Scope is part of
 * the merged skill record, so user/project skills with the same name remain
 * available.
 */
export function filterUnsupportedTeamBuiltinSkills(catalog: V2SkillCatalog): V2SkillCatalog {
  const removedNames = new Set(catalog.loaded
    .filter(isUnsupportedTeamBuiltin)
    .map((skill) => skill.name.toLowerCase()))
  if (removedNames.size === 0) return catalog

  return {
    loaded: catalog.loaded.filter((skill) => !removedNames.has(skill.name.toLowerCase())),
    skills: catalog.skills.filter((skill) => !removedNames.has(String(skill.name).toLowerCase())),
  }
}

export function toV2SkillInfo(skill: LoadedSkill, directory: string): Skill.Info {
  const filePath = skill.path ?? (skill.resolvedPath
    ? join(skill.resolvedPath, "SKILL.md")
    : join(directory, ".opencode", "plugins", "oh-my-openagent", "skills", `${skill.name}.md`))
  const content = skill.lazyContent?.content ?? skill.definition.template ?? ""
  const autoinvokeMetadata: unknown = skill.metadata?.["opencode/autoinvoke"]
  const explicitlyDisabled = skill.disableModelInvocation === true || autoinvokeMetadata === false ||
    (typeof autoinvokeMetadata === "string" && autoinvokeMetadata.trim().toLowerCase() === "false")
  return {
    id: skill.name as Skill.Info["id"],
    name: skill.name as Skill.Info["name"],
    description: skill.definition.description ?? "",
    // OpenCode 2 only lists autoinvokable skills in <available_skills>. Most
    // legacy OMO/Claude skills are model-invocable unless explicitly disabled.
    autoinvoke: !explicitlyDisabled,
    path: filePath as Skill.Info["path"],
    content,
  }
}

/** Read OMO, OpenCode, Claude, shared and bundled skills without calling host APIs. */
export async function loadV2SkillCatalog(
  config: OhMyOpenCodeConfig,
  directory: string,
): Promise<V2SkillCatalog> {
  const context = await createSkillContext({ directory, pluginConfig: config })
  const loaded = context.mergedSkills.filter((skill) => !isUnsupportedTeamBuiltin(skill))
  const skills = await Promise.all(loaded.map(async (skill) => {
    if (skill.lazyContent && !skill.lazyContent.loaded) {
      return toV2SkillInfo({
        ...skill,
        definition: { ...skill.definition, template: await skill.lazyContent.load() },
      }, directory)
    }
    return toV2SkillInfo(skill, directory)
  }))
  return { skills, loaded }
}

export async function registerV2Skills(
  ctx: Plugin.Context,
  catalog: V2SkillCatalog,
  config: OhMyOpenCodeConfig,
): Promise<() => Promise<void>> {
  const disabled = collectDisabledSkillAliases(config)
  const directory = String(ctx.location.directory)
  const controller = new AbortController()
  const expected = catalog.skills.filter((skill) => !isDisabledSkill(skill, disabled))
  let active = true
  let correction: Awaited<ReturnType<typeof ctx.skill.transform>> | undefined
  let reconciliation = Promise.resolve()

  const applyBase = (editor: Parameters<Parameters<typeof ctx.skill.transform>[0]>[0]) => {
    for (const skill of editor.list()) {
      if (isDisabledSkill(skill, disabled)) editor.remove(String(skill.id))
    }
    for (const skill of catalog.skills) {
      if (isDisabledSkill(skill, disabled)) continue
      if (editor.get(String(skill.id))) {
        editor.update(String(skill.id), (current) => Object.assign(current, skill))
      } else {
        editor.add(skill)
      }
    }
  }

  const applyPolicyCorrection = (editor: Parameters<Parameters<typeof ctx.skill.transform>[0]>[0]) => {
    for (const skill of editor.list()) {
      if (isDisabledSkill(skill, disabled)) {
        editor.remove(String(skill.id))
        continue
      }
      const desired = expected.find((candidate) => String(candidate.id) === String(skill.id))
      if (desired && skill.autoinvoke !== desired.autoinvoke) {
        editor.update(String(skill.id), (current) => {
          current.autoinvoke = desired.autoinvoke
        })
      }
    }
  }

  const needsCorrection = (skills: readonly SkillPolicyState[]) => {
    for (const skill of skills) {
      if (isDisabledSkill(skill, disabled)) return true
    }
    return expected.some((desired) => {
      const current = skills.find((skill) => String(skill.id) === String(desired.id))
      return current !== undefined && current.autoinvoke !== desired.autoinvoke
    })
  }

  const reconcile = () => {
    reconciliation = reconciliation.then(async () => {
      if (!active) return
      const result = await ctx.skill.list()
      if (!active || !needsCorrection(result.data)) return

      await correction?.dispose()
      correction = undefined
      if (!active) return
      correction = await ctx.skill.transform(applyPolicyCorrection)
      if (!active) {
        await correction.dispose()
        correction = undefined
      }
    }).catch((error) => {
      if (active && !controller.signal.aborted) {
        log("[v2 skills] Failed to enforce native skill invocation policy.", error)
      }
    })
    return reconciliation
  }

  // Native OpenCode config plugins are activated after user plugins and can add
  // Claude skills with defaults that override this registration. Observe the
  // public skill.updated event and append a final, policy-only transform when
  // the composed registry actually violates OMO's explicit invocation policy.
  const eventTask = (async () => {
    try {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        if (!active || event.type !== "skill.updated") continue
        const eventDirectory = event.location?.directory
        if (eventDirectory && String(eventDirectory) !== directory) continue
        await reconcile()
      }
    } catch (error) {
      if (active && !controller.signal.aborted) {
        log("[v2 skills] Skill registry event stream stopped.", error)
      }
    }
  })()

  let registration: Awaited<ReturnType<typeof ctx.skill.transform>> | undefined
  try {
    registration = await ctx.skill.transform(applyBase)
  } catch (error) {
    active = false
    controller.abort()
    await eventTask
    await reconciliation
    await correction?.dispose()
    throw error
  }

  return async () => {
    if (!active) return
    active = false
    controller.abort()
    await eventTask
    await reconciliation
    await correction?.dispose()
    await registration?.dispose()
  }
}

type SkillPolicyState = { readonly id: unknown; readonly name: unknown; readonly autoinvoke?: boolean }

function isDisabledSkill(skill: SkillPolicyState, disabled: ReadonlySet<string>): boolean {
  return disabled.has(String(skill.name).toLowerCase()) || disabled.has(String(skill.id).toLowerCase())
}
