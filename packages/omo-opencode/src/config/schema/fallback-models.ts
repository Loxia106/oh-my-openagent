import { OmoReasoningSchema } from "@oh-my-opencode/omo-config-core"
import { z } from "zod"

export const FallbackModelObjectSchema = z.object({
  model: z.string(),
  reasoning: OmoReasoningSchema.optional(),
  /** @deprecated Use `reasoning` instead. */
  variant: z.string().optional(),
  /** @deprecated Use `reasoning` instead. */
  reasoningEffort: z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max"]).optional(),
  temperature: z.number().min(0).max(2).optional(),
  top_p: z.number().min(0).max(1).optional(),
  /** Canonical OMO model-ref spelling, normalized to native `maxTokens` at selection time. */
  max_tokens: z.number().int().positive().optional(),
  /** Canonical OMO provider request options, flattened by the native adapter. */
  provider_options: z.record(z.string(), z.unknown()).optional(),
  /** Legacy OpenCode spelling retained for configs that have not been migrated yet. */
  maxTokens: z.number().optional(),
  /** Legacy OpenCode spelling retained for configs that have not been migrated yet. */
  providerOptions: z.record(z.string(), z.unknown()).optional(),
  /** Legacy OpenCode setting; canonical configs carry this inside `provider_options`. */
  textVerbosity: z.enum(["low", "medium", "high"]).optional(),
  thinking: z
    .object({
      type: z.enum(["enabled", "disabled"]),
      budgetTokens: z.number().optional(),
    })
    .optional(),
})

export type FallbackModelObject = z.infer<typeof FallbackModelObjectSchema>

export const FallbackModelStringArraySchema = z.array(z.string())
export const FallbackModelObjectArraySchema = z.array(FallbackModelObjectSchema)
export const FallbackModelMixedArraySchema = z.array(z.union([z.string(), FallbackModelObjectSchema]))

export const FallbackModelsSchema = z.union([
  z.string(),
  FallbackModelStringArraySchema,
  FallbackModelObjectArraySchema,
  FallbackModelMixedArraySchema,
])

export type FallbackModels = z.infer<typeof FallbackModelsSchema>
