import { describe, expect, test } from "bun:test"
import type { LoadedSkill } from "../features/opencode-skill-loader/types"
import type { OhMyOpenCodeConfig } from "../config"
import { teamModeSkill } from "@oh-my-opencode/skills-loader-core/builtin-skills/skills/team-mode"
import { adaptV2TeamSkills, V2_HYPERPLAN_MODE_PROMPT } from "./team-skill-adapter"

function loadedBuiltin(skill: { name: string; description: string; template: string }): LoadedSkill {
	return {
		name: skill.name,
		scope: "builtin",
		definition: { name: skill.name, description: skill.description, template: skill.template },
		lazyContent: { loaded: true, content: skill.template, load: async () => skill.template },
	}
}

describe("adaptV2TeamSkills", () => {
	test("adapts the builtin Team instructions and adds the full native Hyperplan skill", () => {
		const sourceTeam = loadedBuiltin(teamModeSkill)
		const result = adaptV2TeamSkills([sourceTeam], { team_mode: { enabled: true } } as OhMyOpenCodeConfig)
		const team = result.find((skill) => skill.name === "team-mode")!
		const hyperplan = result.find((skill) => skill.name === "hyperplan")!

		expect(team.definition.template).toContain("Native OpenCode Team adapter")
		expect(team.definition.template).toContain("targetMemberName")
		expect(team.definition.template).not.toContain("tmux visualization")
		expect(team.lazyContent?.content).toBe(team.definition.template)
		expect(hyperplan.definition.template).toContain("MEMBER 1: `skeptic`")
		expect(hyperplan.definition.template).toContain("MEMBER 5: `creative`")
		expect(hyperplan.definition.template).toContain("Round 3")
		expect(hyperplan.definition.template).toContain("ulw-plan")
		expect(hyperplan.definition.template).toContain("teamRunId")
		expect(hyperplan.definition.template).toContain("team_send_message")
		expect(hyperplan.definition.template).not.toMatch(/\btask_send\b|\bteam_run_id\b/)
		expect(hyperplan.definition.template).not.toMatch(/team_send_message\([^\n}]*\bmessage\s*:/)
		expect(hyperplan.definition.template).not.toMatch(/subagent_type\s*:\s*["']prometheus["']/)
		expect(hyperplan.definition.template).not.toContain("--no-omo-task")
		expect(hyperplan.definition.template).not.toContain("OMO SENPI")
		expect(hyperplan.definition.template).not.toContain("senpi install")
		expect(hyperplan.definition.template).toContain("optional `researcher` member")
		expect(hyperplan.definition.template).toContain("other four adversarial roles are required")
		expect(hyperplan.definition.template).toContain("If the current prompt does not already include the `<hyperplan-ultrawork-mode>` activation banner")
		expect(V2_HYPERPLAN_MODE_PROMPT).toContain("If the current prompt already includes the <hyperplan-ultrawork-mode> activation banner")
		expect(hyperplan.lazyContent?.content).toBe(hyperplan.definition.template)
	})

	test("does not override user/project same-name skills and honors disabled Hyperplan", () => {
		const userSkill: LoadedSkill = {
			name: "hyperplan",
			scope: "project",
			definition: { name: "hyperplan", template: "project-owned" },
		}
		const result = adaptV2TeamSkills([userSkill], { team_mode: { enabled: true } } as OhMyOpenCodeConfig)
		expect(result).toHaveLength(1)
		expect(result[0]).toBe(userSkill)

		const disabled = adaptV2TeamSkills([], {
			team_mode: { enabled: true },
			disabled_skills: ["hyperplan"],
		} as OhMyOpenCodeConfig)
		expect(disabled).toEqual([])
	})

	test("leaves skill content unchanged when Team mode is disabled", () => {
		const sourceTeam = loadedBuiltin(teamModeSkill)
		expect(adaptV2TeamSkills([sourceTeam], {} as OhMyOpenCodeConfig)[0]).toBe(sourceTeam)
	})
})
