import { join } from "node:path";
import { serve } from "@hono/node-server";
import { loadDrMClawConfig } from "./config/loader.js";
import { isCliProvider, resolveAcpCommandArgs } from "./config/schema.js";
import { createDefaultRegistry } from "./connectors/registry.js";
import { JsonlEventStore } from "./events/store.js";
import { createLLMAdapter } from "./llm/index.js";
import { TaskRunner } from "./runner/runner.js";
import { createAgentRuntime } from "./runtime/agent.js";
import { CronService } from "./scheduler/service.js";
import { createApp } from "./server/app.js";
import { handleSkillsCommand } from "./skills/cli.js";
import { loadSkills } from "./skills/loader.js";

async function main() {
	// 0. Global safety nets — log and survive stray rejections; crash on truly fatal exceptions
	process.on("unhandledRejection", (reason) => {
		console.error("[drmclaw] Unhandled rejection:", reason);
	});
	process.on("uncaughtException", (err) => {
		console.error("[drmclaw] Uncaught exception — exiting:", err);
		process.exit(1);
	});

	// 1. Load and validate config
	const config = await loadDrMClawConfig();
	const providerKind = isCliProvider(config.llm.provider) ? "cli" : "embedded";
	console.log(`[drmclaw] Config loaded (provider: ${config.llm.provider}, ${providerKind})`);
	if (isCliProvider(config.llm.provider)) {
		const { command, args } = resolveAcpCommandArgs(
			config.llm.provider,
			config.llm.acp,
			config.llm.model,
		);
		console.log(`[drmclaw] ACP: ${command} ${args.join(" ")}`);
	}

	// 2. Discover and load skills
	const skills = await loadSkills(config);
	console.log(`[drmclaw] Loaded ${skills.length} skill(s)`);

	// 3. Create LLM adapter and agent runtime
	const adapter = createLLMAdapter(config);
	const runtime = createAgentRuntime(config, adapter);

	// 4. Create task runner
	const runner = new TaskRunner(config, runtime, skills);

	// 5. Create event store for durable event persistence
	const eventStore = new JsonlEventStore(config.dataDir);
	runner.setEventStore(eventStore);
	console.log(`[drmclaw] Event store enabled (${config.dataDir}/events/tasks/)`);

	// 6. Create scheduler
	const scheduler = new CronService(join(config.dataDir, "jobs.json"));
	scheduler.setRunner(runner);
	if (config.scheduler.enabled) {
		await scheduler.initialize();
		console.log(`[drmclaw] Scheduler enabled (${scheduler.listJobs().length} job(s))`);
	}

	// 7. Create connectors
	const { webConnector } = createDefaultRegistry();

	// Wire web connector to task runner
	webConnector.onMessage(async (msg) => {
		try {
			const record = await runner.run(msg.content, {
				userId: msg.userId,
				sessionId: msg.sessionId,
				onPersistedEvent: (event) => {
					webConnector.broadcast({
						type: "event",
						taskId: event.taskId,
						sequence: event.sequence,
						timestamp: event.timestamp,
						source: event.source,
						event: event.event,
					});
				},
			});
			await webConnector.sendTaskStatus(record.id, record.result);
		} catch (err) {
			console.error("[drmclaw] WebSocket message handler error:", err);
		}
	});

	// Wire queue notices to WebSocket
	runner.onQueueNotice((taskId, position) => {
		webConnector.broadcast({ type: "queue_notice", taskId, position });
	});

	// 8. Eagerly discover available models so the dropdown is populated on first load
	if (adapter.discoverModels) {
		adapter
			.discoverModels()
			.then((models) => {
				if (models.length > 0) {
					console.log(`[drmclaw] Discovered ${models.length} model(s) from agent`);
				}
			})
			.catch(() => {
				// Non-fatal — dropdown will be empty until first session
			});
	}

	// 9. Create and start HTTP server with WebSocket support
	let serverReady = false;
	const { app, injectWebSocket } = createApp(
		runner,
		scheduler,
		skills,
		webConnector,
		config,
		adapter,
		{ isReady: () => serverReady },
	);
	const port = config.server.port;

	const server = serve({ fetch: app.fetch, port }, () => {
		serverReady = true;
		console.log(`[drmclaw] Server listening on http://localhost:${port}`);
	});

	injectWebSocket(server);

	// Graceful shutdown: stop accepting tasks, drain in-flight work, then exit.
	let shuttingDown = false;
	const shutdown = async (signal: string): Promise<void> => {
		if (shuttingDown) return;
		shuttingDown = true;
		console.log(`[drmclaw] ${signal} received — draining in-flight tasks…`);

		try {
			await runner.drain();
			console.log("[drmclaw] All tasks drained. Shutting down.");
		} catch (err) {
			console.error("[drmclaw] Error during drain:", err);
		}

		server.close(() => process.exit(0));
		// Force exit after 30s if drain hangs
		setTimeout(() => {
			console.error("[drmclaw] Forced exit after timeout.");
			process.exit(1);
		}, 30_000).unref();
	};
	process.on("SIGINT", () => shutdown("SIGINT"));
	process.on("SIGTERM", () => shutdown("SIGTERM"));
}

const args = process.argv.slice(2);

if (args[0] === "skills") {
	handleSkillsCommand(args.slice(1)).catch((err) => {
		console.error("[drmclaw] Error:", err instanceof Error ? err.message : err);
		process.exit(1);
	});
} else {
	main().catch((err) => {
		console.error("[drmclaw] Fatal error:", err);
		process.exit(1);
	});
}
