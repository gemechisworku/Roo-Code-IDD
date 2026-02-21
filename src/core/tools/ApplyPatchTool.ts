import fs from "fs/promises"
import path from "path"

import { type ClineSayTool, DEFAULT_WRITE_DELAY_MS } from "@roo-code/types"

import { getReadablePath, toPosixPath } from "../../utils/path"
import { isPathOutsideWorkspace } from "../../utils/pathUtils"
import { Task } from "../task/Task"
import { formatResponse } from "../prompts/responses"
import { RecordSource } from "../context-tracking/FileContextTrackerTypes"
import { fileExistsAtPath } from "../../utils/fs"
import { EXPERIMENT_IDS, experiments } from "../../shared/experiments"
import { sanitizeUnifiedDiff, computeDiffStats } from "../diff/stats"
import { BaseTool, ToolCallbacks } from "./BaseTool"
import type { ToolUse } from "../../shared/tools"
import { parsePatch, ParseError, processAllHunks } from "./apply-patch"
import type { ApplyPatchFileChange } from "./apply-patch"
import { buildStaleFileError, checkOptimisticLock, markStaleFile } from "../../hooks/optimisticLock"
import { hashContent } from "../../hooks/traceUtils"
import { serializeHookError } from "../../hooks/hookErrors"
import { appendWithLock } from "../../hooks/appendWithLock"

interface ApplyPatchParams {
	patch: string
}

export class ApplyPatchTool extends BaseTool<"apply_patch"> {
	readonly name = "apply_patch" as const

	private static readonly FILE_HEADER_MARKERS = ["*** Add File: ", "*** Delete File: ", "*** Update File: "] as const
	private static readonly DIAGNOSTICS_FILE = path.join(".orchestration", "agent-diagnostics.jsonl")

	private async logDiagnostics(task: Task, payload: Record<string, unknown>): Promise<void> {
		const entry = {
			ts: new Date().toISOString(),
			tool: this.name,
			...payload,
		}
		console.log("[agent-diagnostics][apply_patch]", entry)
		try {
			const diagPath = path.resolve(task.cwd, ApplyPatchTool.DIAGNOSTICS_FILE)
			await appendWithLock(diagPath, JSON.stringify(entry) + "\n")
		} catch (error) {
			console.warn("[agent-diagnostics][apply_patch] failed to append", error)
		}
	}

	private getSnapshotStatus(task: Task, toolCallId: string | undefined, relPath: string) {
		const store = (task as any).traceSnapshots as Map<string, Map<string, any>> | undefined
		if (!store) return { status: "no_store" }
		if (!toolCallId) return { status: "no_tool_call_id" }
		const snapshotMap = store.get(toolCallId)
		if (!snapshotMap) return { status: "no_tool_entry" }

		const candidates = new Set<string>()
		const raw = relPath || ""
		candidates.add(raw)
		candidates.add(raw.replace(/^[.][\\/]/, ""))
		candidates.add(toPosixPath(raw))
		candidates.add(toPosixPath(raw.replace(/^[.][\\/]/, "")))
		candidates.add(path.posix.normalize(toPosixPath(raw)))
		candidates.add(path.posix.normalize(toPosixPath(raw.replace(/^[.][\\/]/, ""))))

		for (const candidate of candidates) {
			if (snapshotMap.has(candidate)) {
				return { status: "found", key: candidate }
			}
		}

		return { status: "missing", keys: Array.from(snapshotMap.keys()).slice(0, 5) }
	}

	private extractFirstPathFromPatch(patch: string | undefined): string | undefined {
		if (!patch) {
			return undefined
		}

		const lines = patch.split("\n")
		const hasTrailingNewline = patch.endsWith("\n")
		const completeLines = hasTrailingNewline ? lines : lines.slice(0, -1)

		for (const rawLine of completeLines) {
			const line = rawLine.trim()

			for (const marker of ApplyPatchTool.FILE_HEADER_MARKERS) {
				if (!line.startsWith(marker)) {
					continue
				}

				const candidatePath = line.substring(marker.length).trim()
				if (candidatePath.length > 0) {
					return candidatePath
				}
			}
		}

		return undefined
	}

