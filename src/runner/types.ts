/** Status of a completed task. */
export type TaskStatus = "completed" | "error" | "max_steps_reached";

/** Structured result returned by a task run. */
export interface TaskResult {
	status: TaskStatus;
	output: string;
	error?: string;
	durationMs: number;
	skillUsed?: string;
}

/** Lifecycle event types emitted during task execution. */
export type LifecycleEvent =
	| { type: "lifecycle"; phase: "start"; taskId: string }
	| { type: "lifecycle"; phase: "end"; taskId: string; result: TaskResult }
	| { type: "lifecycle"; phase: "error"; taskId: string; error: string };

/** A queued task request. */
export interface TaskRequest {
	id: string;
	prompt: string;
	userId?: string;
	workingDir?: string;
	createdAt: number;
}

/** Stored task result with metadata. */
export interface TaskRecord {
	id: string;
	prompt: string;
	result: TaskResult;
	startedAt: number;
	completedAt: number;
}
