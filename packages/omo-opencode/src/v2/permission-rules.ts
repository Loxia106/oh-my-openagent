import type { Plugin } from "@opencode/plugin"

export type PermissionRule = { action: string; resource: string; effect: "allow" | "ask" | "deny" }
export type PermissionEffect = PermissionRule["effect"]

export function wildcardMatches(value: string, pattern: string): boolean {
	// Keep this aligned with OpenCode's Wildcard.match implementation.
	const normalized = value.replaceAll("\\", "/")
	let escaped = pattern.replaceAll("\\", "/").replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")
	if (escaped.endsWith(" .*")) escaped = escaped.slice(0, -3) + "( .*)?"
	return new RegExp(`^${escaped}$`, process.platform === "win32" ? "si" : "s").test(normalized)
}

/**
 * Evaluate an action against the session's agent/session rules and every native ancestor, using
 * OpenCode's last-matching-rule precedence per ruleset and the strictest result across the chain.
 * Returns undefined when no rule matches.
 */
export async function evaluatePermissionEffect(
	ctx: Plugin.Context,
	sessionID: string,
	agentID: string | undefined,
	action: string,
	resources: readonly string[],
): Promise<PermissionEffect | undefined> {
	const agents = (await ctx.agent.list()).data as Array<{ id: string; permissions?: PermissionRule[] }>
	let result: PermissionEffect | undefined
	let current: { id: string; parentID?: string; agent?: string; permissions?: unknown } | undefined = await ctx.session.get({ sessionID })
	let depth = 0
	const seen = new Set<string>()
	while (current && depth < 32 && !seen.has(current.id)) {
		seen.add(current.id)
		const owner = depth === 0 && agentID ? agentID : current.agent
		const rules = [
			...((agents.find((agent) => agent.id === owner)?.permissions ?? []) as PermissionRule[]),
			...((Array.isArray(current.permissions) ? current.permissions : []) as PermissionRule[]),
		]
		for (const resource of resources.length > 0 ? resources : ["*"]) {
			const matched = rules.findLast((rule) => wildcardMatches(action, rule.action) && wildcardMatches(resource, rule.resource))
			if (matched?.effect === "deny") return "deny"
			if (matched?.effect === "ask") result = "ask"
			else if (matched?.effect === "allow" && result === undefined) result = "allow"
		}
		if (!current.parentID) break
		current = await ctx.session.get({ sessionID: current.parentID })
		depth++
	}
	return result
}
