import { appendFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type {
	ExecutionEventSummary,
	ExecutionHistoryStore,
	ExecutionRunMetadata,
	ExecutionRunRecord,
	ExecutionTimelineItem,
	ExecutionTranscriptMessage,
	PersistedRuntimeEvent,
} from "./types.js";

const PREVIEW_LENGTH = 1_000;
const TIMELINE_PREVIEW_LENGTH = 600;
const SAFE_TASK_ID_RE = /^[A-Za-z0-9._-]+$/;
const DEFAULT_STALE_AFTER_MS = 15 * 60 * 1_000;

function truncate(value: string | undefined, maxLength = PREVIEW_LENGTH): string | undefined {
	if (!value) return undefined;
	if (value.length <= maxLength) return value;
	return `${value.slice(0, maxLength - 1).trimEnd()}...`;
}

export function assertSafeTaskId(taskId: string): void {
	if (!SAFE_TASK_ID_RE.test(taskId) || basename(taskId) !== taskId) {
		throw new Error("invalid task id");
	}
}

export function summarizeExecutionEvents(events: PersistedRuntimeEvent[]): ExecutionEventSummary {
	const eventCounts: Record<string, number> = {};
	const startedToolCalls = new Map<string, string>();
	const completedToolCalls = new Set<string>();
	const resultToolCalls = new Set<string>();
	const toolsByName = new Map<
		string,
		{
			name: string;
			callsStarted: number;
			callsCompleted: number;
			successCount: number;
			failureCount: number;
		}
	>();

	function getTool(name: string) {
		let tool = toolsByName.get(name);
		if (!tool) {
			tool = {
				name,
				callsStarted: 0,
				callsCompleted: 0,
				successCount: 0,
				failureCount: 0,
			};
			toolsByName.set(name, tool);
		}
		return tool;
	}

	for (const persisted of events) {
		const event = persisted.event;
		eventCounts[event.type] = (eventCounts[event.type] ?? 0) + 1;

		if (event.type === "tool_call") {
			const tool = getTool(event.tool);
			if (
				event.status === "pending" ||
				event.status === "in_progress" ||
				event.status === "inProgress"
			) {
				tool.callsStarted += 1;
			}
			if (event.toolCallId) {
				startedToolCalls.set(event.toolCallId, event.tool);
			}
			if (event.status === "completed" || event.status === "failed") {
				if (event.toolCallId) completedToolCalls.add(event.toolCallId);
				if (!event.toolCallId || !resultToolCalls.has(event.toolCallId)) {
					tool.callsCompleted += 1;
					if (event.status === "completed") {
						tool.successCount += 1;
					} else {
						tool.failureCount += 1;
					}
				}
			}
			continue;
		}

		if (event.type === "tool_result") {
			const toolName =
				(event.toolCallId ? startedToolCalls.get(event.toolCallId) : undefined) ?? event.tool;
			const tool = getTool(toolName);
			if (event.toolCallId) resultToolCalls.add(event.toolCallId);
			if (!event.toolCallId || !completedToolCalls.has(event.toolCallId)) {
				tool.callsCompleted += 1;
				tool.successCount += 1;
			}
		}
	}

	const tools = Array.from(toolsByName.values()).sort((left, right) => {
		if (left.callsStarted !== right.callsStarted) return right.callsStarted - left.callsStarted;
		return left.name.localeCompare(right.name);
	});

	return {
		eventCounts,
		toolActivity: {
			totalCalls: tools.reduce((sum, tool) => sum + tool.callsStarted, 0),
			uniqueTools: tools.length,
			tools,
		},
	};
}

export function buildExecutionTranscript(
	events: PersistedRuntimeEvent[],
): ExecutionTranscriptMessage[] {
	const messages: ExecutionTranscriptMessage[] = [];
	const taskInit = events.find((event) => event.event.type === "task_init");
	if (taskInit?.event.type === "task_init") {
		messages.push({
			role: "user",
			timestamp: taskInit.timestamp,
			content: taskInit.event.prompt,
		});
	}

	let assistant = "";
	let firstAssistantTimestamp: string | null = null;
	for (const persisted of events) {
		if (persisted.event.type !== "stream") continue;
		if (!firstAssistantTimestamp) firstAssistantTimestamp = persisted.timestamp;
		assistant += persisted.event.delta;
	}
	if (assistant.trim().length > 0) {
		messages.push({
			role: "assistant",
			timestamp: firstAssistantTimestamp,
			content: assistant.trim(),
		});
	}

	return messages;
}

function timelinePreview(value: string | undefined): string | undefined {
	return truncate(value, TIMELINE_PREVIEW_LENGTH);
}

function titleForLifecycle(phase: string): string {
	if (phase === "start") return "Run started";
	if (phase === "prompt_sent") return "Prompt sent to Codex";
	if (phase === "end") return "Run completed";
	if (phase === "error") return "Run failed";
	return `Lifecycle: ${phase}`;
}

function resultToText(result: unknown): string | undefined {
	if (result == null) return undefined;
	if (typeof result === "string") return result;
	if (typeof result === "number" || typeof result === "boolean") return String(result);
	if (typeof result === "object" && "output" in result) {
		const output = (result as { output?: unknown }).output;
		if (typeof output === "string") return output;
	}
	try {
		return JSON.stringify(result, null, 2);
	} catch {
		return String(result);
	}
}

function splitProgressText(text: string): string[] {
	const normalized = text.replace(/\r\n/g, "\n").trim();
	if (!normalized) return [];
	const paragraphs = normalized
		.split(/\n{2,}/)
		.map((part) => part.trim())
		.filter(Boolean);
	const chunks = paragraphs.length > 1 ? paragraphs : [normalized];
	const result: string[] = [];

	for (const chunk of chunks) {
		if (chunk.length <= 2_000) {
			result.push(chunk);
			continue;
		}

		const sentences = chunk.split(/(?<=[.!?。！？])\s+/).filter(Boolean);
		if (sentences.length <= 1) {
			result.push(chunk);
			continue;
		}

		let current = "";
		for (const sentence of sentences) {
			const next = current ? `${current} ${sentence}` : sentence;
			if (next.length > 2_000 && current) {
				result.push(current);
				current = sentence;
			} else {
				current = next;
			}
		}
		if (current) result.push(current);
	}

	return result;
}

export function buildExecutionTimeline(events: PersistedRuntimeEvent[]): ExecutionTimelineItem[] {
	const timeline: ExecutionTimelineItem[] = [];
	let streamBuffer = "";
	let streamStart: PersistedRuntimeEvent | null = null;
	let streamEndSequence = -1;

	function nextId(kind: string, sequence: number, offset = 0): string {
		return `${kind}-${sequence}-${offset}`;
	}

	function pushProgress(): void {
		if (!streamStart || !streamBuffer.trim()) {
			streamBuffer = "";
			streamStart = null;
			streamEndSequence = -1;
			return;
		}

		const start = streamStart;
		const parts = splitProgressText(streamBuffer);
		parts.forEach((content, index) => {
			timeline.push({
				id: nextId("progress", start.sequence, index),
				kind: "progress",
				timestamp: start.timestamp,
				title: "Assistant progress",
				content,
				preview: timelinePreview(content),
				sequenceStart: start.sequence,
				sequenceEnd: streamEndSequence,
			});
		});

		streamBuffer = "";
		streamStart = null;
		streamEndSequence = -1;
	}

	for (const persisted of events) {
		const event = persisted.event;
		if (event.type === "stream") {
			if (!streamStart) streamStart = persisted;
			streamBuffer += event.delta;
			streamEndSequence = persisted.sequence;
			continue;
		}

		pushProgress();

		if (event.type === "task_init") {
			timeline.push({
				id: nextId("prompt", persisted.sequence),
				kind: "prompt",
				timestamp: persisted.timestamp,
				title: "Prompt",
				content: event.prompt,
				preview: timelinePreview(event.prompt),
				sequenceStart: persisted.sequence,
				sequenceEnd: persisted.sequence,
			});
			continue;
		}

		if (event.type === "lifecycle") {
			timeline.push({
				id: nextId("lifecycle", persisted.sequence),
				kind: "lifecycle",
				timestamp: persisted.timestamp,
				title: titleForLifecycle(event.phase),
				content: event.phase === "error" ? event.error : undefined,
				preview: event.phase === "error" ? timelinePreview(event.error) : undefined,
				status: event.phase,
				result: event.phase === "end" ? event.result : undefined,
				sequenceStart: persisted.sequence,
				sequenceEnd: persisted.sequence,
			});
			continue;
		}

		if (event.type === "thinking") {
			timeline.push({
				id: nextId("thinking", persisted.sequence),
				kind: "thinking",
				timestamp: persisted.timestamp,
				title: "Thinking",
				content: event.text,
				preview: timelinePreview(event.text),
				sequenceStart: persisted.sequence,
				sequenceEnd: persisted.sequence,
			});
			continue;
		}

		if (event.type === "plan") {
			const content = event.entries
				.map((entry) => `${entry.status}: ${entry.content}`)
				.join("\n");
			timeline.push({
				id: nextId("plan", persisted.sequence),
				kind: "plan",
				timestamp: persisted.timestamp,
				title: "Plan update",
				content,
				preview: timelinePreview(content),
				result: event.entries,
				sequenceStart: persisted.sequence,
				sequenceEnd: persisted.sequence,
			});
			continue;
		}

		if (event.type === "tool_call") {
			timeline.push({
				id: nextId("tool-call", persisted.sequence),
				kind: "tool_call",
				timestamp: persisted.timestamp,
				title: `Tool ${event.status}`,
				status: event.status,
				tool: event.tool,
				toolKind: event.kind,
				toolCallId: event.toolCallId,
				args: event.args,
				sequenceStart: persisted.sequence,
				sequenceEnd: persisted.sequence,
			});
			continue;
		}

		if (event.type === "tool_result") {
			const content = resultToText(event.result);
			timeline.push({
				id: nextId("tool-result", persisted.sequence),
				kind: "tool_result",
				timestamp: persisted.timestamp,
				title: "Tool result",
				tool: event.tool,
				toolCallId: event.toolCallId,
				content,
				preview: timelinePreview(content),
				result: event.result,
				sequenceStart: persisted.sequence,
				sequenceEnd: persisted.sequence,
			});
			continue;
		}

		if (event.type === "usage") {
			const content = `Used ${event.used} of ${event.size}${event.cost ? `; cost ${event.cost.amount} ${event.cost.currency}` : ""}`;
			timeline.push({
				id: nextId("usage", persisted.sequence),
				kind: "usage",
				timestamp: persisted.timestamp,
				title: "Usage",
				content,
				preview: content,
				sequenceStart: persisted.sequence,
				sequenceEnd: persisted.sequence,
			});
		}
	}

	pushProgress();
	return timeline;
}

export function buildExecutionRunMetadata(args: {
	taskId: string;
	kind: ExecutionRunMetadata["kind"];
	status: ExecutionRunMetadata["status"];
	provider: string;
	requestedModel?: string;
	requestedReasoningEffort?: string;
	workingDir?: string;
	skill?: string;
	action?: string;
	inputs?: Record<string, unknown>;
	processId?: number;
	startedAt: string;
	finishedAt?: string | null;
	durationMs?: number | null;
	output?: string;
	error?: string;
	events: PersistedRuntimeEvent[];
}): ExecutionRunMetadata {
	const transcript = buildExecutionTranscript(args.events);
	const prompt = transcript.find((message) => message.role === "user")?.content;
	return {
		taskId: args.taskId,
		kind: args.kind,
		status: args.status,
		provider: args.provider,
		requestedModel: args.requestedModel,
		requestedReasoningEffort: args.requestedReasoningEffort,
		workingDir: args.workingDir,
		skill: args.skill,
		action: args.action,
		inputs: args.inputs,
		processId: args.processId,
		startedAt: args.startedAt,
		finishedAt: args.finishedAt ?? null,
		durationMs: args.durationMs ?? null,
		outputPreview: truncate(args.output),
		errorPreview: truncate(args.error),
		promptPreview: truncate(prompt),
		eventCounts: summarizeExecutionEvents(args.events).eventCounts,
	};
}

export class ExecutionHistoryJsonlStore implements ExecutionHistoryStore {
	private readonly runsDir: string;

	constructor(baseDir: string) {
		this.runsDir = join(baseDir, "runs");
	}

	private runDir(taskId: string): string {
		assertSafeTaskId(taskId);
		return join(this.runsDir, taskId);
	}

	async append(taskId: string, event: PersistedRuntimeEvent): Promise<void> {
		const dir = this.runDir(taskId);
		await mkdir(dir, { recursive: true });
		await appendFile(join(dir, "events.jsonl"), `${JSON.stringify(event)}\n`, "utf-8");
	}

	async saveMetadata(metadata: ExecutionRunMetadata): Promise<void> {
		const dir = this.runDir(metadata.taskId);
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, "metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`, "utf-8");
	}

	private async readMetadata(taskId: string): Promise<ExecutionRunMetadata | null> {
		try {
			const raw = await readFile(join(this.runDir(taskId), "metadata.json"), "utf-8");
			const metadata = JSON.parse(raw) as ExecutionRunMetadata;
			return metadata.taskId === taskId ? metadata : null;
		} catch {
			return null;
		}
	}

	private isProcessAlive(pid: number): boolean {
		if (!Number.isInteger(pid) || pid <= 0) return false;
		try {
			process.kill(pid, 0);
			return true;
		} catch {
			return false;
		}
	}

	async markStaleRuns(options: { now?: Date; staleAfterMs?: number } = {}): Promise<number> {
		let entries: Array<{ isDirectory(): boolean; name: string }>;
		try {
			entries = await readdir(this.runsDir, { withFileTypes: true });
		} catch {
			return 0;
		}

		const now = options.now ?? new Date();
		const nowMs = now.getTime();
		const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
		let marked = 0;

		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			if (!SAFE_TASK_ID_RE.test(entry.name)) continue;
			const metadata = await this.readMetadata(entry.name);
			if (!metadata || metadata.status !== "running") continue;

			const ownerAlive =
				typeof metadata.processId === "number" && this.isProcessAlive(metadata.processId);
			const startedMs = Date.parse(metadata.startedAt);
			const ageMs = Number.isFinite(startedMs) ? nowMs - startedMs : Number.POSITIVE_INFINITY;
			if (ownerAlive || ageMs < staleAfterMs) continue;

			const events = await this.listRunEvents(metadata.taskId);
			const staleMetadata = buildExecutionRunMetadata({
				...metadata,
				status: "stale",
				finishedAt: now.toISOString(),
				durationMs: Number.isFinite(startedMs) ? Math.max(0, nowMs - startedMs) : null,
				error: "Run marked stale because no active drmclaw-core process owns it.",
				events,
			});
			await this.saveMetadata(staleMetadata);
			marked += 1;
		}

		return marked;
	}

	async listRunEvents(taskId: string): Promise<PersistedRuntimeEvent[]> {
		const filePath = join(this.runDir(taskId), "events.jsonl");
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
				// Skip malformed lines; append-only logs can be partially written.
			}
		}
		return events;
	}

	async listRuns(options: { limit?: number } = {}): Promise<ExecutionRunMetadata[]> {
		await this.markStaleRuns();
		let entries: Array<{ isDirectory(): boolean; name: string }>;
		try {
			entries = await readdir(this.runsDir, { withFileTypes: true });
		} catch {
			return [];
		}

		const runs: ExecutionRunMetadata[] = [];
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			if (!SAFE_TASK_ID_RE.test(entry.name)) continue;
			try {
				const metadata = await this.readMetadata(entry.name);
				if (metadata) runs.push(metadata);
			} catch {
				// Skip in-flight or unreadable runs without finalized metadata.
			}
		}

		runs.sort((left, right) => {
			const rightStamp = Date.parse(right.finishedAt ?? right.startedAt);
			const leftStamp = Date.parse(left.finishedAt ?? left.startedAt);
			const stamp = rightStamp - leftStamp;
			if (stamp !== 0) return stamp;
			return right.taskId.localeCompare(left.taskId);
		});
		return typeof options.limit === "number" && options.limit >= 0
			? runs.slice(0, options.limit)
			: runs;
	}

	async readRun(taskId: string): Promise<ExecutionRunRecord | null> {
		assertSafeTaskId(taskId);
		await this.markStaleRuns();
		const metadata = await this.readMetadata(taskId);
		if (!metadata) return null;

		const events = await this.listRunEvents(taskId);
		return {
			metadata,
			events,
			transcript: buildExecutionTranscript(events),
			timeline: buildExecutionTimeline(events),
			summary: summarizeExecutionEvents(events),
		};
	}
}

export function createExecutionHistoryStore(dataDir: string): ExecutionHistoryStore {
	return new ExecutionHistoryJsonlStore(dataDir);
}

export async function listExecutionRuns(
	options: {
		dataDir?: string;
		limit?: number;
	} = {},
): Promise<ExecutionRunMetadata[]> {
	const store = createExecutionHistoryStore(options.dataDir ?? ".drmclaw");
	return store.listRuns({ limit: options.limit });
}

export async function markStaleExecutionRuns(
	options: {
		dataDir?: string;
		now?: Date;
		staleAfterMs?: number;
	} = {},
): Promise<number> {
	const store = createExecutionHistoryStore(options.dataDir ?? ".drmclaw");
	return store.markStaleRuns({ now: options.now, staleAfterMs: options.staleAfterMs });
}

export async function readExecutionRun(
	taskId: string,
	options: { dataDir?: string } = {},
): Promise<ExecutionRunRecord | null> {
	const store = createExecutionHistoryStore(options.dataDir ?? ".drmclaw");
	return store.readRun(taskId);
}
