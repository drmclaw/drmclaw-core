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

/** Options for a single LLM adapter run. */
export interface LLMAdapterRunOptions {
	/** User prompt text. */
	prompt: string;
	/** System context (skills list, instructions). */
	systemContext?: string;
	/** Working directory for tool execution. */
	workingDir?: string;
	/** Tool allowlist for auto-approval. */
	allowedTools?: string[];
	/** Tool-kind allowlist for auto-approval. Empty = allow all kinds. */
	allowedToolKinds?: string[];
	/** Structured event callback for text, tool calls, and tool results. */
	onEvent?: (event: AdapterEvent) => void;
	/** Tool-call approval callback. */
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
}
