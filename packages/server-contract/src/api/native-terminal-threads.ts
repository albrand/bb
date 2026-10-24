import { z } from "zod";
import {
  dynamicToolSchema,
  providerNativeTerminalSchema,
  terminalColsSchema,
  terminalRowsSchema,
  toolCallResponseSchema,
} from "@bb/domain";
import { terminalSessionSchema } from "./terminals.js";

export const nativeTerminalThreadSchema = z.object({
  threadId: z.string().min(1),
  providerId: z.string().min(1),
  displayName: z.string().min(1),
  nativeSessionId: z.string().min(1).nullable(),
  canReturnToChat: z.boolean(),
  terminal: terminalSessionSchema.nullable(),
});
export type NativeTerminalThread = z.infer<typeof nativeTerminalThreadSchema>;

export const openNativeTerminalRequestSchema = z
  .object({
    cols: terminalColsSchema.optional(),
    rows: terminalRowsSchema.optional(),
  })
  .strict();
export type OpenNativeTerminalRequest = z.infer<
  typeof openNativeTerminalRequestSchema
>;

export const nativeTerminalLaunchQuerySchema = z.object({
  images: z.literal("argv").optional(),
});
export type NativeTerminalLaunchQuery = z.infer<
  typeof nativeTerminalLaunchQuerySchema
>;

export const nativeTerminalLaunchSpecSchema = z.object({
  threadId: z.string().min(1),
  cli: providerNativeTerminalSchema,
  nativeSessionId: z.string().min(1).nullable(),
  initialPrompt: z.string().min(1).nullable(),
  initialImages: z.array(z.string().min(1)).optional(),
  model: z.string().min(1).nullable(),
});
export type NativeTerminalLaunchSpec = z.infer<
  typeof nativeTerminalLaunchSpecSchema
>;

export const nativeTerminalModeSchema = z.enum(["terminal", "chat"]);
export type NativeTerminalMode = z.infer<typeof nativeTerminalModeSchema>;

export const switchNativeTerminalModeRequestSchema = z
  .object({ mode: nativeTerminalModeSchema })
  .strict();
export type SwitchNativeTerminalModeRequest = z.infer<
  typeof switchNativeTerminalModeRequestSchema
>;

export const nativeTerminalActivityStateSchema = z.enum([
  "working",
  "waiting",
  "idle",
]);
export type NativeTerminalActivityState = z.infer<
  typeof nativeTerminalActivityStateSchema
>;

export const NATIVE_TERMINAL_MAX_OPEN_QUESTIONS = 8;

export const nativeTerminalOpenQuestionSchema = z
  .object({
    id: z.string().trim().min(1).max(256),
    prompt: z.string().trim().min(1).max(4_000),
  })
  .strict();
export type NativeTerminalOpenQuestion = z.infer<
  typeof nativeTerminalOpenQuestionSchema
>;

export const reportNativeTerminalActivityRequestSchema = z
  .object({
    state: nativeTerminalActivityStateSchema,
    prompt: z.string().trim().min(1).max(4_000).optional(),
    questions: z
      .array(nativeTerminalOpenQuestionSchema)
      .min(1)
      .max(NATIVE_TERMINAL_MAX_OPEN_QUESTIONS)
      .optional(),
    confirms: z.boolean().optional(),
    closes: z
      .array(z.string().trim().min(1).max(256))
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
export type ReportNativeTerminalActivityRequest = z.infer<
  typeof reportNativeTerminalActivityRequestSchema
>;

export const recordNativeSessionRequestSchema = z
  .object({
    nativeSessionId: z
      .string()
      .regex(/^[0-9a-f-]{8,64}$/iu, "expected a native session id"),
    replacesNativeSessionId: z
      .string()
      .regex(/^[0-9a-f-]{8,64}$/iu, "expected a native session id")
      .optional(),
  })
  .strict();
export type RecordNativeSessionRequest = z.infer<
  typeof recordNativeSessionRequestSchema
>;

export const nativeTerminalAgentToolsSchema = z.object({
  tools: z.array(dynamicToolSchema),
});
export type NativeTerminalAgentTools = z.infer<
  typeof nativeTerminalAgentToolsSchema
>;

export const callNativeTerminalAgentToolRequestSchema = z
  .object({
    callId: z.string().min(1),
    arguments: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();
export type CallNativeTerminalAgentToolRequest = z.input<
  typeof callNativeTerminalAgentToolRequestSchema
>;
export type NativeTerminalAgentToolResult = z.infer<
  typeof toolCallResponseSchema
>;
