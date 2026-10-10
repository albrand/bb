import {
  publicApiRoutes,
  typedRoutes,
  type PublicApiSchema,
} from "@bb/server-contract";
import type { Hono } from "hono";
import { ApiError } from "../errors.js";
import {
  findNativeTerminalThreadView,
  openNativeTerminal,
  recordNativeTerminalSession,
  takeNativeTerminalLaunchSpec,
} from "../services/threads/native-terminal-threads.js";
import type { AppDeps } from "../types.js";

export function registerNativeTerminalThreadRoutes(
  app: Hono,
  deps: AppDeps,
): void {
  const { get, post } = typedRoutes<PublicApiSchema>(app, {
    onValidationError: (msg) => new ApiError(400, "invalid_request", msg),
  });
  const routes = publicApiRoutes.nativeTerminalThreads;

  get(routes.get, (context) =>
    context.json(findNativeTerminalThreadView(deps, context.req.param("id"))),
  );

  post(routes.open, async (context, payload) =>
    context.json(
      await openNativeTerminal(deps, {
        threadId: context.req.param("id"),
        request: payload,
      }),
    ),
  );

  post(routes.launch, (context) =>
    context.json(takeNativeTerminalLaunchSpec(deps, context.req.param("id"))),
  );

  post(routes.recordSession, (context, payload) =>
    context.json(
      recordNativeTerminalSession(deps, {
        threadId: context.req.param("id"),
        nativeSessionId: payload.nativeSessionId,
      }),
    ),
  );
}
