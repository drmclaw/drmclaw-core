import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { DrMClawConfig } from "../config/schema.js";
import { resolveCodexAppServerCommandArgs } from "../config/schema.js";
import type { TaskResult } from "../runner/types.js";
import type { AdapterEvent, LLMAdapter, LLMAdapterRunOptions } from "./adapter.js";
import type {
	AgentMessageDeltaNotification,
	InitializeParams,
	ItemCompletedNotification,
	ItemStartedNotification,
	JsonRpcMessage,
	JsonRpcNotification,
	JsonRpcRequest,
	RequestId,
	ThreadItem,
	ThreadStartParams,
	ThreadStartResponse,
	Turn,
	TurnCompletedNotification,
	TurnStartParams,
	TurnStartResponse,
} from "./codex-app-server-protocol.js";

type PendingRequest = {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
};

function gracefulKill(proc: ChildProcessWithoutNullStreams): void {
	try {
		proc.stdin.end();
	} catch {
		// Ignore EPIPE during teardown.
	}
	try {
		proc.kill("SIGTERM");
	} catch {
		return;
	}
	const timer = setTimeout(() => {
		if (proc.exitCode === null && proc.signalCode === null) {
			try {
				proc.kill("SIGKILL");
			} catch {
				// Ignore kill races.
			}
		}
	}, 250);
	timer.unref();
}

function errorMessage(error: unknown): string {
	if (typeof error === "string") return error;
	if (error && typeof error === "object" && "message" in error) {
		const message = (error as { message?: unknown }).message;
		if (typeof message === "string") return message;
	}
	return JSON.stringify(error);
}

function toolNameForItem(item: ThreadItem): string {
	switch (item.type) {
		case "commandExecution":
			return item.command;
		case "fileChange":
			return "file_change";
		case "mcpToolCall":
			return `${item.server}.${item.tool}`;
		case "dynamicToolCall":
			return item.namespace ? `${item.namespace}.${item.tool}` : item.tool;
		default:
			return "unknown";
	}
}

function toolArgsForItem(item: ThreadItem): unknown {
	switch (item.type) {
		case "commandExecution":
			return { command: item.command, cwd: item.cwd };
		case "fileChange":
			return item.changes;
		case "mcpToolCall":
		case "dynamicToolCall":
			return item.arguments;
		default:
			return undefined;
	}
}

function toolResultForItem(item: ThreadItem): unknown {
	switch (item.type) {
		case "commandExecution":
			return {
				output: item.aggregatedOutput,
				exitCode: item.exitCode,
			};
		case "fileChange":
			return { status: item.status, changes: item.changes };
		case "mcpToolCall":
			return item.error ?? item.result;
		case "dynamicToolCall":
			return item.contentItems ?? { success: item.success };
		default:
			return undefined;
	}
}

function isToolItem(item: ThreadItem): boolean {
	return (
		item.type === "commandExecution" ||
		item.type === "fileChange" ||
		item.type === "mcpToolCall" ||
		item.type === "dynamicToolCall"
	);
}

function mapItemStarted(item: ThreadItem): AdapterEvent | null {
	if (!isToolItem(item)) return null;
	return {
		type: "tool_call",
		tool: toolNameForItem(item),
		status: "status" in item && typeof item.status === "string" ? item.status : "pending",
		kind: item.type,
		toolCallId: typeof item.id === "string" ? item.id : undefined,
		args: toolArgsForItem(item),
	};
}

function mapItemCompleted(item: ThreadItem): AdapterEvent[] {
	if (item.type === "reasoning") {
		const text = [...(item.summary ?? []), ...(item.content ?? [])].join("\n").trim();
		return text ? [{ type: "thinking", text }] : [];
	}
	if (item.type === "plan" && item.text.trim()) {
		return [
			{
				type: "plan",
				entries: [{ content: item.text, priority: "medium", status: "pending" }],
			},
		];
	}
	if (!isToolItem(item)) return [];
	const base = {
		tool: toolNameForItem(item),
		toolCallId: typeof item.id === "string" ? item.id : undefined,
	};
	return [
		{ type: "tool_result", ...base, result: toolResultForItem(item) },
		{
			type: "tool_call",
			...base,
			status: "status" in item && typeof item.status === "string" ? item.status : "completed",
			kind: item.type,
			args: toolArgsForItem(item),
		},
	];
}

