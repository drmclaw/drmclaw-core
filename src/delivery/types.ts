/** Status of a delivery entry in the queue. */
export type DeliveryStatus = "pending" | "delivered" | "failed";

/**
 * A single delivery entry in the write-ahead queue.
 *
 * `T` is the payload type — kept generic so connectors can deliver
 * any shape (Slack block, email body, webhook payload, etc.).
 */
export interface DeliveryEntry<T = unknown> {
	/** Unique delivery ID. */
	id: string;
	/** Arbitrary payload to deliver. */
	payload: T;
	/** Current delivery status. */
	status: DeliveryStatus;
	/** Number of delivery attempts so far. */
	attempts: number;
	/** ISO timestamp of the last delivery attempt (if any). */
	lastAttempt?: string;
	/** ISO timestamp when the entry was enqueued. */
	createdAt: string;
	/** Error message from the most recent failed attempt. */
	lastError?: string;
}

/** Options for creating a delivery queue. */
export interface DeliveryQueueOptions {
	/** Maximum retry attempts before marking an entry as permanently failed. Default: 5 */
	maxRetries?: number;
	/** Base delay in ms for exponential backoff. Actual delay = base * 5^(attempt-1). Default: 5000 */
	backoffBaseMs?: number;
}

/**
 * DeliveryQueue — write-ahead queue for reliable outbound delivery.
 *
 * Entries are persisted to disk before delivery is attempted,
 * ensuring crash recovery.  On startup, `recover()` reloads
 * pending entries for retry.
 */
export interface DeliveryQueue<T = unknown> {
	/**
	 * Enqueue a payload for delivery.  Returns the entry written to disk.
	 * The entry is persisted *before* this method resolves (write-ahead).
	 */
	enqueue(id: string, payload: T): Promise<DeliveryEntry<T>>;

	/**
	 * Acknowledge successful delivery — removes the entry from the queue.
	 * Uses a two-phase atomic approach (rename then unlink) so that a
	 * crash between phases won't lose the acknowledgment.
	 */
	ack(id: string): Promise<void>;

	/**
	 * Record a delivery failure with an error message.
	 * Increments the attempt counter and stores the error for diagnostics.
	 */
	fail(id: string, error: string): Promise<void>;

	/**
	 * Load all pending entries from disk (crash recovery).
	 * Returns entries that haven't been acked or permanently failed.
	 * Cleans up any orphaned `.delivered` markers from incomplete acks.
	 */
	recover(): Promise<DeliveryEntry<T>[]>;

	/**
	 * Compute the retry delay for an entry based on its attempt count.
	 * Uses exponential backoff: `backoffBaseMs * 5^(attempts - 1)`.
	 */
	retryDelay(entry: DeliveryEntry<T>): number;
}
