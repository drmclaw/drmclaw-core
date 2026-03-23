/**
 * Minimal ACP echo server for subprocess integration tests.
 *
 * Speaks the ACP NDJSON protocol over stdio:
 *   - initialize → responds with protocol version and empty capabilities
 *   - session/new → responds with a fixed session ID
 *   - session/prompt → sends a sessionUpdate (agent_message_chunk) notification
 *     then responds with stopReason "end_turn"
 *
 * This is intentionally minimal — just enough to verify the full
 * spawn → NDJSON → ACP protocol → adapter event pipeline.
 */

import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

const input = Readable.toWeb(process.stdin);
const output = Writable.toWeb(process.stdout);
const stream = acp.ndJsonStream(output, input);

const connection = new acp.AgentSideConnection(
	(conn) => ({
		async initialize(_params) {
			return {
				protocolVersion: acp.PROTOCOL_VERSION,
				agentCapabilities: {},
			};
		},
		async authenticate(_params) {
			return {};
		},
		async newSession(_params) {
			return { sessionId: "echo-session-1" };
		},
		async prompt(params) {
			// Echo the prompt text back as an agent_message_chunk
			const promptText =
				params.prompt
					?.filter((b) => b.type === "text")
					.map((b) => b.text)
					.join("") ?? "";

			await conn.sessionUpdate({
				sessionId: params.sessionId,
				update: {
					sessionUpdate: "agent_message_chunk",
					content: { type: "text", text: `echo: ${promptText}` },
				},
			});

			return { stopReason: "end_turn" };
		},
	}),
	stream,
);

// Keep the process alive until the connection closes
connection.closed.then(() => process.exit(0));
