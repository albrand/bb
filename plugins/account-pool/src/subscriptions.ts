import type { AccountSummary } from "./contracts.js";

type SubscriptionRecord = Pick<
  AccountSummary,
  | "id"
  | "provider"
  | "email"
  | "codexAccountId"
  | "subscriptionType"
  | "rateLimitTier"
  | "signInExpired"
  | "enabled"
  | "status"
  | "active"
>;

export function subscriptionKey(
  account: Pick<
    SubscriptionRecord,
    | "id"
    | "provider"
    | "email"
    | "codexAccountId"
    | "subscriptionType"
    | "rateLimitTier"
  >,
): string {
  const email = account.email?.trim().toLowerCase() ?? "";
  if (email === "") return `record:${account.id}`;
  const organization =
    account.provider === "codex"
      ? (account.codexAccountId ?? "")
      : (account.rateLimitTier ?? account.subscriptionType ?? "");
  return `${account.provider}:${email}:${organization}`;
}

function health(account: SubscriptionRecord): number {
  if (account.signInExpired) return 4;
  if (!account.enabled) return 3;
  if (account.status === "error") return 2;
  if (account.status === "held" || account.status === "exhausted") return 1;
  return 0;
}

function represents(
  candidate: SubscriptionRecord,
  current: SubscriptionRecord,
): boolean {
  const difference = health(candidate) - health(current);
  return difference === 0
    ? candidate.active && !current.active
    : difference < 0;
}

export function subscriptionRepresentatives<T extends SubscriptionRecord>(
  accounts: readonly T[],
): Map<string, T> {
  const chosen = new Map<string, T>();
  for (const account of accounts) {
    const key = subscriptionKey(account);
    const current = chosen.get(key);
    if (current === undefined || represents(account, current))
      chosen.set(key, account);
  }
  return chosen;
}

export function foldSubscriptions<T extends SubscriptionRecord>(
  accounts: readonly T[],
): T[] {
  const kept = new Set(subscriptionRepresentatives(accounts).values());
  return accounts.filter((account) => kept.has(account));
}
