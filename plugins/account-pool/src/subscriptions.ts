import type { AccountSummary } from "./contracts.js";

type SubscriptionRecord = Pick<
  AccountSummary,
  | "id"
  | "provider"
  | "email"
  | "accountUuid"
  | "organizationUuid"
  | "codexAccountId"
  | "subscriptionType"
  | "rateLimitTier"
  | "signInExpired"
  | "enabled"
  | "status"
  | "active"
>;

function loginKey(account: SubscriptionRecord): string | null {
  const email = account.email?.trim().toLowerCase() ?? "";
  if (account.provider === "codex")
    return email === ""
      ? null
      : `codex:${email}:${account.codexAccountId ?? ""}`;
  if (email !== "") return `claude:${email}`;
  return account.accountUuid === null
    ? null
    : `claude:uuid:${account.accountUuid}`;
}

function plan(account: SubscriptionRecord): string | null {
  return account.rateLimitTier ?? account.subscriptionType;
}

export function subscriptionKeys(
  accounts: readonly SubscriptionRecord[],
): Map<string, string> {
  const keys = new Map<string, string>();
  const logins = new Map<string, SubscriptionRecord[]>();
  for (const account of accounts) {
    const login = loginKey(account);
    if (login === null) keys.set(account.id, `record:${account.id}`);
    else logins.set(login, [...(logins.get(login) ?? []), account]);
  }
  for (const [login, members] of logins) {
    const organizations = [
      ...new Set(
        members.flatMap(({ organizationUuid }) =>
          organizationUuid === null ? [] : [organizationUuid],
        ),
      ),
    ];
    for (const member of members) {
      if (member.provider === "codex" || organizations.length < 2) {
        keys.set(member.id, login);
        continue;
      }
      const organization =
        member.organizationUuid ??
        members.find(
          (other) =>
            other.organizationUuid !== null && plan(other) === plan(member),
        )?.organizationUuid ??
        organizations[0];
      keys.set(member.id, `${login}:${organization}`);
    }
  }
  return keys;
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

function representatives<T extends SubscriptionRecord>(
  accounts: readonly T[],
  keys: Map<string, string>,
): Map<string, T> {
  const chosen = new Map<string, T>();
  for (const account of accounts) {
    const key = keys.get(account.id) ?? `record:${account.id}`;
    const current = chosen.get(key);
    if (current === undefined || represents(account, current))
      chosen.set(key, account);
  }
  return chosen;
}

export function subscriptionRepresentative<T extends SubscriptionRecord>(
  accounts: readonly T[],
  accountId: string,
): T | undefined {
  const keys = subscriptionKeys(accounts);
  const key = keys.get(accountId);
  return key === undefined
    ? undefined
    : representatives(accounts, keys).get(key);
}

export function foldSubscriptions<T extends SubscriptionRecord>(
  accounts: readonly T[],
): T[] {
  const kept = new Set(
    representatives(accounts, subscriptionKeys(accounts)).values(),
  );
  return accounts.filter((account) => kept.has(account));
}
