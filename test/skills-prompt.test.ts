import { describe, expect, it } from "vitest";
import { formatSkillsForPrompt } from "../src/skills/prompt.js";
import type { SkillEntry } from "../src/skills/types.js";

function makeSkill(name: string, description = "", skillMdPath?: string): SkillEntry {
	return {
		name,
		description,
		dir: `/skills/${name}`,
		skillMdPath,
		requires: [],
		metadata: {},
		source: "system",
		ready: true,
		missingRequires: [],
	};
}

describe("formatSkillsForPrompt", () => {
	it("returns empty message for no skills", () => {
		const result = formatSkillsForPrompt([]);
		expect(result).toContain("No skills loaded");
		expect(result).toContain("<available_skills>");
	});

	it("formats skills with name, description, and location", () => {
		const skills = [
			makeSkill("hello", "A greeting skill", "/skills/hello/SKILL.md"),
			makeSkill("summarize", "Summarize text content", "/skills/summarize/SKILL.md"),
		];
		const result = formatSkillsForPrompt(skills);

		expect(result).toContain("<name>hello</name>");
		expect(result).toContain("<description>A greeting skill</description>");
		expect(result).toContain("<location>/skills/hello/SKILL.md</location>");
		expect(result).toContain("<name>summarize</name>");
		expect(result).toContain("<available_skills>");
		expect(result).toContain("Use the read tool");
	});

	it("instructs LLM to use read tool for skill files", () => {
		const skills = [makeSkill("hello", "Greet", "/skills/hello/SKILL.md")];
		const result = formatSkillsForPrompt(skills);

		expect(result).toContain("Use the read tool to load a skill's SKILL.md file");
		expect(result).toContain("resolve it against the skill directory");
	});

	it("does not embed body content inline", () => {
		const skill = makeSkill("hello", "Greet the user", "/skills/hello/SKILL.md");
		skill.content = "# Hello\nRespond with a greeting.";
		const result = formatSkillsForPrompt([skill]);

		expect(result).not.toContain("# Hello");
		expect(result).not.toContain("Respond with a greeting.");
	});

	it("escapes XML special characters", () => {
		const skills = [makeSkill("test", "desc & <stuff>")];
		const result = formatSkillsForPrompt(skills);

		expect(result).toContain("&lt;stuff&gt;");
		expect(result).toContain("&amp;");
	});

	it("omits location when skillMdPath is absent", () => {
		const skills = [makeSkill("minimal", "A minimal skill")];
		const result = formatSkillsForPrompt(skills);

		expect(result).toContain("<name>minimal</name>");
		expect(result).not.toContain("<location>");
	});

	it("filters out skills that are not ready", () => {
		const ready = makeSkill("hello", "Greet", "/skills/hello/SKILL.md");
		const notReady = makeSkill("broken", "Missing deps");
		notReady.ready = false;
		const result = formatSkillsForPrompt([ready, notReady]);

		expect(result).toContain("<name>hello</name>");
		expect(result).not.toContain("broken");
	});
});
