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
import type { UserIntentClassification } from "../shared/user-intent"
import { classifyUserIntent, hashUserMessage } from "./UserIntentClassifier"

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

		const isSelectActiveIntent = toolUse.name === "select_active_intent"
		const isExecuteCommand = toolUse.name === "execute_command"
		const isDestructiveToolUse = isDestructiveTool(toolUse.name)
		const requiresIntent = isExecuteCommand || isDestructiveToolUse

		// Load active intent information from task state (set by ContextInjectorHook)
		let activeIntent: any = (task as any).activeIntent
		if (requiresIntent && (!activeIntent || !activeIntent.id)) {
			return {
				shouldProceed: false,
				errorMessage:
					"No active intent selected. Please run select_active_intent before performing destructive actions.",
			}
		}

		// Check .orchestration/.intentignore - if intent id is listed, skip enforcement
		if (activeIntent?.id) {
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
		}

		const targetPaths = this.extractPathsFromToolUse(toolUse)
		let intentClassification: UserIntentClassification | null = null
		if (activeIntent?.id && !isSelectActiveIntent && !isExecuteCommand) {
			intentClassification = await this.getUserIntentClassification(task, toolUse, targetPaths)
		}

		if (isExecuteCommand) {
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

		if (!isDestructiveToolUse) {
			if (intentClassification?.verdict === "destructive") {
				const approvalKey = this.getDestructiveApprovalKey(intentClassification, toolUse, targetPaths)
				const prior = approvalKey ? this.getDestructiveIntentApproval(task, approvalKey) : undefined
				if (prior === true) {
					return { shouldProceed: true }
				}
				if (prior === false) {
					const err = {
						error_type: "destructive_intent_denied",
						code: "REQ-009",
						intent_id: activeIntent?.id ?? "",
						tool: toolUse.name,
						message: "User denied destructive intent confirmation",
					}
					return { shouldProceed: false, errorMessage: serializeHookError(err) }
				}

				const approved = await this.promptApproval(
					`The user request was classified as DESTRUCTIVE. Approve proceeding with this intent?`,
				)

				if (approvalKey) {
					this.setDestructiveIntentApproval(task, approvalKey, approved)
				}

				this.recordDecision(task, {
					intent_id: activeIntent?.id ?? "",
					tool: toolUse.name,
					decision: approved ? "approved" : "rejected",
					reason: "destructive_intent_preflight",
					targets: targetPaths,
					intent_classification: intentClassification ?? undefined,
				})

				if (!approved) {
					const err = {
						error_type: "destructive_intent_denied",
						code: "REQ-009",
						intent_id: activeIntent?.id ?? "",
						tool: toolUse.name,
						message: "User denied destructive intent confirmation",
					}
					return { shouldProceed: false, errorMessage: serializeHookError(err, { targets: targetPaths }) }
				}
			}
			return { shouldProceed: true }
		}

		// Metadata enforcement for mutating tools
		if (isMutatingTool(toolUse.name)) {
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

		const destructiveOpInfo = this.getDestructiveOperationInfo(toolUse)
		const requiresDestructivePrompt =
			isMutatingTool(toolUse.name) &&
			(destructiveOpInfo.isDestructive || intentClassification?.verdict === "destructive")

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
		const scopeViolations: string[] = []

		// Validate each target path is within an owned scope
		for (const p of targetPaths) {
			const absTarget = path.resolve(task.cwd, p)
			const relTarget = toPosixPath(path.relative(task.cwd, absTarget))
			const allowed = ownedScope.some((root) => {
				return this.matchesScope(root, absTarget, relTarget, task.cwd)
			})

			if (!allowed) {
				scopeViolations.push(p)
			}
		}

		if (requiresDestructivePrompt && scopeViolations.length === 0) {
			const approvalKey = this.getDestructiveApprovalKey(intentClassification, toolUse, targetPaths)
			const prior = approvalKey ? this.getDestructiveIntentApproval(task, approvalKey) : undefined
			if (prior === true) {
				return { shouldProceed: true }
			}
			if (prior === false) {
				const err = {
					error_type: "destructive_operation_denied",
					code: "REQ-008",
					intent_id: activeIntent.id,
					tool: toolUse.name,
					message: "User denied destructive operation",
				}
				return { shouldProceed: false, errorMessage: serializeHookError(err) }
			}

			const summary = this.buildDestructiveSummary(toolUse, destructiveOpInfo, targetPaths)
			const classifierNote =
				intentClassification?.verdict === "destructive"
					? `User request classified as destructive (${intentClassification.reason || "llm"}).`
					: ""
			const approved = await this.promptApproval(
				`The agent is about to perform a DESTRUCTIVE operation (${summary}). ${classifierNote} Approve?`,
			)

			if (approvalKey) {
				this.setDestructiveIntentApproval(task, approvalKey, approved)
			}

			this.recordDecision(task, {
				intent_id: activeIntent.id,
				tool: toolUse.name,
				decision: approved ? "approved" : "rejected",
				reason: "destructive_intent",
				targets: targetPaths,
				intent_classification: intentClassification ?? undefined,
			})

			if (!approved) {
				const err = {
					error_type: "destructive_operation_denied",
					code: "REQ-008",
					intent_id: activeIntent.id,
					tool: toolUse.name,
					message: "User denied destructive operation",
				}
				return { shouldProceed: false, errorMessage: serializeHookError(err, { targets: targetPaths }) }
			}
		}

		for (const p of scopeViolations) {
			const approved = await this.promptApproval(
				`The agent is attempting a destructive operation (${toolUse.name}) on '${p}', which is outside the intent's owned scope. Approve?`,
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

	private async logDiagnostics(task: Task, payload: Record<string, unknown>): Promise<void> {
		const entry = {
			ts: new Date().toISOString(),
			hook: this.name,
			...payload,
		}
		console.log("[agent-diagnostics][scope-enforcement]", entry)
		if (process.env.NODE_ENV === "test") {
			return
		}
		try {
			const diagPath = path.resolve(task.cwd, ".orchestration", "agent-diagnostics.jsonl")
			await appendWithLock(diagPath, JSON.stringify(entry) + "\n")
		} catch {
			// best-effort only
		}
	}

	private async getUserIntentClassification(
		task: Task,
		toolUse: ToolUse,
		targetPaths: string[],
	): Promise<UserIntentClassification | null> {
		const userText = (task as any).lastUserMessageText as string | undefined
		if (!userText || !userText.trim()) {
			return null
		}

		const messageHash = hashUserMessage(userText)
		const cached = (task as any).lastUserIntentClassification as UserIntentClassification | undefined
		if (cached && cached.messageHash === messageHash) {
			return cached
		}

		const classification = await classifyUserIntent(userText, (task as any).apiConfiguration, {
			tool: toolUse.name,
			targets: targetPaths,
		})
		const result: UserIntentClassification = { ...classification, messageHash }
		;(task as any).lastUserIntentClassification = result

		await this.logDiagnostics(task, {
			event: "intent_classification",
			tool: toolUse.name,
			verdict: result.verdict,
			source: result.source,
			confidence: result.confidence ?? null,
			message_hash: messageHash,
		})

		return result
	}

	private getDestructiveApprovalKey(
		intentClassification: UserIntentClassification | null,
		toolUse: ToolUse,
		targetPaths: string[],
	): string | null {
		if (intentClassification?.messageHash) return intentClassification.messageHash
		if (targetPaths.length > 0) return `${toolUse.name}:${targetPaths.join(",")}`
		return null
	}

	private getDestructiveIntentApproval(task: Task, key: string): boolean | undefined {
		const approvals = ((task as any).destructiveIntentApprovals ??= new Map<string, boolean>()) as Map<
			string,
			boolean
		>
		return approvals.get(key)
	}

	private setDestructiveIntentApproval(task: Task, key: string, approved: boolean): void {
		const approvals = ((task as any).destructiveIntentApprovals ??= new Map<string, boolean>()) as Map<
			string,
			boolean
		>
		approvals.set(key, approved)
	}

	private getDestructiveOperationInfo(toolUse: ToolUse): { isDestructive: boolean; summary?: string } {
		if (toolUse.name !== "apply_patch") {
			return { isDestructive: false }
		}

		const patch = (toolUse.params as any)?.patch ?? (toolUse.nativeArgs as any)?.patch
		if (typeof patch !== "string" || patch.trim().length === 0) {
			return { isDestructive: false }
		}

		const deletes: string[] = []
		const moves: string[] = []
		for (const rawLine of patch.split("\n")) {
			const line = rawLine.trim()
			if (line.startsWith("*** Delete File: ")) {
				const filePath = line.substring("*** Delete File: ".length).trim()
				if (filePath) deletes.push(filePath)
			}
			if (line.startsWith("*** Move to: ")) {
				const movePath = line.substring("*** Move to: ".length).trim()
				if (movePath) moves.push(movePath)
			}
		}

		if (deletes.length === 0 && moves.length === 0) {
			return { isDestructive: false }
		}

		const parts: string[] = []
		if (deletes.length > 0) {
			parts.push(`delete ${deletes.join(", ")}`)
		}
		if (moves.length > 0) {
			parts.push(`move ${moves.join(", ")}`)
		}

		return { isDestructive: true, summary: parts.join("; ") }
	}

	private buildDestructiveSummary(
		toolUse: ToolUse,
		opInfo: { isDestructive: boolean; summary?: string },
		targetPaths: string[],
	): string {
		if (opInfo.summary) return opInfo.summary
		if (targetPaths.length > 0) return `${toolUse.name} on ${targetPaths.join(", ")}`
		return toolUse.name
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
			intent_classification?: UserIntentClassification
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
