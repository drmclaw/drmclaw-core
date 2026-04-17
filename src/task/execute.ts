/**
 * Task execution — the downstream-facing API for product repos.
 *
 * Products call {@link executeTask} with a prompt and optional policy
 * constraints. Core handles the full LLM-native execution chain:
 *
 * 1. **Config** — loads the real drmclaw-core config file, then merges
 *    request-level overrides on top (not schema defaults alone).
 * 2. **Skills** — loads skills from the resolved config (system skills +
 *    config.skills.dirs), then merges request-level `skillDirs` additively
 *    with deduplication, optionally filtered by a skill allowlist.
 * 3. **Runtime chain** — composes `createLLMAdapter` → `createAgentRuntime`
 *    → `TaskRunner`, routing through the configured ACP CLI.
 * 4. **Execution** — sends the prompt through the agent runtime,
 *    collecting lifecycle and ACP events in memory.
 * 5. **Cleanup** — disposes ACP adapter resources after one-off execution.
 * 6. **Result** — returns a structured {@link ExecuteTaskResult} with
 *    the agent's output, task ID, provider/model metadata, and collected
 *    events.
 *
 * Events are collected in-memory only — no durable {@link EventStore}
 * is wired in this path. The server/CLI bootstrap attaches
 * `JsonlEventStore` separately for long-running processes.
 */

import type { z } from "zod";
import { loadDrMClawConfig } from "../config/loader.js";
import type { DrMClawConfig, configSchema } from "../config/schema.js";
import type { PersistedRuntimeEvent } from "../events/types.js";
import type { LLMAdapter } from "../llm/adapter.js";
import { createLLMAdapter } from "../llm/index.js";
import { TaskRunner } from "../runner/runner.js";
import type { TaskRecord } from "../runner/types.js";
import { createAgentRuntime } from "../runtime/agent.js";
import type { RuntimeEvent } from "../runtime/types.js";
import { loadSkills, loadSkillsFromDirs } from "../skills/loader.js";

/**
 * A constrained task request submitted by a downstream product.
 *
 * The product declares *what* it wants the LLM agent to do and
 * *how tightly* to constrain it. Core handles skill loading,
 * runtime composition, and ACP lifecycle.
 */
export interface ExecuteTaskRequest {
	/** The prompt to send to the configured LLM agent. */
	prompt: string;

	/**
	 * Additional directories to search for skills.
	 *
	 * These are merged with config-driven skill directories (system
	 * skills + config.skills.dirs) — they do not replace them.
	 * Duplicate skill names are deduplicated (config-driven wins).
	 */
	skillDirs?: string[];

	/** Working directory for skill execution. */
	workingDir?: string;

	/**
	 * Execution constraints applied to the agent run.
	 *
	 * This is an intentionally constrained subset of the full
	 * {@link CommonExecutionPolicy}. Fields like `filePatterns`,
	 * `commandAllowlist`, and `maxSteps` are available in the
	 * underlying runtime types but are not surfaced here. Products
	 * that need fine-grained policy control should compose
	 * `createAgentRuntime` + `TaskRunner` directly.
	 */
	policy?: {
		/** Permission mode for tool approvals. */
		permissionMode?: "approve-all" | "approve-reads" | "deny-all";

		/**
		 * Only include these skills in the agent context.
		 * Empty array or omitted = include all discovered skills.
		 */
		skillAllowlist?: string[];
	};

	/**
	 * Config overrides merged onto the loaded drmclaw-core config.
	 *
	 * Products can override the LLM provider, model, workspace dir,
	 * or any other config field. Overrides are applied on top of the
	 * real config file (e.g. drmclaw.config.local.ts), not on top of
	 * schema defaults alone.
	 */
	config?: Partial<z.input<typeof configSchema>>;

	/** Timeout in milliseconds. When set, the task is aborted if it
	 *  exceeds this duration. */
	timeoutMs?: number;

	/** Maximum output characters returned. Longer output is truncated. */
	maxOutputChars?: number;
}

/** Structured result from an LLM-native task execution. */
export interface ExecuteTaskResult {
	/** Whether the agent completed the task successfully. */
	status: "completed" | "error";

	/** The agent's final output text. */
	output: string;

	/** Error message when status is "error". */
	error?: string;

	/** Execution duration in milliseconds. */
	durationMs: number;

	/** Unique task identifier assigned by the TaskRunner. */
	taskId: string;

	/**
	 * Runtime events collected in-memory during execution.
	 *
	 * These use the `PersistedRuntimeEvent` envelope type (taskId, sequence,
	 * timestamp, source, event) for structural compatibility with the
	 * server-side event store, but are **not** written to disk by
	 * `executeTask`. Products that need durable persistence should forward
	 * these events to their own store.
	 *
	 * Includes `source: "acp"` entries as proof the real LLM adapter ran.
	 */
	events: PersistedRuntimeEvent[];

