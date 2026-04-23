import { randomUUID } from "node:crypto";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configSchema } from "../src/config/schema.js";
import type { DrMClawConfig } from "../src/config/schema.js";
import { findMissingRequires } from "../src/skills/check.js";
import { loadSkills } from "../src/skills/loader.js";
import { resolveSystemSkillsDir } from "../src/skills/loader.js";
import { parseSkillMd } from "../src/skills/parser.js";
import { resolveSkillsForRequest } from "../src/skills/resolve.js";

function makeConfig(overrides: { systemDir?: string; dirs?: string[] }): DrMClawConfig {
	return configSchema.parse({
		skills: {
			systemDir: overrides.systemDir ?? `/nonexistent-${randomUUID()}`,
			dirs: overrides.dirs ?? [],
		},
	});
}

async function writeSkillMd(dir: string, frontmatter: Record<string, unknown>): Promise<void> {
	const lines = ["---"];
	for (const [k, v] of Object.entries(frontmatter)) {
		if (Array.isArray(v)) {
			lines.push(`${k}:`);
			for (const item of v) lines.push(`  - ${item}`);
		} else {
			lines.push(`${k}: ${v}`);
		}
	}
	lines.push("---", "# Skill");
	await writeFile(join(dir, "SKILL.md"), lines.join("\n"));
}

