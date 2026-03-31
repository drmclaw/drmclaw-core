import { describe, expect, it } from "vitest";
import { TaskQueue } from "../src/runner/queue.js";
import type { TaskRequest } from "../src/runner/types.js";

function makeRequest(id = "t-1"): TaskRequest {
	return { id, prompt: "test", createdAt: Date.now() };
}

describe("TaskQueue", () => {
	it("allows tasks up to maxConcurrent without queuing", async () => {
		const q = new TaskQueue(2, 10);
		await q.enqueue(makeRequest("a"));
		await q.enqueue(makeRequest("b"));
		expect(q.activeCount).toBe(2);
		expect(q.pendingCount).toBe(0);
	});

	it("queues tasks beyond maxConcurrent", async () => {
		const q = new TaskQueue(1, 10);
		await q.enqueue(makeRequest("a"));

		// Second enqueue should block — start it but don't await
		let resolved = false;
		const p = q.enqueue(makeRequest("b")).then(() => {
			resolved = true;
		});

		// Let microtasks run
		await new Promise((r) => setTimeout(r, 10));
		expect(resolved).toBe(false);
		expect(q.pendingCount).toBe(1);

		// Release one → queued task proceeds
		q.release();
		await p;
		expect(resolved).toBe(true);
	});

	it("rejects enqueue when queue is full", async () => {
		const q = new TaskQueue(1, 2);
		// Fill the running slot
		await q.enqueue(makeRequest("a"));

		// Fill the queue (2 pending slots)
		const p1 = q.enqueue(makeRequest("b"));
		const p2 = q.enqueue(makeRequest("c"));
		expect(q.pendingCount).toBe(2);

		// Third pending → overflow
		await expect(q.enqueue(makeRequest("d"))).rejects.toThrow(/queue full/i);

		// Cleanup: release all
		q.release();
		q.release();
		await p1;
		await p2;
		q.release();
	});

	it("maxQueueSize 0 means unbounded queue", async () => {
		const q = new TaskQueue(1, 0);
		await q.enqueue(makeRequest("a"));

		const promises: Promise<void>[] = [];
		for (let i = 0; i < 100; i++) {
			promises.push(q.enqueue(makeRequest(`q-${i}`)));
		}
		expect(q.pendingCount).toBe(100);

		// Cleanup
		for (let i = 0; i <= 100; i++) q.release();
		await Promise.all(promises);
	});

	describe("drain", () => {
		it("rejects new tasks after drain starts", async () => {
			const q = new TaskQueue(1, 10);
			await q.drain();
			await expect(q.enqueue(makeRequest())).rejects.toThrow(/shutting down/i);
		});

		it("waits for in-flight tasks to complete", async () => {
			const q = new TaskQueue(1, 10);
			await q.enqueue(makeRequest("a"));
			expect(q.activeCount).toBe(1);

			let drained = false;
			const drainPromise = q.drain().then(() => {
				drained = true;
			});

			await new Promise((r) => setTimeout(r, 20));
			expect(drained).toBe(false);

			q.release();
			await drainPromise;
			expect(drained).toBe(true);
			expect(q.activeCount).toBe(0);
		});

		it("resolves immediately when no tasks are running", async () => {
			const q = new TaskQueue(1, 10);
			await q.drain();
			expect(q.isDraining).toBe(true);
		});

		it("rejects pending queue items during drain", async () => {
			const q = new TaskQueue(1, 10);
			await q.enqueue(makeRequest("a"));

			// Queue a pending task
			const p = q.enqueue(makeRequest("b"));
			expect(q.pendingCount).toBe(1);

			// Drain: should reject pending and wait for running
			const drainPromise = q.drain();
			expect(q.pendingCount).toBe(0);

			// Pending task should be rejected
			await expect(p).rejects.toThrow(/shutting down/i);

			q.release(); // release the running task
			await drainPromise;
		});
	});
});
