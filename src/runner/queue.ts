import type { TaskRequest } from "./types.js";

type QueuedItem = {
	request: TaskRequest;
	// biome-ignore lint/suspicious/noConfusingVoidType: Promise<void> resolve pattern
	resolve: (value: void) => void;
	reject: (reason: Error) => void;
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
	private readonly maxQueueSize: number;
	private draining = false;
	private onQueueNotice?: (taskId: string, queuePosition: number) => void;

	constructor(maxConcurrent = 1, maxQueueSize = 50) {
		this.maxConcurrent = maxConcurrent;
		this.maxQueueSize = maxQueueSize;
	}

	/** Register a callback for queue wait notifications (>2s). */
	setQueueNoticeHandler(handler: (taskId: string, queuePosition: number) => void): void {
		this.onQueueNotice = handler;
	}

	/**
	 * Enqueue a task request. Resolves when it's this task's turn to execute.
	 * Rejects immediately if the queue is draining (graceful shutdown).
	 */
	async enqueue(request: TaskRequest): Promise<void> {
		if (this.draining) {
			throw new Error("Server is shutting down — not accepting new tasks");
		}

		if (this.running < this.maxConcurrent) {
			this.running++;
			return;
		}

		if (this.maxQueueSize > 0 && this.queue.length >= this.maxQueueSize) {
			throw new Error(
				`Task queue full (${this.queue.length}/${this.maxQueueSize}) — try again later`,
			);
		}

		return new Promise<void>((resolve, reject) => {
			const item: QueuedItem = { request, resolve, reject };
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

	/** Whether the queue is draining (rejecting new tasks). */
	get isDraining(): boolean {
		return this.draining;
	}

	/**
	 * Begin draining: reject new tasks and wait for in-flight work to finish.
	 * Pending queued tasks are rejected with an error.
	 */
	async drain(): Promise<void> {
		this.draining = true;

		// Reject all pending (not yet running) items
		const drainError = new Error("Server is shutting down — not accepting new tasks");
		for (const item of this.queue.splice(0)) {
			item.reject(drainError);
		}

		// Wait for all running tasks to complete
		if (this.running > 0) {
			await new Promise<void>((resolve) => {
				const check = (): void => {
					if (this.running === 0) {
						resolve();
					} else {
						setTimeout(check, 50);
					}
				};
				check();
			});
		}
	}
}
