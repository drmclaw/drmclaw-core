export type RequestId = string | number;

export interface JsonRpcRequest<TParams = unknown> {
	id: RequestId;
	method: string;
	params?: TParams;
}

export interface JsonRpcNotification<TParams = unknown> {
	method: string;
	params?: TParams;
}

export interface JsonRpcSuccess<TResult = unknown> {
	id: RequestId;
	result: TResult;
}

export interface JsonRpcFailure {
	id: RequestId;
	error: {
		code: number;
		message: string;
		data?: unknown;
	};
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcSuccess | JsonRpcFailure;

export interface InitializeParams {
	clientInfo: {
		name: string;
		title: string;
		version: string;
	};
	capabilities: null;
}

export type CodexApprovalPolicy = "untrusted" | "on-failure" | "on-request" | "never";
export type CodexSandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export type CodexReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface ThreadStartParams {
	model?: string | null;
	cwd?: string | null;
	approvalPolicy?: CodexApprovalPolicy | null;
	sandbox?: CodexSandboxMode | null;
	developerInstructions?: string | null;
	ephemeral?: boolean | null;
}

export interface ThreadStartResponse {
	thread: { id: string };
	model?: string | null;
	modelProvider?: string | null;
	cwd?: string | null;
	reasoningEffort?: CodexReasoningEffort | null;
}

export interface UserTextInput {
	type: "text";
	text: string;
	text_elements: [];
}

export interface TurnStartParams {
	threadId: string;
	input: UserTextInput[];
	cwd?: string | null;
	approvalPolicy?: CodexApprovalPolicy | null;
	sandboxPolicy?: unknown;
	model?: string | null;
	effort?: CodexReasoningEffort | null;
}

export interface TurnStartResponse {
	turn: Turn;
}

export type TurnStatus = "completed" | "interrupted" | "failed" | "inProgress";

export interface Turn {
	id: string;
	items: ThreadItem[];
	status: TurnStatus;
	error: { message?: string; code?: string } | string | null;
	durationMs: number | null;
}

export type ThreadItem =
	| { type: "agentMessage"; id: string; text: string; phase?: string | null }
	| { type: "reasoning"; id: string; summary?: string[]; content?: string[] }
	| { type: "plan"; id: string; text: string }
	| {
			type: "commandExecution";
			id: string;
			command: string;
			cwd?: string;
			status: string;
			aggregatedOutput?: string | null;
			exitCode?: number | null;
	  }
	| { type: "fileChange"; id: string; changes?: unknown[]; status: string }
	| {
			type: "mcpToolCall";
			id: string;
			server: string;
			tool: string;
			status: string;
			arguments?: unknown;
			result?: unknown;
			error?: unknown;
	  }
	| {
			type: "dynamicToolCall";
			id: string;
			namespace?: string | null;
			tool: string;
			arguments?: unknown;
			status: string;
			contentItems?: unknown;
			success?: boolean | null;
	  };

export interface AgentMessageDeltaNotification {
	threadId: string;
	turnId: string;
	itemId: string;
	delta: string;
}

export interface ItemStartedNotification {
	threadId: string;
	turnId: string;
	item: ThreadItem;
}

export interface ItemCompletedNotification {
	threadId: string;
	turnId: string;
	item: ThreadItem;
}

export interface TurnCompletedNotification {
	threadId: string;
	turn: Turn;
}
