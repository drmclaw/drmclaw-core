import type { DrMClawConfig } from "../config/schema.js";
import { buildExecutionRunMetadata, createExecutionHistoryStore } from "../events/store.js";
import type { PersistedRuntimeEvent } from "../events/types.js";

export async function persistExecutionHistory(args: {
	config: DrMClawConfig;
	taskId: string;
	kind: "task" | "skill-action";
	status: "completed" | "error";
	provider: string;
	requestedModel?: string;
	requestedReasoningEffort?: string;
	workingDir?: string;
	skill?: string;
	action?: string;
	inputs?: Record<string, unknown>;
	startedAt: string;
	finishedAt: string;
	durationMs: number;
	output?: string;
	error?: string;
	events: PersistedRuntimeEvent[];
}): Promise<void> {
	if (!args.config.executionHistory.enabled || !args.taskId) return;

	try {
		const store = createExecutionHistoryStore(args.config.dataDir);
		for (const event of args.events) {
			await store.append(args.taskId, event);
		}
		await store.saveMetadata(
			buildExecutionRunMetadata({
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
				startedAt: args.startedAt,
				finishedAt: args.finishedAt,
				durationMs: args.durationMs,
				output: args.output,
				error: args.error,
				events: args.events,
			}),
		);
	} catch (error) {
		console.warn(
			"[drmclaw] Failed to persist execution history:",
			error instanceof Error ? error.message : error,
		);
	}
}
