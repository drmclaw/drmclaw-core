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
		expect(config.llm.allowedTools).toEqual([]);
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
});

describe("resolveAcpCommandArgs", () => {
	it("defaults to copilot --acp --stdio for github-copilot", () => {
		const { command, args } = resolveAcpCommandArgs("github-copilot", {
			githubCopilot: {},
		});
		expect(command).toBe("copilot");
		expect(args).toEqual(["--acp", "--stdio"]);
	});

	it("appends --model when githubCopilot.defaultModel is set", () => {
		const { command, args } = resolveAcpCommandArgs("github-copilot", {
			githubCopilot: { defaultModel: "gpt-5.4" },
		});
		expect(command).toBe("copilot");
		expect(args).toEqual(["--acp", "--stdio", "--model", "gpt-5.4"]);
	});

	it("does not duplicate --model if already in args", () => {
		const { args } = resolveAcpCommandArgs("github-copilot", {
			args: ["--acp", "--stdio", "--model", "custom-model"],
			githubCopilot: { defaultModel: "gpt-5.4" },
		});
		expect(args).toEqual(["--acp", "--stdio", "--model", "custom-model"]);
	});

	it("allows explicit command/args to override provider defaults", () => {
		const { command, args } = resolveAcpCommandArgs("github-copilot", {
			command: "gh-copilot",
			args: ["--custom-flag"],
			githubCopilot: {},
		});
		expect(command).toBe("gh-copilot");
		expect(args).toEqual(["--custom-flag"]);
	});

	it("uses correct default commands for CLI providers", () => {
		const { command: cmd1 } = resolveAcpCommandArgs("claude-cli", { githubCopilot: {} });
		expect(cmd1).toBe("claude");

		const { command: cmd2 } = resolveAcpCommandArgs("openai-cli", { githubCopilot: {} });
		expect(cmd2).toBe("openai");

		const { command: cmd3 } = resolveAcpCommandArgs("gemini-cli", { githubCopilot: {} });
		expect(cmd3).toBe("gemini");
	});

	it("uses --acp --stdio as default args for non-copilot CLI providers", () => {
		for (const provider of ["claude-cli", "openai-cli", "gemini-cli"] as const) {
			const { args } = resolveAcpCommandArgs(provider, { githubCopilot: {} });
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
