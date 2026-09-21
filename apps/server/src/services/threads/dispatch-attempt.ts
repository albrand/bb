import { requestQueuedMachineReadiness } from "./queued-message-dispatch.js";
import {
  cancelPreparingMachinePause,
  isMachineWaitingForExecution,
} from "../machines/lifecycle.js";
import {
  deleteClaimedQueuedThreadMessageBatchInTransaction,
  getEnvironment,
  getThread,
  isThreadQueueAutoSendPaused,
  listRunningThreads,
  type ClaimedQueuedThreadMessageRow,
  type RunningThreadRow,
} from "@bb/db";
import {
  promptInputSchema,
  type PromptInput,
  type QueuedMessagePayload,
  type QueuedMessageWaitingOn,
  type ResolvedThreadExecutionOptions,
  startedOnBehalfOfSchema,
  type StartedOnBehalfOf,
  type Thread,
  type ThreadCreateOrigin,
  type ThreadQueuedMessage,
} from "@bb/domain";
import type { SendMessageRequest } from "@bb/server-contract";
import type { PluginDispatchEnvironmentIntent } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { ApiError } from "../../errors.js";
import type { LoggedPendingInteractionWorkSessionDeps } from "../../types.js";
import { requirePublicProject } from "../lib/entity-lookup.js";
import {
  goneThreadEnvironmentDetails,
  throwThreadNotWritable,
} from "../lib/lifecycle-api-errors.js";
import { validatePromptAttachmentReferences } from "../projects/attachments.js";
import {
  dispatchEnvironmentAndHost,
  dispatchExecutionSources,
  dispatchWaitReasonForPass,
  hasMessageDispatchHooks,
  noteDispatchRequeued,
  runMessageDispatchHookPass,
  type DispatchAttemptKind,
} from "./dispatch-hooks.js";
import {
  createQueuedMessageAutoSendPausedError,
  createQueuedMessageClaimLostError,
  recordQueuedMessageWait,
  settleQueueRowDispatched,
  type QueuedDispatchMessage,
} from "./queue-waits.js";
import { applyLoggedThreadLifecycleEventInTransaction } from "./lifecycle-outcome.js";
import { buildExecutionOptions } from "./thread-commands.js";
import { getActiveTurnId, isManualCompactionActive } from "./thread-events.js";
import { requireThreadCommandEnvironment } from "./thread-command-environment.js";
import {
  requestThreadProvision,
  scheduleThreadProvisioningAdvance,
} from "./thread-provisioning.js";
import {
  threadForkDescriptorSchema,
  threadProvisionEnvironmentIntentSchema,
} from "./thread-startup-store.js";
import {
  readThreadProvisionContext,
  readThreadStartupContextOfKind,
} from "./thread-startup-store.js";
import {
  buildThreadStatusChangeMetadata,
  toThreadResponseFromThread,
} from "./thread-runtime-display.js";
import { toThreadQueuedMessage } from "./thread-queued-messages.js";
import { isPreStartThreadStatus } from "./thread-status.js";
import {
  claimWorkspaceForTurn,
  releaseWorkspaceForThread,
} from "./workspace-write-serialization.js";
import {
  listSharedWorkspaceActiveThreadIds,
  SHARED_WORKSPACE_ISOLATION_INSTRUCTION,
} from "./workspace-awareness.js";
import { queueInputForStartingTurn } from "./thread-turn-starting.js";
import {
  ensureThreadIsWritable,
  resolveMessageSenderThreadId,
  sendThreadMessage,
  type SendThreadMessageTransactionPreflight,
  type ThreadSendRefusal,
} from "./thread-send.js";
import { resolveDispatchAuthor } from "./dispatch-author.js";
import type { TurnRequestRetryMarker } from "./thread-events.js";
import { restoreInterruptedThreadStartupRequest } from "./thread-provisioning.js";

export const pendingThreadStartContextSchema = z.object({
  environmentIntent: threadProvisionEnvironmentIntentSchema,
  fork: threadForkDescriptorSchema.nullable(),
  providerInput: z.array(promptInputSchema).optional(),
  startedOnBehalfOf: startedOnBehalfOfSchema.nullable(),
  titleProvided: z.boolean(),
});
export type PendingThreadStartContext = z.infer<
  typeof pendingThreadStartContextSchema
