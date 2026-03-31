import { isCliProvider } from "../config/schema.js";
import type { DrMClawConfig } from "../config/schema.js";
import type { AdapterEvent, LLMAdapter } from "../llm/adapter.js";
import type { TaskResult } from "../runner/types.js";
import type {
	AcpRuntimeOptions,
	AgentRuntime,
	AgentRuntimeOptions,
	RuntimeEvent,
} from "./types.js";

/** Map an adapter-level event to the runtime event vocabulary.
 *  All adapter events originate from the LLM provider → source: "acp". */
function mapAdapterEvent(event: AdapterEvent): RuntimeEvent {
	switch (event.type) {
		case "text":
			return { source: "acp", type: "stream", delta: event.text };
		case "tool_call":
			return {
				source: "acp",
				type: "tool_call",
				tool: event.tool,
				status: event.status,
				...(event.kind && { kind: event.kind }),
				args: event.args,
				toolCallId: event.toolCallId,
			};
		case "tool_result":
			return {
				source: "acp",
				type: "tool_result",
				tool: event.tool,
				result: event.result,
				toolCallId: event.toolCallId,
			};
		case "thinking":
			return { source: "acp", type: "thinking", text: event.text };
		case "plan":
			return { source: "acp", type: "plan", entries: event.entries };
		case "usage":
			return {
				source: "acp",
				type: "usage",
				used: event.used,
				size: event.size,
				...(event.cost && { cost: event.cost }),
			};
	}
}

/**
 * ACP runtime — delegates the tool-calling loop to an ACP server.
 *
 * drmclaw injects skills into the system prompt and enforces policies
 * via the LLMAdapter's tool allowlist.
 */
export class AcpRuntime implements AgentRuntime {
	constructor(
		private readonly config: DrMClawConfig,
		private readonly adapter: LLMAdapter,
	) {}

	async run(options: AcpRuntimeOptions): Promise<TaskResult> {
		const emit = (event: RuntimeEvent) => options.onEvent?.(event);

		emit({ source: "runtime", type: "lifecycle", phase: "start" });

		try {
			// Use the full system prompt assembled by the runner (includes
			// Tooling, Safety, Skills, Workspace bootstrap, Runtime, Time).
			// Falls back to empty string if not provided.
			const systemContext = options.systemContext ?? "";

			const permissionMode = options.policy?.permissionMode ?? this.config.llm.permissionMode;

			emit({ source: "runtime", type: "lifecycle", phase: "prompt_sent" });

			const result = await this.adapter.run({
				prompt: options.prompt,
				systemContext,
				workingDir: options.workingDir,
				permissionMode,
				sessionId: options.sessionId,
				onEvent: (adapterEvent) => emit(mapAdapterEvent(adapterEvent)),
			});

			emit({ source: "runtime", type: "lifecycle", phase: "end", result });
			return result;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			emit({ source: "runtime", type: "lifecycle", phase: "error", error: message });
			return {
				status: "error",
				output: "",
				error: message,
				durationMs: 0,
			};
		}
	}
}

/**
 * Create the appropriate AgentRuntime based on config.
 *
 * CLI providers route to AcpRuntime; embedded providers will route to
 * a direct-provider runtime (future).
 */
export function createAgentRuntime(config: DrMClawConfig, adapter: LLMAdapter): AgentRuntime {
	if (isCliProvider(config.llm.provider)) {
		return new AcpRuntime(config, adapter);
	}

	// Future: DirectProviderRuntime using Vercel AI SDK Core with maxSteps
	throw new Error(
		`Embedded provider "${config.llm.provider}" is not yet implemented. Use a CLI provider (github-copilot, claude-cli, openai-cli, gemini-cli).`,
	);
}
