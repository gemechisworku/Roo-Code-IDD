import fs from "fs/promises"
import path from "path"

import type { Task } from "../core/task/Task"
import { serializeHookError } from "./hookErrors"
import { hashContent, isBinaryBuffer } from "./traceUtils"
import { toPosixPath } from "../utils/path"

type SnapshotEntry = {
	before: string | null
	existed?: boolean
	binary?: boolean
}

type SnapshotStore = Map<string, Map<string, SnapshotEntry>>

type StaleBlock = {
	timestamp: string
	tool: string
}

type StaleBlockStore = Map<string, StaleBlock>

function getStaleBlockStore(task: Task): StaleBlockStore {
	const anyTask = task as any
	if (!anyTask.staleFileBlocks) {
		anyTask.staleFileBlocks = new Map()
	}
	return anyTask.staleFileBlocks as StaleBlockStore
}

function normalizeStaleKey(relPath: string): string {
	const raw = relPath || ""
	const trimmed = raw.replace(/^[.][\\/]/, "")
	return toPosixPath(trimmed)
}

export function markStaleFile(task: Task, relPath: string, tool: string): void {
	const store = getStaleBlockStore(task)
	const key = normalizeStaleKey(relPath)
	store.set(key, { timestamp: new Date().toISOString(), tool })
}

export function clearStaleFile(task: Task, relPath: string): void {
	const store = getStaleBlockStore(task)
	const key = normalizeStaleKey(relPath)
	store.delete(key)
}

export function getStaleFileBlock(task: Task, relPath: string): StaleBlock | undefined {
	const store = getStaleBlockStore(task)
	const key = normalizeStaleKey(relPath)
	return store.get(key)
}

export function buildStaleFileError(
	task: Task,
	tool: string,
	relPath: string,
	expectedContent: string | null | undefined,
	actualContent: string | null | undefined,
	message: string,
): string {
	const expectedHash = expectedContent !== null && expectedContent !== undefined ? hashContent(expectedContent) : null
	const actualHash = actualContent !== null && actualContent !== undefined ? hashContent(actualContent) : null

	const err = serializeHookError(
		{
			error_type: "stale_file",
			code: "REQ-007",
			intent_id: (task as any).activeIntent?.id || "",
			tool,
			message,
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

	markStaleFile(task, relPath, tool)

	return err
}

function getSnapshotEntry(snapshotMap: Map<string, SnapshotEntry>, relPath: string): SnapshotEntry | undefined {
	const candidates = new Set<string>()
	const raw = relPath || ""

	candidates.add(raw)
	candidates.add(raw.replace(/^[.][\\/]/, ""))
	candidates.add(toPosixPath(raw))
	candidates.add(toPosixPath(raw.replace(/^[.][\\/]/, "")))
	candidates.add(path.posix.normalize(toPosixPath(raw)))
	candidates.add(path.posix.normalize(toPosixPath(raw.replace(/^[.][\\/]/, ""))))

	for (const candidate of candidates) {
		const entry = snapshotMap.get(candidate)
		if (entry) return entry
	}

	return undefined
}

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
	const snapshot = getSnapshotEntry(snapshotMap, relPath)
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
	markStaleFile(task, relPath, tool)

	return err
}
