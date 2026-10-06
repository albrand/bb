import type {
  Account,
  AccountSecret,
  AccountSummary,
  HubTokenSummary,
  LocalLogin,
  PoolProvider,
  PoolStatus,
  RoutedThreadStatus,
} from "./contracts.js";
import type { AccountAddInput } from "./contracts.js";
import type { AccountPoolHub } from "./hub.js";
import type {
  AccountStore,
  HubTokenStore,
  QuotaStore,
  RoutingStore,
} from "./store.js";
import type { ClaudeOAuthAccount } from "./oauth-login.js";
import type { CodexDeviceAccount } from "./codex-device-login.js";
import { subscriptionMembers } from "./subscriptions.js";

interface PoolHost {
  id: string;
  name: string;
}

interface PoolProviderState {
  providerId: string;
  displayName: string;
  status: string;
  accountEmail: string | null;
  planLabel: string | null;
}

const ROUTED_WINDOW_MS = 24 * 60 * 60 * 1_000;

function poolProviderFor(providerId: string): PoolProvider | null {
  if (providerId === "claude-code") return "claude";
  if (providerId === "codex") return "codex";
  return null;
}

function sameEmail(left: string | null, right: string | null): boolean {
  return (
    left !== null &&
    right !== null &&
    left.trim().toLowerCase() === right.trim().toLowerCase()
  );
}

interface LoginIdentity {
  id: string | null;
  email: string | null;
}

function compareLogins(
  stored: LoginIdentity,
  presented: LoginIdentity,
): "same" | "different" | "unverified" {
  if (stored.id !== null && presented.id !== null)
    return stored.id === presented.id ? "same" : "different";
  if (stored.email !== null && presented.email !== null)
    return sameEmail(stored.email, presented.email) ? "same" : "different";
  return "unverified";
}

function requireSameLogin(
  account: Account,
  stored: LoginIdentity,
  presented: LoginIdentity,
  different: string,
): void {
  const match = compareLogins(stored, presented);
  if (match === "different") throw new Error(different);
  if (match === "unverified")
    throw new Error(
      `bb couldn't confirm that this sign-in is the account behind ${account.label}; it was not changed. Try again, or remove it and add the login again.`,
    );
}

function providerName(provider: PoolProvider): string {
  return provider === "claude" ? "Claude" : "Codex";
}

export class PoolOperations {
  constructor(
    private readonly accounts: AccountStore,
    private readonly quotas: QuotaStore,
    private readonly hub: AccountPoolHub,
    private readonly hubTokens: HubTokenStore,
    private readonly routing: RoutingStore,
    private readonly listHosts: () => Promise<PoolHost[]>,
    private readonly providerStates: (
      hostId: string | null,
    ) => Promise<PoolProviderState[]>,
    private readonly now: () => number = Date.now,
    private readonly onAccountsChanged: () => void = () => {},
    private readonly onAccountEnabled: (
      accountId: string,
    ) => Promise<void> = async () => {},
    private readonly parentStatus: () => Promise<
      PoolStatus["parent"]
    > = async () => null,
    private readonly threadState: (threadId: string) => Promise<{
      providerId: string;
      status: string;
      queued: boolean;
    }> = async () => {
      throw new Error("Thread routing state is unavailable.");
    },
  ) {}

