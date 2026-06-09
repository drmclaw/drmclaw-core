import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configSchema } from "../src/config/schema.js";
import type { AdapterEvent } from "../src/llm/adapter.js";
import { CodexAppServerAdapter } from "../src/llm/codex-app-server.js";

const FAKE_SERVER = resolve(import.meta.dirname, "fixtures/codex-app-server-fake.mjs");

describe("CodexAppServerAdapter", () => {
	let tmpDir: string;
	let recordPath: string;
	const originalRecord = process.env.FAKE_CODEX_RECORD;
	const originalMode = process.env.FAKE_CODEX_MODE;
	const originalRecordEnv = process.env.FAKE_CODEX_RECORD_ENV;
	const originalNpmConfigPrefix = process.env.npm_config_prefix;
	const originalUpperNpmConfigPrefix = process.env.NPM_CONFIG_PREFIX;

	beforeEach(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "drmclaw-codex-app-server-"));
		recordPath = join(tmpDir, "messages.jsonl");
		process.env.FAKE_CODEX_RECORD = recordPath;
		process.env.FAKE_CODEX_MODE = undefined;
		process.env.FAKE_CODEX_RECORD_ENV = undefined;
	});

	afterEach(async () => {
		if (originalRecord === undefined) {
			process.env.FAKE_CODEX_RECORD = undefined;
		} else {
			process.env.FAKE_CODEX_RECORD = originalRecord;
		}
		if (originalMode === undefined) {
			process.env.FAKE_CODEX_MODE = undefined;
		} else {
			process.env.FAKE_CODEX_MODE = originalMode;
		}
		if (originalRecordEnv === undefined) {
			process.env.FAKE_CODEX_RECORD_ENV = undefined;
		} else {
			process.env.FAKE_CODEX_RECORD_ENV = originalRecordEnv;
		}
		if (originalNpmConfigPrefix === undefined) {
			process.env.npm_config_prefix = undefined;
		} else {
			process.env.npm_config_prefix = originalNpmConfigPrefix;
		}
		if (originalUpperNpmConfigPrefix === undefined) {
			process.env.NPM_CONFIG_PREFIX = undefined;
		} else {
			process.env.NPM_CONFIG_PREFIX = originalUpperNpmConfigPrefix;
		}
		await rm(tmpDir, { recursive: true, force: true });
	});

	function makeAdapter(): CodexAppServerAdapter {
		const config = configSchema.parse({
			llm: {
				model: "gpt-5.4",
				reasoningEffort: "high",
				codex: {
					command: process.execPath,
					args: [FAKE_SERVER],
					approvalPolicy: "never",
					sandbox: "danger-full-access",
				},
			},
		});
		return new CodexAppServerAdapter(config);
	}

	async function recordedMessages(): Promise<Array<{ method: string; params?: unknown }>> {
		const content = await readFile(recordPath, "utf8");
		return content
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line));
	}

	it("runs the App Server handshake and maps notifications", async () => {
		const adapter = makeAdapter();
		const events: AdapterEvent[] = [];

		const result = await adapter.run({
			prompt: "do the work",
			systemContext: "<runtime>test</runtime>",
			workingDir: tmpDir,
			permissionMode: "approve-all",
			onEvent: (event) => events.push(event),
		});

		expect(result).toMatchObject({
			status: "completed",
			output: "Hello from Codex",
		});

		expect(events).toContainEqual({ type: "text", text: "Hello " });
		expect(events).toContainEqual({ type: "text", text: "from Codex" });
		expect(events.some((event) => event.type === "thinking" && event.text === "thinking")).toBe(
			true,
		);
		expect(events.some((event) => event.type === "plan")).toBe(true);
		expect(
			events.some(
				(event) =>
					event.type === "tool_call" &&
					event.tool === "node --version" &&
					event.status === "running",
			),
		).toBe(true);
		expect(
			events.some(
				(event) =>
					event.type === "tool_result" &&
					event.tool === "node --version" &&
					(event.result as { output?: string }).output === "v22.0.0",
			),
		).toBe(true);

		const messages = await recordedMessages();
		expect(messages.map((message) => message.method)).toEqual([
			"initialize",
			"initialized",
			"thread/start",
			"turn/start",
		]);

		const initialize = messages[0].params as {
			clientInfo: { name: string };
			capabilities: null;
		};
		expect(initialize.clientInfo.name).toBe("drmclaw_core");
		expect(initialize.capabilities).toBeNull();

		const threadStart = messages[2].params as {
			model: string;
			cwd: string;
			approvalPolicy: string;
			sandbox: string;
			developerInstructions: string;
			ephemeral: boolean;
		};
		expect(threadStart.model).toBe("gpt-5.4");
		expect(threadStart.cwd).toBe(tmpDir);
		expect(threadStart.approvalPolicy).toBe("never");
		expect(threadStart.sandbox).toBe("danger-full-access");
		expect(threadStart.developerInstructions).toBe("<runtime>test</runtime>");
		expect(threadStart.ephemeral).toBe(true);

		const turnStart = messages[3].params as {
			threadId: string;
			input: Array<{ type: string; text: string; text_elements: unknown[] }>;
			cwd: string;
			approvalPolicy: string;
			model: string;
			effort: string;
		};
		expect(turnStart.threadId).toBe("thread-1");
		expect(turnStart.input).toEqual([{ type: "text", text: "do the work", text_elements: [] }]);
		expect(turnStart.cwd).toBe(tmpDir);
		expect(turnStart.approvalPolicy).toBe("never");
		expect(turnStart.model).toBe("gpt-5.4");
		expect(turnStart.effort).toBe("high");
	});

	it("does not pass npm prefix variables to the Codex child process", async () => {
		process.env.FAKE_CODEX_RECORD_ENV = "1";
		process.env.npm_config_prefix = "/opt/homebrew";
		process.env.NPM_CONFIG_PREFIX = "/opt/homebrew";
		const adapter = makeAdapter();

		const result = await adapter.run({ prompt: "check env" });

		expect(result.status).toBe("completed");
		const messages = await recordedMessages();
		const envRecord = messages.find((message) => message.method === "env") as
			| { params?: { npm_config_prefix?: string | null; NPM_CONFIG_PREFIX?: string | null } }
			| undefined;
		expect(envRecord?.params).toEqual({
			npm_config_prefix: null,
			NPM_CONFIG_PREFIX: null,
		});
	});

	it("returns an error result for failed turns", async () => {
		process.env.FAKE_CODEX_MODE = "fail";
		const adapter = makeAdapter();

		const result = await adapter.run({ prompt: "fail" });

		expect(result.status).toBe("error");
		expect(result.output).toBe("Hello from Codex");
		expect(result.error).toContain("fake turn failure");
	});

	it("returns an error result when the Codex command is missing", async () => {
		const config = configSchema.parse({
			llm: {
				codex: {
					command: "drmclaw-missing-codex-command",
					args: ["app-server"],
				},
			},
		});
		const adapter = new CodexAppServerAdapter(config);

		const result = await adapter.run({ prompt: "test missing command" });

		expect(result.status).toBe("error");
		expect(result.error).toContain(
			"drmclaw-core runtime unavailable: Codex command not found (drmclaw-missing-codex-command)",
		);
		expect(result.error).toContain("PATH");
		expect(result.error).toContain("llm.codex.command");
	});

	it("kills the App Server process when disposed mid-turn", async () => {
		process.env.FAKE_CODEX_MODE = "hang";
		await writeFile(recordPath, "");
		const adapter = makeAdapter();

		const run = adapter.run({ prompt: "hang" });
		await vi.waitFor(async () => {
			const messages = await recordedMessages();
			expect(messages.some((message) => message.method === "turn/start")).toBe(true);
		});
		await adapter.dispose();

		const result = await run;
		expect(result.status).toBe("error");
		expect(result.error).toContain("Codex App Server exited before turn completion");
	});
});
