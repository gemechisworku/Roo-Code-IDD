import { describe, it, expect, vi } from "vitest"

vi.mock("../../utils/single-completion-handler", () => ({
	singleCompletionHandler: vi.fn(),
}))

import { singleCompletionHandler } from "../../utils/single-completion-handler"
import { classifyUserIntent } from "../UserIntentClassifier"

const singleCompletionHandlerMock = vi.mocked(singleCompletionHandler)

describe("UserIntentClassifier", () => {
	it("treats create/add requests as safe when no API configuration is provided", async () => {
		const result = await classifyUserIntent("Create weather.ts with a basic GET handler.")
		expect(result.verdict).toBe("safe")
		expect(result.source).toBe("heuristic")
	})

	it("overrides destructive LLM verdict when safe keywords are present", async () => {
		singleCompletionHandlerMock.mockResolvedValue(
			`{"verdict":"destructive","reason":"writes files","confidence":0.9}`,
		)

		const result = await classifyUserIntent("Create weather.ts with a basic GET handler.", {
			apiProvider: "openai",
		} as any)

		expect(result.verdict).toBe("safe")
		expect(result.reason).toBe("safe_keyword_override")
		expect(result.source).toBe("heuristic")
	})
})
