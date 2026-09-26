import { realpath } from "node:fs/promises"
import { basename, dirname, isAbsolute, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { isAllowedFile } from "../hooks/prometheus-md-only/path-policy"

function toFilePath(resource: string): string | undefined {
	try {
		return resource.startsWith("file:") ? fileURLToPath(resource) : resource
	} catch {
		return undefined
	}
}

async function canonicalizeEvenIfMissing(path: string): Promise<string | undefined> {
	let cursor = resolve(path)
	const suffix: string[] = []
	for (;;) {
		try {
			const canonical = await realpath(cursor)
			return resolve(canonical, ...suffix)
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code
			if (code !== "ENOENT" && code !== "ENOTDIR") return undefined
			const parent = dirname(cursor)
			if (parent === cursor) return undefined
			suffix.unshift(basename(cursor))
			cursor = parent
		}
	}
}

/** Check the existing .omo/*.md policy lexically and after resolving symlinks. */
export async function isCanonicallyAllowedMarkdown(resource: string, workspaceRoot: string): Promise<boolean> {
	const filePath = toFilePath(resource)
	if (!filePath || !isAllowedFile(filePath, workspaceRoot)) return false
	const [canonicalRoot, canonicalTarget] = await Promise.all([
		realpath(workspaceRoot).catch(() => undefined),
		canonicalizeEvenIfMissing(isAbsolute(filePath) ? filePath : resolve(workspaceRoot, filePath)),
	])
	if (!canonicalRoot || !canonicalTarget) return false
	const canonicalRelative = relative(canonicalRoot, canonicalTarget)
	if (
		canonicalRelative === ".." ||
		canonicalRelative.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
		isAbsolute(canonicalRelative)
	) return false
	return isAllowedFile(canonicalTarget, canonicalRoot)
}
