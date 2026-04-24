import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveConfigFile } from "../src/config/loader.js";
import {
	acpConfigSchema,
	configSchema,
	defineConfig,
	isCliProvider,
	resolveAcpCommandArgs,
} from "../src/config/schema.js";

describe("configSchema", () => {
	it("parses empty input with all defaults", () => {
		const config = configSchema.parse({});

		expect(config.server.port).toBe(3000);
		expect(config.server.maxConcurrent).toBe(1);
		expect(config.llm.provider).toBe("github-copilot");
		expect(config.llm.acp.command).toBeUndefined();
		expect(config.llm.acp.args).toBeUndefined();
		expect(config.llm.permissionMode).toBe("approve-all");
		expect(config.skills.systemDir).toBe("./skills");
		expect(config.dataDir).toBe(".drmclaw");
		expect(config.scheduler.enabled).toBe(false);
		expect(config.taskHistory.maxEntries).toBe(500);
	});

	it("validates provider enum", () => {
		expect(() => configSchema.parse({ llm: { provider: "invalid" } })).toThrow();
	});

	it("validates port range", () => {
		expect(() => configSchema.parse({ server: { port: 0 } })).toThrow();

		expect(() => configSchema.parse({ server: { port: 99999 } })).toThrow();
	});

	it("accepts valid CLI provider", () => {
		const config = configSchema.parse({
			server: { port: 8080 },
			llm: {
				provider: "claude-cli",
				acp: { command: "my-agent", args: ["--stdio"] },
			},
		});

		expect(config.server.port).toBe(8080);
		expect(config.llm.provider).toBe("claude-cli");
		expect(config.llm.acp.command).toBe("my-agent");
		expect(config.llm.acp.args).toEqual(["--stdio"]);
	});

	it("accepts valid embedded provider", () => {
		const config = configSchema.parse({
			llm: { provider: "openai" },
		});

		expect(config.llm.provider).toBe("openai");
	});

	it("accepts all CLI provider IDs", () => {
		for (const id of ["github-copilot", "claude-cli", "openai-cli", "gemini-cli"]) {
			const config = configSchema.parse({ llm: { provider: id } });
			expect(config.llm.provider).toBe(id);
			expect(isCliProvider(config.llm.provider)).toBe(true);
		}
	});

	it("accepts all embedded provider IDs", () => {
		for (const id of ["claude", "openai", "gemini"]) {
			const config = configSchema.parse({ llm: { provider: id } });
			expect(config.llm.provider).toBe(id);
			expect(isCliProvider(config.llm.provider)).toBe(false);
		}
	});

	it("accepts llm.model as optional string", () => {
		const config = configSchema.parse({ llm: { model: "claude-sonnet-4" } });
		expect(config.llm.model).toBe("claude-sonnet-4");
	});

	it("defaults llm.model to undefined", () => {
		const config = configSchema.parse({});
		expect(config.llm.model).toBeUndefined();
	});

	it("strips unknown keys from githubCopilot", () => {
		const config = configSchema.parse({
			llm: { acp: { githubCopilot: { defaultModel: "gpt-5.4" } } },
		});
		expect(config.llm.acp.githubCopilot.defaultModel).toBe("gpt-5.4");
	});

	it("defaults mcpServers to empty array", () => {
		const config = configSchema.parse({});
		expect(config.llm.acp.mcpServers).toEqual([]);
	});

	it("parses mcpServers with full fields", () => {
		const config = configSchema.parse({
			llm: {
				acp: {
					mcpServers: [
						{
							name: "filesystem",
							command: "npx",
							args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
							env: { HOME: "/home/ci" },
						},
					],
				},
			},
		});
		expect(config.llm.acp.mcpServers).toHaveLength(1);
		expect(config.llm.acp.mcpServers[0].name).toBe("filesystem");
		expect(config.llm.acp.mcpServers[0].command).toBe("npx");
		expect(config.llm.acp.mcpServers[0].args).toEqual([
			"-y",
			"@modelcontextprotocol/server-filesystem",
			"/tmp",
		]);
		expect(config.llm.acp.mcpServers[0].env).toEqual({ HOME: "/home/ci" });
	});

	it("defaults mcpServer args and env when omitted", () => {
		const config = configSchema.parse({
			llm: {
				acp: {
					mcpServers: [{ name: "simple", command: "my-server" }],
				},
			},
		});
		expect(config.llm.acp.mcpServers[0].args).toEqual([]);
		expect(config.llm.acp.mcpServers[0].env).toEqual({});
	});

	it("rejects mcpServers entry missing required name", () => {
		expect(() =>
			configSchema.parse({
				llm: { acp: { mcpServers: [{ command: "foo" }] } },
			}),
		).toThrow();
	});

	it("rejects mcpServers entry missing required command", () => {
		expect(() =>
			configSchema.parse({
				llm: { acp: { mcpServers: [{ name: "foo" }] } },
			}),
		).toThrow();
	});
});

