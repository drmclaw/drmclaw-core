# drmclaw-core

Open core runtime for Dr. MClaw.

`drmclaw-core` is an open source AI workflow automation engine. It contains the runtime, SDKs, abstractions, and starter workflows needed to run, extend, and self-host Dr. MClaw and related workflow-driven AI systems.

## Purpose

This repo exists to provide a trustworthy and extensible foundation for AI workflow automation.

It is designed for:

- developers who want to understand or extend the runtime,
- teams who want to self-host the core engine,
- partners who want to build custom skills, connectors, and workflows,
- builders who want to create domain-specific AI automation products on top of a reusable core.

## Architecture

`drmclaw-core` is a TypeScript server that loads skills, routes prompts through pluggable LLM adapters, executes skill-based tasks, runs scheduled jobs, and exposes a developer console with real-time streaming.

```
┌─────────────────────────────────────────────────────┐
│                   drmclaw-core                      │
│                                                     │
│  ┌───────────┐  ┌───────────┐  ┌────────────────┐  │
│  │  Skills    │  │  Config   │  │  Connectors    │  │
│  │  Loader    │  │  System   │  │  (Web, Slack,  │  │
│  │           │  │  (Zod)    │  │   Teams, ...)  │  │
│  └─────┬─────┘  └─────┬─────┘  └───────┬────────┘  │
│        │              │                 │            │
│  ┌─────▼──────────────▼─────────────────▼────────┐  │
│  │  Task Runner (prompt assembly, orchestration)  │  │
│  └─────────────────────┬─────────────────────────┘  │
│                        │                             │
│  ┌─────────────────────▼─────────────────────────┐  │
│  │  AgentRuntime (orchestration, policies)        │  │
│  └─────────────────────┬─────────────────────────┘  │
│                        │                             │
│  ┌─────────────────────▼─────────────────────────┐  │
│  │            LLM Adapter Layer                  │  │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐    │  │
│  │  │   ACP    │  │ OpenAI / │  │  Direct  │    │  │
│  │  │ (stdio)  │  │ Anthropic│  │  Adapters │    │  │
│  │  └──────────┘  └──────────┘  └──────────┘    │  │
│  └───────────────────────────────────────────────┘  │
│                                                     │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────┐  │
│  │  Scheduler   │  │  Task Queue  │  │  Audit   │  │
│  │  (croner)    │  │  (per-user   │  │  Events  │  │
│  │              │  │   + global)  │  │          │  │
│  └──────────────┘  └──────────────┘  └──────────┘  │
│                                                     │
│  ┌──────────────────────────────────────────────┐   │
│  │  HTTP + WebSocket Server (Hono)              │   │
│  │  REST API  ·  Streaming  ·  Dev Console      │   │
│  └──────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────┘
```

### Key Components

- **Skill System** — Multi-directory skill discovery with `SKILL.md` frontmatter format. System skills ship with the engine; external skills loaded from configurable paths. Skills can be LLM-interpreted (instructions only) or script-backed (with an `entrypoint`).
- **LLM Adapter Layer** — Pluggable provider interface with a provider-family configuration model: **CLI providers** (`github-copilot`, `claude-cli`, `openai-cli`, `gemini-cli`) launch an ACP-compatible CLI over stdio; **embedded providers** (`claude`, `openai`, `gemini`) will talk to the upstream API directly (future). The provider ID is the single configuration axis — ACP is an internal transport detail of the CLI-provider path. An `AcpSessionManager` owns process lifecycle, session mapping, and cancellation. The adapter emits structured `AdapterEvent`s (`text`, `tool_call`, `tool_result`) that the runtime maps to `RuntimeEvent`s.
- **Agent Runtime** — Backend-aware orchestration of skills, tools, policies, and workflow state. In ACP mode, the upstream agent CLI owns the bounded tool-calling loop; drmclaw injects skills via system prompt, forwards supported policy controls, and normalizes lifecycle events. In direct-provider mode, drmclaw owns the bounded tool-calling loop using Vercel AI SDK `generateText` with `maxSteps` and drmclaw-defined tools (skill execution, file ops, etc.).
- **Task Runner** — Orchestrates each task run: assembles structured system prompts (Tooling → Safety → Skills → Workspace → Runtime → Time), selects the appropriate AgentRuntime backend (ACP or direct-provider), invokes it, collects lifecycle events, and returns structured results. The task runner does not run the tool-calling loop itself — that is the AgentRuntime's responsibility.
- **Task Queue** — Per-user and global lane serialization with configurable concurrency caps. Prevents session races and upstream rate limits.
- **Scheduler** — Cron-based job scheduling using `croner`. Jobs stored in JSON with atomic writes. Supports missed-job detection, concurrency limits, and timezone awareness.
- **Connectors** — Minimal interface (`onMessage`, `sendMessage`, `sendTaskStatus`) for receiving prompts and delivering results. Ships with a WebSocket-based web connector; additional connectors (Slack, Teams, etc.) implement the same interface.
- **HTTP + WebSocket Server** — Built on Hono. REST API for chat, tasks, skills, and job management. WebSocket for real-time streaming with code-fence-aware chunking.
- **Audit & Events** — Typed lifecycle events (`start`, `end`, `error`) emitted during task execution. Full execution records for review, compliance, and process optimization.

