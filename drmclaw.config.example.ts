import { defineConfig } from "./src/config/schema.js";

/**
 * Example drmclaw configuration.
 *
 * Copy to `drmclaw.config.ts` and customize for your environment.
 * Local overrides go in `drmclaw.config.local.ts` (gitignored).
 *
 * All fields are optional — defaults are shown inline.
 * See README.md for full documentation.
 */
export default defineConfig({
	server: {
		port: 3000,
		maxConcurrent: 1, // max concurrent tasks
		maxQueueSize: 50, // max queued tasks
	},

	skills: {
		systemDir: "./skills", // built-in skills bundled with the repo
		dirs: [
			// Add paths to external skill directories here:
			// "/path/to/my-custom-skills",
		],
	},

	llm: {
		// Provider ID — determines how drmclaw communicates with the LLM.
		// CLI providers: "github-copilot", "claude-cli", "openai-cli", "gemini-cli"
		// Embedded (future): "claude", "openai", "gemini"
		provider: "github-copilot",

		// Optional runtime model override (applies to all CLI providers):
		// model: "claude-sonnet-4",

		acp: {
			// command: "copilot",              // override CLI binary name
			// args: ["--acp", "--stdio"],      // override default CLI args
			githubCopilot: {
				// defaultModel: "gpt-5.4",      // fallback when llm.model is not set
				// Available models are auto-discovered from the agent at startup.
			},
			// MCP servers to forward to the ACP agent on session creation:
			// mcpServers: [
			//   {
			//     name: "filesystem",
			//     command: "npx",
			//     args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
			//     env: { HOME: "/home/ci" },
			//   },
			// ],
		},

		// Permission mode for tool-call approval:
		//   "approve-all"   — approve every tool call (default)
		//   "approve-reads" — auto-approve read/search/think/fetch, reject others
		//   "deny-all"      — reject every tool call
		permissionMode: "approve-all",

		retry: {
			attempts: 3,
			maxDelayMs: 30000,
			jitter: 0.1,
		},

		// Glob patterns for models to hide from discovery and block from selection.
		// Default: ["claude-opus-*-fast"]
		// Set to [] to allow all models.
		// excludeModels: ["claude-opus-*-fast"],
	},

	workspace: {
		// dir: "./workspace",        // directory with AGENTS.md / CONTEXT.md
		bootstrapMaxChars: 20000, // per-file injection cap
	},

	// dataDir: ".drmclaw",          // runtime data directory (events, jobs)

	scheduler: {
		enabled: false,
		// jobs: "jobs.json",        // path to jobs file, or inline array
	},

	taskHistory: {
		pruneAfter: "30d",
		maxEntries: 500,
	},
});
