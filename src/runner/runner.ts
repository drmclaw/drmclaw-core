import { randomUUID } from "node:crypto";
import type { DrMClawConfig } from "../config/schema.js";
import { isCliProvider } from "../config/schema.js";
import type { EventStore, PersistedRuntimeEvent } from "../events/types.js";
import type { AgentRuntime } from "../runtime/types.js";
import type { RuntimeEvent } from "../runtime/types.js";
import type { SkillEntry } from "../skills/types.js";
import { assembleSystemPrompt } from "./prompt.js";
import { TaskQueue } from "./queue.js";
import type { TaskRecord, TaskRequest, TaskResult } from "./types.js";

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
	private eventStore?: EventStore;

	constructor(
		private readonly config: DrMClawConfig,
		private readonly runtime: AgentRuntime,
		private readonly skills: SkillEntry[],
	) {
		this.queue = new TaskQueue(config.server.maxConcurrent);
		this.maxHistory = config.taskHistory.maxEntries;
	}

	/** Attach an event store for durable event persistence. */
	setEventStore(store: EventStore): void {
		this.eventStore = store;
	}

	/** Get the attached event store (if any). */
	getEventStore(): EventStore | undefined {
		return this.eventStore;
	}

	/** Set a handler for queue wait notifications (forwarded to WebSocket). */
	onQueueNotice(handler: (taskId: string, position: number) => void): void {
		this.queue.setQueueNoticeHandler(handler);
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

		const persistEvent = async (event: PersistedRuntimeEvent): Promise<void> => {
			if (this.eventStore) {
				await this.eventStore.append(taskId, event);
			}
			options?.onPersistedEvent?.(event);
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

		// Persist the user prompt so listTasks() can reconstruct it from disk
		await persistEvent(makeEvent("system", { type: "task_init", prompt }));

		try {
			result = await this.executeTask(request, options?.sessionId, (runtimeEvent) => {
				const { source, ...eventPayload } = runtimeEvent;
				const persisted = makeEvent(source, eventPayload as PersistedRuntimeEvent["event"]);
				persistEvent(persisted);
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
		const backend = isCliProvider(this.config.llm.provider) ? "acp" : "direct";

		return this.runtime.run({
			backend,
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
