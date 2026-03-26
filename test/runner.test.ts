import { describe, expect, it, vi } from "vitest";
import { configSchema } from "../src/config/schema.js";
import type { PersistedRuntimeEvent } from "../src/events/types.js";
import { TaskRunner } from "../src/runner/runner.js";
import type { TaskResult } from "../src/runner/types.js";
import type { AgentRuntime, AgentRuntimeOptions, RuntimeEvent } from "../src/runtime/types.js";
import type { SkillEntry } from "../src/skills/types.js";

function makeConfig(overrides = {}) {
	return configSchema.parse(overrides);
}

function makeSkill(name: string): SkillEntry {
	return {
		name,
		description: `${name} skill`,
		dir: `/skills/${name}`,
		requires: [],
		metadata: {},
		source: "system",
		ready: true,
		missingRequires: [],
	};
}

function makeMockRuntime(resultFn?: (options: AgentRuntimeOptions) => TaskResult): AgentRuntime {
	return {
		run: vi.fn(async (options: AgentRuntimeOptions): Promise<TaskResult> => {
			return (
				resultFn?.(options) ?? {
					status: "completed",
					output: "test output",
					durationMs: 100,
				}
			);
		}),
	};
}

describe("TaskRunner", () => {
	it("runs a task and records history", async () => {
		const config = makeConfig();
		const runtime = makeMockRuntime();
		const skills = [makeSkill("hello")];
		const runner = new TaskRunner(config, runtime, skills);

		const record = await runner.run("say hello");

		expect(record.prompt).toBe("say hello");
		expect(record.result.status).toBe("completed");
		expect(record.result.output).toBe("test output");
		expect(record.id).toBeDefined();
		expect(record.startedAt).toBeLessThanOrEqual(record.completedAt);

		const history = runner.getHistory();
		expect(history).toHaveLength(1);
		expect(history[0].id).toBe(record.id);
	});

	it("passes systemContext to the runtime", async () => {
		const config = makeConfig({ workspace: { dir: undefined } });
		const runtime = makeMockRuntime();
		const skills = [makeSkill("hello")];
		const runner = new TaskRunner(config, runtime, skills);

		await runner.run("check status");

		const runCall = vi.mocked(runtime.run).mock.calls[0][0];
		expect(runCall.systemContext).toBeDefined();
		expect(runCall.systemContext).toContain("<available_skills>");
		expect(runCall.systemContext).toContain("hello");
		expect(runCall.systemContext).toContain("<safety>");
		expect(runCall.systemContext).toContain("<runtime>");
	});

	it("catches runtime errors and records them", async () => {
		const config = makeConfig();
		const runtime = makeMockRuntime(() => {
			throw new Error("LLM unavailable");
		});
		const runner = new TaskRunner(config, runtime, []);

		const record = await runner.run("fail please");

		expect(record.result.status).toBe("error");
		expect(record.result.error).toContain("LLM unavailable");
	});

	it("retrieves a specific task by ID", async () => {
		const config = makeConfig();
		const runtime = makeMockRuntime();
		const runner = new TaskRunner(config, runtime, []);

		const record = await runner.run("find me");
		const found = runner.getTask(record.id);

		expect(found).toBeDefined();
		expect(found?.id).toBe(record.id);
		expect(runner.getTask("nonexistent")).toBeUndefined();
	});

	it("forwards sessionId to the runtime", async () => {
		const config = makeConfig();
		const runtime = makeMockRuntime();
		const runner = new TaskRunner(config, runtime, []);

		await runner.run("hello", { sessionId: "ws-client-42" });

		const runCall = vi.mocked(runtime.run).mock.calls[0][0];
		expect(runCall.sessionId).toBe("ws-client-42");
	});

	it("passes undefined sessionId when not provided", async () => {
		const config = makeConfig();
		const runtime = makeMockRuntime();
		const runner = new TaskRunner(config, runtime, []);

		await runner.run("hello");

		const runCall = vi.mocked(runtime.run).mock.calls[0][0];
		expect(runCall.sessionId).toBeUndefined();
	});

	it("persisted event payloads do not contain extra fields from RuntimeEvent", async () => {
		// Mock runtime that emits RuntimeEvents with `source` (the new field).
		// The runner must strip `source` before storing it in the event payload.
		const runtime: AgentRuntime = {
			run: vi.fn(async (options: AgentRuntimeOptions): Promise<TaskResult> => {
				const emit = (e: RuntimeEvent) => options.onEvent?.(e);
				emit({ source: "runtime", type: "lifecycle", phase: "start" });
				emit({ source: "runtime", type: "lifecycle", phase: "prompt_sent" });
				emit({ source: "acp", type: "stream", delta: "hello" });
				emit({ source: "acp", type: "thinking", text: "considering..." });
				emit({
					source: "acp",
					type: "tool_call",
					tool: "read_file",
					status: "pending",
				});
				emit({
					source: "acp",
					type: "tool_result",
					tool: "read_file",
					result: "content",
				});
				emit({
					source: "acp",
					type: "plan",
					entries: [{ content: "Step 1", priority: "high", status: "pending" }],
				});
				emit({
					source: "acp",
					type: "usage",
					used: 5000,
					size: 100000,
				});
				const result: TaskResult = { status: "completed", output: "hello", durationMs: 10 };
				emit({ source: "runtime", type: "lifecycle", phase: "end", result });
				return result;
			}),
		};
		const runner = new TaskRunner(makeConfig(), runtime, []);

		const persisted: PersistedRuntimeEvent[] = [];
		await runner.run("test", {
			onPersistedEvent: (e) => persisted.push(e),
		});

		// Every persisted event's inner `event` field must match EventPayload —
		// it must NOT contain the `source` field that belongs on RuntimeEvent.
		for (const p of persisted) {
			expect(p.event).not.toHaveProperty("source");
		}

		// Verify the outer source is correctly propagated from RuntimeEvent.source
		const byType = (t: string) => persisted.filter((e) => e.event.type === t);
		for (const e of byType("lifecycle")) expect(e.source).toBe("runtime");
		for (const e of byType("stream")) expect(e.source).toBe("acp");
		for (const e of byType("tool_call")) expect(e.source).toBe("acp");
		for (const e of byType("tool_result")) expect(e.source).toBe("acp");
		for (const e of byType("thinking")) expect(e.source).toBe("acp");
		for (const e of byType("plan")) expect(e.source).toBe("acp");
		for (const e of byType("usage")) expect(e.source).toBe("acp");
	});
});
