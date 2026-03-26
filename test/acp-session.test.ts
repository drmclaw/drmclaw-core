import type * as acp from "@agentclientprotocol/sdk";
import { describe, expect, it, vi } from "vitest";
import { configSchema } from "../src/config/schema.js";
import { type AcpSession, AcpSessionManager, type ClientDelegate } from "../src/llm/acp-session.js";
import { AcpAdapter } from "../src/llm/acp.js";
import type { AdapterEvent } from "../src/llm/adapter.js";

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
			{ githubCopilot: {} },
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
			{ githubCopilot: {} },
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
			{ githubCopilot: {} },
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
		await manager.acquire("shared", "github-copilot", { githubCopilot: {} }, secondClient);

		// Trigger the connection callback — should hit secondClient
		await fakeConnection.prompt();

		expect(calls).toEqual(["second"]);
		expect(secondClient.requestPermission).toHaveBeenCalledTimes(1);
		expect(firstClient.requestPermission).not.toHaveBeenCalled();
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

	it("second run uses its own tool policy, not the first run's allowlist", async () => {
		const config = configSchema.parse({ llm: { allowedTools: [] } });

		const permissionOutcomes: string[] = [];

		const { stubManager } = makeStubSession(async (delegate) => {
			// Simulate ACP server requesting permission for "shell(rm)"
			const response = await delegate.current.requestPermission({
				sessionId: "acp-session-1",
				toolCall: { toolCallId: "c", title: "shell(rm)", status: "pending" },
				options: [
					{ optionId: "allow", name: "Allow", kind: "allow_once" },
					{ optionId: "deny", name: "Deny", kind: "reject_once" },
				],
			});
			permissionOutcomes.push(response.outcome.outcome);
		});

		const adapter = new AcpAdapter(config, stubManager);

		// First run: allowedTools includes shell(rm) → approve
		await adapter.run({
			prompt: "first",
			sessionId: "shared",
			allowedTools: ["shell(rm)"],
		});

		// Second run: allowedTools is ["write"] only → deny shell(rm)
		await adapter.run({
			prompt: "second",
			sessionId: "shared",
			allowedTools: ["write"],
		});

		expect(permissionOutcomes).toEqual(["selected", "cancelled"]);
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
});
