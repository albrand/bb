import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import {
  appendStoredThreadEvent,
  closeSession,
  createEnvironment,
  createNativeTerminalThread,
  createProject,
  createQueuedThreadMessage,
  createTerminalSession,
  createThread,
  hostDaemonSessions,
  listQueuedThreadMessages,
  listThreadsWithPendingInteractionState,
  noopNotifier,
  openSession,
  setNativeTerminalThreadTerminal,
  setQueuedThreadMessageFailureReason,
  stampNativeTerminalThreadActivity,
  upsertHost,
  type DbConnection,
  type ThreadWithPendingInteractionState,
} from "@bb/db";
import { createMigratedConnection } from "@bb/db/testing";
import {
  formatClientTurnRequestIdSuffix,
  threadScope,
  turnScope,
} from "@bb/domain";
import type {
  ClientTurnRequestId,
  PromptInput,
  Thread,
  ThreadRuntimeState,
} from "@bb/domain";
import { HOST_RECONNECT_GRACE_MS } from "../../../src/constants.js";
import {
  resolveThreadRuntimeState,
  toPluginThreadDtoFromThread,
  toThreadResponseFromThread,
  toThreadListEntryResponses,
} from "../../../src/services/threads/thread-runtime-display.js";
import { NotificationHub } from "../../../src/ws/hub.js";
import { createTestProviderRegistry } from "../../helpers/provider-registry.js";

const providerRegistry = await createTestProviderRegistry();

interface SetupResult {
  db: DbConnection;
  hostId: string;
  hub: NotificationHub;
}

function countNativeActivityLookupStatements(
  db: DbConnection,
  work: () => void,
): number {
  const prepare = vi.spyOn(db.$client, "prepare");
  try {
    work();
    return prepare.mock.calls.filter(([query]) =>
      String(query).includes("last_evidence_at AS lastEvidenceAt"),
    ).length;
  } finally {
    prepare.mockRestore();
  }
}

interface OpenTestSessionArgs {
  db: DbConnection;
  hostId: string;
  leaseExpiresAt?: number;
}

interface CloseTestSessionArgs {
  closeReason?: "daemon-disconnect" | "expired";
  closedAt: number;
  db: DbConnection;
  sessionId: string;
}

interface CreateThreadWithEnvironmentArgs {
  db: DbConnection;
  environmentProviderId?: string;
  hostId: string;
  providerId?: string;
  status?: Thread["status"];
}

interface ThreadWithPinSortKey extends Thread {
  pinSortKey: string | null;
}

interface CreateThreadListEntryArgs {
  environmentHostId: string | null;
  thread: ThreadWithPinSortKey;
}

const planPromptInput: PromptInput[] = [
  {
    type: "text",
    text: "/plan inspect the failing command",
    mentions: [
      {
        start: 0,
        end: 5,
        resource: {
          kind: "command",
          trigger: "/",
          name: "plan",
          source: "command",
          origin: "user",
          label: "plan",
          argumentHint: null,
        },
      },
    ],
  },
];

function turnRequestData({
  input,
  requestId,
}: {
  input: PromptInput[];
  requestId: ClientTurnRequestId;
}) {
  return {
    direction: "outbound",
    source: "tell",
    initiator: "user",
    senderThreadId: null,
    requestId,
    input,
    target: { kind: "new-turn" },
    request: { method: "turn/start", params: {} },
    execution: {
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "workspace-write",
      source: "client/turn/requested",
      serviceTier: "default",
    },
  } as const;
}

function setup(): SetupResult {
  const db = createMigratedConnection();
  const hub = new NotificationHub();
  const host = upsertHost(db, noopNotifier, {
    id: "host-runtime-display",
    name: "Runtime Display Host",
  });
  return { db, hostId: host.id, hub };
}

function registerTestDaemon(
  hub: NotificationHub,
  args: { hostId: string; sessionId: string },
): void {
  hub.registerDaemon(args.sessionId, args.hostId, {
    close() {},
    send() {},
  });
}

