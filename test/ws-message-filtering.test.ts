import { describe, expect, it } from "vitest";
import {
	gateEventMessage,
	shouldAcknowledgeResult,
} from "../ui/src/components/wsMessageFiltering.js";

// ── gateEventMessage ─────────────────────────────────────────────────

describe("gateEventMessage", () => {
	it("accepts events when no active task and adopts the event taskId", () => {
		const result = gateEventMessage(null, "task-1");
		expect(result).toEqual({ accept: true, adoptTaskId: "task-1" });
	});

	it("accepts events with a matching taskId", () => {
		const result = gateEventMessage("task-1", "task-1");
		expect(result).toEqual({ accept: true });
	});

	it("drops events with a different taskId", () => {
		const result = gateEventMessage("task-1", "task-2");
		expect(result).toEqual({ accept: false });
	});

	it("accepts events with no taskId regardless of active task", () => {
		expect(gateEventMessage("task-1", undefined)).toEqual({ accept: true });
		expect(gateEventMessage(null, undefined)).toEqual({ accept: true });
	});

	it("accepts events when active task is set and event taskId matches", () => {
		const result = gateEventMessage("abc-123", "abc-123");
		expect(result).toEqual({ accept: true });
	});

	// Simulates the handleSend flow: after clearing the active task to null,
	// the first event from the new run should be adopted.
	it("adopts a new taskId after task was cleared (send-after-replay scenario)", () => {
		// Phase 1: active task is set from a replay
		const drop = gateEventMessage("old-task", "new-task");
		expect(drop.accept).toBe(false);

		// Phase 2: handleSend clears the task to null
		const adopt = gateEventMessage(null, "new-task");
		expect(adopt).toEqual({ accept: true, adoptTaskId: "new-task" });
	});
});

// ── shouldAcknowledgeResult ──────────────────────────────────────────

describe("shouldAcknowledgeResult", () => {
	it("acknowledges when no active task (safe default)", () => {
		expect(shouldAcknowledgeResult(null, "any-task")).toBe(true);
	});

	it("acknowledges when result has no taskId (backward compat)", () => {
		expect(shouldAcknowledgeResult("task-1", undefined)).toBe(true);
	});

	it("acknowledges when result taskId matches active task", () => {
		expect(shouldAcknowledgeResult("task-1", "task-1")).toBe(true);
	});

	it("ignores cross-task result when active task is set", () => {
		expect(shouldAcknowledgeResult("task-1", "task-2")).toBe(false);
	});

	it("acknowledges when both are null/undefined", () => {
		expect(shouldAcknowledgeResult(null, undefined)).toBe(true);
	});
});

// ── Replay abort protocol ────────────────────────────────────────────
// These tests verify the AbortController coordination pattern used by
// handleSend, handleNew, and the replay-target effect.  The tests
// operate on plain AbortController instances to validate signal
// semantics without React.

describe("replay abort protocol", () => {
	it("aborting a controller signals its abort signal", () => {
		const ac = new AbortController();
		expect(ac.signal.aborted).toBe(false);
		ac.abort();
		expect(ac.signal.aborted).toBe(true);
	});

	it("aborting the ref before creating a new one cancels the old fetch", () => {
		// Simulates the replay-target effect or handleSend aborting
		// the previous in-flight replay before starting fresh.
		const ref: { current: AbortController | null } = { current: null };

		// First replay starts
		const ac1 = new AbortController();
		ref.current = ac1;

		// User sends a new message — abort the stale replay
		ref.current?.abort();
		ref.current = null;

		expect(ac1.signal.aborted).toBe(true);
		expect(ref.current).toBeNull();
	});

	it("new replay aborts the previous one and replaces the ref", () => {
		const ref: { current: AbortController | null } = { current: null };

		// First replay
		const ac1 = new AbortController();
		ref.current = ac1;

		// Second replay triggers — should cancel first
		ref.current?.abort();
		const ac2 = new AbortController();
		ref.current = ac2;

		expect(ac1.signal.aborted).toBe(true);
		expect(ac2.signal.aborted).toBe(false);
		expect(ref.current).toBe(ac2);
	});

	it("handleSend-style abort prevents a stale replay from writing state", async () => {
		// Simulate: replay fetch is in-flight, user sends, fetch resolves
		// after send — the signal.aborted guard should prevent state writes.
		const ac = new AbortController();
		const signal = ac.signal;

		// Simulate slow fetch — not yet resolved
		let staleWriteOccurred = false;
		const fakeFetch = async () => {
			// Simulates network delay
			await new Promise((r) => setTimeout(r, 10));
			// Guard identical to the one in replayTask
			if (signal.aborted) return;
			staleWriteOccurred = true;
		};

		const fetchPromise = fakeFetch();

		// User sends immediately — aborts the replay
		ac.abort();

		await fetchPromise;
		expect(staleWriteOccurred).toBe(false);
	});

	it("startup-vs-replay: explicit replay selection cancels in-flight mount fetch", async () => {
		// Simulates the race: mount effect stores its AC in the shared ref,
		// then a replay-target effect fires replayAbortRef.current?.abort()
		// before the mount fetch resolves.
		const ref: { current: AbortController | null } = { current: null };

		// Mount effect starts and registers its AC in the shared ref
		const mountAc = new AbortController();
		ref.current = mountAc;

		let mountWriteOccurred = false;
		const mountFetch = async () => {
			await new Promise((r) => setTimeout(r, 20));
			if (mountAc.signal.aborted) return;
			mountWriteOccurred = true;
		};
		const mountPromise = mountFetch();

		// User selects a task from Task History while mount is in flight
		// — replay-target effect runs and aborts the shared ref
		ref.current?.abort();
		const replayAc = new AbortController();
		ref.current = replayAc;

		let replayWriteOccurred = false;
		const replayFetch = async () => {
			await new Promise((r) => setTimeout(r, 5));
			if (replayAc.signal.aborted) return;
			replayWriteOccurred = true;
		};
		const replayPromise = replayFetch();

		// Both resolve
		await Promise.all([mountPromise, replayPromise]);

		// Mount's stale response was discarded; replay's response landed
		expect(mountWriteOccurred).toBe(false);
		expect(replayWriteOccurred).toBe(true);
		expect(mountAc.signal.aborted).toBe(true);
		expect(replayAc.signal.aborted).toBe(false);
	});

	it("mount cleanup clears shared ref only if still its own controller", () => {
		// Simulates: mount stores AC in ref, replay replaces it,
		// then mount cleanup runs — should NOT clear the replay's AC.
		const ref: { current: AbortController | null } = { current: null };

		const mountAc = new AbortController();
		ref.current = mountAc;

		// Replay effect replaces the ref
		ref.current?.abort();
		const replayAc = new AbortController();
		ref.current = replayAc;

		// Mount cleanup — should not clear the ref since it's no longer ours
		mountAc.abort();
		if (ref.current === mountAc) {
			ref.current = null;
		}

		// Replay's controller should still be in the ref
		expect(ref.current).toBe(replayAc);
		expect(replayAc.signal.aborted).toBe(false);
	});
});
