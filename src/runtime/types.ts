import type { TaskResult } from "../runner/types.js";
import type { SkillEntry } from "../skills/types.js";

/**
 * Cross-runtime policy controls.
 */
export interface CommonExecutionPolicy {
	/** Permission mode override for this run. */
	permissionMode?: "approve-all" | "approve-reads" | "deny-all";
	/** Allowed skill names. Empty = allow all. */
	skillAllowlist?: string[];
	/** File path patterns the agent may read/write. */
	filePatterns?: string[];
	/** Shell commands allowed for execution. */
	commandAllowlist?: string[];
}

/** A plain common policy with no backend-specific fields. */
export type PlainExecutionPolicy = CommonExecutionPolicy & {
	backend?: never;
	maxSteps?: never;
};

/** Codex App Server policy — Codex owns the tool-calling loop. */
export interface CodexExecutionPolicy extends CommonExecutionPolicy {
	backend: "codex";
}

/** Discriminated union of backend-specific execution policies. */
export type ExecutionPolicy = CodexExecutionPolicy;

/** Lifecycle phases emitted during an agent run. */
export type LifecyclePhase = "start" | "prompt_sent" | "end" | "error";

/** Origin tag carried by every RuntimeEvent so downstream consumers
 *  (runner, event store, UI) never need to re-derive source from type. */
export type RuntimeEventSource = "runtime" | "codex";

/** Events emitted during an AgentRuntime run. */
export type RuntimeEvent = { source: RuntimeEventSource } & (
	| { type: "lifecycle"; phase: "start" }
	| { type: "lifecycle"; phase: "prompt_sent" }
	| { type: "lifecycle"; phase: "end"; result: TaskResult }
	| { type: "lifecycle"; phase: "error"; error: string }
	| { type: "stream"; delta: string }
	| {
			type: "tool_call";
			tool: string;
			status: string;
			kind?: string;
			args?: unknown;
			toolCallId?: string;
	  }
	| { type: "tool_result"; tool: string; result: unknown; toolCallId?: string }
	| { type: "thinking"; text: string }
	| {
			type: "plan";
			entries: Array<{ content: string; priority: string; status: string }>;
	  }
	| {
			type: "usage";
			used: number;
			size: number;
			cost?: { amount: number; currency: string } | null;
	  }
);

/** Base options shared by all AgentRuntime backends. */
interface BaseRuntimeOptions {
	/** User prompt text. */
	prompt: string;
	/** Assembled system prompt (Tooling/Safety/Skills/Workspace/Runtime/Time). */
	systemContext?: string;
	/** Loaded skills available for this run. */
	skills: SkillEntry[];
	/** Working directory for tool execution. */
	workingDir?: string;
	/** Session ID for multi-turn context. */
	sessionId?: string;
	/** Event callback for streaming lifecycle and chunks. */
	onEvent?: (event: RuntimeEvent) => void;
}

/** Runtime options for the Codex App Server backend. */
export interface CodexRuntimeOptions extends BaseRuntimeOptions {
	backend: "codex";
	policy?: CodexExecutionPolicy | PlainExecutionPolicy;
}

/**
 * Discriminated union of backend-specific runtime options.
 *
 * Discriminated on `backend`; currently Codex App Server is the only backend.
 */
export type AgentRuntimeOptions = CodexRuntimeOptions;

/**
 * AgentRuntime — bounded multi-step execution with skills, tools, and policies.
 *
 * Codex App Server owns the tool-calling loop; drmclaw injects skills via
 * system prompt and maps Codex events into the shared runtime event vocabulary.
 */
export interface AgentRuntime {
	run(options: AgentRuntimeOptions): Promise<TaskResult>;
}
