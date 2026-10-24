import {
  publicApiRoutes,
  typedRoutes,
  nativeTerminalActivityStateSchema,
  nativeTerminalOpenQuestionSchema,
  NATIVE_TERMINAL_MAX_OPEN_QUESTIONS,
  type PublicApiSchema,
} from "@bb/server-contract";
import type { Hono } from "hono";
import { z } from "zod";
import { ApiError } from "../../src/errors.js";
import type { AppDeps } from "../../src/types.js";
import { recordNativeTerminalActivity } from "./native-terminal-legacy-activity.js";

export const legacyReportNativeTerminalActivityRequestSchema = z
  .object({
    state: nativeTerminalActivityStateSchema,
    prompt: z.string().trim().min(1).max(4_000).optional(),
    questions: z
      .array(nativeTerminalOpenQuestionSchema)
      .min(1)
      .max(NATIVE_TERMINAL_MAX_OPEN_QUESTIONS)
      .optional(),
  })
  .strict()
  .superRefine((request, context) => {
    if ((request.state === "waiting") !== (request.questions !== undefined)) {
      context.addIssue({
        code: "custom",
        path: ["questions"],
        message: "questions are required when waiting and only then",
      });
    }
  });

export function registerLegacyNativeTerminalActivityRoute(
  app: Hono,
  deps: AppDeps,
): void {
  const { post } = typedRoutes<PublicApiSchema>(app.basePath("/api/v1"), {
    onValidationError: (message) =>
      new ApiError(400, "invalid_request", message),
  });
  const route = publicApiRoutes.nativeTerminalThreads.reportActivity;
  post(
    {
      ...route,
      request: {
        ...route.request,
        schema: legacyReportNativeTerminalActivityRequestSchema,
      },
    } as typeof route,
    (context, payload) => {
      recordNativeTerminalActivity(deps, {
        authorization: context.req.header("authorization"),
        threadId: context.req.param("id"),
        ...payload,
      });
      return context.json({ ok: true as const });
    },
  );
}
