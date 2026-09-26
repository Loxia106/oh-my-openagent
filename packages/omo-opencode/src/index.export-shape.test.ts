import { describe, expect, it } from "bun:test"
import pluginModule, { omoPlugin } from "./index"
import { setupV2 } from "./v2/setup"

describe("oh-my-openagent plugin export shape", () => {
	it("exposes both V1 server and native V2 setup entrypoints", () => {
		// given
		const defaultServer = pluginModule.server

		// when
		const namedServer = omoPlugin

		// then
		expect(pluginModule.id).toBe("oh-my-openagent")
		expect(typeof defaultServer).toBe("function")
		expect(namedServer).toBe(defaultServer)
		expect(pluginModule.setup).toBe(setupV2)
	})
})
