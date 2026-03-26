import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { PACKAGE_ROOT } from "../paths.js";
import { type DrMClawConfig, configSchema } from "./schema.js";

/**
 * Config file names in priority order.
 * `.local` variants (gitignored developer overrides) take precedence
 * over base config files.
 */
const CONFIG_FILES = [
	"drmclaw.config.local.ts",
	"drmclaw.config.local.mts",
	"drmclaw.config.local.js",
	"drmclaw.config.local.mjs",
	"drmclaw.config.local.cjs",
	"drmclaw.config.ts",
	"drmclaw.config.mts",
	"drmclaw.config.js",
	"drmclaw.config.mjs",
	"drmclaw.config.cjs",
];

/**
 * Find the first matching config file.
 *
 * Search order:
 *   1. `cwd` — the user's project directory (for consumers using drmclaw as a dependency)
 *   2. `PACKAGE_ROOT` — the drmclaw-core package root (for dev / monorepo setups)
 *
 * Within each directory, `.local` variants are checked before base config.
 *
 * Returns the absolute path to the config file, or `undefined` if none exists.
 */
export function resolveConfigFile(cwd: string): string | undefined {
	for (const dir of [cwd, PACKAGE_ROOT]) {
		for (const file of CONFIG_FILES) {
			const full = join(dir, file);
			if (existsSync(full)) return full;
		}
	}
	return undefined;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** Recursively merge `override` into `base`. Arrays are replaced, not concatenated. */
function mergeConfig(
	base: Record<string, unknown>,
	override: Record<string, unknown>,
): Record<string, unknown> {
	const result = { ...base };
	for (const [key, val] of Object.entries(override)) {
		const baseVal = result[key];
		if (isPlainObject(baseVal) && isPlainObject(val)) {
			result[key] = mergeConfig(baseVal, val);
		} else {
			result[key] = val;
		}
	}
	return result;
}

/**
 * Load and validate configuration from `drmclaw.config.{ts,js,mjs}` files.
 *
 * Config files are loaded via native `import()`.  TypeScript files work when
 * a TS loader is registered (e.g. running under `tsx`, which is the default
 * for `pnpm dev:server`).  Production deploys can use `.mjs` config or
 * register a loader via `NODE_OPTIONS="--import=tsx/esm"`.
 */
export async function loadDrMClawConfig(
	overrides?: Partial<DrMClawConfig>,
): Promise<DrMClawConfig> {
	const filePath = resolveConfigFile(process.cwd());
	let raw: Record<string, unknown> = {};

	if (filePath) {
		try {
			const mod = await import(pathToFileURL(filePath).href);
			const loaded = mod.default ?? mod;
			if (isPlainObject(loaded)) {
				raw = loaded;
			}
		} catch (err) {
			const isTs = filePath.endsWith(".ts") || filePath.endsWith(".mts");
			if (isTs) {
				throw new Error(
					`Failed to load config ${filePath}. TypeScript config files require a TS loader (e.g. tsx). Run with tsx or use a .mjs config file instead.\nCause: ${err instanceof Error ? err.message : err}`,
				);
			}
			throw err;
		}
	}

	if (overrides && Object.keys(overrides).length > 0) {
		raw = mergeConfig(raw, overrides as Record<string, unknown>);
	}

	return configSchema.parse(raw);
}
