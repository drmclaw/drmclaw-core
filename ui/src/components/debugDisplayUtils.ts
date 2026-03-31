/**
 * Pure logic for round-aware display grouping in the DebugConsole.
 *
 * Extracted from DebugConsole.tsx so it can be unit-tested without
 * React or DOM dependencies.
 */

// ── Shared types ─────────────────────────────────────────────────────

/** A single event from the backend, regardless of source label. */
export interface EventLogEntry {
	sequence: number;
	timestamp: string;
	source: "runtime" | "acp" | "system";
	event: {
		type: string;
		phase?: string;
		error?: string;
		result?: unknown;
		tool?: string;
		status?: string;
		kind?: string;
		args?: unknown;
		toolCallId?: string;
		prompt?: string;
		delta?: string;
		text?: string;
		entries?: Array<{ content: string; priority: string; status: string }>;
		used?: number;
		size?: number;
		cost?: { amount: number; currency: string } | null;
	};
}

export type UnifiedDisplayItem =
	| { kind: "event"; entry: EventLogEntry }
	| {
			kind: "stream-group";
			entries: EventLogEntry[];
			totalChars: number;
			isLive: boolean;
	  }
	| {
			kind: "thinking-group";
			entries: EventLogEntry[];
			totalChars: number;
			isLive: boolean;
	  }
	| {
			kind: "tool-call-group";
			toolCallId: string;
			entries: EventLogEntry[];
			isLive: boolean;
	  };

// ── Display builder ──────────────────────────────────────────────────

/**
 * Build a unified display list from all events in sequence order.
 *
 * Consecutive `stream` events are collapsed into a stream-group.
 * Consecutive `thinking` events are collapsed into a thinking-group.
 * Tool events (`tool_call` / `tool_result`) sharing the same `toolCallId`
 * are collected into a tool-call-group, rendered at the position of their
 * first event. This works even when thinking, stream, or other tool events
 * are interleaved between the pending and completed states.
 */
export function buildUnifiedDisplay(
	entries: EventLogEntry[],
	isStreaming: boolean,
): UnifiedDisplayItem[] {
	// ── Pass 1: collect tool events by toolCallId ────────────────────
	const toolEventsByCallId = new Map<string, EventLogEntry[]>();
	for (const entry of entries) {
		const { type } = entry.event;
		const id = entry.event.toolCallId;
		if ((type === "tool_call" || type === "tool_result") && id) {
			let group = toolEventsByCallId.get(id);
			if (!group) {
				group = [];
				toolEventsByCallId.set(id, group);
			}
			group.push(entry);
		}
	}

	// Track which toolCallIds have a terminal status (completed / failed)
	const terminalIds = new Set<string>();
	for (const [id, events] of toolEventsByCallId) {
		const hasTerminal = events.some(
			(e) =>
				e.event.type === "tool_call" &&
				(e.event.status === "completed" || e.event.status === "failed"),
		);
		if (hasTerminal) terminalIds.add(id);
	}

	// ── Pass 2: build display list ───────────────────────────────────
	const items: UnifiedDisplayItem[] = [];
	let streamGroup: EventLogEntry[] = [];
	let streamChars = 0;
	let thinkingGroup: EventLogEntry[] = [];
	let thinkingChars = 0;
	const emittedToolIds = new Set<string>();

	function flushStreams(live: boolean) {
		if (streamGroup.length > 0) {
			items.push({
				kind: "stream-group",
				entries: streamGroup,
				totalChars: streamChars,
				isLive: live,
			});
			streamGroup = [];
			streamChars = 0;
		}
	}

	function flushThinking(live: boolean) {
		if (thinkingGroup.length > 0) {
			items.push({
				kind: "thinking-group",
				entries: thinkingGroup,
				totalChars: thinkingChars,
				isLive: live,
			});
			thinkingGroup = [];
			thinkingChars = 0;
		}
	}

	for (const entry of entries) {
		const { type } = entry.event;
		const isToolEvent = type === "tool_call" || type === "tool_result";
		const eventToolCallId = entry.event.toolCallId;

		if (isToolEvent && eventToolCallId) {
			// Already emitted this toolCallId's group? Skip.
			if (emittedToolIds.has(eventToolCallId)) continue;

			// First occurrence — emit the full group from pass-1 data
			flushStreams(false);
			flushThinking(false);
			emittedToolIds.add(eventToolCallId);
			const groupEntries = toolEventsByCallId.get(eventToolCallId) ?? [entry];
			const isLive = isStreaming && !terminalIds.has(eventToolCallId);
			items.push({
				kind: "tool-call-group",
				toolCallId: eventToolCallId,
				entries: groupEntries,
				isLive,
			});
		} else if (isToolEvent) {
			// Tool event without toolCallId — standalone event
			flushStreams(false);
			flushThinking(false);
			items.push({ kind: "event", entry });
		} else if (type === "stream") {
			flushThinking(false);
			streamGroup.push(entry);
			streamChars += (entry.event.delta ?? "").length;
		} else if (type === "thinking") {
			flushStreams(false);
			thinkingGroup.push(entry);
			thinkingChars += (entry.event.text ?? "").length;
		} else {
			flushStreams(false);
			flushThinking(false);
			items.push({ kind: "event", entry });
		}
	}
	// Trailing groups: live if the task is still streaming
	flushStreams(isStreaming);
	flushThinking(isStreaming);
	return items;
}
