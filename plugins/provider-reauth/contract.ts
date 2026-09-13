import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const REAUTH_NOTIFICATION_CHANNEL = "provider-reauth";

export const REAUTH_PROVIDERS = ["claude-code", "codex"] as const;
export const reauthProviderSchema = z.enum(REAUTH_PROVIDERS);
export type ReauthProviderId = z.infer<typeof reauthProviderSchema>;

export const reauthOutcomeSchema = z.enum([
  "renewed",
  "timed-out",
  "headless",
  "failed",
]);
export type ReauthOutcome = z.infer<typeof reauthOutcomeSchema>;

export const reauthNotificationSchema = z
  .object({
    id: z.string().min(1),
    outcome: reauthOutcomeSchema,
    providerId: reauthProviderSchema,
    providerName: z.string().min(1),
    hostId: z.string().min(1),
    resumedTurns: z.number().int().nonnegative(),
    title: z.string().min(1),
    body: z.string().min(1),
    canRetry: z.boolean(),
  })
  .strict();
export type ReauthNotification = z.infer<typeof reauthNotificationSchema>;

export const reauthStartInputSchema = z
  .object({
    providerId: reauthProviderSchema,
    hostId: z.string().min(1),
  })
  .strict();

export const reauthStartOutputSchema = z
  .object({
    started: z.boolean(),
    reason: z.enum([
      "started",
      "already-running",
      "cooling-down",
      "already-ready",
    ]),
  })
  .strict();

export const reauthStatusOutputSchema = z
  .object({
    running: z.array(
      z.object({
        providerId: reauthProviderSchema,
        hostId: z.string().min(1),
        startedAt: z.number().int().nonnegative(),
        waitingTurns: z.number().int().nonnegative(),
      }),
    ),
  })
  .strict();

export const providerReauthRpcContract = defineRpcContract({
  "reauth.start": {
    input: reauthStartInputSchema,
    output: reauthStartOutputSchema,
  },
  "reauth.status": {
    input: z.object({}).strict(),
    output: reauthStatusOutputSchema,
  },
});
