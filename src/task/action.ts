/**
 * Structured skill-action execution — a parallel surface to
 * {@link executeTask} that takes a typed `{ skill, action, inputs }`
 * shape instead of a free-form prompt string.
 *
 * This is the Phase-2 product-contract migration target. Products
 * declare the intent (which skill, which action, which inputs) and
 * core handles the rest: skill resolution, structured validation of
 * the action and its inputs, prompt synthesis, and the same LLM-native
 * runtime chain {@link executeTask} uses.
 *
 * Validation order (all errors are returned as structured
 * {@link ActionValidationError}s — this function never throws to
 * callers):
 *
 * 1. Skill resolution via {@link resolveSkillsForRequest}. Any
 *    resolver error (`SKILL_ROOT_MISSING`, `SKILL_NOT_FOUND`,
 *    `SKILL_NOT_READY`) short-circuits and is surfaced via
 *    `validationErrors` AND `skillResolutionErrors`.
 * 2. Action exists on the resolved skill.
 * 3. Every required input declared on the action is present in
 *    `request.inputs` (presence-based — `false`, `0`, `""` all count).
 * 4. Every key in `request.inputs` maps to a declared input on the
 *    action (strict — unknown keys are rejected).
 * 5. Defaults are applied for declared inputs not supplied by the
 *    caller.
 *
 * Non-resolver preflight failures (`ACTION_NOT_FOUND`,
 * `MISSING_REQUIRED_INPUT`, `UNKNOWN_INPUT`) populate both
 * `validationErrors` AND `actionValidationErrors`, mirroring the
 * `validationErrors` + `skillResolutionErrors` pairing used for
 * resolver codes. Resolver-code returns never populate
 * `actionValidationErrors`.
 *
 * Allowlist defaulting: when `request.policy.skillAllowlist` is
 * undefined we default it to `[request.skill]`. If the caller supplies
 * an allowlist that does not include `request.skill`, we honor it as
 * an explicit contract violation and fail closed with
 * `SKILL_NOT_FOUND` — but this check runs AFTER
 * {@link resolveSkillsForRequest} so `SKILL_ROOT_MISSING` still wins
 * the documented precedence contract.
 */

import type { z } from "zod";
import { loadDrMClawConfig } from "../config/loader.js";
import type { DrMClawConfig, configSchema } from "../config/schema.js";
import type { PersistedRuntimeEvent } from "../events/types.js";
import type { RuntimeEvent } from "../runtime/types.js";
import { type SkillResolutionError, resolveSkillsForRequest } from "../skills/resolve.js";
import type { SkillAction, SkillEntry } from "../skills/types.js";
import { runPromptViaRuntime } from "./runtime-chain.js";

/**
 * A structured action invocation. Products declare the target skill,
 * action name, inputs, and execution policy without crafting prompt text.
 */
export interface ExecuteSkillActionRequest {
	/** Target skill name (must be present in the resolved skill set). */
	skill: string;
	/** Action name declared on the target skill. */
	action: string;
	/** Input values keyed by action input name. */
	inputs?: Record<string, unknown>;

	/** Working directory for skill execution. */
	workingDir?: string;
	/** Additional directories to search for skills (merged with config-driven). */
	skillDirs?: string[];
	/** Execution constraints. Same shape as on ExecuteTaskRequest. */
	policy?: {
		permissionMode?: "approve-all" | "approve-reads" | "deny-all";
		/** Optional explicit allowlist. If omitted, core defaults to [skill]. */
		skillAllowlist?: string[];
	};
	/** Config overrides merged onto the loaded config. */
	config?: Partial<z.input<typeof configSchema>>;
	/** Timeout in milliseconds. */
	timeoutMs?: number;
	/** Max output characters returned. */
	maxOutputChars?: number;
}

/** Structured validation error raised BEFORE runtime assembly. */
export interface ActionValidationError {
	code:
		| "SKILL_NOT_FOUND"
		| "SKILL_NOT_READY"
		| "SKILL_ROOT_MISSING"
		| "ACTION_NOT_FOUND"
		| "MISSING_REQUIRED_INPUT"
		| "UNKNOWN_INPUT";
	message: string;
	/** Populated when applicable. */
	skill?: string;
	action?: string;
	input?: string;
	/** For SKILL_* codes: list carried from SkillResolutionError. */
	missingRequires?: string[];
	skillDirs?: string[];
}

export interface ExecuteSkillActionResult {
	status: "completed" | "error";
	output: string;
	error?: string;
	durationMs: number;
	taskId: string;
	events: PersistedRuntimeEvent[];
	provider: string;
	requestedModel?: string;

	/** Structured validation errors (any pre-runtime validation failure). */
	validationErrors?: ActionValidationError[];
	/** Skill-resolution errors specifically (subset/mirror of validationErrors where applicable). */
	skillResolutionErrors?: SkillResolutionError[];
	/** Non-resolver action-contract preflight errors (subset/mirror of validationErrors).
	 *  Populated for ACTION_NOT_FOUND, MISSING_REQUIRED_INPUT, UNKNOWN_INPUT. */
	actionValidationErrors?: ActionValidationError[];

