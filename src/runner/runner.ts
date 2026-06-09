import { randomUUID } from "node:crypto";
import type { DrMClawConfig } from "../config/schema.js";
import { buildExecutionRunMetadata } from "../events/store.js";
import type { ExecutionHistoryStore, PersistedRuntimeEvent } from "../events/types.js";
import type { AgentRuntime } from "../runtime/types.js";
import type { RuntimeEvent } from "../runtime/types.js";
import type { SkillEntry } from "../skills/types.js";
import { assembleSystemPrompt } from "./prompt.js";
import { TaskQueue } from "./queue.js";
import type { TaskRecord, TaskRequest, TaskResult } from "./types.js";

interface TaskRunExecutionHistoryOptions {
	store: ExecutionHistoryStore;
	kind?: "task" | "skill-action";
	skill?: string;
	action?: string;
	inputs?: Record<string, unknown>;
}

/**
 * Task Runner — orchestrates each task run.
 *
 * Receives user prompt + loaded skills → assembles system prompt →
 * selects AgentRuntime → invokes it → collects lifecycle events →
 * returns structured TaskResult.
 *
 * The runner does NOT run the tool-calling loop itself — that is the
 * AgentRuntime's responsibility.
 */
export class TaskRunner {
	private readonly queue: TaskQueue;
	private readonly history: TaskRecord[] = [];
	private readonly maxHistory: number;
	private executionHistoryStore?: ExecutionHistoryStore;

	constructor(
		private readonly config: DrMClawConfig,
		private readonly runtime: AgentRuntime,
		private readonly skills: SkillEntry[],
	) {
		this.queue = new TaskQueue(config.server.maxConcurrent, config.server.maxQueueSize);
		this.maxHistory = config.taskHistory.maxEntries;
	}

	/** Attach an execution history store for durable run persistence. */
	setExecutionHistoryStore(store: ExecutionHistoryStore): void {
		this.executionHistoryStore = store;
	}

	/** Get the attached execution history store (if any). */
	getExecutionHistoryStore(): ExecutionHistoryStore | undefined {
		return this.executionHistoryStore;
	}

	/** Set a handler for queue wait notifications (forwarded to WebSocket). */
	onQueueNotice(handler: (taskId: string, position: number) => void): void {
		this.queue.setQueueNoticeHandler(handler);
	}

	/** Stop accepting new tasks and wait for in-flight work to finish. */
	async drain(): Promise<void> {
		return this.queue.drain();
	}

