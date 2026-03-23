import type { TaskResult } from "../runner/types.js";

/** Handler for incoming messages to a connector. */
export type MessageHandler = (message: {
	content: string;
	userId?: string;
	sessionId?: string;
	metadata?: Record<string, unknown>;
}) => void;

/**
 * Connector interface — minimal contract for receiving prompts and delivering results.
 *
 * Implementations: WebSocket (web), Slack, MS Teams, etc.
 */
export interface Connector {
	/** Unique connector name. */
	readonly name: string;

	/** Register a handler for incoming messages. */
	onMessage(handler: MessageHandler): void;

	/** Send a message to a specific recipient. */
	sendMessage(to: string, content: string): Promise<void>;

	/** Send task status update to a specific recipient. */
	sendTaskStatus(taskId: string, status: TaskResult): Promise<void>;
}