>;

export function readPendingThreadStartContext(
  deps: Pick<LoggedPendingInteractionWorkSessionDeps, "db">,
  threadId: string,
): PendingThreadStartContext | null {
  return readThreadStartupContextOfKind(
    deps.db,
    threadId,
    "pending",
    pendingThreadStartContextSchema,
  );
}

export function hostIdForEnvironmentIntent(
  deps: Pick<LoggedPendingInteractionWorkSessionDeps, "db">,
  intent: PendingThreadStartContext["environmentIntent"],
): string | null {
  if (intent.type === "reuse") {
    return getEnvironment(deps.db, intent.environmentId)?.hostId ?? null;
  }
  return intent.machine.type === "existing" ? intent.machine.hostId : null;
}

function toPluginEnvironmentIntent(
  intent: PendingThreadStartContext["environmentIntent"],
): PluginDispatchEnvironmentIntent {
  switch (intent.type) {
    case "reuse":
      return { kind: "environment", environmentId: intent.environmentId };
    case "provider":
      return {
        kind: "provider",
        environmentProviderId: intent.environmentProviderId,
        machine: intent.machine,
        inputs: intent.inputs,
      };
  }
}

function intendedThreadIntent(
  deps: Pick<LoggedPendingInteractionWorkSessionDeps, "db">,
  threadId: string,
): PendingThreadStartContext["environmentIntent"] | null {
  return (
    readThreadProvisionContext(deps.db, threadId)?.request.environmentIntent ??
    readPendingThreadStartContext(deps, threadId)?.environmentIntent ??
    null
  );
}

export function intendedThreadEnvironmentIntent(
  deps: Pick<LoggedPendingInteractionWorkSessionDeps, "db">,
  thread: Pick<Thread, "id" | "environmentId">,
): PluginDispatchEnvironmentIntent | null {
  if (thread.environmentId !== null) {
    return { kind: "environment", environmentId: thread.environmentId };
  }
  const intent = intendedThreadIntent(deps, thread.id);
  return intent === null ? null : toPluginEnvironmentIntent(intent);
}

export function intendedThreadHostId(
  deps: Pick<LoggedPendingInteractionWorkSessionDeps, "db">,
  threadId: string,
): string | null {
  const intent = intendedThreadIntent(deps, threadId);
  return intent === null ? null : hostIdForEnvironmentIntent(deps, intent);
}

export function listRunningThreadsWithIntendedHosts(
  deps: Pick<LoggedPendingInteractionWorkSessionDeps, "db">,
): RunningThreadRow[] {
  return listRunningThreads(deps.db).map((row) =>
    row.hostId !== null
      ? row
      : { ...row, hostId: intendedThreadHostId(deps, row.id) },
  );
}

export type DispatchAttemptSource =
  | { kind: "inline" }
  | {
      kind: "drain";
      claimed: ClaimedQueuedThreadMessageRow[];
      respectManualStopPause: boolean;
      sendNow: boolean;
    };

export interface DispatchAttemptArgs {
  thread: Thread;
  payload: SendMessageRequest & { inputGroups?: PromptInput[][] };
  source: DispatchAttemptSource;
  startContext?: PendingThreadStartContext;
  queuePayload: QueuedMessagePayload;
  pluginSubmission: import("@get-bb/plugin-sdk").MessageDispatchHookContext["experimental_submission"];
  retryOf?: TurnRequestRetryMarker;
  origin: ThreadCreateOrigin | null;
  originPluginId: string | null;
  startedOnBehalfOf: StartedOnBehalfOf | null;
  executionDefaults?: Parameters<typeof buildExecutionOptions>[2];
  trigger: "auto-dispatch" | "user";
}

export type DispatchAttemptOutcome =
  | { kind: "dispatched"; refusal?: ThreadSendRefusal | null }
  | { kind: "queued"; entry: ThreadQueuedMessage };

export function resolveDispatchAttemptKind(
  thread: Thread,
  mode: SendMessageRequest["mode"],
): DispatchAttemptKind {
  if (thread.status !== "active") return "start-turn";
  return mode === "steer" || mode === "steer-if-active" || mode === "auto"
    ? "join-turn"
    : "start-turn";
}

