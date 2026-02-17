import path from "path"
import fs from "fs/promises"
import yaml from "yaml"
import crypto from "crypto"

import type { ToolUse } from "../shared/tools"
import type { Task } from "../core/task/Task"
import type { PreToolHook, PreHookResult } from "./types"

/**
 * Context Injector Hook
 *
 * Intercepts select_active_intent calls and injects deep context
 * from the .orchestration/ data model into the conversation.
 */
export class ContextInjectorHook implements PreToolHook {
	name = "context_injector"
	phase = "pre" as const
	toolFilter = ["select_active_intent"]

	async execute(task: Task, toolUse: ToolUse<"select_active_intent">): Promise<PreHookResult> {
		const { intent_id } = (toolUse.nativeArgs as { intent_id: string }) || toolUse.params

		if (!intent_id) {
			return {
				shouldProceed: false,
				errorMessage: "Missing intent_id parameter",
			}
		}

		try {
			// Load intent context
			const context = await this.loadIntentContext(task.cwd, intent_id)

			// Store the active intent in task state for later use
			;(task as any).activeIntent = {
				id: intent_id,
				context: context,
				selectedAt: new Date().toISOString(),
			}

			return {
				shouldProceed: true,
				injectedContext: context,
			}
		} catch (error) {
			return {
				shouldProceed: false,
				errorMessage: `Failed to load intent context: ${error.message}`,
			}
		}
	}

	private async loadIntentContext(cwd: string, intentId: string): Promise<string> {
		const orchestrationDir = path.join(cwd, ".orchestration")

		// Load active intents
		const intentsFile = path.join(orchestrationDir, "active_intents.yaml")
		const intentsContent = await fs.readFile(intentsFile, "utf-8")
		const intentsData = yaml.parse(intentsContent)

		const selectedIntent = intentsData.active_intents?.find((intent: any) => intent.id === intentId)
		if (!selectedIntent) {
			throw new Error(`Intent "${intentId}" not found`)
		}

		if (selectedIntent.status !== "IN_PROGRESS") {
			throw new Error(`Intent "${intentId}" is not in IN_PROGRESS status`)
		}

		// Load related traces
		const traceFile = path.join(orchestrationDir, "agent_trace.jsonl")
		let relatedTraces: any[] = []
		try {
			const traceContent = await fs.readFile(traceFile, "utf-8")
			const lines = traceContent
				.trim()
				.split("\n")
				.filter((line) => line.trim())
			relatedTraces = lines
				.map((line) => {
					try {
						return JSON.parse(line)
					} catch {
						return null
					}
				})
				.filter(
					(trace) =>
						trace &&
						trace.files?.some((file: any) =>
							file.conversations?.some((conv: any) =>
								conv.related?.some(
									(rel: any) => rel.type === "specification" && rel.value === intentId,
								),
							),
						),
				)
				.slice(-5) // Last 5 related traces
		} catch (error) {
			// Trace file might not exist yet
		}

		// Load shared knowledge
		const agentFile = path.join(orchestrationDir, "AGENT.md")
		let sharedKnowledge = ""
		try {
			sharedKnowledge = await fs.readFile(agentFile, "utf-8")
		} catch (error) {
			// Agent file might not exist yet
		}

		// Construct the intent context XML block
		const intentContext = `<intent_context>
<intent_specification>
<id>${selectedIntent.id}</id>
<name>${selectedIntent.name}</name>
<status>${selectedIntent.status}</status>
<owned_scope>
${selectedIntent.owned_scope.map((scope: string) => `  <path>${scope}</path>`).join("\n")}
</owned_scope>
<constraints>
${selectedIntent.constraints.map((constraint: string) => `  <constraint>${constraint}</constraint>`).join("\n")}
</constraints>
<acceptance_criteria>
${selectedIntent.acceptance_criteria.map((criteria: string) => `  <criteria>${criteria}</criteria>`).join("\n")}
</acceptance_criteria>
</intent_specification>

<reief_history>
${
	relatedTraces.length > 0
		? relatedTraces
				.map(
					(trace) =>
						`<trace_entry id="${trace.id}" timestamp="${trace.timestamp}">\n` +
						trace.files
							.map(
								(file: any) =>
									`    <file path="${file.relative_path}">\n` +
									file.conversations
										.map(
											(conv: any) =>
												`      <conversation contributor="${conv.contributor?.model_identifier || "unknown"}">\n` +
												conv.ranges
													.map(
														(range: any) =>
															`        <range lines="${range.start_line}-${range.end_line}" hash="${range.content_hash}"/>\n`,
													)
													.join("") +
												`      </conversation>\n`,
										)
										.join("") +
									`    </file>\n`,
							)
							.join("") +
						`</trace_entry>\n`,
				)
				.join("")
		: "<no_previous_work>No previous work found for this intent.</no_previous_work>"
}
</brief_history>

<shared_knowledge>
${sharedKnowledge ? sharedKnowledge : "<no_shared_knowledge>No shared knowledge available yet.</no_shared_knowledge>"}
</shared_knowledge>
</intent_context>`

		return intentContext
	}
}
