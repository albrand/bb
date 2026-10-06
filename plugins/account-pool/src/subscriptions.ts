import type { AccountSummary } from "./contracts.js";

type IdentityRecord = Pick<
  AccountSummary,
  | "id"
  | "provider"
  | "email"
  | "accountUuid"
  | "organizationUuid"
  | "codexAccountId"
  | "subscriptionType"
  | "rateLimitTier"
>;

type SubscriptionRecord = IdentityRecord &
  Pick<
    AccountSummary,
    "signInExpired" | "enabled" | "status" | "active" | "lastUsedAt"
  >;

function normalizedEmail(account: IdentityRecord): string {
  return account.email?.trim().toLowerCase() ?? "";
}

function loginKey(
  account: IdentityRecord,
  emailByAccountUuid: ReadonlyMap<string, string>,
): string | null {
  const email = normalizedEmail(account);
  if (account.provider === "codex")
    return email === ""
      ? null
      : `codex:${email}:${account.codexAccountId ?? ""}`;
  if (email !== "") return `claude:${email}`;
  if (account.accountUuid === null) return null;
  const known = emailByAccountUuid.get(account.accountUuid);
  return known === undefined
    ? `claude:uuid:${account.accountUuid}`
    : `claude:${known}`;
}

function byId(left: { id: string }, right: { id: string }): number {
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function plan(account: IdentityRecord): string | null {
  return account.rateLimitTier ?? account.subscriptionType;
}

export function subscriptionKeys(
  accounts: readonly IdentityRecord[],
): Map<string, string> {
  const keys = new Map<string, string>();
  const logins = new Map<string, IdentityRecord[]>();
  const emailByAccountUuid = new Map<string, string>();
  const ordered = [...accounts].sort(byId);
  for (const account of ordered) {
    const email = normalizedEmail(account);
    if (
      account.provider === "claude" &&
      account.accountUuid !== null &&
      email !== "" &&
      !emailByAccountUuid.has(account.accountUuid)
    )
      emailByAccountUuid.set(account.accountUuid, email);
  }
  for (const account of ordered) {
    const login = loginKey(account, emailByAccountUuid);
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
  if (difference !== 0) return difference < 0;
  if (candidate.active !== current.active) return candidate.active;
  const recency = (candidate.lastUsedAt ?? -1) - (current.lastUsedAt ?? -1);
  if (recency !== 0) return recency > 0;
  return byId(candidate, current) < 0;
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

export function subscriptionMembers<T extends IdentityRecord>(
  accounts: readonly T[],
  accountId: string,
): T[] {
  const keys = subscriptionKeys(accounts);
  const key = keys.get(accountId);
  return key === undefined
    ? []
    : accounts.filter((account) => keys.get(account.id) === key);
}

export function foldSubscriptions<T extends SubscriptionRecord>(
  accounts: readonly T[],
): T[] {
  const kept = new Set(
    representatives(accounts, subscriptionKeys(accounts)).values(),
  );
  return accounts.filter((account) => kept.has(account));
}
