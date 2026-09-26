import type { PluginInput } from "@opencode-ai/plugin"
import { normalizeSDKResponse } from "../../shared"
import { log } from "../../shared/logger"
import { findRecentSessionPlanPathFromMessages } from "./session-plan-paths"
export { findRecentSessionPlanPathFromMessages } from "./session-plan-paths"

interface SessionMessagePart {
  text?: string
  output?: string
  input?: Record<string, unknown>
}

interface SessionMessage {
  parts?: SessionMessagePart[]
}

export async function findRecentSessionPlanPath(input: {
  client: PluginInput["client"]
  directory: string
  sessionID: string
  availablePlans: string[]
}): Promise<string | null> {
  if (typeof input.client.session?.messages !== "function") {
    return null
  }

  try {
    const response = await input.client.session.messages({ path: { id: input.sessionID } })
    const messages = normalizeSDKResponse(response, [] as SessionMessage[])
    return findRecentSessionPlanPathFromMessages({ ...input, messages })
  } catch (error) {
    log("[ulw-execute] Failed to inspect session history for preferred plan", {
      sessionID: input.sessionID,
      error: String(error),
    })
  }

  return null
}
