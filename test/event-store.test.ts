import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	ExecutionHistoryJsonlStore,
	buildExecutionRunMetadata,
	buildExecutionTimeline,
	buildExecutionTranscript,
	summarizeExecutionEvents,
} from "../src/events/store.js";
import type { ExecutionRunMetadata, PersistedRuntimeEvent } from "../src/events/types.js";

describe("ExecutionHistoryJsonlStore", () => {
	let tmpDir: string;
	let store: ExecutionHistoryJsonlStore;

	beforeEach(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "drmclaw-runs-"));
		store = new ExecutionHistoryJsonlStore(tmpDir);
	});

	afterEach(async () => {
		await rm(tmpDir, { recursive: true, force: true });
	});

	function makeEvent(
		taskId: string,
		sequence: number,
		event: PersistedRuntimeEvent["event"],
		source: PersistedRuntimeEvent["source"] = "runtime",
		timestamp = `2026-06-05T00:00:0${sequence}.000Z`,
	): PersistedRuntimeEvent {
		return {
			taskId,
			sequence,
			timestamp,
			source,
			event,
		};
	}

	function makeMetadata(
		taskId: string,
		events: PersistedRuntimeEvent[],
		overrides: Partial<ExecutionRunMetadata> = {},
	): ExecutionRunMetadata {
		return buildExecutionRunMetadata({
			taskId,
			kind: "task",
			status: "completed",
			provider: "codex-app-server",
			requestedModel: "gpt-5.5",
			requestedReasoningEffort: "high",
			workingDir: "/tmp/project",
			startedAt: "2026-06-05T00:00:00.000Z",
			finishedAt: "2026-06-05T00:00:10.000Z",
			durationMs: 10_000,
			output: "done",
			events,
			...overrides,
		});
	}

	it("appends events under runs/<taskId>/events.jsonl and replays in order", async () => {
		const taskId = "task-001";
		const e1 = makeEvent(taskId, 0, { type: "lifecycle", phase: "start" });
		const e2 = makeEvent(taskId, 1, { type: "stream", delta: "hello" }, "codex");

		await store.append(taskId, e1);
		await store.append(taskId, e2);

		const filePath = join(tmpDir, "runs", taskId, "events.jsonl");
		const content = await readFile(filePath, "utf-8");
		expect(content.trim().split("\n")).toHaveLength(2);

		const events = await store.listRunEvents(taskId);
		expect(events.map((event) => event.sequence)).toEqual([0, 1]);
		expect(events[1]?.event).toMatchObject({ type: "stream", delta: "hello" });
	});

	it("saves metadata and reads full run detail", async () => {
		const taskId = "task-002";
		const events = [
			makeEvent(taskId, 0, { type: "task_init", prompt: "say hello" }, "system"),
			makeEvent(taskId, 1, { type: "stream", delta: "hello" }, "codex"),
		];
		for (const event of events) await store.append(taskId, event);
		await store.saveMetadata(makeMetadata(taskId, events));

		const run = await store.readRun(taskId);
		expect(run?.metadata).toMatchObject({
			taskId,
			provider: "codex-app-server",
			requestedModel: "gpt-5.5",
			requestedReasoningEffort: "high",
			promptPreview: "say hello",
			outputPreview: "done",
		});
		expect(run?.transcript).toEqual([
			{ role: "user", timestamp: events[0]?.timestamp, content: "say hello" },
			{ role: "assistant", timestamp: events[1]?.timestamp, content: "hello" },
		]);
	});

	it("lists finalized runs newest first and respects limit", async () => {
		const early = "task-early";
		const late = "task-late";
		await store.saveMetadata(
			makeMetadata(early, [], {
				taskId: early,
				startedAt: "2026-06-05T00:00:00.000Z",
				finishedAt: "2026-06-05T00:00:01.000Z",
			}),
		);
		await store.saveMetadata(
			makeMetadata(late, [], {
				taskId: late,
				startedAt: "2026-06-05T00:01:00.000Z",
				finishedAt: "2026-06-05T00:01:01.000Z",
			}),
		);

		const runs = await store.listRuns();
		expect(runs.map((run) => run.taskId)).toEqual([late, early]);
		expect((await store.listRuns({ limit: 1 })).map((run) => run.taskId)).toEqual([late]);
	});

	it("returns null for missing runs and rejects unsafe ids", async () => {
		expect(await store.readRun("missing")).toBeNull();
		await expect(store.readRun("../escape")).rejects.toThrow("invalid task id");
	});

	it("skips malformed event lines while reading", async () => {
		const taskId = "task-malformed";
		const runDir = join(tmpDir, "runs", taskId);
		await writeFile(join(runDir, "events.jsonl"), "", "utf-8").catch(async () => {
			await store.append(taskId, makeEvent(taskId, 0, { type: "stream", delta: "ok" }, "codex"));
		});
		await writeFile(
			join(runDir, "events.jsonl"),
			`${JSON.stringify(makeEvent(taskId, 0, { type: "stream", delta: "ok" }, "codex"))}\nnot-json\n`,
			"utf-8",
		);

		const events = await store.listRunEvents(taskId);
		expect(events).toHaveLength(1);
		expect(events[0]?.event).toMatchObject({ type: "stream", delta: "ok" });
	});
});

