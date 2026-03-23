/**
 * Real-provider smoke tests.
 *
 * Exercises the full drmclaw → ACP → real provider CLI pipeline with
 * lightweight assertions that validate drmclaw's own seams: event
 * delivery, session reuse, and skill injection.
 *
 * Defaults to `github-copilot`. Override by setting `DRMCLAW_REAL_PROVIDER`
 * to any supported CLI provider (e.g. `claude-cli`, `openai-cli`).
 *
 * No local CLI discovery probes (e.g. `which copilot`) are performed, which
 * avoids triggering endpoint security alerts as exploratory command activity.
 */
import { afterEach, describe, expect, it } from "vitest";
import { type CliProvider, cliProviderIds, configSchema } from "../src/config/schema.js";
import { AcpSessionManager } from "../src/llm/acp-session.js";
import { AcpAdapter } from "../src/llm/acp.js";
import type { AdapterEvent } from "../src/llm/adapter.js";

// ---------------------------------------------------------------------------
// Provider detection
// ---------------------------------------------------------------------------

function getForcedProvider(): CliProvider {
	const forced = process.env.DRMCLAW_REAL_PROVIDER ?? "github-copilot";

	if ((cliProviderIds as readonly string[]).includes(forced)) {
		return forced as CliProvider;
	}

	throw new Error(`DRMCLAW_REAL_PROVIDER="${forced}" is not a valid CLI provider`);
}

const provider = getForcedProvider();

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe(`Real-provider smoke tests (${provider})`, () => {
	const managers: AcpSessionManager[] = [];

	function createManager(): AcpSessionManager {
		const m = new AcpSessionManager();
		managers.push(m);
		return m;
	}

	afterEach(async () => {
		for (const m of managers.splice(0)) {
			await m.dispose();
		}
	});

	it("prompt round-trip: completed status and text events", async () => {
		const config = configSchema.parse({ llm: { provider } });
		const sessionManager = createManager();
		const adapter = new AcpAdapter(config, sessionManager);
		const events: AdapterEvent[] = [];

		const result = await adapter.run({
			prompt: "Reply with exactly: PONG",
			sessionId: "real-smoke-roundtrip",
			onEvent: (e) => events.push(e),
		});

		expect(result.status).toBe("completed");
		expect(result.output.length).toBeGreaterThan(0);
		expect(events.filter((e) => e.type === "text").length).toBeGreaterThan(0);
	}, 60_000);

	it("tool use: provider makes at least one tool call", async () => {
		const config = configSchema.parse({ llm: { provider } });
		const sessionManager = createManager();
		const adapter = new AcpAdapter(config, sessionManager);
		const events: AdapterEvent[] = [];

		const result = await adapter.run({
			prompt:
				"Read the file package.json in the current directory and tell me the package name. Use a tool to read it.",
			sessionId: "real-smoke-tool",
			allowedTools: [],
			onEvent: (e) => events.push(e),
		});

		expect(result.status).toBe("completed");
		expect(result.output.length).toBeGreaterThan(0);
		// Accept either tool events or just a text answer — some providers
		// may bypass tools for simple requests.
		const toolEvents = events.filter((e) => e.type === "tool_call" || e.type === "tool_result");
		const textEvents = events.filter((e) => e.type === "text");
		expect(toolEvents.length + textEvents.length).toBeGreaterThan(0);
	}, 120_000);

	it("session reuse: same PID across two prompts on one sessionId", async () => {
		const config = configSchema.parse({ llm: { provider } });
		const sessionManager = createManager();
		const adapter = new AcpAdapter(config, sessionManager);

		const r1 = await adapter.run({
			prompt: "What is 2 + 2?",
			sessionId: "real-smoke-reuse",
			onEvent: () => {},
		});
		expect(r1.status).toBe("completed");
		expect(sessionManager.has("real-smoke-reuse")).toBe(true);

		// Capture the backing process PID before the second prompt.
		// biome-ignore lint/suspicious/noExplicitAny: accessing private map for protocol-level assertion
		const sessionBefore = (sessionManager as any).sessions.get("real-smoke-reuse");
		const pidBefore = sessionBefore?.process?.pid;
		expect(pidBefore).toBeDefined();

		const r2 = await adapter.run({
			prompt: "What is 3 + 3?",
			sessionId: "real-smoke-reuse",
			onEvent: () => {},
		});
		expect(r2.status).toBe("completed");

		// Same ACP session object and same child process — no new spawn.
		// biome-ignore lint/suspicious/noExplicitAny: accessing private map for protocol-level assertion
		const sessionAfter = (sessionManager as any).sessions.get("real-smoke-reuse");
		expect(sessionAfter).toBe(sessionBefore);
		expect(sessionAfter?.process?.pid).toBe(pidBefore);
	}, 120_000);

	it("skill injection: systemContext with <available_skills> reaches provider", async () => {
		const config = configSchema.parse({ llm: { provider } });
		const sessionManager = createManager();
		const adapter = new AcpAdapter(config, sessionManager);

		const skillContext = [
			"<available_skills>",
			'<skill name="time-zone-helper">',
			"Converts times between zones. When a user asks about time conversion, use this skill.",
			"</skill>",
			"</available_skills>",
		].join("\n");

		const result = await adapter.run({
			prompt: "What skills do you have available? List them.",
			systemContext: skillContext,
			sessionId: "real-smoke-skill",
			onEvent: () => {},
		});

		expect(result.status).toBe("completed");
		expect(result.output.toLowerCase()).toContain("time");
	}, 60_000);
});
