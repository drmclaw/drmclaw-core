import { Hono } from "hono";
import type { TaskRunner } from "../runner/runner.js";
import type { CronService } from "../scheduler/service.js";
import type { SkillEntry } from "../skills/types.js";

/** Create REST route handlers, mounted on the Hono app. */
export function createRoutes(
	runner: TaskRunner,
	scheduler: CronService,
	skills: SkillEntry[],
): Hono {
	const api = new Hono();

	// ---- Chat ----

	api.post("/chat", async (c) => {
		const body = await c.req.json<{ message: string; idempotencyKey?: string }>();
		if (!body.message) {
			return c.json({ error: "message is required" }, 400);
		}

		const record = await runner.run(body.message);
		return c.json(record);
	});

	// ---- Tasks ----

	api.get("/tasks", (c) => {
		return c.json(runner.getHistory());
	});

	api.get("/tasks/:id", (c) => {
		const task = runner.getTask(c.req.param("id"));
		if (!task) return c.json({ error: "Task not found" }, 404);
		return c.json(task);
	});

	api.get("/tasks/:id/events", async (c) => {
		const store = runner.getEventStore();
		if (!store) return c.json({ error: "Event store not available" }, 501);
		const events = await store.listTaskEvents(c.req.param("id"));
		return c.json(events);
	});

	// Persisted task list (survives backend restarts)
	api.get("/events/tasks", async (c) => {
		const store = runner.getEventStore();
		if (!store) return c.json([]);
		return c.json(await store.listTasks());
	});

	// ---- Skills ----

	api.get("/skills", (c) => {
		return c.json(
			skills.map((s) => ({
				name: s.name,
				description: s.description,
				source: s.source,
				hasEntrypoint: !!s.entrypoint,
				ready: s.ready,
				missingRequires: s.missingRequires,
			})),
		);
	});

	// ---- Jobs (Scheduler) ----

	api.get("/jobs", (c) => {
		return c.json(scheduler.listJobs());
	});

	api.post("/jobs", async (c) => {
		const body = await c.req.json<{
			name: string;
			schedule: string;
			prompt: string;
			skillName?: string;
			timezone?: string;
			enabled?: boolean;
		}>();

		if (!body.name || !body.schedule || !body.prompt) {
			return c.json({ error: "name, schedule, and prompt are required" }, 400);
		}

		const job = await scheduler.addJob({
			name: body.name,
			schedule: body.schedule,
			prompt: body.prompt,
			skillName: body.skillName,
			timezone: body.timezone,
			enabled: body.enabled ?? true,
		});

		return c.json(job, 201);
	});

	api.delete("/jobs/:id", async (c) => {
		const deleted = await scheduler.removeJob(c.req.param("id"));
		if (!deleted) return c.json({ error: "Job not found" }, 404);
		return c.json({ ok: true });
	});

	api.post("/jobs/:id/run", async (c) => {
		try {
			await scheduler.runNow(c.req.param("id"));
			return c.json({ ok: true });
		} catch (error) {
			return c.json({ error: error instanceof Error ? error.message : "Unknown error" }, 404);
		}
	});

	// ---- Health ----

	api.get("/health", (c) => {
		return c.json({ status: "ok", uptime: process.uptime() });
	});

	return api;
}
