import type { DrMClawConfig } from "../config/schema.js";
import type { LLMAdapter } from "./adapter.js";
import { CodexAppServerAdapter } from "./codex-app-server.js";

/**
 * Factory: create the appropriate LLM adapter based on config.
 *
 * Codex App Server is the only supported runtime. It is spawned over stdio
 * per execution by the adapter.
 */
export function createLLMAdapter(config: DrMClawConfig): LLMAdapter {
	return new CodexAppServerAdapter(config);
}
