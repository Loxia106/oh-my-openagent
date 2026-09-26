import { describe, expect, test } from "bun:test"
import { disposeV2ToolRegistrations } from "./tools"

describe("native V2 tool registration cleanup", () => {
  test("attempts every disposer in reverse setup order after one fails", async () => {
    const calls: string[] = []
    await expect(disposeV2ToolRegistrations([
      async () => { calls.push("tools"); throw new Error("tool transform cleanup failed") },
      async () => { calls.push("delegation") },
    ])).rejects.toThrow("One or more V2 tool registrations failed to clean up")
    expect(calls).toEqual(["delegation", "tools"])
  })
})
