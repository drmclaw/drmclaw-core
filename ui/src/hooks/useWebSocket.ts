import { useCallback, useEffect, useRef, useState } from "react";

export interface WsMessage {
	type: string;
	[key: string]: unknown;
}

export interface UseWebSocketReturn {
	send: (data: unknown) => void;
	lastMessage: WsMessage | null;
	messages: WsMessage[];
	connected: boolean;
}

/**
 * WebSocket hook — connects to /ws, auto-reconnects, and provides
 * send/receive functionality.
 */
export function useWebSocket(): UseWebSocketReturn {
	const wsRef = useRef<WebSocket | null>(null);
	const [connected, setConnected] = useState(false);
	const [messages, setMessages] = useState<WsMessage[]>([]);
	const [lastMessage, setLastMessage] = useState<WsMessage | null>(null);

	useEffect(() => {
		let disposed = false;

		function connect() {
			if (disposed) return;
			const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
			const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);

			ws.onopen = () => setConnected(true);
			ws.onclose = () => {
				setConnected(false);
				if (!disposed) {
					setTimeout(connect, 2000);
				}
			};
			ws.onerror = () => {
				setConnected(false);
			};
			ws.onmessage = (event) => {
				try {
					const msg = JSON.parse(event.data as string) as WsMessage;
					setLastMessage(msg);
					setMessages((prev) => [...prev, msg]);
				} catch {
					// Ignore non-JSON messages
				}
			};

			wsRef.current = ws;
		}

		connect();
		return () => {
			disposed = true;
			wsRef.current?.close();
		};
	}, []);

	const send = useCallback((data: unknown) => {
		if (wsRef.current?.readyState === WebSocket.OPEN) {
			wsRef.current.send(JSON.stringify(data));
		}
	}, []);

	return { send, lastMessage, messages, connected };
}
