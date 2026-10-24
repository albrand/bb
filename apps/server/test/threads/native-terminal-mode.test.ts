import { createHash } from "node:crypto";
import {
  createConnection,
  createInterruptedProviderPendingInteraction,
  createNativeTerminalThread,
  deleteThread,
  clearNativeTerminalThreadActivityEvidence,
  clearNativeTerminalThreadEvidence,
  getNativeTerminalThread,
  getPendingInteractionByProviderRequest,
  getTerminalSession,
  getThread,
  getThreadRowState,
  isNativeTerminalThread,
  listPendingInteractionsByThread,
  putThreadRowState,
  setNativeTerminalToolCredential,
  stampNativeTerminalThreadActivity,
  type DbConnection,
} from "@bb/db";
import {
  hostDaemonOnlineRpcResponseMessageSchema,
  hostDaemonServerWsMessageSchema,
  type HostDaemonServerWsMessage,
} from "@bb/host-daemon-contract";
import {
  apiErrorSchema,
  nativeTerminalLaunchSpecSchema,
  nativeTerminalThreadSchema,
  threadResponseSchema,
} from "@bb/server-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as interactiveRequests from "../../src/internal/interactive-requests.js";
import { DAEMON_RESTARTED_PENDING_INTERACTION_REASON } from "../../src/services/interactions/pending-interactions.js";
import { applyLoggedThreadLifecycleEvent } from "../../src/services/threads/lifecycle-outcome.js";
import { stopThreadForCurrentState } from "../../src/services/threads/thread-lifecycle.js";
import {
  isNativeTerminalRebindInFlight,
  NATIVE_TOOL_CREDENTIAL_ENV,
  reopenNativeTerminalsAfterDaemonReconnect,
} from "../../src/services/threads/native-terminal-threads.js";
import {
  clearNativeTerminalStateOnExit,
  interruptNativeTerminalQuestions,
  recordNativeTerminalActivity,
  settleNativeTerminalTurn,
} from "../../src/services/threads/native-terminal-activity.js";
import { buildThreadStatusChangeMetadata } from "../../src/services/threads/thread-runtime-display.js";
import * as titleGeneration from "../../src/services/threads/title-generation.js";
import {
  isNativeTerminalQuestion,
  NATIVE_TERMINAL_QUESTION_REQUEST_PREFIX,
  type PendingInteraction,
  type ProviderNativeTerminalActivity,
} from "@bb/domain";

interface NativeActivitySignalForTest {
  state: "working" | "idle" | null;
  prompt: string | null;
  question?: { id: string; prompt: string };
  answered?: string;
}

type NativeActivityReportForTest =
  | {
      state: "waiting";
      prompt: null;
      questions: { id: string; prompt: string }[];
    }
  | { state: "working" | "idle"; prompt: string | null };

interface NativeActivityTestTools {
  classifyHookRecord(
    hooks: NonNullable<ProviderNativeTerminalActivity["hooks"]>,
    record: unknown,
  ): NativeActivitySignalForTest;
  classifyTranscriptRecord(
    transcript: NonNullable<ProviderNativeTerminalActivity["transcript"]>,
    record: unknown,
  ): NativeActivitySignalForTest;
  NativeActivityTracker: new () => {
    apply(
      signal: NativeActivitySignalForTest,
    ): NativeActivityReportForTest | null;
    heartbeat(): NativeActivityReportForTest | null;
  };
}

const {
  classifyHookRecord,
  classifyTranscriptRecord,
  NativeActivityTracker,
}: NativeActivityTestTools = await import(
  new URL("../../../cli/src/native-activity.ts", import.meta.url).href
);
import { readJson } from "../helpers/json.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
  seedThreadIdentity,
} from "../helpers/seed.js";
import {
  createTestAppHarness,
  createTestDb,
  type TestAppHarness,
} from "../helpers/test-app.js";

interface FakeDaemonSocket {
  close(code?: number, reason?: string): void;
  send(data: string): void;
  sentMessages: string[];
}

interface Fixture {
  environment: ReturnType<typeof seedEnvironment>;
  harness: TestAppHarness;
  hostId: string;
  projectId: string;
  sessionId: string;
  socket: FakeDaemonSocket;
}

type DaemonMessage<TType extends HostDaemonServerWsMessage["type"]> = Extract<
  HostDaemonServerWsMessage,
  { type: TType }
>;

const SESSION_ID = "2e624c50-68af-4689-9410-06caa371eb8a";
const harnesses: TestAppHarness[] = [];

afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.cleanup();
});

async function createFixture(db?: DbConnection): Promise<Fixture> {
  const harness = await createTestAppHarness({ db });
  harnesses.push(harness);
  const seeded = seedHostSession(harness.deps, { id: "native-mode-host" });
  const { project } = seedProjectWithSource(harness.deps, {
    hostId: seeded.host.id,
    path: "/tmp/native-mode-project",
  });
  const environment = seedEnvironment(harness.deps, {
    hostId: seeded.host.id,
    path: "/tmp/native-mode-workspace",
    projectId: project.id,
    status: "ready",
  });
  const sentMessages: string[] = [];
  const socket: FakeDaemonSocket = {
    close: vi.fn(),
    send: vi.fn((data: string) => {
      sentMessages.push(data);
    }),
    sentMessages,
  };
  harness.hub.registerDaemon(seeded.session.id, seeded.host.id, socket);
  return {
    environment,
    harness,
    hostId: seeded.host.id,
    projectId: project.id,
    sessionId: seeded.session.id,
    socket,
  };
}

async function waitForDaemonMessage<
  TType extends HostDaemonServerWsMessage["type"],
>(fixture: Fixture, type: TType, skip = 0): Promise<DaemonMessage<TType>> {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const matches = fixture.socket.sentMessages
      .map((message) =>
        hostDaemonServerWsMessageSchema.parse(JSON.parse(message)),
      )
      .filter(
        (message): message is DaemonMessage<TType> => message.type === type,
      );
    const match = matches[skip];
    if (match !== undefined) return match;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${type}`);
}

function countDaemonMessages(fixture: Fixture, type: string): number {
  return fixture.socket.sentMessages.filter((message) =>
    message.includes(`"type":"${type}"`),
  ).length;
}

async function waitForThreadStop(
  fixture: Fixture,
  threadId: string,
  after: number,
) {
  for (let skip = after; ; skip += 1) {
    const request = await waitForDaemonMessage(
      fixture,
      "host-rpc.request",
      skip,
    );
    if (
      request.command.type === "thread.stop" &&
      request.command.threadId === threadId
    ) {
      return { command: request.command, requestId: request.requestId };
    }
  }
}

function answerThreadStop(
  fixture: Fixture,
  requestId: string,
  outcome: "released" | "failed",
): void {
  fixture.harness.hub.recordHostOnlineRpcResponse({
    message: hostDaemonOnlineRpcResponseMessageSchema.parse(
      outcome === "released"
        ? {
            type: "host-rpc.response",
            requestId,
            commandType: "thread.stop",
            ok: true,
            result: { providerCheckpointId: null },
          }
        : {
            type: "host-rpc.response",
            requestId,
            commandType: "thread.stop",
            ok: false,
            errorCode: "test_release_failure",
            errorMessage: "Test release failure",
          },
    ),
    sessionId: fixture.sessionId,
  });
}

function currentHolderCredential(
  fixture: Fixture,
  threadId: string,
): string | undefined {
  const opens = fixture.socket.sentMessages
    .map((message) =>
      hostDaemonServerWsMessageSchema.parse(JSON.parse(message)),
    )
    .filter(
      (message): message is DaemonMessage<"terminal.open"> =>
        message.type === "terminal.open" && message.threadId === threadId,
    );
  const latest = opens.at(-1);
  const entry = latest?.contributedEnv.find(
    (candidate) => candidate.name === NATIVE_TOOL_CREDENTIAL_ENV,
  );
  return typeof entry?.value === "string" ? entry.value : undefined;
}

async function postJson(
  fixture: Fixture,
  path: string,
  body: unknown,
  authorization?: string | null,
): Promise<Response> {
  const activityThread =
    /^\/threads\/([^/]+)\/native-terminal\/activity$/u.exec(path)?.[1];
  const resolved =
    authorization === undefined && activityThread !== undefined
      ? (() => {
          const credential = currentHolderCredential(fixture, activityThread);
          return credential === undefined ? undefined : `Bearer ${credential}`;
        })()
      : (authorization ?? undefined);
  return fixture.harness.app.request(`/api/v1${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(resolved === undefined ? {} : { authorization: resolved }),
    },
    body: JSON.stringify(body),
  });
}

async function switchMode(
  fixture: Fixture,
  threadId: string,
  mode: "terminal" | "chat",
): Promise<Response> {
  return postJson(fixture, `/threads/${threadId}/native-terminal/mode`, {
    mode,
  });
}

function seedChatThread(
  fixture: Fixture,
  args: { providerId: string; providerThreadId: string | null },
) {
  const thread = seedThread(fixture.harness.deps, {
    projectId: fixture.projectId,
    environmentId: fixture.environment.id,
    providerId: args.providerId,
  });
  if (args.providerThreadId !== null) {
    seedThreadIdentity(fixture.harness.deps, {
      threadId: thread.id,
      environmentId: fixture.environment.id,
      providerThreadId: args.providerThreadId,
    });
  }
  return thread;
}

function acknowledgeOpen(
  fixture: Fixture,
  open: DaemonMessage<"terminal.open">,
): void {
  fixture.harness.deps.terminalSessions.handleDaemonTerminalMessage({
    hostId: fixture.hostId,
    sessionId: fixture.sessionId,
    message: {
      type: "terminal.opened",
      requestId: open.requestId,
      terminalId: open.terminalId,
      shell: "/bin/zsh",
      title: "zsh",
      initialCwd: "/tmp/native-mode-workspace",
      cols: open.cols,
      rows: open.rows,
    },
  });
}

async function readApiErrorCode(response: Response): Promise<string> {
  return apiErrorSchema.parse(await readJson(response)).code;
}

async function enterTerminal(fixture: Fixture, threadId: string) {
  const stops = countDaemonMessages(fixture, "host-rpc.request");
  const opens = countDaemonMessages(fixture, "terminal.open");
  const switching = switchMode(fixture, threadId, "terminal");
  const stop = await waitForThreadStop(fixture, threadId, stops);
  expect(stop.command).toMatchObject({ intent: "release" });
  expect(isNativeTerminalThread(fixture.harness.db, threadId)).toBe(true);
  answerThreadStop(fixture, stop.requestId, "released");
  const open = await waitForDaemonMessage(fixture, "terminal.open", opens);
  expect(open.threadId).toBe(threadId);
  acknowledgeOpen(fixture, open);
  const response = await switching;
  expect(response.status).toBe(200);
  return {
    open,
    view: nativeTerminalThreadSchema.parse(await readJson(response)),
  };
}

describe("switching a chat thread to its native terminal", () => {
  it("resumes the chat's session in the terminal and returns to chat on it", async () => {
    const fixture = await createFixture();
    const thread = seedChatThread(fixture, {
      providerId: "claude-code",
      providerThreadId: SESSION_ID,
    });

    const { open, view } = await enterTerminal(fixture, thread.id);
    expect(view).toMatchObject({
      threadId: thread.id,
      providerId: "claude-code",
      nativeSessionId: SESSION_ID,
      canReturnToChat: true,
    });
    expect(view.terminal?.id).toBe(open.terminalId);
    const launch = nativeTerminalLaunchSpecSchema.parse(
      await readJson(
        await postJson(
          fixture,
          `/threads/${thread.id}/native-terminal/launch`,
          {},
        ),
      ),
    );
    expect(launch).toMatchObject({
      nativeSessionId: SESSION_ID,
      initialPrompt: null,
      initialImages: [],
    });

    const again = await switchMode(fixture, thread.id, "terminal");
    expect(again.status).toBe(200);
    expect(
      nativeTerminalThreadSchema.parse(await readJson(again)).terminal?.id,
    ).toBe(open.terminalId);

    const leaving = switchMode(fixture, thread.id, "chat");
    const close = await waitForDaemonMessage(fixture, "terminal.close");
    expect(close.terminalId).toBe(open.terminalId);
    expect(isNativeTerminalThread(fixture.harness.db, thread.id)).toBe(true);
    fixture.harness.deps.terminalSessions.handleDaemonTerminalMessage({
      hostId: fixture.hostId,
      sessionId: fixture.sessionId,
      message: {
        type: "terminal.exited",
        terminalId: open.terminalId,
        exitCode: 0,
        closeReason: "user",
      },
    });
    const left = await leaving;
    expect(left.status).toBe(200);
    expect(await readJson(left)).toBeNull();
    expect(getNativeTerminalThread(fixture.harness.db, thread.id)).toBeNull();

    const reentered = await enterTerminal(fixture, thread.id);
    expect(reentered.view.nativeSessionId).toBe(SESSION_ID);
  });

  it("waits for a reopen in flight before returning to chat", async () => {
    const fixture = await createFixture();
    const thread = seedChatThread(fixture, {
      providerId: "claude-code",
      providerThreadId: SESSION_ID,
    });
    const { open } = await enterTerminal(fixture, thread.id);
    fixture.harness.deps.terminalSessions.handleDaemonTerminalMessage({
      hostId: fixture.hostId,
      sessionId: fixture.sessionId,
      message: {
        type: "terminal.exited",
        terminalId: open.terminalId,
        exitCode: 0,
        closeReason: "process-exit",
      },
    });

    const opens = countDaemonMessages(fixture, "terminal.open");
    const reopening = postJson(
      fixture,
      `/threads/${thread.id}/native-terminal/open`,
      {},
    );
    const reopen = await waitForDaemonMessage(fixture, "terminal.open", opens);
    const leaving = switchMode(fixture, thread.id, "chat");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(countDaemonMessages(fixture, "terminal.close")).toBe(0);
    acknowledgeOpen(fixture, reopen);
    expect((await reopening).status).toBe(200);

    const close = await waitForDaemonMessage(fixture, "terminal.close");
    expect(close.terminalId).toBe(reopen.terminalId);
    fixture.harness.deps.terminalSessions.handleDaemonTerminalMessage({
      hostId: fixture.hostId,
      sessionId: fixture.sessionId,
      message: {
        type: "terminal.exited",
        terminalId: reopen.terminalId,
        exitCode: 0,
        closeReason: "user",
      },
    });
    const left = await leaving;
    expect(left.status).toBe(200);
    expect(getNativeTerminalThread(fixture.harness.db, thread.id)).toBeNull();
  });

  it("keeps the thread in chat when the agent cannot be stopped", async () => {
    const fixture = await createFixture();
    const thread = seedChatThread(fixture, {
      providerId: "claude-code",
      providerThreadId: SESSION_ID,
    });
    const switching = switchMode(fixture, thread.id, "terminal");
    const stop = await waitForThreadStop(fixture, thread.id, 0);
    answerThreadStop(fixture, stop.requestId, "failed");
    const response = await switching;
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(isNativeTerminalThread(fixture.harness.db, thread.id)).toBe(false);
    expect(
      fixture.socket.sentMessages.some((message) =>
        message.includes('"terminal.open"'),
      ),
    ).toBe(false);
  });

  it("refuses threads it cannot resume in a terminal", async () => {
    const fixture = await createFixture();
    const noCli = seedChatThread(fixture, {
      providerId: "fake",
      providerThreadId: "fake-session",
    });
    const unsupported = await switchMode(fixture, noCli.id, "terminal");
    expect(unsupported.status).toBe(409);
    expect(await readApiErrorCode(unsupported)).toBe(
      "native_terminal_unsupported",
    );

    const fresh = seedChatThread(fixture, {
      providerId: "claude-code",
      providerThreadId: null,
    });
    const noSession = await switchMode(fixture, fresh.id, "terminal");
    expect(noSession.status).toBe(409);
    expect(await readApiErrorCode(noSession)).toBe(
      "native_terminal_no_session",
    );

    const chat = await switchMode(fixture, fresh.id, "chat");
    expect(chat.status).toBe(200);
    expect(await readJson(chat)).toBeNull();

    for (const thread of [noCli, fresh]) {
      expect(isNativeTerminalThread(fixture.harness.db, thread.id)).toBe(false);
    }
  });

  it("keeps a thread born in the terminal there", async () => {
    const fixture = await createFixture();
    const created = await postJson(fixture, "/threads", {
      projectId: fixture.projectId,
      providerId: "claude-code",
      origin: "cli",
      input: [],
      environment: { type: "reuse", environmentId: fixture.environment.id },
      nativeTerminal: true,
    });
    expect(created.status).toBe(201);
    const thread = threadResponseSchema.parse(await readJson(created));
    const view = nativeTerminalThreadSchema.parse(
      await readJson(
        await fixture.harness.app.request(
          `/api/v1/threads/${thread.id}/native-terminal`,
        ),
      ),
    );
    expect(view.canReturnToChat).toBe(false);
    const chat = await switchMode(fixture, thread.id, "chat");
    expect(chat.status).toBe(409);
    expect(await readApiErrorCode(chat)).toBe(
      "native_terminal_no_chat_session",
    );
    expect(isNativeTerminalThread(fixture.harness.db, thread.id)).toBe(true);
  });
});

