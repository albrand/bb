import {
  terminalClientMessageSchema,
  terminalOutputChunkSchema,
  terminalServerMessageSchema,
  terminalSessionSchema,
} from "@bb/server-contract";
import { z } from "zod";

export const TERMINAL_DATA_PLANE_IPC_VERSION = 2;
export const TERMINAL_DATA_PLANE_PENDING_REPLAY_BUFFER_BYTES = 1024 * 1024;
export const TERMINAL_DATA_PLANE_CHILD_PENDING_IPC_BYTES = 1024 * 1024;
export const TERMINAL_DATA_PLANE_RELAY_PAUSE_BYTES = 2 * 1024 * 1024;
export const TERMINAL_DATA_PLANE_RELAY_RESUME_BYTES = 512 * 1024;
export const TERMINAL_DATA_PLANE_RELAY_HARD_CAP_BYTES = 16 * 1024 * 1024;
export const TERMINAL_DATA_PLANE_SOCKET_FRAME_OVERHEAD_BYTES = 10;
export const TERMINAL_DATA_PLANE_INPUT_COALESCE_MS = 4;
export const TERMINAL_DATA_PLANE_INPUT_ACTIVITY_INTERVAL_MS = 1_000;
export const TERMINAL_DATA_PLANE_STATS_INTERVAL_MS = 30_000;
export const TERMINAL_DATA_PLANE_OVERLOAD_CLOSE_CODE = 1013;

const versionSchema = z.literal(TERMINAL_DATA_PLANE_IPC_VERSION);
const idSchema = z.string().min(1);
const seqSchema = z.number().int().nonnegative();

export const terminalDataPlaneHandoffRequestSchema = z
  .object({
    url: z.string().min(1),
    headers: z.array(z.tuple([z.string(), z.string()])),
    headBase64: z.string(),
  })
  .strict();
export type TerminalDataPlaneHandoffRequest = z.infer<
  typeof terminalDataPlaneHandoffRequestSchema
>;

export const terminalDataPlaneRouteModeSchema = z.enum([
  "data-socket",
  "main-relay",
]);
export type TerminalDataPlaneRouteMode = z.infer<
  typeof terminalDataPlaneRouteModeSchema
>;

const browserControlClientMessageSchema = terminalClientMessageSchema.refine(
  (message) => message.type === "resize",
  "Only resize client messages cross to main as browser.control",
);

const browserReplyServerMessageSchema = terminalServerMessageSchema.refine(
  (message) =>
    message.type === "features" ||
    message.type === "resize-applied" ||
    (message.type === "session-updated" && message.resizeSeq !== undefined),
  "Only attach-specific terminal messages are replies to one browser attach",
);

const browserSendServerMessageSchema = terminalServerMessageSchema.refine(
  (message) =>
    message.type === "session-updated" ||
    message.type === "exited" ||
    message.type === "error",
  "Only session-updated, exited and error server messages are sent by main",
);

export const terminalDataPlaneMainMessageSchema = z.discriminatedUnion("type", [
  z
    .object({
      v: versionSchema,
      type: z.literal("browser.attach"),
      attachId: idSchema,
      terminalId: idSchema,
      daemonSessionId: idSchema,
      outputAcks: z.boolean(),
      sequenceBase: seqSchema,
      sinceSeq: seqSchema.nullable(),
      request: terminalDataPlaneHandoffRequestSchema,
    })
    .strict(),
  z
    .object({
      v: versionSchema,
      type: z.literal("browser.replay"),
      attachId: idSchema,
      terminalId: idSchema,
      session: terminalSessionSchema,
      replayStartSeq: seqSchema,
      chunks: z.array(terminalOutputChunkSchema),
      nextSeq: seqSchema,
    })
    .strict(),
  z
    .object({
      v: versionSchema,
      type: z.literal("browser.send"),
      terminalId: idSchema,
      message: browserSendServerMessageSchema,
    })
    .strict(),
  z
    .object({
      v: versionSchema,
      type: z.literal("browser.reply"),
      attachId: idSchema,
      message: browserReplyServerMessageSchema,
    })
    .strict(),
  z
    .object({
      v: versionSchema,
      type: z.literal("browser.close"),
      target: z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("attach"), attachId: idSchema }).strict(),
        z
          .object({ kind: z.literal("terminal"), terminalId: idSchema })
          .strict(),
      ]),
      code: z.number().int(),
      reason: z.string(),
    })
    .strict(),
  z
    .object({
      v: versionSchema,
      type: z.literal("daemon.attach"),
      daemonSessionId: idSchema,
      request: terminalDataPlaneHandoffRequestSchema,
    })
    .strict(),
  z
    .object({
      v: versionSchema,
      type: z.literal("daemon.detach"),
      daemonSessionId: idSchema,
    })
    .strict(),
  z
    .object({
      v: versionSchema,
      type: z.literal("terminal.route"),
      terminalId: idSchema,
      daemonSessionId: idSchema,
      mode: terminalDataPlaneRouteModeSchema,
      holderMarkerPending: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      v: versionSchema,
      type: z.literal("terminal.unroute"),
      terminalId: idSchema,
    })
    .strict(),
  z
    .object({
      v: versionSchema,
      type: z.literal("terminal.output"),
      terminalId: idSchema,
      chunk: terminalOutputChunkSchema,
    })
    .strict(),
  z
    .object({
      v: versionSchema,
      type: z.literal("terminal.resync"),
      terminalId: idSchema,
    })
    .strict(),
  z
    .object({
      v: versionSchema,
      type: z.literal("shutdown"),
    })
    .strict(),
]);
export type TerminalDataPlaneMainMessage = z.infer<
  typeof terminalDataPlaneMainMessageSchema
