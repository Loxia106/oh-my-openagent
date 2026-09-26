import type { Plugin } from "@opencode/plugin"
import { Error as ToolError, type Info, type ToolContext, type ToolEditor } from "@opencode/plugin/promise/tool"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import type { OhMyOpenCodeConfig } from "../config"
import { normalizeArgs, validateArgs } from "../tools/look-at/look-at-arguments"
import type { LookAtArgs } from "../tools/look-at/types"
import { addV2Tool } from "./tool-adapter"

type NativeTool = Info & { readonly id: string }
type LaunchRequest = {
	agent: string
	description: string
	prompt: string
	model?: string
	sessionID?: string
	background: boolean
	blockedActions?: string[]
}
type NativeLaunch = (request: LaunchRequest, context: ToolContext) => Promise<Awaited<ReturnType<NativeTool["execute"]>>>
type NativeReadOutput = { type?: unknown; encoding?: unknown; mime?: unknown }
type InlineMedia = { mime: string; extension: string; bytes: Buffer }

const MAX_INLINE_MEDIA_BYTES = 20 * 1024 * 1024
const MEDIA_EXTENSIONS: Record<string, string> = {
	"image/png": ".png",
	"image/jpeg": ".jpg",
	"image/gif": ".gif",
	"image/webp": ".webp",
	"application/pdf": ".pdf",
}

const input = z.object({
	file_path: z.string().optional(),
	file_paths: z.array(z.string()).optional(),
	path: z.string().optional(),
	image_data: z.string().optional(),
	image_data_list: z.array(z.string()).optional(),
	goal: z.string(),
})

function isDisabled(config: OhMyOpenCodeConfig, name: string): boolean {
	return config.disabled_tools?.some((entry) => entry.trim().toLowerCase() === name) ?? false
}

function isMultimodalAgentDisabled(config: OhMyOpenCodeConfig): boolean {
	const disabled = config.disabled_agents?.some((entry) => entry.trim().toLowerCase() === "multimodal-looker")
	const overrides = config.agents as Record<string, { disable?: boolean } | undefined> | undefined
	const override = overrides?.["multimodal-looker"] ?? Object.entries(overrides ?? {}).find(([key]) => key.toLowerCase() === "multimodal-looker")?.[1]
	return disabled === true || override?.disable === true
}

function object(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? value as Record<string, unknown>
		: undefined
}

function decodeInlineMedia(value: string): InlineMedia {
	const dataURI = /^data:([^;,]+);base64,(.*)$/is.exec(value)
	if (value.startsWith("data:") && !dataURI) throw new ToolError({ message: "look_at inline media must use a base64 data URI." })
	const declaredMime = dataURI?.[1]?.toLowerCase()
	const encoded = (dataURI?.[2] ?? value).replace(/\s/g, "")
	if (!encoded || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 === 1) {
		throw new ToolError({ message: "look_at received invalid base64 media data." })
	}
	const bytes = Buffer.from(encoded, "base64")
	const canonical = bytes.toString("base64").replace(/=+$/, "")
	if (canonical !== encoded.replace(/=+$/, "")) throw new ToolError({ message: "look_at received invalid base64 media data." })
	if (bytes.length === 0 || bytes.length > MAX_INLINE_MEDIA_BYTES) {
		throw new ToolError({ message: `Each inline media item must be between 1 byte and ${MAX_INLINE_MEDIA_BYTES} bytes.` })
	}
	const detectedMime = bytes.subarray(0, 16).toString("binary").startsWith("\x89PNG")
		? "image/png"
		: bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
			? "image/jpeg"
			: bytes.subarray(0, 6).toString("binary").startsWith("GIF8")
				? "image/gif"
				: bytes.subarray(0, 12).toString("binary").startsWith("RIFF") && bytes.subarray(8, 12).toString("binary") === "WEBP"
					? "image/webp"
					: bytes.subarray(0, 4).toString("binary") === "%PDF"
						? "application/pdf"
						: undefined
	if (!detectedMime) throw new ToolError({ message: "look_at inline media must be a PNG, JPEG, GIF, WebP, or PDF file." })
	if (declaredMime && declaredMime !== detectedMime) {
		throw new ToolError({ message: `Inline media declares ${declaredMime}, but its bytes are ${detectedMime}.` })
	}
	return { mime: detectedMime, extension: MEDIA_EXTENSIONS[detectedMime]!, bytes }
}

