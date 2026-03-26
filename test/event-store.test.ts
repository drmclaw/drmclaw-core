import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JsonlEventStore } from "../src/events/store.js";
import type { PersistedRuntimeEvent } from "../src/events/types.js";

describe("JsonlEventStore", () => {
	let tmpDir: string;
	let store: JsonlEventStore;

	beforeEach(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "drmclaw-events-"));
		store = new JsonlEventStore(tmpDir);
	});

	afterEach(async () => {
		await rm(tmpDir, { recursive: true, force: true });
	});

	function makeEvent(
		taskId: string,
		sequence: number,
		event: PersistedRuntimeEvent["event"],
		source: PersistedRuntimeEvent["source"] = "runtime",
	): PersistedRuntimeEvent {
		return {
			taskId,
			sequence,
			timestamp: new Date().toISOString(),
			source,
			event,
		};
	}

	it("appends and replays events in order", async () => {
		const taskId = "task-001";
		const e1 = makeEvent(taskId, 0, { type: "lifecycle", phase: "start" });
		const e2 = makeEvent(taskId, 1, { type: "stream", delta: "hello" }, "acp");
		const e3 = makeEvent(taskId, 2, { type: "lifecycle", phase: "end" });

		await store.append(taskId, e1);
		await store.append(taskId, e2);
		await store.append(taskId, e3);

		const events = await store.listTaskEvents(taskId);
		expect(events).toHaveLength(3);
		expect(events[0]?.sequence).toBe(0);
		expect(events[1]?.sequence).toBe(1);
		expect(events[2]?.sequence).toBe(2);
		expect(events[0]?.event.type).toBe("lifecycle");
		expect(events[1]?.event.type).toBe("stream");
	});

	it("returns empty array for unknown task", async () => {
		const events = await store.listTaskEvents("nonexistent");
		expect(events).toEqual([]);
	});

	it("persists tool_call and tool_result events", async () => {
		const taskId = "task-002";
		const e1 = makeEvent(
			taskId,
			0,
			{ type: "tool_call", tool: "read_file", status: "in_progress" },
			"acp",
		);
		const e2 = makeEvent(
			taskId,
			1,
			{ type: "tool_result", tool: "read_file", result: "file contents" },
			"acp",
		);

		await store.append(taskId, e1);
		await store.append(taskId, e2);

		const events = await store.listTaskEvents(taskId);
		expect(events).toHaveLength(2);

		const toolCall = events[0]?.event;
		expect(toolCall).toMatchObject({ type: "tool_call", tool: "read_file", status: "in_progress" });

		const toolResult = events[1]?.event;
		expect(toolResult).toMatchObject({
			type: "tool_result",
			tool: "read_file",
			result: "file contents",
		});
	});

	it("stores events as JSONL on disk", async () => {
		const taskId = "task-003";
		await store.append(taskId, makeEvent(taskId, 0, { type: "lifecycle", phase: "start" }));
		await store.append(taskId, makeEvent(taskId, 1, { type: "stream", delta: "test" }, "acp"));

		const filePath = join(tmpDir, "events", "tasks", `${taskId}.jsonl`);
		const content = await readFile(filePath, "utf-8");
		const lines = content.trim().split("\n");
		expect(lines).toHaveLength(2);

		const parsed = JSON.parse(lines[0]!);
		expect(parsed.taskId).toBe(taskId);
		expect(parsed.sequence).toBe(0);
	});

	it("isolates events between different tasks", async () => {
		await store.append("task-a", makeEvent("task-a", 0, { type: "lifecycle", phase: "start" }));
		await store.append("task-b", makeEvent("task-b", 0, { type: "lifecycle", phase: "start" }));
		await store.append("task-a", makeEvent("task-a", 1, { type: "stream", delta: "a" }, "acp"));

		const eventsA = await store.listTaskEvents("task-a");
		const eventsB = await store.listTaskEvents("task-b");
		expect(eventsA).toHaveLength(2);
		expect(eventsB).toHaveLength(1);
	});

	it("handles error events with error field", async () => {
		const taskId = "task-err";
		const errorEvent = makeEvent(taskId, 0, {
			type: "lifecycle",
			phase: "error",
			error: "Something went wrong",
		});

		await store.append(taskId, errorEvent);
		const events = await store.listTaskEvents(taskId);
		expect(events).toHaveLength(1);

		const evt = events[0]?.event;
		if (evt?.type === "lifecycle" && "error" in evt) {
			expect(evt.error).toBe("Something went wrong");
		} else {
			throw new Error("Expected lifecycle error event");
		}
	});

	it("preserves source field for column routing", async () => {
		const taskId = "task-src";
		await store.append(
			taskId,
			makeEvent(taskId, 0, { type: "lifecycle", phase: "start" }, "runtime"),
		);
		await store.append(taskId, makeEvent(taskId, 1, { type: "stream", delta: "x" }, "acp"));
		await store.append(taskId, makeEvent(taskId, 2, { type: "lifecycle", phase: "end" }, "system"));

		const events = await store.listTaskEvents(taskId);
		expect(events[0]?.source).toBe("runtime");
		expect(events[1]?.source).toBe("acp");
		expect(events[2]?.source).toBe("system");
	});

	describe("listTasks", () => {
		it("returns tasks with prompt from task_init events", async () => {
			await store.append(
				"task-a",
				makeEvent("task-a", 0, { type: "task_init", prompt: "say hello" }, "system"),
			);
			await store.append("task-a", makeEvent("task-a", 1, { type: "lifecycle", phase: "start" }));

			await store.append(
				"task-b",
				makeEvent("task-b", 0, { type: "task_init", prompt: "say goodbye" }, "system"),
			);

			const tasks = await store.listTasks();
			expect(tasks).toHaveLength(2);
			expect(tasks.map((t) => t.id).sort()).toEqual(["task-a", "task-b"]);

			const taskA = tasks.find((t) => t.id === "task-a");
			expect(taskA?.prompt).toBe("say hello");
			expect(taskA?.startedAt).toBeDefined();
		});

		it("returns empty array when no tasks exist", async () => {
			const tasks = await store.listTasks();
			expect(tasks).toEqual([]);
		});

		it("skips legacy JSONL files without task_init first line", async () => {
			// Simulate a legacy task that starts with lifecycle instead of task_init
			await store.append(
				"legacy-task",
				makeEvent("legacy-task", 0, { type: "lifecycle", phase: "start" }),
			);

			const tasks = await store.listTasks();
			expect(tasks).toEqual([]);
		});

		it("sorts tasks by startedAt ascending", async () => {
			const earlyEvent: PersistedRuntimeEvent = {
				taskId: "task-early",
				sequence: 0,
				timestamp: "2026-01-01T00:00:00.000Z",
				source: "system",
				event: { type: "task_init", prompt: "early" },
			};
			const lateEvent: PersistedRuntimeEvent = {
				taskId: "task-late",
				sequence: 0,
				timestamp: "2026-03-01T00:00:00.000Z",
				source: "system",
				event: { type: "task_init", prompt: "late" },
			};

			await store.append("task-late", lateEvent);
			await store.append("task-early", earlyEvent);

			const tasks = await store.listTasks();
			expect(tasks[0]?.id).toBe("task-early");
			expect(tasks[1]?.id).toBe("task-late");
		});
	});
});
