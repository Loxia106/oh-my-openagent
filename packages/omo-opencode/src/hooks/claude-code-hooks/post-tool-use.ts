import type {
  PostToolUseInput,
  PostToolUseFailureInput,
  PostToolUseOutput,
  ClaudeHooksConfig,
} from "./types"
import { findMatchingHooks, objectToSnakeCase, transformToolName, log } from "../../shared"
import { dispatchHook, getHookIdentifier } from "./dispatch-hook"
import { buildTranscriptFromSession, deleteTempTranscript } from "./transcript"
import { isHookCommandDisabled, type PluginExtendedConfig } from "./config-loader"
import { normalizeHookText } from "./hook-text"

export interface PostToolUseClient {
  session: {
    messages: (opts: { path: { id: string }; query?: { directory: string } }) => Promise<unknown>
  }
}

export interface PostToolUseContext {
  sessionId: string
  toolName: string
  toolInput: Record<string, unknown>
  toolOutput: Record<string, unknown>
  cwd: string
  transcriptPath?: string  // Fallback for append-based transcript
  /** Preserve native tool schema keys when adapting plugin V2 inputs. */
  preserveInputKeys?: boolean
  /** Preserve native result keys when adapting plugin V2 outputs. */
  preserveOutputKeys?: boolean
  hookEventName?: "PostToolUse" | "PostToolUseFailure"
  failure?: { message: string; isInterrupt?: boolean }
  toolUseId?: string
  client?: PostToolUseClient
  permissionMode?: "default" | "plan" | "acceptEdits" | "bypassPermissions"
}

export interface PostToolUseResult {
  block: boolean
  reason?: string
  message?: string
  warnings?: string[]
  elapsedMs?: number
  hookName?: string
  toolName?: string
  additionalContext?: string
  continue?: boolean
  stopReason?: string
  suppressOutput?: boolean
  systemMessage?: string
}

function joinedMessages(messages: readonly string[]): string | undefined {
  return messages.length > 0 ? messages.join("\n\n") : undefined
}

