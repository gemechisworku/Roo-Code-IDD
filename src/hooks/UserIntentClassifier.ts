import crypto from "crypto"
import type { ProviderSettings } from "@roo-code/types"

import { singleCompletionHandler } from "../utils/single-completion-handler"
import type { UserIntentClassification, UserIntentVerdict } from "../shared/user-intent"

const MAX_PROMPT_CHARS = 2000

const DESTRUCTIVE_REGEX =
	/\b(delete|remove|erase|drop|truncate|wipe|destroy|rm|del|rmdir|format|reset|purge|overwrite|replace|rename|move|uninstall)\b/i
const SAFE_REGEX =
	/\b(read|list|show|view|explain|describe|search|find|inspect|create|add|append|insert|scaffold|initialize|setup|generate|edit|update|modify|change|refactor)\b/i

const CLASSIFIER_PROMPT = `You are a strict classifier for software change requests.
Determine whether the USER is explicitly asking for a destructive action.
Destructive actions include: delete/remove files, overwrite/replace content, move/rename files, reset/clean/format, drop databases, or run shell commands that modify data.
 Normal edits/refactors or creating new files or adding new code/content are NOT destructive.
 Safe actions are read-only or additive/iterative: list/view/read/explain/search, create/add/append, edit/update/modify/refactor.
If unclear, respond "unknown".

Return JSON ONLY in the following format:
{"verdict":"safe|destructive|unknown","reason":"short reason","confidence":0-1}`

function normalize(text: string): string {
	return (text ?? "").trim()
}

export function hashUserMessage(text: string): string {
	return crypto.createHash("sha256").update(text).digest("hex")
}

function clampConfidence(value: unknown): number | undefined {
	if (typeof value !== "number" || Number.isNaN(value)) return undefined
	return Math.max(0, Math.min(1, value))
}

function parseClassification(raw: string): UserIntentClassification | null {
	const trimmed = raw.trim()
	const match = trimmed.match(/\{[\s\S]*\}/)
	if (!match) return null
	try {
		const parsed = JSON.parse(match[0])
		const verdict = parsed?.verdict as UserIntentVerdict
		if (verdict !== "safe" && verdict !== "destructive" && verdict !== "unknown") return null
		return {
			verdict,
			reason: typeof parsed?.reason === "string" ? parsed.reason : undefined,
			confidence: clampConfidence(parsed?.confidence),
			source: "llm",
		}
	} catch {
		return null
	}
}

function heuristicClassify(text: string): UserIntentClassification {
	const normalized = normalize(text).toLowerCase()
	if (!normalized) {
		return { verdict: "unknown", source: "none" }
	}

	if (DESTRUCTIVE_REGEX.test(normalized)) {
		return {
			verdict: "destructive",
			reason: "heuristic_destructive_keyword",
			confidence: 0.4,
			source: "heuristic",
		}
	}

	if (SAFE_REGEX.test(normalized)) {
		return { verdict: "safe", reason: "heuristic_safe_keyword", confidence: 0.4, source: "heuristic" }
	}

	return { verdict: "unknown", source: "heuristic" }
}

export async function classifyUserIntent(
	userText: string,
	apiConfiguration?: ProviderSettings,
	context?: { tool?: string; targets?: string[] },
): Promise<UserIntentClassification> {
	const normalized = normalize(userText)
	if (!normalized) {
		return { verdict: "unknown", source: "none" }
	}

	const heuristic = heuristicClassify(normalized)
	if (!apiConfiguration || !apiConfiguration.apiProvider) {
		return heuristic
	}

	const truncated = normalized.slice(0, MAX_PROMPT_CHARS)
	const contextLines: string[] = []
	if (context?.tool) contextLines.push(`Planned tool: ${context.tool}`)
	if (context?.targets && context.targets.length > 0) {
		contextLines.push(`Targets: ${context.targets.slice(0, 10).join(", ")}`)
	}

	const prompt =
		CLASSIFIER_PROMPT +
		`\n\nUser request:\n"""${truncated}"""\n` +
		(contextLines.length > 0 ? `\nContext:\n${contextLines.join("\n")}\n` : "")

	try {
		const raw = await singleCompletionHandler(apiConfiguration, prompt)
		const parsed = parseClassification(raw)
		if (parsed) {
			if (
				parsed.verdict === "destructive" &&
				heuristic.verdict === "safe" &&
				!DESTRUCTIVE_REGEX.test(normalized)
			) {
				return {
					verdict: "safe",
					reason: "safe_keyword_override",
					confidence: heuristic.confidence ?? 0.4,
					source: "heuristic",
				}
			}
			return parsed
		}
		return { ...heuristic, source: "fallback" }
	} catch {
		return { ...heuristic, source: "fallback" }
	}
}
