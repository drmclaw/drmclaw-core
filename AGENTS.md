# AGENTS.md — drmclaw-core

> **Read this file in full.** Agents must read the entire AGENTS.md content before starting any work in this repo. Do not skim, skip, or summarize sections. Every section contains binding rules.

## Identity

`drmclaw-core` is a **public, open source** repository.

It is the domain-agnostic AI workflow automation engine for Dr. MClaw.

Repository: `drmclaw-core`
License: Open source
Visibility: Public

## Boundary Rules

This repo contains **only reusable, domain-agnostic** runtime capabilities.

### What belongs here

- Execution engine (task runner, system prompt assembly, sandboxed execution)
- Agent runtime (`AgentRuntime` interface, bounded multi-step execution, policy controls)
- LLM adapter layer (provider abstraction, generic ACP adapter, future direct adapters)
- Skill system (multi-directory skill discovery, `SKILL.md` parsing, skill prompt formatting)
- Connector SDK and base connectors (WebSocket web connector, connector interface)
- Scheduler (cron-based job scheduling, timer loop, job store)
- Task queue (per-user and global lane serialization, concurrency controls)
- Configuration system (Zod-validated config, native `import()` loader)
- Audit and event primitives (typed lifecycle events)
- Storage abstractions (JSON file store, upgradeable to SQLite)
- Workspace bootstrap file support (`AGENTS.md`, `CONTEXT.md` injection)
- Stream chunking and WebSocket delivery
- Bundled system skills and starter examples
- Developer console UI (operator/self-host admin surface, esbuild + React + Tailwind)
- Self-host templates and deployment guides

### What does NOT belong here

- Business-domain-specific workflows, playbooks, or product features
- Billing, metering, or subscription logic
- Productized onboarding or setup flows
- Platform-specific integrations that serve a single business vertical
- Polished end-user product UIs or product API layers (product repos own these)
- Premium or commercial-only connectors

If a capability is reusable across multiple domains, it belongs here.
If it is specific to a single business vertical or product, it belongs in a separate product repo that depends on this core via published packages.

## Agent Guidelines

When working in this repo:

1. **Keep it domain-agnostic.** Do not add code that assumes a specific business vertical (GTM, HR, finance, etc.). Domain-specific features belong in product repos that depend on this core.
2. **Respect the boundary.** If a feature could be reused by any product built on the core, it belongs here. If it only serves one domain, it does not.
3. **Use the established patterns.** Follow the existing module organization (`config/`, `skills/`, `llm/`, `runtime/`, `runner/`, `scheduler/`, `connectors/`, `server/`).
4. **Prefer composition over coupling.** New capabilities should be exposed as interfaces, adapters, or extension points — not hard-wired behaviors.
5. **Test with Vitest.** Run `pnpm test` before submitting changes.
6. **Format with Biome.** Run `pnpm lint` to check formatting and lint rules.
7. **Run commands from the project root.** When this repo is part of a multi-root VS Code workspace, **all terminal commands** (`pnpm test`, `pnpm lint`, `tsc`, etc.) **must execute from the `drmclaw-core` directory**, not the workspace root. Always `cd` into the project directory first, or use an absolute path. Failure to do so causes commands to fail silently or operate on the wrong `package.json`.

   **Background terminals and long-running processes.** Be aware of this specific pitfall when starting servers or watchers from agent tooling:
   - **Backgrounded processes suspend on tty read.** Running a command with `&` inside an interactive (foreground) terminal creates a background job. If that job reads from stdin, the OS sends `SIGTTIN` and suspends it (`suspended (tty input)`). To avoid this: use the tool's native background-process support (which gives the process its own pty), or redirect stdin explicitly (`cmd </dev/null &`), or avoid manual `&` altogether.