	/** The resolved action metadata that was executed (diagnostic). */
	resolvedAction?: { skill: string; action: string; inputs: Record<string, unknown> };
}

/**
 * Build a deterministic prompt describing a structured action call.
 *
 * The prompt is intentionally simple and domain-agnostic: the skill
 * body (loaded from `SKILL.md`) carries the real instructions; this
 * prompt just tells the agent which action to invoke and with what
 * inputs. Products can later ship custom prompt builders on top of
 * this helper if they want more elaborate framing.
 */
function buildActionPrompt(
	skillName: string,
	action: SkillAction,
	resolvedInputs: Record<string, unknown>,
): string {
	const lines: string[] = [`Invoke skill action: ${skillName}.${action.name}`];
	if (action.description) {
		lines.push(action.description);
	}
	lines.push("", "Inputs:");
	// Emit inputs in a canonical order so prompts are byte-stable
	// regardless of the caller's object-literal key order:
	//   1. Declared order from action.inputs[] (only keys present in the map).
	//   2. Any undeclared leftovers (defensive — validation rejects these)
	//      in alphabetical order.
	// Presence is checked with `in` so an explicit `undefined` value
	// supplied by the caller is still emitted.
	const declaredNames = new Set(action.inputs.map((i) => i.name));
	const orderedKeys: string[] = [];
	for (const declared of action.inputs) {
		if (declared.name in resolvedInputs) {
			orderedKeys.push(declared.name);
		}
	}
	const leftovers = Object.keys(resolvedInputs)
		.filter((k) => !declaredNames.has(k))
		.sort();
	orderedKeys.push(...leftovers);
	if (orderedKeys.length === 0) {
		lines.push("- (none)");
	} else {
		for (const key of orderedKeys) {
			lines.push(`- ${key}: ${JSON.stringify(resolvedInputs[key])}`);
		}
	}
	if (action.expectedEvidence && action.expectedEvidence.length > 0) {
		lines.push("", "Expected evidence:");
		for (const item of action.expectedEvidence) {
			lines.push(`- ${item}`);
		}
	}
	return lines.join("\n");
}

/** Map a SkillResolutionError into an ActionValidationError 1:1 on code. */
function toValidationError(err: SkillResolutionError): ActionValidationError {
	return {
		code: err.code,
		message: err.message,
		skill: err.skill,
		missingRequires: err.missingRequires,
		skillDirs: err.skillDirs,
	};
}

/**
 * Execute a structured skill action through the LLM-native runtime chain.
 *
 * All setup phases (config, skill resolution, action validation, input
 * validation) run inside a structured error boundary so failures always
 * produce a structured {@link ExecuteSkillActionResult} with
 * `status: "error"` and populated `validationErrors` — never a promise
 * rejection.
 */
