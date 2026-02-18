import { describe, it, expect } from "vitest"
import { isDestructiveTool, registerDestructiveTool, unregisterDestructiveTool } from "../ToolClassifier"

describe("ToolClassifier", () => {
	it("should identify built-in destructive tools", () => {
		expect(isDestructiveTool("write_to_file")).toBe(true)
		expect(isDestructiveTool("apply_patch")).toBe(true)
	})

	it("should return false for safe tools", () => {
		expect(isDestructiveTool("list_files")).toBe(false)
		expect(isDestructiveTool(undefined)).toBe(false)
	})

	it("should allow registering and unregistering custom destructive tools", () => {
		const name = "my_custom_destructive"
		expect(isDestructiveTool(name)).toBe(false)
		registerDestructiveTool(name)
		expect(isDestructiveTool(name)).toBe(true)
		unregisterDestructiveTool(name)
		expect(isDestructiveTool(name)).toBe(false)
	})
})
