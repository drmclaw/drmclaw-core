import { beforeEach, describe, expect, it, vi } from "vitest";
import { configSchema } from "../src/config/schema.js";
import type { TaskResult } from "../src/runner/types.js";
import type { AgentRuntime, AgentRuntimeOptions, RuntimeEvent } from "../src/runtime/types.js";
import type { SkillAction, SkillActionInput, SkillEntry } from "../src/skills/types.js";

// ---------------------------------------------------------------------------
// Mock the runtime chain layer so no real ACP CLI is needed — same pattern
// as execute-task.test.ts. We care about structured validation behavior
// BEFORE runtime assembly and that the runtime is/isn't called appropriately.
// ---------------------------------------------------------------------------

const { mockLoadConfig, mockDispose, mockRuntimeRun, mockLoadSkills, mockLoadSkillsFromDirs } =
	vi.hoisted(() => ({
		mockLoadConfig: vi.fn(),
		mockDispose: vi.fn(),
		mockRuntimeRun: vi.fn<(options: AgentRuntimeOptions) => Promise<TaskResult>>(),
		mockLoadSkills: vi.fn(),
		mockLoadSkillsFromDirs: vi.fn(),
	}));

vi.mock("../src/config/loader.js", () => ({
	loadDrMClawConfig: mockLoadConfig,
}));

vi.mock("../src/llm/index.js", () => ({
	createLLMAdapter: vi.fn(() => ({
		run: vi.fn(),
		dispose: mockDispose,
	})),
}));

vi.mock("../src/runtime/agent.js", () => ({
	createAgentRuntime: vi.fn(
		(): AgentRuntime => ({
			run: async (options: AgentRuntimeOptions): Promise<TaskResult> => {
				return mockRuntimeRun(options);
			},
		}),
	),
}));

vi.mock("../src/skills/loader.js", () => ({
	loadSkills: mockLoadSkills,
	loadSkillsFromDirs: mockLoadSkillsFromDirs,
}));

import { executeSkillAction } from "../src/task/action.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function skillWith(
	name: string,
	actions: SkillAction[],
	overrides: Partial<SkillEntry> = {},
): SkillEntry {
	return {
		name,
		description: `${name} skill`,
		dir: `/${name}`,
		requires: [],
		metadata: {},
		actions,
		source: `/${name}`,
		ready: true,
		missingRequires: [],
		...overrides,
	};
}

function action(
	name: string,
	inputs: SkillActionInput[] = [],
	overrides: Partial<SkillAction> = {},
): SkillAction {
	return { name, inputs, ...overrides };
}