export function attemptDispatch(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: DispatchAttemptArgs,
): Promise<DispatchAttemptOutcome> {
  return runDispatchAttempt(deps, args, false);
}

async function runDispatchAttempt(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: DispatchAttemptArgs,
  reattempted: boolean,
): Promise<DispatchAttemptOutcome> {
  const { payload, thread } = args;
  ensureThreadIsWritable(thread, true);
  if (args.trigger === "user" && args.source.kind === "inline") {
    await validatePromptAttachmentReferences({
      db: deps.db,
      dataDir: deps.config.dataDir,
      input: payload.input,
      projectId: thread.projectId,
    });
  }
  const senderThreadId = resolveMessageSenderThreadId(deps, {
    ...(payload.senderThreadId !== undefined
      ? { senderThreadId: payload.senderThreadId }
      : {}),
    targetThread: thread,
  });

  const interruptedStartupRequest =
    (thread.status === "error" || thread.status === "idle") &&
    thread.environmentId === null
      ? await restoreInterruptedThreadStartupRequest(deps, thread.id)
      : null;
  const firstDispatch =
    thread.status === "pending" || interruptedStartupRequest !== null;
  const retryStartContext: PendingThreadStartContext | null =
    interruptedStartupRequest === null
      ? null
      : {
          environmentIntent: interruptedStartupRequest.environmentIntent,
          fork: interruptedStartupRequest.fork,
          startedOnBehalfOf: args.startedOnBehalfOf,
          titleProvided: interruptedStartupRequest.titleProvided,
        };
  const author = resolveDispatchAuthor({
    retrying: args.retryOf !== undefined,
    senderThreadId,
    startedOnBehalfOf: args.startedOnBehalfOf,
  });
  const claimed = args.source.kind === "drain" ? args.source.claimed : null;
  const sendNow = args.source.kind === "drain" && args.source.sendNow;
  const respectManualStopPause =
    args.source.kind === "drain" && args.source.respectManualStopPause;
  const attempt = resolveDispatchAttemptKind(thread, payload.mode);

  const execution = await buildExecutionOptions(
    deps,
    payload,
    args.executionDefaults ?? { threadId: thread.id },
  );
  let resolvedPayload = resolveExecutionIntoPayload(payload, execution);
  const queuedMessage: QueuedDispatchMessage = {
    input: resolvedPayload.input,
    execution,
    senderThreadId,
    origin: args.origin,
    originPluginId: args.originPluginId,
    requestedBy: args.startedOnBehalfOf,
    payload: args.queuePayload,
    systemNotice: null,
  };

  const waitOn = (
    waitingOn: QueuedMessageWaitingOn,
    sendAt: number | null,
  ): DispatchAttemptOutcome => {
    const entry = recordQueuedMessageWait(deps, {
      thread,
      message: queuedMessage,
      waitingOn,
      sendAt,
      claimed,
    });
    if (entry === null) {
      return { kind: "dispatched" };
    }
    return { kind: "queued", entry };
  };

  const admitted: { value: PendingThreadAdmission | null } = {
    value: null,
  };
  const continued: {
    outcome: DispatchAttemptOutcome | null;
    reattemptThread: Thread | null;
  } = {
    outcome: null,
    reattemptThread: null,
  };

  const continueThroughCoreWaits = async (): Promise<void> => {
    const sendAt = payload.sendAt ?? null;
    if (!sendNow && sendAt !== null && sendAt > Date.now()) {
      continued.outcome = waitOn({ kind: "time" }, sendAt);
      return;
    }

    if (thread.status === "stopping") {
      continued.outcome = waitOn({ kind: "stopping" }, null);
      return;
    }

    const { environment: dispatchEnvironment, host: dispatchHost } =
      dispatchEnvironmentAndHost(deps, thread.environmentId);
    if (
      dispatchHost !== null &&
      isMachineWaitingForExecution(deps, dispatchHost.id)
    ) {
      cancelPreparingMachinePause(deps, dispatchHost.id);
      continued.outcome = waitOn(
        { kind: "host-offline", hostName: dispatchHost.name },
        null,
      );
      requestQueuedMachineReadiness(deps, dispatchHost.id);
      return;
    }

    if (thread.status === "active" && attempt === "start-turn") {
      if (payload.mode === "start") {
        throwThreadNotWritable(
          thread,
          "already_active",
          "Thread is already active",
        );
      }
      continued.outcome = waitOn({ kind: "thread-busy" }, null);
      return;
    }

    if (
      dispatchEnvironment !== null &&
      goneThreadEnvironmentDetails(dispatchEnvironment) === null &&
      dispatchHost?.status === "disconnected"
    ) {
      continued.outcome = waitOn(
        { kind: "host-offline", hostName: dispatchHost.name },
        null,
      );
      return;
    }

    if (payload.mode !== "start" && isManualCompactionActive(deps, thread)) {
      continued.outcome = waitOn({ kind: "thread-busy" }, null);
      return;
    }
    const currentThread = getThread(deps.db, thread.id);
    if (currentThread === null) {
      throw new ApiError(404, "thread_not_found", "Thread not found");
    }
    if (
      currentThread.status !== thread.status ||
      currentThread.archivedAt !== thread.archivedAt ||
      currentThread.deletedAt !== thread.deletedAt
    ) {
      continued.reattemptThread = currentThread;
      return;
    }
    if (
      currentThread.status === "active" &&
      resolveDispatchAttemptKind(currentThread, payload.mode) === "join-turn" &&
      getActiveTurnId(deps, thread.id) === null
    ) {
      const outcome = queueInputForStartingTurn(deps, {
        claimed,
        input: queuedMessage,
        threadId: thread.id,
      });
      if (outcome.kind === "queued" || outcome.kind === "dispatched") {
        continued.outcome = outcome;
        return;
      }
      if (outcome.kind === "retry") {
        continued.reattemptThread = outcome.thread;
        return;
      }
    }
    if (!firstDispatch && isPreStartThreadStatus(thread.status)) {
      continued.outcome = waitOn({ kind: "provisioning" }, null);
      return;
    }
    if (
      payload.mode !== "start" &&
      deps.pendingInteractions.hasTurnBoundPendingThreadInteraction(thread.id)
    ) {
      continued.outcome = waitOn({ kind: "interaction" }, null);
      return;
    }

    const workspaceClaim = claimWorkspaceForTurn(deps, {
      environment: dispatchEnvironment,
      threadId: thread.id,
    });
    const activeWorkspaceNeighbourId =
      dispatchEnvironment === null
        ? null
        : (listSharedWorkspaceActiveThreadIds(
            deps.db,
            dispatchEnvironment,
          ).find((threadId) => threadId !== thread.id) ?? null);
    const workspaceOwnerThreadId = workspaceClaim.acquired
      ? activeWorkspaceNeighbourId
      : workspaceClaim.holderThreadId;
    if (workspaceOwnerThreadId !== null) {
      const instruction: PromptInput = {
        type: "text",
        text: `${SHARED_WORKSPACE_ISOLATION_INSTRUCTION} The current shared-workspace owner is ${workspaceOwnerThreadId}.`,
        mentions: [],
        visibility: "agent-only",
      };
      const input = resolvedPayload.input.some(
        (item) =>
          item.type === "text" &&
          item.visibility === "agent-only" &&
          item.text.includes(SHARED_WORKSPACE_ISOLATION_INSTRUCTION),
      )
        ? resolvedPayload.input
        : [instruction, ...resolvedPayload.input];
      resolvedPayload = {
        ...resolvedPayload,
        input,
      };
      queuedMessage.input = resolvedPayload.input;
    }

    if (firstDispatch) {
      admitted.value = await admitPendingThread(deps, {
        claimed,
        payload: resolvedPayload,
        respectManualStopPause,
        startContext: args.startContext ?? retryStartContext,
        thread,
      });
      if (admitted.value === null) {
        continued.reattemptThread = getThread(deps.db, thread.id);
      }
    }
  };

  if (!sendNow && hasMessageDispatchHooks()) {
    const outcome = await runMessageDispatchHookPass(deps, {
      thread,
      threadResponse: toThreadResponseFromThread(deps, { thread }),
      project: requirePublicProject(deps.db, thread.projectId),
      environmentId: thread.environmentId,
      intendedHostId:
        thread.environmentId !== null
          ? null
          : intendedThreadHostId(deps, thread.id),
      environmentIntent: intendedThreadEnvironmentIntent(deps, thread),
      input: resolvedPayload.input,
      requestedExecution: {
        providerId: thread.providerId,
        model: execution.model,
        reasoningLevel: execution.reasoningLevel,
        serviceTier: execution.serviceTier,
        permissionMode: execution.permissionMode,
      },
      executionSources: dispatchExecutionSources(
        payload.executionInputSources ?? {},
      ),
      attempt,
      initiator: author.initiator,
      senderThreadId: author.senderThreadId,
      origin: args.origin,
      originPluginId: args.originPluginId,
      startedOnBehalfOf: args.startedOnBehalfOf,
      parentThreadId: thread.parentThreadId,
      queuedMessages: claimed?.map(toThreadQueuedMessage) ?? [],
      pluginSubmission: args.pluginSubmission,
      continueAfterHooks: continueThroughCoreWaits,
    });
    if (outcome.kind === "wait") {
      if (claimed !== null) {
        noteDispatchRequeued(thread.id);
      }
      return waitOn(
        {
          kind: "plugin",
          pluginId: outcome.waiter.pluginId,
          reason: dispatchWaitReasonForPass(outcome),
        },
        outcome.waiter.sendAt,
      );
    }
  } else {
    await continueThroughCoreWaits();
  }

  if (continued.outcome !== null) {
    return continued.outcome;
  }
  if (continued.reattemptThread !== null) {
    return reattemptDispatchForThreadChange(
      deps,
      args,
      continued.reattemptThread,
      reattempted,
    );
  }

  try {
    if (firstDispatch) {
      const admission = admitted.value;
      if (admission === null) {
        const current = getThread(deps.db, thread.id);
        return reattemptDispatchForThreadChange(
          deps,
          args,
          current,
          reattempted,
        );
      }
      await launchAdmittedThread(deps, admission);
      return { kind: "dispatched" };
    }

    const environment = await requireThreadCommandEnvironment(deps, { thread });
    const sent = await sendThreadMessage(deps, {
      environment,
      payload: resolvedPayload,
      thread,
      trigger: args.trigger,
      ...(args.retryOf !== undefined ? { retryOf: args.retryOf } : {}),
      beforeAppendInTransaction: ({ tx }) => {
        if (getThread(tx, thread.id)?.status !== thread.status) {
          throw new DispatchThreadStatusChangedError();
        }
        if (claimed !== null) {
          consumeClaimedRows(
            claimed,
            thread.id,
            respectManualStopPause,
          )({ tx });
        }
      },
    });
    if (claimed !== null) {
      settleQueueRowDispatched({ row: claimed[0]! });
    }
    return { kind: "dispatched", refusal: sent.refusal };
  } catch (error) {
    releaseWorkspaceForThread(deps, thread);
    if (error instanceof DispatchThreadStatusChangedError) {
      return reattemptDispatchForThreadChange(
        deps,
        args,
        getThread(deps.db, thread.id),
        reattempted,
      );
    }
    throw error;
  }
}

