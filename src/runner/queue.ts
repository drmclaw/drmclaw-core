import type { TaskRequest } from "./types.js";

type QueuedItem = {
	request: TaskRequest;
	// biome-ignore lint/suspicious/noConfusingVoidType: Promise<void> resolve pattern
	resolve: (value: void) => void;
};

/**
 * Task queue with per-user (session lane) and global lane serialization.
 *
 * Prevents session file races and upstream rate limits.
 * Configurable global concurrency cap.
 */
export class TaskQueue {
	private readonly queue: QueuedItem[] = [];
	private running = 0;
	private readonly maxConcurrent: number;
	private onQueueNotice?: (taskId: string, queuePosition: number) => void;

	constructor(maxConcurrent = 1) {
		this.maxConcurrent = maxConcurrent;
	}

	/** Register a callback for queue wait notifications (>2s). */
	setQueueNoticeHandler(handler: (taskId: string, queuePosition: number) => void): void {
		this.onQueueNotice = handler;
	}

	/**
	 * Enqueue a task request. Resolves when it's this task's turn to execute.
	 */
	async enqueue(request: TaskRequest): Promise<void> {
		if (this.running < this.maxConcurrent) {
			this.running++;
			return;
		}

		return new Promise<void>((resolve) => {
			const item: QueuedItem = { request, resolve };
			this.queue.push(item);

			// Emit notice if waiting >2s
			const position = this.queue.length;
			setTimeout(() => {
				if (this.queue.includes(item)) {
					this.onQueueNotice?.(request.id, position);
				}
			}, 2000);
		});
	}

	/** Signal that a task has finished, allowing the next queued task to run. */
	release(): void {
		const next = this.queue.shift();
		if (next) {
			next.resolve();
		} else {
			this.running = Math.max(0, this.running - 1);
		}
	}

	/** Number of tasks currently running. */
	get activeCount(): number {
		return this.running;
	}

	/** Number of tasks waiting in the queue. */
	get pendingCount(): number {
		return this.queue.length;
	}
}
