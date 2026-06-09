import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const recordPath = process.env.FAKE_CODEX_RECORD;
const mode = process.env.FAKE_CODEX_MODE ?? "complete";
const recordEnv = process.env.FAKE_CODEX_RECORD_ENV === "1";

function record(message) {
	if (recordPath) {
		appendFileSync(recordPath, `${JSON.stringify(message)}\n`);
	}
}

function send(message) {
	process.stdout.write(`${JSON.stringify(message)}\n`);
}

function respond(id, result) {
	send({ id, result });
}

const rl = createInterface({ input: process.stdin });

if (recordEnv) {
	record({
		method: "env",
		params: {
			npm_config_prefix: process.env.npm_config_prefix ?? null,
			NPM_CONFIG_PREFIX: process.env.NPM_CONFIG_PREFIX ?? null,
		},
	});
}

rl.on("line", (line) => {
	if (!line.trim()) return;
	const message = JSON.parse(line);
	record(message);

	if (message.method === "initialize") {
		respond(message.id, {
			userAgent: "fake-codex",
			codexHome: "/tmp/fake-codex-home",
			platformFamily: "macos",
			platformOs: "darwin",
		});
		return;
	}

	if (message.method === "thread/start") {
		respond(message.id, {
			thread: {
				id: "thread-1",
				sessionId: null,
				preview: null,
				ephemeral: true,
				modelProvider: "openai",
				status: "idle",
				cwd: message.params?.cwd ?? null,
				turns: [],
			},
			model: message.params?.model ?? "default-model",
			modelProvider: "openai",
			cwd: message.params?.cwd ?? null,
			reasoningEffort: message.params?.effort ?? null,
		});
		return;
	}

	if (message.method === "turn/start") {
		respond(message.id, {
			turn: {
				id: "turn-1",
				items: [],
				itemsView: "complete",
				status: "inProgress",
				error: null,
				startedAt: 1,
				completedAt: null,
				durationMs: null,
			},
		});

		if (mode === "hang") return;

		queueMicrotask(() => {
			send({
				method: "item/started",
				params: {
					threadId: "thread-1",
					turnId: "turn-1",
					startedAtMs: Date.now(),
					item: {
						type: "commandExecution",
						id: "cmd-1",
						command: "node --version",
						cwd: message.params?.cwd ?? "/tmp",
						status: "running",
						commandActions: [],
						aggregatedOutput: null,
						exitCode: null,
						durationMs: null,
					},
				},
			});
			send({
				method: "item/reasoning/textDelta",
				params: { threadId: "thread-1", turnId: "turn-1", itemId: "reason-1", delta: "thinking" },
			});
			send({
				method: "item/agentMessage/delta",
				params: { threadId: "thread-1", turnId: "turn-1", itemId: "msg-1", delta: "Hello " },
			});
			send({
				method: "item/agentMessage/delta",
				params: { threadId: "thread-1", turnId: "turn-1", itemId: "msg-1", delta: "from Codex" },
			});
			send({
				method: "item/completed",
				params: {
					threadId: "thread-1",
					turnId: "turn-1",
					completedAtMs: Date.now(),
					item: { type: "plan", id: "plan-1", text: "Check the runtime" },
				},
			});
			send({
				method: "item/completed",
				params: {
					threadId: "thread-1",
					turnId: "turn-1",
					completedAtMs: Date.now(),
					item: {
						type: "commandExecution",
						id: "cmd-1",
						command: "node --version",
						cwd: message.params?.cwd ?? "/tmp",
						status: "completed",
						commandActions: [],
						aggregatedOutput: "v22.0.0",
						exitCode: 0,
						durationMs: 5,
					},
				},
			});
			send({
				method: "turn/completed",
				params: {
					threadId: "thread-1",
					turn: {
						id: "turn-1",
						items: [{ type: "agentMessage", id: "msg-1", text: "Hello from Codex", phase: null }],
						itemsView: "complete",
						status: mode === "fail" ? "failed" : "completed",
						error: mode === "fail" ? { message: "fake turn failure" } : null,
						startedAt: 1,
						completedAt: 2,
						durationMs: 100,
					},
				},
			});
		});
		return;
	}

	if (message.method === "turn/interrupt") {
		respond(message.id, { ok: true });
	}
});