describe("skills loader", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = join(tmpdir(), `drmclaw-test-${randomUUID()}`);
		await mkdir(tmpDir, { recursive: true });
	});

	afterEach(async () => {
		await rm(tmpDir, { recursive: true, force: true });
	});

	// ---- Basic loading ----

	it("loads skills from a valid directory", async () => {
		const skillDir = join(tmpDir, "test-skill");
		await mkdir(skillDir);
		await writeSkillMd(skillDir, { name: "test-skill", description: "A test skill" });

		const skills = await loadSkills(makeConfig({ dirs: [tmpDir] }));

		expect(skills).toHaveLength(1);
		expect(skills[0].name).toBe("test-skill");
		expect(skills[0].description).toBe("A test skill");
	});

	it("skips non-existent directories gracefully", async () => {
		const skills = await loadSkills(makeConfig({ dirs: ["/nonexistent/xyz"] }));
		expect(skills).toEqual([]);
	});

	it("uses directory name when SKILL.md has no name", async () => {
		const skillDir = join(tmpDir, "my-dir-name");
		await mkdir(skillDir);
		await writeSkillMd(skillDir, { description: "desc only" });

		const skills = await loadSkills(makeConfig({ dirs: [tmpDir] }));

		expect(skills).toHaveLength(1);
		expect(skills[0].name).toBe("my-dir-name");
	});

	// ---- Path containment ----

	it("excludes skills whose directory symlinks outside the root", async () => {
		const outsideDir = join(tmpdir(), `drmclaw-outside-${randomUUID()}`);
		await mkdir(outsideDir, { recursive: true });
		const outsideSkill = join(outsideDir, "evil-skill");
		await mkdir(outsideSkill);
		await writeSkillMd(outsideSkill, { name: "evil", description: "escaped" });

		// Symlink from inside the root to outside
		await symlink(outsideSkill, join(tmpDir, "escape-link"));

		const skills = await loadSkills(makeConfig({ dirs: [tmpDir] }));

		expect(skills.every((s) => s.name !== "evil")).toBe(true);
		await rm(outsideDir, { recursive: true, force: true });
	});

	it("excludes skills with a symlinked SKILL.md pointing outside the root", async () => {
		const outsideDir = join(tmpdir(), `drmclaw-outside-md-${randomUUID()}`);
		await mkdir(outsideDir, { recursive: true });
		await writeFile(
			join(outsideDir, "SKILL.md"),
			["---", "name: stolen", "description: external file", "---", "# Stolen"].join("\n"),
		);

		const skillDir = join(tmpDir, "sneaky");
		await mkdir(skillDir);
		// Symlink SKILL.md to the external file
		await symlink(join(outsideDir, "SKILL.md"), join(skillDir, "SKILL.md"));

		const skills = await loadSkills(makeConfig({ dirs: [tmpDir] }));

		expect(skills.every((s) => s.name !== "stolen")).toBe(true);
		await rm(outsideDir, { recursive: true, force: true });
	});

	it("excludes skills with entrypoints that traverse outside the root", async () => {
		const skillDir = join(tmpDir, "bad-ep");
		await mkdir(skillDir);
		await writeSkillMd(skillDir, {
			name: "bad-ep",
			description: "traversal entrypoint",
			entrypoint: "../../etc/passwd",
		});

		const skills = await loadSkills(makeConfig({ dirs: [tmpDir] }));

		expect(skills.every((s) => s.name !== "bad-ep")).toBe(true);
	});

	it("allows skills with entrypoints inside the root", async () => {
		const skillDir = join(tmpDir, "good-ep");
		await mkdir(skillDir);
		await writeFile(join(skillDir, "index.ts"), "export default {}");
		await writeSkillMd(skillDir, {
			name: "good-ep",
			description: "has entrypoint",
			entrypoint: "index.ts",
		});

		const skills = await loadSkills(makeConfig({ dirs: [tmpDir] }));

		expect(skills.find((s) => s.name === "good-ep")).toBeDefined();
		expect(skills[0].entrypoint).toContain("index.ts");
	});

	// ---- Bounded discovery ----

	it("loads multiple skills up to the per-root cap", async () => {
		for (let i = 0; i < 10; i++) {
			const d = join(tmpDir, `skill-${i}`);
			await mkdir(d);
			await writeSkillMd(d, { name: `skill-${i}`, description: `Skill ${i}` });
		}

		const skills = await loadSkills(makeConfig({ dirs: [tmpDir] }));

		expect(skills.length).toBe(10);
	});

	// ---- Readiness / status ----

	it("marks skills with no requirements as ready", async () => {
		const skillDir = join(tmpDir, "simple");
		await mkdir(skillDir);
		await writeSkillMd(skillDir, { name: "simple", description: "No reqs" });

		const skills = await loadSkills(makeConfig({ dirs: [tmpDir] }));
		const skill = skills.find((s) => s.name === "simple");

		expect(skill).toBeDefined();
		expect(skill?.ready).toBe(true);
		expect(skill?.missingRequires).toEqual([]);
	});

	it("reports missing requirements and marks skill not ready", async () => {
		const skillDir = join(tmpDir, "needs-stuff");
		await mkdir(skillDir);
		await writeSkillMd(skillDir, {
			name: "needs-stuff",
			description: "Needs a fake command",
			requires: ["nonexistent-cmd-abc123", "node"],
		});

		const skills = await loadSkills(makeConfig({ dirs: [tmpDir] }));
		const skill = skills.find((s) => s.name === "needs-stuff");

		expect(skill).toBeDefined();
		expect(skill?.ready).toBe(false);
		expect(skill?.missingRequires).toContain("nonexistent-cmd-abc123");
		expect(skill?.missingRequires).not.toContain("node");
	});

	it("marks skills with all requirements present as ready", async () => {
		const skillDir = join(tmpDir, "needs-node");
		await mkdir(skillDir);
		await writeSkillMd(skillDir, {
			name: "needs-node",
			description: "Needs node",
			requires: ["node"],
		});

		const skills = await loadSkills(makeConfig({ dirs: [tmpDir] }));
		const skill = skills.find((s) => s.name === "needs-node");

		expect(skill).toBeDefined();
		expect(skill?.ready).toBe(true);
		expect(skill?.missingRequires).toEqual([]);
	});
});

