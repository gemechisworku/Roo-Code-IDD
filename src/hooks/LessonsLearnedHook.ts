import path from "path"

import type { Task } from "../core/task/Task"
import type { ToolUse } from "../shared/tools"
import type { PostToolHook, PostHookResult } from "./types"
import { appendWithLock } from "./appendWithLock"

type VerificationFailure = {
	type: string
	intent_id?: string
	tool?: string
	path?: string
	expected_hash?: string | null
	actual_hash?: string | null
	timestamp?: string
}

export class LessonsLearnedHook implements PostToolHook {
	name = "lessons_learned"
	phase = "post" as const

	async execute(task: Task, _toolUse: ToolUse, _result: any): Promise<PostHookResult> {
		const failure = (task as any).lastVerificationFailure as VerificationFailure | undefined
		if (!failure) {
			return { success: true }
		}

		const intentId = failure.intent_id || (task as any).activeIntent?.id || "unknown"
		const tool = failure.tool || "unknown"
		const failurePath = failure.path || "unknown"
		const timestamp = failure.timestamp || new Date().toISOString()

		const entry =
			`\n### Verification Failure (${intentId})\n` +
			`- **Timestamp**: ${timestamp}\n` +
			`- **Tool**: ${tool}\n` +
			`- **Path**: ${failurePath}\n` +
			`- **Lesson**: The file changed between read and write. Refresh context and retry the change.\n` +
			`- **Expected Hash**: ${failure.expected_hash ?? "unknown"}\n` +
			`- **Actual Hash**: ${failure.actual_hash ?? "unknown"}\n`

		try {
			const agentFile = path.join(task.cwd, ".orchestration", "AGENT.md")
			await appendWithLock(agentFile, entry)
		} catch (error: any) {
			return { success: false, errorMessage: error.message }
		} finally {
			delete (task as any).lastVerificationFailure
		}

		return { success: true, sideEffects: ["appended_lessons_learned"] }
	}
}
