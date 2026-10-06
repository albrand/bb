import type {
  Account,
  AccountBalance,
  AccountPoolConfig,
  AccountQuota,
  AccountSecret,
  ModelFamily,
  PoolProvider,
  PoolStatus,
  LastAutomaticChoice,
} from "./contracts.js";
import { accountBalance, chooseBalancedCandidate } from "./balancer.js";
import { createClaudeAdapter } from "./claude-adapter.js";
import {
  createCodexAdapter,
  DEFAULT_CODEX_REFRESH_URL,
  DEFAULT_CODEX_USAGE_URL,
} from "./codex-adapter.js";
import type { ProviderAdapter } from "./provider-adapter.js";
import type { ImportedProviderAccount } from "./provider-adapter.js";
import {
  isSignInRejection,
  OAuthRefreshError,
  TransientOAuthRefreshError,
} from "./provider-adapter.js";
import type {
  ImportedClaudeCredentials,
  ImportedCodexCredentials,
} from "./credentials.js";
import {
  accountStatus,
  blockingResetAt,
  governingWeeklyResetAt,
  hasExtraUsage,
  isQuotaExhausted,
  isSharedQuotaExhausted,
  isUsageRestricted,
  retryAfterMilliseconds,
} from "./quota.js";
import type {
  AccountBinding,
  AccountStore,
  HubTokenStore,
  PoolAffinityStore,
  QuotaStore,
  RoutingStore,
} from "./store.js";
import type { ThreadTokenStore, ThreadRoute } from "./thread-tokens.js";
import { parentRequestHeaders, type ParentPool } from "./parent-pool.js";

