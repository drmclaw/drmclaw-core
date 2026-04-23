import { tmpdir } from "node:os";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { configSchema } from "../src/config/schema.js";
import type { PersistedRuntimeEvent } from "../src/events/types.js";
import type { TaskResult } from "../src/runner/types.js";
import type { AgentRuntime, AgentRuntimeOptions, RuntimeEvent } from "../src/runtime/types.js";
import type { SkillEntry } from "../src/skills/types.js";

// ---------------------------------------------------------------------------
// We test executeTask by mocking the LLM + runtime layer so no real ACP CLI
// is needed.  The test verifies that executeTask correctly loads config via
// loadDrMClawConfig, composes the runtime chain, returns structured results
// with provider/model metadata, and disposes adapter resources.
//
// The TaskRunner mock captures the `skills` array passed to its constructor,
// enabling direct assertions on skill filtering, dedup, and allowlist logic.
// ---------------------------------------------------------------------------

// Use vi.hoisted so mock fns are available before vi.mock factory runs
const { mockLoadConfig, mockDispose, mockRuntimeRun, mockLoadSkills, mockLoadSkillsFromDirs } =
	vi.hoisted(() => ({
		mockLoadConfig: vi.fn(),
		mockDispose: vi.fn(),
		mockRuntimeRun: vi.fn<(options: AgentRuntimeOptions) => Promise<TaskResult>>(),
		mockLoadSkills: vi.fn(),
		mockLoadSkillsFromDirs: vi.fn(),
	}));

// Mock config loader — returns schema defaults without filesystem I/O
vi.mock("../src/config/loader.js", () => ({
	loadDrMClawConfig: mockLoadConfig,
}));

// Mock the LLM factory — track dispose calls
vi.mock("../src/llm/index.js", () => ({
	createLLMAdapter: vi.fn(() => ({
		run: vi.fn(),
		dispose: mockDispose,
	})),
}));

// Mock createAgentRuntime to return a controllable runtime
vi.mock("../src/runtime/agent.js", () => ({
	createAgentRuntime: vi.fn(
		(): AgentRuntime => ({
			run: async (options: AgentRuntimeOptions): Promise<TaskResult> => {
				return mockRuntimeRun(options);
			},
		}),
	),
}));

// Mock skills loader — returns empty by default, tests can override
vi.mock("../src/skills/loader.js", () => ({
	loadSkills: mockLoadSkills,
	loadSkillsFromDirs: mockLoadSkillsFromDirs,
}));

import { createLLMAdapter } from "../src/llm/index.js";
import { createAgentRuntime } from "../src/runtime/agent.js";
import { executeTask } from "../src/task/execute.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Skill stub factory — creates a minimal SkillEntry for test assertions. */
function skill(name: string, desc = `${name} skill`, dir = `/${name}`): SkillEntry {
	return {
		name,
		description: desc,
		dir,
		requires: [],
		metadata: {},
		source: dir,
		ready: true,
		missingRequires: [],
	};
}

function simulateSuccessfulRun(output = "Done."): void {
	mockRuntimeRun.mockImplementation(async (options) => {
		const emit = (e: RuntimeEvent) => options.onEvent?.(e);
		emit({ source: "runtime", type: "lifecycle", phase: "start" });
		emit({ source: "runtime", type: "lifecycle", phase: "prompt_sent" });
		emit({ source: "acp", type: "stream", delta: output });
		const result: TaskResult = { status: "completed", output, durationMs: 42 };
		emit({ source: "runtime", type: "lifecycle", phase: "end", result });
		return result;
	});
}

/** Extract the skills that the TaskRunner forwarded to the AgentRuntime. */
function capturedRuntimeSkills(): SkillEntry[] {
	const lastCall = mockRuntimeRun.mock.calls.at(-1);
	return lastCall?.[0]?.skills ?? [];
}

