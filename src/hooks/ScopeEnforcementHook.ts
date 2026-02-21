import path from "path"
import { toPosixPath } from "../utils/path"
import fs from "fs/promises"
import ignore from "ignore"
import * as vscode from "vscode"

import type { ToolUse } from "../shared/tools"
import type { Task } from "../core/task/Task"
import type { PreToolHook, PreHookResult } from "./types"
import { isDestructiveTool, isMutatingTool } from "./ToolClassifier"
import { classifyCommandWithDebug, type CommandSafety } from "./CommandClassifier"
import { serializeHookError } from "./hookErrors"
import { unescapeHtmlEntities } from "../utils/text-normalization"
import { extractTargetPaths } from "./traceUtils"
import { getStaleFileBlock, clearStaleFile } from "./optimisticLock"
import { appendWithLock } from "./appendWithLock"

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

		// Skip enforcement for partial tool calls to avoid prompting on incomplete args.
		if (toolUse.partial) {
			return { shouldProceed: true }
		}

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

		// Metadata enforcement for mutating tools
		if (isMutatingTool(toolUse.name)) {
			const targetPaths = this.extractPathsFromToolUse(toolUse)
			const blocked = targetPaths.filter((p) => getStaleFileBlock(task, p))
			if (blocked.length > 0) {
				const diagEntry = {
					ts: new Date().toISOString(),
					hook: this.name,
					event: "stale_lock",
					tool: toolUse.name,
					path: blocked[0],
				}
				console.log("[agent-diagnostics][stale-lock]", diagEntry)
				try {
					const diagPath = path.resolve(task.cwd, ".orchestration", "agent-diagnostics.jsonl")
					await appendWithLock(diagPath, JSON.stringify(diagEntry) + "\n")
				} catch {
					// best-effort only
				}

				const approved = await this.promptApproval(
					`The file '${blocked[0]}' changed since the last attempt. Approve overriding the stale lock and proceed?`,
				)
				if (!approved) {
					;(task as any).didRejectTool = true
					const err = {
						error_type: "stale_lock",
						code: "REQ-007",
						intent_id: activeIntent.id,
						tool: toolUse.name,
						message: "Stale file lock active; read file and retry or explicitly approve override",
					}
					return { shouldProceed: false, errorMessage: serializeHookError(err, { path: blocked[0] }) }
				}

				blocked.forEach((p) => clearStaleFile(task, p))
			}

			const metadata = this.getMutationMetadata(toolUse)
			const autoIntentId = metadata.intent_id ?? activeIntent.id
			const autoMutationClass = metadata.mutation_class ?? "INTENT_EVOLUTION"

			if (!metadata.intent_id || !metadata.mutation_class) {
				this.applyMutationMetadata(toolUse, autoIntentId, autoMutationClass)
			}

			if (autoIntentId !== activeIntent.id) {
				const err = {
					error_type: "intent_mismatch",
					code: "REQ-004",
					intent_id: activeIntent.id,
					message: "Provided intent_id does not match active intent",
				}
				return {
					shouldProceed: false,
					errorMessage: serializeHookError(err, { provided_intent_id: autoIntentId }),
				}
			}

			const mutationClass = autoMutationClass
			const allowed = new Set(["AST_REFACTOR", "INTENT_EVOLUTION"])
			if (!mutationClass || !allowed.has(mutationClass)) {
				const err = {
					error_type: "invalid_metadata",
					code: "REQ-005",
					intent_id: activeIntent.id,
					message: "mutation_class must be AST_REFACTOR or INTENT_EVOLUTION",
				}
				return {
					shouldProceed: false,
					errorMessage: serializeHookError(err, { mutation_class: mutationClass }),
				}
			}
		}

		// Special handling: execute_command classification + approval
		if (toolUse.name === "execute_command") {
			const cmdRaw = (toolUse.nativeArgs as any)?.command || (toolUse.params as any)?.command
			const command = unescapeHtmlEntities(String(cmdRaw ?? ""))
			const logger =
				typeof (task as any).providerRef?.deref === "function"
					? (task as any).providerRef.deref()?.log?.bind((task as any).providerRef.deref())
					: undefined
			const log = logger ?? ((message: string) => console.log(message))
			if (toolUse.partial) {
				log("[command-classifier] skipping classification for partial execute_command payload")
				return { shouldProceed: true }
			}

			if (!command.trim()) {
				log("[command-classifier] skipping classification for empty execute_command payload")
				return { shouldProceed: true }
			}

			const classificationTarget = this.unwrapShellCommand(command)
			if (classificationTarget !== command) {
				log(`[command-classifier] unwrapped="` + classificationTarget + `"`)
			}

			const classification = classifyCommandWithDebug(classificationTarget, task.cwd, log)

			if (classification === "safe") {
				this.recordDecision(task, {
					intent_id: activeIntent.id,
					tool: toolUse.name,
					decision: "approved",
					reason: "safe_command",
					command,
					command_classification: classification,
				})
				this.markCommandApproved(task, command)
				return { shouldProceed: true }
			}

			// Check persisted approvals to avoid prompting again for the same command
			const persisted = await this.loadPersistedDecisions(task.cwd)
			const prior = this.findMatchingApproval(
				persisted,
				(d) => d.tool === "execute_command" && d.command === command && d.intent_id === activeIntent.id,
			)
			if (prior) {
				this.recordDecision(task, {
					intent_id: activeIntent.id,
					tool: toolUse.name,
					decision: "approved",
					reason: "reused_approval",
					command,
					command_classification: classification,
				})
				this.markCommandApproved(task, command)
				return { shouldProceed: true }
			}

			const approved = await this.promptApproval(
				`The agent requests to run a DESTRUCTIVE command: ${command}. Approve?`,
			)

			this.recordDecision(task, {
				intent_id: activeIntent.id,
				tool: toolUse.name,
				decision: approved ? "approved" : "rejected",
				reason: "destructive_command",
				command,
				command_classification: classification,
			})

			if (!approved) {
				const err = {
					error_type: "command_not_authorized",
					code: "CMD-001",
					intent_id: activeIntent.id,
					tool: toolUse.name,
					message: "User denied executing command",
				}
				return {
					shouldProceed: false,
					errorMessage: serializeHookError(err, { command, classification }),
				}
			}

			this.markCommandApproved(task, command)
			return { shouldProceed: true }
		}

		// Extract paths targeted by the tool
		const targetPaths = this.extractPathsFromToolUse(toolUse)

		if (!targetPaths || targetPaths.length === 0) {
			const approved = await this.promptApproval(
				`The agent is attempting a destructive operation (${toolUse.name}) but the target files could not be determined. Approve?`,
			)
			this.recordDecision(task, {
				intent_id: activeIntent.id,
				tool: toolUse.name,
				decision: approved ? "approved" : "rejected",
				reason: "unknown_targets",
			})
			if (!approved) {
				const err = {
					error_type: "unknown_targets",
					code: "REQ-002",
					intent_id: activeIntent.id,
					tool: toolUse.name,
					message: "User denied operation with unknown targets",
				}
				return { shouldProceed: false, errorMessage: serializeHookError(err) }
			}
			return { shouldProceed: true }
		}

		// Determine owned scope roots for the active intent
		const ownedScope: string[] = this.getOwnedScopeFromTask(activeIntent)

		// Validate each target path is within an owned scope
		for (const p of targetPaths) {
			const absTarget = path.resolve(task.cwd, p)
			const relTarget = toPosixPath(path.relative(task.cwd, absTarget))
			const allowed = ownedScope.some((root) => {
				return this.matchesScope(root, absTarget, relTarget, task.cwd)
			})

			if (!allowed) {
				const approved = await this.promptApproval(
					`The agent wants to modify '${p}', which is outside the intent's owned scope. Approve?`,
				)
				this.recordDecision(task, {
					intent_id: activeIntent.id,
					tool: toolUse.name,
					decision: approved ? "approved" : "rejected",
					reason: "scope_violation",
					targets: [p],
				})
				if (!approved) {
					const err = {
						error_type: "scope_violation",
						code: "REQ-001",
						intent_id: activeIntent.id,
						message: `Intent not authorized to edit ${p}`,
					}
					return { shouldProceed: false, errorMessage: serializeHookError(err, { filename: p }) }
				}
			}
		}

		return { shouldProceed: true }
	}

	private extractPathsFromToolUse(toolUse: ToolUse): string[] {
		return extractTargetPaths(toolUse)
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

	private getMutationMetadata(toolUse: ToolUse): { intent_id?: string; mutation_class?: string } {
		const fromNative = (toolUse.nativeArgs as any) || {}
		const fromParams = (toolUse.params as any) || {}
		return {
			intent_id: fromNative.intent_id ?? fromParams.intent_id,
			mutation_class: fromNative.mutation_class ?? fromParams.mutation_class,
		}
	}

	private applyMutationMetadata(toolUse: ToolUse, intent_id: string, mutation_class: string): void {
		const nativeArgs = ((toolUse as any).nativeArgs ??= {})
		const params = ((toolUse as any).params ??= {})

		if (!nativeArgs.intent_id) nativeArgs.intent_id = intent_id
		if (!nativeArgs.mutation_class) nativeArgs.mutation_class = mutation_class

		if (!params.intent_id) params.intent_id = intent_id
		if (!params.mutation_class) params.mutation_class = mutation_class
	}

	private async promptApproval(message: string): Promise<boolean> {
		const result = await vscode.window.showWarningMessage(message, { modal: true }, "Approve", "Reject")
		if (!result) return false
		// The API may return a string or a MessageItem with a title.
		if (typeof result === "string") return result === "Approve"
		if ((result as any).title) return (result as any).title === "Approve"
		return false
	}

	private markCommandApproved(task: Task, command: string): void {
		const approvals = ((task as any).approvedCommands ??= new Set<string>()) as Set<string>
		approvals.add(command)
	}

	private unwrapShellCommand(command: string): string {
		const trimmed = command.trim()
		const match = trimmed.match(/^(?:powershell|pwsh)(?:\.exe)?\b[^\S\r\n]*-command[^\S\r\n]+(.+)$/i)
		if (!match) return trimmed

		let inner = match[1].trim()
		// Strip surrounding quotes if present
		if ((inner.startsWith('"') && inner.endsWith('"')) || (inner.startsWith("'") && inner.endsWith("'"))) {
			inner = inner.slice(1, -1)
		}

		return inner.trim()
	}

	private recordDecision(
		task: Task,
		decision: {
			intent_id: string
			tool: string
			decision: "approved" | "rejected"
			reason: string
			targets?: string[]
			command?: string
			command_classification?: CommandSafety
		},
	): void {
		const decisions = ((task as any).intentDecisions ??= []) as Array<any>
		const entry = { ...decision, timestamp: new Date().toISOString() }
		decisions.push(entry)

		// Persist decision to .orchestration/intent-decisions.jsonl for audit and reuse
		try {
			const orchestrationDir = path.join(task.cwd, ".orchestration")
			const outFile = path.join(orchestrationDir, "intent-decisions.jsonl")
			// Ensure directory exists (best-effort)
			fs.mkdir(orchestrationDir, { recursive: true }).catch(() => {})
			fs.appendFile(outFile, JSON.stringify(entry) + "\n").catch(() => {})
		} catch {
			// ignore persistence errors
		}
	}

	private async loadPersistedDecisions(cwd: string): Promise<any[]> {
		try {
			const orchestrationDir = path.join(cwd, ".orchestration")
			const outFile = path.join(orchestrationDir, "intent-decisions.jsonl")
			const content = await fs.readFile(outFile, "utf-8")
			return content
				.trim()
				.split(/\r?\n/)
				.filter(Boolean)
				.map((l) => {
					try {
						return JSON.parse(l)
					} catch {
						return null
					}
				})
				.filter(Boolean)
		} catch {
			return []
		}
	}

	private findMatchingApproval(decisions: any[], predicate: (d: any) => boolean) {
		return decisions.find((d) => d && d.decision === "approved" && predicate(d))
	}

	private matchesScope(scope: string, absTarget: string, relTarget: string, cwd: string): boolean {
		const scopePosix = toPosixPath(scope)
		const hasGlob = /[*?[\]]/.test(scopePosix)

		if (hasGlob) {
			const ig = ignore().add(scopePosix)
			return ig.ignores(relTarget)
		}

		const absRoot = path.resolve(cwd, scope)
		return absTarget === absRoot || absTarget.startsWith(absRoot + path.sep)
	}
}
