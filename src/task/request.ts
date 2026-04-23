/**
 * Structured request-shaping helper for {@link executeSkillAction}.
 *
 * Products that drive structured skill-action execution often carry
 * extra business intent (operator-facing action names, expected
 * evidence, etc.) in their own product-local types. This helper maps
 * a minimal, domain-agnostic call-spec down to an
 * {@link ExecuteSkillActionRequest} so the shaping step stays
 * deterministic and side-effect-free at the core boundary.
 */

import type { ExecuteSkillActionRequest } from "./action.js";

/** Structured skill-action call specification. Reusable request-shaping
 *  input for products that drive `executeSkillAction`. */
export interface SkillActionCallSpec {
	skill: string;
	action: string;
	inputs?: Record<string, unknown>;
	workingDir?: string;
	skillDirs?: string[];
	permissionMode?: "approve-all" | "approve-reads" | "deny-all";
	/** Explicit allowlist. When omitted the builder defaults to [skill]. */
	skillAllowlist?: string[];
	timeoutMs?: number;
	maxOutputChars?: number;
}

/**
 * Build an `ExecuteSkillActionRequest` from a structured call-spec.
 *
 * Deterministic, side-effect-free. Copies reusable request fields
 * verbatim and defaults `policy.skillAllowlist` to `[spec.skill]` when
 * the caller does not supply one. Products that carry extra business
 * intent (operator-facing action names, expected evidence, etc.)
 * should keep those in a product-local type and map down to this spec
 * before calling the builder.
 */
export function buildExecuteSkillActionRequest(
	spec: SkillActionCallSpec,
): ExecuteSkillActionRequest {
	const request: ExecuteSkillActionRequest = {
		skill: spec.skill,
		action: spec.action,
	};

	if (spec.inputs !== undefined) {
		request.inputs = { ...spec.inputs };
	}
	if (spec.workingDir !== undefined) {
		request.workingDir = spec.workingDir;
	}
	if (spec.skillDirs !== undefined) {
		request.skillDirs = [...spec.skillDirs];
	}
	if (spec.timeoutMs !== undefined) {
		request.timeoutMs = spec.timeoutMs;
	}
	if (spec.maxOutputChars !== undefined) {
		request.maxOutputChars = spec.maxOutputChars;
	}

	const policy: NonNullable<ExecuteSkillActionRequest["policy"]> = {
		skillAllowlist: spec.skillAllowlist !== undefined ? [...spec.skillAllowlist] : [spec.skill],
	};
	if (spec.permissionMode !== undefined) {
		policy.permissionMode = spec.permissionMode;
	}
	request.policy = policy;

	return request;
}