	/** LLM provider that was configured for this execution. */
	provider: string;

	/** Model that was requested via config override or loaded config. */
	requestedModel?: string;
}

/**
 * Execute a constrained task through the LLM-native runtime chain.
 *
 * All setup phases (config, skills, adapter, runtime) are inside a
 * structured error boundary so failures always produce a structured
 * {@link ExecuteTaskResult} instead of rejecting the promise.
 *
 * Skills are loaded from the resolved config (system skills +
 * config.skills.dirs) first.  If `request.skillDirs` is provided,
 * those directories are merged additively with deduplication —
 * they do not replace config-driven skills.
 *
 * Timeout triggers real ACP adapter disposal so the subprocess is
 * torn down rather than just racing the promise.  The returned
 * `events` array is a snapshot; late events from abandoned runs
 * are discarded.
 */
export async function executeTask(
	request: ExecuteTaskRequest,
	options?: { onEvent?: (event: RuntimeEvent) => void },
): Promise<ExecuteTaskResult> {
	// 0. Validate prompt — must be non-empty
	if (!request.prompt || request.prompt.trim().length === 0) {
		return {
			status: "error",
			output: "",
			error: "Task prompt must be a non-empty string.",
			durationMs: 0,
			taskId: "",
			events: [],
			provider: "",
		};
	}

	const events: PersistedRuntimeEvent[] = [];
	const startTime = Date.now();
	let lastTaskId = "";
	let config: DrMClawConfig | undefined;
	let adapter: LLMAdapter | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	// Gate that prevents late events from the abandoned run promise
	// from mutating the snapshot after timeout/completion.
	let accepting = true;

	try {
		// 1. Build config — load real config file, merge request overrides on top
		const overrides: Record<string, unknown> = { ...(request.config ?? {}) };
		if (request.policy?.permissionMode) {
			overrides.llm = {
				...((overrides.llm ?? {}) as Record<string, unknown>),
				permissionMode: request.policy.permissionMode,
			};
		}
		config = await loadDrMClawConfig(overrides as Partial<DrMClawConfig>);

		// 2. Load skills — config-driven (system + config.skills.dirs),
		//    then merge request.skillDirs additively with dedup.
		let skills = await loadSkills(config);
		if (request.skillDirs && request.skillDirs.length > 0) {
			const requestSkills = await loadSkillsFromDirs(request.skillDirs);
			const seen = new Set(skills.map((s) => s.name));
			for (const s of requestSkills) {
				if (!seen.has(s.name)) {
					skills.push(s);
					seen.add(s.name);
				}
			}
		}

		// 3. Apply skill allowlist — only include allowed skills in agent context
		if (request.policy?.skillAllowlist && request.policy.skillAllowlist.length > 0) {
			const allowSet = new Set(request.policy.skillAllowlist);
			skills = skills.filter((s) => allowSet.has(s.name));
		}

		// 4. Compose the LLM-native runtime chain
		adapter = createLLMAdapter(config);
		const runtime = createAgentRuntime(config, adapter);
		const runner = new TaskRunner(config, runtime, skills);

		// 5. Run — collect events in memory (no durable EventStore in this path)
		const runPromise = runner.run(request.prompt, {
			workingDir: request.workingDir,
			onEvent: (event) => {
				if (!accepting) return;
				options?.onEvent?.(event);
			},
			onPersistedEvent: (event) => {
				if (!accepting) return;
				events.push(event);
				if (event.taskId) lastTaskId = event.taskId;
			},
		});

		let record: TaskRecord;
		if (request.timeoutMs && request.timeoutMs > 0) {
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
					reject(new Error(`Task timed out after ${request.timeoutMs}ms`));
				}, request.timeoutMs);
			});

			record = await Promise.race([runPromise, timeoutPromise]);
		} else {
			record = await runPromise;
		}

		// Stop accepting events after successful completion
		accepting = false;

		let output = record.result.output;
		if (request.maxOutputChars && output.length > request.maxOutputChars) {
			output = output.slice(0, request.maxOutputChars);
		}

		return {
			status: record.result.status === "completed" ? "completed" : "error",
			output,
			error: record.result.error,
			durationMs: record.result.durationMs,
			taskId: record.id,
			events: [...events],
			provider: config.llm.provider,
			requestedModel: config.llm.model,
		};
	} catch (err) {
		accepting = false;
		const message = err instanceof Error ? err.message : String(err);
		return {
			status: "error",
			output: "",
			error: message,
			durationMs: Date.now() - startTime,
			taskId: lastTaskId,
			events: [...events],
			provider: config?.llm.provider ?? "",
			requestedModel: config?.llm.model,
		};
	} finally {
		// 6. Clean up: cancel pending timeout timer and dispose ACP adapter
		clearTimeout(timer);
		if (adapter) {
			await adapter.dispose();
		}
	}
}
