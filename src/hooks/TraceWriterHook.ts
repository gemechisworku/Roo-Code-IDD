import path from "path"
import fs from "fs/promises"
import crypto from "crypto"

import type { ToolUse } from "../shared/tools"
import type { Task } from "../core/task/Task"
import type { PostToolHook, PostHookResult } from "./types"

function sha256(content: string): string {
	return crypto.createHash("sha256").update(content, "utf8").digest("hex")
}

/**
 * Trace Writer Hook
 * Appends a simple trace entry to .orchestration/agent_trace.jsonl for mutating tools.
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

			const files: Array<any> = []

			const targetPaths = this.extractPathsFromToolUse(toolUse)

			for (const p of targetPaths) {
				try {
					const abs = path.resolve(cwd, p)
					const rel = path.relative(cwd, abs)
					const content = await fs.readFile(abs, "utf-8")
					files.push({ relative_path: rel, content_hash: sha256(content) })
				} catch (error) {
					// If file not found or unreadable, still record the attempted path
					files.push({ relative_path: p, content_hash: null })
				}
			}

			const entry = {
				id: crypto.randomUUID(),
				timestamp: new Date().toISOString(),
				intent_id: (task as any).activeIntent?.id || null,
				tool: toolUse.name,
				params: toolUse.params ?? null,
				contributor: task.api?.getModel?.()?.id ?? null,
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

	private extractPathsFromToolUse(toolUse: ToolUse): string[] {
		const paths: string[] = []
		const tryAdd = (p: any) => {
			if (!p) return
			if (Array.isArray(p)) p.forEach((x) => tryAdd(x))
			else if (typeof p === "string") paths.push(p)
			else if (typeof p === "object") {
				if (p.path) tryAdd(p.path)
				if (p.file_path) tryAdd(p.file_path)
				if (p.files) tryAdd(p.files)
			}
		}
		tryAdd(toolUse.params)
		tryAdd((toolUse as any).nativeArgs)
		return paths.map((p) => String(p))
	}
}
