import path from "path"
import fs from "fs/promises"

import type { ToolUse } from "../shared/tools"
import type { Task } from "../core/task/Task"
import type { PreToolHook, PreHookResult } from "./types"
import { extractTargetPaths, isBinaryBuffer } from "./traceUtils"

type SnapshotEntry = {
	before: string | null
	existed: boolean
	binary: boolean
}

type SnapshotStore = Map<string, Map<string, SnapshotEntry>>

function getSnapshotStore(task: Task): SnapshotStore {
	const anyTask = task as any
	if (!anyTask.traceSnapshots) {
		anyTask.traceSnapshots = new Map()
	}
	return anyTask.traceSnapshots as SnapshotStore
}

function getTraceKey(toolUse: ToolUse): string {
	const anyTool = toolUse as any
	if (anyTool.traceKey) return anyTool.traceKey
	const key = toolUse.id ?? `${toolUse.name}-${Date.now()}-${Math.random().toString(16).slice(2)}`
	anyTool.traceKey = key
	return key
}

/**
 * Trace Snapshot Hook
 * Captures pre-mutation file contents so post-hooks can compute ranges.
 */
export class TraceSnapshotHook implements PreToolHook {
	name = "trace_snapshot"
	phase = "pre" as const
	toolFilter = [
		"write_to_file",
		"apply_diff",
		"edit",
		"search_and_replace",
		"search_replace",
		"edit_file",
		"apply_patch",
		"generate_image",
	]

	async execute(task: Task, toolUse: ToolUse): Promise<PreHookResult> {
		const traceKey = getTraceKey(toolUse)
		const store = getSnapshotStore(task)
		const targetPaths = extractTargetPaths(toolUse)
		const snapshot = new Map<string, SnapshotEntry>()

		for (const relPath of targetPaths) {
			try {
				const absPath = path.resolve(task.cwd, relPath)
				const buffer = await fs.readFile(absPath)
				if (isBinaryBuffer(buffer)) {
					snapshot.set(relPath, { before: null, existed: true, binary: true })
				} else {
					snapshot.set(relPath, { before: buffer.toString("utf8"), existed: true, binary: false })
				}
			} catch {
				snapshot.set(relPath, { before: null, existed: false, binary: false })
			}
		}

		store.set(traceKey, snapshot)

		return { shouldProceed: true }
	}
}
