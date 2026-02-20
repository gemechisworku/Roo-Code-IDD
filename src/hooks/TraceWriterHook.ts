import path from "path"
import fs from "fs/promises"
import crypto from "crypto"

import type { ToolUse } from "../shared/tools"
import type { Task } from "../core/task/Task"
import type { PostToolHook, PostHookResult } from "./types"
import { computeAddedRanges, extractTargetPaths, hashContent, isBinaryBuffer } from "./traceUtils"

type SnapshotEntry = {
	before: string | null
}

type SnapshotStore = Map<string, Map<string, SnapshotEntry>>

function getSnapshotStore(task: Task): SnapshotStore | undefined {
	return (task as any).traceSnapshots as SnapshotStore | undefined
}

function getTraceKey(toolUse: ToolUse): string {
	const anyTool = toolUse as any
	if (anyTool.traceKey) return anyTool.traceKey
	const key = toolUse.id ?? `${toolUse.name}-${Date.now()}-${Math.random().toString(16).slice(2)}`
	anyTool.traceKey = key
	return key
}

function getRevisionId(task: Task): string | null {
	const service = (task as any).checkpointService
	if (!service) return null
	const checkpoints = typeof service.getCheckpoints === "function" ? service.getCheckpoints() : []
	return checkpoints?.[checkpoints.length - 1] ?? service.baseHash ?? null
}

function sanitizeParams(toolUse: ToolUse): Record<string, unknown> | null {
	const params = (toolUse.nativeArgs as Record<string, unknown>) ?? toolUse.params
	if (!params) return null

	const allowedKeys = ["path", "file_path", "intent_id", "mutation_class", "command", "prompt", "image"]
	const sanitized: Record<string, unknown> = {}
	for (const key of allowedKeys) {
		if (params[key] !== undefined) sanitized[key] = params[key]
	}

	if (toolUse.name === "apply_patch" && params["patch"]) {
		sanitized.patch = "[redacted]"
	}
	if (toolUse.name === "apply_diff" && params["diff"]) {
		sanitized.diff = "[redacted]"
	}
	if ((toolUse.name === "edit" || toolUse.name === "search_replace" || toolUse.name === "edit_file") && params) {
		if (params["old_string"]) sanitized.old_string = "[redacted]"
		if (params["new_string"]) sanitized.new_string = "[redacted]"
	}

	return Object.keys(sanitized).length > 0 ? sanitized : null
}

/**
 * Trace Writer Hook
 * Appends intent-aware trace entries to .orchestration/agent_trace.jsonl for mutating tools.
 */
export class TraceWriterHook implements PostToolHook {
	name = "trace_writer"
	phase = "post" as const
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

	async execute(task: Task, toolUse: ToolUse, _result: any): Promise<PostHookResult> {
		try {
			const cwd = task.cwd
			const orchestrationDir = path.join(cwd, ".orchestration")
			await fs.mkdir(orchestrationDir, { recursive: true })

			const intentId =
				(toolUse.nativeArgs as any)?.intent_id ??
				(toolUse.params as any)?.intent_id ??
				(task as any).activeIntent?.id ??
				null

			const mutationClass =
				(toolUse.nativeArgs as any)?.mutation_class ?? (toolUse.params as any)?.mutation_class ?? null

			const contributor = {
				model_identifier: task.api?.getModel?.()?.id ?? null,
				task_id: (task as any).taskId ?? null,
				instance_id: (task as any).instanceId ?? null,
			}

			const traceKey = getTraceKey(toolUse)
			const snapshotStore = getSnapshotStore(task)
			const snapshot = snapshotStore?.get(traceKey)
			if (snapshotStore) {
				snapshotStore.delete(traceKey)
			}

			const files: Array<any> = []
			const targetPaths = extractTargetPaths(toolUse)

			for (const relPath of targetPaths) {
				const abs = path.resolve(cwd, relPath)
				const relative = path.relative(cwd, abs)
				const before = snapshot?.get(relPath)?.before ?? ""

				try {
					const buffer = await fs.readFile(abs)
					const fileHash = hashContent(buffer)

					if (isBinaryBuffer(buffer)) {
						files.push({
							relative_path: relative,
							content_hash: fileHash,
							conversations: [
								{
									contributor,
									related: intentId ? [{ type: "specification", value: intentId }] : [],
									ranges: [],
								},
							],
						})
						continue
					}

					const afterText = buffer.toString("utf8")
					const ranges = computeAddedRanges(before ?? "", afterText)

					files.push({
						relative_path: relative,
						content_hash: fileHash,
						conversations: [
							{
								contributor,
								related: intentId ? [{ type: "specification", value: intentId }] : [],
								ranges,
							},
						],
					})
				} catch {
					// If file not found or unreadable, still record the attempted path
					files.push({
						relative_path: relative,
						content_hash: null,
						conversations: [
							{
								contributor,
								related: intentId ? [{ type: "specification", value: intentId }] : [],
								ranges: [],
							},
						],
					})
				}
			}

			const entry = {
				id: crypto.randomUUID(),
				timestamp: new Date().toISOString(),
				intent_id: intentId,
				mutation_class: mutationClass,
				tool: toolUse.name,
				tool_use_id: toolUse.id ?? null,
				params: sanitizeParams(toolUse),
				contributor,
				vcs: { revision_id: getRevisionId(task) },
				files,
			}

			const traceFile = path.join(orchestrationDir, "agent_trace.jsonl")
			await fs.appendFile(traceFile, JSON.stringify(entry) + "\n", "utf-8")

			return { success: true, sideEffects: ["wrote_trace_entry"] }
		} catch (error: any) {
			console.error("TraceWriterHook error:", error)
			return { success: false, errorMessage: error.message }
		}
	}
}
