export type HookErrorBase = {
	error_type: string
	code: string
	intent_id: string
	tool?: string
	message: string
}

export function serializeHookError(base: HookErrorBase, extras: Record<string, unknown> = {}): string {
	return JSON.stringify({ ...base, ...extras })
}
