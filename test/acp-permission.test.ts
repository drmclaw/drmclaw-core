import type { RequestPermissionRequest } from "@agentclientprotocol/sdk";
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
function makePermissionRequest(toolTitle: string): RequestPermissionRequest {
	return {
		sessionId: "test-session",
		toolCall: {
			toolCallId: "call-1",
			title: toolTitle,
			status: "pending",
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
});
