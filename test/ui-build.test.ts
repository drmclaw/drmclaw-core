import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Smoke test for the UI production build.
 *
 * Builds the developer console and verifies:
 * 1. The build script exits cleanly.
 * 2. The generated index.html references root-relative asset paths
 *    (/index.css, /main.js) — not /dist/ prefixed — because the backend
 *    serves ui/dist/ as the web root.
 * 3. Every asset referenced in the HTML exists on disk.
 */

const UI_DIR = join(import.meta.dirname, "..", "ui");
const DIST_DIR = join(UI_DIR, "dist");

describe("UI production build", () => {
	// Run the build once for all assertions.
	// execSync throws on non-zero exit, so the test fails if the build breaks.
	execSync("node scripts/build.mjs", { cwd: UI_DIR, stdio: "pipe" });

	it("generates dist/index.html with root-relative asset paths", () => {
		const htmlPath = join(DIST_DIR, "index.html");
		expect(existsSync(htmlPath)).toBe(true);

		const html = readFileSync(htmlPath, "utf-8");

		// Must reference root-relative paths (no /dist/ prefix)
		expect(html).toContain('href="/index.css"');
		expect(html).toContain('src="/main.js"');

		// Must NOT contain /dist/-prefixed paths
		expect(html).not.toContain("/dist/index.css");
		expect(html).not.toContain("/dist/main.js");
	});

	it("produces main.js bundle", () => {
		expect(existsSync(join(DIST_DIR, "main.js"))).toBe(true);
	});

	it("produces index.css from Tailwind", () => {
		expect(existsSync(join(DIST_DIR, "index.css"))).toBe(true);
	});

	it("produces sourcemap", () => {
		expect(existsSync(join(DIST_DIR, "main.js.map"))).toBe(true);
	});

	it("does not include duplicate CSS from esbuild", () => {
		// esbuild would output main.css as a sibling if main.tsx imported CSS.
		// Since main.tsx no longer imports index.css, this file should not exist.
		expect(existsSync(join(DIST_DIR, "main.css"))).toBe(false);
	});
});
