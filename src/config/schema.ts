import { z } from "zod";

/** Retry policy for transient LLM errors. */
export const retryPolicySchema = z.object({
	attempts: z.number().int().min(1).default(3),
	maxDelayMs: z.number().int().min(0).default(30_000),
	jitter: z.number().min(0).max(1).default(0.1),
});
export type RetryPolicy = z.infer<typeof retryPolicySchema>;

/**
 * Provider IDs — the single user-facing configuration axis.
 *
 * CLI providers launch an ACP-compatible CLI binary; the ACP transport
 * is an internal detail.  Embedded providers talk to the upstream API
 * directly and drmclaw owns the tool-calling loop.
 */
export const cliProviderIds = ["github-copilot", "claude-cli", "openai-cli", "gemini-cli"] as const;
export type CliProvider = (typeof cliProviderIds)[number];

export const embeddedProviderIds = ["claude", "openai", "gemini"] as const;
export type EmbeddedProvider = (typeof embeddedProviderIds)[number];

export const llmProviderSchema = z.enum([...cliProviderIds, ...embeddedProviderIds]);
export type LLMProvider = z.infer<typeof llmProviderSchema>;

/** Returns true when the provider routes through an ACP CLI binary. */
export function isCliProvider(provider: LLMProvider): provider is CliProvider {
	return (cliProviderIds as readonly string[]).includes(provider);
}

/**
 * Reasoning effort level supported by GitHub Copilot CLI for GPT-5.4 ACP sessions.
 *
 * Applied per-session via the ACP `session/set_config_option` method
 * (configId = "reasoning_effort") after the session is created.
 *
 * NOTE: Copilot CLI's `--effort` / `--reasoning-effort` global flag is
 * silently ignored in `--acp` mode (as of Copilot CLI 1.0.35) — the flag
 * only affects one-shot `copilot -p` invocations. Setting effort for an
 * ACP session MUST go through the protocol-level config option.
 *
 * This schema is intentionally scoped to the values currently advertised by
 * GitHub Copilot CLI for GPT-5.4: `low`, `medium`, and `high`. Other ACP
 * agents or future models may expose a different option ID or different
 * values and should be handled separately.
 */
export const reasoningEffortSchema = z.enum(["low", "medium", "high"]);
export type ReasoningEffort = z.infer<typeof reasoningEffortSchema>;

/** GitHub Copilot-specific ACP settings. */
export const githubCopilotConfigSchema = z
	.object({
		defaultModel: z.string().optional(),
		/**
		 * Reasoning effort applied to each new session via the ACP
		 * `session/set_config_option` method. Omit to use the agent's
		 * default (currently `medium` for GitHub Copilot CLI GPT-5.4).
		 */
		reasoningEffort: reasoningEffortSchema.optional(),
	})
	.default({});

/** Per-provider ACP config (transport-layer settings for the ACP CLI). */
export const acpConfigSchema = z
	.object({
		command: z.string().optional(),
		args: z.array(z.string()).optional(),
		githubCopilot: githubCopilotConfigSchema.default({}),
		mcpServers: z
			.array(
				z.object({
					name: z.string(),
					command: z.string(),
					args: z.array(z.string()).default([]),
					env: z.record(z.string()).default({}),
				}),
			)
			.default([]),
	})
	.default({});
export type AcpConfig = z.infer<typeof acpConfigSchema>;

/**
 * Resolve a fully expanded command + args for spawning the ACP CLI.
 *
 * Provider defaults:
 *   - github-copilot: `copilot --acp --stdio [--model <defaultModel>]`
 *   - claude-cli:     `claude --acp --stdio`
 *   - openai-cli:     `openai --acp --stdio`
 *   - gemini-cli:     `gemini --acp --stdio`
 *
 * Explicit `command` / `args` always override provider defaults.
 */
const CLI_DEFAULT_COMMANDS: Record<CliProvider, string> = {
	"github-copilot": "copilot",
	"claude-cli": "claude",
	"openai-cli": "openai",
	"gemini-cli": "gemini",
};

const DEFAULT_ACP_ARGS = ["--acp", "--stdio"];

export function resolveAcpCommandArgs(
	provider: CliProvider,
	acpCfg: AcpConfig,
	modelOverride?: string,
): { command: string; args: string[] } {
	const command = acpCfg.command ?? CLI_DEFAULT_COMMANDS[provider];
	const baseArgs = acpCfg.args ?? DEFAULT_ACP_ARGS;

	// Resolve model: explicit override > githubCopilot.defaultModel
	const model =
		modelOverride ??
		(provider === "github-copilot" ? acpCfg.githubCopilot.defaultModel : undefined);

	const args = [...baseArgs];

	if (model && !args.includes("--model")) {
		args.push("--model", model);
	}

	// NOTE: Reasoning effort is intentionally NOT forwarded as a CLI flag.
	// Copilot CLI's `--effort` is silently ignored in `--acp` mode; the
	// effort must be applied per-session via `session/set_config_option`
	// after the session is created (see AcpSessionManager.acquire).

	return { command, args };
}

/** Full application config schema. */
export const configSchema = z.object({
	server: z
		.object({
			port: z.number().int().min(1).max(65535).default(3000),
			maxConcurrent: z.number().int().min(1).default(1),
			maxQueueSize: z.number().int().min(0).default(50),
		})
		.default({}),

	skills: z
		.object({
			systemDir: z.string().default("./skills"),
			dirs: z.array(z.string()).default([]),
		})
		.default({}),

	llm: z
		.object({
			provider: llmProviderSchema.default("github-copilot"),
			model: z.string().optional(),
			acp: acpConfigSchema.default({}),
			apiKey: z.string().optional(),
			permissionMode: z.enum(["approve-all", "approve-reads", "deny-all"]).default("approve-all"),
			retry: retryPolicySchema.default({}),
			fallbacks: z.array(z.string()).default([]),
			excludeModels: z.array(z.string()).default(["claude-opus-*-fast"]),
		})
		.default({}),

	workspace: z
		.object({
			dir: z.string().optional(),
			bootstrapMaxChars: z.number().int().min(0).default(20_000),
			bootstrapTotalMaxChars: z.number().int().min(0).default(150_000),
		})
		.default({}),

	dataDir: z.string().default(".drmclaw"),

	scheduler: z
		.object({
			enabled: z.boolean().default(false),
			jobs: z.union([z.string(), z.array(z.unknown())]).optional(),
		})
		.default({}),

	taskHistory: z
		.object({
			pruneAfter: z.string().default("30d"),
			maxEntries: z.number().int().min(1).default(500),
		})
		.default({}),
});

export type DrMClawConfig = z.infer<typeof configSchema>;

/** Type-safe config helper for `drmclaw.config.ts` files. */
export function defineConfig(
	config: Partial<z.input<typeof configSchema>>,
): Partial<z.input<typeof configSchema>> {
	return config;
}