function finalTextFromTurn(turn: Turn): string {
	return turn.items
		.filter(
			(item): item is Extract<ThreadItem, { type: "agentMessage" }> => item.type === "agentMessage",
		)
		.map((item) => item.text)
		.join("");
}

class CodexJsonRpcClient {
	private nextId = 1;
	private pending = new Map<RequestId, PendingRequest>();
	private stderr = "";
	private closed = false;

	constructor(
		private readonly proc: ChildProcessWithoutNullStreams,
		private readonly onNotification: (message: JsonRpcNotification) => void,
		private readonly onServerRequest: (message: JsonRpcRequest) => void,
	) {
		const lines = createInterface({ input: proc.stdout });
		lines.on("line", (line) => this.handleLine(line));
		proc.stderr.on("data", (chunk) => {
			this.stderr += chunk.toString();
		});
		proc.once("error", (error) => this.rejectAll(error));
		proc.once("exit", (code, signal) => {
			this.closed = true;
			if (this.pending.size > 0) {
				const suffix = this.stderr.trim() ? `\n${this.stderr.trim()}` : "";
				this.rejectAll(
					new Error(`Codex App Server exited (${signal ?? code ?? "unknown"}).${suffix}`),
				);
			}
		});
	}

	request<TResult>(method: string, params: unknown): Promise<TResult> {
		if (this.closed) {
			return Promise.reject(new Error("Codex App Server process is closed."));
		}
		const id = this.nextId++;
		const message = { id, method, params };
		return new Promise<TResult>((resolve, reject) => {
			this.pending.set(id, {
				resolve: (value) => resolve(value as TResult),
				reject,
			});
			this.send(message);
		});
	}

	notify(method: string, params?: unknown): void {
		this.send(params === undefined ? { method } : { method, params });
	}

	respond(id: RequestId, result: unknown): void {
		this.send({ id, result });
	}

	error(id: RequestId, code: number, message: string): void {
		this.send({ id, error: { code, message } });
	}

	private send(message: unknown): void {
		this.proc.stdin.write(`${JSON.stringify(message)}\n`);
	}

	private handleLine(line: string): void {
		if (!line.trim()) return;
		let message: JsonRpcMessage;
		try {
			message = JSON.parse(line) as JsonRpcMessage;
		} catch {
			return;
		}

		if ("id" in message && ("result" in message || "error" in message)) {
			const pending = this.pending.get(message.id);
			if (!pending) return;
			this.pending.delete(message.id);
			if ("error" in message) {
				pending.reject(new Error(message.error.message));
			} else {
				pending.resolve(message.result);
			}
			return;
		}

		if ("id" in message && "method" in message) {
			this.onServerRequest(message);
			return;
		}

		if ("method" in message) {
			this.onNotification(message);
		}
	}

	private rejectAll(error: unknown): void {
		const err = error instanceof Error ? error : new Error(String(error));
		for (const pending of this.pending.values()) {
			pending.reject(err);
		}
		this.pending.clear();
	}
}

export class CodexAppServerAdapter implements LLMAdapter {
	private activeProcess?: ChildProcessWithoutNullStreams;
	private activeClient?: CodexJsonRpcClient;
	private activeThreadId?: string;
	private activeTurnId?: string;

	constructor(private readonly config: DrMClawConfig) {}

	async setModel(model: string): Promise<void> {
		(this.config.llm as { model?: string }).model = model;
	}

	getAvailableModels(): Array<{ id: string; name: string }> {
		return this.config.llm.model
			? [{ id: this.config.llm.model, name: this.config.llm.model }]
			: [];
	}

	async discoverModels(): Promise<Array<{ id: string; name: string }>> {
		return this.getAvailableModels();
	}

