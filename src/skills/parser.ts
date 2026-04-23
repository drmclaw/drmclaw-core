import { readFile } from "node:fs/promises";
import matter from "gray-matter";
import type { SkillAction, SkillActionInput, SkillMetadata } from "./types.js";
import { MAX_SKILL_MD_SIZE } from "./types.js";

const KNOWN_INPUT_TYPES = ["string", "number", "boolean", "object", "array"] as const;
type KnownInputType = (typeof KNOWN_INPUT_TYPES)[number];

function isKnownInputType(value: unknown): value is KnownInputType {
	return typeof value === "string" && (KNOWN_INPUT_TYPES as readonly string[]).includes(value);
}

function parseActionInput(raw: unknown): SkillActionInput | null {
	if (typeof raw !== "object" || raw === null) return null;
	const r = raw as Record<string, unknown>;
	if (typeof r.name !== "string" || r.name.length === 0) return null;

	const input: SkillActionInput = { name: r.name };
	if (typeof r.description === "string") input.description = r.description;
	input.required = r.required === true;
	if (isKnownInputType(r.type)) input.type = r.type;
	if ("default" in r) input.default = r.default;
	return input;
}

function parseAction(raw: unknown): SkillAction | null {
	if (typeof raw !== "object" || raw === null) return null;
	const r = raw as Record<string, unknown>;
	if (typeof r.name !== "string" || r.name.length === 0) return null;

	const inputs: SkillActionInput[] = [];
	if (Array.isArray(r.inputs)) {
		for (const item of r.inputs) {
			const parsed = parseActionInput(item);
			if (parsed) inputs.push(parsed);
		}
	}

	const action: SkillAction = { name: r.name, inputs };
	if (typeof r.description === "string") action.description = r.description;
	if (Array.isArray(r.expectedEvidence)) {
		const evidence = r.expectedEvidence.filter((v): v is string => typeof v === "string");
		if (evidence.length > 0) action.expectedEvidence = evidence;
	}
	if (typeof r.metadata === "object" && r.metadata !== null && !Array.isArray(r.metadata)) {
		action.metadata = r.metadata as Record<string, unknown>;
	}
	return action;
}

function parseActions(raw: unknown): SkillAction[] {
	if (!Array.isArray(raw)) return [];
	const actions: SkillAction[] = [];
	for (const item of raw) {
		const parsed = parseAction(item);
		if (parsed) actions.push(parsed);
	}
	return actions;
}

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
		actions: parseActions(data.actions),
	};

	return { meta, body };
}
