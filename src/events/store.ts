import { appendFile, mkdir, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { EventStore, PersistedRuntimeEvent } from "./types.js";

/**
 * JSONL-backed EventStore — one `.jsonl` file per task.
 *
 * Storage layout:
 *   <baseDir>/events/tasks/<taskId>.jsonl
 *
 * Each line is a JSON-serialized `PersistedRuntimeEvent`.
 * Writes use `appendFile` for crash-safe append-only semantics.
 */
export class JsonlEventStore implements EventStore {
	private readonly tasksDir: string;

	constructor(baseDir: string) {
		this.tasksDir = join(baseDir, "events", "tasks");
	}

	async append(taskId: string, event: PersistedRuntimeEvent): Promise<void> {
		await mkdir(this.tasksDir, { recursive: true });
		const filePath = join(this.tasksDir, `${taskId}.jsonl`);
		await appendFile(filePath, `${JSON.stringify(event)}\n`, "utf-8");
	}

	async listTaskEvents(taskId: string): Promise<PersistedRuntimeEvent[]> {
		const filePath = join(this.tasksDir, `${taskId}.jsonl`);
		let content: string;
		try {
			content = await readFile(filePath, "utf-8");
		} catch {
			return [];
		}

		const events: PersistedRuntimeEvent[] = [];
		for (const line of content.split("\n")) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			try {
				events.push(JSON.parse(trimmed) as PersistedRuntimeEvent);
			} catch {
				// Skip malformed lines
			}
		}
		return events;
	}

	async listTasks(): Promise<Array<{ id: string; prompt: string; startedAt: string }>> {
		let files: string[];
		try {
			files = await readdir(this.tasksDir);
		} catch {
			return [];
		}

		const tasks: Array<{ id: string; prompt: string; startedAt: string }> = [];
		for (const file of files) {
			if (!file.endsWith(".jsonl")) continue;
			const taskId = file.replace(".jsonl", "");
			try {
				const content = await readFile(join(this.tasksDir, file), "utf-8");
				const firstLine = content.split("\n", 1)[0]?.trim();
				if (!firstLine) continue;
				const event = JSON.parse(firstLine) as PersistedRuntimeEvent;
				if (event.event.type === "task_init" && "prompt" in event.event) {
					tasks.push({
						id: taskId,
						prompt: (event.event as { type: "task_init"; prompt: string }).prompt,
						startedAt: event.timestamp,
					});
				}
			} catch {
				// Skip unreadable files
			}
		}
		return tasks.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
	}
}
