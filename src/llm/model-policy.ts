/**
 * Convert a simple glob pattern (supports only `*` as wildcard) to a
 * RegExp anchored to the full string.
 */
function globToRegExp(pattern: string): RegExp {
	const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
	return new RegExp(`^${escaped}$`);
}

/**
 * Return `true` if the model is allowed (not matched by any exclusion
 * pattern). Each pattern is a simple glob where `*` matches any substring.
 */
export function isModelAllowed(modelId: string, excludePatterns: readonly string[]): boolean {
	return !excludePatterns.some((p) => globToRegExp(p).test(modelId));
}
