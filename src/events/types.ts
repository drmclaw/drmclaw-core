import type { TaskResult } from "../runner/types.js";

/** Inner event payload discriminated by `type`. */
export type EventPayload =
	| { type: "task_init"; prompt: string }
	| { type: "lifecycle"; phase: "start" }
	| { type: "lifecycle"; phase: "prompt_sent" }
	| { type: "lifecycle"; phase: "end"; result?: TaskResult }
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

/**
 * Persisted runtime event — the append-only event log envelope.
 *
 * Every event produced during a task run is wrapped in this envelope
 * before being written to disk and broadcast over WebSocket.
 *
 * `source` identifies event origin in the unified Events timeline:
 *   - "runtime"  → drmclaw-core orchestration (lifecycle events)
 *   - "acp"      → LLM provider actions (tool calls, results, stream)
 *   - "system"   → system-level notices (task init)
 */
export interface PersistedRuntimeEvent {
	taskId: string;
	sequence: number;
	timestamp: string;
	source: "runtime" | "acp" | "system";
	event: EventPayload;
}

/**
 * EventStore — append-only per-task event log.
 *
 * MVP interface: append events and replay them for a given task.
 */
export interface EventStore {
	append(taskId: string, event: PersistedRuntimeEvent): Promise<void>;
	listTaskEvents(taskId: string): Promise<PersistedRuntimeEvent[]>;
	/** List all persisted tasks (id + prompt extracted from the task_init event). */
	listTasks(): Promise<Array<{ id: string; prompt: string; startedAt: string }>>;
}
