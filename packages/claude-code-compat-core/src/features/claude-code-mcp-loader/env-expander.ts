import { expandEnvReferences, expandEnvReferencesInObject } from "@oh-my-opencode/utils"
import { log } from "../../shared/logger"
import {
  getAllowedMcpEnvVars,
  isAllowedMcpEnvVar,
  isSensitiveMcpEnvVar,
} from "./configure-allowed-env-vars"

export interface ExpandEnvVarsOptions {
  trusted?: boolean
  /** Per-load additions. When present, do not consult the legacy mutable global additions. */
  additionalAllowedMcpEnvVars?: readonly string[]
}

export function expandEnvVars(value: string, options: ExpandEnvVarsOptions = {}): string {
  const { trusted = false, additionalAllowedMcpEnvVars } = options
  const allowedVars = additionalAllowedMcpEnvVars === undefined
    ? undefined
    : getAllowedMcpEnvVars(additionalAllowedMcpEnvVars)
  return expandEnvReferences(value, {
    trusted,
    isAllowed: allowedVars ? (varName) => allowedVars.has(varName) : isAllowedMcpEnvVar,
    onBlocked: (varName) => {
      const isSensitive = isSensitiveMcpEnvVar(varName)
      const reason = isSensitive ? "sensitive variable" : "not in allowlist"

      log(`Blocked MCP env var expansion for ${reason} "${varName}"`, {
        varName,
        sensitive: isSensitive,
      })
    },
  })
}

export function expandEnvVarsInObject<T>(obj: T, options: ExpandEnvVarsOptions = {}): T {
  const { trusted = false, additionalAllowedMcpEnvVars } = options
  const allowedVars = additionalAllowedMcpEnvVars === undefined
    ? undefined
    : getAllowedMcpEnvVars(additionalAllowedMcpEnvVars)
  return expandEnvReferencesInObject(obj, {
    trusted,
    isAllowed: allowedVars ? (varName) => allowedVars.has(varName) : isAllowedMcpEnvVar,
    onBlocked: (varName) => {
      const isSensitive = isSensitiveMcpEnvVar(varName)
      const reason = isSensitive ? "sensitive variable" : "not in allowlist"

      log(`Blocked MCP env var expansion for ${reason} "${varName}"`, {
        varName,
        sensitive: isSensitive,
      })
    },
  }) as T
}
