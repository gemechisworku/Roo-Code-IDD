import { describe, it, expect } from "vitest"
import path from "path"
import { ScopeEnforcementHook } from "../ScopeEnforcementHook"

function makeTask(overrides: any = {}) {
	return {
		cwd: process.cwd(),
		ask: async (_type: string, _message?: string) => ({ response: "yesButtonClicked" }),
		...overrides,
	} as any
}

describe("ScopeEnforcementHook", () => {
	it("blocks when no active intent is selected", async () => {
		const hook = new ScopeEnforcementHook()
		const task = makeTask({ activeIntent: undefined })
		const toolUse: any = { name: "write_to_file", params: { path: "src/foo.ts" } }

		const res = await hook.execute(task, toolUse)
		expect(res.shouldProceed).toBe(false)
		expect(res.errorMessage).toMatch(/No active intent selected/)
	})

	it("allows modification inside owned scope", async () => {
		const hook = new ScopeEnforcementHook()
		const task = makeTask({
			activeIntent: {
				id: "i1",
				context: `<intent_context><owned_scope><path>src</path></owned_scope></intent_context>`,
			},
		})
		const toolUse: any = { name: "write_to_file", params: { path: path.join("src", "foo.ts") } }

		const res = await hook.execute(task, toolUse)
		expect(res.shouldProceed).toBe(true)
	})

	it("prompts and blocks when target is outside owned scope and user denies", async () => {
		const hook = new ScopeEnforcementHook()
		const task = makeTask({
			activeIntent: {
				id: "i1",
				context: `<intent_context><owned_scope><path>src</path></owned_scope></intent_context>`,
			},
			ask: async (_type: string, _message?: string) => ({ response: "noButtonClicked" }),
		})
		const toolUse: any = { name: "write_to_file", params: { path: path.join("other", "foo.ts") } }

		const res = await hook.execute(task, toolUse)
		expect(res.shouldProceed).toBe(false)
		// errorMessage should be JSON with error_type scope_violation
		const err = JSON.parse(res.errorMessage as string)
		expect(err.error_type).toBe("scope_violation")
		expect(err.code).toBe("REQ-001")
		expect(err.intent_id).toBe("i1")
		expect(err.filename).toBe(path.join("other", "foo.ts"))
	})

	it("requires approval for execute_command and respects response", async () => {
		const hook = new ScopeEnforcementHook()
		// Deny first
		const denyTask = makeTask({
			activeIntent: {
				id: "i1",
				context: `<intent_context><owned_scope><path>src</path></owned_scope></intent_context>`,
			},
			ask: async (_type: string, _message?: string) => ({ response: "noButtonClicked" }),
		})
		const cmdUse: any = { name: "execute_command", nativeArgs: { command: "rm -rf /" } }
		const res1 = await hook.execute(denyTask, cmdUse)
		expect(res1.shouldProceed).toBe(false)
		const err = JSON.parse(res1.errorMessage as string)
		expect(err.error_type).toBe("command_not_authorized")

		// Approve
		const approveTask = makeTask({
			activeIntent: {
				id: "i1",
				context: `<intent_context><owned_scope><path>src</path></owned_scope></intent_context>`,
			},
			ask: async (_type: string, _message?: string) => ({ response: "yesButtonClicked" }),
		})
		const res2 = await hook.execute(approveTask, cmdUse)
		expect(res2.shouldProceed).toBe(true)
	})
})
