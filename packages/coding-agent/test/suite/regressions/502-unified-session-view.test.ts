import stripAnsi from "strip-ansi";
import { describe, expect, test, vi } from "vitest";
import { AgentsViewMode } from "../../../src/modes/agents-view/agents-view-mode.js";
import type { SessionSummary } from "../../../src/modes/daemon/daemon-session-list.js";
import { initTheme } from "../../../src/modes/interactive/theme/theme.js";
import { createDeferred as deferred } from "../scheduling.js";

function summary(id: string): SessionSummary {
	return {
		id,
		activeSessionId: id,
		sessionId: `session-${id}`,
		lifecycle: "live",
		activity: "idle",
		isSessionActive: false,
		cwd: "/tmp/project",
		isStreaming: false,
		isCompacting: false,
		attachedClients: 0,
		messageCount: 1,
		sessionActions: { queuedCount: 0, steering: [], followUps: [] },
	};
}

function rawSavedSession(id: string) {
	return {
		path: `/tmp/${id}.jsonl`,
		id,
		cwd: "/tmp/project",
		state: "idle",
		created: new Date(0).toISOString(),
		modified: new Date(0).toISOString(),
		messageCount: 1,
	};
}

function savedSession(id: string) {
	return { path: `/tmp/${id}.jsonl`, id };
}

// The daemon tags every streamed item with the originating request id, and
// `isDaemonRequestProgress` drops any progress message without a string `id`.
const SAVED_SESSION_REQUEST_ID = "list-saved-sessions-1";

function savedSessionListItem(id: string) {
	return {
		id: SAVED_SESSION_REQUEST_ID,
		type: "session_list_item" as const,
		command: "list_saved_sessions" as const,
		session: rawSavedSession(id),
	};
}

function savedPaths(sessions: readonly unknown[] | undefined): string[] {
	return (sessions ?? []).map((session) => (session as { path: string }).path);
}

type SavedCatalogProgressTimer = { generation: number; timeout: ReturnType<typeof setTimeout> } | undefined;

function refreshHarness() {
	const applySessionList = vi.fn();
	const reconcileCatalogs = vi.fn();
	const persistentState: {
		savedSessions?: unknown[];
		lastSuccessfulSavedSessions?: unknown[];
		heartbeats?: unknown[];
		savedCatalogGeneration?: number;
	} = {};
	return {
		reconnectPromise: undefined,
		daemonShutdownReceived: false,
		options: {},
		liveCatalogGeneration: 0,
		savedCatalogGeneration: 0,
		heartbeatCatalogGeneration: 0,
		liveCatalogRefreshPending: false,
		savedCatalogRefreshPending: false,
		heartbeats: [] as unknown[],
		savedCatalogProgressTimer: undefined as SavedCatalogProgressTimer,
		// The throttle runs through the real private helpers, so the harness borrows them.
		clearSavedCatalogProgressTimer: privateMethod<() => void>("clearSavedCatalogProgressTimer"),
		armSavedCatalogProgressTimer:
			privateMethod<(generation: number, onElapsed: () => void) => void>("armSavedCatalogProgressTimer"),
		persistentState,
		applySessionList,
		reconcileCatalogs,
		resolveMissingSelectionAnchor: vi.fn(),
		setStatusMessage: vi.fn(),
		startClientReconnect: vi.fn(),
	};
}

function privateMethod<T>(name: string): T {
	const member = Reflect.get(AgentsViewMode.prototype, name) as T;
	if (typeof member !== "function") {
		throw new Error(`AgentsViewMode.${name} no longer exists; update this regression harness`);
	}
	return member;
}

