import { type ChildProcess, spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import type { AcpConfig, CliProvider } from "../config/schema.js";
import { resolveAcpCommandArgs } from "../config/schema.js";

/**
 * Mutable client delegate — allows swapping per-run callbacks on a
 * long-lived ACP connection.
 *
 * The `ClientSideConnection` receives its client factory once at
 * construction time.  By routing every callback through `delegate.current`,
 * the adapter can point the connection at fresh `requestPermission` and
 * `sessionUpdate` handlers for each prompt call without tearing down
 * the process.
 */
export interface ClientDelegate {
	current: acp.Client;
}

/** An active ACP connection with its backing process and session. */
export interface AcpSession {
	connection: acp.ClientSideConnection;
	sessionId: string;
	process: ChildProcess;
	/** Mutable delegate — update `.current` before each prompt call. */
	clientDelegate: ClientDelegate;
}

/**
 * ACP session/process manager — owns process lifecycle and session mapping.
 *
 * Responsibilities:
 *   - Spawn and reuse ACP CLI processes
 *   - Create and load ACP sessions
 *   - Map drmclaw task/session IDs to ACP session IDs
 *   - Swap per-run client callbacks on existing sessions (via ClientDelegate)
 *   - Cancel running sessions
 *   - Dispose all resources
 *
 * This is an internal coordinator, not a full Gateway-backed session store.
 */
export class AcpSessionManager {
	private sessions = new Map<string, AcpSession>();

	/**
	 * Acquire an ACP session for a given drmclaw session ID.
	 *
	 * If a session already exists for this ID, the caller's `client` is
	 * installed as the active delegate so that the existing connection
	 * dispatches to fresh callbacks.  Otherwise a new ACP process is
	 * spawned and initialized.
	 *
	 * The caller **must** provide a `client` whose callbacks close over
	 * the current run's state (allowedTools, event emitter, output buffer).
	 */
	async acquire(
		taskSessionId: string,
		provider: CliProvider,
		acpCfg: AcpConfig,
		client: acp.Client,
		options?: { cwd?: string },
	): Promise<AcpSession> {
		const existing = this.sessions.get(taskSessionId);
		if (existing) {
			// Swap to the current run's callbacks before returning.
			existing.clientDelegate.current = client;
			return existing;
		}

		const { command, args } = resolveAcpCommandArgs(provider, acpCfg);

		const proc = spawn(command, args, {
			stdio: ["pipe", "pipe", "inherit"],
		});

		const stdin = proc.stdin;
		const stdout = proc.stdout;
		if (!stdin || !stdout) {
			proc.kill();
			throw new Error("ACP process stdin/stdout not available");
		}

		const input = Writable.toWeb(stdin);
		const reader = Readable.toWeb(stdout);
		const stream = acp.ndJsonStream(input, reader);

		const clientDelegate: ClientDelegate = { current: client };

		// Route all callbacks through the mutable delegate so that
		// later runs can install fresh handlers without rebuilding
		// the connection.
		const connection = new acp.ClientSideConnection(
			(_agent) => ({
				requestPermission: (params) => clientDelegate.current.requestPermission(params),
				sessionUpdate: (params) => clientDelegate.current.sessionUpdate(params),
			}),
			stream,
		);

		await connection.initialize({
			protocolVersion: acp.PROTOCOL_VERSION,
			clientCapabilities: {},
		});

		const session = await connection.newSession({
			cwd: options?.cwd ?? process.cwd(),
			mcpServers: [],
		});

		const acpSession: AcpSession = {
			connection,
			sessionId: session.sessionId,
			process: proc,
			clientDelegate,
		};

		this.sessions.set(taskSessionId, acpSession);
		return acpSession;
	}

	/** Cancel and remove a session by drmclaw session ID. */
	cancel(taskSessionId: string): void {
		const session = this.sessions.get(taskSessionId);
		if (session) {
			session.process.kill();
			this.sessions.delete(taskSessionId);
		}
	}

	/** Check whether a session exists for the given ID. */
	has(taskSessionId: string): boolean {
		return this.sessions.has(taskSessionId);
	}

	/** Dispose all sessions and kill all processes. */
	async dispose(): Promise<void> {
		for (const [id, session] of this.sessions) {
			session.process.kill();
			this.sessions.delete(id);
		}
	}
}