	async execute(params: ApplyPatchParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { patch } = params
		const { askApproval, handleError, pushToolResult } = callbacks

		try {
			// Validate required parameters
			if (!patch) {
				task.consecutiveMistakeCount++
				task.recordToolError("apply_patch")
				pushToolResult(await task.sayAndCreateMissingParamError("apply_patch", "patch"))
				return
			}

			// Parse the patch
			let parsedPatch
			try {
				parsedPatch = parsePatch(patch)
			} catch (error) {
				task.consecutiveMistakeCount++
				task.recordToolError("apply_patch")
				const errorMessage =
					error instanceof ParseError
						? `Invalid patch format: ${error.message}`
						: `Failed to parse patch: ${error instanceof Error ? error.message : String(error)}`
				pushToolResult(formatResponse.toolError(errorMessage))
				return
			}

			if (parsedPatch.hunks.length === 0) {
				pushToolResult("No file operations found in patch.")
				return
			}

			await this.logDiagnostics(task, {
				event: "parsed_patch",
				tool_call_id: callbacks.toolCallId,
				hunk_count: parsedPatch.hunks.length,
			})

			// Process each hunk
			const readFile = async (filePath: string): Promise<string> => {
				const absolutePath = path.resolve(task.cwd, filePath)
				return await fs.readFile(absolutePath, "utf8")
			}

			let changes: ApplyPatchFileChange[]
			try {
				changes = await processAllHunks(parsedPatch.hunks, readFile)
			} catch (error) {
				task.consecutiveMistakeCount++
				task.recordToolError("apply_patch")
				const errorMessage = `Failed to process patch: ${error instanceof Error ? error.message : String(error)}`
				pushToolResult(formatResponse.toolError(errorMessage))
				return
			}

			await this.logDiagnostics(task, {
				event: "processed_hunks",
				change_count: changes.length,
				changes: changes.map((change) => ({
					type: change.type,
					path: change.path,
					movePath: change.movePath,
					original_hash: change.originalContent ? hashContent(change.originalContent) : null,
					new_hash: change.newContent ? hashContent(change.newContent) : null,
				})),
			})

			// Process each file change
			for (const change of changes) {
				const relPath = change.path
				const absolutePath = path.resolve(task.cwd, relPath)

				// Check access permissions
				const accessAllowed = task.rooIgnoreController?.validateAccess(relPath)
				if (!accessAllowed) {
					await task.say("rooignore_error", relPath)
					pushToolResult(formatResponse.rooIgnoreError(relPath))
					return
				}

				// Check if file is write-protected
				const isWriteProtected = task.rooProtectedController?.isWriteProtected(relPath) || false

				await this.logDiagnostics(task, {
					event: "change_start",
					tool_call_id: callbacks.toolCallId,
					change_type: change.type,
					path: relPath,
					snapshot: this.getSnapshotStatus(task, callbacks.toolCallId, relPath),
				})

				if (change.type === "add") {
					// Create new file
					await this.handleAddFile(change, absolutePath, relPath, task, callbacks, isWriteProtected)
				} else if (change.type === "delete") {
					// Delete file
					await this.handleDeleteFile(
						absolutePath,
						relPath,
						task,
						callbacks,
						isWriteProtected,
						change.originalContent,
					)
				} else if (change.type === "update") {
					// Update file
					await this.handleUpdateFile(change, absolutePath, relPath, task, callbacks, isWriteProtected)
				}
			}

			task.consecutiveMistakeCount = 0
			task.recordToolUsage("apply_patch")
		} catch (error) {
			await handleError("apply patch", error as Error)
			await task.diffViewProvider.reset()
		}
	}