>;

export const terminalDataPlaneChildMessageSchema = z.discriminatedUnion(
  "type",
  [
    z
      .object({
        v: versionSchema,
        type: z.literal("ready"),
        pid: z.number().int().positive(),
      })
      .strict(),
    z
      .object({
        v: versionSchema,
        type: z.literal("browser.attached"),
        attachId: idSchema,
      })
      .strict(),
    z
      .object({
        v: versionSchema,
        type: z.literal("browser.rejected"),
        attachId: idSchema,
        code: z.string().min(1),
        message: z.string().min(1),
      })
      .strict(),
    z
      .object({
        v: versionSchema,
        type: z.literal("browser.detached"),
        attachId: idSchema,
        terminalId: idSchema,
        lastAckedSeq: seqSchema.nullable(),
      })
      .strict(),
    z
      .object({
        v: versionSchema,
        type: z.literal("browser.control"),
        attachId: idSchema,
        terminalId: idSchema,
        message: browserControlClientMessageSchema,
      })
      .strict(),
    z
      .object({
        v: versionSchema,
        type: z.literal("browser.resync"),
        attachId: idSchema,
        terminalId: idSchema,
        fromSeq: seqSchema,
      })
      .strict(),
    z
      .object({
        v: versionSchema,
        type: z.literal("daemon.attached"),
        daemonSessionId: idSchema,
      })
      .strict(),
    z
      .object({
        v: versionSchema,
        type: z.literal("daemon.detached"),
        daemonSessionId: idSchema,
      })
      .strict(),
    z
      .object({
        v: versionSchema,
        type: z.literal("terminal.input-activity"),
        terminalId: idSchema,
        at: z.number().int().nonnegative(),
      })
      .strict(),
    z
      .object({
        v: versionSchema,
        type: z.literal("terminal.output-batch"),
        terminalId: idSchema,
        daemonSessionId: idSchema,
        chunks: z.array(terminalOutputChunkSchema).min(1),
      })
      .strict(),
    z
      .object({
        v: versionSchema,
        type: z.literal("terminal.input"),
        attachId: idSchema,
        terminalId: idSchema,
        dataBase64: z.string(),
      })
      .strict(),
    z
      .object({
        v: versionSchema,
        type: z.literal("terminal.ack"),
        attachId: idSchema,
        terminalId: idSchema,
        nextSeq: seqSchema,
      })
      .strict(),
    z
      .object({
        v: versionSchema,
        type: z.literal("terminal.visibility"),
        attachId: idSchema,
        terminalId: idSchema,
        visible: z.boolean(),
      })
      .strict(),
    z
      .object({
        v: versionSchema,
        type: z.literal("stats"),
        rssBytes: z.number().int().nonnegative(),
        browserSockets: z.number().int().nonnegative(),
        daemonSockets: z.number().int().nonnegative(),
        droppedMisroutedFrames: z.number().int().nonnegative(),
      })
      .strict(),
  ],
);
export type TerminalDataPlaneChildMessage = z.infer<
  typeof terminalDataPlaneChildMessageSchema
>;

export type TerminalDataPlaneIpcDirection = "main-to-child" | "child-to-main";
export type TerminalDataPlaneIpcRejection =
  | "malformed"
  | "unsupported-version"
  | "wrong-direction";

export class TerminalDataPlaneIpcError extends Error {
  readonly direction: TerminalDataPlaneIpcDirection;
  readonly rejection: TerminalDataPlaneIpcRejection;

  constructor(
    direction: TerminalDataPlaneIpcDirection,
    rejection: TerminalDataPlaneIpcRejection,
    detail: string,
  ) {
    super(`Rejected ${direction} terminal data plane message: ${detail}`);
    this.name = "TerminalDataPlaneIpcError";
    this.direction = direction;
    this.rejection = rejection;
  }
}

const versionEnvelopeSchema = z.object({ v: z.unknown() }).passthrough();

function rejectTerminalDataPlaneMessage(
  direction: TerminalDataPlaneIpcDirection,
  raw: unknown,
  acceptedInOtherDirection: boolean,
  detail: string,
): never {
  const envelope = versionEnvelopeSchema.safeParse(raw);
  if (envelope.success && envelope.data.v !== TERMINAL_DATA_PLANE_IPC_VERSION) {
    throw new TerminalDataPlaneIpcError(
      direction,
      "unsupported-version",
      `version ${String(envelope.data.v)} is not ${TERMINAL_DATA_PLANE_IPC_VERSION}`,
    );
  }
  if (acceptedInOtherDirection) {
    throw new TerminalDataPlaneIpcError(
      direction,
      "wrong-direction",
      "the message belongs to the other direction",
    );
  }
  throw new TerminalDataPlaneIpcError(direction, "malformed", detail);
}

export function parseTerminalDataPlaneMainToChildMessage(
  raw: unknown,
): TerminalDataPlaneMainMessage {
  const parsed = terminalDataPlaneMainMessageSchema.safeParse(raw);
  if (parsed.success) {
    return parsed.data;
  }
  return rejectTerminalDataPlaneMessage(
    "main-to-child",
    raw,
    terminalDataPlaneChildMessageSchema.safeParse(raw).success,
    parsed.error.message,
  );
}

export function parseTerminalDataPlaneChildToMainMessage(
  raw: unknown,
): TerminalDataPlaneChildMessage {
  const parsed = terminalDataPlaneChildMessageSchema.safeParse(raw);
  if (parsed.success) {
    return parsed.data;
  }
  return rejectTerminalDataPlaneMessage(
    "child-to-main",
    raw,
    terminalDataPlaneMainMessageSchema.safeParse(raw).success,
    parsed.error.message,
  );
}
