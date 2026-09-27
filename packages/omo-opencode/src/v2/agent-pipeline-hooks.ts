import type { Plugin } from "@opencode/plugin"
import type { SessionContext, SessionPrompt } from "@opencode/plugin/promise/session"
import type { OhMyOpenCodeConfig } from "../config"
import { isGptModel, isGpt6Model, isGptNativeSisyphusModel } from "../agents/types"
import { isHephaestusSupportedModel } from "../agents/hephaestus"
import type { LoadedSkill } from "../features/opencode-skill-loader/types"
import { getAgentConfigKey } from "../shared/agent-display-names"
import { log } from "../shared/logger"
import { createV2BuiltinAgentPromptRenderer, isV2BuiltinAgentEnabled } from "./agents"
import { isV2DelegationSessionInLocation } from "./delegation-settings"
import type { V2ModelCatalog, V2ModelCatalogSnapshot } from "./model-resolution"
import { getV2SubagentRunState } from "./task-state"

type AgentID = string
type AgentInfo = Awaited<ReturnType<Plugin.Context["agent"]["get"]>>["data"]
type AgentMode = AgentInfo["mode"]
type SessionInfo = Awaited<ReturnType<Plugin.Context["session"]["get"]>>

const MODEL_POLICY_HOOKS = ["no-sisyphus-gpt", "no-hephaestus-non-gpt"] as const

function isPrimaryMode(mode: AgentMode): boolean {
	return mode === "primary" || mode === "all"
}

/**
 * Team metadata is a conservative ancestry hint only. It is not sufficient to
 * authorize Team tools or prove membership; the membership store requires its
 * durable sidecar for those decisions.
 */
function hasV2TeamMetadataHint(metadata: unknown): boolean {
	if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) return false
	const team = (metadata as Record<string, unknown>).omoTeam
	return typeof team === "object" && team !== null && !Array.isArray(team) &&
		(team as Record<string, unknown>).version === 1 && typeof (team as Record<string, unknown>).teamRunId === "string"
}

function effectiveModelRef(
	session: SessionInfo,
	agent: AgentInfo,
	catalog: V2ModelCatalogSnapshot,
): { readonly providerID: string; readonly id: string; readonly variant?: string } | undefined {
	const selected = session.model ?? agent.model
	if (selected) return {
		providerID: String(selected.providerID),
		id: String(selected.id),
		...(selected.variant && selected.variant !== "default" ? { variant: String(selected.variant) } : {}),
	}
	const hostDefault = catalog.defaultModel
	return hostDefault
		? { providerID: hostDefault.providerID, id: hostDefault.modelID }
		: undefined
}

function policyTarget(
	agent: string,
	modelID: string,
	config: OhMyOpenCodeConfig,
): "hephaestus" | "sisyphus" | undefined {
	if (agent === "sisyphus" && !config.disabled_hooks?.includes("no-sisyphus-gpt") &&
		isGptModel(modelID) && !isGptNativeSisyphusModel(modelID) && !isGpt6Model(modelID)) {
		return "hephaestus"
	}
	if (agent === "hephaestus" && !config.disabled_hooks?.includes("no-hephaestus-non-gpt") &&
		!isGptModel(modelID) && config.agents?.hephaestus?.allow_non_gpt_model !== true) {
		return "sisyphus"
	}
	return undefined
}

async function enabledPrimaryAgent(
	ctx: Plugin.Context,
	config: OhMyOpenCodeConfig,
	name: "sisyphus" | "hephaestus",
): Promise<AgentInfo> {
	if (!isV2BuiltinAgentEnabled(config, name)) {
		throw new Error(`Cannot route this session to ${name}: the target OMO agent is disabled or unavailable.`)
	}
	let info: AgentInfo
	try {
		info = (await ctx.agent.get({ agentID: name })).data
	} catch (error) {
		throw new Error(`Cannot route this session to ${name}: the target OMO agent is not registered.`, { cause: error })
	}
	if (info.hidden || !isPrimaryMode(info.mode)) {
		throw new Error(`Cannot route this session to ${name}: the target OMO agent is not an available primary agent.`)
	}
	return info
}