	private async handleAddFile(
		change: ApplyPatchFileChange,
		absolutePath: string,
		relPath: string,
		task: Task,
		callbacks: ToolCallbacks,
		isWriteProtected: boolean,
	): Promise<void> {
		const { askApproval, pushToolResult } = callbacks

		const staleError = await checkOptimisticLock(task, callbacks.toolCallId, relPath, this.name)
		if (staleError) {
			await this.logDiagnostics(task, {
				event: "stale_pre_add",
				tool_call_id: callbacks.toolCallId,
				path: relPath,
			})
			task.recordToolError("apply_patch", staleError)
			task.didToolFailInCurrentTurn = true
			pushToolResult(formatResponse.toolError(staleError))
			return
		}

		// Check if file already exists
		const fileExists = await fileExistsAtPath(absolutePath)
		if (fileExists) {
			task.consecutiveMistakeCount++
			task.recordToolError("apply_patch")
			const errorMessage = `File already exists: ${relPath}. Use Update File instead.`
			await task.say("error", errorMessage)
			pushToolResult(formatResponse.toolError(errorMessage))
			return
		}

		const newContent = change.newContent || ""
		const isOutsideWorkspace = isPathOutsideWorkspace(absolutePath)

		// Initialize diff view for new file
		task.diffViewProvider.editType = "create"
		task.diffViewProvider.originalContent = undefined

		const diff = formatResponse.createPrettyPatch(relPath, "", newContent)

		// Check experiment settings
		const provider = task.providerRef.deref()
		const state = await provider?.getState()
		const diagnosticsEnabled = state?.diagnosticsEnabled ?? true
		const writeDelayMs = state?.writeDelayMs ?? DEFAULT_WRITE_DELAY_MS
		const isPreventFocusDisruptionEnabled = experiments.isEnabled(
			state?.experiments ?? {},
			EXPERIMENT_IDS.PREVENT_FOCUS_DISRUPTION,
		)

		const sanitizedDiff = sanitizeUnifiedDiff(diff || "")
		const diffStats = computeDiffStats(sanitizedDiff) || undefined

		const sharedMessageProps: ClineSayTool = {
			tool: "appliedDiff",
			path: getReadablePath(task.cwd, relPath),
			diff: sanitizedDiff,
			isOutsideWorkspace,
		}

		const completeMessage = JSON.stringify({
			...sharedMessageProps,
			content: sanitizedDiff,
			isProtected: isWriteProtected,
			diffStats,
		} satisfies ClineSayTool)

		// Show diff view if focus disruption prevention is disabled
		if (!isPreventFocusDisruptionEnabled) {
			await task.diffViewProvider.open(relPath)
			await task.diffViewProvider.update(newContent, true)
			task.diffViewProvider.scrollToFirstDiff()
		}

		const didApprove = await askApproval("tool", completeMessage, undefined, isWriteProtected)

		if (!didApprove) {
			await this.logDiagnostics(task, {
				event: "rejected_add",
				tool_call_id: callbacks.toolCallId,
				path: relPath,
			})
			if (!isPreventFocusDisruptionEnabled) {
				await task.diffViewProvider.revertChanges()
			}
			pushToolResult("Changes were rejected by the user.")
			await task.diffViewProvider.reset()
			return
		}

		await this.logDiagnostics(task, {
			event: "stale_check_skipped_add",
			tool_call_id: callbacks.toolCallId,
			path: relPath,
			reason: "add_flow_uses_pre_save_guard",
		})

		// Save the changes
		if (isPreventFocusDisruptionEnabled) {
			const existsBeforeSave = await fileExistsAtPath(absolutePath)
			await this.logDiagnostics(task, {
				event: "pre_save_exists_add",
				tool_call_id: callbacks.toolCallId,
				path: relPath,
				exists: existsBeforeSave,
			})
			if (existsBeforeSave) {
				const diskContent = await fs.readFile(absolutePath, "utf8").catch(() => null)
				const err = buildStaleFileError(
					task,
					this.name,
					relPath,
					null,
					diskContent,
					"File appeared during approval; refresh before retrying",
				)
				task.recordToolError("apply_patch", err)
				task.didToolFailInCurrentTurn = true
				pushToolResult(formatResponse.toolError(err))
				await task.diffViewProvider.reset()
				return
			}
		}

		if (isPreventFocusDisruptionEnabled) {
			await task.diffViewProvider.saveDirectly(relPath, newContent, true, diagnosticsEnabled, writeDelayMs)
		} else {
			const saveResult = await task.diffViewProvider.saveChanges(diagnosticsEnabled, writeDelayMs)
			if (saveResult?.saveError) {
				await this.logDiagnostics(task, {
					event: "save_error_add",
					tool_call_id: callbacks.toolCallId,
					path: relPath,
					error_kind: saveResult.saveError.kind,
					error_message: saveResult.saveError.message,
				})
				if (saveResult.saveError.kind === "stale") {
					const err = buildStaleFileError(
						task,
						this.name,
						relPath,
						newContent,
						saveResult.finalContent ?? null,
						"File changed during save; refresh before retrying",
					)
					task.recordToolError("apply_patch", err)
					task.didToolFailInCurrentTurn = true
					pushToolResult(formatResponse.toolError(err))
					await task.diffViewProvider.reset()
					return
				}
				const errorMessage = `Failed to save '${relPath}': ${saveResult.saveError.message}`
				await task.say("error", errorMessage)
				pushToolResult(formatResponse.toolError(errorMessage))
				await task.diffViewProvider.reset()
				return
			}
			await this.logDiagnostics(task, {
				event: "save_result_add",
				tool_call_id: callbacks.toolCallId,
				path: relPath,
				user_edits: Boolean(saveResult?.userEdits),
			})
			if (saveResult?.userEdits) {
				await this.logDiagnostics(task, {
					event: "user_edits_detected_add",
					tool_call_id: callbacks.toolCallId,
					path: relPath,
					expected_hash: hashContent(newContent),
					actual_hash: hashContent(saveResult.finalContent || ""),
				})
				const expectedHash = hashContent(newContent)
				const actualHash = hashContent(saveResult.finalContent || "")
				const err = serializeHookError(
					{
						error_type: "stale_file",
						code: "REQ-007",
						intent_id: (task as any).activeIntent?.id || "",
						tool: this.name,
						message: "User modified the file before approval; refresh before retrying",
					},
					{ path: relPath, expected_hash: expectedHash, actual_hash: actualHash },
				)
				;(task as any).lastVerificationFailure = {
					type: "stale_file",
					intent_id: (task as any).activeIntent?.id || "",
					tool: this.name,
					path: relPath,
					expected_hash: expectedHash,
					actual_hash: actualHash,
					timestamp: new Date().toISOString(),
				}
				markStaleFile(task, relPath, this.name)
				task.recordToolError("apply_patch", err)
				task.didToolFailInCurrentTurn = true
				pushToolResult(formatResponse.toolError(err))
				await task.diffViewProvider.reset()
				return
			}
		}

		// Track file edit operation
		await task.fileContextTracker.trackFileContext(relPath, "roo_edited" as RecordSource)
		task.didEditFile = true

		const message = await task.diffViewProvider.pushToolWriteResult(task, task.cwd, true)
		pushToolResult(message)
		await task.diffViewProvider.reset()
		task.processQueuedMessages()
	}

