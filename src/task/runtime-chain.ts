/**
 * Shared runtime-chain helper used by the prompt-first {@link executeTask}
 * and the structured {@link executeSkillAction} surfaces.
 *
 * This helper owns the post-validation runtime assembly:
 *
 * 1. Compose `createLLMAdapter` → `createAgentRuntime` → `TaskRunner`.
 * 2. Run the prompt through the agent runtime, collecting lifecycle and
 *    ACP events in memory.
 * 3. Enforce the optional timeout with real ACP adapter disposal (not
 *    just a promise race).
 * 4. Gate late events from abandoned runs.
 * 5. Dispose the adapter in a `finally` block.
 *
 * The helper is intentionally prompt-first — it knows nothing about
 * structured action requests. Callers that carry more shape (e.g.
 * `executeSkillAction`) bridge their request to a prompt before calling.
 *
 * Config loading, skill resolution, and request-shape-specific
 * validation live in the caller. By the time this helper runs, the
 * caller has already produced a {@link DrMClawConfig} and a validated
 * skill list.
 */

import type { DrMClawConfig } from "../config/schema.js";
import type { PersistedRuntimeEvent } from "../events/types.js";
import type { LLMAdapter } from "../llm/adapter.js";
import { createLLMAdapter } from "../llm/index.js";
import { TaskRunner } from "../runner/runner.js";
import type { TaskRecord } from "../runner/types.js";
import { createAgentRuntime } from "../runtime/agent.js";
import type { RuntimeEvent } from "../runtime/types.js";
import type { SkillEntry } from "../skills/types.js";

/** Inputs for {@link runPromptViaRuntime}. */
export interface RunPromptViaRuntimeArgs {
	prompt: string;
	config: DrMClawConfig;
	skills: SkillEntry[];
	workingDir?: string;
	timeoutMs?: number;
	maxOutputChars?: number;
	onEvent?: (event: RuntimeEvent) => void;
	/** Wall-clock start time for duration accounting on error paths. */
	startTime: number;
}

/** Minimal result shape shared by both downstream surfaces. */
export interface RunPromptViaRuntimeResult {
	status: "completed" | "error";
	output: string;
	error?: string;
	durationMs: number;
	taskId: string;
	events: PersistedRuntimeEvent[];
}

/**
 * Drive a prompt through the composed LLM-native runtime chain.
 *
 * Never rejects — failures in adapter construction, runtime execution,
 * or timeout are returned as a structured result with `status: "error"`.
 */
export async function runPromptViaRuntime(
	args: RunPromptViaRuntimeArgs,
): Promise<RunPromptViaRuntimeResult> {
	const events: PersistedRuntimeEvent[] = [];
	let lastTaskId = "";
	let adapter: LLMAdapter | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	// Gate that prevents late events from the abandoned run promise
	// from mutating the snapshot after timeout/completion.
	let accepting = true;

	try {
		adapter = createLLMAdapter(args.config);
		const runtime = createAgentRuntime(args.config, adapter);
		const runner = new TaskRunner(args.config, runtime, args.skills);

		const runPromise = runner.run(args.prompt, {
			workingDir: args.workingDir,
			onEvent: (event) => {
				if (!accepting) return;
				args.onEvent?.(event);
			},
			onPersistedEvent: (event) => {
				if (!accepting) return;
				events.push(event);
				if (event.taskId) lastTaskId = event.taskId;
			},
		});

		let record: TaskRecord;
		if (args.timeoutMs && args.timeoutMs > 0) {
			const timeoutPromise = new Promise<never>((_, reject) => {
				timer = setTimeout(() => {
					// Stop accepting late events before disposal
					accepting = false;
					// Trigger real ACP teardown so the subprocess is killed.
					// Fire-and-forget: the adapter is cleaned up, but we don't
					// block the timeout rejection on it.
					if (adapter) {
						Promise.resolve(adapter.dispose()).catch(() => {});
						adapter = undefined; // prevent double-dispose in finally
					}
					reject(new Error(`Task timed out after ${args.timeoutMs}ms`));
				}, args.timeoutMs);
			});

			record = await Promise.race([runPromise, timeoutPromise]);
		} else {
			record = await runPromise;
		}

		accepting = false;

		let output = record.result.output;
		if (args.maxOutputChars && output.length > args.maxOutputChars) {
			output = output.slice(0, args.maxOutputChars);
		}

		return {
			status: record.result.status === "completed" ? "completed" : "error",
			output,
			error: record.result.error,
			durationMs: record.result.durationMs,
			taskId: record.id,
			events: [...events],
		};
	} catch (err) {
		accepting = false;
		const message = err instanceof Error ? err.message : String(err);
		return {
			status: "error",
			output: "",
			error: message,
			durationMs: Date.now() - args.startTime,
			taskId: lastTaskId,
			events: [...events],
		};
	} finally {
		clearTimeout(timer);
		if (adapter) {
			await adapter.dispose();
		}
	}
}