async function applyPrimaryModelPolicy(
	ctx: Plugin.Context,
	config: OhMyOpenCodeConfig,
	catalog: V2ModelCatalog,
	active: () => boolean,
	input: SessionPrompt,
): Promise<void> {
	if (!active()) return
	let session: SessionInfo
	try {
		session = await ctx.session.get({ sessionID: input.sessionID })
	} catch {
		return
	}
	if (!active() || !isV2DelegationSessionInLocation(session, ctx.location) || session.parentID ||
		hasV2TeamMetadataHint(session.metadata) || !session.agent) return

	let managedRun
	try {
		managedRun = await getV2SubagentRunState(ctx.storage).get(input.sessionID)
	} catch (error) {
		throw new Error(`Cannot verify whether session ${input.sessionID} is an OMO-managed child; refusing agent-policy mutation.`, { cause: error })
	}
	// Team members are logical children without a native Session.parentID. Their
	// shared run record is the ownership boundary; never redirect their identity.
	if (!active() || managedRun) return

	const currentAgentID = String(session.agent) as AgentID
	const currentName = getAgentConfigKey(currentAgentID)
	if (currentName !== "sisyphus" && currentName !== "hephaestus") return
	if (!isV2BuiltinAgentEnabled(config, currentName)) return

	let currentInfo: AgentInfo
	try {
		currentInfo = (await ctx.agent.get({ agentID: currentAgentID })).data
	} catch {
		return
	}
	if (!active() || currentInfo.hidden || !isPrimaryMode(currentInfo.mode)) return

	const selectedModel = effectiveModelRef(session, currentInfo, catalog.snapshot)
	if (!selectedModel) return
	const target = policyTarget(currentName, selectedModel.id, config)
	if (!target) return

	await enabledPrimaryAgent(ctx, config, target)
	if (!active()) return
	// Model and agent can change while the target is being loaded. Re-read the
	// native session and ownership record immediately before applying the redirect.
	let latestSession: SessionInfo
	try {
		latestSession = await ctx.session.get({ sessionID: input.sessionID })
	} catch {
		return
	}
	if (!active() || !isV2DelegationSessionInLocation(latestSession, ctx.location) ||
		latestSession.parentID || hasV2TeamMetadataHint(latestSession.metadata) || latestSession.agent !== session.agent) return
	const latestRun = await getV2SubagentRunState(ctx.storage).get(input.sessionID)
	if (!active() || latestRun) return
	const latestModel = effectiveModelRef(latestSession, currentInfo, catalog.snapshot)
	if (!latestModel || latestModel.providerID !== selectedModel.providerID || latestModel.id !== selectedModel.id ||
		latestModel.variant !== selectedModel.variant) return
	await ctx.session.switchAgent({ sessionID: input.sessionID, agent: target })
	log(`[v2 agent policy] Routed primary session ${input.sessionID} from ${currentName} to ${target} for model ${selectedModel.providerID}/${selectedModel.id}.`)
}

function replaceExactRegisteredPrompt(input: {
	readonly system: SessionContext["system"]
	readonly registeredPrompt: string | undefined
	readonly renderedPrompt: string | undefined
}): boolean {
	const { system, registeredPrompt, renderedPrompt } = input
	if (!registeredPrompt || !renderedPrompt || registeredPrompt === renderedPrompt) return false
	let match: { readonly index: number; readonly start: number } | undefined
	for (let index = 0; index < system.length; index += 1) {
		const part = system[index]
		if (part.type !== "text") continue
		let from = 0
		while (true) {
			const start = part.text.indexOf(registeredPrompt, from)
			if (start < 0) break
			if (match) return false
			match = { index, start }
			from = start + registeredPrompt.length
		}
	}
	if (!match) return false
	const part = system[match.index]
	system[match.index] = {
		...part,
		text: `${part.text.slice(0, match.start)}${renderedPrompt}${part.text.slice(match.start + registeredPrompt.length)}`,
	}
	return true
}

