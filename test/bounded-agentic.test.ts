import type * as acp from "@agentclientprotocol/sdk";
import { describe, expect, it, vi } from "vitest";
import { configSchema } from "../src/config/schema.js";
import type { AcpSession, AcpSessionManager, ClientDelegate } from "../src/llm/acp-session.js";
import { AcpAdapter } from "../src/llm/acp.js";
import type { AdapterEvent, LLMAdapter, LLMAdapterRunOptions } from "../src/llm/adapter.js";
import { AcpRuntime } from "../src/runtime/agent.js";
import type { RuntimeEvent } from "../src/runtime/types.js";
import type { SkillEntry } from "../src/skills/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides = {}) {
	return configSchema.parse(overrides);
}

function makeSkill(name: string, description = ""): SkillEntry {
	return {
		name,
		description,
		dir: `/skills/${name}`,
		requires: [],
		metadata: {},
		source: "system",
		ready: true,
		missingRequires: [],
	};
}

/**
 * Build a stub AcpSessionManager for AcpAdapter tests.
 *
 * The `onPrompt` callback fires inside `connection.prompt()`, receiving the
 * mutable ClientDelegate.  Callers simulate ACP server behaviour by invoking
 * `delegate.current.sessionUpdate(...)` with realistic ACP protocol payloads.
 */
function makeStubSession(onPrompt: (delegate: ClientDelegate) => Promise<void>) {
	const clientDelegate: ClientDelegate = {
		current: {
			requestPermission: async () => ({ outcome: { outcome: "cancelled" as const } }),
			sessionUpdate: async () => {},
		},
	};

	const fakeConnection = {
		prompt: async () => {
			await onPrompt(clientDelegate);
			return { stopReason: "end_turn" };
		},
	};

	const fakeSession: AcpSession = {
		connection: fakeConnection as unknown as AcpSession["connection"],
		sessionId: "acp-session-1",
		process: { kill: vi.fn() } as unknown as AcpSession["process"],
		clientDelegate,
	};

	const stubManager: AcpSessionManager = {
		acquire: vi.fn(async (_taskSessionId, _provider, _acpCfg, client) => {
			clientDelegate.current = client;
			return fakeSession;
		}),
		cancel: vi.fn(),
		has: vi.fn(() => false),
		dispose: vi.fn(async () => {}),
	} as unknown as AcpSessionManager;

	return { stubManager, fakeSession };
}

/**
 * Simulate a multi-step agentic run: the LLMAdapter emits a sequence of
 * tool_call → tool_result pairs before producing final text output.
 */
function makeMultiStepAdapter(steps: AdapterEvent[][], finalOutput: string): LLMAdapter {
	return {
		run: vi.fn(async (opts: LLMAdapterRunOptions): Promise<TaskResult> => {
			for (const round of steps) {
				for (const event of round) {
					opts.onEvent?.(event);
				}
			}
			return { status: "completed", output: finalOutput, durationMs: 42 };
		}),
		dispose: vi.fn(async () => {}),
	};
}

