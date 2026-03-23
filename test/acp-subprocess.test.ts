/**
 * Subprocess-level ACP integration test.
 *
 * Verifies the full spawn → NDJSON → ACP protocol → AcpAdapter event pipeline
 * using a real `AcpSessionManager` and a minimal echo server process.
 *
 * This is a higher-cost test than the stub-based bounded-agentic.test.ts suite.
 * It exercises the real child-process stdio wiring, NDJSON framing, and
 * `ClientSideConnection` negotiation that stubs deliberately skip.
 */
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { configSchema } from "../src/config/schema.js";
import { AcpSessionManager } from "../src/llm/acp-session.js";
import { AcpAdapter } from "../src/llm/acp.js";
import type { AdapterEvent } from "../src/llm/adapter.js";

const ECHO_SERVER = path.resolve(import.meta.dirname, "fixtures/acp-echo-server.mjs");

function makeConfig() {
	return configSchema.parse({
		llm: {
			// Point at our echo server instead of a real CLI
			provider: "github-copilot",
			acp: {
				command: "node",
				args: [ECHO_SERVER],
			},
		},
	});
}

describe("ACP subprocess integration", () => {
	let sessionManager: AcpSessionManager;

	afterEach(async () => {
		await sessionManager?.dispose();
	});

	it("round-trips a prompt through a real ACP subprocess", async () => {
		const config = makeConfig();
		sessionManager = new AcpSessionManager();
		const adapter = new AcpAdapter(config, sessionManager);
		const events: AdapterEvent[] = [];

		const result = await adapter.run({
			prompt: "hello world",
			sessionId: "sub-test-1",
			onEvent: (e) => events.push(e),
		});

		expect(result.status).toBe("completed");
		expect(result.output).toBe("echo: hello world");

		// The adapter should have emitted a text event for the echoed content
		expect(events).toEqual([{ type: "text", text: "echo: hello world" }]);
	});
});
