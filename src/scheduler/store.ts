import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { CronJob } from "./types.js";

const DEFAULT_STORE_PATH = ".drmclaw/jobs.json";

/**
 * Job store — persists cron jobs to a JSON file with atomic writes.
 */
export class JobStore {
	private jobs: Map<string, CronJob> = new Map();

	constructor(private readonly storePath: string = DEFAULT_STORE_PATH) {}

	/** Load jobs from disk. */
	async load(): Promise<void> {
		try {
			const raw = await readFile(this.storePath, "utf-8");
			const parsed = JSON.parse(raw) as CronJob[];
			this.jobs = new Map(parsed.map((j) => [j.id, j]));
		} catch {
			// File doesn't exist or invalid — start fresh
			this.jobs = new Map();
		}
	}

	/** Persist all jobs to disk (atomic write via temp file). */
	async save(): Promise<void> {
		const data = JSON.stringify(Array.from(this.jobs.values()), null, 2);
		await mkdir(dirname(this.storePath), { recursive: true });
		// Write to temp file then rename for atomicity
		const tmpPath = `${this.storePath}.tmp`;
		await writeFile(tmpPath, data, "utf-8");
		const { rename } = await import("node:fs/promises");
		await rename(tmpPath, this.storePath);
	}

	get(id: string): CronJob | undefined {
		return this.jobs.get(id);
	}

	getAll(): CronJob[] {
		return Array.from(this.jobs.values());
	}

	set(job: CronJob): void {
		this.jobs.set(job.id, job);
	}

	delete(id: string): boolean {
		return this.jobs.delete(id);
	}
}
