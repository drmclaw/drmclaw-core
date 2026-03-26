import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_NAME = "drmclaw-core";

/**
 * Walk up from a starting directory until we find a `package.json`
 * whose `name` matches the expected package name.
 *
 * This is robust across all execution layouts:
 *   - Repo dev:     src/paths.ts   → finds drmclaw-core/package.json
 *   - Built:        dist/paths.js  → finds drmclaw-core/package.json
 *   - npm-installed: node_modules/drmclaw-core/dist/paths.js → same
 */
function findPackageRoot(startDir: string): string {
	let dir = startDir;
	const seen = new Set<string>();
	while (!seen.has(dir)) {
		seen.add(dir);
		const pkgPath = join(dir, "package.json");
		if (existsSync(pkgPath)) {
			try {
				const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
				if (pkg.name === PACKAGE_NAME) return dir;
			} catch {
				// Unreadable package.json — keep walking
			}
		}
		dir = dirname(dir);
	}
	throw new Error(`Cannot find package root for "${PACKAGE_NAME}" starting from ${startDir}`);
}

/**
 * Root of the `drmclaw-core` package, resolved once at import time.
 *
 * All package-internal paths (bundled skills, UI assets) are anchored here.
 * User-facing paths (config files, runtime data) are anchored to `process.cwd()`.
 */
export const PACKAGE_ROOT = findPackageRoot(dirname(fileURLToPath(import.meta.url)));
