import type { ToolUse } from "../shared/tools"
import type { Task } from "../core/task/Task"
import type { Hook, PreToolHook, PostToolHook, PreHookResult, PostHookResult } from "./types"

/**
 * Hook Engine - Manages and executes hooks for tool operations
 *
 * This is the core middleware that intercepts tool executions to enforce
 * intent context, authorization, and traceability.
 */
export class HookEngine {
	private hooks: Hook[] = []

	/**
	 * Register a hook with the engine
	 */
	registerHook(hook: Hook): void {
		this.hooks.push(hook)
	}

	/**
	 * Execute all pre-hooks for a tool
	 */
	async executePreHooks(task: Task, toolUse: ToolUse): Promise<PreHookResult> {
		const applicableHooks = this.getApplicableHooks(toolUse.name, "pre") as PreToolHook[]

		let finalResult: PreHookResult = { shouldProceed: true }

		for (const hook of applicableHooks) {
			try {
				const result = await hook.execute(task, toolUse)

				// If any hook blocks execution, stop and return the error
				if (!result.shouldProceed) {
					return {
						shouldProceed: false,
						errorMessage: result.errorMessage || `Hook "${hook.name}" blocked execution`,
					}
				}

				// Merge context injection
				if (result.injectedContext) {
					finalResult.injectedContext = (finalResult.injectedContext || "") + result.injectedContext
				}

				// Use modified params if provided
				if (result.modifiedParams) {
					finalResult.modifiedParams = result.modifiedParams
				}
			} catch (error) {
				console.error(`Pre-hook "${hook.name}" failed:`, error)
				return {
					shouldProceed: false,
					errorMessage: `Hook execution failed: ${error.message}`,
				}
			}
		}

		return finalResult
	}

	/**
	 * Execute all post-hooks for a tool
	 */
	async executePostHooks(task: Task, toolUse: ToolUse, result: any): Promise<PostHookResult[]> {
		const applicableHooks = this.getApplicableHooks(toolUse.name, "post") as PostToolHook[]
		const results: PostHookResult[] = []

		for (const hook of applicableHooks) {
			try {
				const hookResult = await hook.execute(task, toolUse, result)
				results.push(hookResult)
			} catch (error) {
				console.error(`Post-hook "${hook.name}" failed:`, error)
				results.push({
					success: false,
					errorMessage: `Hook execution failed: ${error.message}`,
				})
			}
		}

		return results
	}

	/**
	 * Get hooks applicable to a specific tool and phase
	 */
	private getApplicableHooks(toolName: string, phase: "pre" | "post"): Hook[] {
		return this.hooks.filter((hook) => {
			if (hook.phase !== phase) return false
			if (!hook.toolFilter) return true
			return hook.toolFilter.includes(toolName)
		})
	}

	/**
	 * Get all registered hooks
	 */
	getRegisteredHooks(): Hook[] {
		return [...this.hooks]
	}

	/**
	 * Clear all hooks (useful for testing)
	 */
	clearHooks(): void {
		this.hooks = []
	}
}
