import { describe, expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin"
import { readSessionHistory, sessionStatus } from "./session-history"

describe("native V2 session history", () => {
  test("uses current run start time instead of stale last-run outcome", () => {
    expect(sessionStatus({ outcome: "succeeded", time: { idle: 100 } }, 200)).toBe("running")
    expect(sessionStatus({ outcome: "failed", time: { idle: 250 } }, 200)).toBe("failed")
    expect(sessionStatus({ outcome: "succeeded", time: { idle: 250 } }, undefined)).toBe("unknown")
  })

  test("selects the latest messages before applying a history limit", async () => {
    const messages = Array.from({ length: 250 }, (_, index) => ({
      id: `msg-${index}`,
      type: index === 249 ? "assistant" : "user",
      text: `message ${index}`,
      content: index === 249 ? [{ type: "text", text: "latest answer" }] : undefined,
    }))
    const ctx = { session: { context: async () => messages } } as unknown as Plugin.Context

    const result = await readSessionHistory(ctx, "ses-long", { fullSession: true, messageLimit: 1, fromEnd: true })
    expect(result).toBe("assistant: latest answer")
  })

  test("reports a missing sinceMessageID instead of silently returning unrelated history", async () => {
    const ctx = { session: { context: async () => [{ id: "msg-a", type: "user", text: "hello" }] } } as unknown as Plugin.Context
    await expect(readSessionHistory(ctx, "ses-a", { fullSession: true, sinceMessageID: "missing" }))
      .resolves.toContain("Message ID not found in session history: missing")
  })
})
