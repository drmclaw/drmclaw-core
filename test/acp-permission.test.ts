import type { RequestPermissionRequest, ToolKind } from "@agentclientprotocol/sdk";
import { describe, expect, it, vi } from "vitest";
import { evaluatePermission } from "../src/llm/acp.js";
import type { LLMAdapterRunOptions, PermissionMode } from "../src/llm/adapter.js";

/**
 * ACP permission-flow test — exercises the REAL `evaluatePermission`
 * function exported from acp.ts, using ACP SDK types.
 *
 * Three permission modes:
 *   - "approve-all"   → approve every tool call
 *   - "approve-reads" → approve read/search/think/fetch kinds, reject others
 *   - "deny-all"      → reject every tool call
 *
 * The onToolCall callback overrides mode decisions for rejected tools.
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

// ---------------------------------------------------------------------------
// approve-all mode
// ---------------------------------------------------------------------------
describe("evaluatePermission — approve-all mode", () => {
	it("approves any tool regardless of kind", async () => {
		const res = await evaluatePermission(
			makePermissionRequest("shell(rm)", "execute"),
			"approve-all",
		);
		expect(res.outcome.outcome).toBe("selected");
		if (res.outcome.outcome === "selected") {
			expect(res.outcome.optionId).toBe("allow");
		}
	});

	it("approves read tools", async () => {
		const res = await evaluatePermission(makePermissionRequest("read_file", "read"), "approve-all");
		expect(res.outcome.outcome).toBe("selected");
		if (res.outcome.outcome === "selected") {
			expect(res.outcome.optionId).toBe("allow");
		}
	});

	it("approves tools with no kind", async () => {
		const res = await evaluatePermission(makePermissionRequest("unknown_tool"), "approve-all");
		expect(res.outcome.outcome).toBe("selected");
		if (res.outcome.outcome === "selected") {
			expect(res.outcome.optionId).toBe("allow");
		}
	});

	it("does NOT invoke onToolCall (everything is approved)", async () => {
		const onToolCall = vi.fn(async () => "denied" as const);
		const res = await evaluatePermission(
			makePermissionRequest("shell(rm)", "execute"),
			"approve-all",
			onToolCall,
		);
		expect(res.outcome.outcome).toBe("selected");
		expect(onToolCall).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// deny-all mode
// ---------------------------------------------------------------------------
describe("evaluatePermission — deny-all mode", () => {
	it("rejects any tool regardless of kind", async () => {
		const res = await evaluatePermission(makePermissionRequest("read_file", "read"), "deny-all");
		expect(res.outcome.outcome).toBe("selected");
		if (res.outcome.outcome === "selected") {
			expect(res.outcome.optionId).toBe("deny");
		}
	});

	it("rejects write tools", async () => {
		const res = await evaluatePermission(makePermissionRequest("write_file", "edit"), "deny-all");
		expect(res.outcome.outcome).toBe("selected");
		if (res.outcome.outcome === "selected") {
			expect(res.outcome.optionId).toBe("deny");
		}
	});

	it("delegates to onToolCall and respects approval override", async () => {
		const onToolCall = vi.fn(async () => "approved" as const);
		const res = await evaluatePermission(
			makePermissionRequest("read_file", "read"),
			"deny-all",
			onToolCall,
		);
		expect(res.outcome.outcome).toBe("selected");
		if (res.outcome.outcome === "selected") {
			expect(res.outcome.optionId).toBe("allow");
		}
		expect(onToolCall).toHaveBeenCalledWith(
			"read_file",
			expect.objectContaining({ sessionId: "test-session" }),
		);
	});

	it("delegates to onToolCall and respects denial", async () => {
		const onToolCall = vi.fn(async () => "denied" as const);
		const res = await evaluatePermission(
			makePermissionRequest("read_file", "read"),
			"deny-all",
			onToolCall,
		);
		expect(res.outcome.outcome).toBe("selected");
		if (res.outcome.outcome === "selected") {
			expect(res.outcome.optionId).toBe("deny");
		}
	});
});

// ---------------------------------------------------------------------------
// approve-reads mode
// ---------------------------------------------------------------------------
describe("evaluatePermission — approve-reads mode", () => {
	it.each(["read", "search", "think", "fetch"] as const)("approves %s kind tools", async (kind) => {
		const res = await evaluatePermission(
			makePermissionRequest(`tool-${kind}`, kind),
			"approve-reads",
		);
		expect(res.outcome.outcome).toBe("selected");
		if (res.outcome.outcome === "selected") {
			expect(res.outcome.optionId).toBe("allow");
		}
	});

	it.each(["edit", "delete", "move", "execute", "switch_mode"] as const)(
		"rejects %s kind tools",
		async (kind) => {
			const res = await evaluatePermission(
				makePermissionRequest(`tool-${kind}`, kind),
				"approve-reads",
			);
			expect(res.outcome.outcome).toBe("selected");
			if (res.outcome.outcome === "selected") {
				expect(res.outcome.optionId).toBe("deny");
			}
		},
	);

	it("rejects tools with no kind (defaults to empty string)", async () => {
		const res = await evaluatePermission(makePermissionRequest("mysterious_tool"), "approve-reads");
		expect(res.outcome.outcome).toBe("selected");
		if (res.outcome.outcome === "selected") {
			expect(res.outcome.optionId).toBe("deny");
		}
	});

	it("delegates to onToolCall for rejected write tool and respects approval", async () => {
		const onToolCall = vi.fn(async () => "approved" as const);
		const res = await evaluatePermission(
			makePermissionRequest("write_to_file", "edit"),
			"approve-reads",
			onToolCall,
		);
		expect(res.outcome.outcome).toBe("selected");
		if (res.outcome.outcome === "selected") {
			expect(res.outcome.optionId).toBe("allow");
		}
		expect(onToolCall).toHaveBeenCalledWith(
			"write_to_file",
			expect.objectContaining({ sessionId: "test-session" }),
		);
	});

	it("does NOT invoke onToolCall for approved read tool", async () => {
		const onToolCall = vi.fn(async () => "denied" as const);
		const res = await evaluatePermission(
			makePermissionRequest("read_file", "read"),
			"approve-reads",
			onToolCall,
		);
		expect(res.outcome.outcome).toBe("selected");
		if (res.outcome.outcome === "selected") {
			expect(res.outcome.optionId).toBe("allow");
		}
		expect(onToolCall).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// ACP protocol correctness — never returns "cancelled"
// ---------------------------------------------------------------------------
describe("evaluatePermission never returns cancelled", () => {
	it.each<PermissionMode>(["approve-all", "approve-reads", "deny-all"])(
		"%s mode always returns 'selected' outcome",
		async (mode) => {
			const res = await evaluatePermission(makePermissionRequest("shell(rm)", "execute"), mode);
			expect(res.outcome.outcome).toBe("selected");
		},
	);
});

// ---------------------------------------------------------------------------
// Option picking
// ---------------------------------------------------------------------------
describe("evaluatePermission option selection", () => {
	it("picks the first allow_once/allow_always option for approved tools", async () => {
		const req: RequestPermissionRequest = {
			sessionId: "s",
			toolCall: { toolCallId: "c", title: "tool", status: "pending", kind: "read" },
			options: [
				{ optionId: "reject-it", name: "Deny", kind: "reject_once" },
				{ optionId: "always-yes", name: "Always", kind: "allow_always" },
				{ optionId: "once-yes", name: "Once", kind: "allow_once" },
			],
		};
		const res = await evaluatePermission(req, "approve-all");
		expect(res.outcome.outcome).toBe("selected");
		if (res.outcome.outcome === "selected") {
			expect(res.outcome.optionId).toBe("always-yes");
		}
	});

	it("picks the first reject_once/reject_always option for denied tools", async () => {
		const req: RequestPermissionRequest = {
			sessionId: "s",
			toolCall: { toolCallId: "c", title: "rm", status: "pending", kind: "execute" },
			options: [
				{ optionId: "allow-always", name: "Allow", kind: "allow_always" },
				{ optionId: "reject-always", name: "Reject", kind: "reject_always" },
				{ optionId: "reject-once", name: "Reject Once", kind: "reject_once" },
			],
		};
		const res = await evaluatePermission(req, "deny-all");
		expect(res.outcome.outcome).toBe("selected");
		if (res.outcome.outcome === "selected") {
			expect(res.outcome.optionId).toBe("reject-always");
		}
	});

	it("falls back to 'allow' when no allow-* option exists", async () => {
		const req: RequestPermissionRequest = {
			sessionId: "s",
			toolCall: { toolCallId: "c", title: "tool", status: "pending", kind: "read" },
			options: [],
		};
		const res = await evaluatePermission(req, "approve-all");
		expect(res.outcome.outcome).toBe("selected");
		if (res.outcome.outcome === "selected") {
			expect(res.outcome.optionId).toBe("allow");
		}
	});

	it("falls back to 'reject' when no reject-* option exists", async () => {
		const req: RequestPermissionRequest = {
			sessionId: "s",
			toolCall: { toolCallId: "c", title: "rm", status: "pending", kind: "execute" },
			options: [],
		};
		const res = await evaluatePermission(req, "deny-all");
		expect(res.outcome.outcome).toBe("selected");
		if (res.outcome.outcome === "selected") {
			expect(res.outcome.optionId).toBe("reject");
		}
	});
});

// ---------------------------------------------------------------------------
// AcpRuntime integration — mode plumbing
// ---------------------------------------------------------------------------
describe("AcpRuntime permission mode integration", () => {
	it("runtime passes policy.permissionMode to adapter", async () => {
		const { AcpRuntime } = await import("../src/runtime/agent.js");
		const { configSchema } = await import("../src/config/schema.js");

		const config = configSchema.parse({
			llm: { permissionMode: "deny-all" },
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
			policy: { permissionMode: "approve-all" },
		});
		expect(capturedOptions[0].permissionMode).toBe("approve-all");

		// Falls back to config default
		await runtime.run({
			backend: "acp",
			prompt: "test2",
			skills: [],
		});
		expect(capturedOptions[1].permissionMode).toBe("deny-all");
	});

	it("runtime uses default config permissionMode (approve-all)", async () => {
		const { AcpRuntime } = await import("../src/runtime/agent.js");
		const { configSchema } = await import("../src/config/schema.js");

		const config = configSchema.parse({});

		const capturedOptions: LLMAdapterRunOptions[] = [];
		const mockAdapter = {
			run: vi.fn(async (opts: LLMAdapterRunOptions) => {
				capturedOptions.push(opts);
				return { status: "completed" as const, output: "ok", durationMs: 1 };
			}),
			dispose: vi.fn(async () => {}),
		};

		const runtime = new AcpRuntime(config, mockAdapter);
		await runtime.run({ backend: "acp", prompt: "test", skills: [] });

		expect(capturedOptions[0].permissionMode).toBe("approve-all");
	});
});
