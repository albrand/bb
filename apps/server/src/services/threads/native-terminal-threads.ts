import {
  consumeNativeTerminalThreadInitialPrompt,
  getEnvironment,
  getNativeTerminalThread,
  recordNativeTerminalThreadSessionId,
  setNativeTerminalThreadTerminal,
  type NativeTerminalThreadRecord,
  type getThread,
} from "@bb/db";
import {
  isActiveTerminalSessionStatus,
  type PromptInput,
  type ProviderNativeTerminal,
} from "@bb/domain";
import type {
  NativeTerminalLaunchSpec,
  NativeTerminalThread,
  OpenNativeTerminalRequest,
  TerminalSession,
} from "@bb/server-contract";
import { ApiError } from "../../errors.js";
import type { AppDeps } from "../../types.js";
import { requirePublicThread } from "../lib/entity-lookup.js";
import { resolvePluginProviderEnv } from "../plugins/plugin-agent-contributions.js";
import { applyLoggedThreadLifecycleEventInTransaction } from "./lifecycle-outcome.js";
import { createClientTurnRequestId } from "./thread-events.js";
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
  "config" | "db" | "logger" | "providerRegistry" | "terminalSessions"
>;

type NativeTerminalViewDeps = Pick<
  AppDeps,
  "db" | "providerRegistry" | "terminalSessions"
>;

const pendingOpens = new Map<string, Promise<NativeTerminalThread>>();

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

export function nativeTerminalInitialPrompt(
  input: readonly PromptInput[],
): string | null {
  const parts: string[] = [];
  for (const entry of input) {
    if (entry.type !== "text") {
      throw new ApiError(
        400,
        "invalid_request",
        "Native terminal threads accept text prompts only",
      );
    }
    parts.push(entry.text);
  }
  const prompt = parts.join("\n\n").trim();
  return prompt.length === 0 ? null : prompt;
}

export function nativeTerminalLaunchCommand(args: {
  executable: string;
  threadId: string;
}): string {
  const executable = args.executable;
  const env = `BB_THREAD_ID=${args.threadId}`;
  const wrapper = `"$BB_CLI" thread native-run ${args.threadId}`;
  return [
    `if [ -n "$BB_CLI" ] && ${wrapper} --probe >/dev/null 2>&1; then`,
    `${env} exec ${wrapper};`,
    `else ${env} exec ${executable}; fi`,
  ].join(" ");
}

export function beginNativeTerminalThreadProvisioning(
  deps: ThreadProvisioningDeps & Pick<AppDeps, "config" | "logger">,
  args: {
    environmentIntent: ThreadProvisionEnvironmentIntent;
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
          input: [],
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
      "Thread is not a native terminal thread",
    );
  }
  return record;
}

function readRecordTerminal(
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

function toNativeTerminalThread(
  deps: Pick<AppDeps, "providerRegistry" | "terminalSessions">,
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
  args: { threadId: string; request: OpenNativeTerminalRequest },
): Promise<NativeTerminalThread> {
  const record = requireNativeTerminalThreadRecord(deps, args.threadId);
  const existing = readRecordTerminal(deps, record);
  if (terminalIsLive(existing)) {
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
    environment === null
      ? []
      : await resolvePluginProviderEnv({
          providerId: thread.providerId,
          context: {
            threadId: thread.id,
            projectId: thread.projectId,
            hostId: environment.hostId,
          },
        });
  const terminal = await deps.terminalSessions.createTerminal({
    payload: {
      cols: args.request.cols ?? NATIVE_TERMINAL_DEFAULT_COLS,
      rows: args.request.rows ?? NATIVE_TERMINAL_DEFAULT_ROWS,
      start: {
        mode: "command",
        command: nativeTerminalLaunchCommand({
          executable: provider.cli.executable,
          threadId: thread.id,
        }),
      },
      target: { kind: "thread", threadId: thread.id },
      title: provider.displayName,
    },
    extraContributedEnv: providerEnv,
  });
  setNativeTerminalThreadTerminal(deps.db, {
    threadId: thread.id,
    terminalSessionId: terminal.id,
  });
  return toNativeTerminalThread(deps, record, terminal);
}

export function openNativeTerminal(
  deps: NativeTerminalDeps,
  args: { threadId: string; request: OpenNativeTerminalRequest },
): Promise<NativeTerminalThread> {
  const pending = pendingOpens.get(args.threadId);
  if (pending !== undefined) return pending;
  const opening = openNativeTerminalOnce(deps, args).finally(() => {
    pendingOpens.delete(args.threadId);
  });
  pendingOpens.set(args.threadId, opening);
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

export function takeNativeTerminalLaunchSpec(
  deps: Pick<AppDeps, "db" | "providerRegistry">,
  threadId: string,
): NativeTerminalLaunchSpec {
  const record = requireNativeTerminalThreadRecord(deps, threadId);
  const provider = requireNativeTerminalProvider(deps, record.providerId);
  return {
    threadId: record.threadId,
    cli: provider.cli,
    nativeSessionId: record.nativeSessionId,
    initialPrompt: consumeNativeTerminalThreadInitialPrompt(deps.db, threadId),
    model: record.model,
  };
}

export function recordNativeTerminalSession(
  deps: NativeTerminalViewDeps,
  args: { threadId: string; nativeSessionId: string },
): NativeTerminalThread {
  requireNativeTerminalThreadRecord(deps, args.threadId);
  const result = recordNativeTerminalThreadSessionId(deps.db, args);
  switch (result.kind) {
    case "recorded":
    case "unchanged":
      break;
    case "already-bound":
      throw new ApiError(
        409,
        "native_session_already_bound",
        `Thread is already bound to native session ${result.nativeSessionId}`,
      );
    case "claimed-by-other-thread":
      throw new ApiError(
        409,
        "native_session_claimed",
        `Native session belongs to thread ${result.threadId}`,
      );
  }
  return getNativeTerminalThreadView(deps, args.threadId);
}

export async function sendNativeTerminalMessage(
  deps: NativeTerminalDeps,
  args: { threadId: string; text: string },
): Promise<TerminalSession> {
  const view = getNativeTerminalThreadView(deps, args.threadId);
  if (view.terminal === null || view.terminal.status !== "running") {
    throw new ApiError(
      409,
      "native_terminal_not_running",
      "The native session is not running; open it before sending a message",
    );
  }
  const bracketed = `\u001b[200~${args.text}\u001b[201~`;
  deps.terminalSessions.sendTerminalInput({
    terminalId: view.terminal.id,
    payload: { dataBase64: Buffer.from(bracketed, "utf8").toString("base64") },
  });
  await new Promise((resolve) => setTimeout(resolve, 150));
  return deps.terminalSessions.sendTerminalInput({
    terminalId: view.terminal.id,
    payload: { dataBase64: Buffer.from("\r", "utf8").toString("base64") },
  });
}
