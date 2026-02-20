import { describe, it, expect, vi } from "vitest"
import fs from "fs/promises"
import path from "path"
import os from "os"
import * as vscode from "vscode"
import { ScopeEnforcementHook } from "../ScopeEnforcementHook"

vi.mock("vscode", () => ({
	window: {
		showWarningMessage: vi.fn(),
	},
}))

describe("ScopeEnforcementHook decision persistence", () => {
	it("persists decisions to .orchestration/intent-decisions.jsonl", async () => {
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "intent-decisions-"))
		const hook = new ScopeEnforcementHook()

		const task: any = {
			cwd: tmp,
			activeIntent: {
				id: "i1",
				context: `<intent_context><owned_scope><path>src</path></owned_scope></intent_context>`,
			},
		}

		// Simulate a toolUse attempting to modify outside scope and user rejects
		;(vscode.window.showWarningMessage as any).mockResolvedValue({ title: "Reject" })

		const toolUse: any = {
			name: "write_to_file",
			params: { path: path.join("other", "foo.ts"), intent_id: "i1", mutation_class: "AST_REFACTOR" },
		}

		const res = await hook.execute(task, toolUse)
		expect(res.shouldProceed).toBe(false)

		// Check file exists and contains the decision
		const outFile = path.join(tmp, ".orchestration", "intent-decisions.jsonl")
		const content = await fs.readFile(outFile, "utf-8")
		const last = content.trim().split("\n").pop()
		const parsed = JSON.parse(last || "{}")
		expect(parsed.intent_id).toBe("i1")
		expect(parsed.decision).toBe("rejected")

		await fs.rm(tmp, { recursive: true, force: true })
	})
})
