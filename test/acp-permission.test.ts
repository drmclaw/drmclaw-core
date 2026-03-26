import type { RequestPermissionRequest, ToolKind } from "@agentclientprotocol/sdk";
import { describe, expect, it, vi } from "vitest";
import { evaluatePermission } from "../src/llm/acp.js";
import type { LLMAdapterRunOptions } from "../src/llm/adapter.js";

/**
 * ACP permission-flow test — exercises the REAL `evaluatePermission`
 * function exported from acp.ts, using ACP SDK types for
 * request/response shapes.
 *
 * Decision matrix:
 *   - empty allowlist → approve all  ("selected" + optionId)
 *   - allowlisted tool → approve     ("selected" + optionId)
 *   - non-allowlisted, no onToolCall → deny ("cancelled")
 *   - non-allowlisted, onToolCall returns "approved" → "selected"
 *   - non-allowlisted, onToolCall returns "denied"   → "cancelled"
 */

/** Build a minimal `RequestPermissionRequest` fixture. */
function makePermissionRequest(toolTitle: string, kind?: ToolKind): RequestPermissionRequest {
	return {
		sessionId: "test-session",
		toolCall: {
			toolCallId: "call-1",
			title: toolTitle,
			status: "pending",
			...(kind !== undefined ? { kind } : {}),
		},
		options: [
			{ optionId: "allow", name: "Allow", kind: "allow_once" },
			{ optionId: "deny", name: "Deny", kind: "reject_once" },
		],
	};
}

describe("ACP permission flow (real evaluatePermission)", () => {
	it("approves all tools when allowlist is empty (wildcard mode)", async () => {
		const res = await evaluatePermission(makePermissionRequest("shell(rm)"), new Set());
		expect(res.outcome.outcome).toBe("selected");
		if (res.outcome.outcome === "selected") {
			expect(res.outcome.optionId).toBe("allow");
		}
	});

	it("approves a tool that is in the allowlist", async () => {
		const allowlist = new Set(["shell(git)", "write"]);

		const res1 = await evaluatePermission(makePermissionRequest("shell(git)"), allowlist);
		expect(res1.outcome.outcome).toBe("selected");

		const res2 = await evaluatePermission(makePermissionRequest("write"), allowlist);
		expect(res2.outcome.outcome).toBe("selected");
	});

	it("denies a tool not in the allowlist when no onToolCall callback", async () => {
		const allowlist = new Set(["shell(git)"]);
		const res = await evaluatePermission(makePermissionRequest("shell(rm)"), allowlist);
		expect(res.outcome.outcome).toBe("cancelled");
	});

	it("delegates to onToolCall for non-allowlisted tools and respects approval", async () => {
		const allowlist = new Set(["shell(git)"]);
		const onToolCall = vi.fn(async () => "approved" as const);

		const res = await evaluatePermission(makePermissionRequest("shell(rm)"), allowlist, onToolCall);
		expect(res.outcome.outcome).toBe("selected");
		if (res.outcome.outcome === "selected") {
			expect(res.outcome.optionId).toBe("allow");
		}
		expect(onToolCall).toHaveBeenCalledWith(
			"shell(rm)",
			expect.objectContaining({ sessionId: "test-session" }),
		);
	});

	it("delegates to onToolCall for non-allowlisted tools and respects denial", async () => {
		const allowlist = new Set(["shell(git)"]);
		const onToolCall = vi.fn(async () => "denied" as const);

		const res = await evaluatePermission(makePermissionRequest("shell(rm)"), allowlist, onToolCall);
		expect(res.outcome.outcome).toBe("cancelled");
		expect(onToolCall).toHaveBeenCalledWith(
			"shell(rm)",
			expect.objectContaining({ sessionId: "test-session" }),
		);
	});

	it("does NOT call onToolCall for allowlisted tools", async () => {
		const allowlist = new Set(["write"]);
		const onToolCall = vi.fn(async () => "denied" as const);

		const res = await evaluatePermission(makePermissionRequest("write"), allowlist, onToolCall);
		expect(res.outcome.outcome).toBe("selected");
		expect(onToolCall).not.toHaveBeenCalled();
	});

	it("does NOT call onToolCall in wildcard mode (empty allowlist)", async () => {
		const onToolCall = vi.fn(async () => "denied" as const);

		const res = await evaluatePermission(makePermissionRequest("anything"), new Set(), onToolCall);
		expect(res.outcome.outcome).toBe("selected");
		expect(onToolCall).not.toHaveBeenCalled();
	});

	it("picks the first allow_once/allow_always option for optionId", async () => {
		const req: RequestPermissionRequest = {
			sessionId: "s",
			toolCall: { toolCallId: "c", title: "tool", status: "pending" },
			options: [
				{ optionId: "reject-it", name: "Deny", kind: "reject_once" },
				{ optionId: "always-yes", name: "Always", kind: "allow_always" },
				{ optionId: "once-yes", name: "Once", kind: "allow_once" },
			],
		};
		const res = await evaluatePermission(req, new Set());
		expect(res.outcome.outcome).toBe("selected");
		if (res.outcome.outcome === "selected") {
			// Should pick "always-yes" (first allow-* option), not "reject-it"
			expect(res.outcome.optionId).toBe("always-yes");
		}
	});
});

