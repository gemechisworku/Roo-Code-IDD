import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "fs/promises"
import path from "path"
import os from "os"
import crypto from "crypto"
import { TraceWriterHook } from "../TraceWriterHook"

function sha256(content: string) {
	return crypto.createHash("sha256").update(content, "utf8").digest("hex")
}

describe("TraceWriterHook", () => {
	let tmpDir: string

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "tracehook-"))
	})

	afterEach(async () => {
		try {
			await fs.rm(tmpDir, { recursive: true, force: true })
		} catch {
			// ignore
		}
	})

	it("writes a trace entry with file hash when target file exists", async () => {
		const filePath = path.join(tmpDir, "hello.txt")
		await fs.writeFile(filePath, "hello world", "utf8")

		const hook = new TraceWriterHook()

		const fakeTask: any = {
			cwd: tmpDir,
			api: { getModel: () => ({ id: "model-x" }) },
		}
		;(fakeTask as any).activeIntent = { id: "intent-123" }

		const toolUse: any = {
			name: "write_to_file",
			params: { path: "hello.txt" },
		}

		const res = await hook.execute(fakeTask, toolUse, null)
		expect(res.success).toBe(true)

		const traceFile = path.join(tmpDir, ".orchestration", "agent_trace.jsonl")
		const content = await fs.readFile(traceFile, "utf8")
		const lines = content.trim().split("\n")
		const entry = JSON.parse(lines[lines.length - 1])

		expect(entry.tool).toBe("write_to_file")
		expect(entry.intent_id).toBe("intent-123")
		expect(Array.isArray(entry.files)).toBe(true)
		expect(entry.files.length).toBeGreaterThanOrEqual(1)
		const first = entry.files[0]
		expect(first.relative_path).toBe("hello.txt")
		expect(first.content_hash).toBe(sha256("hello world"))
	})

	it("records attempted path with null hash when file missing", async () => {
		const hook = new TraceWriterHook()
		const fakeTask: any = { cwd: tmpDir, api: { getModel: () => ({ id: "m" }) } }
		;(fakeTask as any).activeIntent = { id: "intent-456" }

		const toolUse: any = { name: "apply_patch", params: { path: "nope.txt" } }

		const res = await hook.execute(fakeTask, toolUse, null)
		expect(res.success).toBe(true)

		const traceFile = path.join(tmpDir, ".orchestration", "agent_trace.jsonl")
		const content = await fs.readFile(traceFile, "utf8")
		const entry = JSON.parse(content.trim().split("\n").pop()!)

		expect(entry.tool).toBe("apply_patch")
		expect(entry.files[0].relative_path).toBe("nope.txt")
		expect(entry.files[0].content_hash).toBeNull()
	})
})
