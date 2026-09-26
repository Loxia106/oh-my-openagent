import type { Plugin } from "@opencode/plugin"
import { Error as ToolError, type Info, type ToolContext, type ToolEditor } from "@opencode/plugin/promise/tool"
import { z } from "zod"
import type { OhMyOpenCodeConfig } from "../config"
import { applyHashlineEditsWithReport } from "../tools/hashline-edit/edit-operations"
import { generateUnifiedDiff, countLineDiffs } from "../tools/hashline-edit/diff-utils"
import { canonicalizeFileText, restoreFileText } from "../tools/hashline-edit/file-text-canonicalization"
import { normalizeHashlineEdits, type RawHashlineEdit } from "../tools/hashline-edit/normalize-edits"
import { HASHLINE_EDIT_DESCRIPTION } from "../tools/hashline-edit/tool-description"
import { addV2Tool } from "./tool-adapter"

type NativeTool = Info & { readonly id: string }
type StringRecord = Record<string, unknown>

const nativePathInput = z.object({
  path: z.string().optional(),
  filePath: z.string().optional(),
  offset: z.number().int().nonnegative().optional(),
  limit: z.number().int().nonnegative().optional(),
}).superRefine((args, context) => {
  if (!args.path && !args.filePath) context.addIssue({ code: "custom", message: "Provide path or filePath." })
  if (args.path && args.filePath && args.path !== args.filePath) {
    context.addIssue({ code: "custom", message: "path and filePath must refer to the same file." })
  }
})

const nativeEditInput = z.object({
  path: z.string().optional(),
  filePath: z.string().optional(),
  oldString: z.string(),
  newString: z.string(),
  replaceAll: z.boolean().optional(),
}).superRefine((args, context) => {
  if (!args.path && !args.filePath) context.addIssue({ code: "custom", message: "Provide path or filePath." })
  if (args.path && args.filePath && args.path !== args.filePath) {
    context.addIssue({ code: "custom", message: "path and filePath must refer to the same file." })
  }
})

const nativeWriteInput = z.object({
  path: z.string().optional(),
  filePath: z.string().optional(),
  content: z.string(),
}).superRefine((args, context) => {
  if (!args.path && !args.filePath) context.addIssue({ code: "custom", message: "Provide path or filePath." })
  if (args.path && args.filePath && args.path !== args.filePath) {
    context.addIssue({ code: "custom", message: "path and filePath must refer to the same file." })
  }
})

const patchAliasInput = z.object({
  patchText: z.string().optional(),
  patch: z.string().optional(),
}).superRefine((args, context) => {
  if (!args.patchText && !args.patch) context.addIssue({ code: "custom", message: "Provide patchText or patch." })
  if (args.patchText && args.patch && args.patchText !== args.patch) {
    context.addIssue({ code: "custom", message: "patchText and patch must contain the same patch." })
  }
})

const hashlineInput = z.object({
  filePath: z.string().describe("Absolute path to the file to edit"),
  edits: z.array(z.object({
    op: z.enum(["replace", "append", "prepend"]),
    pos: z.string().optional(),
    end: z.string().optional(),
    lines: z.union([z.array(z.string()), z.string(), z.null()]),
  })),
  delete: z.boolean().optional(),
  rename: z.string().optional(),
})

function record(value: unknown): StringRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as StringRecord
    : undefined
}

