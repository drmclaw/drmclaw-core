# AGENTS.md — drmclaw-core

## Identity

Public, open-source, domain-agnostic AI workflow automation engine for Dr. MClaw.

## Boundary

**Belongs here:** execution engine, agent runtime, LLM adapter layer, skill system (discovery + parsing), connector SDK, scheduler, task queue, configuration system, audit/event primitives, storage abstractions, workspace bootstrap (`AGENTS.md`/`CONTEXT.md` injection), stream chunking, developer console UI, self-host templates.

**Does not belong here:** business-domain workflows, billing/metering, productized onboarding, single-vertical integrations, polished end-user product UIs, commercial-only connectors.

**Decision rule:** reusable across domains → here. Single product or vertical → product repo.

## Stability

Breaking changes are acceptable when they materially improve architecture or simplify the public surface. When breaking, update `README.md` in the same change and state it plainly in the summary.

## Commands

All commands run from the `drmclaw-core` directory. Requires Node ≥ 22. macOS/Linux only.

| Command | Purpose |
|---|---|
| `pnpm test` | Run all tests (Vitest) |
| `pnpm lint` | Check formatting + lint (Biome) |
| `pnpm lint:fix` | Auto-fix lint/formatting |
| `pnpm check` | Typecheck (`tsc --noEmit -p tsconfig.check.json`) |
| `pnpm build` | Production build |
| `pnpm dev` | Dev server + UI watch mode |

## Guidelines

1. Keep it domain-agnostic — no business-vertical assumptions.
2. Follow existing module layout (`config/`, `skills/`, `llm/`, `runtime/`, `runner/`, `scheduler/`, `connectors/`, `server/`, `delivery/`, `events/`).
3. Prefer composition: interfaces, adapters, extension points — not hard-wired behaviors.
4. No committed credentials, absolute paths, private hostnames, or debug artifacts (`debugger`, ad-hoc `console.log`, commented-out blocks, unexplained `@ts-ignore`).
5. `TODO`/`FIXME` only for genuine backlog items with enough context to act on.
6. Environment-specific values go in `drmclaw.config.local.ts` (gitignored) or env vars.
7. Run commands from the project root, not the workspace root. Background processes: use native async support or `</dev/null &` — bare `&` in an interactive terminal suspends on tty read.

## Review Dimensions

- **Design fit** — belongs here, stays domain-agnostic, preserves module boundaries.
- **README alignment** — implementation matches `README.md`; divergence resolved explicitly in the same change.
- **Protocol fidelity** — request/response shapes match upstream SDK/protocol schema; prefer imported types over hand-rolled objects.
- **Boundary correctness** — tests exercise the real seam under discussion.
- **Test isolation** — no duplicated production logic in test helpers; adversarial + happy-path coverage.
- **Type coverage** — all changed files type-checked, including surfaces outside the root TS program.
- **Diagnostic cleanliness** — changed files warning-free in the editor.
- **CI robustness** — no hardcoded ports, temp paths, clock-sensitive sleeps, race-prone cleanup, or hidden env assumptions.
- **Regression surface** — adjacent behavior, public exports, config examples, and docs checked when runtime wiring or public workflows change.
- **Test ↔ README sync** — key test coverage changes reflected in `README.md`.

## Completion Gate

1. `pnpm test` green.
2. `pnpm lint` green.
3. `pnpm check` green.
4. Changed files warning-free in the editor.
5. `README.md` and implementation agree on shipped behavior and contract.
6. Review produced a visible findings artifact on the latest state; every material finding addressed.
