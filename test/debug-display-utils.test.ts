import { describe, expect, it } from "vitest";
import {
	type EventLogEntry,
	buildUnifiedDisplay,
	roundBgStyle,
	roundBorderClass,
	roundHue,
	roundTextClass,
} from "../ui/src/components/debugDisplayUtils.js";

// ── Helpers ──────────────────────────────────────────────────────────

function mkEntry(
	seq: number,
	source: EventLogEntry["source"],
	type: string,
	extra: Partial<EventLogEntry["event"]> = {},
): EventLogEntry {
	return {
		sequence: seq,
		timestamp: new Date().toISOString(),
		source,
		event: { type, ...extra },
	};
}

// ── buildUnifiedDisplay ──────────────────────────────────────────────

describe("buildUnifiedDisplay", () => {
	it("returns empty items for empty input", () => {
		expect(buildUnifiedDisplay([], false)).toEqual([]);
	});

	it("renders lifecycle events as plain events", () => {
		const entries = [mkEntry(0, "runtime", "lifecycle", { phase: "start" })];
		const display = buildUnifiedDisplay(entries, false);
		expect(display).toHaveLength(1);
		expect(display[0]?.kind).toBe("event");
	});

	it("groups tool_call events by toolCallId into tool-call-groups", () => {
		const entries = [
			mkEntry(0, "runtime", "lifecycle", { phase: "start" }),
			mkEntry(1, "acp", "tool_call", { tool: "ls", status: "pending", toolCallId: "tc-1" }),
			mkEntry(2, "acp", "tool_call", { tool: "ls", status: "completed", toolCallId: "tc-1" }),
			mkEntry(3, "acp", "tool_call", { tool: "cat", status: "pending", toolCallId: "tc-2" }),
			mkEntry(4, "acp", "tool_call", { tool: "cat", status: "completed", toolCallId: "tc-2" }),
			mkEntry(5, "runtime", "lifecycle", { phase: "end" }),
		];
		const display = buildUnifiedDisplay(entries, false);

		// lifecycle:start, tool-call-group(tc-1), tool-call-group(tc-2), lifecycle:end
		expect(display).toHaveLength(4);
		expect(display[0]?.kind).toBe("event");
		expect(display[1]?.kind).toBe("tool-call-group");
		expect(display[2]?.kind).toBe("tool-call-group");
		expect(display[3]?.kind).toBe("event");

		const g1 = display[1];
		expect(g1?.kind === "tool-call-group" && g1.toolCallId).toBe("tc-1");
		expect(g1?.kind === "tool-call-group" && g1.entries).toHaveLength(2);

		const g2 = display[2];
		expect(g2?.kind === "tool-call-group" && g2.toolCallId).toBe("tc-2");
		expect(g2?.kind === "tool-call-group" && g2.entries).toHaveLength(2);
	});

	it("collapses consecutive stream events into stream-groups", () => {
		const entries = [
			mkEntry(1, "acp", "tool_call", { tool: "ls", status: "pending", toolCallId: "tc-1" }),
			mkEntry(2, "acp", "tool_result", { tool: "ls", result: "files", toolCallId: "tc-1" }),
			mkEntry(3, "acp", "stream", { delta: "Hello " }),
			mkEntry(4, "acp", "stream", { delta: "world" }),
			mkEntry(5, "acp", "tool_call", { tool: "cat", status: "pending", toolCallId: "tc-2" }),
			mkEntry(6, "acp", "tool_result", { tool: "cat", result: "content", toolCallId: "tc-2" }),
			mkEntry(7, "acp", "stream", { delta: "done" }),
		];
		const display = buildUnifiedDisplay(entries, false);

		// tool-call-group(tc-1), stream-group, tool-call-group(tc-2), stream-group
		const streamGroups = display.filter((d) => d.kind === "stream-group");
		expect(streamGroups).toHaveLength(2);

		const sg1 = streamGroups[0];
		expect(sg1?.kind === "stream-group" && sg1?.totalChars).toBe(11);
		expect(sg1?.kind === "stream-group" && sg1?.isLive).toBe(false);

		const sg2 = streamGroups[1];
		expect(sg2?.kind === "stream-group" && sg2?.totalChars).toBe(4);
		expect(sg2?.kind === "stream-group" && sg2?.isLive).toBe(false);
	});

	it("marks trailing stream group as live when streaming", () => {
		const entries = [
			mkEntry(1, "acp", "tool_call", { tool: "shell", status: "pending", toolCallId: "tc-1" }),
			mkEntry(2, "acp", "tool_result", { tool: "shell", result: "ok", toolCallId: "tc-1" }),
			mkEntry(3, "acp", "stream", { delta: "partial" }),
		];
		const display = buildUnifiedDisplay(entries, true);
		// tool-call-group(tc-1), stream-group(live)
		expect(display).toHaveLength(2);
		const streamGroups = display.filter((d) => d.kind === "stream-group");
		expect(streamGroups).toHaveLength(1);
		expect(streamGroups[0]?.kind === "stream-group" && streamGroups[0]?.isLive).toBe(true);
	});

	it("marks trailing stream group as not-live when not streaming", () => {
		const entries = [mkEntry(1, "acp", "stream", { delta: "text" })];
		const display = buildUnifiedDisplay(entries, false);
		const streamGroups = display.filter((d) => d.kind === "stream-group");
		expect(streamGroups).toHaveLength(1);
		expect(streamGroups[0]?.kind === "stream-group" && streamGroups[0]?.isLive).toBe(false);
	});

	it("handles non-stream non-tool events without error", () => {
		const entries = [mkEntry(1, "acp", "other_event")];
		const display = buildUnifiedDisplay(entries, false);
		expect(display).toHaveLength(1);
		expect(display[0]?.kind).toBe("event");
	});

	it("interleaves runtime and acp events in a single timeline", () => {
		const entries = [
			mkEntry(0, "system", "task_init", { prompt: "hello" }),
			mkEntry(1, "runtime", "lifecycle", { phase: "start" }),
			mkEntry(2, "acp", "tool_call", {
				tool: "read_file",
				status: "pending",
				toolCallId: "tc-1",
			}),
			mkEntry(3, "acp", "tool_result", { tool: "read_file", result: "data", toolCallId: "tc-1" }),
			mkEntry(4, "acp", "tool_call", {
				tool: "read_file",
				status: "completed",
				toolCallId: "tc-1",
			}),
			mkEntry(5, "acp", "stream", { delta: "Here is " }),
			mkEntry(6, "acp", "stream", { delta: "the answer" }),
			mkEntry(7, "runtime", "lifecycle", { phase: "end" }),
		];
		const display = buildUnifiedDisplay(entries, false);

		// event(task_init), event(lifecycle:start), tool-call-group(tc-1),
		// stream-group, event(lifecycle:end)
		expect(display).toHaveLength(5);
		expect(display[0]?.kind).toBe("event"); // task_init
		expect(display[1]?.kind).toBe("event"); // lifecycle:start
		expect(display[2]?.kind).toBe("tool-call-group"); // tc-1 group
		expect(display[3]?.kind).toBe("stream-group");
		expect(display[4]?.kind).toBe("event"); // lifecycle:end

		// tool-call-group contains all 3 tool events
		const tcg = display[2];
		expect(tcg?.kind === "tool-call-group" && tcg.toolCallId).toBe("tc-1");
		expect(tcg?.kind === "tool-call-group" && tcg.entries).toHaveLength(3);

		const sg = display[3];
		expect(sg?.kind === "stream-group" && sg?.totalChars).toBe(18);
	});

	it("groups tool_call and tool_result with same toolCallId", () => {
		const entries = [
			mkEntry(1, "acp", "tool_call", { tool: "ls", status: "pending", toolCallId: "tc-1" }),
			mkEntry(2, "acp", "tool_result", { tool: "ls", result: "ok", toolCallId: "tc-1" }),
		];
		const display = buildUnifiedDisplay(entries, false);
		expect(display).toHaveLength(1);
		expect(display[0]?.kind).toBe("tool-call-group");
		const g = display[0];
		expect(g?.kind === "tool-call-group" && g.toolCallId).toBe("tc-1");
		expect(g?.kind === "tool-call-group" && g.entries).toHaveLength(2);
		expect(g?.kind === "tool-call-group" && g.isLive).toBe(false);
	});
});

