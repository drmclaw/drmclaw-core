import { describe, expect, it, vi } from "vitest";
import { configSchema } from "../src/config/schema.js";
import type { AdapterEvent, LLMAdapter, LLMAdapterRunOptions } from "../src/llm/adapter.js";
import { AcpRuntime, createAgentRuntime } from "../src/runtime/agent.js";
import type { RuntimeEvent } from "../src/runtime/types.js";
import type { SkillEntry } from "../src/skills/types.js";

function makeConfig(overrides = {}) {
	return configSchema.parse(overrides);
}

function makeSkill(name: string): SkillEntry {
	return {
		name,
		description: `${name} desc`,
		dir: `/skills/${name}`,
		requires: [],
		metadata: {},
		source: "system",
		ready: true,
		missingRequires: [],
	};
}

function makeMockAdapter(): LLMAdapter {
	return {
		run: vi.fn(async (opts: LLMAdapterRunOptions) => ({
			status: "completed" as const,
			output: `response to: ${opts.prompt}`,
			durationMs: 50,
		})),
		dispose: vi.fn(async () => {}),
	};
}

describe("AcpRuntime", () => {
	it("forwards systemContext to the adapter", async () => {
		const config = makeConfig();
		const adapter = makeMockAdapter();
		const runtime = new AcpRuntime(config, adapter);

		await runtime.run({
			backend: "acp",
			prompt: "hello",
			systemContext: "<safety>be safe</safety>",
			skills: [],
		});

		const adapterCall = vi.mocked(adapter.run).mock.calls[0][0];
		expect(adapterCall.systemContext).toBe("<safety>be safe</safety>");
		expect(adapterCall.prompt).toBe("hello");
	});

	it("uses empty systemContext when not provided", async () => {
		const config = makeConfig();
		const adapter = makeMockAdapter();
		const runtime = new AcpRuntime(config, adapter);

		await runtime.run({
			backend: "acp",
			prompt: "test",
			skills: [],
		});

		const adapterCall = vi.mocked(adapter.run).mock.calls[0][0];
		expect(adapterCall.systemContext).toBe("");
	});

	it("emits lifecycle events", async () => {
		const config = makeConfig();
		const adapter = makeMockAdapter();
		const runtime = new AcpRuntime(config, adapter);
		const events: RuntimeEvent[] = [];

		await runtime.run({
			backend: "acp",
			prompt: "hello",
			skills: [],
			onEvent: (e) => events.push(e),
		});

		expect(events[0]).toEqual({ type: "lifecycle", phase: "start" });
		const last = events[events.length - 1];
		expect(last.type).toBe("lifecycle");
		expect((last as { phase: string }).phase).toBe("end");
	});

	it("maps adapter text events to stream runtime events", async () => {
		const config = makeConfig();
		const adapter: LLMAdapter = {
			run: vi.fn(async (opts: LLMAdapterRunOptions) => {
				opts.onEvent?.({ type: "text", text: "hello " });
				opts.onEvent?.({ type: "text", text: "world" });
				return { status: "completed" as const, output: "hello world", durationMs: 10 };
			}),
			dispose: vi.fn(async () => {}),
		};
		const runtime = new AcpRuntime(config, adapter);
		const events: RuntimeEvent[] = [];

		await runtime.run({
			backend: "acp",
			prompt: "test",
			skills: [],
			onEvent: (e) => events.push(e),
		});

		const streamEvents = events.filter((e) => e.type === "stream");
		expect(streamEvents).toEqual([
			{ type: "stream", delta: "hello " },
			{ type: "stream", delta: "world" },
		]);
	});

	it("maps adapter tool_call events to runtime tool_call events", async () => {
		const config = makeConfig();
		const adapter: LLMAdapter = {
			run: vi.fn(async (opts: LLMAdapterRunOptions) => {
				opts.onEvent?.({
					type: "tool_call",
					tool: "shell(git)",
					status: "running",
					args: { cmd: "status" },
				});
				opts.onEvent?.({ type: "tool_result", tool: "shell(git)", result: "clean" });
				return { status: "completed" as const, output: "done", durationMs: 10 };
			}),
			dispose: vi.fn(async () => {}),
		};
		const runtime = new AcpRuntime(config, adapter);
		const events: RuntimeEvent[] = [];

		await runtime.run({
			backend: "acp",
			prompt: "test",
			skills: [],
			onEvent: (e) => events.push(e),
		});

		const toolEvents = events.filter((e) => e.type === "tool_call" || e.type === "tool_result");
		expect(toolEvents).toEqual([
			{ type: "tool_call", tool: "shell(git)", status: "running", args: { cmd: "status" } },
			{ type: "tool_result", tool: "shell(git)", result: "clean" },
		]);
	});

	it("uses policy toolAllowlist over config defaults", async () => {
		const config = makeConfig({ llm: { allowedTools: ["default-tool"] } });
		const adapter = makeMockAdapter();
		const runtime = new AcpRuntime(config, adapter);

		await runtime.run({
			backend: "acp",
			prompt: "test",
			skills: [],
			policy: { toolAllowlist: ["custom-tool"] },
		});

		const adapterCall = vi.mocked(adapter.run).mock.calls[0][0];
		expect(adapterCall.allowedTools).toEqual(["custom-tool"]);
	});

	it("passes sessionId through to adapter", async () => {
		const config = makeConfig();
		const adapter = makeMockAdapter();
		const runtime = new AcpRuntime(config, adapter);

		await runtime.run({
			backend: "acp",
			prompt: "test",
			skills: [],
			sessionId: "sess-123",
		});

		const adapterCall = vi.mocked(adapter.run).mock.calls[0][0];
		expect(adapterCall.sessionId).toBe("sess-123");
	});
});

describe("createAgentRuntime", () => {
	it("creates AcpRuntime for CLI providers", () => {
		const config = makeConfig({ llm: { provider: "github-copilot" } });
		const adapter = makeMockAdapter();
		const runtime = createAgentRuntime(config, adapter);

		expect(runtime).toBeInstanceOf(AcpRuntime);
	});

	it("creates AcpRuntime for any CLI provider", () => {
		const config = makeConfig({ llm: { provider: "claude-cli" } });
		const adapter = makeMockAdapter();
		const runtime = createAgentRuntime(config, adapter);

		expect(runtime).toBeInstanceOf(AcpRuntime);
	});

	it("throws for embedded providers (not yet implemented)", () => {
		const config = makeConfig({ llm: { provider: "openai" } });
		const adapter = makeMockAdapter();

		expect(() => createAgentRuntime(config, adapter)).toThrow(/not yet implemented/);
	});
});