describe("resolveAcpCommandArgs", () => {
	it("defaults to copilot --acp --stdio for github-copilot", () => {
		const { command, args } = resolveAcpCommandArgs("github-copilot", {
			githubCopilot: {},
			mcpServers: [],
		});
		expect(command).toBe("copilot");
		expect(args).toEqual(["--acp", "--stdio"]);
	});

	it("appends --model when githubCopilot.defaultModel is set", () => {
		const { command, args } = resolveAcpCommandArgs("github-copilot", {
			githubCopilot: { defaultModel: "gpt-5.4" },
			mcpServers: [],
		});
		expect(command).toBe("copilot");
		expect(args).toEqual(["--acp", "--stdio", "--model", "gpt-5.4"]);
	});

	it("does not duplicate --model if already in args", () => {
		const { args } = resolveAcpCommandArgs("github-copilot", {
			args: ["--acp", "--stdio", "--model", "custom-model"],
			githubCopilot: { defaultModel: "gpt-5.4" },
			mcpServers: [],
		});
		expect(args).toEqual(["--acp", "--stdio", "--model", "custom-model"]);
	});

	it("allows explicit command/args to override provider defaults", () => {
		const { command, args } = resolveAcpCommandArgs("github-copilot", {
			command: "gh-copilot",
			args: ["--custom-flag"],
			githubCopilot: {},
			mcpServers: [],
		});
		expect(command).toBe("gh-copilot");
		expect(args).toEqual(["--custom-flag"]);
	});

	it("uses correct default commands for CLI providers", () => {
		const { command: cmd1 } = resolveAcpCommandArgs("claude-cli", {
			githubCopilot: {},
			mcpServers: [],
		});
		expect(cmd1).toBe("claude");

		const { command: cmd2 } = resolveAcpCommandArgs("openai-cli", {
			githubCopilot: {},
			mcpServers: [],
		});
		expect(cmd2).toBe("openai");

		const { command: cmd3 } = resolveAcpCommandArgs("gemini-cli", {
			githubCopilot: {},
			mcpServers: [],
		});
		expect(cmd3).toBe("gemini");
	});

	it("uses --acp --stdio as default args for non-copilot CLI providers", () => {
		for (const provider of ["claude-cli", "openai-cli", "gemini-cli"] as const) {
			const { args } = resolveAcpCommandArgs(provider, { githubCopilot: {}, mcpServers: [] });
			expect(args).toEqual(["--acp", "--stdio"]);
		}
	});

	it("works with schema-parsed defaults (round-trip through Zod)", () => {
		const parsed = acpConfigSchema.parse({});
		const { command, args } = resolveAcpCommandArgs("github-copilot", parsed);
		expect(command).toBe("copilot");
		expect(args).toEqual(["--acp", "--stdio"]);
	});

	it("works with schema-parsed config including model", () => {
		const parsed = acpConfigSchema.parse({
			githubCopilot: { defaultModel: "gpt-5.4" },
		});
		const { command, args } = resolveAcpCommandArgs("github-copilot", parsed);
		expect(args).toEqual(["--acp", "--stdio", "--model", "gpt-5.4"]);
	});

	it("modelOverride takes precedence over githubCopilot.defaultModel", () => {
		const { args } = resolveAcpCommandArgs(
			"github-copilot",
			{ githubCopilot: { defaultModel: "gpt-5.4" }, mcpServers: [] },
			"claude-sonnet-4",
		);
		expect(args).toEqual(["--acp", "--stdio", "--model", "claude-sonnet-4"]);
	});

	it("modelOverride works for non-copilot CLI providers", () => {
		const { args } = resolveAcpCommandArgs(
			"claude-cli",
			{ githubCopilot: {}, mcpServers: [] },
			"claude-sonnet-4",
		);
		expect(args).toEqual(["--acp", "--stdio", "--model", "claude-sonnet-4"]);
	});

	it("modelOverride is ignored when --model already in explicit args", () => {
		const { args } = resolveAcpCommandArgs(
			"github-copilot",
			{ args: ["--acp", "--stdio", "--model", "pinned"], githubCopilot: {}, mcpServers: [] },
			"override-attempt",
		);
		expect(args).toEqual(["--acp", "--stdio", "--model", "pinned"]);
	});

	it("does NOT forward reasoningEffort as a CLI flag (Copilot ignores --effort in --acp mode)", () => {
		const { args } = resolveAcpCommandArgs("github-copilot", {
			githubCopilot: { reasoningEffort: "high" },
			mcpServers: [],
		});
		// Effort is applied via ACP `session/set_config_option`, not the CLI.
		expect(args).toEqual(["--acp", "--stdio"]);
		expect(args).not.toContain("--effort");
		expect(args).not.toContain("--reasoning-effort");
	});

	it("appends --model but never --effort when both are configured", () => {
		const { args } = resolveAcpCommandArgs("github-copilot", {
			githubCopilot: { defaultModel: "gpt-5.4", reasoningEffort: "high" },
			mcpServers: [],
		});
		expect(args).toEqual(["--acp", "--stdio", "--model", "gpt-5.4"]);
	});

	it("ignores reasoningEffort for non-copilot CLI providers (no CLI flag either)", () => {
		const { args } = resolveAcpCommandArgs("claude-cli", {
			// biome-ignore lint/suspicious/noExplicitAny: exercising provider-gating
			githubCopilot: { reasoningEffort: "high" } as any,
			mcpServers: [],
		});
		expect(args).toEqual(["--acp", "--stdio"]);
	});

	it("accepts reasoningEffort via schema round-trip without polluting CLI args", () => {
		const parsed = acpConfigSchema.parse({
			githubCopilot: { defaultModel: "gpt-5.4", reasoningEffort: "high" },
		});
		const { args } = resolveAcpCommandArgs("github-copilot", parsed);
		expect(args).toEqual(["--acp", "--stdio", "--model", "gpt-5.4"]);
		expect(parsed.githubCopilot.reasoningEffort).toBe("high");
	});

	it("rejects xhigh because Copilot GPT-5.4 only advertises low/medium/high", () => {
		expect(() =>
			acpConfigSchema.parse({
				githubCopilot: { defaultModel: "gpt-5.4", reasoningEffort: "xhigh" },
			}),
		).toThrow();
	});
});

