import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type * as acp from "@agentclientprotocol/sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { configSchema } from "../src/config/schema.js";
import {
	type AcpSession,
	AcpSessionManager,
	type ClientDelegate,
	type DiscoveredModel,
	getGithubCopilotReasoningEffortConfigId,
	isModelAllowed,
} from "../src/llm/acp-session.js";
import { AcpAdapter } from "../src/llm/acp.js";
import type { AdapterEvent } from "../src/llm/adapter.js";

// ---------------------------------------------------------------------------
// Module-level mocks — control spawn and ACP SDK so that acquire() and
// discoverModels() can be exercised without real subprocesses.
// ---------------------------------------------------------------------------

const {
	mockSpawn,
	mockInitialize,
	mockNewSession,
	mockSetSessionModel,
	mockSetSessionConfigOption,
} = vi.hoisted(() => ({
	mockSpawn: vi.fn(),
	mockInitialize: vi.fn(),
	mockNewSession: vi.fn(),
	mockSetSessionModel: vi.fn(),
	mockSetSessionConfigOption: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => {
	const mod = await importOriginal<typeof import("node:child_process")>();
	return { ...mod, spawn: mockSpawn };
});

vi.mock("@agentclientprotocol/sdk", async (importOriginal) => {
	const mod = await importOriginal<typeof import("@agentclientprotocol/sdk")>();
	return {
		...mod,
		ndJsonStream: vi.fn(),
		ClientSideConnection: vi.fn().mockImplementation(() => ({
			initialize: mockInitialize,
			newSession: mockNewSession,
			unstable_setSessionModel: mockSetSessionModel,
			setSessionConfigOption: mockSetSessionConfigOption,
		})),
	};
});

/**
 * Create a mock ChildProcess backed by an EventEmitter with
 * PassThrough streams — sufficient for acquire()/discoverModels()
 * which call Writable.toWeb(), Readable.toWeb(), and register
 * once("exit"/"error") listeners.
 */
function createMockProcess() {
	const emitter = new EventEmitter();
	return Object.assign(emitter, {
		stdin: new PassThrough(),
		stdout: new PassThrough(),
		stderr: null,
		kill: vi.fn(),
		exitCode: null as number | null,
		signalCode: null as string | null,
		pid: 12345,
	});
}

// ---------------------------------------------------------------------------
// 1. AcpSessionManager — real delegate-swap path
// ---------------------------------------------------------------------------

/**
 * Seed a pre-built AcpSession into the manager's private `sessions` map so
 * we can call the **real** `acquire()` reuse path without spawning a process.
 */
function seedSession(manager: AcpSessionManager, taskSessionId: string, session: AcpSession) {
	// biome-ignore lint/suspicious/noExplicitAny: accessing private map for test seeding
	(manager as any).sessions.set(taskSessionId, session);
}

function makeFakeSession(client: acp.Client): AcpSession {
	const clientDelegate: ClientDelegate = { current: client };
	return {
		connection: { prompt: vi.fn() } as unknown as AcpSession["connection"],
		sessionId: "acp-session-1",
		process: { kill: vi.fn() } as unknown as AcpSession["process"],
		clientDelegate,
	};
}

describe("AcpSessionManager.acquire — delegate swap", () => {
	it("swaps clientDelegate.current to the new client on session reuse", async () => {
		const manager = new AcpSessionManager();

		const originalClient: acp.Client = {
			requestPermission: vi.fn(async () => ({ outcome: { outcome: "cancelled" as const } })),
			sessionUpdate: vi.fn(async () => {}),
		};

		const session = makeFakeSession(originalClient);
		seedSession(manager, "shared", session);

		// Sanity: delegate points at the original client
		expect(session.clientDelegate.current).toBe(originalClient);

		const newClient: acp.Client = {
			requestPermission: vi.fn(async () => ({
				outcome: { outcome: "selected" as const, optionId: "a" },
			})),
			sessionUpdate: vi.fn(async () => {}),
		};

		// Call the REAL acquire() on an existing key
		const reused = await manager.acquire(
			"shared",
			"github-copilot",
			{ githubCopilot: {}, mcpServers: [] },
			newClient,
		);

		// Same session object returned
		expect(reused).toBe(session);
		// Delegate now points at the new client
		expect(session.clientDelegate.current).toBe(newClient);
	});

	it("reused session returns the same process object (PID identity)", async () => {
		const manager = new AcpSessionManager();

		const client: acp.Client = {
			requestPermission: vi.fn(async () => ({ outcome: { outcome: "cancelled" as const } })),
			sessionUpdate: vi.fn(async () => {}),
		};

		const session = makeFakeSession(client);
		seedSession(manager, "pid-check", session);

		const firstAcquire = await manager.acquire(
			"pid-check",
			"github-copilot",
			{ githubCopilot: {}, mcpServers: [] },
			client,
		);
		const processBefore = firstAcquire.process;

		// Second acquire with a different client — same session key
		const newClient: acp.Client = {
			requestPermission: vi.fn(async () => ({
				outcome: { outcome: "selected" as const, optionId: "a" },
			})),
			sessionUpdate: vi.fn(async () => {}),
		};

		const secondAcquire = await manager.acquire(
			"pid-check",
			"github-copilot",
			{ githubCopilot: {}, mcpServers: [] },
			newClient,
		);

		// Same session, same process — no new spawn
		expect(secondAcquire).toBe(firstAcquire);
		expect(secondAcquire.process).toBe(processBefore);
	});

	it("connection dispatches through swapped delegate", async () => {
		const manager = new AcpSessionManager();

		const calls: string[] = [];
		const firstClient: acp.Client = {
			requestPermission: vi.fn(async () => {
				calls.push("first");
				return { outcome: { outcome: "cancelled" as const } };
			}),
			sessionUpdate: vi.fn(async () => {}),
		};

		const delegate: ClientDelegate = { current: firstClient };
		// Build a fake connection that routes through the delegate (like production)
		const fakeConnection = {
			prompt: vi.fn(async () => {
				// Simulate ACP server calling back through the delegate
				await delegate.current.requestPermission({
					sessionId: "s",
					toolCall: { toolCallId: "t", title: "tool", status: "pending" },
					options: [{ optionId: "a", name: "A", kind: "allow_once" }],
				});
				return { stopReason: "end_turn" };
			}),
		};
		const session: AcpSession = {
			connection: fakeConnection as unknown as AcpSession["connection"],
			sessionId: "acp-session-1",
			process: { kill: vi.fn() } as unknown as AcpSession["process"],
			clientDelegate: delegate,
		};
		seedSession(manager, "shared", session);

		// Call acquire with a second client — exercises real delegate swap
		const secondClient: acp.Client = {
			requestPermission: vi.fn(async () => {
				calls.push("second");
				return { outcome: { outcome: "selected" as const, optionId: "a" } };
			}),
			sessionUpdate: vi.fn(async () => {}),
		};
		await manager.acquire(
			"shared",
			"github-copilot",
			{ githubCopilot: {}, mcpServers: [] },
			secondClient,
		);

		// Trigger the connection callback — should hit secondClient
		await fakeConnection.prompt();

		expect(calls).toEqual(["second"]);
		expect(secondClient.requestPermission).toHaveBeenCalledTimes(1);
		expect(firstClient.requestPermission).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// 1b. AcpSessionManager — model switching via session/set_model
// ---------------------------------------------------------------------------

describe("AcpSessionManager.setModel", () => {
	it("calls unstable_setSessionModel on each existing session", async () => {
		const manager = new AcpSessionManager();

		const setModelMock = vi.fn(async () => ({}));
		const session = makeFakeSession({
			requestPermission: vi.fn(async () => ({ outcome: { outcome: "cancelled" as const } })),
			sessionUpdate: vi.fn(async () => {}),
		});
		(
			session.connection as unknown as { unstable_setSessionModel: typeof setModelMock }
		).unstable_setSessionModel = setModelMock;
		seedSession(manager, "s1", session);

		await manager.setModel("gemini-2.5-pro");

		expect(setModelMock).toHaveBeenCalledOnce();
		expect(setModelMock).toHaveBeenCalledWith({
			sessionId: "acp-session-1",
			modelId: "gemini-2.5-pro",
		});
		// Session should still be alive
		expect(manager.has("s1")).toBe(true);
	});

	it("disposes session as fallback when set_model is not supported", async () => {
		const manager = new AcpSessionManager();

		const session = makeFakeSession({
			requestPermission: vi.fn(async () => ({ outcome: { outcome: "cancelled" as const } })),
			sessionUpdate: vi.fn(async () => {}),
		});
		// Simulate agent that doesn't support session/set_model
		(
			session.connection as unknown as { unstable_setSessionModel: () => never }
		).unstable_setSessionModel = () => {
			throw new Error("Method not found: session/set_model");
		};
		seedSession(manager, "s1", session);

		await manager.setModel("gpt-5.4");

		// Session should have been disposed
		expect(manager.has("s1")).toBe(false);
		expect(session.process.kill).toHaveBeenCalled();
	});

	it("handles mixed sessions — some support set_model, some don't", async () => {
		const manager = new AcpSessionManager();

		const supportedSession = makeFakeSession({
			requestPermission: vi.fn(async () => ({ outcome: { outcome: "cancelled" as const } })),
			sessionUpdate: vi.fn(async () => {}),
		});
		(
			supportedSession.connection as unknown as { unstable_setSessionModel: () => Promise<object> }
		).unstable_setSessionModel = vi.fn(async () => ({}));
		seedSession(manager, "supported", supportedSession);

		const unsupportedSession = makeFakeSession({
			requestPermission: vi.fn(async () => ({ outcome: { outcome: "cancelled" as const } })),
			sessionUpdate: vi.fn(async () => {}),
		});
		(
			unsupportedSession.connection as unknown as { unstable_setSessionModel: () => never }
		).unstable_setSessionModel = () => {
			throw new Error("not supported");
		};
		seedSession(manager, "unsupported", unsupportedSession);

		await manager.setModel("claude-sonnet-4.6");

		expect(manager.has("supported")).toBe(true);
		expect(manager.has("unsupported")).toBe(false);
	});

	it("is a no-op when there are no sessions", async () => {
		const manager = new AcpSessionManager();
		// Should not throw
		await manager.setModel("gpt-5.4");
	});
});

// ---------------------------------------------------------------------------
// 1c. AcpSessionManager — model discovery
// ---------------------------------------------------------------------------

describe("AcpSessionManager.getDiscoveredModels", () => {
	it("returns empty array before any session is created", () => {
		const manager = new AcpSessionManager();
		expect(manager.getDiscoveredModels()).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// 1c-2. AcpSessionManager.discoverModels — MCP server forwarding
// ---------------------------------------------------------------------------

describe("AcpSessionManager.discoverModels — MCP server forwarding", () => {
	beforeEach(() => {
		mockSpawn.mockReset();
		mockInitialize.mockReset();
		mockNewSession.mockReset();
		mockSetSessionModel.mockReset();
	});

	it("forwards configured MCP servers to newSession()", async () => {
		mockSpawn.mockReturnValueOnce(createMockProcess());
		mockInitialize.mockResolvedValueOnce({});
		mockNewSession.mockResolvedValueOnce({
			sessionId: "discover-session",
			models: {
				availableModels: [{ modelId: "gpt-5.4", name: "GPT 5.4" }],
			},
		});

		const manager = new AcpSessionManager();
		await manager.discoverModels("github-copilot", {
			githubCopilot: {},
			mcpServers: [
				{
					name: "postgres",
					command: "pg-mcp",
					args: ["--port", "5432"],
					env: { DB_HOST: "localhost" },
				},
				{ name: "github", command: "gh-mcp", args: [], env: {} },
			],
		});

		expect(mockNewSession).toHaveBeenCalledWith({
			cwd: expect.any(String),
			mcpServers: [
				{
					name: "postgres",
					command: "pg-mcp",
					args: ["--port", "5432"],
					env: [{ name: "DB_HOST", value: "localhost" }],
				},
				{
					name: "github",
					command: "gh-mcp",
					args: [],
					env: [],
				},
			],
		});
	});
});

// ---------------------------------------------------------------------------
// 1c-3. Crash-recovery exit handler — wired through real acquire()
// ---------------------------------------------------------------------------

describe("crash-recovery exit handler — stale-handler race guard", () => {
	const noopClient: acp.Client = {
		requestPermission: vi.fn(async () => ({
			outcome: { outcome: "cancelled" as const },
		})),
		sessionUpdate: vi.fn(async () => {}),
	};

	beforeEach(() => {
		mockSpawn.mockReset();
		mockInitialize.mockReset();
		mockNewSession.mockReset();
		mockSetSessionModel.mockReset();
	});

	/** Prepare mocks so the next acquire() completes and returns a controllable process. */
	function prepareAcquire(sessionId = "acp-session-1") {
		const proc = createMockProcess();
		mockSpawn.mockReturnValueOnce(proc);
		mockInitialize.mockResolvedValueOnce({});
		mockNewSession.mockResolvedValueOnce({
			sessionId,
			models: {},
		});
		return proc;
	}

	it("exit on current session removes it from the map", async () => {
		const proc = prepareAcquire();
		const manager = new AcpSessionManager();
		await manager.acquire("k", "github-copilot", { githubCopilot: {}, mcpServers: [] }, noopClient);

		expect(manager.has("k")).toBe(true);
		proc.emit("exit", 1, null);
		expect(manager.has("k")).toBe(false);
	});

	it("exit on stale process does NOT remove the replacement session", async () => {
		const procA = prepareAcquire("sess-a");
		const manager = new AcpSessionManager();
		await manager.acquire("k", "github-copilot", { githubCopilot: {}, mcpServers: [] }, noopClient);

		// cancel() deletes session A from the map and kills procA
		manager.cancel("k");
		expect(manager.has("k")).toBe(false);

		// Acquire session B for the same key
		prepareAcquire("sess-b");
		await manager.acquire("k", "github-copilot", { githubCopilot: {}, mcpServers: [] }, noopClient);
		expect(manager.has("k")).toBe(true);

		// Old process A finally exits (delayed)
		procA.emit("exit", 1, null);

		// Session B must survive — the stale handler must NOT delete it
		expect(manager.has("k")).toBe(true);
		// biome-ignore lint/suspicious/noExplicitAny: accessing private map for test
		expect((manager as any).sessions.get("k").sessionId).toBe("sess-b");
	});

	it("error on stale process does NOT remove the replacement session", async () => {
		const procA = prepareAcquire("sess-a");
		const manager = new AcpSessionManager();
		await manager.acquire("k", "github-copilot", { githubCopilot: {}, mcpServers: [] }, noopClient);

		manager.cancel("k");
		prepareAcquire("sess-b");
		await manager.acquire("k", "github-copilot", { githubCopilot: {}, mcpServers: [] }, noopClient);

		// Old process A errors out
		procA.emit("error", new Error("spawn failed"));

		expect(manager.has("k")).toBe(true);
		// biome-ignore lint/suspicious/noExplicitAny: accessing private map for test
		expect((manager as any).sessions.get("k").sessionId).toBe("sess-b");
	});
});

// ---------------------------------------------------------------------------
// 1d. Model exclusion policy
// ---------------------------------------------------------------------------

describe("isModelAllowed", () => {
	const patterns = ["claude-opus-*-fast"];

	it("allows normal models", () => {
		expect(isModelAllowed("claude-sonnet-4.6", patterns)).toBe(true);
		expect(isModelAllowed("claude-opus-4.6", patterns)).toBe(true);
		expect(isModelAllowed("gpt-5.4", patterns)).toBe(true);
	});

	it("excludes claude-opus-*-fast variants", () => {
		expect(isModelAllowed("claude-opus-4.6-fast", patterns)).toBe(false);
		expect(isModelAllowed("claude-opus-5-fast", patterns)).toBe(false);
		expect(isModelAllowed("claude-opus-4.7-fast", patterns)).toBe(false);
	});

	it("allows non-opus fast models", () => {
		expect(isModelAllowed("claude-sonnet-4.6-fast", patterns)).toBe(true);
	});

	it("allows everything when no patterns are configured", () => {
		expect(isModelAllowed("claude-opus-4.6-fast", [])).toBe(true);
	});
});

describe("getGithubCopilotReasoningEffortConfigId", () => {
	it("returns the Copilot reasoning_effort config id when present", () => {
		expect(
			getGithubCopilotReasoningEffortConfigId({
				configOptions: [{ id: "reasoning_effort" }],
			}),
		).toBe("reasoning_effort");
	});

	it("returns null when configOptions is absent", () => {
		expect(getGithubCopilotReasoningEffortConfigId({})).toBeNull();
	});

	it("returns null for non-Copilot thought-level selectors", () => {
		expect(
			getGithubCopilotReasoningEffortConfigId({
				configOptions: [{ id: "some_other_id" }],
			}),
		).toBeNull();
	});
});

describe("AcpSessionManager.acquire — reasoning effort via session/set_config_option", () => {
	beforeEach(() => {
		mockSpawn.mockReset();
		mockInitialize.mockReset();
		mockNewSession.mockReset();
		mockSetSessionModel.mockReset();
		mockSetSessionConfigOption.mockReset();
	});

	function primeAcquire(opts: {
		advertiseEffort?: boolean;
		sessionId?: string;
	} = {}) {
		const proc = createMockProcess();
		mockSpawn.mockReturnValueOnce(proc);
		mockInitialize.mockResolvedValueOnce({});
		mockNewSession.mockResolvedValueOnce({
			sessionId: opts.sessionId ?? "sess-effort",
			models: {},
			configOptions: opts.advertiseEffort
				? [
						{ id: "mode", category: "mode" },
						{ id: "model", category: "model" },
						{
							id: "reasoning_effort",
							category: "thought_level",
							currentValue: "medium",
						},
					]
				: [{ id: "mode", category: "mode" }],
		});
		return proc;
	}

	const effortNoopClient: acp.Client = {
		requestPermission: vi.fn(async () => ({ outcome: { outcome: "cancelled" as const } })),
		sessionUpdate: vi.fn(async () => {}),
	};

	it("calls setSessionConfigOption with the configured reasoningEffort for github-copilot", async () => {
		primeAcquire({ advertiseEffort: true });
		mockSetSessionConfigOption.mockResolvedValueOnce({ configOptions: [] });

		const manager = new AcpSessionManager();
		await manager.acquire(
			"task-1",
			"github-copilot",
			{
				githubCopilot: { reasoningEffort: "high" },
				mcpServers: [],
			},
			effortNoopClient,
		);

		expect(mockSetSessionConfigOption).toHaveBeenCalledOnce();
		expect(mockSetSessionConfigOption).toHaveBeenCalledWith({
			sessionId: "sess-effort",
			configId: "reasoning_effort",
			value: "high",
		});
	});

	it("does NOT call setSessionConfigOption when no reasoningEffort is configured", async () => {
		primeAcquire({ advertiseEffort: true });

		const manager = new AcpSessionManager();
		await manager.acquire(
			"task-2",
			"github-copilot",
			{ githubCopilot: {}, mcpServers: [] },
			effortNoopClient,
		);

		expect(mockSetSessionConfigOption).not.toHaveBeenCalled();
	});

	it("skips setSessionConfigOption when the agent does not advertise reasoning_effort", async () => {
		primeAcquire({ advertiseEffort: false });

		const manager = new AcpSessionManager();
		await manager.acquire(
			"task-3",
			"github-copilot",
			{
				githubCopilot: { reasoningEffort: "high" },
				mcpServers: [],
			},
			effortNoopClient,
		);

		expect(mockSetSessionConfigOption).not.toHaveBeenCalled();
	});

	it("ignores reasoningEffort for non-copilot providers", async () => {
		primeAcquire({ advertiseEffort: true });

		const manager = new AcpSessionManager();
		await manager.acquire(
			"task-4",
			"claude-cli",
			// biome-ignore lint/suspicious/noExplicitAny: exercising provider-gating
			{ githubCopilot: { reasoningEffort: "high" } as any, mcpServers: [] },
			effortNoopClient,
		);

		expect(mockSetSessionConfigOption).not.toHaveBeenCalled();
	});

	it("swallows errors from setSessionConfigOption (best-effort)", async () => {
		primeAcquire({ advertiseEffort: true });
		mockSetSessionConfigOption.mockRejectedValueOnce(new Error("Internal error"));

		const manager = new AcpSessionManager();
		await expect(
			manager.acquire(
				"task-5",
				"github-copilot",
				{
					githubCopilot: { reasoningEffort: "high" },
					mcpServers: [],
				},
				effortNoopClient,
			),
		).resolves.toBeDefined();

		expect(manager.has("task-5")).toBe(true);
	});
});

describe("AcpSessionManager.setModel — exclusion guard", () => {
	const patterns = ["claude-opus-*-fast"];

	it("rejects excluded models with an error", async () => {
		const manager = new AcpSessionManager(patterns);
		await expect(manager.setModel("claude-opus-4.6-fast")).rejects.toThrow("excluded by policy");
	});

	it("allows non-excluded models", async () => {
		const manager = new AcpSessionManager(patterns);
		// No sessions — setModel is a no-op but should not throw
		await expect(manager.setModel("claude-opus-4.6")).resolves.toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// 2. AcpAdapter — event routing and cleanup semantics
// ---------------------------------------------------------------------------

/**
 * Build a stub session manager for AcpAdapter tests.
 *
 * These tests verify the adapter's event wiring, output accumulation,
 * and session cleanup — NOT the delegate-swap logic (covered above).
 */
function makeStubSession(onPrompt: (delegate: ClientDelegate, callIndex: number) => Promise<void>) {
	const clientDelegate: ClientDelegate = {
		current: {
			requestPermission: async () => ({ outcome: { outcome: "cancelled" as const } }),
			sessionUpdate: async () => {},
		},
	};

	let promptCallCount = 0;

	const fakeConnection = {
		prompt: async () => {
			promptCallCount++;
			await onPrompt(clientDelegate, promptCallCount);
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
			// Replicate the swap so adapter callbacks land on the right client.
			// The swap's correctness is proven by the AcpSessionManager tests above.
			clientDelegate.current = client;
			return fakeSession;
		}),
		cancel: vi.fn(),
		has: vi.fn(() => false),
		dispose: vi.fn(async () => {}),
		setModel: vi.fn(async () => {}),
		getDiscoveredModels: vi.fn(() => []),
		discoverModels: vi.fn(async () => []),
	} as unknown as AcpSessionManager;

	return { stubManager, fakeSession };
}

describe("AcpAdapter session reuse — event routing", () => {
	it("second run receives its own text events, not the first run's sink", async () => {
		const config = configSchema.parse({});

		const { stubManager } = makeStubSession(async (delegate, callIndex) => {
			// Simulate ACP server emitting a text chunk
			await delegate.current.sessionUpdate({
				sessionId: "acp-session-1",
				update: {
					sessionUpdate: "agent_message_chunk",
					content: { type: "text", text: `chunk-from-run-${callIndex}` },
				},
			});
		});

		const adapter = new AcpAdapter(config, stubManager);

		// First run
		const events1: AdapterEvent[] = [];
		await adapter.run({
			prompt: "first",
			sessionId: "shared",
			onEvent: (e) => events1.push(e),
		});

		// Second run
		const events2: AdapterEvent[] = [];
		await adapter.run({
			prompt: "second",
			sessionId: "shared",
			onEvent: (e) => events2.push(e),
		});

		// First run saw only its own chunk
		expect(events1).toEqual([{ type: "text", text: "chunk-from-run-1" }]);
		// Second run saw only its own chunk
		expect(events2).toEqual([{ type: "text", text: "chunk-from-run-2" }]);
	});

	it("second run uses its own permission mode, not the first run's", async () => {
		const config = configSchema.parse({ llm: { permissionMode: "deny-all" } });

		const permissionOutcomes: string[] = [];

		const { stubManager } = makeStubSession(async (delegate) => {
			// Simulate ACP server requesting permission for "shell(rm)" (execute kind)
			const response = await delegate.current.requestPermission({
				sessionId: "acp-session-1",
				toolCall: { toolCallId: "c", title: "shell(rm)", status: "pending", kind: "execute" },
				options: [
					{ optionId: "allow", name: "Allow", kind: "allow_once" },
					{ optionId: "deny", name: "Deny", kind: "reject_once" },
				],
			});
			permissionOutcomes.push(response.outcome.outcome);
		});

		const adapter = new AcpAdapter(config, stubManager);

		// First run: approve-all → approve
		await adapter.run({
			prompt: "first",
			sessionId: "shared",
			permissionMode: "approve-all",
		});

		// Second run: deny-all → deny
		await adapter.run({
			prompt: "second",
			sessionId: "shared",
			permissionMode: "deny-all",
		});

		expect(permissionOutcomes).toEqual(["selected", "selected"]);
	});

	it("one-off sessions (no sessionId) are cleaned up after each run", async () => {
		const config = configSchema.parse({});

		const { stubManager } = makeStubSession(async () => {});

		const adapter = new AcpAdapter(config, stubManager);

		await adapter.run({ prompt: "ephemeral" });

		// cancel() should have been called for the generated one-off ID
		expect(vi.mocked(stubManager.cancel)).toHaveBeenCalledTimes(1);
	});

	it("persistent sessions (with sessionId) are NOT cleaned up", async () => {
		const config = configSchema.parse({});

		const { stubManager } = makeStubSession(async () => {});

		const adapter = new AcpAdapter(config, stubManager);

		await adapter.run({ prompt: "persistent", sessionId: "keep-alive" });
		await adapter.run({ prompt: "persistent-2", sessionId: "keep-alive" });

		expect(vi.mocked(stubManager.cancel)).not.toHaveBeenCalled();
	});

	it("setModel delegates to sessions.setModel and updates config.llm.model", async () => {
		const config = configSchema.parse({});

		const { stubManager } = makeStubSession(async () => {});

		const adapter = new AcpAdapter(config, stubManager);

		expect(config.llm.model).toBeUndefined();

		await adapter.setModel("gemini-2.5-pro");

		expect(config.llm.model).toBe("gemini-2.5-pro");
		expect(vi.mocked(stubManager.setModel)).toHaveBeenCalledOnce();
		expect(vi.mocked(stubManager.setModel)).toHaveBeenCalledWith("gemini-2.5-pro");
	});

	it("getAvailableModels delegates to sessions.getDiscoveredModels", () => {
		const config = configSchema.parse({});

		const discovered: DiscoveredModel[] = [
			{ id: "gpt-5.4", name: "GPT 5.4" },
			{ id: "claude-sonnet-4.6", name: "Claude Sonnet 4.6" },
		];

		const { stubManager } = makeStubSession(async () => {});
		(
			stubManager as unknown as { getDiscoveredModels: () => DiscoveredModel[] }
		).getDiscoveredModels = vi.fn(() => discovered);

		const adapter = new AcpAdapter(config, stubManager);

		expect(adapter.getAvailableModels()).toEqual(discovered);
	});

	it("discoverModels delegates to sessions.discoverModels", async () => {
		const config = configSchema.parse({});

		const discovered: DiscoveredModel[] = [
			{ id: "gpt-5.4", name: "GPT 5.4" },
			{ id: "claude-sonnet-4.6", name: "Claude Sonnet 4.6" },
		];

		const { stubManager } = makeStubSession(async () => {});
		(
			stubManager as unknown as {
				discoverModels: () => Promise<DiscoveredModel[]>;
			}
		).discoverModels = vi.fn(async () => discovered);

		const adapter = new AcpAdapter(config, stubManager);

		const result = await adapter.discoverModels();
		expect(result).toEqual(discovered);
	});
});
