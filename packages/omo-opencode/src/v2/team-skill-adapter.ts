import type { OhMyOpenCodeConfig } from "../config"
import { collectDisabledSkillAliases } from "../plugin/skill-context"
import type { LoadedSkill } from "../features/opencode-skill-loader/types"
import { teamModeSkill } from "@oh-my-opencode/skills-loader-core/builtin-skills/skills/team-mode"
import hyperplanTemplate from "../../../omo-senpi/skills/hyperplan/SKILL.md" with { type: "text" }

const TEAM_SKILL_NAME = "team-mode"
const HYPERPLAN_SKILL_NAME = "hyperplan"

export const V2_HYPERPLAN_MODE_PROMPT = `HYPERPLAN MODE ENABLED. If the current prompt already includes the <hyperplan-ultrawork-mode> activation banner, do not announce activation again; otherwise, say “HYPERPLAN MODE ENABLED!” as your first action. Use the native OMO Team pipeline: load the \`hyperplan\` skill, create one Team with \`team_create\`, coordinate rounds through \`team_send_message\`, collect each member's reply, synthesize only defended findings, hand the result to the \`ulw-plan\` planner, then close the Team. Do not simulate missing Team tools or claim a Team was created when a tool call fails.`

const NATIVE_TEAM_COMPATIBILITY = `

## Native OpenCode Team adapter

This plugin runs Team members as standalone native OpenCode sessions linked by a durable OMO Team identity. It does not create worktrees or tmux panes; all members use the current project location. Tool calls use camel-case \`teamRunId\`; \`team_send_message\` accepts \`body\` (not \`message\`). Team messages are delivered as queued native prompts. A member may claim or update only its own tasks; only the lead may assign ownership to someone else. Members cannot create Teams or delegate further work.
`

function rewriteDefinition(skill: LoadedSkill, template: string): LoadedSkill {
	return {
		...skill,
		definition: { ...skill.definition, template },
		lazyContent: { loaded: true, content: template, load: async () => template },
	}
}

function builtinSkill(name: string, description: string, template: string): LoadedSkill {
	return {
		name,
		scope: "builtin",
		definition: { name, description, template },
		lazyContent: { loaded: true, content: template, load: async () => template },
	}
}

function adaptTeamModeTemplate(template: string): string {
	const corrected = template
		.replace(/Use worktree mode for isolated code changes, or tmux visualization when you want live session layout\./g,
			"Native Team members run as separate sessions in the current project location.")
		.replace(/team_shutdown_request\(\{ teamRunId, memberName: M \}\)/g,
			"team_shutdown_request({ teamRunId, targetMemberName: M })")
		.replace(/Any agent can set or change task ownership via `team_task_update` with the `owner` field\. Members typically claim work by setting `owner: "<their-name>"` and `status: "claimed"` \(or directly `"in_progress"`\)\. The lead can also pre-assign work by creating tasks with `owner` set\./g,
			"Members can claim and update their own tasks; they cannot claim for another member or delete another member's task. The lead may claim an unowned pending task for a verified Team member and may update that member's owned task. The shared task list enforces dependencies and valid status transitions.")
		.replace(/session IDs, and tmux pane assignments/g, "session IDs")
		.replace(/ plus worktree or tmux visibility to understand how the team is laid out\./g,
			". Native members share the current project location.")
	return corrected.includes("## Native OpenCode Team adapter") ? corrected : `${corrected.trimEnd()}${NATIVE_TEAM_COMPATIBILITY}`
}

