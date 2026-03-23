/** Persisted cron job definition. */
export interface CronJob {
	id: string;
	name: string;
	enabled: boolean;
	/** Cron expression (parsed by croner). */
	schedule: string;
	/** Optional skill to invoke. */
	skillName?: string;
	/** Prompt text sent to the task runner. */
	prompt: string;
	/** IANA timezone (e.g. "America/New_York"). */
	timezone?: string;
	/** Computed next run time (ISO string). */
	nextRunAt?: string;
	/** Last run time (ISO string). */
	lastRunAt?: string;
	/** Status of the last run. */
	lastStatus?: "completed" | "error";
	/** Error message from the last failed run. */
	lastError?: string;
	/** Consecutive error count. */
	consecutiveErrors: number;
}