function simulateSuccessfulRun(output = "Done."): void {
	mockRuntimeRun.mockImplementation(async (options) => {
		const emit = (e: RuntimeEvent) => options.onEvent?.(e);
		emit({ source: "runtime", type: "lifecycle", phase: "start" });
		emit({ source: "acp", type: "stream", delta: output });
		const result: TaskResult = { status: "completed", output, durationMs: 5 };
		emit({ source: "runtime", type: "lifecycle", phase: "end", result });
		return result;
	});
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("executeSkillAction", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockLoadConfig.mockImplementation(async (overrides?: Record<string, unknown>) => {
			return configSchema.parse(overrides ?? {});
		});
		mockLoadSkills.mockResolvedValue([]);
		mockLoadSkillsFromDirs.mockResolvedValue([]);
	});

	it("happy path — runs target action with required inputs", async () => {
		const jira = skillWith("jira", [
			action(
				"create_ticket",
				[
					{ name: "summary", required: true },
					{ name: "description", required: false },
				],
				{ description: "Create a new ticket" },
			),
		]);
		mockLoadSkills.mockResolvedValue([jira]);
		simulateSuccessfulRun("ticket created");

		const result = await executeSkillAction({
			skill: "jira",
			action: "create_ticket",
			inputs: { summary: "fix bug", description: "repro steps" },
		});

		expect(result.status).toBe("completed");
		expect(result.output).toBe("ticket created");
		expect(result.resolvedAction).toEqual({
			skill: "jira",
			action: "create_ticket",
			inputs: { summary: "fix bug", description: "repro steps" },
		});
		expect(result.validationErrors).toBeUndefined();
		expect(mockRuntimeRun).toHaveBeenCalledTimes(1);
		const prompt = mockRuntimeRun.mock.calls[0][0].prompt;
		expect(prompt).toContain("jira.create_ticket");
		expect(prompt).toContain("summary");
		expect(prompt).toContain("fix bug");
		expect(prompt).toContain("Create a new ticket");
	});

	it("SKILL_NOT_FOUND — target skill not discovered, runtime not called", async () => {
		mockLoadSkills.mockResolvedValue([]);
		simulateSuccessfulRun();

		const result = await executeSkillAction({
			skill: "jira",
			action: "create_ticket",
		});

		expect(result.status).toBe("error");
		expect(result.validationErrors).toBeDefined();
		expect(result.validationErrors?.[0].code).toBe("SKILL_NOT_FOUND");
		expect(result.validationErrors?.[0].skill).toBe("jira");
		expect(result.skillResolutionErrors).toBeDefined();
		expect(mockRuntimeRun).not.toHaveBeenCalled();
	});

	it("SKILL_NOT_READY — target skill present but unready, runtime not called", async () => {
		const unready = skillWith("jira", [action("noop")], {
			ready: false,
			missingRequires: ["python3"],
		});
		mockLoadSkills.mockResolvedValue([unready]);
		simulateSuccessfulRun();

		const result = await executeSkillAction({
			skill: "jira",
			action: "noop",
		});

		expect(result.status).toBe("error");
		const codes = result.validationErrors?.map((e) => e.code) ?? [];
		expect(codes).toContain("SKILL_NOT_READY");
		expect(result.validationErrors?.[0].missingRequires).toEqual(["python3"]);
		expect(mockRuntimeRun).not.toHaveBeenCalled();
	});

	it("ACTION_NOT_FOUND — skill ready but action missing from declared actions", async () => {
		const jira = skillWith("jira", [action("create_ticket")]);
		mockLoadSkills.mockResolvedValue([jira]);
		simulateSuccessfulRun();

		const result = await executeSkillAction({
			skill: "jira",
			action: "delete_ticket",
		});

		expect(result.status).toBe("error");
		expect(result.validationErrors?.[0].code).toBe("ACTION_NOT_FOUND");
		expect(result.validationErrors?.[0].skill).toBe("jira");
		expect(result.validationErrors?.[0].action).toBe("delete_ticket");
		expect(mockRuntimeRun).not.toHaveBeenCalled();
	});

	it("MISSING_REQUIRED_INPUT — required input omitted, runtime not called", async () => {
		const jira = skillWith("jira", [
			action("create_ticket", [{ name: "summary", required: true }]),
		]);
		mockLoadSkills.mockResolvedValue([jira]);
		simulateSuccessfulRun();

		const result = await executeSkillAction({
			skill: "jira",
			action: "create_ticket",
			inputs: {},
		});

		expect(result.status).toBe("error");
		const missing = result.validationErrors?.filter((e) => e.code === "MISSING_REQUIRED_INPUT");
		expect(missing).toHaveLength(1);
		expect(missing?.[0].input).toBe("summary");
		expect(mockRuntimeRun).not.toHaveBeenCalled();
	});

	it("UNKNOWN_INPUT — undeclared input key rejected, runtime not called", async () => {
		const jira = skillWith("jira", [
			action("create_ticket", [{ name: "summary", required: true }]),
		]);
		mockLoadSkills.mockResolvedValue([jira]);
		simulateSuccessfulRun();

		const result = await executeSkillAction({
			skill: "jira",
			action: "create_ticket",
			inputs: { summary: "ok", bogus: 42 },
		});

		expect(result.status).toBe("error");
		const unknown = result.validationErrors?.filter((e) => e.code === "UNKNOWN_INPUT");
		expect(unknown).toHaveLength(1);
		expect(unknown?.[0].input).toBe("bogus");
		expect(mockRuntimeRun).not.toHaveBeenCalled();
	});

	it("applies declared defaults when caller omits an input", async () => {
		const jira = skillWith("jira", [
			action("create_ticket", [
				{ name: "summary", required: true },
				{ name: "priority", required: false, default: "P3" },
			]),
		]);
		mockLoadSkills.mockResolvedValue([jira]);
		simulateSuccessfulRun();

		const result = await executeSkillAction({
			skill: "jira",
			action: "create_ticket",
			inputs: { summary: "fix" },
		});

		expect(result.status).toBe("completed");
		expect(result.resolvedAction?.inputs).toEqual({ summary: "fix", priority: "P3" });
		const prompt = mockRuntimeRun.mock.calls[0][0].prompt;
		expect(prompt).toContain("priority");
		expect(prompt).toContain("P3");
	});

	it("falsy-but-present required inputs pass validation (presence, not truthiness)", async () => {
		const jira = skillWith("jira", [
			action("toggle", [
				{ name: "enabled", required: true },
				{ name: "count", required: true },
				{ name: "label", required: true },
			]),
		]);
		mockLoadSkills.mockResolvedValue([jira]);
		simulateSuccessfulRun();

		const result = await executeSkillAction({
			skill: "jira",
			action: "toggle",
			inputs: { enabled: false, count: 0, label: "" },
		});

		expect(result.status).toBe("completed");
		expect(result.validationErrors).toBeUndefined();
		expect(result.resolvedAction?.inputs).toEqual({ enabled: false, count: 0, label: "" });
	});

	it("honors caller-supplied allowlist — empty allowlist excludes target → SKILL_NOT_FOUND", async () => {
		const jira = skillWith("jira", [action("create_ticket")]);
		mockLoadSkills.mockResolvedValue([jira]);
		simulateSuccessfulRun();

		const result = await executeSkillAction({
			skill: "jira",
			action: "create_ticket",
			policy: { skillAllowlist: [] },
		});

		expect(result.status).toBe("error");
		const codes = result.validationErrors?.map((e) => e.code) ?? [];
		expect(codes).toContain("SKILL_NOT_FOUND");
		expect(result.validationErrors?.find((e) => e.code === "SKILL_NOT_FOUND")?.skill).toBe("jira");
		expect(mockRuntimeRun).not.toHaveBeenCalled();
	});

	it("honors caller-supplied allowlist that excludes target — SKILL_NOT_FOUND propagates", async () => {
		const jira = skillWith("jira", [action("create_ticket")]);
		const git = skillWith("git", [action("commit")]);
		mockLoadSkills.mockResolvedValue([jira, git]);
		simulateSuccessfulRun();

		const result = await executeSkillAction({
			skill: "jira",
			action: "create_ticket",
			// Non-empty allowlist that explicitly excludes "jira" — we do not
			// auto-add the target to the caller-supplied allowlist.
			policy: { skillAllowlist: ["git"] },
		});

		expect(result.status).toBe("error");
		const codes = result.validationErrors?.map((e) => e.code) ?? [];
		expect(codes).toContain("SKILL_NOT_FOUND");
		expect(result.validationErrors?.find((e) => e.code === "SKILL_NOT_FOUND")?.skill).toBe("jira");
		expect(mockRuntimeRun).not.toHaveBeenCalled();
	});

	it("strict precedence — missing + unready combo emits only SKILL_NOT_FOUND class", async () => {
		// Target skill is unready AND a second allowlisted skill is missing.
		// Per resolver precedence, SKILL_NOT_FOUND dominates SKILL_NOT_READY
		// for the same request.
		const unreadyJira = skillWith("jira", [action("noop")], {
			ready: false,
			missingRequires: ["python3"],
		});
		mockLoadSkills.mockResolvedValue([unreadyJira]);
		simulateSuccessfulRun();

		const result = await executeSkillAction({
			skill: "jira",
			action: "noop",
			// Caller-supplied allowlist pulls in a missing skill alongside
			// the unready target. Resolver must emit only SKILL_NOT_FOUND.
			policy: { skillAllowlist: ["jira", "confluence"] },
		});

		expect(result.status).toBe("error");
		const codes = result.validationErrors?.map((e) => e.code) ?? [];
		expect(codes.length).toBeGreaterThan(0);
		expect(codes).toContain("SKILL_NOT_FOUND");
		expect(codes).not.toContain("SKILL_NOT_READY");
		expect(codes).not.toContain("ACTION_NOT_FOUND");
		expect(mockRuntimeRun).not.toHaveBeenCalled();
	});

	it("explicit undefined counts as supplied and suppresses default", async () => {
		const jira = skillWith("jira", [
			action("create_ticket", [{ name: "a", required: true, default: "DEFAULT_A" }]),
		]);
		mockLoadSkills.mockResolvedValue([jira]);
		simulateSuccessfulRun();

		const result = await executeSkillAction({
			skill: "jira",
			action: "create_ticket",
			inputs: { a: undefined },
		});

		expect(result.status).toBe("completed");
		const missing =
			result.validationErrors?.filter((e) => e.code === "MISSING_REQUIRED_INPUT") ?? [];
		expect(missing).toHaveLength(0);
		expect(result.resolvedAction).toBeDefined();
		expect("a" in (result.resolvedAction?.inputs ?? {})).toBe(true);
		expect(result.resolvedAction?.inputs.a).toBeUndefined();
		expect(mockRuntimeRun).toHaveBeenCalledTimes(1);
	});

	it("MISSING_REQUIRED_INPUT and UNKNOWN_INPUT accumulate together", async () => {
		const jira = skillWith("jira", [action("create_ticket", [{ name: "a", required: true }])]);
		mockLoadSkills.mockResolvedValue([jira]);
		simulateSuccessfulRun();

		const result = await executeSkillAction({
			skill: "jira",
			action: "create_ticket",
			inputs: { b: 1 },
		});

		expect(result.status).toBe("error");
		const missing =
			result.validationErrors?.filter((e) => e.code === "MISSING_REQUIRED_INPUT") ?? [];
		const unknown = result.validationErrors?.filter((e) => e.code === "UNKNOWN_INPUT") ?? [];
		expect(missing).toHaveLength(1);
		expect(missing[0].input).toBe("a");
		expect(unknown).toHaveLength(1);
		expect(unknown[0].input).toBe("b");
		expect(mockRuntimeRun).not.toHaveBeenCalled();
	});

	it("prompt contains expectedEvidence verbatim", async () => {
		const jira = skillWith("jira", [
			action("create_ticket", [{ name: "summary", required: true }], {
				expectedEvidence: ["artifact X", "artifact Y"],
			}),
		]);
		mockLoadSkills.mockResolvedValue([jira]);
		simulateSuccessfulRun();

		const result = await executeSkillAction({
			skill: "jira",
			action: "create_ticket",
			inputs: { summary: "ok" },
		});

		expect(result.status).toBe("completed");
		const prompt = mockRuntimeRun.mock.calls[0][0].prompt;
		expect(prompt).toContain("artifact X");
		expect(prompt).toContain("artifact Y");
	});

	it("prompt is byte-identical regardless of caller input key order", async () => {
		const jira = skillWith("jira", [
			action("create_ticket", [
				{ name: "a", required: true },
				{ name: "b", required: true },
			]),
		]);
		mockLoadSkills.mockResolvedValue([jira]);
		simulateSuccessfulRun();

		const r1 = await executeSkillAction({
			skill: "jira",
			action: "create_ticket",
			inputs: { a: 1, b: 2 },
		});
		const r2 = await executeSkillAction({
			skill: "jira",
			action: "create_ticket",
			inputs: { b: 2, a: 1 },
		});

		expect(r1.status).toBe("completed");
		expect(r2.status).toBe("completed");
		expect(mockRuntimeRun).toHaveBeenCalledTimes(2);
		const p1 = mockRuntimeRun.mock.calls[0][0].prompt;
		const p2 = mockRuntimeRun.mock.calls[1][0].prompt;
		expect(p2).toBe(p1);
	});

	it("precedence — SKILL_ROOT_MISSING wins over caller-allowlist-excludes-target SKILL_NOT_FOUND", async () => {
		// Caller supplies an allowlist that excludes the target skill AND
		// a missing skillDirs entry. Per the documented precedence contract
		// (SKILL_ROOT_MISSING > SKILL_NOT_FOUND > SKILL_NOT_READY) the
		// resolver's root-missing error must win; the action layer must
		// NOT short-circuit to SKILL_NOT_FOUND before the resolver runs.
		const missingPath = `/tmp/drmclaw-test-nonexistent-${Date.now()}-${Math.random()
			.toString(36)
			.slice(2)}`;
		const jira = skillWith("jira", [action("create_ticket")]);
		mockLoadSkills.mockResolvedValue([jira]);
		simulateSuccessfulRun();

		const result = await executeSkillAction({
			skill: "jira",
			action: "create_ticket",
			skillDirs: [missingPath],
			policy: { skillAllowlist: ["git"] },
		});

		expect(result.status).toBe("error");
		const codes = result.validationErrors?.map((e) => e.code) ?? [];
		expect(codes).toEqual(["SKILL_ROOT_MISSING"]);
		expect(codes).not.toContain("SKILL_NOT_FOUND");
		expect(result.skillResolutionErrors?.[0].code).toBe("SKILL_ROOT_MISSING");
		expect(mockRuntimeRun).not.toHaveBeenCalled();
	});

	it("paired — roots valid, caller allowlist excludes target → post-resolver SKILL_NOT_FOUND for target", async () => {
		// Mirror of the precedence test with valid roots: the resolver
		// passes ("git" is discoverable) and the defensive post-resolver
		// fail-closed check fires for "jira" — not the resolver's own
		// SKILL_NOT_FOUND, because "git" IS present in the allowlist.
		const git = skillWith("git", [action("status")]);
		mockLoadSkills.mockResolvedValue([git]);
		simulateSuccessfulRun();

		const result = await executeSkillAction({
			skill: "jira",
			action: "create_ticket",
			skillDirs: [process.cwd()],
			policy: { skillAllowlist: ["git"] },
		});

		expect(result.status).toBe("error");
		expect(result.validationErrors).toHaveLength(1);
		expect(result.validationErrors?.[0].code).toBe("SKILL_NOT_FOUND");
		expect(result.validationErrors?.[0].skill).toBe("jira");
		expect(result.skillResolutionErrors?.[0].code).toBe("SKILL_NOT_FOUND");
		expect(result.skillResolutionErrors?.[0].skill).toBe("jira");
		expect(mockRuntimeRun).not.toHaveBeenCalled();
	});

	it("empty allowlist fail-closed — target discovered but excluded → SKILL_NOT_FOUND", async () => {
		// Confirms the empty-allowlist-excludes-target fail-closed behavior
		// is preserved after the precedence fix: jira IS discoverable via
		// loadSkills, but the caller-supplied empty allowlist excludes it.
		const jira = skillWith("jira", [action("create_ticket")]);
		mockLoadSkills.mockResolvedValue([jira]);
		simulateSuccessfulRun();

		const result = await executeSkillAction({
			skill: "jira",
			action: "create_ticket",
			policy: { skillAllowlist: [] },
		});

		expect(result.status).toBe("error");
		expect(result.validationErrors).toHaveLength(1);
		expect(result.validationErrors?.[0].code).toBe("SKILL_NOT_FOUND");
		expect(result.validationErrors?.[0].skill).toBe("jira");
		expect(mockRuntimeRun).not.toHaveBeenCalled();
	});
});

