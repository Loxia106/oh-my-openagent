import { fromPromise } from "@opencode/plugin/promise/adapter"
import type { Plugin as NativePlugin } from "@opencode/plugin/effect/plugin"
import { setupV2 } from "./setup"
import { withToolFailureBoundary } from "./tool-failure-boundary"

const promiseAdapter = fromPromise({ id: "oh-my-openagent", setup: setupV2 })

/** Native Effect entry with a scoped boundary for OMO's Promise tool callbacks. */
export const opencode2EffectPlugin: NativePlugin = {
	id: "oh-my-openagent",
	effect: (context) => promiseAdapter.effect(withToolFailureBoundary(context)),
}