function openTestSession(args: OpenTestSessionArgs) {
  const session = openSession(args.db, {
    hostId: args.hostId,
    instanceId: `instance-${randomUUID()}`,
    hostName: "Runtime Display Host",
    dataDir: `/tmp/${args.hostId}`,
    protocolVersion: 1,
    heartbeatIntervalMs: 5_000,
    leaseTimeoutMs: 30_000,
  });

  if (args.leaseExpiresAt !== undefined) {
    args.db
      .update(hostDaemonSessions)
      .set({ leaseExpiresAt: args.leaseExpiresAt })
      .where(eq(hostDaemonSessions.id, session.id))
      .run();
  }

  return session;
}

function closeTestSession(args: CloseTestSessionArgs): void {
  closeSession(
    args.db,
    noopNotifier,
    args.sessionId,
    args.closeReason ?? "daemon-disconnect",
  );
  args.db
    .update(hostDaemonSessions)
    .set({
      closedAt: args.closedAt,
      updatedAt: args.closedAt,
    })
    .where(eq(hostDaemonSessions.id, args.sessionId))
    .run();
}

function createThreadWithEnvironment(args: CreateThreadWithEnvironmentArgs) {
  const suffix = randomUUID();
  const { project } = createProject(args.db, noopNotifier, {
    name: `Runtime Display Project ${suffix}`,
    source: {
      type: "local_path",
      hostId: args.hostId,
      path: `/tmp/${args.hostId}/project/${suffix}`,
    },
  });
  const environment = createEnvironment(args.db, noopNotifier, {
    providerOwnsPath: false,
    hostId: args.hostId,
    projectId: project.id,
    path: `/tmp/${args.hostId}/environment/${suffix}`,
    status: "ready",
    environmentProvider:
      args.environmentProviderId === undefined
        ? null
        : {
            environmentProviderId: args.environmentProviderId,
            instanceKey: null,
            selection: {
              machine: { type: "existing", hostId: args.hostId },
              inputs: null,
            },
          },
  });
  const thread = createThread(args.db, noopNotifier, {
    projectId: project.id,
    environmentId: environment.id,
    providerId: args.providerId ?? "codex",
    status: args.status ?? "active",
  });

  return { environment, project, thread };
}

function createLiveNativeReportingThread(args: {
  db: DbConnection;
  hostId: string;
}) {
  const { db, hostId } = args;
  const { environment, thread } = createThreadWithEnvironment({
    db,
    hostId,
    providerId: "claude-code",
  });
  createNativeTerminalThread(db, {
    threadId: thread.id,
    providerId: thread.providerId,
    nativeSessionId: `native-session-${thread.id}`,
    initialPrompt: null,
    initialImages: [],
    model: null,
  });
  const terminal = createTerminalSession(db, {
    threadId: thread.id,
    environmentId: environment.id,
    hostId,
    daemonSessionId: null,
    title: "Claude Code",
    initialCwd: environment.path ?? "/tmp",
    cols: 120,
    rows: 36,
    status: "running",
    now: 100_000,
  });
  setNativeTerminalThreadTerminal(db, {
    threadId: thread.id,
    terminalSessionId: terminal.id,
  });
  const receipt = stampNativeTerminalThreadActivity(db, {
    at: 100_000,
    terminalSessionId: terminal.id,
    threadId: thread.id,
  });
  return { receipt, thread };
}

function createThreadListEntry(
  args: CreateThreadListEntryArgs,
): ThreadWithPendingInteractionState {
  return {
    ...args.thread,
    modelOverride: null,
    reasoningLevelOverride: null,
    storageDeletedAt: null,
    environmentBranchName: null,
    environmentPath: null,
    environmentProviderId: null,
    environmentIsWorktree: null,
    environmentHostId: args.environmentHostId,
    environmentName: null,
    hasPendingInteraction: false,
    // Only a `pending` thread whose first message queued carries one, and
    // these fixtures are all threads that already started.
    startupContext: null,
  };
}

