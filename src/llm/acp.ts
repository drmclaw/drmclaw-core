import type * as acp from "@agentclientprotocol/sdk";
import type { CliProvider, DrMClawConfig } from "../config/schema.js";
import type { TaskResult } from "../runner/types.js";
import { AcpSessionManager } from "./acp-session.js";
import type { LLMAdapter, LLMAdapterRunOptions, PermissionMode } from "./adapter.js";

/** Tool kinds that are considered safe read-only operations. */
const READ_SAFE_KINDS = new Set(["read", "search", "think", "fetch"]);

/**
 * Evaluate a permission request using the three-mode model.
 *
 * Modes:
 * - `"approve-all"`   — approve every tool call
 * - `"approve-reads"` — auto-approve read/search/think/fetch kinds, reject others
 * - `"deny-all"`      — reject every tool call
 *
 * The optional `onToolCall` callback overrides the mode decision for
 * tools that would otherwise be rejected — useful for interactive
 * approval UIs.
 *
 * ACP protocol semantics:
 * - `"selected"` with an allow optionId  → agent executes the tool
 * - `"selected"` with a reject optionId  → agent skips the tool **and continues**
 * - `"cancelled"`                        → the entire turn was cancelled (session/cancel)
 *
 * We never return `"cancelled"` here because denying a single tool call
 * is not the same as cancelling the whole turn.
 */
export async function evaluatePermission(
	params: acp.RequestPermissionRequest,
	mode: PermissionMode,
	onToolCall?: LLMAdapterRunOptions["onToolCall"],
): Promise<acp.RequestPermissionResponse> {
	const toolKind = params.toolCall?.kind ?? "";
	const toolTitle = params.toolCall?.title ?? "";

	let allowed: boolean;
	switch (mode) {
		case "approve-all":
			allowed = true;
			break;
		case "deny-all":
			allowed = false;
			break;
		case "approve-reads":
			allowed = READ_SAFE_KINDS.has(toolKind);
			break;
	}

	if (!allowed && onToolCall) {
		const decision = await onToolCall(toolTitle, params);
		if (decision === "approved") {
			return allowOutcome(params);
		}
		return rejectOutcome(params);
	}

	return allowed ? allowOutcome(params) : rejectOutcome(params);
}

/** Build a "selected" outcome, picking the first allow-* option from params. */
function allowOutcome(params: acp.RequestPermissionRequest): acp.RequestPermissionResponse {
	const allowOption = params.options?.find(
		(o: acp.PermissionOption) => o.kind === "allow_once" || o.kind === "allow_always",
	);
	const optionId = allowOption?.optionId ?? params.options?.[0]?.optionId ?? "allow";
	return { outcome: { outcome: "selected", optionId } };
}

/** Build a "selected" outcome choosing the reject option so the agent continues. */
function rejectOutcome(params: acp.RequestPermissionRequest): acp.RequestPermissionResponse {
	const rejectOption = params.options?.find(
		(o: acp.PermissionOption) => o.kind === "reject_once" || o.kind === "reject_always",
	);
	const optionId = rejectOption?.optionId ?? "reject";
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
		this.sessions = sessionManager ?? new AcpSessionManager(config.llm.excludeModels);
	}

	async setModel(model: string): Promise<void> {
		(this.config.llm as { model?: string }).model = model;
		await this.sessions.setModel(model);
	}

	getAvailableModels(): Array<{ id: string; name: string }> {
		return this.sessions.getDiscoveredModels();
	}

	async discoverModels(): Promise<Array<{ id: string; name: string }>> {
		return this.sessions.discoverModels(
			this.config.llm.provider as CliProvider,
			this.config.llm.acp,
		);
	}

	async run(options: LLMAdapterRunOptions): Promise<TaskResult> {
		const startTime = Date.now();
		const mode = options.permissionMode ?? this.config.llm.permissionMode;
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
					return evaluatePermission(params, mode, options.onToolCall);
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
				{ cwd: options.workingDir, model: this.config.llm.model },
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
