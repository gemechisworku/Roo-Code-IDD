import path from "path"
import fs from "fs/promises"
import yaml from "yaml"

import { Task } from "../task/Task"
import { formatResponse } from "../prompts/responses"
import { getReadablePath } from "../../utils/path"
import type { ToolUse } from "../../shared/tools"

import { BaseTool, ToolCallbacks } from "./BaseTool"

interface SelectActiveIntentParams {
	intent_id: string
}

interface IntentSpec {
	id: string
	name: string
	status: string
	owned_scope: string[]
	constraints: string[]
	acceptance_criteria: string[]
}

export class SelectActiveIntentTool extends BaseTool<"select_active_intent"> {
	readonly name = "select_active_intent" as const

	async execute(params: SelectActiveIntentParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { pushToolResult, handleError } = callbacks
		const { intent_id } = params

		if (!intent_id) {
			task.consecutiveMistakeCount++
			task.recordToolError("select_active_intent")
			pushToolResult(await task.sayAndCreateMissingParamError("select_active_intent", "intent_id"))
			return
		}

		try {
			// Read the active_intents.yaml file
			const orchestrationDir = path.join(task.cwd, ".orchestration")
			const intentsFile = path.join(orchestrationDir, "active_intents.yaml")

			let intentsContent: string
			try {
				intentsContent = await fs.readFile(intentsFile, "utf-8")
			} catch (error) {
				pushToolResult(
					formatResponse.toolError(
						`Could not read .orchestration/active_intents.yaml: ${error.message}. Make sure the file exists.`,
					),
				)
				return
			}

			let intentsData: { active_intents: IntentSpec[] }
			try {
				intentsData = yaml.parse(intentsContent)
			} catch (error) {
				pushToolResult(
					formatResponse.toolError(
						`Could not parse .orchestration/active_intents.yaml: ${error.message}. Check YAML syntax.`,
					),
				)
				return
			}

			// Find the requested intent
			const selectedIntent = intentsData.active_intents?.find((intent) => intent.id === intent_id)

			if (!selectedIntent) {
				const availableIds = intentsData.active_intents?.map((intent) => intent.id).join(", ") || "none"
				pushToolResult(
					formatResponse.toolError(`Intent "${intent_id}" not found. Available intents: ${availableIds}`),
				)
				return
			}

			// Check if intent is in progress
			if (selectedIntent.status !== "IN_PROGRESS") {
				pushToolResult(
					formatResponse.toolError(
						`Intent "${intent_id}" is not in IN_PROGRESS status (current: ${selectedIntent.status}). Only IN_PROGRESS intents can be selected.`,
					),
				)
				return
			}

			const isTraceRelated = (trace: any) => {
				if (!trace) return false
				if (trace.intent_id === intent_id || trace.intentId === intent_id) return true
				return trace.files?.some((file: any) =>
					file.conversations?.some((conv: any) =>
						conv.related?.some((rel: any) => rel.type === "specification" && rel.value === intent_id),
					),
				)
			}

			const formatTraceEntry = (trace: any) => {
				const files = Array.isArray(trace.files) ? trace.files : []
				const fileBlocks = files
					.map((file: any) => {
						const relPath = file.relative_path || file.path || "unknown"
						const conversations = Array.isArray(file.conversations) ? file.conversations : []
						const fallbackConversation =
							conversations.length === 0 && file.content_hash
								? [
										{
											contributor: trace.contributor,
											ranges: [{ content_hash: file.content_hash }],
										},
									]
								: conversations

						if (!fallbackConversation || fallbackConversation.length === 0) {
							return `    <file path="${relPath}"/>\n`
						}

						return (
							`    <file path="${relPath}">\n` +
							fallbackConversation
								.map((conv: any) => {
									const contributorId =
										conv.contributor?.model_identifier ||
										conv.contributor ||
										trace.contributor?.model_identifier ||
										trace.contributor ||
										"unknown"
									const ranges = Array.isArray(conv.ranges) ? conv.ranges : []
									const rangeLines = ranges
										.map((range: any) => {
											const start = range.start_line ?? range.startLine
											const end = range.end_line ?? range.endLine ?? start
											const hash = range.content_hash ?? range.hash
											if (hash && typeof start === "number" && typeof end === "number") {
												return `        <range lines="${start}-${end}" hash="${hash}"/>\n`
											}
											if (hash) {
												return `        <range hash="${hash}"/>\n`
											}
											return ""
										})
										.join("")
									return (
										`      <conversation contributor="${contributorId}">\n` +
										rangeLines +
										`      </conversation>\n`
									)
								})
								.join("") +
							`    </file>\n`
						)
					})
					.join("")

				return `<trace_entry id="${trace.id}" timestamp="${trace.timestamp}">\n${fileBlocks}</trace_entry>\n`
			}

			// Read agent_trace.jsonl for related history
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
					.filter((trace) => isTraceRelated(trace))
					.slice(-5) // Last 5 related traces
			} catch (error) {
				// Trace file might not exist yet, that's okay
			}

			// Read shared knowledge from AGENT.md
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
${selectedIntent.owned_scope.map((scope) => `  <path>${scope}</path>`).join("\n")}
</owned_scope>
<constraints>
${selectedIntent.constraints.map((constraint) => `  <constraint>${constraint}</constraint>`).join("\n")}
</constraints>
<acceptance_criteria>
${selectedIntent.acceptance_criteria.map((criteria) => `  <criteria>${criteria}</criteria>`).join("\n")}
</acceptance_criteria>
</intent_specification>

<brief_history>
${
	relatedTraces.length > 0
		? relatedTraces.map((trace) => formatTraceEntry(trace)).join("")
		: "<no_previous_work>No previous work found for this intent.</no_previous_work>"
}
</brief_history>

<shared_knowledge>
${sharedKnowledge ? sharedKnowledge : "<no_shared_knowledge>No shared knowledge available yet.</no_shared_knowledge>"}
</shared_knowledge>
</intent_context>`

			// Return the context as the tool result
			pushToolResult(intentContext)
		} catch (error) {
			await handleError("selecting active intent", error as Error)
		}
	}
}

export const selectActiveIntentTool = new SelectActiveIntentTool()
