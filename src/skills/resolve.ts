/**
 * Skill resolution — the single helper that turns a config + request pair
 * into a validated set of skills ready for runtime assembly.
 *
 * Unlike the raw {@link loadSkills} / {@link loadSkillsFromDirs} primitives,
 * this helper treats an **explicit skill-scoped request** as a contract.
 * When the caller declares a skill allowlist, every allowlisted skill must
 * be discoverable and ready. When the caller also declares request skill
 * directories, those directories must exist on disk (a missing root yields
 * a precedence-1 `SKILL_ROOT_MISSING` error); once the roots are readable,
 * each allowlisted skill is satisfied iff it is present in the merged skill
 * set (config-driven skills merged with skills loaded from request roots).
 * The merge prefers the config-declared copy on duplicate name, so a request
 * root cannot override a config-declared skill of the same name; readiness
 * is checked against the merged copy.
 * Violations are returned as structured {@link SkillResolutionError}s so
 * the runtime surface (e.g. `executeTask`) can fail closed before any ACP
 * subprocess is spawned.
 *
 * A single request returns errors of **exactly one class**, chosen by the
 * strict precedence `SKILL_ROOT_MISSING` > `SKILL_NOT_FOUND` > `SKILL_NOT_READY`.
 *
 * This is intentionally the only code path that knows how to merge
 * config-driven skills with request skills, apply the allowlist, and
 * assert the skill scope contract. Products should not reimplement this
 * logic.
 *
 * @remarks Next phase. The skill-action surface will grow on top of this
 * helper. `SkillMetadata` and `SkillEntry` are expected to gain typed
 * action metadata; a future `executeSkillAction` surface can reuse this
 * resolver and then validate the requested action exists in the resolved
 * skill's action list before calling the runtime. This helper is the seam.
 */

import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { DrMClawConfig } from "../config/schema.js";
import { loadSkills, loadSkillsFromDirs } from "./loader.js";
import type { SkillEntry } from "./types.js";

/** Reason an explicit skill-scoped request could not be satisfied. */
export type SkillResolutionErrorCode = "SKILL_ROOT_MISSING" | "SKILL_NOT_FOUND" | "SKILL_NOT_READY";

/**
 * Structured resolution failure for an explicit skill-scoped request.
 *
 * Codes are evaluated in strict precedence order, and a single request
 * returns errors of **exactly one class**. Multiple errors of the same
 * class for one request are allowed (e.g. two missing names → two
 * `SKILL_NOT_FOUND` errors); mixing classes is not.
 *
 * - `SKILL_ROOT_MISSING` — one of the request `skillDirs` entries does
 *   not exist on disk or is not a directory. This is a pure filesystem
 *   fact and does not depend on which skill names the allowlist carries.
 *   Wins outright: no `SKILL_NOT_FOUND` or `SKILL_NOT_READY` errors are
 *   emitted in the same request.
 * - `SKILL_NOT_FOUND` — every requested root was readable, but one or
 *   more allowlisted skill names are not in the merged config + request
 *   skill set. Wins over `SKILL_NOT_READY`: readiness is not checked
 *   for skills that happen to be present when any allowlisted name is
 *   missing.
 * - `SKILL_NOT_READY` — every allowlisted skill was discovered, but at
 *   least one's `requires` list is not fully satisfied.
 *   `missingRequires` carries the unmet commands.
 */
export interface SkillResolutionError {
	code: SkillResolutionErrorCode;
	/** The allowlisted skill name this error is about, when applicable. */
	skill?: string;
	/** The specific request skill directories this error is about. */
	skillDirs?: string[];
	/** Requirements that were missing for a `SKILL_NOT_READY` error. */
	missingRequires?: string[];
	/** Human-readable message suitable for logs and error output. */
	message: string;
}

