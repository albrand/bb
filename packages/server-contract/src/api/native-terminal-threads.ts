import { z } from "zod";
import {
  providerNativeTerminalSchema,
  terminalColsSchema,
  terminalRowsSchema,
} from "@bb/domain";
import { terminalSessionSchema } from "./terminals.js";

export const nativeTerminalThreadSchema = z.object({
  threadId: z.string().min(1),
  providerId: z.string().min(1),
  displayName: z.string().min(1),
  nativeSessionId: z.string().min(1).nullable(),
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

export const nativeTerminalLaunchSpecSchema = z.object({
  threadId: z.string().min(1),
  cli: providerNativeTerminalSchema,
  nativeSessionId: z.string().min(1).nullable(),
  initialPrompt: z.string().min(1).nullable(),
  model: z.string().min(1).nullable(),
});
export type NativeTerminalLaunchSpec = z.infer<
  typeof nativeTerminalLaunchSpecSchema
>;

export const recordNativeSessionRequestSchema = z
  .object({
    nativeSessionId: z
      .string()
      .regex(/^[0-9a-f-]{8,64}$/iu, "expected a native session id"),
  })
  .strict();
export type RecordNativeSessionRequest = z.infer<
  typeof recordNativeSessionRequestSchema
>;
