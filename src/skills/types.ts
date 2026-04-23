/** A typed input declaration on a skill action. */
export interface SkillActionInput {
	/** Input name (unique within the action). */
	name: string;
	/** Short human-readable description. */
	description?: string;
	/** Whether the input must be supplied at call time. Default false. */
	required?: boolean;
	/** Lightweight type hint. Domain-agnostic; core does not interpret semantics. */
	type?: "string" | "number" | "boolean" | "object" | "array";
	/** Optional default value applied when the caller omits the input. */
	default?: unknown;
}

/** A typed action exposed by a skill. Domain-agnostic. */
export interface SkillAction {
	/** Unique action name within the skill. */
	name: string;
	/** Short human-readable description of what the action does. */
	description?: string;
	/** Declared inputs for this action. */
	inputs: SkillActionInput[];
	/** Expected artifacts/evidence the action should produce (free-form strings). */
	expectedEvidence?: string[];
	/** Arbitrary per-action metadata the domain may attach. Core does not interpret. */
	metadata?: Record<string, unknown>;
}

/** Metadata extracted from SKILL.md frontmatter. */
export interface SkillMetadata {
	name: string;
	description: string;
	requires?: string[];
	entrypoint?: string;
	metadata?: Record<string, unknown>;
	actions?: SkillAction[];
}

/** A loaded skill entry with its resolved paths and parsed metadata. */
export interface SkillEntry {
	/** Unique skill name (from frontmatter or directory name). */
	name: string;
	/** Human-readable description. */
	description: string;
	/** Absolute path to the skill directory. */
	dir: string;
	/** Absolute path to the SKILL.md file, if present. */
	skillMdPath?: string;
	/** Absolute path to the entrypoint script, if present. */
	entrypoint?: string;
	/** Body content from SKILL.md (instructions), if present. */
	content?: string;
	/** Additional requirements declared by the skill. */
	requires: string[];
	/** Arbitrary metadata from frontmatter. */
	metadata: Record<string, unknown>;
	/** Typed actions declared by the skill. Optional for external constructors; the loader always populates this as an array (empty when no actions are declared). */
	actions?: SkillAction[];
	/** Source precedence: "system" | directory path. */
	source: string;
	/** Whether all declared requirements are satisfied. */
	ready: boolean;
	/** Requirements from `requires` that were not found locally. */
	missingRequires: string[];
}

/** Maximum allowed size for a SKILL.md file (256 KB). */
export const MAX_SKILL_MD_SIZE = 256 * 1024;

/** Maximum candidate directories to scan per skill root. */
export const MAX_CANDIDATES_PER_ROOT = 200;

/** Maximum skills to load per root directory. */
export const MAX_SKILLS_PER_ROOT = 100;