/** Inputs to {@link resolveSkillsForRequest}. */
export interface SkillResolutionRequest {
	config: DrMClawConfig;
	/** Extra skill directories declared by the calling product. */
	skillDirs?: string[];
	/** Skill names the caller has scoped execution to. */
	skillAllowlist?: string[];
}

/** Validated skill resolution — ready-for-runtime skills plus any errors. */
export interface SkillResolutionResult {
	/** Skills after merge + dedup + allowlist filter. */
	skills: SkillEntry[];
	/** Structured errors when an explicit skill scope could not be satisfied. */
	errors: SkillResolutionError[];
}

/**
 * Resolve the effective set of skills for a constrained request, and
 * validate the skill scope contract when the caller has declared one.
 *
 * Merge order: config-driven skills first (system skills + `config.skills.dirs`),
 * then request-declared `skillDirs` additively with name-level deduplication
 * (config-driven wins). Allowlist filtering happens last.
 *
 * Scope contract (enforced only when `skillAllowlist` is non-empty). A
 * single request returns errors of **exactly one class**, chosen by
 * this strict precedence:
 *
 * 1. `SKILL_ROOT_MISSING` — if any entry in `request.skillDirs` does not
 *    exist or is not a directory, the resolver emits one
 *    `SKILL_ROOT_MISSING` error carrying every failing path and returns.
 *    It does not then also ask "was the skill found?" because the ground
 *    truth for that question (the missing directory) is unavailable.
 * 2. `SKILL_NOT_FOUND` — all declared roots were readable, but one or
 *    more allowlisted names did not resolve to a discovered skill.
 *    Emitted per missing name. Readiness is **not** also checked for
 *    skills that happen to be present in the same request: missing-name
 *    failures dominate.
 * 3. `SKILL_NOT_READY` — every allowlisted skill was discovered but at
 *    least one's `requires` list is not fully satisfied. Emitted per
 *    unready skill, carrying `missingRequires`.
 *
 * Multiple errors of the same class for one request are allowed (e.g.
 * two missing names → two `SKILL_NOT_FOUND` errors); mixing classes is
 * not.
 *
 * The returned `skills` array is the filtered, runtime-ready list
 * (allowlisted AND ready) on every path, even when `errors` is
 * non-empty. Callers that want fail-closed behavior should check
 * `errors.length === 0` before proceeding with runtime assembly.
 */
