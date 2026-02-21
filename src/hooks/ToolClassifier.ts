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

const safeTools = new Set<string>([
	"read_file",
	"list_files",
	"search_files",
	"codebase_search",
	"read_command_output",
	"access_mcp_resource",
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

export type ToolSafety = "safe" | "destructive" | "unknown"

export function classifyTool(toolName?: string): ToolSafety {
	if (!toolName) return "unknown"
	if (destructiveTools.has(toolName)) return "destructive"
	if (safeTools.has(toolName)) return "safe"
	return "unknown"
}

export function isDestructiveTool(toolName?: string): boolean {
	if (!toolName) return false
	return destructiveTools.has(toolName)
}

export function isSafeTool(toolName?: string): boolean {
	return classifyTool(toolName) === "safe"
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
