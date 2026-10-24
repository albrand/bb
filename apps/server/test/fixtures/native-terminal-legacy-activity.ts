import {
  getNativeTerminalThread,
  getThread,
  clearThreadRowState,
  stampNativeTerminalThreadActivity,
  type TerminalSessionRow,
} from "@bb/db";
import {
  isNativeTerminalQuestion,
  NATIVE_TERMINAL_ACTIVITY_HEARTBEAT_INTERVAL_MS,
  NATIVE_TERMINAL_QUESTION_REQUEST_PREFIX,
  type Thread,
} from "@bb/domain";
import type {
  NativeTerminalOpenQuestion,
  ReportNativeTerminalActivityRequest,
} from "@bb/server-contract";
import { ApiError } from "../../src/errors.js";
import {
  buildChildThreadBlockerSummary,
  requestChildThreadNeedsAttentionNotification,
} from "../../src/internal/interactive-requests.js";
import type {
  AppDeps,
  LoggedPendingInteractionWorkSessionDeps,
} from "../../src/types.js";
import { requirePublicThread } from "../../src/services/lib/entity-lookup.js";
import { applyLoggedThreadLifecycleEvent } from "../../src/services/threads/lifecycle-outcome.js";
import {
  readRecordTerminal,
  requireLiveNativeTerminalToolThread,
  requireNativeTerminalToolCredential,
} from "../../src/services/threads/native-terminal-threads.js";
import { buildThreadStatusChangeMetadata } from "../../src/services/threads/thread-runtime-display.js";
import { generateAndApplyThreadTitle } from "../../src/services/threads/title-generation.js";

type NativeTerminalActivityDeps = LoggedPendingInteractionWorkSessionDeps &
  Pick<
    AppDeps,
    "db" | "hub" | "logger" | "providerRegistry" | "terminalSessions"
  >;

const activeNativeThreads = new WeakMap<AppDeps["hub"], Set<string>>();
const rejectedNativeQuestions = new WeakMap<
  AppDeps["hub"],
  Map<string, Set<string>>
>();
const nativeActivityReports = new WeakMap<
  AppDeps["hub"],
  Map<string, { signature: string; lastNotifiedAt: number }>
>();

function reportStates(deps: Pick<AppDeps, "hub">) {
  let states = nativeActivityReports.get(deps.hub);
  if (states === undefined) {
    states = new Map();
    nativeActivityReports.set(deps.hub, states);
  }
  return states;
}

function hasCurrentLiveTerminalCredential(
  deps: Pick<AppDeps, "db" | "terminalSessions">,
  args: { authorization: string | undefined; threadId: string },
): boolean {
  if (args.authorization === undefined) return false;
  try {
    requireNativeTerminalToolCredential(deps, args);
    requireLiveNativeTerminalToolThread(deps, args.threadId);
    return true;
  } catch (error) {
    if (
      error instanceof ApiError &&
      (error.body.code === "native_terminal_credential_invalid" ||
        error.body.code === "native_terminal_not_live" ||
        error.body.code === "thread_environment_unavailable" ||
        error.body.code === "environment_not_found")
    ) {
      return false;
    }
    throw error;
  }
}

function rejectedQuestions(deps: Pick<AppDeps, "hub">, threadId: string) {
  let byThread = rejectedNativeQuestions.get(deps.hub);
  if (byThread === undefined) {
    byThread = new Map();
    rejectedNativeQuestions.set(deps.hub, byThread);
  }
  let questions = byThread.get(threadId);
  if (questions === undefined) {
    questions = new Set();
    byThread.set(threadId, questions);
  }
  return questions;
}

function activeThreads(deps: Pick<AppDeps, "hub">): Set<string> {
  let threads = activeNativeThreads.get(deps.hub);
  if (threads !== undefined) return threads;
  threads = new Set<string>();
  const active = threads;
  deps.hub.onChangedMessage((message) => {
    if (message.entity === "thread") active.delete(message.id);
  });
  activeNativeThreads.set(deps.hub, active);
  return active;
}

function requireNativeRecord(deps: Pick<AppDeps, "db">, threadId: string) {
  const record = getNativeTerminalThread(deps.db, threadId);
  if (record === null) {
    throw new ApiError(
      404,
      "native_terminal_thread_not_found",
      "This thread is not running in its native terminal",
    );
  }
  return record;
}