describe("resolveSystemSkillsDir", () => {
	it("resolves the default './skills' against the package root", () => {
		const result = resolveSystemSkillsDir("./skills");
		// Anchored to the package root, not cwd.
		expect(result).toMatch(/drmclaw-core\/skills$/);
	});

	it("resolves custom relative paths against cwd, not the package root", () => {
		const result = resolveSystemSkillsDir("./custom-skills");
		// Custom relative paths resolve against cwd.
		expect(result).toBe(join(process.cwd(), "custom-skills"));
	});

	it("preserves absolute paths as-is", () => {
		const abs = "/usr/share/custom-skills";
		expect(resolveSystemSkillsDir(abs)).toBe(abs);
	});
});

describe("findMissingRequires", () => {
	it("returns empty for no requirements", () => {
		expect(findMissingRequires([])).toEqual([]);
	});

	it("returns empty when all requirements are present", () => {
		expect(findMissingRequires(["node"])).toEqual([]);
	});

	it("returns missing commands", () => {
		const missing = findMissingRequires(["nonexistent-xyz-789"]);
		expect(missing).toEqual(["nonexistent-xyz-789"]);
	});

	it("filters to only missing entries", () => {
		const missing = findMissingRequires(["node", "nonexistent-abc-123"]);
		expect(missing).toEqual(["nonexistent-abc-123"]);
	});
});

// ---------------------------------------------------------------------------
// resolveSkillsForRequest — real filesystem-backed scope contract tests
// ---------------------------------------------------------------------------

