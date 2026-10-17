import type { Hono } from "hono";
import {
  publicApiRoutes,
  typedRoutes,
  type PublicApiSchema,
} from "@bb/server-contract";
import type { ServerAppDeps } from "../types.js";
import { ApiError } from "../errors.js";
import {
  buildWritingAssistanceView,
  correctWriting,
  transcribeDictationSegment,
  updateWritingAssistance,
} from "../services/ai/writing-assistance.js";

function formString(value: FormDataEntryValue | null): string {
  return typeof value === "string" ? value : "";
}

export function registerWritingAssistanceRoutes(
  app: Hono,
  deps: ServerAppDeps,
): void {
  const routes = publicApiRoutes.writingAssistance;
  const { get, post, put } = typedRoutes<PublicApiSchema>(app, {
    onValidationError: (message) =>
      new ApiError(400, "invalid_request", message),
  });

  get(routes.view, (context) => context.json(buildWritingAssistanceView(deps)));

  put(routes.updateSettings, (context, payload) =>
    context.json(updateWritingAssistance(deps, payload)),
  );

  post(routes.correct, async (context, payload) =>
    context.json(await correctWriting(deps, payload, context.req.raw.signal)),
  );

  post(routes.dictationSegment, async (context) => {
    const formData = await context.req.formData();
    const file = formData.get("file");
    if (!(file instanceof File)) {
      throw new ApiError(400, "invalid_request", "Audio file is required");
    }
    return context.json(
      await transcribeDictationSegment(deps, {
        file,
        context: formString(formData.get("context")),
        signal: context.req.raw.signal,
      }),
    );
  });
}