	private async handleDeleteFile(
		absolutePath: string,
		relPath: string,
		task: Task,
		callbacks: ToolCallbacks,
		isWriteProtected: boolean,
		originalContent?: string,
	): Promise<void> {
		const { askApproval, pushToolResult } = callbacks

		const staleError = await checkOptimisticLock(task, callbacks.toolCallId, relPath, this.name)
		if (staleError) {
			await this.logDiagnostics(task, {
				event: "stale_pre_delete",
				tool_call_id: callbacks.toolCallId,
				path: relPath,
			})
			task.recordToolError("apply_patch", staleError)
			task.didToolFailInCurrentTurn = true
			pushToolResult(formatResponse.toolError(staleError))
			return
		}

		// Check if file exists
		const fileExists = await fileExistsAtPath(absolutePath)
		if (!fileExists) {
			task.consecutiveMistakeCount++
			task.recordToolError("apply_patch")
			const errorMessage = `File not found: ${relPath}. Cannot delete a non-existent file.`
			await task.say("error", errorMessage)
			pushToolResult(formatResponse.toolError(errorMessage))
			return
		}

		const isOutsideWorkspace = isPathOutsideWorkspace(absolutePath)

		const sharedMessageProps: ClineSayTool = {
			tool: "appliedDiff",
			path: getReadablePath(task.cwd, relPath),
			diff: `File will be deleted: ${relPath}`,
			isOutsideWorkspace,
		}

		const completeMessage = JSON.stringify({
			...sharedMessageProps,
			content: `Delete file: ${relPath}`,
			isProtected: isWriteProtected,
		} satisfies ClineSayTool)

		const didApprove = await askApproval("tool", completeMessage, undefined, isWriteProtected)

		if (!didApprove) {
			await this.logDiagnostics(task, {
				event: "rejected_delete",
				tool_call_id: callbacks.toolCallId,
				path: relPath,
			})
			pushToolResult("Delete operation was rejected by the user.")
			return
		}

		const staleAfterApproval = await checkOptimisticLock(task, callbacks.toolCallId, relPath, this.name)
		if (staleAfterApproval) {
			await this.logDiagnostics(task, {
				event: "stale_post_approve_delete",
				tool_call_id: callbacks.toolCallId,
				path: relPath,
			})
			task.recordToolError("apply_patch", staleAfterApproval)
			task.didToolFailInCurrentTurn = true
			pushToolResult(formatResponse.toolError(staleAfterApproval))
			return
		}

		if (originalContent !== undefined) {
			const currentContent = await fs.readFile(absolutePath, "utf8").catch(() => null)
			if (currentContent !== null && currentContent !== originalContent) {
				await this.logDiagnostics(task, {
					event: "stale_detected_delete",
					tool_call_id: callbacks.toolCallId,
					path: relPath,
					expected_hash: hashContent(originalContent),
					actual_hash: hashContent(currentContent),
				})
				const expectedHash = hashContent(originalContent)
				const actualHash = hashContent(currentContent)
				const err = serializeHookError(
					{
						error_type: "stale_file",
						code: "REQ-007",
						intent_id: (task as any).activeIntent?.id || "",
						tool: this.name,
						message: "File changed since tool started; refresh before retrying",
					},
					{ path: relPath, expected_hash: expectedHash, actual_hash: actualHash },
				)
				;(task as any).lastVerificationFailure = {
					type: "stale_file",
					intent_id: (task as any).activeIntent?.id || "",
					tool: this.name,
					path: relPath,
					expected_hash: expectedHash,
					actual_hash: actualHash,
					timestamp: new Date().toISOString(),
				}
				markStaleFile(task, relPath, this.name)
				task.recordToolError("apply_patch", err)
				task.didToolFailInCurrentTurn = true
				pushToolResult(formatResponse.toolError(err))
				return
			}
		}

		// Delete the file
		try {
			await fs.unlink(absolutePath)
		} catch (error) {
			const errorMessage = `Failed to delete file '${relPath}': ${error instanceof Error ? error.message : String(error)}`
			await task.say("error", errorMessage)
			pushToolResult(formatResponse.toolError(errorMessage))
			return
		}

		task.didEditFile = true
		pushToolResult(`Successfully deleted ${relPath}`)
		task.processQueuedMessages()
	}

