import { execFileSync } from "node:child_process";

/**
 * Return the subset of `requires` entries not found on the local system.
 * Each entry is expected to be a command name resolvable via PATH.
 */
export function findMissingRequires(requires: string[]): string[] {
	return requires.filter((req) => !isCommandAvailable(req));
}

function isCommandAvailable(cmd: string): boolean {
	try {
		execFileSync("which", [cmd], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}
