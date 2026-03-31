import type { TaskResult } from "../runner/types.js";
import type { SkillEntry } from "../skills/types.js";

/**
 * Cross-backend policy controls — fields that are semantically valid
 * for both ACP and direct-provider runtimes.
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

/**
 * A plain common policy with no backend-specific fields.
 *
 * Uses `never` markers so that a `DirectExecutionPolicy` or
 * `AcpExecutionPolicy` variable cannot be structurally assigned to this
 * type — closing the "variable path" loophole where excess-property
 * checks would otherwise not fire.
 */
export type PlainExecutionPolicy = CommonExecutionPolicy & {
	backend?: never;
	maxSteps?: never;
};

/**
 * ACP-mode policy — the upstream CLI owns the tool-calling loop.
 * drmclaw enforces tool allowlists via `evaluatePermission`, but does
 * not own loop-level bounds like `maxSteps`.
 */
export interface AcpExecutionPolicy extends CommonExecutionPolicy {
	backend: "acp";
}

/**
 * Direct-provider policy — drmclaw owns the tool-calling loop
 * (Vercel AI SDK `generateText` with `maxSteps`).
 */
export interface DirectExecutionPolicy extends CommonExecutionPolicy {
	backend: "direct";
	/** Maximum tool-calling rounds (default: 10). */
	maxSteps?: number;
}

/** Discriminated union of backend-specific execution policies. */
export type ExecutionPolicy = AcpExecutionPolicy | DirectExecutionPolicy;

/** Lifecycle phases emitted during an agent run. */
export type LifecyclePhase = "start" | "prompt_sent" | "end" | "error";

/** Origin tag carried by every RuntimeEvent so downstream consumers
 *  (runner, event store, UI) never need to re-derive source from type. */
export type RuntimeEventSource = "runtime" | "acp";

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

/** Runtime options for the ACP backend. */
export interface AcpRuntimeOptions extends BaseRuntimeOptions {
	backend: "acp";
	/** ACP-mode execution policy (no `maxSteps`). */
	policy?: AcpExecutionPolicy | PlainExecutionPolicy;
}

/** Runtime options for the direct-provider backend (future). */
export interface DirectRuntimeOptions extends BaseRuntimeOptions {
	backend: "direct";
	/** Direct-provider execution policy (includes `maxSteps`). */
	policy?: DirectExecutionPolicy | PlainExecutionPolicy;
}

/**
 * Discriminated union of backend-specific runtime options.
 *
 * Discriminated on `backend`: consumers can narrow with
 * `if (options.backend === "acp")` to access the correct policy type.
 */
export type AgentRuntimeOptions = AcpRuntimeOptions | DirectRuntimeOptions;

/**
 * AgentRuntime — bounded multi-step execution with skills, tools, and policies.
 *
 * In ACP mode: ACP-compatible CLIs own the tool-calling loop; drmclaw injects skills
 * via system prompt and enforces policies via tool allowlists.
 *
 * In direct-provider mode: drmclaw owns the tool-calling loop using Vercel AI SDK
 * `generateText` with `maxSteps` and drmclaw-defined tools.
 */
export interface AgentRuntime {
	run(options: AgentRuntimeOptions): Promise<TaskResult>;
}
