import { randomUUID } from "node:crypto";
import type { DrMClawConfig } from "../config/schema.js";
import { isCliProvider } from "../config/schema.js";
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

	constructor(
		private readonly config: DrMClawConfig,
		private readonly runtime: AgentRuntime,
		private readonly skills: SkillEntry[],
	) {
		this.queue = new TaskQueue(config.server.maxConcurrent);
		this.maxHistory = config.taskHistory.maxEntries;
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

		try {
			result = await this.executeTask(request, options?.sessionId, options?.onEvent);
		} catch (error) {
			result = {
				status: "error",
				output: "",
				error: error instanceof Error ? error.message : String(error),
				durationMs: Date.now() - startedAt,
			};
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

		if (backend === "acp") {
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
