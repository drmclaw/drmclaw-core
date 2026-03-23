import { execFile } from "node:child_process";

/** Default command allowlist for safe subprocess execution. */
const DEFAULT_COMMAND_ALLOWLIST = new Set([
	"git",
	"ls",
	"cat",
	"head",
	"tail",
	"wc",
	"grep",
	"find",
	"echo",
	"node",
	"python3",
	"python",
]);

/**
 * Execute a subprocess safely — allowlist-based, no shell: true.
 *
 * Uses an allowlist-based execution pattern: only commands in the allowlist
 * are permitted. All execution uses `shell: false` for safety.
 */
export async function executeCommand(
	command: string,
	args: string[],
	options?: {
		cwd?: string;
		allowlist?: Set<string>;
		timeoutMs?: number;
	},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const allowlist = options?.allowlist ?? DEFAULT_COMMAND_ALLOWLIST;

	if (!allowlist.has(command)) {
		throw new Error(
			`Command "${command}" is not in the allowlist. ` +
				`Allowed: ${Array.from(allowlist).join(", ")}`,
		);
	}

	return new Promise((resolve, reject) => {
		const proc = execFile(
			command,
			args,
			{
				cwd: options?.cwd,
				timeout: options?.timeoutMs ?? 30_000,
				maxBuffer: 1024 * 1024, // 1 MB
			},
			(error, stdout, stderr) => {
				if (error && !("code" in error)) {
					reject(error);
					return;
				}
				resolve({
					stdout: stdout ?? "",
					stderr: stderr ?? "",
					exitCode: proc.exitCode ?? (error ? 1 : 0),
				});
			},
		);
	});
}
