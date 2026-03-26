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

/** GitHub Copilot-specific ACP settings. */
export const githubCopilotConfigSchema = z
	.object({
		defaultModel: z.string().optional(),
	})
	.default({});

/** Per-provider ACP config (transport-layer settings for the ACP CLI). */
export const acpConfigSchema = z
	.object({
		command: z.string().optional(),
		args: z.array(z.string()).optional(),
		githubCopilot: githubCopilotConfigSchema.default({}),
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
): { command: string; args: string[] } {
	const command = acpCfg.command ?? CLI_DEFAULT_COMMANDS[provider];
	const baseArgs = acpCfg.args ?? DEFAULT_ACP_ARGS;

	// github-copilot supports --model injection from config
	if (provider === "github-copilot") {
		const modelArgs =
			acpCfg.githubCopilot.defaultModel && !baseArgs.includes("--model")
				? ["--model", acpCfg.githubCopilot.defaultModel]
				: [];
		return { command, args: [...baseArgs, ...modelArgs] };
	}

	return { command, args: baseArgs };
}

/** Full application config schema. */
export const configSchema = z.object({
	server: z
		.object({
			port: z.number().int().min(1).max(65535).default(3000),
			maxConcurrent: z.number().int().min(1).default(1),
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
			acp: acpConfigSchema.default({}),
			apiKey: z.string().optional(),
			allowedTools: z.array(z.string()).default([]),
			allowedToolKinds: z
				.array(
					z.enum([
						"read",
						"edit",
						"delete",
						"move",
						"search",
						"execute",
						"think",
						"fetch",
						"switch_mode",
						"other",
					]),
				)
				.default([]),
			retry: retryPolicySchema.default({}),
			fallbacks: z.array(z.string()).default([]),
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
