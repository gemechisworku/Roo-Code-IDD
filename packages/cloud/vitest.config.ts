import { defineConfig } from "vitest/config"
import path from "path"
import { fileURLToPath } from "url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
	resolve: {
		alias: {
			// Redirect `vscode` imports to our runtime shim during tests
			vscode: path.resolve(__dirname, "src/vscode-shim.ts"),
		},
	},
	test: {
		environment: "node",
		globals: true,
	},
})
