import { z } from "zod";
import type { AccountSummary } from "./contracts.js";

export const poolDisplaySchema = z.object({
  plans: z.record(z.string(), z.string().min(1)),
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