describe("ACP permission flow via AcpRuntime integration", () => {
	it("runtime passes policy.toolAllowlist to adapter.run as allowedTools", async () => {
		const { AcpRuntime } = await import("../src/runtime/agent.js");
		const { configSchema } = await import("../src/config/schema.js");

		const config = configSchema.parse({
			llm: { allowedTools: ["default-tool"] },
		});

		const capturedOptions: LLMAdapterRunOptions[] = [];
		const mockAdapter = {
			run: vi.fn(async (opts: LLMAdapterRunOptions) => {
				capturedOptions.push(opts);
				return { status: "completed" as const, output: "ok", durationMs: 1 };
			}),
			dispose: vi.fn(async () => {}),
		};

		const runtime = new AcpRuntime(config, mockAdapter);

		// Run with a policy override
		await runtime.run({
			backend: "acp",
			prompt: "test",
			skills: [],
			policy: { toolAllowlist: ["shell(git)", "write"] },
		});

		expect(capturedOptions).toHaveLength(1);
		expect(capturedOptions[0].allowedTools).toEqual(["shell(git)", "write"]);

		// Run without a policy override — should fall back to config defaults
		await runtime.run({
			backend: "acp",
			prompt: "test2",
			skills: [],
		});

		expect(capturedOptions).toHaveLength(2);
		expect(capturedOptions[1].allowedTools).toEqual(["default-tool"]);
	});

	it("empty policy.toolAllowlist overrides config (produces wildcard)", async () => {
		const { AcpRuntime } = await import("../src/runtime/agent.js");
		const { configSchema } = await import("../src/config/schema.js");

		const config = configSchema.parse({
			llm: { allowedTools: ["restricted-tool"] },
		});

		const capturedOptions: LLMAdapterRunOptions[] = [];
		const mockAdapter = {
			run: vi.fn(async (opts: LLMAdapterRunOptions) => {
				capturedOptions.push(opts);
				return { status: "completed" as const, output: "ok", durationMs: 1 };
			}),
			dispose: vi.fn(async () => {}),
		};

		const runtime = new AcpRuntime(config, mockAdapter);

		// Empty array override = wildcard (allow all), NOT config fallback
		await runtime.run({
			backend: "acp",
			prompt: "test",
			skills: [],
			policy: { toolAllowlist: [] },
		});

		expect(capturedOptions).toHaveLength(1);
		expect(capturedOptions[0].allowedTools).toEqual([]);
	});
});