function withHolderCloses<
  T extends { closes?: string[]; questions?: { id: string }[] },
>(fixture: Fixture, threadId: string, body: T): T {
  if (body.closes !== undefined) return body;
  const listed = new Set((body.questions ?? []).map((question) => question.id));
  const closes = fixture.harness.deps.pendingInteractions
    .listPendingThreadInteractions(threadId)
    .flatMap((interaction) =>
      isNativeTerminalQuestion(interaction)
        ? [
            interaction.providerRequestId.slice(
              NATIVE_TERMINAL_QUESTION_REQUEST_PREFIX.length,
            ),
          ]
        : [],
    )
    .filter((id) => !listed.has(id));
  return { ...body, closes };
}

function reportActivity(
  fixture: Fixture,
  threadId: string,
  body: {
    state: "working" | "waiting" | "idle";
    prompt?: string;
    questions?: { id: string; prompt: string }[];
  },
): Promise<Response> {
  return postJson(
    fixture,
    `/threads/${threadId}/native-terminal/activity`,
    withHolderCloses(fixture, threadId, body),
  );
}

function terminalCredential(open: DaemonMessage<"terminal.open">): string {
  const entry = open.contributedEnv.find(
    (candidate) => candidate.name === NATIVE_TOOL_CREDENTIAL_ENV,
  );
  if (typeof entry?.value !== "string") {
    throw new Error(
      "Expected terminal open to contribute its native credential",
    );
  }
  return entry.value;
}

function threadStatus(fixture: Fixture, threadId: string) {
  return getThread(fixture.harness.db, threadId)?.status;
}

