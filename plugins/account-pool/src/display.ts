import { z } from "zod";
import { familyQuotaSchema } from "./contracts.js";
import type { AccountSummary } from "./contracts.js";

export const modelWeeklySchema = z.record(
  z.string().trim().min(1),
  familyQuotaSchema,
);
export type ModelWeekly = z.infer<typeof modelWeeklySchema>;

export const poolDisplaySchema = z.object({
  plans: z.record(z.string(), z.string().min(1)),
  weekly: z.record(z.string(), modelWeeklySchema).default({}),
});

export type PoolDisplay = z.infer<typeof poolDisplaySchema>;

export function displayPlanLabel(
  account: Pick<AccountSummary, "subscriptionType" | "rateLimitTier">,
  displayName: string | null = null,
): string | null {
  if (displayName !== null) return displayName;
  const max = account.rateLimitTier?.match(/max_(\d+)x/u);
  if (max) return `Max (${max[1]}x)`;
  const plan = account.subscriptionType;
  return plan ? plan.charAt(0).toUpperCase() + plan.slice(1) : null;
}

export function modelWeeklyRows(
  account: Pick<AccountSummary, "familyWeekly">,
  models: ModelWeekly | undefined,
  now = Date.now(),
) {
  const windows = models ?? account.familyWeekly;
  return Object.entries(windows).flatMap(([name, quota]) =>
    quota === null || (quota.resetAt !== null && quota.resetAt <= now)
      ? []
      : [
          {
            name,
            quota,
          },
        ],
  );
}