## What Lives Here

The public core includes:

- task runner and execution model,
- scheduling primitives,
- LLM adapter interfaces and base adapters (ACP, future direct providers),
- agent runtime orchestration and backend-aware policy controls,
- skill system and `SKILL.md` support,
- connector SDKs and basic connectors,
- configuration and policy primitives (Zod-validated config),
- audit and event primitives,
- storage abstractions (JSON file store, upgradeable to SQLite),
- workspace bootstrap file support (`AGENTS.md`, `CONTEXT.md`),
- stream chunking and WebSocket delivery,
- task queue with lane serialization,
- bundled system skills and examples,
- self-host templates and deployment guides.

## Tech Stack

| Layer | Technology | Rationale |
|---|---|---|
| Language | TypeScript (strict, ESM) | Type safety, ecosystem breadth |
| Runtime | Node.js 22+ | LTS, native ESM, modern APIs |
| HTTP + WebSocket | Hono + @hono/node-ws | Lightweight, TypeScript-native |
| LLM (MVP) | ACP over stdio | Transport to provider-specific ACP CLIs (GitHub Copilot, Claude, OpenAI, etc.) |
| LLM (future) | Vercel AI SDK Core (`ai`) | Mainstream multi-provider abstraction |
| Agent runtime | drmclaw-owned `AgentRuntime` over `ai` | Skills/policy orchestration; direct providers use drmclaw-owned `maxSteps`, ACP providers delegate the bounded loop to the upstream CLI |
| Cron | croner | Timezone-aware, well-maintained |
| Config | c12 | Supports .ts/.json/.yaml, env vars |
| Validation | Zod | Industry standard TypeScript validation |
| Skill parsing | gray-matter | Standard YAML frontmatter parser |
| Testing | Vitest | Fast, Vite-compatible |
| Lint / Format | Biome | Single tool, fast |
| Package manager | pnpm | Workspace support, fast installs |

## Configuration

`drmclaw-core` uses a file-based config system loaded via `c12`. Configuration can live in `drmclaw.config.ts`, `drmclaw.config.json`, or environment variables.

Key config areas:

- **`server`** — Port, max concurrent tasks, dev console path.
- **`skills`** — System skill directory and external skill directory paths.
- **`llm`** — Provider selection, nested ACP config for CLI providers, API keys, tool allowlist, retry policy, failover chain.

### Provider Model

Configuration uses **provider** as the single user-facing axis. The provider ID determines how drmclaw communicates with the upstream model — there is no separate `transport` setting.

**CLI providers** launch an ACP-compatible CLI binary. ACP is an internal transport detail.

| Provider ID | Default command | Default args | Notes |
| --- | --- | --- | --- |
| `github-copilot` (default) | `copilot` | `--acp --stdio` | `githubCopilot.defaultModel` appended as `--model` |
| `claude-cli` | `claude` | `--acp --stdio` | |
| `openai-cli` | `openai` | `--acp --stdio` | |
| `gemini-cli` | `gemini` | `--acp --stdio` | |

**Embedded providers** talk to the upstream API directly and drmclaw owns the tool-calling loop. These are defined but not yet implemented:

| Provider ID | Runtime path | Status |
| --- | --- | --- |
| `claude` | Direct HTTP (Vercel AI SDK) | Future |
| `openai` | Direct HTTP (Vercel AI SDK) | Future |
| `gemini` | Direct HTTP (Vercel AI SDK) | Future |

Explicit `command` / `args` in the `acp` block always override CLI provider defaults. Provider-specific settings live under their own key (e.g. `githubCopilot`).

