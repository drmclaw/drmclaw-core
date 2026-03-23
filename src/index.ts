/**
 * drmclaw-core — library entrypoint (side-effect-free).
 *
 * Re-exports all public types, classes, and factory functions.
 * For server bootstrap, use `src/cli.ts` or `node dist/cli.js`.
 */

// Config
export { loadDrMClawConfig } from "./config/loader.js";
export {
	configSchema,
	defineConfig,
	isCliProvider,
	resolveAcpCommandArgs,
} from "./config/schema.js";
export type {
	AcpConfig,
	CliProvider,
	DrMClawConfig,
	EmbeddedProvider,
	LLMProvider,
} from "./config/schema.js";

// Skills
export { loadSkills } from "./skills/loader.js";
export { resolveSystemSkillsDir } from "./skills/loader.js";
export { findMissingRequires } from "./skills/check.js";
export type { SkillEntry, SkillMetadata } from "./skills/types.js";

// LLM
export { createLLMAdapter } from "./llm/index.js";
export type { AdapterEvent, LLMAdapter, LLMAdapterRunOptions } from "./llm/adapter.js";
export { AcpSessionManager } from "./llm/acp-session.js";
export type { AcpSession } from "./llm/acp-session.js";

// Runtime
export { createAgentRuntime } from "./runtime/agent.js";
export type {
	AcpExecutionPolicy,
	AcpRuntimeOptions,
	AgentRuntime,
	AgentRuntimeOptions,
	CommonExecutionPolicy,
	DirectExecutionPolicy,
	DirectRuntimeOptions,
	ExecutionPolicy,
	PlainExecutionPolicy,
	RuntimeEvent,
} from "./runtime/types.js";

// Runner
export { TaskRunner } from "./runner/runner.js";
export type { TaskResult, TaskStatus, TaskRequest, TaskRecord } from "./runner/types.js";

// Scheduler
export { CronService } from "./scheduler/service.js";
export type { CronJob } from "./scheduler/types.js";

// Connectors
export type { Connector, MessageHandler } from "./connectors/interface.js";
export { WebConnector } from "./connectors/web.js";

// Server
export { createApp } from "./server/app.js";
export type { AppWithWebSocket } from "./server/app.js";
