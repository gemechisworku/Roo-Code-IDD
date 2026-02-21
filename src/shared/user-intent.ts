export type UserIntentVerdict = "safe" | "destructive" | "unknown"

export type UserIntentSource = "llm" | "heuristic" | "fallback" | "none"

export interface UserIntentClassification {
	verdict: UserIntentVerdict
	reason?: string
	confidence?: number
	source: UserIntentSource
	messageHash?: string
}
