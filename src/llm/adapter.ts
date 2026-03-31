import type { TaskResult } from "../runner/types.js";

/** Structured events emitted by an LLM adapter during a run. */
export type AdapterEvent =
	| { type: "text"; text: string }
	| {
			type: "tool_call";
			tool: string;
			status: string;
			kind?: string;
			args?: unknown;
			toolCallId?: string;
	  }
	| { type: "tool_result"; tool: string; result?: unknown; toolCallId?: string }
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
	  };

/** Permission mode for tool-call approval. */
export type PermissionMode = "approve-all" | "approve-reads" | "deny-all";

/** Options for a single LLM adapter run. */
export interface LLMAdapterRunOptions {
	/** User prompt text. */
	prompt: string;
	/** System context (skills list, instructions). */
	systemContext?: string;
	/** Working directory for tool execution. */
	workingDir?: string;
	/** Permission mode for tool-call approval (default: approve-reads). */
	permissionMode?: PermissionMode;
	/** Structured event callback for text, tool calls, and tool results. */
	onEvent?: (event: AdapterEvent) => void;
	/** Tool-call approval callback — if set, overrides permissionMode. */
	onToolCall?: (tool: string, args: unknown) => Promise<"approved" | "denied">;
	/** ACP session ID to resume (if the session manager provides one). */
	sessionId?: string;
}

/**
 * LLMAdapter — raw provider access.
 *
 * Responsible for starting a session, sending a prompt, and receiving
 * streaming events from a specific LLM provider.
 */
export interface LLMAdapter {
	run(options: LLMAdapterRunOptions): Promise<TaskResult>;
	dispose(): Promise<void>;
	/** Update the model for subsequent runs (tears down cached sessions). */
	setModel?(model: string): Promise<void>;
	/** Return models discovered from the agent (may be empty before first session). */
	getAvailableModels?(): Array<{ id: string; name: string }>;
	/** Eagerly discover available models from the agent. */
	discoverModels?(): Promise<Array<{ id: string; name: string }>>;
}