describe("AcpAdapter permission wiring", () => {
	it("adapter builds allowedTools Set from options and delegates to evaluatePermission", async () => {
		const { configSchema } = await import("../src/config/schema.js");
		const config = configSchema.parse({
			llm: { allowedTools: ["config-tool"] },
		});

		// We can't easily test the full AcpAdapter without spawning a process,
		// but we can verify that evaluatePermission, given the same Set the
		// adapter would build, produces the correct outcome.

		// Adapter line: new Set(options.allowedTools ?? this.config.llm.allowedTools)

		// Case 1: options.allowedTools provided → uses that, ignores config
		const fromOptions = new Set(["shell(git)", "write"]);
		const res1 = await evaluatePermission(makePermissionRequest("shell(git)"), fromOptions);
		expect(res1.outcome.outcome).toBe("selected");
		const res2 = await evaluatePermission(makePermissionRequest("config-tool"), fromOptions);
		expect(res2.outcome.outcome).toBe("cancelled"); // config-tool not in options set

		// Case 2: options.allowedTools undefined → falls back to config
		const fromConfig = new Set(config.llm.allowedTools);
		const res3 = await evaluatePermission(makePermissionRequest("config-tool"), fromConfig);
		expect(res3.outcome.outcome).toBe("selected");
		const res4 = await evaluatePermission(makePermissionRequest("shell(git)"), fromConfig);
		expect(res4.outcome.outcome).toBe("cancelled"); // shell(git) not in config

		// Case 3: options.allowedTools is empty → wildcard (all approved)
		const fromEmpty = new Set<string>([]);
		const res5 = await evaluatePermission(makePermissionRequest("anything"), fromEmpty);
		expect(res5.outcome.outcome).toBe("selected");
	});

	it("adapter passes onToolCall through to evaluatePermission", async () => {
		// Verifies the bridge: AcpAdapter.run() calls
		//   evaluatePermission(params, allowedTools, options.onToolCall)
		// We test that evaluatePermission correctly uses onToolCall when
		// the adapter would pass a restricted Set + callback.
		const allowedTools = new Set(["write"]);
		const onToolCall = vi.fn(async () => "approved" as const);

		// Tool not in allowlist → delegates to onToolCall
		const res = await evaluatePermission(
			makePermissionRequest("shell(rm)"),
			allowedTools,
			onToolCall,
		);
		expect(res.outcome.outcome).toBe("selected");
		expect(onToolCall).toHaveBeenCalledWith(
			"shell(rm)",
			expect.objectContaining({ sessionId: "test-session" }),
		);
	});
});

describe("evaluatePermission edge cases", () => {
	it("handles toolCall with empty title in permission request", async () => {
		const req: RequestPermissionRequest = {
			sessionId: "s",
			toolCall: { toolCallId: "c", title: "", status: "pending" },
			options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
		};
		// Empty title "" is not in the allowlist → denied
		const allowlist = new Set(["write"]);
		const res = await evaluatePermission(req, allowlist);
		expect(res.outcome.outcome).toBe("cancelled");
	});

	it("handles toolCall with empty title in wildcard mode", async () => {
		const req: RequestPermissionRequest = {
			sessionId: "s",
			toolCall: { toolCallId: "c", title: "", status: "pending" },
			options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
		};
		// Wildcard mode → approved even with empty title
		const res = await evaluatePermission(req, new Set());
		expect(res.outcome.outcome).toBe("selected");
	});

	it("handles request with no options gracefully", async () => {
		const req: RequestPermissionRequest = {
			sessionId: "s",
			toolCall: { toolCallId: "c", title: "shell(ls)", status: "pending" },
			options: [],
		};
		// Wildcard mode, no options → falls back to "allow" as optionId
		const res = await evaluatePermission(req, new Set());
		expect(res.outcome.outcome).toBe("selected");
		if (res.outcome.outcome === "selected") {
			expect(res.outcome.optionId).toBe("allow");
		}
	});
});