describe("execution event helpers", () => {
	it("builds transcript and summarizes tool activity", () => {
		const taskId = "task-summary";
		const events: PersistedRuntimeEvent[] = [
			{
				taskId,
				sequence: 0,
				timestamp: "2026-06-05T00:00:00.000Z",
				source: "system",
				event: { type: "task_init", prompt: "prompt" },
			},
			{
				taskId,
				sequence: 1,
				timestamp: "2026-06-05T00:00:01.000Z",
				source: "codex",
				event: { type: "thinking", text: "reason" },
			},
			{
				taskId,
				sequence: 2,
				timestamp: "2026-06-05T00:00:02.000Z",
				source: "codex",
				event: { type: "stream", delta: "answer " },
			},
			{
				taskId,
				sequence: 3,
				timestamp: "2026-06-05T00:00:03.000Z",
				source: "codex",
				event: { type: "stream", delta: "text" },
			},
			{
				taskId,
				sequence: 4,
				timestamp: "2026-06-05T00:00:04.000Z",
				source: "codex",
				event: {
					type: "tool_call",
					tool: "shell",
					status: "inProgress",
					toolCallId: "call-1",
					kind: "commandExecution",
					args: { command: "echo ok", cwd: "/tmp/project" },
				},
			},
			{
				taskId,
				sequence: 5,
				timestamp: "2026-06-05T00:00:05.000Z",
				source: "codex",
				event: {
					type: "tool_call",
					tool: "shell",
					status: "completed",
					toolCallId: "call-1",
				},
			},
			{
				taskId,
				sequence: 6,
				timestamp: "2026-06-05T00:00:06.000Z",
				source: "codex",
				event: {
					type: "tool_result",
					tool: "shell",
					result: { output: "ok\n" },
					toolCallId: "call-1",
				},
			},
			{
				taskId,
				sequence: 7,
				timestamp: "2026-06-05T00:00:07.000Z",
				source: "codex",
				event: { type: "usage", used: 10, size: 100 },
			},
		];

		expect(buildExecutionTranscript(events)).toEqual([
			{ role: "user", timestamp: "2026-06-05T00:00:00.000Z", content: "prompt" },
			{ role: "assistant", timestamp: "2026-06-05T00:00:02.000Z", content: "answer text" },
		]);

		const summary = summarizeExecutionEvents(events);
		expect(summary.eventCounts).toMatchObject({
			task_init: 1,
			thinking: 1,
			stream: 2,
			tool_call: 2,
			tool_result: 1,
			usage: 1,
		});
		expect(summary.toolActivity).toMatchObject({
			totalCalls: 1,
			uniqueTools: 1,
			tools: [
				{
					name: "shell",
					callsStarted: 1,
					callsCompleted: 1,
					successCount: 1,
					failureCount: 0,
				},
			],
		});
	});

	it("builds a grouped execution timeline without expanding stream deltas", () => {
		const taskId = "task-timeline";
		const events: PersistedRuntimeEvent[] = [
			{
				taskId,
				sequence: 0,
				timestamp: "2026-06-05T00:00:00.000Z",
				source: "system",
				event: { type: "task_init", prompt: "prompt" },
			},
			{
				taskId,
				sequence: 1,
				timestamp: "2026-06-05T00:00:01.000Z",
				source: "runtime",
				event: { type: "lifecycle", phase: "start" },
			},
			{
				taskId,
				sequence: 2,
				timestamp: "2026-06-05T00:00:02.000Z",
				source: "codex",
				event: { type: "stream", delta: "Checking" },
			},
			{
				taskId,
				sequence: 3,
				timestamp: "2026-06-05T00:00:03.000Z",
				source: "codex",
				event: { type: "stream", delta: " files." },
			},
			{
				taskId,
				sequence: 4,
				timestamp: "2026-06-05T00:00:04.000Z",
				source: "codex",
				event: { type: "thinking", text: "Need inspect status." },
			},
			{
				taskId,
				sequence: 5,
				timestamp: "2026-06-05T00:00:05.000Z",
				source: "codex",
				event: {
					type: "plan",
					entries: [{ content: "Run sync", priority: "normal", status: "pending" }],
				},
			},
			{
				taskId,
				sequence: 6,
				timestamp: "2026-06-05T00:00:06.000Z",
				source: "codex",
				event: {
					type: "tool_call",
					tool: "shell",
					status: "inProgress",
					kind: "commandExecution",
					args: { command: "npm test", cwd: "/tmp/project" },
					toolCallId: "call-1",
				},
			},
			{
				taskId,
				sequence: 7,
				timestamp: "2026-06-05T00:00:07.000Z",
				source: "codex",
				event: {
					type: "tool_result",
					tool: "shell",
					result: { output: "passed" },
					toolCallId: "call-1",
				},
			},
			{
				taskId,
				sequence: 8,
				timestamp: "2026-06-05T00:00:08.000Z",
				source: "codex",
				event: { type: "usage", used: 10, size: 100 },
			},
			{
				taskId,
				sequence: 9,
				timestamp: "2026-06-05T00:00:09.000Z",
				source: "runtime",
				event: { type: "lifecycle", phase: "error", error: "boom" },
			},
		];

		const timeline = buildExecutionTimeline(events);
		expect(timeline.map((item) => item.kind)).toEqual([
			"prompt",
			"lifecycle",
			"progress",
			"thinking",
			"plan",
			"tool_call",
			"tool_result",
			"usage",
			"lifecycle",
		]);
		expect(timeline.find((item) => item.kind === "progress")).toMatchObject({
			content: "Checking files.",
			sequenceStart: 2,
			sequenceEnd: 3,
		});
		expect(timeline.find((item) => item.kind === "tool_call")).toMatchObject({
			tool: "shell",
			status: "inProgress",
			toolKind: "commandExecution",
			toolCallId: "call-1",
			args: { command: "npm test", cwd: "/tmp/project" },
		});
		expect(timeline.find((item) => item.kind === "tool_result")).toMatchObject({
			tool: "shell",
			toolCallId: "call-1",
			content: "passed",
			preview: "passed",
		});
		expect(timeline.at(-1)).toMatchObject({
			kind: "lifecycle",
			title: "Run failed",
			content: "boom",
		});
	});

	it("does not double-count tool results and completed calls in either event order", () => {
		function event(
			sequence: number,
			payload: PersistedRuntimeEvent["event"],
		): PersistedRuntimeEvent {
			return {
				taskId: "task-tool-order",
				sequence,
				timestamp: `2026-06-05T00:00:0${sequence}.000Z`,
				source: "codex",
				event: payload,
			};
		}

		const started = event(0, {
			type: "tool_call",
			tool: "shell",
			status: "inProgress",
			toolCallId: "call-1",
		});
		const completed = event(1, {
			type: "tool_call",
			tool: "shell",
			status: "completed",
			toolCallId: "call-1",
		});
		const result = event(2, {
			type: "tool_result",
			tool: "shell",
			result: { output: "ok" },
			toolCallId: "call-1",
		});

		for (const events of [
			[started, completed, result],
			[started, result, completed],
		]) {
			expect(summarizeExecutionEvents(events).toolActivity).toMatchObject({
				totalCalls: 1,
				uniqueTools: 1,
				tools: [
					{
						name: "shell",
						callsStarted: 1,
						callsCompleted: 1,
						successCount: 1,
						failureCount: 0,
					},
				],
			});
		}
	});
});
