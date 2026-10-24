import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  consumeNativeTerminalThreadLaunchInput,
  deleteNativeTerminalToolCredential,
  getNativeTerminalToolCredential,
  setNativeTerminalToolCredential,
  getEnvironment,
  getNativeTerminalThread,
  getStoredProviderSession,
  listTerminalSessions,
  getThread,
  listNativeTerminalThreadsWithDisconnectedTerminal,
  recordNativeTerminalThreadSessionId,
  rebindNativeTerminalThreadSessionId,
  clearNativeTerminalThreadEvidence,
  setNativeTerminalThreadTerminal,
  type NativeTerminalThreadRecord,
} from "@bb/db";
import {
  isActiveTerminalSessionStatus,
  pathLooksRuntimeReadable,
  type PromptInput,
  type ProviderNativeTerminal,
} from "@bb/domain";
import type {
  NativeTerminalAgentTools,
  NativeTerminalLaunchSpec,
  NativeTerminalThread,
  OpenNativeTerminalRequest,
  TerminalSession,
} from "@bb/server-contract";
import { ApiError } from "../../errors.js";
import type {
  AppDeps,
  LoggedPendingInteractionWorkSessionDeps,
} from "../../types.js";
import { isServerMachineHost } from "../hosts/primary-host.js";
import { storedProjectAttachmentPath } from "../projects/attachments.js";
import {
  requirePublicThreadEnvironment,
  requirePublicThread,
  type ThreadEnvironmentLookupResult,
} from "../lib/entity-lookup.js";
import { resolvePluginProviderEnv } from "../plugins/plugin-agent-contributions.js";
import { applyLoggedThreadLifecycleEventInTransaction } from "./lifecycle-outcome.js";
import {
  forgetRejectedNativeQuestions,
  interruptNativeTerminalQuestions,
} from "./native-terminal-questions.js";
import {
  decodeTerminalOutputChunks,
  terminalOutputAlreadyShowsText,
  terminalOutputShowsPaste,
  terminalOutputShowsPasteAgain,
  terminalScreenAlreadyShowsText,
} from "./native-terminal-echo.js";
import { resolveThreadDynamicTools } from "./thread-runtime-config.js";
import { UPDATE_ENVIRONMENT_DIRECTORY_TOOL_NAME } from "./thread-environment-directory.js";
import { createClientTurnRequestId } from "./thread-events.js";
import { interruptActiveThreadsForHost } from "./thread-lifecycle.js";
import { scheduleThreadProvisioningAdvance } from "./thread-provisioning.js";
import type { ThreadProvisioningDeps } from "./thread-provisioning-environment.js";
import {
  createThreadStartup,
  saveThreadProvisionContext,
  type ThreadProvisionEnvironmentIntent,
} from "./thread-startup-store.js";

type ThreadRow = NonNullable<ReturnType<typeof getThread>>;

const NATIVE_TERMINAL_DEFAULT_COLS = 120;
const NATIVE_TERMINAL_DEFAULT_ROWS = 36;

type NativeTerminalDeps = Pick<
  AppDeps,
  | "config"
  | "db"
  | "hub"
  | "logger"
  | "pendingInteractions"
  | "providerRegistry"
  | "terminalSessions"
>;

type NativeTerminalReopenDeps = NativeTerminalDeps &
  LoggedPendingInteractionWorkSessionDeps;

type NativeTerminalViewDeps = Pick<
  AppDeps,
  "db" | "providerRegistry" | "terminalSessions"
>;

interface PendingNativeTerminalOpen {
  promise: Promise<NativeTerminalThread>;
  reattachOnly: boolean;
}

const pendingOpens = new Map<string, PendingNativeTerminalOpen>();
const pendingSends = new Map<string, Promise<void>>();
const rebindsInFlight = new Map<string, number>();

function beginNativeTerminalRebind(threadId: string): void {
  rebindsInFlight.set(threadId, (rebindsInFlight.get(threadId) ?? 0) + 1);
}

function endNativeTerminalRebind(threadId: string): void {
  const remaining = (rebindsInFlight.get(threadId) ?? 1) - 1;
  if (remaining <= 0) rebindsInFlight.delete(threadId);
  else rebindsInFlight.set(threadId, remaining);
}

export function isNativeTerminalRebindInFlight(threadId: string): boolean {
  return rebindsInFlight.has(threadId);
}
const reattachEpochs = new Map<string, number>();

function currentReattachEpoch(threadId: string): number {
  return reattachEpochs.get(threadId) ?? 0;
}

function bumpReattachEpoch(threadId: string): number {
  const next = currentReattachEpoch(threadId) + 1;
  reattachEpochs.set(threadId, next);
  return next;
}
const NATIVE_REATTACH_POLL_MS = 250;
const NATIVE_REATTACH_SETTLE_MS = 15_000;
const NATIVE_REATTACH_DEADLINE_MS = 45_000;
const NATIVE_REATTACH_RETRY_MS = 2_000;
const NATIVE_TERMINAL_ECHO_POLL_MS = 100;
const NATIVE_TERMINAL_ECHO_TIMEOUT_MS = 5000;
const NATIVE_TERMINAL_ECHO_CONTEXT_BYTES = 64 * 1024;

export interface NativeTerminalProvider {
  displayName: string;
  cli: ProviderNativeTerminal;
}

export function findNativeTerminalProvider(
  deps: Pick<AppDeps, "providerRegistry">,
  providerId: string,
): NativeTerminalProvider | null {
  const registration = deps.providerRegistry.get(providerId);
  if (registration === null || registration.nativeTerminal === null) {
    return null;
  }
  return {
    displayName: registration.info.displayName,
    cli: registration.nativeTerminal,
  };
}

