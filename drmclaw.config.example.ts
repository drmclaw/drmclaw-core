import { defineConfig } from "./src/config/schema.js";

/**
 * Example drmclaw configuration.
 *
 * Copy to `drmclaw.config.ts` and customize for your environment.
 * Local overrides go in `drmclaw.config.local.ts` (gitignored).
 */
export default defineConfig({
	server: {
		port: 3000,
		maxConcurrent: 1,
	},

	skills: {
		systemDir: "./skills",
		dirs: [
			// Add paths to external skill directories here:
			// "/path/to/my-custom-skills",
		],
	},

	llm: {
		provider: "github-copilot",
		acp: {
			// command: "copilot",              // override binary name
			// args: ["--acp", "--stdio"],      // override default args
			githubCopilot: {
				// defaultModel: "gpt-4o",      // model forwarded via --model flag
			},
		},
		allowedTools: ["shell(git)", "write"],
		retry: {
			attempts: 3,
			maxDelayMs: 30000,
			jitter: 0.1,
		},
	},

	workspace: {
		// dir: "./workspace",
		bootstrapMaxChars: 20000,
	},

	// dataDir: ".drmclaw",                   // runtime data directory (events, jobs)

	scheduler: {
		enabled: false,
	},

	taskHistory: {
		pruneAfter: "30d",
		maxEntries: 500,
	},
});
