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
 *   - "codex"    → Codex App Server actions (tool calls, results, stream)
 *   - "system"   → system-level notices (task init)
 */
export interface PersistedRuntimeEvent {
	taskId: string;
	sequence: number;
	timestamp: string;
	source: "runtime" | "codex" | "system";
	event: EventPayload;
}

export type ExecutionRunKind = "task" | "skill-action";

export interface ExecutionToolSummary {
	name: string;
	callsStarted: number;
	callsCompleted: number;
	successCount: number;
	failureCount: number;
}

export interface ExecutionEventSummary {
	eventCounts: Record<string, number>;
	toolActivity: {
		totalCalls: number;
		uniqueTools: number;
		tools: ExecutionToolSummary[];
	};
}

export interface ExecutionTranscriptMessage {
	role: "user" | "assistant";
	timestamp: string | null;
	content: string;
}

export type ExecutionTimelineItemKind =
	| "prompt"
	| "lifecycle"
	| "progress"
	| "thinking"
	| "plan"
	| "tool_call"
	| "tool_result"
	| "usage";

export interface ExecutionTimelineItem {
	id: string;
	kind: ExecutionTimelineItemKind;
	timestamp: string | null;
	title: string;
	content?: string;
	preview?: string;
	status?: string;
	tool?: string;
	toolCallId?: string;
	toolKind?: string;
	args?: unknown;
	result?: unknown;
	sequenceStart: number;
	sequenceEnd: number;
}

export interface ExecutionRunMetadata {
	taskId: string;
	kind: ExecutionRunKind;
	status: "running" | "completed" | "error" | "stale";
	provider: string;
	requestedModel?: string;
	requestedReasoningEffort?: string;
	workingDir?: string;
	skill?: string;
	action?: string;
	inputs?: Record<string, unknown>;
	processId?: number;
	startedAt: string;
	finishedAt: string | null;
	durationMs: number | null;
	outputPreview?: string;
	errorPreview?: string;
	promptPreview?: string;
	eventCounts: Record<string, number>;
}

export interface ExecutionRunRecord {
	metadata: ExecutionRunMetadata;
	events: PersistedRuntimeEvent[];
	transcript: ExecutionTranscriptMessage[];
	timeline: ExecutionTimelineItem[];
	summary: ExecutionEventSummary;
}

/**
 * ExecutionHistoryStore — durable Codex run history.
 *
 * Storage is append-oriented while a run is active. Metadata is written with
 * `status: "running"` at runtime start and overwritten after completion.
 */
export interface ExecutionHistoryStore {
	append(taskId: string, event: PersistedRuntimeEvent): Promise<void>;
	saveMetadata(metadata: ExecutionRunMetadata): Promise<void>;
	markStaleRuns(options?: { now?: Date; staleAfterMs?: number }): Promise<number>;
	listRuns(options?: { limit?: number }): Promise<ExecutionRunMetadata[]>;
	readRun(taskId: string): Promise<ExecutionRunRecord | null>;
	listRunEvents(taskId: string): Promise<PersistedRuntimeEvent[]>;
}