const NATIVE_QUESTION_REQUEST_PREFIX = NATIVE_TERMINAL_QUESTION_REQUEST_PREFIX;
const NATIVE_QUESTION_TURN_ID = "native-terminal-turn";
const NATIVE_QUESTION_ANSWERED_REASON = "native-terminal-question-answered";

export function recordNativeTerminalActivity(
  deps: NativeTerminalActivityDeps,
  args: {
    authorization?: string;
    threadId: string;
  } & ReportNativeTerminalActivityRequest,
): void {
  const active = activeThreads(deps);
  const repeatedWorkingSignal =
    args.state === "working" &&
    args.prompt === undefined &&
    active.has(args.threadId);
  if (repeatedWorkingSignal && args.authorization === undefined) return;
  const now = Date.now();
  let notifyReceipt = false;
  const currentTerminalIsLive = hasCurrentLiveTerminalCredential(deps, {
    authorization: args.authorization,
    threadId: args.threadId,
  });
  const currentNativeRecord = currentTerminalIsLive
    ? getNativeTerminalThread(deps.db, args.threadId)
    : null;
  if (
    currentNativeRecord !== null &&
    currentNativeRecord.terminalSessionId !== null
  ) {
    const stamp = stampNativeTerminalThreadActivity(deps.db, {
      at: now,
      terminalSessionId: currentNativeRecord.terminalSessionId,
      threadId: args.threadId,
    });
    if (stamp.updated) {
      const states = reportStates(deps);
      const signature = JSON.stringify({
        prompt: args.prompt ?? null,
        questions: args.questions ?? [],
        state: args.state,
      });
      const previous = states.get(args.threadId);
      const transition =
        previous === undefined || previous.signature !== signature;
      const heartbeatElapsed =
        previous === undefined ||
        now - previous.lastNotifiedAt >=
          NATIVE_TERMINAL_ACTIVITY_HEARTBEAT_INTERVAL_MS;
      const firstReceiptForBinding = stamp.previousLastEvidenceAt === null;
      notifyReceipt = firstReceiptForBinding || transition || heartbeatElapsed;
      if (previous === undefined || notifyReceipt) {
        states.set(args.threadId, { signature, lastNotifiedAt: now });
      } else {
        states.set(args.threadId, { ...previous, signature });
      }
    }
  }
  if (repeatedWorkingSignal) {
    if (notifyReceipt) {
      const thread = requirePublicThread(deps.db, args.threadId);
      const metadata = buildThreadStatusChangeMetadata(deps, thread);
      deps.hub.notifyThread(args.threadId, ["status-changed"], metadata);
    }
    return;
  }
  active.delete(args.threadId);
  const thread = requirePublicThread(deps.db, args.threadId);
  const record = requireNativeRecord(deps, args.threadId);
  if (notifyReceipt) {
    const metadata = buildThreadStatusChangeMetadata(deps, thread);
    deps.hub.notifyThread(args.threadId, ["status-changed"], metadata);
  }
  if (
    args.state === "working" &&
    args.prompt === undefined &&
    active.has(args.threadId)
  ) {
    return;
  }
  let working = thread.status === "active";
  if (
    args.state !== "idle" &&
    (thread.status === "idle" || thread.status === "error")
  ) {
    const outcome = applyLoggedThreadLifecycleEvent(deps, {
      event: { type: "run.started" },
      threadId: thread.id,
    });
    working = outcome.applied && outcome.thread.status === "active";
  }
  if (args.state === "idle") settleNativeTerminalTurn(deps, thread.id);
  reconcileNativeQuestions(deps, {
    nativeSessionId: record.nativeSessionId,
    questions: args.questions ?? [],
    thread,
  });
  if (args.prompt !== undefined) {
    titleNativeThreadFromPrompt(deps, thread.id, args.prompt);
  }
  if (args.state === "working" && working) active.add(thread.id);
}

export function interruptNativeTerminalQuestions(
  deps: Pick<AppDeps, "pendingInteractions">,
  threadId: string,
  keep: ReadonlySet<string> = new Set(),
): void {
  for (const interaction of deps.pendingInteractions.listPendingThreadInteractions(
    threadId,
  )) {
    if (
      !isNativeTerminalQuestion(interaction) ||
      keep.has(interaction.providerRequestId)
    ) {
      continue;
    }
    deps.pendingInteractions.interruptPendingInteraction({
      interactionId: interaction.id,
      reason: NATIVE_QUESTION_ANSWERED_REASON,
    });
  }
}

