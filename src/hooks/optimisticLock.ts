import fs from "fs/promises"
import path from "path"

import type { Task } from "../core/task/Task"
import { serializeHookError } from "./hookErrors"
import { hashContent, isBinaryBuffer } from "./traceUtils"

type SnapshotEntry = {
	before: string | null
	existed?: boolean
	binary?: boolean
}

type SnapshotStore = Map<string, Map<string, SnapshotEntry>>

export async function checkOptimisticLock(
	task: Task,
	toolCallId: string | undefined,
	relPath: string,
	tool: string,
): Promise<string | null> {
	if (!toolCallId) return null
	const store = (task as any).traceSnapshots as SnapshotStore | undefined
	if (!store) return null
	const snapshotMap = store.get(toolCallId)
	if (!snapshotMap) return null
	const snapshot = snapshotMap.get(relPath)
	if (!snapshot) return null

	if (snapshot.binary) return null

	const absPath = path.resolve(task.cwd, relPath)
	let actualHash: string | null = null
	let actualExists = false

	try {
		const buffer = await fs.readFile(absPath)
		actualExists = true
		if (isBinaryBuffer(buffer)) {
			return null
		}
		actualHash = hashContent(buffer)
	} catch {
		actualExists = false
		actualHash = null
	}

	const expectedExists = snapshot.existed ?? snapshot.before !== null
	const expectedHash = expectedExists && snapshot.before !== null ? hashContent(snapshot.before) : null

	const stale =
		(expectedExists && !actualExists) ||
		(!expectedExists && actualExists) ||
		(expectedExists && actualExists && expectedHash !== actualHash)

	if (!stale) return null

	const err = serializeHookError(
		{
			error_type: "stale_file",
			code: "REQ-007",
			intent_id: (task as any).activeIntent?.id || "",
			tool,
			message: "File changed since tool started; refresh before retrying",
		},
		{ path: relPath, expected_hash: expectedHash, actual_hash: actualHash },
	)

	;(task as any).lastVerificationFailure = {
		type: "stale_file",
		intent_id: (task as any).activeIntent?.id || "",
		tool,
		path: relPath,
		expected_hash: expectedHash,
		actual_hash: actualHash,
		timestamp: new Date().toISOString(),
	}

	return err
}
