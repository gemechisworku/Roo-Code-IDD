import type OpenAI from "openai"

const SELECT_ACTIVE_INTENT_DESCRIPTION = `Select and activate an intent from the .orchestration/active_intents.yaml file. This tool MUST be called as the first action when responding to any user request that involves code changes or modifications.

**Critical**: You CANNOT write code, modify files, or execute commands without first calling this tool to establish the active intent context. This ensures all changes are properly tracked and scoped.

The tool loads the intent's constraints, scope, and context, which will be injected into your reasoning process. Only proceed with implementation after this tool returns the intent context.

Example: For a request to "refactor the auth middleware", you would first call select_active_intent with the appropriate intent ID.`

const INTENT_ID_PARAMETER_DESCRIPTION = `The ID of the intent to activate (e.g., "INT-001", "INT-002"). This must match an existing intent in .orchestration/active_intents.yaml.`

export default {
	type: "function",
	function: {
		name: "select_active_intent",
		description: SELECT_ACTIVE_INTENT_DESCRIPTION,
		strict: true,
		parameters: {
			type: "object",
			properties: {
				intent_id: {
					type: "string",
					description: INTENT_ID_PARAMETER_DESCRIPTION,
				},
			},
			required: ["intent_id"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