export async function resolveSkillsForRequest(
	request: SkillResolutionRequest,
): Promise<SkillResolutionResult> {
	const allowlist = request.skillAllowlist ?? [];
	const requestDirs = request.skillDirs ?? [];
	const explicitlyScoped = allowlist.length > 0;
	const errors: SkillResolutionError[] = [];

	// 1. Config-driven skills (system + config.skills.dirs). Lowest precedence.
	//    We load these before the filesystem check because they are also
	//    needed to build the unvalidated `runtimeSkills` return value even
	//    when the scope contract fails.
	const configSkills = await loadSkills(request.config);

	// 2. Validate that each declared request skill directory actually
	//    exists as a directory. This is a pure filesystem fact and is the
	//    only condition that produces SKILL_ROOT_MISSING. When any root is
	//    missing we stop the scope-contract check here — asking "is the
	//    allowlisted skill present?" when the source-of-truth directory
	//    is unavailable would produce a second, noisier structured reason
	//    that the docs promise callers will not see.
	if (explicitlyScoped && requestDirs.length > 0) {
		const missingDirs: string[] = [];
		for (const dir of requestDirs) {
			const resolved = resolve(dir);
			try {
				const info = await stat(resolved);
				if (!info.isDirectory()) missingDirs.push(dir);
			} catch {
				missingDirs.push(dir);
			}
		}
		if (missingDirs.length > 0) {
			errors.push({
				code: "SKILL_ROOT_MISSING",
				skillDirs: missingDirs,
				message:
					missingDirs.length === 1
						? `Request skill directory does not exist or is not a directory: ${missingDirs[0]}`
						: `Request skill directories do not exist or are not directories: ${missingDirs.join(", ")}`,
			});
			// Short-circuit: the runtime-ready skill list falls back to the
			// allowlisted AND ready subset of config-driven skills, with no
			// request skills merged. This preserves two invariants:
			// (a) SKILL_ROOT_MISSING is mutually exclusive with the other
			// codes, and (b) the returned `skills` array is genuinely
			// runtime-ready — callers that consume `skills` without
			// gating on `errors.length === 0` still receive a safe list.
			const allowSet = new Set(allowlist);
			const filtered = configSkills.filter((s) => allowSet.has(s.name) && s.ready);
			return { skills: filtered, errors };
		}
	}

	// 3. Request-declared dirs. `loadSkillsFromDirs` silently skips roots
	//    that do not exist, which is fine here because the fs.stat check
	//    above already rejected any missing root when the caller was
	//    scoped. For unscoped callers, silent-skip is the intended
	//    behavior (free-pick discovery).
	let requestSkills: SkillEntry[] = [];
	if (requestDirs.length > 0) {
		requestSkills = await loadSkillsFromDirs(requestDirs);
	}

	// 4. Merge with dedup by name — config-driven wins.
	const merged: SkillEntry[] = [...configSkills];
	const seen = new Set(merged.map((s) => s.name));
	for (const s of requestSkills) {
		if (!seen.has(s.name)) {
			merged.push(s);
			seen.add(s.name);
		}
	}

	// 5. Allowlisted skill name + readiness contract. SKILL_NOT_FOUND
	//    dominates SKILL_NOT_READY: when any allowlisted name is missing
	//    we do not also report readiness errors for the skills that
	//    happen to be present. This keeps a single request's errors to
	//    exactly one class. Multiple errors of the same class are still
	//    allowed (one per failing name).
	if (explicitlyScoped) {
		const missingNames: string[] = [];
		const unreadyFound: SkillEntry[] = [];
		for (const name of allowlist) {
			const found = merged.find((s) => s.name === name);
			if (!found) {
				missingNames.push(name);
			} else if (!found.ready) {
				unreadyFound.push(found);
			}
		}
		if (missingNames.length > 0) {
			for (const name of missingNames) {
				errors.push({
					code: "SKILL_NOT_FOUND",
					skill: name,
					message: `Allowlisted skill "${name}" was not discovered in config or request skill directories.`,
				});
			}
		} else {
			for (const found of unreadyFound) {
				errors.push({
					code: "SKILL_NOT_READY",
					skill: found.name,
					missingRequires: found.missingRequires,
					message: `Allowlisted skill "${found.name}" is not ready. Missing requirements: ${
						found.missingRequires.join(", ") || "(unknown)"
					}`,
				});
			}
		}
	}

	// 6. Apply allowlist + readiness filter last — runtime-ready skills.
	//    Matches the short-circuit fallback above, so the returned list
	//    satisfies the docstring invariant on every path: an unready
	//    allowlisted skill surfaces via `SKILL_NOT_READY` in `errors` and
	//    is excluded from `skills`. Unscoped requests skip the filter
	//    because they have no contract to enforce.
	const runtimeSkills = explicitlyScoped
		? (() => {
				const allowSet = new Set(allowlist);
				return merged.filter((s) => allowSet.has(s.name) && s.ready);
			})()
		: merged;

	return { skills: runtimeSkills, errors };
}

/**
 * Format a list of resolution errors into a single diagnostic string
 * suitable for the `error` field of a structured runtime result.
 */
export function formatSkillResolutionErrors(errors: SkillResolutionError[]): string {
	if (errors.length === 0) return "";
	if (errors.length === 1) return `Skill scope unsatisfied: ${errors[0].message}`;
	return ["Skill scope unsatisfied:", ...errors.map((e) => `  - [${e.code}] ${e.message}`)].join(
		"\n",
	);
}