	/**
	 * Run a task: enqueue → assemble prompt → invoke runtime → record result.
	 */
	async run(
		prompt: string,
		options?: {
			userId?: string;
			sessionId?: string;
			workingDir?: string;
			onEvent?: (event: RuntimeEvent) => void;
			onPersistedEvent?: (event: PersistedRuntimeEvent) => void;
			executionHistory?: TaskRunExecutionHistoryOptions;
		},
	): Promise<TaskRecord> {
		const taskId = randomUUID();
		const request: TaskRequest = {
			id: taskId,
			prompt,
			userId: options?.userId,
			workingDir: options?.workingDir,
			createdAt: Date.now(),
		};

		// Wait for our turn in the queue
		await this.queue.enqueue(request);

		const startedAt = Date.now();
		let result: TaskResult;
		let sequence = 0;
		const persistedEvents: PersistedRuntimeEvent[] = [];
		const executionHistory =
			options?.executionHistory ??
			(this.executionHistoryStore ? { store: this.executionHistoryStore, kind: "task" as const } : undefined);
		let appendQueue = Promise.resolve();

		const saveHistoryMetadata = async (metadataArgs: Parameters<typeof buildExecutionRunMetadata>[0]) => {
			if (!executionHistory) return;
			try {
				await executionHistory.store.saveMetadata(buildExecutionRunMetadata(metadataArgs));
			} catch (err) {
				console.warn(
					"[drmclaw] Failed to save execution metadata:",
					err instanceof Error ? err.message : err,
				);
			}
		};

		const persistEvent = (event: PersistedRuntimeEvent): Promise<void> => {
			persistedEvents.push(event);
			// Broadcast BEFORE disk I/O so that WebSocket delivery preserves
			// the arrival order of streaming chunks.  Without this, concurrent
			// `append()` calls race and `onPersistedEvent` fires out of order
			// (the root cause of garbled streaming text like ".53GPT--Codex").
			options?.onPersistedEvent?.(event);
			if (executionHistory) {
				appendQueue = appendQueue
					.then(() => executionHistory.store.append(taskId, event))
					.catch((err) => {
						console.warn(
							"[drmclaw] Failed to append execution event:",
							err instanceof Error ? err.message : err,
						);
					});
				return appendQueue;
			}
			return Promise.resolve();
		};

		const makeEvent = (
			source: PersistedRuntimeEvent["source"],
			event: PersistedRuntimeEvent["event"],
		): PersistedRuntimeEvent => ({
			taskId,
			sequence: sequence++,
			timestamp: new Date().toISOString(),
			source,
			event,
		});

		// Persist the user prompt so run history can reconstruct transcripts.
		await persistEvent(makeEvent("system", { type: "task_init", prompt }));
		if (executionHistory) {
			await appendQueue;
			await saveHistoryMetadata({
				taskId,
				kind: executionHistory.kind ?? "task",
				status: "running",
				provider: this.config.llm.provider,
				requestedModel: this.config.llm.model,
				requestedReasoningEffort: this.config.llm.reasoningEffort,
				workingDir: request.workingDir,
				skill: executionHistory.skill,
				action: executionHistory.action,
				inputs: executionHistory.inputs,
				processId: process.pid,
				startedAt: new Date(startedAt).toISOString(),
				events: persistedEvents,
			});
		}

		try {
			result = await this.executeTask(request, options?.sessionId, (runtimeEvent) => {
				const { source, ...eventPayload } = runtimeEvent;
				const persisted = makeEvent(source, eventPayload as PersistedRuntimeEvent["event"]);
				persistEvent(persisted).catch((err) => {
					console.error("[drmclaw] Event persist error:", err);
				});
				options?.onEvent?.(runtimeEvent);
			});
		} catch (error) {
			result = {
				status: "error",
				output: "",
				error: error instanceof Error ? error.message : String(error),
				durationMs: Date.now() - startedAt,
			};
			await persistEvent(
				makeEvent("runtime", {
					type: "lifecycle",
					phase: "error",
					error: result.error ?? "Unknown error",
				}),
			);
		} finally {
			this.queue.release();
		}

		const record: TaskRecord = {
			id: taskId,
			prompt,
			result,
			startedAt,
			completedAt: Date.now(),
		};

		if (executionHistory) {
			await appendQueue;
			await saveHistoryMetadata({
				taskId,
				kind: executionHistory.kind ?? "task",
				status: result.status === "completed" ? "completed" : "error",
				provider: this.config.llm.provider,
				requestedModel: this.config.llm.model,
				requestedReasoningEffort: this.config.llm.reasoningEffort,
				workingDir: request.workingDir,
				skill: executionHistory.skill,
				action: executionHistory.action,
				inputs: executionHistory.inputs,
				processId: process.pid,
				startedAt: new Date(startedAt).toISOString(),
				finishedAt: new Date(record.completedAt).toISOString(),
				durationMs: result.durationMs,
				output: result.output,
				error: result.error,
				events: persistedEvents,
			});
		}

		this.recordTask(record);
		return record;
	}

	/** Get recent task history. */
	getHistory(): readonly TaskRecord[] {
		return this.history;
	}

	/** Get a specific task record by ID. */
	getTask(id: string): TaskRecord | undefined {
		return this.history.find((r) => r.id === id);
	}

	private async executeTask(
		request: TaskRequest,
		sessionId?: string,
		onEvent?: (event: RuntimeEvent) => void,
	): Promise<TaskResult> {
		const systemContext = await assembleSystemPrompt(this.config, this.skills);

		return this.runtime.run({
			backend: "codex",
			prompt: request.prompt,
			systemContext,
			skills: this.skills,
			workingDir: request.workingDir,
			sessionId,
			onEvent,
		});
	}

	private recordTask(record: TaskRecord): void {
		this.history.push(record);
		// Enforce max entries (FIFO eviction)
		while (this.history.length > this.maxHistory) {
			this.history.shift();
		}
	}
}