function simulateErrorRun(errorMessage: string): void {
	mockRuntimeRun.mockImplementation(async (options) => {
		const emit = (e: RuntimeEvent) => options.onEvent?.(e);
		emit({ source: "runtime", type: "lifecycle", phase: "start" });
		emit({ source: "runtime", type: "lifecycle", phase: "error", error: errorMessage });
		return { status: "error", output: "", error: errorMessage, durationMs: 10 };
	});
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("executeTask", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		// Default: return schema defaults (no config file loaded)
		mockLoadConfig.mockImplementation(async (overrides?: Record<string, unknown>) => {
			return configSchema.parse(overrides ?? {});
		});
		// Default: no skills discovered
		mockLoadSkills.mockResolvedValue([]);
		mockLoadSkillsFromDirs.mockResolvedValue([]);
	});

	it("composes the LLM-native runtime chain", async () => {
		simulateSuccessfulRun("Hello from ACP");

		const result = await executeTask({
			prompt: "say hello",
		});

		expect(createLLMAdapter).toHaveBeenCalled();
		expect(createAgentRuntime).toHaveBeenCalled();
		expect(result.status).toBe("completed");
		expect(result.output).toBe("Hello from ACP");
		expect(result.taskId).toBeDefined();
		expect(result.durationMs).toBeGreaterThanOrEqual(0);
	});

	it("loads config via loadDrMClawConfig, not schema defaults alone", async () => {
		simulateSuccessfulRun();

		await executeTask({ prompt: "test config loading" });

		expect(mockLoadConfig).toHaveBeenCalled();
	});

	it("passes config overrides to loadDrMClawConfig", async () => {
		simulateSuccessfulRun();

		await executeTask({
			prompt: "with overrides",
			config: {
				llm: { provider: "claude-cli" },
			},
		});

		const overrides = mockLoadConfig.mock.calls.at(-1)?.[0];
		expect(overrides?.llm?.provider).toBe("claude-cli");
	});

	it("merges permissionMode into config overrides", async () => {
		simulateSuccessfulRun();

		await executeTask({
			prompt: "test policy",
			policy: { permissionMode: "deny-all" },
		});

		// The overrides passed to loadDrMClawConfig should have deny-all
		const overrides = mockLoadConfig.mock.calls.at(-1)?.[0];
		expect(overrides?.llm?.permissionMode).toBe("deny-all");
	});

	it("returns provider and requestedModel from resolved config", async () => {
		mockLoadConfig.mockResolvedValue(
			configSchema.parse({ llm: { provider: "claude-cli", model: "claude-sonnet-4.6" } }),
		);
		simulateSuccessfulRun();

		const result = await executeTask({ prompt: "probe" });

		expect(result.provider).toBe("claude-cli");
		expect(result.requestedModel).toBe("claude-sonnet-4.6");
	});

	it("returns persisted events with source tags", async () => {
		simulateSuccessfulRun("task output");

		const result = await executeTask({ prompt: "test events" });

		expect(result.events.length).toBeGreaterThan(0);

		// Must include task_init from the runner
		const initEvent = result.events.find((e) => e.event.type === "task_init");
		expect(initEvent).toBeDefined();
		expect(initEvent?.source).toBe("system");

		// Must include ACP events (stream delta)
		const acpEvents = result.events.filter((e) => e.source === "acp");
		expect(acpEvents.length).toBeGreaterThan(0);

		// Must include runtime lifecycle events
		const lifecycleEvents = result.events.filter(
			(e) => e.source === "runtime" && e.event.type === "lifecycle",
		);
		expect(lifecycleEvents.length).toBeGreaterThan(0);
	});

	it("returns error status when runtime fails", async () => {
		simulateErrorRun("ACP CLI not found");

		const result = await executeTask({ prompt: "fail" });

		expect(result.status).toBe("error");
		expect(result.error).toContain("ACP CLI not found");
	});

	it("disposes adapter after successful execution", async () => {
		simulateSuccessfulRun();

		await executeTask({ prompt: "test dispose" });

		expect(mockDispose).toHaveBeenCalled();
	});

	it("disposes adapter after error execution", async () => {
		simulateErrorRun("boom");

		await executeTask({ prompt: "test dispose on error" });

		expect(mockDispose).toHaveBeenCalled();
	});

	it("truncates output to maxOutputChars", async () => {
		simulateSuccessfulRun("A".repeat(5000));

		const result = await executeTask({
			prompt: "long output",
			maxOutputChars: 100,
		});

		expect(result.output.length).toBe(100);
	});

	it("aborts execution on timeout", async () => {
		mockRuntimeRun.mockImplementation(
			// Simulate a task that takes much longer than the timeout
			() => new Promise((_resolve) => setTimeout(() => {}, 60_000)),
		);

		const result = await executeTask({ prompt: "slow", timeoutMs: 50 });

		expect(result.status).toBe("error");
		expect(result.error).toContain("timed out");
		expect(mockDispose).toHaveBeenCalled();
	});

	it("preserves taskId and durationMs on failure when events exist", async () => {
		mockRuntimeRun.mockImplementation(async (options) => {
			const emit = (e: RuntimeEvent) => options.onEvent?.(e);
			emit({ source: "runtime", type: "lifecycle", phase: "start" });
			// Simulate work happening before the throw
			await new Promise((r) => setTimeout(r, 10));
			throw new Error("mid-execution crash");
		});

		const result = await executeTask({ prompt: "will crash" });

		expect(result.status).toBe("error");
		expect(result.error).toContain("mid-execution crash");
		// Events were collected before the crash — taskId should be present
		expect(result.events.length).toBeGreaterThan(0);
		expect(result.taskId).not.toBe("");
		// Duration should reflect elapsed time, not zero
		expect(result.durationMs).toBeGreaterThan(0);
	});

	it("filters skills by allowlist — asserts effective skills reaching runtime", async () => {
		mockLoadSkills.mockResolvedValue([skill("jira"), skill("git"), skill("slack")]);
		simulateSuccessfulRun();

		const result = await executeTask({
			prompt: "test filter",
			policy: { skillAllowlist: ["jira", "slack"] },
		});

		expect(result.status).toBe("completed");
		const names = capturedRuntimeSkills().map((s) => s.name);
		expect(names).toEqual(["jira", "slack"]);
		expect(names).not.toContain("git");
	});

	it("passes workingDir to the runner", async () => {
		mockRuntimeRun.mockImplementation(async (options) => {
			// Verify workingDir was forwarded
			expect(options.workingDir).toBe("/workspace/project");
			return { status: "completed", output: "ok", durationMs: 1 };
		});

		await executeTask({
			prompt: "in directory",
			workingDir: "/workspace/project",
		});
	});

	it("forwards onEvent callback", async () => {
		simulateSuccessfulRun("streamed");

		const events: RuntimeEvent[] = [];
		await executeTask({ prompt: "stream" }, { onEvent: (e) => events.push(e) });

		expect(events.length).toBeGreaterThan(0);
		const streamEvents = events.filter((e) => e.type === "stream");
		expect(streamEvents.length).toBeGreaterThan(0);
	});

	it("generates unique taskId for each invocation", async () => {
		simulateSuccessfulRun();

		const r1 = await executeTask({ prompt: "first" });
		const r2 = await executeTask({ prompt: "second" });

		expect(r1.taskId).not.toBe(r2.taskId);
	});

	it("rejects empty prompt with structured error", async () => {
		const result = await executeTask({ prompt: "" });

		expect(result.status).toBe("error");
		expect(result.error).toContain("non-empty");
		expect(result.taskId).toBe("");
		expect(result.events).toEqual([]);
		expect(result.provider).toBe("");
	});

	it("rejects whitespace-only prompt", async () => {
		const result = await executeTask({ prompt: "   " });

		expect(result.status).toBe("error");
		expect(result.error).toContain("non-empty");
	});

	// -----------------------------------------------------------------------
	// Skill-loading merge: system + config + request.skillDirs
	// -----------------------------------------------------------------------

	it("loads skills from config (system + config.skills.dirs) by default", async () => {
		mockLoadSkills.mockResolvedValue([skill("sys-probe")]);
		simulateSuccessfulRun();

		await executeTask({ prompt: "uses config skills" });

		expect(mockLoadSkills).toHaveBeenCalled();
		expect(mockLoadSkillsFromDirs).not.toHaveBeenCalled();
		const names = capturedRuntimeSkills().map((s) => s.name);
		expect(names).toEqual(["sys-probe"]);
	});

	it("merges request.skillDirs additively — unique request skills are included", async () => {
		mockLoadSkills.mockResolvedValue([skill("config-skill", "from config")]);
		mockLoadSkillsFromDirs.mockResolvedValue([skill("req-skill", "from request")]);
		simulateSuccessfulRun();

		await executeTask({
			prompt: "merge skills",
			skillDirs: ["/extra/skills"],
		});

		expect(mockLoadSkillsFromDirs).toHaveBeenCalledWith(["/extra/skills"]);
		const names = capturedRuntimeSkills().map((s) => s.name);
		expect(names).toContain("config-skill");
		expect(names).toContain("req-skill");
		expect(names).toHaveLength(2);
	});

	it("deduplicates skills by name — config-driven wins over request-driven", async () => {
		const configVersion = skill("shared", "config version", "/config");
		const requestVersion = skill("shared", "request version", "/request");
		const uniqueRequest = skill("request-only", "unique");
		mockLoadSkills.mockResolvedValue([configVersion, skill("config-only")]);
		mockLoadSkillsFromDirs.mockResolvedValue([requestVersion, uniqueRequest]);
		simulateSuccessfulRun();

		await executeTask({ prompt: "dedup", skillDirs: ["/extra"] });

		const effective = capturedRuntimeSkills();
		const names = effective.map((s) => s.name);
		// All three unique names present
		expect(names).toEqual(expect.arrayContaining(["shared", "config-only", "request-only"]));
		expect(names).toHaveLength(3);
		// The "shared" skill must be the config version, not the request version
		const shared = effective.find((s) => s.name === "shared");
		expect(shared?.description).toBe("config version");
		expect(shared?.dir).toBe("/config");
	});

	it("allowlist + dedup combined — filters after merge", async () => {
		mockLoadSkills.mockResolvedValue([skill("a"), skill("b")]);
		mockLoadSkillsFromDirs.mockResolvedValue([skill("c"), skill("a", "dup")]);
		simulateSuccessfulRun();

		await executeTask({
			prompt: "combined",
			// Use a real existing directory so fs.stat passes the scope-
			// contract check; loadSkillsFromDirs is mocked so no real
			// skills are read from it.
			skillDirs: [tmpdir()],
			policy: { skillAllowlist: ["a", "c"] },
		});

		const names = capturedRuntimeSkills().map((s) => s.name);
		expect(names).toEqual(expect.arrayContaining(["a", "c"]));
		expect(names).not.toContain("b");
		expect(names).toHaveLength(2);
	});

	it("empty skillDirs array does not trigger request-skill loading", async () => {
		mockLoadSkills.mockResolvedValue([skill("core")]);
		simulateSuccessfulRun();

		await executeTask({ prompt: "no extra", skillDirs: [] });

		expect(mockLoadSkillsFromDirs).not.toHaveBeenCalled();
	});

	// -----------------------------------------------------------------------
	// Persistence: events are in-memory only
	// -----------------------------------------------------------------------

	it("events are collected in-memory — no EventStore wired", async () => {
		simulateSuccessfulRun("output");

		const result = await executeTask({ prompt: "check events" });

		// Events are returned in the result but are in-memory snapshots
		expect(result.events.length).toBeGreaterThan(0);
		// Every event has the PersistedRuntimeEvent envelope shape
		for (const e of result.events) {
			expect(e).toHaveProperty("taskId");
			expect(e).toHaveProperty("sequence");
			expect(e).toHaveProperty("timestamp");
			expect(e).toHaveProperty("source");
			expect(e).toHaveProperty("event");
		}
		// taskId is consistent across all events
		const ids = new Set(result.events.map((e) => e.taskId));
		expect(ids.size).toBe(1);
		expect(ids.has(result.taskId)).toBe(true);
	});

	// -----------------------------------------------------------------------
	// Structured error boundary: no promise rejections
	// -----------------------------------------------------------------------

	it("returns structured error when config loading fails", async () => {
		mockLoadConfig.mockRejectedValue(new Error("config file not found"));

		const result = await executeTask({ prompt: "config will fail" });

		expect(result.status).toBe("error");
		expect(result.error).toContain("config file not found");
		expect(result.provider).toBe("");
		expect(result.events).toEqual([]);
		expect(result.durationMs).toBeGreaterThanOrEqual(0);
	});

	it("returns structured error when skill loading fails", async () => {
		mockLoadSkills.mockRejectedValue(new Error("skills dir unreadable"));
		simulateSuccessfulRun();

		const result = await executeTask({ prompt: "skills will fail" });

		expect(result.status).toBe("error");
		expect(result.error).toContain("skills dir unreadable");
	});

	it("returns structured error when createLLMAdapter throws", async () => {
		const { createLLMAdapter: mockedFactory } = await import("../src/llm/index.js");
		(mockedFactory as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
			throw new Error('Embedded provider "claude" is not yet implemented.');
		});
		simulateSuccessfulRun();

		const result = await executeTask({ prompt: "embedded provider" });

		expect(result.status).toBe("error");
		expect(result.error).toContain("not yet implemented");
		// Provider from config is still available since config loaded first
		expect(result.provider).not.toBe("");
	});

	// -----------------------------------------------------------------------
	// Timeout: real cancellation + snapshot stability
	// -----------------------------------------------------------------------

	it("disposes adapter on timeout for real cancellation", async () => {
		mockRuntimeRun.mockImplementation(
			() => new Promise((_resolve) => setTimeout(() => {}, 60_000)),
		);

		const result = await executeTask({ prompt: "slow", timeoutMs: 50 });

		expect(result.status).toBe("error");
		expect(result.error).toContain("timed out");
		// dispose must be called exactly once (by the timeout handler)
		expect(mockDispose).toHaveBeenCalled();
	});

	it("returns stable event snapshot on timeout — no post-timeout mutation", async () => {
		let pushLateEvent: (() => void) | undefined;

		mockRuntimeRun.mockImplementation(async (options) => {
			const emit = (e: RuntimeEvent) => options.onEvent?.(e);
			emit({ source: "runtime", type: "lifecycle", phase: "start" });

			// Store a callback that will try to push events after timeout
			pushLateEvent = () => {
				emit({
					source: "runtime",
					type: "lifecycle",
					phase: "end",
					result: { status: "completed", output: "late", durationMs: 0 },
				});
			};

			// Never resolve — force timeout
			return new Promise((_resolve) => setTimeout(() => {}, 60_000));
		});

		const result = await executeTask({ prompt: "snapshot test", timeoutMs: 50 });
		const eventCountAtReturn = result.events.length;

		// Attempt to push a late event — it should be gated
		pushLateEvent?.();

		// The returned snapshot must not grow
		expect(result.events.length).toBe(eventCountAtReturn);
	});

	it("catches non-Error throw from runtime as structured error", async () => {
		mockRuntimeRun.mockRejectedValue("string-throw");

		const result = await executeTask({ prompt: "string throw" });

		expect(result.status).toBe("error");
		expect(result.error).toBe("string-throw");
	});

	// -----------------------------------------------------------------------
	// Fail-closed skill scope: explicit skillAllowlist is a contract
	// -----------------------------------------------------------------------

	describe("fail-closed skill scope", () => {
		it("returns SKILL_ROOT_MISSING when a request skillDir does not exist on disk", async () => {
			mockLoadSkills.mockResolvedValue([]);
			mockLoadSkillsFromDirs.mockResolvedValue([]);
			simulateSuccessfulRun();

			const ghost = "/definitely/not/a/real/path/drmclaw-ghost";
			const result = await executeTask({
				prompt: "reload tickets",
				skillDirs: [ghost],
				policy: { skillAllowlist: ["jira"] },
			});

			expect(result.status).toBe("error");
			expect(result.error).toMatch(/Skill scope unsatisfied/);
			expect(result.skillResolutionErrors).toBeDefined();
			const rootMissing = result.skillResolutionErrors?.find(
				(e) => e.code === "SKILL_ROOT_MISSING",
			);
			expect(rootMissing).toBeDefined();
			expect(rootMissing?.skillDirs).toEqual([ghost]);
			// Runtime must not have been invoked when scope failed.
			expect(mockRuntimeRun).not.toHaveBeenCalled();
			expect(result.taskId).toBe("");
			expect(result.events).toEqual([]);
		});

		it("does NOT emit SKILL_ROOT_MISSING when skillDir exists but holds a different skill", async () => {
			// Directory is readable, skill discovery just returns a different
			// skill. That's a SKILL_NOT_FOUND, not a root-missing condition.
			mockLoadSkills.mockResolvedValue([]);
			mockLoadSkillsFromDirs.mockResolvedValue([skill("unrelated")]);
			simulateSuccessfulRun();

			const result = await executeTask({
				prompt: "reload tickets",
				skillDirs: [tmpdir()],
				policy: { skillAllowlist: ["jira"] },
			});

			expect(result.status).toBe("error");
			const codes = result.skillResolutionErrors?.map((e) => e.code) ?? [];
			expect(codes).not.toContain("SKILL_ROOT_MISSING");
			expect(codes).toContain("SKILL_NOT_FOUND");
			expect(mockRuntimeRun).not.toHaveBeenCalled();
		});

		it("returns SKILL_NOT_FOUND when an allowlisted skill is missing after discovery", async () => {
			mockLoadSkills.mockResolvedValue([skill("git")]);
			mockLoadSkillsFromDirs.mockResolvedValue([]);
			simulateSuccessfulRun();

			const result = await executeTask({
				prompt: "reload tickets",
				policy: { skillAllowlist: ["jira"] },
			});

			expect(result.status).toBe("error");
			const codes = result.skillResolutionErrors?.map((e) => e.code) ?? [];
			expect(codes).toContain("SKILL_NOT_FOUND");
			expect(result.skillResolutionErrors?.find((e) => e.code === "SKILL_NOT_FOUND")?.skill).toBe(
				"jira",
			);
			expect(mockRuntimeRun).not.toHaveBeenCalled();
		});

		it("returns SKILL_NOT_READY when the allowlisted skill is present but unready", async () => {
			const unreadyJira: SkillEntry = {
				...skill("jira"),
				ready: false,
				missingRequires: ["python3"],
			};
			mockLoadSkills.mockResolvedValue([unreadyJira]);
			simulateSuccessfulRun();

			const result = await executeTask({
				prompt: "reload tickets",
				policy: { skillAllowlist: ["jira"] },
			});

			expect(result.status).toBe("error");
			const notReady = result.skillResolutionErrors?.find((e) => e.code === "SKILL_NOT_READY");
			expect(notReady).toBeDefined();
			expect(notReady?.skill).toBe("jira");
			expect(notReady?.missingRequires).toEqual(["python3"]);
			expect(mockRuntimeRun).not.toHaveBeenCalled();
		});

		it("succeeds when an allowlisted skill is discovered and ready", async () => {
			mockLoadSkills.mockResolvedValue([skill("git")]);
			mockLoadSkillsFromDirs.mockResolvedValue([skill("jira")]);
			simulateSuccessfulRun();

			const result = await executeTask({
				prompt: "reload tickets",
				// Real existing directory: loadSkillsFromDirs is mocked to
				// return the jira skill, so the scope contract is satisfied.
				skillDirs: [tmpdir()],
				policy: { skillAllowlist: ["jira"] },
			});

			expect(result.status).toBe("completed");
			expect(result.skillResolutionErrors).toBeUndefined();
			// Only the allowlisted skill reaches the runtime.
			const names = capturedRuntimeSkills().map((s) => s.name);
			expect(names).toEqual(["jira"]);
		});

		it("does not enforce the scope contract when no allowlist is declared", async () => {
			// Without an allowlist the caller is giving the agent free pick of
			// discovered skills, so missing names or unready skills must not
			// fail closed.
			mockLoadSkills.mockResolvedValue([
				{ ...skill("needs-stuff"), ready: false, missingRequires: ["foo"] },
			]);
			simulateSuccessfulRun();

			const result = await executeTask({ prompt: "anything" });

			expect(result.status).toBe("completed");
			expect(result.skillResolutionErrors).toBeUndefined();
		});

		it("emits SKILL_NOT_FOUND only (no SKILL_NOT_READY) when one allowlisted skill is missing and another is unready", async () => {
			// Precedence end-to-end: SKILL_NOT_FOUND wins over SKILL_NOT_READY
			// for the same request, even though both classes apply per-name.
			const unreadyJira: SkillEntry = {
				...skill("jira"),
				ready: false,
				missingRequires: ["python3"],
			};
			mockLoadSkills.mockResolvedValue([unreadyJira]);
			mockLoadSkillsFromDirs.mockResolvedValue([]);
			simulateSuccessfulRun();

			const result = await executeTask({
				prompt: "reload tickets",
				// Real existing dir so the SKILL_ROOT_MISSING check passes.
				skillDirs: [tmpdir()],
				policy: { skillAllowlist: ["confluence", "jira"] },
			});

			expect(result.status).toBe("error");
			const codes = result.skillResolutionErrors?.map((e) => e.code) ?? [];
			expect(codes.length).toBeGreaterThan(0);
			expect(codes.every((c) => c === "SKILL_NOT_FOUND")).toBe(true);
			expect(codes).not.toContain("SKILL_NOT_READY");
			expect(result.skillResolutionErrors?.find((e) => e.code === "SKILL_NOT_FOUND")?.skill).toBe(
				"confluence",
			);
			expect(mockRuntimeRun).not.toHaveBeenCalled();
		});
	});
});
