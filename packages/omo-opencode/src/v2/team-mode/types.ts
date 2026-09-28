import type { Plugin } from "@opencode/plugin"
import type { ToolEditor } from "@opencode/plugin/promise/tool"
import type { TeamModeConfig } from "@oh-my-opencode/team-core/config"
import type { TeamSpec, RuntimeState, Message, Task } from "@oh-my-opencode/team-core/types"
import type { V2BackgroundAdmission } from "../background-admission"
import type { V2SubagentRunState } from "../task-state"
import type { OhMyOpenCodeConfig } from "../../config"
import type { TeamLogicalParentResolver } from "./membership-store"

export type V2TeamManagerStart = {
	readonly admission: Pick<V2BackgroundAdmission, "acquire">
	readonly runs: V2SubagentRunState
}

export type V2TeamManager = {
	readonly resolveLogicalParent: TeamLogicalParentResolver
	/** True for an isolated member worktree Location of a run this activation owns. */
	readonly ownsDirectory: (directory: string) => boolean
	/** Load owned runs' member worktree Locations before admission restores durable child leases. */
	loadOwnership(): Promise<void>
	start(dependencies: V2TeamManagerStart): Promise<void>
	createTools(editor: ToolEditor): void
	dispose(): Promise<void>
}

export type V2TeamToolContext = {
	readonly sessionID: string
	readonly signal: AbortSignal
	readonly progress: (update: { title?: string; body?: string; metadata?: Record<string, unknown> }) => Promise<void>
}

export type V2TeamRuntimeDependencies = {
	readonly ctx: Plugin.Context
	readonly omoConfig: OhMyOpenCodeConfig
	readonly teamConfig: TeamModeConfig
}

export type { TeamSpec, RuntimeState, Message, Task }
