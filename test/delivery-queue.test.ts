import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileDeliveryQueue } from "../src/delivery/queue.js";
import type { DeliveryEntry } from "../src/delivery/types.js";

describe("FileDeliveryQueue", () => {
	let tmpDir: string;
	let queue: FileDeliveryQueue<{ message: string }>;

	beforeEach(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "drmclaw-delivery-"));
		queue = new FileDeliveryQueue(tmpDir);
	});

	afterEach(async () => {
		await rm(tmpDir, { recursive: true, force: true });
	});

	// ── Write-ahead enqueue ────────────────────────────────────────

	it("enqueues an entry and persists it to disk", async () => {
		const entry = await queue.enqueue("d-1", { message: "hello" });

		expect(entry.id).toBe("d-1");
		expect(entry.status).toBe("pending");
		expect(entry.attempts).toBe(0);
		expect(entry.payload).toEqual({ message: "hello" });
		expect(entry.createdAt).toBeTruthy();

		// Verify file on disk
		const raw = await readFile(join(tmpDir, "delivery-queue", "d-1.json"), "utf-8");
		const persisted = JSON.parse(raw) as DeliveryEntry;
		expect(persisted.id).toBe("d-1");
		expect(persisted.status).toBe("pending");
	});

	it("atomic write does not leave .tmp files", async () => {
		await queue.enqueue("d-2", { message: "test" });
		const files = await readdir(join(tmpDir, "delivery-queue"));
		expect(files).toEqual(["d-2.json"]);
		expect(files.some((f) => f.endsWith(".tmp"))).toBe(false);
	});

	// ── Ack (two-phase) ────────────────────────────────────────────

	it("ack removes the entry from disk", async () => {
		await queue.enqueue("d-3", { message: "ack me" });
		await queue.ack("d-3");

		const files = await readdir(join(tmpDir, "delivery-queue"));
		expect(files).toHaveLength(0);
	});

	it("ack is idempotent — double ack does not throw", async () => {
		await queue.enqueue("d-4", { message: "double ack" });
		await queue.ack("d-4");
		await expect(queue.ack("d-4")).resolves.toBeUndefined();
	});

	it("ack on non-existent entry does not throw", async () => {
		await expect(queue.ack("no-such-id")).resolves.toBeUndefined();
	});

	// ── Fail ───────────────────────────────────────────────────────

	it("fail increments attempt count and records error", async () => {
		await queue.enqueue("d-5", { message: "fail me" });
		await queue.fail("d-5", "network timeout");

		const raw = await readFile(join(tmpDir, "delivery-queue", "d-5.json"), "utf-8");
		const entry = JSON.parse(raw) as DeliveryEntry;
		expect(entry.attempts).toBe(1);
		expect(entry.status).toBe("pending");
		expect(entry.lastError).toBe("network timeout");
		expect(entry.lastAttempt).toBeTruthy();
	});

	it("fail marks entry as 'failed' after max retries", async () => {
		const q = new FileDeliveryQueue<{ message: string }>(tmpDir, { maxRetries: 2 });
		await q.enqueue("d-6", { message: "exhaust retries" });
		await q.fail("d-6", "attempt 1");
		await q.fail("d-6", "attempt 2");

		const raw = await readFile(join(tmpDir, "delivery-queue", "d-6.json"), "utf-8");
		const entry = JSON.parse(raw) as DeliveryEntry;
		expect(entry.attempts).toBe(2);
		expect(entry.status).toBe("failed");
		expect(entry.lastError).toBe("attempt 2");
	});

	it("fail on non-existent entry does not throw", async () => {
		await expect(queue.fail("no-such-id", "oops")).resolves.toBeUndefined();
	});

	// ── Recovery ───────────────────────────────────────────────────

	it("recover returns pending entries sorted by createdAt", async () => {
		// Enqueue with a small delay to ensure distinct timestamps
		await queue.enqueue("d-a", { message: "first" });
		await queue.enqueue("d-b", { message: "second" });
		await queue.enqueue("d-c", { message: "third" });

		// Ack one
		await queue.ack("d-b");

		const recovered = await queue.recover();
		expect(recovered).toHaveLength(2);
		expect(recovered[0]?.id).toBe("d-a");
		expect(recovered[1]?.id).toBe("d-c");
	});

	it("recover excludes permanently failed entries", async () => {
		const q = new FileDeliveryQueue<{ message: string }>(tmpDir, { maxRetries: 1 });
		await q.enqueue("d-7", { message: "will fail" });
		await q.fail("d-7", "fatal");

		const recovered = await q.recover();
		expect(recovered).toHaveLength(0);
	});

	it("recover cleans up orphaned .delivered markers", async () => {
		await queue.enqueue("d-8", { message: "orphan" });

		// Simulate crash between ack phases: rename to .delivered but don't unlink
		const queueDir = join(tmpDir, "delivery-queue");
		await rename(join(queueDir, "d-8.json"), join(queueDir, "d-8.delivered"));

		const recovered = await queue.recover();
		expect(recovered).toHaveLength(0);

		// Marker should be cleaned up
		const files = await readdir(queueDir);
		expect(files).toHaveLength(0);
	});

	it("recover returns empty array when queue directory does not exist", async () => {
		const q = new FileDeliveryQueue(join(tmpDir, "nonexistent"));
		const recovered = await q.recover();
		expect(recovered).toEqual([]);
	});

	it("recover skips corrupted JSON files", async () => {
		await queue.enqueue("d-good", { message: "valid" });

		// Write a corrupted file
		const queueDir = join(tmpDir, "delivery-queue");
		await writeFile(join(queueDir, "d-bad.json"), "not json{{{", "utf-8");

		const recovered = await queue.recover();
		expect(recovered).toHaveLength(1);
		expect(recovered[0]?.id).toBe("d-good");
	});

	// ── Retry delay (exponential backoff) ──────────────────────────

	it("retryDelay computes exponential backoff based on attempts", () => {
		const entry: DeliveryEntry<{ message: string }> = {
			id: "d-9",
			payload: { message: "test" },
			status: "pending",
			attempts: 0,
			createdAt: new Date().toISOString(),
		};

		// 0 attempts → no delay
		expect(queue.retryDelay(entry)).toBe(0);

		// 1 attempt → 5000ms (5000 * 5^0)
		entry.attempts = 1;
		expect(queue.retryDelay(entry)).toBe(5_000);

		// 2 attempts → 25000ms (5000 * 5^1)
		entry.attempts = 2;
		expect(queue.retryDelay(entry)).toBe(25_000);

		// 3 attempts → 125000ms (5000 * 5^2)
		entry.attempts = 3;
		expect(queue.retryDelay(entry)).toBe(125_000);
	});

	it("retryDelay respects custom backoffBaseMs", () => {
		const q = new FileDeliveryQueue<{ message: string }>(tmpDir, { backoffBaseMs: 1000 });
		const entry: DeliveryEntry<{ message: string }> = {
			id: "d-10",
			payload: { message: "test" },
			status: "pending",
			attempts: 2,
			createdAt: new Date().toISOString(),
		};

		// 2 attempts, base=1000 → 5000ms (1000 * 5^1)
		expect(q.retryDelay(entry)).toBe(5_000);
	});

	// ── Concurrent operations ──────────────────────────────────────

	it("handles concurrent enqueue calls without corruption", async () => {
		const ids = Array.from({ length: 10 }, (_, i) => `concurrent-${i}`);
		await Promise.all(ids.map((id) => queue.enqueue(id, { message: id })));

		const recovered = await queue.recover();
		expect(recovered).toHaveLength(10);

		const recoveredIds = recovered.map((e) => e.id).sort();
		expect(recoveredIds).toEqual(ids.sort());
	});

	it("handles concurrent enqueue + ack without deadlock", async () => {
		await queue.enqueue("race-1", { message: "a" });
		await queue.enqueue("race-2", { message: "b" });

		// Ack race-1 while enqueuing race-3 concurrently
		await Promise.all([queue.ack("race-1"), queue.enqueue("race-3", { message: "c" })]);

		const recovered = await queue.recover();
		const ids = recovered.map((e) => e.id).sort();
		expect(ids).toEqual(["race-2", "race-3"]);
	});

	// ── Full lifecycle ─────────────────────────────────────────────

	it("full lifecycle: enqueue → fail → fail → ack", async () => {
		await queue.enqueue("lifecycle-1", { message: "deliver this" });

		// First failure
		await queue.fail("lifecycle-1", "connection refused");
		let raw = await readFile(join(tmpDir, "delivery-queue", "lifecycle-1.json"), "utf-8");
		let entry = JSON.parse(raw) as DeliveryEntry;
		expect(entry.attempts).toBe(1);
		expect(entry.status).toBe("pending");

		// Second failure
		await queue.fail("lifecycle-1", "timeout");
		raw = await readFile(join(tmpDir, "delivery-queue", "lifecycle-1.json"), "utf-8");
		entry = JSON.parse(raw) as DeliveryEntry;
		expect(entry.attempts).toBe(2);
		expect(entry.status).toBe("pending");

		// Successful delivery
		await queue.ack("lifecycle-1");
		const files = await readdir(join(tmpDir, "delivery-queue"));
		expect(files).toHaveLength(0);
	});
});