describe("defineConfig", () => {
	it("is an identity passthrough", () => {
		const input = { server: { port: 4000 } };
		const result = defineConfig(input);
		expect(result).toBe(input);
	});
});

describe("resolveConfigFile", () => {
	function makeTmpDir(): string {
		return mkdtempSync(join(tmpdir(), "drmclaw-cfg-"));
	}

	it("returns absolute path when .local.ts exists in cwd", () => {
		const dir = makeTmpDir();
		writeFileSync(join(dir, "drmclaw.config.local.ts"), "export default {}");
		expect(resolveConfigFile(dir)).toBe(join(dir, "drmclaw.config.local.ts"));
	});

	it("returns absolute path when .local.mjs exists in cwd", () => {
		const dir = makeTmpDir();
		writeFileSync(join(dir, "drmclaw.config.local.mjs"), "export default {}");
		expect(resolveConfigFile(dir)).toBe(join(dir, "drmclaw.config.local.mjs"));
	});

	it("falls back to package root when cwd has no config", () => {
		const dir = makeTmpDir();
		const result = resolveConfigFile(dir);
		// PACKAGE_ROOT has drmclaw.config.local.ts
		expect(result).toBeDefined();
		expect(result?.startsWith(dir)).toBe(false);
		expect(result).toContain("drmclaw.config.local.ts");
	});

	it("finds base config in cwd before falling to package root", () => {
		const dir = makeTmpDir();
		writeFileSync(join(dir, "drmclaw.config.ts"), "export default {}");
		// All cwd files (including base) are checked before PACKAGE_ROOT
		expect(resolveConfigFile(dir)).toBe(join(dir, "drmclaw.config.ts"));
	});

	it("prefers .local over base config in same directory", () => {
		const dir = makeTmpDir();
		writeFileSync(join(dir, "drmclaw.config.ts"), "export default {}");
		writeFileSync(join(dir, "drmclaw.config.local.ts"), "export default {}");
		expect(resolveConfigFile(dir)).toBe(join(dir, "drmclaw.config.local.ts"));
	});

	it("prefers .local.ts over .local.mjs by extension priority", () => {
		const dir = makeTmpDir();
		writeFileSync(join(dir, "drmclaw.config.local.ts"), "export default {}");
		writeFileSync(join(dir, "drmclaw.config.local.mjs"), "export default {}");
		expect(resolveConfigFile(dir)).toBe(join(dir, "drmclaw.config.local.ts"));
	});
});
