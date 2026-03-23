import type * as acp from "@agentclientprotocol/sdk";
import type { CliProvider, DrMClawConfig } from "../config/schema.js";
import type { TaskResult } from "../runner/types.js";
import { AcpSessionManager } from "./acp-session.js";
import type { LLMAdapter, LLMAdapterRunOptions } from "./adapter.js";

/**
 * Evaluate a permission request against the tool allowlist.
 *
 * Exported so tests can exercise the real decision logic without
 * spawning an ACP subprocess.
 *
 * Returns a `RequestPermissionResponse` using the ACP protocol's
 * `"selected"` / `"cancelled"` outcome vocabulary with proper `optionId`.
 */
export async function evaluatePermission(
	params: acp.RequestPermissionRequest,
	allowedTools: Set<string>,
	onToolCall?: LLMAdapterRunOptions["onToolCall"],
): Promise<acp.RequestPermissionResponse> {
	const toolTitle = params.toolCall?.title ?? "";
	const isAllowed = allowedTools.size === 0 || allowedTools.has(toolTitle);

	if (!isAllowed && onToolCall) {
		const decision = await onToolCall(toolTitle, params);
		if (decision === "approved") {
			return selectedOutcome(params);
		}
		return { outcome: { outcome: "cancelled" } };
	}

	if (isAllowed) {
		return selectedOutcome(params);
	}

	return { outcome: { outcome: "cancelled" } };
}

/** Build a "selected" outcome, picking the first allow-* option from params. */
function selectedOutcome(params: acp.RequestPermissionRequest): acp.RequestPermissionResponse {
	const allowOption = params.options?.find(
		(o: acp.PermissionOption) => o.kind === "allow_once" || o.kind === "allow_always",
	);
	const optionId = allowOption?.optionId ?? params.options?.[0]?.optionId ?? "allow";
	return { outcome: { outcome: "selected", optionId } };
}

/**
 * ACP adapter — generic ACP client that spawns any ACP-compatible CLI.
 *
 * The command is resolved from `llm.provider` + `llm.acp` via `resolveAcpCommandArgs()`.
 * Provider defaults: `github-copilot` → `copilot --acp --stdio`,
 * `claude-cli` → `claude --acp --stdio`, etc.
 *
 * Only instantiated for CLI providers (github-copilot, claude-cli, openai-cli, gemini-cli).
 * Uses `AcpSessionManager` to manage process lifecycle and session mapping.
 * Emits structured `AdapterEvent`s for text chunks and tool calls.
 * Implements `requestPermission` callback → drmclaw's tool allowlist policy.
 */
export class AcpAdapter implements LLMAdapter {
	private readonly sessions: AcpSessionManager;

	constructor(
		private readonly config: DrMClawConfig,
		sessionManager?: AcpSessionManager,
	) {
		this.sessions = sessionManager ?? new AcpSessionManager();
	}

	async run(options: LLMAdapterRunOptions): Promise<TaskResult> {
		const startTime = Date.now();
		const allowedTools = new Set(options.allowedTools ?? this.config.llm.allowedTools);
		const emit = options.onEvent;
		let output = "";

		// Use provided sessionId or generate a one-off ID
		const taskSessionId = options.sessionId ?? `acp-${Date.now()}`;

		try {
			const client: acp.Client = {
				async requestPermission(params) {
					return evaluatePermission(params, allowedTools, options.onToolCall);
				},
				async sessionUpdate(params) {
					const update = params.update;
					if (!update) return;

					if (update.sessionUpdate === "agent_message_chunk") {
						const content = (update as { content?: { type?: string; text?: string } }).content;
						if (content?.type === "text" && content.text) {
							output += content.text;
							emit?.({ type: "text", text: content.text });
						}
					} else if (update.sessionUpdate === "tool_call") {
						const toolCall = update as {
							title?: string;
							status?: string;
							toolCallId?: string;
						};
						emit?.({
							type: "tool_call",
							tool: toolCall.title ?? "unknown",
							status: toolCall.status ?? "pending",
						});
					} else if (update.sessionUpdate === "tool_call_update") {
						const toolUpdate = update as {
							toolCallId?: string;
							title?: string;
							status?: string;
							rawOutput?: unknown;
							content?: unknown;
						};
						// Emit tool_call for every status update so downstream
						// sees the full lifecycle (in_progress → completed / failed).
						if (toolUpdate.status) {
							emit?.({
								type: "tool_call",
								tool: toolUpdate.title ?? "unknown",
								status: toolUpdate.status,
							});
						}
						// When the tool finishes, emit a tool_result with whatever
						// output the ACP server reported.
						if (toolUpdate.status === "completed" || toolUpdate.status === "failed") {
							emit?.({
								type: "tool_result",
								tool: toolUpdate.title ?? "unknown",
								result: toolUpdate.rawOutput ?? toolUpdate.content,
							});
						}
					}
				},
			};

			const session = await this.sessions.acquire(
				taskSessionId,
				this.config.llm.provider as CliProvider,
				this.config.llm.acp,
				client,
				{ cwd: options.workingDir },
			);

			// Build the prompt parts — include system context if provided
			const promptParts: acp.ContentBlock[] = [];
			if (options.systemContext) {
				promptParts.push({ type: "text", text: options.systemContext });
			}
			promptParts.push({ type: "text", text: options.prompt });

			const result = await session.connection.prompt({
				sessionId: session.sessionId,
				prompt: promptParts,
			});

			return {
				status: result.stopReason === "cancelled" ? "error" : "completed",
				output,
				durationMs: Date.now() - startTime,
			};
		} catch (error) {
			return {
				status: "error",
				output: "",
				error: error instanceof Error ? error.message : String(error),
				durationMs: Date.now() - startTime,
			};
		} finally {
			// For one-off sessions (no externally supplied sessionId), clean up
			if (!options.sessionId) {
				this.sessions.cancel(taskSessionId);
			}
		}
	}

	async dispose(): Promise<void> {
		await this.sessions.dispose();
	}
}