class DispatchThreadStatusChangedError extends Error {}

function reattemptDispatchForThreadChange(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: DispatchAttemptArgs,
  thread: Thread | null,
  reattempted: boolean,
): Promise<DispatchAttemptOutcome> {
  if (thread === null) {
    throw new ApiError(404, "thread_not_found", "Thread not found");
  }
  if (reattempted) {
    throw new ApiError(
      500,
      "internal_error",
      `Thread ${thread.id} changed twice under one dispatch attempt`,
    );
  }
  return runDispatchAttempt(deps, { ...args, thread }, true);
}

function consumeClaimedRows(
  claimed: readonly ClaimedQueuedThreadMessageRow[],
  threadId: string,
  respectManualStopPause: boolean,
): SendThreadMessageTransactionPreflight {
  return ({ tx }) => {
    if (respectManualStopPause && isThreadQueueAutoSendPaused(tx, threadId)) {
      throw createQueuedMessageAutoSendPausedError();
    }
    const consumed = deleteClaimedQueuedThreadMessageBatchInTransaction(tx, {
      queuedMessages: claimed,
    });
    if (!consumed) {
      throw createQueuedMessageClaimLostError();
    }
  };
}

interface AdmitPendingThreadArgs {
  claimed: ClaimedQueuedThreadMessageRow[] | null;
  payload: SendMessageRequest & { inputGroups?: PromptInput[][] };
  respectManualStopPause: boolean;
  startContext: PendingThreadStartContext | null;
  thread: Thread;
}

