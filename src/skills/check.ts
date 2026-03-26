import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";

/**
 * Return the subset of `requires` entries not found on the local system.
 * Each entry is expected to be a command name resolvable via PATH.
 */
export function findMissingRequires(requires: string[]): string[] {
	return requires.filter((req) => !isCommandAvailable(req));
}

/**
 * Check if a command exists on PATH by scanning directories directly.
 * Avoids spawning `which` (which can trigger enterprise security monitors).
 */
function isCommandAvailable(cmd: string): boolean {
	const dirs = (process.env.PATH ?? "").split(delimiter);
	return dirs.some((dir) => {
		try {
			accessSync(join(dir, cmd), constants.X_OK);
			return true;
		} catch {
			return false;
		}
	});
}