describe("native terminal activity", () => {
  it("notifies the first receipt after a same-state terminal rebind", async () => {
    const fixture = await createFixture();
    const thread = seedChatThread(fixture, {
      providerId: "claude-code",
      providerThreadId: SESSION_ID,
    });
    const { open } = await enterTerminal(fixture, thread.id);
    const originalCredential = terminalCredential(open);
    const notify = vi.spyOn(fixture.harness.hub, "notifyThread");
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    const receiptMetadataAt = (timestamp: number) =>
      notify.mock.calls
        .map((call) => call[2])
        .filter(
          (metadata) =>
            metadata?.statusChange?.runtime.nativeActivity?.lastEvidenceAt ===
            timestamp,
        );

    try {
      const initial = await postJson(
        fixture,
        `/threads/${thread.id}/native-terminal/activity`,
        { state: "working" },
        `Bearer ${originalCredential}`,
      );
      expect(initial.status).toBe(200);
      expect(
        getNativeTerminalThread(fixture.harness.db, thread.id)?.lastEvidenceAt,
      ).toBe(1_000_000);
      expect(receiptMetadataAt(1_000_000)).toHaveLength(1);

      fixture.harness.deps.terminalSessions.handleDaemonTerminalMessage({
        hostId: fixture.hostId,
        sessionId: fixture.sessionId,
        message: {
          type: "terminal.exited",
          terminalId: open.terminalId,
          exitCode: 0,
          closeReason: "process-exit",
        },
      });
      const opens = countDaemonMessages(fixture, "terminal.open");
      clock.mockReturnValue(1_000_500);
      const reopening = postJson(
        fixture,
        `/threads/${thread.id}/native-terminal/open`,
        {},
      );
      const reopened = await waitForDaemonMessage(
        fixture,
        "terminal.open",
        opens,
      );
      expect(reopened.terminalId).not.toBe(open.terminalId);
      const reopenedCredential = terminalCredential(reopened);
      expect(reopenedCredential).not.toBe(originalCredential);
      acknowledgeOpen(fixture, reopened);
      expect((await reopening).status).toBe(200);
      expect(
        getNativeTerminalThread(fixture.harness.db, thread.id),
      ).toMatchObject({
        terminalSessionId: reopened.terminalId,
        lastEvidenceAt: null,
      });

      clock.mockReturnValue(1_000_750);
      const obsolete = await postJson(
        fixture,
        `/threads/${thread.id}/native-terminal/activity`,
        { state: "working" },
        `Bearer ${originalCredential}`,
      );
      expect(obsolete.status).toBe(401);
      expect(
        getNativeTerminalThread(fixture.harness.db, thread.id)?.lastEvidenceAt,
      ).toBeNull();

      clock.mockReturnValue(1_001_000);
      const firstReboundReceipt = await postJson(
        fixture,
        `/threads/${thread.id}/native-terminal/activity`,
        { state: "working" },
        `Bearer ${reopenedCredential}`,
      );
      expect(firstReboundReceipt.status).toBe(200);
      expect(threadStatus(fixture, thread.id)).toBe("active");
      expect(
        getNativeTerminalThread(fixture.harness.db, thread.id)?.lastEvidenceAt,
      ).toBe(1_001_000);
      expect(receiptMetadataAt(1_001_000)).toHaveLength(1);

      clock.mockReturnValue(1_016_000);
      const throttledReceipt = await postJson(
        fixture,
        `/threads/${thread.id}/native-terminal/activity`,
        { state: "working" },
        `Bearer ${reopenedCredential}`,
      );
      expect(throttledReceipt.status).toBe(200);
      expect(
        getNativeTerminalThread(fixture.harness.db, thread.id)?.lastEvidenceAt,
      ).toBe(1_016_000);
      expect(receiptMetadataAt(1_016_000)).toHaveLength(0);

      clock.mockReturnValue(1_031_000);
      const heartbeat = await postJson(
        fixture,
        `/threads/${thread.id}/native-terminal/activity`,
        { state: "working" },
        `Bearer ${reopenedCredential}`,
      );
      expect(heartbeat.status).toBe(200);
      expect(
        getNativeTerminalThread(fixture.harness.db, thread.id)?.lastEvidenceAt,
      ).toBe(1_031_000);
      expect(receiptMetadataAt(1_031_000)).toHaveLength(1);
      expect(
        receiptMetadataAt(1_031_000)[0]?.statusChange?.runtime.nativeActivity
          ?.lastEvidenceAt,
      ).toBe(1_031_000);
      expect(threadStatus(fixture, thread.id)).toBe("active");
    } finally {
      clock.mockRestore();
      notify.mockRestore();
    }
  });

  it("stamps live receipts through silence and recovery", async () => {
    const fixture = await createFixture();
    const thread = seedChatThread(fixture, {
      providerId: "claude-code",
      providerThreadId: SESSION_ID,
    });
    await enterTerminal(fixture, thread.id);
    const nativeRecord = getNativeTerminalThread(fixture.harness.db, thread.id);
    if (nativeRecord?.terminalSessionId === null || nativeRecord === null) {
      throw new Error("Expected the native terminal to be bound");
    }
    const credential = "synthetic-native-activity-heartbeat-test";
    setNativeTerminalToolCredential(fixture.harness.db, {
      threadId: thread.id,
      terminalSessionId: nativeRecord.terminalSessionId,
      credentialHash: createHash("sha256").update(credential).digest("hex"),
    });
    const authorization = `Bearer ${credential}`;
    const notify = vi.spyOn(fixture.harness.hub, "notifyThread");
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    try {
      recordNativeTerminalActivity(fixture.harness.deps, {
        confirms: true,
        authorization,
        threadId: thread.id,
        state: "working",
      });
      expect(
        getNativeTerminalThread(fixture.harness.db, thread.id)?.lastEvidenceAt,
      ).toBe(1_000_000);
      await vi.advanceTimersByTimeAsync(15_000);
      recordNativeTerminalActivity(fixture.harness.deps, {
        confirms: true,
        authorization,
        threadId: thread.id,
        state: "working",
      });
      await vi.advanceTimersByTimeAsync(15_000);
      recordNativeTerminalActivity(fixture.harness.deps, {
        confirms: true,
        authorization,
        threadId: thread.id,
        state: "working",
      });
      expect(
        getNativeTerminalThread(fixture.harness.db, thread.id)?.lastEvidenceAt,
      ).toBe(1_030_000);
      const receiptMetadataAt = (timestamp: number) =>
        notify.mock.calls
          .map((call) => call[2])
          .filter(
            (metadata) =>
              metadata?.statusChange?.runtime.nativeActivity?.lastEvidenceAt ===
              timestamp,
          );
      expect(receiptMetadataAt(1_030_000)).toHaveLength(1);
      expect(
        receiptMetadataAt(1_030_000)[0]?.statusChange?.runtime.nativeActivity
          ?.lastEvidenceAt,
      ).toBe(1_030_000);

      for (let period = 2; period <= 4; period += 1) {
        await vi.advanceTimersByTimeAsync(30_000);
        recordNativeTerminalActivity(fixture.harness.deps, {
          confirms: true,
          authorization,
          threadId: thread.id,
          state: "working",
        });
        const timestamp = 1_000_000 + period * 30_000;
        expect(receiptMetadataAt(timestamp)).toHaveLength(1);
        expect(
          receiptMetadataAt(timestamp)[0]?.statusChange?.runtime.nativeActivity
            ?.lastEvidenceAt,
        ).toBe(timestamp);
      }

      await vi.advanceTimersByTimeAsync(91_000);
      recordNativeTerminalActivity(fixture.harness.deps, {
        confirms: true,
        authorization,
        threadId: thread.id,
        state: "working",
      });
      expect(receiptMetadataAt(1_211_000)).toHaveLength(1);
      expect(
        receiptMetadataAt(1_211_000)[0]?.statusChange?.runtime.nativeActivity
          ?.lastEvidenceAt,
      ).toBe(1_211_000);

      const beforeTransition = notify.mock.calls.length;
      recordNativeTerminalActivity(fixture.harness.deps, {
        confirms: true,
        authorization,
        threadId: thread.id,
        state: "waiting",
      });
      expect(notify.mock.calls.length).toBeGreaterThan(beforeTransition);
    } finally {
      vi.useRealTimers();
      notify.mockRestore();
    }
  });

  it("keeps lifecycle acceptance when a valid reporter has no available thread environment", async () => {
    const fixture = await createFixture();
    const thread = seedChatThread(fixture, {
      providerId: "claude-code",
      providerThreadId: SESSION_ID,
    });
    await enterTerminal(fixture, thread.id);
    const nativeRecord = getNativeTerminalThread(fixture.harness.db, thread.id);
    if (nativeRecord?.terminalSessionId === null || nativeRecord === null) {
      throw new Error("Expected the native terminal to be bound");
    }
    const credential = "synthetic-native-activity-test-credential";
    setNativeTerminalToolCredential(fixture.harness.db, {
      threadId: thread.id,
      terminalSessionId: nativeRecord.terminalSessionId,
      credentialHash: createHash("sha256").update(credential).digest("hex"),
    });
    fixture.harness.db.$client
      .prepare("UPDATE threads SET environment_id = NULL WHERE id = ?")
      .run(thread.id);

    const response = await postJson(
      fixture,
      `/threads/${thread.id}/native-terminal/activity`,
      { state: "working" },
      `Bearer ${credential}`,
    );

    expect(response.status).toBe(200);
    expect(threadStatus(fixture, thread.id)).toBe("active");
    expect(
      getNativeTerminalThread(fixture.harness.db, thread.id)?.lastEvidenceAt,
    ).toBeNull();
  });

  it("propagates unexpected current terminal validation errors", async () => {
    const fixture = await createFixture();
    const thread = seedChatThread(fixture, {
      providerId: "claude-code",
      providerThreadId: SESSION_ID,
    });
    await enterTerminal(fixture, thread.id);
    const nativeRecord = getNativeTerminalThread(fixture.harness.db, thread.id);
    if (nativeRecord?.terminalSessionId === null || nativeRecord === null) {
      throw new Error("Expected the native terminal to be bound");
    }
    const credential = "synthetic-unexpected-validation-error-test";
    setNativeTerminalToolCredential(fixture.harness.db, {
      threadId: thread.id,
      terminalSessionId: nativeRecord.terminalSessionId,
      credentialHash: createHash("sha256").update(credential).digest("hex"),
    });
    const unexpected = new Error("unexpected terminal lookup failure");
    vi.spyOn(
      fixture.harness.deps.terminalSessions,
      "getTerminal",
    ).mockImplementation(() => {
      throw unexpected;
    });

    expect(() =>
      recordNativeTerminalActivity(fixture.harness.deps, {
        confirms: true,
        authorization: `Bearer ${credential}`,
        threadId: thread.id,
        state: "working",
      }),
    ).toThrow(unexpected);
    expect(
      getNativeTerminalThread(fixture.harness.db, thread.id)?.lastEvidenceAt,
    ).toBeNull();
  });

  it("rejects invalid and obsolete bearer activity with 401 and no effect", async () => {
    const fixture = await createFixture();
    const thread = seedChatThread(fixture, {
      providerId: "claude-code",
      providerThreadId: SESSION_ID,
    });
    await enterTerminal(fixture, thread.id);
    const nativeRecord = getNativeTerminalThread(fixture.harness.db, thread.id);
    if (nativeRecord?.terminalSessionId === null || nativeRecord === null) {
      throw new Error("Expected the native terminal to be bound");
    }

    const invalid = await postJson(
      fixture,
      `/threads/${thread.id}/native-terminal/activity`,
      { state: "idle" },
      "Bearer synthetic-invalid-activity-credential",
    );
    expect(invalid.status).toBe(401);
    expect(threadStatus(fixture, thread.id)).toBe("idle");

    const obsoleteCredential = "synthetic-obsolete-activity-credential";
    setNativeTerminalToolCredential(fixture.harness.db, {
      threadId: thread.id,
      terminalSessionId: "terminal-obsolete",
      credentialHash: createHash("sha256")
        .update(obsoleteCredential)
        .digest("hex"),
    });
    const obsolete = await postJson(
      fixture,
      `/threads/${thread.id}/native-terminal/activity`,
      { state: "working" },
      `Bearer ${obsoleteCredential}`,
    );

    expect(obsolete.status).toBe(401);
    expect(threadStatus(fixture, thread.id)).toBe("idle");
    expect(
      getNativeTerminalThread(fixture.harness.db, thread.id)?.lastEvidenceAt,
    ).toBeNull();
  });

  it("revives a daemon-restarted question for the terminal and settles it after the TUI answer", async () => {
    const fixture = await createFixture();
    const thread = seedChatThread(fixture, {
      providerId: "claude-code",
      providerThreadId: SESSION_ID,
    });
    await enterTerminal(fixture, thread.id);
    const question = { id: "toolu_survived_restart", prompt: "Continue?" };
    const nativeActivity = new NativeActivityTracker();
    const activity = fixture.harness.deps.providerRegistry.get(
      thread.providerId,
    )?.nativeTerminal?.activity;
    if (!activity?.transcript) {
      throw new Error("Expected Claude Code native terminal transcript rules");
    }
    const questionReport = nativeActivity.apply(
      classifyTranscriptRecord(activity.transcript, {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: question.id,
              name: "AskUserQuestion",
              input: { questions: [{ question: question.prompt }] },
            },
          ],
        },
      }),
    );
    expect(questionReport).toMatchObject({
      state: "waiting",
      questions: [question],
    });
    const report = (next: NativeActivityReportForTest | null) => {
      if (next?.state !== "waiting") {
        throw new Error(
          "Expected the native activity tracker to report waiting",
        );
      }
      return reportActivity(fixture, thread.id, {
        state: "waiting",
        questions: next.questions,
      });
    };
    const notification = vi.spyOn(
      interactiveRequests,
      "requestChildThreadNeedsAttentionNotification",
    );
    const warn = vi.spyOn(fixture.harness.deps.logger, "warn");
    expect((await report(questionReport)).status).toBe(200);
    const requestId = `native:${question.id}`;
    const before = getPendingInteractionByProviderRequest(fixture.harness.db, {
      providerId: "claude-code",
      providerThreadId: SESSION_ID,
      providerRequestId: requestId,
    });
    expect(before?.status).toBe("pending");
    expect(notification).toHaveBeenCalledTimes(1);

    fixture.harness.deps.pendingInteractions.interruptPendingInteractionsForThreadIds(
      {
        threadIds: [thread.id],
        reason:
          "Host daemon restarted while awaiting user interaction; retry the thread to continue",
      },
    );
    expect((await report(nativeActivity.heartbeat())).status).toBe(200);
    expect((await report(nativeActivity.heartbeat())).status).toBe(200);

    expect(
      fixture.harness.deps.pendingInteractions.listPendingThreadInteractions(
        thread.id,
      ),
    ).toHaveLength(1);
    expect(
      fixture.harness.deps.pendingInteractions.listPendingThreadInteractions(
        thread.id,
      )[0],
    ).toMatchObject({
      id: before?.id,
      providerRequestId: requestId,
      payload: { kind: "user_question" },
    });
    const listed = await fixture.harness.app.request(
      `/api/v1/threads/${thread.id}/interactions`,
    );
    expect(await readJson(listed)).toHaveLength(1);
    const [revived] = openInteractions(fixture, thread.id);
    const answerFromBb = await postJson(
      fixture,
      `/threads/${thread.id}/interactions/${revived!.id}/resolve`,
      {
        kind: "user_answer",
        answers: { [requestId]: { selected: [], freeText: "continue" } },
      },
    );
    expect(answerFromBb.status).toBe(409);
    expect(
      apiErrorSchema.parse(await readJson(answerFromBb)).message,
    ).toContain("Answer it there");

    const answeredActivity = nativeActivity.apply(
      classifyTranscriptRecord(activity.transcript, {
        type: "user",
        message: {
          content: [{ type: "tool_result", tool_use_id: question.id }],
        },
      }),
    );
    expect(answeredActivity).toEqual({ state: "working", prompt: null });
    expect(
      (
        await reportActivity(fixture, thread.id, {
          state: answeredActivity!.state,
        })
      ).status,
    ).toBe(200);
    expect(
      getPendingInteractionByProviderRequest(fixture.harness.db, {
        providerId: "claude-code",
        providerThreadId: SESSION_ID,
        providerRequestId: requestId,
      }),
    ).toMatchObject({
      id: before?.id,
      status: "interrupted",
      statusReason: "native-terminal-question-answered",
    });

    expect(
      (await reportActivity(fixture, thread.id, { state: "working" })).status,
    ).toBe(200);
    expect(
      getPendingInteractionByProviderRequest(fixture.harness.db, {
        providerId: "claude-code",
        providerThreadId: SESSION_ID,
        providerRequestId: requestId,
      }),
    ).toMatchObject({ id: before?.id, status: "interrupted" });
    expect(openInteractions(fixture, thread.id)).toHaveLength(0);
    expect(notification).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it("keeps answered native questions rejected and warns only once", async () => {
    const fixture = await createFixture();
    const thread = seedChatThread(fixture, {
      providerId: "claude-code",
      providerThreadId: SESSION_ID,
    });
    await enterTerminal(fixture, thread.id);
    const question = { id: "toolu_answered", prompt: "Continue?" };
    const report = () =>
      reportActivity(fixture, thread.id, {
        state: "waiting",
        questions: [question],
      });
    const notification = vi.spyOn(
      interactiveRequests,
      "requestChildThreadNeedsAttentionNotification",
    );
    expect((await report()).status).toBe(200);
    notification.mockClear();
    const requestId = `native:${question.id}`;
    const original = getPendingInteractionByProviderRequest(
      fixture.harness.db,
      {
        providerId: "claude-code",
        providerThreadId: SESSION_ID,
        providerRequestId: requestId,
      },
    );
    expect(original?.status).toBe("pending");
    if (!original) throw new Error("Expected a pending native question");
    interruptNativeTerminalQuestions(fixture.harness.deps, thread.id);
    expect(
      getPendingInteractionByProviderRequest(fixture.harness.db, {
        providerId: "claude-code",
        providerThreadId: SESSION_ID,
        providerRequestId: requestId,
      })?.statusReason,
    ).toBe("native-terminal-question-answered");
    const warn = vi.spyOn(fixture.harness.deps.logger, "warn");

    expect((await report()).status).toBe(200);
    expect((await report()).status).toBe(200);

    expect(
      getPendingInteractionByProviderRequest(fixture.harness.db, {
        providerId: "claude-code",
        providerThreadId: SESSION_ID,
        providerRequestId: requestId,
      }),
    ).toMatchObject({ id: original?.id, status: "interrupted" });
    expect(
      fixture.harness.deps.pendingInteractions.listPendingThreadInteractions(
        thread.id,
      ),
    ).toHaveLength(0);
    expect(
      listPendingInteractionsByThread(fixture.harness.db, {
        threadId: thread.id,
      }),
    ).toHaveLength(1);
    expect(notification).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("keeps user-cancelled native questions rejected without a notification", async () => {
    const fixture = await createFixture();
    const thread = seedChatThread(fixture, {
      providerId: "claude-code",
      providerThreadId: SESSION_ID,
    });
    await enterTerminal(fixture, thread.id);
    const question = { id: "toolu_cancelled", prompt: "Continue?" };
    const report = () =>
      reportActivity(fixture, thread.id, {
        state: "waiting",
        questions: [question],
      });
    const notification = vi.spyOn(
      interactiveRequests,
      "requestChildThreadNeedsAttentionNotification",
    );
    expect((await report()).status).toBe(200);
    const requestId = `native:${question.id}`;
    const original = getPendingInteractionByProviderRequest(
      fixture.harness.db,
      {
        providerId: "claude-code",
        providerThreadId: SESSION_ID,
        providerRequestId: requestId,
      },
    );
    expect(original?.status).toBe("pending");
    if (!original) throw new Error("Expected a pending native question");
    notification.mockClear();
    fixture.harness.deps.pendingInteractions.interruptPendingInteraction({
      interactionId: original.id,
      reason: "user",
    });
    const warn = vi.spyOn(fixture.harness.deps.logger, "warn");

    expect((await report()).status).toBe(200);
    expect((await report()).status).toBe(200);

    expect(
      getPendingInteractionByProviderRequest(fixture.harness.db, {
        providerId: "claude-code",
        providerThreadId: SESSION_ID,
        providerRequestId: requestId,
      }),
    ).toMatchObject({
      id: original.id,
      status: "interrupted",
      statusReason: "user",
    });
    expect(
      fixture.harness.deps.pendingInteractions.listPendingThreadInteractions(
        thread.id,
      ),
    ).toHaveLength(0);
    expect(
      listPendingInteractionsByThread(fixture.harness.db, {
        threadId: thread.id,
      }),
    ).toHaveLength(1);
    expect(notification).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("keeps working across a provisional Claude Stop and the next tool", async () => {
    const fixture = await createFixture();
    const thread = seedChatThread(fixture, {
      providerId: "claude-code",
      providerThreadId: SESSION_ID,
    });
    await enterTerminal(fixture, thread.id);
    const hooks =
      fixture.harness.deps.providerRegistry.get("claude-code")!.nativeTerminal!
        .activity!.hooks!;
    for (const [hook_event_name, expected] of [
      ["UserPromptSubmit", "active"],
      ["Stop", "active"],
      ["PreToolUse", "active"],
    ] as const) {
      const signal = classifyHookRecord(hooks, { hook_event_name });
      if (signal.state !== null) {
        await reportActivity(fixture, thread.id, { state: signal.state });
      }
      expect(threadStatus(fixture, thread.id)).toBe(expected);
    }
  });

  it.each([false, true])(
    "settles the real Claude Stop after continuation (stop_hook_active=%s)",
    async (stop_hook_active) => {
      const fixture = await createFixture();
      const thread = seedChatThread(fixture, {
        providerId: "claude-code",
        providerThreadId: SESSION_ID,
      });
      await enterTerminal(fixture, thread.id);
      const activity =
        fixture.harness.deps.providerRegistry.get("claude-code")!
          .nativeTerminal!.activity!;
      const hooks = activity.hooks!;
      for (const hook_event_name of [
        "UserPromptSubmit",
        "Stop",
        "PreToolUse",
      ]) {
        const signal = classifyHookRecord(hooks, { hook_event_name });
        if (signal.state !== null) {
          await reportActivity(fixture, thread.id, { state: signal.state });
        }
      }
      expect(threadStatus(fixture, thread.id)).toBe("active");
      const signal = classifyHookRecord(hooks, {
        hook_event_name: "Stop",
        stop_hook_active,
      });
      expect(signal.state).toBeNull();
      expect(threadStatus(fixture, thread.id)).toBe("active");
      const completed = classifyTranscriptRecord(activity.transcript!, {
        type: "system",
        subtype: "stop_hook_summary",
        hasOutput: false,
        isSidechain: false,
      });
      expect(completed.state).toBe("idle");
      await reportActivity(fixture, thread.id, { state: completed.state! });
      expect(threadStatus(fixture, thread.id)).toBe("idle");
    },
  );

  it("writes nothing, appends no event and broadcasts nothing for repeated credentialless working signals, which are rejected", async () => {
    const queries = vi.fn();
    const template = createTestDb();
    const db = createConnection(template.$client.serialize(), {
      slowQueryLogger: { info: queries },
      slowQueryThresholdMs: 0,
    });
    template.$client.close();
    const fixture = await createFixture(db);
    const thread = seedChatThread(fixture, {
      providerId: "claude-code",
      providerThreadId: SESSION_ID,
    });
    await enterTerminal(fixture, thread.id);
    expect(() =>
      recordNativeTerminalActivity(fixture.harness.deps, {
        confirms: true,
        threadId: thread.id,
        state: "working",
      }),
    ).toThrow(/valid credential/u);
    expect(
      getNativeTerminalThread(fixture.harness.db, thread.id)?.lastEvidenceAt,
    ).toBeNull();
    const changes = fixture.harness.db.$client
      .prepare("SELECT total_changes()")
      .pluck();
    const before = changes.get();
    queries.mockClear();
    const notify = vi.spyOn(fixture.harness.hub, "notifyThread");
    try {
      for (let i = 0; i < 100; i += 1) {
        expect(() =>
          recordNativeTerminalActivity(fixture.harness.deps, {
            confirms: true,
            threadId: thread.id,
            state: "working",
          }),
        ).toThrow(/valid credential/u);
      }
      expect(changes.get()).toBe(before);
      expect(notify).not.toHaveBeenCalled();
      expect(
        getNativeTerminalThread(fixture.harness.db, thread.id)?.lastEvidenceAt,
      ).toBeNull();
    } finally {
      notify.mockRestore();
    }
    await reportActivity(fixture, thread.id, { state: "idle" });
    await reportActivity(fixture, thread.id, { state: "working" });
    expect(threadStatus(fixture, thread.id)).toBe("active");
  });

  it("keeps Codex tool and assistant entries working until task_complete, then handles another task and abort", async () => {
    const fixture = await createFixture();
    const thread = seedChatThread(fixture, {
      providerId: "codex",
      providerThreadId: SESSION_ID,
    });
    await enterTerminal(fixture, thread.id);
    const transcript =
      fixture.harness.deps.providerRegistry.get("codex")!.nativeTerminal!
        .activity!.transcript!;
    for (const [record, expected] of [
      [{ type: "event_msg", payload: { type: "task_started" } }, "active"],
      [
        {
          type: "event_msg",
          payload: { type: "agent_message", message: "done" },
        },
        "active",
      ],
      [
        {
          type: "response_item",
          payload: { type: "function_call", name: "exec_command" },
        },
        "active",
      ],
      [{ type: "event_msg", payload: { type: "task_complete" } }, "idle"],
      [{ type: "event_msg", payload: { type: "task_started" } }, "active"],
      [{ type: "event_msg", payload: { type: "turn_aborted" } }, "idle"],
    ] as const) {
      const signal = classifyTranscriptRecord(transcript, record);
      if (signal.state !== null)
        await reportActivity(fixture, thread.id, { state: signal.state });
      expect(threadStatus(fixture, thread.id)).toBe(expected);
    }
  });

  it("shows a converted thread working while its CLI runs a turn, then done", async () => {
    const fixture = await createFixture();
    const thread = seedChatThread(fixture, {
      providerId: "claude-code",
      providerThreadId: SESSION_ID,
    });
    await enterTerminal(fixture, thread.id);
    expect(threadStatus(fixture, thread.id)).toBe("idle");
    const before = getThread(fixture.harness.db, thread.id)!.latestAttentionAt;

    for (const _ of [1, 2]) {
      const working = await reportActivity(fixture, thread.id, {
        state: "working",
      });
      expect(working.status).toBe(200);
      expect(threadStatus(fixture, thread.id)).toBe("active");
    }
    await new Promise((resolve) => setTimeout(resolve, 2));
    for (const _ of [1, 2]) {
      const idle = await reportActivity(fixture, thread.id, { state: "idle" });
      expect(idle.status).toBe(200);
      expect(threadStatus(fixture, thread.id)).toBe("idle");
    }
    expect(
      getThread(fixture.harness.db, thread.id)!.latestAttentionAt,
    ).toBeGreaterThan(before);
  });

  it("shows the turn working again after a daemon restart marked it failed", async () => {
    const fixture = await createFixture();
    const thread = seedChatThread(fixture, {
      providerId: "claude-code",
      providerThreadId: SESSION_ID,
    });
    await enterTerminal(fixture, thread.id);
    await reportActivity(fixture, thread.id, { state: "working" });
    applyLoggedThreadLifecycleEvent(fixture.harness.deps, {
      event: { type: "run.failed" },
      threadId: thread.id,
    });
    expect(threadStatus(fixture, thread.id)).toBe("error");

    await reportActivity(fixture, thread.id, { state: "working" });
    expect(threadStatus(fixture, thread.id)).toBe("active");
    await reportActivity(fixture, thread.id, { state: "idle" });
    expect(threadStatus(fixture, thread.id)).toBe("idle");
  });

  it("lets a host-wide stop settle a working native thread like an idle agent", async () => {
    const fixture = await createFixture();
    const thread = seedChatThread(fixture, {
      providerId: "claude-code",
      providerThreadId: SESSION_ID,
    });
    await enterTerminal(fixture, thread.id);
    await reportActivity(fixture, thread.id, { state: "working" });
    const working = getThread(fixture.harness.db, thread.id)!;
    expect(working.status).toBe("active");
    const requests = countDaemonMessages(fixture, "host-rpc.request");

    const stopping = stopThreadForCurrentState(
      fixture.harness.deps,
      working,
      { id: fixture.environment.id, hostId: fixture.hostId },
      { requireStopped: true },
    );
    for (let answered = requests; ; answered += 1) {
      const settled = await Promise.race([
        stopping.then(() => true),
        waitForThreadStop(fixture, thread.id, answered).then((stop) => {
          answerThreadStop(fixture, stop.requestId, "released");
          return false;
        }),
      ]);
      if (settled) break;
    }
    await stopping;
    expect(threadStatus(fixture, thread.id)).toBe("idle");
    expect(isNativeTerminalThread(fixture.harness.db, thread.id)).toBe(true);
    await reportActivity(fixture, thread.id, { state: "working" });
    expect(threadStatus(fixture, thread.id)).toBe("active");
    await reportActivity(fixture, thread.id, { state: "idle" });
    expect(threadStatus(fixture, thread.id)).toBe("idle");
  });

  it("rejects working activity after a cached native thread is deleted", async () => {
    const fixture = await createFixture();
    const thread = seedChatThread(fixture, {
      providerId: "claude-code",
      providerThreadId: SESSION_ID,
    });
    await enterTerminal(fixture, thread.id);
    await reportActivity(fixture, thread.id, { state: "working" });
    deleteThread(fixture.harness.db, fixture.harness.hub, thread.id);

    const response = await reportActivity(fixture, thread.id, {
      state: "working",
    });
    expect(response.status).toBe(404);
  });

  it("refuses activity for a thread that is not in its terminal", async () => {
    const fixture = await createFixture();
    const thread = seedChatThread(fixture, {
      providerId: "claude-code",
      providerThreadId: SESSION_ID,
    });
    const response = await reportActivity(fixture, thread.id, {
      state: "working",
    });
    expect(response.status).toBe(404);
    expect(await readApiErrorCode(response)).toBe(
      "native_terminal_thread_not_found",
    );
    expect(threadStatus(fixture, thread.id)).toBe("idle");
  });

  it("stops a native turn by pressing Esc in the CLI, not by stopping an agent", async () => {
    const fixture = await createFixture();
    const thread = seedChatThread(fixture, {
      providerId: "claude-code",
      providerThreadId: SESSION_ID,
    });
    const { open } = await enterTerminal(fixture, thread.id);
    await reportActivity(fixture, thread.id, { state: "working" });
    const stops = countDaemonMessages(fixture, "host-rpc.request");

    const stopped = await postJson(fixture, `/threads/${thread.id}/stop`, {});
    expect(stopped.status).toBe(200);
    const input = await waitForDaemonMessage(fixture, "terminal.input");
    expect(input).toMatchObject({
      terminalId: open.terminalId,
      dataBase64: Buffer.from("\u001b").toString("base64"),
    });
    expect(countDaemonMessages(fixture, "host-rpc.request")).toBe(stops);
  });

  it("settles a working thread when it goes back to chat", async () => {
    const fixture = await createFixture();
    const thread = seedChatThread(fixture, {
      providerId: "claude-code",
      providerThreadId: SESSION_ID,
    });
    const { open } = await enterTerminal(fixture, thread.id);
    await reportActivity(fixture, thread.id, { state: "working" });
    expect(threadStatus(fixture, thread.id)).toBe("active");

    const leaving = switchMode(fixture, thread.id, "chat");
    await waitForDaemonMessage(fixture, "terminal.close");
    fixture.harness.deps.terminalSessions.handleDaemonTerminalMessage({
      hostId: fixture.hostId,
      sessionId: fixture.sessionId,
      message: {
        type: "terminal.exited",
        terminalId: open.terminalId,
        exitCode: 0,
        closeReason: "user",
      },
    });
    expect((await leaving).status).toBe(200);
    expect(threadStatus(fixture, thread.id)).toBe("idle");
    expect(
      (await reportActivity(fixture, thread.id, { state: "working" })).status,
    ).toBe(404);
    expect(threadStatus(fixture, thread.id)).toBe("idle");
  });
});

function openInteractions(fixture: Fixture, threadId: string) {
  return fixture.harness.deps.pendingInteractions.listPendingThreadInteractions(
    threadId,
  );
}

function nativeRequestIds(interactions: PendingInteraction[]): string[] {
  const ids = interactions.map((interaction) => {
    if (!isNativeTerminalQuestion(interaction)) {
      throw new Error(
        `expected a native terminal question, got ${interaction.id}`,
      );
    }
    expect(interaction.providerRequestId).toEqual(
      expect.stringMatching(
        new RegExp(`^${NATIVE_TERMINAL_QUESTION_REQUEST_PREFIX}.+`, "u"),
      ),
    );
    return interaction.providerRequestId;
  });
  expect(new Set(ids).size).toBe(ids.length);
  return ids;
}

describe("native terminal questions", () => {
  async function waitingThread() {
    const fixture = await createFixture();
    const thread = seedChatThread(fixture, {
      providerId: "claude-code",
      providerThreadId: SESSION_ID,
    });
    const { open } = await enterTerminal(fixture, thread.id);
    await reportActivity(fixture, thread.id, { state: "working" });
    return { fixture, thread, open };
  }

  it("shows a thread blocked on a question as waiting and clears it when the turn resumes", async () => {
    const { fixture, thread } = await waitingThread();
    const waiting = {
      state: "waiting" as const,
      questions: [{ id: "toolu_ask", prompt: "Merge now?" }],
    };
    for (const _ of [1, 2, 3]) {
      expect((await reportActivity(fixture, thread.id, waiting)).status).toBe(
        200,
      );
    }
    expect(threadStatus(fixture, thread.id)).toBe("active");
    const open = openInteractions(fixture, thread.id);
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({
      status: "pending",
      providerRequestId: "native:toolu_ask",
      payload: {
        kind: "user_question",
        questions: [{ prompt: "Merge now?" }],
      },
    });
    const listed = await fixture.harness.app.request(
      `/api/v1/threads/${thread.id}/interactions`,
    );
    expect(await readJson(listed)).toHaveLength(1);

    await reportActivity(fixture, thread.id, { state: "working" });
    expect(openInteractions(fixture, thread.id)).toHaveLength(0);
    expect(threadStatus(fixture, thread.id)).toBe("active");
  });

  it("keeps only the questions still open and clears them when the turn ends", async () => {
    const { fixture, thread } = await waitingThread();
    await reportActivity(fixture, thread.id, {
      state: "waiting",
      questions: [
        { id: "a", prompt: "A?" },
        { id: "b", prompt: "B?" },
      ],
    });
    expect(openInteractions(fixture, thread.id)).toHaveLength(2);
    await reportActivity(fixture, thread.id, {
      state: "waiting",
      questions: [{ id: "b", prompt: "B?" }],
    });
    expect(
      openInteractions(fixture, thread.id).map((i) =>
        "providerRequestId" in i ? i.providerRequestId : null,
      ),
    ).toEqual(["native:b"]);

    await reportActivity(fixture, thread.id, { state: "idle" });
    expect(openInteractions(fixture, thread.id)).toHaveLength(0);
    expect(threadStatus(fixture, thread.id)).toBe("idle");
  });

  it("shows an idle thread waiting when its CLI asks before any turn was reported", async () => {
    const fixture = await createFixture();
    const thread = seedChatThread(fixture, {
      providerId: "claude-code",
      providerThreadId: SESSION_ID,
    });
    await enterTerminal(fixture, thread.id);
    expect(threadStatus(fixture, thread.id)).toBe("idle");
    await reportActivity(fixture, thread.id, {
      state: "waiting",
      questions: [{ id: "q", prompt: "Which branch?" }],
    });
    expect(threadStatus(fixture, thread.id)).toBe("active");
    expect(openInteractions(fixture, thread.id)).toHaveLength(1);
  });

  it("rejects malformed waiting reports", async () => {
    const { fixture, thread } = await waitingThread();
    for (const body of [
      { state: "waiting" },
      { state: "waiting", questions: [] },
      { state: "working", questions: [{ id: "q", prompt: "Q?" }] },
    ]) {
      const response = await postJson(
        fixture,
        `/threads/${thread.id}/native-terminal/activity`,
        body,
      );
      expect(response.status).toBe(400);
    }
    expect(openInteractions(fixture, thread.id)).toHaveLength(0);
  });

  it("refuses to answer a terminal question through the bridge", async () => {
    const { fixture, thread } = await waitingThread();
    await reportActivity(fixture, thread.id, {
      state: "waiting",
      questions: [{ id: "q", prompt: "Q?" }],
    });
    const [interaction] = openInteractions(fixture, thread.id);
    const response = await postJson(
      fixture,
      `/threads/${thread.id}/interactions/${interaction!.id}/resolve`,
      {
        kind: "user_answer",
        answers: { "native:q": { selected: [], freeText: "yes" } },
      },
    );
    expect(response.status).toBe(409);
    expect(await readApiErrorCode(response)).toBe(
      "native_terminal_interaction",
    );
    expect(openInteractions(fixture, thread.id)).toHaveLength(1);
  });

  it("drops the question when the thread returns to chat", async () => {
    const { fixture, thread, open } = await waitingThread();
    await reportActivity(fixture, thread.id, {
      state: "waiting",
      questions: [{ id: "q", prompt: "Q?" }],
    });
    const leaving = switchMode(fixture, thread.id, "chat");
    await waitForDaemonMessage(fixture, "terminal.close");
    fixture.harness.deps.terminalSessions.handleDaemonTerminalMessage({
      hostId: fixture.hostId,
      sessionId: fixture.sessionId,
      message: {
        type: "terminal.exited",
        terminalId: open.terminalId,
        exitCode: 0,
        closeReason: "user",
      },
    });
    const left = await leaving;
    expect(left.status).toBe(200);
    expect(openInteractions(fixture, thread.id)).toHaveLength(0);
  });

  function exitTerminal(
    fixture: Fixture,
    terminalId: string,
    closeReason: "daemon-disconnect" | "process-exit" | "user",
  ) {
    fixture.harness.deps.terminalSessions.handleDaemonTerminalMessage({
      hostId: fixture.hostId,
      sessionId: fixture.sessionId,
      message: {
        type: "terminal.exited",
        terminalId,
        exitCode: closeReason === "process-exit" ? 137 : 0,
        closeReason,
      },
    });
  }

  it.each([
    { closeReason: "process-exit", status: "idle" },
    { closeReason: "user", status: "active" },
  ] as const)(
    "clears the pending question when the CLI exits ($closeReason) without answering",
    async ({ closeReason, status }) => {
      const { fixture, thread, open } = await waitingThread();
      await reportActivity(fixture, thread.id, {
        state: "waiting",
        questions: [{ id: "q", prompt: "Q?" }],
      });
      expect(openInteractions(fixture, thread.id)).toHaveLength(1);
      expect(threadStatus(fixture, thread.id)).toBe("active");

      exitTerminal(fixture, open.terminalId, closeReason);

      expect(openInteractions(fixture, thread.id)).toHaveLength(0);
      expect(threadStatus(fixture, thread.id)).toBe(status);
      expect(isNativeTerminalThread(fixture.harness.db, thread.id)).toBe(true);
    },
  );

  it("keeps the pending question when the terminal only lost its daemon", async () => {
    const { fixture, thread, open } = await waitingThread();
    await reportActivity(fixture, thread.id, {
      state: "waiting",
      questions: [{ id: "q", prompt: "Q?" }],
    });

    exitTerminal(fixture, open.terminalId, "daemon-disconnect");

    expect(openInteractions(fixture, thread.id)).toHaveLength(1);
    expect(threadStatus(fixture, thread.id)).toBe("active");
  });
});

describe("native terminal activity evidence across a swap", () => {
  async function startNativeThread(fixture: Fixture) {
    const thread = seedChatThread(fixture, {
      providerId: "claude-code",
      providerThreadId: SESSION_ID,
    });
    const { open } = await enterTerminal(fixture, thread.id);
    return { open, credential: terminalCredential(open), thread };
  }

  async function reattachAfterDaemonDisconnect(
    fixture: Fixture,
    threadId: string,
    previous: DaemonMessage<"terminal.open">,
  ) {
    fixture.harness.deps.terminalSessions.handleDaemonTerminalMessage({
      hostId: fixture.hostId,
      sessionId: fixture.sessionId,
      message: {
        type: "terminal.exited",
        terminalId: previous.terminalId,
        exitCode: null,
        closeReason: "daemon-disconnect",
      },
    });
    const opens = countDaemonMessages(fixture, "terminal.open");
    const reopening = postJson(
      fixture,
      `/threads/${threadId}/native-terminal/open`,
      {},
    );
    const reopened = await waitForDaemonMessage(
      fixture,
      "terminal.open",
      opens,
    );
    acknowledgeOpen(fixture, reopened);
    expect((await reopening).status).toBe(200);
    return { reopened, credential: terminalCredential(reopened) };
  }

  const evidenceOf = (fixture: Fixture, threadId: string) =>
    getNativeTerminalThread(fixture.harness.db, threadId)?.lastEvidenceAt;

  const displayOf = (fixture: Fixture, threadId: string) => {
    const thread = getThread(fixture.harness.db, threadId);
    if (thread === null) throw new Error("thread missing");
    return buildThreadStatusChangeMetadata(fixture.harness.deps, thread)
      .statusChange?.runtime.nativeActivity;
  };

  const report = (
    fixture: Fixture,
    threadId: string,
    authorization?: string | null,
  ) =>
    postJson(
      fixture,
      `/threads/${threadId}/native-terminal/activity`,
      { state: "working" },
      authorization,
    );

  async function reattached(fixture: Fixture) {
    const {
      open,
      credential: before,
      thread,
    } = await startNativeThread(fixture);
    await report(fixture, thread.id, `Bearer ${before}`);
    const { credential: after, reopened } = await reattachAfterDaemonDisconnect(
      fixture,
      thread.id,
      open,
    );
    return { after, before, open, reopened, thread };
  }

  it("R1 rotation fencing: a pre-reattach credential is never stamped, even replayed after the current one reports", async () => {
    const fixture = await createFixture();
    const clock = vi.spyOn(Date, "now").mockReturnValue(2_000_000);
    try {
      const { after, before, open, reopened, thread } =
        await reattached(fixture);
      expect(reopened.terminalId).not.toBe(open.terminalId);
      expect(after).not.toBe(before);
      expect(evidenceOf(fixture, thread.id)).toBeNull();

      clock.mockReturnValue(2_001_000);
      expect(
        (await report(fixture, thread.id, `Bearer ${before}`)).status,
      ).toBe(401);
      expect(evidenceOf(fixture, thread.id)).toBeNull();
      expect(threadStatus(fixture, thread.id)).toBe("active");

      await report(fixture, thread.id, `Bearer ${after}`);
      expect(evidenceOf(fixture, thread.id)).toBe(2_001_000);

      clock.mockReturnValue(2_002_000);
      await report(fixture, thread.id, `Bearer ${before}`);
      expect(evidenceOf(fixture, thread.id)).toBe(2_001_000);
    } finally {
      clock.mockRestore();
    }
  });

  it("R3 a credential that was never issued is never stamped", async () => {
    const fixture = await createFixture();
    const clock = vi.spyOn(Date, "now").mockReturnValue(2_000_000);
    try {
      const { after, thread } = await reattached(fixture);
      for (const authorization of [
        "Bearer not-the-credential",
        `Bearer ${after}x`,
        `Basic ${after}`,
        after,
      ]) {
        await report(fixture, thread.id, authorization);
        expect(evidenceOf(fixture, thread.id)).toBeNull();
      }
      await report(fixture, thread.id, `Bearer ${after}`);
      expect(evidenceOf(fixture, thread.id)).toBe(2_000_000);
    } finally {
      clock.mockRestore();
    }
  });

  it("a legacy holder's credentialless report, and a stale-after-reattach report, have no effect and are answered with 401", async () => {
    const fixture = await createFixture();
    const clock = vi.spyOn(Date, "now").mockReturnValue(2_000_000);
    try {
      const started = await startNativeThread(fixture);
      const { thread } = started;
      const idle = (authorization?: string | null) =>
        postJson(
          fixture,
          `/threads/${thread.id}/native-terminal/activity`,
          { state: "idle" },
          authorization,
        );
      const before = threadStatus(fixture, thread.id);
      expect((await report(fixture, thread.id, null)).status).toBe(401);
      expect((await idle(null)).status).toBe(401);
      expect(threadStatus(fixture, thread.id)).toBe(before);

      await reattachAfterDaemonDisconnect(fixture, thread.id, started.open);
      for (const authorization of [null, `Bearer ${started.credential}`]) {
        const response = await report(fixture, thread.id, authorization);
        expect(response.status).toBe(401);
        expect(await readApiErrorCode(response)).toBe(
          "native_terminal_credential_invalid",
        );
      }
      expect(threadStatus(fixture, thread.id)).toBe(before);
      expect(evidenceOf(fixture, thread.id)).toBeNull();
    } finally {
      clock.mockRestore();
    }
  });

  it("another thread's credential sent to this thread has no effect and does not stamp it", async () => {
    const fixture = await createFixture();
    const first = await startNativeThread(fixture);
    const secondThread = seedChatThread(fixture, {
      providerId: "claude-code",
      providerThreadId: "7d0ffee0-1111-4222-8333-444455556666",
    });
    const secondOpen = (await enterTerminal(fixture, secondThread.id)).open;
    const second = {
      credential: terminalCredential(secondOpen),
      thread: secondThread,
    };
    const response = await report(
      fixture,
      first.thread.id,
      `Bearer ${second.credential}`,
    );
    expect(response.status).toBe(401);
    expect(evidenceOf(fixture, first.thread.id)).toBeNull();
    expect(evidenceOf(fixture, second.thread.id)).toBeNull();
    expect(
      (await report(fixture, first.thread.id, `Bearer ${first.credential}`))
        .status,
    ).toBe(200);
    expect(evidenceOf(fixture, first.thread.id)).not.toBeNull();
  });

  it("a rejected report cannot open a question, settle a turn, title the thread, or move the binding after reopen, evidence clearing and a session rebind", async () => {
    const fixture = await createFixture();
    const started = await startNativeThread(fixture);
    const { thread } = started;
    await report(fixture, thread.id, `Bearer ${started.credential}`);
    const { credential: current } = await reattachAfterDaemonDisconnect(
      fixture,
      thread.id,
      started.open,
    );
    await postJson(fixture, `/threads/${thread.id}/native-terminal/open`, {});
    clearNativeTerminalThreadEvidence(fixture.harness.db, thread.id);
    const move = await postJson(
      fixture,
      `/threads/${thread.id}/native-terminal/session`,
      {
        nativeSessionId: "5c0ffee0-1111-4222-8333-444455556666",
        replacesNativeSessionId: SESSION_ID,
      },
      `Bearer ${current}`,
    );
    expect(move.status).toBe(200);
    const title = vi
      .spyOn(titleGeneration, "generateAndApplyThreadTitle")
      .mockResolvedValue(undefined as never);
    try {
      const statusBefore = threadStatus(fixture, thread.id);
      const pendingBefore = listPendingInteractionsByThread(
        fixture.harness.db,
        { threadId: thread.id },
      ).length;
      for (const authorization of [null, `Bearer ${started.credential}`]) {
        for (const body of [
          { state: "idle" },
          { state: "working", prompt: "Name this thread" },
          {
            state: "waiting",
            questions: [{ id: "q1", prompt: "Which layout?" }],
          },
        ]) {
          expect(
            (
              await postJson(
                fixture,
                `/threads/${thread.id}/native-terminal/activity`,
                body,
                authorization,
              )
            ).status,
          ).toBe(401);
        }
      }
      expect(threadStatus(fixture, thread.id)).toBe(statusBefore);
      expect(
        listPendingInteractionsByThread(fixture.harness.db, {
          threadId: thread.id,
        }),
      ).toHaveLength(pendingBefore);
      expect(title).not.toHaveBeenCalled();
      expect(evidenceOf(fixture, thread.id)).toBeNull();
      expect(
        getNativeTerminalThread(fixture.harness.db, thread.id)?.nativeSessionId,
      ).toBe("5c0ffee0-1111-4222-8333-444455556666");
    } finally {
      title.mockRestore();
    }
  });

  it("R2 documents current behavior, not protection: an earlier payload re-sent with the still-current credential is stamped again", async () => {
    const fixture = await createFixture();
    const clock = vi.spyOn(Date, "now").mockReturnValue(2_000_000);
    try {
      const { after, thread } = await reattached(fixture);
      await report(fixture, thread.id, `Bearer ${after}`);
      expect(evidenceOf(fixture, thread.id)).toBe(2_000_000);
      clock.mockReturnValue(2_050_000);
      await report(fixture, thread.id, `Bearer ${after}`);
      expect(evidenceOf(fixture, thread.id)).toBe(2_050_000);
    } finally {
      clock.mockRestore();
    }
  });

  it("shows a live thread as unconfirmed until a current credential reports, then fresh, then stale", async () => {
    const fixture = await createFixture();
    const { credential, thread } = await startNativeThread(fixture);
    const clock = vi.spyOn(Date, "now").mockReturnValue(3_000_000);
    try {
      applyLoggedThreadLifecycleEvent(fixture.harness.deps, {
        event: { type: "run.started" },
        threadId: thread.id,
      });
      expect((await report(fixture, thread.id, null)).status).toBe(401);
      expect(threadStatus(fixture, thread.id)).toBe("active");
      expect(displayOf(fixture, thread.id)).toMatchObject({
        lastEvidenceAt: null,
        confirmation: "unconfirmed",
      });
      expect((await report(fixture, thread.id, null)).status).toBe(401);
      expect(displayOf(fixture, thread.id)).toMatchObject({
        lastEvidenceAt: null,
        confirmation: "unconfirmed",
      });
      await report(fixture, thread.id, `Bearer ${credential}`);
      expect(displayOf(fixture, thread.id)).toMatchObject({
        lastEvidenceAt: 3_000_000,
        confirmation: "confirmed",
      });
      clock.mockReturnValue(3_000_000 + 91_000);
      expect(displayOf(fixture, thread.id)).toMatchObject({
        lastEvidenceAt: 3_000_000,
        confirmation: "unconfirmed",
      });
    } finally {
      clock.mockRestore();
    }
  });

  it("stamps through a disconnected terminal but never from an exited one", async () => {
    const fixture = await createFixture();
    const { credential, open, thread } = await startNativeThread(fixture);
    const clock = vi.spyOn(Date, "now").mockReturnValue(4_000_000);
    try {
      fixture.harness.deps.terminalSessions.handleDaemonSessionClosed({
        sessionId: fixture.sessionId,
      });
      expect(
        getTerminalSession(fixture.harness.db, {
          kind: "terminal",
          terminalId: open.terminalId,
        })?.status,
      ).toBe("disconnected");
      await report(fixture, thread.id, `Bearer ${credential}`);
      expect(evidenceOf(fixture, thread.id)).toBe(4_000_000);
    } finally {
      clock.mockRestore();
    }
  });

  it("does not stamp once the terminal has exited", async () => {
    const fixture = await createFixture();
    const { credential, open, thread } = await startNativeThread(fixture);
    fixture.harness.deps.terminalSessions.handleDaemonTerminalMessage({
      hostId: fixture.hostId,
      sessionId: fixture.sessionId,
      message: {
        type: "terminal.exited",
        terminalId: open.terminalId,
        exitCode: 0,
        closeReason: "process-exit",
      },
    });
    await report(fixture, thread.id, `Bearer ${credential}`);
    expect(evidenceOf(fixture, thread.id)).toBeNull();
  });

  it("keeps the thread's state when a superseded terminal's exit arrives after the reattach", async () => {
    const fixture = await createFixture();
    const { open, thread } = await startNativeThread(fixture);
    await report(fixture, thread.id);
    const { reopened } = await reattachAfterDaemonDisconnect(
      fixture,
      thread.id,
      open,
    );
    const rowState = {
      statuses: { task: { value: "Working" } },
      progress: { value: 0.4 },
    };
    putThreadRowState(fixture.harness.db, thread.id, rowState);

    const view = nativeTerminalThreadSchema.parse(
      await readJson(
        await fixture.harness.app.request(
          `/api/v1/threads/${thread.id}/native-terminal`,
        ),
      ),
    );
    expect(view.terminal?.id).toBe(reopened.terminalId);
    expect(view.terminal?.status).toBe("running");

    for (const closeReason of ["daemon-disconnect", "process-exit"] as const) {
      clearNativeTerminalStateOnExit(fixture.harness.deps, {
        closeReason,
        id: open.terminalId,
        threadId: thread.id,
      });
      expect(getThreadRowState(fixture.harness.db, thread.id)).toEqual(
        rowState,
      );
      expect(threadStatus(fixture, thread.id)).toBe("active");
    }
  });

  type LifecycleEffect = "run-started" | "idle-settle" | "questions" | "title";
  type CredentialCase =
    | "a: no credential after a confirmed binding"
    | "b: invalid credential after a confirmed binding"
    | "c: legacy holder that never reported, no Authorization"
    | "d: stale once-captured credential after the reattach reset"
    | "e: no credential after the reattach reset"
    | "f: current-credential heartbeat"
    | "g: current credential, terminal exited by daemon disconnect before reattach"
    | "g2: current credential, terminal disconnected before reattach"
    | "h: new credential before its hash is stored, old terminal exited"
    | "h2: new credential before its hash is stored, old terminal disconnected";

  const LIFECYCLE_CASES: readonly [CredentialCase, boolean][] = [
    ["a: no credential after a confirmed binding", false],
    ["b: invalid credential after a confirmed binding", false],
    ["c: legacy holder that never reported, no Authorization", false],
    ["d: stale once-captured credential after the reattach reset", false],
    ["e: no credential after the reattach reset", false],
    ["f: current-credential heartbeat", true],
    [
      "g: current credential, terminal exited by daemon disconnect before reattach",
      true,
    ],
    ["g2: current credential, terminal disconnected before reattach", true],
    ["h: new credential before its hash is stored, old terminal exited", false],
    [
      "h2: new credential before its hash is stored, old terminal disconnected",
      false,
    ],
  ];
  const LIFECYCLE_EFFECTS: readonly LifecycleEffect[] = [
    "run-started",
    "idle-settle",
    "questions",
    "title",
  ];

  async function startRebindWindow(
    fixture: Fixture,
    started: Awaited<ReturnType<typeof startNativeThread>>,
    oldTerminal: "exited" | "disconnected",
  ) {
    const { thread } = started;
    await report(fixture, thread.id, `Bearer ${started.credential}`);
    expect(evidenceOf(fixture, thread.id)).not.toBeNull();
    const opens = countDaemonMessages(fixture, "terminal.open");
    let finish: Promise<unknown>;
    if (oldTerminal === "exited") {
      fixture.harness.deps.terminalSessions.handleDaemonTerminalMessage({
        hostId: fixture.hostId,
        sessionId: fixture.sessionId,
        message: {
          type: "terminal.exited",
          terminalId: started.open.terminalId,
          exitCode: null,
          closeReason: "daemon-disconnect",
        },
      });
      finish = postJson(
        fixture,
        `/threads/${thread.id}/native-terminal/open`,
        {},
      );
    } else {
      fixture.harness.deps.terminalSessions.handleDaemonSessionClosed({
        sessionId: fixture.sessionId,
      });
      finish = reopenNativeTerminalsAfterDaemonReconnect(fixture.harness.deps, {
        hostId: fixture.hostId,
        threadIds: [thread.id],
      });
    }
    const reopened = await waitForDaemonMessage(
      fixture,
      "terminal.open",
      opens,
    );
    return {
      newCredential: terminalCredential(reopened),
      complete: async () => {
        acknowledgeOpen(fixture, reopened);
        await finish;
      },
    };
  }

  async function lifecycleAuthorization(
    fixture: Fixture,
    credentialCase: CredentialCase,
  ): Promise<{
    authorization: string | null;
    complete?: () => Promise<void>;
    thread: Awaited<ReturnType<typeof startNativeThread>>["thread"];
  }> {
    const started = await startNativeThread(fixture);
    const { thread } = started;
    if (credentialCase.startsWith("h")) {
      const window = await startRebindWindow(
        fixture,
        started,
        credentialCase.startsWith("h2") ? "disconnected" : "exited",
      );
      return {
        authorization: `Bearer ${window.newCredential}`,
        complete: window.complete,
        thread,
      };
    }
    if (credentialCase.startsWith("c")) {
      return { authorization: null, thread };
    }
    if (credentialCase.startsWith("d") || credentialCase.startsWith("e")) {
      await report(fixture, thread.id, `Bearer ${started.credential}`);
      expect(evidenceOf(fixture, thread.id)).not.toBeNull();
      await reattachAfterDaemonDisconnect(fixture, thread.id, started.open);
      expect(evidenceOf(fixture, thread.id)).toBeNull();
      return {
        authorization: credentialCase.startsWith("d")
          ? `Bearer ${started.credential}`
          : null,
        thread,
      };
    }
    await report(fixture, thread.id, `Bearer ${started.credential}`);
    expect(evidenceOf(fixture, thread.id)).not.toBeNull();
    if (credentialCase.startsWith("g2")) {
      fixture.harness.deps.terminalSessions.handleDaemonSessionClosed({
        sessionId: fixture.sessionId,
      });
      expect(
        getTerminalSession(fixture.harness.db, {
          kind: "terminal",
          terminalId: started.open.terminalId,
        })?.status,
      ).toBe("disconnected");
      return { authorization: `Bearer ${started.credential}`, thread };
    }
    if (credentialCase.startsWith("g")) {
      fixture.harness.deps.terminalSessions.handleDaemonTerminalMessage({
        hostId: fixture.hostId,
        sessionId: fixture.sessionId,
        message: {
          type: "terminal.exited",
          terminalId: started.open.terminalId,
          exitCode: null,
          closeReason: "daemon-disconnect",
        },
      });
      return { authorization: `Bearer ${started.credential}`, thread };
    }
    if (credentialCase.startsWith("a")) {
      return { authorization: null, thread };
    }
    if (credentialCase.startsWith("b")) {
      return { authorization: "Bearer not-the-credential", thread };
    }
    return { authorization: `Bearer ${started.credential}`, thread };
  }

  it("a heartbeat of the old binding inside the reattach window is rejected and neither stamps it nor lets the not-yet-stored new credential act, and the new credential's idle works once the rebind completes", async () => {
    const fixture = await createFixture();
    const started = await startNativeThread(fixture);
    const { thread } = started;
    const window = await startRebindWindow(fixture, started, "disconnected");
    expect(isNativeTerminalRebindInFlight(thread.id)).toBe(true);
    expect(evidenceOf(fixture, thread.id)).toBeNull();
    expect(threadStatus(fixture, thread.id)).toBe("active");

    expect(
      (await report(fixture, thread.id, `Bearer ${started.credential}`)).status,
    ).toBe(401);
    expect(evidenceOf(fixture, thread.id)).toBeNull();

    const early = await postJson(
      fixture,
      `/threads/${thread.id}/native-terminal/activity`,
      { state: "idle" },
      `Bearer ${window.newCredential}`,
    );
    expect(early.status).toBe(401);
    expect(threadStatus(fixture, thread.id)).toBe("active");

    await window.complete();
    expect(isNativeTerminalRebindInFlight(thread.id)).toBe(false);
    expect(evidenceOf(fixture, thread.id)).toBeNull();
    const idle = await postJson(
      fixture,
      `/threads/${thread.id}/native-terminal/activity`,
      { state: "idle" },
      `Bearer ${window.newCredential}`,
    );
    expect(idle.status).toBe(200);
    expect(threadStatus(fixture, thread.id)).toBe("idle");
    expect(evidenceOf(fixture, thread.id)).not.toBeNull();
  });

  it("rejects every report of the old holder's credential from the moment the rebind starts, with no state change, and accepts the new holder's report once its credential is stored", async () => {
    const fixture = await createFixture();
    const started = await startNativeThread(fixture);
    const { thread } = started;
    const activity = `/threads/${thread.id}/native-terminal/activity`;
    expect(
      (
        await postJson(
          fixture,
          activity,
          {
            closes: [],
            questions: [{ id: "q1", prompt: "Which layout?" }],
            state: "waiting",
          },
          `Bearer ${started.credential}`,
        )
      ).status,
    ).toBe(200);
    const window = await startRebindWindow(fixture, started, "disconnected");
    const title = vi
      .spyOn(titleGeneration, "generateAndApplyThreadTitle")
      .mockResolvedValue(undefined as never);
    try {
      const statusBefore = threadStatus(fixture, thread.id);
      const pendingBefore = openInteractions(fixture, thread.id).length;
      expect(pendingBefore).toBe(1);
      for (const body of [
        { state: "idle" },
        { state: "working", prompt: "Name this thread" },
        { closes: ["q1"], state: "working" },
        {
          closes: [],
          questions: [{ id: "q2", prompt: "Another layout?" }],
          state: "waiting",
        },
      ]) {
        expect(
          (
            await postJson(
              fixture,
              activity,
              body,
              `Bearer ${started.credential}`,
            )
          ).status,
        ).toBe(401);
      }
      expect(threadStatus(fixture, thread.id)).toBe(statusBefore);
      expect(openInteractions(fixture, thread.id)).toHaveLength(pendingBefore);
      expect(title).not.toHaveBeenCalled();
      expect(evidenceOf(fixture, thread.id)).toBeNull();
    } finally {
      title.mockRestore();
    }
    await window.complete();
    expect(
      (
        await postJson(
          fixture,
          activity,
          { state: "idle" },
          `Bearer ${window.newCredential}`,
        )
      ).status,
    ).toBe(200);
    expect(threadStatus(fixture, thread.id)).toBe("idle");
  });

  it("rejects every report with the stored credential of a terminal that exited on its own, with no state change", async () => {
    const fixture = await createFixture();
    const started = await startNativeThread(fixture);
    const { thread } = started;
    const activity = `/threads/${thread.id}/native-terminal/activity`;
    expect(
      (
        await postJson(
          fixture,
          activity,
          {
            closes: [],
            questions: [{ id: "q1", prompt: "Which layout?" }],
            state: "waiting",
          },
          `Bearer ${started.credential}`,
        )
      ).status,
    ).toBe(200);
    fixture.harness.deps.terminalSessions.handleDaemonTerminalMessage({
      hostId: fixture.hostId,
      sessionId: fixture.sessionId,
      message: {
        type: "terminal.exited",
        terminalId: started.open.terminalId,
        exitCode: 0,
        closeReason: "process-exit",
      },
    });
    const title = vi
      .spyOn(titleGeneration, "generateAndApplyThreadTitle")
      .mockResolvedValue(undefined as never);
    try {
      const statusBefore = threadStatus(fixture, thread.id);
      const pendingBefore = openInteractions(fixture, thread.id).length;
      const evidenceBefore = evidenceOf(fixture, thread.id);
      for (const body of [
        { state: "idle" },
        { state: "working", prompt: "Name this thread" },
        { closes: ["q1"], state: "working" },
        {
          closes: [],
          questions: [{ id: "q2", prompt: "Another layout?" }],
          state: "waiting",
        },
      ]) {
        const response = await postJson(
          fixture,
          activity,
          body,
          `Bearer ${started.credential}`,
        );
        expect(response.status).toBe(409);
        expect(await readApiErrorCode(response)).toBe(
          "native_terminal_not_live",
        );
      }
      expect(threadStatus(fixture, thread.id)).toBe(statusBefore);
      expect(openInteractions(fixture, thread.id)).toHaveLength(pendingBefore);
      expect(title).not.toHaveBeenCalled();
      expect(evidenceOf(fixture, thread.id)).toBe(evidenceBefore);
    } finally {
      title.mockRestore();
    }
  });

  it("still accepts a report from a terminal that awaits its reattach, whether it is disconnected or was exited by a daemon disconnect", async () => {
    for (const awaiting of ["disconnected", "exited-by-daemon-disconnect"]) {
      const fixture = await createFixture();
      const started = await startNativeThread(fixture);
      const { thread } = started;
      if (awaiting === "disconnected") {
        fixture.harness.deps.terminalSessions.handleDaemonSessionClosed({
          sessionId: fixture.sessionId,
        });
        expect(
          getTerminalSession(fixture.harness.db, {
            kind: "terminal",
            terminalId: started.open.terminalId,
          })?.status,
        ).toBe("disconnected");
      } else {
        fixture.harness.deps.terminalSessions.handleDaemonTerminalMessage({
          hostId: fixture.hostId,
          sessionId: fixture.sessionId,
          message: {
            type: "terminal.exited",
            terminalId: started.open.terminalId,
            exitCode: null,
            closeReason: "daemon-disconnect",
          },
        });
      }
      const response = await postJson(
        fixture,
        `/threads/${thread.id}/native-terminal/activity`,
        { state: "idle" },
        `Bearer ${started.credential}`,
      );
      expect(response.status).toBe(200);
      expect(threadStatus(fixture, thread.id)).toBe("idle");
    }
  });

  it("gives the old holder its credential back when the replacement terminal cannot be created, so it can report again", async () => {
    const fixture = await createFixture();
    const started = await startNativeThread(fixture);
    const { thread } = started;
    await report(fixture, thread.id, `Bearer ${started.credential}`);
    fixture.harness.deps.terminalSessions.handleDaemonTerminalMessage({
      hostId: fixture.hostId,
      sessionId: fixture.sessionId,
      message: {
        type: "terminal.exited",
        terminalId: started.open.terminalId,
        exitCode: null,
        closeReason: "daemon-disconnect",
      },
    });
    const create = vi
      .spyOn(fixture.harness.deps.terminalSessions, "createTerminal")
      .mockRejectedValue(new Error("the host never answered"));
    try {
      const response = await postJson(
        fixture,
        `/threads/${thread.id}/native-terminal/open`,
        {},
      );
      expect(response.status).toBeGreaterThanOrEqual(500);
    } finally {
      create.mockRestore();
    }
    expect(isNativeTerminalRebindInFlight(thread.id)).toBe(false);
    expect(
      (
        await postJson(
          fixture,
          `/threads/${thread.id}/native-terminal/activity`,
          { state: "idle" },
          `Bearer ${started.credential}`,
        )
      ).status,
    ).toBe(200);
    expect(threadStatus(fixture, thread.id)).toBe("idle");
  });

  it("a report sent before the server stored the new credential is dropped with 401 and, resent once the credential is stored, has its lifecycle effect exactly once", async () => {
    const fixture = await createFixture();
    const started = await startNativeThread(fixture);
    const { thread } = started;
    const window = await startRebindWindow(fixture, started, "exited");
    const idle = () =>
      postJson(
        fixture,
        `/threads/${thread.id}/native-terminal/activity`,
        { state: "idle" },
        `Bearer ${window.newCredential}`,
      );
    expect(threadStatus(fixture, thread.id)).toBe("active");
    expect((await idle()).status).toBe(401);
    expect(threadStatus(fixture, thread.id)).toBe("active");

    await window.complete();
    expect((await idle()).status).toBe(200);
    expect(threadStatus(fixture, thread.id)).toBe("idle");
    expect((await idle()).status).toBe(200);
    expect(threadStatus(fixture, thread.id)).toBe("idle");
  });

  it("an idle report resent after an earlier failed delivery settles the thread to idle, and a duplicate idle is a no-op", async () => {
    const fixture = await createFixture();
    const started = await startNativeThread(fixture);
    const { thread } = started;
    applyLoggedThreadLifecycleEvent(fixture.harness.deps, {
      event: { type: "run.started" },
      threadId: thread.id,
    });
    expect(threadStatus(fixture, thread.id)).toBe("active");
    const idle = () =>
      postJson(
        fixture,
        `/threads/${thread.id}/native-terminal/activity`,
        { state: "idle" },
        `Bearer ${started.credential}`,
      );
    expect((await idle()).status).toBe(200);
    expect(threadStatus(fixture, thread.id)).toBe("idle");
    const notify = vi.spyOn(fixture.harness.hub, "notifyThread");
    const pendingBefore = listPendingInteractionsByThread(fixture.harness.db, {
      threadId: thread.id,
    });
    try {
      expect((await idle()).status).toBe(200);
      expect(threadStatus(fixture, thread.id)).toBe("idle");
      expect(
        notify.mock.calls.filter((call) => call[1].includes("status-changed")),
      ).toHaveLength(0);
    } finally {
      notify.mockRestore();
    }
    expect(
      listPendingInteractionsByThread(fixture.harness.db, {
        threadId: thread.id,
      }),
    ).toEqual(pendingBefore);
  });

  it("ends the rebind window when the reattach fails, so the binding can be stamped again", async () => {
    const fixture = await createFixture();
    const started = await startNativeThread(fixture);
    const { thread } = started;
    await report(fixture, thread.id, `Bearer ${started.credential}`);
    fixture.harness.deps.terminalSessions.handleDaemonTerminalMessage({
      hostId: fixture.hostId,
      sessionId: fixture.sessionId,
      message: {
        type: "terminal.exited",
        terminalId: started.open.terminalId,
        exitCode: null,
        closeReason: "daemon-disconnect",
      },
    });
    const create = vi
      .spyOn(fixture.harness.deps.terminalSessions, "createTerminal")
      .mockRejectedValue(new Error("the host never answered"));
    try {
      const response = await postJson(
        fixture,
        `/threads/${thread.id}/native-terminal/open`,
        {},
      );
      expect(response.status).toBeGreaterThanOrEqual(500);
      expect(create).toHaveBeenCalledTimes(1);
      expect(isNativeTerminalRebindInFlight(thread.id)).toBe(false);
    } finally {
      create.mockRestore();
    }
  });

  describe("rebinding the thread to the session the CLI rotated to", () => {
    const ROTATED = "5c0ffee0-1111-4222-8333-444455556666";
    const recordSession = (
      fixture: Fixture,
      threadId: string,
      nativeSessionId: string,
      authorization?: string,
      replacesNativeSessionId: string | null = SESSION_ID,
    ) =>
      postJson(
        fixture,
        `/threads/${threadId}/native-terminal/session`,
        {
          nativeSessionId,
          ...(replacesNativeSessionId === null
            ? {}
            : { replacesNativeSessionId }),
        },
        authorization,
      );
    const boundSession = (fixture: Fixture, threadId: string) =>
      getNativeTerminalThread(fixture.harness.db, threadId)?.nativeSessionId;

    it("lets the holder with the current credential move the binding", async () => {
      const fixture = await createFixture();
      const started = await startNativeThread(fixture);
      const { thread } = started;
      expect(boundSession(fixture, thread.id)).toBe(SESSION_ID);
      const response = await recordSession(
        fixture,
        thread.id,
        ROTATED,
        `Bearer ${started.credential}`,
      );
      expect(response.status).toBe(200);
      expect(boundSession(fixture, thread.id)).toBe(ROTATED);
    });

    it("is a compare-and-swap: it needs the id it replaces, and refuses a stale one", async () => {
      const fixture = await createFixture();
      const started = await startNativeThread(fixture);
      const { thread } = started;
      const authorization = `Bearer ${started.credential}`;
      for (const [replaces, code] of [
        [null, "native_session_already_bound"],
        ["0a0ffee0-1111-4222-8333-444455556666", "native_session_rebind_stale"],
      ] as const) {
        const response = await recordSession(
          fixture,
          thread.id,
          ROTATED,
          authorization,
          replaces,
        );
        expect(response.status).toBe(409);
        expect(await readApiErrorCode(response)).toBe(code);
        expect(boundSession(fixture, thread.id)).toBe(SESSION_ID);
      }
      expect(
        (await recordSession(fixture, thread.id, ROTATED, authorization))
          .status,
      ).toBe(200);
      const replayed = await recordSession(
        fixture,
        thread.id,
        "7d0ffee0-1111-4222-8333-444455556666",
        authorization,
        SESSION_ID,
      );
      expect(replayed.status).toBe(409);
      expect(boundSession(fixture, thread.id)).toBe(ROTATED);
    });

    it("refuses a caller without the current live credential", async () => {
      const fixture = await createFixture();
      const started = await startNativeThread(fixture);
      const { thread } = started;
      const { credential: current } = await reattachAfterDaemonDisconnect(
        fixture,
        thread.id,
        started.open,
      );
      for (const authorization of [
        undefined,
        "Bearer not-the-credential",
        `Bearer ${started.credential}`,
      ]) {
        const response = await recordSession(
          fixture,
          thread.id,
          ROTATED,
          authorization,
        );
        expect(response.status).toBe(401);
        expect(await readApiErrorCode(response)).toBe(
          "native_terminal_credential_invalid",
        );
        expect(boundSession(fixture, thread.id)).toBe(SESSION_ID);
      }
      expect(
        (await recordSession(fixture, thread.id, ROTATED, `Bearer ${current}`))
          .status,
      ).toBe(200);
    });

    it("accepts the same move after the terminal was exited and reattached, with the refreshed credential", async () => {
      const fixture = await createFixture();
      const started = await startNativeThread(fixture);
      const { thread } = started;
      fixture.harness.deps.terminalSessions.handleDaemonTerminalMessage({
        hostId: fixture.hostId,
        sessionId: fixture.sessionId,
        message: {
          type: "terminal.exited",
          terminalId: started.open.terminalId,
          exitCode: null,
          closeReason: "daemon-disconnect",
        },
      });
      const early = await recordSession(
        fixture,
        thread.id,
        ROTATED,
        `Bearer ${started.credential}`,
      );
      expect(early.status).toBe(409);
      expect(await readApiErrorCode(early)).toBe("native_terminal_not_live");
      expect(boundSession(fixture, thread.id)).toBe(SESSION_ID);

      const { credential: refreshed } = await reattachAfterDaemonDisconnect(
        fixture,
        thread.id,
        started.open,
      );
      const stale = await recordSession(
        fixture,
        thread.id,
        ROTATED,
        `Bearer ${started.credential}`,
      );
      expect(stale.status).toBe(401);
      const retried = await recordSession(
        fixture,
        thread.id,
        ROTATED,
        `Bearer ${refreshed}`,
      );
      expect(retried.status).toBe(200);
      expect(boundSession(fixture, thread.id)).toBe(ROTATED);
    });

    it("refuses once the terminal is no longer live, and never takes another thread's session", async () => {
      const fixture = await createFixture();
      const started = await startNativeThread(fixture);
      const { thread } = started;
      const other = seedChatThread(fixture, {
        providerId: "claude-code",
        providerThreadId: null,
      });
      createNativeTerminalThread(fixture.harness.db, {
        threadId: other.id,
        providerId: "claude-code",
        nativeSessionId: ROTATED,
        initialPrompt: null,
        initialImages: [],
        model: null,
      });
      const claimed = await recordSession(
        fixture,
        thread.id,
        ROTATED,
        `Bearer ${started.credential}`,
      );
      expect(claimed.status).toBe(409);
      expect(await readApiErrorCode(claimed)).toBe("native_session_claimed");

      fixture.harness.deps.terminalSessions.handleDaemonTerminalMessage({
        hostId: fixture.hostId,
        sessionId: fixture.sessionId,
        message: {
          type: "terminal.exited",
          terminalId: started.open.terminalId,
          exitCode: 0,
          closeReason: "process-exit",
        },
      });
      const exited = await recordSession(
        fixture,
        thread.id,
        "7d0ffee0-1111-4222-8333-444455556666",
        `Bearer ${started.credential}`,
      );
      expect(exited.status).toBe(409);
      expect(await readApiErrorCode(exited)).toBe("native_terminal_not_live");
      expect(boundSession(fixture, thread.id)).toBe(SESSION_ID);
    });
  });

  describe("lifecycle effects of a report", () => {
    it.each(
      LIFECYCLE_CASES.flatMap(([credentialCase, applied]) =>
        LIFECYCLE_EFFECTS.map(
          (effect) => [credentialCase, effect, applied] as const,
        ),
      ),
    )("%s: %s applied=%s", async (credentialCase, effect, applied) => {
      const fixture = await createFixture();
      let completeRebind: (() => Promise<void>) | undefined;
      const title = vi
        .spyOn(titleGeneration, "generateAndApplyThreadTitle")
        .mockResolvedValue(undefined as never);
      const stampChecked = credentialCase.startsWith("g");
      const clock = stampChecked
        ? vi.spyOn(Date, "now").mockReturnValue(7_000_000)
        : null;
      try {
        const { authorization, complete, thread } =
          await lifecycleAuthorization(fixture, credentialCase);
        completeRebind = complete;
        clock?.mockReturnValue(7_001_000);
        const send = (body: unknown) =>
          postJson(
            fixture,
            `/threads/${thread.id}/native-terminal/activity`,
            body,
            authorization,
          );
        if (effect === "run-started") {
          settleNativeTerminalTurn(fixture.harness.deps, thread.id);
          expect(threadStatus(fixture, thread.id)).toBe("idle");
          expect((await send({ state: "working" })).status).toBe(
            applied ? 200 : 401,
          );
          expect(threadStatus(fixture, thread.id)).toBe(
            applied ? "active" : "idle",
          );
        } else if (effect === "idle-settle") {
          applyLoggedThreadLifecycleEvent(fixture.harness.deps, {
            event: { type: "run.started" },
            threadId: thread.id,
          });
          expect(threadStatus(fixture, thread.id)).toBe("active");
          expect((await send({ state: "idle" })).status).toBe(
            applied ? 200 : 401,
          );
          expect(threadStatus(fixture, thread.id)).toBe(
            applied ? "idle" : "active",
          );
        } else if (effect === "questions") {
          expect(
            (
              await send({
                state: "waiting",
                questions: [{ id: "q1", prompt: "Which layout?" }],
              })
            ).status,
          ).toBe(applied ? 200 : 401);
          expect(
            listPendingInteractionsByThread(fixture.harness.db, {
              threadId: thread.id,
            }),
          ).toHaveLength(applied ? 1 : 0);
        } else {
          expect(
            (await send({ state: "working", prompt: "Name this thread" }))
              .status,
          ).toBe(applied ? 200 : 401);
          await vi.waitFor(() => undefined);
          expect(title).toHaveBeenCalledTimes(applied ? 1 : 0);
        }
        if (stampChecked) {
          expect(evidenceOf(fixture, thread.id)).toBe(
            credentialCase.startsWith("g2") ? 7_001_000 : 7_000_000,
          );
        }
      } finally {
        clock?.mockRestore();
        title.mockRestore();
        await completeRebind?.();
      }
    });
  });
});

describe("a native activity report that does not confirm activity", () => {
  async function startThread(fixture: Fixture) {
    const thread = seedChatThread(fixture, {
      providerId: "claude-code",
      providerThreadId: SESSION_ID,
    });
    const { open } = await enterTerminal(fixture, thread.id);
    return Object.assign(thread, { open });
  }

  const send = (
    fixture: Fixture,
    threadId: string,
    body: {
      closes?: string[];
      confirms?: boolean | string;
      prompt?: string;
      questions?: { id: string; prompt: string }[];
      state: "idle" | "waiting" | "working";
    },
  ) =>
    postJson(
      fixture,
      `/threads/${threadId}/native-terminal/activity`,
      withHolderCloses(fixture, threadId, body),
    );

  const evidence = (fixture: Fixture, threadId: string) =>
    getNativeTerminalThread(fixture.harness.db, threadId)?.lastEvidenceAt;

  const display = (fixture: Fixture, threadId: string) => {
    const thread = getThread(fixture.harness.db, threadId);
    if (thread === null) throw new Error("thread missing");
    return buildThreadStatusChangeMetadata(fixture.harness.deps, thread)
      .statusChange?.runtime.nativeActivity;
  };

  async function answeredQuestion(
    fixture: Fixture,
    clock: { mockReturnValue(value: number): unknown },
  ) {
    const thread = await startThread(fixture);
    clock.mockReturnValue(1_000_000);
    expect((await send(fixture, thread.id, { state: "working" })).status).toBe(
      200,
    );
    clock.mockReturnValue(1_010_000);
    expect(
      (
        await send(fixture, thread.id, {
          questions: [{ id: "q1", prompt: "Which layout?" }],
          state: "waiting",
        })
      ).status,
    ).toBe(200);
    expect(openInteractions(fixture, thread.id)).toHaveLength(1);
    return thread;
  }

  it("resolves the answered question and shows Activity not reported at once, not Working", async () => {
    const fixture = await createFixture();
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    try {
      const thread = await answeredQuestion(fixture, clock);
      clock.mockReturnValue(1_020_000);
      expect(
        (await send(fixture, thread.id, { confirms: false, state: "working" }))
          .status,
      ).toBe(200);
      expect(openInteractions(fixture, thread.id)).toHaveLength(0);
      expect(threadStatus(fixture, thread.id)).toBe("active");
      expect(evidence(fixture, thread.id)).toBeNull();
      expect(display(fixture, thread.id)).toMatchObject({
        confirmation: "unconfirmed",
        lastEvidenceAt: null,
      });
    } finally {
      clock.mockRestore();
    }
  });

  it("notifies the thread when it clears the evidence, so a connected client drops Working", async () => {
    const fixture = await createFixture();
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    const notify = vi.spyOn(fixture.harness.hub, "notifyThread");
    try {
      const thread = await answeredQuestion(fixture, clock);
      notify.mockClear();
      clock.mockReturnValue(1_020_000);
      await send(fixture, thread.id, { confirms: false, state: "working" });
      expect(
        notify.mock.calls.some(
          (call) =>
            call[2]?.statusChange?.runtime.nativeActivity?.confirmation ===
              "unconfirmed" &&
            call[2]?.statusChange?.runtime.nativeActivity?.lastEvidenceAt ===
              null,
        ),
      ).toBe(true);
    } finally {
      clock.mockRestore();
    }
  });

  it("is re-confirmed as Working by the next real report", async () => {
    const fixture = await createFixture();
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    try {
      const thread = await answeredQuestion(fixture, clock);
      clock.mockReturnValue(1_020_000);
      await send(fixture, thread.id, { confirms: false, state: "working" });
      clock.mockReturnValue(1_030_000);
      expect(
        (await send(fixture, thread.id, { prompt: "next", state: "working" }))
          .status,
      ).toBe(200);
      expect(evidence(fixture, thread.id)).toBe(1_030_000);
      expect(display(fixture, thread.id)).toMatchObject({
        confirmation: "confirmed",
        lastEvidenceAt: 1_030_000,
      });
    } finally {
      clock.mockRestore();
    }
  });

  it("a delayed or retried close that arrives after a newer real confirmation resolves nothing and keeps that confirmation", async () => {
    const fixture = await createFixture();
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    try {
      const thread = await answeredQuestion(fixture, clock);
      clock.mockReturnValue(2_000_000);
      expect(
        (await send(fixture, thread.id, { prompt: "next", state: "working" }))
          .status,
      ).toBe(200);
      expect(openInteractions(fixture, thread.id)).toHaveLength(0);
      expect(evidence(fixture, thread.id)).toBe(2_000_000);
      clock.mockReturnValue(2_010_000);
      expect(
        (await send(fixture, thread.id, { confirms: false, state: "working" }))
          .status,
      ).toBe(200);
      expect(evidence(fixture, thread.id)).toBe(2_000_000);
      expect(display(fixture, thread.id)).toMatchObject({
        confirmation: "confirmed",
        lastEvidenceAt: 2_000_000,
      });
    } finally {
      clock.mockRestore();
    }
  });

  it("keeps a stored stamp that is newer than the receipt time even though the close resolves the question", async () => {
    const fixture = await createFixture();
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    try {
      const thread = await answeredQuestion(fixture, clock);
      const terminalSessionId = getNativeTerminalThread(
        fixture.harness.db,
        thread.id,
      )?.terminalSessionId;
      if (terminalSessionId === null || terminalSessionId === undefined) {
        throw new Error("terminal session missing");
      }
      stampNativeTerminalThreadActivity(fixture.harness.db, {
        at: 2_000_000,
        terminalSessionId,
        threadId: thread.id,
      });
      clock.mockReturnValue(1_990_000);
      expect(
        (await send(fixture, thread.id, { confirms: false, state: "working" }))
          .status,
      ).toBe(200);
      expect(openInteractions(fixture, thread.id)).toHaveLength(0);
      expect(evidence(fixture, thread.id)).toBe(2_000_000);
    } finally {
      clock.mockRestore();
    }
  });

  it("still clears when other genuine reports kept the question open in between (several questions answered in turn)", async () => {
    const fixture = await createFixture();
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    try {
      const thread = await answeredQuestion(fixture, clock);
      clock.mockReturnValue(1_012_000);
      await send(fixture, thread.id, {
        questions: [
          { id: "q1", prompt: "Which layout?" },
          { id: "q2", prompt: "Which colour?" },
        ],
        state: "waiting",
      });
      clock.mockReturnValue(1_014_000);
      await send(fixture, thread.id, {
        questions: [{ id: "q1", prompt: "Which layout?" }],
        state: "waiting",
      });
      expect(openInteractions(fixture, thread.id)).toHaveLength(1);
      expect(evidence(fixture, thread.id)).toBe(1_014_000);
      clock.mockReturnValue(1_020_000);
      expect(
        (await send(fixture, thread.id, { confirms: false, state: "working" }))
          .status,
      ).toBe(200);
      expect(openInteractions(fixture, thread.id)).toHaveLength(0);
      expect(evidence(fixture, thread.id)).toBeNull();
    } finally {
      clock.mockRestore();
    }
  });

  const pendingIds = (fixture: Fixture, threadId: string) =>
    nativeRequestIds(openInteractions(fixture, threadId));

  it("a close that names its question resolves only that question and clears the evidence", async () => {
    const fixture = await createFixture();
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    try {
      const thread = await answeredQuestion(fixture, clock);
      clock.mockReturnValue(1_012_000);
      await send(fixture, thread.id, {
        questions: [
          { id: "q1", prompt: "Which layout?" },
          { id: "q2", prompt: "Which colour?" },
        ],
        state: "waiting",
      });
      expect(openInteractions(fixture, thread.id)).toHaveLength(2);
      clock.mockReturnValue(1_020_000);
      expect(
        (
          await send(fixture, thread.id, {
            closes: ["q1"],
            confirms: false,
            state: "working",
          })
        ).status,
      ).toBe(200);
      expect(pendingIds(fixture, thread.id)).toEqual([
        expect.stringContaining("q2"),
      ]);
      expect(evidence(fixture, thread.id)).toBeNull();
    } finally {
      clock.mockRestore();
    }
  });

  it("a late close that names an already resolved question cannot end a newer question or clear its evidence, and repeating it is a no-op", async () => {
    const fixture = await createFixture();
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    const notify = vi.spyOn(fixture.harness.hub, "notifyThread");
    try {
      const thread = await answeredQuestion(fixture, clock);
      clock.mockReturnValue(1_030_000);
      expect(
        (
          await send(fixture, thread.id, {
            closes: ["q1"],
            questions: [{ id: "q2", prompt: "Which colour?" }],
            state: "waiting",
          })
        ).status,
      ).toBe(200);
      expect(pendingIds(fixture, thread.id)).toEqual([
        expect.stringContaining("q2"),
      ]);
      expect(evidence(fixture, thread.id)).toBe(1_030_000);
      notify.mockClear();
      for (const at of [1_040_000, 1_041_000]) {
        clock.mockReturnValue(at);
        expect(
          (
            await send(fixture, thread.id, {
              closes: ["q1"],
              confirms: false,
              state: "working",
            })
          ).status,
        ).toBe(200);
        expect(pendingIds(fixture, thread.id)).toEqual([
          expect.stringContaining("q2"),
        ]);
        expect(evidence(fixture, thread.id)).toBe(1_030_000);
      }
      expect(notify).not.toHaveBeenCalled();
    } finally {
      clock.mockRestore();
    }
  });

  it("an empty list closes nothing, a holder's computed list closes exactly what the report does not list, and an omitted list closes nothing", async () => {
    const fixture = await createFixture();
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    try {
      const thread = await answeredQuestion(fixture, clock);
      clock.mockReturnValue(1_020_000);
      expect(
        (await send(fixture, thread.id, { closes: [], state: "working" }))
          .status,
      ).toBe(200);
      expect(openInteractions(fixture, thread.id)).toHaveLength(1);
      expect(evidence(fixture, thread.id)).toBe(1_020_000);
      clock.mockReturnValue(1_030_000);
      expect(
        (
          await send(fixture, thread.id, {
            closes: [],
            questions: [{ id: "q2", prompt: "Which colour?" }],
            state: "waiting",
          })
        ).status,
      ).toBe(200);
      expect(openInteractions(fixture, thread.id)).toHaveLength(2);
      clock.mockReturnValue(1_040_000);
      expect(
        (
          await postJson(
            fixture,
            `/threads/${thread.id}/native-terminal/activity`,
            { state: "working", prompt: "omitted" },
          )
        ).status,
      ).toBe(200);
      expect(openInteractions(fixture, thread.id)).toHaveLength(2);
      clock.mockReturnValue(1_050_000);
      await send(fixture, thread.id, { state: "working", prompt: "next" });
      expect(openInteractions(fixture, thread.id)).toHaveLength(0);
    } finally {
      clock.mockRestore();
    }
  });

  it("a close that names an unknown question resolves nothing and clears nothing", async () => {
    const fixture = await createFixture();
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    try {
      const thread = await answeredQuestion(fixture, clock);
      clock.mockReturnValue(1_020_000);
      await send(fixture, thread.id, {
        closes: ["nope"],
        confirms: false,
        state: "working",
      });
      expect(openInteractions(fixture, thread.id)).toHaveLength(1);
      expect(evidence(fixture, thread.id)).toBe(1_010_000);
    } finally {
      clock.mockRestore();
    }
  });

  it("closes only the named questions of its own thread", async () => {
    const fixture = await createFixture();
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    try {
      const first = await answeredQuestion(fixture, clock);
      const second = seedChatThread(fixture, {
        providerId: "claude-code",
        providerThreadId: "6b5f1f7c-2d0f-4a6e-9a43-0c1d2e3f4a5b",
      });
      await enterTerminal(fixture, second.id);
      clock.mockReturnValue(1_015_000);
      await send(fixture, second.id, {
        questions: [{ id: "q1", prompt: "Which layout?" }],
        state: "waiting",
      });
      clock.mockReturnValue(1_020_000);
      await send(fixture, first.id, {
        closes: ["q1"],
        confirms: false,
        state: "working",
      });
      expect(openInteractions(fixture, first.id)).toHaveLength(0);
      expect(openInteractions(fixture, second.id)).toHaveLength(1);
      expect(evidence(fixture, second.id)).toBe(1_015_000);
    } finally {
      clock.mockRestore();
    }
  });

  it("a late close of prompt occurrence 1 does not end occurrence 2 of the same tool", async () => {
    const fixture = await createFixture();
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    try {
      const thread = await startThread(fixture);
      const first = { id: "permission:Bash#1", prompt: "Allow Bash?" };
      const second = { id: "permission:Bash#2", prompt: "Allow Bash?" };
      await send(fixture, thread.id, {
        closes: [],
        questions: [first],
        state: "waiting",
      });
      clock.mockReturnValue(1_010_000);
      await send(fixture, thread.id, {
        closes: [],
        questions: [first, second],
        state: "waiting",
      });
      clock.mockReturnValue(1_020_000);
      await send(fixture, thread.id, {
        closes: ["permission:Bash#1"],
        questions: [second],
        state: "waiting",
      });
      expect(pendingIds(fixture, thread.id)).toEqual([
        expect.stringContaining("permission:Bash#2"),
      ]);
      clock.mockReturnValue(1_030_000);
      await send(fixture, thread.id, {
        closes: ["permission:Bash#1"],
        confirms: false,
        state: "working",
      });
      expect(pendingIds(fixture, thread.id)).toEqual([
        expect.stringContaining("permission:Bash#2"),
      ]);
      expect(evidence(fixture, thread.id)).toBe(1_020_000);
    } finally {
      clock.mockRestore();
    }
  });

  it("is idempotent for a duplicate close: the second one changes and notifies nothing", async () => {
    const fixture = await createFixture();
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    const notify = vi.spyOn(fixture.harness.hub, "notifyThread");
    try {
      const thread = await answeredQuestion(fixture, clock);
      clock.mockReturnValue(1_020_000);
      await send(fixture, thread.id, { confirms: false, state: "working" });
      expect(evidence(fixture, thread.id)).toBeNull();
      notify.mockClear();
      clock.mockReturnValue(1_021_000);
      expect(
        (await send(fixture, thread.id, { confirms: false, state: "working" }))
          .status,
      ).toBe(200);
      expect(evidence(fixture, thread.id)).toBeNull();
      expect(notify).not.toHaveBeenCalled();
      expect(threadStatus(fixture, thread.id)).toBe("active");
      expect(openInteractions(fixture, thread.id)).toHaveLength(0);
    } finally {
      clock.mockRestore();
    }
  });

  it.each([
    ["no credential", null],
    ["a stale credential", "Bearer stale-credential"],
  ])(
    "with %s a non-confirming close is a 401 that resolves, clears and notifies nothing",
    async (_name, authorization) => {
      const fixture = await createFixture();
      const clock = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
      try {
        const thread = await answeredQuestion(fixture, clock);
        const before = evidence(fixture, thread.id);
        expect(before).toBe(1_010_000);
        const notify = vi.spyOn(fixture.harness.hub, "notifyThread");
        notify.mockClear();
        clock.mockReturnValue(1_020_000);
        const response = await postJson(
          fixture,
          `/threads/${thread.id}/native-terminal/activity`,
          { confirms: false, state: "working" },
          authorization,
        );
        expect(response.status).toBe(401);
        expect(await readApiErrorCode(response)).toBe(
          "native_terminal_credential_invalid",
        );
        expect(openInteractions(fixture, thread.id)).toHaveLength(1);
        expect(evidence(fixture, thread.id)).toBe(before);
        expect(notify).not.toHaveBeenCalled();
      } finally {
        clock.mockRestore();
      }
    },
  );

  it("cannot be used with the credential of an earlier terminal session to clear the new binding's evidence", async () => {
    const fixture = await createFixture();
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    try {
      const thread = await answeredQuestion(fixture, clock);
      const oldCredential = terminalCredential(thread.open);
      fixture.harness.deps.terminalSessions.handleDaemonTerminalMessage({
        hostId: fixture.hostId,
        sessionId: fixture.sessionId,
        message: {
          type: "terminal.exited",
          terminalId: thread.open.terminalId,
          exitCode: null,
          closeReason: "daemon-disconnect",
        },
      });
      const opens = countDaemonMessages(fixture, "terminal.open");
      const reopening = postJson(
        fixture,
        `/threads/${thread.id}/native-terminal/open`,
        {},
      );
      const reopened = await waitForDaemonMessage(
        fixture,
        "terminal.open",
        opens,
      );
      acknowledgeOpen(fixture, reopened);
      expect((await reopening).status).toBe(200);
      clock.mockReturnValue(1_030_000);
      expect(
        (
          await postJson(
            fixture,
            `/threads/${thread.id}/native-terminal/activity`,
            { state: "working" },
            `Bearer ${terminalCredential(reopened)}`,
          )
        ).status,
      ).toBe(200);
      expect(evidence(fixture, thread.id)).toBe(1_030_000);
      clock.mockReturnValue(1_040_000);
      const stale = await postJson(
        fixture,
        `/threads/${thread.id}/native-terminal/activity`,
        { confirms: false, state: "working" },
        `Bearer ${oldCredential}`,
      );
      expect(stale.status).toBe(401);
      expect(evidence(fixture, thread.id)).toBe(1_030_000);
    } finally {
      clock.mockRestore();
    }
  });

  describe("a question closed by name leaves a durable tombstone", () => {
    const bash1 = { id: "permission:Bash#aaaa.1", prompt: "Allow Bash?" };
    const bash2 = { id: "permission:Bash#aaaa.2", prompt: "Allow Bash?" };

    const reopen = async (
      fixture: Fixture,
      thread: { id: string; open: DaemonMessage<"terminal.open"> },
    ) => {
      fixture.harness.deps.terminalSessions.handleDaemonTerminalMessage({
        hostId: fixture.hostId,
        sessionId: fixture.sessionId,
        message: {
          type: "terminal.exited",
          terminalId: thread.open.terminalId,
          exitCode: null,
          closeReason: "daemon-disconnect",
        },
      });
      const opens = countDaemonMessages(fixture, "terminal.open");
      const reopening = postJson(
        fixture,
        `/threads/${thread.id}/native-terminal/open`,
        {},
      );
      const reopened = await waitForDaemonMessage(
        fixture,
        "terminal.open",
        opens,
      );
      acknowledgeOpen(fixture, reopened);
      expect((await reopening).status).toBe(200);
    };

    it("does not re-register the closed question when a delayed waiting report arrives, and its other fields still apply", async () => {
      const fixture = await createFixture();
      const clock = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
      try {
        const thread = await startThread(fixture);
        await send(fixture, thread.id, {
          closes: [bash1.id],
          state: "working",
        });
        clock.mockReturnValue(1_010_000);
        expect(
          (
            await send(fixture, thread.id, {
              closes: [],
              questions: [bash1],
              state: "waiting",
            })
          ).status,
        ).toBe(200);
        expect(openInteractions(fixture, thread.id)).toHaveLength(0);
        expect(threadStatus(fixture, thread.id)).toBe("active");
        expect(evidence(fixture, thread.id)).toBe(1_010_000);
      } finally {
        clock.mockRestore();
      }
    });

    it("still registers a different, new question carried by the same late report", async () => {
      const fixture = await createFixture();
      const clock = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
      try {
        const thread = await startThread(fixture);
        await send(fixture, thread.id, {
          closes: [bash1.id],
          state: "working",
        });
        await send(fixture, thread.id, {
          closes: [],
          questions: [bash1, bash2],
          state: "waiting",
        });
        expect(pendingIds(fixture, thread.id)).toEqual([
          expect.stringContaining("permission:Bash#aaaa.2"),
        ]);
      } finally {
        clock.mockRestore();
      }
    });

    it("holds past 256 other closes: the opener delivered last still registers nothing", async () => {
      const fixture = await createFixture();
      const clock = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
      try {
        const thread = await startThread(fixture);
        await send(fixture, thread.id, {
          closes: [bash1.id],
          state: "working",
        });
        for (let batch = 0; batch < 33; batch += 1) {
          await send(fixture, thread.id, {
            closes: Array.from(
              { length: 8 },
              (_, index) => `permission:Other#aaaa.${batch * 8 + index}`,
            ),
            state: "working",
          });
        }
        await send(fixture, thread.id, {
          closes: [],
          questions: [bash1],
          state: "waiting",
        });
        expect(openInteractions(fixture, thread.id)).toHaveLength(0);
      } finally {
        clock.mockRestore();
      }
    });

    it("survives a server restart: a new app on a copy of the database refuses the delayed opener, and still registers a question that was never closed", async () => {
      const fixture = await createFixture();
      const thread = await startThread(fixture);
      const credential = currentHolderCredential(fixture, thread.id);
      await send(fixture, thread.id, { closes: [bash1.id], state: "working" });
      const restarted = await createTestAppHarness({
        db: createConnection(fixture.harness.db.$client.serialize()),
      });
      harnesses.push(restarted);
      const post = (body: unknown) =>
        restarted.app.request(
          `/api/v1/threads/${thread.id}/native-terminal/activity`,
          {
            body: JSON.stringify(body),
            headers: {
              authorization: `Bearer ${credential}`,
              "content-type": "application/json",
            },
            method: "POST",
          },
        );
      const pending = () =>
        nativeRequestIds(
          restarted.deps.pendingInteractions.listPendingThreadInteractions(
            thread.id,
          ),
        );

      expect(
        (await post({ closes: [], questions: [bash1], state: "waiting" }))
          .status,
      ).toBe(200);
      expect(pending()).toHaveLength(0);

      expect(
        (await post({ closes: [], questions: [bash2], state: "waiting" }))
          .status,
      ).toBe(200);
      expect(pending()).toEqual([
        expect.stringContaining("permission:Bash#aaaa.2"),
      ]);
    });

    it("does not touch another thread's daemon-restart row that has the same identity", async () => {
      const fixture = await createFixture();
      const thread = await startThread(fixture);
      const other = seedChatThread(fixture, {
        providerId: "claude-code",
        providerThreadId: null,
      });
      const providerRequestId = `${NATIVE_TERMINAL_QUESTION_REQUEST_PREFIX}${bash1.id}`;
      createInterruptedProviderPendingInteraction(fixture.harness.db, {
        payload: JSON.stringify({
          kind: "user_question",
          questions: [
            {
              allowFreeText: true,
              id: providerRequestId,
              multiSelect: false,
              prompt: bash1.prompt,
            },
          ],
        }),
        providerId: "claude-code",
        providerRequestId,
        providerThreadId: SESSION_ID,
        statusReason: DAEMON_RESTARTED_PENDING_INTERACTION_REASON,
        threadId: other.id,
        turnId: "native-terminal-turn",
      });
      await send(fixture, thread.id, { closes: [bash1.id], state: "working" });
      expect(
        getPendingInteractionByProviderRequest(fixture.harness.db, {
          providerId: "claude-code",
          providerRequestId,
          providerThreadId: SESSION_ID,
        }),
      ).toMatchObject({
        status: "interrupted",
        statusReason: DAEMON_RESTARTED_PENDING_INTERACTION_REASON,
        threadId: other.id,
      });
    });

    it("is not forgotten when the terminal exits or a new terminal is bound", async () => {
      const fixture = await createFixture();
      const clock = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
      try {
        const thread = await startThread(fixture);
        await send(fixture, thread.id, {
          closes: [bash1.id],
          state: "working",
        });
        await reopen(fixture, thread);
        clock.mockReturnValue(1_020_000);
        await send(fixture, thread.id, {
          closes: [],
          questions: [bash1],
          state: "waiting",
        });
        expect(openInteractions(fixture, thread.id)).toHaveLength(0);
      } finally {
        clock.mockRestore();
      }
    });

    it("keeps a question that the daemon restart interrupted from being revived once it was closed by name", async () => {
      const fixture = await createFixture();
      const clock = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
      try {
        const thread = await startThread(fixture);
        await send(fixture, thread.id, {
          questions: [bash1],
          state: "waiting",
        });
        const [pending] = openInteractions(fixture, thread.id);
        fixture.harness.deps.pendingInteractions.interruptPendingInteraction({
          interactionId: pending!.id,
          reason: DAEMON_RESTARTED_PENDING_INTERACTION_REASON,
        });
        expect(openInteractions(fixture, thread.id)).toHaveLength(0);
        await send(fixture, thread.id, {
          closes: [bash1.id],
          state: "working",
        });
        await send(fixture, thread.id, {
          closes: [],
          questions: [bash1],
          state: "waiting",
        });
        expect(openInteractions(fixture, thread.id)).toHaveLength(0);
        expect(
          getPendingInteractionByProviderRequest(fixture.harness.db, {
            providerId: "claude-code",
            providerRequestId: `${NATIVE_TERMINAL_QUESTION_REQUEST_PREFIX}${bash1.id}`,
            providerThreadId: SESSION_ID,
          }),
        ).toMatchObject({
          status: "interrupted",
          statusReason: "native-terminal-question-answered",
        });
      } finally {
        clock.mockRestore();
      }
    });

    it("revives an unclosed question the daemon restart interrupted (control)", async () => {
      const fixture = await createFixture();
      const clock = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
      try {
        const thread = await startThread(fixture);
        await send(fixture, thread.id, {
          questions: [bash1],
          state: "waiting",
        });
        const [pending] = openInteractions(fixture, thread.id);
        fixture.harness.deps.pendingInteractions.interruptPendingInteraction({
          interactionId: pending!.id,
          reason: DAEMON_RESTARTED_PENDING_INTERACTION_REASON,
        });
        await send(fixture, thread.id, {
          questions: [bash1],
          state: "waiting",
        });
        expect(openInteractions(fixture, thread.id)).toHaveLength(1);
      } finally {
        clock.mockRestore();
      }
    });
  });

  describe("a holder that resumes the same session", () => {
    it("registers its first prompt of a tool again, because the ids carry the new holder's nonce", async () => {
      const fixture = await createFixture();
      const clock = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
      try {
        const thread = await startThread(fixture);
        const first = { id: "permission:Bash#aaaa.1", prompt: "Allow Bash?" };
        await send(fixture, thread.id, {
          questions: [first],
          state: "waiting",
        });
        await send(fixture, thread.id, {
          closes: [first.id],
          state: "working",
        });
        fixture.harness.deps.terminalSessions.handleDaemonTerminalMessage({
          hostId: fixture.hostId,
          sessionId: fixture.sessionId,
          message: {
            type: "terminal.exited",
            terminalId: thread.open.terminalId,
            exitCode: null,
            closeReason: "daemon-disconnect",
          },
        });
        const opens = countDaemonMessages(fixture, "terminal.open");
        const reopening = postJson(
          fixture,
          `/threads/${thread.id}/native-terminal/open`,
          {},
        );
        const reopened = await waitForDaemonMessage(
          fixture,
          "terminal.open",
          opens,
        );
        acknowledgeOpen(fixture, reopened);
        expect((await reopening).status).toBe(200);
        clock.mockReturnValue(1_020_000);
        await send(fixture, thread.id, {
          questions: [{ id: "permission:Bash#bbbb.1", prompt: "Allow Bash?" }],
          state: "waiting",
        });
        expect(pendingIds(fixture, thread.id)).toEqual([
          expect.stringContaining("permission:Bash#bbbb.1"),
        ]);
        await send(fixture, thread.id, {
          closes: ["permission:Bash#bbbb.1"],
          state: "working",
        });
        await send(fixture, thread.id, {
          questions: [{ id: "permission:Bash#aaaa.1", prompt: "Allow Bash?" }],
          state: "waiting",
        });
        expect(openInteractions(fixture, thread.id)).toHaveLength(0);
      } finally {
        clock.mockRestore();
      }
    });

    it("forgets the cache of refused question ids at the new binding", async () => {
      const fixture = await createFixture();
      const clock = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
      const warn = vi.spyOn(fixture.harness.deps.logger, "warn");
      try {
        const thread = await startThread(fixture);
        const old = { id: "permission:Bash#1", prompt: "Allow Bash?" };
        await send(fixture, thread.id, { questions: [old], state: "waiting" });
        await send(fixture, thread.id, { state: "working", prompt: "next" });
        const refusals = () =>
          warn.mock.calls.filter(
            (call) => call[1] === "Native terminal question was not registered",
          ).length;
        await send(fixture, thread.id, { questions: [old], state: "waiting" });
        expect(refusals()).toBe(1);
        await send(fixture, thread.id, { questions: [old], state: "waiting" });
        expect(refusals()).toBe(1);
        fixture.harness.deps.terminalSessions.handleDaemonTerminalMessage({
          hostId: fixture.hostId,
          sessionId: fixture.sessionId,
          message: {
            type: "terminal.exited",
            terminalId: thread.open.terminalId,
            exitCode: null,
            closeReason: "daemon-disconnect",
          },
        });
        const opens = countDaemonMessages(fixture, "terminal.open");
        const reopening = postJson(
          fixture,
          `/threads/${thread.id}/native-terminal/open`,
          {},
        );
        const reopened = await waitForDaemonMessage(
          fixture,
          "terminal.open",
          opens,
        );
        acknowledgeOpen(fixture, reopened);
        expect((await reopening).status).toBe(200);
        await send(fixture, thread.id, { questions: [old], state: "waiting" });
        expect(refusals()).toBe(2);
      } finally {
        clock.mockRestore();
      }
    });
  });

  it("ends the questions of the previous binding when a new terminal is bound, so a holder that names what it closes leaves no orphan", async () => {
    const fixture = await createFixture();
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    try {
      const thread = await answeredQuestion(fixture, clock);
      fixture.harness.deps.terminalSessions.handleDaemonTerminalMessage({
        hostId: fixture.hostId,
        sessionId: fixture.sessionId,
        message: {
          type: "terminal.exited",
          terminalId: thread.open.terminalId,
          exitCode: null,
          closeReason: "daemon-disconnect",
        },
      });
      expect(openInteractions(fixture, thread.id)).toHaveLength(1);
      const opens = countDaemonMessages(fixture, "terminal.open");
      const reopening = postJson(
        fixture,
        `/threads/${thread.id}/native-terminal/open`,
        {},
      );
      const reopened = await waitForDaemonMessage(
        fixture,
        "terminal.open",
        opens,
      );
      acknowledgeOpen(fixture, reopened);
      expect((await reopening).status).toBe(200);
      expect(openInteractions(fixture, thread.id)).toHaveLength(0);
    } finally {
      clock.mockRestore();
    }
  });

  it("clears only the evidence of its own thread and terminal session", async () => {
    const fixture = await createFixture();
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    try {
      const thread = await answeredQuestion(fixture, clock);
      const terminalSessionId = getNativeTerminalThread(
        fixture.harness.db,
        thread.id,
      )?.terminalSessionId;
      if (terminalSessionId === null || terminalSessionId === undefined) {
        throw new Error("terminal session missing");
      }
      expect(
        clearNativeTerminalThreadActivityEvidence(fixture.harness.db, {
          at: 9_999_999,
          terminalSessionId: "term_of_an_earlier_binding",
          threadId: thread.id,
        }),
      ).toEqual({ cleared: false });
      expect(
        clearNativeTerminalThreadActivityEvidence(fixture.harness.db, {
          at: 9_999_999,
          terminalSessionId,
          threadId: "thr_another_thread",
        }),
      ).toEqual({ cleared: false });
      expect(evidence(fixture, thread.id)).toBe(1_010_000);
      expect(
        clearNativeTerminalThreadActivityEvidence(fixture.harness.db, {
          at: 9_999_999,
          terminalSessionId,
          threadId: thread.id,
        }),
      ).toEqual({ cleared: true });
      expect(evidence(fixture, thread.id)).toBeNull();
    } finally {
      clock.mockRestore();
    }
  });

  it.each([
    ["without the field", undefined],
    ["with confirms true", true],
  ])("stamps as before for a report %s", async (_name, confirms) => {
    const fixture = await createFixture();
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    try {
      const thread = await answeredQuestion(fixture, clock);
      clock.mockReturnValue(1_020_000);
      expect(
        (
          await send(fixture, thread.id, {
            ...(confirms === undefined ? {} : { confirms }),
            state: "working",
          })
        ).status,
      ).toBe(200);
      expect(openInteractions(fixture, thread.id)).toHaveLength(0);
      expect(evidence(fixture, thread.id)).toBe(1_020_000);
      expect(display(fixture, thread.id)).toMatchObject({
        confirmation: "confirmed",
      });
    } finally {
      clock.mockRestore();
    }
  });

  it("rejects a confirms value that is not a boolean", async () => {
    const fixture = await createFixture();
    const thread = await startThread(fixture);
    const response = await send(fixture, thread.id, {
      confirms: "no",
      state: "working",
    });
    expect(response.status).toBe(400);
    expect(await readApiErrorCode(response)).toBe("invalid_request");
  });
});
