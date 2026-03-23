import { describe, expect, it, vi } from "vitest";
import { configSchema } from "../src/config/schema.js";
import { TaskRunner } from "../src/runner/runner.js";
import type { TaskResult } from "../src/runner/types.js";
import type { AgentRuntime, AgentRuntimeOptions } from "../src/runtime/types.js";
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
});