interface PendingThreadAdmission {
  claimedRow: ClaimedQueuedThreadMessageRow | null;
  startingThread: Thread;
}

class PendingThreadAdmissionLost extends Error {
  constructor() {
    super("The thread left pending under the attempt");
    this.name = "PendingThreadAdmissionLost";
  }
}

async function admitPendingThread(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: AdmitPendingThreadArgs,
): Promise<PendingThreadAdmission | null> {
  const startContext =
    args.startContext ?? readPendingThreadStartContext(deps, args.thread.id);
  if (startContext === null) {
    if (getThread(deps.db, args.thread.id)?.status !== "pending") {
      return null;
    }
    throw new ApiError(
      500,
      "internal_error",
      `Thread ${args.thread.id} is pending but has no start context to dispatch`,
    );
  }
  const execution = await buildExecutionOptions(deps, args.payload, {
    threadId: args.thread.id,
  });
  const claimedRow = args.claimed?.[0] ?? null;
  let startingThread: Thread;
  try {
    startingThread = deps.db.transaction(
      (tx) => {
        if (args.claimed !== null && args.claimed.length > 0) {
          consumeClaimedRows(
            args.claimed,
            args.thread.id,
            args.respectManualStopPause,
          )({ tx });
        }
        const prepared = applyLoggedThreadLifecycleEventInTransaction(
          { db: tx, logger: deps.logger },
          { threadId: args.thread.id, event: { type: "run.preparing" } },
        );
        if (!prepared.applied) {
          throw new PendingThreadAdmissionLost();
        }
        const starting = getThread(tx, args.thread.id);
        if (starting === null) throw new PendingThreadAdmissionLost();
        requestThreadProvision(deps, {
          thread: starting,
          environmentIntent: startContext.environmentIntent,
          execution,
          fork: startContext.fork,
          input: args.payload.input,
          ...(startContext.providerInput === undefined
            ? {}
            : { providerInput: startContext.providerInput }),
          startedOnBehalfOf: startContext.startedOnBehalfOf,
          titleProvided: startContext.titleProvided,
        });
        return starting;
      },
      { behavior: "immediate" },
    );
  } catch (error) {
    if (!(error instanceof PendingThreadAdmissionLost)) {
      throw error;
    }
    deps.logger.warn(
      { threadId: args.thread.id, status: args.thread.status },
      "A cleared first dispatch could not move its thread out of pending",
    );
    return null;
  }
  deps.hub.notifyThread(
    startingThread.id,
    ["status-changed"],
    buildThreadStatusChangeMetadata(deps, startingThread),
  );
  return {
    claimedRow,
    startingThread,
  };
}

async function launchAdmittedThread(
  deps: LoggedPendingInteractionWorkSessionDeps,
  admission: PendingThreadAdmission,
): Promise<void> {
  const { claimedRow, startingThread } = admission;
  if (claimedRow !== null) {
    settleQueueRowDispatched({ row: claimedRow });
  }
  scheduleThreadProvisioningAdvance(deps, startingThread.id);
}

function resolveExecutionIntoPayload(
  payload: SendMessageRequest & { inputGroups?: PromptInput[][] },
  execution: ResolvedThreadExecutionOptions,
): SendMessageRequest & { inputGroups?: PromptInput[][] } {
  return {
    ...payload,
    model: execution.model,
    reasoningLevel: execution.reasoningLevel,
    serviceTier: execution.serviceTier,
    permissionMode: execution.permissionMode,
    executionInputSources: {
      ...(payload.executionInputSources ?? {}),
      model: "explicit",
      reasoningLevel: "explicit",
      serviceTier: "explicit",
      permissionMode: "explicit",
    },
  };
}
