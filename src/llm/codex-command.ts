import { accessSync, constants, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, sep } from "node:path";
import type { CodexAppServerConfig } from "../config/schema.js";

export interface ResolvedCodexAppServerCommand {
	command: string;
	args: string[];
	found: boolean;
}

function isExecutable(path: string): boolean {
	try {
		accessSync(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

function hasPathSeparator(command: string): boolean {
	return command.includes("/") || (sep === "\\" && command.includes("\\"));
}

function pathCandidates(command: string): string[] {
	return (process.env.PATH ?? "")
		.split(delimiter)
		.filter(Boolean)
		.map((dir) => join(dir, command));
}

function vscodeCodexCandidates(): string[] {
	const extensionsDir = join(homedir(), ".vscode", "extensions");
	let entries: string[];
	try {
		entries = readdirSync(extensionsDir);
	} catch {
		return [];
	}

	return entries
		.filter((entry) => entry.startsWith("openai.chatgpt-"))
		.sort()
		.reverse()
		.flatMap((entry) => [
			join(extensionsDir, entry, "bin", "macos-aarch64", "codex"),
			join(extensionsDir, entry, "bin", "macos-x64", "codex"),
			join(extensionsDir, entry, "bin", "linux-x64", "codex"),
			join(extensionsDir, entry, "bin", "linux-arm64", "codex"),
		]);
}

function defaultCodexCandidates(): string[] {
	return [
		...pathCandidates("codex"),
		join(homedir(), ".local", "bin", "codex"),
		join(homedir(), ".codex", "bin", "codex"),
		...vscodeCodexCandidates(),
	];
}

export function resolveCodexAppServerExecutable(
	codexCfg: CodexAppServerConfig,
): ResolvedCodexAppServerCommand {
	const args = [...codexCfg.args];
	const command = codexCfg.command;

	if (isAbsolute(command) || hasPathSeparator(command)) {
		return { command, args, found: isExecutable(command) };
	}

	for (const candidate of pathCandidates(command)) {
		if (isExecutable(candidate)) return { command: candidate, args, found: true };
	}

	if (command === "codex") {
		for (const candidate of defaultCodexCandidates()) {
			if (isExecutable(candidate)) return { command: candidate, args, found: true };
		}
	}

	return { command, args, found: false };
}
