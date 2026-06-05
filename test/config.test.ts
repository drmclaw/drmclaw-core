import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveConfigFile } from "../src/config/loader.js";
import {
	codexAppServerConfigSchema,
	configSchema,
	defineConfig,
	resolveCodexAppServerCommandArgs,
} from "../src/config/schema.js";

describe("configSchema", () => {
	it("parses empty input with all defaults", () => {
		const config = configSchema.parse({});

		expect(config.server.port).toBe(3000);
		expect(config.server.maxConcurrent).toBe(1);
		expect(config.llm.provider).toBe("codex-app-server");
		expect(config.llm.codex.command).toBe("codex");
		expect(config.llm.codex.args).toEqual(["app-server"]);
		expect(config.llm.codex.approvalPolicy).toBe("never");
		expect(config.llm.codex.sandbox).toBe("danger-full-access");
		expect(config.llm.reasoningEffort).toBeUndefined();
		expect(config.llm.permissionMode).toBe("approve-all");
		expect(config.skills.systemDir).toBe("./skills");
		expect(config.dataDir).toBe(".drmclaw");
		expect(config.executionHistory.enabled).toBe(true);
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

	it("accepts Codex App Server command overrides", () => {
		const config = configSchema.parse({
			server: { port: 8080 },
			llm: {
				provider: "codex-app-server",
				codex: { command: "my-codex", args: ["app-server", "--listen", "stdio://"] },
			},
		});

		expect(config.server.port).toBe(8080);
		expect(config.llm.provider).toBe("codex-app-server");
		expect(config.llm.codex.command).toBe("my-codex");
		expect(config.llm.codex.args).toEqual(["app-server", "--listen", "stdio://"]);
	});

	it("rejects removed provider IDs", () => {
		for (const provider of ["github-copilot", "claude-cli", "openai", "gemini-cli"]) {
			expect(() => configSchema.parse({ llm: { provider } })).toThrow();
		}
	});

	it("accepts Codex approval and sandbox settings", () => {
		const config = configSchema.parse({
			llm: {
				codex: {
					approvalPolicy: "on-request",
					sandbox: "workspace-write",
				},
			},
		});

		expect(config.llm.codex.approvalPolicy).toBe("on-request");
		expect(config.llm.codex.sandbox).toBe("workspace-write");
	});

	it("accepts llm.model as optional string", () => {
		const config = configSchema.parse({ llm: { model: "claude-sonnet-4" } });
		expect(config.llm.model).toBe("claude-sonnet-4");
	});

	it("accepts Codex reasoning effort", () => {
		const config = configSchema.parse({ llm: { reasoningEffort: "high" } });
		expect(config.llm.reasoningEffort).toBe("high");
	});

	it("defaults llm.model to undefined", () => {
		const config = configSchema.parse({});
		expect(config.llm.model).toBeUndefined();
		expect(config.llm.reasoningEffort).toBeUndefined();
	});

	it("allows execution history to be disabled", () => {
		const config = configSchema.parse({ executionHistory: { enabled: false } });
		expect(config.executionHistory.enabled).toBe(false);
	});

	it("rejects invalid Codex approval and sandbox settings", () => {
		expect(() => configSchema.parse({ llm: { codex: { approvalPolicy: "always" } } })).toThrow();
		expect(() => configSchema.parse({ llm: { codex: { sandbox: "network-full" } } })).toThrow();
		expect(() => configSchema.parse({ llm: { reasoningEffort: "extreme" } })).toThrow();
	});
});

describe("resolveCodexAppServerCommandArgs", () => {
	it("defaults to codex app-server", () => {
		const parsed = codexAppServerConfigSchema.parse({});
		const { command, args } = resolveCodexAppServerCommandArgs(parsed);
		expect(command).toBe("codex");
		expect(args).toEqual(["app-server"]);
	});

	it("allows explicit command and args", () => {
		const parsed = codexAppServerConfigSchema.parse({
			command: "node",
			args: ["fake-codex-app-server.mjs"],
		});
		const { command, args } = resolveCodexAppServerCommandArgs(parsed);
		expect(command).toBe("node");
		expect(args).toEqual(["fake-codex-app-server.mjs"]);
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
