import { mkdtemp, rm, unlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Plugin } from "@opencode/plugin"
import { TeamModeConfigSchema } from "@oh-my-opencode/team-core/config"
import { TeamSpecSchema } from "@oh-my-opencode/team-core/types"
import { createRuntimeState, loadRuntimeState, transitionRuntimeState } from "@oh-my-opencode/team-core/team-state-store"
import {
	createV2TeamMembershipStore,
	v2TeamRunDirectories,
	V2TeamMembershipError,
	type TeamLogicalParentResolver,
} from "./membership-store"

const teamSpec = TeamSpecSchema.parse({
	name: "native-team",
	leadAgentId: "lead",
	members: [
		{ name: "lead", kind: "subagent_type", subagent_type: "atlas" },
		{ name: "worker", kind: "subagent_type", subagent_type: "sisyphus" },
	],
})

type SessionInfo = Awaited<ReturnType<Plugin.Context["session"]["get"]>>

function session(id: string, projectID: string, directory: string, parentID?: string, metadata?: Record<string, unknown>): SessionInfo {
	return {
		id,
		projectID,
		location: { directory },
		...(metadata ? { metadata } : {}),
		...(parentID ? { parentID } : {}),
	} as SessionInfo
}

function context(input: {
	baseDir: string
	projectID?: string
	directory?: string
	workspaceID?: string
	sessions?: Map<string, SessionInfo>
}): Pick<Plugin.Context, "location" | "session"> {
	const directory = input.directory ?? "/workspace"
	const projectID = input.projectID ?? "project-a"
	const sessions = input.sessions ?? new Map<string, SessionInfo>()
	return {
		location: {
			project: { id: projectID, canonical: directory },
			directory,
			workspaceID: input.workspaceID ?? "workspace-a",
		} as Plugin.Context["location"],
		session: {
			get: async ({ sessionID }: { sessionID: string }) => {
				const found = sessions.get(sessionID)
				if (!found) throw new Error(`unknown session ${sessionID}`)
				return found
			},
		} as unknown as Plugin.Context["session"],
	}
}

async function fixture() {
	const baseDir = await mkdtemp(join(tmpdir(), "omo-team-membership-"))
	const config = TeamModeConfigSchema.parse({ base_dir: baseDir })
	const leadSessionID = "ses-team-lead"
	const memberSessionID = "ses-team-worker"
	const sessions = new Map<string, SessionInfo>([
		[leadSessionID, session(leadSessionID, "project-a", "/workspace")],
		[memberSessionID, session(memberSessionID, "project-a", "/workspace")],
	])
	const ctx = context({ baseDir, sessions })
	const runtime = await createRuntimeState(teamSpec, leadSessionID, "project", config)
	await transitionRuntimeState(runtime.teamRunId, (current) => ({
		...current,
		members: current.members.map((member) => member.name === "lead"
			? { ...member, sessionId: leadSessionID, status: "running" }
			: { ...member, sessionId: memberSessionID, status: "running" }),
	}), config)
	const store = createV2TeamMembershipStore(ctx, config)
	await store.registerRun({
		teamRunId: runtime.teamRunId,
		teamName: teamSpec.name,
		spec: teamSpec,
		leadSessionID,
		leadMemberName: "lead",
		memberNames: teamSpec.members.map((member) => member.name),
	})
	await store.bindSession({ teamRunId: runtime.teamRunId, memberName: "worker", sessionID: memberSessionID })
	return { baseDir, config, ctx, runtime, store, sessions, leadSessionID, memberSessionID }
}

async function close(baseDir: string): Promise<void> {
	await rm(baseDir, { recursive: true, force: true })
}

