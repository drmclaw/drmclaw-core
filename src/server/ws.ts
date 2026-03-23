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
	| { type: "lifecycle"; phase: "start" | "end" | "error"; taskId?: string; error?: string }
	| { type: "stream"; delta: string }
	| { type: "result"; taskId: string; task: unknown }
	| { type: "status"; jobs: unknown[] }
	| { type: "pong" }
	| { type: "queue_notice"; taskId: string; position: number };
