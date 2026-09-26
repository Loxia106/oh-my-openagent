/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { join, win32 } from "node:path"
import { tmpdir } from "node:os"
import { findRecentSessionPlanPath } from "./session-plan-affinity"
import { findRecentSessionPlanPathFromNativeMessages, findRecentSessionPlanPathFromMessages } from "./session-plan-paths"
import { unsafeTestValue } from "../../../../../test-support/unsafe-test-value"

type FindRecentSessionPlanPathInput = Parameters<typeof findRecentSessionPlanPath>[0]

describe("findRecentSessionPlanPath", () => {
  test("finds the latest matching plan from native SessionMessageInfo content and tool input", () => {
    const directory = join(tmpdir(), `native-session-plan-affinity-test-${randomUUID()}`)
    const olderPath = join(directory, ".omo", "plans", "older.md")
    const latestPath = join(directory, ".omo", "plans", "latest.md")

    const result = findRecentSessionPlanPathFromNativeMessages({
      directory,
      availablePlans: [olderPath, latestPath],
      messages: [
        { type: "assistant", content: [{ type: "text", text: `Saved ${olderPath}` }] },
        {
          type: "assistant",
          content: [{ type: "tool", state: { status: "completed", input: { path: latestPath } } }],
        },
      ],
    })

    expect(result).toBe(latestPath)
  })

  test("preserves first text candidate in the newest native part and ignores unrelated metadata", () => {
    const directory = join(tmpdir(), `native-session-plan-order-${randomUUID()}`)
    const firstTextPath = join(directory, ".omo", "plans", "first-text.md")
    const secondTextPath = join(directory, ".omo", "plans", "second-text.md")
    const metadataPath = join(directory, ".omo", "plans", "metadata-only.md")

    const result = findRecentSessionPlanPathFromNativeMessages({
      directory,
      availablePlans: [firstTextPath, secondTextPath, metadataPath],
      messages: [{
        type: "assistant",
        content: [{
          type: "text",
          text: `Use ${firstTextPath} before ${secondTextPath}`,
          state: { opaque: { path: metadataPath } },
        }],
        metadata: { debug: { selectedPlan: metadataPath } },
      }],
    })

    expect(result).toBe(firstTextPath)
  })

  test("preserves the legacy first text candidate within the newest part", () => {
    const directory = join(tmpdir(), `legacy-session-plan-order-${randomUUID()}`)
    const firstTextPath = join(directory, ".omo", "plans", "first-text.md")
    const secondTextPath = join(directory, ".omo", "plans", "second-text.md")

    const result = findRecentSessionPlanPathFromMessages({
      directory,
      availablePlans: [firstTextPath, secondTextPath],
      messages: [{ parts: [{ text: `Use ${firstTextPath} before ${secondTextPath}` }] }],
    })

    expect(result).toBe(firstTextPath)
  })

  test("#given session history references omo plan path #when finding recent plan #then returns matching plan", async () => {
    const directory = join(tmpdir(), `session-plan-affinity-test-${randomUUID()}`)
    const planPath = join(directory, ".omo", "plans", "foo-bar.md")
    const client = unsafeTestValue<FindRecentSessionPlanPathInput["client"]>({
      session: {
        messages: async () => ({
          data: [
            {
              parts: [
                {
                  text: "Plan saved to .omo/plans/foo-bar.md",
                },
              ],
            },
          ],
        }),
      },
    })

    const result = await findRecentSessionPlanPath({
      client,
      directory,
      sessionID: "session-123",
      availablePlans: [planPath],
    })

    expect(result).toBe(planPath)
  })

  test("#given session history references Windows short home path #when finding recent plan #then returns matching plan", async () => {
    // given
    const directory = "C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\session-plan-affinity-test"
    const planPath = win32.join(directory, ".omo", "plans", "foo-bar.md")
    const client = unsafeTestValue<FindRecentSessionPlanPathInput["client"]>({
      session: {
        messages: async () => ({
          data: [
            {
              parts: [
                {
                  text: `Plan saved to ${directory}\\.omo\\plans\\foo-bar.md`,
                },
              ],
            },
          ],
        }),
      },
    })

    // when
    const result = await findRecentSessionPlanPath({
      client,
      directory,
      sessionID: "session-123",
      availablePlans: [planPath],
    })

    // then
    expect(result).toBe(planPath)
  })
})
