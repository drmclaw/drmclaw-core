import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { configSchema } from "../src/config/schema.js";
import { WebConnector } from "../src/connectors/web.js";
import type { LLMAdapter, LLMAdapterRunOptions } from "../src/llm/adapter.js";
import { TaskRunner } from "../src/runner/runner.js";
import type { TaskResult } from "../src/runner/types.js";
import { AcpRuntime } from "../src/runtime/agent.js";
import { CronService } from "../src/scheduler/service.js";
import { createApp } from "../src/server/app.js";

/**
 * Integration test: boots the Hono app with a mock LLM adapter and
 * exercises both /api REST endpoints and /ws WebSocket together.
 */

function makeMockAdapter(): LLMAdapter {
	return {
		run: vi.fn(async (opts: LLMAdapterRunOptions): Promise<TaskResult> => {
			// Simulate streaming two chunks via structured adapter events
			opts.onEvent?.({ type: "text", text: "hello " });
			opts.onEvent?.({ type: "text", text: "world" });
			return { status: "completed", output: "hello world", durationMs: 10 };
		}),
		dispose: vi.fn(async () => {}),
	};
}

let server: ReturnType<typeof serve>;
let runner: TaskRunner;
let BASE: string;

beforeAll(() => {
	// Config uses a placeholder port; we pass port 0 to serve() directly
	// so the OS assigns a free port — avoids CI collisions.
	const config = configSchema.parse({});
	const adapter = makeMockAdapter();
	const runtime = new AcpRuntime(config, adapter);
	const skills = [
		{
			name: "test-skill",
			description: "A test skill",
			dir: "/tmp/skills/test",
			requires: [] as string[],
			metadata: {},
			source: "system",
			ready: true,
			missingRequires: [] as string[],
		},
	];
	runner = new TaskRunner(config, runtime, skills);
	const scheduler = new CronService();
	scheduler.setRunner(runner);
	const webConnector = new WebConnector();

	// Wire web connector → runner (same as cli.ts bootstrap)
	webConnector.onMessage(async (msg) => {
		const record = await runner.run(msg.content, {
			userId: msg.userId,
			sessionId: msg.sessionId,
			onEvent: (event) => webConnector.broadcast(event),
		});
		await webConnector.sendTaskStatus(record.id, record.result);
	});

	const { app, injectWebSocket } = createApp(runner, scheduler, skills, webConnector);
	server = serve({ fetch: app.fetch, port: 0 });
	injectWebSocket(server);

	const addr = server.address() as AddressInfo;
	BASE = `http://localhost:${addr.port}`;
});

afterAll(() => {
	server?.close();
});

describe("HTTP + WebSocket integration", () => {
	// ---- REST endpoints ----

	it("GET /api/health returns ok", async () => {
		const res = await fetch(`${BASE}/api/health`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { status: string };
		expect(body.status).toBe("ok");
	});

	it("GET /api/skills lists skills", async () => {
		const res = await fetch(`${BASE}/api/skills`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as Array<{ name: string }>;
		expect(body).toHaveLength(1);
		expect(body[0].name).toBe("test-skill");
	});

	it("POST /api/chat runs a task and returns a record", async () => {
		const res = await fetch(`${BASE}/api/chat`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ message: "integration test prompt" }),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { id: string; prompt: string; result: TaskResult };
		expect(body.prompt).toBe("integration test prompt");
		expect(body.result.status).toBe("completed");
		expect(body.result.output).toBe("hello world");
	});

	it("GET /api/tasks returns history including the chat task", async () => {
		const res = await fetch(`${BASE}/api/tasks`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as Array<{ prompt: string }>;
		expect(body.length).toBeGreaterThanOrEqual(1);
		expect(body.some((t) => t.prompt === "integration test prompt")).toBe(true);
	});

	it("POST /api/chat rejects missing message", async () => {
		const res = await fetch(`${BASE}/api/chat`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(400);
	});

	it("GET /api/tasks/:id returns 404 for unknown id", async () => {
		const res = await fetch(`${BASE}/api/tasks/nonexistent`);
		expect(res.status).toBe(404);
	});

	// ---- WebSocket ----

	it("connects to /ws and receives pong for ping", async () => {
		const ws = new WebSocket(`${BASE.replace("http", "ws")}/ws`);

		const pong = await new Promise<Record<string, unknown>>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("WS pong timeout")), 5000);
			ws.onopen = () => {
				ws.send(JSON.stringify({ type: "ping" }));
			};
			ws.onmessage = (event) => {
				const msg = JSON.parse(String(event.data));
				if (msg.type === "pong") {
					clearTimeout(timer);
					resolve(msg);
				}
			};
			ws.onerror = (err) => {
				clearTimeout(timer);
				reject(err);
			};
		});

		expect(pong.type).toBe("pong");
		ws.close();
	});

	it("sends a chat message over /ws and receives streaming + result", async () => {
		const ws = new WebSocket(`${BASE.replace("http", "ws")}/ws`);
		const messages: Array<Record<string, unknown>> = [];

		const result = await new Promise<Record<string, unknown>>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("WS chat timeout")), 5000);
			ws.onopen = () => {
				ws.send(JSON.stringify({ type: "chat", message: "ws integration test" }));
			};
			ws.onmessage = (event) => {
				const msg = JSON.parse(String(event.data));
				messages.push(msg);
				if (msg.type === "result") {
					clearTimeout(timer);
					resolve(msg);
				}
			};
			ws.onerror = (err) => {
				clearTimeout(timer);
				reject(err);
			};
		});

		// Should have received lifecycle start, stream chunks, lifecycle end, and result
		const lifecycleStarts = messages.filter((m) => m.type === "lifecycle" && m.phase === "start");
		const streamChunks = messages.filter((m) => m.type === "stream");
		expect(lifecycleStarts.length).toBeGreaterThanOrEqual(1);
		expect(streamChunks.length).toBeGreaterThanOrEqual(1);

		expect(result.type).toBe("result");
		expect(result.taskId).toBeDefined();

		ws.close();
	});
});