  async add(input: AccountAddInput): Promise<Account> {
    const priority =
      input.priority ?? (await this.nextPriority(input.provider));
    if (input.source.kind === "api-key") {
      if (input.provider !== "claude") {
        throw new Error("Codex accounts can only be added with --import.");
      }
      const account = await this.accounts.add(
        {
          provider: input.provider,
          kind: "api-key",
          label: input.label ?? "Claude API key",
          email: null,
          accountUuid: null,
          subscriptionType: null,
          rateLimitTier: null,
          enabled: true,
          priority,
        },
        { kind: "api-key", apiKey: input.source.apiKey },
      );
      this.onAccountsChanged();
      await this.onAccountEnabled(account.id);
      return account;
    }
    const imported = await this.hub.importAccount(input.provider);
    const existing = await this.accounts.list();
    const duplicate = existing.some(
      (account) =>
        account.provider === input.provider &&
        (input.provider === "claude"
          ? imported.accountUuid !== null &&
            account.accountUuid === imported.accountUuid
          : imported.codexAccountId !== undefined &&
            account.codexAccountId === imported.codexAccountId),
    );
    if (duplicate) {
      throw new Error("This current login is already in the account pool.");
    }
    const account = await this.accounts.add(
      {
        provider: input.provider,
        kind: "oauth",
        label: input.label ?? imported.label,
        email: imported.email,
        accountUuid: imported.accountUuid ?? null,
        ...(imported.codexAccountId === undefined
          ? {}
          : { codexAccountId: imported.codexAccountId }),
        subscriptionType: imported.subscriptionType,
        rateLimitTier: imported.rateLimitTier,
        enabled: true,
        priority,
      },
      imported.secret,
    );
    if (imported.organizationUuid !== undefined)
      await this.accounts.setOrganization(
        account.id,
        imported.organizationUuid,
      );
    this.onAccountsChanged();
    await this.onAccountEnabled(account.id);
    return account;
  }

  async addOAuth(authenticated: ClaudeOAuthAccount): Promise<Account> {
    const account = await this.accounts.add(
      {
        provider: "claude",
        kind: "oauth",
        label: authenticated.label,
        email: authenticated.email,
        accountUuid: authenticated.accountUuid,
        subscriptionType: authenticated.subscriptionType,
        rateLimitTier: authenticated.rateLimitTier,
        enabled: true,
        priority: await this.nextPriority("claude"),
      },
      {
        kind: "oauth",
        accessToken: authenticated.accessToken,
        refreshToken: authenticated.refreshToken,
        expiresAt: authenticated.expiresAt,
      },
    );
    if (authenticated.organizationUuid !== null)
      await this.accounts.setOrganization(
        account.id,
        authenticated.organizationUuid,
      );
    this.onAccountsChanged();
    await this.onAccountEnabled(account.id);
    return account;
  }

  async addCodexOAuth(
    authenticated: CodexDeviceAccount,
  ): Promise<AccountSummary> {
    const account = await this.accounts.add(
      {
        provider: "codex",
        kind: "oauth",
        label: authenticated.label,
        email: authenticated.email,
        accountUuid: null,
        codexAccountId: authenticated.accountId,
        subscriptionType: null,
        rateLimitTier: null,
        enabled: true,
        priority: await this.nextPriority("codex"),
      },
      {
        kind: "oauth",
        accessToken: authenticated.accessToken,
        refreshToken: authenticated.refreshToken,
        idToken: authenticated.idToken,
        expiresAt: authenticated.expiresAt,
      },
    );
    this.onAccountsChanged();
    await this.onAccountEnabled(account.id);
    const summary = (await this.list()).find((item) => item.id === account.id);
    if (summary === undefined) {
      throw new Error("Added Codex account could not be read back.");
    }
    return summary;
  }

  async requireReauthorizable(
    id: string,
    provider: PoolProvider | null,
  ): Promise<Account> {
    const account = await this.accounts.get(id);
    if (account === null)
      throw new Error("This subscription no longer exists.");
    if (provider !== null && account.provider !== provider)
      throw new Error(
        `This subscription belongs to ${providerName(account.provider)}.`,
      );
    if (account.kind !== "oauth")
      throw new Error(
        "An API key can't sign in again. Remove it and add a new key.",
      );
    return account;
  }

  async reauthorizeClaude(
    id: string,
    authenticated: ClaudeOAuthAccount,
    label?: string,
  ): Promise<Account> {
    const account = await this.requireReauthorizable(id, "claude");
    const organizationUuid =
      (await this.accounts.organizations()).get(account.id) ?? null;
    if (
      organizationUuid !== null &&
      authenticated.organizationUuid !== null &&
      organizationUuid !== authenticated.organizationUuid
    )
      throw new Error(
        `That code belongs to a different Claude organization. Sign in to the organization behind ${account.label}; it was not changed.`,
      );
    requireSameLogin(
      account,
      { id: account.accountUuid, email: account.email },
      { id: authenticated.accountUuid, email: authenticated.email },
      `That code belongs to a different Claude account. Sign in as the account behind ${account.label}; it was not changed.`,
    );
    return this.reauthorize(
      account,
      {
        ...(label === undefined ? {} : { label }),
        email: authenticated.email ?? account.email,
        accountUuid: authenticated.accountUuid ?? account.accountUuid,
        subscriptionType:
          authenticated.subscriptionType ?? account.subscriptionType,
        rateLimitTier: authenticated.rateLimitTier ?? account.rateLimitTier,
      },
      {
        kind: "oauth",
        accessToken: authenticated.accessToken,
        refreshToken: authenticated.refreshToken,
        expiresAt: authenticated.expiresAt,
      },
      authenticated.organizationUuid,
    );
  }

