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
	allowedToolKinds?: Set<string>,
): Promise<acp.RequestPermissionResponse> {
	const toolTitle = params.toolCall?.title ?? "";
	const toolKind = params.toolCall?.kind ?? "";

	const titleAllowed = allowedTools.size === 0 || allowedTools.has(toolTitle);
	const kindAllowed =
		!allowedToolKinds || allowedToolKinds.size === 0 || allowedToolKinds.has(toolKind);
	const isAllowed = titleAllowed && kindAllowed;

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
		const allowedToolKinds = new Set(
			options.allowedToolKinds ?? this.config.llm.allowedToolKinds,
		);
		const emit = options.onEvent;
		let output = "";
		// Cache toolCallId → title/kind so tool_call_update events (which
		// may lack title/kind) can resolve the originals.
		const toolTitleByCallId = new Map<string, string>();
		const toolKindByCallId = new Map<string, string>();

		// Use provided sessionId or generate a one-off ID
		const taskSessionId = options.sessionId ?? `acp-${Date.now()}`;

		try {
			const client: acp.Client = {
				async requestPermission(params) {
					return evaluatePermission(
						params,
						allowedTools,
						options.onToolCall,
						allowedToolKinds,
					);
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
					} else if (update.sessionUpdate === "agent_thought_chunk") {
						const content = (update as { content?: { type?: string; text?: string } }).content;
						if (content?.type === "text" && content.text) {
							emit?.({ type: "thinking", text: content.text });
						}
					} else if (update.sessionUpdate === "tool_call") {
						const toolCall = update as {
							title?: string;
							status?: string;
							toolCallId?: string;
							rawInput?: unknown;
							kind?: string;
						};
						if (toolCall.toolCallId && toolCall.title) {
							toolTitleByCallId.set(toolCall.toolCallId, toolCall.title);
						}
						if (toolCall.toolCallId && toolCall.kind) {
							toolKindByCallId.set(toolCall.toolCallId, toolCall.kind);
						}
						emit?.({
							type: "tool_call",
							tool: toolCall.title ?? "unknown",
							status: toolCall.status ?? "pending",
							...(toolCall.kind && { kind: toolCall.kind }),
							toolCallId: toolCall.toolCallId,
							args: toolCall.rawInput,
						});
					} else if (update.sessionUpdate === "tool_call_update") {
						const toolUpdate = update as {
							toolCallId?: string;
							title?: string;
							status?: string;
							rawOutput?: unknown;
							rawInput?: unknown;
							content?: unknown;
							kind?: string;
						};
						const resolvedTitle =
							toolUpdate.title ?? toolTitleByCallId.get(toolUpdate.toolCallId ?? "") ?? "unknown";
						const resolvedKind =
							toolUpdate.kind ?? toolKindByCallId.get(toolUpdate.toolCallId ?? "");
						// When the tool finishes, emit tool_result FIRST so the
						// event timeline reads: pending → result → completed.
						if (toolUpdate.status === "completed" || toolUpdate.status === "failed") {
							emit?.({
								type: "tool_result",
								tool: resolvedTitle,
								result: toolUpdate.rawOutput ?? toolUpdate.content,
								toolCallId: toolUpdate.toolCallId,
							});
						}
						// Emit tool_call for every status update so downstream
						// sees the full lifecycle (in_progress → completed / failed).
						if (toolUpdate.status) {
							emit?.({
								type: "tool_call",
								tool: resolvedTitle,
								status: toolUpdate.status,
								...(resolvedKind && { kind: resolvedKind }),
								toolCallId: toolUpdate.toolCallId,
								args: toolUpdate.rawInput,
							});
						}
					} else if (update.sessionUpdate === "plan") {
						const plan = update as {
							entries?: Array<{
								content?: string;
								priority?: string;
								status?: string;
							}>;
						};
						if (plan.entries && plan.entries.length > 0) {
							emit?.({
								type: "plan",
								entries: plan.entries.map((e) => ({
									content: e.content ?? "",
									priority: e.priority ?? "medium",
									status: e.status ?? "pending",
								})),
							});
						}
					} else if (update.sessionUpdate === "usage_update") {
						const usage = update as {
							used?: number;
							size?: number;
							cost?: { amount: number; currency: string } | null;
						};
						if (typeof usage.used === "number" && typeof usage.size === "number") {
							emit?.({
								type: "usage",
								used: usage.used,
								size: usage.size,
								...(usage.cost && { cost: usage.cost }),
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
