// LOCAL PATCH(agents-view-active-ancestors): whole file is local. Delete it together with the
// promoteAncestorsOfRunningRows block in agents-view-state.ts once upstream puts a session with a
// busy descendant in the Running section by itself.
// DROP TEST, one command: delete the LOCAL PATCH function and its marked call site in
// agents-view-state.ts, then run
//   npx vitest --run packages/coding-agent/test/agents-view-active-ancestors.test.ts
// If this file still passes without them, upstream does this natively and the workaround is dead:
// delete both blocks AND this whole file.
import { describe, expect, test } from "vitest";
import { buildAgentsViewRows } from "../src/modes/agents-view/agents-view-state.js";
import type { SessionSummary } from "../src/modes/index.js";

function makeSummary(overrides: Partial<SessionSummary>): SessionSummary {
	return {
		id: overrides.activeSessionId ?? "active-parent",
		lifecycle: "live",
		activity: "idle",
		isSessionActive: false,
		sessionId: "session-parent",
		cwd: "/tmp/project",
		isStreaming: false,
		isCompacting: false,
		attachedClients: 0,
		messageCount: 1,
		sessionActions: { queuedCount: 0, steering: [], followUps: [] },
		...overrides,
	};
}

// A parent whose own roster row says idle: nothing in its snapshot knows about a busy subtree,
// because hasRunningRlmChildren only counts child runs that are still running or queued.
const idleParent = makeSummary({
	activeSessionId: "active-parent",
	sessionId: "session-parent",
	sessionName: "parent",
	rosterStatus: "idle",
});

function child(overrides: Partial<SessionSummary>): SessionSummary {
	return makeSummary({
		activeSessionId: "active-child",
		sessionId: "session-child",
		sessionName: "child",
		runtimeKind: "subagent",
		rlmChildId: "c1",
		parentActiveSessionId: "active-parent",
		parentSessionId: "session-parent",
		...overrides,
	});
}

function grandchild(overrides: Partial<SessionSummary>): SessionSummary {
	return makeSummary({
		activeSessionId: "active-grandchild",
		sessionId: "session-grandchild",
		sessionName: "grandchild",
		runtimeKind: "subagent",
		rlmChildId: "c2",
		parentActiveSessionId: "active-child",
		parentSessionId: "session-child",
		...overrides,
	});
}

const streamingChild = child({
	activity: "working",
	isSessionActive: true,
	isStreaming: true,
	rosterStatus: "running",
});
const toolChild = child({ activity: "working", isSessionActive: true, isRunningTools: true, rosterStatus: "running" });
// An admitted child run has no active session yet; the roster still classifies it as running.
const queuedChild = child({
	id: "queued-child",
	activeSessionId: undefined,
	rosterStatus: "running",
	statusLabel: "queued",
});
const idleChild = child({ rosterStatus: "idle" });

// Nested rows are only emitted under an expanded parent, so expand every identity the tree exposes.
function expandedRows(summaries: readonly SessionSummary[]): ReturnType<typeof buildAgentsViewRows> {
	const expanded = new Set<string>();
	let rows = buildAgentsViewRows(summaries, expanded);
	for (let pass = 0; pass < 5; pass += 1) {
		const before = expanded.size;
		for (const row of rows) expanded.add(row.identity);
		if (expanded.size === before) break;
		rows = buildAgentsViewRows(summaries, expanded);
	}
	return rows;
}

function sessionRow(summaries: readonly SessionSummary[], sessionId: string) {
	return expandedRows(summaries).find(
		(row) => (row.kind === "agent" || row.kind === "subagent") && row.summary.sessionId === sessionId,
	);
}

function sectionOf(summaries: readonly SessionSummary[], sessionId: string): string | undefined {
	return sessionRow(summaries, sessionId)?.section;
}

describe("agents view: a session with a busy descendant renders as running", () => {
	test("an idle parent of a streaming child is running", () => {
		expect(sectionOf([idleParent, streamingChild], "session-parent")).toBe("running");
	});

	test("an idle parent of a child running tools is running", () => {
		expect(sectionOf([idleParent, toolChild], "session-parent")).toBe("running");
	});

	test("an idle parent of a queued child is running", () => {
		expect(sectionOf([idleParent, queuedChild], "session-parent")).toBe("running");
	});

	test("a busy grandchild promotes both the idle child and the idle parent", () => {
		const rows = [
			idleParent,
			idleChild,
			grandchild({ activity: "working", isSessionActive: true, isStreaming: true, rosterStatus: "running" }),
		];
		expect(sectionOf(rows, "session-parent")).toBe("running");
		expect(sectionOf(rows, "session-child")).toBe("running");
	});

	test("a promoted ancestor reports its busy subtree in the status label and the child tally", () => {
		const summaries = [
			idleParent,
			idleChild,
			grandchild({ isSessionActive: true, isStreaming: true, rosterStatus: "running" }),
		];
		const parentRow = sessionRow(summaries, "session-parent");
		expect(parentRow?.statusLabel).toBe("subagents running");
		expect(parentRow?.runningSubagentCount).toBe(1);
	});

	test("an idle subtree leaves the parent idle", () => {
		expect(sectionOf([idleParent, idleChild], "session-parent")).toBe("idle");
		expect(sectionOf([idleParent, idleChild], "session-child")).toBe("idle");
	});

	test("an inactive ancestor is not pulled into running", () => {
		const inactiveParent = makeSummary({
			activeSessionId: undefined,
			sessionId: "session-parent",
			sessionName: "parent",
			rosterStatus: "inactive",
		});
		expect(sectionOf([inactiveParent, streamingChild], "session-parent")).toBe("inactive");
	});

	test("a session with no children is left alone", () => {
		expect(sectionOf([idleParent], "session-parent")).toBe("idle");
	});
});