  async reauthorizeCodex(
    id: string,
    authenticated: CodexDeviceAccount,
  ): Promise<AccountSummary> {
    const account = await this.requireReauthorizable(id, "codex");
    requireSameLogin(
      account,
      { id: account.codexAccountId ?? null, email: account.email },
      { id: authenticated.accountId, email: authenticated.email },
      `Codex sign-in belongs to a different ChatGPT account. Sign in as the account behind ${account.label}; it was not changed.`,
    );
    const updated = await this.reauthorize(
      account,
      {
        email: authenticated.email ?? account.email,
        codexAccountId: authenticated.accountId,
      },
      {
        kind: "oauth",
        accessToken: authenticated.accessToken,
        refreshToken: authenticated.refreshToken,
        idToken: authenticated.idToken,
        expiresAt: authenticated.expiresAt,
      },
      null,
    );
    const summary = (await this.list()).find((item) => item.id === updated.id);
    if (summary === undefined)
      throw new Error("Codex subscription could not be read back.");
    return summary;
  }

  private async reauthorize(
    account: Account,
    identity: Partial<
      Pick<
        Account,
        | "label"
        | "email"
        | "accountUuid"
        | "codexAccountId"
        | "subscriptionType"
        | "rateLimitTier"
      >
    >,
    secret: AccountSecret,
    organizationUuid: string | null,
  ): Promise<Account> {
    const updated = await this.accounts.replaceCredentials(
      account.id,
      identity,
      secret,
    );
    if (updated === null)
      throw new Error("This subscription no longer exists.");
    if (organizationUuid !== null)
      await this.accounts.setOrganization(updated.id, organizationUuid);
    this.quotas.put({
      ...this.quotas.get(updated.id),
      error: null,
      heldUntil: null,
    });
    this.onAccountsChanged();
    if (updated.enabled) await this.onAccountEnabled(updated.id);
    return updated;
  }

  async localLogins(): Promise<LocalLogin[]> {
    const [states, accounts] = await Promise.all([
      this.providerStates(null),
      this.accounts.list(),
    ]);
    return states.flatMap((state): LocalLogin[] => {
      if (state.status !== "ready" && state.status !== "expired") return [];
      if (state.planLabel === "Proxied") return [];
      if (state.accountEmail === null && state.planLabel === null) return [];
      const poolProvider = poolProviderFor(state.providerId);
      if (
        poolProvider !== null &&
        accounts.some(
          (account) =>
            account.provider === poolProvider &&
            sameEmail(account.email, state.accountEmail),
        )
      )
        return [];
      return [
        {
          providerId: state.providerId,
          displayName: state.displayName,
          email: state.accountEmail,
          planLabel: state.planLabel,
          status: state.status,
          poolProvider,
        },
      ];
    });
  }

  async list(): Promise<AccountSummary[]> {
    return (await this.status()).accounts;
  }

  async remove(id: string): Promise<boolean> {
    const removed = await this.accounts.remove(id);
    if (removed) {
      this.quotas.remove(id);
      this.onAccountsChanged();
    }
    return removed;
  }

  async enable(id: string): Promise<Account | null> {
    const account = await this.accounts.setEnabled(id, true);
    if (account === null) return null;
    const quota = this.quotas.get(id);
    this.quotas.put({ ...quota, error: null, heldUntil: null });
    this.onAccountsChanged();
    await this.onAccountEnabled(account.id);
    return account;
  }

