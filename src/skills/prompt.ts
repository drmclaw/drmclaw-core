import type { SkillEntry } from "./types.js";

/**
 * Format loaded skills into a compact XML listing for the LLM system prompt.
 *
 * Skills are listed as `<available_skills>` with name, description, and file location.
 * The LLM reads full SKILL.md on demand via tool call — this keeps the base prompt small.
 */
export function formatSkillsForPrompt(skills: SkillEntry[]): string {
	if (skills.length === 0) {
		return "<available_skills>\nNo skills loaded.\n</available_skills>";
	}

	const entries = skills
		.map((s) => {
			const desc = s.description ? ` description="${escapeXmlAttr(s.description)}"` : "";
			const loc = s.skillMdPath ?? s.dir;
			return `  <skill name="${escapeXmlAttr(s.name)}"${desc} location="${escapeXmlAttr(loc)}" />`;
		})
		.join("\n");

	return `<available_skills>\n${entries}\n</available_skills>`;
}

function escapeXmlAttr(str: string): string {
	return str
		.replace(/&/g, "&amp;")
		.replace(/"/g, "&quot;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}