```ts
llm: {
	provider: "github-copilot",
	acp: {
		// command and args are optional — provider defaults apply
		githubCopilot: {
			defaultModel: "gpt-5.4",   // forwarded as --model gpt-5.4
		},
	},
}
```

Resolution is handled by `resolveAcpCommandArgs(provider, acpCfg)`, which returns `{ command, args }` ready for `spawn()`. The helper `isCliProvider(provider)` determines whether a provider routes through ACP.
- **`workspace`** — Optional directory with bootstrap files (`AGENTS.md`, `CONTEXT.md`) injected into the system prompt. Per-file injection cap (default 20KB).
- **`scheduler`** — Enable/disable, inline job definitions or path to `jobs.json`.
- **`taskHistory`** — Retention period, max entries, disk budget.

Local overrides use a `.local` suffix (e.g. `drmclaw.config.local.ts`) which is gitignored by default.

### Execution Policy

Execution policies are split by backend so each runtime path only exposes controls it can actually enforce.

**CommonExecutionPolicy** — cross-backend fields semantically valid for both ACP and direct-provider runtimes:

| Field              | Type       | Purpose                                   |
| ------------------ | ---------- | ----------------------------------------- |
| `toolAllowlist`    | `string[]` | Tool names the agent may invoke            |
| `skillAllowlist`   | `string[]` | Skill names the agent may use              |
| `filePatterns`     | `string[]` | File path patterns for read/write access   |
| `commandAllowlist` | `string[]` | Shell commands allowed for execution       |

**PlainExecutionPolicy** — `CommonExecutionPolicy & { backend?: never; maxSteps?: never }`. Used as the policy slot type in backend-specific runtime options so that a `DirectExecutionPolicy` variable (with `backend: "direct"` and `maxSteps`) cannot be structurally assigned into the ACP path, and vice versa.

**AcpExecutionPolicy** (`backend: "acp"`) — extends `CommonExecutionPolicy`. The upstream ACP CLI owns the tool-calling loop; drmclaw enforces tool allowlists via `evaluatePermission` but does not own loop-level bounds.

**DirectExecutionPolicy** (`backend: "direct"`) — extends `CommonExecutionPolicy` with `maxSteps?: number`. drmclaw owns the tool-calling loop (Vercel AI SDK `generateText`) and enforces loop bounds directly.

Backend-specific runtime options are discriminated on `backend`:

- **`AcpRuntimeOptions`** (`backend: "acp"`) accepts `AcpExecutionPolicy | PlainExecutionPolicy`
- **`DirectRuntimeOptions`** (`backend: "direct"`) accepts `DirectExecutionPolicy | PlainExecutionPolicy`
- **`AgentRuntimeOptions`** is the discriminated union of both, narrowable via `options.backend`

`maxSteps` is only available on the direct-provider path. ACP-mode bounded execution is upstream-owned.

### ACP Session Continuity

Multiple user prompts on the same conversation share a stable `sessionId`, so `AcpSessionManager` reuses one upstream ACP session instead of spawning a fresh process per message. The plumbing path is: `app.ts` → `WebConnector` → `TaskRunner` → `AcpRuntime` → `AcpAdapter` → `AcpSessionManager.acquire(sessionId)`. REST `/api/chat` callers get one-off sessions (no sessionId supplied).

Bounded agentic execution (internal multi-round tool-calling loops) is upstream-owned by the provider CLI in ACP mode. drmclaw injects skills, forwards policy controls, and normalizes the resulting event stream.

### Real-Provider Tests

`test/real-provider-agentic.test.ts` contains lightweight smoke tests that exercise the full drmclaw → ACP → real provider CLI pipeline. Run with `pnpm test:real`. Defaults to `github-copilot`; set `DRMCLAW_REAL_PROVIDER` to override. Coverage: prompt round-trip, tool use, session reuse (PID identity), and skill injection. Protocol-level seam behavior (event translation, session lifecycle) is covered by the fast mocked suite (`bounded-agentic.test.ts`, `acp-session.test.ts`, `runner.test.ts`, `runtime.test.ts`).

### Skills Hardening

The skills system includes the following safety and operability features:

1. **Path containment** — Every discovered skill directory and resolved `entrypoint` is validated (via `realpath`) to stay inside its configured root. Symlink-based traversal and `../` path escape are rejected at load time.
2. **Bundled dir resolution** — The bundled `skills/` directory is resolved relative to the installed package root (using `import.meta.url`), not the current working directory. Bundled skills work in repo dev, npm-installed, and built-runtime execution modes.
3. **Bounded discovery** — Skill roots are capped at 200 candidate directories and 100 loaded skills per root (`MAX_CANDIDATES_PER_ROOT`, `MAX_SKILLS_PER_ROOT`), preventing unbounded filesystem crawls from misconfigured or adversarial directories.
4. **Skill readiness / status** — Each skill exposes `ready` (boolean) and `missingRequires` (string[]) based on its `requires` frontmatter. Requirements are checked against locally available commands. The `/api/skills` endpoint and CLI commands surface this status.
5. **CLI inspection** — Operator-facing skill commands are available without starting the web UI:

```bash
drmclaw skills list          # Tabular listing: name, source, ready, description
drmclaw skills info <name>   # Detailed view: paths, entrypoint, requires, metadata
drmclaw skills check         # Validate all skills; exits non-zero if any are not ready
```

## Repo Structure

`drmclaw-core` is a single npm package with subpath exports (e.g. `drmclaw-core/sdk`, `drmclaw-core/connectors`). `ui/` is a pnpm workspace member for development but is not published separately. No `packages/` directory — split into separate packages only when the surface area warrants it.

```
drmclaw-core/
├── src/
│   ├── index.ts                # Library entrypoint (side-effect-free)
│   ├── cli.ts                  # CLI / server bootstrap
│   ├── config/                 # Zod schema + c12 loader
│   ├── skills/                 # Multi-directory skill discovery + SKILL.md parsing
│   ├── llm/                    # LLM adapter interface + ACP adapter
│   ├── runtime/                # Agent runtime: orchestration, policies
│   ├── runner/                 # Task execution, system prompt assembly, queue, chunker
│   ├── scheduler/              # Cron service, timer loop, job store
│   ├── connectors/             # Connector interface + web connector
│   └── server/                 # Hono app, REST routes, WebSocket handler
├── skills/                     # Bundled system skills
├── ui/                         # Developer console (Vite + React + Tailwind, workspace member)
├── package.json                # Single published package with subpath exports
├── pnpm-workspace.yaml         # Workspace: root + ui/
├── tsconfig.json
├── vitest.config.ts
├── biome.json
└── drmclaw.config.example.ts   # Example configuration
```

## Design Philosophy

`drmclaw-core` is intentionally domain-agnostic at the top level and opinionated at the runtime level.

- It exposes strong primitives and extension seams.
- It does not hard-code a single business vertical.
- It is usable on its own.
- It preserves seams for future enterprise deployment options without making enterprise features the default.

At the runtime level, the core favors a **skills-first, policy-driven, and bounded** model of automation.

- New behavior is introduced through skills, workflow definitions, connectors, and explicit integrations.
- Execution is predictable and reviewable rather than dependent on unconstrained runtime self-modification.
- Permissions, tool use, and side effects are controllable through clear policy boundaries.
- Auditability and repeatability are core runtime properties, not optional add-ons.

## Positioning

`drmclaw-core` is a general AI workflow automation engine, not a GTM-only framework.

- The runtime stays reusable across domains.
- Domain-specific products are built through workflows, skills, connectors, and packaging layers.
- GTM is one important application area, but not the only one.

Examples of domains that can be built on top of the core:

- GTM and content operations,
- internal business workflows,
- research and analysis pipelines,
- document and reporting automation,
- team-specific AI operators with controlled tool access.

## Getting Started

```bash
# Clone the repo
git clone https://github.com/your-org/drmclaw-core.git
cd drmclaw-core

# Install dependencies
pnpm install

# Copy and edit config
cp drmclaw.config.example.ts drmclaw.config.ts

# Start in development mode
pnpm dev
```

The server starts on port 3000 by default. The bundled developer console (chat, task viewer, skill list, job management) is served at the root path. This is an operator/self-host admin surface — product-level UIs are built in separate product repos.

### Prerequisites

- Node.js 22+
- pnpm
- An ACP-compatible CLI (default: GitHub Copilot CLI, authenticated via `gh auth login`) for the default LLM adapter

## Long-Term Role

This repo is the stable platform layer for:

- community and developer adoption,
- self-hosted experimentation,
- ecosystem building,
- domain-specific workflow products built on a shared runtime.

Product layers built on top of the core can evolve quickly, but the core itself must stay understandable, modular, and extensible.