describe("evaluatePermission kind-based filtering", () => {
	it("approves tool whose kind is in the allowedToolKinds set", async () => {
		const kindSet = new Set(["read"]);
		const res = await evaluatePermission(
			makePermissionRequest("Viewing file.ts", "read"),
			new Set(),
			undefined,
			kindSet,
		);
		expect(res.outcome.outcome).toBe("selected");
	});

	it("denies tool whose kind is NOT in allowedToolKinds set", async () => {
		const kindSet = new Set(["read"]);
		const res = await evaluatePermission(
			makePermissionRequest("Get git commits", "execute"),
			new Set(),
			undefined,
			kindSet,
		);
		expect(res.outcome.outcome).toBe("cancelled");
	});

	it("empty allowedToolKinds allows all kinds (wildcard)", async () => {
		const kindSet = new Set<string>();
		const res = await evaluatePermission(
			makePermissionRequest("shell(rm)", "execute"),
			new Set(),
			undefined,
			kindSet,
		);
		expect(res.outcome.outcome).toBe("selected");
	});

	it("undefined allowedToolKinds allows all kinds", async () => {
		const res = await evaluatePermission(
			makePermissionRequest("shell(rm)", "execute"),
			new Set(),
			undefined,
			undefined,
		);
		expect(res.outcome.outcome).toBe("selected");
	});

	it("denies tool with missing kind when allowedToolKinds is non-empty", async () => {
		// Real ACP events sometimes have no kind field — must not sneak through
		const kindSet = new Set(["read"]);
		const res = await evaluatePermission(
			makePermissionRequest("unknown-tool"),
			new Set(),
			undefined,
			kindSet,
		);
		expect(res.outcome.outcome).toBe("cancelled");
	});

	it("both title and kind must pass when both filters are active", async () => {
		const titleSet = new Set(["shell(git)"]);
		const kindSet = new Set(["read"]);

		// Title matches but kind doesn't → denied
		const res1 = await evaluatePermission(
			makePermissionRequest("shell(git)", "execute"),
			titleSet,
			undefined,
			kindSet,
		);
		expect(res1.outcome.outcome).toBe("cancelled");

		// Kind matches but title doesn't → denied
		const res2 = await evaluatePermission(
			makePermissionRequest("Viewing file", "read"),
			titleSet,
			undefined,
			kindSet,
		);
		expect(res2.outcome.outcome).toBe("cancelled");

		// Both match → approved
		const res3 = await evaluatePermission(
			makePermissionRequest("shell(git)", "read"),
			titleSet,
			undefined,
			kindSet,
		);
		expect(res3.outcome.outcome).toBe("selected");
	});

	it("delegates to onToolCall when kind is denied (not title denied)", async () => {
		const kindSet = new Set(["read"]);
		const onToolCall = vi.fn(async () => "approved" as const);

		const res = await evaluatePermission(
			makePermissionRequest("shell(rm)", "execute"),
			new Set(), // title wildcard
			onToolCall,
			kindSet,
		);
		expect(res.outcome.outcome).toBe("selected");
		expect(onToolCall).toHaveBeenCalledWith(
			"shell(rm)",
			expect.objectContaining({ sessionId: "test-session" }),
		);
	});

	it("denies via onToolCall when kind fails and callback returns denied", async () => {
		const kindSet = new Set(["read"]);
		const onToolCall = vi.fn(async () => "denied" as const);

		const res = await evaluatePermission(
			makePermissionRequest("shell(rm)", "execute"),
			new Set(),
			onToolCall,
			kindSet,
		);
		expect(res.outcome.outcome).toBe("cancelled");
	});

	it("multiple allowed kinds work correctly", async () => {
		const kindSet = new Set(["read", "search", "think"]);

		const res1 = await evaluatePermission(
			makePermissionRequest("Search files", "search"),
			new Set(),
			undefined,
			kindSet,
		);
		expect(res1.outcome.outcome).toBe("selected");

		const res2 = await evaluatePermission(
			makePermissionRequest("Reasoning", "think"),
			new Set(),
			undefined,
			kindSet,
		);
		expect(res2.outcome.outcome).toBe("selected");

		const res3 = await evaluatePermission(
			makePermissionRequest("Edit file", "edit"),
			new Set(),
			undefined,
			kindSet,
		);
		expect(res3.outcome.outcome).toBe("cancelled");
	});
});

describe("AcpRuntime kind-based filtering integration", () => {
	it("runtime passes policy.toolKindAllowlist to adapter as allowedToolKinds", async () => {
		const { AcpRuntime } = await import("../src/runtime/agent.js");
		const { configSchema } = await import("../src/config/schema.js");

		const config = configSchema.parse({
			llm: { allowedToolKinds: ["read", "search"] },
		});

		const capturedOptions: LLMAdapterRunOptions[] = [];
		const mockAdapter = {
			run: vi.fn(async (opts: LLMAdapterRunOptions) => {
				capturedOptions.push(opts);
				return { status: "completed" as const, output: "ok", durationMs: 1 };
			}),
			dispose: vi.fn(async () => {}),
		};

		const runtime = new AcpRuntime(config, mockAdapter);

		// Policy override
		await runtime.run({
			backend: "acp",
			prompt: "test",
			skills: [],
			policy: { toolKindAllowlist: ["read"] },
		});
		expect(capturedOptions[0].allowedToolKinds).toEqual(["read"]);

		// Falls back to config default
		await runtime.run({
			backend: "acp",
			prompt: "test2",
			skills: [],
		});
		expect(capturedOptions[1].allowedToolKinds).toEqual(["read", "search"]);
	});
});