describe("executeSkillAction — actionValidationErrors population", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockLoadConfig.mockImplementation(async (overrides?: Record<string, unknown>) => {
			return configSchema.parse(overrides ?? {});
		});
		mockLoadSkills.mockResolvedValue([]);
		mockLoadSkillsFromDirs.mockResolvedValue([]);
	});

	it("ACTION_NOT_FOUND → actionValidationErrors populated, skillResolutionErrors undefined", async () => {
		const jira = skillWith("jira", [action("create_ticket")]);
		mockLoadSkills.mockResolvedValue([jira]);
		simulateSuccessfulRun();

		const result = await executeSkillAction({
			skill: "jira",
			action: "delete_ticket",
		});

		expect(result.status).toBe("error");
		expect(result.actionValidationErrors).toHaveLength(1);
		expect(result.actionValidationErrors?.[0].code).toBe("ACTION_NOT_FOUND");
		expect(result.skillResolutionErrors).toBeUndefined();
		expect(result.validationErrors).toEqual(result.actionValidationErrors);
		// Invariant: validationErrors == (skillResolutionErrors ?? []) ++ (actionValidationErrors ?? [])
		expect(result.validationErrors).toEqual([
			...(result.skillResolutionErrors ?? []),
			...(result.actionValidationErrors ?? []),
		]);
	});

	it("MISSING_REQUIRED_INPUT → actionValidationErrors mirrors validationErrors", async () => {
		const jira = skillWith("jira", [
			action("create_ticket", [{ name: "summary", required: true }]),
		]);
		mockLoadSkills.mockResolvedValue([jira]);
		simulateSuccessfulRun();

		const result = await executeSkillAction({
			skill: "jira",
			action: "create_ticket",
			inputs: {},
		});

		expect(result.status).toBe("error");
		expect(result.actionValidationErrors).toHaveLength(1);
		expect(result.actionValidationErrors?.[0].code).toBe("MISSING_REQUIRED_INPUT");
		expect(result.actionValidationErrors?.[0].input).toBe("summary");
		expect(result.skillResolutionErrors).toBeUndefined();
		expect(result.validationErrors).toEqual(result.actionValidationErrors);
	});

	it("UNKNOWN_INPUT → actionValidationErrors mirrors validationErrors", async () => {
		const jira = skillWith("jira", [
			action("create_ticket", [{ name: "summary", required: true }]),
		]);
		mockLoadSkills.mockResolvedValue([jira]);
		simulateSuccessfulRun();

		const result = await executeSkillAction({
			skill: "jira",
			action: "create_ticket",
			inputs: { summary: "ok", bogus: 42 },
		});

		expect(result.status).toBe("error");
		expect(result.actionValidationErrors).toHaveLength(1);
		expect(result.actionValidationErrors?.[0].code).toBe("UNKNOWN_INPUT");
		expect(result.actionValidationErrors?.[0].input).toBe("bogus");
		expect(result.skillResolutionErrors).toBeUndefined();
		expect(result.validationErrors).toEqual(result.actionValidationErrors);
	});

	it("combined MISSING + UNKNOWN → actionValidationErrors carries both; validationErrors matches", async () => {
		const jira = skillWith("jira", [action("create_ticket", [{ name: "a", required: true }])]);
		mockLoadSkills.mockResolvedValue([jira]);
		simulateSuccessfulRun();

		const result = await executeSkillAction({
			skill: "jira",
			action: "create_ticket",
			inputs: { b: 1 },
		});

		expect(result.status).toBe("error");
		const codes = result.actionValidationErrors?.map((e) => e.code) ?? [];
		expect(codes).toContain("MISSING_REQUIRED_INPUT");
		expect(codes).toContain("UNKNOWN_INPUT");
		expect(result.actionValidationErrors).toHaveLength(2);
		expect(result.skillResolutionErrors).toBeUndefined();
		expect(result.validationErrors).toEqual(result.actionValidationErrors);
	});

	it("resolver SKILL_NOT_FOUND (allowlist excludes target) → actionValidationErrors undefined", async () => {
		const jira = skillWith("jira", [action("create_ticket")]);
		const git = skillWith("git", [action("commit")]);
		mockLoadSkills.mockResolvedValue([jira, git]);
		simulateSuccessfulRun();

		const result = await executeSkillAction({
			skill: "jira",
			action: "create_ticket",
			policy: { skillAllowlist: ["git"] },
		});

		expect(result.status).toBe("error");
		expect(result.actionValidationErrors).toBeUndefined();
		expect(result.skillResolutionErrors).toBeDefined();
		expect(result.skillResolutionErrors?.[0].code).toBe("SKILL_NOT_FOUND");
		expect(result.validationErrors).toHaveLength(1);
		expect(result.validationErrors?.[0].code).toBe("SKILL_NOT_FOUND");
		// Invariant: validationErrors == (skillResolutionErrors ?? []) ++ (actionValidationErrors ?? [])
		const expected = [
			...(result.skillResolutionErrors ?? []).map((e) => e.code),
			...(result.actionValidationErrors ?? []).map((e) => e.code),
		];
		expect(result.validationErrors?.map((e) => e.code)).toEqual(expected);
	});
});
