import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { DrMClawConfig } from "../config/schema.js";
import { formatSkillsForPrompt } from "../skills/prompt.js";
import type { SkillEntry } from "../skills/types.js";

const BOOTSTRAP_FILES = ["AGENTS.md", "CONTEXT.md"];

/**
 * Assemble the structured system prompt.
 *
 * Sections: Tooling → Safety → Skills → Workspace → Runtime → Time
 */
export async function assembleSystemPrompt(
	config: DrMClawConfig,
	skills: SkillEntry[],
): Promise<string> {
	const sections: string[] = [];

	// --- Tooling ---
	sections.push(
		"<tooling>\nYou have access to tools provided by the runtime environment.\n</tooling>",
	);

	// --- Safety ---
	sections.push(
		"<safety>\n" +
			"Follow the execution policy. Only use approved tools and skills.\n" +
			"Do not execute commands outside the tool allowlist.\n" +
			"Never expose secrets, credentials, or API keys in output.\n" +
			"</safety>",
	);

	// --- Skills ---
	sections.push(formatSkillsForPrompt(skills));

	// --- Workspace bootstrap ---
	if (config.workspace.dir) {
		const bootstrap = await loadBootstrapContext(config);
		if (bootstrap) {
			sections.push(`<project_context>\n${bootstrap}\n</project_context>`);
		}
	}

	// --- Runtime ---
	sections.push(`<runtime>\nEngine: drmclaw-core\nProvider: ${config.llm.provider}\n</runtime>`);

	// --- Time ---
	sections.push(`<time>\nCurrent time: ${new Date().toISOString()}\n</time>`);

	return sections.join("\n\n");
}

async function loadBootstrapContext(config: DrMClawConfig): Promise<string | null> {
	if (!config.workspace.dir) return null;

	const parts: string[] = [];
	let totalChars = 0;
	const maxPerFile = config.workspace.bootstrapMaxChars;
	const maxTotal = config.workspace.bootstrapTotalMaxChars;

	for (const fileName of BOOTSTRAP_FILES) {
		if (totalChars >= maxTotal) break;

		const filePath = join(config.workspace.dir, fileName);
		let content: string;
		try {
			content = await readFile(filePath, "utf-8");
		} catch {
			continue; // Missing files skipped
		}

		const remaining = maxTotal - totalChars;
		const cap = Math.min(maxPerFile, remaining);

		if (content.length > cap) {
			content = `${content.slice(0, cap)}\n\n[... truncated at ${cap} characters ...]`;
		}

		parts.push(`--- ${fileName} ---\n${content}`);
		totalChars += content.length;
	}

	return parts.length > 0 ? parts.join("\n\n") : null;
}
