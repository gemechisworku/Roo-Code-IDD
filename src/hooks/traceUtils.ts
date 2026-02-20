import crypto from "crypto"
import * as diff from "diff"

import type { ToolUse } from "../shared/tools"

const PATCH_FILE_MARKERS = ["*** Add File: ", "*** Delete File: ", "*** Update File: "] as const
const MOVE_TO_MARKER = "*** Move to: "

export type TraceRange = {
	start_line: number
	end_line: number
	content_hash: string
}

export function normalizeContent(content: string): string {
	return content.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
}

export function hashContent(content: string | Buffer): string {
	return crypto.createHash("sha256").update(content).digest("hex")
}

export function isBinaryBuffer(buffer: Buffer): boolean {
	for (let i = 0; i < buffer.length; i++) {
		if (buffer[i] === 0) return true
	}
	return false
}

function countLines(content: string): number {
	if (!content) return 0
	const normalized = normalizeContent(content)
	const parts = normalized.split("\n")
	return parts[parts.length - 1] === "" ? parts.length - 1 : parts.length
}

export function computeAddedRanges(before: string, after: string): TraceRange[] {
	const ranges: TraceRange[] = []
	const normalizedBefore = normalizeContent(before)
	const normalizedAfter = normalizeContent(after)
	const changes = diff.diffLines(normalizedBefore, normalizedAfter)

	let newLine = 1
	let oldLine = 1

	for (const change of changes) {
		const lineCount = countLines(change.value)
		if (change.added) {
			if (lineCount > 0) {
				const start = newLine
				const end = newLine + lineCount - 1
				ranges.push({
					start_line: start,
					end_line: end,
					content_hash: hashContent(change.value),
				})
			}
			newLine += lineCount
		} else if (change.removed) {
			oldLine += lineCount
		} else {
			newLine += lineCount
			oldLine += lineCount
		}
	}

	return ranges
}

function extractPathsFromPatch(patchContent: string): string[] {
	const filePaths: string[] = []
	const lines = patchContent.split("\n")

	for (const line of lines) {
		for (const marker of PATCH_FILE_MARKERS) {
			if (line.startsWith(marker)) {
				const filePath = line.substring(marker.length).trim()
				if (filePath) {
					filePaths.push(filePath)
				}
				break
			}
		}

		if (line.startsWith(MOVE_TO_MARKER)) {
			const movePath = line.substring(MOVE_TO_MARKER.length).trim()
			if (movePath) {
				filePaths.push(movePath)
			}
		}
	}

	return filePaths
}

export function extractTargetPaths(toolUse: ToolUse): string[] {
	const paths: string[] = []
	const tryAdd = (value: any) => {
		if (!value) return
		if (Array.isArray(value)) {
			value.forEach((entry) => tryAdd(entry))
		} else if (typeof value === "string") {
			paths.push(value)
		} else if (typeof value === "object") {
			if ("path" in value) tryAdd((value as any).path)
			if ("file_path" in value) tryAdd((value as any).file_path)
			if ("files" in value) tryAdd((value as any).files)
		}
	}

	const patch = (toolUse.params as any)?.patch ?? (toolUse.nativeArgs as any)?.patch
	if (typeof patch === "string") {
		paths.push(...extractPathsFromPatch(patch))
	}

	tryAdd(toolUse.params)
	tryAdd((toolUse as any).nativeArgs)

	return Array.from(new Set(paths.map((entry) => String(entry)).filter(Boolean)))
}
