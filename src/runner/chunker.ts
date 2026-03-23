/**
 * Stream chunker — applies min/max character bounds when streaming to WebSocket.
 *
 * - Never splits inside code fences (tracks open/close state).
 * - Coalesces small consecutive chunks with an idle timeout before emitting.
 * - Reduces WebSocket message spam and improves chat UI rendering quality.
 */
export class StreamChunker {
	private buffer = "";
	private timer: ReturnType<typeof setTimeout> | null = null;
	private inCodeFence = false;

	constructor(
		private readonly emit: (chunk: string) => void,
		private readonly minChars = 20,
		private readonly maxChars = 2000,
		private readonly idleMs = 200,
	) {}

	/** Feed a raw chunk from the LLM stream. */
	push(chunk: string): void {
		this.buffer += chunk;
		this.trackCodeFences(chunk);

		// If buffer exceeds max and we're not inside a code fence, flush
		if (this.buffer.length >= this.maxChars && !this.inCodeFence) {
			this.flush();
			return;
		}

		// Reset idle timer
		this.resetTimer();
	}

	/** Signal end of stream — flush remaining buffer. */
	end(): void {
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}
		if (this.buffer.length > 0) {
			this.flush();
		}
	}

	private flush(): void {
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}
		if (this.buffer.length > 0) {
			this.emit(this.buffer);
			this.buffer = "";
		}
	}

	private resetTimer(): void {
		if (this.timer) {
			clearTimeout(this.timer);
		}
		this.timer = setTimeout(() => {
			if (this.buffer.length >= this.minChars || !this.inCodeFence) {
				this.flush();
			}
		}, this.idleMs);
	}

	private trackCodeFences(chunk: string): void {
		const fencePattern = /^```/gm;
		while (fencePattern.exec(chunk) !== null) {
			this.inCodeFence = !this.inCodeFence;
		}
	}
}
