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

## Stability Model

`drmclaw-core` is still evolving in both code and design.

Today, the most actively shaped path is the ACP-backed task-execution runtime exposed through `executeSkillAction()` (structured action surface) and `executeTask()` (lower-level prompt-first escape hatch). Other surfaces in the repo may continue to change as the architecture is simplified and clarified.

That means compatibility is not guaranteed across design updates, and documented behavior should be interpreted as the current shipped model rather than a permanent long-term commitment for every surface.

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

- **Skill System** — Multi-directory skill discovery with `SKILL.md` frontmatter format. System skills ship with the engine; external skills loaded from configurable paths. Skills can be LLM-interpreted (instructions only) or script-backed (with an `entrypoint`). Each skill is listed in the system prompt with its name, description, and the absolute path to its `SKILL.md` file. The LLM reads the skill file on demand using its built-in file-reading tool — no custom MCP server or tool registration needed.
- **LLM Adapter Layer** — Pluggable provider interface with a provider-family configuration model: **CLI providers** (`github-copilot`, `claude-cli`, `openai-cli`, `gemini-cli`) launch an ACP-compatible CLI over stdio; **embedded providers** (`claude`, `openai`, `gemini`) will talk to the upstream API directly (future). The provider ID is the single configuration axis — ACP is an internal transport detail of the CLI-provider path. An `AcpSessionManager` owns process lifecycle, session mapping, and cancellation. Subprocess shutdown follows the ACP stdio transport spec: `stdin.end()` → `SIGTERM` → 250 ms → `SIGKILL` escalation. Dead processes are auto-detected via `exit`/`error` listeners and removed from the session map so the next `acquire()` spawns a fresh connection. MCP servers listed in config are forwarded to the ACP agent's `newSession` call. The adapter emits structured `AdapterEvent`s (`text`, `tool_call`, `tool_result`, `thinking`, `plan`, `usage`) that the runtime maps to `RuntimeEvent`s.
- **Agent Runtime** — Backend-aware orchestration of skills, tools, policies, and workflow state. In ACP mode, the upstream agent CLI owns the bounded tool-calling loop; drmclaw lists skills with file paths in the system prompt so the agent reads them on demand, forwards supported policy controls, and normalizes lifecycle events. In direct-provider mode, drmclaw owns the bounded tool-calling loop using Vercel AI SDK `generateText` with `maxSteps` and drmclaw-defined tools (skill execution, file ops, etc.).
- **Task Runner** — Orchestrates each task run: assembles structured system prompts (Tooling → Safety → Skills → Workspace → Runtime → Time), selects the appropriate AgentRuntime backend (ACP or direct-provider), invokes it, collects lifecycle events, and returns structured results. The task runner does not run the tool-calling loop itself — that is the AgentRuntime's responsibility.
- **Task Queue** — Per-user and global lane serialization with configurable concurrency caps and bounded queue size (`maxQueueSize`, default 50). Rejects new tasks with an error when the queue is full. Supports graceful drain on shutdown. Prevents session races and upstream rate limits.
- **Scheduler** — Cron-based job scheduling using `croner`. Jobs stored in JSON with atomic writes. Supports missed-job detection, concurrency limits, and timezone awareness.
- **Connectors** — Minimal interface (`onMessage`, `sendMessage`, `sendTaskStatus`) for receiving prompts and delivering results. Ships with a WebSocket-based web connector; additional connectors (Slack, Teams, etc.) implement the same interface.
- **HTTP + WebSocket Server** — Built on Hono. REST API for chat, tasks, skills, and job management. A `/ready` endpoint returns `503` while the server is still initializing and `200` once fully operational (suitable for container health probes and load balancers). WebSocket for real-time streaming with code-fence-aware chunking. Graceful shutdown on `SIGINT`/`SIGTERM`: drains in-flight tasks, rejects new work, then exits cleanly.
- **Audit & Events** — Typed lifecycle events (`start`, `end`, `error`) emitted during task execution. Full execution records for review, compliance, and process optimization.
- **Delivery Queue** — Write-ahead file-backed queue for reliable outbound delivery. Entries are persisted to disk before delivery is attempted, ensuring crash recovery. Two-phase atomic ack (rename then unlink), exponential backoff retry, and startup recovery of pending entries. Generic payload type — connectors deliver any shape.
- **Task Executor** — Downstream-facing execution surface for product repos, exposed as two complementary entry points. `executeSkillAction` is the preferred structured surface: products pass an `ExecuteSkillActionRequest` (`{ skill, action, inputs, policy, skillDirs, workingDir, ... }`) that names a specific action declared in a skill's `SKILL.md` frontmatter. Core performs structured preflight validation — skill existence, action existence, required inputs, unknown inputs — before assembling any runtime, synthesizes the agent prompt internally from the structured descriptor, and returns an `ExecuteSkillActionResult` carrying `validationErrors` (codes: `SKILL_ROOT_MISSING`, `SKILL_NOT_FOUND`, `SKILL_NOT_READY`, `ACTION_NOT_FOUND`, `MISSING_REQUIRED_INPUT`, `UNKNOWN_INPUT`) and `skillResolutionErrors` (the resolver-code subset) alongside the agent's output. `ExecuteSkillActionResult` also exposes `actionValidationErrors`, the non-resolver preflight subset containing `ACTION_NOT_FOUND`, `MISSING_REQUIRED_INPUT`, and `UNKNOWN_INPUT` — the symmetric counterpart to `skillResolutionErrors`, so downstream callers do not need to reclassify codes. For request shaping, `buildExecuteSkillActionRequest(spec)` maps a domain-agnostic `SkillActionCallSpec` (`skill`, `action`, `inputs`, plus environment fields `workingDir`, `skillDirs`, `timeoutMs`, `maxOutputChars`, `permissionMode`, `skillAllowlist`) to an `ExecuteSkillActionRequest`, defaulting `policy.skillAllowlist` to `[spec.skill]` when the caller omits one; it is exported from both `drmclaw-core` and `drmclaw-core/sdk`. `executeTask` remains supported as the lower-level prompt-first escape hatch for flexible or unstructured invocations: products pass a free-form `ExecuteTaskRequest` (prompt, skill directories, execution policy, config overrides) and receive an `ExecuteTaskResult`. Both surfaces run over the same engine — core loads the real drmclaw-core config file (via `loadDrMClawConfig`), merges request-level overrides on top, then composes the full LLM-native runtime chain: `createLLMAdapter` → `createAgentRuntime` → `TaskRunner`. The configured ACP CLI is the process that runs — no child processes are spawned outside the ACP session. Types are domain-agnostic — no product or vertical concepts leak in. All setup failures (config loading, skill discovery, adapter creation) are caught inside a structured error boundary — neither entry point rejects; each always returns a structured result with `status: "error"`. One-off executions clean up ACP adapter resources via `dispose()` in a `finally` block.

  **Runtime path:** Task execution traverses the same `AgentRuntime` → `TaskRunner` infrastructure used by all other execution paths in the engine. Products pass either a structured action descriptor or a prompt + policy — no subprocess wiring leaks to the product. Skills are loaded from the resolved config (system skills + `config.skills.dirs`) first; `request.skillDirs` is merged additively with deduplication (config-driven skills take precedence by name). The combined set is optionally filtered by a skill allowlist. The `TaskRunner` generates a UUID task ID, assembles the system prompt, invokes the `AcpRuntime`, collects lifecycle events, and returns a `TaskRecord`. Products can pass an `onEvent` callback to observe runtime events during execution. Optional `timeoutMs` and `maxOutputChars` guardrails are available for constrained runs. Timeout triggers real ACP adapter disposal so the subprocess is torn down — not just a promise race — and the returned events array is a stable snapshot immune to post-timeout mutation. The result includes `provider` and `requestedModel` fields. Failure results preserve best-effort `taskId` and non-zero `durationMs` when events were already collected, so failed executions remain diagnosable.

  **Event persistence:** Both `executeSkillAction` and `executeTask` collect events in-memory only — no durable `EventStore` is wired in this path. The `PersistedRuntimeEvent` envelope type is reused for structural compatibility with the server-side `JsonlEventStore`, but events are not written to disk. The server/CLI bootstrap (`src/cli.ts`) attaches `JsonlEventStore` to the `TaskRunner` separately. Products that need durable event persistence should forward the returned `events` array to their own store.

  **Constrained policy surface:** `ExecuteTaskRequest.policy` and `ExecuteSkillActionRequest.policy` intentionally expose only `permissionMode` and `skillAllowlist`. The broader runtime policy fields (`filePatterns`, `commandAllowlist`, `maxSteps`) are available in the underlying `CommonExecutionPolicy` / `ExecutionPolicy` types but are not surfaced through either entry point. Products that need fine-grained policy control should compose `createAgentRuntime` + `TaskRunner` directly.

  **Fail-closed skill scope:** When a request declares a non-empty `policy.skillAllowlist`, the allowlist is treated as a contract, not a hint. Before any runtime is assembled, core merges config-driven skills with `request.skillDirs`, applies the allowlist, and validates the declared scope. An allowlisted skill is satisfied iff it is present in the **merged** skill set (config-driven skills merged with skills loaded from request roots). The merge prefers the config-declared copy on duplicate name, so a request root cannot override a config-declared skill of the same name; readiness is checked against the merged copy. The three error codes are evaluated in strict precedence order, and a single request returns errors of **exactly one class** (multiple errors of the same class are allowed — e.g. two missing names produce two `SKILL_NOT_FOUND` errors — but classes are never mixed):

  - `SKILL_ROOT_MISSING` — one or more entries in `request.skillDirs` do not exist on disk or are not directories. Wins outright: the resolver short-circuits, reports every failing path on a single error (via the `skillDirs` field), and does not go on to ask "was the allowlisted skill found?", because the ground truth for that question (the missing directory) is unavailable.
  - `SKILL_NOT_FOUND` — every declared root was readable, but one or more allowlisted names are absent from the merged skill set. Emitted per missing name. Wins over `SKILL_NOT_READY`: readiness is not checked for skills that happen to be present when any allowlisted name is missing.
  - `SKILL_NOT_READY` — every allowlisted skill was discovered but at least one's declared `requires` are unmet. Emitted per unready skill, carrying `missingRequires`.

  When any of these codes is raised, both `executeSkillAction` and `executeTask` return `status: "error"` immediately — no ACP subprocess is spawned. The structured reason is returned as `result.skillResolutionErrors: SkillResolutionError[]` alongside the formatted `error` string. Requests that omit `skillAllowlist` continue to run with whatever skills were discovered; the fail-closed contract applies only when the caller has explicitly scoped execution.

  **Action-contract preflight (`executeSkillAction` only):** The structured surface extends fail-closed evaluation to additional preflight codes that guard the declared action contract — `ACTION_NOT_FOUND` (the named action is not declared in the resolved skill's `SKILL.md` frontmatter), `MISSING_REQUIRED_INPUT` (a required `SkillActionInput` was omitted from `request.inputs`), and `UNKNOWN_INPUT` (`request.inputs` carries a key the action does not declare). These codes land on `result.validationErrors` alongside the resolver codes (which are also mirrored there), and like the resolver codes they are evaluated before runtime assembly and fail closed: no ACP subprocess is spawned.

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
- delivery queue (write-ahead, crash-recoverable outbound delivery),
- workspace bootstrap file support (`AGENTS.md`, `CONTEXT.md`),
- stream chunking and WebSocket delivery,
- task queue with lane serialization,
- bundled system skills and examples,
- self-host templates and deployment guides.

### Public vs Internal API

The package exports (`drmclaw-core`, `drmclaw-core/sdk`, `drmclaw-core/connectors`) define the public contract. Products and integrators should only depend on symbols exported from these entry points.

This contract is still evolving. The ACP-backed task-execution path is the current priority surface. Other exported or documented surfaces may change as the codebase is simplified or the architecture is clarified.

**Public — stable contract for product repos:**

| Symbol | Purpose |
|---|---|
| `executeSkillAction` | Structured skill-action execution surface for products (preferred) |
| `ExecuteSkillActionRequest`, `ExecuteSkillActionResult` | Structured action execution types |
| `ActionValidationError` | Structured preflight reasons for action-contract failures (skill/action/input) |
| `SkillAction`, `SkillActionInput` | Typed action metadata declared in `SKILL.md` frontmatter |
| `executeTask` | Lower-level prompt-first task execution surface (escape hatch) |
| `ExecuteTaskRequest`, `ExecuteTaskResult` | Prompt-first task execution types |
| `SkillResolutionError`, `SkillResolutionErrorCode` | Structured fail-closed reasons surfaced when an explicit skill scope cannot be resolved |
| `loadDrMClawConfig`, `resolveConfigFile`, `defineConfig`, `configSchema` | Config loading and validation |
| `createAgentRuntime` | Agent runtime factory (self-host / framework setup) |
| `TaskRunner` | Task orchestration (self-host / framework setup) |
| `createApp` | HTTP + WebSocket server factory |
| `loadSkills`, `loadSkillsFromDirs`, `resolveSystemSkillsDir` | Skill discovery |
| `CronService`, `JsonlEventStore`, `FileDeliveryQueue` | Infrastructure services |
| `WebConnector` | WebSocket connector |
| All exported `type` declarations | Type contracts for custom adapters, runtimes, connectors |

**Internal — not exported, implementation details:**

| Symbol | Reason |
|---|---|
| `AcpSessionManager` | ACP process lifecycle; internal to the LLM adapter layer |
| `createLLMAdapter` | Internal factory; composed by `executeSkillAction` / `executeTask` and CLI bootstrap, products don't need it |
| `evaluatePermission` | ACP protocol detail; internal to the adapter |

Products that need to execute skills should prefer `executeSkillAction()` — the structured action surface that declares `{ skill, action, inputs }` against the action catalog declared in `SKILL.md` frontmatter. `executeTask()` remains supported as the prompt-first escape hatch for flexible or unstructured invocations. Products that need to customize the runtime should use `createAgentRuntime()` + `TaskRunner`. Lower-level symbols are internal and may change without notice.

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
| Config | Native `import()` | Zero-dep loader; .ts files work under tsx, .mjs natively |
| Validation | Zod | Industry standard TypeScript validation |
| Skill parsing | gray-matter | Standard YAML frontmatter parser |
| Testing | Vitest | Fast, TypeScript-native |
| Lint / Format | Biome | Single tool, fast |
| Package manager | pnpm | Workspace support, fast installs |

## Configuration

`drmclaw-core` uses a file-based config system loaded via native `import()`. Configuration lives in `drmclaw.config.ts` (requires a TS loader such as `tsx`) or `drmclaw.config.mjs` (works natively). A `.local` variant (e.g. `drmclaw.config.local.ts`) takes precedence and is gitignored for per-developer overrides.

Key config areas:

- **`server`** — Port, max concurrent tasks, dev console path.
- **`skills`** — System skill directory and external skill directory paths.
- **`llm`** — Provider selection, optional runtime `model` override (applies to all CLI providers), nested ACP config for CLI providers (including `mcpServers` for MCP server passthrough), API keys, permission mode (`approve-all`/`approve-reads`/`deny-all`), retry policy, failover chain, `excludeModels` glob patterns for blocking unwanted models from discovery and selection.
- **`dataDir`** — Directory for runtime data (event logs, job store). Defaults to `.drmclaw`.

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
	model: "claude-sonnet-4",   // optional runtime model override (all CLI providers)
	acp: {
		// command and args are optional — provider defaults apply
		githubCopilot: {
			defaultModel: "gpt-5.4",   // fallback when llm.model is not set
			// Available models are auto-discovered from the agent at startup.
		},
		mcpServers: [                  // forwarded to the ACP agent's newSession call
			{
				name: "filesystem",
				command: "npx",
				args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
				env: { HOME: "/home/ci" },   // optional, defaults to {}
			},
		],
	},
	excludeModels: ["claude-opus-*-fast"],   // glob patterns — matched models are hidden from discovery and rejected by PUT /api/model
}
```

Resolution is handled by `resolveAcpCommandArgs(provider, acpCfg, modelOverride?)`, which returns `{ command, args }` ready for `spawn()`. Model precedence: `llm.model` > `githubCopilot.defaultModel` > none. Explicit `--model` in custom `args` is never overridden. The helper `isCliProvider(provider)` determines whether a provider routes through ACP.

#### Runtime Model Switching

The active model can be changed at runtime via the developer console UI or the REST API without restarting the server:

- `GET /api/model` — returns `{ model: string | null }`
- `GET /api/models` — returns `{ models: string[] }` discovered from the ACP agent at startup via a short-lived session. Models are auto-populated before the first user prompt.
- `PUT /api/model` — accepts `{ model: string }`, returns `{ model: string }`
- `GET /api/ready` — returns `{ status: "ready" | "starting", uptime }` with HTTP 200 (ready) or 503 (starting). Suitable for container health probes and load balancer checks.

When a model is changed, `AcpSessionManager` calls `session/set_model` (ACP protocol) on each active session to switch in-place. If the agent does not support `session/set_model`, the session is disposed and the next task spawns a fresh CLI process with the updated `--model` flag. On session creation, `session/set_model` is also called to ensure the desired model is active regardless of CLI flag behavior.
- **`workspace`** — Optional directory with bootstrap files (`AGENTS.md`, `CONTEXT.md`) injected into the system prompt. Per-file injection cap (default 20KB).
- **`scheduler`** — Enable/disable, inline job definitions or path to `jobs.json`.
- **`taskHistory`** — Retention period, max entries, disk budget.

Local overrides use a `.local` suffix (e.g. `drmclaw.config.local.ts`) which is gitignored by default.

### Execution Policy

Execution policies are split by backend so each runtime path only exposes controls it can actually enforce.

**CommonExecutionPolicy** — cross-backend fields semantically valid for both ACP and direct-provider runtimes:

| Field                | Type       | Purpose                                     |
| -------------------- | ---------- | ------------------------------------------- |
| `permissionMode`     | `"approve-all" \| "approve-reads" \| "deny-all"` | Tool permission mode: approve-all approves every tool, approve-reads auto-approves read/search/think/fetch kinds, deny-all rejects all |
| `skillAllowlist`     | `string[]` | Skill names the agent may use                |
| `filePatterns`       | `string[]` | File path patterns for read/write access     |
| `commandAllowlist`   | `string[]` | Shell commands allowed for execution         |

**PlainExecutionPolicy** — `CommonExecutionPolicy & { backend?: never; maxSteps?: never }`. Used as the policy slot type in backend-specific runtime options so that a `DirectExecutionPolicy` variable (with `backend: "direct"` and `maxSteps`) cannot be structurally assigned into the ACP path, and vice versa.

**AcpExecutionPolicy** (`backend: "acp"`) — extends `CommonExecutionPolicy`. The upstream ACP CLI owns the tool-calling loop; drmclaw enforces the `permissionMode` via `evaluatePermission` but does not own loop-level bounds.

**DirectExecutionPolicy** (`backend: "direct"`) — extends `CommonExecutionPolicy` with `maxSteps?: number`. drmclaw owns the tool-calling loop (Vercel AI SDK `generateText`) and enforces loop bounds directly.

Backend-specific runtime options are discriminated on `backend`:

- **`AcpRuntimeOptions`** (`backend: "acp"`) accepts `AcpExecutionPolicy | PlainExecutionPolicy`
- **`DirectRuntimeOptions`** (`backend: "direct"`) accepts `DirectExecutionPolicy | PlainExecutionPolicy`
- **`AgentRuntimeOptions`** is the discriminated union of both, narrowable via `options.backend`

`maxSteps` is only available on the direct-provider path. ACP-mode bounded execution is upstream-owned.

### ACP Session Continuity

Multiple user prompts on the same conversation share a stable `sessionId`, so `AcpSessionManager` reuses one upstream ACP session instead of spawning a fresh process per message. The plumbing path is: `app.ts` → `WebConnector` → `TaskRunner` → `AcpRuntime` → `AcpAdapter` → `AcpSessionManager.acquire(sessionId)`. REST `/api/chat` callers get one-off sessions (no sessionId supplied).

Bounded agentic execution (internal multi-round tool-calling loops) is upstream-owned by the provider CLI in ACP mode. drmclaw injects skills, forwards policy controls, and normalizes the resulting event stream.

### Test Suite

All tests run via `pnpm test` with no external dependencies (no real LLM provider needed):

| Test file | Coverage area |
|---|---|
| `bounded-agentic.test.ts` | Event translation, bounded tool-calling loop, adapter events |
| `acp-session.test.ts` | ACP session lifecycle, process spawn/reuse, PID identity, delegate swap, crash-recovery exit-handler race guard, discoverModels MCP server forwarding |
| `acp-permission.test.ts` | Three-mode permission control (approve-all, approve-reads, deny-all), runtime policy override, `onToolCall` callback, adapter wiring, ACP protocol correctness |
| `acp-subprocess.test.ts` | ACP subprocess management |
| `session-continuity.test.ts` | Session reuse across multiple prompts |
| `runner.test.ts` | Task runner orchestration, system prompt assembly |
| `runtime.test.ts` | AgentRuntime backend selection, policy forwarding, skill injection |
| `config.test.ts` | Zod-validated config, provider resolution, model override precedence, `githubCopilot.defaultModel`, `mcpServers` schema validation, `.local` config file discovery |
| `skills-loader.test.ts` | Skill discovery, path containment, bounded scan |
| `skills-prompt.test.ts` | Skill prompt formatting for system prompt |
| `executor.test.ts` | Task execution and queue integration |
| `queue.test.ts` | Task queue: concurrency, bounded overflow, graceful drain |
| `integration.test.ts` | End-to-end composed runtime paths, prompt round-trip, `/ready` endpoint (200/503 states) |
| `event-store.test.ts` | JSONL event store, persistence, WebSocket broadcasting |
| `delivery-queue.test.ts` | Delivery queue: write-ahead enqueue, two-phase ack, fail/retry, crash recovery, concurrent operations |
| `debug-display-utils.test.ts` | Developer console display grouping: stream/thinking collapse, toolCallId-based tool-call grouping, interleaved parallel tool events |
| `ui-build.test.ts` | UI production build: correct asset paths, no duplicate CSS, all referenced assets exist |
| `ws-message-filtering.test.ts` | WebSocket message gating: task-scoped event filtering, stale-result acknowledgment |
| `execute-task.test.ts` | Task executor: config loading via `loadDrMClawConfig`, runtime chain composition, in-memory event collection, policy forwarding, skill allowlist filtering (effective skills assertion), config-driven skill precedence over request skills, additive merge for unique request skills, config overrides, provider/model metadata, adapter dispose cleanup, timeout abort with real ACP disposal, output truncation, failure-evidence preservation, structured error boundary (config failure, skill failure, adapter creation failure), post-timeout event snapshot stability, no durable persistence (in-memory only) |
| `execute-skill-action.test.ts` | Structured skill-action executor: resolver and action-contract preflight validation (`SKILL_ROOT_MISSING`, `SKILL_NOT_FOUND`, `SKILL_NOT_READY`, `ACTION_NOT_FOUND`, `MISSING_REQUIRED_INPUT`, `UNKNOWN_INPUT`), fail-closed allowlist contract, prompt synthesis determinism, default application for declared inputs, falsy-but-present required-input handling, `actionValidationErrors` population on non-resolver codes with the invariant `validationErrors == (skillResolutionErrors ?? []) ++ (actionValidationErrors ?? [])` |
| `build-execute-skill-action-request.test.ts` | `buildExecuteSkillActionRequest` request shaper: verbatim skill/action/inputs copy, `policy.skillAllowlist` default to `[spec.skill]`, explicit allowlist passthrough (including empty / target-excluding), `permissionMode` passthrough and omission, `timeoutMs` / `maxOutputChars` / `workingDir` / `skillDirs` passthrough, `inputs` omission (no `{}` injection), input-spec isolation from returned-request mutation |
| `entrypoint.test.ts` | Source-barrel regression: `"."` barrel symbols (factory functions, classes, task executor), `"./sdk"` barrel symbols (types, utilities), `"./connectors"` barrel symbols (connector classes, registry), removed-export regression guards (`createLLMAdapter`, `AcpSessionManager`, `evaluatePermission` must not be exported). Built-package surface (dist-gated, runs after `pnpm build`): exercises the real `dist/index.js`, `dist/sdk.js`, `dist/connectors.js` entrypoints declared in package.json `exports`; skipped when dist/ is absent so `pnpm test` stays build-free. |

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
│   ├── config/                 # Zod schema + native config loader
│   ├── skills/                 # Multi-directory skill discovery + SKILL.md parsing
│   ├── llm/                    # LLM adapter interface + ACP adapter
│   ├── runtime/                # Agent runtime: orchestration, policies
│   ├── runner/                 # Task execution, system prompt assembly, queue, chunker
│   ├── scheduler/              # Cron service, timer loop, job store
│   ├── connectors/             # Connector interface + web connector
│   ├── delivery/               # Write-ahead delivery queue for outbound messages
│   ├── events/                 # Typed lifecycle events, JSONL event store
│   └── server/                 # Hono app, REST routes, WebSocket handler
├── skills/                     # Bundled system skills (hello)
├── docs/examples/skills/       # Example skills (workspace-analyst, file-ops)
├── ui/                         # Developer console (esbuild + React + Tailwind, workspace member)
├── package.json                # Single published package with subpath exports
├── pnpm-workspace.yaml         # Workspace: root + ui/
├── tsconfig.json
├── vitest.config.ts
├── biome.json
└── drmclaw.config.example.ts   # Example configuration
```

