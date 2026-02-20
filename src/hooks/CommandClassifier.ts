import fs from "fs"
import path from "path"
import yaml from "yaml"

export type CommandSafety = "safe" | "destructive"

const SAFE_COMMAND_PATTERNS: RegExp[] = [
	/^ls(\s|$)/,
	/^dir(\s|$)/,
	/^pwd(\s|$)/,
	/^whoami(\s|$)/,
	/^cat(\s|$)/,
	/^type(\s|$)/, // windows
	/^head(\s|$)/,
	/^tail(\s|$)/,
	/^git\s+status(\s|$)/,
	/^git\s+diff(\s|$)/,
	/^git\s+log(\s|$)/,
]

const DESTRUCTIVE_COMMAND_PATTERNS: RegExp[] = [
	/\brm(\s|$)/,
	/\bdel(\s|$)/,
	/\berase(\s|$)/,
	/\brmdir(\s|$)/,
	/\bmv(\s|$)/,
	/\bmove(\s|$)/,
	/\bcp(\s|$)/,
	/\bcopy(\s|$)/,
	/\btouch(\s|$)/,
	/\bmkdir(\s|$)/,
	/\bchmod(\s|$)/,
	/\bchown(\s|$)/,
	/\btee(\s|$)/,
	/\btruncate(\s|$)/,
	/\bperl\s+-pi\b/,
	/\bsed\s+-i\b/,
	/\bgit\s+(add|commit|push|checkout|reset|clean|revert|merge|branch)\b/,
	/\bpnpm\s+(install|add|remove|update|patch)\b/,
	/\bnpm\s+(install|add|remove|update)\b/,
	/\byarn\s+(add|remove|install|upgrade)\b/,
	/\bpip\s+(install|uninstall)\b/,
	/\bgo\s+build\b/,
	/\bcargo\s+(build|run|install)\b/,
	/\bmake(\s|$)/,
	/\bcmake(\s|$)/,
	/\btsc(\s|$)/,
	/\bdotnet\s+build\b/,
	/\bgradle(\s|$)/,
	/\bmvn(\s|$)/,
]

export function classifyCommand(command: string, cwd?: string): CommandSafety {
	const normalized = command.trim().toLowerCase()

	if (!normalized) return "destructive"

	// Any explicit redirection is treated as destructive.
	if (/[<>]/.test(normalized)) return "destructive"

	// Load optional policy from .orchestration/command-policy.(json|yaml)
	const policy = loadCommandPolicy(cwd || process.cwd())
	if (policy) {
		for (const p of policy.safe || []) {
			try {
				const re = new RegExp(p, "i")
				if (re.test(normalized)) return "safe"
			} catch {
				// ignore invalid patterns
			}
		}
		for (const p of policy.destructive || []) {
			try {
				const re = new RegExp(p, "i")
				if (re.test(normalized)) return "destructive"
			} catch {
				// ignore
			}
		}
	}

	for (const pattern of SAFE_COMMAND_PATTERNS) {
		if (pattern.test(normalized)) return "safe"
	}

	for (const pattern of DESTRUCTIVE_COMMAND_PATTERNS) {
		if (pattern.test(normalized)) return "destructive"
	}

	// Default to destructive for unknown commands.
	return "destructive"
}

function loadCommandPolicy(cwd: string): { safe?: string[]; destructive?: string[] } | null {
	try {
		const orch = path.join(cwd, ".orchestration")
		const jsonPath = path.join(orch, "command-policy.json")
		const yamlPath = path.join(orch, "command-policy.yaml")
		if (fs.existsSync(jsonPath)) {
			const content = fs.readFileSync(jsonPath, "utf-8")
			return JSON.parse(content)
		}
		if (fs.existsSync(yamlPath)) {
			const content = fs.readFileSync(yamlPath, "utf-8")
			return yaml.parse(content)
		}
	} catch {
		// ignore
	}
	return null
}