async function renderSelectedAgentPrompt(
	ctx: Plugin.Context,
	config: OhMyOpenCodeConfig,
	render: (agentName: string, model: string) => string | undefined,
	active: () => boolean,
	input: SessionContext,
): Promise<void> {
	if (!active()) return
	const agentID = String(input.agent)
	const agentName = getAgentConfigKey(agentID)
	if (!isV2BuiltinAgentEnabled(config, agentName)) return
	let agent: AgentInfo
	try {
		agent = (await ctx.agent.get({ agentID })).data
	} catch {
		return
	}
	if (!active() || agent.hidden || typeof agent.system !== "string") return
	const model = `${input.model.providerID}/${input.model.id}`
	if (agentName === "hephaestus" && !isHephaestusSupportedModel(model)) return
	if (!active()) return
	const next = render(agentName, model)
	replaceExactRegisteredPrompt({
		system: input.system,
		registeredPrompt: agent.system,
		renderedPrompt: next,
	})
}

/**
 * Register the V1 primary-agent model guards and model-aware builtin prompts.
 * Setup performs no public catalog calls; all API reads happen on an actual hook.
 */
export async function registerV2AgentPipelineHooks(
	ctx: Plugin.Context,
	config: OhMyOpenCodeConfig,
	loadedSkills: readonly LoadedSkill[],
	catalog: V2ModelCatalog,
): Promise<() => Promise<void>> {
	let active = true
	const registrations: Array<Awaited<ReturnType<typeof ctx.session.hook>>> = []
	const enabledPolicies = MODEL_POLICY_HOOKS.some((name) => !config.disabled_hooks?.includes(name))
	const directory = String(ctx.location.directory)
	let rendererSnapshot = catalog.snapshot
	let renderPrompt = createV2BuiltinAgentPromptRenderer({ config, catalog: rendererSnapshot, loadedSkills, directory })
	const renderForCurrentModel = (agentName: string, model: string) => {
		// The native config transform can replace its catalog snapshot after startup.
		// Refresh this pure renderer lazily; never query public catalogs during setup.
		if (rendererSnapshot !== catalog.snapshot) {
			rendererSnapshot = catalog.snapshot
			renderPrompt = createV2BuiltinAgentPromptRenderer({ config, catalog: rendererSnapshot, loadedSkills, directory })
		}
		return renderPrompt(agentName, model)
	}
	try {
		if (enabledPolicies) {
			registrations.push(await ctx.session.hook("prompt", async (input: SessionPrompt) => {
				await applyPrimaryModelPolicy(ctx, config, catalog, () => active, input)
			}))
		}
		registrations.push(await ctx.session.hook("context", async (input: SessionContext) => {
			await renderSelectedAgentPrompt(ctx, config, renderForCurrentModel, () => active, input)
		}))
	} catch (error) {
		active = false
		const cleanupErrors: unknown[] = []
		for (const registration of registrations.reverse()) {
			try {
				await registration.dispose()
			} catch (cleanupError) {
				cleanupErrors.push(cleanupError)
			}
		}
		if (cleanupErrors.length > 0) throw new AggregateError([error, ...cleanupErrors], "V2 agent pipeline hook registration failed and cleanup was incomplete")
		throw error
	}

	let disposed = false
	return async () => {
		if (disposed) return
		disposed = true
		active = false
		const errors: unknown[] = []
		for (const registration of registrations.reverse()) {
			try {
				await registration.dispose()
			} catch (error) {
				errors.push(error)
			}
		}
		if (errors.length > 0) throw new AggregateError(errors, "V2 agent pipeline hook cleanup was incomplete")
	}
}
