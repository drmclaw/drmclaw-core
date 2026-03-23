import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		globals: true,
		include: ["test/real-provider-*.test.ts"],
		testTimeout: 120_000,
	},
});
