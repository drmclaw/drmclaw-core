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
- Developer console UI (operator/self-host admin surface, Vite + React + Tailwind)
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

## Implement → Review → Enhance Loop

Before closing any implementation effort, agents **must** perform a self-review pass and iterate until the work is actually clean, not merely “green enough”. The loop is:

1. **Implement** — Write the code, the narrowest tests that prove it, and any required docs or config updates.
2. **Review** — Switch into reviewer mode and try to disprove the change. This is a **separate todo item** from running CI. It must produce a **written findings list** before any enhancement begins.

   **Required output format.** Before proceeding to step 3, emit a review block in exactly this structure:

   ```
   ## Review Findings

   Walking AGENTS.md criteria against the current state:

   1. **Design fit** — PASS | FINDING: [file:line] [description]
   2. **README alignment** — PASS | FINDING: [file:line] [description]
   3. **Protocol fidelity** — PASS | FINDING: [file:line] [description]
   4. **Boundary correctness** — PASS | FINDING: [file:line] [description]
   5. **Test isolation** — PASS | FINDING: [file:line] [description]
   6. **Type coverage** — PASS | FINDING: [file:line] [description]
   7. **Diagnostic cleanliness** — PASS | FINDING: [file:line] [description]
   8. **CI robustness** — PASS | FINDING: [file:line] [description]
   9. **Regression surface** — PASS | FINDING: [file:line] [description]
   10. **Test ↔ README sync** — PASS | FINDING: [file:line] [description]

   **Total findings: N**
   ```

   If all 10 say PASS, that is a valid review. But the review must exist as a visible artifact — not a silent “I checked and it's fine.”

   Check at minimum:
   - **Design fit**: Does the change belong in `drmclaw-core`, stay domain-agnostic, and preserve existing module boundaries?
   - **README alignment**: Does the implementation still match the promises, architecture, public surface, and operational model described in `README.md`?
   - **README decision**: If implementation and `README.md` diverge, decide explicitly which is wrong:
     - if the code drifted from the intended product contract, adjust the implementation;
     - if the implementation is the new correct direction, update `README.md` in the same change;
     - if both are partially stale, fix both until they agree.
   - **Protocol fidelity**: Do request/response shapes match the upstream SDK or protocol schema exactly? Prefer importing real ACP or SDK types over recreating protocol objects by hand.
   - **Boundary correctness**: Are tests exercising the real seam under discussion? Integration tests should boot the composed app or runtime path, not a re-implemented copy of the logic.
   - **Test isolation**: Tests must not duplicate production decision logic in local helpers. Import the production function, or construct the real object and call the real method. Test inputs must include adversarial shapes that violate the implementation's assumptions — not only idealized sequences that confirm the happy path (see "Happy-path mirror" anti-pattern).
   - **Type coverage**: Are all changed files type-checked? If the root `tsconfig.json` excludes tests, UI, or other changed files, run an additional typecheck or use editor diagnostics so those files are verified too.
   - **Diagnostic cleanliness**: The repo should be clean in the editor. Warnings or schema errors in changed files count as regressions even if `pnpm build` still passes.
   - **CI robustness**: No hardcoded ports, temp paths, clock-sensitive sleeps, race-prone cleanup, or environment assumptions. Prefer OS-assigned resources, deterministic teardown, and explicit timeouts.
   - **Regression surface**: Check adjacent behavior, public exports, config examples, and docs whenever the change touches runtime wiring, package boundaries, or user-facing workflows.
   - **Test ↔ README sync**: When key test cases are added, removed, or substantially changed — especially new test files, renamed test suites, or shifted coverage areas — verify that `README.md` sections referencing test coverage (e.g., "Real-Provider Tests", test file lists, coverage descriptions) are updated to match. A test suite that `README.md` doesn't mention (or still describes with stale names/counts) is a documentation drift.

3. **Enhance** — Fix every finding from step 2, then re-run the review. Repeat until the review yields zero substantive findings.

### Anti-patterns

These are known failure modes. If you catch yourself doing any of these, stop and restart the Review step properly:

- **Collapsing Review into CI.** A todo called “Self-review: tests + lint + tsc” is not a review. Running `pnpm test` is the Completion Gate, not the Review. The Review reads code and produces findings.
- **Skipping the findings list.** If you proceed to Enhance (or to marking the task complete) without emitting the numbered findings block above, the Review did not happen.
- **“PASS” without reading.** Each criterion requires re-reading the relevant file(s). “PASS” means “I read the file and found no issue,” not “I assume it's fine.”
- **Batching Review with other todos.** Review is its own task. It is not a sub-bullet of “Implement” or “Run tests.” Create a separate todo for it.- **Happy-path mirror.** Test data must not be shaped to confirm the algorithm works — it must be shaped to probe where the algorithm breaks. If every test input follows the exact structure the implementation assumes (e.g., contiguous sequences when the real system produces interleaved ones, single-item inputs when production handles batches, synchronous arrival when events race), the tests prove nothing beyond "the code does what the code does." For every behavioral assumption the implementation makes, write at least one test that violates it: out-of-order inputs, interleaved sequences, concurrent/parallel arrivals, missing fields, duplicate entries, and boundary values. Ask: "What real-world input shape would make this algorithm silently wrong?" — then write that test first.
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