export function requireNativeTerminalProvider(
  deps: Pick<AppDeps, "providerRegistry">,
  providerId: string,
): NativeTerminalProvider {
  const provider = findNativeTerminalProvider(deps, providerId);
  if (provider === null) {
    throw new ApiError(
      400,
      "invalid_request",
      `Provider ${providerId} does not declare a native terminal`,
    );
  }
  return provider;
}

interface NativeTerminalPromptArgs {
  hostId: string | null;
  input: readonly PromptInput[];
  projectId: string;
}

function nativeTerminalAttachmentPath(
  deps: Pick<AppDeps, "config">,
  args: Omit<NativeTerminalPromptArgs, "input"> & { path: string },
): string {
  if (pathLooksRuntimeReadable(args.path)) return args.path;
  if (args.hostId === null || !isServerMachineHost(deps, args.hostId)) {
    throw new ApiError(
      400,
      "invalid_request",
      "This terminal thread runs on another machine, where an uploaded attachment is not available. Put the file on that machine and send its path",
    );
  }
  return storedProjectAttachmentPath(
    deps.config.dataDir,
    args.projectId,
    args.path,
  );
}

export function nativeTerminalLaunchInput(
  deps: Pick<AppDeps, "config">,
  args: NativeTerminalPromptArgs & { provider: NativeTerminalProvider },
): { initialPrompt: string | null; initialImages: string[] } {
  const launchesImages = (args.provider.cli.imageArgs ?? []).length > 0;
  const initialImages = launchesImages
    ? nativeTerminalPromptParts(deps, {
        ...args,
        input: args.input.filter((entry) => entry.type === "localImage"),
      })
    : [];
  const prompt = nativeTerminalPromptParts(deps, {
    ...args,
    input: launchesImages
      ? args.input.filter((entry) => entry.type !== "localImage")
      : args.input,
  }).join("\n");
  return {
    initialPrompt: prompt.length === 0 ? null : prompt,
    initialImages,
  };
}

export function nativeTerminalPromptParts(
  deps: Pick<AppDeps, "config">,
  args: NativeTerminalPromptArgs,
): string[] {
  const attachments: string[] = [];
  const parts: string[] = [];
  for (const entry of args.input) {
    if (entry.type === "text") {
      parts.push(entry.text);
      continue;
    }
    attachments.push(
      entry.type === "image"
        ? entry.url
        : nativeTerminalAttachmentPath(deps, {
            hostId: args.hostId,
            path: entry.path,
            projectId: args.projectId,
          }),
    );
  }
  const text = parts.join("\n\n").trim();
  return [...attachments, ...(text.length === 0 ? [] : [text])];
}

export const NATIVE_TERMINAL_ENDED_MESSAGE =
  "The CLI for this thread ended while bb was disconnected from this machine. Open the terminal again to resume the session.";

