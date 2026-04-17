/**
 * Dev server for the drmclaw developer console.
 *
 * Uses esbuild to bundle JS/TSX and Tailwind CLI for CSS.
 * Proxies /api and /ws requests to the backend on port 3000.
 *
 * Works reliably in non-TTY environments (background processes, CI,
 * Docker containers) — unlike Vite which stalls in non-interactive shells.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, watch, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { connect } from "node:net";
import { join, resolve } from "node:path";
import { context } from "esbuild";

const UI_DIR = resolve(import.meta.dirname, "..");
const PORT = Number(process.env.UI_PORT ?? 5173);
const BACKEND = process.env.BACKEND_URL ?? "http://localhost:3000";
const backendUrl = new URL(BACKEND);

// --- esbuild: bundle JS/TSX ---

/** SSE clients waiting for live-reload notifications. */
const reloadClients = new Set();

/** Safely write to all SSE reload clients, removing dead connections. */
function notifyReloadClients() {
	for (const res of reloadClients) {
		try {
			res.write("data: reload\n\n");
		} catch {
			reloadClients.delete(res);
		}
	}
}

const ctx = await context({
	entryPoints: [join(UI_DIR, "src/main.tsx")],
	bundle: true,
	outfile: join(UI_DIR, "dist/main.js"),
	format: "esm",
	platform: "browser",
	target: "es2022",
	jsx: "automatic",
	loader: { ".tsx": "tsx", ".ts": "ts", ".css": "css" },
	sourcemap: true,
	define: {
		"process.env.NODE_ENV": '"development"',
	},
	logLevel: "info",
	plugins: [
		{
			name: "live-reload",
			setup(build) {
				build.onEnd((result) => {
					if (result.errors.length === 0) {
						notifyReloadClients();
					}
				});
			},
		},
	],
});

await ctx.watch();

// --- Tailwind: compile CSS ---

// Ensure dist/ and a placeholder index.css exist before starting Tailwind
// and the CSS watcher. On a clean start ui/dist/ may not exist yet, and
// fs.watch() would throw ENOENT before Tailwind produces its first output.
const distDir = join(UI_DIR, "dist");
mkdirSync(distDir, { recursive: true });
const cssPath = join(distDir, "index.css");
if (!existsSync(cssPath)) {
	writeFileSync(cssPath, "/* placeholder — Tailwind will overwrite */\n");
}

const tailwind = spawn(
	"npx",
	["tailwindcss", "-i", join(UI_DIR, "src/index.css"), "-o", cssPath, "--watch"],
	{ cwd: UI_DIR, stdio: "inherit" },
);

// Watch Tailwind output for changes — trigger live-reload on CSS rebuild.
// esbuild's onEnd plugin handles JS rebuilds; this covers CSS-only changes.
watch(cssPath, { persistent: false }, () => {
	notifyReloadClients();
});

// --- HTTP server: static files + proxy ---

/** MIME types for static file serving. */
const MIME = {
	".html": "text/html",
	".js": "application/javascript",
	".css": "text/css",
	".map": "application/json",
	".json": "application/json",
	".svg": "image/svg+xml",
	".png": "image/png",
	".ico": "image/x-icon",
};

/**
 * Read index.html and inject the bundled script/css references + live-reload.
 * Asset paths are root-relative (/index.css, /main.js) — same contract
 * the production build uses, since the backend serves ui/dist/ as web root.
 * In dev, a small SSE-based live-reload script is injected before </body>.
 */
async function serveIndex() {
	const html = await readFile(join(UI_DIR, "index.html"), "utf-8");
	const LIVE_RELOAD_SCRIPT = `<script>new EventSource("/__reload").addEventListener("message",()=>location.reload())</script>`;
	return html
		.replace(
			'<script type="module" src="/src/main.tsx"></script>',
			'<link rel="stylesheet" href="/index.css">\n    <script type="module" src="/main.js"></script>',
		)
		.replace("</body>", `    ${LIVE_RELOAD_SCRIPT}\n  </body>`);
}

/** Proxy an HTTP request to the backend. */
function proxyHttp(req, res) {
	const proxyReq = httpRequest(
		{
			hostname: backendUrl.hostname,
			port: backendUrl.port,
			path: req.url,
			method: req.method,
			headers: { ...req.headers, host: `${backendUrl.hostname}:${backendUrl.port}` },
		},
		(proxyRes) => {
			res.writeHead(proxyRes.statusCode, proxyRes.headers);
			proxyRes.pipe(res);
		},
	);
	proxyReq.on("error", () => {
		res.writeHead(502);
		res.end("Backend unavailable");
	});
	req.pipe(proxyReq);
}

const server = createServer(async (req, res) => {
	const pathname = new URL(req.url, `http://localhost:${PORT}`).pathname;

	// Proxy /api/* to backend
	if (pathname.startsWith("/api")) {
		return proxyHttp(req, res);
	}

	// SSE endpoint for live-reload
	if (pathname === "/__reload") {
		res.writeHead(200, {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
		});
		reloadClients.add(res);
		req.on("close", () => reloadClients.delete(res));
		return;
	}

	// Serve built assets from dist/ (root-relative paths, same as production)
	const ext = pathname.slice(pathname.lastIndexOf("."));
	const mime = MIME[ext];
	if (mime && pathname !== "/") {
		try {
			const content = await readFile(join(UI_DIR, "dist", pathname.slice(1)));
			res.writeHead(200, { "Content-Type": mime });
			res.end(content);
			return;
		} catch {
			// Fall through to SPA fallback
		}
	}

	// SPA fallback: serve index.html
	try {
		const html = await serveIndex();
		res.writeHead(200, { "Content-Type": "text/html" });
		res.end(html);
	} catch (err) {
		res.writeHead(500);
		res.end(String(err));
	}
});

// WebSocket proxy: forward /ws upgrade to backend
server.on("upgrade", (req, socket, head) => {
	if (!req.url?.startsWith("/ws")) {
		socket.destroy();
		return;
	}

	const backendSocket = connect({ host: backendUrl.hostname, port: Number(backendUrl.port) });
	const handshakeTimeout = setTimeout(() => {
		socket.destroy();
		backendSocket.destroy();
	}, 5000);

	backendSocket.once("connect", () => {
		const reqLine = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`;
		const headers = Object.entries(req.headers)
			.map(([k, v]) => `${k}: ${v}`)
			.join("\r\n");
		backendSocket.write(`${reqLine}${headers}\r\n\r\n`);
		if (head.length > 0) backendSocket.write(head);
		backendSocket.once("data", () => clearTimeout(handshakeTimeout));
		socket.pipe(backendSocket).pipe(socket);
	});
	backendSocket.on("error", () => socket.destroy());
	backendSocket.on("close", () => clearTimeout(handshakeTimeout));
	socket.on("error", () => backendSocket.destroy());
	socket.on("close", () => backendSocket.destroy());
});

server.listen(PORT, () => {
	console.log(`[drmclaw-ui] Dev server: http://localhost:${PORT}`);
});

// Cleanup on exit
function cleanup() {
	tailwind.kill();
	ctx.dispose();
	server.close();
	process.exit(0);
}

process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);