describe("thread runtime display", () => {
  it("applies one receipt freshness policy to native list and detail status", () => {
    const { db, hostId, hub } = setup();
    const session = openTestSession({ db, hostId });
    registerTestDaemon(hub, { hostId, sessionId: session.id });
    const native = createThreadWithEnvironment({
      db,
      hostId,
      providerId: "claude-code",
    });
    const nativeTwo = createThreadWithEnvironment({
      db,
      hostId,
      providerId: "claude-code",
    });
    const ordinary = createThreadWithEnvironment({ db, hostId });
    for (const thread of [native.thread, nativeTwo.thread]) {
      createNativeTerminalThread(db, {
        threadId: thread.id,
        providerId: thread.providerId,
        nativeSessionId: `synthetic-session-${thread.id}`,
        initialPrompt: null,
        initialImages: [],
        model: null,
      });
      db.$client
        .prepare(
          "UPDATE fork_native_terminal_threads SET last_evidence_at = ? WHERE thread_id = ?",
        )
        .run(100_000, thread.id);
    }
    const nativeEntry = createThreadListEntry({
      environmentHostId: hostId,
      thread: native.thread,
    });
    const ordinaryEntry = createThreadListEntry({
      environmentHostId: hostId,
      thread: ordinary.thread,
    });
    const nativeTwoEntry = createThreadListEntry({
      environmentHostId: hostId,
      thread: nativeTwo.thread,
    });
    const oneNativeLookupStatements = countNativeActivityLookupStatements(
      db,
      () =>
        toThreadListEntryResponses(
          { db, hub, providerRegistry },
          { now: 190_000, threads: [nativeEntry, ordinaryEntry] },
        ),
    );
    const twoNativeLookupStatements = countNativeActivityLookupStatements(
      db,
      () =>
        toThreadListEntryResponses(
          { db, hub, providerRegistry },
          {
            now: 190_000,
            threads: [nativeEntry, nativeTwoEntry, ordinaryEntry],
          },
        ),
    );

    const fresh = toThreadListEntryResponses(
      { db, hub, providerRegistry },
      { now: 190_000, threads: [nativeEntry, nativeTwoEntry, ordinaryEntry] },
    );
    const stale = toThreadListEntryResponses(
      { db, hub, providerRegistry },
      { now: 190_001, threads: [nativeEntry, nativeTwoEntry, ordinaryEntry] },
    );
    const detail = toThreadResponseFromThread(
      { db, hub, providerRegistry },
      { now: 190_001, thread: native.thread },
    );

    expect(fresh[0]?.runtime.nativeActivity?.confirmation).toBe("confirmed");
    expect(fresh[0]?.nativeTerminal).toBe(true);
    expect(fresh[0]?.listIndicator).toBe("working");
    expect(fresh[1]?.runtime.nativeActivity?.confirmation).toBe("confirmed");
    expect(fresh[1]?.listIndicator).toBe("working");
    expect(stale[0]?.runtime.nativeActivity?.confirmation).toBe("unconfirmed");
    expect(stale[0]?.listIndicator).toBe("activity-unreported");
    expect(stale[1]?.runtime.nativeActivity?.confirmation).toBe("unconfirmed");
    expect(stale[1]?.listIndicator).toBe("activity-unreported");
    expect(detail.runtime.nativeActivity?.confirmation).toBe("unconfirmed");
    expect(detail.nativeTerminal).toBe(true);
    expect(stale[2]?.runtime.nativeActivity).toBeUndefined();
    expect(stale[2]?.nativeTerminal).toBe(false);
    expect(stale[2]?.listIndicator).toBe("working");
    expect(oneNativeLookupStatements).toBe(1);
    expect(twoNativeLookupStatements).toBe(oneNativeLookupStatements);
  });

  it("projects native receipt freshness and edit policy through the plugin DTO", () => {
    const { db, hostId, hub } = setup();
    const { receipt, thread } = createLiveNativeReportingThread({ db, hostId });
    expect(receipt).toEqual({ updated: true, previousLastEvidenceAt: null });

    const pluginFresh = toPluginThreadDtoFromThread(
      { db, hub, providerRegistry },
      { now: 190_000, thread },
    );
    const detailFresh = toThreadResponseFromThread(
      { db, hub, providerRegistry },
      { now: 190_000, thread },
    );
    const pluginExpired = toPluginThreadDtoFromThread(
      { db, hub, providerRegistry },
      { now: 190_001, thread },
    );
    const detailExpired = toThreadResponseFromThread(
      { db, hub, providerRegistry },
      { now: 190_001, thread },
    );

    expect(pluginFresh.runtime.nativeActivity).toEqual({
      lastEvidenceAt: 100_000,
      freshForMs: 90_000,
      confirmation: "confirmed",
      evidenceKind: "holder-report",
    });
    expect(pluginFresh.runtime.nativeActivity).toEqual(
      detailFresh.runtime.nativeActivity,
    );
    expect(pluginExpired.runtime.nativeActivity).toEqual({
      lastEvidenceAt: 100_000,
      freshForMs: 90_000,
      confirmation: "unconfirmed",
      evidenceKind: "unknown",
    });
    expect(pluginExpired.runtime.nativeActivity).toEqual(
      detailExpired.runtime.nativeActivity,
    );
    expect(providerRegistry.supportsSessionRewind("claude-code")).toBe(true);
    expect(pluginFresh.canEditMessages).toBe(true);
    expect(pluginFresh.canEditMessages).toBe(detailFresh.canEditMessages);
  });

  it("keeps the plugin DTO safe without a registry and preserves registered editability", () => {
    const { db, hostId, hub } = setup();
    const { receipt, thread } = createLiveNativeReportingThread({ db, hostId });
    expect(receipt).toEqual({ updated: true, previousLastEvidenceAt: null });
    const ordinary = createThreadWithEnvironment({ db, hostId });

    const withoutRegistry = toPluginThreadDtoFromThread(
      { db, hub },
      { now: 190_000, thread },
    );
    const withRegistry = toPluginThreadDtoFromThread(
      { db, hub, providerRegistry },
      { now: 190_000, thread: ordinary.thread },
    );

    expect(withoutRegistry.runtime.nativeActivity).toBeUndefined();
    expect(withoutRegistry.canEditMessages).toBe(false);
    expect(providerRegistry.supportsSessionRewind("codex")).toBe(true);
    expect(withRegistry.canEditMessages).toBe(true);
  });

  it("keeps active threads active while the host daemon websocket is registered", () => {
    const { db, hostId, hub } = setup();
    const now = 1_000;
    const session = openTestSession({
      db,
      hostId,
      leaseExpiresAt: now - 1,
    });
    registerTestDaemon(hub, { hostId, sessionId: session.id });

    expect(
      resolveThreadRuntimeState(
        { db, hub },
        { environmentHostId: hostId, now, status: "active" },
      ),
    ).toEqual({
      displayStatus: "active",
    } satisfies ThreadRuntimeState);
  });

  it("does not treat a fresh lease as active without a registered daemon websocket", () => {
    const { db, hostId, hub } = setup();
    const now = 1_000;
    openTestSession({
      db,
      hostId,
      leaseExpiresAt: now + 30_000,
    });

    expect(
      resolveThreadRuntimeState(
        { db, hub },
        { environmentHostId: hostId, now, status: "active" },
      ),
    ).toEqual({
      displayStatus: "waiting-for-host",
    } satisfies ThreadRuntimeState);
  });

  it("keeps an active thread active while its host's closed socket is within the reconnect grace", () => {
    const { db, hostId, hub } = setup();
    const now = 60_000;
    const session = openTestSession({ db, hostId });
    closeTestSession({
      closedAt: now - HOST_RECONNECT_GRACE_MS + 1_000,
      db,
      sessionId: session.id,
    });

    expect(
      resolveThreadRuntimeState(
        { db, hub },
        { environmentHostId: hostId, now, status: "active" },
      ),
    ).toEqual({
      displayStatus: "active",
    } satisfies ThreadRuntimeState);
  });

  it("keeps an active thread active while its reconnecting daemon has not registered its socket", () => {
    const { db, hostId, hub } = setup();
    const now = Date.now();
    const lost = openTestSession({ db, hostId });
    closeTestSession({
      closedAt: now - 1_000,
      db,
      sessionId: lost.id,
    });
    openTestSession({ db, hostId });

    expect(
      resolveThreadRuntimeState(
        { db, hub },
        { environmentHostId: hostId, now, status: "active" },
      ),
    ).toEqual({
      displayStatus: "active",
    } satisfies ThreadRuntimeState);
  });

  it("shows waiting-for-host as soon as the server closes a silent daemon session", () => {
    const { db, hostId, hub } = setup();
    const now = 60_000;
    const session = openTestSession({ db, hostId });
    closeTestSession({
      closeReason: "expired",
      closedAt: now - 1_000,
      db,
      sessionId: session.id,
    });

    expect(
      resolveThreadRuntimeState(
        { db, hub },
        { environmentHostId: hostId, now, status: "active" },
      ),
    ).toEqual({
      displayStatus: "waiting-for-host",
    } satisfies ThreadRuntimeState);
  });

  it("shows waiting-for-host after the reconnect grace expires", () => {
    const { db, hostId, hub } = setup();
    const now = 60_000;
    const session = openTestSession({ db, hostId });
    closeTestSession({
      closedAt: now - HOST_RECONNECT_GRACE_MS - 1,
      db,
      sessionId: session.id,
    });

    expect(
      resolveThreadRuntimeState(
        { db, hub },
        { environmentHostId: hostId, now, status: "active" },
      ),
    ).toEqual({
      displayStatus: "waiting-for-host",
    } satisfies ThreadRuntimeState);
  });

  it("uses the thread status directly for non-active statuses", () => {
    const { db, hostId, hub } = setup();

    expect(
      resolveThreadRuntimeState(
        { db, hub },
        {
          environmentHostId: hostId,
          now: 1_000,
          status: "idle",
        },
      ),
    ).toEqual({
      displayStatus: "idle",
    } satisfies ThreadRuntimeState);
  });

  it("does not require a host id for active threads without an environment host", () => {
    const { db, hub } = setup();

    expect(
      resolveThreadRuntimeState(
        { db, hub },
        {
          environmentHostId: null,
          now: 1_000,
          status: "active",
        },
      ),
    ).toEqual({
      displayStatus: "active",
    } satisfies ThreadRuntimeState);
  });

  it("carries the producing environment provider into the list entry", () => {
    const { db, hostId, hub } = setup();
    const provided = createThreadWithEnvironment({
      db,
      hostId,
      environmentProviderId: "git-worktree",
    });
    const checkout = createThreadWithEnvironment({ db, hostId });

    const providerIdByThreadId = new Map(
      [provided, checkout].flatMap(({ project }) =>
        toThreadListEntryResponses(
          { db, hub, providerRegistry },
          {
            now: 1_000,
            threads: listThreadsWithPendingInteractionState(db, {
              projectId: project.id,
            }),
          },
        ).map((entry) => [entry.id, entry.environmentProviderId]),
      ),
    );

    expect(providerIdByThreadId.get(provided.thread.id)).toBe("git-worktree");
    expect(providerIdByThreadId.get(checkout.thread.id)).toBeNull();
  });

  it("reports the selected machine before a new thread has an environment", () => {
    const { db, hostId, hub } = setup();
    const { project } = createThreadWithEnvironment({ db, hostId });
    const thread = createThread(db, noopNotifier, {
      projectId: project.id,
      environmentId: null,
      providerId: "codex",
      status: "pending",
      startupContext: JSON.stringify({
        kind: "pending",
        environmentIntent: {
          type: "provider",
          environmentProviderId: "git-worktree",
          machine: { type: "existing", hostId },
          inputs: null,
          selectionResolved: true,
        },
        fork: null,
        startedOnBehalfOf: null,
        titleProvided: false,
      }),
    });

    const [entry] = toThreadListEntryResponses(
      { db, hub, providerRegistry },
      {
        threads: listThreadsWithPendingInteractionState(db, {
          projectId: project.id,
        }).filter((row) => row.id === thread.id),
      },
    );

    expect(entry?.environmentHostId).toBe(hostId);
    expect(entry?.environmentId).toBeNull();
  });

  it("resolves list entry runtime from daemon registration per host", () => {
    const { db, hostId, hub } = setup();
    const now = 1_000;
    const session = openTestSession({
      db,
      hostId,
      leaseExpiresAt: now - 1,
    });
    registerTestDaemon(hub, { hostId, sessionId: session.id });
    const first = createThreadWithEnvironment({ db, hostId });
    const second = createThreadWithEnvironment({ db, hostId });
    const noHost = createThreadWithEnvironment({
      db,
      hostId,
      status: "active",
    });

    const entries = toThreadListEntryResponses(
      { db, hub, providerRegistry },
      {
        now,
        threads: [
          createThreadListEntry({
            environmentHostId: hostId,
            thread: first.thread,
          }),
          createThreadListEntry({
            environmentHostId: hostId,
            thread: second.thread,
          }),
          createThreadListEntry({
            environmentHostId: null,
            thread: noHost.thread,
          }),
        ],
      },
    );

    expect(entries.map((entry) => entry.runtime)).toEqual([
      {
        displayStatus: "active",
      },
      {
        displayStatus: "active",
      },
      {
        displayStatus: "active",
      },
    ] satisfies ThreadRuntimeState[]);
  });

  it("reports each thread's queued work, with a failure outranking a wait", () => {
    const { db, hostId, hub } = setup();
    const empty = createThreadWithEnvironment({ db, hostId, status: "idle" });
    const waiting = createThreadWithEnvironment({ db, hostId, status: "idle" });
    const failed = createThreadWithEnvironment({ db, hostId, status: "idle" });

    // The failed thread holds BOTH a healthy row and a failed one, which is the
    // case the precedence rule exists for: a thread that queued two messages
    // and only the first one blew up must not read as merely waiting.
    for (const { thread, count } of [
      { thread: waiting.thread, count: 1 },
      { thread: failed.thread, count: 2 },
    ]) {
      for (let index = 0; index < count; index += 1) {
        createQueuedThreadMessage(db, noopNotifier, {
          threadId: thread.id,
          content: [{ type: "text", text: `queued ${index}`, mentions: [] }],
          model: "gpt-5",
          reasoningLevel: "medium",
          permissionMode: "auto",
          serviceTier: "default",
          waitingOn: { kind: "thread-busy" },
          sendAt: null,
          payload: { kind: "inline" },
          systemNotice: null,
        });
      }
    }
    const failedRow = listQueuedThreadMessages(db, failed.thread.id)[0]!;
    setQueuedThreadMessageFailureReason(db, noopNotifier, {
      id: failedRow.id,
      threadId: failed.thread.id,
      failureReason: "The message could not be sent.",
      now: Date.now(),
      retryDelaysMs: [],
    });

    const entries = toThreadListEntryResponses(
      { db, hub, providerRegistry },
      {
        now: 1_000,
        threads: [empty.thread, waiting.thread, failed.thread].map((thread) =>
          createThreadListEntry({
            environmentHostId: hostId,
            thread: { ...thread, pinSortKey: null },
          }),
        ),
      },
    );

    expect(entries.map((entry) => entry.queuedWork)).toEqual([
      "none",
      "waiting",
      "failed",
    ]);
  });

  it("builds active list entries above the SQLite variable limit", () => {
    const { db, hostId, hub } = setup();
    const { thread } = createThreadWithEnvironment({ db, hostId });
    const template = createThreadListEntry({
      environmentHostId: null,
      thread,
    });
    const threads = Array.from({ length: 32_767 }, (_, index) => ({
      ...template,
      id: `thr_variable_limit_${index}`,
    }));

    expect(
      toThreadListEntryResponses(
        { db, hub, providerRegistry },
        {
          now: 1_000,
          threads,
        },
      ),
    ).toHaveLength(32_767);
  });

  it("marks list entries active when the prompt banner would show plan or goal state", () => {
    const { db, hostId, hub } = setup();
    const activePlan = createThreadWithEnvironment({ db, hostId });
    const completedPlan = createThreadWithEnvironment({ db, hostId });
    const activeGoal = createThreadWithEnvironment({ db, hostId });
    const clearedGoal = createThreadWithEnvironment({ db, hostId });
    const concurrentPlanGoal = createThreadWithEnvironment({ db, hostId });
    const claudePlan = createThreadWithEnvironment({
      db,
      hostId,
      providerId: "claude-code",
    });
    const activePlanRequestId = formatClientTurnRequestIdSuffix({
      suffix: "23456789ab",
    });
    const completedPlanRequestId = formatClientTurnRequestIdSuffix({
      suffix: "23456789ac",
    });
    const concurrentPlanRequestId = formatClientTurnRequestIdSuffix({
      suffix: "23456789ad",
    });
    const claudePlanRequestId = formatClientTurnRequestIdSuffix({
      suffix: "23456789ae",
    });

    appendStoredThreadEvent(db, noopNotifier, {
      threadId: activePlan.thread.id,
      scope: threadScope(),
      type: "client/turn/requested",
      data: turnRequestData({
        input: planPromptInput,
        requestId: activePlanRequestId,
      }),
    });
    appendStoredThreadEvent(db, noopNotifier, {
      threadId: activePlan.thread.id,
      scope: turnScope("turn-active-plan"),
      providerThreadId: "provider-active-plan",
      type: "turn/input/accepted",
      data: {
        providerThreadId: "provider-active-plan",
        clientRequestId: activePlanRequestId,
      },
    });

    appendStoredThreadEvent(db, noopNotifier, {
      threadId: completedPlan.thread.id,
      scope: threadScope(),
      type: "client/turn/requested",
      data: turnRequestData({
        input: planPromptInput,
        requestId: completedPlanRequestId,
      }),
    });
    appendStoredThreadEvent(db, noopNotifier, {
      threadId: completedPlan.thread.id,
      scope: turnScope("turn-completed-plan"),
      providerThreadId: "provider-completed-plan",
      type: "turn/input/accepted",
      data: {
        providerThreadId: "provider-completed-plan",
        clientRequestId: completedPlanRequestId,
      },
    });
    appendStoredThreadEvent(db, noopNotifier, {
      threadId: completedPlan.thread.id,
      scope: turnScope("turn-completed-plan"),
      providerThreadId: "provider-completed-plan",
      type: "turn/completed",
      data: {
        providerThreadId: "provider-completed-plan",
        status: "completed",
      },
    });

    appendStoredThreadEvent(db, noopNotifier, {
      threadId: activeGoal.thread.id,
      scope: threadScope(),
      providerThreadId: "provider-active-goal",
      type: "thread/goal/updated",
      data: {
        providerThreadId: "provider-active-goal",
        objective: "Finish the sidebar activity indicator",
        status: "active",
        tokenBudget: 10_000,
        tokensUsed: 512,
        timeUsedSeconds: 42,
      },
    });
    appendStoredThreadEvent(db, noopNotifier, {
      threadId: clearedGoal.thread.id,
      scope: threadScope(),
      providerThreadId: "provider-cleared-goal",
      type: "thread/goal/updated",
      data: {
        providerThreadId: "provider-cleared-goal",
        objective: "This goal was cleared",
        status: "active",
        tokenBudget: null,
        tokensUsed: 128,
        timeUsedSeconds: 10,
      },
    });
    appendStoredThreadEvent(db, noopNotifier, {
      threadId: clearedGoal.thread.id,
      scope: threadScope(),
      providerThreadId: "provider-cleared-goal",
      type: "thread/goal/cleared",
      data: { providerThreadId: "provider-cleared-goal" },
    });
    for (const [target, requestId, turnId, providerThreadId] of [
      [
        concurrentPlanGoal,
        concurrentPlanRequestId,
        "turn-concurrent-plan-goal",
        "provider-concurrent-plan-goal",
      ],
      [
        claudePlan,
        claudePlanRequestId,
        "turn-claude-plan",
        "provider-claude-plan",
      ],
    ] as const) {
      appendStoredThreadEvent(db, noopNotifier, {
        threadId: target.thread.id,
        scope: threadScope(),
        type: "client/turn/requested",
        data: turnRequestData({ input: planPromptInput, requestId }),
      });
      appendStoredThreadEvent(db, noopNotifier, {
        threadId: target.thread.id,
        scope: turnScope(turnId),
        providerThreadId,
        type: "turn/input/accepted",
        data: { providerThreadId, clientRequestId: requestId },
      });
    }
    appendStoredThreadEvent(db, noopNotifier, {
      threadId: concurrentPlanGoal.thread.id,
      scope: threadScope(),
      providerThreadId: "provider-concurrent-plan-goal",
      type: "thread/goal/updated",
      data: {
        providerThreadId: "provider-concurrent-plan-goal",
        objective: "Keep working while planning",
        status: "active",
        tokenBudget: null,
        tokensUsed: 64,
        timeUsedSeconds: 5,
      },
    });

    const entries = toThreadListEntryResponses(
      { db, hub, providerRegistry },
      {
        threads: [
          createThreadListEntry({
            environmentHostId: hostId,
            thread: activePlan.thread,
          }),
          createThreadListEntry({
            environmentHostId: hostId,
            thread: completedPlan.thread,
          }),
          createThreadListEntry({
            environmentHostId: hostId,
            thread: activeGoal.thread,
          }),
          createThreadListEntry({
            environmentHostId: hostId,
            thread: clearedGoal.thread,
          }),
          createThreadListEntry({
            environmentHostId: hostId,
            thread: concurrentPlanGoal.thread,
          }),
          createThreadListEntry({
            environmentHostId: hostId,
            thread: claudePlan.thread,
          }),
        ],
      },
    );
    const activityByThreadId = new Map(
      entries.map((entry) => [entry.id, entry.activity]),
    );

    expect(activityByThreadId.get(activePlan.thread.id)).toMatchObject({
      activePlanModeCount: 1,
      activeGoalCount: 0,
    });
    expect(activityByThreadId.get(completedPlan.thread.id)).toMatchObject({
      activePlanModeCount: 0,
      activeGoalCount: 0,
    });
    expect(activityByThreadId.get(activeGoal.thread.id)).toMatchObject({
      activePlanModeCount: 0,
      activeGoalCount: 1,
    });
    expect(activityByThreadId.get(clearedGoal.thread.id)).toMatchObject({
      activePlanModeCount: 0,
      activeGoalCount: 0,
    });
    expect(activityByThreadId.get(concurrentPlanGoal.thread.id)).toMatchObject({
      activePlanModeCount: 1,
      activeGoalCount: 1,
    });
    expect(activityByThreadId.get(claudePlan.thread.id)).toMatchObject({
      activePlanModeCount: 1,
      activeGoalCount: 0,
    });
  });
});