function reconcileNativeQuestions(
  deps: NativeTerminalActivityDeps,
  args: {
    nativeSessionId: string | null;
    questions: readonly NativeTerminalOpenQuestion[];
    thread: Thread;
  },
): void {
  const wanted = new Map(
    args.questions
      .map(
        (question) =>
          [
            `${NATIVE_QUESTION_REQUEST_PREFIX}${question.id}`,
            question,
          ] as const,
      )
      .filter(
        ([providerRequestId]) =>
          !rejectedQuestions(deps, args.thread.id).has(providerRequestId),
      ),
  );
  interruptNativeTerminalQuestions(
    deps,
    args.thread.id,
    new Set(wanted.keys()),
  );
  for (const [providerRequestId, question] of wanted) {
    const registered = deps.pendingInteractions.registerPendingInteraction({
      interaction: {
        threadId: args.thread.id,
        turnId: NATIVE_QUESTION_TURN_ID,
        providerId: args.thread.providerId,
        providerThreadId: args.nativeSessionId ?? args.thread.id,
        providerRequestId,
        payload: {
          kind: "user_question",
          questions: [
            {
              id: providerRequestId,
              prompt: question.prompt,
              multiSelect: false,
              allowFreeText: true,
            },
          ],
        },
      },
    });
    if (registered.outcome === "rejected") {
      rejectedQuestions(deps, args.thread.id).add(providerRequestId);
      deps.logger.warn(
        { reason: registered.reason, threadId: args.thread.id },
        "Native terminal question was not registered",
      );
      continue;
    }
    if (registered.outcome === "created") {
      requestChildThreadNeedsAttentionNotification(deps, {
        blockerSummary: buildChildThreadBlockerSummary(registered.interaction),
        childThreadId: args.thread.id,
      });
    }
  }
}

export function clearNativeTerminalStateOnExit(
  deps: Pick<
    AppDeps,
    "db" | "hub" | "logger" | "pendingInteractions" | "providerRegistry"
  >,
  session: Pick<TerminalSessionRow, "closeReason" | "id" | "threadId">,
): void {
  if (
    session.threadId === null ||
    session.closeReason === "daemon-disconnect"
  ) {
    return;
  }
  const record = getNativeTerminalThread(deps.db, session.threadId);
  if (record === null || record.terminalSessionId !== session.id) return;
  interruptNativeTerminalQuestions(deps, session.threadId);
  clearThreadRowState(deps.db, session.threadId);
  deps.hub.notifyThread(session.threadId, ["status-changed"]);
  if (session.closeReason === "process-exit") {
    settleNativeTerminalTurn(deps, session.threadId);
  }
}

export function settleNativeTerminalTurn(
  deps: Pick<AppDeps, "db" | "hub" | "logger" | "providerRegistry">,
  threadId: string,
): void {
  if (getThread(deps.db, threadId)?.status !== "active") return;
  applyLoggedThreadLifecycleEvent(deps, {
    event: { type: "run.succeeded" },
    threadId,
  });
}

function titleNativeThreadFromPrompt(
  deps: NativeTerminalActivityDeps,
  threadId: string,
  prompt: string,
): void {
  void generateAndApplyThreadTitle(deps, {
    input: [{ type: "text", text: prompt, mentions: [] }],
    threadId,
  }).catch((error: unknown) => {
    deps.logger.warn(
      { err: error, threadId },
      "Native terminal thread title generation failed",
    );
  });
}

export function interruptNativeTerminalTurn(
  deps: Pick<AppDeps, "db" | "terminalSessions">,
  threadId: string,
): void {
  const record = requireNativeRecord(deps, threadId);
  const terminal = readRecordTerminal(deps, record);
  if (terminal === null || terminal.status !== "running") {
    throw new ApiError(
      409,
      "native_terminal_not_running",
      "The native session is not running, so there is no turn to stop",
    );
  }
  deps.terminalSessions.sendTerminalInput({
    terminalId: terminal.id,
    payload: { dataBase64: Buffer.from("\u001b", "utf8").toString("base64") },
  });
}
