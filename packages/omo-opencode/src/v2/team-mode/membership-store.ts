import { mkdir, readFile, readdir } from "node:fs/promises"
import { realpathSync } from "node:fs"
import { normalize, resolve, join } from "node:path"
import type { Plugin } from "@opencode/plugin"
import { z } from "zod"
import type { TeamModeConfig } from "@oh-my-opencode/team-core/config"
import { TeamSpecSchema, type TeamSpec } from "@oh-my-opencode/team-core/types"
import { resolveBaseDir } from "@oh-my-opencode/team-core/team-registry"
import { loadRuntimeState } from "@oh-my-opencode/team-core/team-state-store"
import { atomicWrite, withLock } from "@oh-my-opencode/team-core/team-state-store/locks"

const MEMBERSHIP_VERSION = 1
const MEMBERSHIP_DIRECTORY = "team-memberships"


const TeamMemberIdentitySchema = z.object({
	name: z.string().min(1),
	sessionID: z.string().min(1).optional(),
	role: z.enum(["lead", "member"]),
	/** Canonical native worktree Location of an isolated member; absent members share the lead Location. */
	directory: z.string().min(1).optional(),
	turnCount: z.number().int().nonnegative().default(0),
	admittedSyntheticMessageIDs: z.array(z.string().min(1).max(256)).default([]),
}).strict()

const TeamMembershipRecordSchema = z.object({
	version: z.literal(MEMBERSHIP_VERSION),
	teamRunId: z.string().uuid(),
	teamName: z.string().min(1),
	projectID: z.string().min(1),
	directory: z.string().min(1),
	workspaceID: z.string().nullable(),
	leadSessionID: z.string().min(1),
	spec: TeamSpecSchema,
	closedAt: z.number().int().positive().nullable().default(null),
	messageCount: z.number().int().nonnegative().default(0),
	reservedMessageIDs: z.array(z.string().min(1).max(512)).default([]),
	members: z.array(TeamMemberIdentitySchema),
}).strict()

export type V2TeamMembershipRecord = z.infer<typeof TeamMembershipRecordSchema>
export type V2TeamMemberIdentity = z.infer<typeof TeamMemberIdentitySchema>

export class V2TeamMembershipError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options)
		this.name = "V2TeamMembershipError"
	}
}

type RuntimeInfo = Awaited<ReturnType<typeof loadRuntimeState>>
type Location = Plugin.Context["location"]

export type TeamLogicalParentResolver = (sessionID: string) => Promise<string | undefined>

function canonicalDirectory(directory: string): string {
	const absolute = normalize(resolve(directory))
	try {
		return normalize(realpathSync.native(absolute))
	} catch {
		return absolute
	}
}

function membershipDirectory(config: TeamModeConfig): string {
	return join(resolveBaseDir(config), MEMBERSHIP_DIRECTORY)
}

function recordPath(config: TeamModeConfig, teamRunId: string): string {
	return join(membershipDirectory(config), `${encodeURIComponent(teamRunId)}.json`)
}

function lockPath(config: TeamModeConfig, teamRunId: string): string {
	return `${recordPath(config, teamRunId)}.lock`
}

function isMissing(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error &&
		((error as { code?: unknown }).code === "ENOENT" || (error as { code?: unknown }).code === "ENOTDIR")
}

function parseRecord(raw: unknown, path: string): V2TeamMembershipRecord {
	const parsed = TeamMembershipRecordSchema.safeParse(raw)
	if (!parsed.success) {
		throw new V2TeamMembershipError(`Team membership identity is invalid at ${path}; refusing to drop logical ancestry. ${parsed.error.message}`)
	}
	const names = new Set<string>()
	const sessions = new Set<string>()
	for (const member of parsed.data.members) {
		if (names.has(member.name)) throw new V2TeamMembershipError(`Team membership identity at ${path} has duplicate member ${member.name}.`)
		names.add(member.name)
		if (member.sessionID) {
			if (sessions.has(member.sessionID)) throw new V2TeamMembershipError(`Team membership identity at ${path} assigns a session twice.`)
			sessions.add(member.sessionID)
		}
	}
	return parsed.data
}

