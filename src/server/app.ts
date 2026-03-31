import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import { createNodeWebSocket } from "@hono/node-ws";
import { Hono } from "hono";
import type { DrMClawConfig } from "../config/schema.js";
import type { WebConnector } from "../connectors/web.js";
import type { LLMAdapter } from "../llm/adapter.js";
import { PACKAGE_ROOT } from "../paths.js";
import type { TaskRunner } from "../runner/runner.js";
import type { CronService } from "../scheduler/service.js";
import type { SkillEntry } from "../skills/types.js";
import { createRoutes } from "./routes.js";

export interface AppWithWebSocket {
	app: Hono;
	injectWebSocket: (server: import("node:http").Server | import("node:http2").Http2Server) => void;
}

/**
 * Create the main Hono application with REST routes and WebSocket support.
 */
export function createApp(
	runner: TaskRunner,
	scheduler: CronService,
	skills: SkillEntry[],
	webConnector: WebConnector,
	config: DrMClawConfig,
	adapter: LLMAdapter,
	options?: { isReady?: () => boolean },
): AppWithWebSocket {
	const app = new Hono();
	const { upgradeWebSocket, injectWebSocket } = createNodeWebSocket({ app });

	// Mount REST API routes under /api
	const routes = createRoutes(runner, scheduler, skills, config, adapter, {
		isReady: options?.isReady,
	});
	app.route("/api", routes);

	// WebSocket endpoint for developer console
	app.get(
		"/ws",
		upgradeWebSocket(() => {
			const clientId = randomUUID();
			return {
				onOpen(_event, ws) {
					webConnector.addClient(clientId, {
						send: (data: string) => ws.send(data),
						close: (code?: number, reason?: string) => ws.close(code, reason),
					});
				},
				onMessage(event) {
					try {
						const parsed = JSON.parse(String(event.data));
						if (parsed.type === "ping") {
							webConnector.broadcast({ type: "pong" });
							return;
						}
						if (parsed.type === "chat" && typeof parsed.message === "string") {
							webConnector.handleIncoming(parsed.message, clientId, clientId);
						}
					} catch {
						// Ignore malformed messages
					}
				},
				onClose() {
					webConnector.removeClient(clientId);
				},
			};
		}),
	);

	// Serve developer console static files in production.
	// In dev, the esbuild/Tailwind dev server (ui/scripts/dev.mjs) proxies
	// /api and /ws to this backend and serves built assets directly.
	// Static files are package-internal assets — anchor to PACKAGE_ROOT
	// so they serve correctly regardless of the server's working directory.
	app.use("/*", serveStatic({ root: join(PACKAGE_ROOT, "ui/dist") }));

	return { app, injectWebSocket };
}
