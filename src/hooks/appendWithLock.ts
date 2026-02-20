import fs from "fs/promises"
import path from "path"

async function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function appendWithLock(filePath: string, content: string): Promise<void> {
	const lockPath = `${filePath}.lock`
	const dir = path.dirname(filePath)
	await fs.mkdir(dir, { recursive: true })

	const maxAttempts = 8
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		try {
			const handle = await fs.open(lockPath, "wx")
			try {
				await fs.appendFile(filePath, content, "utf-8")
			} finally {
				await handle.close().catch(() => {})
				await fs.unlink(lockPath).catch(() => {})
			}
			return
		} catch (error: any) {
			if (error?.code !== "EEXIST") {
				throw error
			}

			if (attempt === maxAttempts) {
				throw error
			}

			await delay(25 * attempt)
		}
	}
}
