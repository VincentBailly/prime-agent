// LOCAL PATCH(agents-view-done-in-running): whole file is local. Delete together with the
// guard in agents-view-state.ts once upstream fixes #1873 / lands #1967.
// DROP TEST: delete the LOCAL PATCH block in agents-view-state.ts, then run
//   npx vitest --run packages/coding-agent/test/agents-view-done-in-running.test.ts
// If this test still passes without that block, upstream classifies finished agents correctly and this
// workaround is dead: delete that block AND this whole file.
import { describe, expect, test } from "vitest";
import { classifyAgentsViewSession, classifyUnifiedSession } from "../src/modes/agents-view/agents-view-state.js";
import type { SessionSummary } from "../src/modes/index.js";

function makeSummary(overrides: Partial<SessionSummary>): SessionSummary {
	return {
		id: "active-1",
		activeSessionId: "active-1",
		lifecycle: "live",
		activity: "idle",
		isSessionActive: false,
		sessionId: "session-1",
		cwd: "/tmp/project",
		isStreaming: false,
		isCompacting: false,
		attachedClients: 0,
		messageCount: 1,
		sessionActions: { queuedCount: 0, steering: [], followUps: [] },
		...overrides,
	};
}

// A finished top-level agent whose roster row was frozen at turn_end: the summarizer verdict never
// changed, so no roster flush recomposed the row and rosterStatus stayed "running".
const staleFinished = makeSummary({ activity: "working", rosterStatus: "running" });

describe("agents view: finished agents leave the Running section", () => {
	test("a frozen running rosterStatus with no live busy signal classifies as idle", () => {
		expect(classifyAgentsViewSession(staleFinished)).toBe("idle");
		expect(classifyUnifiedSession({ daemon: staleFinished })).toBe("idle");
	});

	test("a streaming or tool-running agent stays running", () => {
		const streaming = makeSummary({
			activity: "working",
			isSessionActive: true,
			isStreaming: true,
			rosterStatus: "running",
		});
		expect(classifyAgentsViewSession(streaming)).toBe("running");
	});

	test("an agent with running rlm children stays running", () => {
		const withChildren = makeSummary({
			activity: "working",
			hasRunningRlmChildren: true,
			rosterStatus: "running",
		});
		expect(classifyAgentsViewSession(withChildren)).toBe("running");
	});

	test("a queued child row stays running", () => {
		const queued = makeSummary({
			activity: "idle",
			activeSessionId: undefined,
			rosterStatus: "running",
			statusLabel: "queued",
		});
		expect(classifyAgentsViewSession(queued)).toBe("running");
	});

	test("a heartbeat-armed session stays running", () => {
		const armed = makeSummary({ activity: "idle", hasActiveHeartbeat: true, rosterStatus: "running" });
		expect(classifyAgentsViewSession(armed)).toBe("running");
		expect(classifyUnifiedSession({ daemon: staleFinished, heartbeat: { activeCount: 1 } })).toBe("running");
	});

	test("idle and inactive roster statuses are passed through untouched", () => {
		expect(classifyAgentsViewSession(makeSummary({ rosterStatus: "idle" }))).toBe("idle");
		expect(classifyAgentsViewSession(makeSummary({ rosterStatus: "inactive" }))).toBe("inactive");
		expect(classifyAgentsViewSession(makeSummary({ activity: "working" }))).toBe("running");
	});
});
