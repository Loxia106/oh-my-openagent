import type { Plugin } from "@opencode/plugin"
import type { Info, ToolContext, ToolEditor, Result } from "@opencode/plugin/promise/tool"
import type { ValueSchema } from "@opencode/schema/tool"

export type V2ToolContext = ToolContext
export type V2ToolEditor = ToolEditor
export type NativeTool = Info & { readonly id: string }

export function addV2Tool<Input extends ValueSchema<any>, Output extends ValueSchema<any> | undefined = undefined>(
  editor: ToolEditor,
  tool: Omit<Info<Input, Output>, "execute"> & {
    execute: (input: Parameters<Info<Input, Output>["execute"]>[0], context: ToolContext) => Promise<Result<Output>>
  },
): void {
  editor.add(tool as Info<Input, Output>)
}

export async function registerV2ToolTransform(
  ctx: Plugin.Context,
  transform: (editor: ToolEditor) => void,
) {
  return ctx.tool.transform(transform)
}

export function resultText(output: string, metadata?: Record<string, unknown>): Result<undefined> {
  return { content: output, ...(metadata ? { metadata } : {}) }
}