describe("v2 Team durable logical membership", () => {
	test("reconstructs a parentless member edge after manager recreation and leaves the lead as the root", async () => {
		const f = await fixture()
		try {
			f.sessions.set("ses-unmanaged", session("ses-unmanaged", "project-a", "/workspace"))
			const restartedStore = createV2TeamMembershipStore(f.ctx, f.config)
			const resolver: TeamLogicalParentResolver = (id) => restartedStore.resolveLogicalParent(id)
			expect(await resolver(f.memberSessionID)).toBe(f.leadSessionID)
			expect(await resolver(f.leadSessionID)).toBeUndefined()
			expect(await resolver("ses-unmanaged")).toBeUndefined()
			expect((await loadRuntimeState(f.runtime.teamRunId, f.config)).members.find((member) => member.name === "worker")?.sessionId)
				.toBe(f.memberSessionID)
		} finally {
			await close(f.baseDir)
		}
	})

	test("does not replace a host-owned native parent for a known Team session", async () => {
		const f = await fixture()
		try {
			f.sessions.set(f.memberSessionID, session(f.memberSessionID, "project-a", "/workspace", "ses-native-parent"))
			expect(await f.store.resolveLogicalParent(f.memberSessionID)).toBeUndefined()
		} finally {
			await close(f.baseDir)
		}
	})

	test("counts a synthetic mailbox turn once per stable message ID and enforces the member turn quota", async () => {
		const f = await fixture()
		try {
			expect(await f.store.admitSyntheticTurn(f.memberSessionID, "omo-team:run:worker:message-1", 1))
				.toEqual({ turnCount: 1, newlyAdmitted: true })
			expect(await f.store.admitSyntheticTurn(f.memberSessionID, "omo-team:run:worker:message-1", 1))
				.toEqual({ turnCount: 1, newlyAdmitted: false })
			expect((await f.store.sessionMembership(f.memberSessionID))?.member.turnCount).toBe(1)
			await expect(f.store.admitSyntheticTurn(f.memberSessionID, "omo-team:run:worker:message-2", 1))
				.rejects.toThrow("max_member_turns (1)")
		} finally {
			await close(f.baseDir)
		}
	})

	test("reserves message quota idempotently before retryable mailbox writes", async () => {
		const f = await fixture()
		try {
			await f.store.reserveMessage(f.runtime.teamRunId, 1, "tool:call-1")
			await f.store.reserveMessage(f.runtime.teamRunId, 1, "tool:call-1")
			await expect(f.store.reserveMessage(f.runtime.teamRunId, 1, "tool:call-2"))
				.rejects.toThrow("max_messages_per_run (1)")
			expect((await f.store.recordForRun(f.runtime.teamRunId))?.messageCount).toBe(1)
		} finally {
			await close(f.baseDir)
		}
	})

	test("an isolated member is verified from its own worktree Location and from the lead's, never from elsewhere", async () => {
		const f = await fixture()
		const worktree = "/workspace/.omo/worktrees/native-team-worker"
		try {
			const bound = await f.store.bindWorktree({ teamRunId: f.runtime.teamRunId, memberName: "worker", directory: worktree })
			expect(v2TeamRunDirectories(bound)).toEqual(["/workspace", worktree])
			await expect(f.store.bindWorktree({ teamRunId: f.runtime.teamRunId, memberName: "worker", directory: "/workspace/.omo/worktrees/other" }))
				.rejects.toThrow("different worktree")
			await expect(f.store.bindWorktree({ teamRunId: f.runtime.teamRunId, memberName: "lead", directory: worktree }))
				.rejects.toThrow("no member lead")

			// The member session must actually live in its recorded worktree.
			await expect(f.store.resolveLogicalParent(f.memberSessionID)).rejects.toThrow("disagrees with its durable Team location")
			f.sessions.set(f.memberSessionID, session(f.memberSessionID, "project-a", worktree))
			expect(await f.store.resolveLogicalParent(f.memberSessionID)).toBe(f.leadSessionID)

			const memberLocation = createV2TeamMembershipStore(context({ baseDir: f.baseDir, directory: worktree, sessions: f.sessions }), f.config)
			expect(await memberLocation.resolveLogicalParent(f.memberSessionID)).toBe(f.leadSessionID)
			expect(await memberLocation.recordForRun(f.runtime.teamRunId)).toMatchObject({ teamRunId: f.runtime.teamRunId })
			// Only the lead Location owns (recovers) the run.
			expect(await memberLocation.listForLocation()).toEqual([])
			expect((await f.store.listForLocation()).map((record) => record.teamRunId)).toEqual([f.runtime.teamRunId])

			const unrelated = createV2TeamMembershipStore(context({ baseDir: f.baseDir, directory: "/elsewhere", sessions: f.sessions }), f.config)
			await expect(unrelated.resolveLogicalParent(f.memberSessionID)).rejects.toThrow("another project or workspace")
			await expect(unrelated.recordForRun(f.runtime.teamRunId)).rejects.toThrow("another project or workspace")
		} finally {
			await close(f.baseDir)
		}
	})

	test("fails closed when a known session is queried from a different workspace", async () => {
		const f = await fixture()
		try {
			const otherWorkspace = createV2TeamMembershipStore(context({
				baseDir: f.baseDir,
				workspaceID: "workspace-b",
				sessions: f.sessions,
			}), f.config)
			await expect(otherWorkspace.resolveLogicalParent(f.memberSessionID)).rejects.toThrow("another project or workspace")
		} finally {
			await close(f.baseDir)
		}
	})

	test("fails closed when team-core runtime no longer agrees with a recorded member session", async () => {
		const f = await fixture()
		try {
			await transitionRuntimeState(f.runtime.teamRunId, (current) => ({
				...current,
				members: current.members.map((member) => member.name === "worker"
					? { ...member, sessionId: "ses-replaced" }
					: member),
			}), f.config)
			await expect(f.store.resolveLogicalParent(f.memberSessionID)).rejects.toBeInstanceOf(V2TeamMembershipError)
		} finally {
			await close(f.baseDir)
		}
	})

	test("fails closed instead of losing ancestry when the native session disappears", async () => {
		const f = await fixture()
		try {
			f.sessions.delete(f.memberSessionID)
			await expect(f.store.resolveLogicalParent(f.memberSessionID)).rejects.toThrow("cannot be verified with OpenCode")
		} finally {
			await close(f.baseDir)
		}
	})

	test("treats the same lead session in multiple runs as a root instead of ambiguous membership", async () => {
		const f = await fixture()
		try {
			const secondSpec = TeamSpecSchema.parse({
				...teamSpec,
				name: "native-team-second",
			})
			const second = await createRuntimeState(secondSpec, f.leadSessionID, "project", f.config)
			await transitionRuntimeState(second.teamRunId, (current) => ({
				...current,
				members: current.members.map((member) => member.name === "lead"
					? { ...member, sessionId: f.leadSessionID, status: "running" }
					: member),
			}), f.config)
			await f.store.registerRun({
				teamRunId: second.teamRunId,
				teamName: secondSpec.name,
				spec: secondSpec,
				leadSessionID: f.leadSessionID,
				leadMemberName: "lead",
				memberNames: secondSpec.members.map((member) => member.name),
			})
			expect(await f.store.resolveLogicalParent(f.leadSessionID)).toBeUndefined()
		} finally {
			await close(f.baseDir)
		}
	})

	test("a closed tombstone preserves ancestry after runtime files are cleaned", async () => {
		const f = await fixture()
		try {
			await f.store.closeRun(f.runtime.teamRunId)
			await rm(join(f.baseDir, "runtime", f.runtime.teamRunId), { recursive: true, force: true })
			expect(await f.store.resolveLogicalParent(f.memberSessionID)).toBe(f.leadSessionID)
			expect(await f.store.recordForRun(f.runtime.teamRunId)).toMatchObject({ closedAt: expect.any(Number) })
		} finally {
			await close(f.baseDir)
		}
	})

	test("fails closed when Team-created native metadata remains but membership identity is missing", async () => {
		const f = await fixture()
		try {
			f.sessions.set(f.memberSessionID, session(f.memberSessionID, "project-a", "/workspace", undefined, {
				omoTeam: { version: 1, teamRunId: f.runtime.teamRunId, memberName: "worker" },
			}))
			await unlink(join(f.baseDir, "team-memberships", `${encodeURIComponent(f.runtime.teamRunId)}.json`))
			await expect(f.store.resolveLogicalParent(f.memberSessionID)).rejects.toThrow("durable membership record is missing")
		} finally {
			await close(f.baseDir)
		}
	})

	test("fails closed when native lookup errors prevent proving a metadata-hinted session is unmanaged", async () => {
		const f = await fixture()
		try {
			const unreadable = createV2TeamMembershipStore({
				location: f.ctx.location,
				session: {
					get: async () => { throw new Error("host temporarily unavailable") },
				} as unknown as Plugin.Context["session"],
			}, f.config)
			await expect(unreadable.resolveLogicalParent("ses-not-verifiable")).rejects.toThrow("Cannot verify whether session ses-not-verifiable has managed Team ancestry")
		} finally {
			await close(f.baseDir)
		}
	})
})
