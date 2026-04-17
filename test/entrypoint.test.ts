import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Source-barrel regression tests — verify that the barrel files
 * (src/index.ts, src/sdk.ts, src/connectors.ts) re-export the expected
 * public symbols and are side-effect-free.
 *
 * These import from source (../src/*.js), not from the built dist/, so
 * they catch barrel regressions without a build step. They do NOT verify
 * the package.json `exports` map, dist barrel correctness, or published
 * entrypoints. For that, see the "built package exports" suite below
 * which runs conditionally when dist/ has been built.
 */

// -------------------------------------------------------------------------
// Source barrel: "." (src/index.ts)
// -------------------------------------------------------------------------

describe("source barrel: index.ts", () => {
	it("imports are side-effect-free (no server startup)", async () => {
		const mod = await import("../src/index.js");
		expect(mod).toBeDefined();
	});

	it("exports config symbols", async () => {
		const mod = await import("../src/index.js");
		expect(typeof mod.loadDrMClawConfig).toBe("function");
		expect(typeof mod.resolveConfigFile).toBe("function");
		expect(typeof mod.defineConfig).toBe("function");
		expect(mod.configSchema).toBeDefined();
	});

	it("exports skill symbols", async () => {
		const mod = await import("../src/index.js");
		expect(typeof mod.loadSkills).toBe("function");
		expect(typeof mod.loadSkillsFromDirs).toBe("function");
		expect(typeof mod.resolveSystemSkillsDir).toBe("function");
		expect(typeof mod.findMissingRequires).toBe("function");
	});

	it("exports runtime and runner classes", async () => {
		const mod = await import("../src/index.js");
		expect(typeof mod.createAgentRuntime).toBe("function");
		expect(typeof mod.TaskRunner).toBe("function");
	});

	it("exports infrastructure services", async () => {
		const mod = await import("../src/index.js");
		expect(typeof mod.CronService).toBe("function");
		expect(typeof mod.JsonlEventStore).toBe("function");
		expect(typeof mod.FileDeliveryQueue).toBe("function");
	});

	it("exports connector and server symbols", async () => {
		const mod = await import("../src/index.js");
		expect(typeof mod.WebConnector).toBe("function");
		expect(typeof mod.createApp).toBe("function");
	});

	it("exports task executor", async () => {
		const mod = await import("../src/index.js");
		expect(typeof mod.executeTask).toBe("function");
	});

	it("exports PACKAGE_ROOT path constant", async () => {
		const mod = await import("../src/index.js");
		expect(typeof mod.PACKAGE_ROOT).toBe("string");
	});

	it("does NOT export removed internal symbols", async () => {
		const mod = await import("../src/index.js");
		const keys = Object.keys(mod);
		expect(keys).not.toContain("createLLMAdapter");
		expect(keys).not.toContain("AcpSessionManager");
		expect(keys).not.toContain("evaluatePermission");
	});
});

// -------------------------------------------------------------------------
// Source barrel: "./sdk" (src/sdk.ts)
// -------------------------------------------------------------------------

describe("source barrel: sdk.ts", () => {
	it("imports are side-effect-free", async () => {
		const mod = await import("../src/sdk.js");
		expect(mod).toBeDefined();
	});

	it("exports skill utilities", async () => {
		const mod = await import("../src/sdk.js");
		expect(typeof mod.findMissingRequires).toBe("function");
	});

	it("exports delivery queue", async () => {
		const mod = await import("../src/sdk.js");
		expect(typeof mod.FileDeliveryQueue).toBe("function");
	});

	it("exports defineConfig helper", async () => {
		const mod = await import("../src/sdk.js");
		expect(typeof mod.defineConfig).toBe("function");
	});
});

// -------------------------------------------------------------------------
// Source barrel: "./connectors" (src/connectors.ts)
// -------------------------------------------------------------------------

describe("source barrel: connectors.ts", () => {
	it("imports are side-effect-free", async () => {
		const mod = await import("../src/connectors.js");
		expect(mod).toBeDefined();
	});

	it("exports WebConnector class", async () => {
		const mod = await import("../src/connectors.js");
		expect(typeof mod.WebConnector).toBe("function");
	});

	it("exports ConnectorRegistry", async () => {
		const mod = await import("../src/connectors.js");
		expect(typeof mod.ConnectorRegistry).toBe("function");
		expect(typeof mod.createDefaultRegistry).toBe("function");
	});
});

// -------------------------------------------------------------------------
// Built package exports (dist/) — runs only after `pnpm build`
//
// These exercise the real entrypoints declared in package.json `exports`.
// Skipped when dist/ does not exist so `pnpm test` stays build-free.
// -------------------------------------------------------------------------

const distExists =
	existsSync(new URL("../dist/index.js", import.meta.url).pathname) &&
	existsSync(new URL("../dist/sdk.js", import.meta.url).pathname) &&
	existsSync(new URL("../dist/connectors.js", import.meta.url).pathname);

describe.runIf(distExists)('built package export "." (dist/index.js)', () => {
	it("is side-effect-free and exports core symbols", async () => {
		const mod = await import("../dist/index.js");
		expect(mod).toBeDefined();
		expect(typeof mod.loadDrMClawConfig).toBe("function");
		expect(typeof mod.loadSkills).toBe("function");
		expect(typeof mod.loadSkillsFromDirs).toBe("function");
		expect(typeof mod.createAgentRuntime).toBe("function");
		expect(typeof mod.TaskRunner).toBe("function");
		expect(typeof mod.executeTask).toBe("function");
		expect(typeof mod.createApp).toBe("function");
		expect(typeof mod.CronService).toBe("function");
		expect(typeof mod.JsonlEventStore).toBe("function");
		expect(typeof mod.FileDeliveryQueue).toBe("function");
		expect(typeof mod.WebConnector).toBe("function");
		expect(typeof mod.PACKAGE_ROOT).toBe("string");
	});

	it("does NOT export removed internal symbols", async () => {
		const mod = await import("../dist/index.js");
		const keys = Object.keys(mod);
		expect(keys).not.toContain("createLLMAdapter");
		expect(keys).not.toContain("AcpSessionManager");
		expect(keys).not.toContain("evaluatePermission");
	});
});

describe.runIf(distExists)('built package export "./sdk" (dist/sdk.js)', () => {
	it("is side-effect-free and exports SDK symbols", async () => {
		const mod = await import("../dist/sdk.js");
		expect(mod).toBeDefined();
		expect(typeof mod.findMissingRequires).toBe("function");
		expect(typeof mod.FileDeliveryQueue).toBe("function");
		expect(typeof mod.defineConfig).toBe("function");
	});
});

describe.runIf(distExists)('built package export "./connectors" (dist/connectors.js)', () => {
	it("is side-effect-free and exports connector symbols", async () => {
		const mod = await import("../dist/connectors.js");
		expect(mod).toBeDefined();
		expect(typeof mod.WebConnector).toBe("function");
		expect(typeof mod.ConnectorRegistry).toBe("function");
		expect(typeof mod.createDefaultRegistry).toBe("function");
	});
});
