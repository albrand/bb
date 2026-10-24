import {
  clearNativeTerminalThreadActivityEvidence,
  createInterruptedProviderPendingInteraction,
  getNativeTerminalThread,
  getPendingInteractionByProviderRequest,
  getThread,
  clearThreadRowState,
  retagInterruptedPendingInteraction,
  stampNativeTerminalThreadActivity,
  stampNativeTerminalThreadToolCall,
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
import { ApiError } from "../../errors.js";
import { DAEMON_RESTARTED_PENDING_INTERACTION_REASON } from "../interactions/pending-interactions.js";
import {
  buildChildThreadBlockerSummary,
  requestChildThreadNeedsAttentionNotification,
} from "../../internal/interactive-requests.js";
import type {
  AppDeps,
  LoggedPendingInteractionWorkSessionDeps,
} from "../../types.js";
import { requirePublicThread } from "../lib/entity-lookup.js";
import { applyLoggedThreadLifecycleEvent } from "./lifecycle-outcome.js";
import {
  isNativeTerminalRebindInFlight,
  nativeTerminalAwaitsReattach,
  readRecordTerminal,
  requireLiveNativeTerminalToolThread,
  requireNativeTerminalToolCredential,
} from "./native-terminal-threads.js";
import {
  interruptNativeTerminalQuestions,
  NATIVE_QUESTION_ANSWERED_REASON,
  rejectedQuestions,
} from "./native-terminal-questions.js";
import { buildThreadStatusChangeMetadata } from "./thread-runtime-display.js";

export { interruptNativeTerminalQuestions };
import { generateAndApplyThreadTitle } from "./title-generation.js";

type NativeTerminalActivityDeps = LoggedPendingInteractionWorkSessionDeps &
  Pick<
    AppDeps,
    "db" | "hub" | "logger" | "providerRegistry" | "terminalSessions"
  >;

const activeNativeThreads = new WeakMap<AppDeps["hub"], Set<string>>();
const nativeActivityReports = new WeakMap<
  AppDeps["hub"],
  Map<string, { signature: string; lastNotifiedAt: number }>
>();

const nativeToolCallNotifications = new WeakMap<
  AppDeps["hub"],
  Map<string, number>
>();

function toolCallNotifications(deps: Pick<AppDeps, "hub">) {
  let notified = nativeToolCallNotifications.get(deps.hub);
  if (notified === undefined) {
    notified = new Map();
    nativeToolCallNotifications.set(deps.hub, notified);
  }
  return notified;
}

function reportStates(deps: Pick<AppDeps, "hub">) {
  let states = nativeActivityReports.get(deps.hub);
  if (states === undefined) {
    states = new Map();
    nativeActivityReports.set(deps.hub, states);
  }
  return states;
}

function hasCurrentTerminalCredential(
  deps: Pick<AppDeps, "db" | "terminalSessions">,
  args: { authorization: string | undefined; threadId: string },
): boolean {
  if (args.authorization === undefined) return false;
  try {
    requireNativeTerminalToolCredential(deps, args);
    return true;
  } catch (error) {
    if (
      error instanceof ApiError &&
      error.body.code === "native_terminal_credential_invalid"
    ) {
      return false;
    }
    throw error;
  }
}

type CurrentTerminalState = "live" | "awaiting-reattach" | "unavailable";

function currentTerminalState(
  deps: Pick<AppDeps, "db" | "terminalSessions">,
  threadId: string,
): CurrentTerminalState {
  try {
    requireLiveNativeTerminalToolThread(deps, threadId);
    return "live";
  } catch (error) {
    if (error instanceof ApiError) {
      if (error.body.code === "native_terminal_not_live") {
        if (nativeTerminalAwaitsReattach(deps, threadId)) {
          return "awaiting-reattach";
        }
        throw error;
      }
      if (
        error.body.code === "thread_environment_unavailable" ||
        error.body.code === "environment_not_found"
      ) {
        return "unavailable";
      }
    }
    throw error;
  }
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

export function recordNativeTerminalActivity(
  deps: NativeTerminalActivityDeps,
  args: {
    authorization?: string;
    confirms: boolean;
    threadId: string;
  } & Omit<ReportNativeTerminalActivityRequest, "confirms">,
): void {
  requireNativeRecord(deps, args.threadId);
  const credentialIsCurrent = hasCurrentTerminalCredential(deps, {
    authorization: args.authorization,
    threadId: args.threadId,
  });
  if (!credentialIsCurrent) {
    deps.logger.warn(
      { threadId: args.threadId },
      "A native terminal activity report without the current holder credential was rejected",
    );
    throw new ApiError(
      401,
      "native_terminal_credential_invalid",
      "A valid credential for this thread's current native terminal is required",
    );
  }
  let currentTerminalIsLive: boolean;
  try {
    currentTerminalIsLive =
      currentTerminalState(deps, args.threadId) === "live";
  } catch (error) {
    deps.logger.warn(
      { threadId: args.threadId },
      "A native terminal activity report for a terminal that is not running was rejected",
    );
    throw error;
  }
  const active = activeThreads(deps);
  const repeatedWorkingSignal =
    args.state === "working" &&
    args.prompt === undefined &&
    (args.closes?.length ?? 0) === 0 &&
    active.has(args.threadId);
  const now = Date.now();
  let notifyReceipt = false;
  const currentNativeRecord =
    currentTerminalIsLive && !isNativeTerminalRebindInFlight(args.threadId)
      ? getNativeTerminalThread(deps.db, args.threadId)
      : null;
  if (
    args.confirms &&
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
        closes: args.closes ?? [],
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
  const resolvedQuestions = reconcileNativeQuestions(deps, {
    closes: args.closes,
    nativeSessionId: record.nativeSessionId,
    questions: args.questions ?? [],
    thread,
  });
  if (
    !args.confirms &&
    resolvedQuestions > 0 &&
    currentNativeRecord !== null &&
    currentNativeRecord.terminalSessionId !== null
  ) {
    const cleared = clearNativeTerminalThreadActivityEvidence(deps.db, {
      at: now,
      terminalSessionId: currentNativeRecord.terminalSessionId,
      threadId: args.threadId,
    });
    if (cleared.cleared) {
      reportStates(deps).delete(args.threadId);
      deps.hub.notifyThread(
        args.threadId,
        ["status-changed"],
        buildThreadStatusChangeMetadata(
          deps,
          requirePublicThread(deps.db, args.threadId),
        ),
      );
    }
  }
  if (args.prompt !== undefined) {
    titleNativeThreadFromPrompt(deps, thread.id, args.prompt);
  }
  if (args.state === "working" && working) active.add(thread.id);
}

export function recordNativeTerminalToolCallEvidence(
  deps: AppDeps,
  args: { terminalSessionId: string; threadId: string },
): void {
  try {
    if (isNativeTerminalRebindInFlight(args.threadId)) return;
    const now = Date.now();
    const stamp = stampNativeTerminalThreadToolCall(deps.db, {
      at: now,
      terminalSessionId: args.terminalSessionId,
      threadId: args.threadId,
    });
    if (!stamp.updated) return;
    const notified = toolCallNotifications(deps);
    const lastNotifiedAt = notified.get(args.threadId);
    const notifiedRecently =
      stamp.previousLastToolCallAt !== null &&
      lastNotifiedAt !== undefined &&
      now >= lastNotifiedAt &&
      now - lastNotifiedAt < NATIVE_TERMINAL_ACTIVITY_HEARTBEAT_INTERVAL_MS;
    if (notifiedRecently) return;
    notified.set(args.threadId, now);
    const thread = requirePublicThread(deps.db, args.threadId);
    deps.hub.notifyThread(
      args.threadId,
      ["status-changed"],
      buildThreadStatusChangeMetadata(deps, thread),
    );
  } catch (error) {
    deps.logger.warn(
      { err: error, threadId: args.threadId },
      "Native terminal tool-call evidence was not recorded",
    );
  }
}

function closeNamedNativeQuestions(
  deps: Pick<AppDeps, "db" | "pendingInteractions">,
  args: {
    nativeSessionId: string | null;
    questionIds: readonly string[];
    thread: Thread;
  },
): number {
  const remaining = new Set(
    args.questionIds.map((id) => `${NATIVE_QUESTION_REQUEST_PREFIX}${id}`),
  );
  let closed = 0;
  for (const interaction of deps.pendingInteractions.listPendingThreadInteractions(
    args.thread.id,
  )) {
    if (
      !isNativeTerminalQuestion(interaction) ||
      !remaining.has(interaction.providerRequestId)
    ) {
      continue;
    }
    deps.pendingInteractions.interruptPendingInteraction({
      interactionId: interaction.id,
      reason: NATIVE_QUESTION_ANSWERED_REASON,
    });
    remaining.delete(interaction.providerRequestId);
    closed += 1;
  }
  const providerThreadId = args.nativeSessionId ?? args.thread.id;
  for (const providerRequestId of remaining) {
    const identity = {
      providerId: args.thread.providerId,
      providerRequestId,
      providerThreadId,
    };
    const existing = getPendingInteractionByProviderRequest(deps.db, identity);
    if (existing === null) {
      createInterruptedProviderPendingInteraction(deps.db, {
        ...identity,
        payload: JSON.stringify({
          kind: "user_question",
          questions: [
            {
              id: providerRequestId,
              prompt: "Closed before it was reported",
              multiSelect: false,
              allowFreeText: true,
            },
          ],
        }),
        statusReason: NATIVE_QUESTION_ANSWERED_REASON,
        threadId: args.thread.id,
        turnId: NATIVE_QUESTION_TURN_ID,
      });
    } else if (
      existing.threadId === args.thread.id &&
      existing.status === "interrupted" &&
      existing.statusReason === DAEMON_RESTARTED_PENDING_INTERACTION_REASON
    ) {
      retagInterruptedPendingInteraction(deps.db, {
        fromStatusReason: DAEMON_RESTARTED_PENDING_INTERACTION_REASON,
        id: existing.id,
        threadId: args.thread.id,
        toStatusReason: NATIVE_QUESTION_ANSWERED_REASON,
      });
    }
  }
  return closed;
}

function reconcileNativeQuestions(
  deps: NativeTerminalActivityDeps,
  args: {
    closes: readonly string[] | undefined;
    nativeSessionId: string | null;
    questions: readonly NativeTerminalOpenQuestion[];
    thread: Thread;
  },
): number {
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
  const interrupted =
    args.closes === undefined
      ? 0
      : closeNamedNativeQuestions(deps, {
          nativeSessionId: args.nativeSessionId,
          questionIds: args.closes.filter(
            (id) => !wanted.has(`${NATIVE_QUESTION_REQUEST_PREFIX}${id}`),
          ),
          thread: args.thread,
        });
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
  return interrupted;
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
