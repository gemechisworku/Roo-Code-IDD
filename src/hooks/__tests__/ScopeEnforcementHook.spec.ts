import { describe, it, expect, vi, beforeEach } from "vitest"
import path from "path"
import * as vscode from "vscode"
import { ScopeEnforcementHook } from "../ScopeEnforcementHook"

vi.mock("vscode", () => ({
	window: {
		showWarningMessage: vi.fn(),
	},
}))

const showWarningMessageMock = vi.mocked(vscode.window.showWarningMessage)

function makeTask(overrides: any = {}) {
	return {
		cwd: process.cwd(),
		...overrides,
	} as any
}

describe("ScopeEnforcementHook", () => {
	beforeEach(() => {
		showWarningMessageMock.mockReset()
	})

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
		const toolUse: any = {
			name: "write_to_file",
			params: { path: path.join("src", "foo.ts"), intent_id: "i1", mutation_class: "AST_REFACTOR" },
		}

		const res = await hook.execute(task, toolUse)
		expect(res.shouldProceed).toBe(true)
		expect(showWarningMessageMock).not.toHaveBeenCalled()
	})

	it("prompts and blocks when target is outside owned scope and user denies", async () => {
		showWarningMessageMock.mockResolvedValue({ title: "Reject" } as vscode.MessageItem)
		const hook = new ScopeEnforcementHook()
		const task = makeTask({
			activeIntent: {
				id: "i1",
				context: `<intent_context><owned_scope><path>src</path></owned_scope></intent_context>`,
			},
		})
		const toolUse: any = {
			name: "write_to_file",
			params: { path: path.join("other", "foo.ts"), intent_id: "i1", mutation_class: "AST_REFACTOR" },
		}

		const res = await hook.execute(task, toolUse)
		expect(res.shouldProceed).toBe(false)
		// errorMessage should be JSON with error_type scope_violation
		const err = JSON.parse(res.errorMessage as string)
		expect(err.error_type).toBe("scope_violation")
		expect(err.code).toBe("REQ-001")
		expect(err.intent_id).toBe("i1")
		expect(err.filename).toBe(path.join("other", "foo.ts"))
	})

	it("allows safe execute_command without approval", async () => {
		const hook = new ScopeEnforcementHook()
		const task = makeTask({
			activeIntent: {
				id: "i1",
				context: `<intent_context><owned_scope><path>src</path></owned_scope></intent_context>`,
			},
		})
		const cmdUse: any = { name: "execute_command", nativeArgs: { command: "pwd" } }
		const res = await hook.execute(task, cmdUse)
		expect(res.shouldProceed).toBe(true)
		expect(showWarningMessageMock).not.toHaveBeenCalled()
	})

	it("blocks destructive execute_command when user rejects", async () => {
		showWarningMessageMock.mockResolvedValue({ title: "Reject" } as vscode.MessageItem)
		const hook = new ScopeEnforcementHook()
		const task = makeTask({
			activeIntent: {
				id: "i1",
				context: `<intent_context><owned_scope><path>src</path></owned_scope></intent_context>`,
			},
		})
		const cmdUse: any = { name: "execute_command", nativeArgs: { command: "rm -rf /" } }
		const res = await hook.execute(task, cmdUse)
		expect(res.shouldProceed).toBe(false)
		const err = JSON.parse(res.errorMessage as string)
		expect(err.error_type).toBe("command_not_authorized")
	})

	it("blocks mutating tools when mutation metadata is missing", async () => {
		const hook = new ScopeEnforcementHook()
		const task = makeTask({
			activeIntent: {
				id: "i1",
				context: `<intent_context><owned_scope><path>src</path></owned_scope></intent_context>`,
			},
		})
		const toolUse: any = { name: "write_to_file", params: { path: "src/foo.ts" } }

		const res = await hook.execute(task, toolUse)
		expect(res.shouldProceed).toBe(false)
		const err = JSON.parse(res.errorMessage as string)
		expect(err.error_type).toBe("missing_metadata")
		expect(err.missing).toContain("intent_id")
		expect(err.missing).toContain("mutation_class")
	})

	it("blocks mutating tools when intent_id does not match active intent", async () => {
		const hook = new ScopeEnforcementHook()
		const task = makeTask({
			activeIntent: {
				id: "i1",
				context: `<intent_context><owned_scope><path>src</path></owned_scope></intent_context>`,
			},
		})
		const toolUse: any = {
			name: "write_to_file",
			params: { path: "src/foo.ts", intent_id: "i2", mutation_class: "AST_REFACTOR" },
		}

		const res = await hook.execute(task, toolUse)
		expect(res.shouldProceed).toBe(false)
		const err = JSON.parse(res.errorMessage as string)
		expect(err.error_type).toBe("intent_mismatch")
		expect(err.provided_intent_id).toBe("i2")
	})

	it("blocks mutating tools when mutation_class is invalid", async () => {
		const hook = new ScopeEnforcementHook()
		const task = makeTask({
			activeIntent: {
				id: "i1",
				context: `<intent_context><owned_scope><path>src</path></owned_scope></intent_context>`,
			},
		})
		const toolUse: any = {
			name: "write_to_file",
			params: { path: "src/foo.ts", intent_id: "i1", mutation_class: "FREEFORM" },
		}

		const res = await hook.execute(task, toolUse)
		expect(res.shouldProceed).toBe(false)
		const err = JSON.parse(res.errorMessage as string)
		expect(err.error_type).toBe("invalid_metadata")
		expect(err.mutation_class).toBe("FREEFORM")
	})
})
