/**
 * Production build for the drmclaw developer console.
 *
 * Bundles JS/TSX with esbuild and compiles Tailwind CSS.
 * Output goes to ui/dist/.
 */

import { execSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { build } from "esbuild";

const UI_DIR = resolve(import.meta.dirname, "..");

// Clean dist
await rm(join(UI_DIR, "dist"), { recursive: true, force: true });
await mkdir(join(UI_DIR, "dist"), { recursive: true });

// Bundle JS/TSX
await build({
	entryPoints: [join(UI_DIR, "src/main.tsx")],
	bundle: true,
	outfile: join(UI_DIR, "dist/main.js"),
	format: "esm",
	platform: "browser",
	target: "es2022",
	jsx: "automatic",
	loader: { ".tsx": "tsx", ".ts": "ts", ".css": "css" },
	minify: true,
	sourcemap: true,
	define: {
		"process.env.NODE_ENV": '"production"',
	},
});

// Compile Tailwind CSS
execSync(
	`npx tailwindcss -i ${join(UI_DIR, "src/index.css")} -o ${join(UI_DIR, "dist/index.css")} --minify`,
	{ cwd: UI_DIR, stdio: "inherit" },
);

// Generate production index.html
// Asset paths are root-relative (/index.css, /main.js) because the backend
// serves ui/dist/ as the web root via serveStatic.
const html = await readFile(join(UI_DIR, "index.html"), "utf-8");
const prodHtml = html.replace(
	'<script type="module" src="/src/main.tsx"></script>',
	'<link rel="stylesheet" href="/index.css">\n    <script type="module" src="/main.js"></script>',
);
await writeFile(join(UI_DIR, "dist/index.html"), prodHtml);

console.log("[drmclaw-ui] Build complete → ui/dist/");