export async function executePostToolUseHooks(
  ctx: PostToolUseContext,
  config: ClaudeHooksConfig | null,
  extendedConfig?: PluginExtendedConfig | null
): Promise<PostToolUseResult> {
  if (!config) {
    return { block: false }
  }

  const transformedToolName = transformToolName(ctx.toolName)
  const hookEventName = ctx.hookEventName ?? "PostToolUse"
  const matchers = findMatchingHooks(config, hookEventName, transformedToolName)
  if (matchers.length === 0) {
    return { block: false }
  }

  // PORT FROM DISABLED: Build Claude Code compatible transcript (temp file)
  let tempTranscriptPath: string | null = null

  try {
    // Try to build full transcript from API if client available
    if (ctx.client) {
      tempTranscriptPath = await buildTranscriptFromSession(
        ctx.client,
        ctx.sessionId,
        ctx.cwd,
        ctx.toolName,
        ctx.toolInput
      )
    }

    const common = {
      session_id: ctx.sessionId,
      // Use temp transcript if available, otherwise fallback to append-based
      transcript_path: tempTranscriptPath ?? ctx.transcriptPath,
      cwd: ctx.cwd,
      permission_mode: ctx.permissionMode ?? "bypassPermissions",
      tool_name: transformedToolName,
      tool_input: ctx.preserveInputKeys ? ctx.toolInput : objectToSnakeCase(ctx.toolInput),
      tool_use_id: ctx.toolUseId,
      hook_source: "opencode-plugin" as const,
    }
    const stdinData: PostToolUseInput | PostToolUseFailureInput = hookEventName === "PostToolUseFailure"
      ? {
          ...common,
          hook_event_name: "PostToolUseFailure",
          error: ctx.failure?.message ?? "Tool failed",
          ...(ctx.failure?.isInterrupt ? { is_interrupt: true } : {}),
        }
      : {
          ...common,
          hook_event_name: "PostToolUse",
          tool_response: ctx.preserveOutputKeys ? ctx.toolOutput : objectToSnakeCase(ctx.toolOutput),
        }

    const messages: string[] = []
    const warnings: string[] = []
    let firstHookName: string | undefined

    const startTime = Date.now()

     for (const matcher of matchers) {
       if (!matcher.hooks || matcher.hooks.length === 0) continue
       for (const hook of matcher.hooks) {
         if (hook.type !== "command" && hook.type !== "http") continue

        const hookName = getHookIdentifier(hook)
        if (isHookCommandDisabled(hookEventName, hookName, extendedConfig ?? null)) {
          log(`${hookEventName} hook command skipped (disabled by config)`, { command: hookName, toolName: ctx.toolName })
          continue
        }

        if (!firstHookName) firstHookName = hookName

        const result = await dispatchHook(hook, JSON.stringify(stdinData), ctx.cwd)

        if (result.exitCode === 2) {
          const stderr = normalizeHookText(result.stderr)
          if (stderr !== undefined) {
            warnings.push(`[${hookName}]\n${stderr}`)
          }
          continue
        }

        if (result.exitCode === 0 && result.stdout) {
          try {
            const output = JSON.parse(result.stdout || "{}") as PostToolUseOutput
            const additionalContext = normalizeHookText(output.hookSpecificOutput?.additionalContext)
            if (output.decision === "block") {
              return {
                block: true,
                reason: normalizeHookText(output.reason) ?? normalizeHookText(result.stderr),
                message: joinedMessages(messages),
                warnings: warnings.length > 0 ? warnings : undefined,
                elapsedMs: Date.now() - startTime,
                hookName: firstHookName,
                toolName: transformedToolName,
                additionalContext,
                continue: output.continue,
                stopReason: normalizeHookText(output.stopReason),
                suppressOutput: output.suppressOutput,
                systemMessage: normalizeHookText(output.systemMessage),
              }
            }
            if (additionalContext || output.continue !== undefined || output.systemMessage || output.suppressOutput === true || output.stopReason !== undefined) {
              return {
                block: false,
                message: joinedMessages(messages),
                warnings: warnings.length > 0 ? warnings : undefined,
                elapsedMs: Date.now() - startTime,
                hookName: firstHookName,
                toolName: transformedToolName,
                additionalContext,
                continue: output.continue,
                stopReason: normalizeHookText(output.stopReason),
                suppressOutput: output.suppressOutput,
                systemMessage: normalizeHookText(output.systemMessage),
              }
            }
          } catch (error) {
            if (!(error instanceof Error)) {
              throw error
            }
            const stdout = normalizeHookText(result.stdout)
            if (stdout !== undefined) {
              messages.push(stdout)
            }
          }
        } else if (result.exitCode !== 0 && result.exitCode !== 2) {
          try {
            const output = JSON.parse(result.stdout || "{}") as PostToolUseOutput
            const additionalContext = normalizeHookText(output.hookSpecificOutput?.additionalContext)
            if (output.decision === "block") {
              return {
                block: true,
                reason: normalizeHookText(output.reason) ?? normalizeHookText(result.stderr),
                message: joinedMessages(messages),
                warnings: warnings.length > 0 ? warnings : undefined,
                elapsedMs: Date.now() - startTime,
                hookName: firstHookName,
                toolName: transformedToolName,
                additionalContext,
                continue: output.continue,
                stopReason: normalizeHookText(output.stopReason),
                suppressOutput: output.suppressOutput,
                systemMessage: normalizeHookText(output.systemMessage),
              }
            }
          } catch (error) {
            if (!(error instanceof Error)) {
              throw error
            }
            const stdout = normalizeHookText(result.stdout)
            if (stdout !== undefined) {
              messages.push(stdout)
            }
          }
        }
      }
    }

    const elapsedMs = Date.now() - startTime

    return {
      block: false,
      message: joinedMessages(messages),
      warnings: warnings.length > 0 ? warnings : undefined,
      elapsedMs,
      hookName: firstHookName,
      toolName: transformedToolName,
    }
  } finally {
    // PORT FROM DISABLED: Cleanup temp file to avoid disk accumulation
    deleteTempTranscript(tempTranscriptPath)
  }
}
