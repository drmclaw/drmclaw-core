import { describe, expect, it, vi } from "vitest";
import { configSchema } from "../src/config/schema.js";
import { WebConnector } from "../src/connectors/web.js";
import type { LLMAdapterRunOptions } from "../src/llm/adapter.js";
import { TaskRunner } from "../src/runner/runner.js";
import type { TaskResult } from "../src/runner/types.js";
import { AcpRuntime } from "../src/runtime/agent.js";
import type { AgentRuntimeOptions } from "../src/runtime/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides = {}) {
	return configSchema.parse(overrides);
}

function makeSpyAdapter() {
	const calls: LLMAdapterRunOptions[] = [];
	return {
		calls,
		adapter: {
			run: vi.fn(async (opts: LLMAdapterRunOptions): Promise<TaskResult> => {
				calls.push(opts);
				return { status: "completed", output: "ok", durationMs: 1 };
			}),
			dispose: vi.fn(async () => {}),
		},
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Session continuity — connector → runner → runtime → adapter", () => {
	it("WebConnector.handleIncoming propagates sessionId to handlers", () => {
		const connector = new WebConnector();
		const received: Array<{ sessionId?: string }> = [];

		connector.onMessage((msg) => received.push({ sessionId: msg.sessionId }));
		connector.handleIncoming("hi", "user-1", "session-abc");

		expect(received).toHaveLength(1);
		expect(received[0].sessionId).toBe("session-abc");
	});

	it("WebConnector passes undefined sessionId when omitted", () => {
		const connector = new WebConnector();
		const received: Array<{ sessionId?: string }> = [];

		connector.onMessage((msg) => received.push({ sessionId: msg.sessionId }));
		connector.handleIncoming("hi", "user-1");

		expect(received).toHaveLength(1);
		expect(received[0].sessionId).toBeUndefined();
	});

	it("sessionId flows from runner through AcpRuntime to adapter", async () => {
		const config = makeConfig();
		const { adapter, calls } = makeSpyAdapter();
		const runtime = new AcpRuntime(config, adapter);
		const runner = new TaskRunner(config, runtime, []);

		await runner.run("test prompt", { sessionId: "ws-client-99" });

		expect(calls).toHaveLength(1);
		expect(calls[0].sessionId).toBe("ws-client-99");
	});

	it("each runner.run() call preserves caller-supplied sessionId", async () => {
		const config = makeConfig();
		const { adapter, calls } = makeSpyAdapter();
		const runtime = new AcpRuntime(config, adapter);
		const runner = new TaskRunner(config, runtime, []);

		// Simulate two messages from the same WebSocket client
		await runner.run("msg 1", { sessionId: "client-A" });
		await runner.run("msg 2", { sessionId: "client-A" });
		// And one from a different client
		await runner.run("msg 3", { sessionId: "client-B" });

		expect(calls).toHaveLength(3);
		expect(calls[0].sessionId).toBe("client-A");
		expect(calls[1].sessionId).toBe("client-A");
		expect(calls[2].sessionId).toBe("client-B");
	});

	it("adapter receives no sessionId when runner has none", async () => {
		const config = makeConfig();
		const { adapter, calls } = makeSpyAdapter();
		const runtime = new AcpRuntime(config, adapter);
		const runner = new TaskRunner(config, runtime, []);

		await runner.run("one-off");

		expect(calls).toHaveLength(1);
		expect(calls[0].sessionId).toBeUndefined();
	});

	it("end-to-end: connector → runner → adapter wiring", async () => {
		const config = makeConfig();
		const { adapter, calls } = makeSpyAdapter();
		const runtime = new AcpRuntime(config, adapter);
		const runner = new TaskRunner(config, runtime, []);
		const connector = new WebConnector();

		// Wire connector → runner (same pattern as cli.ts)
		connector.onMessage(async (msg) => {
			await runner.run(msg.content, {
				userId: msg.userId,
				sessionId: msg.sessionId,
			});
		});

		// Simulate two messages from the same WS client
		connector.handleIncoming("hello", "user-1", "ws-session-42");
		connector.handleIncoming("follow up", "user-1", "ws-session-42");

		// Wait for async handlers to settle
		await vi.waitFor(() => expect(calls).toHaveLength(2));

		// Both messages should carry the same sessionId to the adapter
		expect(calls[0].sessionId).toBe("ws-session-42");
		expect(calls[1].sessionId).toBe("ws-session-42");
	});
});
