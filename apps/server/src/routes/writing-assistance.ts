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
  editWritingVocabulary,
  transcribeDictationSegment,
  updateWritingAssistance,
} from "../services/ai/writing-assistance.js";

const DICTATION_SEGMENT_MAX_BYTES = 25 * 1024 * 1024;

function formString(value: FormDataEntryValue | null): string {
  return typeof value === "string" ? value : "";
}

function segmentTooLarge(): ApiError {
  return new ApiError(
    413,
    "invalid_request",
    `A dictation segment upload can be at most ${DICTATION_SEGMENT_MAX_BYTES} bytes`,
  );
}

async function readLimitedFormData(request: Request): Promise<FormData> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > DICTATION_SEGMENT_MAX_BYTES) {
    throw segmentTooLarge();
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (request.body !== null) {
    const reader = request.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > DICTATION_SEGMENT_MAX_BYTES) {
        await reader.cancel();
        throw segmentTooLarge();
      }
      chunks.push(value);
    }
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return await new Response(body, {
      headers: { "content-type": request.headers.get("content-type") ?? "" },
    }).formData();
  } catch {
    throw new ApiError(400, "invalid_request", "Audio file is required");
  }
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

  post(routes.editVocabulary, (context, payload) =>
    context.json(editWritingVocabulary(deps, payload)),
  );

  post(routes.correct, async (context, payload) =>
    context.json(await correctWriting(deps, payload, context.req.raw.signal)),
  );

  post(routes.dictationSegment, async (context) => {
    const formData = await readLimitedFormData(context.req.raw);
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