// TaskResult type used by helpers above — import kept local to avoid
// pulling an extra top-level import that Biome may flag as misordered.
type TaskResult = Awaited<ReturnType<LLMAdapter["run"]>>;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Bounded-agentic execution", () => {
	// ------------------------------------------------------------------
	// 1. ACP adapter — real sessionUpdate protocol translation
	// ------------------------------------------------------------------
	describe("ACP adapter multi-step protocol translation", () => {
		it("translates a two-round tool loop into AdapterEvents", async () => {
			const config = makeConfig();
			const events: AdapterEvent[] = [];

			const { stubManager } = makeStubSession(async (delegate) => {
				const su = delegate.current.sessionUpdate;

				// Round 1: tool_call → tool_call_update(completed)
				await su({
					sessionId: "s",
					update: {
						sessionUpdate: "tool_call",
						toolCallId: "tc-1",
						title: "list_directory",
						status: "pending",
					},
				});
				await su({
					sessionId: "s",
					update: {
						sessionUpdate: "tool_call_update",
						toolCallId: "tc-1",
						title: "list_directory",
						status: "completed",
						rawOutput: "README.md\nsrc/",
					},
				});

				// Round 2: tool_call → tool_call_update(completed)
				await su({
					sessionId: "s",
					update: {
						sessionUpdate: "tool_call",
						toolCallId: "tc-2",
						title: "read_file",
						status: "pending",
					},
				});
				await su({
					sessionId: "s",
					update: {
						sessionUpdate: "tool_call_update",
						toolCallId: "tc-2",
						title: "read_file",
						status: "completed",
						rawOutput: "# drmclaw-core",
					},
				});

				// Final text
				await su({
					sessionId: "s",
					update: {
						sessionUpdate: "agent_message_chunk",
						content: { type: "text", text: "Node.js project" },
					},
				});
			});

			const adapter = new AcpAdapter(config, stubManager);
			const result = await adapter.run({
				prompt: "probe workspace",
				sessionId: "sess-1",
				onEvent: (e) => events.push(e),
			});

			// tool_call(pending) + tool_result + tool_call(completed) for round 1
			// tool_call(pending) + tool_result + tool_call(completed) for round 2
			// text
			expect(events).toEqual([
				{ type: "tool_call", tool: "list_directory", status: "pending", toolCallId: "tc-1" },
				{
					type: "tool_result",
					tool: "list_directory",
					result: "README.md\nsrc/",
					toolCallId: "tc-1",
				},
				{ type: "tool_call", tool: "list_directory", status: "completed", toolCallId: "tc-1" },
				{ type: "tool_call", tool: "read_file", status: "pending", toolCallId: "tc-2" },
				{ type: "tool_result", tool: "read_file", result: "# drmclaw-core", toolCallId: "tc-2" },
				{ type: "tool_call", tool: "read_file", status: "completed", toolCallId: "tc-2" },
				{ type: "text", text: "Node.js project" },
			]);

			expect(result.status).toBe("completed");
			expect(result.output).toBe("Node.js project");
		});

		it("accumulates text output across multiple agent_message_chunk updates", async () => {
			const config = makeConfig();

			const { stubManager } = makeStubSession(async (delegate) => {
				const su = delegate.current.sessionUpdate;
				await su({
					sessionId: "s",
					update: {
						sessionUpdate: "agent_message_chunk",
						content: { type: "text", text: "Hello " },
					},
				});
				await su({
					sessionId: "s",
					update: {
						sessionUpdate: "agent_message_chunk",
						content: { type: "text", text: "world" },
					},
				});
			});

			const adapter = new AcpAdapter(config, stubManager);
			const result = await adapter.run({ prompt: "greet", sessionId: "s" });

			expect(result.output).toBe("Hello world");
		});

		it("reuses session across repeated runs with delegate swap", async () => {
			const config = makeConfig();
			const allEvents: AdapterEvent[][] = [[], []];
			let callIndex = 0;

			const clientDelegate: ClientDelegate = {
				current: {
					requestPermission: async () => ({ outcome: { outcome: "cancelled" as const } }),
					sessionUpdate: async () => {},
				},
			};

			const fakeConnection = {
				prompt: async () => {
					const i = callIndex++;
					const su = clientDelegate.current.sessionUpdate;
					await su({
						sessionId: "s",
						update: {
							sessionUpdate: "agent_message_chunk",
							content: { type: "text", text: `response-${i}` },
						},
					});
					return { stopReason: "end_turn" };
				},
			};

			const fakeSession: AcpSession = {
				connection: fakeConnection as unknown as AcpSession["connection"],
				sessionId: "reused-session",
				process: { kill: vi.fn() } as unknown as AcpSession["process"],
				clientDelegate,
			};

			const acquireMock = vi.fn(
				async (
					_tid: string,
					_p: unknown,
					_c: unknown,
					client: { sessionUpdate: unknown; requestPermission: unknown },
				) => {
					clientDelegate.current = client as ClientDelegate["current"];
					return fakeSession;
				},
			);

			const stubManager = {
				acquire: acquireMock,
				cancel: vi.fn(),
				has: vi.fn(() => false),
				dispose: vi.fn(async () => {}),
			} as unknown as AcpSessionManager;

			const adapter = new AcpAdapter(config, stubManager);

			// Run 1: same sessionId → session reused
			const r1 = await adapter.run({
				prompt: "first",
				sessionId: "persistent",
				onEvent: (e) => allEvents[0].push(e),
			});

			// Run 2: same sessionId → acquire called again, delegate swapped
			const r2 = await adapter.run({
				prompt: "second",
				sessionId: "persistent",
				onEvent: (e) => allEvents[1].push(e),
			});

			// acquire called twice with same session id
			expect(acquireMock).toHaveBeenCalledTimes(2);
			expect(acquireMock.mock.calls[0][0]).toBe("persistent");
			expect(acquireMock.mock.calls[1][0]).toBe("persistent");

			// Each run accumulated its own independent output
			expect(r1.output).toBe("response-0");
			expect(r2.output).toBe("response-1");

			// Events routed to the correct run's callback
			expect(allEvents[0]).toEqual([{ type: "text", text: "response-0" }]);
			expect(allEvents[1]).toEqual([{ type: "text", text: "response-1" }]);
		});

		it("emits lifecycle events for in_progress and failed tool statuses", async () => {
			const config = makeConfig();
			const events: AdapterEvent[] = [];

			const { stubManager } = makeStubSession(async (delegate) => {
				const su = delegate.current.sessionUpdate;

				// tool_call initial
				await su({
					sessionId: "s",
					update: {
						sessionUpdate: "tool_call",
						toolCallId: "tc-1",
						title: "shell",
						status: "pending",
					},
				});

				// in_progress update — should emit tool_call but NOT tool_result
				await su({
					sessionId: "s",
					update: {
						sessionUpdate: "tool_call_update",
						toolCallId: "tc-1",
						title: "shell",
						status: "in_progress",
					},
				});

				// failed update — should emit both tool_call and tool_result
				await su({
					sessionId: "s",
					update: {
						sessionUpdate: "tool_call_update",
						toolCallId: "tc-1",
						title: "shell",
						status: "failed",
						rawOutput: "exit code 1",
					},
				});
			});

			const adapter = new AcpAdapter(config, stubManager);
			await adapter.run({
				prompt: "test",
				sessionId: "s",
				onEvent: (e) => events.push(e),
			});

			expect(events).toEqual([
				// Initial tool_call
				{ type: "tool_call", tool: "shell", status: "pending", toolCallId: "tc-1" },
				// in_progress: tool_call event only, no tool_result
				{ type: "tool_call", tool: "shell", status: "in_progress", toolCallId: "tc-1" },
				// failed: tool_result first, then tool_call
				{ type: "tool_result", tool: "shell", result: "exit code 1", toolCallId: "tc-1" },
				{ type: "tool_call", tool: "shell", status: "failed", toolCallId: "tc-1" },
			]);
		});

		it("emits tool_result with content fallback when rawOutput is absent", async () => {
			const config = makeConfig();
			const events: AdapterEvent[] = [];

			const contentArray = [
				{ type: "content" as const, content: { type: "text" as const, text: "fallback content" } },
			];

			const { stubManager } = makeStubSession(async (delegate) => {
				const su = delegate.current.sessionUpdate;
				await su({
					sessionId: "s",
					update: {
						sessionUpdate: "tool_call_update",
						toolCallId: "tc-1",
						title: "shell",
						status: "completed",
						content: contentArray,
					},
				});
			});

			const adapter = new AcpAdapter(config, stubManager);
			await adapter.run({
				prompt: "test",
				sessionId: "s",
				onEvent: (e) => events.push(e),
			});

			const toolResult = events.find((e) => e.type === "tool_result");
			expect(toolResult).toEqual({
				type: "tool_result",
				tool: "shell",
				result: contentArray,
				toolCallId: "tc-1",
			});
		});

		it("propagates tool kind from tool_call session updates", async () => {
			const config = makeConfig();
			const events: AdapterEvent[] = [];

			const { stubManager } = makeStubSession(async (delegate) => {
				const su = delegate.current.sessionUpdate;
				await su({
					sessionId: "s",
					update: {
						sessionUpdate: "tool_call",
						toolCallId: "tc-1",
						title: "list_directory",
						status: "pending",
						kind: "search",
					},
				});
				await su({
					sessionId: "s",
					update: {
						sessionUpdate: "tool_call_update",
						toolCallId: "tc-1",
						status: "completed",
						rawOutput: "README.md",
					},
				});
			});

			const adapter = new AcpAdapter(config, stubManager);
			await adapter.run({
				prompt: "test",
				sessionId: "s",
				onEvent: (e) => events.push(e),
			});

			const pending = events.find((e) => e.type === "tool_call" && e.status === "pending");
			expect(pending).toEqual({
				type: "tool_call",
				tool: "list_directory",
				status: "pending",
				kind: "search",
				toolCallId: "tc-1",
			});

			// Kind resolved from cache on update (which lacks kind)
			const completed = events.find((e) => e.type === "tool_call" && e.status === "completed");
			expect(completed).toEqual({
				type: "tool_call",
				tool: "list_directory",
				status: "completed",
				kind: "search",
				toolCallId: "tc-1",
			});
		});

		it("omits kind when not provided by the session update", async () => {
			const config = makeConfig();
			const events: AdapterEvent[] = [];

			const { stubManager } = makeStubSession(async (delegate) => {
				const su = delegate.current.sessionUpdate;
				await su({
					sessionId: "s",
					update: {
						sessionUpdate: "tool_call",
						toolCallId: "tc-1",
						title: "shell",
						status: "pending",
					},
				});
			});

			const adapter = new AcpAdapter(config, stubManager);
			await adapter.run({
				prompt: "test",
				sessionId: "s",
				onEvent: (e) => events.push(e),
			});

			const toolCall = events.find((e) => e.type === "tool_call");
			expect(toolCall).not.toHaveProperty("kind");
		});

		it("emits thinking events from agent_thought_chunk updates", async () => {
			const config = makeConfig();
			const events: AdapterEvent[] = [];

			const { stubManager } = makeStubSession(async (delegate) => {
				const su = delegate.current.sessionUpdate;
				await su({
					sessionId: "s",
					update: {
						sessionUpdate: "agent_thought_chunk",
						content: { type: "text", text: "Analyzing the codebase..." },
					},
				});
				await su({
					sessionId: "s",
					update: {
						sessionUpdate: "agent_thought_chunk",
						content: { type: "text", text: "Found relevant files." },
					},
				});
			});

			const adapter = new AcpAdapter(config, stubManager);
			await adapter.run({
				prompt: "test",
				sessionId: "s",
				onEvent: (e) => events.push(e),
			});

			const thinkingEvents = events.filter((e) => e.type === "thinking");
			expect(thinkingEvents).toEqual([
				{ type: "thinking", text: "Analyzing the codebase..." },
				{ type: "thinking", text: "Found relevant files." },
			]);
		});

		it("emits plan events from plan session updates", async () => {
			const config = makeConfig();
			const events: AdapterEvent[] = [];

			const { stubManager } = makeStubSession(async (delegate) => {
				const su = delegate.current.sessionUpdate;
				await su({
					sessionId: "s",
					update: {
						sessionUpdate: "plan",
						entries: [
							{ content: "Read config file", priority: "high", status: "completed" },
							{ content: "Run tests", priority: "medium", status: "pending" },
						],
					},
				});
			});

			const adapter = new AcpAdapter(config, stubManager);
			await adapter.run({
				prompt: "test",
				sessionId: "s",
				onEvent: (e) => events.push(e),
			});

			const planEvents = events.filter((e) => e.type === "plan");
			expect(planEvents).toHaveLength(1);
			expect(planEvents[0]).toEqual({
				type: "plan",
				entries: [
					{ content: "Read config file", priority: "high", status: "completed" },
					{ content: "Run tests", priority: "medium", status: "pending" },
				],
			});
		});

		it("emits usage events from usage_update session updates", async () => {
			const config = makeConfig();
			const events: AdapterEvent[] = [];

			const { stubManager } = makeStubSession(async (delegate) => {
				const su = delegate.current.sessionUpdate;
				await su({
					sessionId: "s",
					update: {
						sessionUpdate: "usage_update",
						used: 75000,
						size: 200000,
						cost: { amount: 0.25, currency: "USD" },
					},
				});
			});

			const adapter = new AcpAdapter(config, stubManager);
			await adapter.run({
				prompt: "test",
				sessionId: "s",
				onEvent: (e) => events.push(e),
			});

			const usageEvents = events.filter((e) => e.type === "usage");
			expect(usageEvents).toHaveLength(1);
			expect(usageEvents[0]).toEqual({
				type: "usage",
				used: 75000,
				size: 200000,
				cost: { amount: 0.25, currency: "USD" },
			});
		});

		it("emits usage events without cost when cost is absent", async () => {
			const config = makeConfig();
			const events: AdapterEvent[] = [];

			const { stubManager } = makeStubSession(async (delegate) => {
				const su = delegate.current.sessionUpdate;
				await su({
					sessionId: "s",
					update: {
						sessionUpdate: "usage_update",
						used: 10000,
						size: 128000,
					},
				});
			});

			const adapter = new AcpAdapter(config, stubManager);
			await adapter.run({
				prompt: "test",
				sessionId: "s",
				onEvent: (e) => events.push(e),
			});

			const usageEvents = events.filter((e) => e.type === "usage");
			expect(usageEvents).toHaveLength(1);
			expect(usageEvents[0]).toEqual({
				type: "usage",
				used: 10000,
				size: 128000,
			});
		});
	});

	// ------------------------------------------------------------------
	// 2. Policy-enforced tool refusal (real boundedness)
	// ------------------------------------------------------------------
	describe("policy-enforced tool refusal", () => {
		it("denies an unsafe tool in approve-reads mode", async () => {
			const config = makeConfig({ llm: { permissionMode: "approve-reads" } });
			const permissionOutcomes: string[] = [];

			const { stubManager } = makeStubSession(async (delegate) => {
				// ACP server requests permission for "shell(rm)" (execute kind)
				const response = await delegate.current.requestPermission({
					sessionId: "s",
					toolCall: { toolCallId: "c", title: "shell(rm)", status: "pending", kind: "execute" },
					options: [
						{ optionId: "allow", name: "Allow", kind: "allow_once" },
						{ optionId: "deny", name: "Deny", kind: "reject_once" },
					],
				});
				permissionOutcomes.push(response.outcome.outcome);
			});

			const adapter = new AcpAdapter(config, stubManager);

			// approve-reads rejects execute kind → deny
			await adapter.run({
				prompt: "delete everything",
				permissionMode: "approve-reads",
				sessionId: "s",
			});

			expect(permissionOutcomes).toEqual(["selected"]);
		});

		it("approves read tools and denies unsafe tools in the same run", async () => {
			const config = makeConfig({ llm: { permissionMode: "approve-reads" } });
			const permissionOutcomes: string[] = [];

			const { stubManager } = makeStubSession(async (delegate) => {
				// First tool: read kind → allowed
				const r1 = await delegate.current.requestPermission({
					sessionId: "s",
					toolCall: { toolCallId: "c1", title: "read_file", status: "pending", kind: "read" },
					options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
				});
				permissionOutcomes.push(r1.outcome.outcome);

				// Second tool: execute kind → denied
				const r2 = await delegate.current.requestPermission({
					sessionId: "s",
					toolCall: { toolCallId: "c2", title: "shell(rm)", status: "pending", kind: "execute" },
					options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
				});
				permissionOutcomes.push(r2.outcome.outcome);
			});

			const adapter = new AcpAdapter(config, stubManager);
			await adapter.run({
				prompt: "mixed tools",
				permissionMode: "approve-reads",
				sessionId: "s",
			});

			expect(permissionOutcomes).toEqual(["selected", "selected"]);
		});

		it("runtime passes policy.permissionMode into the adapter", async () => {
			const adapter: LLMAdapter = {
				run: vi.fn(async () => ({
					status: "completed" as const,
					output: "ok",
					durationMs: 1,
				})),
				dispose: vi.fn(async () => {}),
			};
			const config = makeConfig({ llm: { permissionMode: "deny-all" } });
			const runtime = new AcpRuntime(config, adapter);

			await runtime.run({
				backend: "acp",
				prompt: "probe",
				skills: [],
				policy: { permissionMode: "approve-all" },
			});

			const call = vi.mocked(adapter.run).mock.calls[0]?.[0];
			expect(call?.permissionMode).toBe("approve-all");
		});

		it("falls back to config permissionMode when no policy is set", async () => {
			const adapter: LLMAdapter = {
				run: vi.fn(async () => ({
					status: "completed" as const,
					output: "ok",
					durationMs: 1,
				})),
				dispose: vi.fn(async () => {}),
			};
			const config = makeConfig({ llm: { permissionMode: "deny-all" } });
			const runtime = new AcpRuntime(config, adapter);

			await runtime.run({ backend: "acp", prompt: "test", skills: [] });

			const call = vi.mocked(adapter.run).mock.calls[0]?.[0];
			expect(call?.permissionMode).toBe("deny-all");
		});
	});

	// ------------------------------------------------------------------
	// 3. Multi-step event fidelity through AcpRuntime
	// ------------------------------------------------------------------
	describe("multi-step event fidelity through AcpRuntime", () => {
		it("collects all events from a two-tool-round run in order", async () => {
			const steps: AdapterEvent[][] = [
				[
					{ type: "tool_call", tool: "list_directory", status: "running", args: { path: "." } },
					{ type: "tool_result", tool: "list_directory", result: "README.md\nsrc/" },
				],
				[
					{ type: "tool_call", tool: "read_file", status: "running", args: { path: "README.md" } },
					{ type: "tool_result", tool: "read_file", result: "# drmclaw-core" },
				],
				[{ type: "text", text: "Node.js project" }],
			];
			const adapter = makeMultiStepAdapter(steps, "Node.js project");
			const runtime = new AcpRuntime(makeConfig(), adapter);
			const events: RuntimeEvent[] = [];

			const result = await runtime.run({
				backend: "acp",
				prompt: "probe workspace",
				skills: [makeSkill("hello")],
				onEvent: (e) => events.push(e),
			});

			// start + prompt_sent + 2×(tool_call+tool_result) + stream + end = 8
			expect(events).toHaveLength(8);
			expect(events[0]).toEqual({ source: "runtime", type: "lifecycle", phase: "start" });
			expect(events[1]).toEqual({ source: "runtime", type: "lifecycle", phase: "prompt_sent" });
			expect(events[2]).toMatchObject({ type: "tool_call", tool: "list_directory" });
			expect(events[3]).toMatchObject({ type: "tool_result", tool: "list_directory" });
			expect(events[4]).toMatchObject({ type: "tool_call", tool: "read_file" });
			expect(events[5]).toMatchObject({ type: "tool_result", tool: "read_file" });
			expect(events[6]).toEqual({ source: "acp", type: "stream", delta: "Node.js project" });
			expect(events[7]).toMatchObject({ type: "lifecycle", phase: "end" });
			expect(result.status).toBe("completed");
		});

		it("streamed text and returned output stay aligned", async () => {
			const steps: AdapterEvent[][] = [
				[
					{ type: "tool_call", tool: "read_file", status: "running" },
					{ type: "tool_result", tool: "read_file", result: "content" },
				],
				[
					{ type: "text", text: "Part A. " },
					{ type: "text", text: "Part B." },
				],
			];
			const adapter = makeMultiStepAdapter(steps, "Part A. Part B.");
			const runtime = new AcpRuntime(makeConfig(), adapter);
			const events: RuntimeEvent[] = [];

			const result = await runtime.run({
				backend: "acp",
				prompt: "test",
				skills: [],
				onEvent: (e) => events.push(e),
			});

			// Concatenate all streamed deltas
			const streamedText = events
				.filter((e): e is RuntimeEvent & { type: "stream" } => e.type === "stream")
				.map((e) => e.delta)
				.join("");

			// Streamed text must equal the final returned output
			expect(streamedText).toBe(result.output);
			expect(result.output).toBe("Part A. Part B.");
		});

		it("handles a three-round tool-calling loop", async () => {
			const steps: AdapterEvent[][] = [
				[
					{ type: "tool_call", tool: "shell", status: "running", args: { cmd: "ls" } },
					{ type: "tool_result", tool: "shell", result: "a.txt\nb.txt" },
				],
				[
					{ type: "tool_call", tool: "read_file", status: "running", args: { path: "a.txt" } },
					{ type: "tool_result", tool: "read_file", result: "contents of a" },
				],
				[
					{ type: "tool_call", tool: "read_file", status: "running", args: { path: "b.txt" } },
					{ type: "tool_result", tool: "read_file", result: "contents of b" },
				],
				[{ type: "text", text: "done" }],
			];
			const adapter = makeMultiStepAdapter(steps, "done");
			const runtime = new AcpRuntime(makeConfig(), adapter);
			const events: RuntimeEvent[] = [];

			await runtime.run({
				backend: "acp",
				prompt: "read all files",
				skills: [],
				onEvent: (e) => events.push(e),
			});

			const toolCalls = events.filter((e) => e.type === "tool_call");
			const toolResults = events.filter((e) => e.type === "tool_result");
			expect(toolCalls).toHaveLength(3);
			expect(toolResults).toHaveLength(3);
		});
	});

	// ------------------------------------------------------------------
	// 4. Error resilience mid-run
	// ------------------------------------------------------------------
	describe("error resilience", () => {
		it("captures partial events when adapter fails mid-run", async () => {
			const adapter: LLMAdapter = {
				run: vi.fn(async (opts: LLMAdapterRunOptions) => {
					opts.onEvent?.({ type: "tool_call", tool: "list_directory", status: "running" });
					opts.onEvent?.({ type: "tool_result", tool: "list_directory", result: "README.md" });
					throw new Error("Connection lost");
				}),
				dispose: vi.fn(async () => {}),
			};
			const runtime = new AcpRuntime(makeConfig(), adapter);
			const events: RuntimeEvent[] = [];

			const result = await runtime.run({
				backend: "acp",
				prompt: "probe workspace",
				skills: [],
				onEvent: (e) => events.push(e),
			});

			expect(events).toHaveLength(5);
			expect(events[0]).toMatchObject({ type: "lifecycle", phase: "start" });
			expect(events[1]).toMatchObject({ type: "lifecycle", phase: "prompt_sent" });
			expect(events[2]).toMatchObject({ type: "tool_call", tool: "list_directory" });
			expect(events[3]).toMatchObject({ type: "tool_result", tool: "list_directory" });
			expect(events[4]).toMatchObject({ type: "lifecycle", phase: "error" });
			expect(result.status).toBe("error");
			expect(result.error).toContain("Connection lost");
		});

		it("returns error status when adapter throws before any tool call", async () => {
			const adapter: LLMAdapter = {
				run: vi.fn(async () => {
					throw new Error("Auth expired");
				}),
				dispose: vi.fn(async () => {}),
			};
			const runtime = new AcpRuntime(makeConfig(), adapter);
			const events: RuntimeEvent[] = [];

			const result = await runtime.run({
				backend: "acp",
				prompt: "test",
				skills: [],
				onEvent: (e) => events.push(e),
			});

			expect(events).toHaveLength(3);
			expect(events[0]).toMatchObject({ type: "lifecycle", phase: "start" });
			expect(events[1]).toMatchObject({ type: "lifecycle", phase: "prompt_sent" });
			expect(events[2]).toMatchObject({ type: "lifecycle", phase: "error" });
			expect(result.status).toBe("error");
			expect(result.error).toContain("Auth expired");
		});

		it("ACP adapter returns error status on connection failure", async () => {
			const config = makeConfig();
			const { stubManager } = makeStubSession(async () => {
				throw new Error("Process exited unexpectedly");
			});

			const adapter = new AcpAdapter(config, stubManager);
			const result = await adapter.run({ prompt: "test", sessionId: "s" });

			expect(result.status).toBe("error");
			expect(result.error).toContain("Process exited unexpectedly");
		});
	});
});
