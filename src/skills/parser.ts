import { readFile } from "node:fs/promises";
import matter from "gray-matter";
import type { SkillMetadata } from "./types.js";
import { MAX_SKILL_MD_SIZE } from "./types.js";

/**
 * Parse a SKILL.md file, extracting frontmatter metadata and body content.
 * Enforces a 256 KB size limit.
 */
export async function parseSkillMd(
	filePath: string,
): Promise<{ meta: SkillMetadata; body: string }> {
	const content = await readFile(filePath, "utf-8");
	if (content.length > MAX_SKILL_MD_SIZE) {
		throw new Error(`SKILL.md exceeds maximum size (${MAX_SKILL_MD_SIZE} bytes): ${filePath}`);
	}

	const { data, content: body } = matter(content);

	const meta: SkillMetadata = {
		name: typeof data.name === "string" ? data.name : "",
		description: typeof data.description === "string" ? data.description : "",
		requires: Array.isArray(data.requires) ? data.requires : [],
		entrypoint: typeof data.entrypoint === "string" ? data.entrypoint : undefined,
		metadata:
			typeof data.metadata === "object" && data.metadata !== null
				? (data.metadata as Record<string, unknown>)
				: {},
	};

	return { meta, body };
}
