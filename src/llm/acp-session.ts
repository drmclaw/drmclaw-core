import { type ChildProcess, spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import type { AcpConfig, CliProvider } from "../config/schema.js";
import { resolveAcpCommandArgs } from "../config/schema.js";

/**
 * Gracefully terminate an ACP subprocess.
 *
 * Per the ACP stdio transport spec: close stdin first, then signal.
 * Uses SIGTERM → 250 ms → SIGKILL escalation so the CLI has a brief
 * window to flush state and exit cleanly.
 */
function gracefulKill(proc: ChildProcess): void {
	try {
		proc.stdin?.end();
	} catch {
		// Ignore EPIPE — child may already be gone.
	}
	try {
		proc.kill("SIGTERM");
	} catch {
		// Ignore if already exited.
		return;
	}
	const forceTimer = setTimeout(() => {
		if (proc.exitCode === null && proc.signalCode === null) {
			try {
				proc.kill("SIGKILL");
			} catch {
				// Ignore kill race.
			}
		}
	}, 250);
	forceTimer.unref();
}

/** Simplified model info exposed to the rest of the app. */
export interface DiscoveredModel {
	id: string;
	name: string;
}

/**
 * Convert a simple glob pattern (supports only `*` as wildcard) to a
 * RegExp anchored to the full string.
 */
function globToRegExp(pattern: string): RegExp {
	const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
	return new RegExp(`^${escaped}$`);
}

/**
 * Return `true` if the model is allowed (not matched by any exclusion
 * pattern).  Each pattern is a simple glob where `*` matches any
 * substring.
 */
export function isModelAllowed(modelId: string, excludePatterns: readonly string[]): boolean {
	return !excludePatterns.some((p) => globToRegExp(p).test(modelId));
}

/**
 * Return the GitHub Copilot-specific `reasoning_effort` config option ID when
 * the agent advertises it. We intentionally require the exact Copilot option
 * name rather than inferring from the generic `thought_level` category because
 * other agents may use different IDs or semantics.
 */
export function getGithubCopilotReasoningEffortConfigId(session: {
	configOptions?: ReadonlyArray<{ id?: string }>;
}): "reasoning_effort" | null {
	return session.configOptions?.some((opt) => opt.id === "reasoning_effort")
		? "reasoning_effort"
		: null;
}

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
	private discoveredModels: DiscoveredModel[] = [];
	private excludeModels: readonly string[];

	constructor(excludeModels: readonly string[] = []) {
		this.excludeModels = excludeModels;
	}

	/**
	 * Acquire an ACP session for a given drmclaw session ID.
	 *
	 * If a session already exists for this ID, the caller's `client` is
	 * installed as the active delegate so that the existing connection
	 * dispatches to fresh callbacks.  Otherwise a new ACP process is
	 * spawned and initialized.
	 *
	 * The caller **must** provide a `client` whose callbacks close over
	 * the current run's state (permissionMode, event emitter, output buffer).
	 */
	async acquire(
		taskSessionId: string,
		provider: CliProvider,
		acpCfg: AcpConfig,
		client: acp.Client,
		options?: { cwd?: string; model?: string },
	): Promise<AcpSession> {
		const existing = this.sessions.get(taskSessionId);
		if (existing) {
			// Swap to the current run's callbacks before returning.
			existing.clientDelegate.current = client;
			return existing;
		}

		// Resolve the effective model: explicit option > githubCopilot.defaultModel.
		const effectiveModel =
			options?.model ??
			(provider === "github-copilot" ? acpCfg.githubCopilot.defaultModel : undefined);

		// Resolve the effective reasoning effort (currently only github-copilot).
		// Applied per-session via ACP `session/set_config_option` after newSession
		// returns — Copilot CLI silently ignores a `--effort` flag in `--acp` mode.
		const effectiveEffort =
			provider === "github-copilot" ? acpCfg.githubCopilot.reasoningEffort : undefined;

		const { command, args } = resolveAcpCommandArgs(provider, acpCfg, options?.model);

		const proc = spawn(command, args, {
			stdio: ["pipe", "pipe", "inherit"],
		});

		// Suppress EPIPE when the child exits before stdin flush completes.
		proc.stdin?.on("error", () => {});

		const stdin = proc.stdin;
		const stdout = proc.stdout;
		if (!stdin || !stdout) {
			gracefulKill(proc);
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
			mcpServers: acpCfg.mcpServers.map((s) => ({
				name: s.name,
				command: s.command,
				args: s.args,
				env: Object.entries(s.env).map(([name, value]) => ({ name, value })),
			})),
		});

		// Capture available models from the first session response.
		if (session.models?.availableModels && this.discoveredModels.length === 0) {
			this.discoveredModels = session.models.availableModels
				.map((m: { modelId: string; name: string }) => ({
					id: m.modelId,
					name: m.name,
				}))
				.filter((m: DiscoveredModel) => isModelAllowed(m.id, this.excludeModels));
		}

		const acpSession: AcpSession = {
			connection,
			sessionId: session.sessionId,
			process: proc,
			clientDelegate,
		};

		// Auto-remove the session if the process exits or errors unexpectedly
		// so that the next acquire() spawns a fresh process instead of
		// returning a dead one.
		// Guard: only delete if the session in the map is still *this* session.
		// Without the identity check, a stale handler from a cancelled/disposed
		// process could delete a newer session that was acquired for the same
		// taskSessionId before the old process emitted "exit".
		const removeOnExit = () => {
			if (this.sessions.get(taskSessionId) === acpSession) {
				this.sessions.delete(taskSessionId);
			}
		};
		proc.once("exit", removeOnExit);
		proc.once("error", removeOnExit);

		// The --model CLI flag sets session metadata but may not control
		// actual routing.  Always call session/set_model to ensure the
		// desired model is active.
		if (effectiveModel) {
			try {
				await connection.unstable_setSessionModel({
					sessionId: session.sessionId,
					modelId: effectiveModel,
				});
			} catch {
				// Best-effort — the session proceeds with whatever model the agent chose.
			}
		}

		// Apply reasoning effort via GitHub Copilot's ACP session config option.
		// This is intentionally provider-specific: other ACP agents may expose a
		// different option ID or different values, so we only target the exact
		// Copilot `reasoning_effort` selector when it is advertised.
		const reasoningEffortConfigId = getGithubCopilotReasoningEffortConfigId(session);
		if (effectiveEffort && reasoningEffortConfigId) {
			try {
				await connection.setSessionConfigOption({
					sessionId: session.sessionId,
					configId: reasoningEffortConfigId,
					value: effectiveEffort,
				});
			} catch {
				// Best-effort — session proceeds with the agent's default effort.
			}
		}

		this.sessions.set(taskSessionId, acpSession);
		return acpSession;
	}

	/** Cancel and remove a session by drmclaw session ID. */
	cancel(taskSessionId: string): void {
		const session = this.sessions.get(taskSessionId);
		if (session) {
			gracefulKill(session.process);
			this.sessions.delete(taskSessionId);
		}
	}

	/** Check whether a session exists for the given ID. */
	has(taskSessionId: string): boolean {
		return this.sessions.has(taskSessionId);
	}

	/**
	 * Switch the model for all active sessions via `session/set_model`.
	 *
	 * If the agent doesn't support the (unstable) set_model method, the
	 * session is torn down so that the next `acquire()` spawns a fresh
	 * process with the updated `--model` CLI flag.
	 */
	async setModel(modelId: string): Promise<void> {
		if (!isModelAllowed(modelId, this.excludeModels)) {
			throw new Error(`Model "${modelId}" is excluded by policy`);
		}
		for (const [id, session] of this.sessions) {
			try {
				await session.connection.unstable_setSessionModel({
					sessionId: session.sessionId,
					modelId,
				});
			} catch {
				// Agent doesn't support session/set_model — tear down so
				// next acquire() spawns a fresh process with --model.
				gracefulKill(session.process);
				this.sessions.delete(id);
			}
		}
	}

	/** Dispose all sessions and kill all processes. */
	async dispose(): Promise<void> {
		for (const [id, session] of this.sessions) {
			gracefulKill(session.process);
			this.sessions.delete(id);
		}
	}

	/** Return models discovered from the ACP agent's NewSessionResponse. */
	getDiscoveredModels(): DiscoveredModel[] {
		return this.discoveredModels;
	}

	/**
	 * Eagerly discover available models by creating a short-lived ACP
	 * session, reading the `NewSessionResponse.models`, then tearing
	 * it down.  Safe to call at startup so the dropdown is populated
	 * before the first user prompt.
	 */
	async discoverModels(provider: CliProvider, acpCfg: AcpConfig): Promise<DiscoveredModel[]> {
		if (this.discoveredModels.length > 0) return this.discoveredModels;

		const noopClient: acp.Client = {
			async requestPermission() {
				return { outcome: { outcome: "cancelled" as const } };
			},
			async sessionUpdate() {},
		};

		const { command, args } = resolveAcpCommandArgs(provider, acpCfg);
		const proc = spawn(command, args, {
			stdio: ["pipe", "pipe", "inherit"],
		});
		proc.stdin?.on("error", () => {});

		try {
			const stdin = proc.stdin;
			const stdout = proc.stdout;
			if (!stdin || !stdout) throw new Error("stdin/stdout not available");

			const stream = acp.ndJsonStream(Writable.toWeb(stdin), Readable.toWeb(stdout));
			const connection = new acp.ClientSideConnection(() => noopClient, stream);

			await connection.initialize({
				protocolVersion: acp.PROTOCOL_VERSION,
				clientCapabilities: {},
			});

			const session = await connection.newSession({
				cwd: process.cwd(),
				mcpServers: acpCfg.mcpServers.map((s) => ({
					name: s.name,
					command: s.command,
					args: s.args,
					env: Object.entries(s.env).map(([name, value]) => ({ name, value })),
				})),
			});

			if (session.models?.availableModels) {
				this.discoveredModels = session.models.availableModels
					.map((m: { modelId: string; name: string }) => ({
						id: m.modelId,
						name: m.name,
					}))
					.filter((m: DiscoveredModel) => isModelAllowed(m.id, this.excludeModels));
			}
		} finally {
			gracefulKill(proc);
		}

		return this.discoveredModels;
	}
}