const ROUTE = "/api/v1/plugins/account-pool/http";
const DEFAULT_REFRESH_URL = "https://platform.claude.com/v1/oauth/token";
const DEFAULT_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const DEFAULT_PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";
const DEFAULT_USAGE_REFRESH_INTERVAL_MS = 5 * 60 * 1_000;
const EXHAUSTED_USAGE_REFRESH_INTERVAL_MS = 30 * 1_000;
const MAX_INLINE_HOLD_MS = 20_000;
const MAX_REFRESH_BACKOFF_MS = 60_000;
const MAX_REFRESH_BACKOFFS = 1_024;
const UPSTREAM_REJECTION_HOLD_MS = 60_000;
const MAX_FAILURE_DETAIL_BYTES = 1_024;
const FAILURE_DISPOSAL_TIMEOUT_MS = 250;
const AFFINITY_IDLE_TTL_MS = 30 * 60 * 1_000;
const MAX_AFFINITY_BINDINGS = 4_096;
const DROPPED_RESPONSE_HEADERS = new Set([
  "content-encoding",
  "content-length",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

interface HubOptions {
  accounts: AccountStore;
  quotas: QuotaStore;
  affinity: PoolAffinityStore;
  maxAffinityBindings: number;
  hubTokens: HubTokenStore;
  threadTokens: ThreadTokenStore | null;
  routing: RoutingStore | null;
  getSettings: () => AccountPoolConfig;
  adapters: ReadonlyMap<PoolProvider, ProviderAdapter>;
  fetch: typeof fetch;
  now: () => number;
  drainTimeoutMs: number;
  getParentRoute: () => ParentPool | null;
  onAccountsChanged: () => void;
  onUpstreamError: (provider: PoolProvider, error: unknown) => void;
  onOAuthRefresh: (
    provider: PoolProvider,
    accountId: string,
    outcome: "succeeded" | "failed",
    message: string,
  ) => void;
}

interface SelectedAccount {
  account: Account;
  quota: AccountQuota;
  keepAffinity: boolean;
  automaticChoice: LastAutomaticChoice | null;
  accept: () => void;
}

interface ActiveAccount {
  accountId: string;
}

interface PacingFlight {
  heldUntil: number;
  result: Promise<void>;
}

interface RoutingAttempt {
  binding: AccountBinding | null;
  active: ActiveAccount | null;
  pinnedAccountId: string | null;
  selectionAccountId: string | null;
}

export interface BindingPreview {
  boundAccountId: string | null;
  nextAccountId: string | null;
  reason: string;
  headroom: Array<{
    accountId: string;
    balance: AccountBalance;
    eligible: boolean;
  }>;
}

export interface NextAccountPreview {
  nextAccountId: string | null;
  reason: string;
}

interface UpstreamResult {
  response: Response;
  controller: AbortController;
  release: () => void;
}

interface RefreshBackoff {
  kind: "proactive" | "rejected" | "upstream";
  accessToken: string;
  retryAt: number;
  delayMs: number;
  error: TransientOAuthRefreshError;
}

type SecretUse = { kind: "normal" } | { kind: "rejected"; accessToken: string };

type SecretFlight =
  | { kind: "refresh"; use: SecretUse; result: Promise<AccountSecret> }
  | { kind: "rejection-check"; result: Promise<void> };

interface FailureSummary {
  status: number;
  message: string;
  headers: Record<string, string>;
}

class UpstreamConnectionError extends Error {}

export class AccountPoolHub {
  private accepting = false;
  private stopped = new AbortController();
  private readonly inFlightByAccount = new Map<string, number>();
  private readonly activeControllers = new Set<AbortController>();
  private readonly refreshes = new Map<string, SecretFlight>();
  private readonly refreshBackoffs = new Map<string, RefreshBackoff>();
  private readonly pacingByAccount = new Map<string, PacingFlight>();
  private affinityBindings = new Map<string, AccountBinding>();
  private activeAccounts = new Map<PoolProvider, ActiveAccount>();
  private readonly usageRefreshes = new Map<string, Promise<boolean>>();
  private readonly lastUsageRefreshAt = new Map<string, number>();
  private readonly drainWaiters = new Set<() => void>();

  constructor(private readonly options: HubOptions) {}

  async start(signal: AbortSignal): Promise<void> {
    this.affinityBindings = this.options.affinity.loadBindings(
      this.options.now() - AFFINITY_IDLE_TTL_MS,
      MAX_AFFINITY_BINDINGS,
    );
    this.activeAccounts = this.options.affinity.loadActiveAccounts();
    this.pacingByAccount.clear();
    this.stopped = new AbortController();
    this.accepting = true;
    while (!signal.aborted) {
      await this.refreshUsage();
      await waitForDelay(DEFAULT_USAGE_REFRESH_INTERVAL_MS, signal);
    }
    await this.stop();
  }

  async authenticate(request: Request): Promise<string | null> {
    const token =
      request.headers.get("x-bb-account-pool-token") ??
      readBearer(request.headers.get("authorization"));
    const route = await this.options.threadTokens?.authenticate(token);
    return route?.hostId ?? this.options.hubTokens.authenticate(token);
  }

  async importAccount(
    provider: PoolProvider,
  ): Promise<ImportedProviderAccount> {
    return this.adapter(provider).importAccount();
  }

  async handle(
    request: Request,
    provider: PoolProvider,
    routePath: string,
  ): Promise<Response> {
    const adapter = this.adapter(provider);
    const token =
      request.headers.get("x-bb-account-pool-token") ??
      readBearer(request.headers.get("authorization"));
    const threadRoute =
      (await this.options.threadTokens?.authenticate(token, provider)) ?? null;
    const hostId =
      threadRoute?.hostId ?? (await this.options.hubTokens.authenticate(token));
    if (hostId === null) {
      return adapter.errorResponse(401, "Invalid Account Pooler bearer token.");
    }
    if (!this.accepting)
      return adapter.errorResponse(
        503,
        "Account Pooler is not accepting requests.",
      );
    if (
      threadRoute !== null &&
      threadRoute.accountId !== null &&
      threadRoute.accountId !== undefined &&
      this.options.routing !== null &&
      ((await this.options.routing.isBypassed(threadRoute.threadId)) ||
        !(await this.options.routing.isProviderEnabled(provider)))
    ) {
      return adapter.errorResponse(
        409,
        "Pooled routing is disabled for this conversation. Start a new turn to use its current routing settings.",
      );
    }
    const parent = this.options.getParentRoute();
    if (parent !== null) {
      if (
        threadRoute?.accountId !== undefined &&
        threadRoute.accountId !== null
      ) {
        return adapter.errorResponse(
          409,
          "An explicit subscription requires a local account pool. Choose Automatic while using a parent pool.",
        );
      }
      return this.forwardToParent(request, adapter, routePath, parent);
    }
    return this.forward(
      request,
      new Uint8Array(await request.arrayBuffer()),
      adapter,
      hostId,
      threadRoute,
    );
  }

  private trackRequest(
    request: Request,
    onRelease?: () => void,
  ): { controller: AbortController; release: () => void } {
    const controller = new AbortController();
    const abortFromRequest = () => controller.abort(request.signal.reason);
    this.activeControllers.add(controller);
    if (request.signal.aborted) abortFromRequest();
    else
      request.signal.addEventListener("abort", abortFromRequest, {
        once: true,
      });
    let released = false;
    return {
      controller,
      release: () => {
        if (released) return;
        released = true;
        request.signal.removeEventListener("abort", abortFromRequest);
        this.activeControllers.delete(controller);
        onRelease?.();
      },
    };
  }

  private async forwardToParent(
    request: Request,
    adapter: ProviderAdapter,
    routePath: string,
    parent: ParentPool,
  ): Promise<Response> {
    const { controller, release } = this.trackRequest(request);
    try {
      const search = new URL(request.url).search;
      const body =
        request.method === "GET" || request.method === "HEAD"
          ? undefined
          : await request.arrayBuffer();
      const response = await this.options
        .fetch(`${parent.baseUrl}${routePath}${search}`, {
          method: request.method,
          headers: parentRequestHeaders(request.headers, parent.token),
          ...(body === undefined ? {} : { body }),
          signal: controller.signal,
        })
        .catch((cause: unknown) => {
          if (!controller.signal.aborted)
            this.options.onUpstreamError(adapter.provider, cause);
          throw new UpstreamConnectionError("Parent pool unreachable.", {
            cause,
          });
        });
      return this.clientResponse({ response, controller, release });
    } catch (error) {
      release();
      if (request.signal.aborted)
        return adapter.errorResponse(
          499,
          "Account Pooler request was canceled.",
        );
      if (error instanceof UpstreamConnectionError)
        return adapter.errorResponse(
          502,
          "Account Pooler could not reach the parent pool.",
        );
      throw error;
    }
  }

  async refreshUsage(accountId?: string, force = false): Promise<boolean> {
    const accounts = (await this.options.accounts.list()).filter(
      (account) =>
        account.enabled &&
        account.kind === "oauth" &&
        (accountId === undefined || account.id === accountId),
    );
    const refreshed = await Promise.all(
      accounts.map((account) =>
        this.refreshAccountUsage(
          account,
          force ? 0 : DEFAULT_USAGE_REFRESH_INTERVAL_MS,
          force,
        ),
      ),
    );
    return refreshed.every(Boolean);
  }

  private async refreshExhaustedUsage(
    candidateIds: ReadonlySet<string>,
    attempted: ReadonlySet<string>,
    family: ModelFamily,
  ): Promise<void> {
    const now = this.options.now();
    const threshold = this.options.getSettings().switchThreshold;
    const accounts = (await this.options.accounts.list()).filter((account) => {
      if (
        !candidateIds.has(account.id) ||
        attempted.has(account.id) ||
        !account.enabled ||
        account.kind !== "oauth"
      )
        return false;
      const quota = this.options.quotas.get(account.id);
      return (
        quota.error === null && isQuotaExhausted(quota, family, threshold, now)
      );
    });
    await Promise.all(
      accounts.map((account) =>
        this.refreshAccountUsage(account, EXHAUSTED_USAGE_REFRESH_INTERVAL_MS),
      ),
    );
  }

  private async refreshAccountUsage(
    account: Account,
    minIntervalMs: number,
    recoverError = false,
  ): Promise<boolean> {
    const adapter = this.adapter(account.provider);
    if ((this.inFlightByAccount.get(account.id) ?? 0) > 0) return true;
    const running = this.usageRefreshes.get(account.id);
    if (running !== undefined) return running;
    const now = this.options.now();
    const last = this.lastUsageRefreshAt.get(account.id);
    if (last !== undefined && now - last < minIntervalMs) return true;
    this.lastUsageRefreshAt.set(account.id, now);
    const recover =
      recoverError && this.options.quotas.get(account.id).error !== null;
    const refresh = adapter
      .refreshUsage({
        account,
        freshSecret: () =>
          this.freshSecret(account, adapter, { kind: "normal" }, recover).catch(
            (error: unknown) => {
              if (recover && !(error instanceof TransientOAuthRefreshError))
                this.markError(account.id, errorMessage(error));
              throw error;
            },
          ),
        accounts: this.options.accounts,
        quotas: this.options.quotas,
        fetch: this.options.fetch,
        now: this.options.now,
      })
      .then(
        () => true,
        () => false,
      )
      .finally(() => this.usageRefreshes.delete(account.id));
    this.usageRefreshes.set(account.id, refresh);
    return refresh;
  }

  async stop(): Promise<void> {
    this.accepting = false;
    this.stopped.abort(new Error("Account Pooler stopped accepting requests."));
    if (this.inFlightCount() === 0) return;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    await Promise.race([
      new Promise<void>((resolve) => this.drainWaiters.add(resolve)),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, this.options.drainTimeoutMs);
      }),
    ]);
    if (timeout !== null) clearTimeout(timeout);
    if (this.inFlightCount() === 0) return;
    for (const controller of this.activeControllers) {
      controller.abort(
        new Error(
          "Account Pooler stopped before the upstream response completed.",
        ),
      );
    }
  }

  async status(): Promise<Omit<PoolStatus, "routing" | "parent">> {
    const settings = this.options.getSettings();
    const now = this.options.now();
    const automaticChoices = this.options.affinity.loadAutomaticChoices();
    const accounts = (await this.options.accounts.list()).sort(
      (left, right) => left.priority - right.priority,
    );
    return {
      route: ROUTE,
      enabledAccountCount: accounts.filter((account) => account.enabled).length,
      inFlight: this.inFlightCount(),
      accepting: this.accepting,
      hosts: await this.options.hubTokens.list(),
      accounts: accounts.map((account) => {
        const quota = this.options.quotas.get(account.id);
        const { accountId: _accountId, ...quotaFields } = quota;
        return {
          ...account,
          active:
            this.activeAccounts.get(account.provider)?.accountId === account.id,
          balance: accountBalance(quota, null, now),
          lastAutomaticChoice:
            automaticChoices.get(`${account.provider}:${account.id}`) ?? null,
          lastUsedHostName: null,
          ...quotaFields,
          inFlight: this.inFlightByAccount.get(account.id) ?? 0,
          status: accountStatus(account, quota, settings.switchThreshold, now),
          signInExpired: isSignInRejection(quota.error),
        };
      }),
    };
  }

  async bindingPreview(threadId: string | null): Promise<BindingPreview> {
    const preview = await this.previewAccountChoice("claude");
    const now = this.options.now();
    let binding: AccountBinding | null = null;
    for (const [key, value] of this.affinityBindings) {
      let identity: unknown;
      try {
        identity = JSON.parse(key);
      } catch {
        continue;
      }
      if (
        Array.isArray(identity) &&
        identity[0] === "claude" &&
        identity[2] === threadId &&
        value.lastUsedAt > (binding?.lastUsedAt ?? 0) &&
        now - value.lastUsedAt < AFFINITY_IDLE_TTL_MS
      )
        binding = value;
    }
    const bindingEligibleIds = new Set(preview.bindingEligibleAccountIds);
    const status = await this.options.accounts.list();
    const account =
      binding === null
        ? null
        : status.find(
            (candidate) =>
              candidate.id === binding?.accountId &&
              candidate.provider === "claude" &&
              candidate.enabled &&
              bindingEligibleIds.has(candidate.id),
          );
    const headroom = preview.headroom;
    return {
      boundAccountId: account?.id ?? null,
      nextAccountId: preview.nextAccountId,
      reason: preview.reason,
      headroom,
    };
  }

  async nextAccountPreview(provider: PoolProvider): Promise<
    NextAccountPreview & {
      headroom: Array<{
        accountId: string;
        balance: AccountBalance;
        eligible: boolean;
      }>;
    }
  > {
    const preview = await this.previewAccountChoice(provider);
    return {
      nextAccountId: preview.nextAccountId,
      reason: preview.reason,
      headroom: preview.headroom,
    };
  }

  private async previewAccountChoice(provider: PoolProvider): Promise<
    NextAccountPreview & {
      headroom: Array<{
        accountId: string;
        balance: AccountBalance;
        eligible: boolean;
      }>;
      bindingEligibleAccountIds: string[];
    }
  > {
    const now = this.options.now();
    const threshold = this.options.getSettings().switchThreshold;
    const enabled = (await this.options.accounts.list()).filter(
      (account) => account.provider === provider && account.enabled,
    );
    const available = enabled
      .map((account) => ({
        account,
        quota: this.options.quotas.get(account.id),
      }))
      .filter(
        ({ quota }) =>
          quota.error === null &&
          !isUsageRestricted(quota, now) &&
          (!isSharedQuotaExhausted(quota, threshold, now) ||
            hasExtraUsage(quota)),
      );
    let eligible = available.filter(
      ({ quota }) =>
        !isQuotaExhausted(quota, "other", threshold, now) ||
        hasExtraUsage(quota),
    );
    const included = eligible.filter(
      ({ quota }) => !isQuotaExhausted(quota, "other", threshold, now),
    );
    if (
      included.some(
        ({ quota }) => quota.heldUntil === null || quota.heldUntil <= now,
      )
    )
      eligible = included;
    const bindingEligibleAccountIds = eligible.map(({ account }) => account.id);
    eligible = eligible.filter(
      ({ quota }) => quota.heldUntil === null || quota.heldUntil <= now,
    );
    const eligibleIds = new Set(eligible.map(({ account }) => account.id));
    const choice = chooseBalancedCandidate(
      eligible,
      "other",
      now,
      this.activeAccounts.get(provider)?.accountId ?? null,
    );
    return {
      nextAccountId: choice.candidate?.account.id ?? null,
      reason: choice.reason,
      headroom: enabled.map((account) => ({
        accountId: account.id,
        balance: accountBalance(this.options.quotas.get(account.id), null, now),
        eligible: eligibleIds.has(account.id),
      })),
      bindingEligibleAccountIds,
    };
  }

  private async forward(
    request: Request,
    body: Uint8Array,
    adapter: ProviderAdapter,
    hostId: string,
    threadRoute: ThreadRoute | null = null,
  ): Promise<Response> {
    const signal = AbortSignal.any([request.signal, this.stopped.signal]);
    const attempted = new Set<string>();
    const waited = new Set<string>();
    const routing: RoutingAttempt = {
      binding: null,
      active: null,
      pinnedAccountId: null,
      selectionAccountId: threadRoute?.accountId ?? null,
    };
    let previousAccountId: string | null = null;
    let failure: FailureSummary | null = null;
    let usageRefreshed = false;
    const accounts = (await this.options.accounts.list()).filter(
      (account) =>
        account.provider === adapter.provider &&
        (routing.selectionAccountId === null ||
          account.id === routing.selectionAccountId),
    );
    if (routing.selectionAccountId !== null && accounts.length === 0) {
      return adapter.errorResponse(
        404,
        "The selected subscription no longer exists. Choose another subscription or Automatic.",
      );
    }
    const candidateIds = new Set(accounts.map((account) => account.id));
    const parsed = adapter.parseRequest(body, request.headers);
    const family = parsed.family;
    const affinityKey =
      parsed.affinityId === null
        ? null
        : JSON.stringify(
            threadRoute === null
              ? [adapter.provider, hostId, parsed.affinityId]
              : [
                  adapter.provider,
                  hostId,
                  threadRoute.threadId,
                  parsed.affinityId,
                ],
          );
    const parentAffinityKey =
      affinityKey === null || parsed.parentAffinityId === null
        ? null
        : JSON.stringify(
            threadRoute === null
              ? [adapter.provider, hostId, parsed.parentAffinityId]
              : [
                  adapter.provider,
                  hostId,
                  threadRoute.threadId,
                  parsed.parentAffinityId,
                ],
          );
    try {
      while (attempted.size < candidateIds.size) {
        signal.throwIfAborted();
        const selected = await this.select(
          adapter.provider,
          candidateIds,
          attempted,
          family,
          affinityKey,
          parentAffinityKey,
          previousAccountId,
          routing,
          signal,
        );
        if (
          !usageRefreshed &&
          (selected === null ||
            isQuotaExhausted(
              selected.quota,
              family,
              this.options.getSettings().switchThreshold,
              this.options.now(),
            ))
        ) {
          usageRefreshed = true;
          await abortable(
            this.refreshExhaustedUsage(candidateIds, attempted, family),
            signal,
          );
          continue;
        }
        if (selected === null) break;
        let pacing: PacingFlight | null = null;
        const heldMs = (selected.quota.heldUntil ?? 0) - this.options.now();
        let activePacing = this.pacingByAccount.get(selected.account.id);
        if (
          activePacing !== undefined &&
          (activePacing.heldUntil !== selected.quota.heldUntil || heldMs <= 0)
        ) {
          this.releasePacing(selected.account.id, activePacing);
          activePacing = undefined;
        }
        if (heldMs > 0) {
          if (activePacing !== undefined) {
            pacing = activePacing;
            waited.add(selected.account.id);
            await abortable(activePacing.result, signal);
          } else if (
            heldMs > MAX_INLINE_HOLD_MS ||
            waited.has(selected.account.id)
          ) {
            failure = {
              status: 429,
              message:
                "The current Account Pooler account is temporarily rate limited.",
              headers: { "retry-after": String(Math.ceil(heldMs / 1_000)) },
            };
            if (selected.keepAffinity)
              return adapter.errorResponse(
                failure.status,
                failure.message,
                failure.headers,
              );
            attempted.add(selected.account.id);
            previousAccountId = selected.account.id;
            continue;
          } else {
            waited.add(selected.account.id);
            await waitForDelay(heldMs, signal);
            continue;
          }
        }
        attempted.add(selected.account.id);
        previousAccountId = selected.account.id;
        const changed = await this.options.accounts.recordUsed(
          selected.account.id,
          this.options.now(),
          hostId,
        );
        if (changed) this.options.onAccountsChanged();
        let secret: AccountSecret;
        try {
          signal.throwIfAborted();
          secret = await abortable(
            this.freshSecret(selected.account, adapter, { kind: "normal" }),
            signal,
          );
        } catch (error) {
          if (pacing !== null) {
            this.releasePacing(selected.account.id, pacing);
            pacing = null;
          }
          signal.throwIfAborted();
          if (error instanceof TransientOAuthRefreshError) {
            failure = { status: 503, message: error.message, headers: {} };
          } else {
            this.markError(selected.account.id, errorMessage(error));
          }
          continue;
        }
        let authRetried = false;
        let paced = waited.has(selected.account.id);
        while (true) {
          signal.throwIfAborted();
          let upstream: UpstreamResult;
          try {
            upstream = await this.fetchUpstream(
              request,
              parsed.forAccount(selected.account),
              selected.account,
              secret,
              adapter,
            );
          } catch (error) {
            if (pacing !== null) {
              this.releasePacing(selected.account.id, pacing);
              pacing = null;
            }
            signal.throwIfAborted();
            if (!(error instanceof UpstreamConnectionError)) throw error;
            failure = {
              status: 502,
              message:
                "Account Pooler could not reach " + adapter.upstreamName + ".",
              headers: {},
            };
            break;
          }
          if (request.signal.aborted) {
            await this.discardUpstream(upstream, false);
            signal.throwIfAborted();
          }
          const { response } = upstream;
          const observed = adapter.quotaFromHeaders(
            selected.account.id,
            response.headers,
            this.options.quotas.get(selected.account.id),
            family,
            this.options.now(),
          );
          this.options.quotas.put(observed);
          if (pacing !== null && !response.ok) {
            this.releasePacing(selected.account.id, pacing);
            pacing = null;
          }
          if (response.status === 429) {
            if (adapter.isQuotaRejection(response.headers)) {
              await this.discardUpstream(upstream, false);
              break;
            }
            const waitMs = retryAfterMilliseconds(
              response.headers.get("retry-after"),
              this.options.now(),
            );
            const heldUntil = this.options.now() + waitMs;
            this.options.quotas.put({
              ...observed,
              heldUntil,
            });
            if (!paced && waitMs <= MAX_INLINE_HOLD_MS) {
              paced = true;
              pacing = {
                heldUntil,
                result: waitForDelay(waitMs, this.stopped.signal),
              };
              this.pacingByAccount.set(selected.account.id, pacing);
              await this.discardUpstream(upstream, false);
              await abortable(pacing.result, signal);
              continue;
            }
            if (!selected.keepAffinity) {
              failure = {
                status: 429,
                message: await this.discardUpstream(upstream, true),
                headers: { "retry-after": String(Math.ceil(waitMs / 1_000)) },
              };
              break;
            }
          }
          if (
            response.status === 401 ||
            response.status === 403 ||
            response.status === 408 ||
            response.status === 500 ||
            response.status === 502 ||
            response.status === 503 ||
            response.status === 504 ||
            response.status === 529
          ) {
            const retryAfter = response.headers.get("retry-after");
            const detail = await this.discardUpstream(upstream, true);
            signal.throwIfAborted();
            failure = {
              status: response.status,
              message:
                detail ||
                adapter.upstreamName +
                  " returned HTTP " +
                  response.status +
                  ".",
              headers: retryAfter === null ? {} : { "retry-after": retryAfter },
            };
            const rejected = response.status === 401 || response.status === 403;
            if (rejected && secret.kind === "oauth" && !authRetried) {
              authRetried = true;
              try {
                secret = await abortable(
                  this.freshSecret(selected.account, adapter, {
                    kind: "rejected",
                    accessToken: secret.accessToken,
                  }),
                  signal,
                );
              } catch (error) {
                signal.throwIfAborted();
                if (error instanceof TransientOAuthRefreshError) {
                  failure = {
                    status: 503,
                    message: error.message,
                    headers: {},
                  };
                } else {
                  const message = errorMessage(error);
                  await this.rejectCredential(
                    selected.account,
                    secret,
                    signal,
                    () => this.markError(selected.account.id, message),
                  );
                }
                break;
              }
              continue;
            }
            if (rejected && secret.kind === "oauth") {
              const accessToken = secret.accessToken;
              const hold = new TransientOAuthRefreshError(
                adapter.upstreamName +
                  " returned HTTP " +
                  response.status +
                  " for a freshly refreshed credential, so the Account Pooler is treating it as an upstream failure: " +
                  failure.message,
                0,
              );
              failure = { status: 503, message: hold.message, headers: {} };
              await this.rejectCredential(
                selected.account,
                secret,
                signal,
                () =>
                  this.holdUpstreamRejection(
                    selected.account.id,
                    accessToken,
                    hold,
                  ),
              );
            } else if (rejected) {
              const message = failure.message;
              await this.rejectCredential(
                selected.account,
                secret,
                signal,
                () => this.markError(selected.account.id, message),
              );
            }
            break;
          }
          if (response.ok) selected.accept();
          return this.clientResponse(upstream);
        }
      }
      signal.throwIfAborted();
      return failure === null
        ? this.noEligibleResponse(accounts, family, adapter)
        : adapter.errorResponse(
            failure.status,
            failure.message,
            failure.headers,
          );
    } catch (error) {
      if (!signal.aborted) throw error;
      return adapter.errorResponse(
        request.signal.aborted ? 499 : 503,
        request.signal.aborted
          ? "Account Pooler request was canceled."
          : "Account Pooler stopped accepting requests.",
      );
    }
  }

  private async discardUpstream(
    upstream: UpstreamResult,
    readDetail: boolean,
  ): Promise<string> {
    const reader = upstream.response.body?.getReader();
    if (reader === undefined) {
      upstream.controller.abort();
      upstream.release();
      return "";
    }
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<string>((resolve) => {
      timeout = setTimeout(() => resolve(""), FAILURE_DISPOSAL_TIMEOUT_MS);
    });
    let detail = "";
    try {
      if (!readDetail) return detail;
      return await Promise.race([
        (async () => {
          const decoder = new TextDecoder();
          let bytes = 0;
          while (bytes < MAX_FAILURE_DETAIL_BYTES) {
            const chunk = await reader.read();
            if (chunk.done) break;
            const part = chunk.value.subarray(
              0,
              MAX_FAILURE_DETAIL_BYTES - bytes,
            );
            bytes += part.byteLength;
            detail += decoder.decode(part, { stream: true });
          }
          return (detail + decoder.decode()).trim();
        })().catch(() => detail.trim()),
        deadline,
      ]);
    } finally {
      upstream.controller.abort();
      await Promise.race([reader.cancel().catch(() => undefined), deadline]);
      clearTimeout(timeout);
      upstream.release();
    }
  }

  private async rejectCredential(
    account: Account,
    rejected: AccountSecret,
    signal: AbortSignal,
    apply: () => void,
  ): Promise<void> {
    if (rejected.kind !== "oauth") {
      apply();
      return;
    }
    while (true) {
      signal.throwIfAborted();
      const existing = this.refreshes.get(account.id);
      if (existing !== undefined) {
        await abortable(
          existing.result.then(
            () => undefined,
            () => undefined,
          ),
          signal,
        );
        continue;
      }
      const flight: SecretFlight = {
        kind: "rejection-check",
        result: this.options.accounts
          .readSecret(account.id)
          .then((current) => {
            const backoff = this.refreshBackoffs.get(account.id);
            if (
              !signal.aborted &&
              current.kind === "oauth" &&
              current.accessToken === rejected.accessToken &&
              !(
                backoff !== undefined &&
                backoff.kind !== "proactive" &&
                backoff.accessToken === current.accessToken
              )
            ) {
              apply();
            }
          })
          .finally(() => {
            if (this.refreshes.get(account.id) === flight)
              this.refreshes.delete(account.id);
          }),
      };
      this.refreshes.set(account.id, flight);
      await abortable(flight.result, signal);
      return;
    }
  }

  private async select(
    provider: PoolProvider,
    candidateIds: ReadonlySet<string>,
    attempted: ReadonlySet<string>,
    family: ModelFamily,
    affinityKey: string | null,
    parentAffinityKey: string | null,
    previousAccountId: string | null,
    routing: RoutingAttempt,
    signal: AbortSignal,
  ): Promise<SelectedAccount | null> {
    const accounts = (await this.options.accounts.list()).sort(
      (left, right) => left.priority - right.priority,
    );
    signal.throwIfAborted();
    const now = this.options.now();
    const threshold = this.options.getSettings().switchThreshold;
    const available = accounts
      .filter((account) => account.provider === provider && account.enabled)
      .map((account) => ({
        account,
        quota: this.options.quotas.get(account.id),
      }))
      .filter(
        ({ quota }) => quota.error === null && !isUsageRestricted(quota, now),
      )
      .filter(
        ({ quota }) =>
          !isSharedQuotaExhausted(quota, threshold, now) ||
          hasExtraUsage(quota),
      );
    let eligible = available.filter(
      ({ quota }) =>
        !isQuotaExhausted(quota, family, threshold, now) ||
        hasExtraUsage(quota),
    );
    const included = eligible.filter(
      ({ quota }) => !isQuotaExhausted(quota, family, threshold, now),
    );
    if (
      included.some(
        ({ account, quota }) =>
          candidateIds.has(account.id) &&
          !attempted.has(account.id) &&
          (quota.heldUntil === null || quota.heldUntil <= now),
      )
    ) {
      eligible = included;
    }
    const unattempted = eligible.filter(
      ({ account }) =>
        candidateIds.has(account.id) && !attempted.has(account.id),
    );
    const candidates = unattempted.filter(
      ({ quota }) => quota.heldUntil === null || quota.heldUntil <= now,
    );
    let binding =
      affinityKey === null ? undefined : this.affinityBindings.get(affinityKey);
    const boundAccountId =
      binding !== undefined && now - binding.lastUsedAt < AFFINITY_IDLE_TTL_MS
        ? binding.accountId
        : null;
    const bound =
      boundAccountId !== null
        ? eligible.find(({ account }) => account.id === boundAccountId)
        : undefined;
    const boundIsHeld =
      bound !== undefined &&
      bound.quota.heldUntil !== null &&
      bound.quota.heldUntil > now;
    let inherited: (typeof candidates)[number] | undefined;
    if (bound === undefined && parentAffinityKey !== null) {
      const parent = this.affinityBindings.get(parentAffinityKey);
      if (
        parent !== undefined &&
        now - parent.lastUsedAt < AFFINITY_IDLE_TTL_MS
      ) {
        inherited = unattempted.find(
          ({ account }) => account.id === parent.accountId,
        );
      }
    }
    let active = this.activeAccounts.get(provider);
    const activeAccount = eligible.find(
      ({ account }) => account.id === active?.accountId,
    );
    const balanced =
      provider === "claude"
        ? chooseBalancedCandidate(
            candidates,
            family,
            now,
            activeAccount?.account.id ?? null,
          )
        : {
            candidate: candidates[0] ?? null,
            reason: "priority tie-break",
          };
    const selectedBound =
      bound !== undefined && unattempted.includes(bound) ? bound : null;
    const anchorId = previousAccountId ?? boundAccountId ?? active?.accountId;
    const anchorIndex = accounts.findIndex(
      (account) => account.id === anchorId,
    );
    const ordered = [
      ...accounts.slice(anchorIndex + 1),
      ...accounts.slice(0, anchorIndex + 1),
    ];
    const next = ordered
      .map((account) =>
        candidates.find((candidate) => candidate.account.id === account.id),
      )
      .find((candidate) => candidate !== undefined);
    const legacyAutomatic =
      boundAccountId === null &&
      previousAccountId === null &&
      activeAccount !== undefined &&
      unattempted.includes(activeAccount)
        ? activeAccount
        : (next ?? null);
    const selected =
      selectedBound ??
      inherited ??
      (provider === "claude" ? balanced.candidate : legacyAutomatic);
    if (selected === null) return null;
    const choiceReason =
      selectedBound !== null || inherited !== undefined
        ? null
        : balanced.reason;
    const automaticChoice =
      provider !== "claude" ||
      choiceReason === null ||
      routing.selectionAccountId !== null
        ? null
        : {
            chosenAt: now,
            reason: choiceReason,
            family,
            balance: accountBalance(selected.quota, family, now),
          };
    if (routing.active === null)
      routing.pinnedAccountId = boundAccountId ?? inherited?.account.id ?? null;
    if (affinityKey !== null && binding === undefined) {
      binding = { accountId: selected.account.id, lastUsedAt: now };
      this.affinityBindings.set(affinityKey, binding);
    }
    if (binding !== undefined && binding.accountId === selected.account.id) {
      binding.lastUsedAt = now;
      if (affinityKey !== null) {
        this.affinityBindings.delete(affinityKey);
        this.affinityBindings.set(affinityKey, binding);
      }
    }
    while (this.affinityBindings.size > this.options.maxAffinityBindings) {
      const oldest = this.affinityBindings.keys().next();
      if (!oldest.done) {
        this.affinityBindings.delete(oldest.value);
        this.options.affinity.removeBinding(oldest.value);
      }
    }
    if (active === undefined) {
      active = { accountId: selected.account.id };
      if (routing.selectionAccountId === null)
        this.activeAccounts.set(provider, active);
    }
    routing.binding ??= binding ?? null;
    routing.active ??= active;
    const familyDetour = (accountId: string | null) =>
      available.some(
        ({ account, quota }) =>
          account.id === accountId &&
          !isSharedQuotaExhausted(quota, threshold, now) &&
          isQuotaExhausted(quota, family, threshold, now),
      );
    const rebind =
      affinityKey !== null &&
      !familyDetour(boundAccountId) &&
      (bound === undefined ||
        bound.account.id === selected.account.id ||
        (binding === routing.binding &&
          attempted.has(bound.account.id) &&
          !boundIsHeld));
    const advance =
      routing.selectionAccountId === null &&
      !familyDetour(active.accountId) &&
      (activeAccount === undefined ||
        active.accountId === selected.account.id ||
        (active === routing.active && attempted.has(active.accountId)) ||
        (provider === "claude" && automaticChoice !== null));
    return {
      ...selected,
      keepAffinity:
        selected.account.id === routing.pinnedAccountId &&
        (provider !== "claude" || routing.selectionAccountId !== null),
      automaticChoice,
      accept: () => {
        if (automaticChoice !== null) {
          this.options.affinity.putAutomaticChoice(
            provider,
            selected.account.id,
            automaticChoice,
          );
        }
        if (rebind && this.affinityBindings.get(affinityKey) === binding) {
          const accepted = {
            accountId: selected.account.id,
            lastUsedAt: this.options.now(),
          };
          this.options.affinity.putBinding(affinityKey, accepted);
          this.affinityBindings.delete(affinityKey);
          this.affinityBindings.set(affinityKey, accepted);
        }
        if (advance && this.activeAccounts.get(provider) === active) {
          this.options.affinity.putActiveAccount(provider, selected.account.id);
          this.activeAccounts.set(provider, { accountId: selected.account.id });
        }
      },
    };
  }

  private async freshSecret(
    account: Account,
    adapter: ProviderAdapter,
    use: SecretUse,
    recover = false,
  ): Promise<AccountSecret> {
    while (true) {
      const existing = this.refreshes.get(account.id);
      if (existing !== undefined) {
        if (existing.kind === "rejection-check") {
          await existing.result;
          continue;
        }
        let secret: AccountSecret;
        try {
          secret = await existing.result;
        } catch (error) {
          const current = this.refreshes.get(account.id);
          if (current !== undefined && current !== existing) continue;
          throw error;
        }
        const current = this.refreshes.get(account.id);
        if (current !== undefined && current !== existing) continue;
        const backoff = this.refreshBackoffs.get(account.id);
        if (
          secret.kind === "oauth" &&
          backoff?.accessToken === secret.accessToken &&
          backoff.kind !== "proactive"
        )
          continue;
        if (
          use.kind === "normal" ||
          secret.kind !== "oauth" ||
          secret.accessToken !== use.accessToken ||
          (existing.use.kind === "rejected" &&
            existing.use.accessToken === use.accessToken)
        ) {
          return secret;
        }
        continue;
      }
      const flight: Extract<SecretFlight, { kind: "refresh" }> = {
        kind: "refresh",
        use,
        result: this.options.accounts
          .readSecret(account.id)
          .then(async (secret) => {
            let backoff = this.refreshBackoffs.get(account.id);
            if (
              secret.kind !== "oauth" ||
              backoff?.accessToken !== secret.accessToken
            ) {
              this.refreshBackoffs.delete(account.id);
              backoff = undefined;
            }
            const explicitlyRejected =
              secret.kind === "oauth" &&
              use.kind === "rejected" &&
              secret.accessToken === use.accessToken;
            const forceRefresh =
              recover || explicitlyRejected || backoff?.kind === "rejected";
            if (forceRefresh && secret.kind === "oauth") {
              flight.use = {
                kind: "rejected",
                accessToken: secret.accessToken,
              };
            }
            const error = this.options.quotas.get(account.id).error;
            if (error !== null && !recover) throw new Error(error);
            if (
              !recover &&
              backoff !== undefined &&
              this.options.now() < backoff.retryAt &&
              (!explicitlyRejected || backoff.kind !== "proactive")
            ) {
              if (
                backoff.kind === "proactive" &&
                !forceRefresh &&
                secret.kind === "oauth" &&
                secret.expiresAt !== null &&
                secret.expiresAt > this.options.now()
              ) {
                return secret;
              }
              throw backoff.error;
            }
            try {
              const result = await adapter.refreshSecret({
                account,
                secret,
                accounts: this.options.accounts,
                quotas: this.options.quotas,
                fetch: this.options.fetch,
                now: this.options.now,
                forceRefresh,
              });
              this.refreshBackoffs.delete(account.id);
              if (result.refreshed) {
                this.options.onOAuthRefresh(
                  account.provider,
                  account.id,
                  "succeeded",
                  `previousExpiresAt=${secret.kind === "oauth" ? secret.expiresAt : null}, expiresAt=${result.secret.kind === "oauth" ? result.secret.expiresAt : null}, forced=${forceRefresh}.`,
                );
                const quota = this.options.quotas.get(account.id);
                this.options.quotas.put({ ...quota, error: null });
              }
              return result.secret;
            } catch (error) {
              this.options.onOAuthRefresh(
                account.provider,
                account.id,
                "failed",
                `${error instanceof OAuthRefreshError ? error.message : "Stored credential refresh failed."} expiresAt=${secret.kind === "oauth" ? secret.expiresAt : null}, forced=${forceRefresh}.`,
              );
              if (
                !(error instanceof TransientOAuthRefreshError) ||
                secret.kind !== "oauth"
              ) {
                this.refreshBackoffs.delete(account.id);
                throw error;
              }
              const delayMs = Math.min(
                MAX_REFRESH_BACKOFF_MS,
                Math.max(
                  backoff === undefined ? 1_000 : backoff.delayMs * 2,
                  error.retryAfterMs,
                ),
              );
              this.refreshBackoffs.delete(account.id);
              this.refreshBackoffs.set(account.id, {
                kind: forceRefresh ? "rejected" : "proactive",
                accessToken: secret.accessToken,
                retryAt: this.options.now() + delayMs,
                delayMs,
                error,
              });
              while (this.refreshBackoffs.size > MAX_REFRESH_BACKOFFS) {
                const oldest = this.refreshBackoffs.keys().next();
                if (!oldest.done) this.refreshBackoffs.delete(oldest.value);
              }
              if (
                !forceRefresh &&
                secret.expiresAt !== null &&
                secret.expiresAt > this.options.now()
              ) {
                return secret;
              }
              throw error;
            }
          })
          .finally(() => {
            if (this.refreshes.get(account.id) === flight)
              this.refreshes.delete(account.id);
          }),
      };
      this.refreshes.set(account.id, flight);
      return flight.result;
    }
  }

  private async fetchUpstream(
    request: Request,
    body: Uint8Array,
    account: Account,
    secret: AccountSecret,
    adapter: ProviderAdapter,
  ): Promise<UpstreamResult> {
    this.increment(account.id);
    const { controller, release } = this.trackRequest(request, () =>
      this.decrement(account.id),
    );
    try {
      const upstreamBody = new ArrayBuffer(body.byteLength);
      new Uint8Array(upstreamBody).set(body);
      const url = adapter.upstreamUrl(request, this.options.getSettings());
      const headers = adapter.requestHeaders(request.headers, account, secret);
      const response = await this.options
        .fetch(url, {
          method: request.method,
          headers,
          ...(request.method === "GET" || request.method === "HEAD"
            ? {}
            : { body: upstreamBody }),
          signal: controller.signal,
        })
        .catch((cause: unknown) => {
          if (!controller.signal.aborted)
            this.options.onUpstreamError(adapter.provider, cause);
          throw new UpstreamConnectionError("Upstream connection failed.", {
            cause,
          });
        });
      return { response, controller, release };
    } catch (error) {
      release();
      throw error;
    }
  }

  private clientResponse(upstream: UpstreamResult): Response {
    const headers = new Headers();
    for (const [name, value] of upstream.response.headers) {
      if (!DROPPED_RESPONSE_HEADERS.has(name.toLowerCase()))
        headers.append(name, value);
    }
    if (upstream.response.body === null) {
      upstream.release();
      return new Response(null, {
        status: upstream.response.status,
        statusText: upstream.response.statusText,
        headers,
      });
    }
    const reader = upstream.response.body.getReader();
    const eventStream =
      upstream.response.headers
        .get("content-type")
        ?.split(";", 1)[0]
        ?.trim()
        .toLowerCase() === "text/event-stream";
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const chunk = await reader.read();
          if (chunk.done) {
            upstream.release();
            controller.close();
          } else controller.enqueue(chunk.value);
        } catch (error) {
          upstream.release();
          if (!eventStream) {
            controller.error(
              error instanceof Error ? error : new Error(String(error)),
            );
            return;
          }
          controller.enqueue(
            new TextEncoder().encode(
              `event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "api_error", message: errorMessage(error) } })}\n\n`,
            ),
          );
          controller.close();
        }
      },
      async cancel() {
        upstream.controller.abort();
        await reader.cancel().catch(() => undefined);
        upstream.release();
      },
    });
    return new Response(body, {
      status: upstream.response.status,
      statusText: upstream.response.statusText,
      headers,
    });
  }

  private noEligibleResponse(
    accounts: readonly Account[],
    family: ModelFamily,
    adapter: ProviderAdapter,
  ): Response {
    if (!accounts.some((account) => account.enabled)) {
      return adapter.errorResponse(
        503,
        "Account Pooler has no enabled account",
      );
    }
    const now = this.options.now();
    const threshold = this.options.getSettings().switchThreshold;
    const next = accounts
      .filter((account) => account.enabled)
      .flatMap((account) => {
        const quota = this.options.quotas.get(account.id);
        if (quota.error !== null) return [];
        const quotaResetAt = hasExtraUsage(quota)
          ? null
          : blockingResetAt(quota, family, threshold, now);
        if (
          quotaResetAt === null &&
          isQuotaExhausted(quota, family, threshold, now) &&
          !hasExtraUsage(quota)
        )
          return [];
        const resetAt = Math.max(quota.heldUntil ?? 0, quotaResetAt ?? 0);
        return resetAt > now ? [resetAt] : [];
      })
      .sort((left, right) => left - right)[0];
    const retryAfter = Math.max(
      1,
      Math.ceil(((next ?? now + 1_000) - now) / 1_000),
    );
    return adapter.errorResponse(
      429,
      "No Account Pooler account is currently eligible.",
      { "retry-after": String(retryAfter) },
    );
  }

  private holdUpstreamRejection(
    accountId: string,
    accessToken: string,
    error: TransientOAuthRefreshError,
  ): void {
    this.refreshBackoffs.delete(accountId);
    this.refreshBackoffs.set(accountId, {
      kind: "upstream",
      accessToken,
      retryAt: this.options.now() + UPSTREAM_REJECTION_HOLD_MS,
      delayMs: UPSTREAM_REJECTION_HOLD_MS,
      error,
    });
    while (this.refreshBackoffs.size > MAX_REFRESH_BACKOFFS) {
      const oldest = this.refreshBackoffs.keys().next();
      if (!oldest.done) this.refreshBackoffs.delete(oldest.value);
    }
  }

  private markError(accountId: string, message: string): void {
    const quota = this.options.quotas.get(accountId);
    this.options.quotas.put({ ...quota, error: message.slice(0, 1_000) });
  }

  private releasePacing(accountId: string, pacing: PacingFlight): void {
    if (this.pacingByAccount.get(accountId) === pacing)
      this.pacingByAccount.delete(accountId);
  }

  private adapter(provider: PoolProvider): ProviderAdapter {
    const adapter = this.options.adapters.get(provider);
    if (adapter === undefined)
      throw new Error(`Missing ${provider} Account Pooler adapter.`);
    return adapter;
  }

  private increment(accountId: string): void {
    this.inFlightByAccount.set(
      accountId,
      (this.inFlightByAccount.get(accountId) ?? 0) + 1,
    );
  }

  private decrement(accountId: string): void {
    const next = Math.max(0, (this.inFlightByAccount.get(accountId) ?? 1) - 1);
    if (next === 0) this.inFlightByAccount.delete(accountId);
    else this.inFlightByAccount.set(accountId, next);
    if (this.inFlightCount() !== 0) return;
    for (const resolve of this.drainWaiters) resolve();
    this.drainWaiters.clear();
  }

  private inFlightCount(): number {
    let total = 0;
    for (const count of this.inFlightByAccount.values()) total += count;
    return total;
  }
}

