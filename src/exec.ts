import { spawn } from "node:child_process"

export interface ExecResult {
	code: number
	output: string
}

// Runs a command and resolves with its exit code and combined stdout/stderr, it never rejects
// on a non zero exit code so callers can decide what a failure means.
export function exec(
	command: string,
	args: string[],
	options: { cwd?: string; timeout?: number } = {}
): Promise<ExecResult> {
	return new Promise((resolve) => {
		const child = spawn(command, args, {
			cwd: options.cwd,
			timeout: options.timeout,
			stdio: ["ignore", "pipe", "pipe"]
		})

		let output = ""
		child.stdout.on("data", (data) => (output += data))
		child.stderr.on("data", (data) => (output += data))
		child.on("error", (err) => resolve({ code: -1, output: output + err.message }))
		child.on("close", (code, signal) => {
			if (signal) output += `\nProcess was killed with ${signal}`
			resolve({ code: code ?? -1, output })
		})
	})
}

export async function execOrThrow(command: string, args: string[], cwd?: string) {
	const result = await exec(command, args, { cwd })
	if (result.code !== 0) {
		throw new Error(`${command} ${args.join(" ")} failed (${result.code}):\n${result.output}`)
	}
	return result.output
}