  async disable(id: string): Promise<Account | null> {
    const account = await this.accounts.setEnabled(id, false);
    if (account !== null) this.onAccountsChanged();
    return account;
  }

  async disableSubscription(id: string): Promise<Account[] | null> {
    const accounts = await this.accounts.list();
    if (!accounts.some((account) => account.id === id)) return null;
    const organizations = await this.accounts.organizations();
    const members = subscriptionMembers(
      accounts.map((account) => ({
        ...account,
        organizationUuid: organizations.get(account.id) ?? null,
      })),
      id,
    );
    const disabled = await this.accounts.disableAll(
      members.filter((account) => account.enabled).map(({ id }) => id),
    );
    if (disabled.length > 0) this.onAccountsChanged();
    return disabled;
  }

  async setPriority(id: string, priority: number): Promise<Account | null> {
    const account = await this.accounts.setPriority(id, priority);
    if (account !== null) this.onAccountsChanged();
    return account;
  }

  async rename(id: string, label: string): Promise<Account | null> {
    const account = await this.accounts.rename(id, label);
    if (account !== null) this.onAccountsChanged();
    return account;
  }

  async reorder(provider: PoolProvider, accountIds: string[]): Promise<void> {
    await this.accounts.reorder(provider, accountIds);
    this.onAccountsChanged();
  }

  async refreshUsage(id: string): Promise<AccountSummary | null> {
    if ((await this.accounts.get(id)) === null) return null;
    try {
      if (!(await this.hub.refreshUsage(id, true)))
        throw new Error("Could not refresh account usage. Try again.");
    } finally {
      this.onAccountsChanged();
    }
    return (
      (await this.status()).accounts.find((account) => account.id === id) ??
      null
    );
  }

  async setRouting(provider: PoolProvider, enabled: boolean): Promise<void> {
    await this.routing.setProviderEnabled(provider, enabled);
    this.onAccountsChanged();
  }

  isRoutingEnabled(provider: PoolProvider): Promise<boolean> {
    return this.routing.isProviderEnabled(provider);
  }

  async selectedAccount(
    threadId: string,
    provider: PoolProvider,
  ): Promise<{ accountId: string | null }> {
    return {
      accountId: await this.routing.selectedAccount(threadId, provider),
    };
  }

  bindingPreview(threadId: string) {
    return this.hub.bindingPreview(threadId);
  }

  async nextAccountPreview(provider: PoolProvider) {
    const { nextAccountId, reason } =
      await this.hub.nextAccountPreview(provider);
    return { nextAccountId, reason };
  }

  async selectAccount(
    threadId: string,
    provider: PoolProvider,
    accountId: string | null,
  ): Promise<{ accountId: string | null }> {
    const current = await this.routing.selectedAccount(threadId, provider);
    const thread = await this.threadState(threadId);
    if (
      thread.providerId !== (provider === "claude" ? "claude-code" : "codex")
    ) {
      throw new Error("This subscription belongs to a different provider.");
    }
    if (current === accountId) return { accountId };
    if (
      (thread.status !== "idle" && thread.status !== "error") ||
      thread.queued
    ) {
      throw new Error(
        "Wait for this conversation and its queued messages to finish before changing subscriptions.",
      );
    }
    await this.validateSelection(threadId, provider, accountId);
    await this.routing.selectAccount(threadId, provider, accountId);
    this.onAccountsChanged();
    return { accountId };
  }

  async initializeSelection(
    threadId: string,
    provider: PoolProvider,
    accountId: string,
  ): Promise<void> {
    await this.validateSelection(threadId, provider, accountId);
    await this.routing.selectAccount(threadId, provider, accountId);
  }

  private async validateSelection(
    threadId: string,
    provider: PoolProvider,
    accountId: string | null,
  ): Promise<void> {
    if (accountId === null) return;
    if (
      (await this.routing.isBypassed(threadId)) ||
      !(await this.isRoutingEnabled(provider))
    ) {
      throw new Error("Enable pooled routing before selecting a subscription.");
    }
    if ((await this.parentStatus())?.mode === "proxy") {
      throw new Error("Choose Automatic while using a parent pool.");
    }
    const account = await this.accounts.get(accountId);
    if (account === null || account.provider !== provider || !account.enabled) {
      throw new Error(
        "The selected subscription is missing, disabled, or belongs to another provider.",
      );
    }
    if (this.quotas.get(accountId).error !== null) {
      throw new Error(
        "Repair the selected subscription's login before using it.",
      );
    }
  }

