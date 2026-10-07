import type { ThreadEvent } from "@bb/domain";
import type { EventMeta } from "./event-decode.js";
import { messageId } from "./format-helpers.js";
import type { EventProjectionErrorMessage } from "./event-projection-types.js";

export function parseErrorMessage(
  decoded: ThreadEvent,
  meta: EventMeta,
): EventProjectionErrorMessage | null {
  if (
    decoded.type !== "provider/error" &&
    decoded.type !== "system/error" &&
    decoded.type !== "turn/completed"
  ) {
    return null;
  }

  if (decoded.type === "turn/completed") {
    if (decoded.status !== "failed" || !decoded.error?.message) return null;
    return {
      kind: "error",
      id: messageId(decoded.threadId, "error", `${meta.seq}`),
      threadId: decoded.threadId,
      sourceSeqStart: meta.seq,
      sourceSeqEnd: meta.seq,
      createdAt: meta.createdAt,
      sourceEvent: { seq: meta.seq, part: 0 },
      scope: decoded.scope,
      rawType: decoded.type,
      systemErrorCode: null,
      message: decoded.error.message,
      detail: null,
    };
  }

  const { message, detail } = decoded;
  return {
    kind: "error",
    id: messageId(decoded.threadId, "error", `${meta.seq}`),
    threadId: decoded.threadId,
    sourceEvent: { seq: meta.seq, part: 0 },
    sourceSeqStart: meta.seq,
    sourceSeqEnd: meta.seq,
    createdAt: meta.createdAt,
    scope: decoded.scope,
    rawType: decoded.type,
    systemErrorCode:
      decoded.type === "system/error" ? (decoded.code ?? null) : null,
    message: message || "Error event",
    detail: detail && detail !== message ? detail : null,
    ...(decoded.type === "provider/error" && decoded.errorInfo
      ? { providerErrorInfo: decoded.errorInfo }
      : {}),
    ...(decoded.type === "provider/error" && decoded.willRetry !== undefined
      ? { willRetry: decoded.willRetry }
      : {}),
  };
}
