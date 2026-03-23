import { Cron } from "croner";
import type { CronJob } from "./types.js";

type TimerCallback = (job: CronJob) => void;

/**
 * Timer event loop — computes next due job and uses setTimeout to wake.
 *
 * Each job gets its own croner instance for timezone-aware scheduling.
 */
export class TimerLoop {
	private timers = new Map<string, Cron>();

	/** Schedule a job. When the cron fires, callback is invoked. */
	schedule(job: CronJob, callback: TimerCallback): void {
		this.cancel(job.id);

		if (!job.enabled) return;

		const cronInstance = new Cron(
			job.schedule,
			{
				timezone: job.timezone,
			},
			() => {
				callback(job);
			},
		);

		this.timers.set(job.id, cronInstance);
	}

	/** Cancel a scheduled job timer. */
	cancel(id: string): void {
		const existing = this.timers.get(id);
		if (existing) {
			existing.stop();
			this.timers.delete(id);
		}
	}

	/** Get the next run date for a job. */
	getNextRun(id: string): Date | null {
		const cron = this.timers.get(id);
		return cron?.nextRun() ?? null;
	}

	/** Stop all timers. */
	stopAll(): void {
		for (const cron of this.timers.values()) {
			cron.stop();
		}
		this.timers.clear();
	}
}