describe("#502 unified session view regressions", () => {
	test.each(["live", "heartbeat"] as const)(
		"an older overlapping %s poll cannot overwrite the newer response",
		async (kind) => {
			const old = deferred<unknown>();
			const newer = kind === "live" ? summary("new") : { job: { id: "new" } };
			const client = {
				isConnected: true,
				hello: { protocol: { version: 3 } },
				supportsServerCapability: () => true,
				request: vi
					.fn()
					.mockReturnValueOnce(old.promise)
					.mockResolvedValueOnce({
						success: true,
						data: kind === "live" ? { sessions: [newer] } : { heartbeats: [newer] },
					}),
			};
			const harness = { ...refreshHarness(), requireClient: () => client };
			const refresh = privateMethod<(this: typeof harness) => Promise<unknown>>(
				kind === "live" ? "refreshSessions" : "refreshHeartbeats",
			);

			const oldPoll = refresh.call(harness);
			await refresh.call(harness);
			old.resolve({
				success: true,
				data: kind === "live" ? { sessions: [summary("old")] } : { heartbeats: [{ job: { id: "old" } }] },
			});
			await oldPoll;

			if (kind === "live") expect(harness.applySessionList).toHaveBeenCalledWith([newer], true);
			else expect(harness.heartbeats).toEqual([newer]);
			expect(kind === "live" ? harness.applySessionList : harness.reconcileCatalogs).toHaveBeenCalledOnce();
		},
	);

	test("overlapping saved scans retain the last complete catalog after the newest scan fails", async () => {
		const previous = [savedSession("previous")];
		const older = deferred<{ success: true; data: { sessions: unknown[] } }>();
		const client = {
			request: vi
				.fn()
				.mockReturnValueOnce(older.promise)
				.mockImplementationOnce(
					async (
						_command: unknown,
						_timeout: unknown,
						options: { onProgress: (update: { type: string; session: unknown }) => void },
					) => {
						options.onProgress(savedSessionListItem("streamed"));
						throw new Error("scan failed");
					},
				),
		};
		const harness = {
			...refreshHarness(),
			savedSessions: previous,
			lastSuccessfulSavedSessions: previous,
			requireClient: () => client,
			getSavedSessionCatalogContext: () => ({ cwd: "/tmp/project" }),
		};
		harness.persistentState.savedSessions = previous;
		const refresh = privateMethod<(this: typeof harness) => Promise<boolean>>("refreshSavedSessions");

		const oldScan = refresh.call(harness);
		await Promise.resolve();
		expect(await refresh.call(harness)).toBe(false);
		older.resolve({ success: true, data: { sessions: [rawSavedSession("stale")] } });
		expect(await oldScan).toBe(false);

		expect([harness.savedSessions, harness.persistentState.savedSessions]).toEqual([previous, previous]);
		expect(harness.savedCatalogRefreshPending).toBe(false);
	});

	test("batches streamed saved sessions and immediately applies the authoritative final catalog", async () => {
		vi.useFakeTimers();
		try {
			const response = deferred<{ success: true; data: { sessions: ReturnType<typeof rawSavedSession>[] } }>();
			let onProgress: ((update: ReturnType<typeof savedSessionListItem>) => void) | undefined;
			const client = {
				request: vi.fn(
					(
						_command: unknown,
						_timeout: unknown,
						options: { onProgress: (update: ReturnType<typeof savedSessionListItem>) => void },
					) => {
						onProgress = options.onProgress;
						return response.promise;
					},
				),
			};
			const previous = [savedSession("previous")];
			const harness = {
				...refreshHarness(),
				savedSessions: previous,
				lastSuccessfulSavedSessions: previous,
				requireClient: () => client,
				getSavedSessionCatalogContext: () => ({ cwd: "/tmp/project" }),
			};
			const refresh = privateMethod<(this: typeof harness) => Promise<boolean>>("refreshSavedSessions");

			const pending = refresh.call(harness);
			expect(onProgress).toBeDefined();
			onProgress?.(savedSessionListItem("streamed-a"));
			// Leading edge: the first streamed session is never held back by the throttle.
			expect(harness.reconcileCatalogs).toHaveBeenCalledOnce();
			expect(harness.savedSessions.map((session) => session.path)).toEqual([
				"/tmp/previous.jsonl",
				"/tmp/streamed-a.jsonl",
			]);

			// Everything else inside the open window is coalesced into one trailing flush.
			onProgress?.(savedSessionListItem("streamed-b"));
			expect(harness.reconcileCatalogs).toHaveBeenCalledOnce();
			await vi.advanceTimersByTimeAsync(99);
			expect(harness.reconcileCatalogs).toHaveBeenCalledOnce();
			await vi.advanceTimersByTimeAsync(1);
			expect(harness.reconcileCatalogs).toHaveBeenCalledTimes(2);
			expect(harness.savedSessions.map((session) => session.path)).toEqual([
				"/tmp/previous.jsonl",
				"/tmp/streamed-a.jsonl",
				"/tmp/streamed-b.jsonl",
			]);

			onProgress?.(savedSessionListItem("streamed-c"));
			response.resolve({
				success: true,
				data: { sessions: [rawSavedSession("final-b"), rawSavedSession("final-a")] },
			});
			expect(await pending).toBe(true);
			expect(harness.savedSessions.map((session) => session.path)).toEqual([
				"/tmp/final-b.jsonl",
				"/tmp/final-a.jsonl",
			]);
			expect(harness.reconcileCatalogs).toHaveBeenCalledTimes(3);

			await vi.advanceTimersByTimeAsync(100);
			expect(harness.reconcileCatalogs).toHaveBeenCalledTimes(3);
		} finally {
			vi.useRealTimers();
		}
	});

	test("a long saved-session stream stays rate-bounded across throttle windows", async () => {
		vi.useFakeTimers();
		try {
			const response = deferred<{ success: true; data: { sessions: ReturnType<typeof rawSavedSession>[] } }>();
			let onProgress: ((update: ReturnType<typeof savedSessionListItem>) => void) | undefined;
			const client = {
				request: vi.fn(
					(
						_command: unknown,
						_timeout: unknown,
						options: { onProgress: (update: ReturnType<typeof savedSessionListItem>) => void },
					) => {
						onProgress = options.onProgress;
						return response.promise;
					},
				),
			};
			const harness = {
				...refreshHarness(),
				savedSessions: [] as ReturnType<typeof savedSession>[],
				lastSuccessfulSavedSessions: [] as ReturnType<typeof savedSession>[],
				requireClient: () => client,
				getSavedSessionCatalogContext: () => ({ cwd: "/tmp/project" }),
			};
			const refresh = privateMethod<(this: typeof harness) => Promise<boolean>>("refreshSavedSessions");

			const pending = refresh.call(harness);
			expect(onProgress).toBeDefined();

			const windows = 4;
			const perWindow = 25;
			for (let window = 0; window < windows; window += 1) {
				for (let index = 0; index < perWindow; index += 1) {
					onProgress?.(savedSessionListItem(`streamed-${window}-${index}`));
				}
				await vi.advanceTimersByTimeAsync(100);
			}
			const streamed = windows * perWindow;

			// One leading apply plus one trailing flush per elapsed window. The cost is bounded
			// by elapsed time, not by how many sessions the daemon streamed.
			expect(harness.reconcileCatalogs).toHaveBeenCalledTimes(windows + 1);
			// Coalescing must not drop anything: the trailing flush carries the whole window.
			expect(harness.savedSessions).toHaveLength(streamed);
			expect(savedPaths(harness.persistentState.savedSessions)).toHaveLength(streamed);

			response.resolve({ success: true, data: { sessions: [rawSavedSession("final")] } });
			expect(await pending).toBe(true);
			expect(harness.savedSessions.map((session) => session.path)).toEqual(["/tmp/final.jsonl"]);
			expect(harness.reconcileCatalogs).toHaveBeenCalledTimes(windows + 2);

			await vi.advanceTimersByTimeAsync(1000);
			expect(harness.reconcileCatalogs).toHaveBeenCalledTimes(windows + 2);
		} finally {
			vi.useRealTimers();
		}
	});

	test("throttled saved-session updates mirror into persistentState", async () => {
		vi.useFakeTimers();
		try {
			const response = deferred<{ success: true; data: { sessions: ReturnType<typeof rawSavedSession>[] } }>();
			let onProgress: ((update: ReturnType<typeof savedSessionListItem>) => void) | undefined;
			const client = {
				request: vi.fn(
					(
						_command: unknown,
						_timeout: unknown,
						options: { onProgress: (update: ReturnType<typeof savedSessionListItem>) => void },
					) => {
						onProgress = options.onProgress;
						return response.promise;
					},
				),
			};
			const previous = [savedSession("previous")];
			const harness = {
				...refreshHarness(),
				savedSessions: previous,
				lastSuccessfulSavedSessions: previous,
				requireClient: () => client,
				getSavedSessionCatalogContext: () => ({ cwd: "/tmp/project" }),
			};
			const refresh = privateMethod<(this: typeof harness) => Promise<boolean>>("refreshSavedSessions");

			const pending = refresh.call(harness);
			expect(onProgress).toBeDefined();

			onProgress?.(savedSessionListItem("leading"));
			expect(savedPaths(harness.persistentState.savedSessions)).toEqual([
				"/tmp/previous.jsonl",
				"/tmp/leading.jsonl",
			]);

			onProgress?.(savedSessionListItem("trailing"));
			expect(savedPaths(harness.persistentState.savedSessions)).toEqual([
				"/tmp/previous.jsonl",
				"/tmp/leading.jsonl",
			]);

			await vi.advanceTimersByTimeAsync(100);
			expect(savedPaths(harness.persistentState.savedSessions)).toEqual([
				"/tmp/previous.jsonl",
				"/tmp/leading.jsonl",
				"/tmp/trailing.jsonl",
			]);
			expect(harness.persistentState.savedSessions).toBe(harness.savedSessions);

			response.resolve({ success: true, data: { sessions: [rawSavedSession("final")] } });
			expect(await pending).toBe(true);
			expect(savedPaths(harness.persistentState.savedSessions)).toEqual(["/tmp/final.jsonl"]);
		} finally {
			vi.useRealTimers();
		}
	});

	test("cancels a delayed saved-session update before rolling back on error", async () => {
		vi.useFakeTimers();
		try {
			const response = deferred<{ success: true; data: { sessions: ReturnType<typeof rawSavedSession>[] } }>();
			let onProgress: ((update: ReturnType<typeof savedSessionListItem>) => void) | undefined;
			const client = {
				request: (
					_command: unknown,
					_timeout: unknown,
					options: { onProgress: (update: ReturnType<typeof savedSessionListItem>) => void },
				) => {
					onProgress = options.onProgress;
					return response.promise;
				},
			};
			const previous = [savedSession("previous")];
			const harness = {
				...refreshHarness(),
				savedSessions: previous,
				lastSuccessfulSavedSessions: previous,
				requireClient: () => client,
				getSavedSessionCatalogContext: () => ({ cwd: "/tmp/project" }),
			};
			const pending =
				privateMethod<(this: typeof harness) => Promise<boolean>>("refreshSavedSessions").call(harness);

			onProgress?.(savedSessionListItem("partial"));
			// Leading edge already rendered the partial catalog once.
			expect(harness.reconcileCatalogs).toHaveBeenCalledOnce();
			response.reject(new Error("scan failed"));
			expect(await pending).toBe(false);
			expect(harness.savedSessions).toEqual(previous);
			expect(harness.reconcileCatalogs).toHaveBeenCalledTimes(2);

			await vi.advanceTimersByTimeAsync(100);
			expect(harness.savedSessions).toEqual(previous);
			expect(harness.reconcileCatalogs).toHaveBeenCalledTimes(2);
		} finally {
			vi.useRealTimers();
		}
	});

	test("an older saved refresh cannot clear or apply a newer progress timer", async () => {
		vi.useFakeTimers();
		try {
			const older = deferred<{ success: true; data: { sessions: ReturnType<typeof rawSavedSession>[] } }>();
			const newer = deferred<{ success: true; data: { sessions: ReturnType<typeof rawSavedSession>[] } }>();
			const progress: Array<(update: ReturnType<typeof savedSessionListItem>) => void> = [];
			const client = {
				request: vi
					.fn()
					.mockImplementationOnce(
						(
							_command: unknown,
							_timeout: unknown,
							options: { onProgress: (update: ReturnType<typeof savedSessionListItem>) => void },
						) => {
							progress.push(options.onProgress);
							return older.promise;
						},
					)
					.mockImplementationOnce(
						(
							_command: unknown,
							_timeout: unknown,
							options: { onProgress: (update: ReturnType<typeof savedSessionListItem>) => void },
						) => {
							progress.push(options.onProgress);
							return newer.promise;
						},
					),
			};
			const previous = [savedSession("previous")];
			const harness = {
				...refreshHarness(),
				savedSessions: previous,
				lastSuccessfulSavedSessions: previous,
				requireClient: () => client,
				getSavedSessionCatalogContext: () => ({ cwd: "/tmp/project" }),
			};
			const refresh = privateMethod<(this: typeof harness) => Promise<boolean>>("refreshSavedSessions");

			const oldRefresh = refresh.call(harness);
			progress[0]?.(savedSessionListItem("old-progress"));
			const newRefresh = refresh.call(harness);
			progress[1]?.(savedSessionListItem("new-progress"));
			// Held back by the newer generation's open window, so it can only land on the
			// trailing flush the stale refresh must not cancel.
			progress[1]?.(savedSessionListItem("new-progress-late"));
			older.resolve({ success: true, data: { sessions: [rawSavedSession("old-final")] } });
			expect(await oldRefresh).toBe(false);
			expect(harness.reconcileCatalogs).toHaveBeenCalledTimes(2);

			await vi.advanceTimersByTimeAsync(100);
			expect(harness.savedSessions.map((session) => session.path)).toEqual([
				"/tmp/previous.jsonl",
				"/tmp/new-progress.jsonl",
				"/tmp/new-progress-late.jsonl",
			]);
			expect(harness.reconcileCatalogs).toHaveBeenCalledTimes(3);

			newer.resolve({ success: true, data: { sessions: [rawSavedSession("new-final")] } });
			expect(await newRefresh).toBe(true);
			expect(harness.savedSessions.map((session) => session.path)).toEqual(["/tmp/new-final.jsonl"]);
			expect(harness.reconcileCatalogs).toHaveBeenCalledTimes(4);
		} finally {
			vi.useRealTimers();
		}
	});

	test("finish cancels a pending saved-session progress timer before closing the client", async () => {
		vi.useFakeTimers();
		try {
			const delayedUpdate = vi.fn();
			const timeout = setTimeout(delayedUpdate, 100);
			const client = { close: vi.fn() };
			const harness = {
				stopped: false,
				savedCatalogProgressTimer: { generation: 1, timeout } as SavedCatalogProgressTimer,
				clearSavedCatalogProgressTimer: privateMethod<() => void>("clearSavedCatalogProgressTimer"),
				savedCatalogGeneration: 1,
				liveCatalogGeneration: 1,
				heartbeatCatalogGeneration: 1,
				pollTimer: undefined,
				heartbeatPollTimer: undefined,
				animationTimer: undefined,
				clearCtrlCExitHint: vi.fn(),
				clearDeleteConfirmation: vi.fn(),
				setStatusMessage: vi.fn(),
				ui: { stop: vi.fn() },
				unsubscribeClientClose: undefined,
				unsubscribeClientMessage: undefined,
				client,
				resolveRun: vi.fn(),
			};

			privateMethod<(this: typeof harness, result: { type: "exit" }) => void>("finish").call(harness, {
				type: "exit",
			});
			expect(harness.savedCatalogProgressTimer).toBeUndefined();
			expect(client.close).toHaveBeenCalledOnce();
			await vi.advanceTimersByTimeAsync(100);
			expect(delayedUpdate).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	test("reconnect retries the saved catalog and fences a stale startup scan", async () => {
		const previous = [savedSession("previous")];
		const startup = deferred<{ success: true; data: { sessions: unknown[] } }>();
		const retried = deferred<{ success: true; data: { sessions: unknown[] } }>();
		const replacement = savedSession("retried");
		const client = {
			request: vi.fn().mockReturnValueOnce(startup.promise).mockReturnValueOnce(retried.promise),
		};
		const harness = {
			...refreshHarness(),
			reconnectPromise: undefined as Promise<void> | undefined,
			savedSessions: previous,
			lastSuccessfulSavedSessions: previous,
			requireClient: () => client,
			getSavedSessionCatalogContext: () => ({ cwd: "/tmp/project" }),
		};
		harness.persistentState.savedSessions = previous;
		const refresh =
			privateMethod<
				(
					this: typeof harness,
					options?: { duringReconnect?: boolean; preserveStatusOnError?: boolean },
				) => Promise<boolean>
			>("refreshSavedSessions");

		harness.reconnectPromise = undefined;
		const startupScan = refresh.call(harness);
		harness.reconnectPromise = Promise.resolve();
		const retry = refresh.call(harness, { duringReconnect: true, preserveStatusOnError: true });
		expect(harness.savedCatalogGeneration).toBe(2);
		expect(harness.persistentState.savedCatalogGeneration).toBe(2);

		retried.resolve({ success: true, data: { sessions: [rawSavedSession("retried")] } });
		expect(await retry).toBe(true);
		startup.resolve({ success: true, data: { sessions: [rawSavedSession("stale")] } });
		expect(await startupScan).toBe(false);
		expect(harness.savedSessions).toEqual([expect.objectContaining({ path: replacement.path })]);
	});

	test("failed saved retry during reconnect preserves status and complete catalog", async () => {
		const previous = [savedSession("previous")];
		const client = {
			request: async (
				_command: unknown,
				_timeout: unknown,
				options: { onProgress: (update: { type: string; session: unknown }) => void },
			) => {
				options.onProgress(savedSessionListItem("partial"));
				throw new Error("retry failed");
			},
		};
		const harness = {
			...refreshHarness(),
			reconnectPromise: Promise.resolve(),
			savedSessions: previous,
			lastSuccessfulSavedSessions: previous,
			requireClient: () => client,
			getSavedSessionCatalogContext: () => ({ cwd: "/tmp/project" }),
		};
		harness.persistentState.savedSessions = previous;

		const refreshed = await privateMethod<
			(
				this: typeof harness,
				options: { duringReconnect: boolean; preserveStatusOnError: boolean },
			) => Promise<boolean>
		>("refreshSavedSessions").call(harness, { duringReconnect: true, preserveStatusOnError: false });

		expect(refreshed).toBe(false);
		expect(harness.savedSessions).toEqual(previous);
		expect(harness.persistentState.savedSessions).toEqual(previous);
		expect(harness.setStatusMessage).not.toHaveBeenCalled();
	});

	test("reconnect stays active until the heartbeat catalog refresh succeeds", async () => {
		vi.useFakeTimers();
		try {
			const firstHeartbeatAttempt = deferred<void>();
			let heartbeatAttempts = 0;
			const client = {
				hello: { protocol: { version: 3 } },
				supportsServerCapability: () => true,
				reconnect: vi.fn(async () => {}),
				request: vi.fn(async (command: { type: string }) => {
					if (command.type === "list") return { success: true, data: { sessions: [summary("live")] } };
					heartbeatAttempts += 1;
					if (heartbeatAttempts === 1) {
						firstHeartbeatAttempt.resolve();
						throw new Error("heartbeat connection lost");
					}
					return { success: true, data: { heartbeats: [{ job: { id: "healthy" } }] } };
				}),
			};
			const harness = {
				...refreshHarness(),
				stopped: false,
				reconnectTimedOut: false,
				client,
				options: { reconnectTimeoutMs: 10_000 },
				requireClient: () => client,
				refreshSavedSessions: vi.fn(async () => true),
				refreshHeartbeats: vi.fn(async (_options?: { duringReconnect?: boolean }) => false),
				reconnectClient: vi.fn(async (_reconnectingClient: typeof client, _error: unknown) => {}),
			};
			const refreshHeartbeats =
				privateMethod<(this: typeof harness, options?: { duringReconnect?: boolean }) => Promise<boolean>>(
					"refreshHeartbeats",
				);
			const reconnectClient =
				privateMethod<(this: typeof harness, reconnectingClient: typeof client, error: unknown) => Promise<void>>(
					"reconnectClient",
				);
			harness.refreshHeartbeats.mockImplementation((options) => refreshHeartbeats.call(harness, options));
			harness.reconnectClient.mockImplementation((reconnectingClient, error) =>
				reconnectClient.call(harness, reconnectingClient, error),
			);

			privateMethod<(this: typeof harness, reconnectingClient: typeof client, error: unknown) => void>(
				"startClientReconnect",
			).call(harness, client, new Error("disconnected"));
			await firstHeartbeatAttempt.promise;
			await Promise.resolve();

			expect(harness.reconnectPromise).toBeDefined();
			expect(harness.applySessionList).not.toHaveBeenCalled();
			expect(harness.setStatusMessage).not.toHaveBeenCalledWith("Daemon reconnected", { render: false });
			expect(client.reconnect).toHaveBeenCalledOnce();

			await vi.advanceTimersByTimeAsync(1_000);
			await harness.reconnectPromise;

			expect(client.reconnect).toHaveBeenCalledTimes(2);
			expect(harness.applySessionList).toHaveBeenCalledWith([summary("live")], true);
			expect(harness.heartbeats).toEqual([{ job: { id: "healthy" } }]);
			expect(harness.reconnectPromise).toBeUndefined();
		} finally {
			vi.useRealTimers();
		}
	});

	test("a pending saved scan cannot overwrite daemon shutdown status", async () => {
		const scan = deferred<void>();
		const client = {
			request: async () => {
				await scan.promise;
				throw new Error("scan failed");
			},
		};
		const harness = {
			...refreshHarness(),
			savedSessions: [],
			lastSuccessfulSavedSessions: [],
			requireClient: () => client,
			getSavedSessionCatalogContext: () => ({ cwd: "/tmp/project" }),
		};

		const pending = privateMethod<(this: typeof harness) => Promise<boolean>>("refreshSavedSessions").call(harness);
		harness.daemonShutdownReceived = true;
		scan.resolve();
		expect(await pending).toBe(false);
		expect(harness.setStatusMessage).not.toHaveBeenCalled();
	});

	test("a missing selection anchor blocks open only until both catalogs settle", () => {
		const finish = vi.fn();
		const fallback = summary("fallback");
		const harness = {
			selectionAnchorPending: true,
			liveCatalogRefreshPending: false,
			savedCatalogRefreshPending: true,
			selectedIndex: 0,
			selectedActiveSessionId: undefined as string | undefined,
			selectedRowIdentity: "identity-intended",
			rows: [{ selectable: true, kind: "agent", summary: fallback }],
			isPendingDeleteRow: () => false,
			setStatusMessage: vi.fn(),
			finish,
		};

		privateMethod<(this: typeof harness) => void>("openSelected").call(harness);
		expect(finish).not.toHaveBeenCalled();
		privateMethod<(this: typeof harness) => void>("resolveMissingSelectionAnchor").call(harness);
		expect(harness.selectionAnchorPending).toBe(true);
		harness.savedCatalogRefreshPending = false;
		privateMethod<(this: typeof harness) => void>("resolveMissingSelectionAnchor").call(harness);
		// Open unblocks on the visible fallback row...
		expect(harness.selectionAnchorPending).toBe(false);
		expect(harness.selectedActiveSessionId).toBe(fallback.activeSessionId ?? fallback.id);
		// ...but the restored anchor identity survives so a late poll can still re-anchor.
		expect(harness.selectedRowIdentity).toBe("identity-intended");
	});
	test("rename uses the captured row after refresh removes it", async () => {
		const captured = summary("captured");
		const request = vi.fn(async () => ({ success: true, data: {} }));
		const harness = {
			renameTarget: { activeSessionId: captured.activeSessionId, summary: captured },
			rows: [],
			exitRenameMode: vi.fn(),
			setStatusMessage: vi.fn(),
			refreshBothCatalogs: vi.fn(async () => true),
			requireClient: () => ({ request }),
			renameSession: Reflect.get(AgentsViewMode.prototype, "renameSession"),
		};

		await privateMethod<(this: typeof harness, value: string) => Promise<void>>("confirmRename").call(
			harness,
			"Renamed",
		);

		expect(request).toHaveBeenCalledWith({
			type: "rename",
			activeSessionId: captured.activeSessionId,
			name: "Renamed",
		});
	});

	test("saved-only delete confirmation remains in the inactive catalog", () => {
		const savedOnly = { ...summary("saved"), lifecycle: "archived" as const, activeSessionId: undefined };
		const harness = {
			pendingDeleteAgent: { identity: "saved", summary: savedOnly, stopped: false },
			isDeleteConfirmationVisible: () => true,
		};

		expect(
			privateMethod<(this: typeof harness, sessions: SessionSummary[]) => SessionSummary[]>(
				"withPendingDeleteSession",
			).call(harness, []),
		).toEqual([]);
	});

	test("slow live polls are coalesced instead of repeatedly superseded", async () => {
		const slow = deferred<boolean>();
		const refreshSessions = vi.fn(() => slow.promise);
		const harness = { liveCatalogPollPromise: undefined, refreshSessions };
		const poll = privateMethod<(this: typeof harness) => void>("pollSessions");

		poll.call(harness);
		poll.call(harness);
		expect(refreshSessions).toHaveBeenCalledOnce();
		slow.resolve(true);
		await slow.promise;
		await Promise.resolve();
		poll.call(harness);
		expect(refreshSessions).toHaveBeenCalledTimes(2);
	});

	test.each([
		{ mode: "search", prompt: ["prompt top", "prompt input", "prompt bottom"] },
		{ mode: "reply", prompt: ["prompt top", "reply header", "reply gap", "prompt input", "prompt bottom"] },
	])("short content reserves the $mode editor and a session row ahead of startup chrome", ({ prompt }) => {
		const renderSessionRows = vi.fn(() => ["session row"]);
		const harness = {
			splash: { render: () => Array.from({ length: 8 }, () => "splash") },
			renderStartupNotices: () => Array.from({ length: 8 }, () => "notice"),
			renderPrompt: () => prompt,
			renderSessionRows,
		};
		const height = prompt.length + 2;

		const lines = privateMethod<(this: typeof harness, width: number, height: number) => string[]>(
			"renderContent",
		).call(harness, 80, height);

		expect(lines).toHaveLength(height);
		expect(lines).toEqual(expect.arrayContaining([...prompt, "session row"]));
		expect(renderSessionRows).toHaveBeenCalledWith(80, 1);
	});

	test.each(["reply", "rename"] as const)("%s refresh keeps the captured search filter", (mode) => {
		const harness = {
			replyTarget: mode === "reply" ? { key: "active", summary: {} } : undefined,
			renameTarget: mode === "rename" ? { identity: "target" } : undefined,
			actionModeSearchQuery: "needle",
			editor: { getText: () => "action editor text" },
			scopedRecords: [
				{ identity: "match", identityAliases: [], section: "idle", searchableText: "needle session" },
				{ identity: "other", identityAliases: [], section: "idle", searchableText: "other session" },
			],
		};

		const filtered =
			privateMethod<(this: typeof harness) => Array<{ identity: string }>>("getFilteredRecords").call(harness);
		expect(filtered.map((record) => record.identity)).toEqual(["match"]);
	});

	test("inactive rows give message count and age their full responsive cell", () => {
		const inactive = {
			kind: "agent" as const,
			section: "inactive" as const,
			summary: {
				...summary("archived"),
				activeSessionId: undefined,
				lifecycle: "archived" as const,
				messageCount: 123456,
				modified: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
			},
			title: "archived",
			subtitle: "",
			statusLabel: "inactive",
			depth: 0,
			selectable: true,
			runningSubagentCount: 0,
			identity: "archived",
		};
		const harness = {
			rows: [inactive],
			selectedIndex: 0,
			isPendingDeleteRow: () => false,
			isPendingKillSubagentRow: () => false,
			getRowIcon: () => "x",
			formatRowIcon: (_section: string, icon: string) => icon,
		};

		const rendered = stripAnsi(
			privateMethod<(this: typeof harness, row: typeof inactive, width: number) => string>("renderRow").call(
				harness,
				inactive,
				50,
			),
		);
		expect(rendered).toMatch(/123456 · 2h\s*$/);
	});

	test("scoped subagent rows keep model and effort ahead of summaries", () => {
		initTheme("dark");
		const subagent = {
			// Direct children in a scoped Agents View render as agent rows while
			// retaining their persisted subagent runtime kind.
			kind: "agent" as const,
			section: "idle" as const,
			summary: {
				...summary("effort-child"),
				runtimeKind: "subagent" as const,
				summary: "Investigate a variable background status that can be truncated",
				model: { provider: "prime-inference", id: "gpt-5.6-terra" } as SessionSummary["model"],
				thinkingLevel: "high" as SessionSummary["thinkingLevel"],
			} as SessionSummary,
			title: "Inspect agents view",
			subtitle: "",
			statusLabel: "idle",
			depth: 1,
			selectable: true,
			runningSubagentCount: 0,
			identity: "effort-child",
			parentIdentity: "parent",
		};
		const harness = {
			rows: [subagent],
			selectedIndex: -1,
			isPendingDeleteRow: () => false,
			isPendingKillSubagentRow: () => false,
			getRowIcon: () => "·",
			formatRowIcon: (_section: string, icon: string) => icon,
		};
		const render = (width: number) =>
			stripAnsi(
				privateMethod<(this: typeof harness, row: typeof subagent, width: number) => string>("renderRow").call(
					harness,
					subagent,
					width,
				),
			);

		const full = render(120);
		expect(full).toContain(
			"Inspect agents view · prime-inference/gpt-5.6-terra:high · Investigate a variable background status",
		);
		const narrow = render(75);
		expect(narrow).toContain("prime-inference/gpt-5.6-terra:high");
		expect(narrow).not.toContain("Investigate a variable background status");

		subagent.summary.summary = "";
		expect(render(100)).toContain("Inspect agents view · prime-inference/gpt-5.6-terra:high");

		// Older daemons identify subagents through persisted linkage instead of runtimeKind.
		subagent.summary.runtimeKind = undefined;
		subagent.summary.rlmChildId = "effort-child";
		expect(render(100)).toContain("Inspect agents view · prime-inference/gpt-5.6-terra:high");

		subagent.summary.thinkingLevel = "off";
		subagent.summary.summary = "A later summary";
		expect(render(100)).toContain("Inspect agents view · prime-inference/gpt-5.6-terra · A later summary");
		expect(render(100)).not.toContain(":off");

		expect(render(20)).toHaveLength(20);
	});
});