function isDisabled(config: OhMyOpenCodeConfig, ...names: string[]): boolean {
  const disabled = config.disabled_tools ?? []
  return names.some((name) => disabled.some((item) => item.trim().toLowerCase() === name.toLowerCase()))
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function readExactText(read: NativeTool, path: string, context: ToolContext): Promise<string> {
  const result = await read.execute({ path }, context)
  const output = record(result.output)
  if (!output) throw new ToolError({ message: `Native read returned no structured content for ${path}.` })
  if (output.type === "file" && output.encoding === "utf8" && typeof output.content === "string") {
    if (output.content.includes("... (line truncated to 2000 chars)")) {
      throw new ToolError({ message: `Cannot use hashline_edit on ${path}: native read truncated a long line, so an exact replacement cannot be authorized safely.` })
    }
    return output.content
  }
  if (output.type === "text-page") {
    throw new ToolError({ message: `Cannot use hashline_edit on ${path}: native read returned paginated text without the original file's exact line endings and final-newline state. Use native edit for a bounded replacement.` })
  }
  throw new ToolError({ message: `Cannot use hashline_edit on ${path}: native read did not return a complete UTF-8 text file.` })
}

function canCreateFromMissingFile(edits: ReturnType<typeof normalizeHashlineEdits>): boolean {
  return edits.length > 0 && edits.every((edit) => (edit.op === "append" || edit.op === "prepend") && !edit.pos)
}

async function executeHashlineEdit(
  args: z.infer<typeof hashlineInput>,
  context: ToolContext,
  nativeRead: NativeTool,
  nativeEdit: NativeTool,
  nativeWrite: NativeTool | undefined,
  nativePatch: NativeTool | undefined,
) {
  if (args.delete && args.rename) throw new ToolError({ message: "hashline_edit cannot delete and rename in the same operation." })
  if (args.delete && args.edits.length > 0) throw new ToolError({ message: "hashline_edit delete mode requires an empty edits array." })
  if (!args.delete && args.edits.length === 0) throw new ToolError({ message: "hashline_edit requires at least one edit operation." })

  if (args.delete) {
    if (!nativePatch) throw new ToolError({ message: "The native V2 patch tool is unavailable; hashline_edit cannot safely delete a file." })
    const patchText = `*** Begin Patch\n*** Delete File: ${args.filePath}\n*** End Patch`
    const result = await nativePatch.execute({ patchText }, context)
    return {
      content: typeof result.content === "string" ? result.content : `Successfully deleted ${args.filePath}`,
      metadata: { ...(result.metadata ?? {}), filePath: args.filePath, hashline: true },
    }
  }

  const edits = normalizeHashlineEdits(args.edits as RawHashlineEdit[])
  let before: string
  try {
    before = await readExactText(nativeRead, args.filePath, context)
  } catch (error) {
    if (!(error instanceof Error) || !error.message.startsWith("File not found:") || args.rename || !canCreateFromMissingFile(edits)) throw error
    if (!nativeWrite) throw new ToolError({ message: "Cannot create a missing file because the native write tool is unavailable." })
    const empty = canonicalizeFileText("")
    const applied = applyHashlineEditsWithReport(empty.content, edits)
    const content = restoreFileText(applied.content, empty)
    const written = await nativeWrite.execute({ path: args.filePath, content }, context)
    return {
      content: typeof written.content === "string" ? written.content : `Created ${args.filePath}`,
      metadata: { filePath: args.filePath, hashline: true, diff: generateUnifiedDiff("", content, args.filePath) },
    }
  }

  const envelope = canonicalizeFileText(before)
  const applied = applyHashlineEditsWithReport(envelope.content, edits)
  if (applied.content === envelope.content && !args.rename) {
    throw new ToolError({ message: `No changes made to ${args.filePath}; the requested edits produce identical content.` })
  }
  const after = restoreFileText(applied.content, envelope)

  if (args.rename && args.rename !== args.filePath && (before.startsWith("\uFEFF") || before.includes("\r"))) {
    throw new ToolError({ message: "Cannot rename this file with hashline_edit because the native patch tool may normalize its BOM or line endings. Rename it with a byte-preserving filesystem operation instead." })
  }

  if (before.length === 0) {
    if (!nativeWrite) throw new ToolError({ message: "Cannot edit an empty file because the native write tool is unavailable." })
    const targetPath = args.rename ?? args.filePath
    if (args.rename && args.rename !== args.filePath && !nativePatch) {
      throw new ToolError({ message: "The native V2 patch tool is unavailable; hashline_edit cannot safely rename a file." })
    }
    const result = await nativeWrite.execute({ path: targetPath, content: after }, context)
    let renameResult: Awaited<ReturnType<NativeTool["execute"]>> | undefined
    if (args.rename && args.rename !== args.filePath) {
      try {
        renameResult = await nativePatch!.execute({ patchText: `*** Begin Patch\n*** Delete File: ${args.filePath}\n*** End Patch` }, context)
      } catch (error) {
        throw new ToolError({ message: `Wrote ${targetPath}, but the native patch tool could not delete ${args.filePath}; the rename is incomplete: ${errorText(error)}` })
      }
    }
    return {
      content: typeof renameResult?.content === "string"
        ? renameResult.content
        : typeof result.content === "string" ? result.content : `Updated ${targetPath}`,
      metadata: { ...(result.metadata ?? {}), ...(renameResult?.metadata ?? {}), filePath: targetPath, hashline: true, diff: generateUnifiedDiff("", applied.content, targetPath) },
    }
  }

  let nativeResult: Awaited<ReturnType<NativeTool["execute"]>>
  if (args.rename && args.rename !== args.filePath) {
    if (!nativePatch) throw new ToolError({ message: "The native V2 patch tool is unavailable; hashline_edit cannot safely rename a file." })
    if (!after.endsWith("\n")) {
      // Patch's update operation normalizes to a trailing newline. Preserve the source bytes
      // with native write, then delete the original through the native permissioned patch tool.
      if (!nativeWrite) throw new ToolError({ message: "The native V2 write tool is unavailable; hashline_edit cannot preserve this rename safely." })
      if (!nativeWrite) throw new ToolError({ message: "The native V2 write tool is unavailable; hashline_edit cannot preserve this rename safely." })
      await nativeWrite.execute({ path: args.rename, content: after }, context)
      const deletePatch = `*** Begin Patch\n*** Delete File: ${args.filePath}\n*** End Patch`
      try {
        nativeResult = await nativePatch.execute({ patchText: deletePatch }, context)
      } catch (error) {
        throw new ToolError({ message: `Wrote ${args.rename}, but the native patch tool could not delete ${args.filePath}; the rename is incomplete: ${errorText(error)}` })
      }
    } else {
      const oldLines = envelope.content.split("\n")
      if (oldLines.at(-1) === "") oldLines.pop()
      const newLines = applied.content.split("\n")
      if (newLines.at(-1) === "") newLines.pop()
      const patchText = [
        "*** Begin Patch",
        `*** Update File: ${args.filePath}`,
        `*** Move to: ${args.rename}`,
        "@@",
        ...oldLines.map((line) => `-${line}`),
        ...newLines.map((line) => `+${line}`),
        "*** End Patch",
      ].join("\n")
      nativeResult = await nativePatch.execute({ patchText }, context)
    }
  } else {
    nativeResult = await nativeEdit.execute({ path: args.filePath, oldString: before, newString: after }, context)
  }
  const { additions, deletions } = countLineDiffs(envelope.content, applied.content)
  return {
    content: typeof nativeResult.content === "string" ? nativeResult.content : `Updated ${args.rename ?? args.filePath}`,
    metadata: {
      ...(nativeResult.metadata ?? {}),
      filePath: args.rename ?? args.filePath,
      hashline: true,
      diff: generateUnifiedDiff(envelope.content, applied.content, args.filePath),
      noopEdits: applied.noopEdits,
      deduplicatedEdits: applied.deduplicatedEdits,
      filediff: { file: args.filePath, path: args.filePath, filePath: args.filePath, before: envelope.content, after: applied.content, additions, deletions },
    },
  }
}

function normalizedPath(args: { path?: string; filePath?: string }): string {
  const path = args.path ?? args.filePath
  if (!path) throw new ToolError({ message: "Provide path or filePath." })
  return path
}

function addPathCompatibility(editor: ToolEditor, name: "read" | "edit" | "write", native: NativeTool, input: typeof nativePathInput | typeof nativeEditInput | typeof nativeWriteInput, normalize: (args: any) => unknown): void {
  editor.remove(name)
  editor.add({
    name,
    description: native.description,
    input,
    output: native.output,
    options: native.options,
    execute: async (args, context) => native.execute(normalize(args), context),
  })
}

function patchInputField(native: NativeTool): "patchText" | "patch" {
  const schema = record(native.input)
  const fields = record(schema?.fields) ?? record(schema?.properties)
  if (fields && "patch" in fields && !("patchText" in fields)) return "patch"
  return "patchText"
}

function addNativeAlias(editor: ToolEditor, alias: string, native: NativeTool): void {
  editor.add({
    name: alias,
    description: native.description,
    input: native.input,
    output: native.output,
    options: native.options,
    execute: (input, context) => native.execute(input, context),
  })
}

/** Compatibility aliases route through V2 host tools so native permissions remain authoritative. */
export function addV2FilesystemTools(editor: ToolEditor, ctx: Plugin.Context, config: OhMyOpenCodeConfig): void {
  const shell = editor.get("shell")
  if (shell && !isDisabled(config, "shell") && !isDisabled(config, "bash")) {
    if (!editor.get("bash")) addNativeAlias(editor, "bash", shell)
  } else if (isDisabled(config, "bash")) {
    editor.remove("bash")
  }
  if (isDisabled(config, "shell")) {
    editor.remove("shell")
    editor.remove("bash")
  }

  const patch = editor.get("patch")
  if (patch && !isDisabled(config, "patch") && !isDisabled(config, "apply_patch")) {
    const field = patchInputField(patch)
    editor.remove("apply_patch")
    editor.add({
      name: "apply_patch",
      description: patch.description,
      input: patchAliasInput,
      output: patch.output,
      options: patch.options,
      execute: (args, context) => patch.execute({ [field]: args.patchText ?? args.patch }, context),
    })
  } else if (isDisabled(config, "apply_patch")) {
    editor.remove("apply_patch")
  }
  if (isDisabled(config, "patch")) {
    editor.remove("patch")
    editor.remove("apply_patch")
  }

  const read = editor.get("read")
  const edit = editor.get("edit")
  const write = editor.get("write")
  const nativePatch = editor.get("patch")
  if (read && !isDisabled(config, "read")) {
    addPathCompatibility(editor, "read", read, nativePathInput, (args: z.infer<typeof nativePathInput>) => ({
      path: normalizedPath(args), ...(args.offset === undefined ? {} : { offset: args.offset }), ...(args.limit === undefined ? {} : { limit: args.limit }),
    }))
  } else if (isDisabled(config, "read")) editor.remove("read")
  if (edit && !isDisabled(config, "edit")) {
    addPathCompatibility(editor, "edit", edit, nativeEditInput, (args: z.infer<typeof nativeEditInput>) => ({
      path: normalizedPath(args), oldString: args.oldString, newString: args.newString,
      ...(args.replaceAll === undefined ? {} : { replaceAll: args.replaceAll }),
    }))
  } else if (isDisabled(config, "edit")) editor.remove("edit")
  if (write && !isDisabled(config, "write")) {
    addPathCompatibility(editor, "write", write, nativeWriteInput, (args: z.infer<typeof nativeWriteInput>) => ({
      path: normalizedPath(args), content: args.content,
    }))
  } else if (isDisabled(config, "write")) editor.remove("write")

  if (!config.hashline_edit || isDisabled(config, "hashline_edit", "edit") || isDisabled(config, "read")) {
    editor.remove("hashline_edit")
    return
  }
  if (!read || !edit) {
    editor.remove("hashline_edit")
    return
  }
  addV2Tool(editor, {
    name: "hashline_edit",
    description: HASHLINE_EDIT_DESCRIPTION,
    input: hashlineInput,
    options: { codemode: false, permission: "edit" },
    execute: async (args, context) => executeHashlineEdit(args, context, read, edit, write, nativePatch),
  })
}

export { executeHashlineEdit }