describe("resolveSkillsForRequest", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = join(tmpdir(), `drmclaw-resolve-${randomUUID()}`);
		await mkdir(tmpDir, { recursive: true });
	});

	afterEach(async () => {
		await rm(tmpDir, { recursive: true, force: true });
	});

	it("returns ONLY SKILL_ROOT_MISSING when a request dir does not exist (mutually exclusive)", async () => {
		const ghost = join(tmpdir(), `drmclaw-ghost-${randomUUID()}`);
		const result = await resolveSkillsForRequest({
			config: makeConfig({}),
			skillDirs: [ghost],
			skillAllowlist: ["jira"],
		});

		const codes = result.errors.map((e) => e.code);
		// Mutually-exclusive contract: a missing root short-circuits the
		// resolver, so SKILL_NOT_FOUND / SKILL_NOT_READY cannot also fire
		// for the same request.
		expect(codes).toEqual(["SKILL_ROOT_MISSING"]);
		const rootMissing = result.errors[0];
		expect(rootMissing.skillDirs).toEqual([ghost]);
		expect(result.skills).toEqual([]);
	});

	it("does NOT emit SKILL_ROOT_MISSING when the request dir exists but holds a different skill", async () => {
		// A real skill exists in the dir, but it is not the allowlisted one.
		const skillDir = join(tmpDir, "git");
		await mkdir(skillDir);
		await writeSkillMd(skillDir, { name: "git", description: "some other skill" });

		const result = await resolveSkillsForRequest({
			config: makeConfig({}),
			skillDirs: [tmpDir],
			skillAllowlist: ["jira"],
		});

		// Existing, readable directory → not a root-missing condition.
		expect(result.errors.some((e) => e.code === "SKILL_ROOT_MISSING")).toBe(false);
		// The allowlisted name is unresolved → SKILL_NOT_FOUND covers it.
		const notFound = result.errors.find((e) => e.code === "SKILL_NOT_FOUND");
		expect(notFound).toBeDefined();
		expect(notFound?.skill).toBe("jira");
	});

	it("flags only the missing request dir when some roots exist and some do not", async () => {
		const realDir = join(tmpDir, "real");
		await mkdir(realDir);
		const jiraDir = join(realDir, "jira");
		await mkdir(jiraDir);
		await writeSkillMd(jiraDir, { name: "jira", description: "real jira" });
		const ghost = join(tmpdir(), `drmclaw-ghost-pair-${randomUUID()}`);

		const result = await resolveSkillsForRequest({
			config: makeConfig({}),
			skillDirs: [realDir, ghost],
			skillAllowlist: ["jira"],
		});

		const rootMissing = result.errors.find((e) => e.code === "SKILL_ROOT_MISSING");
		expect(rootMissing).toBeDefined();
		// Only the missing dir is reported — the real one is not included.
		expect(rootMissing?.skillDirs).toEqual([ghost]);
		// The allowlisted skill is still resolved via the real dir, so no
		// SKILL_NOT_FOUND or SKILL_NOT_READY is raised.
		expect(result.errors.some((e) => e.code === "SKILL_NOT_FOUND")).toBe(false);
		expect(result.errors.some((e) => e.code === "SKILL_NOT_READY")).toBe(false);
	});

	it("returns SKILL_NOT_READY when the allowlisted skill exists but has unmet requirements", async () => {
		const skillDir = join(tmpDir, "jira");
		await mkdir(skillDir);
		await writeSkillMd(skillDir, {
			name: "jira",
			description: "real jira stub",
			requires: ["definitely-not-a-real-cmd-abc-999"],
		});

		const result = await resolveSkillsForRequest({
			config: makeConfig({}),
			skillDirs: [tmpDir],
			skillAllowlist: ["jira"],
		});

		const notReady = result.errors.find((e) => e.code === "SKILL_NOT_READY");
		expect(notReady).toBeDefined();
		expect(notReady?.skill).toBe("jira");
		expect(notReady?.missingRequires).toContain("definitely-not-a-real-cmd-abc-999");
		// Runtime-ready invariant: an unready allowlisted skill must NOT
		// appear in `result.skills`. The SKILL_NOT_READY error is the
		// authoritative signal, and the returned list is safe for callers
		// that consume it without gating on `errors.length === 0`.
		expect(result.skills.map((s) => s.name)).not.toContain("jira");
	});

	it("succeeds when the allowlisted skill is found in the request dir and ready", async () => {
		const skillDir = join(tmpDir, "jira");
		await mkdir(skillDir);
		await writeSkillMd(skillDir, { name: "jira", description: "jira stub" });

		const result = await resolveSkillsForRequest({
			config: makeConfig({}),
			skillDirs: [tmpDir],
			skillAllowlist: ["jira"],
		});

		expect(result.errors).toEqual([]);
		expect(result.skills.map((s) => s.name)).toEqual(["jira"]);
	});

	it("does not enforce the contract when no allowlist is declared", async () => {
		const result = await resolveSkillsForRequest({
			config: makeConfig({}),
			skillDirs: [join(tmpdir(), `never-exists-${randomUUID()}`)],
		});

		expect(result.errors).toEqual([]);
	});

	// ---- Per-request error-class precedence ----

	it("returns no errors and both skills when a multi-name allowlist is fully satisfied", async () => {
		const a = join(tmpDir, "alpha");
		const b = join(tmpDir, "beta");
		await mkdir(a);
		await mkdir(b);
		await writeSkillMd(a, { name: "alpha", description: "a" });
		await writeSkillMd(b, { name: "beta", description: "b" });

		const result = await resolveSkillsForRequest({
			config: makeConfig({}),
			skillDirs: [tmpDir],
			skillAllowlist: ["alpha", "beta"],
		});

		expect(result.errors).toEqual([]);
		expect(result.skills.map((s) => s.name).sort()).toEqual(["alpha", "beta"]);
	});

	it("emits one SKILL_NOT_FOUND per missing name and zero SKILL_NOT_READY when all allowlisted names are missing", async () => {
		// Empty but real directory: roots check passes.
		const result = await resolveSkillsForRequest({
			config: makeConfig({}),
			skillDirs: [tmpDir],
			skillAllowlist: ["alpha", "beta"],
		});

		const codes = result.errors.map((e) => e.code);
		expect(codes.filter((c) => c === "SKILL_NOT_FOUND")).toHaveLength(2);
		expect(codes.filter((c) => c === "SKILL_NOT_READY")).toHaveLength(0);
		expect(result.errors.map((e) => e.skill).sort()).toEqual(["alpha", "beta"]);
		expect(result.skills).toEqual([]);
	});

	it("emits SKILL_NOT_FOUND only (not SKILL_NOT_READY) when one name is missing and another is found-but-unready", async () => {
		// Beta is present but not ready; alpha is missing entirely.
		const b = join(tmpDir, "beta");
		await mkdir(b);
		await writeSkillMd(b, {
			name: "beta",
			description: "needs missing cmd",
			requires: ["definitely-not-real-cmd-precedence-001"],
		});

		const result = await resolveSkillsForRequest({
			config: makeConfig({}),
			skillDirs: [tmpDir],
			skillAllowlist: ["alpha", "beta"],
		});

		const codes = result.errors.map((e) => e.code);
		// Precedence pin: SKILL_NOT_FOUND dominates; SKILL_NOT_READY is suppressed.
		expect(codes.filter((c) => c === "SKILL_NOT_FOUND")).toHaveLength(1);
		expect(codes.filter((c) => c === "SKILL_NOT_READY")).toHaveLength(0);
		expect(result.errors.find((e) => e.code === "SKILL_NOT_FOUND")?.skill).toBe("alpha");
		// beta is unready, so it must not appear in the runtime-ready list.
		expect(result.skills.map((s) => s.name)).not.toContain("beta");
	});

	it("emits one SKILL_NOT_READY (and zero SKILL_NOT_FOUND) when all allowlisted names are found but one is unready", async () => {
		const a = join(tmpDir, "alpha");
		const b = join(tmpDir, "beta");
		await mkdir(a);
		await mkdir(b);
		await writeSkillMd(a, { name: "alpha", description: "ready" });
		await writeSkillMd(b, {
			name: "beta",
			description: "unready",
			requires: ["definitely-not-real-cmd-precedence-002"],
		});

		const result = await resolveSkillsForRequest({
			config: makeConfig({}),
			skillDirs: [tmpDir],
			skillAllowlist: ["alpha", "beta"],
		});

		const codes = result.errors.map((e) => e.code);
		expect(codes.filter((c) => c === "SKILL_NOT_READY")).toHaveLength(1);
		expect(codes.filter((c) => c === "SKILL_NOT_FOUND")).toHaveLength(0);
		expect(result.errors.find((e) => e.code === "SKILL_NOT_READY")?.skill).toBe("beta");
		// Runtime-ready invariant: only the ready, allowlisted skill is returned.
		expect(result.skills.map((s) => s.name)).toEqual(["alpha"]);
	});

	it("returns ONLY SKILL_ROOT_MISSING even when an allowlisted skill would otherwise resolve via config", async () => {
		// A real skill exists in tmpDir, available via config.skills.dirs.
		const skillDir = join(tmpDir, "jira");
		await mkdir(skillDir);
		await writeSkillMd(skillDir, { name: "jira", description: "ready jira" });

		const ghost = join(tmpdir(), `drmclaw-ghost-precedence-${randomUUID()}`);
		const result = await resolveSkillsForRequest({
			config: makeConfig({ dirs: [tmpDir] }),
			skillDirs: [ghost],
			skillAllowlist: ["jira"],
		});

		// Precedence pin: missing root short-circuits everything else.
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0].code).toBe("SKILL_ROOT_MISSING");
		expect(result.errors[0].skillDirs).toEqual([ghost]);
		expect(result.errors.some((e) => e.code === "SKILL_NOT_FOUND")).toBe(false);
		expect(result.errors.some((e) => e.code === "SKILL_NOT_READY")).toBe(false);
	});

	it("succeeds when the allowlisted skill comes from the merged config set and the request root exists but is empty", async () => {
		// Allowlisted skill is provided ONLY by config.skills.dirs.
		const configDir = join(tmpdir(), `drmclaw-resolve-config-${randomUUID()}`);
		await mkdir(configDir, { recursive: true });
		const skillDir = join(configDir, "jira");
		await mkdir(skillDir);
		await writeSkillMd(skillDir, { name: "jira", description: "ready jira" });

		try {
			// Request root exists but contains no allowlisted skill.
			const result = await resolveSkillsForRequest({
				config: makeConfig({ dirs: [configDir] }),
				skillDirs: [tmpDir],
				skillAllowlist: ["jira"],
			});

			// Merged-source contract: either source can satisfy the allowlist.
			expect(result.errors).toEqual([]);
			expect(result.skills.map((s) => s.name)).toEqual(["jira"]);
		} finally {
			await rm(configDir, { recursive: true, force: true });
		}
	});
});