  private async nextPriority(provider: PoolProvider): Promise<number> {
    const accounts = await this.accounts.list();
    const priorities = accounts
      .filter((account) => account.provider === provider)
      .map((account) => account.priority);
    return priorities.length === 0 ? 0 : Math.max(...priorities) + 1;
  }

  async status(): Promise<PoolStatus> {
    const hosts = await this.listHosts();
    await this.hubTokens.prune(hosts.map((host) => host.id));
    const status = await this.hub.status();
    const hostNames = new Map(hosts.map((host) => [host.id, host.name]));
    const [claude, codex] = await Promise.all([
      this.routing.isProviderEnabled("claude"),
      this.routing.isProviderEnabled("codex"),
    ]);
    return {
      ...status,
      hosts: status.hosts.map((token) => ({
        ...token,
        hostName: hostNames.get(token.hostId) ?? null,
      })),
      accounts: status.accounts.map((account) => ({
        ...account,
        lastUsedHostName:
          account.lastUsedHostId === null
            ? null
            : (hostNames.get(account.lastUsedHostId) ?? null),
      })),
      routing: { claude, codex },
      parent: await this.parentStatus(),
    };
  }

  async rotateToken(machine: string): Promise<HubTokenSummary> {
    const hosts = await this.listHosts();
    const matches = hosts.filter(
      (host) => host.id === machine || host.name === machine,
    );
    if (matches.length === 0)
      throw new Error(`Machine ${machine} does not exist.`);
    if (matches.length > 1)
      throw new Error(`Machine name ${machine} matches more than one host.`);
    const host = matches[0];
    if (host === undefined)
      throw new Error(`Machine ${machine} does not exist.`);
    const token = await this.hubTokens.rotate(host.id);
    return { ...token, hostName: host.name };
  }

  async setBypass(
    threadId: string,
    bypassed: boolean,
  ): Promise<{
    threadId: string;
    bypassed: boolean;
  }> {
    await this.routing.setBypassed(threadId, bypassed);
    return { threadId, bypassed };
  }

  async getBypass(threadId: string): Promise<{
    threadId: string;
    bypassed: boolean;
  }> {
    return { threadId, bypassed: await this.routing.isBypassed(threadId) };
  }

  async hasUsableEnabledAccount(provider: PoolProvider): Promise<boolean> {
    for (const account of await this.accounts.list()) {
      if (!account.enabled || account.provider !== provider) continue;
      try {
        await this.accounts.readSecret(account.id);
        return true;
      } catch {
        continue;
      }
    }
    return false;
  }

  async routedThreadsWithoutLocalLogin(): Promise<RoutedThreadStatus[]> {
    const routed = await this.routing.listRoutedSince(
      this.now() - ROUTED_WINDOW_MS,
    );
    const [hosts, statesByHost] = await Promise.all([
      this.listHosts(),
      Promise.all(
        [...new Set(routed.map((entry) => entry.hostId))].map(
          async (hostId) => ({
            hostId,
            states: await this.providerStates(hostId).catch(() => []),
          }),
        ),
      ),
    ]);
    const hostNames = new Map(hosts.map((host) => [host.id, host.name]));
    const localStateByHost = new Map(
      statesByHost.map(({ hostId, states }) => [
        hostId,
        states.find((state) => state.providerId === "claude-code") ?? null,
      ]),
    );
    return routed.flatMap((entry) => {
      const state = localStateByHost.get(entry.hostId);
      const status =
        state?.status === "ready" && state.planLabel === "Proxied"
          ? "proxied"
          : state?.status;
      if (
        status !== "unauthenticated" &&
        status !== "expired" &&
        status !== "proxied"
      )
        return [];
      return [
        {
          ...entry,
          hostName: hostNames.get(entry.hostId) ?? null,
          localClaudeStatus: status,
        },
      ];
    });
  }
}