function assertRuntimeMatches(record: V2TeamMembershipRecord, runtime: RuntimeInfo): void {
	if (runtime.teamRunId !== record.teamRunId || runtime.teamName !== record.teamName || runtime.leadSessionId !== record.leadSessionID) {
		throw new V2TeamMembershipError(`Team ${record.teamRunId} runtime identity disagrees with its durable native membership record.`)
	}
	if (record.spec.name !== record.teamName || record.spec.members.length !== record.members.length ||
		record.spec.members.some((member) => !record.members.some((identity) => identity.name === member.name))) {
		throw new V2TeamMembershipError(`Team ${record.teamRunId} saved TeamSpec disagrees with its durable member roster.`)
	}
	const runtimeNames = new Set(runtime.members.map((member) => member.name))
	if (runtimeNames.size !== record.members.length || record.members.some((member) => !runtimeNames.has(member.name))) {
		throw new V2TeamMembershipError(`Team ${record.teamRunId} member roster disagrees with its durable native membership record.`)
	}
	for (const identity of record.members) {
		if (!identity.sessionID) continue
		const runtimeMember = runtime.members.find((member) => member.name === identity.name)
		if (!runtimeMember || runtimeMember.sessionId !== identity.sessionID) {
			throw new V2TeamMembershipError(`Team ${record.teamRunId} member ${identity.name} disagrees with its persisted session identity.`)
		}
		if ((identity.role === "lead") !== (identity.sessionID === record.leadSessionID)) {
			throw new V2TeamMembershipError(`Team ${record.teamRunId} member ${identity.name} has an inconsistent lead role.`)
		}
	}
}

/** Every Location a run may be evaluated from: the lead's plus each isolated member worktree. */
export function v2TeamRunDirectories(record: V2TeamMembershipRecord): string[] {
	return [...new Set([record.directory, ...record.members.flatMap((member) => member.directory ? [member.directory] : [])])]
}

export function canonicalTeamDirectory(directory: string): string {
	return canonicalDirectory(directory)
}

function assertCurrentLocation(record: V2TeamMembershipRecord, location: Location): void {
	if (record.projectID !== location.project.id ||
		!v2TeamRunDirectories(record).includes(canonicalDirectory(String(location.directory))) ||
		record.workspaceID !== (location.workspaceID ?? null)) {
		throw new V2TeamMembershipError(`Known Team session belongs to another project or workspace; refusing logical-parent resolution for ${record.teamRunId}.`)
	}
}

function identityForSession(record: V2TeamMembershipRecord, sessionID: string): V2TeamMemberIdentity | undefined {
	return record.members.find((member) => member.sessionID === sessionID)
}

