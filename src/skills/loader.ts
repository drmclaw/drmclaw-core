import { access, readdir, realpath, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { DrMClawConfig } from "../config/schema.js";
import { PACKAGE_ROOT } from "../paths.js";
import { findMissingRequires } from "./check.js";
import { parseSkillMd } from "./parser.js";
import type { SkillEntry } from "./types.js";
import { MAX_CANDIDATES_PER_ROOT, MAX_SKILLS_PER_ROOT } from "./types.js";

const SKILL_MD = "SKILL.md";
const ENTRYPOINT_FILES = ["index.ts", "index.js", "main.ts", "main.js", "run.sh", "run.py"];

/** The schema default for skills.systemDir. */
const DEFAULT_SYSTEM_DIR = "./skills";

/**
 * Resolve the system skills directory.
 *
 * - When systemDir is the unchanged default (`"./skills"`), resolve it
 *   relative to the installed package root so bundled skills work from
 *   any working directory.
 * - When the caller has overridden systemDir to a custom value, resolve
 *   it normally against cwd so relative paths behave as expected.
 */
export function resolveSystemSkillsDir(systemDir: string): string {
	if (systemDir === DEFAULT_SYSTEM_DIR) {
		return resolve(PACKAGE_ROOT, systemDir);
	}
	return resolve(systemDir);
}

/**
 * Discover and load all skills from configured directories.
 *
 * Precedence: system skills (lowest) < external dirs in order (last wins on name conflict).
 */
export async function loadSkills(config: DrMClawConfig): Promise<SkillEntry[]> {
	const skillMap = new Map<string, SkillEntry>();

	// Load system skills first (lowest precedence).
	// Resolved relative to the package root, not cwd.
	const systemDir = resolveSystemSkillsDir(config.skills.systemDir);
	await loadSkillsFromDir(systemDir, "system", skillMap);

	// Load external dirs in order (last wins)
	for (const dir of config.skills.dirs) {
		const resolved = resolve(dir);
		await loadSkillsFromDir(resolved, resolved, skillMap);
	}

	return Array.from(skillMap.values());
}

/**
 * Load skills from an explicit list of directories.
 *
 * Unlike {@link loadSkills}, this does not require a full `DrMClawConfig`
 * and does not include system skills. Intended for downstream products
 * that resolve skill directories themselves (e.g. via workflow requests).
 */
export async function loadSkillsFromDirs(dirs: string[]): Promise<SkillEntry[]> {
	const skillMap = new Map<string, SkillEntry>();
	for (const dir of dirs) {
		const resolved = resolve(dir);
		await loadSkillsFromDir(resolved, resolved, skillMap);
	}
	return Array.from(skillMap.values());
}

async function loadSkillsFromDir(
	dir: string,
	source: string,
	skillMap: Map<string, SkillEntry>,
): Promise<void> {
	// Resolve the root through realpath so symlink comparisons are consistent.
	let realDir: string;
	try {
		realDir = await realpath(dir);
	} catch {
		// Directory doesn't exist or not accessible — skip silently
		return;
	}

	let entries: string[];
	try {
		entries = await readdir(realDir);
	} catch {
		return;
	}

	// Sort for deterministic ordering — readdir() order is filesystem-dependent.
	entries.sort();

	// Bounded discovery — cap the number of candidates scanned per root.
	if (entries.length > MAX_CANDIDATES_PER_ROOT) {
		entries = entries.slice(0, MAX_CANDIDATES_PER_ROOT);
	}

	let loaded = 0;
	for (const entry of entries) {
		if (loaded >= MAX_SKILLS_PER_ROOT) break;

		const skillDir = join(realDir, entry);
		const dirStat = await stat(skillDir).catch(() => null);
		if (!dirStat?.isDirectory()) continue;

		// Path containment — ensure the candidate stays inside its root.
		if (!(await isContainedIn(realDir, skillDir))) continue;

		const skill = await loadSingleSkill(skillDir, realDir, source);
		if (skill) {
			skillMap.set(skill.name, skill);
			loaded++;
		}
	}
}

async function loadSingleSkill(
	skillDir: string,
	rootDir: string,
	source: string,
): Promise<SkillEntry | null> {
	const skillMdPath = join(skillDir, SKILL_MD);
	const hasSkillMd = await fileExists(skillMdPath);

	if (hasSkillMd) {
		// Path containment — validate SKILL.md itself stays inside its root
		// (catches symlinked SKILL.md pointing outside the allowed tree).
		if (!(await isContainedIn(rootDir, skillMdPath))) return null;

		const { meta, body } = await parseSkillMd(skillMdPath);
		const name = meta.name || basename(skillDir);
		const entrypoint = meta.entrypoint
			? resolve(skillDir, meta.entrypoint)
			: await findEntrypoint(skillDir);

		// Path containment — validate the entrypoint stays inside its root.
		if (entrypoint && !(await isContainedIn(rootDir, entrypoint))) return null;

		const missingRequires = findMissingRequires(meta.requires ?? []);

		return {
			name,
			description: meta.description,
			dir: skillDir,
			skillMdPath,
			entrypoint: entrypoint ?? undefined,
			content: body.trim() || undefined,
			requires: meta.requires ?? [],
			metadata: meta.metadata ?? {},
			actions: meta.actions ?? [],
			source,
			ready: missingRequires.length === 0,
			missingRequires,
		};
	}

	// No SKILL.md — check for a standalone entrypoint script
	const entrypoint = await findEntrypoint(skillDir);
	if (entrypoint) {
		// Path containment — validate the entrypoint stays inside its root.
		if (!(await isContainedIn(rootDir, entrypoint))) return null;

		return {
			name: basename(skillDir),
			description: "",
			dir: skillDir,
			entrypoint,
			requires: [],
			metadata: {},
			actions: [],
			source,
			ready: true,
			missingRequires: [],
		};
	}

	return null;
}

async function findEntrypoint(skillDir: string): Promise<string | null> {
	for (const file of ENTRYPOINT_FILES) {
		const fullPath = join(skillDir, file);
		if (await fileExists(fullPath)) {
			return fullPath;
		}
	}
	return null;
}

async function fileExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

/**
 * Check that `target` is contained within `root` after resolving symlinks.
 *
 * 1. A fast `resolve()`-based check catches `../` traversal.
 * 2. If the target exists on disk, a `realpath()` check catches symlink escape.
 * 3. If the target does not exist, the resolve-based check is sufficient.
 */
async function isContainedIn(root: string, target: string): Promise<boolean> {
	const resolvedRoot = resolve(root);
	const resolvedTarget = resolve(target);
	if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(`${resolvedRoot}/`)) {
		return false;
	}
	try {
		const realRoot = await realpath(root);
		const realTarget = await realpath(target);
		return realTarget === realRoot || realTarget.startsWith(`${realRoot}/`);
	} catch {
		// Target does not exist — the resolve-based check already passed.
		return true;
	}
}
