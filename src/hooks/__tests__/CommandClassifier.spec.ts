import { describe, it, expect } from "vitest"
import fs from "fs/promises"
import path from "path"
import os from "os"
import { classifyCommand } from "../CommandClassifier"

describe("CommandClassifier with project policy", () => {
	it("respects command-policy.json in .orchestration", async () => {
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cmd-policy-"))
		const orch = path.join(tmp, ".orchestration")
		await fs.mkdir(orch)
		const policy = {
			safe: ["^custom-safe\\s"],
			destructive: ["^custom-destroy\\s"],
		}
		await fs.writeFile(path.join(orch, "command-policy.json"), JSON.stringify(policy))

		expect(classifyCommand("custom-safe do something", tmp)).toBe("safe")
		expect(classifyCommand("custom-destroy /", tmp)).toBe("destructive")

		// cleanup
		await fs.rm(tmp, { recursive: true, force: true })
	})

	it("classifies common PowerShell safe commands as safe", () => {
		expect(classifyCommand("Get-ChildItem")).toBe("safe")
		expect(classifyCommand("gci -Force")).toBe("safe")
		expect(classifyCommand("Get-Location")).toBe("safe")
		expect(classifyCommand("Get-Content README.md")).toBe("safe")
	})

	it("classifies PowerShell remove commands as destructive", () => {
		expect(classifyCommand("Remove-Item _qa_in_scope.txt")).toBe("destructive")
		expect(classifyCommand("ri _qa_in_scope.txt")).toBe("destructive")
	})
})
