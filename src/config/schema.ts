import { z } from "zod";

/** Retry policy for transient LLM errors. */
export const retryPolicySchema = z.object({
	attempts: z.number().int().min(1).default(3),
	maxDelayMs: z.number().int().min(0).default(30_000),
	jitter: z.number().min(0).max(1).default(0.1),
});
export type RetryPolicy = z.infer<typeof retryPolicySchema>;

/** Codex App Server is the only supported LLM runtime for this MVP. */
export const llmProviderSchema = z.literal("codex-app-server");
export type LLMProvider = z.infer<typeof llmProviderSchema>;

export const codexApprovalPolicySchema = z.enum(["untrusted", "on-failure", "on-request", "never"]);
export type CodexApprovalPolicy = z.infer<typeof codexApprovalPolicySchema>;

export const codexSandboxModeSchema = z.enum([
	"read-only",
	"workspace-write",
	"danger-full-access",
]);
export type CodexSandboxMode = z.infer<typeof codexSandboxModeSchema>;

export const codexReasoningEffortSchema = z.enum([
	"none",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
]);
export type CodexReasoningEffort = z.infer<typeof codexReasoningEffortSchema>;

/** Codex App Server subprocess configuration. */
export const codexAppServerConfigSchema = z
	.object({
		command: z.string().default("codex"),
		args: z.array(z.string()).default(["app-server"]),
		approvalPolicy: codexApprovalPolicySchema.default("never"),
		sandbox: codexSandboxModeSchema.default("danger-full-access"),
	})
	.default({});
export type CodexAppServerConfig = z.infer<typeof codexAppServerConfigSchema>;

/** Resolve the command used to spawn Codex App Server over stdio. */
export function resolveCodexAppServerCommandArgs(codexCfg: CodexAppServerConfig): {
	command: string;
	args: string[];
} {
	return { command: codexCfg.command, args: [...codexCfg.args] };
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
			provider: llmProviderSchema.default("codex-app-server"),
			model: z.string().optional(),
			reasoningEffort: codexReasoningEffortSchema.optional(),
			codex: codexAppServerConfigSchema.default({}),
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

	executionHistory: z
		.object({
			enabled: z.boolean().default(true),
		})
		.default({}),

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
