import { hasQueuedRetryOfTurnRequest } from "@bb/db";
import { permissionModeSchema } from "@bb/domain";
import type {
  ClientTurnRequestId,
  PermissionMode,
  PromptInput,
  Thread,
} from "@bb/domain";
import type {
  RetryTurnRequest,
  RetryTurnResponse,
  SendMessageRequest,
} from "@bb/server-contract";
import { ApiError } from "../../errors.js";
import type { LoggedPendingInteractionWorkSessionDeps } from "../../types.js";
import { attemptDispatch } from "./dispatch-attempt.js";
import {
  loadFailedTurn,
  retryChain,
  wasFailedTurnInputAccepted,
  type FailedTurnRecord,
} from "./turn-failed.js";

type TurnRetryDeps = LoggedPendingInteractionWorkSessionDeps;

function hasQueuedRetryFor(
  deps: Pick<TurnRetryDeps, "db">,
  args: { threadId: string; originalRequestId: string },
): boolean {
  return hasQueuedRetryOfTurnRequest(deps.db, {
    threadId: args.threadId,
    retryOfTurnRequestId: args.originalRequestId,
  });
}

function requireFailedTurn(
  deps: Pick<TurnRetryDeps, "db">,
  args: { thread: Thread; turnRequestId: ClientTurnRequestId | null },
) {
  const { thread } = args;
  if (thread.status !== "error") {
    throw new ApiError(
      409,
      "no_failed_turn",
      `Thread ${thread.id} has no failed turn to retry: it is ${thread.status}.`,
    );
  }
  const failed = loadFailedTurn(deps.db, thread.id);
  if (failed === null) {
    throw new ApiError(
      409,
      "no_failed_turn",
      `Thread ${thread.id} failed before it dispatched a turn, so there is nothing to retry.`,
    );
  }
  if (
    args.turnRequestId !== null &&
    args.turnRequestId !== failed.request.requestId
  ) {
    throw new ApiError(
      409,
      "no_failed_turn",
      `Turn ${args.turnRequestId} is not the failed turn on thread ${thread.id}; its most recent turn is ${failed.request.requestId}.`,
    );
  }
  return failed;
}

export interface RetryFailedTurnArgs {
  thread: Thread;
  request: RetryTurnRequest;
}

const CONTINUE_ACCEPTED_TURN_TEXT = "Please continue.";

function retryInput(
  deps: Pick<TurnRetryDeps, "db">,
  args: { threadId: string; failed: FailedTurnRecord },
): { input: PromptInput[]; inputGroups?: PromptInput[][] } {
  if (wasFailedTurnInputAccepted(deps.db, args)) {
    return {
      input: [
        {
          type: "text",
          text: CONTINUE_ACCEPTED_TURN_TEXT,
          mentions: [],
          visibility: "agent-only",
        },
      ],
    };
  }
  const agentOnly = (block: PromptInput): PromptInput => ({
    ...block,
    visibility: "agent-only",
  });
  const groups = args.failed.request.inputGroups;
  return {
    input: args.failed.request.input.map(agentOnly),
    ...(groups === undefined
      ? {}
      : { inputGroups: groups.map((group) => group.map(agentOnly)) }),
  };
}

function retryExecution(failed: FailedTurnRecord): {
  model: string;
  reasoningLevel: SendMessageRequest["reasoningLevel"];
  serviceTier: SendMessageRequest["serviceTier"];
  permissionMode?: PermissionMode;
} {
  const { execution } = failed.request;
  const permissionMode = permissionModeSchema.safeParse(
    execution.permissionMode,
  ).data;
  return {
    model: execution.model,
    reasoningLevel: execution.reasoningLevel,
    serviceTier: execution.serviceTier,
    ...(permissionMode === undefined ? {} : { permissionMode }),
  };
}

const retriesInFlight = new Set<string>();

export async function retryFailedTurn(
  deps: TurnRetryDeps,
  args: RetryFailedTurnArgs,
): Promise<RetryTurnResponse> {
  const { request, thread } = args;
  const failed = requireFailedTurn(deps, {
    thread,
    turnRequestId: request.turnRequestId,
  });
  const chain = retryChain(failed.request);
  const originalRequestId = chain.originalRequestId;
  const inFlightKey = `${thread.id}:${originalRequestId}`;
  if (
    retriesInFlight.has(inFlightKey) ||
    hasQueuedRetryFor(deps, { threadId: thread.id, originalRequestId })
  ) {
    throw new ApiError(
      409,
      "retry_already_queued",
      `Turn ${originalRequestId} already has a retry waiting on thread ${thread.id}.`,
    );
  }
  retriesInFlight.add(inFlightKey);
  try {
    const attempt = chain.attemptNumber + 1;
    const outcome = await attemptDispatch(deps, {
      thread,
      payload: {
        mode: "queue-if-active",
        ...retryInput(deps, { threadId: thread.id, failed }),
        ...retryExecution(failed),
        ...(request.sendAt === null ? {} : { sendAt: request.sendAt }),
      },
      source: { kind: "inline" },
      queuePayload: {
        kind: "retry",
        retryOfTurnRequestId: originalRequestId,
        attempt,
        reason: request.reason,
      },
      pluginSubmission: null,
      retryOf: { requestId: originalRequestId, attempt },
      origin: null,
      originPluginId: null,
      startedOnBehalfOf: null,
      trigger: "user",
    });
    if (outcome.kind === "dispatched") {
      return {
        ok: true,
        delivery: "sent",
        turnRequestId: originalRequestId,
        attempt,
        ...(outcome.refusal ? { refusal: outcome.refusal } : {}),
      };
    }
    return {
      ok: true,
      delivery: "queued",
      turnRequestId: originalRequestId,
      attempt,
      queuedMessageId: outcome.entry.id,
      waitingOn: outcome.entry.waitingOn ?? { kind: "thread-busy" },
      sendAt: outcome.entry.sendAt,
    };
  } finally {
    retriesInFlight.delete(inFlightKey);
  }
}
