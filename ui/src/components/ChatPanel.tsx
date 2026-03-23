import { useEffect, useRef, useState } from "react";
import type { UseWebSocketReturn, WsMessage } from "../hooks/useWebSocket.js";

interface ChatMessage {
	role: "user" | "assistant";
	content: string;
}

export function ChatPanel({ ws }: { ws: UseWebSocketReturn }) {
	const [input, setInput] = useState("");
	const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
	const [streaming, setStreaming] = useState(false);
	const bottomRef = useRef<HTMLDivElement>(null);

	// Process incoming WebSocket messages
	useEffect(() => {
		if (!ws.lastMessage) return;
		const msg = ws.lastMessage;

		if (msg.type === "lifecycle" && msg.phase === "start") {
			setStreaming(true);
			setChatMessages((prev) => [...prev, { role: "assistant", content: "" }]);
		} else if (msg.type === "stream") {
			setChatMessages((prev) => {
				const updated = [...prev];
				const last = updated[updated.length - 1];
				if (last?.role === "assistant") {
					last.content += msg.delta as string;
				}
				return updated;
			});
		} else if (msg.type === "lifecycle" && (msg.phase === "end" || msg.phase === "error")) {
			setStreaming(false);
		}
	}, [ws.lastMessage]);

	// Auto-scroll
	useEffect(() => {
		bottomRef.current?.scrollIntoView({ behavior: "smooth" });
	});

	function handleSend() {
		const trimmed = input.trim();
		if (!trimmed || streaming) return;

		setChatMessages((prev) => [...prev, { role: "user", content: trimmed }]);
		ws.send({ type: "chat", message: trimmed });
		setInput("");
	}

	return (
		<div className="flex flex-col h-[calc(100vh-8rem)]">
			<div className="flex-1 overflow-y-auto space-y-4 pb-4">
				{chatMessages.map((msg, i) => (
					<div
						key={`msg-${i}-${msg.role}`}
						className={`max-w-2xl ${msg.role === "user" ? "ml-auto" : ""}`}
					>
						<div
							className={`rounded-lg px-4 py-2 text-sm whitespace-pre-wrap ${
								msg.role === "user" ? "bg-blue-600 text-white" : "bg-gray-800 text-gray-100"
							}`}
						>
							{msg.content || (streaming ? "..." : "")}
						</div>
					</div>
				))}
				<div ref={bottomRef} />
			</div>

			<div className="flex gap-2 pt-4 border-t border-gray-800">
				<input
					type="text"
					value={input}
					onChange={(e) => setInput(e.target.value)}
					onKeyDown={(e) => e.key === "Enter" && handleSend()}
					placeholder="Send a message..."
					className="flex-1 bg-gray-900 border border-gray-700 rounded-lg px-4 py-2 text-sm focus:outline-none focus:border-blue-500"
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
	);
}
