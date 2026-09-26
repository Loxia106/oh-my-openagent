import type * as NativePlugin from "@opencode/plugin/effect/plugin"
import { Error as ToolError, type Info as NativeToolInfo } from "@opencode/schema/tool"
import { Effect, Schema } from "effect"

type NativeToolEditor = Parameters<Parameters<NativePlugin.Context["tool"]["transform"]>[0]>[0]
type ToolHookName = Parameters<NativePlugin.Context["tool"]["hook"]>[0]

/**
 * The Promise adapter intentionally uses Effect.promise for Promise callbacks.
 * That turns rejected Tool.Error values into defects, bypassing Core's typed
 * execute.after failure path. Recover only schema-valid Tool.Error defects at
 * this plugin boundary; all unrelated defects and interruptions stay intact.
 */
export function preserveToolErrorFailure<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E | ToolError, R> {
	return Effect.catchDefect(effect, (defect) => {
		if (Schema.is(ToolError)(defect)) return Effect.fail(defect)
		return Effect.die(defect)
	})
}

function wrapToolInfo<Input extends NativeToolInfo["input"], Output extends NativeToolInfo["output"]>(
	tool: NativeToolInfo<Input, Output>,
): NativeToolInfo<Input, Output> {
	return {
		...tool,
		execute: (input, context) => preserveToolErrorFailure(tool.execute(input, context)),
	}
}

function wrapEditor(editor: NativeToolEditor): NativeToolEditor {
	return {
		list: () => editor.list(),
		get: (id) => editor.get(id),
		namespace: (namespace) => editor.namespace(namespace),
		add: (tool) => editor.add(wrapToolInfo(tool)),
		update: (id, update) => editor.update(id, (tool) => {
			update(tool)
			const execute = tool.execute
			tool.execute = (input, context) => preserveToolErrorFailure(execute(input, context))
		}),
		remove: (id) => editor.remove(id),
	}
}

/** Wrap only native tool transforms/hooks registered through this plugin's adapter. */
export function withToolFailureBoundary(context: NativePlugin.Context): NativePlugin.Context {
	const tool = context.tool
	const wrappedTool = new Proxy(tool, {
		get(target, property, receiver) {
			if (property === "transform") {
				return (callback: (editor: NativeToolEditor) => void) =>
					target.transform((editor) => callback(wrapEditor(editor)))
			}
			if (property === "hook") {
				return ((name: ToolHookName, callback: (event: never) => Effect.Effect<void, unknown>) => {
					if (name !== "execute.before") return target.hook(name, callback as never)
					return target.hook(
						name,
						((event: never) => preserveToolErrorFailure(callback(event))) as never,
					)
				}) as typeof target.hook
			}
			return Reflect.get(target, property, receiver)
		},
	})

	return new Proxy(context, {
		get(target, property, receiver) {
			if (property === "tool") return wrappedTool
			return Reflect.get(target, property, receiver)
		},
	})
}
