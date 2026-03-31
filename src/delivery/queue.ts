import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DeliveryEntry, DeliveryQueue, DeliveryQueueOptions } from "./types.js";

const DEFAULT_MAX_RETRIES = 5;
const DEFAULT_BACKOFF_BASE_MS = 5_000;

/**
 * File-backed delivery queue — one JSON file per entry.
 *
 * Storage layout:
 *   <baseDir>/delivery-queue/<id>.json        — pending entry
 *   <baseDir>/delivery-queue/<id>.delivered    — transient ack marker (cleaned on recovery)
 *
 * Write-ahead: entries are persisted to disk *before* the enqueue promise
 * resolves, so a crash after enqueue but before delivery is recoverable.
 *
 * Ack uses two-phase atomic cleanup: rename `.json → .delivered`, then
 * `unlink(.delivered)`.  If the process crashes between phases, `recover()`
 * cleans up the orphaned marker on next startup.
 */
export class FileDeliveryQueue<T = unknown> implements DeliveryQueue<T> {
	private readonly dir: string;
	private readonly maxRetries: number;
	private readonly backoffBaseMs: number;

	constructor(baseDir: string, options?: DeliveryQueueOptions) {
		this.dir = join(baseDir, "delivery-queue");
		this.maxRetries = options?.maxRetries ?? DEFAULT_MAX_RETRIES;
		this.backoffBaseMs = options?.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
	}

	async enqueue(id: string, payload: T): Promise<DeliveryEntry<T>> {
		await mkdir(this.dir, { recursive: true });

		const entry: DeliveryEntry<T> = {
			id,
			payload,
			status: "pending",
			attempts: 0,
			createdAt: new Date().toISOString(),
		};

		// Atomic write: temp file → rename
		const target = join(this.dir, `${id}.json`);
		const tmp = `${target}.tmp`;
		await writeFile(tmp, JSON.stringify(entry), "utf-8");
		await rename(tmp, target);

		return entry;
	}

	async ack(id: string): Promise<void> {
		const source = join(this.dir, `${id}.json`);
		const marker = join(this.dir, `${id}.delivered`);

		// Phase 1: rename to .delivered (atomic — entry is no longer "pending")
		try {
			await rename(source, marker);
		} catch {
			// Already acked or missing — idempotent
			return;
		}

		// Phase 2: remove the marker
		try {
			await unlink(marker);
		} catch {
			// Orphaned marker will be cleaned by recover()
		}
	}

	async fail(id: string, error: string): Promise<void> {
		const filePath = join(this.dir, `${id}.json`);
		let entry: DeliveryEntry<T>;

		try {
			const raw = await readFile(filePath, "utf-8");
			entry = JSON.parse(raw) as DeliveryEntry<T>;
		} catch {
			// Entry already acked or missing
			return;
		}

		entry.attempts += 1;
		entry.lastAttempt = new Date().toISOString();
		entry.lastError = error;

		if (entry.attempts >= this.maxRetries) {
			entry.status = "failed";
		}

		// Atomic update
		const tmp = `${filePath}.tmp`;
		await writeFile(tmp, JSON.stringify(entry), "utf-8");
		await rename(tmp, filePath);
	}

	async recover(): Promise<DeliveryEntry<T>[]> {
		let files: string[];
		try {
			files = await readdir(this.dir);
		} catch {
			return [];
		}

		// Clean up orphaned .delivered markers (crash between ack phases)
		for (const file of files) {
			if (file.endsWith(".delivered")) {
				try {
					await unlink(join(this.dir, file));
				} catch {
					// Already removed
				}
			}
		}

		// Reload pending entries
		const entries: DeliveryEntry<T>[] = [];
		for (const file of files) {
			if (!file.endsWith(".json")) continue;
			try {
				const raw = await readFile(join(this.dir, file), "utf-8");
				const entry = JSON.parse(raw) as DeliveryEntry<T>;
				if (entry.status === "pending") {
					entries.push(entry);
				}
			} catch {
				// Skip corrupted files
			}
		}

		return entries.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
	}

	retryDelay(entry: DeliveryEntry<T>): number {
		if (entry.attempts <= 0) return 0;
		return this.backoffBaseMs * 5 ** (entry.attempts - 1);
	}
}
