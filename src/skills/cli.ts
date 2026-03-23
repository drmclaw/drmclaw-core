import { loadDrMClawConfig } from "../config/loader.js";
import { loadSkills } from "./loader.js";
import type { SkillEntry } from "./types.js";

/**
 * Handle `drmclaw skills <subcommand>` CLI invocations.
 */
export async function handleSkillsCommand(args: string[]): Promise<void> {
	const sub = args[0];

	if (sub === "list") {
		await skillsList();
	} else if (sub === "info") {
		const name = args[1];
		if (!name) {
			console.error("Usage: drmclaw skills info <name>");
			process.exit(1);
		}
		await skillsInfo(name);
	} else if (sub === "check") {
		await skillsCheck();
	} else {
		console.log("Usage: drmclaw skills <list|info|check>");
		console.log("");
		console.log("Commands:");
		console.log("  list         List all discovered skills");
		console.log("  info <name>  Show detailed info for a skill");
		console.log("  check        Validate skills and check readiness");
		process.exit(sub ? 1 : 0);
	}
}

async function discoverSkills(): Promise<SkillEntry[]> {
	const config = await loadDrMClawConfig();
	return loadSkills(config);
}

async function skillsList(): Promise<void> {
	const skills = await discoverSkills();

	if (skills.length === 0) {
		console.log("No skills discovered.");
		return;
	}

	const nameW = Math.max(...skills.map((s) => s.name.length), 4);

	console.log(`${"NAME".padEnd(nameW)}  ${"SOURCE".padEnd(10)}  ${"READY".padEnd(5)}  DESCRIPTION`);
	console.log(`${"─".repeat(nameW)}  ${"─".repeat(10)}  ${"─".repeat(5)}  ${"─".repeat(11)}`);

	for (const skill of skills) {
		const source = skill.source === "system" ? "system" : "external";
		const ready = skill.ready ? "yes" : "no";
		const desc =
			skill.description.length > 60 ? `${skill.description.slice(0, 57)}...` : skill.description;
		console.log(`${skill.name.padEnd(nameW)}  ${source.padEnd(10)}  ${ready.padEnd(5)}  ${desc}`);
	}

	console.log(`\n${skills.length} skill(s) discovered.`);
}

async function skillsInfo(name: string): Promise<void> {
	const skills = await discoverSkills();
	const skill = skills.find((s) => s.name === name);

	if (!skill) {
		console.error(`Skill not found: ${name}`);
		console.error(`\nAvailable skills: ${skills.map((s) => s.name).join(", ") || "(none)"}`);
		process.exit(1);
	}

	console.log(`Name:          ${skill.name}`);
	console.log(`Description:   ${skill.description || "(none)"}`);
	console.log(`Source:        ${skill.source}`);
	console.log(`Directory:     ${skill.dir}`);
	if (skill.skillMdPath) {
		console.log(`SKILL.md:      ${skill.skillMdPath}`);
	}
	if (skill.entrypoint) {
		console.log(`Entrypoint:    ${skill.entrypoint}`);
	}
	console.log(`Ready:         ${skill.ready ? "yes" : "no"}`);
	if (skill.requires.length > 0) {
		console.log(`Requires:      ${skill.requires.join(", ")}`);
	}
	if (skill.missingRequires.length > 0) {
		console.log(`Missing:       ${skill.missingRequires.join(", ")}`);
	}
	if (Object.keys(skill.metadata).length > 0) {
		console.log(`Metadata:      ${JSON.stringify(skill.metadata)}`);
	}
}

async function skillsCheck(): Promise<void> {
	const skills = await discoverSkills();

	if (skills.length === 0) {
		console.log("No skills discovered.");
		return;
	}

	const ready = skills.filter((s) => s.ready);
	const notReady = skills.filter((s) => !s.ready);

	if (notReady.length > 0) {
		console.log("Skills with missing requirements:\n");
		for (const skill of notReady) {
			console.log(`  ${skill.name}`);
			for (const req of skill.missingRequires) {
				console.log(`    ✗ ${req}`);
			}
		}
		console.log("");
	}

	console.log(`${ready.length}/${skills.length} skill(s) ready.`);

	if (notReady.length > 0) {
		process.exit(1);
	}
}
