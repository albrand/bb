import { isNativeTerminalQuestion } from "@bb/domain";
import type { AppDeps } from "../../types.js";

export const NATIVE_QUESTION_ANSWERED_REASON =
  "native-terminal-question-answered";

export function interruptNativeTerminalQuestions(
  deps: Pick<AppDeps, "pendingInteractions">,
  threadId: string,
  keep: ReadonlySet<string> = new Set(),
): number {
  let interrupted = 0;
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
    interrupted += 1;
  }
  return interrupted;
}

const rejectedNativeQuestions = new WeakMap<
  AppDeps["hub"],
  Map<string, Set<string>>
>();

export function rejectedQuestions(
  deps: Pick<AppDeps, "hub">,
  threadId: string,
): Set<string> {
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

export function forgetRejectedNativeQuestions(
  deps: Pick<AppDeps, "hub">,
  threadId: string,
): void {
  rejectedQuestions(deps, threadId).clear();
}