	private async handleUpdateFile(
		change: ApplyPatchFileChange,
		absolutePath: string,
		relPath: string,
		task: Task,
		callbacks: ToolCallbacks,
		isWriteProtected: boolean,
	): Promise<void> {
		const { askApproval, pushToolResult } = callbacks

		const staleError = await checkOptimisticLock(task, callbacks.toolCallId, relPath, this.name)
		if (staleError) {
			await this.logDiagnostics(task, {
				event: "stale_pre_update",
				tool_call_id: callbacks.toolCallId,
				path: relPath,
			})
			task.recordToolError("apply_patch", staleError)
			task.didToolFailInCurrentTurn = true
			pushToolResult(formatResponse.toolError(staleError))
			return
		}

		// Check if file exists
		const fileExists = await fileExistsAtPath(absolutePath)
		if (!fileExists) {
			task.consecutiveMistakeCount++
			task.recordToolError("apply_patch")
			const errorMessage = `File not found: ${relPath}. Cannot update a non-existent file.`
			await task.say("error", errorMessage)
			pushToolResult(formatResponse.toolError(errorMessage))
			return
		}

		const originalContent = change.originalContent || ""
		const newContent = change.newContent || ""
		const isOutsideWorkspace = isPathOutsideWorkspace(absolutePath)

		if (newContent === originalContent) {
			pushToolResult(`No changes needed for '${relPath}'`)
			await task.diffViewProvider.reset()
			return
		}

		// Initialize diff view
		task.diffViewProvider.editType = "modify"
		task.diffViewProvider.originalContent = originalContent

		// Generate and validate diff
		const diff = formatResponse.createPrettyPatch(relPath, originalContent, newContent)
		if (!diff) {
			pushToolResult(`No changes needed for '${relPath}'`)
			await task.diffViewProvider.reset()
			return
		}

		// Check experiment settings
		const provider = task.providerRef.deref()
		const state = await provider?.getState()
		const diagnosticsEnabled = state?.diagnosticsEnabled ?? true
		const writeDelayMs = state?.writeDelayMs ?? DEFAULT_WRITE_DELAY_MS
		const isPreventFocusDisruptionEnabled = experiments.isEnabled(
			state?.experiments ?? {},
			EXPERIMENT_IDS.PREVENT_FOCUS_DISRUPTION,
		)

		const sanitizedDiff = sanitizeUnifiedDiff(diff)
		const diffStats = computeDiffStats(sanitizedDiff) || undefined

		const sharedMessageProps: ClineSayTool = {
			tool: "appliedDiff",
			path: getReadablePath(task.cwd, relPath),
			diff: sanitizedDiff,
			isOutsideWorkspace,
		}

		const completeMessage = JSON.stringify({
			...sharedMessageProps,
			content: sanitizedDiff,
			isProtected: isWriteProtected,
			diffStats,
		} satisfies ClineSayTool)

		// Show diff view if focus disruption prevention is disabled
		if (!isPreventFocusDisruptionEnabled) {
			await task.diffViewProvider.open(relPath)
			await task.diffViewProvider.update(newContent, true)
			task.diffViewProvider.scrollToFirstDiff()
		}

		const didApprove = await askApproval("tool", completeMessage, undefined, isWriteProtected)

		if (!didApprove) {
			await this.logDiagnostics(task, {
				event: "rejected_update",
				tool_call_id: callbacks.toolCallId,
				path: relPath,
			})
			if (!isPreventFocusDisruptionEnabled) {
				await task.diffViewProvider.revertChanges()
			}
			pushToolResult("Changes were rejected by the user.")
			await task.diffViewProvider.reset()
			return
		}

		const staleAfterApproval = await checkOptimisticLock(task, callbacks.toolCallId, relPath, this.name)
		if (staleAfterApproval) {
			await this.logDiagnostics(task, {
				event: "stale_post_approve_update",
				tool_call_id: callbacks.toolCallId,
				path: relPath,
			})
			task.recordToolError("apply_patch", staleAfterApproval)
			task.didToolFailInCurrentTurn = true
			pushToolResult(formatResponse.toolError(staleAfterApproval))
			if (!isPreventFocusDisruptionEnabled) {
				await task.diffViewProvider.revertChanges()
			}
			await task.diffViewProvider.reset()
			return
		}

		const currentContent = await fs.readFile(absolutePath, "utf8").catch(() => null)
		await this.logDiagnostics(task, {
			event: "current_content_check_update",
			tool_call_id: callbacks.toolCallId,
			path: relPath,
			current_exists: currentContent !== null,
			current_hash: currentContent !== null ? hashContent(currentContent) : null,
			original_hash: hashContent(originalContent),
			match: currentContent !== null ? currentContent === originalContent : null,
		})
		if (currentContent !== null && currentContent !== originalContent) {
			await this.logDiagnostics(task, {
				event: "stale_detected_update",
				tool_call_id: callbacks.toolCallId,
				path: relPath,
				expected_hash: hashContent(originalContent),
				actual_hash: hashContent(currentContent),
			})
			const expectedHash = hashContent(originalContent)
			const actualHash = hashContent(currentContent)
			const err = serializeHookError(
				{
					error_type: "stale_file",
					code: "REQ-007",
					intent_id: (task as any).activeIntent?.id || "",
					tool: this.name,
					message: "File changed since tool started; refresh before retrying",
				},
				{ path: relPath, expected_hash: expectedHash, actual_hash: actualHash },
			)
			;(task as any).lastVerificationFailure = {
				type: "stale_file",
				intent_id: (task as any).activeIntent?.id || "",
				tool: this.name,
				path: relPath,
				expected_hash: expectedHash,
				actual_hash: actualHash,
				timestamp: new Date().toISOString(),
			}
			markStaleFile(task, relPath, this.name)
			task.recordToolError("apply_patch", err)
			task.didToolFailInCurrentTurn = true
			pushToolResult(formatResponse.toolError(err))
			if (!isPreventFocusDisruptionEnabled) {
				await task.diffViewProvider.revertChanges()
			}
			await task.diffViewProvider.reset()
			return
		}

		// Handle file move if specified
		if (change.movePath) {
			const moveStaleError = await checkOptimisticLock(task, callbacks.toolCallId, change.movePath, this.name)
			if (moveStaleError) {
				task.recordToolError("apply_patch", moveStaleError)
				task.didToolFailInCurrentTurn = true
				pushToolResult(formatResponse.toolError(moveStaleError))
				await task.diffViewProvider.reset()
				return
			}

			const moveAbsolutePath = path.resolve(task.cwd, change.movePath)

			// Validate destination path access permissions
			const moveAccessAllowed = task.rooIgnoreController?.validateAccess(change.movePath)
			if (!moveAccessAllowed) {
				await task.say("rooignore_error", change.movePath)
				pushToolResult(formatResponse.rooIgnoreError(change.movePath))
				await task.diffViewProvider.reset()
				return
			}

			// Check if destination path is write-protected
			const isMovePathWriteProtected = task.rooProtectedController?.isWriteProtected(change.movePath) || false
			if (isMovePathWriteProtected) {
				task.consecutiveMistakeCount++
				task.recordToolError("apply_patch")
				const errorMessage = `Cannot move file to write-protected path: ${change.movePath}`
				await task.say("error", errorMessage)
				pushToolResult(formatResponse.toolError(errorMessage))
				await task.diffViewProvider.reset()
				return
			}

			// Check if destination path is outside workspace
			const isMoveOutsideWorkspace = isPathOutsideWorkspace(moveAbsolutePath)
			if (isMoveOutsideWorkspace) {
				task.consecutiveMistakeCount++
				task.recordToolError("apply_patch")
				const errorMessage = `Cannot move file to path outside workspace: ${change.movePath}`
				await task.say("error", errorMessage)
				pushToolResult(formatResponse.toolError(errorMessage))
				await task.diffViewProvider.reset()
				return
			}

			// Save new content to the new path
			if (isPreventFocusDisruptionEnabled) {
				await task.diffViewProvider.saveDirectly(
					change.movePath,
					newContent,
					false,
					diagnosticsEnabled,
					writeDelayMs,
				)
			} else {
				// Write to new path and delete old file
				const parentDir = path.dirname(moveAbsolutePath)
				await fs.mkdir(parentDir, { recursive: true })
				await fs.writeFile(moveAbsolutePath, newContent, "utf8")
			}

			// Delete the original file
			try {
				await fs.unlink(absolutePath)
			} catch (error) {
				console.error(`Failed to delete original file after move: ${error}`)
			}

			await task.fileContextTracker.trackFileContext(change.movePath, "roo_edited" as RecordSource)
		} else {
			// Save changes to the same file
			if (isPreventFocusDisruptionEnabled) {
				await task.diffViewProvider.saveDirectly(relPath, newContent, false, diagnosticsEnabled, writeDelayMs)
			} else {
				const saveResult = await task.diffViewProvider.saveChanges(diagnosticsEnabled, writeDelayMs)
				if (saveResult?.saveError) {
					await this.logDiagnostics(task, {
						event: "save_error_update",
						tool_call_id: callbacks.toolCallId,
						path: relPath,
						error_kind: saveResult.saveError.kind,
						error_message: saveResult.saveError.message,
					})
					if (saveResult.saveError.kind === "stale") {
						const err = buildStaleFileError(
							task,
							this.name,
							relPath,
							newContent,
							saveResult.finalContent ?? null,
							"File changed during save; refresh before retrying",
						)
						task.recordToolError("apply_patch", err)
						task.didToolFailInCurrentTurn = true
						pushToolResult(formatResponse.toolError(err))
						await task.diffViewProvider.reset()
						return
					}
					const errorMessage = `Failed to save '${relPath}': ${saveResult.saveError.message}`
					await task.say("error", errorMessage)
					pushToolResult(formatResponse.toolError(errorMessage))
					await task.diffViewProvider.reset()
					return
				}
				await this.logDiagnostics(task, {
					event: "save_result_update",
					tool_call_id: callbacks.toolCallId,
					path: relPath,
					user_edits: Boolean(saveResult?.userEdits),
				})
				if (saveResult?.userEdits) {
					await this.logDiagnostics(task, {
						event: "user_edits_detected_update",
						tool_call_id: callbacks.toolCallId,
						path: relPath,
						expected_hash: hashContent(newContent),
						actual_hash: hashContent(saveResult.finalContent || ""),
					})
					const expectedHash = hashContent(newContent)
					const actualHash = hashContent(saveResult.finalContent || "")
					const err = serializeHookError(
						{
							error_type: "stale_file",
							code: "REQ-007",
							intent_id: (task as any).activeIntent?.id || "",
							tool: this.name,
							message: "User modified the file before approval; refresh before retrying",
						},
						{ path: relPath, expected_hash: expectedHash, actual_hash: actualHash },
					)
					;(task as any).lastVerificationFailure = {
						type: "stale_file",
						intent_id: (task as any).activeIntent?.id || "",
						tool: this.name,
						path: relPath,
						expected_hash: expectedHash,
						actual_hash: actualHash,
						timestamp: new Date().toISOString(),
					}
					markStaleFile(task, relPath, this.name)
					task.recordToolError("apply_patch", err)
					task.didToolFailInCurrentTurn = true
					pushToolResult(formatResponse.toolError(err))
					await task.diffViewProvider.reset()
					return
				}
			}

			await task.fileContextTracker.trackFileContext(relPath, "roo_edited" as RecordSource)
		}

		task.didEditFile = true

		const message = await task.diffViewProvider.pushToolWriteResult(task, task.cwd, false)
		pushToolResult(message)
		await task.diffViewProvider.reset()
		task.processQueuedMessages()
	}

	override async handlePartial(task: Task, block: ToolUse<"apply_patch">): Promise<void> {
		const patch: string | undefined = block.params.patch
		const candidateRelPath = this.extractFirstPathFromPatch(patch)
		const fallbackDisplayPath = path.basename(task.cwd) || "workspace"
		const resolvedRelPath = candidateRelPath ?? ""
		const absolutePath = path.resolve(task.cwd, resolvedRelPath)
		const displayPath = candidateRelPath ? getReadablePath(task.cwd, candidateRelPath) : fallbackDisplayPath

		let patchPreview: string | undefined
		if (patch) {
			// Show first few lines of the patch
			const lines = patch.split("\n").slice(0, 5)
			patchPreview = lines.join("\n") + (patch.split("\n").length > 5 ? "\n..." : "")
		}

		const sharedMessageProps: ClineSayTool = {
			tool: "appliedDiff",
			path: displayPath || path.basename(task.cwd) || "workspace",
			diff: patchPreview || "Parsing patch...",
			isOutsideWorkspace: isPathOutsideWorkspace(absolutePath),
		}

		await task.ask("tool", JSON.stringify(sharedMessageProps), block.partial).catch(() => {})
	}
}

export const applyPatchTool = new ApplyPatchTool()
