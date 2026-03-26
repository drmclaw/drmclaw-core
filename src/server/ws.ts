import type { PersistedRuntimeEvent } from "../events/types.js";

/**
 * Minimal WebSocket type used by the server layer.
 * Compatible with @hono/node-ws WebSocket interface.
 */
export interface ServerWebSocket {
	send(data: string): void;
	close(code?: number, reason?: string): void;
}

/** Parsed incoming WebSocket message. */
export type WsIncomingMessage = { type: "chat"; message: string } | { type: "ping" };

/** Outgoing WebSocket message types. */
export type WsOutgoingMessage =
	| {
			type: "event";
			taskId: string;
			sequence: number;
			timestamp: string;
			source: PersistedRuntimeEvent["source"];
			event: PersistedRuntimeEvent["event"];
	  }
	| { type: "result"; taskId: string; task: unknown }
	| { type: "status"; jobs: unknown[] }
	| { type: "pong" }
	| { type: "queue_notice"; taskId: string; position: number };
