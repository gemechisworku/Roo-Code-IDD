import path from "path"
import fs from "fs/promises"

import type { ToolUse } from "../shared/tools"
import type { Task } from "../core/task/Task"
import type { PreToolHook, PreHookResult } from "./types"
import { isDestructiveTool } from "./ToolClassifier"

/**
 * Scope Enforcement Hook
 * - Ensures an active intent is selected before destructive tools run
 * - Validates target paths against the intent's owned_scope
 * - Prompts user (HITL) when a potential violation is detected
 */
export class ScopeEnforcementHook implements PreToolHook {
	name = "scope_enforcement"
	phase = "pre" as const

	async execute(task: Task, toolUse: ToolUse): Promise<PreHookResult> {
		const cwd = task.cwd

		// Only apply enforcement for classified destructive tools
		if (!isDestructiveTool(toolUse.name)) {
			return { shouldProceed: true }
		}

		// Load active intent information from task state (set by ContextInjectorHook)
		let activeIntent: any = (task as any).activeIntent
		if (!activeIntent || !activeIntent.id) {
			return {
				shouldProceed: false,
				errorMessage:
					"No active intent selected. Please run select_active_intent before performing destructive actions.",
			}
		}

		// Check .orchestration/.intentignore - if intent id is listed, skip enforcement
		try {
			const orchestrationDir = path.join(cwd, ".orchestration")
			const ignoreFile = path.join(orchestrationDir, ".intentignore")
			const txt = await fs.readFile(ignoreFile, "utf-8")
			const lines = txt
				.split(/\r?\n/)
				.map((l) => l.trim())
				.filter(Boolean)
				.filter((l) => !l.startsWith("#"))
			if (lines.includes(activeIntent.id)) {
				return { shouldProceed: true }
			}
		} catch {
			// ignore missing file
		}

		// Special handling: execute_command requires explicit approval via UI
		if (toolUse.name === "execute_command") {
			const cmd = (toolUse.nativeArgs as any)?.command || (toolUse.params as any)?.command
			const prompt = `The agent requests to run command: ${cmd}. Approve?`
			const { response } = await task.ask("tool", prompt)
			if (response !== "yesButtonClicked") {
				const err = {
					error_type: "command_not_authorized",
					code: "CMD-001",
					intent_id: activeIntent.id,
					command: cmd,
					message: "User denied executing command",
				}
				return { shouldProceed: false, errorMessage: JSON.stringify(err) }
			}
			return { shouldProceed: true }
		}

		// Extract paths targeted by the tool
		const targetPaths = this.extractPathsFromToolUse(toolUse)

		if (!targetPaths || targetPaths.length === 0) {
			const { response } = await task.ask(
				"tool",
				`The agent is attempting a destructive operation (${toolUse.name}) but the target files could not be determined. Approve?`,
			)
			if (response !== "yesButtonClicked") {
				const err = {
					error_type: "unknown_targets",
					code: "REQ-002",
					intent_id: activeIntent.id,
					tool: toolUse.name,
					message: "User denied operation with unknown targets",
				}
				return { shouldProceed: false, errorMessage: JSON.stringify(err) }
			}
			return { shouldProceed: true }
		}

		// Determine owned scope roots for the active intent
		const ownedScope: string[] = this.getOwnedScopeFromTask(activeIntent)

		// Validate each target path is within an owned scope
		for (const p of targetPaths) {
			const absTarget = path.resolve(task.cwd, p)
			const allowed = ownedScope.some((root) => {
				const absRoot = path.resolve(task.cwd, root)
				return absTarget === absRoot || absTarget.startsWith(absRoot + path.sep)
			})

			if (!allowed) {
				const { response } = await task.ask(
					"tool",
					`The agent wants to modify '${p}', which is outside the intent's owned scope. Approve?`,
				)
				if (response !== "yesButtonClicked") {
					const err = {
						error_type: "scope_violation",
						code: "REQ-001",
						intent_id: activeIntent.id,
						filename: p,
						message: `Intent not authorized to edit ${p}`,
					}
					return { shouldProceed: false, errorMessage: JSON.stringify(err) }
				}
			}
		}

		return { shouldProceed: true }
	}

	private extractPathsFromToolUse(toolUse: ToolUse): string[] {
		const paths: string[] = []

		const tryAdd = (p: any) => {
			if (!p) return
			if (Array.isArray(p)) p.forEach((x) => tryAdd(x))
			else if (typeof p === "string") paths.push(p)
			else if (typeof p === "object") {
				// try common fields
				if (p.path) tryAdd(p.path)
				if (p.file_path) tryAdd(p.file_path)
				if (p.files) tryAdd(p.files)
			}
		}

		tryAdd((toolUse.nativeArgs as any) || toolUse.params)

		return paths.map((p) => String(p))
	}

	private getOwnedScopeFromTask(activeIntent: any): string[] {
		// activeIntent may contain parsed intent or an injected xml string in .context
		if (!activeIntent) return []

		// If activeIntent.context exists and is an object with owned_scope, use it
		const ctx = activeIntent.context
		if (ctx && typeof ctx === "object" && Array.isArray(ctx.owned_scope)) {
			return ctx.owned_scope
		}

		// If context is an XML string produced by ContextInjectorHook, do a simple parse for <path> tags
		if (ctx && typeof ctx === "string") {
			const matches = Array.from(ctx.matchAll(/<path>(.*?)<\/path>/g))
			if (matches.length > 0) {
				return matches.map((m) => m[1])
			}
		}

		// Fallback: check activeIntent.selectedAt or id and attempt to read from disk would be done by ContextInjectorHook earlier.
		return []
	}
}
