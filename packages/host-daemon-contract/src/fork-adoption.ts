import { z } from "zod";

export const hostDaemonActiveTurnsRequestSchema = z
  .object({
    sessionId: z.string().min(1),
    threadIds: z.array(z.string().min(1)).max(1_000),
  })
  .strict();
export type HostDaemonActiveTurnsRequest = z.infer<
  typeof hostDaemonActiveTurnsRequestSchema
>;

export const hostDaemonActiveTurnsResponseSchema = z
  .object({
    threads: z.array(
      z
        .object({
          threadId: z.string().min(1),
          activeTurnId: z.string().min(1).nullable(),
        })
        .strict(),
    ),
  })
  .strict();
export type HostDaemonActiveTurnsResponse = z.infer<
  typeof hostDaemonActiveTurnsResponseSchema
>;

export const hostDaemonAdoptedThreadSchema = z
  .object({
    threadId: z.string().min(1),
    activeTurnId: z.string().min(1).nullable(),
  })
  .strict();
export type HostDaemonAdoptedThread = z.infer<
  typeof hostDaemonAdoptedThreadSchema
>;

export const hostDaemonDetachNoticeRequestSchema = z
  .object({
    sessionId: z.string().min(1),
    threadIds: z.array(z.string().min(1)).max(1_000),
  })
  .strict();
export type HostDaemonDetachNoticeRequest = z.infer<
  typeof hostDaemonDetachNoticeRequestSchema
>;

export const hostDaemonDetachNoticeResponseSchema = z
  .object({
    recordedThreadIds: z.array(z.string().min(1)),
    expectAdoptionUntil: z.number().int().nonnegative(),
  })
  .strict();
export type HostDaemonDetachNoticeResponse = z.infer<
  typeof hostDaemonDetachNoticeResponseSchema
>;