// ---------------------------------------------------------------------------
// parseSkillMd — typed action metadata (Phase 1 product-contract migration)
// ---------------------------------------------------------------------------

describe("parseSkillMd actions", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = join(tmpdir(), `drmclaw-parser-${randomUUID()}`);
		await mkdir(tmpDir, { recursive: true });
	});

	afterEach(async () => {
		await rm(tmpDir, { recursive: true, force: true });
	});

	async function writeRaw(frontmatter: string): Promise<string> {
		const path = join(tmpDir, "SKILL.md");
		await writeFile(path, `---\n${frontmatter}\n---\n# Skill\n`);
		return path;
	}

	it("parses a well-formed actions block with inputs, expectedEvidence, metadata", async () => {
		const path = await writeRaw(
			[
				"name: jira",
				"description: Jira skill",
				"actions:",
				"  - name: reload-tickets",
				"    description: Refresh Jira ticket data",
				"    inputs:",
				"      - name: projectKey",
				"        description: Jira project key",
				"        required: true",
				"        type: string",
				"      - name: limit",
				"        type: number",
				"        default: 50",
				"    expectedEvidence:",
				'      - "new or updated .xlsx artifact in tickets/reports/"',
				"    metadata:",
				"      foo: bar",
			].join("\n"),
		);

		const { meta } = await parseSkillMd(path);

		expect(meta.actions).toHaveLength(1);
		const action = meta.actions?.[0];
		expect(action?.name).toBe("reload-tickets");
		expect(action?.description).toBe("Refresh Jira ticket data");
		expect(action?.inputs).toHaveLength(2);
		expect(action?.inputs[0]).toEqual({
			name: "projectKey",
			description: "Jira project key",
			required: true,
			type: "string",
		});
		expect(action?.inputs[1]).toEqual({
			name: "limit",
			required: false,
			type: "number",
			default: 50,
		});
		expect(action?.expectedEvidence).toEqual(["new or updated .xlsx artifact in tickets/reports/"]);
		expect(action?.metadata).toEqual({ foo: "bar" });
	});

	it("returns an empty actions list when the field is absent", async () => {
		const path = await writeRaw(["name: simple", "description: no actions"].join("\n"));

		const { meta } = await parseSkillMd(path);

		expect(meta.actions).toEqual([]);
	});

	it("defensively skips or coerces malformed action entries without throwing", async () => {
		const path = await writeRaw(
			[
				"name: messy",
				"description: malformed actions",
				"actions:",
				"  - description: missing name (skipped)",
				"  - name: 42",
				"  - name: non-array-inputs",
				"    inputs: not-a-list",
				"  - name: bad-inputs",
				"    inputs:",
				"      - description: no name (skipped)",
				"      - name: ok",
				"        type: bogus",
				"    expectedEvidence: not-a-list",
				"  - name: mixed-evidence",
				"    expectedEvidence:",
				"      - good",
				"      - 123",
				"    metadata: not-an-object",
			].join("\n"),
		);

		const { meta } = await parseSkillMd(path);
		const names = meta.actions?.map((a) => a.name) ?? [];
		// Entries with non-string names are dropped; name-only entries kept.
		expect(names).toEqual(["non-array-inputs", "bad-inputs", "mixed-evidence"]);

		const badInputs = meta.actions?.find((a) => a.name === "bad-inputs");
		// Nameless input dropped; unknown type dropped, default required=false.
		expect(badInputs?.inputs).toEqual([{ name: "ok", required: false }]);
		// Non-array expectedEvidence is ignored.
		expect(badInputs?.expectedEvidence).toBeUndefined();

		const nonArrayInputs = meta.actions?.find((a) => a.name === "non-array-inputs");
		// Non-array inputs becomes an empty list, not a throw.
		expect(nonArrayInputs?.inputs).toEqual([]);

		const mixed = meta.actions?.find((a) => a.name === "mixed-evidence");
		// Non-string evidence items are filtered out; string-only survives.
		expect(mixed?.expectedEvidence).toEqual(["good"]);
		// Non-object metadata is coerced to undefined.
		expect(mixed?.metadata).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// loadSkills — typed action metadata surfaces on SkillEntry
// ---------------------------------------------------------------------------

describe("loadSkills actions", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = join(tmpdir(), `drmclaw-loader-actions-${randomUUID()}`);
		await mkdir(tmpDir, { recursive: true });
	});

	afterEach(async () => {
		await rm(tmpDir, { recursive: true, force: true });
	});

	async function writeRawSkill(dir: string, frontmatter: string): Promise<void> {
		await writeFile(join(dir, "SKILL.md"), `---\n${frontmatter}\n---\n# Skill\n`);
	}

	it("defaults to an empty actions list when SKILL.md omits actions", async () => {
		const skillDir = join(tmpDir, "plain");
		await mkdir(skillDir);
		await writeRawSkill(skillDir, "name: plain\ndescription: plain skill");

		const skills = await loadSkills(makeConfig({ dirs: [tmpDir] }));

		expect(skills).toHaveLength(1);
		expect(skills[0].actions).toEqual([]);
	});

	it("carries parsed actions onto the SkillEntry end-to-end", async () => {
		const skillDir = join(tmpDir, "jira");
		await mkdir(skillDir);
		await writeRawSkill(
			skillDir,
			[
				"name: jira",
				"description: Jira skill",
				"actions:",
				"  - name: reload-tickets",
				"    description: Refresh Jira ticket data",
				"    inputs:",
				"      - name: projectKey",
				"        required: true",
				"        type: string",
				"    expectedEvidence:",
				"      - tickets/reports/report.xlsx",
				"  - name: summarize",
				"    inputs: []",
			].join("\n"),
		);

		const skills = await loadSkills(makeConfig({ dirs: [tmpDir] }));
		const jira = skills.find((s) => s.name === "jira");

		expect(jira).toBeDefined();
		expect(jira?.actions).toHaveLength(2);
		expect(jira?.actions?.[0]).toEqual({
			name: "reload-tickets",
			description: "Refresh Jira ticket data",
			inputs: [{ name: "projectKey", required: true, type: "string" }],
			expectedEvidence: ["tickets/reports/report.xlsx"],
		});
		expect(jira?.actions?.[1]).toEqual({ name: "summarize", inputs: [] });
	});

	it("defaults to an empty actions list for entrypoint-only skills (no SKILL.md)", async () => {
		const skillDir = join(tmpDir, "entry-only");
		await mkdir(skillDir);
		await writeFile(join(skillDir, "index.ts"), "// standalone entrypoint\n");

		const skills = await loadSkills(makeConfig({ dirs: [tmpDir] }));
		const entry = skills.find((s) => s.name === "entry-only");

		expect(entry).toBeDefined();
		expect(entry?.skillMdPath).toBeUndefined();
		expect(entry?.entrypoint).toContain("index.ts");
		expect(entry?.actions).toEqual([]);
	});
});
