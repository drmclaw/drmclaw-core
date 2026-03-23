import { describe, expect, it } from "vitest";
import { formatSkillsForPrompt } from "../src/skills/prompt.js";
import type { SkillEntry } from "../src/skills/types.js";

function makeSkill(name: string, description = ""): SkillEntry {
	return {
		name,
		description,
		dir: `/skills/${name}`,
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

	it("formats skills as XML listing", () => {
		const skills = [
			makeSkill("hello", "A greeting skill"),
			makeSkill("summarize", "Summarize text content"),
		];
		const result = formatSkillsForPrompt(skills);

		expect(result).toContain('<skill name="hello"');
		expect(result).toContain('description="A greeting skill"');
		expect(result).toContain('<skill name="summarize"');
	});

	it("escapes XML special characters", () => {
		const skills = [makeSkill('test<"name">', 'desc & "stuff"')];
		const result = formatSkillsForPrompt(skills);

		expect(result).toContain("&lt;");
		expect(result).toContain("&amp;");
		expect(result).toContain("&quot;");
		expect(result).not.toContain('<"name">');
	});
});