## Conventions

- All source code is in `src/` with TypeScript strict mode and ESM modules.
- Skills use the `SKILL.md` frontmatter format (parsed with `gray-matter`).
- Configuration files follow the `drmclaw.config.{ts,json}` pattern. Local overrides use `.local` suffix (gitignored by default).
- Tests live next to the code they test or in a top-level `test/` directory.
- The repo publishes one npm package (`drmclaw-core`) with subpath exports (`drmclaw-core/sdk`, `drmclaw-core/connectors`). `ui/` is a workspace member for development but is not published separately.

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
git clone https://github.com/drmclaw/drmclaw-core.git
cd drmclaw-core

# Install dependencies
pnpm install

# Copy and edit config
cp drmclaw.config.example.ts drmclaw.config.ts

# Start in development mode (backend + UI dev server)
pnpm dev
```

`pnpm dev` starts both the backend server (port 3000) and the UI dev server (port 5173) concurrently. Open `http://localhost:5173` for the developer console with live-reload on save. The UI dev server uses esbuild for JS/TSX bundling and Tailwind CLI for CSS compilation, then proxies `/api` and `/ws` requests to the backend. Live-reload is SSE-based: esbuild's `onEnd` plugin and a Tailwind output watcher push rebuild notifications to the browser, which triggers an automatic page refresh. Both dev and production use the same root-relative asset paths (`/main.js`, `/index.css`) — the dev server maps these to `ui/dist/` on disk, and the backend's `serveStatic` serves `ui/dist/` as the web root. The dev server works reliably in non-TTY environments (background processes, CI, Docker containers).

For production, build the UI first (`pnpm --filter drmclaw-ui build`), then run `pnpm start` — the backend serves the built UI from `ui/dist/` at port 3000.

The developer console is a 2-column debug view: **User Chat** (left — conversation with the assistant) and **Events** (right — unified timeline of all runtime events in sequence order). The Events column shows lifecycle transitions, tool call requests, tool results, LLM stream deltas, thinking chunks, execution plans, and token usage in a single chronological timeline with color-coded source badges (`system`, `runtime`, `acp`). Tool-call rounds are grouped with numbered headers and tinted backgrounds; consecutive stream chunks and thinking fragments are collapsed into expandable groups. Events are persisted to `.drmclaw/events/tasks/` as JSONL and replayed on page load. This is an operator/self-host admin surface — product-level UIs are built in separate product repos.

### Prerequisites

- **macOS or Linux** — Windows is not supported at this phase
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