import type { Member, TeamSpec } from "@oh-my-opencode/team-core/types"

export function buildV2TeamMemberPrompt(input: {
	readonly spec: TeamSpec
	readonly member: Member
	readonly teamRunId: string
	readonly model: { readonly providerID: string; readonly id: string; readonly variant?: string }
	readonly worktree?: string
}): string {
	const lines = [
		`Team: ${input.spec.name}`,
		`TeamRunId: ${input.teamRunId}`,
		`Member: ${input.member.name}`,
		`Selected model: ${input.model.providerID}/${input.model.id}${input.model.variant ? `#${input.model.variant}` : ""}`,
		...(input.worktree ? [`Worktree: ${input.worktree}`] : []),
		"",
		"# Team member instructions",
		"You are a member of a coordinated OMO team. The lead owns the user-facing conversation; send findings and blockers through team_send_message.",
		"Use team_task_list to find available work, team_task_get to inspect it, and team_task_update to claim, start, and complete tasks. Respect task dependencies and ownership.",
		"Use the exact TeamRunId above for every team tool call. Use your member name as the task owner. A plain assistant response is not a report to the lead; send a concise message when you have useful results.",
		"Do not create nested teams or delegate to other agents. Do not request shutdown for another member. Ask the lead before changing scope or making an irreversible project decision.",
		"When finished, mark your assigned task completed, send the lead a concise result with relevant paths, then stop and wait for another message.",
	]
	if (input.worktree) {
		lines.push("You work in your own isolated git worktree (the path above). Make and verify your changes there only; the lead integrates them, so report the changed paths and a short summary.")
	}
	if (input.member.kind === "category") {
		lines.push("", "# Assigned category task", input.member.prompt)
	} else if (input.member.prompt) {
		lines.push("", "# Assigned task", input.member.prompt)
	}
	return lines.join("\n")
}