// ── Round color utilities ────────────────────────────────────────────

describe("roundHue", () => {
	it("returns 0 for round 1", () => {
		expect(roundHue(1)).toBe(0);
	});

	it("returns distinct hues for consecutive rounds", () => {
		const hues = Array.from({ length: 12 }, (_, i) => roundHue(i + 1));
		const unique = new Set(hues.map((h) => Math.round(h)));
		expect(unique.size).toBe(12);
	});

	it("wraps around within 0-360", () => {
		for (let r = 1; r <= 20; r++) {
			const h = roundHue(r);
			expect(h).toBeGreaterThanOrEqual(0);
			expect(h).toBeLessThan(360);
		}
	});
});

describe("roundBorderClass", () => {
	it("returns valid Tailwind border class for any round", () => {
		for (let r = 1; r <= 15; r++) {
			expect(roundBorderClass(r)).toMatch(/^border-\w+-500$/);
		}
	});
});

describe("roundTextClass", () => {
	it("returns valid Tailwind text class for any round", () => {
		for (let r = 1; r <= 15; r++) {
			expect(roundTextClass(r)).toMatch(/^text-\w+-400$/);
		}
	});
});

describe("roundBgStyle", () => {
	it("returns undefined for round 0", () => {
		expect(roundBgStyle(0)).toBeUndefined();
	});

	it("returns an hsla backgroundColor for positive rounds", () => {
		const style = roundBgStyle(1);
		expect(style).toBeDefined();
		expect(style?.backgroundColor).toMatch(/^hsla\(/);
	});

	it("produces distinct bg colors for many rounds", () => {
		const colors = Array.from({ length: 20 }, (_, i) => roundBgStyle(i + 1)?.backgroundColor);
		const unique = new Set(colors);
		expect(unique.size).toBe(20);
	});
});

// ── Thinking group collapsing ────────────────────────────────────────

describe("buildUnifiedDisplay — thinking groups", () => {
	it("collapses consecutive thinking events into a thinking-group", () => {
		const entries = [
			mkEntry(1, "acp", "thinking", { text: "Let me " }),
			mkEntry(2, "acp", "thinking", { text: "look at " }),
			mkEntry(3, "acp", "thinking", { text: "the tests" }),
		];
		const display = buildUnifiedDisplay(entries, false);
		expect(display).toHaveLength(1);
		expect(display[0]?.kind).toBe("thinking-group");
		const tg = display[0];
		expect(tg?.kind === "thinking-group" && tg.entries).toHaveLength(3);
		expect(tg?.kind === "thinking-group" && tg.totalChars).toBe(24);
		expect(tg?.kind === "thinking-group" && tg.isLive).toBe(false);
	});

	it("marks trailing thinking group as live when streaming", () => {
		const entries = [
			mkEntry(1, "acp", "thinking", { text: "hmm " }),
			mkEntry(2, "acp", "thinking", { text: "thinking..." }),
		];
		const display = buildUnifiedDisplay(entries, true);
		const tg = display[0];
		expect(tg?.kind === "thinking-group" && tg.isLive).toBe(true);
	});

	it("flushes thinking group before a tool_call", () => {
		const entries = [
			mkEntry(1, "acp", "thinking", { text: "I should read the file" }),
			mkEntry(2, "acp", "tool_call", { tool: "read_file", status: "pending", toolCallId: "tc-1" }),
		];
		const display = buildUnifiedDisplay(entries, false);
		// thinking-group, tool-call-group(tc-1)
		expect(display).toHaveLength(2);
		expect(display[0]?.kind).toBe("thinking-group");
		expect(display[1]?.kind).toBe("tool-call-group");
	});

	it("flushes thinking group before stream events", () => {
		const entries = [
			mkEntry(1, "acp", "thinking", { text: "planning" }),
			mkEntry(2, "acp", "stream", { delta: "Here is " }),
			mkEntry(3, "acp", "stream", { delta: "the answer" }),
		];
		const display = buildUnifiedDisplay(entries, false);
		// thinking-group, stream-group
		expect(display).toHaveLength(2);
		expect(display[0]?.kind).toBe("thinking-group");
		expect(display[1]?.kind).toBe("stream-group");
	});

	it("flushes stream group before thinking events", () => {
		const entries = [
			mkEntry(1, "acp", "stream", { delta: "partial " }),
			mkEntry(2, "acp", "thinking", { text: "wait, let me reconsider" }),
		];
		const display = buildUnifiedDisplay(entries, false);
		// stream-group, thinking-group
		expect(display).toHaveLength(2);
		expect(display[0]?.kind).toBe("stream-group");
		expect(display[1]?.kind).toBe("thinking-group");
	});

	it("creates separate thinking groups when interrupted by other events", () => {
		const entries = [
			mkEntry(1, "acp", "thinking", { text: "first thought" }),
			mkEntry(2, "acp", "tool_call", { tool: "ls", status: "pending", toolCallId: "tc-1" }),
			mkEntry(3, "acp", "tool_result", { tool: "ls", result: "ok", toolCallId: "tc-1" }),
			mkEntry(4, "acp", "thinking", { text: "second thought" }),
		];
		const display = buildUnifiedDisplay(entries, false);
		const thinkingGroups = display.filter((d) => d.kind === "thinking-group");
		expect(thinkingGroups).toHaveLength(2);
		// Also verify the tool events formed a group
		const toolGroups = display.filter((d) => d.kind === "tool-call-group");
		expect(toolGroups).toHaveLength(1);
	});
});

// ── Plan and usage events ────────────────────────────────────────────

describe("buildUnifiedDisplay — plan and usage events", () => {
	it("renders plan events as individual event items", () => {
		const entries = [
			mkEntry(1, "acp", "plan", {
				entries: [
					{ content: "Read config", priority: "high", status: "completed" },
					{ content: "Update tests", priority: "medium", status: "pending" },
				],
			}),
		];
		const display = buildUnifiedDisplay(entries, false);
		expect(display).toHaveLength(1);
		expect(display[0]?.kind).toBe("event");
		expect(display[0]?.kind === "event" && display[0].entry.event.type).toBe("plan");
	});

	it("renders usage events as individual event items", () => {
		const entries = [mkEntry(1, "acp", "usage", { used: 50000, size: 200000 })];
		const display = buildUnifiedDisplay(entries, false);
		expect(display).toHaveLength(1);
		expect(display[0]?.kind).toBe("event");
		expect(display[0]?.kind === "event" && display[0].entry.event.type).toBe("usage");
	});
});

// ── Tool-call grouping by toolCallId ─────────────────────────────────

describe("buildUnifiedDisplay — tool-call-group", () => {
	it("groups pending → result → completed into one tool-call-group", () => {
		const entries = [
			mkEntry(1, "acp", "tool_call", { tool: "read_file", status: "pending", toolCallId: "tc-1" }),
			mkEntry(2, "acp", "tool_result", {
				tool: "read_file",
				result: "contents",
				toolCallId: "tc-1",
			}),
			mkEntry(3, "acp", "tool_call", {
				tool: "read_file",
				status: "completed",
				toolCallId: "tc-1",
			}),
		];
		const display = buildUnifiedDisplay(entries, false);
		expect(display).toHaveLength(1);
		expect(display[0]?.kind).toBe("tool-call-group");
		const g = display[0];
		expect(g?.kind === "tool-call-group" && g.toolCallId).toBe("tc-1");
		expect(g?.kind === "tool-call-group" && g.entries).toHaveLength(3);
		expect(g?.kind === "tool-call-group" && g.isLive).toBe(false);
	});

	it("marks trailing tool-call-group as live when streaming and no terminal status", () => {
		const entries = [
			mkEntry(1, "acp", "tool_call", { tool: "shell", status: "pending", toolCallId: "tc-1" }),
		];
		const display = buildUnifiedDisplay(entries, true);
		expect(display).toHaveLength(1);
		expect(display[0]?.kind).toBe("tool-call-group");
		const g = display[0];
		expect(g?.kind === "tool-call-group" && g.isLive).toBe(true);
	});

	it("marks tool-call-group as not-live when completed even if streaming", () => {
		const entries = [
			mkEntry(1, "acp", "tool_call", { tool: "shell", status: "pending", toolCallId: "tc-1" }),
			mkEntry(2, "acp", "tool_call", { tool: "shell", status: "completed", toolCallId: "tc-1" }),
		];
		const display = buildUnifiedDisplay(entries, true);
		const g = display[0];
		expect(g?.kind === "tool-call-group" && g.isLive).toBe(false);
	});

	it("marks trailing tool-call-group as not-live when not streaming", () => {
		const entries = [
			mkEntry(1, "acp", "tool_call", { tool: "shell", status: "pending", toolCallId: "tc-1" }),
		];
		const display = buildUnifiedDisplay(entries, false);
		const g = display[0];
		expect(g?.kind === "tool-call-group" && g.isLive).toBe(false);
	});

	it("keeps tool events without toolCallId as standalone events", () => {
		const entries = [
			mkEntry(1, "acp", "tool_call", { tool: "legacy", status: "pending" }),
			mkEntry(2, "acp", "tool_result", { tool: "legacy", result: "ok" }),
		];
		const display = buildUnifiedDisplay(entries, false);
		expect(display).toHaveLength(2);
		expect(display.every((d) => d.kind === "event")).toBe(true);
	});

	it("creates separate groups for different toolCallIds", () => {
		const entries = [
			mkEntry(1, "acp", "tool_call", { tool: "ls", status: "pending", toolCallId: "tc-1" }),
			mkEntry(2, "acp", "tool_result", { tool: "ls", result: "files", toolCallId: "tc-1" }),
			mkEntry(3, "acp", "tool_call", { tool: "cat", status: "pending", toolCallId: "tc-2" }),
			mkEntry(4, "acp", "tool_result", { tool: "cat", result: "data", toolCallId: "tc-2" }),
		];
		const display = buildUnifiedDisplay(entries, false);
		expect(display).toHaveLength(2);
		expect(display[0]?.kind).toBe("tool-call-group");
		expect(display[1]?.kind).toBe("tool-call-group");
		expect(display[0]?.kind === "tool-call-group" && display[0].toolCallId).toBe("tc-1");
		expect(display[1]?.kind === "tool-call-group" && display[1].toolCallId).toBe("tc-2");
	});

	it("emits tool-call-group before stream events", () => {
		const entries = [
			mkEntry(1, "acp", "tool_call", { tool: "ls", status: "pending", toolCallId: "tc-1" }),
			mkEntry(2, "acp", "tool_result", { tool: "ls", result: "ok", toolCallId: "tc-1" }),
			mkEntry(3, "acp", "tool_call", { tool: "ls", status: "completed", toolCallId: "tc-1" }),
			mkEntry(4, "acp", "stream", { delta: "Here are the files" }),
		];
		const display = buildUnifiedDisplay(entries, false);
		expect(display).toHaveLength(2);
		expect(display[0]?.kind).toBe("tool-call-group");
		expect(display[1]?.kind).toBe("stream-group");
	});

	it("emits tool-call-group before lifecycle events", () => {
		const entries = [
			mkEntry(1, "acp", "tool_call", { tool: "ls", status: "pending", toolCallId: "tc-1" }),
			mkEntry(2, "runtime", "lifecycle", { phase: "end" }),
		];
		const display = buildUnifiedDisplay(entries, false);
		expect(display).toHaveLength(2);
		expect(display[0]?.kind).toBe("tool-call-group");
		expect(display[1]?.kind).toBe("event");
	});

	it("handles mixed toolCallId and no-toolCallId tool events", () => {
		const entries = [
			mkEntry(1, "acp", "tool_call", { tool: "new_tool", status: "pending", toolCallId: "tc-1" }),
			mkEntry(2, "acp", "tool_result", { tool: "new_tool", result: "ok", toolCallId: "tc-1" }),
			mkEntry(3, "acp", "tool_call", { tool: "legacy", status: "pending" }),
		];
		const display = buildUnifiedDisplay(entries, false);
		expect(display).toHaveLength(2);
		expect(display[0]?.kind).toBe("tool-call-group");
		expect(display[1]?.kind).toBe("event");
	});
});

// ── Interleaved tool events (real ACP patterns) ──────────────────────

describe("buildUnifiedDisplay — interleaved tool events", () => {
	it("groups tool events split by thinking chunks", () => {
		// Real ACP pattern: thinking arrives between pending and result
		const entries = [
			mkEntry(1, "acp", "tool_call", {
				tool: "read_file",
				status: "pending",
				toolCallId: "tc-1",
			}),
			mkEntry(2, "acp", "thinking", { text: "Reading the file..." }),
			mkEntry(3, "acp", "thinking", { text: "This looks like config" }),
			mkEntry(4, "acp", "tool_result", {
				tool: "read_file",
				result: "file contents",
				toolCallId: "tc-1",
			}),
			mkEntry(5, "acp", "tool_call", {
				tool: "read_file",
				status: "completed",
				toolCallId: "tc-1",
			}),
		];
		const display = buildUnifiedDisplay(entries, false);

		// tool-call-group(tc-1, 3 entries), thinking-group(2 entries)
		expect(display).toHaveLength(2);
		expect(display[0]?.kind).toBe("tool-call-group");
		expect(display[1]?.kind).toBe("thinking-group");

		const tcg = display[0];
		expect(tcg?.kind === "tool-call-group" && tcg.toolCallId).toBe("tc-1");
		expect(tcg?.kind === "tool-call-group" && tcg.entries).toHaveLength(3);
		// Group should contain pending, result, completed in order
		if (tcg?.kind === "tool-call-group") {
			expect(tcg.entries[0]?.event.status).toBe("pending");
			expect(tcg.entries[1]?.event.type).toBe("tool_result");
			expect(tcg.entries[2]?.event.status).toBe("completed");
		}
	});

	it("groups parallel tool calls with interleaved events", () => {
		// Real ACP pattern: multiple tools dispatched, results interleave
		const entries = [
			mkEntry(1, "acp", "tool_call", {
				tool: "read_file",
				status: "pending",
				toolCallId: "tc-A",
			}),
			mkEntry(2, "acp", "tool_call", {
				tool: "list_dir",
				status: "pending",
				toolCallId: "tc-B",
			}),
			mkEntry(3, "acp", "tool_call", {
				tool: "grep",
				status: "pending",
				toolCallId: "tc-C",
			}),
			mkEntry(4, "acp", "tool_result", {
				tool: "list_dir",
				result: "files",
				toolCallId: "tc-B",
			}),
			mkEntry(5, "acp", "tool_call", {
				tool: "list_dir",
				status: "completed",
				toolCallId: "tc-B",
			}),
			mkEntry(6, "acp", "tool_result", {
				tool: "read_file",
				result: "content",
				toolCallId: "tc-A",
			}),
			mkEntry(7, "acp", "tool_call", {
				tool: "read_file",
				status: "completed",
				toolCallId: "tc-A",
			}),
			mkEntry(8, "acp", "tool_result", {
				tool: "grep",
				result: "matches",
				toolCallId: "tc-C",
			}),
			mkEntry(9, "acp", "tool_call", {
				tool: "grep",
				status: "completed",
				toolCallId: "tc-C",
			}),
		];
		const display = buildUnifiedDisplay(entries, false);

		// 3 tool-call-groups, ordered by first occurrence
		expect(display).toHaveLength(3);
		expect(display[0]?.kind).toBe("tool-call-group");
		expect(display[1]?.kind).toBe("tool-call-group");
		expect(display[2]?.kind).toBe("tool-call-group");

		// Order follows first event appearance: tc-A, tc-B, tc-C
		expect(display[0]?.kind === "tool-call-group" && display[0].toolCallId).toBe("tc-A");
		expect(display[1]?.kind === "tool-call-group" && display[1].toolCallId).toBe("tc-B");
		expect(display[2]?.kind === "tool-call-group" && display[2].toolCallId).toBe("tc-C");

		// Each group collected all its events
		expect(display[0]?.kind === "tool-call-group" && display[0].entries).toHaveLength(3);
		expect(display[1]?.kind === "tool-call-group" && display[1].entries).toHaveLength(3);
		expect(display[2]?.kind === "tool-call-group" && display[2].entries).toHaveLength(3);
	});

	it("reproduces real ACP trace: thinking + parallel tools + stream", () => {
		// Sequence matching the screenshot pattern
		const entries = [
			mkEntry(0, "system", "task_init", { prompt: "analyze workspace" }),
			mkEntry(1, "runtime", "lifecycle", { phase: "start" }),
			mkEntry(2, "runtime", "lifecycle", { phase: "prompt_sent" }),
			mkEntry(3, "acp", "thinking", { text: "Let me look at the workspace" }),
			// First tool: skill use
			mkEntry(4, "acp", "tool_result", {
				tool: "use_skill",
				result: { message: "Skill not found" },
				toolCallId: "tc-skill",
			}),
			mkEntry(5, "acp", "tool_call", {
				tool: "use_skill",
				status: "pending",
				kind: "other",
				toolCallId: "tc-skill",
			}),
			// Thinking interrupts
			mkEntry(6, "acp", "thinking", { text: "I'll read the files directly" }),
			// Parallel reads dispatched
			mkEntry(7, "acp", "tool_call", {
				tool: "read_file",
				status: "pending",
				kind: "read",
				toolCallId: "tc-read-skill",
			}),
			mkEntry(8, "acp", "thinking", { text: "checking" }),
			mkEntry(9, "acp", "tool_call", {
				tool: "read_file",
				status: "completed",
				kind: "read",
				toolCallId: "tc-read-skill",
			}),
			mkEntry(10, "acp", "tool_call", {
				tool: "read_file",
				status: "pending",
				kind: "read",
				toolCallId: "tc-read-pkg",
			}),
			mkEntry(11, "acp", "tool_call", {
				tool: "read_file",
				status: "pending",
				kind: "read",
				toolCallId: "tc-read-readme",
			}),
			mkEntry(12, "acp", "tool_call", {
				tool: "read_file",
				status: "completed",
				kind: "read",
				toolCallId: "tc-read-readme",
			}),
			mkEntry(13, "acp", "tool_result", {
				tool: "read_file",
				result: "readme content",
				toolCallId: "tc-read-readme",
			}),
			mkEntry(14, "acp", "tool_call", {
				tool: "execute",
				status: "completed",
				kind: "execute",
				toolCallId: "tc-git",
			}),
			mkEntry(15, "acp", "tool_result", {
				tool: "execute",
				result: "commit log",
				toolCallId: "tc-git",
			}),
			mkEntry(16, "acp", "stream", { delta: "Here is my analysis" }),
			mkEntry(17, "runtime", "lifecycle", { phase: "end" }),
		];
		const display = buildUnifiedDisplay(entries, false);

		// Expected: task_init, lifecycle:start, lifecycle:prompt_sent,
		// thinking-group(seq3), tool-call-group(tc-skill),
		// thinking-group(seq6), tool-call-group(tc-read-skill),
		// thinking-group(seq8), tool-call-group(tc-read-pkg),
		// tool-call-group(tc-read-readme), tool-call-group(tc-git),
		// stream-group, lifecycle:end
		const kinds = display.map((d) => d.kind);
		expect(kinds).toEqual([
			"event", // task_init
			"event", // lifecycle:start
			"event", // lifecycle:prompt_sent
			"thinking-group", // thinking seq 3
			"tool-call-group", // tc-skill (first seen at seq 4)
			"thinking-group", // thinking seq 6 (separated by tc-skill group)
			"tool-call-group", // tc-read-skill (first seen at seq 7)
			"thinking-group", // thinking seq 8 (separated by tc-read-skill group)
			"tool-call-group", // tc-read-pkg (first seen at seq 10)
			"tool-call-group", // tc-read-readme (first seen at seq 11)
			"tool-call-group", // tc-git (first seen at seq 14)
			"stream-group", // delta
			"event", // lifecycle:end
		]);

		// Verify tc-skill collected both its events (result + pending)
		const skillGroup = display.find(
			(d) => d.kind === "tool-call-group" && d.toolCallId === "tc-skill",
		);
		expect(skillGroup?.kind === "tool-call-group" && skillGroup.entries).toHaveLength(2);

		// Verify tc-read-readme collected all 3 events despite interleaving
		const readmeGroup = display.find(
			(d) => d.kind === "tool-call-group" && d.toolCallId === "tc-read-readme",
		);
		expect(readmeGroup?.kind === "tool-call-group" && readmeGroup.entries).toHaveLength(3);
	});

	it("marks only incomplete tool groups as live during streaming", () => {
		const entries = [
			mkEntry(1, "acp", "tool_call", {
				tool: "done_tool",
				status: "pending",
				toolCallId: "tc-done",
			}),
			mkEntry(2, "acp", "tool_call", {
				tool: "running_tool",
				status: "pending",
				toolCallId: "tc-running",
			}),
			mkEntry(3, "acp", "tool_call", {
				tool: "done_tool",
				status: "completed",
				toolCallId: "tc-done",
			}),
		];
		const display = buildUnifiedDisplay(entries, true);
		expect(display).toHaveLength(2);

		// tc-done has completed status → not live
		const doneGroup = display.find(
			(d) => d.kind === "tool-call-group" && d.toolCallId === "tc-done",
		);
		expect(doneGroup?.kind === "tool-call-group" && doneGroup.isLive).toBe(false);

		// tc-running has no terminal status → live
		const runningGroup = display.find(
			(d) => d.kind === "tool-call-group" && d.toolCallId === "tc-running",
		);
		expect(runningGroup?.kind === "tool-call-group" && runningGroup.isLive).toBe(true);
	});
});