export async function executeSkillAction(
	request: ExecuteSkillActionRequest,
	options?: { onEvent?: (event: RuntimeEvent) => void },
): Promise<ExecuteSkillActionResult> {
	const startTime = Date.now();
	let config: DrMClawConfig | undefined;

	try {
		// 1. Build config — load real config file, merge request overrides on top
		const overrides: Record<string, unknown> = { ...(request.config ?? {}) };
		if (request.policy?.permissionMode) {
			overrides.llm = {
				...((overrides.llm ?? {}) as Record<string, unknown>),
				permissionMode: request.policy.permissionMode,
			};
		}
		config = await loadDrMClawConfig(overrides as Partial<DrMClawConfig>);

		// 2. Resolve skills — default allowlist to [request.skill] when
		//    the caller did not supply one. A caller-supplied allowlist
		//    is honored as-is (we do not auto-add request.skill to it).
		//    The caller-supplied-allowlist-excludes-target fail-closed
		//    check runs AFTER the resolver so that SKILL_ROOT_MISSING
		//    retains precedence per the documented contract.
		const callerSuppliedAllowlist = request.policy?.skillAllowlist;
		const effectiveAllowlist = callerSuppliedAllowlist ?? [request.skill];
		const resolution = await resolveSkillsForRequest({
			config,
			skillDirs: request.skillDirs,
			skillAllowlist: effectiveAllowlist,
		});

		if (resolution.errors.length > 0) {
			const validationErrors = resolution.errors.map(toValidationError);
			return {
				status: "error",
				output: "",
				error: validationErrors.map((e) => `[${e.code}] ${e.message}`).join("\n"),
				durationMs: Date.now() - startTime,
				taskId: "",
				events: [],
				provider: config.llm.provider,
				requestedModel: config.llm.model,
				validationErrors,
				skillResolutionErrors: resolution.errors,
			};
		}

		// Post-resolver fail-closed: the resolver has confirmed request.skillDirs
		// are valid (SKILL_ROOT_MISSING wins precedence). If the caller supplied
		// an allowlist that excludes request.skill, honor that as an explicit
		// contract violation and fail closed with SKILL_NOT_FOUND for the
		// requested target. Done here (not before the resolver) so missing
		// roots always dominate per the documented precedence contract.
		if (callerSuppliedAllowlist !== undefined && !callerSuppliedAllowlist.includes(request.skill)) {
			const err: ActionValidationError = {
				code: "SKILL_NOT_FOUND",
				skill: request.skill,
				message: `Allowlisted skill "${request.skill}" was not discovered in config or request skill directories.`,
			};
			return {
				status: "error",
				output: "",
				error: `[${err.code}] ${err.message}`,
				durationMs: Date.now() - startTime,
				taskId: "",
				events: [],
				provider: config.llm.provider,
				requestedModel: config.llm.model,
				validationErrors: [err],
				skillResolutionErrors: [
					{
						code: "SKILL_NOT_FOUND",
						skill: request.skill,
						message: err.message,
					},
				],
			};
		}

		// 3. Action exists — locate the target skill and its action.
		const targetSkill: SkillEntry | undefined = resolution.skills.find(
			(s) => s.name === request.skill,
		);
		// If the resolver returned no errors and the allowlist included
		// request.skill, the skill must be in resolution.skills. If a
		// caller-supplied allowlist omitted the target entirely, the
		// resolver would have emitted SKILL_NOT_FOUND and we would have
		// returned above. Guard defensively anyway.
		if (!targetSkill) {
			const err: ActionValidationError = {
				code: "SKILL_NOT_FOUND",
				skill: request.skill,
				message: `Target skill "${request.skill}" was not present in the resolved skill set.`,
			};
			return {
				status: "error",
				output: "",
				error: `[${err.code}] ${err.message}`,
				durationMs: Date.now() - startTime,
				taskId: "",
				events: [],
				provider: config.llm.provider,
				requestedModel: config.llm.model,
				validationErrors: [err],
			};
		}

		const action = (targetSkill.actions ?? []).find((a) => a.name === request.action);
		if (!action) {
			const err: ActionValidationError = {
				code: "ACTION_NOT_FOUND",
				skill: request.skill,
				action: request.action,
				message: `Action "${request.action}" is not declared on skill "${request.skill}".`,
			};
			return {
				status: "error",
				output: "",
				error: `[${err.code}] ${err.message}`,
				durationMs: Date.now() - startTime,
				taskId: "",
				events: [],
				provider: config.llm.provider,
				requestedModel: config.llm.model,
				validationErrors: [err],
				actionValidationErrors: [err],
			};
		}

		// 4-5. Input validation — presence-based for required, strict for unknown.
		const suppliedInputs = request.inputs ?? {};
		const declaredInputNames = new Set(action.inputs.map((i) => i.name));
		const inputErrors: ActionValidationError[] = [];

		for (const declared of action.inputs) {
			if (declared.required === true && !(declared.name in suppliedInputs)) {
				inputErrors.push({
					code: "MISSING_REQUIRED_INPUT",
					skill: request.skill,
					action: request.action,
					input: declared.name,
					message: `Required input "${declared.name}" is missing for action "${request.skill}.${request.action}".`,
				});
			}
		}

		for (const key of Object.keys(suppliedInputs)) {
			if (!declaredInputNames.has(key)) {
				inputErrors.push({
					code: "UNKNOWN_INPUT",
					skill: request.skill,
					action: request.action,
					input: key,
					message: `Unknown input "${key}" for action "${request.skill}.${request.action}".`,
				});
			}
		}

		if (inputErrors.length > 0) {
			return {
				status: "error",
				output: "",
				error: inputErrors.map((e) => `[${e.code}] ${e.message}`).join("\n"),
				durationMs: Date.now() - startTime,
				taskId: "",
				events: [],
				provider: config.llm.provider,
				requestedModel: config.llm.model,
				validationErrors: inputErrors,
				actionValidationErrors: inputErrors,
			};
		}

		// 6. Apply defaults for declared inputs the caller omitted.
		const resolvedInputs: Record<string, unknown> = { ...suppliedInputs };
		for (const declared of action.inputs) {
			if (!(declared.name in resolvedInputs) && declared.default !== undefined) {
				resolvedInputs[declared.name] = declared.default;
			}
		}

		// 7. Bridge to the prompt-first runtime chain.
		const prompt = buildActionPrompt(request.skill, action, resolvedInputs);
		const runResult = await runPromptViaRuntime({
			prompt,
			config,
			skills: resolution.skills,
			workingDir: request.workingDir,
			timeoutMs: request.timeoutMs,
			maxOutputChars: request.maxOutputChars,
			onEvent: options?.onEvent,
			startTime,
		});

		return {
			...runResult,
			provider: config.llm.provider,
			requestedModel: config.llm.model,
			resolvedAction: {
				skill: request.skill,
				action: request.action,
				inputs: resolvedInputs,
			},
		};
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return {
			status: "error",
			output: "",
			error: message,
			durationMs: Date.now() - startTime,
			taskId: "",
			events: [],
			provider: config?.llm.provider ?? "",
			requestedModel: config?.llm.model,
		};
	}
}
