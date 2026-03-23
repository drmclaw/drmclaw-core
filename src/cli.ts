import { serve } from "@hono/node-server";
import { loadDrMClawConfig } from "./config/loader.js";
import { isCliProvider, resolveAcpCommandArgs } from "./config/schema.js";
import { createDefaultRegistry } from "./connectors/registry.js";
import { createLLMAdapter } from "./llm/index.js";
import { TaskRunner } from "./runner/runner.js";
import { createAgentRuntime } from "./runtime/agent.js";
import { CronService } from "./scheduler/service.js";
import { createApp } from "./server/app.js";
import { handleSkillsCommand } from "./skills/cli.js";
import { loadSkills } from "./skills/loader.js";

async function main() {
	// 1. Load and validate config
	const config = await loadDrMClawConfig();
	const providerKind = isCliProvider(config.llm.provider) ? "cli" : "embedded";
	console.log(`[drmclaw] Config loaded (provider: ${config.llm.provider}, ${providerKind})`);
	if (isCliProvider(config.llm.provider)) {
		const { command, args } = resolveAcpCommandArgs(config.llm.provider, config.llm.acp);
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

	// 5. Create scheduler
	const scheduler = new CronService();
	scheduler.setRunner(runner);
	if (config.scheduler.enabled) {
		await scheduler.initialize();
		console.log(`[drmclaw] Scheduler enabled (${scheduler.listJobs().length} job(s))`);
	}

	// 6. Create connectors
	const { webConnector } = createDefaultRegistry();

	// Wire web connector to task runner
	webConnector.onMessage(async (msg) => {
		const record = await runner.run(msg.content, {
			userId: msg.userId,
			sessionId: msg.sessionId,
			onEvent: (event) => {
				webConnector.broadcast(event);
			},
		});
		await webConnector.sendTaskStatus(record.id, record.result);
	});

	// Wire queue notices to WebSocket
	runner.onQueueNotice((taskId, position) => {
		webConnector.broadcast({ type: "queue_notice", taskId, position });
	});

	// 7. Create and start HTTP server with WebSocket support
	const { app, injectWebSocket } = createApp(runner, scheduler, skills, webConnector);
	const port = config.server.port;

	const server = serve({ fetch: app.fetch, port }, () => {
		console.log(`[drmclaw] Server listening on http://localhost:${port}`);
	});

	injectWebSocket(server);
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