export function createV2TeamMembershipStore(
	ctx: Pick<Plugin.Context, "location" | "session">,
	config: TeamModeConfig,
) {
	const directory = membershipDirectory(config)

	async function readRecord(teamRunId: string): Promise<V2TeamMembershipRecord | undefined> {
		const path = recordPath(config, teamRunId)
		try {
			return parseRecord(JSON.parse(await readFile(path, "utf8")), path)
		} catch (error) {
			if (isMissing(error)) return undefined
			throw error
		}
	}

	async function listRecords(): Promise<V2TeamMembershipRecord[]> {
		let entries
		try {
			entries = await readdir(directory, { withFileTypes: true })
		} catch (error) {
			if (isMissing(error)) return []
			throw error
		}
		const records: V2TeamMembershipRecord[] = []
		for (const entry of entries) {
			if (!entry.isFile() || !entry.name.endsWith(".json")) continue
			const path = join(directory, entry.name)
			let raw: unknown
			try {
				raw = JSON.parse(await readFile(path, "utf8"))
			} catch (error) {
				throw new V2TeamMembershipError(`Could not read Team membership identity at ${path}; refusing to bypass logical ancestry.`, { cause: error })
			}
			records.push(parseRecord(raw, path))
		}
		return records
	}

	async function verifyRuntime(record: V2TeamMembershipRecord): Promise<RuntimeInfo | undefined> {
		let runtime: RuntimeInfo
		try {
			runtime = await loadRuntimeState(record.teamRunId, config)
		} catch (error) {
			if (record.closedAt !== null && isMissing(error)) return undefined
			throw new V2TeamMembershipError(`Known Team ${record.teamRunId} has no readable team-core runtime; refusing to drop logical ancestry.`, { cause: error })
		}
		assertRuntimeMatches(record, runtime)
		return runtime
	}

	async function sessionMembership(sessionID: string): Promise<{
		record: V2TeamMembershipRecord
		member: V2TeamMemberIdentity
		runtime?: RuntimeInfo
		session: Awaited<ReturnType<Plugin.Context["session"]["get"]>>
	} | undefined> {
		const records = await listRecords()
		const knownMatches: Array<{ record: V2TeamMembershipRecord; member: V2TeamMemberIdentity }> = []
		for (const record of records) {
			const member = identityForSession(record, sessionID)
			if (member) knownMatches.push({ record, member })
		}
		if (knownMatches.length === 0) {
			// Metadata is only a fail-closed hint, never proof of membership. It
			// prevents a lost sidecar from silently turning a managed child into
			// an unmanaged root after restart.
			let native: Awaited<ReturnType<Plugin.Context["session"]["get"]>>
			try {
				native = await ctx.session.get({ sessionID })
			} catch (error) {
				throw new V2TeamMembershipError(`Cannot verify whether session ${sessionID} has managed Team ancestry.`, { cause: error })
			}
			const metadata = native?.metadata
			const omoTeam = typeof metadata === "object" && metadata !== null && !Array.isArray(metadata)
				? (metadata as Record<string, unknown>).omoTeam
				: undefined
			if (typeof omoTeam === "object" && omoTeam !== null && !Array.isArray(omoTeam) &&
				(omoTeam as Record<string, unknown>).version === 1 && typeof (omoTeam as Record<string, unknown>).teamRunId === "string") {
				throw new V2TeamMembershipError(`Native session ${sessionID} has Team metadata but its durable membership record is missing.`)
			}
			return undefined
		}
		if (knownMatches.every(({ member }) => member.role === "lead")) return undefined
		if (knownMatches.length > 1) {
			// A primary lead can legitimately create several historical/current
			// runs from the same session. A session with any member binding cannot
			// shed that persistent ancestry by also appearing as a lead elsewhere.
			throw new V2TeamMembershipError(`Session ${sessionID} is bound to multiple Team runs; refusing ambiguous membership.`)
		}
		const { record, member } = knownMatches[0]!
		assertCurrentLocation(record, ctx.location)
		const runtime = await verifyRuntime(record)
		let session: Awaited<ReturnType<Plugin.Context["session"]["get"]>>
		try {
			session = await ctx.session.get({ sessionID })
		} catch (error) {
			throw new V2TeamMembershipError(`Known Team session ${sessionID} cannot be verified with OpenCode; refusing to drop logical ancestry.`, { cause: error })
		}
		// A member runs in its own worktree Location when isolated, otherwise in the lead's.
		if (session.id !== sessionID || session.projectID !== ctx.location.project.id ||
			canonicalDirectory(session.location.directory) !== (member.directory ?? record.directory)) {
			throw new V2TeamMembershipError(`OpenCode session ${sessionID} disagrees with its durable Team location.`)
		}
		return { record, member, runtime, session }
	}

	return {
		/** Persist TeamSpec roster and exact OpenCode location before any member session is created. */
		async registerRun(input: {
			teamRunId: string
			teamName: string
			spec: TeamSpec
			leadSessionID: string
			leadMemberName: string
			memberNames: readonly string[]
		}): Promise<void> {
			const runtime = await loadRuntimeState(input.teamRunId, config)
			if (runtime.teamName !== input.teamName || runtime.leadSessionId !== input.leadSessionID) {
				throw new V2TeamMembershipError(`Team ${input.teamRunId} does not match the requested lead identity.`)
			}
			const leadMember = runtime.members.find((member) => member.name === input.leadMemberName)
			if (leadMember?.sessionId !== input.leadSessionID) {
				throw new V2TeamMembershipError(`Team ${input.teamRunId} lead member is not bound to the requested lead session.`)
			}
			const runtimeNames = new Set(runtime.members.map((member) => member.name))
			if (runtimeNames.size !== input.memberNames.length || input.memberNames.some((name) => !runtimeNames.has(name))) {
				throw new V2TeamMembershipError(`Team ${input.teamRunId} roster does not match TeamSpec.`)
			}
			const path = recordPath(config, input.teamRunId)
			await mkdir(directory, { recursive: true, mode: 0o700 })
			await withLock(lockPath(config, input.teamRunId), async () => {
				if (await readRecord(input.teamRunId)) throw new V2TeamMembershipError(`Team ${input.teamRunId} already has a native membership identity.`)
				const record = TeamMembershipRecordSchema.parse({
					version: MEMBERSHIP_VERSION,
					teamRunId: input.teamRunId,
					teamName: input.teamName,
					projectID: ctx.location.project.id,
					directory: canonicalDirectory(String(ctx.location.directory)),
					workspaceID: ctx.location.workspaceID ?? null,
					leadSessionID: input.leadSessionID,
					spec: input.spec,
					closedAt: null,
					messageCount: 0,
					reservedMessageIDs: [],
					members: input.memberNames.map((name) => ({
						name,
						...(name === input.leadMemberName ? { sessionID: input.leadSessionID } : {}),
						role: name === input.leadMemberName ? "lead" : "member",
						turnCount: 0,
					})),
				})
				await atomicWrite(path, `${JSON.stringify(record, null, 2)}\n`)
			})
		},

		/** Bind only after the same session ID is durably present in team-core state. */
		async bindSession(input: { teamRunId: string; memberName: string; sessionID: string }): Promise<V2TeamMembershipRecord> {
			const path = recordPath(config, input.teamRunId)
			return withLock(lockPath(config, input.teamRunId), async () => {
				const record = await readRecord(input.teamRunId)
				if (!record) throw new V2TeamMembershipError(`Team ${input.teamRunId} has no registered native membership identity.`)
				if (record.closedAt !== null) throw new V2TeamMembershipError(`Team ${input.teamRunId} is closed and cannot bind another native session.`)
				const runtime = await verifyRuntime(record)
				if (!runtime) throw new V2TeamMembershipError(`Team ${input.teamRunId} runtime is unavailable; refusing to bind a native session.`)
				const runtimeMember = runtime.members.find((member) => member.name === input.memberName)
				if (!runtimeMember || runtimeMember.sessionId !== input.sessionID) {
					throw new V2TeamMembershipError(`Refusing to bind ${input.sessionID}: team-core has no matching ${input.memberName} session.`)
				}
				const existing = identityForSession(record, input.sessionID)
				if (existing && existing.name !== input.memberName) {
					throw new V2TeamMembershipError(`Session ${input.sessionID} is already bound to Team member ${existing.name}.`)
				}
				const existingMember = record.members.find((member) => member.name === input.memberName)
				if (existingMember?.sessionID && existingMember.sessionID !== input.sessionID) {
					throw new V2TeamMembershipError(`Team member ${input.memberName} already has a different session identity.`)
				}
				const updated = TeamMembershipRecordSchema.parse({
					...record,
					members: record.members.map((member) => member.name === input.memberName
						? { ...member, sessionID: input.sessionID }
						: member),
				})
				await atomicWrite(path, `${JSON.stringify(updated, null, 2)}\n`)
				return updated
			})
		},

		/** Persist an isolated member's native worktree before its session is created, so cleanup can find it. */
		async bindWorktree(input: { teamRunId: string; memberName: string; directory: string }): Promise<V2TeamMembershipRecord> {
			const path = recordPath(config, input.teamRunId)
			return withLock(lockPath(config, input.teamRunId), async () => {
				const record = await readRecord(input.teamRunId)
				if (!record || record.closedAt !== null) throw new V2TeamMembershipError(`Team ${input.teamRunId} is unavailable for a member worktree.`)
				assertCurrentLocation(record, ctx.location)
				const member = record.members.find((entry) => entry.name === input.memberName)
				if (!member || member.role !== "member") throw new V2TeamMembershipError(`Team ${input.teamRunId} has no member ${input.memberName}.`)
				const directory = canonicalDirectory(input.directory)
				if (member.directory && member.directory !== directory) {
					throw new V2TeamMembershipError(`Team member ${input.memberName} already has a different worktree.`)
				}
				const updated = TeamMembershipRecordSchema.parse({
					...record,
					members: record.members.map((entry) => entry.name === input.memberName ? { ...entry, directory } : entry),
				})
				await atomicWrite(path, `${JSON.stringify(updated, null, 2)}\n`)
				return updated
			})
		},

		sessionMembership,

		async resolveLogicalParent(sessionID: string): Promise<string | undefined> {
			const membership = await sessionMembership(sessionID)
			if (!membership || membership.member.role === "lead") return undefined
			// The host's native parent relation is authoritative; only parentless
			// sessions get the durable Team logical edge. Closed runs retain this
			// ancestry: closure disables Team tools but must not turn an old member
			// session into a new permission/admission root.
			if (membership.session.parentID) return undefined
			return membership.record.leadSessionID
		},

		async recordForRun(teamRunId: string): Promise<V2TeamMembershipRecord | undefined> {
			const record = await readRecord(teamRunId)
			if (!record) return undefined
			assertCurrentLocation(record, ctx.location)
			await verifyRuntime(record)
			return record
		},

		async listForLocation(): Promise<V2TeamMembershipRecord[]> {
			const records = await listRecords()
			const current = records.filter((record) => record.closedAt === null && record.projectID === ctx.location.project.id &&
				record.directory === canonicalDirectory(String(ctx.location.directory)) &&
				record.workspaceID === (ctx.location.workspaceID ?? null))
			for (const record of current) await verifyRuntime(record)
			return current
		},

		async closeRun(teamRunId: string): Promise<void> {
			const path = recordPath(config, teamRunId)
			await withLock(lockPath(config, teamRunId), async () => {
				const record = await readRecord(teamRunId)
				if (!record) throw new V2TeamMembershipError(`Team ${teamRunId} has no native membership identity to close.`)
				assertCurrentLocation(record, ctx.location)
				if (record.closedAt !== null) return
				const updated = TeamMembershipRecordSchema.parse({ ...record, closedAt: Date.now() })
				await atomicWrite(path, `${JSON.stringify(updated, null, 2)}\n`)
			})
		},

		async incrementTurnCount(sessionID: string, maximum: number): Promise<number | undefined> {
			for (const record of await listRecords()) {
				if (record.closedAt !== null || !identityForSession(record, sessionID)) continue
				const path = recordPath(config, record.teamRunId)
				return withLock(lockPath(config, record.teamRunId), async () => {
					const current = await readRecord(record.teamRunId)
					if (!current || current.closedAt !== null) throw new V2TeamMembershipError(`Team ${record.teamRunId} is closed.`)
					const member = identityForSession(current, sessionID)
					if (!member) throw new V2TeamMembershipError(`Team member session ${sessionID} lost its identity during turn accounting.`)
					if (member.role === "lead") return member.turnCount
					if (member.turnCount >= maximum) throw new V2TeamMembershipError(`Team member ${member.name} exceeded max_member_turns (${maximum}).`)
					const next = TeamMembershipRecordSchema.parse({
						...current,
						members: current.members.map((entry) => entry.name === member.name ? { ...entry, turnCount: entry.turnCount + 1 } : entry),
					})
					await atomicWrite(path, `${JSON.stringify(next, null, 2)}\n`)
					return member.turnCount + 1
				})
			}
			return undefined
		},

		/** Count a manager-owned synthetic mailbox prompt once, even if delivery retries. */
		async admitSyntheticTurn(sessionID: string, messageID: string, maximum: number): Promise<{ turnCount: number; newlyAdmitted: boolean } | undefined> {
			if (!messageID || messageID.length > 256) throw new V2TeamMembershipError("Synthetic Team message ID is invalid.")
			for (const record of await listRecords()) {
				if (record.closedAt !== null || !identityForSession(record, sessionID)) continue
				const path = recordPath(config, record.teamRunId)
				return withLock(lockPath(config, record.teamRunId), async () => {
					const current = await readRecord(record.teamRunId)
					if (!current || current.closedAt !== null) throw new V2TeamMembershipError(`Team ${record.teamRunId} is closed.`)
					const member = identityForSession(current, sessionID)
					if (!member) throw new V2TeamMembershipError(`Team member session ${sessionID} lost its identity during synthetic turn accounting.`)
					if (member.role === "lead") return { turnCount: member.turnCount, newlyAdmitted: false }
					if (member.admittedSyntheticMessageIDs.includes(messageID)) {
						return { turnCount: member.turnCount, newlyAdmitted: false }
					}
					if (member.turnCount >= maximum) {
						throw new V2TeamMembershipError(`Team member ${member.name} exceeded max_member_turns (${maximum}).`)
					}
					const next = TeamMembershipRecordSchema.parse({
						...current,
						members: current.members.map((entry) => entry.name === member.name
							? { ...entry, turnCount: entry.turnCount + 1, admittedSyntheticMessageIDs: [...entry.admittedSyntheticMessageIDs, messageID] }
							: entry),
					})
					await atomicWrite(path, `${JSON.stringify(next, null, 2)}\n`)
					return { turnCount: member.turnCount + 1, newlyAdmitted: true }
				})
			}
			return undefined
		},

		async reserveMessage(teamRunId: string, maximum: number, messageID?: string): Promise<number> {
			if (messageID !== undefined && (!messageID || messageID.length > 512)) {
				throw new V2TeamMembershipError("Team message reservation ID is invalid.")
			}
			const path = recordPath(config, teamRunId)
			return withLock(lockPath(config, teamRunId), async () => {
				const record = await readRecord(teamRunId)
				if (!record || record.closedAt !== null) throw new V2TeamMembershipError(`Team ${teamRunId} is unavailable for new messages.`)
				assertCurrentLocation(record, ctx.location)
				if (messageID !== undefined && record.reservedMessageIDs.includes(messageID)) return record.messageCount
				if (record.messageCount >= maximum) throw new V2TeamMembershipError(`Team ${teamRunId} exceeded max_messages_per_run (${maximum}).`)
				const next = TeamMembershipRecordSchema.parse({
					...record,
					messageCount: record.messageCount + 1,
					...(messageID === undefined ? {} : { reservedMessageIDs: [...record.reservedMessageIDs, messageID] }),
				})
				await atomicWrite(path, `${JSON.stringify(next, null, 2)}\n`)
				return next.messageCount
			})
		},
	}
}
