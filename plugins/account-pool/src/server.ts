import { registerUsageSource } from "./usage-source.js";
import {
  createUpstreamTransport,
  transportErrorCode,
} from "./upstream-transport.js";
import path from "node:path";
import { z } from "zod";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { registerPoolCli } from "./cli.js";
import {
  accountPoolConfigSchema,
  accountPoolConfigSetInputSchema,
  poolAvailabilitySchema,
  type AccountPoolConfigController,
  type PoolProvider,
  type PoolStatus,
} from "./contracts.js";
import { draftSelectionSchema } from "./contracts.js";
import { ThreadTokenStore, type ThreadLookup } from "./thread-tokens.js";
import {
  AVAILABILITY_PATH,
  PARENT_TOKEN_ENV,
  PARENT_URL_ENV,
  ParentAvailability,
  isParentPoolSelf,
  readParentPool,
  type ParentPool,
} from "./parent-pool.js";
import type {
  ImportedClaudeCredentials,
  ImportedCodexCredentials,
} from "./credentials.js";
import { createHub, waitForDelay } from "./hub.js";
import { PoolOperations } from "./operations.js";
import {
  accountPoolBindingReadRpcContract,
  accountPoolBypassReadRpcContract,
  accountPoolRpcContract,
  createBindingReadRpcHandlers,
  createRpcHandlers,
} from "./rpc.js";
import { ClaudeOAuthLogin } from "./oauth-login.js";
import { CodexDeviceLogin } from "./codex-device-login.js";
import {
  ACCOUNT_POOL_ACCOUNTS_CHANGED,
  ACCOUNT_POOL_CONFIG_CHANGED,
} from "./realtime.js";
import {
  AccountStore,
  HubTokenStore,
  PoolAffinityStore,
  QUOTA_MIGRATIONS,
  QuotaStore,
  RoutingStore,
} from "./store.js";

export interface AccountPoolPluginOptions {
  fetch?: typeof fetch;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
  availabilityTtlMs?: number;
  refreshUrl?: string;
  codexRefreshUrl?: string;
  codexUsageUrl?: string;
  usageUrl?: string;
  drainTimeoutMs?: number;
  threadSweepTimeoutMs?: number;
  threadSweepLookupTimeoutMs?: number;
  threadSweepIntervalMs?: number;
  threadSweepRetryMs?: number;
  maxAffinityBindings?: number;
  disposeTimeoutMs?: number;
  importCredentials?: () => Promise<ImportedClaudeCredentials>;
  importCodexCredentials?: () => Promise<ImportedCodexCredentials>;
  oauthAuthorizeUrl?: string;
  oauthTokenUrl?: string;
  oauthProfileUrl?: string;
  codexAuthBaseUrl?: string;
}

const DISPOSE_INSPECTION_TIMEOUT_MS = 2_000;
const DISPOSE_INSPECTION_TIMEOUT = Symbol("dispose-inspection-timeout");
const THREAD_SWEEP_INTERVAL_MS = 15 * 60_000;
const THREAD_SWEEP_TIMEOUT_MS = 15_000;
const THREAD_SWEEP_LOOKUP_TIMEOUT_MS = 5_000;
const THREAD_SWEEP_RETRY_MS = 60_000;
const HUB_BASE_PATH = "/api/v1/plugins/account-pool/http";

const PROVIDER_ROUTING_ENV: Record<PoolProvider, readonly string[]> = {
  claude: ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN"],
  codex: ["CODEX_OPENAI_BASE_URL", "CODEX_POOL_AUTH_TOKEN"],
};

interface PoolEnvEntry {
  name: string;
  value: string | { serverPath: string };
  reason: string;
}

export function helloResponse(): Response {
  return new Response(null, { status: 200 });
}

