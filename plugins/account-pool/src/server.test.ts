import {
  usageMeasurementSchema,
  usageResourceListSchema,
  usageListMethod,
  usageFetchMethod,
} from "./usage-contract.js";
import fs from "node:fs/promises";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  createFakePluginHost,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  accountSchema,
  accountSecretSchema,
  accountSummarySchema,
  accountPoolConfigSchema,
  accountPoolConfigSetInputSchema,
  codexLoginPollSchema,
  codexLoginStartSchema,
  localLoginSchema,
  loginStartSchema,
  routedThreadStatusListSchema,
  statusReportSchema,
  statusSchema,
  type AccountQuota,
  type AccountSummary,
} from "./contracts.js";
import { z } from "zod";
import type {
  ImportedClaudeCredentials,
  ImportedCodexCredentials,
} from "./credentials.js";
import { PARENT_TOKEN_ENV, PARENT_URL_ENV } from "./parent-pool.js";
import {
  AccountStore,
  HubTokenStore,
  PoolAffinityStore,
  QuotaStore,
} from "./store.js";
import {
  createAccountPoolPlugin,
  helloResponse,
  type AccountPoolPluginOptions,
} from "./server.js";

type UpstreamHandler = (
  request: IncomingMessage,
  response: ServerResponse,
) => void | Promise<void>;

interface Upstream {
  url: string;
  close: () => Promise<void>;
}

interface Fixture {
  dataDir: string;
  host: ReturnType<typeof createFakePluginHost>;
  service: ReturnType<
    ReturnType<typeof createFakePluginHost>["harness"]["behavior"]["runService"]
  >;
  key: string;
  account: AccountSummary;
}

const cleanups: Array<() => Promise<void>> = [];

function sdkStubs() {
  return {
    hosts: {
      list: async () => [
        {
          id: "host-one",
          name: "One",
        },
        {
          id: "host-two",
          name: "Two",
        },
      ],
    },
    system: {
      providerStates: async () => ({ providers: [] }),
    },
    threads: {
      get: async ({ threadId }: { threadId: string }) =>
        makeThreadResponse({ id: threadId }),
    },
    plugins: {
      list: async () => ({
        plugins: [{ id: "account-pool", enabled: true }],
      }),
    },
  };
}

async function resolveToken(
  host: ReturnType<typeof createFakePluginHost>,
  hostId = "host-one",
  threadId = "thread-one",
): Promise<string> {
  const entries = await host.harness.behavior.resolveProviderEnv(
    "claude-code",
    { threadId, projectId: "project-one", hostId },
  );
  const token = entries.find((entry) => entry.name === "ANTHROPIC_AUTH_TOKEN");
  if (token === undefined || typeof token.value !== "string") {
    throw new Error("Account Pool token was not resolved.");
  }
  return token.value;
}

async function resolveCodexToken(
  host: ReturnType<typeof createFakePluginHost>,
  hostId = "host-one",
): Promise<{ token: string; baseUrl: string }> {
  const entries = await host.harness.behavior.resolveProviderEnv("codex", {
    threadId: "thread-codex",
    projectId: "project-one",
    hostId,
  });
  const token = entries.find((entry) => entry.name === "CODEX_POOL_AUTH_TOKEN");
  const baseUrl = entries.find(
    (entry) => entry.name === "CODEX_OPENAI_BASE_URL",
  );
  if (token === undefined || typeof token.value !== "string") {
    throw new Error("Codex Account Pool token was not resolved.");
  }
  if (baseUrl === undefined || typeof baseUrl.value !== "object") {
    throw new Error("Codex Account Pool base URL was not resolved.");
  }
  return { token: token.value, baseUrl: baseUrl.value.serverPath };
}

describe("Explicit subscription routing", () => {
  async function twoSubscriptions() {
    const seen: string[] = [];
    const upstream = await startUpstream((request, response) => {
      seen.push(String(request.headers["x-api-key"]));
      response.setHeader("content-type", "application/json");
      response.end('{"ok":true}');
    });
    cleanups.push(upstream.close);
    const fixture = await createFixture({
      upstreamUrl: upstream.url,
      apiKey: "sk-first",
    });
    const second = accountSchema.parse(
      await fixture.host.harness.behavior.callRpc("account.add", {
        provider: "claude",
        source: { kind: "api-key", apiKey: "sk-second" },
        label: "Second subscription",
        priority: 200,
      }),
    );
    const configure =
      fixture.host.harness.registrations.hooks["experimental_thread.configure"];
    if (configure === null)
      throw new Error("Subscription configuration hook is missing.");
    await configure({
      thread: { id: "thr_pinned", providerId: "claude-code" },
      data: { provider: "claude", accountId: second.id },
    });
    const key = await resolveToken(fixture.host, "host-one", "thr_pinned");
    const request = async (token: string) => {
      const response = await fixture.host.harness.behavior.fetchHttp(
        "POST",
        "/v1/messages",
        {
          method: "POST",
          headers: authHeaders(token),
          body: JSON.stringify({
            model: "claude-opus-4-1",
            messages: [],
            max_tokens: 1,
          }),
        },
      );
      await response.text();
      return response;
    };
    return { fixture, second, seen, key, request };
  }

  it("uses the explicit account without moving the automatic provider cursor", async () => {
    const { fixture, seen, key, request } = await twoSubscriptions();
    expect((await request(key)).status).toBe(200);
    expect((await request(fixture.key)).status).toBe(200);
    expect(seen).toEqual(["sk-second", "sk-first"]);
  });

  it("stops contributing pinned account credentials when provider routing is disabled", async () => {
    const { fixture } = await twoSubscriptions();
    await fixture.host.harness.behavior.callRpc("routing.set", {
      provider: "claude",
      enabled: false,
    });

    const entries = await fixture.host.harness.behavior.resolveProviderEnv(
      "claude-code",
      { threadId: "thr_pinned", projectId: "project-one", hostId: "host-one" },
    );
    expect(
      entries.filter(({ name }) =>
        ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN"].includes(name),
      ),
    ).toEqual([]);
  });

  it.each(["routing-off", "bypassed"] as const)(
    "keeps an automatic turn on its route after %s changes",
    async (change) => {
      const { fixture, seen, request } = await twoSubscriptions();
      const token = await resolveToken(
        fixture.host,
        "host-one",
        "thread-running",
      );
      if (change === "routing-off") {
        await fixture.host.harness.behavior.callRpc("routing.set", {
          provider: "claude",
          enabled: false,
        });
      } else {
        await fixture.host.harness.behavior.callRpc("bypass.set", {
          threadId: "thread-running",
          bypassed: true,
        });
      }

      expect((await request(token)).status).toBe(200);
      expect(seen).toEqual(["sk-first"]);
    },
  );

  it.each(["disabled", "exhausted", "removed"])(
    "never switches away from a selected %s subscription",
    async (state) => {
      const { fixture, second, seen, key, request } = await twoSubscriptions();
      if (state === "exhausted") {
        const quotas = new QuotaStore(fixture.host.bb.storage.database());
        quotas.put({
          ...quotas.get(second.id),
          sevenDayUtilization: 0.98,
          sevenDayResetAt: Date.now() + 3_600_000,
        });
      } else {
        await fixture.host.harness.behavior.callRpc(
          state === "disabled" ? "account.disable" : "account.remove",
          { id: second.id },
        );
      }
      const response = await request(key);
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(seen).toEqual([]);
      expect((await request(fixture.key)).status).toBe(200);
      expect(seen).toEqual(["sk-first"]);
    },
  );

  it("keeps a running turn's credential on its account while the next turn changes", async () => {
    const { fixture, key, seen, request } = await twoSubscriptions();
    fixture.host.harness.sdk.stub("threads.get", async ({ threadId }) =>
      makeThreadResponse({
        id: threadId,
        providerId: "claude-code",
        status: "idle",
      }),
    );
    fixture.host.harness.sdk.stub(
      "threads.queuedMessages.list",
      async () => [],
    );
    await fixture.host.harness.behavior.callRpc("routing.selection.set", {
      threadId: "thr_pinned",
      provider: "claude",
      accountId: fixture.account.id,
    });
    const nextKey = await resolveToken(fixture.host, "host-one", "thr_pinned");
    expect(nextKey).not.toBe(key);
    expect((await request(key)).status).toBe(200);
    expect((await request(nextKey)).status).toBe(200);
    expect(seen).toEqual(["sk-second", "sk-first"]);
    const result = await fixture.host.harness.behavior.runCli([
      "select",
      "thr_pinned",
      "claude",
      "automatic",
      "--json",
    ]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ accountId: null });
  });

  it("preserves the original thread ID validation for selection RPCs", async () => {
    const { fixture } = await twoSubscriptions();

    await expect(
      fixture.host.harness.behavior.callRpc("routing.selection.get", {
        threadId: "thr_invalid-id",
        provider: "claude",
      }),
    ).rejects.toThrow();
  });

  it("rejects selection changes while a conversation has active or queued work", async () => {
    const { fixture } = await twoSubscriptions();
    fixture.host.harness.sdk.stub("threads.get", async ({ threadId }) =>
      makeThreadResponse({
        id: threadId,
        providerId: "claude-code",
        status: "active",
      }),
    );
    fixture.host.harness.sdk.stub(
      "threads.queuedMessages.list",
      async () => [],
    );
    const input = {
      threadId: "thr_pinned",
      provider: "claude",
      accountId: fixture.account.id,
    };
    await expect(
      fixture.host.harness.behavior.callRpc("routing.selection.set", input),
    ).rejects.toThrow("Wait for this conversation");
    fixture.host.harness.sdk.stub("threads.get", async ({ threadId }) =>
      makeThreadResponse({
        id: threadId,
        providerId: "claude-code",
        status: "idle",
      }),
    );
    fixture.host.harness.sdk.stub("threads.queuedMessages.list", async () => [
      { id: "qmsg_waiting" },
    ]);
    await expect(
      fixture.host.harness.behavior.callRpc("routing.selection.set", input),
    ).rejects.toThrow("Wait for this conversation");
  });
});

beforeEach(() => {
  vi.stubEnv(PARENT_URL_ENV, undefined);
  vi.stubEnv(PARENT_TOKEN_ENV, undefined);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function startUpstream(handler: UpstreamHandler): Promise<Upstream> {
  const server = http.createServer((request, response) => {
    Promise.resolve(handler(request, response)).catch((error) => {
      response.statusCode = 500;
      response.end(error instanceof Error ? error.message : String(error));
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Fake upstream did not bind a TCP port.");
  }
  const url = `http://127.0.0.1:${address.port}`;
  return {
    url,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    },
  };
}

async function readRequestBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function importedCredentials(
  overrides: Partial<ImportedClaudeCredentials> = {},
): ImportedClaudeCredentials {
  return {
    accessToken: "oauth-access",
    refreshToken: "oauth-refresh",
    expiresAt: Date.now() + 60 * 60 * 1_000,
    subscriptionType: "max",
    rateLimitTier: "max_5x",
    email: "pool@example.com",
    accountUuid: "11111111-1111-4111-8111-111111111111",
    organizationUuid: null,
    ...overrides,
  };
}

function testJwt(payload: object): string {
  return [
    Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url"),
    Buffer.from(JSON.stringify(payload)).toString("base64url"),
    "signature",
  ].join(".");
}

async function createFixture(args: {
  upstreamUrl: string;
  options?: AccountPoolPluginOptions;
  provider?: "claude" | "codex";
  source?: "api-key" | "import";
  apiKey?: string;
  priority?: number;
  beforePlugin?: (host: Fixture["host"]) => void;
}): Promise<Fixture> {
  const dataDir = await mkdtemp(path.join(tmpdir(), "bb-account-pool-"));
  const host = createFakePluginHost({
    pluginId: "account-pool",
    dataDir,
    sdk: sdkStubs(),
  });
  await host.bb.storage.kv.set("config", {
    anthropicUpstreamBaseUrl: args.upstreamUrl,
    codexUpstreamBaseUrl: args.upstreamUrl,
  });
  const options = args.options ?? {};
  const upstreamFetch = options.fetch;
  const plugin = createAccountPoolPlugin({
    usageUrl: "data:application/json,{}",
    ...options,
    oauthProfileUrl: options.oauthProfileUrl ?? UNUSED_PROFILE_URL,
    ...(upstreamFetch === undefined
      ? {}
      : {
          fetch: (input, init) =>
            String(input) === UNUSED_PROFILE_URL
              ? Promise.resolve(Response.json(null))
              : upstreamFetch(input, init),
        }),
  });
  args.beforePlugin?.(host);
  await plugin(host.bb);
  const accountMetadata = accountSchema.parse(
    await host.harness.behavior.callRpc("account.add", {
      provider: args.provider ?? "claude",
      source:
        args.source === "import"
          ? { kind: "import" }
          : { kind: "api-key", apiKey: args.apiKey ?? "sk-account" },
      label: null,
      priority: args.priority ?? 100,
    }),
  );
  const service = host.harness.behavior.runService("hub");
  await vi.waitFor(async () => {
    const result = await host.harness.behavior.runCli(["status", "--json"]);
    expect(result.exitCode).toBe(0);
    expect(statusReportSchema.parse(JSON.parse(result.stdout)).accepting).toBe(
      true,
    );
  });
  const statusResult = await host.harness.behavior.runCli(["status", "--json"]);
  const status = statusReportSchema.parse(JSON.parse(statusResult.stdout));
  const account = status.accounts.find(
    (candidate) => candidate.id === accountMetadata.id,
  );
  if (account === undefined) throw new Error("Added account was not listed.");
  cleanups.push(async () => {
    service.controller.abort();
    await service.done;
    await host.harness.lifecycle.dispose();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  const key =
    args.provider === "codex"
      ? (await resolveCodexToken(host)).token
      : await resolveToken(host);
  return { dataDir, host, service, key, account };
}

async function createOAuthRequestFixture(
  provider: "claude" | "codex",
  upstreamFetch: typeof fetch,
  now: () => number,
  usagePayload: Record<string, unknown> = {},
): Promise<Fixture> {
  return createFixture({
    upstreamUrl: "https://upstream.example",
    provider,
    source: "import",
    options: {
      fetch: (input, init) =>
        String(input) === EMPTY_USAGE_URL
          ? Promise.resolve(Response.json(usagePayload))
          : upstreamFetch(input, init),
      now,
      refreshUrl: "https://upstream.example/oauth/token",
      codexRefreshUrl: "https://upstream.example/oauth/token",
      codexUsageUrl: EMPTY_USAGE_URL,
      importCredentials: async () =>
        importedCredentials({
          accessToken: "oauth-old",
          expiresAt: now() + 60 * 60 * 1_000,
        }),
      importCodexCredentials: async () => ({
        accessToken: "oauth-old",
        refreshToken: "oauth-refresh",
        idToken: null,
        accountId: "chatgpt-account",
        planType: null,
        email: "codex@example.com",
        expiresAt: now() + 60 * 60 * 1_000,
      }),
    },
  });
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => {};
  const promise = new Promise<void>((release) => {
    resolve = release;
  });
  return { promise, resolve };
}

function authHeaders(key: string): Record<string, string> {
  return {
    authorization: `Bearer ${key}`,
    "content-type": "application/json",
    "anthropic-version": "2023-06-01",
  };
}

function setQuota(
  fixture: Fixture,
  accountId: string,
  update: Partial<AccountQuota>,
): void {
  const quotas = new QuotaStore(fixture.host.bb.storage.database());
  quotas.put({ ...quotas.get(accountId), ...update });
}

async function addApiAccount(
  fixture: Fixture,
  apiKey: string,
  priority = 100,
): Promise<AccountSummary> {
  const added = accountSchema.parse(
    await fixture.host.harness.behavior.callRpc("account.add", {
      provider: "claude",
      source: { kind: "api-key", apiKey },
      label: apiKey,
      priority,
    }),
  );
  const list = z
    .array(accountSummarySchema)
    .parse(await fixture.host.harness.behavior.callRpc("account.list", null));
  const found = list.find((account) => account.id === added.id);
  if (found === undefined) throw new Error("Added account was not listed.");
  return found;
}

async function movePoolToOtherAccount(
  fixture: Fixture,
  provider: "claude" | "codex",
  disabledId = fixture.account.id,
): Promise<void> {
  await fixture.host.harness.behavior.callRpc("account.disable", {
    id: disabledId,
  });
  try {
    const response = await fixture.host.harness.behavior.fetchHttp(
      "POST",
      provider === "claude" ? "/v1/messages" : "/v1/responses",
      { headers: authHeaders(fixture.key), body: "{}" },
    );
    expect(response.status).toBe(200);
    await response.text();
  } finally {
    await fixture.host.harness.behavior.callRpc("account.enable", {
      id: disabledId,
    });
  }
}

const EMPTY_USAGE_URL = "data:application/json,{}";
const UNUSED_PROFILE_URL = "data:application/json,null";
const CODEX_USAGE_STUB_URL = "https://usage.example/wham/usage";

describe("Account Pool config schema", () => {
  it("fills defaults and rejects invalid URLs and thresholds", () => {
    expect(accountPoolConfigSchema.parse({})).toEqual({
      anthropicUpstreamBaseUrl: "https://api.anthropic.com",
      codexUpstreamBaseUrl: "https://chatgpt.com/backend-api/codex",
      switchThreshold: 0.98,
      parentMode: "proxy",
    });
    expect(
      accountPoolConfigSetInputSchema.safeParse({
        anthropicUpstreamBaseUrl: "ftp://example.com",
      }).success,
    ).toBe(false);
    expect(
      accountPoolConfigSetInputSchema.safeParse({ switchThreshold: 0 }).success,
    ).toBe(false);
    expect(
      accountPoolConfigSetInputSchema.safeParse({ switchThreshold: 1.01 })
        .success,
    ).toBe(false);
  });
});

describe("Account Pool plugin", () => {
  it("appends accounts to the current priority order and renames over RPC and CLI", async () => {
    const fixture = await createFixture({
      upstreamUrl: "http://127.0.0.1:9001",
    });
    const added = accountSchema.parse(
      await fixture.host.harness.behavior.callRpc("account.add", {
        provider: "claude",
        source: { kind: "api-key", apiKey: "sk-appended" },
        label: "Appended account",
      }),
    );
    expect(added.priority).toBe(fixture.account.priority + 1);
    const renamed = await fixture.host.harness.behavior.callRpc(
      "account.rename",
      {
        id: added.id,
        label: "Work Claude",
      },
    );
    expect(renamed).toMatchObject({
      account: { label: "Work Claude", priority: added.priority },
    });
    const cliRename = await fixture.host.harness.behavior.runCli([
      "account",
      "rename",
      added.id,
      "Primary Claude",
    ]);
    expect(cliRename).toMatchObject({
      exitCode: 0,
      stdout: expect.stringContaining("Primary Claude"),
    });
    const table = await fixture.host.harness.behavior.runCli([
      "account",
      "list",
      "--json",
    ]);
    expect(JSON.parse(table.stdout).accounts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: added.id,
          label: "Primary Claude",
          active: false,
        }),
      ]),
    );
  });

  it("removes persisted cache debugging settings while preserving pool configuration across reloads", async () => {
    const dataDir = await mkdtemp(
      path.join(tmpdir(), "bb-account-pool-config-upgrade-"),
    );
    const host = createFakePluginHost({
      pluginId: "account-pool",
      dataDir,
      sdk: sdkStubs(),
    });
    cleanups.push(async () => {
      await host.harness.lifecycle.dispose();
      await fs.rm(dataDir, { recursive: true, force: true });
    });
    const expected = accountPoolConfigSchema.parse({
      anthropicUpstreamBaseUrl: "http://127.0.0.1:9000",
      switchThreshold: 0.75,
      parentMode: "isolate",
    });
    await host.bb.storage.kv.set("config", {
      ...expected,
      cacheMissDebug: true,
      cacheMissMinTokens: 20_000,
    });
    const plugin = createAccountPoolPlugin();
    await plugin(host.bb);
    expect(await host.bb.storage.kv.get("config")).toEqual(expected);
    expect(await host.harness.behavior.callRpc("config.get", null)).toEqual(
      expected,
    );
    await host.harness.lifecycle.reload(plugin);
    expect(await host.harness.behavior.callRpc("config.get", null)).toEqual(
      expected,
    );
  });

  it("reads and updates one full config record through RPC and CLI", async () => {
    const dataDir = await mkdtemp(
      path.join(tmpdir(), "bb-account-pool-config-"),
    );
    const host = createFakePluginHost({
      pluginId: "account-pool",
      dataDir,
      sdk: sdkStubs(),
    });
    await createAccountPoolPlugin()(host.bb);
    cleanups.push(async () => {
      await host.harness.lifecycle.dispose();
      await fs.rm(dataDir, { recursive: true, force: true });
    });

    expect(
      accountPoolConfigSchema.parse(
        await host.harness.behavior.callRpc("config.get", null),
      ),
    ).toEqual(accountPoolConfigSchema.parse({}));
    const cliGet = await host.harness.behavior.runCli(["config"]);
    expect(cliGet.exitCode).toBe(0);
    expect(cliGet.stdout).toContain(
      "anthropicUpstreamBaseUrl: https://api.anthropic.com",
    );
    expect(cliGet.stdout).toContain(
      "codexUpstreamBaseUrl: https://chatgpt.com/backend-api/codex",
    );
    expect(cliGet.stdout).toContain("switchThreshold: 0.98");

    const cliSet = await host.harness.behavior.runCli([
      "config",
      "set",
      "switchThreshold",
      "0.75",
    ]);
    expect(cliSet.exitCode).toBe(0);
    expect(cliSet.stdout).toContain("switchThreshold: 0.75");
    const updated = accountPoolConfigSchema.parse(
      await host.harness.behavior.callRpc("config.set", {
        anthropicUpstreamBaseUrl: "http://127.0.0.1:9000",
      }),
    );
    expect(updated).toEqual({
      anthropicUpstreamBaseUrl: "http://127.0.0.1:9000",
      codexUpstreamBaseUrl: "https://chatgpt.com/backend-api/codex",
      switchThreshold: 0.75,
      parentMode: "proxy",
    });
    expect(
      accountPoolConfigSchema.parse(await host.bb.storage.kv.get("config")),
    ).toEqual(updated);
    expect(host.harness.inspection.realtimeSignals).toContainEqual({
      channel: "config-changed",
      payload: {},
    });
  });

  it.each([
    {
      path: "images/generations",
      request: { prompt: "A fox astronaut", images: [] },
      result: { data: [{ b64_json: "generated-image" }] },
    },
    {
      path: "images/edits",
      request: { prompt: "A fox astronaut", images: [] },
      result: { data: [{ b64_json: "generated-image" }] },
    },
    {
      path: "alpha/search",
      request: {
        id: "search-1",
        model: "gpt-5.5",
        commands: { search_query: [{ q: "bb account pooler" }] },
      },
      result: { encrypted_output: "encrypted-search-output" },
    },
  ])(
    "routes native Codex $path with pool authentication",
    async ({ path, request, result }) => {
      const requests: Request[] = [];
      const fixture = await createOAuthRequestFixture(
        "codex",
        async (input, init) => {
          requests.push(new Request(input, init));
          return Response.json(result);
        },
        Date.now,
      );
      const route = `/v1/${path}`;
      const body = JSON.stringify(request);
      const denied = await fixture.host.harness.behavior.fetchHttp(
        "POST",
        route,
        { body },
      );
      expect(denied.status).toBe(401);
      expect(requests).toHaveLength(0);
      const response = await fixture.host.harness.behavior.fetchHttp(
        "POST",
        route,
        {
          headers: {
            "content-type": "application/json",
            "x-bb-account-pool-token": fixture.key,
            authorization: "Bearer local-token",
          },
          body,
        },
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(result);
      expect(requests).toHaveLength(1);
      expect(requests[0]?.url).toBe(`https://upstream.example/${path}`);
      expect(requests[0]?.headers.get("authorization")).toBe(
        "Bearer oauth-old",
      );
      expect(requests[0]?.headers.get("chatgpt-account-id")).toBe(
        "chatgpt-account",
      );
      expect(requests[0]?.headers.has("x-bb-account-pool-token")).toBe(false);
      expect(await requests[0]?.text()).toBe(body);
    },
  );

  it("imports, refreshes, and routes Codex HTTP sessions by provider", async () => {
    const seen: Array<{
      path: string;
      authorization: string | undefined;
      accountId: string | undefined;
      body: string;
    }> = [];
    const modelRequests: string[] = [];
    let responseNumber = 0;
    let planType: unknown = "pro";
    const futureToken = `header.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1_000) + 3_600 })).toString("base64url")}.signature`;
    const upstream = await startUpstream(async (request, response) => {
      const body = (await readRequestBody(request)).toString("utf8");
      if (request.url === "/oauth") {
        const parsed = z
          .object({
            client_id: z.literal("app_EMoamEEZ73f0CkXaXp7hrann"),
            grant_type: z.literal("refresh_token"),
            refresh_token: z.string(),
          })
          .parse(JSON.parse(body));
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            access_token: futureToken,
            refresh_token: `next-${parsed.refresh_token}`,
            id_token: "next-id-token",
          }),
        );
        return;
      }
      if (request.url === "/usage") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            plan_type: planType,
            rate_limit: {
              allowed: true,
              limit_reached: false,
              primary_window: {
                used_percent: 48,
                limit_window_seconds: 604_800,
                reset_after_seconds: 180_092,
                reset_at: 4_102_452_000,
              },
              secondary_window: null,
            },
          }),
        );
        return;
      }
      if (request.url === "/models") {
        modelRequests.push(
          request.headers["chatgpt-account-id"]?.toString() ?? "",
        );
        response.writeHead(200, { "content-type": "application/json" });
        response.end('{"data":[]}');
        return;
      }
      responseNumber += 1;
      seen.push({
        path: request.url ?? "",
        authorization: request.headers.authorization,
        accountId: z
          .string()
          .optional()
          .parse(request.headers["chatgpt-account-id"]),
        body,
      });
      if (responseNumber === 1) {
        response.writeHead(200, {
          "content-type": "application/json",
          "x-codex-primary-used-percent": "25",
          "x-codex-primary-window-minutes": "300",
          "x-codex-primary-reset-after-seconds": "3600",
          "x-codex-secondary-used-percent": "40",
          "x-codex-secondary-window-minutes": "10080",
          "x-codex-secondary-reset-after-seconds": "86400",
        });
        response.end('{"id":"http-response"}');
        return;
      }
      if (responseNumber === 2) {
        response.writeHead(429, {
          "content-type": "application/json",
          "x-codex-secondary-used-percent": "100",
        });
        response.end('{"error":{"message":"quota exhausted"}}');
        return;
      }
      const id = `response-${responseNumber}`;
      response.writeHead(200, {
        "content-type": "text/event-stream",
      });
      response.end(
        `event: response.created\ndata: ${JSON.stringify({
          type: "response.created",
          response: { id },
        })}\n\nevent: response.completed\ndata: ${JSON.stringify({
          type: "response.completed",
          response: {
            id,
            output: [{ type: "message", id: `message-${responseNumber}` }],
          },
        })}\n\ndata: [DONE]\n\n`,
      );
    });
    cleanups.push(upstream.close);
    const dataDir = await mkdtemp(
      path.join(tmpdir(), "bb-account-pool-codex-"),
    );
    let imported = 0;
    const importCodexCredentials =
      async (): Promise<ImportedCodexCredentials> => {
        imported += 1;
        return {
          accessToken: "expired-token",
          refreshToken: `refresh-${imported}`,
          idToken: "id-token",
          accountId: `chatgpt-account-${imported}`,
          planType: null,
          email: `codex-${imported}@example.com`,
          expiresAt: Date.now() - 1,
        };
      };
    const host = createFakePluginHost({
      pluginId: "account-pool",
      dataDir,
      sdk: sdkStubs(),
    });
    await host.bb.storage.kv.set("config", {
      anthropicUpstreamBaseUrl: upstream.url,
      codexUpstreamBaseUrl: upstream.url,
    });
    await createAccountPoolPlugin({
      codexRefreshUrl: `${upstream.url}/oauth`,
      codexUsageUrl: `${upstream.url}/usage`,
      importCodexCredentials,
      usageUrl: "data:application/json,{}",
    })(host.bb);
    const service = host.harness.behavior.runService("hub");
    cleanups.push(async () => {
      service.controller.abort();
      await service.done;
      await host.harness.lifecycle.dispose();
      await fs.rm(dataDir, { recursive: true, force: true });
    });
    await vi.waitFor(async () => {
      expect(
        statusSchema.parse(
          await host.harness.behavior.callRpc("status.get", null),
        ).accepting,
      ).toBe(true);
    });
    await host.harness.behavior.callRpc("account.add", {
      provider: "claude",
      source: { kind: "api-key", apiKey: "claude-key" },
      label: "Claude first",
      priority: 0,
    });
    const importedByCli = await host.harness.behavior.runCli([
      "account",
      "add",
      "--provider",
      "codex",
      "--import",
    ]);
    expect(importedByCli.exitCode).toBe(0);
    await host.harness.behavior.callRpc("account.add", {
      provider: "codex",
      source: { kind: "import" },
      label: null,
      priority: 100,
    });
    const accountTable = await host.harness.behavior.runCli([
      "account",
      "list",
    ]);
    expect(accountTable.stdout).toContain("Provider");
    expect(accountTable.stdout).toContain("codex");
    expect(accountTable.stdout).toContain("7d=48% 2100-01-01T02:00:00.000Z");
    expect(accountTable.stdout).not.toContain("5h=");
    const codexAccount = statusSchema
      .parse(await host.harness.behavior.callRpc("status.get", null))
      .accounts.find((account) => account.provider === "codex")!;
    expect(codexAccount.subscriptionType).toBe("pro");
    for (const [reportedPlan, expectedPlan] of [
      ["pro", "pro"],
      ["plus", "plus"],
      [undefined, "plus"],
      [null, "plus"],
      [123, "plus"],
      ["", "plus"],
    ]) {
      planType = reportedPlan;
      expect(
        await host.harness.behavior.callRpc("provider-usage.v1.getResource", {
          resourceId: codexAccount.id,
          refresh: true,
        }),
      ).toMatchObject({
        usage: {
          status: "ok",
          plan: { id: expectedPlan, multiplier: null },
          planLabel: expectedPlan === "pro" ? "Pro" : "Plus",
          windows: [expect.objectContaining({ usedPercent: 48 })],
        },
      });
    }

    const routed = await resolveCodexToken(host);
    expect(routed.baseUrl).toBe("/api/v1/plugins/account-pool/http/v1");
    await expect(
      host.harness.behavior.resolveProviderEnvHealth("codex", {
        hostId: "host-one",
      }),
    ).resolves.toEqual({
      label: "Proxied",
      statusMessage: "Credentials are provided by the Account Pooler hub.",
    });
    const httpResponse = await host.harness.behavior.fetchHttp(
      "POST",
      "/v1/responses",
      {
        headers: {
          authorization: "Bearer local-codex-token",
          "x-bb-account-pool-token": routed.token,
          "content-type": "application/json",
          "openai-beta": "responses=experimental",
        },
        body: JSON.stringify({ model: "gpt-5", input: [] }),
      },
    );
    expect(httpResponse.status).toBe(200);
    expect(await httpResponse.json()).toEqual({ id: "http-response" });
    const modelsResponse = await host.harness.behavior.fetchHttp(
      "GET",
      "/v1/models",
      {
        headers: { "x-bb-account-pool-token": routed.token },
      },
    );
    expect(await modelsResponse.json()).toEqual({ data: [] });
    expect(modelRequests).toHaveLength(1);
    expect(modelRequests[0]).toMatch(/^chatgpt-account-[12]$/u);
    expect(seen[0]).toMatchObject({
      path: "/responses",
      authorization: `Bearer ${futureToken}`,
      accountId: "chatgpt-account-1",
    });
    const postResponses = (input: unknown[]) =>
      host.harness.behavior.fetchHttp("POST", "/v1/responses", {
        headers: {
          authorization: "Bearer local-codex-token",
          "x-bb-account-pool-token": routed.token,
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: "gpt-5", input }),
      });
    const first = await postResponses([
      { type: "message", id: "prefix" },
      { type: "message", id: "delta-one" },
    ]);
    expect(first.status).toBe(200);
    expect(await first.text()).toContain('"type":"response.completed"');
    const second = await postResponses([
      { type: "message", id: "prefix" },
      { type: "message", id: "delta-one" },
      { type: "message", id: "message-3" },
      { type: "message", id: "delta-two" },
    ]);
    expect(second.status).toBe(200);
    await second.text();
    expect(seen[1]?.accountId).not.toBe(seen[2]?.accountId);
    expect(seen[2]?.accountId).toBe(seen[3]?.accountId);
    expect(JSON.parse(seen[3]?.body ?? "{}").input).toEqual([
      { type: "message", id: "prefix" },
      { type: "message", id: "delta-one" },
      { type: "message", id: "message-3" },
      { type: "message", id: "delta-two" },
    ]);
    const status = statusSchema.parse(
      await host.harness.behavior.callRpc("status.get", null),
    );
    const firstCodex = status.accounts.find(
      (account) => account.codexAccountId === "chatgpt-account-1",
    );
    expect(seen[1]?.accountId).toBe("chatgpt-account-1");
    expect(firstCodex).toMatchObject({
      provider: "codex",
      status: "exhausted",
      fiveHourUtilization: null,
      sevenDayUtilization: null,
      familyWeekly: { other: null },
      limitWindows: [
        {
          slot: "primary",
          windowMinutes: 300,
          utilization: 0.25,
          status: null,
          source: "header",
        },
        {
          slot: "secondary",
          windowMinutes: 10_080,
          utilization: 1,
          status: "rejected",
          source: "header",
        },
      ],
    });
    expect(
      status.accounts.find(
        (account) => account.codexAccountId === seen[2]?.accountId,
      ),
    ).toMatchObject({
      provider: "codex",
      status: "ready",
      limitWindows: [
        {
          slot: "primary",
          windowMinutes: 10_080,
          utilization: 0.48,
          status: "allowed",
          source: "usage",
        },
      ],
    });
    const secondCodex = status.accounts.find(
      (account) =>
        account.provider === "codex" && account.id !== firstCodex?.id,
    );
    expect(status.accounts.filter((account) => account.active)).toHaveLength(1);
    expect(
      status.accounts.find((account) => account.active)?.codexAccountId,
    ).toBe(seen[3]?.accountId);
    if (secondCodex === undefined) throw new Error("Missing second account.");
    await host.harness.behavior.callRpc("account.disable", {
      id: secondCodex.id,
    });
    const blocked = await host.harness.behavior.fetchHttp(
      "POST",
      "/v1/responses",
      {
        headers: { "x-bb-account-pool-token": routed.token },
        body: JSON.stringify({ model: "gpt-5", input: [] }),
      },
    );
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(80_000);
    const secret = accountSecretSchema.parse(
      JSON.parse(
        await fs.readFile(
          path.join(
            dataDir,
            "plugins",
            "account-pool",
            "secrets",
            "accounts",
            `account-${firstCodex?.id}.json`,
          ),
          "utf8",
        ),
      ),
    );
    expect(secret).toMatchObject({
      accessToken: futureToken,
      refreshToken: "next-refresh-1",
      idToken: "next-id-token",
    });
  });

  it("cancels a Codex upstream read when the HTTP client aborts", async () => {
    const dataDir = await mkdtemp(
      path.join(tmpdir(), "bb-account-pool-codex-cancel-"),
    );
    let upstreamReadCanceled = false;
    const upstreamFetch = async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      if (String(input) === CODEX_USAGE_STUB_URL) return Response.json({});
      const signal = init?.signal;
      if (signal === undefined || signal === null) {
        throw new Error("Expected the upstream request to carry a signal.");
      }
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              'event: response.created\ndata: {"type":"response.created","response":{"id":"streaming"}}\n\n',
            ),
          );
          signal.addEventListener(
            "abort",
            () => {
              upstreamReadCanceled = true;
              controller.error(signal.reason);
            },
            { once: true },
          );
        },
      });
      return new Response(body, {
        headers: { "content-type": "text/event-stream" },
      });
    };
    const host = createFakePluginHost({
      pluginId: "account-pool",
      dataDir,
      sdk: sdkStubs(),
    });
    await host.bb.storage.kv.set("config", {
      codexUpstreamBaseUrl: "https://example.com",
    });
    await createAccountPoolPlugin({
      fetch: upstreamFetch,
      codexUsageUrl: CODEX_USAGE_STUB_URL,
      importCodexCredentials: async () => ({
        accessToken: "access",
        refreshToken: "refresh",
        idToken: null,
        accountId: "account",
        planType: null,
        email: null,
        expiresAt: null,
      }),
    })(host.bb);
    const service = host.harness.behavior.runService("hub");
    cleanups.push(async () => {
      service.controller.abort();
      await service.done;
      await host.harness.lifecycle.dispose();
      await fs.rm(dataDir, { recursive: true, force: true });
    });
    await vi.waitFor(async () => {
      expect(
        statusSchema.parse(
          await host.harness.behavior.callRpc("status.get", null),
        ).accepting,
      ).toBe(true);
    });
    await host.harness.behavior.callRpc("account.add", {
      provider: "codex",
      source: { kind: "import" },
      label: null,
      priority: 100,
    });
    const { token } = await resolveCodexToken(host);
    const client = new AbortController();
    const response = await host.harness.behavior.fetchHttp(
      "POST",
      "/v1/responses",
      {
        headers: {
          "x-bb-account-pool-token": token,
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: "gpt-5", input: [] }),
        signal: client.signal,
      },
    );
    expect(response.status).toBe(200);
    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error("Expected a streaming body.");
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain("response.created");
    client.abort(new Error("interrupted"));
    await reader.cancel().catch(() => undefined);
    await vi.waitFor(async () => {
      expect(upstreamReadCanceled).toBe(true);
      expect(
        statusSchema.parse(
          await host.harness.behavior.callRpc("status.get", null),
        ).inFlight,
      ).toBe(0);
    });
  });

  it("prunes token files for unenrolled hosts on startup and status", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "bb-pool-prune-"));
    const secretDir = path.join(
      dataDir,
      "plugins",
      "account-pool",
      "secrets",
      "accounts",
    );
    const seededTokens = new HubTokenStore(secretDir);
    await seededTokens.initialize();
    await seededTokens.forHost("host-gone");
    const goneTokenFile = path.join(secretDir, "hub-token-host-gone.json");
    await expect(fs.access(goneTokenFile)).resolves.toBeUndefined();
    const host = createFakePluginHost({
      pluginId: "account-pool",
      dataDir,
      sdk: sdkStubs(),
    });
    await createAccountPoolPlugin()(host.bb);
    cleanups.push(async () => {
      await host.harness.lifecycle.dispose();
      await fs.rm(dataDir, { recursive: true, force: true });
    });
    await expect(fs.access(goneTokenFile)).rejects.toThrow();
    await host.harness.behavior.callRpc("account.add", {
      provider: "claude",
      source: { kind: "api-key", apiKey: "sk-account" },
      label: null,
      priority: 100,
    });
    await resolveToken(host, "host-two", "thread-two");
    const hostTwoTokenFile = path.join(secretDir, "hub-token-host-two.json");
    await expect(fs.access(hostTwoTokenFile)).resolves.toBeUndefined();
    host.harness.sdk.stub("hosts.list", async () => [
      { id: "host-one", name: "One" },
    ]);
    const status = statusSchema.parse(
      await host.harness.behavior.callRpc("status.get", null),
    );
    expect(status.hosts).toEqual([]);
    await expect(fs.access(hostTwoTokenFile)).rejects.toThrow();
  });

  it("uses a single-process token cache and throttles last-use file writes", async () => {
    let now = 1_000;
    const dataDir = await mkdtemp(path.join(tmpdir(), "bb-pool-tokens-"));
    cleanups.push(() => fs.rm(dataDir, { recursive: true, force: true }));
    const tokens = new HubTokenStore(dataDir, () => now);
    await tokens.initialize();
    const token = await tokens.forHost("host-one");
    const tokenFile = path.join(dataDir, "hub-token-host-one.json");
    await fs.writeFile(
      tokenFile,
      `${JSON.stringify({
        hostId: "host-one",
        value: "A".repeat(43),
        mintedAt: now,
        lastUsedAt: null,
        previous: [],
      })}\n`,
    );
    const writeFile = vi.spyOn(fs, "writeFile");
    try {
      expect(await tokens.authenticate(token)).toBe("host-one");
      now += 30_000;
      expect(await tokens.authenticate(token)).toBe("host-one");
      expect(await tokens.authenticate("A".repeat(43))).toBeNull();
      expect(writeFile).toHaveBeenCalledTimes(1);
      now += 30_000;
      expect(await tokens.authenticate(token)).toBe("host-one");
      expect(writeFile).toHaveBeenCalledTimes(2);
    } finally {
      writeFile.mockRestore();
    }
  });

  it("forwards the next request after adding the first account through the CLI", async () => {
    let forwarded = 0;
    const upstream = await startUpstream(async (request, response) => {
      forwarded += 1;
      await readRequestBody(request);
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"forwarded":true}');
    });
    cleanups.push(upstream.close);
    const dataDir = await mkdtemp(
      path.join(tmpdir(), "bb-account-pool-empty-"),
    );
    const host = createFakePluginHost({
      pluginId: "account-pool",
      dataDir,
      sdk: sdkStubs(),
    });
    await host.bb.storage.kv.set("config", {
      anthropicUpstreamBaseUrl: upstream.url,
    });
    await createAccountPoolPlugin()(host.bb);
    const service = host.harness.behavior.runService("hub");
    cleanups.push(async () => {
      service.controller.abort();
      await service.done;
      await host.harness.lifecycle.dispose();
      await fs.rm(dataDir, { recursive: true, force: true });
    });
    const statusResult = await host.harness.behavior.runCli([
      "status",
      "--json",
    ]);
    const status = statusReportSchema.parse(JSON.parse(statusResult.stdout));
    expect(status.accepting).toBe(true);
    expect(status.hosts).toEqual([]);
    expect(
      await host.harness.behavior.resolveProviderEnv("claude-code", {
        threadId: "thread-empty",
        projectId: "project-one",
        hostId: "host-one",
      }),
    ).toEqual([]);
    await expect(
      host.harness.behavior.resolveProviderEnvHealth("claude-code", {
        hostId: "host-one",
      }),
    ).resolves.toBeNull();
    expect(host.harness.inspection.needsConfigurationMessages).toEqual([
      "Add and enable a Claude or Codex account with `bb pool account add`.",
    ]);
    const hello = helloResponse();
    expect(hello.status).toBe(200);
    const added = await host.harness.behavior.runCli(
      [
        "account",
        "add",
        "--provider",
        "claude",
        "--api-key-stdin",
        "--label",
        "CLI account",
        "--priority",
        "7",
      ],
      {
        experimental_stdinInputs: { "api-key": "fixture-cli-key" },
      },
    );
    expect(added.exitCode).toBe(0);
    expect(added.stdout).not.toContain("fixture-cli-key");
    expect(added.stdout).not.toContain("reload");
    const key = await resolveToken(host, "host-one", "thread-empty");
    const forwardedResponse = await host.harness.behavior.fetchHttp(
      "POST",
      "/v1/messages",
      { headers: authHeaders(key), body: "{}" },
    );
    expect(forwardedResponse.status).toBe(200);
    expect(await forwardedResponse.text()).toBe('{"forwarded":true}');
    expect(forwarded).toBe(1);
  });

  it("exposes every account CLI operation", async () => {
    const upstream = await startUpstream(async (request, response) => {
      await readRequestBody(request);
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
    cleanups.push(upstream.close);
    const fixture = await createFixture({ upstreamUrl: upstream.url });
    const help = await fixture.host.harness.behavior.runCli([
      "account",
      "add",
      "--help",
    ]);
    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain("--login");
    expect(help.stdout).toContain("account login-complete");
    expect(help.stdout).toContain("--api-key-stdin");
    expect(help.stdout).toContain(
      "Use --api-key-stdin to keep it out of process arguments",
    );
    const loginCompleteHelp = await fixture.host.harness.behavior.runCli([
      "account",
      "login-complete",
      "--help",
    ]);
    expect(loginCompleteHelp.exitCode).toBe(0);
    expect(loginCompleteHelp.stdout).toContain("--code-stdin");
    const topLevelHelp = await fixture.host.harness.behavior.runCli(["--help"]);
    expect(topLevelHelp.exitCode).toBe(0);
    expect(topLevelHelp.stdout).toContain("bb pool account refresh");
    expect(topLevelHelp.stdout).toContain("bb pool account login-poll");
    const refreshHelp = await fixture.host.harness.behavior.runCli([
      "account",
      "refresh",
      "--help",
    ]);
    expect(refreshHelp.exitCode).toBe(0);
    expect(refreshHelp.stdout).toContain("bb pool account refresh <id>");
    const list = await fixture.host.harness.behavior.runCli([
      "account",
      "list",
      "--json",
    ]);
    const listed = z
      .object({ accounts: z.array(accountSummarySchema) })
      .strict()
      .parse(JSON.parse(list.stdout));
    const account = listed.accounts[0];
    if (account === undefined) throw new Error("CLI account was not listed.");
    expect(account).toMatchObject({ label: "Claude API key", priority: 100 });
    expect(
      await fixture.host.harness.behavior.runCli([
        "account",
        "refresh",
        account.id,
      ]),
    ).toMatchObject({ exitCode: 0 });
    const refreshedAsJson = await fixture.host.harness.behavior.runCli([
      "account",
      "refresh",
      account.id,
      "--json",
    ]);
    expect(refreshedAsJson.exitCode).toBe(0);
    expect(JSON.parse(refreshedAsJson.stdout)).toMatchObject({
      ok: true,
      account: { id: account.id },
    });
    const configAsJson = await fixture.host.harness.behavior.runCli([
      "config",
      "--json",
    ]);
    expect(configAsJson.exitCode).toBe(0);
    expect(JSON.parse(configAsJson.stdout)).toMatchObject({
      ok: true,
      config: { switchThreshold: expect.any(Number) },
    });
    expect(
      (
        await fixture.host.harness.behavior.runCli([
          "account",
          "disable",
          account.id,
        ])
      ).exitCode,
    ).toBe(0);
    expect(
      z
        .array(accountSummarySchema)
        .parse(
          await fixture.host.harness.behavior.callRpc("account.list", null),
        )[0]?.status,
    ).toBe("disabled");
    expect(
      (
        await fixture.host.harness.behavior.runCli([
          "account",
          "enable",
          account.id,
        ])
      ).exitCode,
    ).toBe(0);
    const publicStatus = statusReportSchema.parse(
      JSON.parse(
        (await fixture.host.harness.behavior.runCli(["status", "--json"]))
          .stdout,
      ),
    );
    expect(publicStatus.accepting).toBe(true);
    expect(publicStatus.hosts).toEqual([
      expect.objectContaining({ hostId: "host-one", hostName: "One" }),
    ]);
    expect(publicStatus).not.toHaveProperty("hubKey");
    expect(JSON.stringify(publicStatus)).not.toContain(fixture.key);
    const counted = await fixture.host.harness.behavior.fetchHttp(
      "POST",
      "/v1/messages/count_tokens",
      { headers: authHeaders(fixture.key), body: "{}" },
    );
    expect(counted.status).toBe(200);
    expect(await counted.text()).toBe("{}");
    expect(
      (
        await fixture.host.harness.behavior.runCli([
          "account",
          "remove",
          account.id,
        ])
      ).exitCode,
    ).toBe(0);
    expect(
      await fixture.host.harness.behavior.callRpc("account.list", null),
    ).toEqual([]);
  });

  it("refuses unusable pool invocations instead of guessing", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "bb-account-pool-cli-"));
    const host = createFakePluginHost({
      pluginId: "account-pool",
      dataDir,
      sdk: sdkStubs(),
    });
    await createAccountPoolPlugin()(host.bb);
    cleanups.push(async () => {
      await host.harness.lifecycle.dispose();
      await fs.rm(dataDir, { recursive: true, force: true });
    });
    const run = (argv: string[], ctx?: { threadId: string }) =>
      host.harness.behavior.runCli(argv, ctx);

    const strayArgument = await run(["status", "everything"]);
    expect(strayArgument.exitCode).toBe(1);
    expect(strayArgument.stderr).toContain("unexpected argument 'everything'");

    const allMissing = await run(["account", "login-complete"]);
    expect(allMissing.exitCode).toBe(1);
    expect(allMissing.stderr).toContain(
      "missing required options: --session, --code",
    );

    const stdinFlag = await run([
      "account",
      "login-complete",
      "--session",
      "11111111-1111-4111-8111-111111111111",
      "--code-stdin",
    ]);
    expect(stdinFlag.exitCode).toBe(1);
    expect(stdinFlag.stderr).toContain(
      "--code-stdin must be supplied by the bb CLI through stdin",
    );

    const badProvider = await run([
      "account",
      "add",
      "--provider",
      "gemini",
      "--import",
    ]);
    expect(badProvider.exitCode).toBe(1);
    expect(badProvider.stderr).toContain(
      "invalid value 'gemini' for --provider. Expected one of: claude, codex",
    );

    const conflicting = await run([
      "account",
      "add",
      "--provider",
      "claude",
      "--import",
      "--login",
    ]);
    expect(conflicting.exitCode).toBe(1);
    expect(conflicting.stderr).toContain(
      "--login and --import cannot be combined",
    );

    const jsonEnvelope = await run([
      "account",
      "add",
      "--provider",
      "claude",
      "--json",
    ]);
    expect(jsonEnvelope.exitCode).toBe(1);
    expect(JSON.parse(jsonEnvelope.stdout)).toEqual({
      ok: false,
      error: {
        code: "missing_required",
        message:
          "missing required options: one of --login, --import, --api-key",
        hint: expect.stringContaining("bb pool account add"),
      },
    });
    expect(jsonEnvelope.stderr).toContain(
      "missing required options: one of --login, --import, --api-key",
    );

    const bypassWithoutThread = await run(["bypass"], {
      threadId: "thread-seven",
    });
    expect(bypassWithoutThread.exitCode).toBe(1);
    expect(bypassWithoutThread.stderr).toContain(
      "This thread is thread-seven; re-run with bb pool bypass thread-seven",
    );
  });

  it("exposes manual Claude login over RPC and the two-step CLI", async () => {
    const tokenBodies: object[] = [];
    const oauth = await startUpstream(async (request, response) => {
      if (request.url === "/token") {
        tokenBodies.push(
          JSON.parse((await readRequestBody(request)).toString()),
        );
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            access_token: "login-access",
            refresh_token: "login-refresh",
            expires_in: 3600,
          }),
        );
        return;
      }
      if (request.url === "/profile") {
        expect(request.headers.authorization).toBe("Bearer login-access");
        expect(request.headers["anthropic-beta"]).toBe("oauth-2025-04-20");
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            account: {
              uuid: "22222222-2222-4222-8222-222222222222",
              email: "login@example.com",
              display_name: "Logged-in Claude",
              has_claude_pro: true,
              rate_limit_tier: "default_claude_pro",
            },
          }),
        );
        return;
      }
      response.statusCode = 404;
      response.end();
    });
    cleanups.push(oauth.close);
    const dataDir = await mkdtemp(path.join(tmpdir(), "bb-pool-login-rpc-"));
    const host = createFakePluginHost({
      pluginId: "account-pool",
      dataDir,
      sdk: sdkStubs(),
    });
    await createAccountPoolPlugin({
      oauthAuthorizeUrl: `${oauth.url}/authorize`,
      oauthTokenUrl: `${oauth.url}/token`,
      oauthProfileUrl: `${oauth.url}/profile`,
      usageUrl: "data:application/json,{}",
    })(host.bb);
    cleanups.push(async () => {
      await host.harness.lifecycle.dispose();
      await fs.rm(dataDir, { recursive: true, force: true });
    });
    const started = z
      .object({ sessionId: z.string().uuid(), authorizeUrl: z.string().url() })
      .strict()
      .parse(await host.harness.behavior.callRpc("login.start", null));
    const state = new URL(started.authorizeUrl).searchParams.get("state");
    if (state === null) throw new Error("Login start did not return state.");
    const account = accountSchema.parse(
      await host.harness.behavior.callRpc("login.complete", {
        sessionId: started.sessionId,
        pasted: `login-code#${state}`,
      }),
    );
    expect(account).toMatchObject({
      label: "Logged-in Claude",
      email: "login@example.com",
      subscriptionType: "pro",
      rateLimitTier: "default_claude_pro",
      kind: "oauth",
      enabled: true,
    });
    expect(tokenBodies).toHaveLength(1);
    expect(tokenBodies[0]).toMatchObject({
      code: "login-code",
      state,
      grant_type: "authorization_code",
      redirect_uri: "https://console.anthropic.com/oauth/code/callback",
      client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
    });
    const secret = accountSecretSchema.parse(
      JSON.parse(
        await fs.readFile(
          path.join(
            dataDir,
            "plugins",
            "account-pool",
            "secrets",
            "accounts",
            `account-${account.id}.json`,
          ),
          "utf8",
        ),
      ),
    );
    expect(secret).toMatchObject({
      kind: "oauth",
      accessToken: "login-access",
      refreshToken: "login-refresh",
    });
    expect(host.harness.inspection.realtimeSignals).toContainEqual({
      channel: "accounts-changed",
      payload: {},
    });

    const cliStarted = await host.harness.behavior.runCli([
      "account",
      "add",
      "--provider",
      "claude",
      "--login",
    ]);
    expect(cliStarted.exitCode).toBe(0);
    expect(cliStarted.stdout).toContain("Open this URL to sign in to Claude:");
    expect(cliStarted.stdout).toContain("account login-complete");
    expect(cliStarted.stdout).toContain("--code-stdin");
    const sessionId = cliStarted.stdout.match(/Session ID: ([0-9a-f-]+)/u)?.[1];
    const authorizeUrl = cliStarted.stdout.match(
      /Open this URL to sign in to Claude:\n([^\n]+)/u,
    )?.[1];
    if (sessionId === undefined || authorizeUrl === undefined) {
      throw new Error("CLI login start did not return its session and URL.");
    }
    const cliState = new URL(authorizeUrl).searchParams.get("state");
    if (cliState === null) throw new Error("CLI login start omitted state.");
    const cliCompleted = await host.harness.behavior.runCli(
      ["account", "login-complete", "--session", sessionId, "--code-stdin"],
      {
        experimental_stdinInputs: { code: `cli-code#${cliState}` },
      },
    );
    expect(cliCompleted).toMatchObject({
      exitCode: 0,
      stdout: expect.stringContaining("Added Logged-in Claude"),
    });
    expect(tokenBodies).toHaveLength(2);
    expect(tokenBodies[1]).toMatchObject({ code: "cli-code", state: cliState });
  });

  it("exposes Codex device login over RPC and the two-step CLI", async () => {
    let holdTokenPoll = false;
    let markTokenPollStarted: () => void = () => {};
    const tokenPollStarted = new Promise<void>((resolve) => {
      markTokenPollStarted = resolve;
    });
    let releaseTokenPoll: () => void = () => {};
    const tokenPollRelease = new Promise<void>((resolve) => {
      releaseTokenPoll = resolve;
    });
    const auth = await startUpstream(async (request, response) => {
      await readRequestBody(request);
      response.setHeader("content-type", "application/json");
      if (request.url === "/api/accounts/deviceauth/usercode") {
        response.end(
          JSON.stringify({
            device_auth_id: "device-secret",
            user_code: "ABCD-1234",
            interval: "1",
            expires_in: 600,
          }),
        );
        return;
      }
      if (request.url === "/api/accounts/deviceauth/token") {
        if (holdTokenPoll) {
          markTokenPollStarted();
          await tokenPollRelease;
        }
        response.end(
          JSON.stringify({
            authorization_code: "authorization-secret",
            code_challenge: "challenge-secret",
            code_verifier: "verifier-secret",
          }),
        );
        return;
      }
      if (request.url === "/oauth/token") {
        response.end(
          JSON.stringify({
            access_token: testJwt({ exp: 2_000_000_000 }),
            refresh_token: "refresh-secret",
            id_token: testJwt({
              email: "codex@example.com",
              "https://api.openai.com/auth": {
                chatgpt_account_id: "chatgpt-account-1",
              },
            }),
          }),
        );
        return;
      }
      response.statusCode = 404;
      response.end("{}");
    });
    cleanups.push(auth.close);
    const dataDir = await mkdtemp(path.join(tmpdir(), "bb-pool-codex-login-"));
    const host = createFakePluginHost({
      pluginId: "account-pool",
      dataDir,
      sdk: sdkStubs(),
    });
    await createAccountPoolPlugin({
      codexAuthBaseUrl: auth.url,
      codexUsageUrl: EMPTY_USAGE_URL,
      usageUrl: "data:application/json,{}",
    })(host.bb);
    cleanups.push(async () => {
      await host.harness.lifecycle.dispose();
      await fs.rm(dataDir, { recursive: true, force: true });
    });

    const started = codexLoginStartSchema.parse(
      await host.harness.behavior.callRpc("codexLogin.start", null),
    );
    expect(started).toMatchObject({
      verificationUri: `${auth.url}/codex/device`,
      userCode: "ABCD-1234",
      intervalMs: 1_000,
    });
    expect(
      codexLoginPollSchema.parse(
        await host.harness.behavior.callRpc("codexLogin.poll", {
          sessionId: started.sessionId,
        }),
      ),
    ).toEqual({ status: "pending" });
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const completed = codexLoginPollSchema.parse(
      await host.harness.behavior.callRpc("codexLogin.poll", {
        sessionId: started.sessionId,
      }),
    );
    expect(completed).toMatchObject({
      status: "complete",
      account: {
        provider: "codex",
        codexAccountId: "chatgpt-account-1",
        email: "codex@example.com",
      },
    });

    const cliStarted = await host.harness.behavior.runCli([
      "account",
      "add",
      "--provider",
      "codex",
      "--login",
    ]);
    expect(cliStarted).toMatchObject({
      exitCode: 0,
      stdout: expect.stringContaining("Open this URL to sign in to Codex:"),
    });
    expect(cliStarted.stdout).toContain("Enter this code: ABCD-1234");
    expect(cliStarted.stdout).toContain("account login-poll --session");
    const sessionId = cliStarted.stdout.match(/Session ID: ([0-9a-f-]+)/u)?.[1];
    if (sessionId === undefined) {
      throw new Error("Codex CLI login start omitted its session ID.");
    }
    const cliCompleted = await host.harness.behavior.runCli([
      "account",
      "login-poll",
      "--session",
      sessionId,
    ]);
    expect(cliCompleted).toMatchObject({
      exitCode: 0,
      stdout: expect.stringContaining("Added codex@example.com"),
    });
    const cancelledStart = await host.harness.behavior.runCli([
      "account",
      "add",
      "--provider",
      "codex",
      "--login",
    ]);
    const cancelledSessionId = cancelledStart.stdout.match(
      /Session ID: ([0-9a-f-]+)/u,
    )?.[1];
    if (cancelledSessionId === undefined) {
      throw new Error("Codex CLI login start omitted its session ID.");
    }
    holdTokenPoll = true;
    const controller = new AbortController();
    const cancelledPoll = host.harness.behavior.runCli(
      ["account", "login-poll", "--session", cancelledSessionId],
      { signal: controller.signal },
    );
    await tokenPollStarted;
    controller.abort(new Error("cancelled by test"));
    expect(
      codexLoginPollSchema.parse(
        await host.harness.behavior.callRpc("codexLogin.poll", {
          sessionId: cancelledSessionId,
        }),
      ),
    ).toEqual({
      status: "error",
      message: "Login session was not found. Start again.",
    });
    releaseTokenPoll();
    expect(await cancelledPoll).toMatchObject({ exitCode: 1 });
    expect(host.harness.inspection.logEntries.join("\n")).not.toMatch(
      /device-secret|ABCD-1234|authorization-secret|verifier-secret|refresh-secret/u,
    );
  });

  it("resolves distinct secret machine tokens and honors per-thread bypass", async () => {
    const upstream = await startUpstream(async (request, response) => {
      await readRequestBody(request);
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
    cleanups.push(upstream.close);
    const fixture = await createFixture({ upstreamUrl: upstream.url });
    const first = await fixture.host.harness.behavior.resolveProviderEnv(
      "claude-code",
      {
        threadId: "thread-one",
        projectId: "project-one",
        hostId: "host-one",
      },
    );
    expect(first).toEqual([
      {
        name: "ANTHROPIC_BASE_URL",
        value: { serverPath: "/api/v1/plugins/account-pool/http" },
        reason: "Routed through the Account Pooler hub",
      },
      {
        name: "ANTHROPIC_AUTH_TOKEN",
        value: fixture.key,
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
      {
        name: "BB_ACCOUNT_POOL_PARENT_URL",
        value: { serverPath: "/api/v1/plugins/account-pool/http" },
        reason: "Account Pooler hub for nested bb servers on this machine",
      },
      {
        name: "BB_ACCOUNT_POOL_PARENT_TOKEN",
        value: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
        reason:
          "Account Pooler token scoped to this thread for nested bb servers it launches",
      },
    ]);
    await expect(
      fixture.host.harness.behavior.resolveProviderEnvHealth("claude-code", {
        hostId: "host-one",
      }),
    ).resolves.toEqual({
      label: "Proxied",
      statusMessage: "Credentials are provided by the Account Pooler hub.",
    });
    const secondToken = await resolveToken(
      fixture.host,
      "host-two",
      "thread-two",
    );
    expect(secondToken).not.toBe(fixture.key);
    expect(
      await fixture.host.harness.behavior.callRpc("bypass.set", {
        threadId: "thread-one",
        bypassed: true,
      }),
    ).toEqual({ threadId: "thread-one", bypassed: true });
    const publishedBypassRead =
      fixture.host.harness.registrations.experimental_publishedRpcMethods.find(
        ({ method }) => method === "bypass.get",
      );
    expect(publishedBypassRead).toMatchObject({
      methodDescription:
        "Reads whether Account Pooler routing is bypassed for one thread. This is read-only and does not change routing.",
    });
    await expect(
      fixture.host.harness.behavior.callRpc("bypass.get", {
        threadId: "thread-one",
      }),
    ).resolves.toEqual({ threadId: "thread-one", bypassed: true });
    await expect(
      fixture.host.harness.behavior.callRpc("bypass.get", {
        threadId: "thread-two",
      }),
    ).resolves.toEqual({ threadId: "thread-two", bypassed: false });
    await expect(
      fixture.host.harness.behavior.callRpc("bypass.get", {
        threadId: "thread-one",
        bypassed: false,
      }),
    ).rejects.toThrow();
    const bypassStatus = await fixture.host.harness.behavior.runCli([
      "bypass",
      "get",
      "thread-one",
      "--json",
    ]);
    expect(bypassStatus.exitCode).toBe(0);
    expect(JSON.parse(bypassStatus.stdout)).toEqual({
      ok: true,
      threadId: "thread-one",
      bypassed: true,
    });
    expect(
      await fixture.host.harness.behavior.resolveProviderEnv("claude-code", {
        threadId: "thread-one",
        projectId: "project-one",
        hostId: "host-one",
      }),
    ).toEqual([]);
    const off = await fixture.host.harness.behavior.runCli([
      "bypass",
      "thread-one",
      "--off",
    ]);
    expect(off.exitCode).toBe(0);
    expect(await resolveToken(fixture.host)).toBe(fixture.key);
  });

  it("withholds env and proxied health when an enabled account secret is missing", async () => {
    const upstream = await startUpstream(async (request, response) => {
      await readRequestBody(request);
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
    cleanups.push(upstream.close);
    const fixture = await createFixture({ upstreamUrl: upstream.url });
    const accountSecretFile = path.join(
      fixture.dataDir,
      "plugins",
      "account-pool",
      "secrets",
      "accounts",
      `account-${fixture.account.id}.json`,
    );
    await fs.rm(accountSecretFile);
    await expect(
      fixture.host.harness.behavior.resolveProviderEnv("claude-code", {
        threadId: "thread-without-secret",
        projectId: "project-one",
        hostId: "host-one",
      }),
    ).resolves.toEqual([]);
    await expect(
      fixture.host.harness.behavior.resolveProviderEnvHealth("claude-code", {
        hostId: "host-one",
      }),
    ).resolves.toBeNull();
  });

  it("rotates a machine token with a ten-minute grace window", async () => {
    let now = 1_000;
    const upstream = await startUpstream(async (request, response) => {
      await readRequestBody(request);
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
    cleanups.push(upstream.close);
    const fixture = await createFixture({
      upstreamUrl: upstream.url,
      options: { now: () => now },
    });
    const first = await fixture.host.harness.behavior.fetchHttp(
      "POST",
      "/v1/messages",
      { headers: authHeaders(fixture.key), body: "{}" },
    );
    expect(first.status).toBe(200);
    await first.text();
    now = 2_000;
    const rotate = await fixture.host.harness.behavior.runCli([
      "token",
      "rotate",
      "--machine",
      "One",
    ]);
    expect(rotate.exitCode).toBe(0);
    expect(rotate.stdout).not.toContain(fixture.key);
    const nextKey = await resolveToken(fixture.host);
    expect(nextKey).not.toBe(fixture.key);
    now += 9 * 60 * 1_000;
    const grace = await fixture.host.harness.behavior.fetchHttp(
      "POST",
      "/v1/messages",
      { headers: authHeaders(fixture.key), body: "{}" },
    );
    expect(grace.status).toBe(200);
    await grace.text();
    now = 2_000 + 10 * 60 * 1_000 + 1;
    const expired = await fixture.host.harness.behavior.fetchHttp(
      "POST",
      "/v1/messages",
      { headers: authHeaders(fixture.key), body: "{}" },
    );
    expect(expired.status).toBe(401);
    const current = await fixture.host.harness.behavior.fetchHttp(
      "POST",
      "/v1/messages",
      { headers: authHeaders(nextKey), body: "{}" },
    );
    expect(current.status).toBe(200);
    await current.text();
    const tokenFile = path.join(
      fixture.dataDir,
      "plugins",
      "account-pool",
      "secrets",
      "accounts",
      "hub-token-host-one.json",
    );
    expect(await fs.readFile(tokenFile, "utf8")).not.toContain(fixture.key);
    const status = statusSchema.parse(
      await fixture.host.harness.behavior.callRpc("status.get", null),
    );
    expect(status.hosts).toEqual([
      {
        hostId: "host-one",
        hostName: "One",
        mintedAt: 2_000,
        lastUsedAt: now,
      },
    ]);
    expect(JSON.stringify(status)).not.toContain(fixture.key);
    expect(JSON.stringify(status)).not.toContain(nextKey);
  });

  it("reports routed threads without local login and logs them on disable", async () => {
    const upstream = await startUpstream(async (request, response) => {
      await readRequestBody(request);
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
    cleanups.push(upstream.close);
    const fixture = await createFixture({ upstreamUrl: upstream.url });
    await resolveToken(fixture.host, "host-two", "thread-two");
    fixture.host.harness.sdk.stub(
      "system.providerStates",
      async ({ hostId }) => ({
        providers: [
          {
            providerId: "claude-code",
            status: hostId === "host-one" ? "unauthenticated" : "ready",
            planLabel: null,
          },
        ],
      }),
    );
    const routedThreads = routedThreadStatusListSchema.parse(
      await fixture.host.harness.behavior.callRpc("status.routedThreads", null),
    );
    expect(routedThreads).toEqual([
      {
        threadId: "thread-one",
        hostId: "host-one",
        hostName: "One",
        routedAt: expect.any(Number),
        localClaudeStatus: "unauthenticated",
      },
    ]);
    fixture.host.harness.sdk.stub("plugins.list", async () => ({
      plugins: [{ id: "account-pool", enabled: false }],
    }));
    await fixture.host.harness.lifecycle.dispose();
    expect(fixture.host.harness.inspection.logEntries).toContainEqual({
      level: "warn",
      message:
        "Account Pooler disabled with 1 recently routed thread on machines without a local Claude login. Run bb pool status before disabling to inspect them.",
    });
  });

  it("does not fail disposal when disable inspection rejects", async () => {
    const upstream = await startUpstream(async (request, response) => {
      await readRequestBody(request);
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
    cleanups.push(upstream.close);
    const fixture = await createFixture({ upstreamUrl: upstream.url });
    fixture.host.harness.sdk.stub("plugins.list", async () => {
      throw new Error("plugin list unavailable");
    });
    await expect(fixture.host.harness.lifecycle.dispose()).resolves.toBe(
      undefined,
    );
    expect(fixture.host.harness.inspection.logEntries).toContainEqual({
      level: "debug",
      message:
        "Account Pooler disable inspection skipped: plugin list unavailable",
    });
  });

  it("bounds disable inspection when provider states hang", async () => {
    const upstream = await startUpstream(async (request, response) => {
      await readRequestBody(request);
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
    cleanups.push(upstream.close);
    const fixture = await createFixture({
      upstreamUrl: upstream.url,
      options: { disposeTimeoutMs: 10 },
    });
    fixture.host.harness.sdk.stub("plugins.list", async () => ({
      plugins: [{ id: "account-pool", enabled: false }],
    }));
    fixture.host.harness.sdk.stub(
      "system.providerStates",
      () => new Promise(() => {}),
    );
    await expect(fixture.host.harness.lifecycle.dispose()).resolves.toBe(
      undefined,
    );
    expect(fixture.host.harness.inspection.logEntries).toContainEqual({
      level: "debug",
      message: "Account Pooler disable inspection timed out.",
    });
  });

  it("keeps proxied routed hosts visible in status", async () => {
    const upstream = await startUpstream(async (request, response) => {
      await readRequestBody(request);
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
    cleanups.push(upstream.close);
    const fixture = await createFixture({ upstreamUrl: upstream.url });
    fixture.host.harness.sdk.stub("system.providerStates", async () => ({
      providers: [
        {
          providerId: "claude-code",
          status: "ready",
          planLabel: "Proxied",
        },
      ],
    }));
    const routedThreads = routedThreadStatusListSchema.parse(
      await fixture.host.harness.behavior.callRpc("status.routedThreads", null),
    );
    expect(routedThreads).toEqual([
      {
        threadId: "thread-one",
        hostId: "host-one",
        hostName: "One",
        routedAt: expect.any(Number),
        localClaudeStatus: "proxied",
      },
    ]);
  });

  it("requires a machine token and forwards a streaming SSE response byte for byte", async () => {
    const seen: {
      url: string;
      authorization: string | undefined;
      clientApiKey: string | undefined;
      beta: string | undefined;
      version: string | undefined;
      userAgent: string | undefined;
      app: string | undefined;
      stainlessRetry: string | undefined;
      cookie: string | undefined;
      gateMachineId: string | undefined;
      forwarded: string | undefined;
      cfRay: string | undefined;
      body: Buffer;
    }[] = [];
    const first = Buffer.from('event: message_start\ndata: {"one":1}\n\n');
    const second = Buffer.from('event: message_stop\ndata: {"two":2}\n\n');
    const upstream = await startUpstream(async (request, response) => {
      seen.push({
        url: request.url ?? "",
        authorization: request.headers.authorization,
        clientApiKey: request.headers["x-api-key"]?.toString(),
        beta: request.headers["anthropic-beta"]?.toString(),
        version: request.headers["anthropic-version"]?.toString(),
        userAgent: request.headers["user-agent"]?.toString(),
        app: request.headers["x-app"]?.toString(),
        stainlessRetry: request.headers["x-stainless-retry-count"]?.toString(),
        cookie: request.headers.cookie,
        gateMachineId: request.headers["x-bb-gate-machine-id"]?.toString(),
        forwarded: request.headers.forwarded,
        cfRay: request.headers["cf-ray"]?.toString(),
        body: await readRequestBody(request),
      });
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "anthropic-ratelimit-unified-5h-utilization": "0.25",
        "anthropic-ratelimit-unified-5h-reset": "4102444800",
        "anthropic-ratelimit-unified-5h-status": "allowed",
        "anthropic-ratelimit-unified-7d-utilization": "0.5",
        "anthropic-ratelimit-unified-7d-reset": "4102448400",
        "anthropic-ratelimit-unified-7d-status": "allowed",
        "anthropic-ratelimit-unified-representative-claim": "claim-a",
        "anthropic-ratelimit-unified-status": "rejected",
        "anthropic-ratelimit-unified-overage-status": "rejected",
        "anthropic-ratelimit-unified-7d_oi-status": "rejected",
        "anthropic-ratelimit-unified-7d_oi-reset": "4102452000",
      });
      response.write(first);
      setTimeout(() => response.end(second), 60);
    });
    cleanups.push(upstream.close);
    const fixture = await createFixture({
      upstreamUrl: upstream.url,
      source: "import",
      options: { importCredentials: async () => importedCredentials() },
    });
    const unauthorized = await fixture.host.harness.behavior.fetchHttp(
      "POST",
      "/v1/messages",
      { headers: { "content-type": "application/json" }, body: "{}" },
    );
    expect(unauthorized.status).toBe(401);
    expect(seen).toHaveLength(0);
    const body = Buffer.from('{"model":"claude-fable-5","stream":true}');
    const response = await fixture.host.harness.behavior.fetchHttp(
      "POST",
      "/v1/messages?beta=true",
      {
        headers: {
          ...authHeaders(fixture.key),
          "x-api-key": "client-key-must-not-forward",
          "anthropic-beta": "feature-a,feature-b",
          "user-agent": "claude-code-test",
          "x-app": "cli",
          "x-stainless-retry-count": "2",
          cookie: "bb_session=browser-secret",
          "x-bb-gate-machine-id": "machine-stable-id",
          forwarded: "for=192.0.2.1",
          "cf-ray": "edge-request-id",
          "accept-encoding": "gzip",
        },
        body,
      },
    );
    expect(response.status).toBe(200);
    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error("Expected an SSE response body.");
    const firstRead = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("First SSE chunk was buffered.")),
          30,
        ),
      ),
    ]);
    expect(firstRead.done).toBe(false);
    expect(Buffer.from(firstRead.value ?? []).equals(first)).toBe(true);
    const remaining: Buffer[] = [];
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      remaining.push(Buffer.from(chunk.value));
    }
    expect(
      Buffer.concat([Buffer.from(firstRead.value ?? []), ...remaining]),
    ).toEqual(Buffer.concat([first, second]));
    expect(seen).toEqual([
      {
        url: "/v1/messages?beta=true",
        authorization: "Bearer oauth-access",
        clientApiKey: undefined,
        beta: "feature-a,feature-b",
        version: "2023-06-01",
        userAgent: "claude-code-test",
        app: "cli",
        stainlessRetry: "2",
        cookie: undefined,
        gateMachineId: undefined,
        forwarded: undefined,
        cfRay: undefined,
        body,
      },
    ]);
    const accounts = z
      .array(accountSummarySchema)
      .parse(await fixture.host.harness.behavior.callRpc("account.list", null));
    expect(accounts[0]).toMatchObject({
      fiveHourUtilization: 0.25,
      sevenDayUtilization: 0.5,
      fiveHourStatus: "allowed",
      sevenDayStatus: "allowed",
      representativeClaim: "claim-a",
      familyWeekly: {
        fable: {
          utilization: null,
          resetAt: 4_102_452_000_000,
          status: "rejected",
          observedAt: expect.any(Number),
          source: "header",
        },
      },
    });
    expect(fixture.host.harness.inspection.registrations.httpRoutes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: "HEAD",
          path: "/api/hello",
          auth: "none",
        }),
      ]),
    );
  });

  it("errors a failed non-SSE stream without appending an SSE frame", async () => {
    const partial = Buffer.from('{"partial":');
    const upstream = await startUpstream(async (request, response) => {
      await readRequestBody(request);
      response.writeHead(200, { "content-type": "application/json" });
      response.write(partial);
      setTimeout(() => response.destroy(new Error("upstream failed")), 30);
    });
    cleanups.push(upstream.close);
    const fixture = await createFixture({ upstreamUrl: upstream.url });
    const response = await fixture.host.harness.behavior.fetchHttp(
      "POST",
      "/v1/messages",
      { headers: authHeaders(fixture.key), body: "{}" },
    );
    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error("Expected a streaming body.");
    const first = await reader.read();
    expect(first.done).toBe(false);
    expect(Buffer.from(first.value ?? [])).toEqual(partial);
    await expect(reader.read()).rejects.toThrow();
  });

  it("applies config threshold changes live and rotates quota rejections", async () => {
    const keys: string[] = [];
    let requestNumber = 0;
    const upstream = await startUpstream((request, response) => {
      requestNumber += 1;
      keys.push(request.headers["x-api-key"]?.toString() ?? "");
      if (requestNumber === 1) {
        response.writeHead(200, {
          "content-type": "application/json",
          "anthropic-ratelimit-unified-5h-utilization": "0.75",
          "anthropic-ratelimit-unified-5h-reset": "4102444800",
          "anthropic-ratelimit-unified-5h-status": "allowed",
        });
        response.end('{"first":true}');
        return;
      }
      if (requestNumber === 2) {
        response.writeHead(429, {
          "content-type": "application/json",
          "anthropic-ratelimit-unified-5h-status": "rejected",
          "anthropic-ratelimit-unified-5h-reset": "4102444800",
        });
        response.end('{"rejected":true}');
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"rotated":true}');
    });
    cleanups.push(upstream.close);
    const fixture = await createFixture({
      upstreamUrl: upstream.url,
      apiKey: "sk-one",
    });
    await addApiAccount(fixture, "sk-two");
    await addApiAccount(fixture, "sk-three");
    const first = await fixture.host.harness.behavior.fetchHttp(
      "POST",
      "/v1/messages",
      {
        headers: authHeaders(fixture.key),
        body: "{}",
      },
    );
    expect(first.status).toBe(200);
    await first.text();
    expect(
      accountPoolConfigSchema.parse(
        await fixture.host.harness.behavior.callRpc("config.set", {
          switchThreshold: 0.7,
        }),
      ).switchThreshold,
    ).toBe(0.7);
    const rotated = await fixture.host.harness.behavior.fetchHttp(
      "POST",
      "/v1/messages",
      {
        headers: authHeaders(fixture.key),
        body: "{}",
      },
    );
    expect(rotated.status).toBe(200);
    expect(await rotated.text()).toBe('{"rotated":true}');
    expect(keys).toEqual(["sk-one", "sk-two", "sk-three"]);
  });

  it("routes around a Fable-spent account while retaining it for Opus", async () => {
    const keys: string[] = [];
    const upstream = await startUpstream(async (request, response) => {
      keys.push(request.headers["x-api-key"]?.toString() ?? "");
      await readRequestBody(request);
      if (keys.length === 1) {
        response.writeHead(200, {
          "content-type": "application/json",
          "anthropic-ratelimit-unified-5h-status": "allowed",
          "anthropic-ratelimit-unified-7d-status": "allowed",
          "anthropic-ratelimit-unified-7d_oi-utilization": "0.99",
          "anthropic-ratelimit-unified-7d_oi-reset": "4102452000",
          "anthropic-ratelimit-unified-7d_oi-status": "allowed",
        });
      } else {
        response.writeHead(200, { "content-type": "application/json" });
      }
      response.end("{}");
    });
    cleanups.push(upstream.close);
    const fixture = await createFixture({
      upstreamUrl: upstream.url,
      apiKey: "sk-one",
    });
    await addApiAccount(fixture, "sk-two");

    for (const model of [
      "claude-fable-5",
      "claude-fable-5",
      "claude-opus-4-1",
    ]) {
      const response = await fixture.host.harness.behavior.fetchHttp(
        "POST",
        "/v1/messages",
        {
          headers: authHeaders(fixture.key),
          body: JSON.stringify({ model }),
        },
      );
      expect(response.status).toBe(200);
      await response.text();
    }

    expect(keys).toEqual(["sk-one", "sk-two", "sk-one"]);
  });

  it("rotates a family-only 429 without exhausting other families", async () => {
    const keys: string[] = [];
    const upstream = await startUpstream(async (request, response) => {
      keys.push(request.headers["x-api-key"]?.toString() ?? "");
      await readRequestBody(request);
      if (keys.length === 1) {
        response.writeHead(429, {
          "content-type": "application/json",
          "anthropic-ratelimit-unified-5h-status": "allowed",
          "anthropic-ratelimit-unified-7d-status": "allowed",
          "anthropic-ratelimit-unified-7d_oi-reset": "4102452000",
          "anthropic-ratelimit-unified-7d_oi-status": "rejected",
        });
        response.end('{"rejected":true}');
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
    cleanups.push(upstream.close);
    const fixture = await createFixture({
      upstreamUrl: upstream.url,
      apiKey: "sk-one",
    });
    await addApiAccount(fixture, "sk-two");

    const fable = await fixture.host.harness.behavior.fetchHttp(
      "POST",
      "/v1/messages",
      {
        headers: authHeaders(fixture.key),
        body: JSON.stringify({ model: "claude-fable-5" }),
      },
    );
    expect(fable.status).toBe(200);
    await fable.text();
    const opus = await fixture.host.harness.behavior.fetchHttp(
      "POST",
      "/v1/messages",
      {
        headers: authHeaders(fixture.key),
        body: JSON.stringify({ model: "claude-opus-4-1" }),
      },
    );
    expect(opus.status).toBe(200);
    await opus.text();

    expect(keys).toEqual(["sk-one", "sk-two", "sk-one"]);
    const accounts = z
      .array(accountSummarySchema)
      .parse(await fixture.host.harness.behavior.callRpc("account.list", null));
    expect(accounts[0]).toMatchObject({
      status: "ready",
      familyWeekly: {
        fable: { status: "rejected", source: "header" },
      },
    });
  });

  it("rotates when a same-account retry reveals a family limit", async () => {
    const keys: string[] = [];
    const fixture = await createFixture({
      upstreamUrl: "https://upstream.example",
      apiKey: "sk-one",
      options: {
        fetch: async (_input, init) => {
          keys.push(new Headers(init?.headers).get("x-api-key") ?? "");
          if (keys.length === 1) {
            return Response.json(
              { minute: true },
              { status: 429, headers: { "retry-after": "0" } },
            );
          }
          if (keys.length === 2) {
            return Response.json(
              { family: true },
              {
                status: 429,
                headers: {
                  "anthropic-ratelimit-unified-5h-status": "allowed",
                  "anthropic-ratelimit-unified-7d-status": "allowed",
                  "anthropic-ratelimit-unified-7d_oi-reset": "4102452000",
                  "anthropic-ratelimit-unified-7d_oi-status": "rejected",
                },
              },
            );
          }
          return Response.json({ rotated: true });
        },
      },
    });
    await addApiAccount(fixture, "sk-two");
    const response = await fixture.host.harness.behavior.fetchHttp(
      "POST",
      "/v1/messages",
      {
        headers: authHeaders(fixture.key),
        body: JSON.stringify({ model: "claude-fable-5" }),
      },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ rotated: true });
    expect(keys).toEqual(["sk-one", "sk-one", "sk-two"]);
  });

  it("refreshes usage on import and routes from its family observations", async () => {
    const authorizations: Array<string | undefined> = [];
    const usageCalls = new Map<string, number>();
    const upstream = await startUpstream(async (request, response) => {
      if (request.url === "/usage") {
        const authorization = request.headers.authorization;
        usageCalls.set(
          authorization ?? "",
          (usageCalls.get(authorization ?? "") ?? 0) + 1,
        );
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            five_hour: { utilization: 10, resets_at: "4102444800" },
            seven_day: { utilization: 20, resets_at: "4102448400" },
            limits: [
              {
                kind: "weekly_scoped",
                group: "weekly",
                percent: authorization === "Bearer oauth-a" ? 100 : 0,
                resets_at: "4102452000",
                scope: { model: { display_name: "Fable" } },
              },
            ],
          }),
        );
        return;
      }
      if (request.url === "/profile") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            account: { uuid: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
          }),
        );
        return;
      }
      authorizations.push(request.headers.authorization);
      await readRequestBody(request);
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
    cleanups.push(upstream.close);
    const imports = [
      importedCredentials({
        accessToken: "oauth-a",
        accountUuid: null,
      }),
      importedCredentials({
        accessToken: "oauth-b",
        accountUuid: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      }),
    ];
    let importIndex = 0;
    const fixture = await createFixture({
      upstreamUrl: upstream.url,
      source: "import",
      options: {
        usageUrl: `${upstream.url}/usage`,
        oauthProfileUrl: `${upstream.url}/profile`,
        importCredentials: async () => {
          const imported = imports[importIndex];
          importIndex += 1;
          if (imported === undefined) throw new Error("No import fixture.");
          return imported;
        },
      },
    });
    const second = accountSchema.parse(
      await fixture.host.harness.behavior.callRpc("account.add", {
        provider: "claude",
        source: { kind: "import" },
        label: "second",
        priority: 100,
      }),
    );
    expect(usageCalls).toEqual(
      new Map([
        ["Bearer oauth-a", 1],
        ["Bearer oauth-b", 1],
      ]),
    );
    await fixture.host.harness.behavior.callRpc("account.disable", {
      id: second.id,
    });
    await fixture.host.harness.behavior.callRpc("account.enable", {
      id: second.id,
    });
    expect(usageCalls.get("Bearer oauth-a")).toBe(1);
    expect(usageCalls.get("Bearer oauth-b")).toBe(2);
    const listed = await fixture.host.harness.behavior.runCli([
      "account",
      "list",
    ]);
    expect(listed.stdout).toContain("Fable");
    expect(listed.stdout).toContain("100% rejected");
    expect(listed.stdout).toContain("0% allowed");
    const accounts = z
      .array(accountSummarySchema)
      .parse(await fixture.host.harness.behavior.callRpc("account.list", null));
    expect(accounts[0]?.accountUuid).toBe(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    );

    for (const model of ["claude-fable-5", "claude-opus-4-1"]) {
      const response = await fixture.host.harness.behavior.fetchHttp(
        "POST",
        "/v1/messages",
        {
          headers: authHeaders(fixture.key),
          body: JSON.stringify({ model }),
        },
      );
      expect(response.status).toBe(200);
      await response.text();
    }

    expect(authorizations).toEqual(["Bearer oauth-b", "Bearer oauth-b"]);
  });

  it("rewrites both known metadata account UUID formats", async () => {
    const bodies: Buffer[] = [];
    const upstream = await startUpstream(async (request, response) => {
      bodies.push(await readRequestBody(request));
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
    cleanups.push(upstream.close);
    const accountUuid = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const oldUuid = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const fixture = await createFixture({
      upstreamUrl: upstream.url,
      source: "import",
      options: {
        importCredentials: async () => importedCredentials({ accountUuid }),
      },
    });
    const inputs = [
      JSON.stringify({
        model: "claude-fable-5",
        metadata: {
          user_id: JSON.stringify({
            device_id: "device",
            account_uuid: oldUuid,
          }),
        },
      }),
      JSON.stringify({
        model: "claude-fable-5",
        metadata: {
          user_id: `user_hash_account_${oldUuid}_session_cccccccc-cccc-4ccc-8ccc-cccccccccccc`,
        },
      }),
    ];
    for (const body of inputs) {
      const response = await fixture.host.harness.behavior.fetchHttp(
        "POST",
        "/v1/messages",
        { headers: authHeaders(fixture.key), body },
      );
      await response.text();
    }
    expect(bodies).toHaveLength(2);
    expect(bodies.every((body) => body.toString().includes(accountUuid))).toBe(
      true,
    );
    expect(bodies.every((body) => !body.toString().includes(oldUuid))).toBe(
      true,
    );
  });

  it("preserves request bytes when an account UUID rewrite cannot apply", async () => {
    const bodies: Buffer[] = [];
    const upstream = await startUpstream(async (request, response) => {
      bodies.push(await readRequestBody(request));
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
    cleanups.push(upstream.close);
    const fixture = await createFixture({ upstreamUrl: upstream.url });
    const inputs = [
      JSON.stringify({
        model: "claude-fable-5",
        metadata: {
          user_id: JSON.stringify({
            account_uuid: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          }),
        },
      }),
      '{ "model": "claude-fable-5", "messages": [] }',
      "not-json-at-all",
    ];
    for (const body of inputs) {
      const response = await fixture.host.harness.behavior.fetchHttp(
        "POST",
        "/v1/messages",
        { headers: authHeaders(fixture.key), body },
      );
      await response.text();
    }
    expect(bodies.map((body) => body.toString())).toEqual(inputs);
  });

  it("paces a per-minute 429 on the same account without rotating", async () => {
    const keys: string[] = [];
    const times: number[] = [];
    const upstream = await startUpstream((request, response) => {
      keys.push(request.headers["x-api-key"]?.toString() ?? "");
      times.push(Date.now());
      if (keys.length === 1) {
        response.writeHead(429, {
          "content-type": "application/json",
          "retry-after": "0.04",
        });
        response.end('{"minute":true}');
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"retried":true}');
    });
    cleanups.push(upstream.close);
    const fixture = await createFixture({
      upstreamUrl: upstream.url,
      apiKey: "sk-one",
    });
    await addApiAccount(fixture, "sk-two");
    const response = await fixture.host.harness.behavior.fetchHttp(
      "POST",
      "/v1/messages",
      {
        headers: authHeaders(fixture.key),
        body: "{}",
      },
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('{"retried":true}');
    expect(keys).toEqual(["sk-one", "sk-one"]);
    expect((times[1] ?? 0) - (times[0] ?? 0)).toBeGreaterThanOrEqual(30);
  });

  it.each([401, 403, 408, 500, 502, 503, 504, 529, "disconnect"])(
    "tries another account after a pre-stream %s failure",
    async (failure) => {
      const attempts: Array<string | undefined> = [];
      const upstream = await startUpstream(async (request, response) => {
        await readRequestBody(request);
        const key = request.headers["x-api-key"];
        attempts.push(typeof key === "string" ? key : undefined);
        if (key === "sk-first") {
          if (typeof failure === "string") {
            request.socket.destroy();
            return;
          }
          response.writeHead(failure, { "content-type": "application/json" });
          response.end('{"error":{"message":"first account failed"}}');
          return;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end('{"result":"second"}');
      });
      cleanups.push(upstream.close);
      const fixture = await createFixture({
        upstreamUrl: upstream.url,
        apiKey: "sk-first",
        priority: 0,
      });
      await addApiAccount(fixture, "sk-second", 100);
      const response = await fixture.host.harness.behavior.fetchHttp(
        "POST",
        "/v1/messages",
        { headers: authHeaders(fixture.key), body: "{}" },
      );
      const payload = await response.json();
      expect(response.status).toBe(200);
      expect(payload).toEqual({ result: "second" });
      expect(attempts).toEqual(["sk-first", "sk-second"]);
      const accounts = z
        .array(accountSummarySchema)
        .parse(
          await fixture.host.harness.behavior.callRpc("account.list", null),
        );
      expect(
        accounts.find((account) => account.id === fixture.account.id)?.error,
      ).toEqual(failure === 401 || failure === 403 ? expect.any(String) : null);
    },
  );

  describe.each<{ provider: "claude" | "codex"; route: string }>([
    { provider: "claude", route: "/v1/messages" },
    { provider: "codex", route: "/v1/responses" },
  ])("$provider rejected-token recovery", ({ provider, route }) => {
    it.each([
      {
        name: "401",
        statuses: [401, 200],
        refreshStatus: 200,
        sameToken: false,
      },
      {
        name: "429 then 401",
        statuses: [429, 401, 200],
        refreshStatus: 200,
        sameToken: false,
      },
      {
        name: "same-token refresh",
        statuses: [401, 200],
        refreshStatus: 200,
        sameToken: true,
      },
      {
        name: "401 then 429",
        statuses: [401, 429, 200],
        refreshStatus: 200,
        sameToken: false,
      },
      {
        name: "401 after both retry budgets",
        statuses: [401, 429, 401],
        refreshStatus: 200,
        sameToken: false,
      },
      {
        name: "repeated 401",
        statuses: [401, 401],
        refreshStatus: 200,
        sameToken: false,
      },
      {
        name: "refresh outage",
        statuses: [401],
        refreshStatus: 503,
        sameToken: false,
      },
    ])(
      "bounds $name recovery and never reuses rejected fallback credentials",
      async ({ statuses, refreshStatus, sameToken }) => {
        let now = 1_800_000_000_000;
        let refreshCalls = 0;
        let oauthStatus = refreshStatus;
        const newToken = sameToken
          ? "oauth-old"
          : testJwt({ exp: now / 1_000 + 3600 });
        const authorizations: Array<string | null> = [];
        const fixture = await createOAuthRequestFixture(
          provider,
          async (input, init) => {
            if (String(input).endsWith("/oauth/token")) {
              refreshCalls += 1;
              return Response.json(
                oauthStatus === 200
                  ? { access_token: newToken, expires_in: 3600 }
                  : { error: "temporarily_unavailable" },
                { status: oauthStatus },
              );
            }
            authorizations.push(
              new Headers(init?.headers).get("authorization"),
            );
            return Response.json(
              { result: "upstream" },
              {
                status: statuses[authorizations.length - 1] ?? 200,
                headers: { "retry-after": "0" },
              },
            );
          },
          () => now,
        );
        const response = await fixture.host.harness.behavior.fetchHttp(
          "POST",
          route,
          {
            headers: authHeaders(fixture.key),
            body: "{}",
          },
        );
        await response.text();
        expect(response.status).toBe(
          refreshStatus === 503 || statuses.at(-1) === 401
            ? 503
            : statuses.at(-1),
        );
        expect(refreshCalls).toBe(1);
        expect(authorizations).toEqual(
          statuses.map(
            (_status, index) =>
              `Bearer ${index > statuses.indexOf(401) && refreshStatus === 200 ? newToken : "oauth-old"}`,
          ),
        );
        if (refreshStatus === 503) {
          const held = await fixture.host.harness.behavior.fetchHttp(
            "POST",
            route,
            {
              headers: authHeaders(fixture.key),
              body: "{}",
            },
          );
          await held.text();
          expect(held.status).toBe(503);
          expect(authorizations).toHaveLength(1);
          expect(refreshCalls).toBe(1);
          now += 1_000;
          oauthStatus = 200;
          const recovered = await fixture.host.harness.behavior.fetchHttp(
            "POST",
            route,
            {
              headers: authHeaders(fixture.key),
              body: "{}",
            },
          );
          await recovered.text();
          expect(recovered.status).toBe(200);
          expect(refreshCalls).toBe(2);
          expect(authorizations.at(-1)).toBe(`Bearer ${newToken}`);
        }
      },
    );

    it("joins an unchanged normal flight once and reuses replacement tokens after a late 401", async () => {
      const now = 1_800_000_000_000;
      const newToken = testJwt({ exp: now / 1_000 + 3600 });
      const oldResponses: Array<() => void> = [];
      const authorizations: Array<string | null> = [];
      let refreshCalls = 0;
      let releaseRefresh = () => {};
      const refreshReleased = new Promise<void>((resolve) => {
        releaseRefresh = resolve;
      });
      const fixture = await createOAuthRequestFixture(
        provider,
        async (input, init) => {
          if (String(input).endsWith("/oauth/token")) {
            refreshCalls += 1;
            await refreshReleased;
            return Response.json({ access_token: newToken, expires_in: 3600 });
          }
          const authorization = new Headers(init?.headers).get("authorization");
          authorizations.push(authorization);
          if (authorization === "Bearer oauth-old") {
            await new Promise<void>((resolve) => {
              oldResponses.push(resolve);
            });
            return Response.json(
              { error: { message: "expired access token" } },
              { status: 401 },
            );
          }
          return Response.json({ result: "refreshed" });
        },
        () => now,
      );
      const requests = [1, 2].map(() =>
        fixture.host.harness.behavior.fetchHttp("POST", route, {
          headers: authHeaders(fixture.key),
          body: "{}",
        }),
      );
      let releaseRead = () => {};
      const readReleased = new Promise<void>((resolve) => {
        releaseRead = resolve;
      });
      const originalRead = AccountStore.prototype.readSecret;
      const read = vi.spyOn(AccountStore.prototype, "readSecret");
      try {
        await vi.waitFor(() => expect(oldResponses).toHaveLength(2));
        read.mockImplementation(async function (this: AccountStore, id) {
          const secret = await originalRead.call(this, id);
          await readReleased;
          return secret;
        });
        read.mockClear();
        requests.push(
          fixture.host.harness.behavior.fetchHttp("POST", route, {
            headers: authHeaders(fixture.key),
            body: "{}",
          }),
        );
        await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
        oldResponses[0]?.();
        oldResponses[1]?.();
        await new Promise<void>((resolve) => setImmediate(resolve));
        releaseRead();
        await vi.waitFor(() => {
          expect(oldResponses).toHaveLength(3);
          expect(refreshCalls).toBe(1);
        });
        releaseRefresh();
        const first = await Promise.all(requests.slice(0, 2));
        expect(first.map((response) => response.status)).toEqual([200, 200]);
        await Promise.all(first.map((response) => response.text()));
        oldResponses[2]?.();
        const late = await requests[2];
        expect(late?.status).toBe(200);
        await late?.text();
        expect(refreshCalls).toBe(1);
        expect(
          authorizations.filter((value) => value === `Bearer ${newToken}`),
        ).toHaveLength(3);
        const accounts = z
          .array(accountSummarySchema)
          .parse(
            await fixture.host.harness.behavior.callRpc("account.list", null),
          );
        expect(accounts[0]?.error).toBeNull();
      } finally {
        releaseRead();
        releaseRefresh();
        for (const release of oldResponses) release();
        await Promise.allSettled(
          requests.map(async (request) => {
            const response = await request;
            await response.text();
          }),
        );
        read.mockRestore();
      }
    });
  });

  it.each(["terminal", "same-token cooldown"])(
    "keeps late 401 recovery bounded after a %s refresh",
    async (outcome) => {
      const oldResponse = deferred();
      const refreshed = deferred();
      let now = 1_800_000_000_000;
      let attempts = 0;
      let refreshCalls = 0;
      const fixture = await createOAuthRequestFixture(
        "claude",
        async (input) => {
          if (String(input).endsWith("/oauth/token")) {
            refreshCalls += 1;
            if (refreshCalls === 1)
              return Response.json(
                {
                  error:
                    outcome === "terminal"
                      ? "invalid_grant"
                      : "temporarily_unavailable",
                },
                { status: outcome === "terminal" ? 400 : 503 },
              );
            await refreshed.promise;
            return Response.json({
              access_token: "oauth-old",
              expires_in: 3600,
            });
          }
          attempts += 1;
          const attempt = attempts;
          if (attempt === 1) await oldResponse.promise;
          return Response.json({}, { status: attempt <= 2 ? 401 : 200 });
        },
        () => now,
      );
      const send = () =>
        fixture.host.harness.behavior.fetchHttp("POST", "/v1/messages", {
          headers: authHeaders(fixture.key),
          body: "{}",
        });
      const requests = [send()];
      try {
        await vi.waitFor(() => expect(attempts).toBe(1));
        const rejected = await send();
        expect(rejected.status).toBe(outcome === "terminal" ? 401 : 503);
        await rejected.text();
        if (outcome === "same-token cooldown") {
          now += 1_000;
          requests.push(send());
          await vi.waitFor(() => expect(refreshCalls).toBe(2));
        }
        oldResponse.resolve();
        await new Promise<void>((resolve) => setImmediate(resolve));
        refreshed.resolve();
        const responses = await Promise.all(requests);
        await Promise.all(responses.map((response) => response.text()));
        expect(responses.map((response) => response.status)).toEqual(
          outcome === "terminal" ? [401] : [200, 200],
        );
        expect(refreshCalls).toBe(outcome === "terminal" ? 1 : 2);
        expect(attempts).toBe(outcome === "terminal" ? 2 : 4);
      } finally {
        oldResponse.resolve();
        refreshed.resolve();
        await Promise.allSettled(
          requests.map(async (request) => (await request).text()),
        );
      }
    },
  );

  it.each([false, true])(
    "separates rejection checks from credential flights when the reporting request is canceled: %s",
    async (cancelReporter) => {
      let attempts = 0;
      const fixture = await createOAuthRequestFixture(
        "claude",
        async (input) => {
          if (String(input).endsWith("/oauth/token"))
            return Response.json({
              access_token: "oauth-new",
              expires_in: 3600,
            });
          attempts += 1;
          return Response.json({}, { status: attempts <= 2 ? 401 : 200 });
        },
        () => 1_800_000_000_000,
      );
      const gate = deferred();
      const checking = deferred();
      const originalRead = AccountStore.prototype.readSecret;
      let reads = 0;
      const read = vi
        .spyOn(AccountStore.prototype, "readSecret")
        .mockImplementation(async function (this: AccountStore, id) {
          const secret = await originalRead.call(this, id);
          reads += 1;
          if (reads === 3) {
            checking.resolve();
            await gate.promise;
          }
          return secret;
        });
      const recordUsed = vi.spyOn(AccountStore.prototype, "recordUsed");
      const controller = new AbortController();
      const requests = [
        fixture.host.harness.behavior.fetchHttp("POST", "/v1/messages", {
          headers: authHeaders(fixture.key),
          body: "{}",
          signal: controller.signal,
        }),
      ];
      try {
        await checking.promise;
        requests.push(
          fixture.host.harness.behavior.fetchHttp("POST", "/v1/messages", {
            headers: authHeaders(fixture.key),
            body: "{}",
          }),
        );
        await vi.waitFor(() => expect(recordUsed).toHaveBeenCalledTimes(2));
        await Promise.all(
          recordUsed.mock.results.map((result) => result.value),
        );
        await new Promise<void>((resolve) => setImmediate(resolve));
        if (cancelReporter) controller.abort();
        gate.resolve();
        const responses = await Promise.all(requests);
        await Promise.all(responses.map((response) => response.text()));
        expect(responses.map((response) => response.status)).toEqual(
          cancelReporter ? [499, 200] : [503, 503],
        );
        expect(attempts).toBe(cancelReporter ? 3 : 2);
      } finally {
        gate.resolve();
        await Promise.allSettled(
          requests.map(async (request) => (await request).text()),
        );
        read.mockRestore();
        recordUsed.mockRestore();
      }
    },
  );

  it("cancels one forced-refresh waiter without canceling shared recovery", async () => {
    const gate = deferred();
    let refreshCalls = 0;
    const authorizations: Array<string | null> = [];
    const fixture = await createOAuthRequestFixture(
      "claude",
      async (input, init) => {
        if (String(input).endsWith("/oauth/token")) {
          refreshCalls += 1;
          await gate.promise;
          return Response.json({ access_token: "oauth-new", expires_in: 3600 });
        }
        const authorization = new Headers(init?.headers).get("authorization");
        authorizations.push(authorization);
        return Response.json(
          {},
          { status: authorization === "Bearer oauth-old" ? 401 : 200 },
        );
      },
      () => 1_800_000_000_000,
    );
    const controller = new AbortController();
    const requests = [controller.signal, undefined].map((signal) =>
      fixture.host.harness.behavior.fetchHttp("POST", "/v1/messages", {
        headers: authHeaders(fixture.key),
        body: "{}",
        signal,
      }),
    );
    try {
      await vi.waitFor(() => {
        expect(authorizations).toHaveLength(2);
        expect(refreshCalls).toBe(1);
      });
      controller.abort();
      const canceled = await requests[0];
      expect(canceled?.status).toBe(499);
      await canceled?.text();
      gate.resolve();
      const recovered = await requests[1];
      expect(recovered?.status).toBe(200);
      await recovered?.text();
      expect(refreshCalls).toBe(1);
      expect(authorizations).toEqual([
        "Bearer oauth-old",
        "Bearer oauth-old",
        "Bearer oauth-new",
      ]);
    } finally {
      gate.resolve();
      await Promise.allSettled(
        requests.map(async (request) => (await request).text()),
      );
    }
  });

  it("does not let a late second 401 poison a newer credential", async () => {
    const gate = deferred();
    let refreshCalls = 0;
    let newAttempts = 0;
    const fixture = await createOAuthRequestFixture(
      "claude",
      async (input, init) => {
        if (String(input).endsWith("/oauth/token")) {
          refreshCalls += 1;
          return Response.json({
            access_token: `oauth-new-${refreshCalls}`,
            expires_in: 3600,
          });
        }
        const authorization = new Headers(init?.headers).get("authorization");
        if (authorization === "Bearer oauth-new-2") return Response.json({});
        if (authorization === "Bearer oauth-new-1") {
          newAttempts += 1;
          if (newAttempts === 1) await gate.promise;
        }
        return Response.json({ error: "rejected token" }, { status: 401 });
      },
      () => 1_800_000_000_000,
    );
    const send = () =>
      fixture.host.harness.behavior.fetchHttp("POST", "/v1/messages", {
        headers: authHeaders(fixture.key),
        body: "{}",
      });
    const first = send();
    try {
      await vi.waitFor(() => expect(newAttempts).toBe(1));
      const second = await send();
      expect(second.status).toBe(200);
      await second.text();
      gate.resolve();
      const late = await first;
      expect(late.status).toBe(503);
      await late.text();
      const accounts = z
        .array(accountSummarySchema)
        .parse(
          await fixture.host.harness.behavior.callRpc("account.list", null),
        );
      expect(accounts[0]?.error).toBeNull();
      const next = await send();
      expect(next.status).toBe(200);
      await next.text();
      expect(refreshCalls).toBe(2);
    } finally {
      gate.resolve();
      const response = await first;
      if (!response.bodyUsed) await response.text();
    }
  });

  describe.each<{ provider: "claude" | "codex"; route: string }>([
    { provider: "claude", route: "/v1/messages" },
    { provider: "codex", route: "/v1/responses" },
  ])("$provider upstream credential rejection", ({ provider, route }) => {
    it.each([401, 403])(
      "holds a freshly refreshed token rejected with HTTP %s without marking an account error",
      async (status) => {
        let now = 1_800_000_000_000;
        let outage = true;
        let refreshCalls = 0;
        const authorizations: Array<string | null> = [];
        const fixture = await createOAuthRequestFixture(
          provider,
          async (input, init) => {
            if (String(input).endsWith("/oauth/token")) {
              refreshCalls += 1;
              return Response.json({
                access_token: `oauth-new-${refreshCalls}`,
                expires_in: 3600,
              });
            }
            authorizations.push(
              new Headers(init?.headers).get("authorization"),
            );
            if (!outage) return Response.json({ result: "recovered" });
            return Response.json(
              {
                error: {
                  message:
                    "Incorrect API key provided: sk-svcac***fvMA. You can find your API key at https://platform.openai.com/account/api-keys.",
                  type: "invalid_request_error",
                  code: "invalid_api_key",
                },
              },
              { status },
            );
          },
          () => now,
        );
        const send = async () => {
          const response = await fixture.host.harness.behavior.fetchHttp(
            "POST",
            route,
            { headers: authHeaders(fixture.key), body: "{}" },
          );
          return { status: response.status, body: await response.text() };
        };
        const accountState = async () =>
          z
            .array(accountSummarySchema)
            .parse(
              await fixture.host.harness.behavior.callRpc("account.list", null),
            )[0];

        const rejected = await send();
        expect(rejected.status).toBe(503);
        expect(rejected.body).toContain("invalid_api_key");
        expect(authorizations).toEqual([
          "Bearer oauth-old",
          "Bearer oauth-new-1",
        ]);
        expect(refreshCalls).toBe(1);
        expect(await accountState()).toMatchObject({ error: null });

        now += 30_000;
        const held = await send();
        expect(held.status).toBe(503);
        expect(authorizations).toHaveLength(2);
        expect(refreshCalls).toBe(1);

        now += 31_000;
        outage = false;
        const recovered = await send();
        expect(recovered.status).toBe(200);
        expect(authorizations.at(-1)).toBe("Bearer oauth-new-1");
        expect(refreshCalls).toBe(1);
        expect(await accountState()).toMatchObject({ error: null });
      },
    );

    it("clears a stored credential error through a manual refresh", async () => {
      let refreshStatus = 400;
      let refreshCalls = 0;
      const fixture = await createOAuthRequestFixture(
        provider,
        async (input, init) => {
          if (String(input).endsWith("/oauth/token")) {
            refreshCalls += 1;
            return refreshStatus === 200
              ? Response.json({ access_token: "oauth-new", expires_in: 3600 })
              : Response.json({ error: "invalid_grant" }, { status: 400 });
          }
          return Response.json(
            {},
            {
              status:
                new Headers(init?.headers).get("authorization") ===
                "Bearer oauth-old"
                  ? 401
                  : 200,
            },
          );
        },
        () => 1_800_000_000_000,
        provider === "claude"
          ? { seven_day: { utilization: 10 } }
          : { rate_limit: { primary_window: { used_percent: 10 } } },
      );
      const send = async () => {
        const response = await fixture.host.harness.behavior.fetchHttp(
          "POST",
          route,
          { headers: authHeaders(fixture.key), body: "{}" },
        );
        await response.text();
        return response.status;
      };
      const refresh = async () =>
        z
          .object({ account: accountSummarySchema.nullable() })
          .parse(
            await fixture.host.harness.behavior.callRpc(
              "account.refreshUsage",
              { accountId: fixture.account.id },
            ),
          ).account;

      expect(await send()).toBe(401);
      expect(await send()).toBe(429);
      expect(refreshCalls).toBe(1);

      await expect(refresh()).rejects.toThrow(
        "Could not refresh account usage. Try again.",
      );
      expect(refreshCalls).toBe(2);
      const stillRejected = z
        .array(accountSummarySchema)
        .parse(
          await fixture.host.harness.behavior.callRpc("account.list", null),
        )[0];
      expect(stillRejected?.error).toBe(
        "OAuth refresh failed with HTTP 400. invalid_grant.",
      );
      expect(fixture.host.harness.inspection.logEntries).toContainEqual({
        level: "warn",
        message: expect.stringContaining(
          `Account Pooler ${provider} account ${fixture.account.id} OAuth refresh failed`,
        ),
      });

      refreshStatus = 200;
      const recovered = await refresh();
      expect(refreshCalls).toBe(3);
      expect(recovered?.error).toBeNull();
      expect(fixture.host.harness.inspection.logEntries).toContainEqual({
        level: "info",
        message: expect.stringContaining(
          `Account Pooler ${provider} account ${fixture.account.id} OAuth refresh succeeded`,
        ),
      });
      expect(await send()).toBe(200);
      const refreshLogs = fixture.host.harness.inspection.logEntries.filter(
        (entry) =>
          entry.message.includes(`account ${fixture.account.id} OAuth refresh`),
      );
      expect(refreshLogs).toHaveLength(3);
      const logText = JSON.stringify(refreshLogs);
      for (const token of ["oauth-old", "oauth-new", "oauth-refresh"])
        expect(logText).not.toContain(token);
    });
  });

  it("honors a newer token's rejected cooldown when an older 401 arrives late", async () => {
    const gate = deferred();
    let now = 1_800_000_000_000;
    let refreshCalls = 0;
    let attempts = 0;
    const fixture = await createOAuthRequestFixture(
      "claude",
      async (input) => {
        if (String(input).endsWith("/oauth/token")) {
          refreshCalls += 1;
          return refreshCalls === 2
            ? Response.json({}, { status: 503 })
            : Response.json({
                access_token: `oauth-new-${refreshCalls}`,
                expires_in: 3600,
              });
        }
        attempts += 1;
        if (attempts === 1) await gate.promise;
        return Response.json(
          {},
          { status: attempts === 3 || attempts >= 5 ? 200 : 401 },
        );
      },
      () => now,
    );
    const send = () =>
      fixture.host.harness.behavior.fetchHttp("POST", "/v1/messages", {
        headers: authHeaders(fixture.key),
        body: "{}",
      });
    const first = send();
    try {
      await vi.waitFor(() => expect(attempts).toBe(1));
      const second = await send();
      expect(second.status).toBe(200);
      await second.text();
      const rejected = await send();
      expect(rejected.status).toBe(503);
      await rejected.text();
      gate.resolve();
      const late = await first;
      expect(late.status).toBe(503);
      await late.text();
      const held = await send();
      expect(held.status).toBe(503);
      await held.text();
      expect(attempts).toBe(4);
      now += 1_000;
      const recovered = await send();
      expect(recovered.status).toBe(200);
      await recovered.text();
      expect(refreshCalls).toBe(3);
    } finally {
      gate.resolve();
      const response = await first;
      if (!response.bodyUsed) await response.text();
    }
  });

  it.each(["never ends", "cancel rejects", "cancel hangs"])(
    "bounds failed response disposal when the body %s",
    async (behavior) => {
      const cancel = vi.fn(() =>
        behavior === "cancel hangs"
          ? new Promise<void>(() => {})
          : behavior === "cancel rejects"
            ? Promise.reject(new Error("cancel failed"))
            : Promise.resolve(),
      );
      let attempts = 0;
      const fixture: Fixture = await createFixture({
        upstreamUrl: "https://upstream.example",
        priority: 0,
        options: {
          fetch: async (_input, init) => {
            attempts += 1;
            if (attempts === 1)
              return new Response(
                new ReadableStream({
                  start(controller) {
                    if (behavior !== "never ends")
                      controller.enqueue(new Uint8Array(2048).fill(65));
                  },
                  cancel,
                }),
                { status: 503 },
              );
            const status = statusSchema.parse(
              await fixture.host.harness.behavior.callRpc("status.get", null),
            );
            expect(
              status.accounts.find(
                (account) => account.id === fixture.account.id,
              )?.inFlight,
            ).toBe(0);
            expect(init?.signal?.aborted).toBe(false);
            return Response.json({});
          },
        },
      });
      await addApiAccount(fixture, "sk-backup", 100);
      const response = await fixture.host.harness.behavior.fetchHttp(
        "POST",
        "/v1/messages",
        {
          headers: authHeaders(fixture.key),
          body: "{}",
        },
      );
      expect(response.status).toBe(200);
      await response.text();
      expect(attempts).toBe(2);
      expect(cancel).toHaveBeenCalledOnce();
    },
  );

  it("finishes a successful in-flight fetch during graceful hub shutdown", async () => {
    const gate = deferred();
    const started = deferred();
    const fixture = await createFixture({
      upstreamUrl: "https://upstream.example",
      options: {
        fetch: async () => {
          started.resolve();
          await gate.promise;
          return Response.json({});
        },
      },
    });
    const request = fixture.host.harness.behavior.fetchHttp(
      "POST",
      "/v1/messages",
      {
        headers: authHeaders(fixture.key),
        body: "{}",
      },
    );
    await started.promise;
    fixture.service.controller.abort();
    await vi.waitFor(async () => {
      const status = statusSchema.parse(
        await fixture.host.harness.behavior.callRpc("status.get", null),
      );
      expect(status.accepting).toBe(false);
    });
    gate.resolve();
    const response = await request;
    expect(response.status).toBe(200);
    await response.text();
    await fixture.service.done;
  });

  it("accepts requests after stopping and restarting the hub service", async () => {
    const fixture = await createFixture({
      upstreamUrl: "https://upstream.example",
      options: { fetch: async () => Response.json({}) },
    });
    fixture.service.controller.abort();
    await fixture.service.done;
    const restarted = fixture.host.harness.behavior.runService("hub");
    cleanups.push(async () => {
      restarted.controller.abort();
      await restarted.done;
    });
    await vi.waitFor(async () => {
      const status = statusSchema.parse(
        await fixture.host.harness.behavior.callRpc("status.get", null),
      );
      expect(status.accepting).toBe(true);
    });
    const response = await fixture.host.harness.behavior.fetchHttp(
      "POST",
      "/v1/messages",
      {
        headers: authHeaders(fixture.key),
        body: "{}",
      },
    );
    expect(response.status).toBe(200);
    await response.text();
  });

  it.each([true, false])(
    "uses only the initial account snapshot with a healthy fourth account: %s",
    async (healthyFourth) => {
      const attempts: Array<string | null> = [];
      const fixture: Fixture = await createFixture({
        upstreamUrl: "https://upstream.example",
        apiKey: "sk-1",
        priority: 1,
        options: {
          fetch: async (_input, init) => {
            const key = new Headers(init?.headers).get("x-api-key");
            attempts.push(key);
            if (attempts.length === 1)
              await addApiAccount(fixture, "sk-late", -1);
            return Response.json(
              { result: key },
              {
                status:
                  key === "sk-late" || (healthyFourth && key === "sk-4")
                    ? 200
                    : 503,
              },
            );
          },
        },
      });
      for (const account of [2, 3, 4])
        await addApiAccount(fixture, `sk-${account}`, account);
      const response = await fixture.host.harness.behavior.fetchHttp(
        "POST",
        "/v1/messages",
        {
          headers: authHeaders(fixture.key),
          body: "{}",
        },
      );
      await response.text();
      expect(response.status).toBe(healthyFourth ? 200 : 503);
      expect(attempts).toEqual(["sk-1", "sk-2", "sk-3", "sk-4"]);
    },
  );

  it("does not start another inference after cancellation during pacing", async () => {
    const controller = new AbortController();
    let attempts = 0;
    const fixture = await createFixture({
      upstreamUrl: "https://upstream.example",
      options: {
        fetch: async () => {
          attempts += 1;
          return attempts === 1
            ? new Response(
                new ReadableStream({
                  cancel() {
                    controller.abort();
                  },
                }),
                { status: 429, headers: { "retry-after": "0" } },
              )
            : Response.json({});
        },
      },
    });
    const response = await fixture.host.harness.behavior.fetchHttp(
      "POST",
      "/v1/messages",
      {
        headers: authHeaders(fixture.key),
        body: "{}",
        signal: controller.signal,
      },
    );
    await response.text();
    expect(attempts).toBe(1);
  });

  it("never replays a committed SSE stream on another account", async () => {
    let failStream = () => {};
    let attempts = 0;
    const fixture = await createFixture({
      upstreamUrl: "https://upstream.example",
      options: {
        fetch: async () => {
          attempts += 1;
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(
                  new TextEncoder().encode("data: started\n\n"),
                );
                failStream = () =>
                  controller.error(new Error("stream disconnected"));
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          );
        },
      },
    });
    await addApiAccount(fixture, "sk-backup");
    const response = await fixture.host.harness.behavior.fetchHttp(
      "POST",
      "/v1/messages",
      {
        headers: authHeaders(fixture.key),
        body: "{}",
      },
    );
    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error("Missing SSE stream.");
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(
      "data: started\n\n",
    );
    failStream();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain(
      "event: error",
    );
    expect((await reader.read()).done).toBe(true);
    expect(attempts).toBe(1);
  });

  describe("session affinity", () => {
    const sessionId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const claudeBody = (id: string, model = "claude-fable-5") =>
      JSON.stringify({
        model,
        metadata: {
          user_id: JSON.stringify({
            account_uuid: "invalid-account-uuid",
            device_id: "device",
            parent_session_id: "parent",
            session_id: id,
          }),
        },
      });
    const openStream = () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("data: started\n\n"));
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );

    async function affinityFixture(
      provider: "claude" | "codex",
      upstreamFetch: typeof fetch,
      now = () => 1_800_000_000_000,
    ): Promise<Fixture> {
      let imported = 0;
      const fixture = await createFixture({
        upstreamUrl: "https://upstream.example",
        provider,
        apiKey: "sk-first",
        source: provider === "codex" ? "import" : "api-key",
        options: {
          now,
          codexUsageUrl: EMPTY_USAGE_URL,
          fetch: (input, init) =>
            String(input) === EMPTY_USAGE_URL
              ? Promise.resolve(Response.json({}))
              : upstreamFetch(input, init),
          importCodexCredentials: async () => ({
            accessToken:
              ["sk-first", "sk-second", "sk-third"][imported++] ?? "sk-extra",
            refreshToken: "refresh",
            idToken: null,
            accountId: `codex-account-${imported}`,
            planType: null,
            email: null,
            expiresAt: now() + 24 * 60 * 60 * 1_000,
          }),
        },
      });
      if (provider === "claude") await addApiAccount(fixture, "sk-second");
      else
        await fixture.host.harness.behavior.callRpc("account.add", {
          provider,
          source: { kind: "import" },
          label: null,
          priority: 100,
        });
      return fixture;
    }

    it.each(["claude", "codex"] as const)(
      "keeps %s sessions and the pool cursor on the third account after two failures",
      async (provider) => {
        let outage = false;
        const attempts: string[] = [];
        const fixture = await affinityFixture(
          provider,
          async (_input, init) => {
            const headers = new Headers(init?.headers);
            const key =
              headers.get("x-api-key") ??
              headers.get("authorization")?.slice(7) ??
              "";
            attempts.push(key);
            return Response.json(
              {},
              { status: outage && key !== "sk-third" ? 503 : 200 },
            );
          },
        );
        if (provider === "claude") await addApiAccount(fixture, "sk-third");
        else
          await fixture.host.harness.behavior.callRpc("account.add", {
            provider,
            source: { kind: "import" },
            label: null,
            priority: 100,
          });
        const send = async (id: string) => {
          const response = await fixture.host.harness.behavior.fetchHttp(
            "POST",
            provider === "claude" ? "/v1/messages" : "/v1/responses",
            {
              headers: { ...authHeaders(fixture.key), "session-id": id },
              body: provider === "claude" ? claudeBody(id) : "{}",
            },
          );
          expect(response.status).toBe(200);
          await response.text();
        };
        await send("warm");
        outage = true;
        await send("warm");
        await send("warm");
        await send("fresh");
        outage = false;
        await send("warm");
        await send("fresh-after-recovery");
        expect(attempts).toEqual([
          "sk-first",
          "sk-first",
          "sk-second",
          "sk-third",
          "sk-third",
          "sk-third",
          "sk-third",
          "sk-third",
        ]);
      },
    );

    it.each(["claude", "codex"] as const)(
      "routes %s conversations around long holds according to provider affinity",
      async (provider) => {
        let now = 1_800_000_000_000;
        let limited = false;
        const attempts: string[] = [];
        const fixture = await affinityFixture(
          provider,
          async (_input, init) => {
            const headers = new Headers(init?.headers);
            const key =
              headers.get("x-api-key") ??
              headers.get("authorization")?.slice(7) ??
              "";
            attempts.push(key);
            return limited && key === "sk-first"
              ? Response.json(
                  {},
                  { status: 429, headers: { "retry-after": "60" } },
                )
              : Response.json({});
          },
          () => now,
        );
        const send = async (id: string, status = 200) => {
          const response = await fixture.host.harness.behavior.fetchHttp(
            "POST",
            provider === "claude" ? "/v1/messages" : "/v1/responses",
            {
              headers: { ...authHeaders(fixture.key), "session-id": id },
              body: provider === "claude" ? claudeBody(id) : "{}",
            },
          );
          expect(response.status).toBe(status);
          await response.text();
        };
        await send("warm");
        limited = true;
        await send("warm", provider === "claude" ? 200 : 429);
        await send("fresh");
        await send("warm", provider === "claude" ? 200 : 429);
        now += 60_000;
        limited = false;
        await send("warm");
        await send("fresh-after-recovery");
        expect(attempts).toEqual(
          provider === "claude"
            ? [
                "sk-first",
                "sk-first",
                "sk-second",
                "sk-second",
                "sk-second",
                "sk-first",
                "sk-second",
              ]
            : ["sk-first", "sk-first", "sk-second", "sk-first", "sk-second"],
        );
      },
    );

    it.each(["claude", "codex"] as const)(
      "fails over immediately when a new %s conversation receives a long rate limit",
      async (provider) => {
        const attempts: string[] = [];
        const fixture = await affinityFixture(
          provider,
          async (_input, init) => {
            const headers = new Headers(init?.headers);
            const key =
              headers.get("x-api-key") ??
              headers.get("authorization")?.slice(7) ??
              "";
            attempts.push(key);
            return key === "sk-first"
              ? Response.json(
                  {},
                  { status: 429, headers: { "retry-after": "60" } },
                )
              : Response.json({});
          },
        );
        for (const id of ["fresh", "another"]) {
          const response = await fixture.host.harness.behavior.fetchHttp(
            "POST",
            provider === "claude" ? "/v1/messages" : "/v1/responses",
            {
              headers: { ...authHeaders(fixture.key), "session-id": id },
              body: provider === "claude" ? claudeBody(id) : "{}",
            },
          );
          expect(response.status).toBe(200);
          await response.text();
        }
        expect(attempts).toEqual(["sk-first", "sk-second", "sk-second"]);
      },
    );

    it.each(["claude", "codex"] as const)(
      "restores the %s cursor and distinct session pins after a full plugin reload",
      async (provider) => {
        let outage = false;
        const attempts: string[] = [];
        const upstreamFetch: typeof fetch = async (input, init) => {
          if (String(input) === EMPTY_USAGE_URL) return Response.json({});
          const headers = new Headers(init?.headers);
          const key =
            headers.get("x-api-key") ??
            headers.get("authorization")?.slice(7) ??
            "";
          attempts.push(key);
          return Response.json(
            {},
            { status: outage && key === "sk-first" ? 503 : 200 },
          );
        };
        const fixture = await affinityFixture(provider, upstreamFetch);
        let host = fixture.host;
        const send = async (id: string) => {
          const response = await host.harness.behavior.fetchHttp(
            "POST",
            provider === "claude" ? "/v1/messages" : "/v1/responses",
            {
              headers: { ...authHeaders(fixture.key), "session-id": id },
              body: provider === "claude" ? claudeBody(id) : "{}",
            },
          );
          expect(response.status).toBe(200);
          await response.text();
        };
        await send("original");
        outage = true;
        await send("fallback");
        outage = false;
        host = await host.harness.lifecycle.reload(
          createAccountPoolPlugin({
            fetch: upstreamFetch,
            now: () => 1_800_000_000_000,
            usageUrl: EMPTY_USAGE_URL,
            codexUsageUrl: EMPTY_USAGE_URL,
          }),
        );
        const service = host.harness.behavior.runService("hub");
        cleanups.push(async () => {
          service.controller.abort();
          await service.done;
          await host.harness.lifecycle.dispose();
        });
        await vi.waitFor(async () => {
          const status = statusSchema.parse(
            await host.harness.behavior.callRpc("status.get", null),
          );
          expect(status.accepting).toBe(true);
        });
        await send("fresh-after-restart");
        await send("original");
        await send("fallback");
        await send("another-fresh");
        expect(attempts).toEqual([
          "sk-first",
          "sk-first",
          "sk-second",
          "sk-second",
          "sk-first",
          "sk-second",
          "sk-second",
        ]);
      },
    );

    it.each(["claude", "codex"] as const)(
      "routes %s across conversations and keeps a recovered earlier account as backup",
      async (provider) => {
        let now = 1_800_000_000_000;
        let rejected: string | null = null;
        const attempts: string[] = [];
        const fixture = await affinityFixture(
          provider,
          async (_input, init) => {
            const headers = new Headers(init?.headers);
            const key =
              headers.get("x-api-key") ??
              headers.get("authorization")?.slice(7) ??
              "";
            attempts.push(key);
            if (key === rejected)
              return Response.json(
                {},
                {
                  status: 429,
                  headers:
                    provider === "claude"
                      ? {
                          "anthropic-ratelimit-unified-5h-status": "rejected",
                          "anthropic-ratelimit-unified-5h-reset": String(
                            now / 1000 + 60,
                          ),
                        }
                      : {
                          "x-codex-primary-over-limit": "true",
                          "x-codex-primary-reset-after-seconds": "60",
                        },
                },
              );
            return attempts.length === 1 ? openStream() : Response.json({});
          },
          () => now,
        );
        const send = (id: string) =>
          fixture.host.harness.behavior.fetchHttp(
            "POST",
            provider === "claude" ? "/v1/messages" : "/v1/responses",
            {
              headers: { ...authHeaders(fixture.key), "thread-id": id },
              body: provider === "claude" ? claudeBody(id) : "{}",
            },
          );
        const first = await send("original");
        try {
          await (await send("new-while-busy")).text();
          expect(attempts).toEqual(["sk-first", "sk-first"]);
          rejected = "sk-first";
          await (await send("failover")).text();
          now += 60_000;
          rejected = null;
          await (await send("new-after-recovery")).text();
          await (await send("original")).text();
          await (await send("another-new")).text();
          expect(attempts).toEqual(
            provider === "claude"
              ? [
                  "sk-first",
                  "sk-first",
                  "sk-first",
                  "sk-second",
                  "sk-first",
                  "sk-first",
                  "sk-first",
                ]
              : [
                  "sk-first",
                  "sk-first",
                  "sk-first",
                  "sk-second",
                  "sk-second",
                  "sk-first",
                  "sk-second",
                ],
          );
          rejected = "sk-second";
          await (await send("wrap")).text();
          expect(attempts.slice(provider === "claude" ? -1 : -2)).toEqual(
            provider === "claude" ? ["sk-first"] : ["sk-second", "sk-first"],
          );
        } finally {
          await first.body?.cancel();
        }
      },
    );

    it.each(["claude", "codex"] as const)(
      "handles %s quota exhaustion and reset with session affinity",
      async (provider) => {
        let now = 1_800_000_000_000;
        const exhausted = new Set<string>();
        const attempts: string[] = [];
        const fixture = await affinityFixture(
          provider,
          async (_input, init) => {
            const headers = new Headers(init?.headers);
            const key =
              headers.get("x-api-key") ??
              headers.get("authorization")?.slice(7);
            if (key === undefined)
              throw new Error("Missing account credential.");
            attempts.push(key);
            if (!exhausted.has(key)) return Response.json({ account: key });
            const resetSeconds = key === "sk-first" ? 60 : 120;
            return Response.json(
              { error: { message: "Account usage exhausted." } },
              {
                status: 429,
                headers:
                  provider === "claude"
                    ? {
                        "anthropic-ratelimit-unified-5h-status": "rejected",
                        "anthropic-ratelimit-unified-5h-reset": String(
                          now / 1000 + resetSeconds,
                        ),
                      }
                    : {
                        "x-codex-primary-used-percent": "100",
                        "x-codex-primary-window-minutes": "300",
                        "x-codex-primary-reset-after-seconds":
                          String(resetSeconds),
                      },
              },
            );
          },
          () => now,
        );
        const send = () =>
          fixture.host.harness.behavior.fetchHttp(
            "POST",
            provider === "claude" ? "/v1/messages" : "/v1/responses",
            {
              headers: {
                ...authHeaders(fixture.key),
                "session-id": sessionId,
                "thread-id": "quota-thread",
              },
              body:
                provider === "claude"
                  ? claudeBody(sessionId)
                  : JSON.stringify({ model: "gpt-5", input: [] }),
            },
          );
        const expectAccount = async (account: string) => {
          const response = await send();
          expect(response.status).toBe(200);
          expect(await response.json()).toEqual({ account });
        };

        await expectAccount("sk-first");
        exhausted.add("sk-first");
        await expectAccount("sk-second");
        await expectAccount("sk-second");
        now += 60_000;
        exhausted.delete("sk-first");
        await expectAccount("sk-second");
        expect(attempts).toEqual([
          "sk-first",
          "sk-first",
          "sk-second",
          "sk-second",
          "sk-second",
        ]);

        exhausted.add("sk-first");
        exhausted.add("sk-second");
        const unavailable = await send();
        expect(unavailable.status).toBe(429);
        expect(unavailable.headers.get("retry-after")).toBe("60");
        await unavailable.text();
        expect(attempts.slice(5)).toEqual(["sk-second", "sk-first"]);
        const stillUnavailable = await send();
        expect(stillUnavailable.status).toBe(429);
        expect(stillUnavailable.headers.get("retry-after")).toBe("60");
        await stillUnavailable.text();
        expect(attempts).toHaveLength(7);

        now += 60_000;
        exhausted.delete("sk-first");
        await expectAccount("sk-first");
        await expectAccount("sk-first");
        expect(attempts.slice(7)).toEqual(["sk-first", "sk-first"]);
        const status = statusSchema.parse(
          await fixture.host.harness.behavior.callRpc("status.get", null),
        );
        expect(status.accounts.map((account) => account.status)).toEqual([
          "ready",
          "exhausted",
        ]);
      },
    );

    describe("parent affinity", () => {
      type Wire =
        | "claude"
        | "codex-fork"
        | "codex-shared-session"
        | "codex-body"
        | "codex-parent-header"
        | "codex-parent-body"
        | "codex-spawn";
      function forkRequest(
        wire: Wire,
        own: string,
        parent: string | null,
      ): { headers: Record<string, string>; body: string } {
        if (wire === "claude")
          return {
            headers: {},
            body: JSON.stringify({
              model: "claude-fable-5",
              metadata: {
                user_id: JSON.stringify({
                  session_id: own,
                  parent_session_id: parent,
                  device_id: "device",
                  account_uuid: "invalid-account-uuid",
                  extra: "keep",
                }),
              },
              messages: [{ role: "user", content: "Identical cached prefix" }],
            }),
          };
        const session =
          (wire === "codex-shared-session" || wire === "codex-body") &&
          parent !== null
            ? parent
            : own;
        const turn = {
          session_id: session,
          thread_id: own,
          forked_from_thread_id:
            wire === "codex-fork" ||
            wire === "codex-shared-session" ||
            wire === "codex-body"
              ? parent
              : null,
          parent_thread_id: wire === "codex-spawn" ? parent : null,
          extra: "keep",
        };
        const bodyOnly = wire === "codex-body" || wire === "codex-parent-body";
        const headers: Record<string, string> = { "session-id": session };
        if (!bodyOnly) headers["thread-id"] = own;
        if (!bodyOnly) headers["x-codex-turn-metadata"] = JSON.stringify(turn);
        if (wire === "codex-parent-header" && parent !== null)
          headers["x-codex-parent-thread-id"] = parent;
        return {
          headers,
          body: JSON.stringify({
            model: "gpt-5",
            prompt_cache_key: "shared-parent-cache",
            client_metadata: {
              session_id: session,
              thread_id: own,
              "x-codex-turn-metadata": JSON.stringify(turn),
              ...(wire === "codex-parent-body" && parent !== null
                ? { "x-codex-parent-thread-id": parent }
                : {}),
            },
            input: [
              {
                type: "message",
                role: "user",
                content: [
                  { type: "input_text", text: "Identical cached prefix" },
                ],
              },
              { type: "compaction", encrypted_content: "preserve" },
            ],
          }),
        };
      }

      it.each<Wire>(["claude", "codex-fork"])(
        "keeps a fork on its short-held parent account over %s",
        async (wire) => {
          const provider = wire === "claude" ? "claude" : "codex";
          let now = Date.now();
          const attempts: Array<string | null> = [];
          const parentRetry = deferred();
          const fixture = await affinityFixture(
            provider,
            async (_input, init) => {
              const headers = new Headers(init?.headers);
              attempts.push(
                headers.get("x-api-key") ??
                  headers.get("authorization")?.slice(7) ??
                  null,
              );
              if (attempts.length === 4) await parentRetry.promise;
              return attempts.length === 3
                ? Response.json(
                    {},
                    { status: 429, headers: { "retry-after": "0.25" } },
                  )
                : Response.json({});
            },
            () => now,
          );
          const send = (own: string, parent: string | null) => {
            const request = forkRequest(wire, own, parent);
            return fixture.host.harness.behavior.fetchHttp(
              "POST",
              provider === "claude" ? "/v1/messages" : "/v1/responses",
              {
                headers: { ...authHeaders(fixture.key), ...request.headers },
                body: request.body,
              },
            );
          };
          await (await send("parent", null)).text();
          await movePoolToOtherAccount(fixture, provider);
          const paced = send("parent", null);
          try {
            await vi.waitFor(
              async () => {
                const status = statusSchema.parse(
                  await fixture.host.harness.behavior.callRpc(
                    "status.get",
                    null,
                  ),
                );
                expect(
                  status.accounts.find(
                    (account) => account.id === fixture.account.id,
                  )?.status,
                ).toBe("held");
                expect(attempts).toHaveLength(4);
              },
              { interval: 5 },
            );
            const child = await send("child", "parent");
            expect(child.status).toBe(200);
            await child.text();
            parentRetry.resolve();
            await (await paced).text();
            await (await send("child", "parent")).text();
            expect(attempts).toEqual([
              "sk-first",
              "sk-second",
              "sk-first",
              "sk-first",
              "sk-first",
              "sk-first",
            ]);
            now += 251;
            const status = statusSchema.parse(
              await fixture.host.harness.behavior.callRpc("status.get", null),
            );
            expect(
              status.accounts.find(
                (account) => account.id === fixture.account.id,
              )?.status,
            ).toBe("ready");
          } finally {
            parentRetry.resolve();
            const response = await paced;
            if (!response.bodyUsed) await response.text();
          }
        },
      );

      it.each<Wire>([
        "claude",
        "codex-fork",
        "codex-shared-session",
        "codex-body",
        "codex-parent-header",
        "codex-parent-body",
        "codex-spawn",
      ])(
        "inherits the eligible %s parent once and keeps child failover independent",
        async (wire) => {
          const provider = wire === "claude" ? "claude" : "codex";
          const route =
            provider === "claude" ? "/v1/messages" : "/v1/responses";
          const seen: Array<{ key: string | null; body: string }> = [];
          let rejectNext = false;
          const fixture = await affinityFixture(
            provider,
            async (_input, init) => {
              const headers = new Headers(init?.headers);
              seen.push({
                key:
                  headers.get("x-api-key") ??
                  headers.get("authorization")?.slice(7) ??
                  null,
                body: new TextDecoder().decode(
                  init?.body instanceof ArrayBuffer
                    ? init.body
                    : new ArrayBuffer(0),
                ),
              });
              if (seen.length === 1) return openStream();
              if (rejectNext) {
                rejectNext = false;
                return Response.json({}, { status: 503 });
              }
              return Response.json({});
            },
          );
          const send = (own: string, parent: string | null) => {
            const request = forkRequest(wire, own, parent);
            return fixture.host.harness.behavior.fetchHttp("POST", route, {
              headers: { ...authHeaders(fixture.key), ...request.headers },
              body: request.body,
            });
          };
          const held = await send("parent-session", null);
          try {
            const child = await send("child-session", "parent-session");
            expect(child.status).toBe(200);
            await child.text();
            expect(seen[1]?.key).toBe("sk-first");
            expect(seen[1]?.body).toBe(
              forkRequest(wire, "child-session", "parent-session").body,
            );
            rejectNext = true;
            const failover = await send("child-session", "parent-session");
            expect(failover.status).toBe(200);
            await failover.text();
            const parent = await send("parent-session", null);
            await parent.text();
            const repeatedChild = await send("child-session", "parent-session");
            await repeatedChild.text();
            expect(seen.map(({ key }) => key)).toEqual([
              "sk-first",
              "sk-first",
              "sk-first",
              "sk-second",
              "sk-first",
              "sk-second",
            ]);
          } finally {
            await held.body?.cancel();
          }
        },
      );

      describe.each<"claude" | "codex">(["claude", "codex"])(
        "%s parent eligibility",
        (provider) => {
          const wire = provider === "claude" ? "claude" : "codex-fork";
          const route =
            provider === "claude" ? "/v1/messages" : "/v1/responses";
          it.each(["disabled", "expired", "missing", "other host"])(
            "uses ordinary selection when the parent is %s",
            async (reason) => {
              let now = 1_800_000_000_000;
              const attempts: Array<string | null> = [];
              const fixture = await affinityFixture(
                provider,
                async (_input, init) => {
                  const headers = new Headers(init?.headers);
                  attempts.push(
                    headers.get("x-api-key") ??
                      headers.get("authorization")?.slice(7) ??
                      null,
                  );
                  return attempts.length === 1
                    ? openStream()
                    : Response.json({});
                },
                () => now,
              );
              const parent = forkRequest(wire, "parent-session", null);
              const held = await fixture.host.harness.behavior.fetchHttp(
                "POST",
                route,
                {
                  headers: { ...authHeaders(fixture.key), ...parent.headers },
                  body: parent.body,
                },
              );
              try {
                await movePoolToOtherAccount(fixture, provider);
                attempts.splice(1);
                if (reason === "disabled")
                  await fixture.host.harness.behavior.callRpc(
                    "account.disable",
                    { id: fixture.account.id },
                  );
                if (reason === "expired") now += 31 * 60 * 1_000;
                const key =
                  reason === "other host"
                    ? provider === "claude"
                      ? await resolveToken(fixture.host, "host-two")
                      : (await resolveCodexToken(fixture.host, "host-two"))
                          .token
                    : fixture.key;
                const request = forkRequest(
                  wire,
                  "child-session",
                  reason === "missing" ? "missing-parent" : "parent-session",
                );
                const child = await fixture.host.harness.behavior.fetchHttp(
                  "POST",
                  route,
                  {
                    headers: { ...authHeaders(key), ...request.headers },
                    body: request.body,
                  },
                );
                expect(child.status).toBe(200);
                await child.text();
                expect(attempts).toEqual(["sk-first", "sk-second"]);
              } finally {
                await held.body?.cancel();
              }
            },
          );

          it("does not extend the parent lifetime when a child inherits its account", async () => {
            let now = 1_800_000_000_000;
            const attempts: Array<string | null> = [];
            const fixture = await affinityFixture(
              provider,
              async (_input, init) => {
                const headers = new Headers(init?.headers);
                attempts.push(
                  headers.get("x-api-key") ??
                    headers.get("authorization")?.slice(7) ??
                    null,
                );
                return attempts.length === 1 ? openStream() : Response.json({});
              },
              () => now,
            );
            const send = (own: string, parent: string | null) => {
              const request = forkRequest(wire, own, parent);
              return fixture.host.harness.behavior.fetchHttp("POST", route, {
                headers: { ...authHeaders(fixture.key), ...request.headers },
                body: request.body,
              });
            };
            const held = await send("parent-session", null);
            try {
              await movePoolToOtherAccount(fixture, provider);
              attempts.splice(1);
              now += 29 * 60 * 1_000;
              await (await send("child-session", "parent-session")).text();
              now += 2 * 60 * 1_000;
              await (await send("parent-session", null)).text();
              await (await send("child-session", "parent-session")).text();
              expect(attempts).toEqual([
                "sk-first",
                "sk-first",
                "sk-second",
                "sk-first",
              ]);
            } finally {
              await held.body?.cancel();
            }
          });
        },
      );

      it("does not inherit a parent binding from another provider", async () => {
        const attempts: Array<string | null> = [];
        const fixture = await affinityFixture("codex", async (_input, init) => {
          const headers = new Headers(init?.headers);
          attempts.push(
            headers.get("x-api-key") ??
              headers.get("authorization")?.slice(7) ??
              null,
          );
          return attempts.length <= 2 ? openStream() : Response.json({});
        });
        await addApiAccount(fixture, "sk-claude-parent");
        const claudeKey = await resolveToken(fixture.host);
        const claude = forkRequest("claude", "parent-session", null);
        const codex = forkRequest("codex-fork", "unrelated-session", null);
        const held = [
          await fixture.host.harness.behavior.fetchHttp(
            "POST",
            "/v1/messages",
            { headers: authHeaders(claudeKey), body: claude.body },
          ),
          await fixture.host.harness.behavior.fetchHttp(
            "POST",
            "/v1/responses",
            {
              headers: { ...authHeaders(fixture.key), ...codex.headers },
              body: codex.body,
            },
          ),
        ];
        try {
          await movePoolToOtherAccount(fixture, "codex");
          attempts.splice(2);
          const request = forkRequest(
            "codex-fork",
            "child-session",
            "parent-session",
          );
          const child = await fixture.host.harness.behavior.fetchHttp(
            "POST",
            "/v1/responses",
            {
              headers: { ...authHeaders(fixture.key), ...request.headers },
              body: request.body,
            },
          );
          expect(child.status).toBe(200);
          await child.text();
          expect(attempts).toEqual([
            "sk-claude-parent",
            "sk-first",
            "sk-second",
          ]);
        } finally {
          for (const response of held) await response.body?.cancel();
        }
      });
    });

    it.each<{
      name: string;
      provider: "claude" | "codex";
      headers: Record<string, string>;
      body: string;
    }>([
      {
        name: "Claude JSON",
        provider: "claude",
        headers: {},
        body: claudeBody(sessionId),
      },
      {
        name: "Claude legacy",
        provider: "claude",
        headers: {},
        body: JSON.stringify({
          metadata: {
            user_id: `user_hash_account_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa_session_${sessionId}`,
          },
        }),
      },
      {
        name: "Codex native",
        provider: "codex",
        headers: { "session-id": sessionId, "thread-id": "native-thread" },
        body: "{}",
      },
      {
        name: "Codex legacy",
        provider: "codex",
        headers: { session_id: sessionId },
        body: "{}",
      },
      {
        name: "Codex cache",
        provider: "codex",
        headers: {},
        body: JSON.stringify({ prompt_cache_key: sessionId }),
      },
    ])(
      "keeps $name sessions sticky with host isolation and idle expiry",
      async ({ provider, headers, body }) => {
        let now = 1_800_000_000_000;
        const attempts: Array<string | null> = [];
        const fixture = await affinityFixture(
          provider,
          async (_input, init) => {
            const requestHeaders = new Headers(init?.headers);
            attempts.push(
              provider === "claude"
                ? requestHeaders.get("x-api-key")
                : requestHeaders.get("authorization"),
            );
            return attempts.length === 1 ? openStream() : Response.json({});
          },
          () => now,
        );
        const route = provider === "claude" ? "/v1/messages" : "/v1/responses";
        const keyFor = (key: string) =>
          provider === "claude" ? key : `Bearer ${key}`;
        const send = async (
          key: string,
          requestBody: string,
          sessionHeaders = headers,
        ) => {
          const response = await fixture.host.harness.behavior.fetchHttp(
            "POST",
            route,
            {
              headers: { ...authHeaders(key), ...sessionHeaders },
              body: requestBody,
            },
          );
          await response.text();
          expect(response.status).toBe(200);
          return attempts.at(-1);
        };
        const held = await fixture.host.harness.behavior.fetchHttp(
          "POST",
          route,
          {
            headers: { ...authHeaders(fixture.key), ...headers },
            body,
          },
        );
        try {
          const otherHost =
            provider === "codex"
              ? (await resolveCodexToken(fixture.host, "host-two")).token
              : await resolveToken(fixture.host, "host-two");
          expect(await send(fixture.key, body)).toBe(keyFor("sk-first"));
          await fixture.host.harness.behavior.callRpc("account.disable", {
            id: fixture.account.id,
          });
          expect(await send(otherHost, body)).toBe(keyFor("sk-second"));
          await fixture.host.harness.behavior.callRpc("account.enable", {
            id: fixture.account.id,
          });
          expect(await send(fixture.key, "{}", {})).toBe(keyFor("sk-second"));
          now += 29 * 60 * 1_000;
          expect(await send(fixture.key, body)).toBe(keyFor("sk-first"));
          now += 2 * 60 * 1_000;
          expect(await send(fixture.key, body)).toBe(keyFor("sk-first"));
          now += 31 * 60 * 1_000;
          expect(await send(fixture.key, body)).toBe(keyFor("sk-second"));
        } finally {
          await held.body?.cancel();
        }
      },
    );

    it.each([
      "family quota",
      "auth error",
      "disabled account",
      "network error",
    ])(
      "preserves the correct binding after %s despite an older response completion",
      async (reason) => {
        const attempts: Array<string | null> = [];
        let finishOld = () => {};
        const fixture = await createFixture({
          upstreamUrl: "https://upstream.example",
          apiKey: "sk-first",
          options: {
            fetch: async (_input, init) => {
              const key = new Headers(init?.headers).get("x-api-key");
              attempts.push(key);
              if (attempts.length === 1)
                return new Response(
                  new ReadableStream({
                    start(controller) {
                      controller.enqueue(
                        new TextEncoder().encode("data: old\n\n"),
                      );
                      finishOld = () => {
                        controller.close();
                        finishOld = () => {};
                      };
                    },
                  }),
                  {
                    headers:
                      reason === "family quota"
                        ? {
                            "anthropic-ratelimit-unified-7d_fable-status":
                              "rejected",
                            "anthropic-ratelimit-unified-7d_fable-reset":
                              "4102444800",
                          }
                        : {},
                  },
                );
              if (
                reason === "network error" &&
                key === "sk-first" &&
                attempts.length === 2
              )
                throw new TypeError("network failed");
              return Response.json(
                {},
                {
                  status:
                    reason === "auth error" &&
                    key === "sk-first" &&
                    attempts.length === 2
                      ? 403
                      : 200,
                },
              );
            },
          },
        });
        await addApiAccount(fixture, "sk-second");
        const send = (model: string) =>
          fixture.host.harness.behavior.fetchHttp("POST", "/v1/messages", {
            headers: authHeaders(fixture.key),
            body: claudeBody(sessionId, model),
          });
        const held = await send(
          reason === "family quota" ? "claude-fable-5" : "claude-opus-4-1",
        );
        try {
          if (reason === "disabled account")
            await fixture.host.harness.behavior.callRpc("account.disable", {
              id: fixture.account.id,
            });
          const rebound = await send("claude-fable-5");
          expect(rebound.status).toBe(200);
          await rebound.text();
          if (reason !== "family quota")
            await fixture.host.harness.behavior.callRpc("account.enable", {
              id: fixture.account.id,
            });
          finishOld();
          await held.text();
          const afterCompletion = await send("claude-opus-4-1");
          await afterCompletion.text();
          expect(attempts).toEqual(
            reason === "auth error" || reason === "network error"
              ? ["sk-first", "sk-first", "sk-second", "sk-second"]
              : [
                  "sk-first",
                  "sk-second",
                  reason === "family quota" ? "sk-first" : "sk-second",
                ],
          );
        } finally {
          finishOld();
          if (!held.bodyUsed) await held.body?.cancel();
        }
      },
    );

    it("shares the first binding when simultaneous account listings resume under different load", async () => {
      const attempts: Array<string | null> = [];
      const fixture = await createFixture({
        upstreamUrl: "https://upstream.example",
        apiKey: "sk-first",
        options: {
          fetch: async (_input, init) => {
            attempts.push(new Headers(init?.headers).get("x-api-key"));
            return attempts.length === 1 ? openStream() : Response.json({});
          },
        },
      });
      await addApiAccount(fixture, "sk-second");
      const gates = [deferred(), deferred()];
      const originalList = AccountStore.prototype.list;
      let listings = 0;
      const list = vi
        .spyOn(AccountStore.prototype, "list")
        .mockImplementation(async function (this: AccountStore) {
          const index = listings++;
          const accounts = await originalList.call(this);
          if (index < 2) await gates[index]?.promise;
          return accounts;
        });
      const requests = [1, 2].map(() =>
        fixture.host.harness.behavior.fetchHttp("POST", "/v1/messages", {
          headers: authHeaders(fixture.key),
          body: claudeBody(sessionId),
        }),
      );
      try {
        await vi.waitFor(() => expect(listings).toBe(2));
        gates[0]?.resolve();
        await vi.waitFor(() => expect(attempts).toHaveLength(1));
        gates[1]?.resolve();
        const responses = await Promise.all(requests);
        await responses[1]?.text();
        await responses[0]?.body?.cancel();
        expect(attempts).toEqual(["sk-first", "sk-first"]);
      } finally {
        for (const gate of gates) gate.resolve();
        await Promise.allSettled(
          requests.map(async (request) => {
            const response = await request;
            if (!response.bodyUsed) await response.body?.cancel();
          }),
        );
        list.mockRestore();
      }
    });

    it("keeps native Codex HTTP compaction continuations on the same account", async () => {
      const seen: Array<{ headers: Headers; body: string }> = [];
      const compacted = {
        type: "compaction",
        encrypted_content: "encrypted-compaction-fixture",
      };
      const fixture = await affinityFixture("codex", async (_input, init) => {
        seen.push({
          headers: new Headers(init?.headers),
          body: new TextDecoder().decode(
            init?.body instanceof ArrayBuffer ? init.body : new ArrayBuffer(0),
          ),
        });
        if (seen.length === 1) return openStream();
        return new Response(
          `data: ${JSON.stringify({ type: "response.completed", response: { id: `response-${seen.length}`, output: [compacted] } })}\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        );
      });
      const headers = {
        ...authHeaders(fixture.key),
        "session-id": sessionId,
        "thread-id": "native-thread",
      };
      const held = await fixture.host.harness.behavior.fetchHttp(
        "POST",
        "/v1/responses",
        { headers, body: "{}" },
      );
      try {
        const fields = {
          model: "gpt-5",
          prompt_cache_key: "cache-key",
          client_metadata: {
            session_id: "body-session",
            thread_id: "body-thread",
            "x-codex-turn-metadata": "fixture",
          },
          include: ["reasoning.encrypted_content"],
          reasoning: { effort: "high" },
        };
        const input = [
          {
            type: "reasoning",
            encrypted_content: "encrypted-reasoning-fixture",
          },
          { type: "compaction_trigger" },
        ];
        const first = await fixture.host.harness.behavior.fetchHttp(
          "POST",
          "/v1/responses",
          { headers, body: JSON.stringify({ ...fields, input }) },
        );
        expect(first.status).toBe(200);
        await first.text();
        const delta = { type: "message", role: "user", content: "next" };
        const second = await fixture.host.harness.behavior.fetchHttp(
          "POST",
          "/v1/responses",
          {
            headers,
            body: JSON.stringify({
              ...fields,
              input: [...input, compacted, delta],
            }),
          },
        );
        expect(second.status).toBe(200);
        await second.text();
        expect(JSON.parse(seen[1]?.body ?? "{}")).toMatchObject({
          ...fields,
          input,
        });
        expect(JSON.parse(seen[2]?.body ?? "{}")).toMatchObject({
          ...fields,
          input: [...input, compacted, delta],
        });
        expect(seen.map(({ headers }) => headers.get("session-id"))).toEqual([
          sessionId,
          sessionId,
          sessionId,
        ]);
        expect(seen.map(({ headers }) => headers.get("thread-id"))).toEqual([
          "native-thread",
          "native-thread",
          "native-thread",
        ]);
        expect(seen.map(({ headers }) => headers.get("authorization"))).toEqual(
          ["Bearer sk-first", "Bearer sk-first", "Bearer sk-first"],
        );
      } finally {
        await held.body?.cancel();
      }
    });

    it.each([false, true])(
      "preserves a newer session binding outside an older candidate snapshot with a fallback: %s",
      async (hasFallback) => {
        const gate = deferred();
        const attempts: Array<string | null> = [];
        const fixture = await createFixture({
          upstreamUrl: "https://upstream.example",
          apiKey: "sk-first",
          priority: 0,
          options: {
            fetch: async (_input, init) => {
              attempts.push(new Headers(init?.headers).get("x-api-key"));
              if (attempts.length === 1) {
                await gate.promise;
                return Response.json({}, { status: 503 });
              }
              return Response.json({});
            },
          },
        });
        const fallback = await addApiAccount(fixture, "sk-fallback", 20);
        if (!hasFallback)
          await fixture.host.harness.behavior.callRpc("account.disable", {
            id: fallback.id,
          });
        const send = () =>
          fixture.host.harness.behavior.fetchHttp("POST", "/v1/messages", {
            headers: authHeaders(fixture.key),
            body: claudeBody(sessionId),
          });
        const old = send();
        try {
          await vi.waitFor(() => expect(attempts).toEqual(["sk-first"]));
          await addApiAccount(fixture, "sk-new", 10);
          await fixture.host.harness.behavior.callRpc("account.disable", {
            id: fixture.account.id,
          });
          const rebound = await send();
          expect(rebound.status).toBe(200);
          await rebound.text();
          gate.resolve();
          const exhausted = await old;
          expect(exhausted.status).toBe(hasFallback ? 200 : 503);
          await exhausted.text();
          await fixture.host.harness.behavior.callRpc("account.enable", {
            id: fixture.account.id,
          });
          const next = await send();
          expect(next.status).toBe(200);
          await next.text();
          expect(attempts).toEqual(
            hasFallback
              ? ["sk-first", "sk-new", "sk-fallback", "sk-new"]
              : ["sk-first", "sk-new", "sk-new"],
          );
        } finally {
          gate.resolve();
          const response = await old;
          if (!response.bodyUsed) await response.text();
        }
      },
    );

    it("preserves a newer session binding to an already-attempted account", async () => {
      const gate = deferred();
      const attempts: Array<string | null> = [];
      const fixture = await createFixture({
        upstreamUrl: "https://upstream.example",
        apiKey: "sk-first",
        priority: 0,
        options: {
          fetch: async (_input, init) => {
            const key = new Headers(init?.headers).get("x-api-key");
            attempts.push(key);
            if (attempts.length === 1)
              return Response.json({}, { status: 503 });
            if (key === "sk-second") {
              await gate.promise;
              return Response.json({}, { status: 503 });
            }
            return Response.json({});
          },
        },
      });
      const second = await addApiAccount(fixture, "sk-second", 10);
      await addApiAccount(fixture, "sk-fallback", 20);
      const send = () =>
        fixture.host.harness.behavior.fetchHttp("POST", "/v1/messages", {
          headers: authHeaders(fixture.key),
          body: claudeBody(sessionId),
        });
      const old = send();
      try {
        await vi.waitFor(() =>
          expect(attempts).toEqual(["sk-first", "sk-second"]),
        );
        await fixture.host.harness.behavior.callRpc("account.disable", {
          id: second.id,
        });
        const rebound = await send();
        expect(rebound.status).toBe(200);
        await rebound.text();
        gate.resolve();
        const fallback = await old;
        expect(fallback.status).toBe(200);
        await fallback.text();
        const next = await send();
        expect(next.status).toBe(200);
        await next.text();
        expect(attempts).toEqual([
          "sk-first",
          "sk-second",
          "sk-first",
          "sk-fallback",
          "sk-first",
        ]);
      } finally {
        gate.resolve();
        const response = await old;
        if (!response.bodyUsed) await response.text();
      }
    });

    it("isolates provider bindings and retains them on hub restart", async () => {
      const attempts: Array<string | null> = [];
      const started = new Set<string>();
      const fixture = await affinityFixture("codex", async (_input, init) => {
        const headers = new Headers(init?.headers);
        const provider = headers.has("x-api-key") ? "claude" : "codex";
        attempts.push(headers.get("x-api-key") ?? headers.get("authorization"));
        if (!started.has(provider)) {
          started.add(provider);
          return openStream();
        }
        return Response.json({});
      });
      await addApiAccount(fixture, "sk-claude-first");
      const claudeSecond = await addApiAccount(fixture, "sk-claude-second");
      const claudeKey = await resolveToken(fixture.host);
      const accounts = z
        .array(accountSummarySchema)
        .parse(
          await fixture.host.harness.behavior.callRpc("account.list", null),
        );
      const codexSecond = accounts.find(
        (account) => account.codexAccountId === "codex-account-2",
      );
      if (codexSecond === undefined)
        throw new Error("Missing second Codex account.");
      const sendClaude = () =>
        fixture.host.harness.behavior.fetchHttp("POST", "/v1/messages", {
          headers: authHeaders(claudeKey),
          body: claudeBody(sessionId),
        });
      const sendCodex = () =>
        fixture.host.harness.behavior.fetchHttp("POST", "/v1/responses", {
          headers: { ...authHeaders(fixture.key), "session-id": sessionId },
          body: "{}",
        });
      const held = [await sendClaude(), await sendCodex()];
      try {
        for (const account of [claudeSecond, codexSecond])
          await fixture.host.harness.behavior.callRpc("account.setPriority", {
            accountId: account.id,
            priority: 0,
          });
        await (await sendClaude()).text();
        await (await sendCodex()).text();
        for (const response of held) await response.body?.cancel();
        fixture.service.controller.abort();
        await fixture.service.done;
        const restarted = fixture.host.harness.behavior.runService("hub");
        cleanups.push(async () => {
          restarted.controller.abort();
          await restarted.done;
        });
        await vi.waitFor(async () => {
          const status = statusSchema.parse(
            await fixture.host.harness.behavior.callRpc("status.get", null),
          );
          expect(status.accepting).toBe(true);
        });
        await (await sendClaude()).text();
        await (await sendCodex()).text();
        const claudeAccount = attempts[0];
        expect(["sk-claude-first", "sk-claude-second"]).toContain(
          claudeAccount,
        );
        expect(attempts.filter((_, index) => index % 2 === 0)).toEqual([
          claudeAccount,
          claudeAccount,
          claudeAccount,
        ]);
        expect(attempts.filter((_, index) => index % 2 === 1)).toEqual([
          "Bearer sk-first",
          "Bearer sk-first",
          "Bearer sk-first",
        ]);
      } finally {
        for (const response of held)
          if (!response.bodyUsed) await response.body?.cancel();
      }
    });

    it("evicts the least recently used binding at capacity", async () => {
      let lastKey: string | null = null;
      let attempts = 0;
      const fixture = await createFixture({
        upstreamUrl: "https://upstream.example",
        apiKey: "sk-first",
        options: {
          now: () => 1_800_000_000_000,
          maxAffinityBindings: 4,
          fetch: async (_input, init) => {
            lastKey = new Headers(init?.headers).get("x-api-key");
            attempts += 1;
            return attempts === 1 ? openStream() : Response.json({});
          },
        },
      });
      const second = await addApiAccount(fixture, "sk-second");
      const send = async (id: string) => {
        const response = await fixture.host.harness.behavior.fetchHttp(
          "POST",
          "/v1/messages",
          {
            headers: authHeaders(fixture.key),
            body: claudeBody(id),
          },
        );
        await response.text();
        return lastKey;
      };
      const held = await fixture.host.harness.behavior.fetchHttp(
        "POST",
        "/v1/messages",
        {
          headers: authHeaders(fixture.key),
          body: claudeBody("oldest"),
        },
      );
      try {
        await movePoolToOtherAccount(fixture, "claude");
        for (let index = 1; index < 4; index += 1)
          await send(`session-${index}`);
        const touched = await send("oldest");
        await send("newest");
        const retained = await send("oldest");
        await held.body?.cancel();
        await movePoolToOtherAccount(fixture, "claude", second.id);
        const nextOldest = await send("session-2");
        const evicted = await send("session-1");
        expect([touched, retained, nextOldest, evicted]).toEqual([
          "sk-first",
          "sk-first",
          "sk-second",
          "sk-first",
        ]);
      } finally {
        if (!held.bodyUsed) await held.body?.cancel();
      }
    });
  });

  it("serializes refresh, writes new tokens with 0600 mode, and uses them", async () => {
    let now = 1_800_000_000_000;
    let refreshCalls = 0;
    const authorizations: Array<string | undefined> = [];
    const upstream = await startUpstream(async (request, response) => {
      if (request.url === "/oauth/token") {
        refreshCalls += 1;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            access_token: "oauth-new",
            refresh_token: "refresh-new",
            expires_in: 3600,
          }),
        );
        return;
      }
      authorizations.push(request.headers.authorization);
      await readRequestBody(request);
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
    cleanups.push(upstream.close);
    const fixture = await createFixture({
      upstreamUrl: upstream.url,
      source: "import",
      options: {
        now: () => now,
        importCredentials: async () =>
          importedCredentials({ expiresAt: now + 10 * 60 * 1_000 }),
        refreshUrl: `${upstream.url}/oauth/token`,
      },
    });
    expect(refreshCalls).toBe(0);
    now += 6 * 60 * 1_000;
    let releaseSecretReads = () => {};
    const secretReadsReleased = new Promise<void>((resolve) => {
      releaseSecretReads = resolve;
    });
    const readSecret = AccountStore.prototype.readSecret;
    const pendingSecretReads: ReturnType<typeof readSecret>[] = [];
    const readSecretSpy = vi
      .spyOn(AccountStore.prototype, "readSecret")
      .mockImplementation(async function (this: AccountStore, accountId) {
        const reading = readSecret.call(this, accountId);
        pendingSecretReads.push(reading);
        const secret = await reading;
        await secretReadsReleased;
        return secret;
      });
    const recordUsed = vi.spyOn(AccountStore.prototype, "recordUsed");
    const requests = [1, 2].map(() =>
      fixture.host.harness.behavior.fetchHttp("POST", "/v1/messages", {
        headers: authHeaders(fixture.key),
        body: "{}",
      }),
    );
    try {
      await vi.waitFor(() => {
        expect(recordUsed).toHaveBeenCalledTimes(2);
      });
      await Promise.all(recordUsed.mock.results.map((result) => result.value));
      await new Promise<void>((resolve) => setImmediate(resolve));
      await Promise.all(pendingSecretReads);
      releaseSecretReads();
      const responses = await Promise.all(requests);
      expect(responses.map((response) => response.status)).toEqual([200, 200]);
      await Promise.all(responses.map((response) => response.text()));
    } finally {
      releaseSecretReads();
      await Promise.allSettled(requests);
      readSecretSpy.mockRestore();
      recordUsed.mockRestore();
    }
    expect(refreshCalls).toBe(1);
    expect(authorizations).toEqual(["Bearer oauth-new", "Bearer oauth-new"]);
    const secretPath = path.join(
      fixture.dataDir,
      "plugins",
      "account-pool",
      "secrets",
      "accounts",
      `account-${fixture.account.id}.json`,
    );
    const secret = accountSecretSchema.parse(
      JSON.parse(await fs.readFile(secretPath, "utf8")),
    );
    expect(secret).toMatchObject({
      kind: "oauth",
      accessToken: "oauth-new",
      refreshToken: "refresh-new",
    });
    if (process.platform !== "win32") {
      expect((await fs.stat(secretPath)).mode & 0o777).toBe(0o600);
    }
  });

  it("refreshes unrelated accounts independently", async () => {
    let now = 1_800_000_000_000;
    let releaseFirstRefresh = () => {};
    const firstRefreshReleased = new Promise<void>((resolve) => {
      releaseFirstRefresh = resolve;
    });
    const refreshes: string[] = [];
    const authorizations: Array<string | undefined> = [];
    const upstream = await startUpstream(async (request, response) => {
      if (request.url === "/oauth/token") {
        const { refresh_token } = z
          .object({ refresh_token: z.string() })
          .parse(JSON.parse((await readRequestBody(request)).toString()));
        refreshes.push(refresh_token);
        if (refresh_token === "refresh-1") await firstRefreshReleased;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            access_token: `new-${refresh_token}`,
            refresh_token: `next-${refresh_token}`,
            expires_in: 3600,
          }),
        );
        return;
      }
      authorizations.push(request.headers.authorization);
      await readRequestBody(request);
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
    cleanups.push(upstream.close);
    let imported = 0;
    const fixture = await createFixture({
      upstreamUrl: upstream.url,
      source: "import",
      options: {
        now: () => now,
        importCredentials: async () => {
          imported += 1;
          return importedCredentials({
            accessToken: `access-${imported}`,
            refreshToken: `refresh-${imported}`,
            email: `account-${imported}@example.com`,
            accountUuid: `00000000-0000-4000-8000-${String(imported).padStart(12, "0")}`,
            expiresAt: now + 10 * 60 * 1_000,
          });
        },
        refreshUrl: `${upstream.url}/oauth/token`,
      },
    });
    const second = accountSchema.parse(
      await fixture.host.harness.behavior.callRpc("account.add", {
        provider: "claude",
        source: { kind: "import" },
        label: "second",
        priority: 200,
      }),
    );
    expect(refreshes).toEqual([]);
    now += 6 * 60 * 1_000;
    const requests: Promise<Response>[] = [];
    try {
      requests.push(
        fixture.host.harness.behavior.fetchHttp("POST", "/v1/messages", {
          headers: authHeaders(fixture.key),
          body: "{}",
        }),
      );
      await vi.waitFor(() => {
        expect(refreshes).toEqual(["refresh-1"]);
      });
      await fixture.host.harness.behavior.callRpc("account.disable", {
        id: fixture.account.id,
      });
      requests.push(
        fixture.host.harness.behavior.fetchHttp("POST", "/v1/messages", {
          headers: authHeaders(fixture.key),
          body: "{}",
        }),
      );
      await vi.waitFor(() => {
        expect(authorizations).toEqual(["Bearer new-refresh-2"]);
      });
    } finally {
      releaseFirstRefresh();
      await Promise.allSettled(requests);
    }
    const responses = await Promise.all(requests);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    await Promise.all(responses.map((response) => response.text()));
    expect(refreshes).toEqual(["refresh-1", "refresh-2"]);
    expect(authorizations).toEqual([
      "Bearer new-refresh-2",
      "Bearer new-refresh-1",
    ]);
  });

  describe.each<{ provider: "claude" | "codex"; route: string }>([
    { provider: "claude", route: "/v1/messages" },
    { provider: "codex", route: "/v1/responses" },
  ])("$provider OAuth refresh recovery", ({ provider, route }) => {
    it.each([
      {
        name: "uses valid tokens during temporary failure and retries after backoff",
        elapsedMinutes: 6,
        failureStatus: 503,
        expectedStatus: 200,
      },
      {
        name: "temporarily rejects expired tokens and recovers after backoff",
        elapsedMinutes: 11,
        failureStatus: 503,
        expectedStatus: 503,
      },
      {
        name: "keeps invalid_grant accounts excluded despite a valid access token",
        elapsedMinutes: 6,
        failureStatus: 400,
        expectedStatus: 429,
      },
    ])("$name", async ({ elapsedMinutes, failureStatus, expectedStatus }) => {
      let now = 1_800_000_000_000;
      const expiresAt = now + 10 * 60 * 1_000;
      const oldToken = testJwt({ exp: expiresAt / 1_000 });
      const newToken = testJwt({ exp: now / 1_000 + 3600 });
      let refreshStatus = failureStatus;
      let refreshCalls = 0;
      const authorizations: Array<string | undefined> = [];
      const upstream = await startUpstream(async (request, response) => {
        await readRequestBody(request);
        response.writeHead(
          request.url === "/oauth/token" ? refreshStatus : 200,
          { "content-type": "application/json" },
        );
        if (request.url === "/oauth/token") {
          refreshCalls += 1;
          response.end(
            JSON.stringify(
              refreshStatus === 200
                ? {
                    access_token: newToken,
                    refresh_token: "new-refresh",
                    expires_in: 3600,
                  }
                : {
                    error:
                      refreshStatus === 400
                        ? "invalid_grant"
                        : "temporarily_unavailable",
                  },
            ),
          );
          return;
        }
        authorizations.push(request.headers.authorization);
        response.end("{}");
      });
      cleanups.push(upstream.close);
      const fixture = await createFixture({
        upstreamUrl: upstream.url,
        provider,
        source: "import",
        options: {
          now: () => now,
          importCredentials: async () =>
            importedCredentials({ accessToken: oldToken, expiresAt }),
          importCodexCredentials: async () => ({
            accessToken: oldToken,
            refreshToken: "old-refresh",
            idToken: null,
            accountId: "chatgpt-account",
            planType: null,
            email: "codex@example.com",
            expiresAt,
          }),
          refreshUrl: `${upstream.url}/oauth/token`,
          codexRefreshUrl: `${upstream.url}/oauth/token`,
          codexUsageUrl: EMPTY_USAGE_URL,
        },
      });
      expect(refreshCalls).toBe(0);
      now += elapsedMinutes * 60 * 1_000;
      for (let request = 0; request < 2; request += 1) {
        const response = await fixture.host.harness.behavior.fetchHttp(
          "POST",
          route,
          { headers: authHeaders(fixture.key), body: "{}" },
        );
        await response.text();
        expect(response.status).toBe(expectedStatus);
        expect(refreshCalls).toBe(1);
      }
      const accounts = z
        .array(accountSummarySchema)
        .parse(
          await fixture.host.harness.behavior.callRpc("account.list", null),
        );
      expect(accounts[0]?.error).toEqual(
        failureStatus === 400
          ? expect.stringContaining("OAuth refresh failed")
          : null,
      );
      expect(authorizations).toEqual(
        expectedStatus === 200
          ? [`Bearer ${oldToken}`, `Bearer ${oldToken}`]
          : [],
      );
      refreshStatus = 200;
      now += 1_000;
      const recovered = await fixture.host.harness.behavior.fetchHttp(
        "POST",
        route,
        { headers: authHeaders(fixture.key), body: "{}" },
      );
      await recovered.text();
      expect(recovered.status).toBe(failureStatus === 400 ? 429 : 200);
      expect(refreshCalls).toBe(failureStatus === 400 ? 1 : 2);
      if (failureStatus !== 400) {
        expect(authorizations.at(-1)).toBe(`Bearer ${newToken}`);
        const recoveredAccounts = z
          .array(accountSummarySchema)
          .parse(
            await fixture.host.harness.behavior.callRpc("account.list", null),
          );
        expect(recoveredAccounts[0]?.error).toBeNull();
      }
    });
  });

  it("expires fallback tokens during refresh backoff and caps Retry-After", async () => {
    let now = 1_800_000_000_000;
    const expiresAt = now + 10 * 60 * 1_000;
    let refreshCalls = 0;
    let refreshStatus = 503;
    const authorizations: Array<string | undefined> = [];
    const upstream = await startUpstream(async (request, response) => {
      await readRequestBody(request);
      if (request.url === "/oauth/token") {
        refreshCalls += 1;
        response.writeHead(refreshStatus, {
          "content-type": "application/json",
          "retry-after": "120",
        });
        response.end(
          JSON.stringify(
            refreshStatus === 503
              ? { error: "temporarily_unavailable" }
              : { access_token: "oauth-new", expires_in: 3600 },
          ),
        );
        return;
      }
      authorizations.push(request.headers.authorization);
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
    cleanups.push(upstream.close);
    const fixture = await createFixture({
      upstreamUrl: upstream.url,
      source: "import",
      options: {
        now: () => now,
        importCredentials: async () => importedCredentials({ expiresAt }),
        refreshUrl: `${upstream.url}/oauth/token`,
      },
    });
    now = expiresAt - 500;
    const attempts: Array<
      [advanceMs: number, expectedStatus: number, expectedRefreshes: number]
    > = [
      [0, 200, 1],
      [500, 503, 1],
      [59_499, 503, 1],
      [1, 200, 2],
    ];
    for (const [advanceMs, expectedStatus, expectedRefreshes] of attempts) {
      now += advanceMs;
      const response = await fixture.host.harness.behavior.fetchHttp(
        "POST",
        "/v1/messages",
        { headers: authHeaders(fixture.key), body: "{}" },
      );
      await response.text();
      expect(response.status).toBe(expectedStatus);
      expect(refreshCalls).toBe(expectedRefreshes);
      refreshStatus = 200;
    }
    expect(authorizations).toEqual(["Bearer oauth-access", "Bearer oauth-new"]);
  });

  it("marks refresh and upstream authorization failures as account errors", async () => {
    const upstream = await startUpstream((request, response) => {
      if (request.url === "/oauth/token") {
        response.writeHead(401, { "content-type": "application/json" });
        response.end("{}");
        return;
      }
      response.writeHead(401, { "content-type": "application/json" });
      response.end('{"error":{"message":"bad account"}}');
    });
    cleanups.push(upstream.close);
    const refreshFixture = await createFixture({
      upstreamUrl: upstream.url,
      source: "import",
      options: {
        importCredentials: async () =>
          importedCredentials({ expiresAt: Date.now() + 1_000 }),
        refreshUrl: `${upstream.url}/oauth/token`,
      },
    });
    const refreshResponse =
      await refreshFixture.host.harness.behavior.fetchHttp(
        "POST",
        "/v1/messages",
        { headers: authHeaders(refreshFixture.key), body: "{}" },
      );
    expect(refreshResponse.status).toBe(429);
    const refreshAccounts = z
      .array(accountSummarySchema)
      .parse(
        await refreshFixture.host.harness.behavior.callRpc(
          "account.list",
          null,
        ),
      );
    expect(refreshAccounts[0]?.status).toBe("error");
    expect(refreshAccounts[0]?.error).toContain("OAuth refresh failed");

    const authFixture = await createFixture({ upstreamUrl: upstream.url });
    const authResponse = await authFixture.host.harness.behavior.fetchHttp(
      "POST",
      "/v1/messages",
      { headers: authHeaders(authFixture.key), body: "{}" },
    );
    expect(authResponse.status).toBe(401);
    await authResponse.text();
    const authAccounts = z
      .array(accountSummarySchema)
      .parse(
        await authFixture.host.harness.behavior.callRpc("account.list", null),
      );
    expect(authAccounts[0]?.status).toBe("error");
    expect(authAccounts[0]?.error).toContain("bad account");
  });

  it("suppresses env and health only for the provider whose routing is off", async () => {
    const fixture = await createFixture({
      upstreamUrl: "https://upstream.example",
      options: {
        fetch: async () => Response.json({}),
        codexUsageUrl: EMPTY_USAGE_URL,
        importCodexCredentials: async () => ({
          accessToken: "codex-access",
          refreshToken: "codex-refresh",
          idToken: "codex-id",
          accountId: "chatgpt-account",
          planType: null,
          email: "codex@example.com",
          expiresAt: Date.now() + 60_000,
        }),
      },
    });
    await fixture.host.harness.behavior.callRpc("account.add", {
      provider: "codex",
      source: { kind: "import" },
      label: null,
      priority: 100,
    });
    const disabled = await fixture.host.harness.behavior.runCli([
      "routing",
      "claude",
      "--off",
    ]);
    expect(disabled).toMatchObject({ exitCode: 0 });
    await expect(
      fixture.host.harness.behavior.resolveProviderEnv("claude-code", {
        threadId: "thread-off",
        projectId: "project-one",
        hostId: "host-one",
      }),
    ).resolves.toEqual([]);
    await expect(
      fixture.host.harness.behavior.resolveProviderEnvHealth("claude-code", {
        hostId: "host-one",
      }),
    ).resolves.toBeNull();
    await expect(resolveCodexToken(fixture.host)).resolves.toMatchObject({
      baseUrl: "/api/v1/plugins/account-pool/http/v1",
    });
    const result = statusSchema.parse(
      await fixture.host.harness.behavior.callRpc("status.get", null),
    );
    expect(result.routing).toEqual({ claude: false, codex: true });
  });

  it("records the selected account's last-use time and host", async () => {
    const upstream = await startUpstream((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
    cleanups.push(upstream.close);
    let now = 1_800_000_000_000;
    const fixture = await createFixture({
      upstreamUrl: upstream.url,
      options: { now: () => now },
    });
    const changedCount = () =>
      fixture.host.harness.inspection.realtimeSignals.filter(
        (signal) => signal.channel === "accounts-changed",
      ).length;
    const baseline = changedCount();
    const forward = async (key: string) => {
      const response = await fixture.host.harness.behavior.fetchHttp(
        "POST",
        "/v1/messages",
        { headers: authHeaders(key), body: "{}" },
      );
      await response.text();
    };
    await forward(fixture.key);
    expect(changedCount()).toBe(baseline + 1);
    now += 1_000;
    await forward(fixture.key);
    expect(changedCount()).toBe(baseline + 1);
    const secondHostKey = await resolveToken(
      fixture.host,
      "host-two",
      "thread-two",
    );
    await forward(secondHostKey);
    expect(changedCount()).toBe(baseline + 2);
    const result = statusSchema.parse(
      await fixture.host.harness.behavior.callRpc("status.get", null),
    );
    expect(result.accounts[0]).toMatchObject({
      lastUsedAt: now,
      lastUsedHostId: "host-two",
      lastUsedHostName: "Two",
    });
  });

  it("sets priority, refreshes one account, and returns status over RPC", async () => {
    const upstream = await startUpstream((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
    cleanups.push(upstream.close);
    const fixture = await createFixture({ upstreamUrl: upstream.url });
    const priority = z.object({ account: accountSchema.nullable() }).parse(
      await fixture.host.harness.behavior.callRpc("account.setPriority", {
        accountId: fixture.account.id,
        priority: 42,
      }),
    );
    expect(priority.account?.priority).toBe(42);
    const refreshed = z
      .object({ account: accountSummarySchema.nullable() })
      .parse(
        await fixture.host.harness.behavior.callRpc("account.refreshUsage", {
          accountId: fixture.account.id,
        }),
      );
    expect(refreshed.account?.id).toBe(fixture.account.id);
    expect(
      statusSchema.parse(
        await fixture.host.harness.behavior.callRpc("status.get", null),
      ).accounts[0]?.priority,
    ).toBe(42);
  });

  it.each(["claude", "codex"] as const)(
    "reports failed %s manual usage reads without losing cached quota or blocking recovery",
    async (provider) => {
      let failure: "network" | "http" | "payload" | null = null;
      let utilization = 20;
      const fixture = await createFixture({
        upstreamUrl: "https://upstream.example",
        provider,
        source: "import",
        options: {
          usageUrl: "https://upstream.example/usage",
          codexUsageUrl: "https://upstream.example/usage",
          importCredentials: async () => importedCredentials(),
          importCodexCredentials: async () => ({
            accessToken: "oauth-old",
            refreshToken: "oauth-refresh",
            idToken: null,
            accountId: "chatgpt-account",
            planType: null,
            email: "codex@example.test",
            expiresAt: Date.now() + 3_600_000,
          }),
          fetch: async (input) => {
            if (new URL(String(input)).pathname === "/usage") {
              if (failure === "network")
                throw new Error("PRIVATE_UPSTREAM_DETAIL");
              if (failure === "http")
                return Response.json(
                  { detail: "PRIVATE_UPSTREAM_DETAIL" },
                  { status: 503 },
                );
              if (failure === "payload")
                return Response.json({ unexpected: "PRIVATE_UPSTREAM_DETAIL" });
              return Response.json(
                provider === "claude"
                  ? { seven_day: { utilization } }
                  : {
                      rate_limit: {
                        primary_window: {
                          used_percent: utilization,
                          limit_window_seconds: 604800,
                        },
                      },
                    },
              );
            }
            return Response.json({ ok: true });
          },
        },
      });
      const accountState = async () =>
        statusSchema
          .parse(
            await fixture.host.harness.behavior.callRpc("status.get", null),
          )
          .accounts.find((account) => account.id === fixture.account.id);
      const cached = await accountState();
      const quota = (account: typeof cached) =>
        provider === "claude"
          ? account?.sevenDayUtilization
          : account?.limitWindows[0]?.utilization;
      expect(quota(cached)).toBe(0.2);
      for (const mode of ["network", "http", "payload"] as const) {
        failure = mode;
        await expect(
          fixture.host.harness.behavior.callRpc("account.refreshUsage", {
            accountId: fixture.account.id,
          }),
        ).rejects.toThrow("Could not refresh account usage. Try again.");
        await expect(
          fixture.host.harness.behavior.callRpc(usageFetchMethod, {
            resourceId: fixture.account.id,
            refresh: true,
          }),
        ).rejects.toThrow("Could not refresh account usage. Try again.");
        expect(await accountState()).toMatchObject({
          enabled: true,
          error: null,
        });
        expect(quota(await accountState())).toBe(quota(cached));
      }
      failure = null;
      utilization = 30;
      await fixture.host.harness.behavior.callRpc("account.refreshUsage", {
        accountId: fixture.account.id,
      });
      expect(await accountState()).toMatchObject({
        enabled: true,
        error: null,
      });
      expect(quota(await accountState())).toBe(0.3);
    },
  );

  async function claudePlanFixture(
    profile: Record<string, unknown>,
    firstProfileFailure:
      | "network"
      | "http"
      | "json"
      | "payload"
      | "identity"
      | null = null,
  ) {
    const profileCalls: string[] = [];
    const fixture = await createFixture({
      upstreamUrl: "https://upstream.example",
      source: "import",
      options: {
        usageUrl: "https://upstream.example/usage",
        oauthProfileUrl: "https://upstream.example/profile",
        importCredentials: async () =>
          importedCredentials({
            subscriptionType: "max",
            rateLimitTier: "default_claude_max_5x",
          }),
        fetch: async (input, init) => {
          const url = new URL(String(input));
          if (url.pathname === "/profile") {
            profileCalls.push(
              new Headers(init?.headers).get("authorization") ?? "",
            );
            if (profileCalls.length === 1) {
              if (firstProfileFailure === "network")
                throw new Error("Profile request failed");
              if (firstProfileFailure === "http")
                return Response.json({ error: "Unavailable" }, { status: 503 });
              if (firstProfileFailure === "json")
                return new Response("Unreadable profile");
              if (firstProfileFailure === "payload")
                return Response.json({ account: { uuid: "invalid" } });
              if (firstProfileFailure === "identity")
                return Response.json({
                  ...profile,
                  account: { uuid: "99999999-9999-4999-8999-999999999999" },
                });
            }
            return Response.json(profile);
          }
          if (url.pathname === "/usage")
            return Response.json({ seven_day: { utilization: 13 } });
          return Response.json({ ok: true });
        },
      },
    });
    const listed = async () =>
      z
        .array(accountSummarySchema)
        .parse(
          await fixture.host.harness.behavior.callRpc("account.list", null),
        )
        .find((account) => account.id === fixture.account.id);
    return { fixture, listed, profileCalls };
  }

  it("refreshes a Claude account's plan when Anthropic reports a new tier", async () => {
    const { fixture, listed, profileCalls } = await claudePlanFixture({
      account: {
        uuid: "11111111-1111-4111-8111-111111111111",
        has_claude_max: true,
      },
      organization: {
        organization_type: "claude_max",
        rate_limit_tier: "default_claude_max_20x",
      },
    });
    await fixture.host.harness.behavior.callRpc("account.refreshUsage", {
      accountId: fixture.account.id,
    });

    expect(await listed()).toMatchObject({
      subscriptionType: "max",
      rateLimitTier: "default_claude_max_20x",
    });
    const fetched = usageMeasurementSchema.parse(
      await fixture.host.harness.behavior.callRpc(usageFetchMethod, {
        resourceId: fixture.account.id,
        refresh: false,
      }),
    );
    expect(fetched.usage).toMatchObject({ planLabel: "Max (20x)" });
    expect(profileCalls.length).toBeGreaterThan(0);
    expect(profileCalls.every((value) => value === "Bearer oauth-access")).toBe(
      true,
    );
  });

  it("checks a Claude account's plan at most once per refresh interval", async () => {
    const { fixture, profileCalls } = await claudePlanFixture({
      account: { uuid: "11111111-1111-4111-8111-111111111111" },
      organization: { rate_limit_tier: "default_claude_max_20x" },
    });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await fixture.host.harness.behavior.callRpc("account.refreshUsage", {
        accountId: fixture.account.id,
      });
    }

    expect(profileCalls).toHaveLength(1);
  });

  it.each(["network", "http", "json", "payload", "identity"] as const)(
    "retries a failed Claude profile lookup on the next usage refresh after %s failure",
    async (failure) => {
      const organizationUuid = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      const { fixture, listed, profileCalls } = await claudePlanFixture(
        {
          account: {
            uuid: "11111111-1111-4111-8111-111111111111",
            has_claude_max: true,
          },
          organization: {
            uuid: organizationUuid,
            rate_limit_tier: "default_claude_max_20x",
          },
        },
        failure,
      );
      const refresh = () =>
        fixture.host.harness.behavior.callRpc("account.refreshUsage", {
          accountId: fixture.account.id,
        });

      expect(profileCalls.length).toBe(1);
      expect(await listed()).toMatchObject({
        organizationUuid: null,
        rateLimitTier: "default_claude_max_5x",
      });

      await refresh();
      expect(profileCalls.length).toBe(2);
      expect(await listed()).toMatchObject({
        organizationUuid,
        subscriptionType: "max",
        rateLimitTier: "default_claude_max_20x",
      });
      await refresh();
      expect(profileCalls.length).toBe(2);
    },
  );

  it.each([
    [
      "omits the tier",
      { account: { uuid: "11111111-1111-4111-8111-111111111111" } },
    ],
    [
      "describes another Claude account",
      {
        account: {
          uuid: "99999999-9999-4999-8999-999999999999",
          has_claude_max: true,
        },
        organization: { rate_limit_tier: "default_claude_max_20x" },
      },
    ],
  ])(
    "keeps a Claude account's stored plan when the profile %s",
    async (_case, profile) => {
      const { fixture, listed, profileCalls } =
        await claudePlanFixture(profile);
      await fixture.host.harness.behavior.callRpc("account.refreshUsage", {
        accountId: fixture.account.id,
      });

      expect(await listed()).toMatchObject({
        accountUuid: "11111111-1111-4111-8111-111111111111",
        subscriptionType: "max",
        rateLimitTier: "default_claude_max_5x",
      });
      expect(profileCalls.length).toBeGreaterThan(0);
    },
  );

  it("publishes recovered account state when the follow-up usage read fails", async () => {
    const now = 1_800_000_000_000;
    let refreshCalls = 0;
    let usageCalls = 0;
    const fixture = await createFixture({
      upstreamUrl: "https://upstream.example",
      provider: "claude",
      source: "import",
      options: {
        refreshUrl: "https://upstream.example/oauth/token",
        usageUrl: "https://upstream.example/usage",
        now: () => now,
        importCredentials: async () =>
          importedCredentials({ expiresAt: now + 60 * 60 * 1_000 }),
        fetch: async (input) => {
          if (new URL(String(input)).pathname === "/oauth/token") {
            refreshCalls += 1;
            return Response.json({
              access_token: "oauth-recovered",
              expires_in: 3600,
            });
          }
          usageCalls += 1;
          return Response.json(
            { detail: "usage unavailable" },
            { status: 500 },
          );
        },
      },
    });
    const quotas = new QuotaStore(fixture.host.bb.storage.database());
    quotas.put({
      ...quotas.get(fixture.account.id),
      error: "Previous refresh failed.",
    });
    const baselineUsageCalls = usageCalls;
    const changedCount = () =>
      fixture.host.harness.inspection.realtimeSignals.filter(
        (signal) => signal.channel === "accounts-changed",
      ).length;
    const baseline = changedCount();

    await expect(
      fixture.host.harness.behavior.callRpc("account.refreshUsage", {
        accountId: fixture.account.id,
      }),
    ).rejects.toThrow("Could not refresh account usage. Try again.");
    expect(refreshCalls).toBe(1);
    expect(usageCalls).toBe(baselineUsageCalls + 1);

    const account = statusSchema
      .parse(await fixture.host.harness.behavior.callRpc("status.get", null))
      .accounts.find((item) => item.id === fixture.account.id);
    expect(account?.error).toBeNull();
    expect(changedCount()).toBe(baseline + 1);
  });

  it("keeps background usage failures from stopping the pool or rejecting requests", async () => {
    const fixture = await createFixture({
      upstreamUrl: "https://upstream.example",
      source: "import",
      options: {
        usageUrl: "https://upstream.example/usage",
        importCredentials: async () => importedCredentials(),
        fetch: async (input) => {
          if (new URL(String(input)).pathname === "/usage")
            throw new Error("PRIVATE_UPSTREAM_DETAIL");
          return Response.json({ ok: true });
        },
      },
    });
    const response = await fixture.host.harness.behavior.fetchHttp(
      "POST",
      "/v1/messages",
      { headers: authHeaders(fixture.key), body: "{}" },
    );
    expect(response.status).toBe(200);
    await response.text();
    const status = statusSchema.parse(
      await fixture.host.harness.behavior.callRpc("status.get", null),
    );
    expect(status.accepting).toBe(true);
    expect(status.accounts[0]).toMatchObject({ enabled: true, error: null });
  });

  it("drains completed streams and aborts a stuck stream after the stop deadline", async () => {
    const upstream = await startUpstream((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write("data: started\n\n");
    });
    cleanups.push(upstream.close);
    const fixture = await createFixture({
      upstreamUrl: upstream.url,
      options: { drainTimeoutMs: 40 },
    });
    const response = await fixture.host.harness.behavior.fetchHttp(
      "POST",
      "/v1/messages",
      {
        headers: authHeaders(fixture.key),
        body: "{}",
      },
    );
    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error("Expected a streaming body.");
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe("data: started\n\n");
    const startedAt = Date.now();
    fixture.service.controller.abort();
    await fixture.service.done;
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(30);
    const stopped = await reader.read();
    expect(new TextDecoder().decode(stopped.value)).toContain(
      "Account Pooler stopped",
    );
    const rejected = await fixture.host.harness.behavior.fetchHttp(
      "POST",
      "/v1/messages",
      { headers: authHeaders(fixture.key), body: "{}" },
    );
    expect(rejected.status).toBe(503);
  });

  describe("Automatic account balancing", () => {
    const now = 1_800_000_000_000;

    async function fixtureWithAccounts(): Promise<{
      fixture: Fixture;
      second: AccountSummary;
      seen: string[];
      send: (
        threadId: string,
        sessionId: string,
        model?: string,
      ) => Promise<void>;
    }> {
      const seen: string[] = [];
      const upstream = await startUpstream((request, response) => {
        seen.push(String(request.headers["x-api-key"]));
        response.writeHead(200, { "content-type": "application/json" });
        response.end("{}");
      });
      cleanups.push(upstream.close);
      const fixture = await createFixture({
        upstreamUrl: upstream.url,
        apiKey: "sk-first",
        options: { now: () => now },
      });
      const second = await addApiAccount(fixture, "sk-second", 200);
      return {
        fixture,
        second,
        seen,
        async send(threadId, sessionId, model = "claude-opus-4-1") {
          const token = await resolveToken(fixture.host, "host-one", threadId);
          const response = await fixture.host.harness.behavior.fetchHttp(
            "POST",
            "/v1/messages",
            {
              headers: authHeaders(token),
              body: JSON.stringify({
                model,
                metadata: {
                  user_id: JSON.stringify({ session_id: sessionId }),
                },
              }),
            },
          );
          expect(response.status).toBe(200);
          await response.text();
        },
      };
    }

    it("chooses 2% weekly usage over an account at 100%", async () => {
      const pool = await fixtureWithAccounts();
      setQuota(pool.fixture, pool.fixture.account.id, {
        sevenDayUtilization: 1,
        sevenDayResetAt: now + 7 * 24 * 60 * 60 * 1_000,
      });
      setQuota(pool.fixture, pool.second.id, {
        sevenDayUtilization: 0.02,
        sevenDayResetAt: now + 7 * 24 * 60 * 60 * 1_000,
      });

      await pool.send("thread-weekly", "session-weekly");

      expect(pool.seen).toEqual(["sk-second"]);
      const status = statusSchema.parse(
        await pool.fixture.host.harness.behavior.callRpc("status.get", null),
      );
      expect(
        status.accounts.find(({ id }) => id === pool.second.id),
      ).toMatchObject({
        balance: {
          bindingWindow: "weekly",
          bindingHeadroom: 0.98,
        },
        lastAutomaticChoice: {
          reason: "most headroom",
          balance: { bindingWindow: "weekly", bindingHeadroom: 0.98 },
        },
      });
      const cliStatus = await pool.fixture.host.harness.behavior.runCli([
        "status",
      ]);
      expect(cliStatus.exitCode).toBe(0);
      expect(cliStatus.stdout).toContain("Binding window");
      expect(cliStatus.stdout).toContain("Headroom");
      expect(cliStatus.stdout).toContain("most headroom");
    });

    it("clears weekly utilization when its reset time has passed", async () => {
      const pool = await fixtureWithAccounts();
      setQuota(pool.fixture, pool.fixture.account.id, {
        sevenDayUtilization: 0.97,
        sevenDayResetAt: now - 60 * 60 * 1_000,
      });
      setQuota(pool.fixture, pool.second.id, {
        sevenDayUtilization: 0.9,
        sevenDayResetAt: now + 7 * 24 * 60 * 60 * 1_000,
      });

      await pool.send("thread-expired-week", "session-expired-week");

      expect(pool.seen).toEqual(["sk-first"]);
    });

    it("clears rejected utilization when its reset time has passed", async () => {
      const pool = await fixtureWithAccounts();
      setQuota(pool.fixture, pool.fixture.account.id, {
        fiveHourUtilization: 1,
        fiveHourStatus: "rejected",
        fiveHourResetAt: now - 60 * 1_000,
      });
      setQuota(pool.fixture, pool.second.id, {
        fiveHourUtilization: 0.95,
        fiveHourStatus: "allowed",
        fiveHourResetAt: now + 5 * 60 * 60 * 1_000,
      });

      await pool.send("thread-rejected-window", "session-rejected-window");

      expect(pool.seen).toEqual(["sk-first"]);
    });

    it("ranks known headroom before unknown headroom but keeps unknown as a fallback", async () => {
      const pool = await fixtureWithAccounts();
      setQuota(pool.fixture, pool.fixture.account.id, {
        fiveHourUtilization: 0.2,
        fiveHourResetAt: now + 5 * 60 * 60 * 1_000,
        sevenDayUtilization: 0.2,
        sevenDayResetAt: now + 7 * 24 * 60 * 60 * 1_000,
      });

      await pool.send("thread-known-quota", "session-known-quota");

      setQuota(pool.fixture, pool.fixture.account.id, {
        fiveHourUtilization: 0.98,
        fiveHourResetAt: now + 5 * 60 * 60 * 1_000,
        sevenDayUtilization: 0.2,
        sevenDayResetAt: now + 7 * 24 * 60 * 60 * 1_000,
      });
      await pool.send("thread-unknown-fallback", "session-unknown-fallback");

      expect(pool.seen).toEqual(["sk-first", "sk-second"]);
    });

    it("chooses the account with more binding headroom when weekly usage is low", async () => {
      const pool = await fixtureWithAccounts();
      setQuota(pool.fixture, pool.fixture.account.id, {
        fiveHourUtilization: 0.95,
        fiveHourResetAt: now + 5 * 60 * 60 * 1_000,
        sevenDayUtilization: 0.02,
        sevenDayResetAt: now + 7 * 24 * 60 * 60 * 1_000,
      });
      setQuota(pool.fixture, pool.second.id, {
        fiveHourUtilization: 0.12,
        fiveHourResetAt: now + 5 * 60 * 60 * 1_000,
        sevenDayUtilization: 0.02,
        sevenDayResetAt: now + 7 * 24 * 60 * 60 * 1_000,
      });

      await pool.send("thread-five-hour", "session-five-hour");

      expect(pool.seen).toEqual(["sk-second"]);
    });

    it("uses priority as the final tie-breaker for equal headroom", async () => {
      const pool = await fixtureWithAccounts();
      await pool.fixture.host.harness.behavior.callRpc("account.setPriority", {
        accountId: pool.fixture.account.id,
        priority: 10,
      });
      for (const accountId of [pool.fixture.account.id, pool.second.id])
        setQuota(pool.fixture, accountId, {
          fiveHourUtilization: 0.2,
          fiveHourResetAt: now + 5 * 60 * 60 * 1_000,
          sevenDayUtilization: 0.2,
          sevenDayResetAt: now + 7 * 24 * 60 * 60 * 1_000,
        });

      await pool.send("thread-priority", "session-priority");

      expect(pool.seen).toEqual(["sk-first"]);
    });

    it("uses reset recovery to break equal-headroom ties", async () => {
      const pool = await fixtureWithAccounts();
      setQuota(pool.fixture, pool.fixture.account.id, {
        sevenDayUtilization: 0.2,
        sevenDayResetAt: now + 7 * 24 * 60 * 60 * 1_000,
      });
      setQuota(pool.fixture, pool.second.id, {
        sevenDayUtilization: 0.2,
        sevenDayResetAt: now + 60 * 60 * 1_000,
      });

      await pool.send("thread-reset-tie", "session-reset-tie");

      expect(pool.seen).toEqual(["sk-second"]);
    });

    it("includes the requested model-family quota in binding headroom", async () => {
      const pool = await fixtureWithAccounts();
      for (const accountId of [pool.fixture.account.id, pool.second.id]) {
        const quota = new QuotaStore(
          pool.fixture.host.bb.storage.database(),
        ).get(accountId);
        setQuota(pool.fixture, accountId, {
          sevenDayUtilization: 0.1,
          sevenDayResetAt: now + 7 * 24 * 60 * 60 * 1_000,
          familyWeekly: {
            ...quota.familyWeekly,
            fable: {
              utilization: accountId === pool.fixture.account.id ? 0.9 : 0.2,
              resetAt: now + 7 * 24 * 60 * 60 * 1_000,
              status: "allowed",
              observedAt: now,
              source: "usage",
            },
          },
        });
      }

      await pool.send("thread-fable", "session-fable", "claude-fable-5");

      expect(pool.seen).toEqual(["sk-second"]);
    });

    it("keeps an affinity until its account crosses a quota threshold and reports a different next pick", async () => {
      const pool = await fixtureWithAccounts();
      setQuota(pool.fixture, pool.fixture.account.id, {
        sevenDayUtilization: 0.2,
        sevenDayResetAt: now + 7 * 24 * 60 * 60 * 1_000,
      });
      setQuota(pool.fixture, pool.second.id, {
        sevenDayUtilization: 0.4,
        sevenDayResetAt: now + 7 * 24 * 60 * 60 * 1_000,
      });
      await pool.send("thr_balancer_affinity", "session-affinity");
      expect(pool.seen).toEqual(["sk-first"]);

      setQuota(pool.fixture, pool.fixture.account.id, {
        sevenDayUtilization: 0.6,
        sevenDayResetAt: now + 7 * 24 * 60 * 60 * 1_000,
      });
      setQuota(pool.fixture, pool.second.id, {
        sevenDayUtilization: 0.1,
        sevenDayResetAt: now + 7 * 24 * 60 * 60 * 1_000,
      });
      const binding = await pool.fixture.host.harness.behavior.callRpc(
        "routing.binding.get",
        { threadId: "thr_balancer_affinity", provider: "claude" },
      );
      expect(binding).toMatchObject({
        boundAccountId: pool.fixture.account.id,
        nextAccountId: pool.second.id,
        reason: "most headroom",
      });
      await pool.send("thr_balancer_affinity", "session-affinity");
      expect(pool.seen).toEqual(["sk-first", "sk-first"]);

      setQuota(pool.fixture, pool.fixture.account.id, {
        sevenDayUtilization: 0.98,
        sevenDayResetAt: now + 7 * 24 * 60 * 60 * 1_000,
      });
      await pool.send("thr_balancer_affinity", "session-affinity");
      expect(pool.seen).toEqual(["sk-first", "sk-first", "sk-second"]);
    });

    it("returns the binding for the requested thread when another thread was used later", async () => {
      const pool = await fixtureWithAccounts();
      setQuota(pool.fixture, pool.fixture.account.id, {
        sevenDayUtilization: 0.2,
        sevenDayResetAt: now + 7 * 24 * 60 * 60 * 1_000,
      });
      setQuota(pool.fixture, pool.second.id, {
        sevenDayUtilization: 0.4,
        sevenDayResetAt: now + 7 * 24 * 60 * 60 * 1_000,
      });
      await pool.send("thr_balancerthreadone", "session-thread-one");

      setQuota(pool.fixture, pool.fixture.account.id, {
        sevenDayUtilization: 0.6,
        sevenDayResetAt: now + 7 * 24 * 60 * 60 * 1_000,
      });
      setQuota(pool.fixture, pool.second.id, {
        sevenDayUtilization: 0.1,
        sevenDayResetAt: now + 7 * 24 * 60 * 60 * 1_000,
      });
      await pool.send("thr_balancerthreadtwo", "session-thread-two");

      const first = await pool.fixture.host.harness.behavior.callRpc(
        "routing.binding.get",
        { threadId: "thr_balancerthreadone", provider: "claude" },
      );
      const second = await pool.fixture.host.harness.behavior.callRpc(
        "routing.binding.get",
        { threadId: "thr_balancerthreadtwo", provider: "claude" },
      );

      expect(first).toMatchObject({ boundAccountId: pool.fixture.account.id });
      expect(second).toMatchObject({ boundAccountId: pool.second.id });
    });

    it("reports all enabled accounts in binding headroom when none are eligible", async () => {
      const pool = await fixtureWithAccounts();
      for (const accountId of [pool.fixture.account.id, pool.second.id])
        setQuota(pool.fixture, accountId, {
          fiveHourUtilization: 0.98,
          fiveHourResetAt: now + 5 * 60 * 60 * 1_000,
          sevenDayUtilization: 0.98,
          sevenDayResetAt: now + 7 * 24 * 60 * 60 * 1_000,
        });

      const binding = await pool.fixture.host.harness.behavior.callRpc(
        "routing.binding.get",
        { threadId: "thr_exhaustedpreview", provider: "claude" },
      );

      expect(binding).toMatchObject({
        boundAccountId: null,
        nextAccountId: null,
        headroom: [
          { accountId: pool.fixture.account.id, eligible: false },
          { accountId: pool.second.id, eligible: false },
        ],
      });
    });

    it("excludes held accounts from the binding preview", async () => {
      const pool = await fixtureWithAccounts();
      setQuota(pool.fixture, pool.fixture.account.id, {
        sevenDayUtilization: 0.1,
        sevenDayResetAt: now + 7 * 24 * 60 * 60 * 1_000,
        heldUntil: now + 60 * 1_000,
      });
      setQuota(pool.fixture, pool.second.id, {
        sevenDayUtilization: 0.3,
        sevenDayResetAt: now + 7 * 24 * 60 * 60 * 1_000,
      });

      const next = await pool.fixture.host.harness.behavior.callRpc(
        "routing.binding.next",
        { provider: "claude" },
      );

      expect(next).toMatchObject({ nextAccountId: pool.second.id });
    });

    it("keeps a held account bound while previewing another account for new work", async () => {
      const pool = await fixtureWithAccounts();
      setQuota(pool.fixture, pool.fixture.account.id, {
        sevenDayUtilization: 0.2,
        sevenDayResetAt: now + 7 * 24 * 60 * 60 * 1_000,
      });
      setQuota(pool.fixture, pool.second.id, {
        sevenDayUtilization: 0.4,
        sevenDayResetAt: now + 7 * 24 * 60 * 60 * 1_000,
      });
      await pool.send("thr_heldbindingpreview", "session-heldbindingpreview");

      setQuota(pool.fixture, pool.fixture.account.id, {
        sevenDayUtilization: 0.2,
        sevenDayResetAt: now + 7 * 24 * 60 * 60 * 1_000,
        heldUntil: now + 60 * 1_000,
      });

      const binding = await pool.fixture.host.harness.behavior.callRpc(
        "routing.binding.get",
        { threadId: "thr_heldbindingpreview", provider: "claude" },
      );

      expect(binding).toMatchObject({
        boundAccountId: pool.fixture.account.id,
        nextAccountId: pool.second.id,
        headroom: [
          { accountId: pool.fixture.account.id, eligible: false },
          { accountId: pool.second.id, eligible: true },
        ],
      });
    });

    it("keeps an Automatic conversation bound through a hold and returns to it afterward", async () => {
      const pool = await fixtureWithAccounts();
      setQuota(pool.fixture, pool.fixture.account.id, {
        sevenDayUtilization: 0.2,
        sevenDayResetAt: now + 7 * 24 * 60 * 60 * 1_000,
      });
      await pool.send("thr_longholdrebalance", "session-longholdrebalance");

      setQuota(pool.fixture, pool.fixture.account.id, {
        sevenDayUtilization: 0.2,
        sevenDayResetAt: now + 7 * 24 * 60 * 60 * 1_000,
        heldUntil: now + 60 * 1_000,
      });
      const before = await pool.fixture.host.harness.behavior.callRpc(
        "routing.binding.get",
        { threadId: "thr_longholdrebalance", provider: "claude" },
      );
      expect(before).toMatchObject({
        boundAccountId: pool.fixture.account.id,
        nextAccountId: pool.second.id,
        headroom: [
          { accountId: pool.fixture.account.id, eligible: false },
          { accountId: pool.second.id, eligible: true },
        ],
      });

      await pool.send("thr_longholdrebalance", "session-longholdrebalance");

      expect(pool.seen).toEqual(["sk-first", "sk-second"]);
      const after = await pool.fixture.host.harness.behavior.callRpc(
        "routing.binding.get",
        { threadId: "thr_longholdrebalance", provider: "claude" },
      );
      expect(after).toMatchObject({
        boundAccountId: pool.fixture.account.id,
        nextAccountId: pool.second.id,
      });

      setQuota(pool.fixture, pool.fixture.account.id, {
        sevenDayUtilization: 0.2,
        sevenDayResetAt: now + 7 * 24 * 60 * 60 * 1_000,
        heldUntil: null,
      });
      await pool.send("thr_longholdrebalance", "session-longholdrebalance");
      await pool.send("thr_longholdrebalance", "session-longholdrebalance");

      expect(pool.seen).toEqual([
        "sk-first",
        "sk-second",
        "sk-first",
        "sk-first",
      ]);
    });

    it("keeps an explicitly pinned conversation on its account during a long hold", async () => {
      const pool = await fixtureWithAccounts();
      pool.fixture.host.harness.sdk.stub("threads.get", async ({ threadId }) =>
        makeThreadResponse({
          id: threadId,
          providerId: "claude-code",
          status: "idle",
        }),
      );
      pool.fixture.host.harness.sdk.stub(
        "threads.queuedMessages.list",
        async () => [],
      );
      await pool.fixture.host.harness.behavior.callRpc(
        "routing.selection.set",
        {
          threadId: "thr_longholdpin",
          provider: "claude",
          accountId: pool.fixture.account.id,
        },
      );
      setQuota(pool.fixture, pool.fixture.account.id, {
        sevenDayUtilization: 0.2,
        sevenDayResetAt: now + 7 * 24 * 60 * 60 * 1_000,
        heldUntil: now + 60 * 1_000,
      });

      const token = await resolveToken(
        pool.fixture.host,
        "host-one",
        "thr_longholdpin",
      );
      const response = await pool.fixture.host.harness.behavior.fetchHttp(
        "POST",
        "/v1/messages",
        {
          headers: authHeaders(token),
          body: JSON.stringify({
            model: "claude-opus-4-1",
            messages: [],
            max_tokens: 1,
          }),
        },
      );

      expect(response.status).toBe(429);
      await response.text();
      expect(pool.seen).toEqual([]);
    });

    it("keeps an extra-usage eligible bound account in the binding preview", async () => {
      const pool = await fixtureWithAccounts();
      setQuota(pool.fixture, pool.fixture.account.id, {
        sevenDayUtilization: 0.2,
        sevenDayResetAt: now + 7 * 24 * 60 * 60 * 1_000,
      });
      setQuota(pool.fixture, pool.second.id, {
        sevenDayUtilization: 0.4,
        sevenDayResetAt: now + 7 * 24 * 60 * 60 * 1_000,
      });
      await pool.send("thr_extrausagepreview", "session-extrausagepreview");

      setQuota(pool.fixture, pool.fixture.account.id, {
        sevenDayUtilization: 0.98,
        sevenDayResetAt: now + 7 * 24 * 60 * 60 * 1_000,
        extraUsage: { status: "allowed", observedAt: now, source: "usage" },
      });
      setQuota(pool.fixture, pool.second.id, {
        sevenDayUtilization: 0.98,
        sevenDayResetAt: now + 7 * 24 * 60 * 60 * 1_000,
      });

      const binding = await pool.fixture.host.harness.behavior.callRpc(
        "routing.binding.get",
        { threadId: "thr_extrausagepreview", provider: "claude" },
      );

      expect(binding).toMatchObject({
        boundAccountId: pool.fixture.account.id,
        nextAccountId: pool.fixture.account.id,
        headroom: [
          { accountId: pool.fixture.account.id, eligible: true },
          { accountId: pool.second.id, eligible: false },
        ],
      });
    });

    it("does not report an extra-usage bound account when routing narrows below threshold", async () => {
      const pool = await fixtureWithAccounts();
      setQuota(pool.fixture, pool.fixture.account.id, {
        sevenDayUtilization: 0.2,
        sevenDayResetAt: now + 7 * 24 * 60 * 60 * 1_000,
      });
      setQuota(pool.fixture, pool.second.id, {
        sevenDayUtilization: 0.4,
        sevenDayResetAt: now + 7 * 24 * 60 * 60 * 1_000,
      });
      await pool.send("thr_extrausagerebalance", "session-extrausagerebalance");

      setQuota(pool.fixture, pool.fixture.account.id, {
        sevenDayUtilization: 0.98,
        sevenDayResetAt: now + 7 * 24 * 60 * 60 * 1_000,
        extraUsage: { status: "allowed", observedAt: now, source: "usage" },
      });
      setQuota(pool.fixture, pool.second.id, {
        sevenDayUtilization: 0.5,
        sevenDayResetAt: now + 7 * 24 * 60 * 60 * 1_000,
      });

      const binding = await pool.fixture.host.harness.behavior.callRpc(
        "routing.binding.get",
        { threadId: "thr_extrausagerebalance", provider: "claude" },
      );

      expect(binding).toMatchObject({
        boundAccountId: null,
        nextAccountId: pool.second.id,
        headroom: [
          { accountId: pool.fixture.account.id, eligible: false },
          { accountId: pool.second.id, eligible: true },
        ],
      });

      await pool.send("thr_extrausagerebalance", "session-extrausagerebalance");
      expect(pool.seen).toEqual(["sk-first", "sk-second"]);
    });

    it("uses hysteresis for new conversations and switches after a 10-point lead", async () => {
      const pool = await fixtureWithAccounts();
      setQuota(pool.fixture, pool.fixture.account.id, {
        sevenDayUtilization: 0.3,
        sevenDayResetAt: now + 7 * 24 * 60 * 60 * 1_000,
      });
      setQuota(pool.fixture, pool.second.id, {
        sevenDayUtilization: 0.35,
        sevenDayResetAt: now + 7 * 24 * 60 * 60 * 1_000,
      });
      await pool.send("thread-hysteresis-1", "session-hysteresis-1");

      setQuota(pool.fixture, pool.fixture.account.id, {
        sevenDayUtilization: 0.5,
        sevenDayResetAt: now + 7 * 24 * 60 * 60 * 1_000,
      });
      setQuota(pool.fixture, pool.second.id, {
        sevenDayUtilization: 0.45,
        sevenDayResetAt: now + 7 * 24 * 60 * 60 * 1_000,
      });
      await pool.send("thread-hysteresis-2", "session-hysteresis-2");
      expect(pool.seen).toEqual(["sk-first", "sk-first"]);

      setQuota(pool.fixture, pool.fixture.account.id, {
        sevenDayUtilization: 0.65,
        sevenDayResetAt: now + 7 * 24 * 60 * 60 * 1_000,
      });
      await pool.send("thread-hysteresis-3", "session-hysteresis-3");
      expect(pool.seen).toEqual(["sk-first", "sk-first", "sk-second"]);
    });

    it("keeps explicit thread pins independent from automatic headroom", async () => {
      const pool = await fixtureWithAccounts();
      setQuota(pool.fixture, pool.fixture.account.id, {
        sevenDayUtilization: 0.02,
        sevenDayResetAt: now + 7 * 24 * 60 * 60 * 1_000,
      });
      setQuota(pool.fixture, pool.second.id, {
        sevenDayUtilization: 0.9,
        sevenDayResetAt: now + 7 * 24 * 60 * 60 * 1_000,
      });
      const configure =
        pool.fixture.host.harness.registrations.hooks[
          "experimental_thread.configure"
        ];
      if (configure === null) throw new Error("Thread configure hook missing.");
      await configure({
        thread: { id: "thr_balancer_pin", providerId: "claude-code" },
        data: { provider: "claude", accountId: pool.second.id },
      });

      await pool.send("thr_balancer_pin", "session-pinned");

      expect(pool.seen).toEqual(["sk-second"]);
    });

    it("balances across three accounts", async () => {
      const pool = await fixtureWithAccounts();
      const third = await addApiAccount(pool.fixture, "sk-third", 300);
      for (const [accountId, utilization] of [
        [pool.fixture.account.id, 0.9],
        [pool.second.id, 0.3],
        [third.id, 0.1],
      ] as const)
        setQuota(pool.fixture, accountId, {
          sevenDayUtilization: utilization,
          sevenDayResetAt: now + 7 * 24 * 60 * 60 * 1_000,
        });

      await pool.send("thread-three", "session-three");

      expect(pool.seen).toEqual(["sk-third"]);
    });

    it("strictly validates binding RPC inputs and exposes the pool-wide marker", async () => {
      const pool = await fixtureWithAccounts();
      setQuota(pool.fixture, pool.fixture.account.id, {
        sevenDayUtilization: 0.4,
        sevenDayResetAt: now + 7 * 24 * 60 * 60 * 1_000,
      });
      setQuota(pool.fixture, pool.second.id, {
        sevenDayUtilization: 0.1,
        sevenDayResetAt: now + 7 * 24 * 60 * 60 * 1_000,
      });

      await expect(
        pool.fixture.host.harness.behavior.callRpc("routing.binding.get", {
          threadId: "thread-binding-rpc",
          provider: "claude",
          extra: true,
        }),
      ).rejects.toThrow();
      await expect(
        pool.fixture.host.harness.behavior.callRpc("routing.binding.get", {
          threadId: "invalid thread",
          provider: "claude",
        }),
      ).rejects.toThrow();
      await expect(
        pool.fixture.host.harness.behavior.callRpc("routing.binding.next", {
          provider: "claude",
        }),
      ).resolves.toEqual({
        nextAccountId: pool.second.id,
        reason: "most headroom",
      });
    });
  });
});

describe("sequential pool recovery", () => {
  const body = JSON.stringify({
    model: "claude-opus-4-1",
    metadata: { user_id: JSON.stringify({ session_id: "review-session" }) },
  });

  it("bounds repeated waits when a session's rate-limit hold keeps extending", async () => {
    let attempts = 0;
    const fixture = await createFixture({
      upstreamUrl: "https://upstream.example",
      options: {
        now: () => 1_800_000_000_000,
        fetch: async () =>
          ++attempts === 1
            ? Response.json({})
            : Response.json(
                {},
                { status: 429, headers: { "retry-after": "0.01" } },
              ),
      },
    });
    const send = () =>
      fixture.host.harness.behavior.fetchHttp("POST", "/v1/messages", {
        headers: authHeaders(fixture.key),
        body,
        signal: AbortSignal.timeout(1_000),
      });
    await (await send()).text();
    const paced = await send();
    expect(paced.status).toBe(429);
    await paced.text();
    const held = await send();
    expect(held.status).toBe(429);
    await held.text();
    expect(attempts).toBe(3);
  });

  it("keeps a paced session on its account when another request arrives during a short hold", async () => {
    const attempts: Array<string | null> = [];
    let now = 1_800_000_000_000;
    const fixture = await createFixture({
      upstreamUrl: "https://upstream.example",
      apiKey: "sk-first",
      options: {
        now: () => now,
        fetch: async (_input, init) => {
          attempts.push(new Headers(init?.headers).get("x-api-key"));
          return attempts.length === 2
            ? Response.json(
                {},
                {
                  status: 429,
                  headers: {
                    "retry-after": "0.25",
                    "anthropic-ratelimit-unified-5h-status": "allowed",
                    "anthropic-ratelimit-unified-overage-status": "rejected",
                  },
                },
              )
            : Response.json({});
        },
      },
    });
    await addApiAccount(fixture, "sk-second");
    const send = () =>
      fixture.host.harness.behavior.fetchHttp("POST", "/v1/messages", {
        headers: authHeaders(fixture.key),
        body,
      });
    await (await send()).text();
    const paced = send();
    try {
      await vi.waitFor(async () => {
        const status = statusSchema.parse(
          await fixture.host.harness.behavior.callRpc("status.get", null),
        );
        expect(
          status.accounts.find((account) => account.id === fixture.account.id)
            ?.status,
        ).toBe("held");
      });
      const duringHold = send();
      now += 249;
      const duringHoldResponse = await duringHold;
      expect(duringHoldResponse.status).toBe(200);
      await duringHoldResponse.text();
      now += 1;
      await (await paced).text();
      await (await send()).text();
      expect(attempts).toEqual([
        "sk-first",
        "sk-first",
        "sk-first",
        "sk-first",
        "sk-first",
      ]);
    } finally {
      const response = await paced;
      if (!response.bodyUsed) await response.text();
    }
  });

  it("keeps the last working binding after every account fails during a provider outage", async () => {
    const attempts: Array<string | null> = [];
    let outage = false;
    const fixture = await createFixture({
      upstreamUrl: "https://upstream.example",
      apiKey: "sk-first",
      options: {
        fetch: async (_input, init) => {
          attempts.push(new Headers(init?.headers).get("x-api-key"));
          return Response.json({}, { status: outage ? 503 : 200 });
        },
      },
    });
    await addApiAccount(fixture, "sk-second");
    const send = () =>
      fixture.host.harness.behavior.fetchHttp("POST", "/v1/messages", {
        headers: authHeaders(fixture.key),
        body,
      });
    await (await send()).text();
    outage = true;
    const failed = await send();
    expect(failed.status).toBe(503);
    await failed.text();
    outage = false;
    await (await send()).text();
    expect(attempts).toEqual(["sk-first", "sk-first", "sk-second", "sk-first"]);
  });

  it("keeps Codex over-limit accounts ineligible until reset when utilization is omitted", async () => {
    let imported = 0;
    const attempts: Array<string | null> = [];
    const fixture = await createFixture({
      upstreamUrl: "https://upstream.example",
      provider: "codex",
      source: "import",
      options: {
        codexUsageUrl: EMPTY_USAGE_URL,
        importCodexCredentials: async () => ({
          accessToken: imported++ === 0 ? "sk-first" : "sk-second",
          refreshToken: "refresh",
          idToken: null,
          accountId: `review-codex-account-${imported}`,
          planType: null,
          email: null,
          expiresAt: Date.now() + 24 * 60 * 60 * 1_000,
        }),
        fetch: async (input, init) => {
          if (String(input) === EMPTY_USAGE_URL) return Response.json({});
          const key = new Headers(init?.headers).get("authorization");
          attempts.push(key);
          return key === "Bearer sk-first"
            ? Response.json(
                {},
                {
                  status: 429,
                  headers: {
                    "x-codex-primary-over-limit": "true",
                    "x-codex-primary-reset-after-seconds": "60",
                    "x-codex-primary-window-minutes": "300",
                  },
                },
              )
            : Response.json({});
        },
      },
    });
    await fixture.host.harness.behavior.callRpc("account.add", {
      provider: "codex",
      source: { kind: "import" },
      label: null,
      priority: 100,
    });
    for (const session of ["first-session", "second-session"]) {
      const response = await fixture.host.harness.behavior.fetchHttp(
        "POST",
        "/v1/responses",
        {
          headers: { ...authHeaders(fixture.key), "thread-id": session },
          body: "{}",
        },
      );
      expect(response.status).toBe(200);
      await response.text();
    }
    expect(attempts).toEqual([
      "Bearer sk-first",
      "Bearer sk-second",
      "Bearer sk-second",
    ]);
    const status = statusSchema.parse(
      await fixture.host.harness.behavior.callRpc("status.get", null),
    );
    expect(
      status.accounts.find((account) => account.id === fixture.account.id)
        ?.status,
    ).toBe("exhausted");
  });

  it.each([
    ["funded", { has_credits: true, unlimited: false }, null, 200],
    ["unlimited", { has_credits: false, unlimited: true }, null, 200],
    ["depleted", { has_credits: false, unlimited: false }, null, 429],
    ["unknown", null, null, 429],
    [
      "spending cap",
      { has_credits: true, unlimited: true },
      { reached: true },
      429,
    ],
    [
      "individual cap",
      { has_credits: true, unlimited: false },
      {
        reached: false,
        individual_limit: { remaining_percent: 0, reset_at: 4102444800 },
      },
      429,
    ],
  ])(
    "routes Codex credit fallback with %s allowance",
    async (_label, credits, spendControl, expected) => {
      let calls = 0;
      const fixture = await createFixture({
        upstreamUrl: "https://upstream.example",
        provider: "codex",
        source: "import",
        options: {
          codexUsageUrl: "https://upstream.example/usage",
          importCodexCredentials: async () => ({
            accessToken: "codex-credit",
            refreshToken: "refresh",
            expiresAt: Date.now() + 3600000,
            idToken: null,
            accountId: "codex-qa",
            planType: null,
            email: null,
          }),
          fetch: async (input) => {
            if (new URL(String(input)).pathname === "/usage")
              return Response.json({
                rate_limit: {
                  primary_window: {
                    used_percent: spendControl === null ? 100 : 10,
                    reset_at: 4102444800,
                  },
                },
                credits,
                spend_control: spendControl,
              });
            calls++;
            return Response.json({ ok: true });
          },
        },
      });
      const response = await fixture.host.harness.behavior.fetchHttp(
        "POST",
        "/v1/responses",
        { headers: authHeaders(fixture.key), body: "{}" },
      );
      expect(response.status).toBe(expected);
      await response.text();
      expect(calls).toBe(expected === 200 ? 1 : 0);
      const report = statusSchema.parse(
        await fixture.host.harness.behavior.callRpc("status.get", null),
      );
      expect(report.accounts[0]?.extraUsage?.status ?? null).toBe(
        credits === null ? null : expected === 200 ? "allowed" : "rejected",
      );
    },
  );

  it("returns Codex paid pins to recovered subscriptions and persists spending restrictions", async () => {
    let now = Date.now();
    let imports = 0;
    let includedPercent = 10;
    let spendingBlocked = false;
    const calls: string[] = [];
    const options: AccountPoolPluginOptions = {
      now: () => now,
      codexUsageUrl: "https://upstream.example/usage",
      importCodexCredentials: async () => ({
        accessToken: ++imports === 1 ? "paid" : "included",
        refreshToken: "refresh",
        expiresAt: now + 3600000,
        idToken: null,
        accountId: `codex-qa-${imports}`,
        planType: null,
        email: null,
      }),
      fetch: async (input, init) => {
        const auth = new Headers(init?.headers).get("authorization") ?? "";
        if (new URL(String(input)).pathname === "/usage")
          return Response.json({
            rate_limit: {
              primary_window: {
                used_percent: auth === "Bearer paid" ? 100 : includedPercent,
                reset_at: 4102444800,
              },
            },
            credits: {
              has_credits: auth === "Bearer paid",
              unlimited: false,
            },
          });
        calls.push(auth);
        return spendingBlocked
          ? Response.json(
              {},
              {
                status: 429,
                headers: {
                  "x-codex-rate-limit-reached-type":
                    "workspace_member_usage_limit_reached",
                },
              },
            )
          : Response.json({ ok: true });
      },
    };
    const fixture = await createFixture({
      upstreamUrl: "https://upstream.example",
      provider: "codex",
      source: "import",
      priority: 1,
      options,
    });
    const second = accountSchema.parse(
      await fixture.host.harness.behavior.callRpc("account.add", {
        provider: "codex",
        source: { kind: "import" },
        label: "Included",
        priority: 2,
      }),
    );
    let host = fixture.host;
    const send = async () => {
      const response = await host.harness.behavior.fetchHttp(
        "POST",
        "/v1/responses",
        {
          headers: {
            ...authHeaders(fixture.key),
            "session-id": "credit-session",
          },
          body: "{}",
        },
      );
      await response.text();
      return response.status;
    };
    expect(await send()).toBe(200);
    includedPercent = 100;
    await host.harness.behavior.callRpc("account.refreshUsage", {
      accountId: second.id,
    });
    expect(await send()).toBe(200);
    includedPercent = 10;
    now += 30000;
    expect(await send()).toBe(200);
    expect(calls).toEqual([
      "Bearer included",
      "Bearer paid",
      "Bearer included",
    ]);
    includedPercent = 100;
    await host.harness.behavior.callRpc("account.refreshUsage", {
      accountId: second.id,
    });
    spendingBlocked = true;
    expect(await send()).toBe(429);
    host = await host.harness.lifecycle.reload(
      createAccountPoolPlugin(options),
    );
    const service = host.harness.behavior.runService("hub");
    cleanups.push(async () => {
      service.controller.abort();
      await service.done;
      await host.harness.lifecycle.dispose();
    });
    await vi.waitFor(async () =>
      expect(
        statusSchema.parse(
          await host.harness.behavior.callRpc("status.get", null),
        ).accepting,
      ).toBe(true),
    );
    expect(await send()).toBe(429);
    expect(calls).toHaveLength(4);
    expect(
      statusSchema
        .parse(await host.harness.behavior.callRpc("status.get", null))
        .accounts.find((a) => a.id === fixture.account.id)?.usageRestriction
        ?.reason,
    ).toBe("workspace_member_usage_limit_reached");
  });

  it.each([
    [
      "enabled",
      {
        is_enabled: true,
        monthly_limit: 1000,
        used_credits: 100,
        utilization: 10,
      },
      200,
    ],
    [
      "unlimited",
      {
        is_enabled: true,
        monthly_limit: null,
        used_credits: 100,
        utilization: null,
      },
      200,
    ],
    [
      "disabled",
      { is_enabled: false, monthly_limit: 1000, used_credits: 0 },
      429,
    ],
    [
      "spent",
      { is_enabled: true, monthly_limit: 1000, used_credits: 1000 },
      429,
    ],
    ["100 percent", { is_enabled: true, utilization: 100 }, 429],
    ["unobserved", null, 429],
  ])(
    "routes exhausted Claude accounts with %s extra usage",
    async (_name, extraUsage, expectedStatus) => {
      const calls: string[] = [];
      const fixture = await createFixture({
        upstreamUrl: "https://upstream.example",
        source: "import",
        options: {
          usageUrl: "https://upstream.example/usage",
          importCredentials: async () => importedCredentials(),
          fetch: async (input) => {
            const pathname = new URL(String(input)).pathname;
            if (pathname === "/usage")
              return Response.json({
                five_hour: { utilization: 100, resets_at: "4102444800" },
                extra_usage: extraUsage,
              });
            calls.push(pathname);
            return Response.json({ ok: true });
          },
        },
      });
      const response = await fixture.host.harness.behavior.fetchHttp(
        "POST",
        "/v1/messages",
        {
          headers: authHeaders(fixture.key),
          body,
        },
      );
      expect(response.status).toBe(expectedStatus);
      await response.text();
      expect(calls).toEqual(expectedStatus === 200 ? ["/v1/messages"] : []);
      const status = await fixture.host.harness.behavior.runCli([
        "status",
        "--json",
      ]);
      expect(
        statusReportSchema.parse(JSON.parse(status.stdout)).accounts[0],
      ).toMatchObject({
        status: expectedStatus === 200 ? "ready" : "exhausted",
        extraUsage:
          extraUsage === null
            ? null
            : {
                status: expectedStatus === 200 ? "allowed" : "rejected",
                source: "usage",
              },
      });
    },
  );

  it.each(["shared", "family"])(
    "prefers subscription quota over %s extra usage and leaves paid pins on recovery",
    async (scope) => {
      let now = Date.now();
      let firstPercent = 100;
      let secondPercent = 10;
      let importCount = 0;
      const attempts: string[] = [];
      const fixture = await createFixture({
        upstreamUrl: "https://upstream.example",
        source: "import",
        priority: 1,
        options: {
          now: () => now,
          usageUrl: "https://upstream.example/usage",
          importCredentials: async () =>
            importedCredentials({
              accessToken: ++importCount === 1 ? "paid" : "included",
              accountUuid: `00000000-0000-4000-8000-${String(importCount).padStart(12, "0")}`,
            }),
          fetch: async (input, init) => {
            const key = new Headers(init?.headers).get("authorization");
            if (new URL(String(input)).pathname === "/usage")
              return Response.json({
                [scope === "shared" ? "five_hour" : "seven_day_opus"]: {
                  utilization:
                    key === "Bearer paid" ? firstPercent : secondPercent,
                  resets_at: "4102444800",
                },
                extra_usage: {
                  is_enabled: key === "Bearer paid",
                  monthly_limit: 1000,
                  used_credits: 0,
                },
              });
            attempts.push(key ?? "missing");
            return Response.json({ ok: true });
          },
        },
      });
      const second = accountSchema.parse(
        await fixture.host.harness.behavior.callRpc("account.add", {
          provider: "claude",
          source: { kind: "import" },
          label: "included",
          priority: 2,
        }),
      );
      const send = async (id: string) => {
        const response = await fixture.host.harness.behavior.fetchHttp(
          "POST",
          "/v1/messages",
          {
            headers: authHeaders(fixture.key),
            body: JSON.stringify({
              model: "claude-opus-4-1",
              metadata: { user_id: JSON.stringify({ session_id: id }) },
            }),
          },
        );
        expect(response.status).toBe(200);
        await response.text();
      };
      await send("pinned");
      secondPercent = 100;
      await fixture.host.harness.behavior.callRpc("account.refreshUsage", {
        accountId: second.id,
      });
      await send("pinned");
      await send("new-paid");
      secondPercent = 10;
      now += 30_000;
      await send("new-paid");
      await send("new-included");
      firstPercent = 0;
      await fixture.host.harness.behavior.callRpc("account.refreshUsage", {
        accountId: fixture.account.id,
      });
      await send("new-included");
      expect(attempts).toEqual([
        "Bearer included",
        "Bearer paid",
        "Bearer paid",
        "Bearer included",
        "Bearer included",
        "Bearer included",
      ]);
    },
  );

  it("learns extra usage from headers, preserves it across restart, and stops on an overage rejection", async () => {
    let rejectOverage = false;
    let upstreamCalls = 0;
    const options: AccountPoolPluginOptions = {
      usageUrl: "https://upstream.example/usage",
      importCredentials: async () => importedCredentials(),
      fetch: async (input) => {
        if (new URL(String(input)).pathname === "/usage")
          return Response.json({});
        upstreamCalls++;
        return Response.json(
          {},
          {
            status: rejectOverage ? 429 : 200,
            headers: {
              "anthropic-ratelimit-unified-5h-utilization": "1",
              "anthropic-ratelimit-unified-5h-status": "rejected",
              "anthropic-ratelimit-unified-5h-reset": "4102444800",
              "anthropic-ratelimit-unified-overage-status": rejectOverage
                ? "rejected"
                : "allowed_warning",
            },
          },
        );
      },
    };
    const fixture = await createFixture({
      upstreamUrl: "https://upstream.example",
      source: "import",
      options,
    });
    let host = fixture.host;
    const send = async () => {
      const response = await host.harness.behavior.fetchHttp(
        "POST",
        "/v1/messages",
        { headers: authHeaders(fixture.key), body },
      );
      await response.text();
      return response.status;
    };
    expect(await send()).toBe(200);
    host = await host.harness.lifecycle.reload(
      createAccountPoolPlugin(options),
    );
    const service = host.harness.behavior.runService("hub");
    cleanups.push(async () => {
      service.controller.abort();
      await service.done;
      await host.harness.lifecycle.dispose();
    });
    await vi.waitFor(async () => {
      expect(
        statusSchema.parse(
          await host.harness.behavior.callRpc("status.get", null),
        ).accepting,
      ).toBe(true);
    });
    expect(await send()).toBe(200);
    rejectOverage = true;
    expect(await send()).toBe(429);
    expect(await send()).toBe(429);
    expect(upstreamCalls).toBe(3);
  });

  it("refreshes exhausted usage before refusing a request, at most every 30 seconds per account", async () => {
    let now = Date.now();
    let usagePercent = 100;
    const calls: string[] = [];
    const fixture = await createFixture({
      upstreamUrl: "https://upstream.example",
      source: "import",
      options: {
        now: () => now,
        usageUrl: "https://upstream.example/usage",
        importCredentials: async () => importedCredentials(),
        fetch: async (input) => {
          const url = new URL(String(input));
          calls.push(url.pathname);
          if (url.pathname === "/usage")
            return Response.json({
              seven_day: {
                utilization: usagePercent,
                resets_at: String(Math.floor(now / 1_000) + 3 * 86_400),
              },
            });
          return Response.json({});
        },
      },
    });
    const send = async () => {
      const response = await fixture.host.harness.behavior.fetchHttp(
        "POST",
        "/v1/messages",
        { headers: authHeaders(fixture.key), body },
      );
      await response.text();
      return response.status;
    };
    expect(calls).toEqual(["/usage"]);
    expect(await send()).toBe(429);
    now += 30_000;
    expect(await send()).toBe(429);
    expect(await send()).toBe(429);
    usagePercent = 30;
    expect(await send()).toBe(429);
    now += 30_000;
    expect(await send()).toBe(200);
    expect(calls).toEqual(["/usage", "/usage", "/usage", "/v1/messages"]);
  });

  it("lets concurrent requests share an exhausted-usage recheck", async () => {
    let now = Date.now();
    let usagePercent = 100;
    let releaseUsage = () => {};
    const usageGate = new Promise<void>((resolve) => {
      releaseUsage = resolve;
    });
    const calls: string[] = [];
    const fixture = await createFixture({
      upstreamUrl: "https://upstream.example",
      source: "import",
      options: {
        now: () => now,
        usageUrl: "https://upstream.example/usage",
        importCredentials: async () => importedCredentials(),
        fetch: async (input) => {
          const url = new URL(String(input));
          calls.push(url.pathname);
          if (url.pathname === "/usage") {
            if (usagePercent < 100) await usageGate;
            return Response.json({
              seven_day: {
                utilization: usagePercent,
                resets_at: String(Math.floor(now / 1_000) + 3 * 86_400),
              },
            });
          }
          return Response.json({});
        },
      },
    });
    const send = async () => {
      const response = await fixture.host.harness.behavior.fetchHttp(
        "POST",
        "/v1/messages",
        { headers: authHeaders(fixture.key), body },
      );
      await response.text();
      return response.status;
    };
    usagePercent = 30;
    now += 30_000;
    const statuses = Promise.all([send(), send()]);
    await vi.waitFor(() => expect(calls).toEqual(["/usage", "/usage"]));
    await new Promise((resolve) => setTimeout(resolve, 50));
    releaseUsage();
    expect(await statuses).toEqual([200, 200]);
    expect(calls).toEqual(["/usage", "/usage", "/v1/messages", "/v1/messages"]);
  });

  it("applies reordered failover atomically without moving current conversations", async () => {
    const attempts: Array<string | null> = [];
    let rejectFirst = false;
    let rejectThird = false;
    const fixture = await createFixture({
      upstreamUrl: "https://upstream.example",
      apiKey: "sk-first",
      options: {
        fetch: async (_input, init) => {
          const key = new Headers(init?.headers).get("x-api-key");
          attempts.push(key);
          return Response.json(
            {},
            {
              status:
                (key === "sk-first" && rejectFirst) ||
                (key === "sk-third" && rejectThird)
                  ? 503
                  : 200,
            },
          );
        },
      },
    });
    const second = await addApiAccount(fixture, "sk-second");
    const third = await addApiAccount(fixture, "sk-third");
    const send = async (session: string) => {
      const response = await fixture.host.harness.behavior.fetchHttp(
        "POST",
        "/v1/messages",
        {
          headers: authHeaders(fixture.key),
          body: JSON.stringify({
            metadata: { user_id: JSON.stringify({ session_id: session }) },
          }),
        },
      );
      expect(response.status).toBe(200);
      await response.text();
    };
    await send("original");
    const reorder = await fixture.host.harness.behavior.runCli([
      "account",
      "reorder",
      "claude",
      fixture.account.id,
      third.id,
      second.id,
    ]);
    expect(reorder.exitCode).toBe(0);
    const ordered = z
      .array(accountSummarySchema)
      .parse(await fixture.host.harness.behavior.callRpc("account.list", null));
    expect(ordered.map((account) => account.id)).toEqual([
      fixture.account.id,
      third.id,
      second.id,
    ]);
    const persisted = z
      .array(accountSchema)
      .parse(await fixture.host.bb.storage.kv.get("accounts:v1"));
    expect(
      persisted.find((account) => account.id === third.id)?.priority,
    ).toBeLessThan(
      persisted.find((account) => account.id === second.id)?.priority ?? 0,
    );
    for (const accountIds of [
      [fixture.account.id],
      [fixture.account.id, third.id, third.id],
      [fixture.account.id, third.id, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"],
    ]) {
      await expect(
        fixture.host.harness.behavior.callRpc("account.reorder", {
          provider: "claude",
          accountIds,
        }),
      ).rejects.toThrow("exactly once");
    }
    expect(await fixture.host.bb.storage.kv.get("accounts:v1")).toEqual(
      persisted,
    );
    await send("new-before-failover");
    rejectFirst = true;
    await send("advance");
    rejectFirst = false;
    await send("new-after-recovery");
    rejectThird = true;
    await send("advance-again");
    expect(attempts).toEqual([
      "sk-first",
      "sk-first",
      "sk-first",
      "sk-third",
      "sk-third",
      "sk-third",
      "sk-first",
    ]);
    const negativePriority = await fixture.host.harness.behavior.runCli([
      "account",
      "priority",
      second.id,
      "-1",
    ]);
    expect(negativePriority.exitCode, negativePriority.stderr).toBe(0);
    const priority = await fixture.host.harness.behavior.runCli([
      "account",
      "priority",
      second.id,
      "0",
    ]);
    expect(priority.exitCode).toBe(0);
    expect(
      z
        .array(accountSummarySchema)
        .parse(
          await fixture.host.harness.behavior.callRpc("account.list", null),
        )[0]?.id,
    ).toBe(second.id);
  });
});

it("logs a sanitized transport cause when pooled fetch fails", async () => {
  const fixture = await createFixture({
    upstreamUrl: "https://upstream.example",
    options: {
      fetch: async () => {
        throw new TypeError("fetch failed with private request data", {
          cause: Object.assign(
            new Error("The session has been destroyed: secret-token"),
            {
              code: "ERR_HTTP2_INVALID_SESSION",
            },
          ),
        });
      },
    },
  });
  const response = await fixture.host.harness.behavior.fetchHttp(
    "POST",
    "/v1/messages",
    {
      headers: authHeaders(fixture.key),
      body: "{}",
    },
  );
  expect(response.status).toBe(502);
  expect(await response.text()).not.toContain("secret-token");
  expect(fixture.host.harness.inspection.logEntries).toContainEqual({
    level: "warn",
    message:
      "Account Pooler claude transport failed: ERR_HTTP2_INVALID_SESSION.",
  });
  expect(
    JSON.stringify(fixture.host.harness.inspection.logEntries),
  ).not.toContain("secret-token");
  expect(
    JSON.stringify(fixture.host.harness.inspection.logEntries),
  ).not.toContain("private request data");
});

it("drains a streamed response before disposing the owned transport", async () => {
  const finish = deferred();
  const upstream = await startUpstream(async (request, response) => {
    await readRequestBody(request);
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write("first");
    await finish.promise;
    response.end("last");
  });
  cleanups.push(upstream.close);
  const hooks: Array<() => void | Promise<void>> = [];
  const fixture = await createFixture({
    upstreamUrl: upstream.url,
    beforePlugin(host) {
      const register = host.bb.onDispose.bind(host.bb);
      vi.spyOn(host.bb, "onDispose").mockImplementation((hook) => {
        hooks.push(hook);
        register(hook);
      });
    },
  });
  const response = await fixture.host.harness.behavior.fetchHttp(
    "POST",
    "/v1/messages",
    {
      headers: authHeaders(fixture.key),
      body: "{}",
    },
  );
  const reader = response.body?.getReader();
  if (reader === undefined) throw new Error("Expected a stream");
  expect(new TextDecoder().decode((await reader.read()).value)).toBe("first");
  const disposeTransport = hooks[0];
  if (disposeTransport === undefined)
    throw new Error("Expected transport disposal");
  const tail = reader.read().then(
    (result) => ({
      kind: "chunk",
      text: new TextDecoder().decode(result.value),
    }),
    () => ({ kind: "error", text: "" }),
  );
  const disposing = disposeTransport();
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    finish.resolve();
    expect(await tail).toEqual({ kind: "chunk", text: "last" });
    expect((await reader.read()).done).toBe(true);
    await disposing;
  } finally {
    finish.resolve();
    await reader.cancel().catch(() => undefined);
    await disposing;
  }
});

it("publishes pooled usage without a display plugin and does not invent unobserved utilization", async () => {
  const upstream = await startUpstream((_request, response) => {
    response.end();
  });
  cleanups.push(upstream.close);
  const fixture = await createFixture({ upstreamUrl: upstream.url });
  const inventory = usageResourceListSchema.parse(
    await fixture.host.harness.behavior.callRpc(usageListMethod, {}),
  );
  expect(inventory.label).toBe("Account Pooler");
  expect(inventory.resources).toEqual([
    expect.objectContaining({
      id: fixture.account.id,
      providerId: "claude-code",
      scope: { kind: "shared" },
      accountPool: {
        active: false,
        enabled: true,
        status: "ready",
        heldUntil: null,
        error: null,
        extraUsage: null,
      },
    }),
  ]);
  const result = usageMeasurementSchema.parse(
    await fixture.host.harness.behavior.callRpc(usageFetchMethod, {
      resourceId: fixture.account.id,
      refresh: false,
    }),
  );
  expect(result).toMatchObject({
    observedAt: null,
    usage: {
      status: "error",
      message: "Usage has not been observed for this account.",
    },
  });
  expect(
    fixture.host.harness.registrations.experimental_publishedRpcMethods.map(
      (entry) => entry.method,
    ),
  ).toEqual([
    usageListMethod,
    usageFetchMethod,
    "bypass.get",
    "routing.binding.get",
    "routing.binding.next",
  ]);
});

it("publishes an empty shared usage group before any accounts or settings are configured", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "bb-empty-usage-pool-"));
  const host = createFakePluginHost({
    pluginId: "account-pool",
    dataDir,
    sdk: sdkStubs(),
  });
  const fetch = vi.fn(async () => {
    throw new Error("An empty pool must not contact an upstream");
  });
  try {
    await createAccountPoolPlugin({ fetch })(host.bb);
    expect(
      host.harness.registrations.experimental_publishedRpcMethods.map(
        (entry) => entry.method,
      ),
    ).toContain(usageListMethod);
    await expect(
      host.harness.behavior.callRpc(usageListMethod, {}),
    ).resolves.toEqual({ resources: [] });
    await expect(
      host.harness.behavior.callRpc(usageFetchMethod, {
        resourceId: "removed",
        refresh: false,
      }),
    ).rejects.toThrow("no longer exists");
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    await host.harness.lifecycle.dispose();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

it("lists every routed pool account and hides them from provider usage when routing is off", async () => {
  const upstream = await startUpstream((_request, response) => {
    response.end();
  });
  cleanups.push(upstream.close);
  const fixture = await createFixture({ upstreamUrl: upstream.url });
  const second = accountSchema.parse(
    await fixture.host.harness.behavior.callRpc("account.add", {
      provider: "claude",
      source: { kind: "api-key", apiKey: "sk-second" },
      label: "Second",
      priority: 2,
    }),
  );
  const disabled = accountSchema.parse(
    await fixture.host.harness.behavior.callRpc("account.add", {
      provider: "claude",
      source: { kind: "api-key", apiKey: "test-disabled-account-key" },
      label: "Disabled",
      priority: 3,
    }),
  );
  await fixture.host.harness.behavior.callRpc("account.disable", {
    id: disabled.id,
  });
  await fixture.host.harness.behavior.callRpc("routing.set", {
    provider: "claude",
    enabled: true,
  });
  const inventory = usageResourceListSchema.parse(
    await fixture.host.harness.behavior.callRpc(usageListMethod, {}),
  );
  expect(inventory.resources.map(({ id }) => id)).toEqual([
    second.id,
    fixture.account.id,
  ]);
  expect(inventory.resources.map(({ accountPool }) => accountPool)).toEqual([
    {
      active: false,
      enabled: true,
      status: "ready",
      heldUntil: null,
      error: null,
      extraUsage: null,
    },
    {
      active: false,
      enabled: true,
      status: "ready",
      heldUntil: null,
      error: null,
      extraUsage: null,
    },
  ]);
  await fixture.host.harness.behavior.callRpc("routing.set", {
    provider: "claude",
    enabled: false,
  });
  expect(
    usageResourceListSchema.parse(
      await fixture.host.harness.behavior.callRpc(usageListMethod, {}),
    ),
  ).toEqual({ resources: [] });
});

it("does not publish expired quota windows as current usage", async () => {
  const upstream = await startUpstream((_request, response) => {
    response.end();
  });
  cleanups.push(upstream.close);
  const fixture = await createFixture({ upstreamUrl: upstream.url });
  const now = Date.now();
  setQuota(fixture, fixture.account.id, {
    fiveHourUtilization: 0.8,
    fiveHourResetAt: now - 10 * 60 * 60 * 1_000,
    fiveHourStatus: "allowed",
    observedAt: now - 10 * 60 * 60 * 1_000,
  });
  await fixture.host.harness.behavior.callRpc("routing.set", {
    provider: "claude",
    enabled: true,
  });

  const measurement = usageMeasurementSchema.parse(
    await fixture.host.harness.behavior.callRpc(usageFetchMethod, {
      resourceId: fixture.account.id,
      refresh: false,
    }),
  );

  expect(measurement.usage).toMatchObject({
    status: "error",
    message: "Usage data is stale. Refresh usage.",
  });
});

describe("Account Pool nested proxy", () => {
  const PARENT_TOKEN = "vqMIj4xUiI3PyvKS2SllSKHsOfxLF_sAZwzNAAvV9TQ";

  interface ParentRecord {
    url: string;
    token: string | null;
    authorization: string | null;
    body: string;
  }

  async function startParent(args: {
    availability?: { claude: boolean; codex: boolean };
    availabilityStatus?: number;
  }): Promise<{ upstream: Upstream; records: ParentRecord[] }> {
    const records: ParentRecord[] = [];
    const upstream = await startUpstream(async (request, response) => {
      const body = await readRequestBody(request);
      records.push({
        url: request.url ?? "",
        token:
          (request.headers["x-bb-account-pool-token"] as string | undefined) ??
          null,
        authorization: request.headers.authorization ?? null,
        body: body.toString("utf8"),
      });
      if ((request.url ?? "").endsWith("/availability")) {
        const status = args.availabilityStatus ?? 200;
        response.writeHead(status, { "content-type": "application/json" });
        response.end(
          JSON.stringify(args.availability ?? { claude: true, codex: true }),
        );
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
    });
    return { upstream, records };
  }

  async function createChild(args: {
    parentUrl: string | null;
    parentMode?: "proxy" | "isolate";
    loopbackBaseUrl?: string;
    inheritedServerUrl?: string;
    fetch?: typeof fetch;
  }): Promise<ReturnType<typeof createFakePluginHost>> {
    const dataDir = await mkdtemp(
      path.join(tmpdir(), "bb-account-pool-child-"),
    );
    const host = createFakePluginHost({
      pluginId: "account-pool",
      dataDir,
      ...(args.loopbackBaseUrl === undefined
        ? {}
        : { loopbackBaseUrl: args.loopbackBaseUrl }),
      sdk: sdkStubs(),
    });
    let pluginInitialized = false;
    const loopbackBaseUrl = args.loopbackBaseUrl ?? "http://127.0.0.1:38886";
    Object.defineProperty(host.bb.server, "loopbackBaseUrl", {
      configurable: true,
      get: () => {
        if (!pluginInitialized) {
          throw new Error(
            "Server loopback URL read during plugin registration",
          );
        }
        return loopbackBaseUrl;
      },
    });
    if (args.parentMode !== undefined) {
      await host.bb.storage.kv.set("config", { parentMode: args.parentMode });
    }
    if (args.fetch !== undefined) {
      await host.bb.storage.kv.set("config", {
        anthropicUpstreamBaseUrl: "https://api.anthropic.test",
        codexUpstreamBaseUrl: "https://api.openai.test",
      });
    }
    await createAccountPoolPlugin({
      usageUrl: "data:application/json,{}",
      availabilityTtlMs: 0,
      ...(args.fetch === undefined ? {} : { fetch: args.fetch }),
      env:
        args.parentUrl === null
          ? {}
          : {
              BB_ACCOUNT_POOL_PARENT_URL: args.parentUrl,
              BB_ACCOUNT_POOL_PARENT_TOKEN: PARENT_TOKEN,
              ...(args.inheritedServerUrl === undefined
                ? {}
                : { BB_SERVER_URL: args.inheritedServerUrl }),
            },
    })(host.bb);
    pluginInitialized = true;
    host.harness.behavior.runService("hub");
    cleanups.push(async () => {
      await host.harness.lifecycle.dispose();
      await fs.rm(dataDir, { recursive: true, force: true });
    });
    return host;
  }

  const PROVIDER_ENV = {
    claude: ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN"],
    codex: ["CODEX_OPENAI_BASE_URL", "CODEX_POOL_AUTH_TOKEN"],
  } as const;

  function envNames(entries: Array<{ name: string }>): string[] {
    return entries.map((entry) => entry.name);
  }

  const neutralised = (provider: "claude" | "codex") =>
    PROVIDER_ENV[provider].map((name) => ({
      name,
      value: "",
      reason:
        "Account Pooler is isolated from the parent bb server's pool on this instance",
    }));

  it.each([
    {
      label: "the instance is set to isolate",
      provider: "claude" as const,
      parentMode: "isolate" as const,
      availability: undefined,
      stopParent: false,
    },
    {
      label: "the parent cannot serve the provider",
      provider: "codex" as const,
      parentMode: undefined,
      availability: { claude: true, codex: false },
      stopParent: false,
    },
    {
      label: "the parent is unreachable",
      provider: "claude" as const,
      parentMode: undefined,
      availability: undefined,
      stopParent: true,
    },
  ])("neutralises inherited routing when $label", async (args) => {
    const parent = await startParent(
      args.availability === undefined
        ? {}
        : { availability: args.availability },
    );
    if (args.stopParent) await parent.upstream.close();
    else cleanups.push(parent.upstream.close);
    const host = await createChild({
      parentUrl: parent.upstream.url,
      ...(args.parentMode === undefined ? {} : { parentMode: args.parentMode }),
    });
    await expect(
      host.harness.behavior.resolveProviderEnv(
        args.provider === "claude" ? "claude-code" : "codex",
        {
          threadId: "thread-one",
          projectId: "project-one",
          hostId: "host-one",
        },
      ),
    ).resolves.toEqual(neutralised(args.provider));
  });

  it("contributes self-pointing routing and the marker while proxying", async () => {
    const parent = await startParent({});
    cleanups.push(parent.upstream.close);
    const host = await createChild({ parentUrl: parent.upstream.url });
    const entries = await host.harness.behavior.resolveProviderEnv(
      "claude-code",
      { threadId: "thread-one", projectId: "project-one", hostId: "host-one" },
    );
    expect(envNames(entries)).toEqual([
      "ANTHROPIC_BASE_URL",
      "ANTHROPIC_AUTH_TOKEN",
      "ENABLE_TOOL_SEARCH",
      "_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL",
      "BB_ACCOUNT_POOL_PARENT_URL",
      "BB_ACCOUNT_POOL_PARENT_TOKEN",
    ]);
    expect(
      entries.find((entry) => entry.name === "ANTHROPIC_BASE_URL")?.value,
    ).toEqual({ serverPath: "/api/v1/plugins/account-pool/http" });
    expect(
      entries.find((entry) => entry.name === "ANTHROPIC_AUTH_TOKEN")?.value,
    ).not.toBe(PARENT_TOKEN);
  });

  it("proxies a pinned thread through the parent pool after switching to proxy mode", async () => {
    const parent = await startParent({});
    cleanups.push(parent.upstream.close);
    const host = await createChild({
      parentUrl: `${parent.upstream.url}/api/v1/plugins/account-pool/http`,
      parentMode: "isolate",
    });
    const account = accountSchema.parse(
      await host.harness.behavior.callRpc("account.add", {
        provider: "claude",
        source: { kind: "api-key", apiKey: "sk-local" },
        label: "Local subscription",
      }),
    );
    const configure =
      host.harness.registrations.hooks["experimental_thread.configure"];
    if (configure === null)
      throw new Error("Subscription configuration hook is missing.");
    await configure({
      thread: { id: "thread-one", providerId: "claude-code" },
      data: { provider: "claude", accountId: account.id },
    });
    await host.harness.behavior.callRpc("config.set", {
      parentMode: "proxy",
    });
    const entries = await host.harness.behavior.resolveProviderEnv(
      "claude-code",
      { threadId: "thread-one", projectId: "project-one", hostId: "host-one" },
    );
    const childToken = entries.find(
      (entry) => entry.name === "ANTHROPIC_AUTH_TOKEN",
    )?.value;
    const response = await host.harness.behavior.fetchHttp(
      "POST",
      "/v1/messages",
      {
        headers: { authorization: `Bearer ${String(childToken)}` },
        body: JSON.stringify({ model: "claude-opus-4", messages: [] }),
      },
    );

    expect(response.status).toBe(200);
    await response.text();
    expect(parent.records.at(-1)).toMatchObject({
      url: "/api/v1/plugins/account-pool/http/v1/messages",
      token: PARENT_TOKEN,
    });
  });

  it("forwards pooled traffic to the parent with the parent token", async () => {
    const parent = await startParent({});
    cleanups.push(parent.upstream.close);
    const parentPoolUrl = `${parent.upstream.url}/api/v1/plugins/account-pool/http`;
    const host = await createChild({
      parentUrl: parentPoolUrl,
      loopbackBaseUrl: "http://localhost:49999/",
      inheritedServerUrl: parent.upstream.url,
    });
    const entries = await host.harness.behavior.resolveProviderEnv(
      "claude-code",
      { threadId: "thread-one", projectId: "project-one", hostId: "host-one" },
    );
    const childToken = entries.find(
      (entry) => entry.name === "ANTHROPIC_AUTH_TOKEN",
    )?.value;
    const response = await host.harness.behavior.fetchHttp(
      "POST",
      "/v1/messages",
      {
        headers: { authorization: `Bearer ${String(childToken)}` },
        body: JSON.stringify({ model: "claude-opus-4", messages: [] }),
      },
    );
    expect(response.status).toBe(200);
    await response.text();
    const forwarded = parent.records.filter((record) =>
      record.url.endsWith("/v1/messages"),
    );
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]?.token).toBe(PARENT_TOKEN);
    expect(forwarded[0]?.authorization).toBeNull();
    expect(JSON.parse(forwarded[0]?.body ?? "{}")).toEqual({
      model: "claude-opus-4",
      messages: [],
    });
  });

  it.each([
    {
      label: "canonical URL",
      loopbackBaseUrl: "http://localhost:38886",
      parentUrl: "http://localhost:38886/api/v1/plugins/account-pool/http",
    },
    {
      label: "trailing slash and IPv4 loopback alias",
      loopbackBaseUrl: "http://localhost:38886/",
      parentUrl: "http://127.0.0.1:38886/api/v1/plugins/account-pool/http///",
    },
    {
      label: "IPv6 loopback alias",
      loopbackBaseUrl: "http://[::1]:38886/",
      parentUrl: "http://localhost:38886/api/v1/plugins/account-pool/http",
    },
    {
      label: "default HTTPS port and server path prefix",
      loopbackBaseUrl: "https://bb.example.test:443/desk/",
      parentUrl:
        "https://bb.example.test/desk/api/v1/plugins/account-pool/http/",
    },
  ])(
    "uses local account selection when parent URL is this hub ($label)",
    async ({ parentUrl, loopbackBaseUrl }) => {
      const fetchImpl = vi.fn(async (input: string | URL | Request) =>
        String(input).endsWith("/availability")
          ? Response.json({ claude: true, codex: true })
          : Response.json({ ok: true }),
      ) as unknown as typeof fetch;
      const host = await createChild({
        parentUrl,
        loopbackBaseUrl,
        fetch: fetchImpl,
      });
      await host.harness.behavior.callRpc("account.add", {
        provider: "claude",
        source: { kind: "api-key", apiKey: "synthetic-local-key" },
        label: "Local account",
        priority: 100,
      });
      const childToken = await resolveToken(host);
      const response = await host.harness.behavior.fetchHttp(
        "POST",
        "/v1/messages",
        {
          headers: { authorization: `Bearer ${childToken}` },
          body: JSON.stringify({ model: "claude-opus-4", messages: [] }),
        },
      );
      expect(response.status).toBe(200);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(String(vi.mocked(fetchImpl).mock.calls[0]?.[0])).toBe(
        "https://api.anthropic.test/v1/messages",
      );
      const init = vi.mocked(fetchImpl).mock.calls[0]?.[1];
      expect(new Headers(init?.headers).get("x-api-key")).toBe(
        "synthetic-local-key",
      );
      expect(new Headers(init?.headers).get("authorization")).toBeNull();
      expect(
        new Headers(init?.headers).get("x-bb-account-pool-token"),
      ).toBeNull();
    },
  );

  it("neutralises inherited routing for a bypassed self-parent thread", async () => {
    const host = await createChild({
      parentUrl: "http://127.0.0.1:38886/api/v1/plugins/account-pool/http",
      loopbackBaseUrl: "http://localhost:38886/",
    });
    await host.harness.behavior.callRpc("bypass.set", {
      threadId: "thread-one",
      bypassed: true,
    });
    await expect(
      host.harness.behavior.resolveProviderEnv("claude-code", {
        threadId: "thread-one",
        projectId: "project-one",
        hostId: "host-one",
      }),
    ).resolves.toEqual(neutralised("claude"));
  });

  it("rejects pooled traffic that does not present the child's own token", async () => {
    const parent = await startParent({});
    cleanups.push(parent.upstream.close);
    const host = await createChild({ parentUrl: parent.upstream.url });
    const response = await host.harness.behavior.fetchHttp(
      "POST",
      "/v1/messages",
      { headers: { authorization: `Bearer ${PARENT_TOKEN}` }, body: "{}" },
    );
    expect(response.status).toBe(401);
    expect(
      parent.records.filter((record) => record.url === "/v1/messages"),
    ).toHaveLength(0);
  });

  it("serves availability only to nested-server tokens", async () => {
    const upstream = await startUpstream(async (request, response) => {
      await readRequestBody(request);
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
    cleanups.push(upstream.close);
    const fixture = await createFixture({ upstreamUrl: upstream.url });
    const nestedToken = z.string().parse(
      (
        await fixture.host.harness.behavior.resolveProviderEnv("claude-code", {
          threadId: "thread-one",
          projectId: "project-one",
          hostId: "host-one",
        })
      ).find((entry) => entry.name === PARENT_TOKEN_ENV)?.value,
    );
    const denied = await fixture.host.harness.behavior.fetchHttp(
      "GET",
      "/availability",
      {},
    );
    expect(denied.status).toBe(401);
    const threadScoped = await fixture.host.harness.behavior.fetchHttp(
      "GET",
      "/availability",
      { headers: { "x-bb-account-pool-token": fixture.key } },
    );
    expect(threadScoped.status).toBe(401);
    const allowed = await fixture.host.harness.behavior.fetchHttp(
      "GET",
      "/availability",
      { headers: { "x-bb-account-pool-token": nestedToken } },
    );
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toEqual({ claude: true, codex: false });
  });
});

describe("Account Pool subscription sign-in repair", () => {
  const SHARED_LOGIN = {
    account: {
      uuid: "33333333-3333-4333-8333-333333333333",
      email: "shared@example.com",
      display_name: "Shared login",
      has_claude_max: true,
      rate_limit_tier: "default_claude_max_20x",
    },
  };
  const OTHER_LOGIN = {
    account: {
      uuid: "44444444-4444-4444-8444-444444444444",
      email: "other@example.com",
      display_name: "Other login",
      has_claude_max: true,
      rate_limit_tier: "default_claude_max_20x",
    },
  };

  async function claudeLoginHost(
    profile: { current: object },
    codexLogin: ImportedCodexCredentials | null = null,
  ) {
    let issued = 0;
    const oauth = await startUpstream(async (request, response) => {
      await readRequestBody(request);
      response.setHeader("content-type", "application/json");
      if (request.url === "/token") {
        issued += 1;
        response.end(
          JSON.stringify({
            access_token: `access-${issued}`,
            refresh_token: `refresh-${issued}`,
            expires_in: 3600,
          }),
        );
        return;
      }
      if (request.url === "/profile") {
        response.end(JSON.stringify(profile.current));
        return;
      }
      response.statusCode = 404;
      response.end("{}");
    });
    cleanups.push(oauth.close);
    const dataDir = await mkdtemp(path.join(tmpdir(), "bb-pool-reauth-"));
    const host = createFakePluginHost({
      pluginId: "account-pool",
      dataDir,
      sdk: sdkStubs(),
    });
    await createAccountPoolPlugin({
      oauthAuthorizeUrl: `${oauth.url}/authorize`,
      oauthTokenUrl: `${oauth.url}/token`,
      oauthProfileUrl: `${oauth.url}/profile`,
      usageUrl: "data:application/json,{}",
      importCodexCredentials: async () => {
        if (codexLogin === null)
          throw new Error("No Codex login on this test host.");
        return codexLogin;
      },
    })(host.bb);
    cleanups.push(async () => {
      await host.harness.lifecycle.dispose();
      await fs.rm(dataDir, { recursive: true, force: true });
    });
    const signIn = async (
      target: { accountId: string } | null,
      label?: string,
    ) => {
      const started = loginStartSchema.parse(
        await host.harness.behavior.callRpc("login.start", target),
      );
      const state = new URL(started.authorizeUrl).searchParams.get("state");
      return accountSchema.parse(
        await host.harness.behavior.callRpc("login.complete", {
          sessionId: started.sessionId,
          pasted: `code#${state}`,
          ...(label === undefined ? {} : { label }),
        }),
      );
    };
    const secretOf = async (id: string) =>
      accountSecretSchema.parse(
        JSON.parse(
          await fs.readFile(
            path.join(
              dataDir,
              "plugins",
              "account-pool",
              "secrets",
              "accounts",
              `account-${id}.json`,
            ),
            "utf8",
          ),
        ),
      );
    const list = async () =>
      z
        .array(accountSummarySchema)
        .parse(await host.harness.behavior.callRpc("account.list", null));
    const expire = (
      id: string,
      error = "OAuth refresh failed with HTTP 400.",
    ) => {
      const quotas = new QuotaStore(host.bb.storage.database());
      quotas.put({ ...quotas.get(id), error });
    };
    return { host, signIn, secretOf, list, expire };
  }

  async function parallelSubscriptions(profile: { current: object }) {
    const pool = await claudeLoginHost(profile);
    const principal = await pool.signIn(null, "Claude Max 20x (principal)");
    const previous = await pool.signIn(
      null,
      "Claude Max 20x (previous token, disabled)",
    );
    await pool.host.harness.behavior.callRpc("account.disable", {
      id: previous.id,
    });
    pool.expire(previous.id);
    return { ...pool, principal, previous };
  }

  it("lists both records of one login in account list and flags only the rejected one", async () => {
    const pool = await parallelSubscriptions({ current: SHARED_LOGIN });
    pool.expire(
      pool.principal.id,
      "OAuth refresh failed due to a network error or timeout.",
    );
    expect(
      (await pool.list()).map((account) => ({
        id: account.id,
        email: account.email,
        enabled: account.enabled,
        signInExpired: account.signInExpired,
      })),
    ).toEqual([
      {
        id: pool.principal.id,
        email: "shared@example.com",
        enabled: true,
        signInExpired: false,
      },
      {
        id: pool.previous.id,
        email: "shared@example.com",
        enabled: false,
        signInExpired: true,
      },
    ]);
    const listed = await pool.host.harness.behavior.runCli(["account", "list"]);
    const header = listed.stdout.split("\n")[0]?.split("\t") ?? [];
    const signInColumn = header.indexOf("Sign-in");
    expect(signInColumn).toBeGreaterThan(0);
    expect(
      listed.stdout
        .split("\n")
        .slice(1)
        .filter((row) => row.length > 0)
        .map((row) => row.split("\t")[signInColumn]),
    ).toEqual(["ok", "expired"]);
  });

  it("reports one usage subscription per login, represented by its healthy record", async () => {
    const profile = { current: SHARED_LOGIN as object };
    const pool = await parallelSubscriptions(profile);
    profile.current = OTHER_LOGIN;
    const other = await pool.signIn(null, "Claude Max 20x (other login)");
    await pool.host.harness.behavior.callRpc("account.reorder", {
      provider: "claude",
      accountIds: [pool.previous.id, pool.principal.id, other.id],
    });
    expect(
      usageResourceListSchema
        .parse(await pool.host.harness.behavior.callRpc(usageListMethod, {}))
        .resources.map(({ id }) => id),
    ).toEqual([pool.principal.id, other.id]);
    expect((await pool.list()).map((account) => account.id)).toEqual([
      pool.previous.id,
      pool.principal.id,
      other.id,
    ]);
  });

  it("keeps two organizations of one login apart and refuses a sign-in again from the other organization", async () => {
    const personal = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const team = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const profile = {
      current: {
        ...SHARED_LOGIN,
        organization: { uuid: personal, name: "Personal" },
      } as object,
    };
    const pool = await claudeLoginHost(profile);
    const first = await pool.signIn(null, "Personal seat");
    profile.current = {
      ...SHARED_LOGIN,
      organization: { uuid: team, name: "Team" },
    };
    const second = await pool.signIn(null, "Team seat");
    expect(
      (await pool.list()).map(({ id, organizationUuid }) => ({
        id,
        organizationUuid,
      })),
    ).toEqual([
      { id: first.id, organizationUuid: personal },
      { id: second.id, organizationUuid: team },
    ]);
    expect(
      usageResourceListSchema
        .parse(await pool.host.harness.behavior.callRpc(usageListMethod, {}))
        .resources.map(({ id }) => id),
    ).toEqual([first.id, second.id]);
    pool.expire(first.id);
    const before = await pool.secretOf(first.id);
    await expect(pool.signIn({ accountId: first.id })).rejects.toThrow(
      "That code belongs to a different Claude organization. Sign in to the organization behind Personal seat; it was not changed.",
    );
    expect(await pool.secretOf(first.id)).toEqual(before);
    expect((await pool.list())[0]).toMatchObject({
      id: first.id,
      organizationUuid: personal,
      signInExpired: true,
    });
  });

  it("learns each record's organization on a usage refresh and splits one login into its organizations", async () => {
    const organizations = new Map([
      ["Bearer personal-access", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"],
      ["Bearer team-access", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"],
    ]);
    const imports = ["personal-access", "team-access"];
    const dataDir = await mkdtemp(path.join(tmpdir(), "bb-pool-profile-org-"));
    const host = createFakePluginHost({
      pluginId: "account-pool",
      dataDir,
      sdk: sdkStubs(),
    });
    await createAccountPoolPlugin({
      usageUrl: "https://upstream.example/usage",
      oauthProfileUrl: "https://upstream.example/profile",
      importCredentials: async () =>
        importedCredentials({
          accessToken: imports.shift() ?? "unexpected-access",
          email: "shared@example.com",
          accountUuid: null,
        }),
      fetch: async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname === "/profile") {
          const uuid = organizations.get(
            new Headers(init?.headers).get("authorization") ?? "",
          );
          return Response.json({
            ...SHARED_LOGIN,
            ...(uuid === undefined ? {} : { organization: { uuid } }),
          });
        }
        if (url.pathname === "/usage")
          return Response.json({ seven_day: { utilization: 13 } });
        return Response.json({ ok: true });
      },
    })(host.bb);
    cleanups.push(async () => {
      await host.harness.lifecycle.dispose();
      await fs.rm(dataDir, { recursive: true, force: true });
    });
    for (const label of ["Personal seat", "Team seat"])
      await host.harness.behavior.callRpc("account.add", {
        provider: "claude",
        source: { kind: "import" },
        label,
        priority: 100,
      });
    const list = async () =>
      z
        .array(accountSummarySchema)
        .parse(await host.harness.behavior.callRpc("account.list", null));
    for (const { id } of await list())
      await host.harness.behavior.callRpc("account.refreshUsage", {
        accountId: id,
      });
    const accounts = await list();
    expect(
      accounts.map(({ label, accountUuid, organizationUuid }) => ({
        label,
        accountUuid,
        organizationUuid,
      })),
    ).toEqual([
      {
        label: "Personal seat",
        accountUuid: SHARED_LOGIN.account.uuid,
        organizationUuid: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      },
      {
        label: "Team seat",
        accountUuid: SHARED_LOGIN.account.uuid,
        organizationUuid: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      },
    ]);
    expect(
      usageResourceListSchema
        .parse(await host.harness.behavior.callRpc(usageListMethod, {}))
        .resources.map(({ id }) => id),
    ).toEqual(accounts.map(({ id }) => id));
  });

  it("turns a subscription off in one write and leaves its disabled record untouched", async () => {
    const profile = { current: SHARED_LOGIN as object };
    const pool = await parallelSubscriptions(profile);
    const twin = await pool.signIn(null, "Claude Max 20x (twin)");
    profile.current = OTHER_LOGIN;
    const other = await pool.signIn(null, "Claude Max 20x (other login)");
    const protectedBefore = (await pool.list()).find(
      ({ id }) => id === pool.previous.id,
    );
    const protectedSecret = await pool.secretOf(pool.previous.id);
    expect(protectedBefore).toMatchObject({
      enabled: false,
      signInExpired: true,
    });

    const result = z
      .object({ accounts: z.array(accountSchema).nullable() })
      .parse(
        await pool.host.harness.behavior.callRpc(
          "account.disableSubscription",
          { id: pool.principal.id },
        ),
      );

    expect(result.accounts?.map(({ id }) => id)).toEqual([
      pool.principal.id,
      twin.id,
    ]);
    const after = await pool.list();
    expect(after.find(({ id }) => id === pool.previous.id)).toEqual(
      protectedBefore,
    );
    expect(await pool.secretOf(pool.previous.id)).toEqual(protectedSecret);
    expect(after.map(({ id, enabled }) => ({ id, enabled }))).toEqual([
      { id: pool.principal.id, enabled: false },
      { id: pool.previous.id, enabled: false },
      { id: twin.id, enabled: false },
      { id: other.id, enabled: true },
    ]);
    expect(
      await pool.host.harness.behavior.callRpc("account.disableSubscription", {
        id: "99999999-9999-4999-8999-999999999999",
      }),
    ).toEqual({ accounts: null });

    const byCli = await pool.host.harness.behavior.runCli([
      "account",
      "disable",
      other.id,
      "--subscription",
      "--json",
    ]);
    expect(byCli.exitCode).toBe(0);
    expect(
      z
        .object({ accounts: z.array(accountSchema) })
        .parse(JSON.parse(byCli.stdout))
        .accounts.map(({ id, enabled }) => ({ id, enabled })),
    ).toEqual([{ id: other.id, enabled: false }]);
    const again = await pool.host.harness.behavior.runCli([
      "account",
      "disable",
      other.id,
      "--subscription",
    ]);
    expect(again.stdout).toBe(
      `No record of the subscription of ${other.id} was enabled.\n`,
    );
    expect(
      (await pool.list()).find(({ id }) => id === pool.previous.id),
    ).toEqual(protectedBefore);
  });

  it("refuses a stale subscription turn off that would disable a record it never named", async () => {
    const profile = { current: SHARED_LOGIN as object };
    const pool = await parallelSubscriptions(profile);
    const twin = await pool.signIn(null, "Claude Max 20x (twin)");
    const named = [pool.principal.id, twin.id];
    await pool.host.harness.behavior.callRpc("account.enable", {
      id: pool.previous.id,
    });
    const enabled = async () =>
      (await pool.list()).map(({ id, enabled }) => ({ id, enabled }));
    const before = await enabled();
    expect(before).toEqual([
      { id: pool.principal.id, enabled: true },
      { id: pool.previous.id, enabled: true },
      { id: twin.id, enabled: true },
    ]);

    await expect(
      pool.host.harness.behavior.callRpc("account.disableSubscription", {
        id: pool.principal.id,
        expectedIds: named,
      }),
    ).rejects.toThrow(
      "The records of this subscription changed. Review the updated list; nothing was turned off.",
    );
    expect(await enabled()).toEqual(before);

    const confirmed = z
      .object({ accounts: z.array(accountSchema).nullable() })
      .parse(
        await pool.host.harness.behavior.callRpc(
          "account.disableSubscription",
          {
            id: pool.principal.id,
            expectedIds: [twin.id, pool.previous.id, pool.principal.id],
          },
        ),
      );
    expect(confirmed.accounts?.map(({ id }) => id)).toEqual([
      pool.principal.id,
      pool.previous.id,
      twin.id,
    ]);
  });

  it("refuses a subscription turn off whose records change while it waits for the store, with no storage write", async () => {
    const pool = await parallelSubscriptions({ current: SHARED_LOGIN });
    const twin = await pool.signIn(null, "Claude Max 20x (twin)");
    const named = [pool.principal.id, twin.id];
    const kv = pool.host.bb.storage.kv;
    const get = kv.get.bind(kv);
    const set = kv.set.bind(kv);
    const remove = kv.delete.bind(kv);
    const log: string[] = [];
    let holdNextAccountsWrite = false;
    let held = () => {};
    let release = () => {};
    const writeHeld = new Promise<void>((resolve) => {
      held = resolve;
    });
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    kv.get = <T>(key: string): Promise<T | undefined> => {
      log.push(`get ${key}`);
      return get<T>(key);
    };
    kv.set = async (key, value) => {
      log.push(`set ${key}`);
      if (key === "accounts:v1" && holdNextAccountsWrite) {
        holdNextAccountsWrite = false;
        held();
        await barrier;
        await set(key, value);
        log.push(`committed ${key}`);
        return;
      }
      await set(key, value);
    };
    kv.delete = async (key) => {
      log.push(`delete ${key}`);
      await remove(key);
    };
    type Locked = {
      mutationLock: Promise<void> | null;
      serialized(action: () => Promise<unknown>): Promise<unknown>;
    };
    const store = AccountStore.prototype as unknown as Locked;
    const serialized = store.serialized;
    let instance: Locked | null = null;
    let holding: Promise<void> | null = null;
    const queue = vi.spyOn(store, "serialized").mockImplementation(function (
      this: Locked,
      action: () => Promise<unknown>,
    ) {
      instance = this;
      const before = this.mutationLock;
      const pending = serialized.call(this, action);
      const registered =
        this.mutationLock !== null && this.mutationLock !== before;
      log.push(
        !registered
          ? "lock not registered"
          : before === null
            ? "lock taken"
            : before === holding
              ? "queued behind held write"
              : "queued behind another call",
      );
      return pending;
    });
    cleanups.push(async () => queue.mockRestore());

    holdNextAccountsWrite = true;
    const enabling = pool.host.harness.behavior.callRpc("account.enable", {
      id: pool.previous.id,
    });
    await writeHeld;
    expect(log.at(-1)).toBe("set accounts:v1");
    expect(log).toContain("lock taken");
    holding = (instance as Locked | null)?.mutationLock ?? null;
    expect(holding).not.toBeNull();
    const contestedFrom = log.length;
    let settledAt = -1;
    const turningOff = pool.host.harness.behavior
      .callRpc("account.disableSubscription", {
        id: pool.principal.id,
        expectedIds: named,
      })
      .then(
        () => {
          settledAt = log.length;
          return "turned off";
        },
        (error: unknown) => {
          settledAt = log.length;
          return error instanceof Error ? error.message : String(error);
        },
      );
    for (let turn = 0; turn < 100 && log.length === contestedFrom; turn += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(log.slice(contestedFrom)).toEqual(["queued behind held write"]);
    for (let turn = 0; turn < 5; turn += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(settledAt).toBe(-1);
    expect(log.slice(contestedFrom)).toEqual(["queued behind held write"]);

    release();
    await enabling;
    expect(await turningOff).toBe(
      "The records of this subscription changed. Review the updated list; nothing was turned off.",
    );
    const committed = log.indexOf("committed accounts:v1");
    expect(committed).toBeGreaterThan(contestedFrom);
    const checked = log.slice(committed, settledAt);
    expect(checked).toContain("get accounts:v1");
    expect(
      checked.filter(
        (entry) => entry.startsWith("set ") || entry.startsWith("delete "),
      ),
    ).toEqual([]);
    expect(log.filter((entry) => entry === "set accounts:v1")).toHaveLength(1);
    expect(
      (await pool.list()).map(({ id, enabled }) => ({ id, enabled })),
    ).toEqual([
      { id: pool.principal.id, enabled: true },
      { id: pool.previous.id, enabled: true },
      { id: twin.id, enabled: true },
    ]);
  });

  it("stores the organization of an imported Claude login", async () => {
    const personal = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const dataDir = await mkdtemp(path.join(tmpdir(), "bb-pool-import-org-"));
    const host = createFakePluginHost({
      pluginId: "account-pool",
      dataDir,
      sdk: sdkStubs(),
    });
    await createAccountPoolPlugin({
      usageUrl: "data:application/json,{}",
      importCredentials: async () =>
        importedCredentials({ organizationUuid: personal }),
    })(host.bb);
    cleanups.push(async () => {
      await host.harness.lifecycle.dispose();
      await fs.rm(dataDir, { recursive: true, force: true });
    });
    await host.harness.behavior.callRpc("account.add", {
      provider: "claude",
      source: { kind: "import" },
      label: null,
      priority: 100,
    });
    expect(
      z
        .array(accountSummarySchema)
        .parse(await host.harness.behavior.callRpc("account.list", null))
        .map(({ organizationUuid }) => organizationUuid),
    ).toEqual([personal]);
  });

  it("stores the organization of a sign-in again on a record that had none", async () => {
    const personal = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const profile = { current: SHARED_LOGIN as object };
    const pool = await parallelSubscriptions(profile);
    profile.current = {
      ...SHARED_LOGIN,
      organization: { uuid: personal },
    };
    await pool.signIn({ accountId: pool.previous.id });
    expect(
      (await pool.list()).map(({ id, organizationUuid }) => ({
        id,
        organizationUuid,
      })),
    ).toEqual([
      { id: pool.principal.id, organizationUuid: null },
      { id: pool.previous.id, organizationUuid: personal },
    ]);
  });

  it("signs in again to an expired Claude subscription in place", async () => {
    const pool = await parallelSubscriptions({ current: SHARED_LOGIN });
    const before = await pool.secretOf(pool.previous.id);
    const repaired = await pool.signIn({ accountId: pool.previous.id });
    expect(repaired).toMatchObject({
      id: pool.previous.id,
      label: "Claude Max 20x (previous token, disabled)",
      priority: pool.previous.priority,
      enabled: false,
      rateLimitTier: "default_claude_max_20x",
    });
    const after = await pool.secretOf(pool.previous.id);
    expect(after.kind === "oauth" && after.refreshToken).not.toBe(
      before.kind === "oauth" && before.refreshToken,
    );
    const listed = await pool.list();
    expect(listed.map((account) => account.id)).toEqual([
      pool.principal.id,
      pool.previous.id,
    ]);
    expect(listed[1]).toMatchObject({ signInExpired: false, error: null });
    expect(pool.host.harness.inspection.realtimeSignals).toContainEqual({
      channel: "accounts-changed",
      payload: {},
    });
  });

  it("refuses a sign-in again from a different Claude account and leaves the subscription unchanged", async () => {
    const profile = { current: SHARED_LOGIN as object };
    const pool = await parallelSubscriptions(profile);
    const before = await pool.secretOf(pool.previous.id);
    profile.current = OTHER_LOGIN;
    await expect(pool.signIn({ accountId: pool.previous.id })).rejects.toThrow(
      "That code belongs to a different Claude account. Sign in as the account behind Claude Max 20x (previous token, disabled); it was not changed.",
    );
    expect(await pool.secretOf(pool.previous.id)).toEqual(before);
    const listed = await pool.list();
    expect(listed).toHaveLength(2);
    expect(listed[1]).toMatchObject({
      id: pool.previous.id,
      email: "shared@example.com",
      signInExpired: true,
    });
  });

  it("refuses a sign-in again whose Claude account can't be identified and leaves the subscription unchanged", async () => {
    const anonymous = {
      account: {
        display_name: "No identity",
        has_claude_max: true,
        rate_limit_tier: "default_claude_max_20x",
      },
    };
    const profile = { current: anonymous as object };
    const pool = await claudeLoginHost(profile);
    const unknown = await pool.signIn(null, "Claude Max 20x (no identity)");
    expect(unknown).toMatchObject({ email: null, accountUuid: null });
    pool.expire(unknown.id);
    const unknownBefore = await pool.secretOf(unknown.id);
    await expect(pool.signIn({ accountId: unknown.id })).rejects.toThrow(
      "bb couldn't confirm that this sign-in is the account behind Claude Max 20x (no identity); it was not changed. Try again, or remove it and add the login again.",
    );
    expect(await pool.secretOf(unknown.id)).toEqual(unknownBefore);
    profile.current = SHARED_LOGIN;
    await expect(pool.signIn({ accountId: unknown.id })).rejects.toThrow(
      "bb couldn't confirm that this sign-in is the account behind Claude Max 20x (no identity); it was not changed.",
    );
    const known = await pool.signIn(null, "Claude Max 20x (shared)");
    pool.expire(known.id);
    const knownBefore = await pool.secretOf(known.id);
    profile.current = anonymous;
    await expect(pool.signIn({ accountId: known.id })).rejects.toThrow(
      "bb couldn't confirm that this sign-in is the account behind Claude Max 20x (shared); it was not changed.",
    );
    expect(await pool.secretOf(unknown.id)).toEqual(unknownBefore);
    expect(await pool.secretOf(known.id)).toEqual(knownBefore);
    expect(await pool.list()).toMatchObject([
      { id: unknown.id, email: null, signInExpired: true },
      { id: known.id, email: "shared@example.com", signInExpired: true },
    ]);
  });

  it("refuses to start a sign-in again for a missing, API key, or other-provider subscription", async () => {
    const pool = await claudeLoginHost({ current: SHARED_LOGIN });
    const key = accountSchema.parse(
      await pool.host.harness.behavior.callRpc("account.add", {
        provider: "claude",
        source: { kind: "api-key", apiKey: "sk-test" },
        label: "Metered",
      }),
    );
    const subscription = await pool.signIn(null);
    await expect(
      pool.host.harness.behavior.callRpc("login.start", {
        accountId: "55555555-5555-4555-8555-555555555555",
      }),
    ).rejects.toThrow(/no longer exists/u);
    await expect(
      pool.host.harness.behavior.callRpc("login.start", { accountId: key.id }),
    ).rejects.toThrow(/API key/u);
    await expect(
      pool.host.harness.behavior.callRpc("codexLogin.start", {
        accountId: subscription.id,
      }),
    ).rejects.toThrow(/belongs to Claude/u);
  });

  it("signs in again from the CLI and says so", async () => {
    const pool = await parallelSubscriptions({ current: SHARED_LOGIN });
    const started = await pool.host.harness.behavior.runCli([
      "account",
      "sign-in-again",
      pool.previous.id,
    ]);
    expect(started.exitCode).toBe(0);
    expect(started.stdout).toContain(
      "Open this URL to sign in to Claude as the account behind Claude Max 20x (previous token, disabled):",
    );
    const sessionId = started.stdout.match(/Session ID: ([0-9a-f-]+)/u)?.[1];
    const authorizeUrl = started.stdout.match(/\n(http[^\n]+)\n/u)?.[1];
    if (sessionId === undefined || authorizeUrl === undefined)
      throw new Error("Sign in again did not print its session and URL.");
    const state = new URL(authorizeUrl).searchParams.get("state");
    const completed = await pool.host.harness.behavior.runCli(
      ["account", "login-complete", "--session", sessionId, "--code-stdin"],
      { experimental_stdinInputs: { code: `code#${state}` } },
    );
    expect(completed).toMatchObject({
      exitCode: 0,
      stdout: `Signed in again to Claude Max 20x (previous token, disabled) (${pool.previous.id}).\n`,
    });
    expect((await pool.list()).map((account) => account.signInExpired)).toEqual(
      [false, false],
    );
  });

  it("signs in again to an expired Codex subscription only as the same ChatGPT account", async () => {
    const identity = { accountId: "chatgpt-account-1" };
    let now = 1_800_000_000_000;
    const auth = await startUpstream(async (request, response) => {
      await readRequestBody(request);
      response.setHeader("content-type", "application/json");
      if (request.url === "/api/accounts/deviceauth/usercode") {
        response.end(
          JSON.stringify({
            device_auth_id: "device",
            user_code: "ABCD-1234",
            interval: "1",
            expires_in: 600,
          }),
        );
        return;
      }
      if (request.url === "/api/accounts/deviceauth/token") {
        response.end(
          JSON.stringify({
            authorization_code: "authorization",
            code_challenge: "challenge",
            code_verifier: "verifier",
          }),
        );
        return;
      }
      if (request.url === "/oauth/token") {
        response.end(
          JSON.stringify({
            access_token: testJwt({ exp: 2_000_000_000 }),
            refresh_token: `refresh-${identity.accountId}`,
            id_token: testJwt({
              email: "codex@example.com",
              "https://api.openai.com/auth": {
                chatgpt_account_id: identity.accountId,
              },
            }),
          }),
        );
        return;
      }
      response.statusCode = 404;
      response.end("{}");
    });
    cleanups.push(auth.close);
    const dataDir = await mkdtemp(path.join(tmpdir(), "bb-pool-codex-reauth-"));
    const host = createFakePluginHost({
      pluginId: "account-pool",
      dataDir,
      sdk: sdkStubs(),
    });
    await createAccountPoolPlugin({
      now: () => now,
      codexAuthBaseUrl: auth.url,
      codexUsageUrl: EMPTY_USAGE_URL,
      usageUrl: "data:application/json,{}",
    })(host.bb);
    cleanups.push(async () => {
      await host.harness.lifecycle.dispose();
      await fs.rm(dataDir, { recursive: true, force: true });
    });
    const signIn = async (target: { accountId: string } | null) => {
      const started = codexLoginStartSchema.parse(
        await host.harness.behavior.callRpc("codexLogin.start", target),
      );
      expect(
        await host.harness.behavior.callRpc("codexLogin.poll", {
          sessionId: started.sessionId,
        }),
      ).toEqual({ status: "pending" });
      now += started.intervalMs;
      return codexLoginPollSchema.parse(
        await host.harness.behavior.callRpc("codexLogin.poll", {
          sessionId: started.sessionId,
        }),
      );
    };
    const added = await signIn(null);
    if (added.status !== "complete") throw new Error("Codex login failed.");
    const quotas = new QuotaStore(host.bb.storage.database());
    quotas.put({
      ...quotas.get(added.account.id),
      error: "OAuth refresh failed with HTTP 401.",
    });
    identity.accountId = "chatgpt-account-2";
    expect(await signIn({ accountId: added.account.id })).toEqual({
      status: "error",
      message: `Codex sign-in belongs to a different ChatGPT account. Sign in as the account behind ${added.account.label}; it was not changed. Start again.`,
    });
    identity.accountId = "chatgpt-account-1";
    expect(await signIn({ accountId: added.account.id })).toMatchObject({
      status: "complete",
      account: {
        id: added.account.id,
        codexAccountId: "chatgpt-account-1",
        signInExpired: false,
        error: null,
      },
    });
    const listed = z
      .array(accountSummarySchema)
      .parse(await host.harness.behavior.callRpc("account.list", null));
    expect(listed.map((account) => account.id)).toEqual([added.account.id]);
  });

  it("lists this Mac's own logins that are not in the pool", async () => {
    const pool = await claudeLoginHost(
      { current: SHARED_LOGIN },
      {
        accessToken: "codex-access",
        refreshToken: "codex-refresh",
        idToken: null,
        accountId: "chatgpt-account",
        email: "codex@example.com",
        expiresAt: null,
        planType: "pro",
      },
    );
    await pool.signIn(null);
    pool.host.harness.sdk.stub("system.providerStates", async (input) => {
      expect(input).toEqual({});
      return {
        providers: [
          {
            providerId: "claude-code",
            displayName: "Claude Code",
            status: "ready",
            accountEmail: "Shared@Example.com",
            planLabel: "Max (20x)",
          },
          {
            providerId: "codex",
            displayName: "Codex",
            status: "ready",
            accountEmail: "codex@example.com",
            planLabel: null,
          },
          {
            providerId: "acp-cursor",
            displayName: "Cursor",
            status: "expired",
            accountEmail: "cursor@example.com",
            planLabel: "Pro",
          },
          {
            providerId: "pi",
            displayName: "Pi",
            status: "ready",
            accountEmail: null,
            planLabel: null,
          },
          {
            providerId: "acp-gemini",
            displayName: "Gemini",
            status: "unauthenticated",
            accountEmail: "gemini@example.com",
            planLabel: null,
          },
        ],
      };
    });
    const logins = z
      .array(localLoginSchema)
      .parse(await pool.host.harness.behavior.callRpc("local.logins", null));
    expect(logins).toEqual([
      {
        providerId: "codex",
        displayName: "Codex",
        email: "codex@example.com",
        planLabel: "ChatGPT Pro",
        status: "ready",
        poolProvider: "codex",
      },
      {
        providerId: "acp-cursor",
        displayName: "Cursor",
        email: "cursor@example.com",
        planLabel: "Pro",
        status: "expired",
        poolProvider: null,
      },
    ]);
    const cli = await pool.host.harness.behavior.runCli(["account", "local"]);
    expect(cli.exitCode).toBe(0);
    expect(cli.stdout).toContain("pool account add --provider codex --import");
    expect(cli.stdout).toContain(
      "Codex\tChatGPT Pro\tready\tcodex@example.com",
    );
    expect(cli.stdout).toContain(
      "Cursor\tPro\texpired\tcursor@example.com\tcan't be pooled",
    );
    pool.host.harness.sdk.stub("system.providerStates", async () => ({
      providers: [
        {
          providerId: "codex",
          displayName: "Codex",
          status: "ready",
          accountEmail: "other.codex@example.com",
          planLabel: null,
        },
      ],
    }));
    expect(
      z
        .array(localLoginSchema)
        .parse(await pool.host.harness.behavior.callRpc("local.logins", null)),
    ).toEqual([
      {
        providerId: "codex",
        displayName: "Codex",
        email: "other.codex@example.com",
        planLabel: null,
        status: "ready",
        poolProvider: "codex",
      },
    ]);
  });
});

describe("Account Pool credential scoping", () => {
  const POOL_SECRETS = ["plugins", "account-pool", "secrets", "accounts"];
  const HUB_ROUTES = [
    "/v1/messages",
    "/v1/messages/count_tokens",
    "/v1/responses",
    "/v1/images/generations",
    "/v1/images/edits",
    "/v1/alpha/search",
    "/v1/models",
    "/availability",
  ];

  async function scopedFixture(
    options?: AccountPoolPluginOptions,
  ): Promise<Fixture> {
    const upstream = await startUpstream(async (request, response) => {
      await readRequestBody(request);
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
    cleanups.push(upstream.close);
    const fixture = await createFixture({
      upstreamUrl: upstream.url,
      options: {
        codexUsageUrl: EMPTY_USAGE_URL,
        importCodexCredentials: async () => ({
          accessToken: "codex-access",
          refreshToken: "codex-refresh",
          idToken: null,
          accountId: "codex-account",
          planType: null,
          email: null,
          expiresAt: Date.now() + 60 * 60 * 1_000,
        }),
        ...options,
      },
    });
    await fixture.host.harness.behavior.callRpc("account.add", {
      provider: "codex",
      source: { kind: "import" },
      label: null,
      priority: 100,
    });
    return fixture;
  }

  async function envToken(
    host: Fixture["host"],
    providerId: "claude-code" | "codex",
    name: string,
    threadId = "thread-one",
    hostId = "host-one",
  ): Promise<string> {
    const entries = await host.harness.behavior.resolveProviderEnv(providerId, {
      threadId,
      projectId: "project-one",
      hostId,
    });
    const entry = entries.find((candidate) => candidate.name === name);
    if (entry === undefined || typeof entry.value !== "string") {
      throw new Error(`${name} was not resolved.`);
    }
    return entry.value;
  }

  const claudeToken = (
    host: Fixture["host"],
    threadId?: string,
    hostId?: string,
  ) => envToken(host, "claude-code", "ANTHROPIC_AUTH_TOKEN", threadId, hostId);
  const nestedToken = (
    host: Fixture["host"],
    threadId?: string,
    hostId?: string,
  ) => envToken(host, "claude-code", PARENT_TOKEN_ENV, threadId, hostId);

  async function readHostToken(
    fixture: Fixture,
    hostId = "host-one",
  ): Promise<string> {
    const file = path.join(
      fixture.dataDir,
      ...POOL_SECRETS,
      `hub-token-${hostId}.json`,
    );
    return z
      .object({ value: z.string() })
      .parse(JSON.parse(await fs.readFile(file, "utf8"))).value;
  }

  async function statusOf(
    host: Fixture["host"],
    token: string,
    route: string,
    via: "bearer" | "header" = "bearer",
  ): Promise<number> {
    const read = route === "/availability" || route === "/v1/models";
    const response = await host.harness.behavior.fetchHttp(
      read ? "GET" : "POST",
      route,
      {
        headers:
          via === "bearer"
            ? authHeaders(token)
            : {
                "x-bb-account-pool-token": token,
                "content-type": "application/json",
              },
        ...(read ? {} : { body: "{}" }),
      },
    );
    await response.text();
    return response.status;
  }

  it("never exports the machine token and rejects it on every hub route", async () => {
    const fixture = await scopedFixture();
    const hostToken = await readHostToken(fixture);
    const nested = await nestedToken(fixture.host);
    const exported = JSON.stringify([
      await fixture.host.harness.behavior.resolveProviderEnv("claude-code", {
        threadId: "thread-one",
        projectId: "project-one",
        hostId: "host-one",
      }),
      await fixture.host.harness.behavior.resolveProviderEnv("codex", {
        threadId: "thread-codex",
        projectId: "project-one",
        hostId: "host-one",
      }),
    ]);
    expect(exported).toContain(PARENT_TOKEN_ENV);
    expect(exported).toContain("CODEX_POOL_AUTH_TOKEN");
    expect(exported).not.toContain(hostToken);
    expect(nested).not.toBe(hostToken);
    for (const via of ["bearer", "header"] as const) {
      for (const route of HUB_ROUTES) {
        expect(await statusOf(fixture.host, hostToken, route, via)).toBe(401);
        expect(await statusOf(fixture.host, nested, route, via)).not.toBe(401);
      }
    }
  });

  it("accepts each credential only on the routes it is scoped to", async () => {
    const fixture = await scopedFixture();
    const claude = fixture.key;
    const codex = await envToken(
      fixture.host,
      "codex",
      "CODEX_POOL_AUTH_TOKEN",
      "thread-codex",
    );
    const nested = await nestedToken(fixture.host);
    expect(new Set([claude, codex, nested]).size).toBe(3);
    expect(
      await envToken(fixture.host, "codex", PARENT_TOKEN_ENV, "thread-one"),
    ).toBe(nested);
    const matrix: Array<[string, string, string, number]> = [
      ["claude", claude, "/v1/messages", 200],
      ["claude", claude, "/v1/responses", 401],
      ["claude", claude, "/availability", 401],
      ["codex", codex, "/v1/responses", 200],
      ["codex", codex, "/v1/messages", 401],
      ["codex", codex, "/availability", 401],
      ["nested", nested, "/v1/messages", 200],
      ["nested", nested, "/v1/responses", 200],
      ["nested", nested, "/availability", 200],
    ];
    for (const [kind, token, route, expected] of matrix) {
      expect([kind, route, await statusOf(fixture.host, token, route)]).toEqual(
        [kind, route, expected],
      );
    }
  });

  it("keeps nested traffic attributed to the machine and thread traffic to its thread", async () => {
    const fixture = await scopedFixture();
    const nested = await nestedToken(fixture.host);
    const body = (id: string) =>
      JSON.stringify({
        model: "claude-fable-5",
        metadata: {
          user_id: JSON.stringify({
            account_uuid: "invalid-account-uuid",
            device_id: "device",
            parent_session_id: "parent",
            session_id: id,
          }),
        },
      });
    for (const [token, id] of [
      [nested, "nested-session"],
      [fixture.key, "thread-session"],
    ] as const) {
      const response = await fixture.host.harness.behavior.fetchHttp(
        "POST",
        "/v1/messages",
        {
          headers: { ...authHeaders(token), "session-id": id },
          body: body(id),
        },
      );
      expect(response.status).toBe(200);
      await response.text();
    }
    const keys = [
      ...new PoolAffinityStore(fixture.host.bb.storage.database())
        .loadBindings(0, 100)
        .keys(),
    ].map((key) => z.array(z.string()).parse(JSON.parse(key)));
    expect(keys).toEqual([
      ["claude", "host-one", "session:nested-session"],
      ["claude", "host-one", "thread-one", "session:thread-session"],
    ]);
    const status = statusSchema.parse(
      await fixture.host.harness.behavior.callRpc("status.get", null),
    );
    expect(
      status.accounts.find((account) => account.provider === "claude")
        ?.lastUsedHostId,
    ).toBe("host-one");
  });

  it("revokes thread and nested tokens with their machine token generation", async () => {
    let now = 1_000;
    const fixture = await scopedFixture({ now: () => now });
    const { host } = fixture;
    const claude = fixture.key;
    const nested = await nestedToken(host);
    const otherHost = await claudeToken(host, "thread-two", "host-two");
    now = 2_000;
    const rotate = await host.harness.behavior.runCli([
      "token",
      "rotate",
      "--machine",
      "One",
    ]);
    expect(rotate.exitCode).toBe(0);
    now += 9 * 60_000;
    expect(await statusOf(host, claude, "/v1/messages")).toBe(200);
    expect(await statusOf(host, nested, "/v1/messages")).toBe(200);
    expect(await statusOf(host, nested, "/availability")).toBe(200);
    now = 2_000 + 10 * 60_000 + 1;
    expect(await statusOf(host, claude, "/v1/messages")).toBe(401);
    expect(await statusOf(host, nested, "/v1/messages")).toBe(401);
    expect(await statusOf(host, nested, "/availability")).toBe(401);
    const nextClaude = await claudeToken(host);
    const nextNested = await nestedToken(host);
    expect(nextClaude).not.toBe(claude);
    expect(nextNested).not.toBe(nested);
    expect(await statusOf(host, nextClaude, "/v1/messages")).toBe(200);
    expect(await statusOf(host, nextNested, "/availability")).toBe(200);
    expect(await statusOf(host, otherHost, "/v1/messages")).toBe(200);
  });

  it("revokes on archive and delete and issues fresh tokens on the next env resolution", async () => {
    const fixture = await scopedFixture();
    const { host } = fixture;
    const archive = (event: "thread.archived" | "thread.deleted") =>
      host.harness.behavior.emitThreadEvent(event, {
        thread: makeThreadResponse({ id: "thread-one" }),
      });
    const claude = fixture.key;
    const nested = await nestedToken(host);
    const sibling = await claudeToken(host, "thread-two");
    await host.harness.behavior.callRpc("bypass.set", {
      threadId: "thread-one",
      bypassed: true,
    });
    expect(await archive("thread.archived")).toEqual({ errors: [] });
    expect(await statusOf(host, claude, "/v1/messages")).toBe(401);
    expect(await statusOf(host, nested, "/availability")).toBe(401);
    expect(await statusOf(host, sibling, "/v1/messages")).toBe(200);
    await expect(
      host.harness.behavior.callRpc("bypass.get", { threadId: "thread-one" }),
    ).resolves.toEqual({ threadId: "thread-one", bypassed: true });
    await host.harness.behavior.callRpc("bypass.set", {
      threadId: "thread-one",
      bypassed: false,
    });
    const reissued = await claudeToken(host);
    const reissuedNested = await nestedToken(host);
    expect(reissued).not.toBe(claude);
    expect(reissuedNested).not.toBe(nested);
    expect(await statusOf(host, reissued, "/v1/messages")).toBe(200);
    expect(await statusOf(host, reissuedNested, "/availability")).toBe(200);
    await host.harness.behavior.callRpc("bypass.set", {
      threadId: "thread-one",
      bypassed: true,
    });
    expect(await archive("thread.deleted")).toEqual({ errors: [] });
    expect(await statusOf(host, reissued, "/v1/messages")).toBe(401);
    expect(await statusOf(host, reissuedNested, "/availability")).toBe(401);
    await expect(
      host.harness.behavior.callRpc("bypass.get", { threadId: "thread-one" }),
    ).resolves.toEqual({ threadId: "thread-one", bypassed: false });
  });

  it("keeps valid tokens valid and revoked tokens revoked across a plugin restart", async () => {
    const fixture = await scopedFixture();
    const claude = fixture.key;
    const nested = await nestedToken(fixture.host);
    const revoked = await claudeToken(fixture.host, "thread-gone");
    const revokedNested = await nestedToken(fixture.host, "thread-gone");
    await fixture.host.harness.behavior.emitThreadEvent("thread.archived", {
      thread: makeThreadResponse({ id: "thread-gone" }),
    });
    const host = await fixture.host.harness.lifecycle.reload(
      createAccountPoolPlugin({
        usageUrl: EMPTY_USAGE_URL,
        codexUsageUrl: EMPTY_USAGE_URL,
        importCodexCredentials: async () => ({
          accessToken: "codex-access",
          refreshToken: "codex-refresh",
          idToken: null,
          accountId: "codex-account",
          planType: null,
          email: null,
          expiresAt: Date.now() + 60 * 60 * 1_000,
        }),
      }),
    );
    const service = host.harness.behavior.runService("hub");
    cleanups.push(async () => {
      service.controller.abort();
      await service.done;
      await host.harness.lifecycle.dispose();
    });
    await vi.waitFor(async () => {
      const status = statusSchema.parse(
        await host.harness.behavior.callRpc("status.get", null),
      );
      expect(status.accepting).toBe(true);
    });
    expect(await statusOf(host, claude, "/v1/messages")).toBe(200);
    expect(await statusOf(host, nested, "/availability")).toBe(200);
    expect(await statusOf(host, revoked, "/v1/messages")).toBe(401);
    expect(await statusOf(host, revokedNested, "/availability")).toBe(401);
  });

  it("keeps the tokens of a thread archived while the plugin was down valid until the machine token rotates", async () => {
    let now = 1_000;
    const fixture = await scopedFixture({ now: () => now });
    const missed = await claudeToken(fixture.host, "thread-missed");
    const missedNested = await nestedToken(fixture.host, "thread-missed");
    const host = await fixture.host.harness.lifecycle.reload(
      createAccountPoolPlugin({
        now: () => now,
        usageUrl: EMPTY_USAGE_URL,
        codexUsageUrl: EMPTY_USAGE_URL,
        importCodexCredentials: async () => ({
          accessToken: "codex-access",
          refreshToken: "codex-refresh",
          idToken: null,
          accountId: "codex-account",
          planType: null,
          email: null,
          expiresAt: Date.now() + 60 * 60 * 1_000,
        }),
      }),
    );
    const service = host.harness.behavior.runService("hub");
    cleanups.push(async () => {
      service.controller.abort();
      await service.done;
      await host.harness.lifecycle.dispose();
    });
    await vi.waitFor(async () => {
      const status = statusSchema.parse(
        await host.harness.behavior.callRpc("status.get", null),
      );
      expect(status.accepting).toBe(true);
    });
    expect(await statusOf(host, missed, "/v1/messages")).toBe(200);
    expect(await statusOf(host, missedNested, "/availability")).toBe(200);
    now = 2_000;
    const rotate = await host.harness.behavior.runCli([
      "token",
      "rotate",
      "--machine",
      "One",
    ]);
    expect(rotate.exitCode).toBe(0);
    now = 2_000 + 10 * 60_000 + 1;
    expect(await statusOf(host, missed, "/v1/messages")).toBe(401);
    expect(await statusOf(host, missedNested, "/availability")).toBe(401);
  });

  it("exports nothing for an archived thread and revokes any token it already held", async () => {
    const fixture = await scopedFixture();
    const { host } = fixture;
    const archived = async ({ threadId }: { threadId: string }) =>
      makeThreadResponse({ id: threadId, archivedAt: 1_000 });
    const entries = (threadId: string) =>
      host.harness.behavior.resolveProviderEnv("claude-code", {
        threadId,
        projectId: "project-one",
        hostId: "host-one",
      });
    const credentialFiles = async (threadId: string) =>
      (await fs.readdir(path.join(fixture.dataDir, ...POOL_SECRETS))).filter(
        (name) => name.includes(threadId),
      );
    const held = await claudeToken(host, "thread-held");
    const heldNested = await nestedToken(host, "thread-held");
    expect(await statusOf(host, held, "/v1/messages")).toBe(200);
    host.harness.sdk.stub("threads.get", archived);
    expect(await entries("thread-late")).toEqual([]);
    expect(await credentialFiles("thread-late")).toEqual([]);
    expect(await entries("thread-held")).toEqual([]);
    expect(await credentialFiles("thread-held")).toEqual([]);
    expect(await statusOf(host, held, "/v1/messages")).toBe(401);
    expect(await statusOf(host, heldNested, "/availability")).toBe(401);
    host.harness.sdk.stub("threads.get", async ({ threadId }) =>
      makeThreadResponse({ id: threadId }),
    );
    const restored = await claudeToken(host, "thread-held");
    expect(restored).not.toBe(held);
    expect(await statusOf(host, restored, "/v1/messages")).toBe(200);
  });

  it("mints nothing when the thread lookup fails", async () => {
    const fixture = await scopedFixture();
    const { host } = fixture;
    host.harness.sdk.stub("threads.get", async () => {
      throw new Error("lookup failed");
    });
    await expect(
      host.harness.behavior.resolveProviderEnv("claude-code", {
        threadId: "thread-lookup",
        projectId: "project-one",
        hostId: "host-one",
      }),
    ).resolves.toEqual([]);
    expect(
      (await fs.readdir(path.join(fixture.dataDir, ...POOL_SECRETS))).filter(
        (name) => name.includes("thread-lookup"),
      ),
    ).toEqual([]);
  });

  it("mints nothing and skips the contribution when the thread lookup fails on a nested server", async () => {
    const parent = await scopedFixture();
    const { host: child, dataDir } = await startNestedChild(
      parent,
      await nestedToken(parent.host),
    );
    child.harness.sdk.stub("threads.get", async () => {
      throw new Error("lookup failed");
    });
    await expect(
      child.harness.behavior.resolveProviderEnv("claude-code", {
        threadId: "thread-lookup",
        projectId: "project-one",
        hostId: "host-one",
      }),
    ).resolves.toEqual([]);
    expect(
      (
        await fs.readdir(path.join(dataDir, ...POOL_SECRETS)).catch(() => [])
      ).filter((name) => name.includes("thread-lookup")),
    ).toEqual([]);
  });

  it("revokes what it minted when the thread is archived while its environment resolves", async () => {
    const fixture = await scopedFixture();
    const { host } = fixture;
    let lookups = 0;
    host.harness.sdk.stub("threads.get", async ({ threadId }) => {
      lookups += 1;
      return makeThreadResponse({
        id: threadId,
        archivedAt: lookups === 1 ? null : 1_000,
      });
    });
    const entries = await host.harness.behavior.resolveProviderEnv(
      "claude-code",
      {
        threadId: "thread-racing",
        projectId: "project-one",
        hostId: "host-one",
      },
    );
    expect(lookups).toBe(2);
    expect(entries).toEqual([]);
    expect(
      (await fs.readdir(path.join(fixture.dataDir, ...POOL_SECRETS))).filter(
        (name) => name.includes("thread-racing"),
      ),
    ).toEqual([]);
  });

  it("does not restore an archived thread from a delayed unarchive event", async () => {
    const { host } = await scopedFixture();
    const token = await claudeToken(host, "thread-delayed-unarchive");
    host.harness.sdk.stub("threads.get", async ({ threadId }) =>
      makeThreadResponse({ id: threadId, archivedAt: 1_000 }),
    );
    await host.harness.behavior.emitThreadEvent("thread.archived", {
      thread: makeThreadResponse({
        id: "thread-delayed-unarchive",
        archivedAt: 1_000,
      }),
    });
    await host.harness.behavior.emitThreadEvent("thread.unarchived", {
      thread: makeThreadResponse({ id: "thread-delayed-unarchive" }),
    });
    expect(await statusOf(host, token, "/v1/messages")).toBe(401);
    const entries = await host.harness.behavior.resolveProviderEnv(
      "claude-code",
      {
        threadId: "thread-delayed-unarchive",
        projectId: "project-one",
        hostId: "host-one",
      },
    );
    expect(entries.some((entry) => entry.name === "ANTHROPIC_AUTH_TOKEN")).toBe(
      false,
    );
  });

  it("does not restore when archive arrives during the unarchive lookup", async () => {
    const fixture = await scopedFixture();
    const { host } = fixture;
    const token = await claudeToken(host, "thread-unarchive-race");
    const lookupStarted = deferred();
    const releaseLookup = deferred();
    host.harness.sdk.stub("threads.get", async ({ threadId }) => {
      lookupStarted.resolve();
      await releaseLookup.promise;
      return makeThreadResponse({ id: threadId });
    });
    const restoring = host.harness.behavior.emitThreadEvent(
      "thread.unarchived",
      { thread: makeThreadResponse({ id: "thread-unarchive-race" }) },
    );
    await lookupStarted.promise;
    await host.harness.behavior.emitThreadEvent("thread.archived", {
      thread: makeThreadResponse({
        id: "thread-unarchive-race",
        archivedAt: 1_000,
      }),
    });
    releaseLookup.resolve();
    await restoring;
    const directory = path.join(fixture.dataDir, ...POOL_SECRETS);
    const markerName = (await fs.readdir(directory)).find((name) =>
      name.startsWith("archived-thread-"),
    );
    expect(markerName).toBeDefined();
    const marker = JSON.parse(
      await fs.readFile(path.join(directory, markerName ?? ""), "utf8"),
    ) as { archived: boolean };
    expect(marker.archived).toBe(true);
    expect(await statusOf(host, token, "/v1/messages")).toBe(401);
  });

  it("does not restore an unarchived event whose thread lookup is still archived", async () => {
    const fixture = await scopedFixture();
    const { host } = fixture;
    const threadId = "thread-still-archived";
    const token = await claudeToken(host, threadId);
    await host.harness.behavior.emitThreadEvent("thread.archived", {
      thread: makeThreadResponse({ id: threadId, archivedAt: 1_000 }),
    });
    host.harness.sdk.stub("threads.get", async ({ threadId: id }) =>
      makeThreadResponse({ id, archivedAt: 1_000 }),
    );
    await host.harness.behavior.emitThreadEvent("thread.unarchived", {
      thread: makeThreadResponse({ id: threadId }),
    });
    const directory = path.join(fixture.dataDir, ...POOL_SECRETS);
    const markerName = (await fs.readdir(directory)).find((name) =>
      name.startsWith("archived-thread-"),
    );
    expect(markerName).toBeDefined();
    const marker = JSON.parse(
      await fs.readFile(path.join(directory, markerName ?? ""), "utf8"),
    ) as { archived: boolean };
    expect(marker.archived).toBe(true);
    expect(await statusOf(host, token, "/v1/messages")).toBe(401);
  });

  it("does not apply a stale archived lookup after archive and unarchive events", async () => {
    const fixture = await scopedFixture();
    const { host } = fixture;
    const oldToken = await claudeToken(host, "thread-racing");
    const lookupStarted = deferred();
    const releaseLookup = deferred();
    let lookups = 0;
    host.harness.sdk.stub("threads.get", async ({ threadId }) => {
      lookups += 1;
      if (lookups === 1) {
        lookupStarted.resolve();
        await releaseLookup.promise;
        return makeThreadResponse({ id: threadId, archivedAt: 1_000 });
      }
      return makeThreadResponse({ id: threadId });
    });
    const resolving = host.harness.behavior.resolveProviderEnv(
      "claude-code",
      {
        threadId: "thread-racing",
        projectId: "project-one",
        hostId: "host-one",
      },
    );
    await lookupStarted.promise;
    await host.harness.behavior.emitThreadEvent("thread.archived", {
      thread: makeThreadResponse({ id: "thread-racing", archivedAt: 1_000 }),
    });
    await host.harness.behavior.emitThreadEvent("thread.unarchived", {
      thread: makeThreadResponse({ id: "thread-racing" }),
    });
    releaseLookup.resolve();
    const entries = await resolving;
    const token = entries.find(
      (entry) => entry.name === "ANTHROPIC_AUTH_TOKEN",
    );
    expect(lookups).toBe(3);
    if (token === undefined || typeof token.value !== "string")
      throw new Error("Account Pool token was not resolved after unarchive.");
    expect(await statusOf(host, oldToken, "/v1/messages")).toBe(401);
    expect(await statusOf(host, token.value, "/v1/messages")).toBe(
      200,
    );
  });

  it("blanks the inherited routing for an archived thread on a nested server", async () => {
    const parent = await scopedFixture();
    const { host: child } = await startNestedChild(
      parent,
      await nestedToken(parent.host),
    );
    const live = await claudeToken(child, "thread-nested");
    expect(await statusOf(child, live, "/v1/messages")).toBe(200);
    child.harness.sdk.stub("threads.get", async ({ threadId }) =>
      makeThreadResponse({ id: threadId, archivedAt: 1_000 }),
    );
    const entries = await child.harness.behavior.resolveProviderEnv(
      "claude-code",
      {
        threadId: "thread-nested",
        projectId: "project-one",
        hostId: "host-one",
      },
    );
    expect(entries.map((entry) => [entry.name, entry.value])).toEqual([
      ["ANTHROPIC_BASE_URL", ""],
      ["ANTHROPIC_AUTH_TOKEN", ""],
    ]);
    expect(await statusOf(child, live, "/v1/messages")).toBe(401);
  });

  describe.each(["routing disabled", "bypassed"] as const)(
    "a thread with %s",
    (change) => {
      const turnOff = async (host: Fixture["host"], threadId: string) => {
        if (change === "routing disabled") {
          await host.harness.behavior.callRpc("routing.set", {
            provider: "claude",
            enabled: false,
          });
          return;
        }
        await host.harness.behavior.callRpc("bypass.set", {
          threadId,
          bypassed: true,
        });
      };
      const archiveSilently = (host: Fixture["host"]) =>
        host.harness.sdk.stub("threads.get", async ({ threadId }) =>
          makeThreadResponse({ id: threadId, archivedAt: 1_000 }),
        );
      const credentialFiles = async (dataDir: string, threadId: string) =>
        (await fs.readdir(path.join(dataDir, ...POOL_SECRETS))).filter((name) =>
          name.includes(threadId),
        );

      it("revokes its tokens after a missed archive event the next time its environment resolves", async () => {
        const fixture = await scopedFixture();
        const { host } = fixture;
        const held = await claudeToken(host, "thread-missed");
        const heldNested = await nestedToken(host, "thread-missed");
        const other = await claudeToken(host, "thread-other");
        expect(await statusOf(host, held, "/v1/messages")).toBe(200);
        expect(await statusOf(host, heldNested, "/availability")).toBe(200);
        expect(
          await credentialFiles(fixture.dataDir, "thread-missed"),
        ).toHaveLength(2);
        await turnOff(host, "thread-missed");
        archiveSilently(host);
        const entries = await host.harness.behavior.resolveProviderEnv(
          "claude-code",
          {
            threadId: "thread-missed",
            projectId: "project-one",
            hostId: "host-one",
          },
        );
        expect(entries).toEqual([]);
        expect(await statusOf(host, held, "/v1/messages")).toBe(401);
        expect(await statusOf(host, heldNested, "/availability")).toBe(401);
        expect(await credentialFiles(fixture.dataDir, "thread-missed")).toEqual(
          [],
        );
        expect(
          await credentialFiles(fixture.dataDir, "thread-other"),
        ).toHaveLength(2);
        host.harness.sdk.stub("threads.get", async ({ threadId }) =>
          makeThreadResponse({ id: threadId }),
        );
        expect(await statusOf(host, other, "/v1/messages")).not.toBe(401);
      });

      it("revokes its tokens after a missed archive event on a nested server and blanks the inherited routing", async () => {
        const parent = await scopedFixture();
        const { host: child, dataDir } = await startNestedChild(
          parent,
          await nestedToken(parent.host),
        );
        const held = await claudeToken(child, "thread-missed");
        const heldNested = await nestedToken(child, "thread-missed");
        expect(await statusOf(child, held, "/v1/messages")).toBe(200);
        expect(await statusOf(child, heldNested, "/availability")).toBe(200);
        expect(await credentialFiles(dataDir, "thread-missed")).toHaveLength(2);
        await turnOff(child, "thread-missed");
        archiveSilently(child);
        const entries = await child.harness.behavior.resolveProviderEnv(
          "claude-code",
          {
            threadId: "thread-missed",
            projectId: "project-one",
            hostId: "host-one",
          },
        );
        expect(entries.map((entry) => [entry.name, entry.value])).toEqual([
          ["ANTHROPIC_BASE_URL", ""],
          ["ANTHROPIC_AUTH_TOKEN", ""],
        ]);
        expect(await statusOf(child, held, "/v1/messages")).toBe(401);
        expect(await statusOf(child, heldNested, "/availability")).toBe(401);
        expect(await credentialFiles(dataDir, "thread-missed")).toEqual([]);
      });

      it("stays unrouted without minting when its thread lookup fails on a nested server", async () => {
        const parent = await scopedFixture();
        const { host: child, dataDir } = await startNestedChild(
          parent,
          await nestedToken(parent.host),
        );
        await turnOff(child, "thread-lookup");
        child.harness.sdk.stub("threads.get", async () => {
          throw new Error("lookup failed");
        });
        const entries = await child.harness.behavior.resolveProviderEnv(
          "claude-code",
          {
            threadId: "thread-lookup",
            projectId: "project-one",
            hostId: "host-one",
          },
        );
        expect(entries.map((entry) => [entry.name, entry.value])).toEqual([
          ["ANTHROPIC_BASE_URL", ""],
          ["ANTHROPIC_AUTH_TOKEN", ""],
        ]);
        expect(
          await credentialFiles(dataDir, "thread-lookup").catch(() => []),
        ).toEqual([]);
      });
    },
  );

  it("keeps one thread's token from acting as another thread", async () => {
    const fixture = await scopedFixture();
    const { host } = fixture;
    const second = accountSchema.parse(
      await host.harness.behavior.callRpc("account.add", {
        provider: "claude",
        source: { kind: "api-key", apiKey: "sk-second" },
        label: "Second subscription",
        priority: 200,
      }),
    );
    const configure =
      host.harness.registrations.hooks["experimental_thread.configure"];
    if (configure === null) throw new Error("Configuration hook is missing.");
    await configure({
      thread: { id: "thr_pinned", providerId: "claude-code" },
      data: { provider: "claude", accountId: second.id },
    });
    const pinned = await claudeToken(host, "thr_pinned");
    const automatic = await claudeToken(host, "thr_automatic");
    const nested = await nestedToken(host, "thr_automatic");
    await host.harness.behavior.callRpc("bypass.set", {
      threadId: "thr_pinned",
      bypassed: true,
    });
    expect(await statusOf(host, pinned, "/v1/messages")).toBe(409);
    expect(await statusOf(host, automatic, "/v1/messages")).toBe(200);
    expect(await statusOf(host, nested, "/v1/messages")).toBe(200);
  });

  async function startNestedChild(
    parent: Fixture,
    scoped: string,
  ): Promise<{ host: Fixture["host"]; dataDir: string }> {
    const parentBase = "http://parent.test/api/v1/plugins/account-pool/http";
    const viaParent: typeof fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const route = url.pathname.slice(new URL(parentBase).pathname.length);
      const body =
        init?.body instanceof ArrayBuffer
          ? new TextDecoder().decode(init.body)
          : undefined;
      return parent.host.harness.behavior.fetchHttp(
        init?.method ?? "GET",
        `${route}${url.search}`,
        {
          headers: Object.fromEntries(new Headers(init?.headers)),
          ...(body === undefined ? {} : { body }),
        },
      );
    };
    const dataDir = await mkdtemp(path.join(tmpdir(), "bb-account-pool-nest-"));
    const child = createFakePluginHost({
      pluginId: "account-pool",
      dataDir,
      sdk: sdkStubs(),
    });
    await createAccountPoolPlugin({
      fetch: viaParent,
      availabilityTtlMs: 0,
      usageUrl: EMPTY_USAGE_URL,
      env: {
        [PARENT_URL_ENV]: parentBase,
        [PARENT_TOKEN_ENV]: scoped,
      },
    })(child.bb);
    const service = child.harness.behavior.runService("hub");
    cleanups.push(async () => {
      service.controller.abort();
      await service.done;
      await child.harness.lifecycle.dispose();
      await fs.rm(dataDir, { recursive: true, force: true });
    });
    await vi.waitFor(async () => {
      const status = statusSchema.parse(
        await child.harness.behavior.callRpc("status.get", null),
      );
      expect(status.accepting).toBe(true);
    });
    return { host: child, dataDir };
  }

  it("lets a nested server proxy through its parent with the scoped token until the thread is archived", async () => {
    const parent = await scopedFixture();
    const scoped = await nestedToken(parent.host);
    const { host: child } = await startNestedChild(parent, scoped);
    const childToken = await claudeToken(child, "thread-nested");
    expect(await statusOf(child, childToken, "/v1/messages")).toBe(200);
    expect(await statusOf(parent.host, scoped, "/availability")).toBe(200);
    await parent.host.harness.behavior.emitThreadEvent("thread.archived", {
      thread: makeThreadResponse({ id: "thread-one" }),
    });
    expect(await statusOf(child, childToken, "/v1/messages")).toBe(401);
    expect(await statusOf(parent.host, scoped, "/availability")).toBe(401);
    const neutralised = await child.harness.behavior.resolveProviderEnv(
      "claude-code",
      {
        threadId: "thread-nested",
        projectId: "project-one",
        hostId: "host-one",
      },
    );
    expect(neutralised.map((entry) => [entry.name, entry.value])).toEqual([
      ["ANTHROPIC_BASE_URL", ""],
      ["ANTHROPIC_AUTH_TOKEN", ""],
    ]);
  });
});
