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

Today, the most actively shaped path is the Codex App Server task-execution runtime exposed through `executeSkillAction()` (structured action surface) and `executeTask()` (lower-level prompt-first escape hatch). Other surfaces in the repo may continue to change as the architecture is simplified and clarified.

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
│  │  │ Codex App Server over stdio JSON-RPC      │  │
│  │  └───────────────────────────────────────────┘  │
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
- **LLM Adapter Layer** — A Codex App Server adapter that spawns `codex app-server` over stdio JSON-RPC for each execution. It performs `initialize` → `initialized` → `thread/start` → `turn/start`, maps App Server notifications into structured `AdapterEvent`s (`text`, `tool_call`, `tool_result`, `thinking`, `plan`, `usage`), and disposes the child process when the run finishes or times out.
- **Agent Runtime** — Codex-backed orchestration of skills, tools, policies, and workflow state. Codex owns the bounded tool-calling loop; drmclaw lists skills with file paths in the system prompt, forwards cwd/model/approval/sandbox controls, and normalizes lifecycle events.
- **Task Runner** — Orchestrates each task run: assembles structured system prompts (Tooling → Safety → Skills → Workspace → Runtime → Time), invokes the Codex runtime, collects lifecycle events, and returns structured results. The task runner does not run the tool-calling loop itself — that is Codex App Server's responsibility.
- **Task Queue** — Per-user and global lane serialization with configurable concurrency caps and bounded queue size (`maxQueueSize`, default 50). Rejects new tasks with an error when the queue is full. Supports graceful drain on shutdown. Prevents session races and upstream rate limits.
- **Scheduler** — Cron-based job scheduling using `croner`. Jobs stored in JSON with atomic writes. Supports missed-job detection, concurrency limits, and timezone awareness.
- **Connectors** — Minimal interface (`onMessage`, `sendMessage`, `sendTaskStatus`) for receiving prompts and delivering results. Ships with a WebSocket-based web connector; additional connectors (Slack, Teams, etc.) implement the same interface.
- **HTTP + WebSocket Server** — Built on Hono. REST API for chat, tasks, skills, and job management. A `/ready` endpoint returns `503` while the server is still initializing and `200` once fully operational (suitable for container health probes and load balancers). WebSocket for real-time streaming with code-fence-aware chunking. Graceful shutdown on `SIGINT`/`SIGTERM`: drains in-flight tasks, rejects new work, then exits cleanly.
- **Audit & Events** — Typed lifecycle events (`start`, `end`, `error`) emitted during task execution. Full execution records for review, compliance, and process optimization.
- **Delivery Queue** — Write-ahead file-backed queue for reliable outbound delivery. Entries are persisted to disk before delivery is attempted, ensuring crash recovery. Two-phase atomic ack (rename then unlink), exponential backoff retry, and startup recovery of pending entries. Generic payload type — connectors deliver any shape.
- **Task Executor** — Downstream-facing execution surface for product repos, exposed as two complementary entry points. `executeSkillAction` is the preferred structured surface: products pass an `ExecuteSkillActionRequest` (`{ skill, action, inputs, policy, skillDirs, workingDir, ... }`) that names a specific action declared in a skill's `SKILL.md` frontmatter. Core performs structured preflight validation — skill existence, action existence, required inputs, unknown inputs — before assembling any runtime, synthesizes the agent prompt internally from the structured descriptor, and returns an `ExecuteSkillActionResult` carrying `validationErrors` (codes: `SKILL_ROOT_MISSING`, `SKILL_NOT_FOUND`, `SKILL_NOT_READY`, `ACTION_NOT_FOUND`, `MISSING_REQUIRED_INPUT`, `UNKNOWN_INPUT`) and `skillResolutionErrors` (the resolver-code subset) alongside the agent's output. `ExecuteSkillActionResult` also exposes `actionValidationErrors`, the non-resolver preflight subset containing `ACTION_NOT_FOUND`, `MISSING_REQUIRED_INPUT`, and `UNKNOWN_INPUT` — the symmetric counterpart to `skillResolutionErrors`, so downstream callers do not need to reclassify codes. For request shaping, `buildExecuteSkillActionRequest(spec)` maps a domain-agnostic `SkillActionCallSpec` (`skill`, `action`, `inputs`, plus environment fields `workingDir`, `skillDirs`, `timeoutMs`, `maxOutputChars`, `permissionMode`, `skillAllowlist`) to an `ExecuteSkillActionRequest`, defaulting `policy.skillAllowlist` to `[spec.skill]` when the caller omits one; it is exported from both `drmclaw-core` and `drmclaw-core/sdk`. `executeTask` remains supported as the lower-level prompt-first escape hatch for flexible or unstructured invocations. Both surfaces run over the same engine — core loads the real drmclaw-core config file, merges request-level overrides on top, then composes `createLLMAdapter` → `createAgentRuntime` → `TaskRunner` using Codex App Server. Types are domain-agnostic, and setup failures are returned as structured `status: "error"` results.

  **Runtime path:** Task execution traverses the same `AgentRuntime` → `TaskRunner` infrastructure used by all other execution paths in the engine. Products pass either a structured action descriptor or a prompt + policy — no subprocess wiring leaks to the product. Skills are loaded from the resolved config first; `request.skillDirs` is merged additively with deduplication. The `TaskRunner` generates a UUID task ID, assembles the system prompt, invokes `CodexRuntime`, collects lifecycle events, and returns a `TaskRecord`. Products can pass an `onEvent` callback to observe runtime events during execution. Optional `timeoutMs` and `maxOutputChars` guardrails are available for constrained runs. Timeout triggers real Codex adapter disposal so the subprocess is torn down, and the returned events array is a stable snapshot immune to post-timeout mutation. The result includes `provider` and `requestedModel` fields.

  **Execution history:** Both `executeSkillAction` and `executeTask` return an in-memory event snapshot and, by default, persist run history under `dataDir/runs/<taskId>/`. Each run stores `metadata.json` plus `events.jsonl`, including provider/model/reasoning metadata, prompt/output/error previews, event counts, and skill/action metadata when applicable. Disable this with `executionHistory.enabled: false`.

  **Constrained policy surface:** `ExecuteTaskRequest.policy` and `ExecuteSkillActionRequest.policy` intentionally expose only `permissionMode` and `skillAllowlist`. Fine-grained Codex approval/sandbox behavior is configured under `llm.codex`.

  **Fail-closed skill scope:** When a request declares a non-empty `policy.skillAllowlist`, the allowlist is treated as a contract, not a hint. Before any runtime is assembled, core merges config-driven skills with `request.skillDirs`, applies the allowlist, and validates the declared scope. An allowlisted skill is satisfied iff it is present in the **merged** skill set (config-driven skills merged with skills loaded from request roots). The merge prefers the config-declared copy on duplicate name, so a request root cannot override a config-declared skill of the same name; readiness is checked against the merged copy. The three error codes are evaluated in strict precedence order, and a single request returns errors of **exactly one class** (multiple errors of the same class are allowed — e.g. two missing names produce two `SKILL_NOT_FOUND` errors — but classes are never mixed):

  - `SKILL_ROOT_MISSING` — one or more entries in `request.skillDirs` do not exist on disk or are not directories. Wins outright: the resolver short-circuits, reports every failing path on a single error (via the `skillDirs` field), and does not go on to ask "was the allowlisted skill found?", because the ground truth for that question (the missing directory) is unavailable.
  - `SKILL_NOT_FOUND` — every declared root was readable, but one or more allowlisted names are absent from the merged skill set. Emitted per missing name. Wins over `SKILL_NOT_READY`: readiness is not checked for skills that happen to be present when any allowlisted name is missing.
  - `SKILL_NOT_READY` — every allowlisted skill was discovered but at least one's declared `requires` are unmet. Emitted per unready skill, carrying `missingRequires`.

  When any of these codes is raised, both `executeSkillAction` and `executeTask` return `status: "error"` immediately — no Codex subprocess is spawned. The structured reason is returned as `result.skillResolutionErrors: SkillResolutionError[]` alongside the formatted `error` string. Requests that omit `skillAllowlist` continue to run with whatever skills were discovered; the fail-closed contract applies only when the caller has explicitly scoped execution.

  **Action-contract preflight (`executeSkillAction` only):** The structured surface extends fail-closed evaluation to additional preflight codes that guard the declared action contract — `ACTION_NOT_FOUND` (the named action is not declared in the resolved skill's `SKILL.md` frontmatter), `MISSING_REQUIRED_INPUT` (a required `SkillActionInput` was omitted from `request.inputs`), and `UNKNOWN_INPUT` (`request.inputs` carries a key the action does not declare). These codes land on `result.validationErrors` alongside the resolver codes (which are also mirrored there), and like the resolver codes they are evaluated before runtime assembly and fail closed: no Codex subprocess is spawned.

## What Lives Here

The public core includes:

- task runner and execution model,
- scheduling primitives,
- Codex App Server adapter and LLM adapter interfaces,
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

This contract is still evolving. The Codex App Server task-execution path is the current priority surface. Other exported or documented surfaces may change as the codebase is simplified or the architecture is clarified.

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
| `CronService`, `ExecutionHistoryJsonlStore`, `FileDeliveryQueue` | Infrastructure services |
| `listExecutionRuns`, `readExecutionRun`, `buildExecutionTranscript`, `buildExecutionTimeline`, `summarizeExecutionEvents` | Generic execution-history APIs for product UIs |
| `WebConnector` | WebSocket connector |
| All exported `type` declarations | Type contracts for custom adapters, runtimes, connectors |

**Internal — not exported, implementation details:**

| Symbol | Reason |
|---|---|
| `createLLMAdapter` | Internal factory; composed by `executeSkillAction` / `executeTask` and CLI bootstrap, products don't need it |

Products that need to execute skills should prefer `executeSkillAction()` — the structured action surface that declares `{ skill, action, inputs }` against the action catalog declared in `SKILL.md` frontmatter. `executeTask()` remains supported as the prompt-first escape hatch for flexible or unstructured invocations. Products that need to customize the runtime should use `createAgentRuntime()` + `TaskRunner`. Lower-level symbols are internal and may change without notice.

## Tech Stack

| Layer | Technology | Rationale |
|---|---|---|
| Language | TypeScript (strict, ESM) | Type safety, ecosystem breadth |
| Runtime | Node.js 22+ | LTS, native ESM, modern APIs |
| HTTP + WebSocket | Hono + @hono/node-ws | Lightweight, TypeScript-native |
| LLM (MVP) | Codex App Server over stdio JSON-RPC | Local Codex execution with auth, tools, streamed events, and conversation primitives |
| Agent runtime | CodexRuntime | Skills/policy orchestration; Codex App Server owns the bounded tool loop |
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
- **`llm`** — Codex App Server command/args, optional runtime `model`, approval policy, sandbox mode, legacy permission mode (`approve-all`/`approve-reads`/`deny-all`), retry policy, failover chain, and `excludeModels` glob patterns for blocking unwanted model selection.
- **`dataDir`** — Directory for runtime data (event logs, job store). Defaults to `.drmclaw`.

### Provider Model

Codex App Server is the only supported LLM runtime in this MVP. Core spawns `codex app-server` over stdio for each execution, performs the App Server JSON-RPC handshake, sends the assembled system prompt as `developerInstructions`, sends the user prompt as a text input, streams App Server notifications into drmclaw runtime events, then disposes the process.

```ts
llm: {
	provider: "codex-app-server",
	model: "gpt-5.5", // optional; omit to use the user's Codex default
	reasoningEffort: "high", // optional; omit to use the user's Codex default
	codex: {
		command: "codex",
		args: ["app-server"],
		approvalPolicy: "never",
		sandbox: "danger-full-access",
	},
	permissionMode: "approve-all",
	excludeModels: ["experimental-*"],
}
```

`resolveCodexAppServerCommandArgs(config.llm.codex)` returns `{ command, args }` ready for `spawn()`. `llm.model` is passed on App Server `thread/start` and `turn/start`; `llm.reasoningEffort` is passed as `turn/start.effort`. No `--model` or reasoning CLI argument is appended by drmclaw.

#### Runtime Model Switching

The active model can be changed at runtime via the developer console UI or the REST API without restarting the server:

- `GET /api/model` — returns `{ model: string | null }`
- `GET /api/models` — returns the configured model when one is set.
- `PUT /api/model` — accepts `{ model: string }`, returns `{ model: string }`
- `GET /api/ready` — returns `{ status: "ready" | "starting", uptime }` with HTTP 200 (ready) or 503 (starting). Suitable for container health probes and load balancer checks.

Because App Server processes are spawned per execution, model changes affect subsequent runs.
- **`workspace`** — Optional directory with bootstrap files (`AGENTS.md`, `CONTEXT.md`) injected into the system prompt. Per-file injection cap (default 20KB).
- **`scheduler`** — Enable/disable, inline job definitions or path to `jobs.json`.
- **`taskHistory`** — Retention period, max entries, disk budget.

Local overrides use a `.local` suffix (e.g. `drmclaw.config.local.ts`) which is gitignored by default.

### Execution Policy

Codex App Server owns the tool-calling loop. drmclaw exposes a constrained policy surface for product callers:

| Field                | Type       | Purpose                                     |
| -------------------- | ---------- | ------------------------------------------- |
| `permissionMode`     | `"approve-all" \| "approve-reads" \| "deny-all"` | High-level legacy alias; the trusted MVP config maps approve-all to Codex `approvalPolicy: "never"` and `sandbox: "danger-full-access"` |
| `skillAllowlist`     | `string[]` | Skill names the agent may use                |
| `filePatterns`       | `string[]` | File path patterns for read/write access     |
| `commandAllowlist`   | `string[]` | Shell commands allowed for execution         |

`CodexRuntimeOptions` uses `backend: "codex"`. `sessionId` is still accepted by the runner/connector contract for caller continuity, but the MVP adapter starts an ephemeral Codex thread per execution.

Bounded agentic execution is upstream-owned by Codex App Server. drmclaw injects skills, forwards prompt/model/reasoning/cwd/approval/sandbox controls, and normalizes the resulting event stream.

### Test Suite

All tests run via `pnpm test` with no external dependencies (no real LLM provider needed):

| Test file | Coverage area |
|---|---|
| `codex-app-server.test.ts` | Codex App Server JSONL handshake, prompt shape, event mapping, failed turns, process disposal |
| `session-continuity.test.ts` | Session reuse across multiple prompts |
| `runner.test.ts` | Task runner orchestration, system prompt assembly |
| `runtime.test.ts` | AgentRuntime backend selection, policy forwarding, skill injection |
| `config.test.ts` | Zod-validated config, Codex command resolution, model setting, `.local` config file discovery |
| `skills-loader.test.ts` | Skill discovery, path containment, bounded scan |
| `skills-prompt.test.ts` | Skill prompt formatting for system prompt |
| `executor.test.ts` | Task execution and queue integration |
| `queue.test.ts` | Task queue: concurrency, bounded overflow, graceful drain |
| `integration.test.ts` | End-to-end composed runtime paths, prompt round-trip, `/ready` endpoint (200/503 states) |
| `event-store.test.ts` | Execution history store, run metadata, event replay, transcript and event-summary helpers |
| `delivery-queue.test.ts` | Delivery queue: write-ahead enqueue, two-phase ack, fail/retry, crash recovery, concurrent operations |
| `debug-display-utils.test.ts` | Developer console display grouping: stream/thinking collapse, toolCallId-based tool-call grouping, interleaved parallel tool events |
| `ui-build.test.ts` | UI production build: correct asset paths, no duplicate CSS, all referenced assets exist |
| `ws-message-filtering.test.ts` | WebSocket message gating: task-scoped event filtering, stale-result acknowledgment |
| `execute-task.test.ts` | Task executor: config loading via `loadDrMClawConfig`, runtime chain composition, event collection and default run-history persistence, policy forwarding, skill allowlist filtering (effective skills assertion), config-driven skill precedence over request skills, additive merge for unique request skills, config overrides, provider/model metadata, adapter dispose cleanup, timeout abort with real Codex disposal, output truncation, failure-evidence preservation, structured error boundary (config failure, skill failure, adapter creation failure), post-timeout event snapshot stability, and no-history preflight failures |
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
│   ├── llm/                    # LLM adapter interface + Codex App Server adapter
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

The developer console is a 2-column debug view: **User Chat** (left — conversation with the assistant) and **Events** (right — unified timeline of all runtime events in sequence order). The Events column shows lifecycle transitions, tool call requests, tool results, LLM stream deltas, thinking chunks, execution plans, and token usage in a single chronological timeline with color-coded source badges (`system`, `runtime`, `codex`). Tool-call rounds are grouped with numbered headers and tinted backgrounds; consecutive stream chunks and thinking fragments are collapsed into expandable groups. Runs are persisted to `.drmclaw/runs/<taskId>/` and replayed on page load. This is an operator/self-host admin surface — product-level UIs are built in separate product repos.

### Prerequisites

- **macOS or Linux** — Windows is not supported at this phase
- Node.js 22+
- pnpm
- Codex CLI installed and logged in (`codex login status` should report an authenticated account)

## Long-Term Role

This repo is the stable platform layer for:

- community and developer adoption,
- self-hosted experimentation,
- ecosystem building,
- domain-specific workflow products built on a shared runtime.

Product layers built on top of the core can evolve quickly, but the core itself must stay understandable, modular, and extensible.
