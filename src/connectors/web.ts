import type { TaskResult } from "../runner/types.js";
import type { ServerWebSocket } from "../server/ws.js";
import type { Connector, MessageHandler } from "./interface.js";

/**
 * Web connector — wraps the WebSocket server as a Connector.
 *
 * Receives prompts from WebSocket clients, sends streaming responses
 * and task status updates back over the same connection.
 */
export class WebConnector implements Connector {
	readonly name = "web";
	private handlers: MessageHandler[] = [];
	private clients = new Map<string, ServerWebSocket>();

	onMessage(handler: MessageHandler): void {
		this.handlers.push(handler);
	}

	/** Register a connected WebSocket client. */
	addClient(id: string, ws: ServerWebSocket): void {
		this.clients.set(id, ws);
	}

	/** Remove a disconnected client. */
	removeClient(id: string): void {
		this.clients.delete(id);
	}

	/** Dispatch an incoming message from a WebSocket client. */
	handleIncoming(content: string, userId?: string, sessionId?: string): void {
		for (const handler of this.handlers) {
			handler({ content, userId, sessionId });
		}
	}

	async sendMessage(to: string, content: string): Promise<void> {
		const ws = this.clients.get(to);
		if (ws) {
			try {
				ws.send(JSON.stringify({ type: "stream", delta: content }));
			} catch {
				this.clients.delete(to);
			}
		}
	}

	async sendTaskStatus(taskId: string, status: TaskResult): Promise<void> {
		const message = JSON.stringify({ type: "result", taskId, task: status });
		for (const [id, ws] of this.clients) {
			try {
				ws.send(message);
			} catch {
				this.clients.delete(id);
			}
		}
	}

	/** Broadcast a message to all connected clients. */
	broadcast(data: unknown): void {
		const message = JSON.stringify(data);
		for (const [id, ws] of this.clients) {
			try {
				ws.send(message);
			} catch {
				this.clients.delete(id);
			}
		}
	}
}