function adaptHyperplanTemplate(): string {
	let template = hyperplanTemplate
		.replace(
			/> \*\*MANDATORY\*\*: First action when this skill loads — say "HYPERPLAN MODE ENABLED!" so the user knows orchestration started\./,
			"> **MANDATORY**: If the current prompt does not already include the `<hyperplan-ultrawork-mode>` activation banner, say \"HYPERPLAN MODE ENABLED!\" as your first action so the user knows orchestration started.",
		)
		.replace(/^1\. Say "HYPERPLAN MODE ENABLED!" exactly once\.$/m,
			"1. If the current prompt does not already include the `<hyperplan-ultrawork-mode>` activation banner, say \"HYPERPLAN MODE ENABLED!\" exactly once.")
		.replace(
			/## HOW THIS MAPS TO omo-senpi[\s\S]*?(?=## HARD PRECONDITIONS)/,
			`## NATIVE TEAM ADAPTER

This skill uses the native OMO Team tools when \`team_mode.enabled: true\` is configured and the OpenCode plugin has been restarted. Create the five-member roster with \`team_create\`; it returns \`teamRunId\`. Send each round with \`team_send_message({ teamRunId, to, body })\`. Replies arrive as queued native prompts in the lead session. Members run as standalone sessions in the current project location; do not request tmux panes or worktrees.

`,
		)
		.replace(
			/1\. \*\*The lead team tools must be available\*\*[\s\S]*?(?=2\. \*\*You are the current top-level lead session\*\*)/,
			`1. **Native Team mode must be enabled** — set \`team_mode.enabled: true\` in the OMO configuration and restart OpenCode. The Team tools are unavailable while the feature is disabled; if they are missing after restart, report that the native plugin did not register them and stop.
`,
		)
		.replaceAll("task_send", "team_send_message")
		.replaceAll("team_run_id", "teamRunId")
		.replaceAll("`message`", "`body`")
		.replaceAll(", message })", ", body })")
		.replaceAll(", message: \"...\" })", ", body: \"...\" })")
		.replaceAll("message is:", "body is:")
		.replaceAll("task_send writes", "team_send_message writes")
		.replaceAll("task_send to", "team_send_message to")
		.replaceAll("task_send`", "team_send_message`")
		.replaceAll("`task_send`", "`team_send_message`")
		.replaceAll("task_send({ to:", "team_send_message({ teamRunId, to:")
		.replaceAll("team_send_message({ to:", "team_send_message({ teamRunId, to:")
		.replaceAll("teamRunId, teamRunId,", "teamRunId,")
		.replaceAll("`force: true` is correct here — the debate is over, so you tear the run down even though members may still be resident.",
			"Use the graceful shutdown sequence first. Set `force: true` only if the lead has verified that interrupting every active member is safe.")
		.replaceAll("Do not use worktree or tmux visibility.", "Members run as native sessions in the current project location.")
		.replaceAll("| Disband the team | `team_delete` | `teamRunId`, `force: true` |", "| Disband the team | `team_delete` | `teamRunId`, graceful shutdown first |")
		.replaceAll("`task`", "`task` (the native OMO delegation tool)")

	// The source skill's tool table and examples use the old payload field name.
	template = template.replace(/(team_send_message\([^\n]*?)\bmessage\s*:/g, "$1body:")
	template = template.replace(/(team_send_message\([^\n]*?),\s*message\s*([})])/g, "$1, body$2")
	template = template.replace(/`team_send_message`\s*\(\s*\{\s*to:/g, "`team_send_message`({ teamRunId, to:")
	template = template.replaceAll("teamRunId, teamRunId,", "teamRunId,")

const nativeNote = `

## Native OpenCode execution constraints

The Team tools use \`teamRunId\` and \`team_send_message({ teamRunId, to, body })\`. Preserve Phase 6's planner handoff exactly as specified: the native OMO \`task\` alias with \`category: "ultrabrain"\`, \`load_skills: ["ulw-plan"]\`, and \`run_in_background: false\`. Prometheus is a primary-only agent and is not a valid delegate target. Members are standalone sessions in the same project location, and cannot delegate. Do not describe or request tmux panes or worktrees. Retry once without only the optional \`researcher\` member if \`deep-low\` is unavailable. The other four adversarial roles are required; if any required role/category/model is unavailable, stop and report the failure instead of changing the protocol.
`
	return `${template.trimEnd()}${nativeNote}`
}

/** Adapt only the built-in Team instructions; user/project skills always win name collisions. */
export function adaptV2TeamSkills(skills: readonly LoadedSkill[], config: OhMyOpenCodeConfig): LoadedSkill[] {
	if (config.team_mode?.enabled !== true) return [...skills]
	const disabled = collectDisabledSkillAliases(config)
	const output = skills.map((skill) => {
		if (skill.scope !== "builtin") return skill
		if (skill.name.toLowerCase() === TEAM_SKILL_NAME) {
			const template = adaptTeamModeTemplate(skill.lazyContent?.content ?? skill.definition.template ?? "")
			return rewriteDefinition(skill, template)
		}
		if (skill.name.toLowerCase() === HYPERPLAN_SKILL_NAME) {
			return rewriteDefinition(skill, adaptHyperplanTemplate())
		}
		return skill
	})
	if (!disabled.has(HYPERPLAN_SKILL_NAME) && !output.some((skill) => skill.name.toLowerCase() === HYPERPLAN_SKILL_NAME)) {
		output.push(builtinSkill(HYPERPLAN_SKILL_NAME, "Adversarial multi-agent planning through the native OMO Team pipeline.", adaptHyperplanTemplate()))
	}
	return output
}
