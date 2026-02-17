import type { ToolUse } from "../shared/tools"
import type { Task } from "../core/task/Task"

/**
 * Hook execution phases
 */
export type HookPhase = "pre" | "post"

/**
 * Base hook interface
 */
export interface BaseHook {
	/**
	 * The name of the hook for identification
	 */
	name: string

	/**
	 * The phase when this hook should execute
	 */
	phase: HookPhase

	/**
	 * Optional filter for which tools this hook applies to
	 * If not specified, applies to all tools
	 */
	toolFilter?: string[]
}

/**
 * Pre-tool execution hook
 * Executed before a tool runs, can modify parameters or block execution
 */
export interface PreToolHook extends BaseHook {
	phase: "pre"

	/**
	 * Execute the pre-hook
	 * @param task The current task
	 * @param toolUse The tool use being executed
	 * @returns Promise resolving to hook result
	 */
	execute(task: Task, toolUse: ToolUse): Promise<PreHookResult>
}

/**
 * Post-tool execution hook
 * Executed after a tool runs, can process results or perform side effects
 */
export interface PostToolHook extends BaseHook {
	phase: "post"

	/**
	 * Execute the post-hook
	 * @param task The current task
	 * @param toolUse The tool use that was executed
	 * @param result The result of the tool execution
	 * @returns Promise resolving to hook result
	 */
	execute(task: Task, toolUse: ToolUse, result: any): Promise<PostHookResult>
}

/**
 * Result of a pre-hook execution
 */
export interface PreHookResult {
	/**
	 * Whether to proceed with tool execution
	 */
	shouldProceed: boolean

	/**
	 * Optional modified tool parameters
	 */
	modifiedParams?: any

	/**
	 * Optional error message if execution should be blocked
	 */
	errorMessage?: string

	/**
	 * Optional context to inject into the conversation
	 */
	injectedContext?: string
}

/**
 * Result of a post-hook execution
 */
export interface PostHookResult {
	/**
	 * Whether the hook execution was successful
	 */
	success: boolean

	/**
	 * Optional error message
	 */
	errorMessage?: string

	/**
	 * Optional side effects performed
	 */
	sideEffects?: string[]
}

/**
 * Union type for all hooks
 */
export type Hook = PreToolHook | PostToolHook
