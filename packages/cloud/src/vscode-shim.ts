// Minimal runtime shim for `vscode` used by unit tests.
// Exports only the bits tests and runtime code expect: `commands.executeCommand`.
export const commands = {
	async executeCommand(_command: string, ..._args: unknown[]) {
		// No-op in test environment; return undefined to match VS Code API.
		return undefined
	},
}

export default { commands }
