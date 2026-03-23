import { describe, expect, it } from "vitest";
import { executeCommand } from "../src/runner/executor.js";

describe("executeCommand", () => {
	it("executes an allowed command", async () => {
		const result = await executeCommand("echo", ["hello world"]);

		expect(result.exitCode).toBe(0);
		expect(result.stdout.trim()).toBe("hello world");
	});

	it("rejects commands not in the allowlist", async () => {
		await expect(executeCommand("rm", ["-rf", "/"])).rejects.toThrow(/not in the allowlist/);
	});

	it("rejects commands with custom allowlist", async () => {
		const allowlist = new Set(["echo"]);

		await expect(executeCommand("ls", ["."], { allowlist })).rejects.toThrow(
			/not in the allowlist/,
		);

		const result = await executeCommand("echo", ["ok"], { allowlist });
		expect(result.exitCode).toBe(0);
	});
});
