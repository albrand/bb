import type { JsonValue } from "@bb/domain";
import type { PendingInteraction } from "@bb/domain";
import { buildUnclaimedAnswerMessage } from "./unclaimed-answer-message.js";

export interface UnclaimedAnswerDelivery {
  threadId: string;
  text: string;
}

export function planUnclaimedAnswerDelivery(args: {
  interaction: Pick<PendingInteraction, "threadId" | "payload">;
  value: JsonValue;
}): UnclaimedAnswerDelivery | null {
  const text = buildUnclaimedAnswerMessage(args.interaction.payload, args.value);
  if (text === null) return null;
  return { threadId: args.interaction.threadId, text };
}