function shellWord(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function nativeTerminalLaunchCommand(args: {
  executable: string;
  launchArgs: readonly string[];
  reattachOnly: boolean;
  threadId: string;
}): string {
  const executable = [args.executable, ...args.launchArgs.map(shellWord)].join(
    " ",
  );
  const env = `BB_THREAD_ID=${args.threadId}`;
  const wrapper = args.reattachOnly
    ? `"$BB_CLI" thread native-run ${args.threadId} --reattach`
    : `"$BB_CLI" thread native-run ${args.threadId}`;
  const fallback = args.reattachOnly
    ? `printf '%s\\r\\n' '${NATIVE_TERMINAL_ENDED_MESSAGE}';`
    : `unset ${NATIVE_TOOL_CREDENTIAL_ENV}; ${env} exec ${executable};`;
  return [
    `if [ -n "$BB_CLI" ] && ${wrapper} --probe >/dev/null 2>&1; then`,
    `${env} exec ${wrapper};`,
    `else ${fallback} fi`,
  ].join(" ");
}

export function beginNativeTerminalThreadProvisioning(
  deps: ThreadProvisioningDeps & Pick<AppDeps, "config" | "logger">,
  args: {
    environmentIntent: ThreadProvisionEnvironmentIntent;
    input: PromptInput[];
    thread: ThreadRow;
    titleProvided: boolean;
  },
): void {
  const started = deps.db.transaction(
    (tx) => {
      const prepared = applyLoggedThreadLifecycleEventInTransaction(
        { db: tx, logger: deps.logger },
        { event: { type: "run.preparing" }, threadId: args.thread.id },
      );
      if (!prepared.applied) return false;
      saveThreadProvisionContext({
        replace: true,
        db: tx,
        threadId: args.thread.id,
        context: createThreadStartup({
          clientRequestId: createClientTurnRequestId(),
          environmentIntent: args.environmentIntent,
          execution: null,
          fork: null,
          input: args.input,
          seedWithoutRun: true,
          titleProvided: args.titleProvided,
        }),
      });
      return true;
    },
    { behavior: "immediate" },
  );
  if (!started) {
    throw new ApiError(
      409,
      "thread_not_startable",
      "Native terminal thread could not start provisioning",
    );
  }
  scheduleThreadProvisioningAdvance(deps, args.thread.id);
}

function requireNativeTerminalThreadRecord(
  deps: Pick<AppDeps, "db">,
  threadId: string,
): NativeTerminalThreadRecord {
  requirePublicThread(deps.db, threadId);
  const record = getNativeTerminalThread(deps.db, threadId);
  if (record === null) {
    throw new ApiError(
      404,
      "native_terminal_thread_not_found",
      "This thread runs in chat. Switch it to its terminal first with Open in terminal, or `bb thread native <id> --convert`",
    );
  }
  return record;
}

export function readRecordTerminal(
  deps: Pick<AppDeps, "terminalSessions">,
  record: NativeTerminalThreadRecord,
): TerminalSession | null {
  if (record.terminalSessionId === null) return null;
  try {
    return deps.terminalSessions.getTerminal({
      terminalId: record.terminalSessionId,
    });
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

function canReturnToChat(
  deps: Pick<AppDeps, "db">,
  record: NativeTerminalThreadRecord,
): boolean {
  const session = getStoredProviderSession(deps.db, record.threadId);
  return (
    session.kind === "owned" &&
    session.providerThreadId === record.nativeSessionId
  );
}

function toNativeTerminalThread(
  deps: Pick<AppDeps, "db" | "providerRegistry" | "terminalSessions">,
  record: NativeTerminalThreadRecord,
  terminal: TerminalSession | null = readRecordTerminal(deps, record),
): NativeTerminalThread {
  return {
    threadId: record.threadId,
    providerId: record.providerId,
    displayName:
      deps.providerRegistry.get(record.providerId)?.info.displayName ??
      record.providerId,
    nativeSessionId: record.nativeSessionId,
    canReturnToChat: canReturnToChat(deps, record),
    terminal,
  };
}

export function findNativeTerminalThreadView(
  deps: NativeTerminalViewDeps,
  threadId: string,
): NativeTerminalThread | null {
  requirePublicThread(deps.db, threadId);
  const record = getNativeTerminalThread(deps.db, threadId);
  return record === null ? null : toNativeTerminalThread(deps, record);
}

export function getNativeTerminalThreadView(
  deps: NativeTerminalViewDeps,
  threadId: string,
): NativeTerminalThread {
  return toNativeTerminalThread(
    deps,
    requireNativeTerminalThreadRecord(deps, threadId),
  );
}

function terminalIsLive(terminal: TerminalSession | null): boolean {
  return (
    terminal !== null &&
    (isActiveTerminalSessionStatus(terminal.status) ||
      terminal.status === "disconnected")
  );
}

async function openNativeTerminalOnce(
  deps: NativeTerminalDeps,
  args: {
    reattachOnly: boolean;
    repaintOnAttach?: boolean;
    replaceLiveTerminal: boolean;
    threadId: string;
    request: OpenNativeTerminalRequest;
  },
): Promise<NativeTerminalThread> {
  const record = requireNativeTerminalThreadRecord(deps, args.threadId);
  const existing = readRecordTerminal(deps, record);
  if (
    !args.replaceLiveTerminal &&
    terminalIsLive(existing) &&
    !(args.reattachOnly && existing?.status === "disconnected")
  ) {
    return toNativeTerminalThread(deps, record);
  }
  const thread = requirePublicThread(deps.db, args.threadId);
  const provider = requireNativeTerminalProvider(deps, record.providerId);
  if (thread.archivedAt !== null) {
    throw new ApiError(
      409,
      "thread_archived",
      "Unarchive the thread before opening its native terminal",
    );
  }
  const environment =
    thread.environmentId === null
      ? null
      : getEnvironment(deps.db, thread.environmentId);
  const providerEnv =
    environment === null || args.reattachOnly
      ? []
      : await resolvePluginProviderEnv({
          providerId: thread.providerId,
          context: {
            threadId: thread.id,
            projectId: thread.projectId,
            hostId: environment.hostId,
            experimental_runtimeKind: "native",
          },
        });
  if (args.reattachOnly) {
    const currentThread = getThread(deps.db, args.threadId);
    const currentRecord = getNativeTerminalThread(deps.db, args.threadId);
    const currentTerminal =
      currentRecord === null ? null : readRecordTerminal(deps, currentRecord);
    if (
      currentThread === null ||
      currentThread.archivedAt !== null ||
      currentThread.deletedAt !== null ||
      (currentTerminal?.status !== "disconnected" &&
        !(
          currentTerminal?.status === "exited" &&
          (currentTerminal.closeReason === "daemon-disconnect" ||
            currentTerminal.closeReason === "thread-archived")
        ))
    ) {
      throw new ApiError(
        409,
        "native_terminal_reconnect_stale",
        "The native terminal is no longer eligible for reconnect",
      );
    }
  }
  const credential = issueNativeTerminalToolCredential(record.providerId);
  const previousCredential = getNativeTerminalToolCredential(
    deps.db,
    thread.id,
  );
  beginNativeTerminalRebind(thread.id);
  try {
    deleteNativeTerminalToolCredential(deps.db, thread.id);
    clearNativeTerminalThreadEvidence(deps.db, thread.id);
    const terminal = await deps.terminalSessions
      .createTerminal({
        ...(args.repaintOnAttach
          ? {
              onTerminalStarted: (terminalId: string) =>
                deps.terminalSessions.requestNativeTerminalRepaintOnNextAttach(
                  terminalId,
                ),
            }
          : {}),
        payload: {
          cols: args.request.cols ?? NATIVE_TERMINAL_DEFAULT_COLS,
          rows: args.request.rows ?? NATIVE_TERMINAL_DEFAULT_ROWS,
          start: {
            mode: "command",
            command: nativeTerminalLaunchCommand({
              executable: provider.cli.executable,
              launchArgs: provider.cli.launchArgs,
              reattachOnly: args.reattachOnly,
              threadId: thread.id,
            }),
          },
          target: { kind: "thread", threadId: thread.id },
          title: provider.displayName,
        },
        extraContributedEnv: [...providerEnv, credential.env],
      })
      .catch((error: unknown) => {
        if (
          previousCredential !== null &&
          getNativeTerminalToolCredential(deps.db, thread.id) === null
        ) {
          setNativeTerminalToolCredential(deps.db, previousCredential);
        }
        throw error;
      });
    setNativeTerminalToolCredential(deps.db, {
      threadId: thread.id,
      terminalSessionId: terminal.id,
      credentialHash: credential.hash,
    });
    setNativeTerminalThreadTerminal(deps.db, {
      threadId: thread.id,
      terminalSessionId: terminal.id,
    });
    interruptNativeTerminalQuestions(deps, thread.id);
    forgetRejectedNativeQuestions(deps, thread.id);
    return toNativeTerminalThread(deps, record, terminal);
  } finally {
    endNativeTerminalRebind(thread.id);
  }
}

export async function settlePendingNativeTerminalOpen(
  threadId: string,
): Promise<void> {
  await pendingOpens.get(threadId)?.promise.catch(() => undefined);
}

export function openNativeTerminal(
  deps: NativeTerminalDeps,
  args: { threadId: string; request: OpenNativeTerminalRequest },
): Promise<NativeTerminalThread> {
  bumpReattachEpoch(args.threadId);
  return openNativeTerminalDeduplicated(deps, { ...args, reattachOnly: false });
}

function openNativeTerminalDeduplicated(
  deps: NativeTerminalDeps,
  args: {
    reattachOnly: boolean;
    repaintOnAttach?: boolean;
    threadId: string;
    request: OpenNativeTerminalRequest;
  },
): Promise<NativeTerminalThread> {
  const pending = pendingOpens.get(args.threadId);
  if (pending !== undefined && (args.reattachOnly || !pending.reattachOnly)) {
    return pending.promise;
  }
  const opening: Promise<NativeTerminalThread> = (
    pending === undefined
      ? openNativeTerminalOnce(deps, { ...args, replaceLiveTerminal: false })
      : pending.promise
          .then(
            () => undefined,
            () => undefined,
          )
          .then(() =>
            openNativeTerminalOnce(deps, {
              ...args,
              replaceLiveTerminal: true,
            }),
          )
  ).finally(() => {
    if (pendingOpens.get(args.threadId)?.promise === opening) {
      pendingOpens.delete(args.threadId);
    }
  });
  pendingOpens.set(args.threadId, {
    promise: opening,
    reattachOnly: args.reattachOnly,
  });
  return opening;
}

export async function openNativeTerminalAfterProvisioning(
  deps: NativeTerminalDeps,
  threadId: string,
): Promise<void> {
  if (getNativeTerminalThread(deps.db, threadId) === null) return;
  try {
    await openNativeTerminal(deps, { threadId, request: {} });
  } catch (error) {
    deps.logger.warn(
      { err: error, threadId },
      "Failed to open native terminal after provisioning",
    );
  }
}

export function listNativeTerminalThreadsAwaitingDaemon(
  deps: Pick<AppDeps, "db">,
  hostId: string,
): string[] {
  return listNativeTerminalThreadsWithDisconnectedTerminal(deps.db, hostId);
}

function reattachTerminalExitedOnItsOwn(
  deps: Pick<AppDeps, "db">,
  args: { since: number; threadId: string },
): boolean {
  const newest = listTerminalSessions(deps.db, {
    scope: { kind: "thread", threadId: args.threadId },
    visible: false,
  })
    .filter((terminal) => terminal.createdAt >= args.since)
    .at(-1);
  return (
    newest !== undefined &&
    newest.status === "exited" &&
    newest.closeReason === "process-exit"
  );
}

export function reopenErrorProvesHolderGone(
  deps: Pick<AppDeps, "db">,
  args: { error: unknown; since: number; threadId: string },
): boolean {
  return (
    args.error instanceof ApiError &&
    args.error.body.code === "terminal_open_cancelled" &&
    reattachTerminalExitedOnItsOwn(deps, args)
  );
}

const REOPEN_NO_LONGER_WANTED_ERROR_CODES: ReadonlySet<string> = new Set([
  "native_terminal_reconnect_stale",
  "native_terminal_thread_not_found",
  "thread_archived",
  "thread_not_found",
]);

function reopenErrorMeansNoLongerWanted(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    REOPEN_NO_LONGER_WANTED_ERROR_CODES.has(error.body.code)
  );
}

function interruptThreadWhoseHolderIsGone(
  deps: NativeTerminalReopenDeps,
  args: { hostId: string; threadId: string },
): void {
  deps.logger.info(
    { hostId: args.hostId, threadId: args.threadId },
    "Interrupting a native terminal thread whose CLI could not be reattached",
  );
  interruptActiveThreadsForHost(deps, {
    hostId: args.hostId,
    includeStopping: false,
    onlyThreadIds: new Set([args.threadId]),
    reason: "host-daemon-restarted",
  });
}

function isClosedDatabaseConnectionError(error: unknown): boolean {
  return (
    error instanceof TypeError &&
    error.message === "The database connection is not open"
  );
}

function watchReattachedTerminal(
  deps: NativeTerminalReopenDeps,
  args: { hostId: string; terminalId: string; threadId: string },
): void {
  const deadline = Date.now() + NATIVE_REATTACH_SETTLE_MS;
  const check = () => {
    const record = getNativeTerminalThread(deps.db, args.threadId);
    if (record === null || record.terminalSessionId !== args.terminalId) {
      return;
    }
    const terminal = readRecordTerminal(deps, record);
    if (terminal !== null && terminal.status === "exited") {
      if (terminal.closeReason === "process-exit") {
        interruptThreadWhoseHolderIsGone(deps, args);
      }
      return;
    }
    if (Date.now() >= deadline) return;
    setTimeout(check, NATIVE_REATTACH_POLL_MS).unref();
  };
  setTimeout(check, NATIVE_REATTACH_POLL_MS).unref();
}

function reopenNativeTerminals(
  deps: NativeTerminalReopenDeps,
  args: { hostId: string; threadIds: readonly string[] },
  reason: "daemon-reconnect" | "thread-unarchived",
  monotonicNowMs: () => number = () => performance.now(),
): Promise<void> {
  return Promise.all(
    args.threadIds.map(async (threadId) => {
      const attempt = bumpReattachEpoch(threadId);
      const startedAt = Date.now();
      let lateTerminalBeingDiscarded: string | null = null;
      const stillWaiting = () => {
        if (currentReattachEpoch(threadId) !== attempt) return false;
        const current = getNativeTerminalThread(deps.db, threadId);
        if (current === null) return false;
        if (current.terminalSessionId === lateTerminalBeingDiscarded)
          return true;
        const terminal = readRecordTerminal(deps, current);
        return (
          terminal === null || !isActiveTerminalSessionStatus(terminal.status)
        );
      };
      const deadlineAt = monotonicNowMs() + NATIVE_REATTACH_DEADLINE_MS;
      let expired = false;
      let interrupted = false;
      let interruptAttempts = 0;
      let interrupting: Promise<void> | null = null;
      let leaveToDeadline = false;
      const pastDeadline = () => expired || monotonicNowMs() >= deadlineAt;
      const interruptOnce = async () => {
        if (interrupted) return;
        if (interrupting !== null) return interrupting;
        interrupting = (async () => {
          while (!interrupted && interruptAttempts < 3) {
            if (!stillWaiting()) {
              deps.logger.debug(
                {
                  attempts: interruptAttempts,
                  hostId: args.hostId,
                  threadId,
                },
                "Stopping native terminal interrupt retries after reattach recovery",
              );
              return;
            }
            interruptAttempts += 1;
            try {
              interruptThreadWhoseHolderIsGone(deps, {
                hostId: args.hostId,
                threadId,
              });
              interrupted = true;
            } catch (error: unknown) {
              if (isClosedDatabaseConnectionError(error)) return;
              if (interruptAttempts === 3) {
                deps.logger.error(
                  {
                    attempts: interruptAttempts,
                    err: error,
                    hostId: args.hostId,
                    threadId,
                  },
                  "Failed to interrupt a native terminal thread after retries",
                );
                return;
              }
              deps.logger.warn(
                {
                  attempt: interruptAttempts,
                  err: error,
                  hostId: args.hostId,
                  threadId,
                },
                "Retrying a failed native terminal thread interrupt",
              );
              await new Promise<void>((resolve) => {
                setTimeout(resolve, 25);
              });
            }
          }
        })();
        try {
          await interrupting;
        } finally {
          interrupting = null;
        }
      };
      const shouldStop = async () => {
        if (pastDeadline()) {
          if (stillWaiting()) await interruptOnce();
          return true;
        }
        return !stillWaiting();
      };
      const deadline = setTimeout(() => {
        expired = true;
        void (async () => {
          try {
            if (stillWaiting()) await interruptOnce();
          } catch (error: unknown) {
            if (isClosedDatabaseConnectionError(error)) return;
            deps.logger.warn(
              { err: error, hostId: args.hostId, threadId },
              "Failed to check the native terminal reattach deadline",
            );
          }
        })();
      }, NATIVE_REATTACH_DEADLINE_MS);
      deadline.unref();
      try {
        const record = getNativeTerminalThread(deps.db, threadId);
        if (record === null) return;
        await deps.providerRegistry.whenProviderRegistered(record.providerId);
        if (deps.providerRegistry.get(record.providerId) === null) {
          await new Promise<void>((resolve) => {
            const unsubscribe = deps.providerRegistry.onProviderRegistered(
              record.providerId,
              () => {
                unsubscribe();
                resolve();
              },
            );
          });
        }
        const thread = getThread(deps.db, threadId);
        const currentRecord = getNativeTerminalThread(deps.db, threadId);
        const currentTerminal =
          currentRecord === null
            ? null
            : readRecordTerminal(deps, currentRecord);
        if (
          thread === null ||
          thread.archivedAt !== null ||
          thread.deletedAt !== null ||
          (reason === "thread-unarchived"
            ? currentTerminal?.status !== "exited" ||
              currentTerminal.closeReason !== "thread-archived"
            : currentTerminal?.status !== "disconnected" &&
              !(
                currentTerminal?.status === "exited" &&
                (currentTerminal.closeReason === "daemon-disconnect" ||
                  currentTerminal.closeReason === "thread-archived")
              ))
        ) {
          return;
        }
        if (await shouldStop()) return;
        let reopened: NativeTerminalThread;
        for (;;) {
          if (await shouldStop()) return;
          try {
            const exitedAfterArchive =
              currentTerminal?.status === "exited" &&
              currentTerminal.closeReason === "thread-archived";
            const sharedSize =
              currentRecord?.terminalSessionId === null ||
              currentRecord?.terminalSessionId === undefined
                ? null
                : deps.terminalSessions.sharedBrowserTerminalSize(
                    currentRecord.terminalSessionId,
                  );
            reopened = await openNativeTerminalDeduplicated(deps, {
              repaintOnAttach: sharedSize !== null,
              reattachOnly:
                reason === "daemon-reconnect" && !exitedAfterArchive,
              threadId,
              request: sharedSize ?? {},
            });
            break;
          } catch (error: unknown) {
            if (
              reopenErrorProvesHolderGone(deps, {
                error,
                since: startedAt,
                threadId,
              }) ||
              reopenErrorMeansNoLongerWanted(error) ||
              pastDeadline() ||
              !stillWaiting()
            ) {
              throw error;
            }
            deps.logger.warn(
              { err: error, hostId: args.hostId, threadId },
              "Retrying the native terminal reattach after a transient failure",
            );
            await new Promise<void>((resolve) => {
              setTimeout(resolve, NATIVE_REATTACH_RETRY_MS).unref();
            });
          }
        }
        if (pastDeadline()) {
          deps.logger.info(
            {
              hostId: args.hostId,
              terminalId: reopened.terminal?.id,
              threadId,
            },
            "Discarding a native terminal reattach that finished after its deadline",
          );
          if (reopened.terminal !== null) {
            const isCurrentTerminal =
              getNativeTerminalThread(deps.db, threadId)?.terminalSessionId ===
              reopened.terminal.id;
            const belongsToCurrentReattach =
              isCurrentTerminal && currentReattachEpoch(threadId) === attempt;
            if (belongsToCurrentReattach) {
              lateTerminalBeingDiscarded = reopened.terminal.id;
              await interruptOnce();
            }
            const stillCurrentTerminal =
              getNativeTerminalThread(deps.db, threadId)?.terminalSessionId ===
              reopened.terminal.id;
            if (
              !stillCurrentTerminal ||
              currentReattachEpoch(threadId) === attempt
            ) {
              await deps.terminalSessions
                .closeTerminal({
                  terminalId: reopened.terminal.id,
                  payload: { mode: "force", reason: "user" },
                })
                .catch((error: unknown) => {
                  deps.logger.warn(
                    { err: error, hostId: args.hostId, threadId },
                    "Failed to close a late native terminal reattach",
                  );
                });
            }
          }
          return;
        }
        deps.logger.info(
          { hostId: args.hostId, terminalId: reopened.terminal?.id, threadId },
          "Reopened native terminal session",
        );
        if (reopened.terminal !== null) {
          watchReattachedTerminal(deps, {
            hostId: args.hostId,
            terminalId: reopened.terminal.id,
            threadId,
          });
        }
      } catch (error: unknown) {
        deps.logger.warn(
          { err: error, hostId: args.hostId, threadId },
          "Failed to reopen native terminal session",
        );
        if (
          !reopenErrorProvesHolderGone(deps, {
            error,
            since: startedAt,
            threadId,
          })
        ) {
          if (pastDeadline()) {
            if (stillWaiting()) await interruptOnce();
          } else {
            leaveToDeadline = true;
          }
        } else if (stillWaiting()) {
          await interruptOnce();
        }
      } finally {
        if (!leaveToDeadline) clearTimeout(deadline);
      }
    }),
  ).then(() => undefined);
}

export function reopenNativeTerminalsAfterDaemonReconnect(
  deps: NativeTerminalReopenDeps,
  args: { hostId: string; threadIds: readonly string[] },
  monotonicNowMs: () => number = () => performance.now(),
): Promise<void> {
  return reopenNativeTerminals(deps, args, "daemon-reconnect", monotonicNowMs);
}

export async function resumeNativeTerminalAfterUnarchive(
  deps: NativeTerminalReopenDeps,
  args: { threadId: string },
): Promise<void> {
  const record = getNativeTerminalThread(deps.db, args.threadId);
  const terminal = record === null ? null : readRecordTerminal(deps, record);
  if (
    record === null ||
    terminal?.status !== "exited" ||
    terminal.closeReason !== "thread-archived"
  ) {
    return Promise.resolve();
  }
  return reopenNativeTerminals(
    deps,
    { hostId: terminal.hostId, threadIds: [args.threadId] },
    "thread-unarchived",
  );
}

function launchInputWithImagesInPrompt(input: {
  initialPrompt: string | null;
  initialImages: string[];
}): { initialPrompt: string | null; initialImages: string[] } {
  const parts = [
    ...input.initialImages,
    ...(input.initialPrompt === null ? [] : [input.initialPrompt]),
  ];
  return {
    initialPrompt: parts.length === 0 ? null : parts.join("\n"),
    initialImages: [],
  };
}

export function takeNativeTerminalLaunchSpec(
  deps: Pick<AppDeps, "db" | "providerRegistry">,
  args: { imagesAsArgv: boolean; threadId: string },
): NativeTerminalLaunchSpec {
  const record = requireNativeTerminalThreadRecord(deps, args.threadId);
  const provider = requireNativeTerminalProvider(deps, record.providerId);
  const input = consumeNativeTerminalThreadLaunchInput(deps.db, args.threadId);
  return {
    threadId: record.threadId,
    cli: provider.cli,
    nativeSessionId: record.nativeSessionId,
    ...(args.imagesAsArgv ? input : launchInputWithImagesInPrompt(input)),
    model: record.model,
  };
}

const TOOL_CREDENTIAL_BYTES = 32;

function hashToolCredential(credential: string): Buffer {
  return createHash("sha256").update(credential).digest();
}

export const NATIVE_TOOL_CREDENTIAL_ENV = "BB_NATIVE_TOOL_CREDENTIAL";

function issueNativeTerminalToolCredential(providerId: string) {
  const secret = randomBytes(TOOL_CREDENTIAL_BYTES).toString("base64url");
  return {
    secret,
    hash: hashToolCredential(secret).toString("hex"),
    env: {
      name: NATIVE_TOOL_CREDENTIAL_ENV,
      value: secret,
      source: { plugin: providerId },
      reason: "Credential for this native terminal's bb tools",
    },
  };
}

export function requireNativeTerminalToolCredential(
  deps: Pick<AppDeps, "db" | "terminalSessions">,
  args: { authorization: string | undefined; threadId: string },
): { terminalSessionId: string } {
  const record = getNativeTerminalThread(deps.db, args.threadId);
  const match = /^Bearer ([A-Za-z0-9_-]+)$/u.exec(args.authorization ?? "");
  const stored = getNativeTerminalToolCredential(deps.db, args.threadId);
  const supplied = hashToolCredential(match?.[1] ?? "");
  const expected = Buffer.from(stored?.credentialHash ?? "", "hex");
  const valid =
    match !== null &&
    stored !== null &&
    record !== null &&
    expected.length === supplied.length &&
    timingSafeEqual(expected, supplied) &&
    stored.terminalSessionId === record.terminalSessionId;
  if (!valid) {
    throw new ApiError(
      401,
      "native_terminal_credential_invalid",
      "A valid credential for this thread's current native terminal is required",
    );
  }
  return { terminalSessionId: stored.terminalSessionId };
}

export function requireLiveNativeTerminalToolThread(
  deps: Pick<AppDeps, "db" | "terminalSessions">,
  threadId: string,
): ThreadEnvironmentLookupResult {
  const record = requireNativeTerminalThreadRecord(deps, threadId);
  const lookup = requirePublicThreadEnvironment(deps.db, threadId);
  if (lookup.thread.archivedAt !== null) {
    throw new ApiError(
      409,
      "native_terminal_not_live",
      "This thread is archived",
    );
  }
  const terminal = readRecordTerminal(deps, record);
  if (terminal === null || terminal.status === "exited") {
    throw new ApiError(
      409,
      "native_terminal_not_live",
      "This thread's native terminal is not running",
    );
  }
  return lookup;
}

export function nativeTerminalAwaitsReattach(
  deps: Pick<AppDeps, "db" | "terminalSessions">,
  threadId: string,
): boolean {
  const thread = getThread(deps.db, threadId);
  const record = getNativeTerminalThread(deps.db, threadId);
  if (
    thread === null ||
    thread.archivedAt !== null ||
    thread.deletedAt !== null ||
    record === null
  ) {
    return false;
  }
  const terminal = readRecordTerminal(deps, record);
  return (
    terminal !== null &&
    (terminal.status === "disconnected" ||
      (terminal.status === "exited" &&
        terminal.closeReason === "daemon-disconnect"))
  );
}

export async function resolveNativeTerminalAgentTools(
  deps: AppDeps,
  args: { authorization: string | undefined; threadId: string },
): Promise<
  ThreadEnvironmentLookupResult & {
    terminalSessionId: string;
    tools: NativeTerminalAgentTools["tools"];
  }
> {
  const { threadId } = args;
  const { terminalSessionId } = requireNativeTerminalToolCredential(deps, args);
  const lookup = requireLiveNativeTerminalToolThread(deps, threadId);
  const record = requireNativeTerminalThreadRecord(deps, threadId);
  const tools = await resolveThreadDynamicTools(deps, {
    environment: lookup.environment,
    model: record.model ?? "",
    thread: lookup.thread,
  });
  return {
    ...lookup,
    terminalSessionId,
    tools: tools.filter(
      (tool) => tool.name !== UPDATE_ENVIRONMENT_DIRECTORY_TOOL_NAME,
    ),
  };
}

export async function listNativeTerminalAgentTools(
  deps: AppDeps,
  args: { authorization: string | undefined; threadId: string },
): Promise<NativeTerminalAgentTools> {
  const { tools } = await resolveNativeTerminalAgentTools(deps, args);
  return { tools };
}

export async function requireNativeTerminalAgentToolCall(
  deps: AppDeps,
  args: { authorization: string | undefined; threadId: string; tool: string },
): Promise<ThreadEnvironmentLookupResult & { terminalSessionId: string }> {
  const { environment, terminalSessionId, thread, tools } =
    await resolveNativeTerminalAgentTools(deps, args);
  if (!tools.some((tool) => tool.name === args.tool)) {
    throw new ApiError(
      404,
      "native_terminal_tool_not_found",
      `Tool ${args.tool} is not available to this thread`,
    );
  }
  return { environment, terminalSessionId, thread };
}

export function recordNativeTerminalSession(
  deps: NativeTerminalViewDeps,
  args: {
    authorization?: string;
    threadId: string;
    nativeSessionId: string;
    replacesNativeSessionId?: string;
  },
): NativeTerminalThread {
  requireNativeTerminalThreadRecord(deps, args.threadId);
  requireNativeTerminalToolCredential(deps, {
    authorization: args.authorization,
    threadId: args.threadId,
  });
  requireLiveNativeTerminalToolThread(deps, args.threadId);
  const result = recordNativeTerminalThreadSessionId(deps.db, args);
  switch (result.kind) {
    case "recorded":
    case "unchanged":
      break;
    case "already-bound": {
      if (args.replacesNativeSessionId === undefined) {
        throw new ApiError(
          409,
          "native_session_already_bound",
          `Thread is already bound to native session ${result.nativeSessionId}`,
        );
      }
      const rebound = rebindNativeTerminalThreadSessionId(deps.db, {
        nativeSessionId: args.nativeSessionId,
        replacesNativeSessionId: args.replacesNativeSessionId,
        threadId: args.threadId,
      });
      if (rebound.kind === "claimed-by-other-thread") {
        throw new ApiError(
          409,
          "native_session_claimed",
          `Native session belongs to thread ${rebound.threadId}`,
        );
      }
      if (rebound.kind === "stale") {
        throw new ApiError(
          409,
          "native_session_rebind_stale",
          "The thread's native session changed since this move was requested",
        );
      }
      break;
    }
    case "claimed-by-other-thread":
      throw new ApiError(
        409,
        "native_session_claimed",
        `Native session belongs to thread ${result.threadId}`,
      );
  }
  return getNativeTerminalThreadView(deps, args.threadId);
}

export function sendNativeTerminalMessage(
  deps: NativeTerminalDeps,
  args: { threadId: string; pastes: readonly string[] },
): Promise<TerminalSession> {
  const previous = pendingSends.get(args.threadId) ?? Promise.resolve();
  const sending = previous.then(() => deliverNativeTerminalMessage(deps, args));
  const settled = sending.then(
    () => undefined,
    () => undefined,
  );
  pendingSends.set(args.threadId, settled);
  void settled.then(() => {
    if (pendingSends.get(args.threadId) === settled) {
      pendingSends.delete(args.threadId);
    }
  });
  return sending;
}

function nativeTerminalNotRunning(): ApiError {
  return new ApiError(
    409,
    "native_terminal_not_running",
    "The native session is not running; open it before sending a message",
  );
}

function nativeTerminalInputAmbiguous(
  provider: NativeTerminalProvider,
  pastedBefore: number,
): ApiError {
  return new ApiError(
    409,
    "native_terminal_input_ambiguous",
    pastedBefore === 0
      ? `${provider.displayName} already shows this text, so an echo of it could not be told apart from what is on screen, and nothing was sent. Type the message in the terminal, or reword it.`
      : `${provider.displayName} began showing this text while the message was being pasted, so an echo of it could not be told apart from what is on screen, and the message was not submitted. What was pasted before it is still in the input box: clear the input box in the terminal, then send again.`,
  );
}

async function deliverNativeTerminalMessage(
  deps: NativeTerminalDeps,
  args: { threadId: string; pastes: readonly string[] },
): Promise<TerminalSession> {
  const view = getNativeTerminalThreadView(deps, args.threadId);
  if (view.terminal === null || view.terminal.status !== "running") {
    throw nativeTerminalNotRunning();
  }
  const terminalId = view.terminal.id;
  const provider = requireNativeTerminalProvider(deps, view.providerId);
  const before = await deps.terminalSessions.readTerminalOutput({
    terminalId,
    query: { tailBytes: NATIVE_TERMINAL_ECHO_CONTEXT_BYTES },
  });
  if (before.status !== "running") throw nativeTerminalNotRunning();
  const shown = decodeTerminalOutputChunks(before.chunks);
  for (const text of args.pastes) {
    if (
      terminalScreenAlreadyShowsText({
        output: shown,
        screenRows: view.terminal.rows,
        text,
      })
    ) {
      throw nativeTerminalInputAmbiguous(provider, 0);
    }
  }
  for (const [pastedBefore, text] of args.pastes.entries()) {
    await pasteIntoNativeTerminal(deps, {
      pastedBefore,
      provider,
      screenRows: view.terminal.rows,
      terminalId,
      text,
    });
  }
  return deps.terminalSessions.sendTerminalInput({
    terminalId,
    payload: { dataBase64: Buffer.from("\r", "utf8").toString("base64") },
  });
}

async function pasteIntoNativeTerminal(
  deps: NativeTerminalDeps,
  args: {
    pastedBefore: number;
    provider: NativeTerminalProvider;
    screenRows: number;
    terminalId: string;
    text: string;
  },
): Promise<void> {
  const { provider, terminalId } = args;
  const before = await deps.terminalSessions.readTerminalOutput({
    terminalId,
    query: { tailBytes: NATIVE_TERMINAL_ECHO_CONTEXT_BYTES },
  });
  if (before.status !== "running") throw nativeTerminalNotRunning();
  const shown = decodeTerminalOutputChunks(before.chunks);
  if (
    terminalScreenAlreadyShowsText({
      output: shown,
      screenRows: args.screenRows,
      text: args.text,
    })
  ) {
    throw nativeTerminalInputAmbiguous(provider, args.pastedBefore);
  }
  const showsPaste = terminalOutputAlreadyShowsText({
    output: shown,
    text: args.text,
  })
    ? terminalOutputShowsPasteAgain
    : terminalOutputShowsPaste;
  const bracketed = `\u001b[200~${args.text}\u001b[201~`;
  deps.terminalSessions.sendTerminalInput({
    terminalId,
    payload: { dataBase64: Buffer.from(bracketed, "utf8").toString("base64") },
  });
  const deadline = Date.now() + NATIVE_TERMINAL_ECHO_TIMEOUT_MS;
  for (;;) {
    await new Promise((resolve) =>
      setTimeout(resolve, NATIVE_TERMINAL_ECHO_POLL_MS),
    );
    const after = await deps.terminalSessions.readTerminalOutput({
      terminalId,
      query: { sinceSeq: before.nextSeq },
    });
    if (after.status !== "running") throw nativeTerminalNotRunning();
    if (
      showsPaste({
        before: shown,
        output: decodeTerminalOutputChunks(after.chunks),
        pastePlaceholders: provider.cli.pastePlaceholders,
        text: args.text,
      })
    ) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new ApiError(
        409,
        "native_terminal_input_not_shown",
        `${provider.displayName} did not show the message in its input box, so it was not submitted. A menu or dialog is probably open; answer it in the terminal, then send again. If the message is in the input box, press Enter there.`,
      );
    }
  }
}
