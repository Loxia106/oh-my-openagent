import { describe, expect, test } from "bun:test"
import { btwQuestion } from "./tui"

describe("native OpenCode 2 TUI helpers", () => {
	test("accepts slash-command arguments and full BTW drafts", () => {
		expect(btwQuestion("What changed in this branch?")).toBe("What changed in this branch?")
		expect(btwQuestion("/omo-btw What changed in this branch?")).toBe("What changed in this branch?")
		expect(btwQuestion("  /side  inspect the tests  ")).toBe("inspect the tests")
	})

	test("leaves an empty command for the prompt dialog", () => {
		expect(btwQuestion(undefined)).toBe("")
		expect(btwQuestion("/omo-btw")).toBe("")
	})

	test("does not claim the host's native /btw command", () => {
		expect(btwQuestion("/btw keep OpenCode's native command")).toBe("/btw keep OpenCode's native command")
	})
})
