import { describe, expect, it } from "vitest";

/**
 * Library entrypoint tests — verify that `import "drmclaw-core"` is
 * side-effect-free and exports the expected public API.
 */
describe("library entrypoint (src/index.ts)", () => {
	it("exports are side-effect-free (no server startup)", async () => {
		// If main.ts were the entrypoint, this import would call main()
		// and try to start a server — causing a timeout/failure.
		const mod = await import("../src/index.js");
		expect(mod).toBeDefined();
	});

	it("exports core factory functions", async () => {
		const mod = await import("../src/index.js");
		expect(typeof mod.loadDrMClawConfig).toBe("function");
		expect(typeof mod.loadSkills).toBe("function");
		expect(typeof mod.createLLMAdapter).toBe("function");
		expect(typeof mod.createAgentRuntime).toBe("function");
		expect(typeof mod.createApp).toBe("function");
		expect(typeof mod.defineConfig).toBe("function");
	});

	it("exports TaskRunner class", async () => {
		const mod = await import("../src/index.js");
		expect(typeof mod.TaskRunner).toBe("function");
	});

	it("exports CronService class", async () => {
		const mod = await import("../src/index.js");
		expect(typeof mod.CronService).toBe("function");
	});

	it("exports WebConnector class", async () => {
		const mod = await import("../src/index.js");
		expect(typeof mod.WebConnector).toBe("function");
	});

	it("exports AcpSessionManager class", async () => {
		const mod = await import("../src/index.js");
		expect(typeof mod.AcpSessionManager).toBe("function");
	});
});
