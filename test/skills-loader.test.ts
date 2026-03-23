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