export function createAccountPoolPlugin(
  options: AccountPoolPluginOptions = {},
) {
  return async function accountPoolPlugin(bb: BbPluginApi): Promise<void> {
    const storedConfig = z
      .record(z.string(), z.unknown())
      .parse((await bb.storage.kv.get("config")) ?? {});
    const hasRemovedSettings =
      "cacheMissDebug" in storedConfig || "cacheMissMinTokens" in storedConfig;
    delete storedConfig.cacheMissDebug;
    delete storedConfig.cacheMissMinTokens;
    let currentSettings = accountPoolConfigSchema.parse(storedConfig);
    if (hasRemovedSettings) {
      await bb.storage.kv.set("config", currentSettings);
    }
    const config: AccountPoolConfigController = {
      get: () => currentSettings,
      set: async (input) => {
        const update = accountPoolConfigSetInputSchema.parse(input);
        const next = accountPoolConfigSchema.parse({
          ...currentSettings,
          ...update,
        });
        await bb.storage.kv.set("config", next);
        currentSettings = next;
        bb.realtime.publish(ACCOUNT_POOL_CONFIG_CHANGED, {});
        return next;
      },
    };
    const secretDir = path.join(
      bb.server.experimental_dataDir,
      "plugins",
      bb.pluginId,
      "secrets",
      "accounts",
    );
    const accounts = new AccountStore(bb.storage.kv, secretDir);
    await accounts.initialize();
    const now = options.now ?? Date.now;
    const hubTokens = new HubTokenStore(secretDir, now);
    await hubTokens.initialize();
    const enrolledHosts = await bb.sdk.hosts.list();
    await hubTokens.prune(enrolledHosts.map((host) => host.id));
    const threadTokens = new ThreadTokenStore(secretDir, hubTokens);
    await threadTokens.initialize(enrolledHosts.map((host) => host.id));
    const routing = new RoutingStore(bb.storage.kv, now);
    const env = options.env ?? process.env;
    const configuredParentPool = readParentPool(env);
    const hasConfiguredParentPool = configuredParentPool !== null;
    const parentPool = (): ParentPool | null => {
      if (configuredParentPool === null) return null;
      const ownHubUrl = `${bb.server.loopbackBaseUrl.replace(/\/+$/u, "")}${HUB_BASE_PATH}`;
      return isParentPoolSelf(configuredParentPool, ownHubUrl)
        ? null
        : configuredParentPool;
    };
    const proxyingParent = (): ParentPool | null =>
      currentSettings.parentMode === "proxy" ? parentPool() : null;
    const db = bb.storage.database();
    bb.storage.migrate(db, QUOTA_MIGRATIONS);
    const quotas = new QuotaStore(db);
    const transport =
      options.fetch === undefined ? createUpstreamTransport() : null;
    const upstreamFetch = options.fetch ?? transport?.fetch;
    const hub = createHub({
      accounts,
      quotas,
      affinity: new PoolAffinityStore(db),
      hubTokens,
      threadTokens,
      routing,
      getSettings: () => currentSettings,
      fetch: upstreamFetch,
      now,
      refreshUrl: options.refreshUrl,
      codexRefreshUrl: options.codexRefreshUrl,
      codexUsageUrl: options.codexUsageUrl,
      usageUrl: options.usageUrl,
      profileUrl: options.oauthProfileUrl,
      importClaudeCredentials: options.importCredentials,
      importCodexCredentials: options.importCodexCredentials,
      drainTimeoutMs: options.drainTimeoutMs,
      maxAffinityBindings: options.maxAffinityBindings,
      getParentRoute: proxyingParent,
      onUpstreamError: (provider, error) =>
        bb.log.warn(
          `Account Pooler ${provider} transport failed: ${transportErrorCode(error)}.`,
        ),
      onAccountsChanged: () =>
        bb.realtime.publish(ACCOUNT_POOL_ACCOUNTS_CHANGED, {}),
      onOAuthRefresh: (provider, accountId, outcome, detail) => {
        const message = `Account Pooler ${provider} account ${accountId} OAuth refresh ${outcome}: ${detail}`;
        if (outcome === "succeeded") bb.log.info(message);
        else bb.log.warn(message);
      },
    });
    if (transport !== null) {
      bb.onDispose(async () => {
        await hub.stop();
        await transport.destroy();
      });
    }
    const availability =
      configuredParentPool === null
        ? null
        : new ParentAvailability({
            parent: configuredParentPool,
            fetch: upstreamFetch ?? fetch,
            now,
            ...(options.availabilityTtlMs === undefined
              ? {}
              : { ttlMs: options.availabilityTtlMs }),
            onError: (error) =>
              bb.log.warn(
                `Account Pooler could not read parent availability: ${error instanceof Error ? error.message : String(error)}.`,
              ),
          });
    const parentStatus = async (): Promise<PoolStatus["parent"]> => {
      const parent = parentPool();
      return parent === null || availability === null
        ? null
        : {
            baseUrl: parent.baseUrl,
            mode: currentSettings.parentMode,
            availability: await availability.get(),
          };
    };
    const operations = new PoolOperations(
      accounts,
      quotas,
      hub,
      hubTokens,
      routing,
      () => bb.sdk.hosts.list(),
      async (hostId) =>
        (await bb.sdk.system.providerStates(hostId === null ? {} : { hostId }))
          .providers,
      now,
      () => bb.realtime.publish(ACCOUNT_POOL_ACCOUNTS_CHANGED, {}),
      async (accountId) => {
        await hub.refreshUsage(accountId, true);
      },
      parentStatus,
      async (threadId) => {
        const [thread, queue] = await Promise.all([
          bb.sdk.threads.get({ threadId }),
          bb.sdk.threads.queuedMessages.list({ threadId }),
        ]);
        return {
          providerId: thread.providerId,
          status: thread.status,
          queued: queue.length > 0,
        };
      },
    );
    bb.experimental_hooks.on(
      "experimental_thread.configure",
      async ({ thread, data }) => {
        const selection = draftSelectionSchema.parse(data);
        if (
          thread.providerId !==
          (selection.provider === "claude" ? "claude-code" : "codex")
        ) {
          throw new Error(
            "The selected subscription belongs to another provider.",
          );
        }
        await operations.initializeSelection(
          thread.id,
          selection.provider,
          selection.accountId,
        );
        return null;
      },
    );
    bb.events.on("thread.archived", async ({ thread }) => {
      await threadTokens.removeThread(thread.id);
    });
    bb.events.on("thread.unarchived", async ({ thread }) => {
      const archiveVersion = threadTokens.archiveVersion(thread.id);
      const current = await bb.sdk.threads.get({ threadId: thread.id });
      if (current.archivedAt === null) {
        await threadTokens.restoreThread(thread.id, archiveVersion);
      }
    });
    bb.events.on("thread.deleted", async ({ thread }) => {
      await Promise.all([
        threadTokens.removeThread(thread.id),
        routing.removeThread(thread.id),
      ]);
    });
    const login = new ClaudeOAuthLogin({
      fetch: upstreamFetch,
      now,
      authorizeUrl: options.oauthAuthorizeUrl,
      tokenUrl: options.oauthTokenUrl,
      profileUrl: options.oauthProfileUrl,
      addAccount: (authenticated) => operations.addOAuth(authenticated),
      reauthorizeAccount: (accountId, authenticated, label) =>
        operations.reauthorizeClaude(accountId, authenticated, label),
    });
    const codexLogin = new CodexDeviceLogin({
      fetch: upstreamFetch,
      now,
      authBaseUrl: options.codexAuthBaseUrl,
      addAccount: (authenticated) => operations.addCodexOAuth(authenticated),
      reauthorizeAccount: (accountId, authenticated) =>
        operations.reauthorizeCodex(accountId, authenticated),
    });
    if ((await accounts.list()).every((account) => !account.enabled)) {
      bb.status.needsConfiguration(
        "Add and enable a Claude or Codex account with `bb pool account add`.",
      );
    }
    registerUsageSource(bb, hub, (provider) =>
      operations.isRoutingEnabled(provider),
    );
    bb.rpc.register(
      accountPoolRpcContract,
      createRpcHandlers(operations, login, codexLogin, config),
    );
    bb.rpc.register(
      accountPoolBypassReadRpcContract,
      { "bypass.get": ({ threadId }) => operations.getBypass(threadId) },
      { experimental_discoverable: true },
    );
    bb.rpc.register(
      accountPoolBindingReadRpcContract,
      createBindingReadRpcHandlers(operations),
      { experimental_discoverable: true },
    );
    registerPoolCli(bb, operations, login, codexLogin, config);
    const canServe = async (provider: PoolProvider): Promise<boolean> => {
      if (!(await operations.isRoutingEnabled(provider))) return false;
      if (proxyingParent() !== null && availability !== null) {
        return (await availability.get())[provider];
      }
      return operations.hasUsableEnabledAccount(provider);
    };
    const markerEntries = (token: string): PoolEnvEntry[] => [
      {
        name: PARENT_URL_ENV,
        value: { serverPath: HUB_BASE_PATH },
        reason: "Account Pooler hub for nested bb servers on this machine",
      },
      {
        name: PARENT_TOKEN_ENV,
        value: token,
        reason:
          "Account Pooler token scoped to this thread for nested bb servers it launches",
      },
    ];
    const neutralized = (provider: PoolProvider): PoolEnvEntry[] =>
      PROVIDER_ROUTING_ENV[provider].map((name) => ({
        name,
        value: "",
        reason:
          "Account Pooler is isolated from the parent bb server's pool on this instance",
      }));
    const revokeIfArchived = async (threadId: string): Promise<boolean> => {
      const archiveVersion = threadTokens.archiveVersion(threadId);
      const thread = await bb.sdk.threads.get({ threadId });
      if (thread.archivedAt === null) {
        await threadTokens.restoreThread(threadId, archiveVersion);
        return false;
      }
      return threadTokens.removeThreadIfVersion(threadId, archiveVersion);
    };
    const lookupThread: ThreadLookup = async (threadId, signal) => {
      try {
        const thread = await bb.sdk.threads.get({ threadId, signal });
        return thread.archivedAt === null && thread.deletedAt === null
          ? "live"
          : "gone";
      } catch (error) {
        if (isThreadNotFound(error)) return "gone";
        throw error;
      }
    };
    const sweepThreadCredentialsOnce = async (
      serviceSignal: AbortSignal,
    ): Promise<boolean> => {
      try {
        const { checked, revoked, failed } = await threadTokens.sweepThreads(
          lookupThread,
          {
            signal: AbortSignal.any([
              serviceSignal,
              AbortSignal.timeout(
                options.threadSweepTimeoutMs ?? THREAD_SWEEP_TIMEOUT_MS,
              ),
            ]),
            lookupTimeoutMs:
              options.threadSweepLookupTimeoutMs ??
              THREAD_SWEEP_LOOKUP_TIMEOUT_MS,
          },
        );
        if (revoked > 0 || failed > 0) {
          bb.log.warn(
            `Account Pooler thread credential sweep checked ${checked} threads, revoked ${revoked}, and could not look up ${failed}.`,
          );
        }
        return failed === 0;
      } catch {
        bb.log.warn("Account Pooler thread credential sweep failed.");
        return false;
      }
    };
    const sweepThreadCredentialsPeriodically = async (
      signal: AbortSignal,
      startupComplete: boolean,
    ): Promise<void> => {
      let complete = startupComplete;
      while (!signal.aborted) {
        await waitForDelay(
          complete
            ? (options.threadSweepIntervalMs ?? THREAD_SWEEP_INTERVAL_MS)
            : (options.threadSweepRetryMs ?? THREAD_SWEEP_RETRY_MS),
          signal,
        );
        if (!signal.aborted) complete = await sweepThreadCredentialsOnce(signal);
      }
    };
    const checkArchived = async (
      threadId: string,
    ): Promise<
      | { status: "archived" }
      | { status: "active" }
      | { status: "unknown"; error: unknown }
    > => {
      try {
        return (await revokeIfArchived(threadId))
          ? { status: "archived" }
          : { status: "active" };
      } catch (error) {
        return { status: "unknown", error };
      }
    };
    const contributeFor =
      (provider: PoolProvider, serving: (token: string) => PoolEnvEntry[]) =>
      async (context: { threadId: string; hostId: string }) => {
        const unrouted = () =>
          hasConfiguredParentPool ? neutralized(provider) : [];
        const archive = await checkArchived(context.threadId);
        if (archive.status === "archived") return unrouted();
        const bypassed = await routing.isBypassed(context.threadId);
        const selectedAccountId = await routing.selectedAccount(
          context.threadId,
          provider,
        );
        const accountId = proxyingParent() === null ? selectedAccountId : null;
        const canRoute =
          !bypassed &&
          (accountId === null
            ? await canServe(provider)
            : await operations.isRoutingEnabled(provider));
        if (canRoute) {
          if (archive.status === "unknown") throw archive.error;
          const hostToken = await hubTokens.forHost(context.hostId);
          const token = await threadTokens.forThread(
            {
              threadId: context.threadId,
              hostId: context.hostId,
              provider,
              accountId,
            },
            hostToken,
          );
          const nestedToken = await threadTokens.forNested(
            { threadId: context.threadId, hostId: context.hostId },
            hostToken,
          );
          if (await revokeIfArchived(context.threadId)) return unrouted();
          if (provider === "claude") {
            await routing.recordRouted(context.threadId, context.hostId);
          }
          return [...serving(token), ...markerEntries(nestedToken)];
        }
        return unrouted();
      };
    const proxiedHealth = async (provider: PoolProvider) =>
      (await canServe(provider))
        ? {
            label: "Proxied",
            statusMessage:
              proxyingParent() === null
                ? "Credentials are provided by the Account Pooler hub."
                : "Credentials are proxied to the parent bb server's Account Pooler.",
          }
        : null;
    bb.providers.experimental_contributeEnv(
      "claude-code",
      contributeFor("claude", (token) => [
        {
          name: "ANTHROPIC_BASE_URL",
          value: { serverPath: HUB_BASE_PATH },
          reason: "Routed through the Account Pooler hub",
        },
        {
          name: "ANTHROPIC_AUTH_TOKEN",
          value: token,
          reason: "Account Pooler token scoped to this thread",
        },
        {
          name: "ENABLE_TOOL_SEARCH",
          value: "true",
          reason:
            "Claude Code turns tool search off behind a custom base URL; the hub forwards tool_reference blocks",
        },
        {
          name: "_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL",
          value: "1",
          reason:
            "Claude Code limits Opus to a 200k context window behind a custom base URL; the hub forwards to Anthropic's API",
        },
      ]),
    );
    bb.providers.experimental_contributeEnvHealth("claude-code", () =>
      proxiedHealth("claude"),
    );
    bb.providers.experimental_contributeEnv(
      "codex",
      contributeFor("codex", (token) => [
        {
          name: "CODEX_OPENAI_BASE_URL",
          value: { serverPath: `${HUB_BASE_PATH}/v1` },
          reason: "Routed through the Account Pooler hub",
        },
        {
          name: "CODEX_POOL_AUTH_TOKEN",
          value: token,
          reason: "Account Pooler token scoped to this thread",
        },
      ]),
    );
    bb.providers.experimental_contributeEnvHealth("codex", () =>
      proxiedHealth("codex"),
    );
    bb.onDispose(async () => {
      codexLogin.dispose();
      let timer: ReturnType<typeof setTimeout> | null = null;
      try {
        const inspection = inspectDisableState(bb, operations);
        const timeout = new Promise<typeof DISPOSE_INSPECTION_TIMEOUT>(
          (resolve) => {
            timer = setTimeout(
              () => resolve(DISPOSE_INSPECTION_TIMEOUT),
              options.disposeTimeoutMs ?? DISPOSE_INSPECTION_TIMEOUT_MS,
            );
            timer.unref();
          },
        );
        const result = await Promise.race([inspection, timeout]);
        if (result === DISPOSE_INSPECTION_TIMEOUT) {
          bb.log.debug("Account Pooler disable inspection timed out.");
          return;
        }
        if (result !== null) bb.log.warn(result);
      } catch (error) {
        bb.log.debug(
          `Account Pooler disable inspection skipped: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        if (timer !== null) clearTimeout(timer);
      }
    });
    for (const route of ["/v1/messages", "/v1/messages/count_tokens"]) {
      bb.http.route(
        "POST",
        route,
        (context) => hub.handle(context.req.raw, "claude", route),
        { auth: "none" },
      );
    }
    for (const route of [
      "/v1/responses",
      "/v1/images/generations",
      "/v1/images/edits",
      "/v1/alpha/search",
    ]) {
      bb.http.route(
        "POST",
        route,
        (context) => hub.handle(context.req.raw, "codex", route),
        { auth: "none" },
      );
    }
    bb.http.route(
      "GET",
      "/v1/models",
      (context) => hub.handle(context.req.raw, "codex", "/v1/models"),
      { auth: "none" },
    );
    bb.http.route(
      "GET",
      AVAILABILITY_PATH,
      async (context) => {
        if ((await hub.authenticateNested(context.req.raw)) === null) {
          return new Response(null, { status: 401 });
        }
        return Response.json(
          poolAvailabilitySchema.parse({
            claude: await canServe("claude"),
            codex: await canServe("codex"),
          }),
        );
      },
      { auth: "none" },
    );
    bb.http.route("HEAD", "/api/hello", () => helloResponse(), {
      auth: "none",
    });
    bb.background.service("hub", {
      start: async (signal) => {
        const startupComplete = await sweepThreadCredentialsOnce(signal);
        await Promise.all([
          hub.start(signal),
          sweepThreadCredentialsPeriodically(signal, startupComplete),
        ]);
      },
    });
  };
}

function isThreadNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    error.status === 404 &&
    "code" in error &&
    error.code === "thread_not_found"
  );
}

async function inspectDisableState(
  bb: BbPluginApi,
  operations: PoolOperations,
): Promise<string | null> {
  const installed = await bb.sdk.plugins.list();
  const disabled =
    installed.plugins.find((plugin) => plugin.id === bb.pluginId)?.enabled ===
    false;
  if (!disabled) return null;
  const warnings = await operations.routedThreadsWithoutLocalLogin();
  if (warnings.length === 0) return null;
  return `Account Pooler disabled with ${warnings.length} recently routed thread${warnings.length === 1 ? "" : "s"} on machines without a local Claude login. Run bb pool status before disabling to inspect them.`;
}

export default createAccountPoolPlugin();
