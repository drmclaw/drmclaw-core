/**
 * Pure functions for filtering WebSocket messages by task ID.
 *
 * Extracted from DebugConsole.tsx so the task-ID gating logic
 * can be unit-tested without React or DOM dependencies.
 */

export interface TaskIdGateResult {
	/** Whether this message should be processed (true) or dropped (false). */
	accept: boolean;
	/** When set, the consumer should adopt this as the new active task ID. */
	adoptTaskId?: string;
}

/**
 * Decide whether an incoming WS event message should be accepted or
 * dropped based on the current active task ID.
 *
 * Rules:
 * - If no active task (`activeTaskId === null`), accept the event and
 *   adopt its taskId (if present) as the new active task.
 * - If the event has a taskId that differs from the active one, drop it.
 * - Otherwise (matching taskId or no taskId on the event), accept.
 */
export function gateEventMessage(
	activeTaskId: string | null,
	eventTaskId: string | undefined,
): TaskIdGateResult {
	if (activeTaskId !== null && eventTaskId && eventTaskId !== activeTaskId) {
		return { accept: false };
	}
	if (activeTaskId === null && eventTaskId) {
		return { accept: true, adoptTaskId: eventTaskId };
	}
	return { accept: true };
}

/**
 * Decide whether a WS result message should mark the current stream as
 * finished.  Cross-task completions are ignored when the console knows
 * which task it is tracking.
 *
 * Rules:
 * - If activeTaskId is null (no task locked yet), acknowledge — safe default.
 * - If the result has no taskId, acknowledge — backward compat.
 * - If the result's taskId matches the active one, acknowledge.
 * - Otherwise, ignore the result.
 */
export function shouldAcknowledgeResult(
	activeTaskId: string | null,
	resultTaskId: string | undefined,
): boolean {
	if (!activeTaskId || !resultTaskId || resultTaskId === activeTaskId) {
		return true;
	}
	return false;
}
