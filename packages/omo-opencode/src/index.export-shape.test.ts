import { describe, expect, it } from "bun:test"
import pluginModule, { omoPlugin } from "./index"
import { setupV2 } from "./v2/setup"

describe("oh-my-openagent plugin export shape", () => {
	it("exposes V1 server plus native V2 Effect and setup entrypoints", () => {
		// given
		const defaultServer = pluginModule.server

		// when
		const namedServer = omoPlugin

		// then
		expect(pluginModule.id).toBe("oh-my-openagent")
		expect(typeof defaultServer).toBe("function")
		expect(namedServer).toBe(defaultServer)
		expect(pluginModule.setup).toBe(setupV2)
		expect(typeof pluginModule.effect).toBe("function")
	})
})
