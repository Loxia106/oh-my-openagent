import type { Plugin } from "@opencode/plugin"
import { canonicalTeamDirectory } from "./membership-store"

const PREFIX = "oh-my-openagent:v2:location-heartbeat:"

export type V2LocationHeartbeat = { readonly at: number; readonly teamMode: boolean }

function key(directory: string): string {
	return `${PREFIX}${encodeURIComponent(canonicalTeamDirectory(directory))}`
}

/**
 * OpenCode 2 activates the plugin separately for every Location. Each OMO activation records that it is live
 * (and whether Team mode is on) in plugin storage, which the host shares across Locations. A Team owner reads it
 * to confirm OMO governs an isolated member's worktree before prompting that member.
 */
export async function recordV2LocationHeartbeat(ctx: Pick<Plugin.Context, "storage" | "location">, teamMode: boolean): Promise<void> {
	await ctx.storage.set(key(String(ctx.location.directory)), { at: Date.now(), teamMode })
}

export async function readV2LocationHeartbeat(storage: Plugin.Context["storage"], directory: string): Promise<V2LocationHeartbeat | undefined> {
	const value = await storage.get(key(directory))
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
	const record = value as Record<string, unknown>
	return typeof record.at === "number" && typeof record.teamMode === "boolean" ? { at: record.at, teamMode: record.teamMode } : undefined
}
