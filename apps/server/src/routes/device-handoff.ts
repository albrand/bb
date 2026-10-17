import { Buffer } from "node:buffer";
import { getThread, updateThread } from "@bb/db";
import {
  publicApiRoutes,
  typedRoutes,
  type PublicApiSchema,
} from "@bb/server-contract";
import type { Hono } from "hono";
import { ApiError } from "../errors.js";
import type { AppDeps } from "../types.js";

export function registerDeviceHandoffRoutes(app: Hono, deps: AppDeps): void {
  const attentionMarkers = new Map<
    string,
    { markerAt: number; previousAttentionAt: number }
  >();
  deps.hub.onDeviceHandoffAttentionChange((threadId, terminalId, pending) => {
    if (terminalId !== null) {
      deps.terminalSessions.setDeviceHandoffAttention(terminalId, pending);
      return;
    }
    const marker = attentionMarkers.get(threadId);
    if (pending) {
      if (marker) return;
      const thread = getThread(deps.db, threadId);
      if (!thread) return;
      const markerAt = Math.max(Date.now(), thread.latestAttentionAt + 1);
      attentionMarkers.set(threadId, {
        markerAt,
        previousAttentionAt: thread.latestAttentionAt,
      });
      updateThread(deps.db, deps.hub, threadId, {
        latestAttentionAt: markerAt,
      });
      return;
    }
    if (!marker) return;
    attentionMarkers.delete(threadId);
    const thread = getThread(deps.db, threadId);
    if (thread?.latestAttentionAt === marker.markerAt) {
      updateThread(deps.db, deps.hub, threadId, {
        latestAttentionAt: marker.previousAttentionAt,
      });
    }
  });
  const { post } = typedRoutes<PublicApiSchema>(app, {
    onValidationError: (message) =>
      new ApiError(
        400,
        "invalid_request",
        `Invalid device handoff: ${message}`,
      ),
  });

  post(publicApiRoutes.deviceHandoff.request, (context, request) => {
    if (
      request.kind === "copy-text" &&
      Buffer.byteLength(request.text, "utf8") > 1024 * 1024
    ) {
      throw new ApiError(
        400,
        "invalid_request",
        "Copy text exceeds the 1 MiB limit",
      );
    }
    if (
      request.kind === "open-url" &&
      Buffer.byteLength(request.url, "utf8") > 8 * 1024
    ) {
      throw new ApiError(
        400,
        "invalid_request",
        "Open URL exceeds the 8 KiB limit",
      );
    }
    const thread = request.origin.threadId
      ? getThread(deps.db, request.origin.threadId)
      : undefined;
    const terminal = request.origin.terminalSessionId
      ? deps.terminalSessions.getTerminal({
          terminalId: request.origin.terminalSessionId,
        })
      : undefined;
    const originLabel = (terminal?.title ?? thread?.title ?? "BB").slice(
      0,
      256,
    );
    const delivered = deps.hub.notifyDeviceHandoff(
      request,
      originLabel,
      thread?.id ?? terminal?.threadId,
    );
    return context.json({ delivered });
  });
}
