/**
 * ToolClassifier
 * Provides a simple, pluggable classification for tools as Safe or Destructive.
 */
const destructiveTools = new Set<string>([
	"write_to_file",
	"apply_diff",
	"edit",
	"search_and_replace",
	"search_replace",
	"edit_file",
	"apply_patch",
	"execute_command",
	"generate_image",
])

const mutatingTools = new Set<string>([
	"write_to_file",
	"apply_diff",
	"edit",
	"search_and_replace",
	"search_replace",
	"edit_file",
	"apply_patch",
	"generate_image",
])

export function isDestructiveTool(toolName?: string): boolean {
	if (!toolName) return false
	return destructiveTools.has(toolName)
}

export function isMutatingTool(toolName?: string): boolean {
	if (!toolName) return false
	return mutatingTools.has(toolName)
}

export function registerDestructiveTool(toolName: string): void {
	destructiveTools.add(toolName)
}

export function unregisterDestructiveTool(toolName: string): void {
	destructiveTools.delete(toolName)
}