	async run(options: LLMAdapterRunOptions): Promise<TaskResult> {
		const startTime = Date.now();
		const { command, args } = resolveCodexAppServerCommandArgs(this.config.llm.codex);
		let output = "";
		let completeTurn: ((turn: Turn) => void) | undefined;

		const turnCompleted = new Promise<Turn>((resolve) => {
			completeTurn = resolve;
		});

		try {
			const proc = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
			this.activeProcess = proc;
			const processClosed = new Promise<never>((_, reject) => {
				proc.once("exit", (code, signal) => {
					reject(
						new Error(
							`Codex App Server exited before turn completion (${signal ?? code ?? "unknown"}).`,
						),
					);
				});
				proc.once("error", (error) => reject(error));
			});

			const client = new CodexJsonRpcClient(
				proc,
				(message) => {
					switch (message.method) {
						case "item/agentMessage/delta": {
							const params = message.params as AgentMessageDeltaNotification;
							output += params.delta;
							options.onEvent?.({ type: "text", text: params.delta });
							break;
						}
						case "item/started": {
							const event = mapItemStarted((message.params as ItemStartedNotification).item);
							if (event) options.onEvent?.(event);
							break;
						}
						case "item/completed": {
							for (const event of mapItemCompleted(
								(message.params as ItemCompletedNotification).item,
							)) {
								options.onEvent?.(event);
							}
							break;
						}
						case "item/reasoning/textDelta":
						case "item/reasoning/summaryTextDelta": {
							const delta = (message.params as { delta?: string }).delta;
							if (delta) options.onEvent?.({ type: "thinking", text: delta });
							break;
						}
						case "item/plan/delta": {
							const delta = (message.params as { delta?: string }).delta;
							if (delta) {
								options.onEvent?.({
									type: "plan",
									entries: [{ content: delta, priority: "medium", status: "pending" }],
								});
							}
							break;
						}
						case "turn/completed": {
							const params = message.params as TurnCompletedNotification;
							completeTurn?.(params.turn);
							break;
						}
					}
				},
				(message) => {
					if (
						message.method === "item/commandExecution/requestApproval" ||
						message.method === "execCommandApproval" ||
						message.method === "applyPatchApproval" ||
						message.method === "item/fileChange/requestApproval"
					) {
						const decision = options.permissionMode === "deny-all" ? "decline" : "accept";
						client.respond(message.id, { decision });
						return;
					}
					client.error(
						message.id,
						-32601,
						`Unsupported Codex App Server request: ${message.method}`,
					);
				},
			);
			this.activeClient = client;

			await client.request("initialize", {
				clientInfo: {
					name: "drmclaw_core",
					title: "Dr. MClaw Core",
					version: "0.1.0",
				},
				capabilities: null,
			} satisfies InitializeParams);
			client.notify("initialized", {});

			const threadParams: ThreadStartParams = {
				model: this.config.llm.model ?? null,
				cwd: options.workingDir ?? null,
				approvalPolicy: this.config.llm.codex.approvalPolicy,
				sandbox: this.config.llm.codex.sandbox,
				developerInstructions: options.systemContext ?? null,
				ephemeral: true,
			};
			const thread = await client.request<ThreadStartResponse>("thread/start", threadParams);
			this.activeThreadId = thread.thread.id;

			const turnParams: TurnStartParams = {
				threadId: thread.thread.id,
				input: [{ type: "text", text: options.prompt, text_elements: [] }],
				cwd: options.workingDir ?? null,
				approvalPolicy: this.config.llm.codex.approvalPolicy,
				model: this.config.llm.model ?? null,
				effort: this.config.llm.reasoningEffort ?? null,
			};
			const startedTurn = await client.request<TurnStartResponse>("turn/start", turnParams);
			this.activeTurnId = startedTurn.turn.id;
			const turn = await Promise.race([turnCompleted, processClosed]);
			this.activeTurnId = undefined;

			if (!output) {
				output = finalTextFromTurn(turn);
			}

			if (turn.status === "completed") {
				return { status: "completed", output, durationMs: Date.now() - startTime };
			}

			return {
				status: "error",
				output,
				error: turn.error
					? errorMessage(turn.error)
					: `Codex turn ended with status: ${turn.status}`,
				durationMs: Date.now() - startTime,
			};
		} catch (error) {
			return {
				status: "error",
				output,
				error: error instanceof Error ? error.message : String(error),
				durationMs: Date.now() - startTime,
			};
		} finally {
			await this.dispose();
		}
	}

	async dispose(): Promise<void> {
		if (this.activeClient && this.activeThreadId && this.activeTurnId) {
			try {
				this.activeClient
					.request("turn/interrupt", { threadId: this.activeThreadId, turnId: this.activeTurnId })
					.catch(() => {});
			} catch {
				// Best effort only; the process is about to be terminated.
			}
		}
		if (this.activeProcess) {
			gracefulKill(this.activeProcess);
		}
		this.activeClient = undefined;
		this.activeThreadId = undefined;
		this.activeTurnId = undefined;
		this.activeProcess = undefined;
	}
}
