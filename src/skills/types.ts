/** Metadata extracted from SKILL.md frontmatter. */
export interface SkillMetadata {
	name: string;
	description: string;
	requires?: string[];
	entrypoint?: string;
	metadata?: Record<string, unknown>;
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
