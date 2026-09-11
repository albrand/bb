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