8. **Keep committed code environment-neutral.** The repo should work for any contributor on any machine. Do not commit:
   - Absolute paths tied to a specific machine (`/Users/…`, `/home/…`, `C:\Users\…`)
   - Real credentials, API keys, tokens, or passwords (use placeholders like `sk-your-key-here` in examples)
   - Hostnames or URLs pointing to private infrastructure
   - Values that vary per deployment belong in `drmclaw.config.local.ts` (gitignored), environment variables, or example config with placeholder values.
9. **No debug code in committed files.** Code merged to the repo must be production-ready:
   - No `debugger` statements
   - No `console.log` / `console.debug` / `console.warn` used for ad-hoc debugging (structured operational logging with a `[drmclaw]` prefix in `cli.ts` and CLI output in `skills/cli.ts` are fine)
   - No commented-out code blocks left behind from development
   - No `// @ts-ignore` or `// @ts-expect-error` without a comment explaining why
   - `TODO` / `FIXME` comments are allowed only when they describe a genuine backlog item with enough context for a future contributor to act on them — not as markers for half-finished or known-broken code

## Implement → Review → Enhance Loop

Before closing any implementation effort, agents **must** perform a self-review pass and iterate until the work is actually clean, not merely "green enough".

The preferred workflow in this workspace is to use the shared custom agents `Implement and Review` and `Code Review`. Those agents handle the implementation and review handoff automatically, but they still need to satisfy this repo's review criteria and completion gate.

These shared custom agents are optional workflow helpers, not a hard requirement for contributing. Some developers or tools may not load workspace custom agents, may not have the same VS Code customization setup, or may work outside this workspace layout. In those cases, follow the same review criteria and completion gate manually.

Whether the review is manual or done through the shared workspace agents, it must be a distinct step from CI and must produce a visible written review artifact before the task is considered done.

At minimum, the review must check:

- **Design fit**: Does the change belong in `drmclaw-core`, stay domain-agnostic, and preserve existing module boundaries?
- **README alignment**: Does the implementation still match the promises, architecture, public surface, and operational model described in `README.md`?
- **README decision**: If implementation and `README.md` diverge, decide explicitly which is wrong and update code or docs so they agree in the same change.
- **Protocol fidelity**: Do request/response shapes match upstream SDK or protocol schema exactly? Prefer importing real ACP or SDK types over recreating protocol objects by hand.
- **Boundary correctness**: Are tests exercising the real seam under discussion?
- **Test isolation**: Tests must not duplicate production decision logic in local helpers and must probe adversarial as well as happy-path inputs.
- **Type coverage**: Are all changed files type-checked, including surfaces excluded from the root TypeScript program?
- **Diagnostic cleanliness**: Changed files must be warning-free in the editor.
- **CI robustness**: Avoid hardcoded ports, temp paths, clock-sensitive sleeps, race-prone cleanup, and hidden environment assumptions.
- **Regression surface**: Check adjacent behavior, public exports, config examples, and docs when runtime wiring or public workflows change.
- **Test ↔ README sync**: When key test coverage changes, update `README.md` accordingly.

If the active workflow expects a review block, it must be emitted as a visible artifact. Silent "looks fine" reviews do not count.

After review, fix every substantive finding and re-review until the result is actually clean.

### Completion Gate

Do **not** mark the task complete until all of the following are true:

1. The implementation satisfies the intended design, not just the immediate test case.
2. `pnpm test` is green.
3. `pnpm lint` is green.
4. `tsc --noEmit` is green for the relevant surface, or an equivalent additional typecheck/diagnostic pass covers files excluded from the root TypeScript program.
5. Changed files are warning-free in the editor.
6. `README.md` and the implementation agree on the shipped behavior, architecture, and public contract.
7. The final self-review produced a visible findings block with zero unresolved findings.
8. If key test cases were added, removed, or substantially changed, `README.md` test-related sections have been updated to reflect the current test landscape.

“Build passes” is necessary but insufficient. The bar is: no protocol drift, no hidden diagnostics, no shallow tests, no stale README claims, and no unresolved review concerns.
