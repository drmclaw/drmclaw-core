import { useCallback, useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { UseWebSocketReturn } from "../hooks/useWebSocket.js";
import {
	type EventLogEntry,
	type UnifiedDisplayItem,
	buildUnifiedDisplay,
} from "./debugDisplayUtils.js";

interface ChatMessage {
	role: "user" | "assistant";
	content: string;
}

function formatTime(iso: string): string {
	try {
		return new Date(iso).toLocaleTimeString([], {
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
		});
	} catch {
		return iso;
	}
}

// ── Main component ───────────────────────────────────────────────────

export function DebugConsole({ ws }: { ws: UseWebSocketReturn }) {
	const [input, setInput] = useState("");
	const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
	const [eventLog, setEventLog] = useState<EventLogEntry[]>([]);
	const [streaming, setStreaming] = useState(false);
	const [currentTaskId, setCurrentTaskId] = useState<string | null>(null);

	const chatBottomRef = useRef<HTMLDivElement>(null);
	const eventsBottomRef = useRef<HTMLDivElement>(null);

	// Replay events from HTTP on mount (latest task)
	const replayTask = useCallback(async (taskId: string) => {
		try {
			const res = await fetch(`/api/tasks/${taskId}/events`);
			if (!res.ok) return;
			const events = (await res.json()) as Array<{
				taskId: string;
				sequence: number;
				timestamp: string;
				source: string;
				event: Record<string, unknown>;
			}>;

			const entries: EventLogEntry[] = [];
			const chatMsgs: ChatMessage[] = [];
			let assistantText = "";

			for (const e of events) {
				const evt = e.event as Record<string, unknown>;
				entries.push({
					sequence: e.sequence,
					timestamp: e.timestamp,
					source: e.source as EventLogEntry["source"],
					event: evt as EventLogEntry["event"],
				});
				if (evt.type === "stream" && evt.delta) {
					assistantText += String(evt.delta);
				}
			}

			if (assistantText) {
				chatMsgs.push({ role: "assistant", content: assistantText });
			}

			setEventLog(entries);
			if (chatMsgs.length > 0) {
				setChatMessages((prev) => {
					if (prev.length > 0 && prev[prev.length - 1]?.role === "assistant") return prev;
					return [...prev, ...chatMsgs];
				});
			}
		} catch {
			// Replay failed silently
		}
	}, []);

	// Load last task on mount (in-memory first, then persisted fallback)
	useEffect(() => {
		(async () => {
			let tasks: Array<{ id: string; prompt: string }> = [];
			try {
				const res = await fetch("/api/tasks");
				if (res.ok) tasks = (await res.json()) as Array<{ id: string; prompt: string }>;
			} catch {
				/* ignore */
			}

			// Fallback to persisted task list (survives backend restarts)
			if (tasks.length === 0) {
				try {
					const res = await fetch("/api/events/tasks");
					if (res.ok) tasks = (await res.json()) as Array<{ id: string; prompt: string }>;
				} catch {
					/* ignore */
				}
			}

			if (tasks.length === 0) return;
			const last = tasks[tasks.length - 1];
			if (last) {
				setCurrentTaskId(last.id);
				setChatMessages([{ role: "user", content: last.prompt }]);
				await replayTask(last.id);
			}
		})();
	}, [replayTask]);

	// Process incoming WebSocket messages
	useEffect(() => {
		if (!ws.lastMessage) return;
		const msg = ws.lastMessage;

		if (msg.type === "event") {
			const source = msg.source as string;
			const seq = msg.sequence as number;
			const ts = msg.timestamp as string;
			const event = msg.event as Record<string, unknown>;
			const eventType = event.type as string;

			setEventLog((prev) => [
				...prev,
				{
					sequence: seq,
					timestamp: ts,
					source: source as EventLogEntry["source"],
					event: event as EventLogEntry["event"],
				},
			]);

			if (eventType === "lifecycle") {
				const phase = event.phase as string;
				if (phase === "start") {
					setStreaming(true);
					setChatMessages((prev) => [...prev, { role: "assistant", content: "" }]);
				} else if (phase === "end" || phase === "error") {
					setStreaming(false);
				}
			}

			if (eventType === "stream") {
				const delta = event.delta as string;
				setChatMessages((prev) => {
					const updated = [...prev];
					const lastIdx = updated.length - 1;
					const last = updated[lastIdx];
					if (last?.role === "assistant") {
						updated[lastIdx] = { ...last, content: last.content + delta };
					}
					return updated;
				});
			}

			if (msg.taskId) {
				setCurrentTaskId(msg.taskId as string);
			}
		} else if (msg.type === "result") {
			setStreaming(false);
		}
	}, [ws.lastMessage]);

	// Auto-scroll each column
	useEffect(() => {
		chatBottomRef.current?.scrollIntoView({ behavior: "smooth" });
	}, [chatMessages]);
	useEffect(() => {
		eventsBottomRef.current?.scrollIntoView({ behavior: "smooth" });
	}, [eventLog]);

	function handleNew() {
		setChatMessages([]);
		setEventLog([]);
		setCurrentTaskId(null);
		setStreaming(false);
		setInput("");
	}

	function handleSend() {
		const trimmed = input.trim();
		if (!trimmed || streaming) return;

		// Clear logs for new task
		setEventLog([]);
		setChatMessages((prev) => [...prev, { role: "user", content: trimmed }]);
		ws.send({ type: "chat", message: trimmed });
		setInput("");
	}

	const unifiedDisplay = buildUnifiedDisplay(eventLog, streaming);

	return (
		<div className="flex h-[calc(100vh-3.5rem)] divide-x divide-gray-800">
			{/* Column 1: User Chat */}
			<div className="flex-1 flex flex-col min-w-0">
				<div className="px-4 py-2 border-b border-gray-800 text-xs font-medium text-gray-400 uppercase tracking-wider flex items-center justify-between">
					<span>User Chat</span>
					<button
						type="button"
						onClick={handleNew}
						disabled={streaming}
						className="px-2 py-0.5 text-[10px] font-semibold rounded bg-gray-800 text-gray-300 hover:bg-gray-700 hover:text-white disabled:opacity-50 transition-colors"
					>
						+ New
					</button>
				</div>
				<div className="flex-1 overflow-y-auto p-4 space-y-3">
					{chatMessages.map((msg, i) => (
						<div
							key={`chat-${i}-${msg.role}`}
							className={`max-w-full ${msg.role === "user" ? "ml-auto max-w-[85%]" : ""}`}
						>
							{msg.role === "user" ? (
								<div className="rounded-lg px-3 py-2 text-sm whitespace-pre-wrap bg-blue-600 text-white">
									{msg.content}
								</div>
							) : (
								<div className="rounded-lg px-3 py-2 text-sm bg-gray-800 text-gray-100 prose prose-sm prose-invert max-w-none">
									{msg.content ? (
										<Markdown remarkPlugins={[remarkGfm]}>{msg.content}</Markdown>
									) : streaming ? (
										"..."
									) : (
										""
									)}
								</div>
							)}
						</div>
					))}
					<div ref={chatBottomRef} />
				</div>
				<div className="flex gap-2 p-3 border-t border-gray-800">
					<input
						type="text"
						value={input}
						onChange={(e) => setInput(e.target.value)}
						onKeyDown={(e) => e.key === "Enter" && handleSend()}
						placeholder="Send a message..."
						className="flex-1 bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500"
						disabled={streaming}
					/>
					<button
						type="button"
						onClick={handleSend}
						disabled={streaming || !input.trim()}
						className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-500 disabled:opacity-50"
					>
						Send
					</button>
				</div>
			</div>

			{/* Column 2: Unified Events */}
			<div className="flex-1 flex flex-col min-w-0">
				<div className="px-4 py-2 border-b border-gray-800 text-xs font-medium text-gray-400 uppercase tracking-wider">
					Events
				</div>
				<div className="flex-1 overflow-y-auto p-3 space-y-0">
					{eventLog.length === 0 && (
						<div className="text-gray-600 text-xs italic">No events yet</div>
					)}
					{unifiedDisplay.map((item) => {
						if (item.kind === "stream-group") {
							return <StreamGroup key={`sg-${item.entries[0]?.sequence}`} group={item} />;
						}
						if (item.kind === "thinking-group") {
							return <ThinkingGroup key={`tg-${item.entries[0]?.sequence}`} group={item} />;
						}
						if (item.kind === "tool-call-group") {
							return <ToolCallGroup key={`tcg-${item.toolCallId}`} group={item} />;
						}
						if (item.entry.event.type === "tool_result") {
							return <ToolResultRow key={`tr-${item.entry.sequence}`} entry={item.entry} />;
						}
						return (
							<div key={`ev-${item.entry.sequence}`} className="rounded px-1 py-0.5">
								<EventRow entry={item.entry} />
							</div>
						);
					})}
					<div ref={eventsBottomRef} />
				</div>
			</div>
		</div>
	);
}

// ── Collapsible stream group with live indicator ─────────────────────

function StreamGroup({ group }: { group: UnifiedDisplayItem & { kind: "stream-group" } }) {
	const [expanded, setExpanded] = useState(false);
	const firstEntry = group.entries[0];
	const time = firstEntry ? formatTime(firstEntry.timestamp) : "";

	return (
		<div className="rounded px-1 py-0.5">
			<button
				type="button"
				onClick={() => setExpanded(!expanded)}
				className="flex items-center gap-2 text-xs font-mono w-full text-left hover:bg-white/5 rounded px-1"
			>
				<span className="text-gray-600 shrink-0">{expanded ? "▼" : "▶"}</span>
				<span className="text-gray-600 shrink-0">{time}</span>
				<SourceBadge source={firstEntry?.source ?? "acp"} />
				<span className="text-gray-400 font-semibold shrink-0">LLM RESPONSE</span>
				<span className="text-gray-600">
					{group.entries.length} chunks &middot; {group.totalChars.toLocaleString()} chars
				</span>
				{group.isLive && (
					<span className="inline-flex items-center gap-1 text-[10px] text-green-400">
						<span className="relative flex h-1.5 w-1.5">
							<span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
							<span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-green-400" />
						</span>
						streaming
					</span>
				)}
			</button>
			{expanded && (
				<div className="ml-4 mt-1 space-y-0 max-h-60 overflow-y-auto border-l border-gray-800 pl-2">
					{group.entries.map((entry) => (
						<div
							key={`sg-${entry.sequence}`}
							className="text-[10px] font-mono text-gray-600 truncate"
						>
							{entry.event.delta}
						</div>
					))}
				</div>
			)}
		</div>
	);
}

// ── Collapsible thinking group with live indicator ───────────────────

function ThinkingGroup({ group }: { group: UnifiedDisplayItem & { kind: "thinking-group" } }) {
	const [expanded, setExpanded] = useState(false);
	const firstEntry = group.entries[0];
	const time = firstEntry ? formatTime(firstEntry.timestamp) : "";

	// Concatenate all thinking chunks into a single preview string
	const fullText = group.entries.map((e) => e.event.text ?? "").join("");

	return (
		<div className="rounded px-1 py-0.5">
			<button
				type="button"
				onClick={() => setExpanded(!expanded)}
				className="flex items-center gap-2 text-xs font-mono w-full text-left hover:bg-white/5 rounded px-1"
			>
				<span className="text-gray-600 shrink-0">{expanded ? "▼" : "▶"}</span>
				<span className="text-gray-600 shrink-0">{time}</span>
				<SourceBadge source={firstEntry?.source ?? "acp"} />
				<span className="text-amber-400 font-semibold shrink-0">THINKING</span>
				<span className="text-gray-600">
					{group.entries.length} chunks &middot; {group.totalChars.toLocaleString()} chars
				</span>
				{group.isLive && (
					<span className="inline-flex items-center gap-1 text-[10px] text-amber-400">
						<span className="relative flex h-1.5 w-1.5">
							<span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75" />
							<span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-amber-400" />
						</span>
						thinking
					</span>
				)}
			</button>
			{expanded && (
				<div className="ml-4 mt-1 max-h-60 overflow-y-auto border-l border-amber-800/30 pl-2">
					<div className="text-xs font-mono text-amber-300/70 whitespace-pre-wrap">{fullText}</div>
				</div>
			)}
		</div>
	);
}

// ── Collapsible tool-call group (tool_call → tool_result → status) ───

function ToolCallGroup({ group }: { group: UnifiedDisplayItem & { kind: "tool-call-group" } }) {
	const [expanded, setExpanded] = useState(false);

	// Derive summary from the grouped entries
	const pendingCall = group.entries.find(
		(e) => e.event.type === "tool_call" && (e.event.status === "pending" || !e.event.status),
	);
	const resultEntry = group.entries.find((e) => e.event.type === "tool_result");
	const statusCall = group.entries.find(
		(e) =>
			e.event.type === "tool_call" && e.event.status !== "pending" && e.event.status !== undefined,
	);

	const toolName = pendingCall?.event.tool ?? resultEntry?.event.tool ?? "unknown";
	const toolKind = pendingCall?.event.kind;
	const finalStatus = statusCall?.event.status ?? (resultEntry ? "completed" : "in_progress");
	const firstEntry = group.entries[0];
	const time = firstEntry ? formatTime(firstEntry.timestamp) : "";

	const resultStr =
		resultEntry?.event.result != null
			? typeof resultEntry.event.result === "string"
				? resultEntry.event.result
				: JSON.stringify(resultEntry.event.result, null, 2)
			: "";
	const preview = resultStr.length > 80 ? `${resultStr.slice(0, 80)}…` : resultStr;

	return (
		<div className="rounded px-1 py-0.5">
			<button
				type="button"
				onClick={() => setExpanded(!expanded)}
				className="flex items-center gap-2 text-xs font-mono w-full text-left hover:bg-white/5 rounded px-1"
			>
				<span className="text-gray-600 shrink-0">{expanded ? "▼" : "▶"}</span>
				<span className="text-gray-600 shrink-0">{time}</span>
				<SourceBadge source={firstEntry?.source ?? "acp"} />
				<ToolStatusBadge status={finalStatus} />
				<span className="text-blue-400 font-semibold shrink-0">TOOL</span>
				<span className="text-gray-400 shrink-0">
					{toolKind ? `[${toolKind}] ` : ""}
					{toolName}
				</span>
				{preview && <span className="text-gray-600 truncate">— {preview}</span>}
				{group.isLive && (
					<span className="inline-flex items-center gap-1 text-[10px] text-yellow-400">
						<span className="relative flex h-1.5 w-1.5">
							<span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-yellow-400 opacity-75" />
							<span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-yellow-400" />
						</span>
						running
					</span>
				)}
			</button>
			{expanded && (
				<div className="ml-4 mt-1 space-y-0.5 border-l border-blue-800/30 pl-2">
					{group.entries.map((entry) =>
						entry.event.type === "tool_result" ? (
							<ToolResultRow key={`tcg-tr-${entry.sequence}`} entry={entry} />
						) : (
							<div key={`tcg-ev-${entry.sequence}`} className="rounded px-1 py-0.5">
								<EventRow entry={entry} />
							</div>
						),
					)}
				</div>
			)}
		</div>
	);
}

// ── Row renderers ────────────────────────────────────────────────────

function extractToolDetail(args: unknown): string {
	if (!args || typeof args !== "object") return "";
	const obj = args as Record<string, unknown>;
	const path = obj.path ?? obj.filePath ?? obj.file ?? obj.uri ?? "";
	if (typeof path === "string" && path) return path;
	const cmd = obj.command ?? obj.query ?? "";
	if (typeof cmd === "string" && cmd) return cmd;
	return "";
}

/** Source indicator pill shown before the event label */
function SourceBadge({ source }: { source: string }) {
	const styles: Record<string, string> = {
		runtime: "bg-cyan-900/40 text-cyan-400",
		acp: "bg-purple-900/40 text-purple-400",
		system: "bg-gray-700/40 text-gray-400",
	};
	const cls = styles[source] ?? styles.system;
	return <span className={`text-[9px] px-1 py-0 rounded whitespace-nowrap ${cls}`}>{source}</span>;
}

// ── Collapsible tool result row ──────────────────────────────────────

function ToolResultRow({ entry }: { entry: EventLogEntry }) {
	const [expanded, setExpanded] = useState(false);
	const { event, timestamp, source } = entry;
	const time = formatTime(timestamp);
	const toolName = event.tool ?? "result";
	const resultStr =
		event.result != null
			? typeof event.result === "string"
				? event.result
				: JSON.stringify(event.result, null, 2)
			: "";
	const preview = resultStr.length > 80 ? `${resultStr.slice(0, 80)}…` : resultStr;

	return (
		<div className="rounded px-1 py-0.5">
			<button
				type="button"
				onClick={() => setExpanded(!expanded)}
				className="flex items-center gap-2 text-xs font-mono w-full text-left hover:bg-white/5 rounded px-1"
			>
				<span className="text-gray-600 shrink-0">{expanded ? "▼" : "▶"}</span>
				<span className="text-gray-600 shrink-0">{time}</span>
				<SourceBadge source={source} />
				<span className="text-[10px] px-1.5 py-0 rounded-full bg-green-900/50 text-green-400 whitespace-nowrap">
					✓ received
				</span>
				<span className="text-purple-400 font-semibold shrink-0">TOOL RESULT</span>
				<span className="text-gray-500 truncate">
					{toolName}
					{preview ? ` — ${preview}` : ""}
				</span>
			</button>
			{expanded && (
				<div className="ml-4 mt-1 max-h-60 overflow-y-auto border-l border-purple-800/30 pl-2">
					<div className="text-xs font-mono text-purple-300/70 whitespace-pre-wrap">
						{resultStr}
					</div>
				</div>
			)}
		</div>
	);
}

function EventRow({ entry }: { entry: EventLogEntry }) {
	const { event, timestamp, source } = entry;
	const time = formatTime(timestamp);

	let colorClass = "text-gray-400";
	let label = event.type;
	let detail = "";
	let statusBadge: React.ReactNode = null;

	if (event.type === "task_init") {
		colorClass = "text-gray-500";
		label = "INIT";
		detail = event.prompt ?? "";
	} else if (event.type === "lifecycle") {
		if (event.phase === "start") {
			colorClass = "text-blue-400";
			label = "STARTED";
		} else if (event.phase === "prompt_sent") {
			colorClass = "text-cyan-400";
			label = "PROMPT SENT";
		} else if (event.phase === "end") {
			colorClass = "text-green-400";
			label = "COMPLETED";
		} else if (event.phase === "error") {
			colorClass = "text-red-400";
			label = "ERROR";
			detail = event.error ?? "";
		}
	} else if (event.type === "tool_call") {
		const status = event.status ?? "pending";
		colorClass = "text-blue-400";
		label = "TOOL CALL";
		statusBadge = <ToolStatusBadge status={status} />;
		const toolName = event.tool ?? "unknown";
		const kindTag = event.kind ? `[${event.kind}] ` : "";
		const argsDetail = extractToolDetail(event.args);
		detail = argsDetail ? `${kindTag}${toolName} \u2014 ${argsDetail}` : `${kindTag}${toolName}`;
	} else if (event.type === "stream") {
		colorClass = "text-gray-500";
		label = "STREAM";
		detail = event.delta ?? "";
	} else if (event.type === "thinking") {
		colorClass = "text-amber-400";
		label = "THINKING";
		detail = event.text ?? "";
	} else if (event.type === "plan") {
		colorClass = "text-indigo-400";
		label = "PLAN";
		const entries = event.entries ?? [];
		detail = entries.map((e) => `[${e.status}] ${e.content}`).join(" · ");
	} else if (event.type === "usage") {
		colorClass = "text-teal-400";
		label = "USAGE";
		const pct = event.size ? Math.round(((event.used ?? 0) / event.size) * 100) : 0;
		const costStr = event.cost ? ` · $${event.cost.amount.toFixed(4)} ${event.cost.currency}` : "";
		detail = `${(event.used ?? 0).toLocaleString()} / ${(event.size ?? 0).toLocaleString()} tokens (${pct}%)${costStr}`;
	}

	return (
		<div className="flex items-start gap-2 text-xs font-mono py-0.5">
			<span className="text-gray-600 shrink-0">{time}</span>
			<SourceBadge source={source} />
			{statusBadge}
			<span className={`font-semibold shrink-0 whitespace-nowrap ${colorClass}`}>{label}</span>
			{detail && <span className="text-gray-500 break-all">{detail}</span>}
		</div>
	);
}

function ToolStatusBadge({ status }: { status: string }) {
	let bg = "bg-gray-700 text-gray-300";
	let icon = "";
	if (status === "completed") {
		bg = "bg-green-900/50 text-green-400";
		icon = "✓ ";
	} else if (status === "failed") {
		bg = "bg-red-900/50 text-red-400";
		icon = "✗ ";
	} else if (status === "in_progress") {
		bg = "bg-yellow-900/50 text-yellow-400";
		icon = "⟳ ";
	} else if (status === "pending") {
		bg = "bg-blue-900/50 text-blue-400";
		icon = "◦ ";
	}
	return (
		<span className={`text-[10px] px-1.5 py-0 rounded-full whitespace-nowrap ${bg}`}>
			{icon}
			{status}
		</span>
	);
}
