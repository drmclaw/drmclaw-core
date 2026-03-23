import { isCliProvider } from "../config/schema.js";
import type { DrMClawConfig } from "../config/schema.js";
import { AcpAdapter } from "./acp.js";
import type { LLMAdapter } from "./adapter.js";

/**
 * Factory: create the appropriate LLM adapter based on config.
 *
 * CLI providers (github-copilot, claude-cli, openai-cli, gemini-cli) route
 * through the ACP adapter.  Embedded providers (claude, openai, gemini) will
 * use a direct HTTP adapter (future).
 */
export function createLLMAdapter(config: DrMClawConfig): LLMAdapter {
	if (isCliProvider(config.llm.provider)) {
		return new AcpAdapter(config);
	}

	// Future: use Vercel AI SDK Core (`ai`) for embedded providers.
	throw new Error(
		`Embedded provider "${config.llm.provider}" is not yet implemented. Use a CLI provider (github-copilot, claude-cli, openai-cli, gemini-cli).`,
	);
}