export function createHub(options: {
  accounts: AccountStore;
  quotas: QuotaStore;
  affinity: PoolAffinityStore;
  hubTokens: HubTokenStore;
  threadTokens?: ThreadTokenStore;
  routing?: RoutingStore;
  getSettings: () => AccountPoolConfig;
  fetch?: typeof fetch;
  now?: () => number;
  refreshUrl?: string;
  codexRefreshUrl?: string;
  codexUsageUrl?: string;
  importClaudeCredentials?: () => Promise<ImportedClaudeCredentials>;
  importCodexCredentials?: () => Promise<ImportedCodexCredentials>;
  usageUrl?: string;
  profileUrl?: string;
  drainTimeoutMs?: number;
  maxAffinityBindings?: number;
  getParentRoute?: () => ParentPool | null;
  onAccountsChanged?: () => void;
  onUpstreamError?: (provider: PoolProvider, error: unknown) => void;
  onOAuthRefresh?: HubOptions["onOAuthRefresh"];
}): AccountPoolHub {
  const adapters: ReadonlyMap<PoolProvider, ProviderAdapter> = new Map([
    [
      "claude",
      createClaudeAdapter({
        refreshUrl: options.refreshUrl ?? DEFAULT_REFRESH_URL,
        usageUrl: options.usageUrl ?? DEFAULT_USAGE_URL,
        profileUrl: options.profileUrl ?? DEFAULT_PROFILE_URL,
        importCredentials: options.importClaudeCredentials,
      }),
    ],
    [
      "codex",
      createCodexAdapter({
        refreshUrl: options.codexRefreshUrl ?? DEFAULT_CODEX_REFRESH_URL,
        usageUrl: options.codexUsageUrl ?? DEFAULT_CODEX_USAGE_URL,
        importCredentials: options.importCodexCredentials,
      }),
    ],
  ]);
  return new AccountPoolHub({
    accounts: options.accounts,
    quotas: options.quotas,
    affinity: options.affinity,
    maxAffinityBindings: options.maxAffinityBindings ?? MAX_AFFINITY_BINDINGS,
    hubTokens: options.hubTokens,
    threadTokens: options.threadTokens ?? null,
    routing: options.routing ?? null,
    getSettings: options.getSettings,
    adapters,
    fetch: options.fetch ?? fetch,
    now: options.now ?? Date.now,
    drainTimeoutMs: options.drainTimeoutMs ?? 60_000,
    getParentRoute: options.getParentRoute ?? (() => null),
    onAccountsChanged: options.onAccountsChanged ?? (() => {}),
    onUpstreamError: options.onUpstreamError ?? (() => {}),
    onOAuthRefresh: options.onOAuthRefresh ?? (() => {}),
  });
}

function readBearer(value: string | null): string | null {
  if (value === null) return null;
  return /^Bearer\s+(.+)$/iu.exec(value)?.[1] ?? null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function waitForDelay(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    timeout.unref();
    const abort = () => {
      clearTimeout(timeout);
      resolve();
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    operation.then(
      (result) => {
        signal.removeEventListener("abort", abort);
        resolve(result);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}
