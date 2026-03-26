import { randomUUID } from "node:crypto";
import type { TaskRunner } from "../runner/runner.js";
import { JobStore } from "./store.js";
import { TimerLoop } from "./timer.js";
import type { CronJob } from "./types.js";

/**
 * CronService — manages scheduled jobs.
 *
 * Uses a JSON file store for persistence and croner for timezone-aware
 * cron scheduling. Executes jobs through the TaskRunner.
 */
export class CronService {
	private readonly store: JobStore;
	private readonly timers: TimerLoop;
	private runner: TaskRunner | null = null;

	constructor(storePath: string) {
		this.store = new JobStore(storePath);
		this.timers = new TimerLoop();
	}

	/** Wire the task runner (called during app bootstrap). */
	setRunner(runner: TaskRunner): void {
		this.runner = runner;
	}

	/** Initialize: load jobs from disk and schedule all enabled jobs. */
	async initialize(): Promise<void> {
		await this.store.load();
		for (const job of this.store.getAll()) {
			if (job.enabled) {
				this.scheduleJob(job);
			}
		}
	}

	/** Add a new job. */
	async addJob(
		params: Omit<
			CronJob,
			"id" | "consecutiveErrors" | "nextRunAt" | "lastRunAt" | "lastStatus" | "lastError"
		>,
	): Promise<CronJob> {
		const job: CronJob = {
			...params,
			id: randomUUID(),
			consecutiveErrors: 0,
		};
		this.store.set(job);
		await this.store.save();

		if (job.enabled) {
			this.scheduleJob(job);
		}
		return job;
	}

	/** Update an existing job. */
	async updateJob(id: string, updates: Partial<Omit<CronJob, "id">>): Promise<CronJob | null> {
		const existing = this.store.get(id);
		if (!existing) return null;

		const updated = { ...existing, ...updates };
		this.store.set(updated);
		await this.store.save();

		// Reschedule
		this.timers.cancel(id);
		if (updated.enabled) {
			this.scheduleJob(updated);
		}
		return updated;
	}

	/** Remove a job. */
	async removeJob(id: string): Promise<boolean> {
		this.timers.cancel(id);
		const deleted = this.store.delete(id);
		if (deleted) {
			await this.store.save();
		}
		return deleted;
	}

	/** List all jobs. */
	listJobs(): CronJob[] {
		return this.store.getAll().map((job) => ({
			...job,
			nextRunAt: this.timers.getNextRun(job.id)?.toISOString(),
		}));
	}

	/** Trigger a job immediately (out of schedule). */
	async runNow(id: string): Promise<void> {
		const job = this.store.get(id);
		if (!job) throw new Error(`Job not found: ${id}`);
		await this.executeJob(job);
	}

	/** Stop all timers. */
	shutdown(): void {
		this.timers.stopAll();
	}

	private scheduleJob(job: CronJob): void {
		this.timers.schedule(job, (j) => {
			void this.executeJob(j);
		});
	}

	private async executeJob(job: CronJob): Promise<void> {
		if (!this.runner) {
			console.error(`[CronService] No runner set — cannot execute job ${job.id}`);
			return;
		}

		try {
			const record = await this.runner.run(job.prompt);
			job.lastRunAt = new Date().toISOString();
			job.lastStatus = record.result.status === "error" ? "error" : "completed";
			job.lastError = record.result.error;
			job.consecutiveErrors = job.lastStatus === "error" ? job.consecutiveErrors + 1 : 0;
		} catch (error) {
			job.lastRunAt = new Date().toISOString();
			job.lastStatus = "error";
			job.lastError = error instanceof Error ? error.message : String(error);
			job.consecutiveErrors += 1;
		}

		this.store.set(job);
		await this.store.save();
	}
}
