import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, posix } from "node:path"

import { createLegacyConfigMigrationPlans, executeLegacyConfigMigrationPlan, REASONING_UNIFICATION_MIGRATION_ID } from "../config-migration"
import { resolveV2DelegationModelSelection } from "../v2/delegation-model-selection"
import { validatePluginConfig } from "./validate"

type Fixture = {
	readonly root: string
	readonly home: string
	readonly project: string
	readonly projectConfig: string
	readonly environment: {
		readonly HOME: string
		readonly XDG_CONFIG_HOME: string
		readonly XDG_DATA_HOME: string
		readonly XDG_STATE_HOME: string
		readonly XDG_CACHE_HOME: string
		readonly OPENCODE_CONFIG_DIR: string
	}
}

function withFixture<T>(name: string, run: (fixture: Fixture) => T): T {
	const root = mkdtempSync(join(tmpdir(), `omo-model-settings-${name}-`))
	const home = join(root, "home")
	const project = join(root, "project")
	const projectConfig = join(project, ".omo", "omo.jsonc")
	mkdirSync(project, { recursive: true })
	const fixture: Fixture = {
		root,
		home,
		project,
		projectConfig,
		environment: {
			HOME: home,
			XDG_CONFIG_HOME: join(home, ".config"),
			XDG_DATA_HOME: join(home, ".local", "share"),
			XDG_STATE_HOME: join(home, ".local", "state"),
			XDG_CACHE_HOME: join(home, ".cache"),
			OPENCODE_CONFIG_DIR: join(root, "opencode-config"),
		},
	}

	try {
		return run(fixture)
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
}

function writeProjectConfig(fixture: Fixture, value: unknown): void {
	mkdirSync(join(fixture.project, ".omo"), { recursive: true })
	writeFileSync(fixture.projectConfig, `${JSON.stringify(value, null, 2)}\n`, "utf-8")
}

function migrateProjectReasoningConfig(fixture: Fixture): Record<string, unknown> {
	const plans = createLegacyConfigMigrationPlans({
		backupTimestamp: "2026-09-27T00-00-00-000Z",
		cwd: fixture.project,
		environment: fixture.environment,
		homeDir: fixture.home,
		pathOperations: posix,
		platform: "linux",
	})
	const plan = plans.find((candidate) =>
		candidate.id === REASONING_UNIFICATION_MIGRATION_ID,
	)
	if (!plan) throw new Error("Expected project reasoning-unification migration plan")

	const result = executeLegacyConfigMigrationPlan(plan, { env: fixture.environment })
	if (result.status !== "migrated") throw new Error(`Expected reasoning migration; received ${result.status}`)
	return JSON.parse(readFileSync(fixture.projectConfig, "utf-8")) as Record<string, unknown>
}

const catalog = [
	{ providerID: "blocked", id: "primary", enabled: true, variants: [] },
	{ providerID: "openai", id: "hoisted", enabled: true, variants: [] },
	{ providerID: "openai", id: "ordered-first", enabled: true, variants: [] },
	{ providerID: "openai", id: "ordered-second", enabled: true, variants: [] },
	{ providerID: "openai", id: "promoted", enabled: true, variants: [] },
	{ providerID: "openai", id: "promoted-later", enabled: true, variants: [] },
	{ providerID: "blocked", id: "category-primary", enabled: true, variants: [] },
	{
		providerID: "openai",
		id: "category-rich",
		enabled: true,
		variants: [{ id: "high", settings: { collision: "variant", variantMarker: true } }],
	},
	{ providerID: "openai", id: "legacy", enabled: true, variants: [] },
]

describe("config migration through validation and V2 delegation model selection", () => {
	test("preserves canonical fallback settings, hoist precedence, and disabled-provider promotion", () => {
		withFixture("migrated", (fixture) => {
			writeProjectConfig(fixture, {
				"[opencode]": {
					disabled_providers: ["blocked"],
					agents: {
						hoisted: {
							maxTokens: 600,
							providerOptions: { baseOnly: true, collision: "base" },
							models: [
								{
									model: "openai/hoisted",
									maxTokens: 1_200,
									providerOptions: { entryOnly: true, collision: "entry" },
								},
								"openai/ordered-first",
							],
						},
						fallbackOnly: {
							fallback_models: [
								{ model: "openai/ordered-first", maxTokens: 1_500, providerOptions: { chainPosition: "first" } },
								{ model: "openai/ordered-second", maxTokens: 2_500, providerOptions: { chainPosition: "second" } },
							],
						},
						promoted: {
							maxTokens: 700,
							providerOptions: { baseOnly: true, collision: "base" },
							models: [
								"blocked/primary",
								{ model: "openai/promoted", maxTokens: 1_800, providerOptions: { promotedOnly: true, collision: "fallback" } },
								{ model: "openai/promoted-later", maxTokens: 2_800, providerOptions: { chainPosition: "later" } },
							],
						},
					},
					categories: {
						"qa-rich": {
							max_tokens: 500,
							provider_options: { categoryBase: true, collision: "base" },
							models: [
								"blocked/category-primary",
								{
									model: "openai/category-rich",
									variant: "high",
									maxTokens: 3_600,
									top_p: 0.82,
									providerOptions: { entryOnly: true, collision: "entry" },
								},
							],
						},
					},
				},
			})

			const migrated = migrateProjectReasoningConfig(fixture)
			const migratedOpenCode = migrated["[opencode]"] as {
				agents: Record<string, { models?: Record<string, unknown>[] }>
				categories: Record<string, { models?: (string | Record<string, unknown>)[] }>
			}
			expect(migratedOpenCode.agents.hoisted.models?.[0]).toMatchObject({
				max_tokens: 1_200,
				provider_options: { entryOnly: true, collision: "entry" },
			})
			expect(migratedOpenCode.agents.fallbackOnly.models?.[0]).toMatchObject({
				model: "openai/ordered-first",
				max_tokens: 1_500,
				provider_options: { chainPosition: "first" },
			})
			expect(migratedOpenCode.categories["qa-rich"].models?.[1]).toMatchObject({
				max_tokens: 3_600,
				provider_options: { entryOnly: true, collision: "entry" },
				reasoning: "high",
			})

			const validation = validatePluginConfig(fixture.project, fixture.environment)
			expect(validation.valid).toBe(true)
			expect(validation.messages).toEqual([])
			expect(validation.config.disabled_providers).toEqual(["blocked"])

			const chooseAgent = (name: string) => resolveV2DelegationModelSelection({
				agentID: "custom-agent",
				catalog,
				disabledProviders: validation.config.disabled_providers,
				agentConfig: validation.config.agents?.[name],
			})
			const hoisted = chooseAgent("hoisted")
			expect(hoisted).toMatchObject({
				model: { providerID: "openai", id: "hoisted" },
				settings: { maxTokens: 1_200, baseOnly: true, entryOnly: true, collision: "entry" },
			})

			const fallbackOnly = chooseAgent("fallbackOnly")
			expect(validation.config.agents?.fallbackOnly?.model).toBe("openai/ordered-first")
			expect(fallbackOnly).toMatchObject({
				model: { providerID: "openai", id: "ordered-first" },
				settings: { maxTokens: 1_500, chainPosition: "first" },
			})

			const promoted = chooseAgent("promoted")
			expect(validation.config.agents?.promoted).toMatchObject({
				model: "openai/promoted",
				maxTokens: 1_800,
				providerOptions: { baseOnly: true, promotedOnly: true, collision: "fallback" },
			})
			expect(promoted).toMatchObject({
				model: { providerID: "openai", id: "promoted" },
				settings: { maxTokens: 1_800, baseOnly: true, promotedOnly: true, collision: "fallback" },
			})

			const category = resolveV2DelegationModelSelection({
				agentID: "custom-agent",
				categoryName: "qa-rich",
				categoryConfig: validation.config.categories?.["qa-rich"],
				catalog,
				disabledProviders: validation.config.disabled_providers,
			})
			expect(category).toMatchObject({
				model: { providerID: "openai", id: "category-rich", variant: "high" },
				settings: {
					maxTokens: 3_600,
					topP: 0.82,
					categoryBase: true,
					entryOnly: true,
					variantMarker: true,
					collision: "variant",
				},
			})
		})
	})

	test("accepts unmigrated legacy maxTokens/providerOptions fallback aliases through validation and selection", () => {
		withFixture("legacy-aliases", (fixture) => {
			writeProjectConfig(fixture, {
				"[opencode]": {
					agents: {
						legacy: {
							model: "openai/not-in-catalog",
							fallback_models: [
								{ model: "openai/legacy", maxTokens: 444, providerOptions: { legacyAlias: true } },
							],
						},
					},
				},
			})

			const validation = validatePluginConfig(fixture.project, fixture.environment)
			expect(validation.valid).toBe(true)
			const selected = resolveV2DelegationModelSelection({
				agentID: "custom-agent",
				agentConfig: validation.config.agents?.legacy,
				catalog,
			})
			expect(selected).toMatchObject({
				model: { providerID: "openai", id: "legacy" },
				settings: { maxTokens: 444, legacyAlias: true },
			})
		})
	})
})
