import { describe, expect, it } from "vitest";
import type { SkillActionCallSpec } from "../src/task/request.js";
import { buildExecuteSkillActionRequest } from "../src/task/request.js";

describe("buildExecuteSkillActionRequest", () => {
	it("copies skill / action / inputs verbatim", () => {
		const spec: SkillActionCallSpec = {
			skill: "jira",
			action: "create_ticket",
			inputs: { summary: "fix bug", priority: "P1" },
		};
		const req = buildExecuteSkillActionRequest(spec);
		expect(req.skill).toBe("jira");
		expect(req.action).toBe("create_ticket");
		expect(req.inputs).toEqual({ summary: "fix bug", priority: "P1" });
	});

	it("defaults policy.skillAllowlist to [spec.skill] when omitted", () => {
		const req = buildExecuteSkillActionRequest({ skill: "jira", action: "noop" });
		expect(req.policy?.skillAllowlist).toEqual(["jira"]);
	});

	it("forwards explicit skillAllowlist verbatim (empty array is preserved)", () => {
		const req = buildExecuteSkillActionRequest({
			skill: "jira",
			action: "noop",
			skillAllowlist: [],
		});
		expect(req.policy?.skillAllowlist).toEqual([]);
	});

	it("forwards explicit skillAllowlist verbatim (does not auto-inject spec.skill)", () => {
		const req = buildExecuteSkillActionRequest({
			skill: "jira",
			action: "noop",
			skillAllowlist: ["git"],
		});
		expect(req.policy?.skillAllowlist).toEqual(["git"]);
	});

	it("passes permissionMode through when supplied", () => {
		const req = buildExecuteSkillActionRequest({
			skill: "jira",
			action: "noop",
			permissionMode: "approve-reads",
		});
		expect(req.policy?.permissionMode).toBe("approve-reads");
	});

	it("omits permissionMode from policy when caller does not supply one", () => {
		const req = buildExecuteSkillActionRequest({ skill: "jira", action: "noop" });
		expect(req.policy).toBeDefined();
		expect("permissionMode" in (req.policy ?? {})).toBe(false);
	});

	it("applies allowlist default even when permissionMode is absent", () => {
		const req = buildExecuteSkillActionRequest({ skill: "jira", action: "noop" });
		expect(req.policy?.skillAllowlist).toEqual(["jira"]);
	});

	it("passes timeoutMs and maxOutputChars through", () => {
		const req = buildExecuteSkillActionRequest({
			skill: "jira",
			action: "noop",
			timeoutMs: 1234,
			maxOutputChars: 5678,
		});
		expect(req.timeoutMs).toBe(1234);
		expect(req.maxOutputChars).toBe(5678);
	});

	it("passes workingDir and skillDirs through", () => {
		const req = buildExecuteSkillActionRequest({
			skill: "jira",
			action: "noop",
			workingDir: "/tmp/work",
			skillDirs: ["/skills/a", "/skills/b"],
		});
		expect(req.workingDir).toBe("/tmp/work");
		expect(req.skillDirs).toEqual(["/skills/a", "/skills/b"]);
	});

	it("omits inputs from the request when caller omits it (no {} injection)", () => {
		const req = buildExecuteSkillActionRequest({ skill: "jira", action: "noop" });
		expect("inputs" in req).toBe(false);
	});

	it("is side-effect-free — mutating the returned request does not affect the input spec", () => {
		const inputs = { summary: "fix" };
		const skillDirs = ["/s"];
		const skillAllowlist = ["jira"];
		const spec: SkillActionCallSpec = {
			skill: "jira",
			action: "create_ticket",
			inputs,
			skillDirs,
			skillAllowlist,
		};
		const req = buildExecuteSkillActionRequest(spec);

		(req.inputs as Record<string, unknown>).summary = "tampered";
		req.skillDirs?.push("/mutated");
		req.policy?.skillAllowlist?.push("extra");

		expect(inputs).toEqual({ summary: "fix" });
		expect(skillDirs).toEqual(["/s"]);
		expect(skillAllowlist).toEqual(["jira"]);
		expect(spec.inputs).toBe(inputs);
		expect(spec.skillDirs).toBe(skillDirs);
		expect(spec.skillAllowlist).toBe(skillAllowlist);
	});
});
