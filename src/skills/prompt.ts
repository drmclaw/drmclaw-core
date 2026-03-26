import type { SkillEntry } from "./types.js";

/**
 * Format loaded skills into a catalog for the LLM system prompt.
 *
 * Each skill is listed with its name, description, and the file path to
 * its SKILL.md.  The LLM is instructed to use its built-in read tool to
 * load the skill's instructions on demand — no custom MCP server needed.
 *
 * The ACP CLI agent (Copilot, Claude, etc.)
 * already has file-reading tools, so the LLM just reads
 * SKILL.md when a skill applies.
 */
export function formatSkillsForPrompt(skills: SkillEntry[]): string {
	if (skills.length === 0) {
		return "<available_skills>\nNo skills loaded.\n</available_skills>";
	}

	const visible = skills.filter((s) => s.ready);
	if (visible.length === 0) {
		return "<available_skills>\nNo skills loaded.\n</available_skills>";
	}

	const lines = [
		"The following skills provide specialized instructions for specific tasks.",
		"Use the read tool to load a skill's SKILL.md file when the task matches its name.",
		"When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md) and use that absolute path in tool commands.",
		"",
		"<available_skills>",
	];

	for (const s of visible) {
		lines.push("  <skill>");
		lines.push(`    <name>${escapeXml(s.name)}</name>`);
		if (s.description) {
			lines.push(`    <description>${escapeXml(s.description)}</description>`);
		}
		if (s.skillMdPath) {
			lines.push(`    <location>${escapeXml(s.skillMdPath)}</location>`);
		}
		lines.push("  </skill>");
	}

	lines.push("</available_skills>");
	return lines.join("\n");
}

function escapeXml(str: string): string {
	return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