function inlineMediaValues(args: LookAtArgs): string[] {
	return args.image_data_list ?? (args.image_data ? [args.image_data] : [])
}

async function validateMediaPath(read: NativeTool, path: string, context: ToolContext): Promise<void> {
	const result = await read.execute({ path }, context)
	const output = object(result.output) as NativeReadOutput | undefined
	if (output?.type !== "file" || output.encoding !== "base64" || typeof output.mime !== "string") {
		throw new ToolError({ message: `look_at supports native image/PDF files only; native read did not return media for ${path}.` })
	}
	if (!(output.mime.startsWith("image/") || output.mime === "application/pdf")) {
		throw new ToolError({ message: `look_at does not support ${output.mime} at ${path}; expected an image or PDF.` })
	}
}

/**
 * V2 has no standalone generate API that accepts files. Use the host's native
 * subagent tool so the multimodal reader is a true child and its read calls keep
 * the parent session's permission restrictions.
 */
export function addV2LookAtTool(
	editor: ToolEditor,
	config: OhMyOpenCodeConfig,
	nativeRead: NativeTool | undefined,
	launch: NativeLaunch,
): void {
	if (isDisabled(config, "look_at") || isDisabled(config, "read") || isMultimodalAgentDisabled(config) || !nativeRead) {
		editor.remove("look_at")
		return
	}
	addV2Tool(editor, {
		name: "look_at",
		description: "Analyze a local image or PDF with the configured multimodal-looker agent. The source is read through native V2 permission checks and analyzed in an owned child session.",
		input,
		options: { codemode: false, permission: "task" },
		execute: async (args, context) => {
			const normalized = normalizeArgs(args as LookAtArgs & { path?: string })
			const validation = validateArgs(normalized)
			if (validation) throw new ToolError({ message: validation })
			const paths = [...(normalized.file_paths ?? (normalized.file_path ? [normalized.file_path] : []))]
			const inlineValues = inlineMediaValues(normalized)
			let temporaryDirectory: string | undefined
			try {
				if (inlineValues.length > 0) {
					temporaryDirectory = mkdtempSync(join(tmpdir(), "omo-look-at-v2-"))
					let totalBytes = 0
					for (const [index, value] of inlineValues.entries()) {
						const media = decodeInlineMedia(value)
						totalBytes += media.bytes.length
						if (totalBytes > MAX_INLINE_MEDIA_BYTES) {
							throw new ToolError({ message: `Combined inline media must not exceed ${MAX_INLINE_MEDIA_BYTES} bytes.` })
						}
						const path = join(temporaryDirectory, `clipboard-${index + 1}${media.extension}`)
						writeFileSync(path, media.bytes, { flag: "wx", mode: 0o600 })
						paths.push(path)
					}
				}
				if (paths.length === 0) throw new ToolError({ message: "Pass file_path, file_paths, image_data, or image_data_list." })
				for (const path of paths) await validateMediaPath(nativeRead, path, context)

				const sourceList = paths.map((path, index) => `${index + 1}. ${path}`).join("\n")
				const prompt = [
					`Analyze the following local media files and extract only the information requested: ${normalized.goal}`,
					"These files are not attached to this message. Use the native read tool with each exact path below to inspect them.",
					"Do not write or modify files. Do not call other agents or other tools.",
					`Files:\n${sourceList}`,
				].join("\n\n")
				const result = await launch({
					agent: "multimodal-looker",
					description: `Analyze ${paths.length} media file${paths.length === 1 ? "" : "s"}: ${normalized.goal}`.slice(0, 200),
					prompt,
					background: false,
				}, context)
				const output = object(result.output)
				const text = typeof output?.output === "string"
					? output.output
					: typeof result.content === "string" ? result.content : undefined
				if (!text) throw new ToolError({ message: "The multimodal-looker child returned no text result." })
				return { content: text, ...(output?.sessionID ? { metadata: { sessionID: output.sessionID } } : {}) }
			} finally {
				if (temporaryDirectory) rmSync(temporaryDirectory, { recursive: true, force: true })
			}
		},
	})
}
