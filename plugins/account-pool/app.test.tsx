// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  waitFor,
  within,
} from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { useComposer } from "@get-bb/plugin-sdk/app";
import type { PluginComposerApi } from "@get-bb/plugin-sdk";
import type {
  AccountPoolConfig,
  AccountSummary,
  PoolStatus,
} from "./src/contracts.js";
import { ACCOUNT_POOL_CONFIG_CHANGED } from "./src/realtime.js";

const app = await loadPluginApp(() => import("./app"));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

const STATUS_CACHE_KEY = "account-pool:status";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function measureAccountRows() {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      const handle = this.querySelector(
        'button[aria-roledescription="sortable"]',
      );
      const rows = Array.from(this.parentElement?.children ?? []);
      return new DOMRect(0, handle ? rows.indexOf(this) * 60 : 0, 600, 60);
    },
  );
}

async function keyboardMove(handle: HTMLElement, code = "ArrowDown") {
  handle.focus();
  fireEvent.keyDown(handle, { code: "Space" });
  await waitFor(() => expect(handle.getAttribute("aria-pressed")).toBe("true"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  fireEvent.keyDown(document, { code });
}

function account(overrides: Partial<AccountSummary> = {}): AccountSummary {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    provider: "claude",
    kind: "oauth",
    label: "person@example.com",
    email: "person@example.com",
    accountUuid: null,
    subscriptionType: "Max",
    rateLimitTier: "default_claude_max_5x",
    enabled: true,
    active: false,
    priority: 100,
    createdAt: 1,
    lastUsedAt: 2,
    lastUsedHostId: "host-one",
    lastUsedHostName: "bee",
    fiveHourUtilization: 0.21,
    fiveHourResetAt: null,
    fiveHourStatus: null,
    sevenDayUtilization: null,
    sevenDayResetAt: null,
    sevenDayStatus: null,
    representativeClaim: null,
    familyWeekly: {
      fable: null,
      sonnet: null,
      opus: null,
      haiku: null,
      other: null,
    },
    balance: {
      bindingWindow: null,
      bindingHeadroom: null,
      resetRecoveryPerHour: null,
      windows: [],
    },
    lastAutomaticChoice: null,
    limitWindows: [],
    extraUsage: null,
    usageRestriction: null,
    observedAt: 1,
    heldUntil: null,
    error: null,
    inFlight: 0,
    status: "ready",
    signInExpired: false,
    organizationUuid: null,
    ...overrides,
  };
}

function status(accounts: AccountSummary[] = [account()]): PoolStatus {
  return {
    route: "/api/v1/plugins/account-pool/http",
    enabledAccountCount: accounts.filter((item) => item.enabled).length,
    inFlight: 2,
    accepting: true,
    hosts: [
      { hostId: "host-one", hostName: "bee", mintedAt: 1, lastUsedAt: 2 },
    ],
    accounts,
    routing: { claude: true, codex: true },
    parent: null,
  };
}

function config(overrides: Partial<AccountPoolConfig> = {}): AccountPoolConfig {
  return {
    anthropicUpstreamBaseUrl: "https://api.anthropic.com",
    codexUpstreamBaseUrl: "https://chatgpt.com/backend-api/codex",
    switchThreshold: 0.98,
    parentMode: "proxy",
    ...overrides,
  };
}

function render(
  accounts = [account()],
  extraRpc: Record<string, () => object | null | Promise<object | null>> = {},
) {
  return renderSlot(
    app.settingsSections[0]!,
    {},
    {
      rpc: {
        "status.get": () => status(accounts),
        "config.get": () => config(),
        ...extraRpc,
      },
      openUrl: () => true,
    },
  );
}

describe("Subscription picker", () => {
  const Component = (() => {
    const component = app.composerCustomizations[0]?.experimental_modelPicker;
    if (component === undefined)
      throw new Error("Subscription picker registration is missing.");
    return component;
  })();

  const accounts = [
    account({
      label: "Max 20x",
      rateLimitTier: "default_claude_max_20x",
      sevenDayUtilization: 0.98,
      organizationUuid: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    }),
    account({
      id: "22222222-2222-4222-8222-222222222222",
      label: "Max 5x",
      sevenDayUtilization: 0.05,
      organizationUuid: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    }),
    account({
      id: "33333333-3333-4333-8333-333333333333",
      label: "Previous login",
      enabled: false,
    }),
  ];

  it("shows separate statistics for two organizations on one email and folds a second record of the same login", async () => {
    const slot = renderSlot(
      { component: Component },
      { providerId: "claude-code" },
      {
        pluginId: "account-pool",
        composer: { selection: { providerId: "claude-code" } },
        rpc: { "status.get": () => status(accounts) },
      },
    );
    expect(
      await slot.findByRole("option", { name: /Max 20x.*weekly 98%/ }),
    ).toBeTruthy();
    expect(
      slot.getByRole("option", { name: /Max 5x.*weekly 5%/ }),
    ).toBeTruthy();
    expect(slot.queryByRole("option", { name: /Previous login/ })).toBeNull();
    expect(
      (
        slot.getByRole("combobox", {
          name: "Subscription",
        }) as HTMLSelectElement
      ).value,
    ).toBe("automatic");
  });

  it("retains a new draft's choice after menu unmount and clears it for Automatic", async () => {
    let composer: PluginComposerApi | undefined;
    function Capture() {
      const current = useComposer();
      useEffect(() => {
        composer = current;
      }, [current]);
      return <Component providerId="claude-code" />;
    }
    const slot = renderSlot(
      { component: Capture },
      {},
      {
        pluginId: "account-pool",
        composer: { selection: { providerId: "claude-code" } },
        rpc: { "status.get": () => status(accounts) },
      },
    );
    const select = await slot.findByRole("combobox", { name: "Subscription" });
    await waitFor(() => expect(select.hasAttribute("disabled")).toBe(false));
    fireEvent.change(select, { target: { value: accounts[1]!.id } });
    await waitFor(() =>
      expect(composer?.experimental_createData).toEqual({
        provider: "claude",
        accountId: accounts[1]!.id,
      }),
    );
    slot.rerender(<div />);
    slot.rerender(<Capture />);
    await waitFor(() =>
      expect(
        (
          slot.getByRole("combobox", {
            name: "Subscription",
          }) as HTMLSelectElement
        ).value,
      ).toBe(accounts[1]!.id),
    );
    fireEvent.change(slot.getByRole("combobox"), {
      target: { value: "automatic" },
    });
    await waitFor(() => expect(composer?.experimental_createData).toBeNull());
  });

  it.each(["routing-off", "parent-proxy"] as const)(
    "explains that a new pinned conversation cannot be sent while %s is active",
    async (inactiveMode) => {
      let currentStatus = status(accounts);
      const slot = renderSlot(
        { component: Component },
        { providerId: "claude-code" },
        {
          pluginId: "account-pool",
          composer: {
            scope: { kind: "new-thread", projectId: null },
            selection: { providerId: "claude-code" },
          },
          rpc: { "status.get": () => currentStatus },
        },
      );
      const select = await slot.findByRole("combobox", {
        name: "Subscription",
      });
      await waitFor(() => expect(select.hasAttribute("disabled")).toBe(false));
      fireEvent.change(select, { target: { value: accounts[1]!.id } });

      if (inactiveMode === "routing-off") {
        currentStatus = {
          ...currentStatus,
          routing: { claude: false, codex: true },
        };
      } else {
        currentStatus = {
          ...currentStatus,
          parent: {
            baseUrl: "https://parent.example",
            mode: "proxy",
            availability: { claude: true, codex: true },
          },
        };
      }
      await slot.emitRealtime(ACCOUNT_POOL_CONFIG_CHANGED, {});

      const expected =
        inactiveMode === "routing-off"
          ? "This new conversation can't use the selected subscription while Claude routing is off. Choose Automatic or turn routing back on before sending."
          : "This new conversation can't use the selected subscription while a parent pool is in proxy mode. Choose Automatic or switch the parent to local mode before sending.";
      expect(await slot.findByText(expected)).toBeTruthy();
      expect(
        slot.queryByText(/Saved preference not in use right now/u),
      ).toBeNull();
      expect(
        slot.queryByText(
          "This conversation uses only the selected subscription.",
        ),
      ).toBeNull();
    },
  );

  it("selects only the owning conversation and preserves its choice when the server rejects a change", async () => {
    const slot = renderSlot(
      { component: Component },
      { providerId: "claude-code" },
      {
        pluginId: "account-pool",
        composer: {
          scope: { kind: "thread", threadId: "thr_existing" },
          selection: { providerId: "claude-code" },
        },
        rpc: {
          "status.get": () => status(accounts),
          "routing.selection.get": () => ({ accountId: accounts[1]!.id }),
          "bypass.get": () => ({
            threadId: "thr_existing",
            bypassed: false,
          }),
          "routing.selection.set": () => {
            throw new Error("Wait for queued messages to finish.");
          },
        },
      },
    );
    const select = await slot.findByRole("combobox");
    await waitFor(() => expect(select.hasAttribute("disabled")).toBe(false));
    fireEvent.change(select, { target: { value: "automatic" } });
    expect(await slot.findByRole("alert")).toHaveProperty(
      "textContent",
      "Wait for queued messages to finish.",
    );
    expect(slot.rpcCalls.at(-1)?.input).toEqual({
      threadId: "thr_existing",
      provider: "claude",
      accountId: null,
    });
    expect((select as HTMLSelectElement).value).toBe(accounts[1]!.id);
  });

  it("shows a saved preference when parent routing or routing-off makes the pin inactive", async () => {
    const pinnedSlot = (currentStatus: PoolStatus, bypassed = false) =>
      renderSlot(
        { component: Component },
        { providerId: "claude-code" },
        {
          pluginId: "account-pool",
          composer: {
            scope: { kind: "thread", threadId: "thr_existing" },
            selection: { providerId: "claude-code" },
          },
          rpc: {
            "status.get": () => currentStatus,
            "routing.selection.get": () => ({ accountId: accounts[1]!.id }),
            "bypass.get": () => ({ threadId: "thr_existing", bypassed }),
          },
        },
      );
    const parentProxyStatus = {
      ...status(accounts),
      parent: {
        baseUrl: "https://parent.example",
        mode: "proxy" as const,
        availability: { claude: true, codex: true },
      },
    };
    const proxySlot = pinnedSlot(parentProxyStatus);
    expect(
      await proxySlot.findByText(
        "Saved preference not in use right now. A parent pool decides which subscription to use.",
      ),
    ).toBeTruthy();
    expect(
      proxySlot.queryByText(
        "This conversation uses only the selected subscription.",
      ),
    ).toBeNull();
    cleanup();

    const routingOffSlot = pinnedSlot({
      ...status(accounts),
      routing: { claude: false, codex: true },
    });
    expect(
      await routingOffSlot.findByText(
        "Saved preference not in use right now. Claude routing is off.",
      ),
    ).toBeTruthy();
    expect(
      routingOffSlot.queryByText(
        "This conversation uses only the selected subscription.",
      ),
    ).toBeNull();
    cleanup();

    const bypassedSlot = pinnedSlot(status(accounts), true);
    expect(
      await bypassedSlot.findByText(
        "Saved preference not in use right now. Pool routing is bypassed for this conversation.",
      ),
    ).toBeTruthy();
    expect(
      bypassedSlot.queryByText(
        "This conversation uses only the selected subscription.",
      ),
    ).toBeNull();
    cleanup();
  });

  it("refreshes the pin explanation after a routing configuration event", async () => {
    let currentStatus: PoolStatus = status(accounts);
    const slot = renderSlot(
      { component: Component },
      { providerId: "claude-code" },
      {
        pluginId: "account-pool",
        composer: {
          scope: { kind: "thread", threadId: "thr_existing" },
          selection: { providerId: "claude-code" },
        },
        rpc: {
          "status.get": () => currentStatus,
          "routing.selection.get": () => ({ accountId: accounts[1]!.id }),
          "bypass.get": () => ({ threadId: "thr_existing", bypassed: false }),
        },
      },
    );
    expect(
      await slot.findByText(
        "This conversation uses only the selected subscription.",
      ),
    ).toBeTruthy();
    const statusCalls = slot.rpcCalls.filter(
      (call) => call.method === "status.get",
    ).length;
    currentStatus = {
      ...currentStatus,
      parent: {
        baseUrl: "https://parent.example",
        mode: "proxy",
        availability: { claude: true, codex: true },
      },
    };
    await slot.emitRealtime(ACCOUNT_POOL_CONFIG_CHANGED, {});
    await waitFor(() =>
      expect(
        slot.rpcCalls.filter((call) => call.method === "status.get").length,
      ).toBeGreaterThan(statusCalls),
    );
    expect(
      await slot.findByText(
        "Saved preference not in use right now. A parent pool decides which subscription to use.",
      ),
    ).toBeTruthy();
    expect(
      slot.queryByText(
        "This conversation uses only the selected subscription.",
      ),
    ).toBeNull();
  });

  it("keeps the exclusivity message for an active local pin", async () => {
    const slot = renderSlot(
      { component: Component },
      { providerId: "claude-code" },
      {
        pluginId: "account-pool",
        composer: {
          scope: { kind: "thread", threadId: "thr_existing" },
          selection: { providerId: "claude-code" },
        },
        rpc: {
          "status.get": () => status(accounts),
          "routing.selection.get": () => ({ accountId: accounts[1]!.id }),
          "bypass.get": () => ({ threadId: "thr_existing", bypassed: false }),
        },
      },
    );
    expect(
      await slot.findByText(
        "This conversation uses only the selected subscription.",
      ),
    ).toBeTruthy();
    expect(
      slot.queryByText(/Saved preference not in use right now/u),
    ).toBeNull();
  });
});

describe("Account Pool parent banner", () => {
  const PARENT_URL = "http://127.0.0.1:25231/api/v1/plugins/account-pool/http";

  function renderWithParent(
    parent: PoolStatus["parent"],
    accounts = [account()],
  ) {
    return renderSlot(
      app.settingsSections[0]!,
      {},
      {
        rpc: {
          "status.get": () => ({ ...status(accounts), parent }),
          "config.get": () => config(),
        },
        openUrl: () => true,
      },
    );
  }

  it("says nothing about a parent when this server has none", async () => {
    const slot = renderWithParent(null, []);
    expect(await slot.findByText("No subscriptions in the pool")).toBeTruthy();
    expect(slot.queryByText(/Account Pooler available/i)).toBeNull();
  });

  it("invites pooling through the parent while isolated, without leaking the api path", async () => {
    const slot = renderWithParent({
      baseUrl: PARENT_URL,
      mode: "isolate",
      availability: { claude: true, codex: true },
    });
    expect(
      await slot.findByText("Parent Account Pooler available"),
    ).toBeTruthy();
    expect(
      slot.getByText(/started from a thread on 127\.0\.0\.1:25231/),
    ).toBeTruthy();
    expect(slot.queryByText(/api\/v1\/plugins/)).toBeNull();
  });

  it("names both providers and says local accounts go unused while proxying", async () => {
    const slot = renderWithParent({
      baseUrl: PARENT_URL,
      mode: "proxy",
      availability: { claude: true, codex: true },
    });
    expect(
      await slot.findByText("Using the parent Account Pooler"),
    ).toBeTruthy();
    expect(
      slot.getByText(
        /Claude and Codex requests are sent to the pool on 127\.0\.0\.1:25231\. Accounts on this server are not used/,
      ),
    ).toBeTruthy();
  });

  it("calls out a provider the parent cannot serve", async () => {
    const slot = renderWithParent({
      baseUrl: PARENT_URL,
      mode: "proxy",
      availability: { claude: true, codex: false },
    });
    expect(
      await slot.findByText(
        /Claude requests are sent to the pool on .*Codex has no accounts there, so those requests fall back/,
      ),
    ).toBeTruthy();
  });

  it("says nothing is routed when the parent has no accounts at all", async () => {
    const slot = renderWithParent({
      baseUrl: PARENT_URL,
      mode: "proxy",
      availability: { claude: false, codex: false },
    });
    expect(
      await slot.findByText(/has no accounts available right now/),
    ).toBeTruthy();
  });
});

it("gives subscription and routing switches a 44px coarse-pointer hit area", async () => {
  const slot = render([
    account(),
    account({
      id: "22222222-2222-4222-8222-222222222222",
      provider: "codex",
      label: "codex@example.com",
      email: "codex@example.com",
      accountUuid: null,
      codexAccountId: "codex-account",
      subscriptionType: null,
      rateLimitTier: null,
    }),
  ]);
  const switchNames = [
    "Use person@example.com",
    "Use codex@example.com",
    "Route Claude threads",
    "Route Codex threads",
  ];

  for (const name of switchNames) {
    const control = await slot.findByRole("switch", { name });
    expect(control.className).toContain("h-4 w-7");
    expect(control.getAttribute("data-switch-hit-area")).toBe("true");
    expect(control.className).toContain("pointer-coarse:size-11");
    expect(control.querySelector("[data-switch-track]")).toBeTruthy();
  }

  const subscriptionSwitch = slot.getByRole("switch", {
    name: "Use person@example.com",
  });
  const checkedBeforeActions = subscriptionSwitch.getAttribute("aria-checked");
  fireEvent.click(
    slot.getByRole("button", { name: "person@example.com actions" }),
  );
  expect(subscriptionSwitch.getAttribute("aria-checked")).toBe(
    checkedBeforeActions,
  );
});

describe("Account Pool settings", () => {
  it("renders cached accounts as refreshing until live status arrives, then caches it", async () => {
    window.localStorage.setItem(
      STATUS_CACHE_KEY,
      JSON.stringify(status([account({ label: "Cached Claude" })])),
    );
    const live = deferred<PoolStatus>();
    const slot = render([], { "status.get": () => live.promise });
    expect(slot.getByText("Cached Claude")).toBeTruthy();
    expect(slot.getByText("refreshing usage…")).toBeTruthy();
    expect(slot.getByText(/· refreshing…$/)).toBeTruthy();
    expect(slot.queryByText("Loading…")).toBeNull();
    expect(slot.queryByText("No subscriptions in the pool")).toBeNull();
    live.resolve(status([account({ label: "Live Claude" })]));
    expect(await slot.findByText("Live Claude")).toBeTruthy();
    expect(slot.queryByText("refreshing usage…")).toBeNull();
    expect(slot.queryByText(/· refreshing…$/)).toBeNull();
    const cached = JSON.parse(
      window.localStorage.getItem(STATUS_CACHE_KEY) ?? "null",
    ) as PoolStatus;
    expect(cached.accounts[0]?.label).toBe("Live Claude");
  });

  it("ignores a malformed status cache and shows the loading state", async () => {
    window.localStorage.setItem(STATUS_CACHE_KEY, '{"accounts":"nope"}');
    const live = deferred<PoolStatus>();
    const slot = render([], { "status.get": () => live.promise });
    expect(slot.getAllByText("Loading…")).toHaveLength(1);
    live.resolve(status());
    expect(await slot.findByText("person@example.com")).toBeTruthy();
  });

  it("marks a row as refreshing while its usage refresh is in flight", async () => {
    const refresh = deferred<{ account: null }>();
    const slot = render([account()], {
      "account.refreshUsage": () => refresh.promise,
    });
    fireEvent.pointerDown(
      await slot.findByRole("button", { name: "person@example.com actions" }),
    );
    fireEvent.click(await slot.findByText("Refresh usage"));
    expect(await slot.findByText("refreshing usage…")).toBeTruthy();
    refresh.resolve({ account: null });
    await waitFor(() =>
      expect(slot.queryByText("refreshing usage…")).toBeNull(),
    );
  });

  function openActions(slot: ReturnType<typeof render>, label: string) {
    return slot
      .findByRole("button", { name: `${label} actions` })
      .then((button) => fireEvent.pointerDown(button));
  }

  const GMAIL_ID = "44444444-4444-4444-8444-444444444444";
  const PREVIOUS_ID = "55555555-5555-4555-8555-555555555555";
  const ICLOUD_ID = "66666666-6666-4666-8666-666666666666";

  function parallelLogins() {
    return [
      account({
        id: PREVIOUS_ID,
        label: "Claude Max 20x (previous token, disabled)",
        email: "Gmail@Example.com",
        rateLimitTier: "default_claude_max_5x",
        enabled: false,
        status: "disabled",
        signInExpired: true,
        error: "OAuth refresh failed with HTTP 400.",
        priority: 1,
      }),
      account({
        id: GMAIL_ID,
        label: "Claude Max 20x (principal)",
        email: "gmail@example.com",
        rateLimitTier: "default_claude_max_20x",
        organizationUuid: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        priority: 2,
      }),
      account({
        id: ICLOUD_ID,
        label: "Alexandre",
        email: "icloud@example.com",
        rateLimitTier: "default_claude_max_20x",
        priority: 3,
      }),
    ];
  }

  it("shows one row per subscription when two records share a login", async () => {
    const slot = render(parallelLogins());
    const group = await slot.findByRole("group", {
      name: "Claude subscriptions",
    });
    expect(within(group).getByText("2 subscriptions · 2 on")).toBeTruthy();
    expect(
      within(group)
        .getAllByRole("switch", { name: /^Use / })
        .map((control) => control.getAttribute("aria-label")),
    ).toEqual(["Use Claude Max 20x (principal)", "Use Alexandre"]);
    expect(
      slot.queryByText("Claude Max 20x (previous token, disabled)"),
    ).toBeNull();
    expect(slot.queryByText("Sign-in expired")).toBeNull();
    expect(
      slot.queryByRole("button", { name: /^Sign in again to / }),
    ).toBeNull();
    expect(slot.getAllByText("Max 20x")).toHaveLength(2);
    for (const badge of slot.getAllByText("Max 20x")) {
      expect(badge.className).toContain("whitespace-nowrap");
      expect(badge.parentElement?.className).toContain("shrink-0");
    }
  });

  it("keeps the folded record in place when reordering the visible subscriptions", async () => {
    measureAccountRows();
    const slot = render(parallelLogins(), {
      "account.reorder": () => null,
    });
    const handle = await slot.findByRole("button", {
      name: "Reorder Alexandre",
    });
    await keyboardMove(handle, "ArrowUp");
    await new Promise((resolve) => setTimeout(resolve, 0));
    fireEvent.keyDown(document, { code: "ArrowUp" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    fireEvent.keyDown(document, { code: "Space" });
    await waitFor(() =>
      expect(slot.rpcCalls).toContainEqual({
        method: "account.reorder",
        input: {
          provider: "claude",
          accountIds: [PREVIOUS_ID, ICLOUD_ID, GMAIL_ID],
        },
      }),
    );
  });

  it("marks the subscription behind the next automatic pick, even when a folded record was picked", async () => {
    const [, principal, icloud] = parallelLogins();
    if (principal === undefined || icloud === undefined)
      throw new Error("Missing parallel login fixtures.");
    const spare = account({
      ...principal,
      id: PREVIOUS_ID,
      label: "Claude Max 20x (spare token)",
      priority: 4,
    });
    const slot = render([principal, icloud, spare], {
      "routing.binding.next": () => ({
        nextAccountId: PREVIOUS_ID,
        reason: "Most headroom.",
      }),
    });
    expect(await slot.findByText("Next")).toBeTruthy();
    const nextRow = slot
      .getByRole("switch", { name: "Use Claude Max 20x (principal)" })
      .closest("div");
    expect(nextRow?.textContent).toContain("Next");
    expect(slot.queryByText("Claude Max 20x (spare token)")).toBeNull();
  });

  it("names each subscription's state in words", async () => {
    const now = Date.now();
    const slot = render(
      [
        account({ id: GMAIL_ID, label: "Next one", email: "a@example.com" }),
        account({
          id: "77777777-7777-4777-8777-777777777777",
          label: "Used up one",
          email: "b@example.com",
          status: "exhausted",
          sevenDayUtilization: 1,
          sevenDayResetAt: now + (2 * 24 * 60 + 5) * 60_000,
        }),
        account({
          id: "88888888-8888-4888-8888-888888888888",
          label: "Held one",
          email: "c@example.com",
          status: "held",
          heldUntil: now + 30 * 60_000,
        }),
        account({
          id: "99999999-9999-4999-8999-999999999999",
          label: "Unread one",
          email: "d@example.com",
          status: "error",
          error: "Usage could not be read.",
        }),
        account({
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          label: "Off one",
          email: "e@example.com",
          enabled: false,
          status: "disabled",
        }),
      ],
      {
        "routing.binding.next": () => ({
          nextAccountId: GMAIL_ID,
          reason: "Most headroom.",
        }),
      },
    );
    expect(await slot.findByText("Next")).toBeTruthy();
    expect(slot.getByText("· most headroom")).toBeTruthy();
    expect(slot.getByText("Used up")).toBeTruthy();
    expect(slot.getByText("· back in 2d 0h")).toBeTruthy();
    expect(slot.getByText("Held")).toBeTruthy();
    expect(slot.getByText(/^· retry at /)).toBeTruthy();
    expect(slot.getByText("Can't read usage")).toBeTruthy();
    expect(slot.getByText("Off")).toBeTruthy();
    expect(slot.getByText("5 subscriptions · 4 on")).toBeTruthy();
    expect(
      slot.getByText("Hub accepting · 2 in flight · used by bee"),
    ).toBeTruthy();
  });

  it("shows the plan from the tier and opens usage details for a Codex subscription", async () => {
    const blockingResetAt = Date.now() + 6 * 24 * 60 * 60 * 1_000;
    const slot = render([
      account({
        id: "22222222-2222-4222-8222-222222222222",
        provider: "codex",
        label: "pro@example.com",
        email: "pro@example.com",
        codexAccountId: "chatgpt-account",
        subscriptionType: null,
        rateLimitTier: null,
        status: "exhausted",
        limitWindows: [
          {
            slot: "primary",
            windowMinutes: 10_080,
            utilization: 1,
            resetAt: blockingResetAt,
            status: "rejected",
            observedAt: 1,
            source: "usage",
          },
        ],
      }),
      account({ label: "Claude Max" }),
    ]);
    expect(await slot.findByText("pro@example.com")).toBeTruthy();
    expect(slot.getByText("Max 5x")).toBeTruthy();
    expect(slot.getByText("· back in 6d 0h")).toBeTruthy();
    await openActions(slot, "pro@example.com");
    fireEvent.click(await slot.findByText("Usage details"));
    expect(await slot.findByText("Weekly")).toBeTruthy();
    expect(slot.queryByText("5 hour")).toBeNull();
    expect(slot.queryByText("7 day")).toBeNull();
  });

  it.each([
    {
      control: "switch",
      enabled: true,
      method: "account.disable",
    },
    {
      control: "switch",
      enabled: false,
      method: "account.enable",
    },
  ])(
    "turns a subscription with enabled $enabled through its switch",
    async ({ enabled, method }) => {
      const slot = render([account({ enabled })], {
        [method]: () => ({ account: null }),
      });
      fireEvent.click(
        await slot.findByRole("switch", { name: "Use person@example.com" }),
      );
      await waitFor(() =>
        expect(slot.rpcCalls).toContainEqual({
          method,
          input: { id: account().id },
        }),
      );
    },
  );

  function foldedTwins(enabled: boolean) {
    return [
      account({
        id: "b2222222-2222-4222-8222-222222222222",
        label: "Gmail copy",
        email: "twin@example.com",
        enabled,
        lastUsedAt: 1,
      }),
      account({
        id: "a1111111-1111-4111-8111-111111111111",
        label: "Gmail twin",
        email: "Twin@Example.com",
        enabled,
        lastUsedAt: 5,
      }),
      account({
        id: "c3333333-3333-4333-8333-333333333333",
        label: "Gmail lapsed",
        email: "twin@example.com",
        enabled: false,
        signInExpired: true,
        status: "error",
        error: "OAuth refresh failed with HTTP 400.",
      }),
      account({
        id: "d4444444-4444-4444-8444-444444444444",
        label: "Other login",
        email: "other@example.com",
        accountUuid: "44444444-4444-4444-8444-444444444444",
      }),
    ];
  }

  it("asks before turning off a subscription whose other records are still on, naming them", async () => {
    const slot = render(foldedTwins(true), {
      "account.disableSubscription": () => ({ accounts: [] }),
    });
    const accountCalls = () =>
      slot.rpcCalls.filter((call) => call.method.startsWith("account."));
    expect(await slot.findByText("2 subscriptions · 2 on")).toBeTruthy();
    fireEvent.click(slot.getByRole("switch", { name: "Use Gmail twin" }));
    const dialog = await slot.findByRole("dialog", {
      name: "Turn off Gmail twin?",
    });
    expect(dialog.textContent).toContain(
      "Also on for this login: Gmail copy. Gmail twin keeps sending through it unless it is turned off too.",
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(slot.queryByRole("dialog")).toBeNull());
    expect(accountCalls()).toEqual([]);
    fireEvent.click(slot.getByRole("switch", { name: "Use Gmail twin" }));
    fireEvent.click(
      within(
        await slot.findByRole("dialog", { name: "Turn off Gmail twin?" }),
      ).getByRole("button", { name: "Turn off all" }),
    );
    await waitFor(() =>
      expect(accountCalls()).toEqual([
        {
          method: "account.disableSubscription",
          input: {
            id: "a1111111-1111-4111-8111-111111111111",
            expectedIds: [
              "b2222222-2222-4222-8222-222222222222",
              "a1111111-1111-4111-8111-111111111111",
            ],
          },
        },
      ]),
    );
  });

  it("refuses a stale turn off, shows the updated list and turns off only what it named", async () => {
    let accounts = foldedTwins(true);
    const third = account({
      id: "e5555555-5555-4555-8555-555555555555",
      label: "Gmail third",
      email: "twin@example.com",
      lastUsedAt: 0,
    });
    let confirms = 0;
    const slot = render(accounts, {
      "status.get": () => status(accounts),
      "account.disableSubscription": () => {
        confirms += 1;
        if (confirms > 1) return { accounts: [] };
        accounts = [...accounts, third];
        throw new Error(
          "The records of this subscription changed. Review the updated list; nothing was turned off.",
        );
      },
    });
    fireEvent.click(
      await slot.findByRole("switch", { name: "Use Gmail twin" }),
    );
    const dialog = await slot.findByRole("dialog", {
      name: "Turn off Gmail twin?",
    });
    expect(dialog.textContent).toContain("Also on for this login: Gmail copy.");
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Turn off all" }),
    );
    expect(
      await within(dialog).findByText(
        "The records of this subscription changed. Review the updated list; nothing was turned off.",
      ),
    ).toBeTruthy();
    await waitFor(() =>
      expect(dialog.textContent).toContain(
        "Also on for this login: Gmail copy, Gmail third.",
      ),
    );
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Turn off all" }),
    );
    await waitFor(() => expect(slot.queryByRole("dialog")).toBeNull());
    expect(
      slot.rpcCalls
        .filter((call) => call.method === "account.disableSubscription")
        .map((call) => call.input),
    ).toEqual([
      {
        id: "a1111111-1111-4111-8111-111111111111",
        expectedIds: [
          "b2222222-2222-4222-8222-222222222222",
          "a1111111-1111-4111-8111-111111111111",
        ],
      },
      {
        id: "a1111111-1111-4111-8111-111111111111",
        expectedIds: [
          "b2222222-2222-4222-8222-222222222222",
          "a1111111-1111-4111-8111-111111111111",
          "e5555555-5555-4555-8555-555555555555",
        ],
      },
    ]);
  });

  it("turns a subscription off without asking when its other enabled record can't send", async () => {
    const [copy, twin, ...rest] = foldedTwins(true);
    const slot = render(
      [
        {
          ...copy!,
          signInExpired: true,
          status: "error",
          error: "OAuth refresh failed with HTTP 401.",
        },
        twin!,
        ...rest,
      ],
      { "account.disable": () => ({ account: null }) },
    );
    fireEvent.click(
      await slot.findByRole("switch", { name: "Use Gmail twin" }),
    );
    await waitFor(() =>
      expect(
        slot.rpcCalls.filter((call) => call.method.startsWith("account.")),
      ).toEqual([
        {
          method: "account.disable",
          input: { id: "a1111111-1111-4111-8111-111111111111" },
        },
      ]),
    );
    expect(slot.queryByRole("dialog")).toBeNull();
  });

  it("leaves a folded, disabled record untouched when its subscription is switched off and on", async () => {
    const PROTECTED = "f5c490bc-0000-4000-8000-000000000000";
    const pool = (principalEnabled: boolean) => [
      account({
        id: PROTECTED,
        label: "Previous login",
        email: "Gmail@Example.com",
        enabled: false,
        signInExpired: true,
        status: "error",
        error: "OAuth refresh failed with HTTP 400.",
        priority: 1,
        lastUsedAt: 1,
      }),
      account({
        id: "b2222222-2222-4222-8222-222222222222",
        label: "principal",
        email: "gmail@example.com",
        enabled: principalEnabled,
        active: true,
        priority: 2,
        lastUsedAt: 5,
      }),
      account({
        id: "c3333333-3333-4333-8333-333333333333",
        label: "Alexandre",
        email: "icloud@example.com",
        accountUuid: "44444444-4444-4444-8444-444444444444",
        priority: 3,
      }),
    ];
    const off = render(pool(true), {
      "account.disable": () => ({ account: null }),
    });
    expect(await off.findByText("2 subscriptions · 2 on")).toBeTruthy();
    fireEvent.click(off.getByRole("switch", { name: "Use principal" }));
    await waitFor(() =>
      expect(off.rpcCalls).toContainEqual({
        method: "account.disable",
        input: { id: "b2222222-2222-4222-8222-222222222222" },
      }),
    );
    expect(off.queryByRole("dialog")).toBeNull();
    const offCalls = off.rpcCalls;
    cleanup();
    const on = render(pool(false), {
      "account.enable": () => ({ account: null }),
    });
    expect(await on.findByText("2 subscriptions · 1 on")).toBeTruthy();
    expect(on.queryByText("Previous login")).toBeNull();
    fireEvent.click(on.getByRole("switch", { name: "Use principal" }));
    await waitFor(() =>
      expect(on.rpcCalls).toContainEqual({
        method: "account.enable",
        input: { id: "b2222222-2222-4222-8222-222222222222" },
      }),
    );
    expect(
      [...offCalls, ...on.rpcCalls].filter((call) =>
        call.method.startsWith("account."),
      ),
    ).toEqual([
      {
        method: "account.disable",
        input: { id: "b2222222-2222-4222-8222-222222222222" },
      },
      {
        method: "account.enable",
        input: { id: "b2222222-2222-4222-8222-222222222222" },
      },
    ]);
    expect(JSON.stringify([...offCalls, ...on.rpcCalls])).not.toContain(
      PROTECTED,
    );
  });

  it("turns a folded subscription back on through its representative only", async () => {
    const slot = render(foldedTwins(false), {
      "account.enable": () => ({ account: null }),
    });
    expect(await slot.findByText("2 subscriptions · 1 on")).toBeTruthy();
    expect(slot.queryByRole("switch", { name: "Use Gmail copy" })).toBeNull();
    fireEvent.click(slot.getByRole("switch", { name: "Use Gmail twin" }));
    await waitFor(() =>
      expect(
        slot.rpcCalls.filter((call) => call.method === "account.enable"),
      ).toEqual([
        {
          method: "account.enable",
          input: { id: "a1111111-1111-4111-8111-111111111111" },
        },
      ]),
    );
    expect(
      slot.rpcCalls.some((call) => call.method === "account.disable"),
    ).toBe(false);
  });

  it("dispatches Refresh usage to its RPC contract", async () => {
    const slot = render([account()], {
      "account.refreshUsage": () => ({ account: null }),
    });
    await openActions(slot, "person@example.com");
    fireEvent.click(await slot.findByText("Refresh usage"));
    expect(slot.rpcCalls).toContainEqual({
      method: "account.refreshUsage",
      input: { accountId: account().id },
    });
  });

  it("confirms Remove before dispatching its RPC contract", async () => {
    const slot = render([account()], {
      "account.remove": () => ({ removed: true }),
    });
    await openActions(slot, "person@example.com");
    fireEvent.click(await slot.findByText("Remove…"));
    const dialog = await slot.findByRole("dialog", {
      name: "Remove person@example.com?",
    });
    expect(dialog.textContent).toContain(
      "bb deletes its saved sign-in. Conversations on Automatic move to your other Claude subscriptions; conversations set to this one stop until you choose another. To use it again, sign in again.",
    );
    expect(slot.rpcCalls.some((call) => call.method === "account.remove")).toBe(
      false,
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
    expect(slot.rpcCalls).toContainEqual({
      method: "account.remove",
      input: { id: account().id },
    });
  });

  it("renames a subscription in place with Enter and on blur, and cancels with Escape", async () => {
    const slot = render([account()], {
      "account.rename": () => ({ account: account({ label: "Main Claude" }) }),
    });
    const renames = () =>
      slot.rpcCalls.filter((call) => call.method === "account.rename");
    fireEvent.click(
      await slot.findByRole("button", { name: "Rename person@example.com" }),
    );
    const field = await slot.findByRole("textbox", {
      name: "Subscription name",
    });
    fireEvent.change(field, { target: { value: "Ignored" } });
    fireEvent.keyDown(field, { key: "Escape" });
    expect(slot.queryByRole("textbox", { name: "Subscription name" })).toBe(
      null,
    );
    expect(renames()).toEqual([]);

    fireEvent.click(
      slot.getByRole("button", { name: "Rename person@example.com" }),
    );
    fireEvent.change(
      await slot.findByRole("textbox", { name: "Subscription name" }),
      { target: { value: "Also ignored" } },
    );
    expect(
      fireEvent.mouseDown(slot.getByRole("button", { name: "Save" })),
    ).toBe(false);
    const cancel = slot.getByRole("button", { name: "Cancel" });
    expect(fireEvent.mouseDown(cancel)).toBe(false);
    fireEvent.click(cancel);
    expect(slot.queryByRole("textbox", { name: "Subscription name" })).toBe(
      null,
    );
    expect(renames()).toEqual([]);

    fireEvent.click(
      slot.getByRole("button", { name: "Rename person@example.com" }),
    );
    const again = await slot.findByRole("textbox", {
      name: "Subscription name",
    });
    fireEvent.change(again, { target: { value: "  Main Claude " } });
    fireEvent.keyDown(again, { key: "Enter" });
    await waitFor(() =>
      expect(renames()).toEqual([
        {
          method: "account.rename",
          input: { id: account().id, label: "Main Claude" },
        },
      ]),
    );

    fireEvent.click(
      slot.getByRole("button", { name: "Rename person@example.com" }),
    );
    const blurred = await slot.findByRole("textbox", {
      name: "Subscription name",
    });
    fireEvent.change(blurred, { target: { value: "Work Claude" } });
    fireEvent.blur(blurred);
    await waitFor(() => expect(renames()).toHaveLength(2));
    expect(renames()[1]?.input).toEqual({
      id: account().id,
      label: "Work Claude",
    });
  });

  it("signs an expired Claude subscription in again without adding or renaming it", async () => {
    const expired = account({
      id: PREVIOUS_ID,
      label: "Claude Max 20x (gmail)",
      email: "gmail@example.com",
      enabled: false,
      status: "disabled",
      signInExpired: true,
      error: "OAuth refresh failed with HTTP 400.",
    });
    const slot = render([expired], {
      "login.start": () => ({
        sessionId: "22222222-2222-4222-8222-222222222222",
        authorizeUrl: "https://claude.ai/oauth/authorize",
      }),
      "login.complete": () => expired,
    });
    expect(await slot.findByText("Sign-in expired")).toBeTruthy();
    expect(slot.getByText("1 subscription · 0 on · 1 needs sign-in")).toBe(
      slot.getByText("1 subscription · 0 on · 1 needs sign-in"),
    );
    expect(
      slot.queryByRole("switch", { name: "Use Claude Max 20x (gmail)" }),
    ).toBeNull();
    fireEvent.click(
      slot.getByRole("button", {
        name: "Sign in again to Claude Max 20x (gmail)",
      }),
    );
    const dialog = await slot.findByRole("dialog", { name: "Sign in again" });
    expect(slot.rpcCalls).toContainEqual({
      method: "login.start",
      input: { accountId: PREVIOUS_ID },
    });
    expect(dialog.textContent).toContain(
      "Sign in to Claude as the account behind Claude Max 20x (gmail). bb keeps its name, plan and place in the list.",
    );
    expect(dialog.textContent).toContain(
      "If the code belongs to a different Claude account, bb stops and keeps this subscription as it is.",
    );
    expect(
      within(dialog).queryByRole("textbox", { name: "Account label" }),
    ).toBeNull();
    fireEvent.change(
      await within(dialog).findByLabelText("Claude authorization code"),
      { target: { value: "code#state" } },
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Complete" }));
    await waitFor(() =>
      expect(slot.rpcCalls).toContainEqual({
        method: "login.complete",
        input: {
          sessionId: "22222222-2222-4222-8222-222222222222",
          pasted: "code#state",
        },
      }),
    );
    expect(
      await within(dialog).findByText(
        "Signed in again to Claude Max 20x (gmail)",
      ),
    ).toBeTruthy();
    expect(
      within(dialog).getByText("It stays off until you turn it on."),
    ).toBeTruthy();
    expect(
      within(dialog).queryByRole("button", { name: "Add another" }),
    ).toBeNull();
  });

  it("shows a refused sign-in again inside the dialog and offers a fresh start", async () => {
    const expired = account({
      label: "Claude Max 20x (gmail)",
      signInExpired: true,
      status: "error",
      error: "OAuth refresh failed with HTTP 400.",
    });
    let starts = 0;
    const slot = render([expired], {
      "login.start": () => {
        starts += 1;
        return {
          sessionId: "22222222-2222-4222-8222-222222222222",
          authorizeUrl: "https://claude.ai/oauth/authorize",
        };
      },
      "login.complete": () => {
        throw new Error(
          "That code belongs to a different Claude account. Sign in as the account behind Claude Max 20x (gmail); it was not changed.",
        );
      },
    });
    fireEvent.click(
      await slot.findByRole("button", { name: /^Sign in again to / }),
    );
    const dialog = await slot.findByRole("dialog", { name: "Sign in again" });
    fireEvent.change(
      await within(dialog).findByLabelText("Claude authorization code"),
      { target: { value: "code#state" } },
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Complete" }));
    expect(
      await within(dialog).findByText(
        "That code belongs to a different Claude account. Sign in as the account behind Claude Max 20x (gmail); it was not changed.",
      ),
    ).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(starts).toBe(2));
    expect(
      slot.rpcCalls.filter((call) => call.method === "login.start"),
    ).toEqual([
      { method: "login.start", input: { accountId: expired.id } },
      { method: "login.start", input: { accountId: expired.id } },
    ]);
  });

  it("starts a Codex sign in again for its subscription and keeps Turn off in its menu", async () => {
    const expired = account({
      id: "22222222-2222-4222-8222-222222222222",
      provider: "codex",
      label: "Codex Pro",
      email: "codex@example.com",
      codexAccountId: "chatgpt-account",
      signInExpired: true,
      status: "error",
      error: "OAuth refresh failed with HTTP 401.",
    });
    const slot = render([expired], {
      "codexLogin.start": codexLoginStart,
      "codexLogin.poll": () => ({ status: "pending" }),
      "codexLogin.cancel": () => ({ cancelled: true }),
      "account.disable": () => ({ account: null }),
    });
    await openActions(slot, "Codex Pro");
    fireEvent.click(await slot.findByText("Turn off"));
    await waitFor(() =>
      expect(slot.rpcCalls).toContainEqual({
        method: "account.disable",
        input: { id: expired.id },
      }),
    );
    fireEvent.click(slot.getByRole("button", { name: /^Sign in again to / }));
    const dialog = await slot.findByRole("dialog", { name: "Sign in again" });
    expect(slot.rpcCalls).toContainEqual({
      method: "codexLogin.start",
      input: { accountId: expired.id },
    });
    expect(dialog.textContent).toContain(
      "Sign in to ChatGPT as the account behind Codex Pro. bb keeps its name and place in the list.",
    );
    expect(
      within(dialog).queryByRole("textbox", { name: "Account label" }),
    ).toBeNull();
  });

  function renderOwnerPool() {
    const gmail = "gmail.owner@example.com";
    return render(
      [
        account({
          id: "f5c490bc-0000-4000-8000-000000000000",
          label: "Claude Max 20x (previous token, disabled)",
          email: gmail,
          rateLimitTier: "default_claude_max_20x",
          enabled: false,
          signInExpired: true,
          status: "error",
          error: "OAuth refresh failed with HTTP 400.",
          priority: 1,
          lastUsedAt: 1,
        }),
        account({
          id: "567f46ec-0000-4000-8000-000000000000",
          label: "Claude Max 20x (principal)",
          email: gmail,
          rateLimitTier: "default_claude_max_20x",
          status: "exhausted",
          sevenDayUtilization: 1,
          priority: 1,
          lastUsedAt: 5,
        }),
        account({
          id: "6b45fa7d-0000-4000-8000-000000000000",
          label: "Alexandre",
          email: "icloud.owner@example.com",
          accountUuid: "44444444-4444-4444-8444-444444444444",
          active: true,
          priority: 2,
        }),
      ],
      {
        "local.logins": () => [
          {
            providerId: "codex",
            displayName: "Codex",
            email: "codex.owner@example.com",
            planLabel: "ChatGPT Pro",
            status: "ready",
            poolProvider: "codex",
          },
        ],
        "routing.set": () => ({ provider: "codex", enabled: false }),
      },
    );
  }

  it("shows the owner's two records of one Claude login as one subscription beside their other login", async () => {
    const slot = renderOwnerPool();
    await slot.findAllByText("Claude Max 20x (principal)");
    expect(
      slot.queryByText("Claude Max 20x (previous token, disabled)"),
    ).toBeNull();
    const claude = slot.getByRole("group", { name: "Claude subscriptions" });
    expect(within(claude).getByText("2 subscriptions · 2 on")).toBeTruthy();
    expect(
      within(claude)
        .getAllByRole("switch", { name: /^Use / })
        .map((control) => control.getAttribute("aria-label")),
    ).toEqual(["Use Claude Max 20x (principal)", "Use Alexandre"]);
  });

  it("shows the owner's own Codex login under On this Mac instead of an empty Codex pool section", async () => {
    const slot = renderOwnerPool();
    await slot.findAllByText("Claude Max 20x (principal)");
    expect(slot.queryByText(/No accounts yet/)).toBeNull();
    expect(
      slot.queryByRole("switch", { name: "Route Codex threads" }),
    ).toBeNull();
    expect(
      slot.queryByRole("group", { name: "Codex subscriptions" }),
    ).toBeNull();
    const mac = await slot.findByRole("group", { name: "On this Mac" });
    expect(within(mac).getByText("Codex")).toBeTruthy();
    expect(within(mac).getByText("ChatGPT Pro")).toBeTruthy();
    expect(within(mac).getByText("Ready")).toBeTruthy();
    expect(
      within(mac).getByRole("button", {
        name: "Add this Mac's Codex login to the pool",
      }),
    ).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: "Advanced" }));
    fireEvent.click(
      await slot.findByRole("switch", { name: "Route Codex threads" }),
    );
    expect(
      slot.getAllByRole("switch", { name: "Route Claude threads" }),
    ).toHaveLength(1);
    await waitFor(() =>
      expect(slot.rpcCalls).toContainEqual({
        method: "routing.set",
        input: { provider: "codex", enabled: false },
      }),
    );
  });

  it("lists this Mac's own logins outside the pool and adds a poolable one", async () => {
    const slot = render([account()], {
      "local.logins": () => [
        {
          providerId: "codex",
          displayName: "Codex",
          email: "codex@example.com",
          planLabel: null,
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
      ],
      "account.add": () => account({ provider: "codex" }),
    });
    const group = await slot.findByRole("group", { name: "On this Mac" });
    expect(
      within(group).getByText("Signed in directly, not in the pool"),
    ).toBeTruthy();
    expect(
      within(group).getByText("cursor@example.com · can't be pooled"),
    ).toBeTruthy();
    expect(within(group).getByText("Sign-in expired")).toBeTruthy();
    expect(
      within(group)
        .getAllByRole("button", { name: /to the pool$/ })
        .map((button) => button.getAttribute("aria-label")),
    ).toEqual(["Add this Mac's Codex login to the pool"]);
    fireEvent.click(
      within(group).getByRole("button", {
        name: "Add this Mac's Codex login to the pool",
      }),
    );
    await waitFor(() =>
      expect(slot.rpcCalls).toContainEqual({
        method: "account.add",
        input: { provider: "codex", source: { kind: "import" }, label: null },
      }),
    );
  });

  it("opens each provider's sign-in flow from the Add subscription menu", async () => {
    const slot = render([], {
      "login.start": () => ({
        sessionId: "22222222-2222-4222-8222-222222222222",
        authorizeUrl: "https://claude.ai/oauth/authorize",
      }),
      "login.complete": () => account({ label: "Work Claude" }),
      "codexLogin.start": () => ({
        sessionId: "33333333-3333-4333-8333-333333333333",
        verificationUri: "https://auth.openai.com/codex/device",
        userCode: "ABCD-1234",
        expiresAt: Date.now() + 600_000,
        intervalMs: 60_000,
      }),
    });
    const add = await slot.findByRole("button", { name: "Add subscription" });
    fireEvent.pointerDown(add);
    fireEvent.click(
      await slot.findByText("Sign in to Claude", { selector: "span.block" }),
    );
    expect(slot.rpcCalls).toContainEqual({
      method: "login.start",
      input: null,
    });
    const authorizationCode = await slot.findByLabelText(
      "Claude authorization code",
    );
    expect(authorizationCode.getAttribute("type")).toBe("password");
    expect(
      slot.getByText(
        /private window or sign in to the account you want to add/i,
      ),
    ).toBeTruthy();
    fireEvent.change(slot.getByRole("textbox", { name: "Account label" }), {
      target: { value: "Work Claude" },
    });
    fireEvent.change(authorizationCode, { target: { value: "one-time-code" } });
    fireEvent.click(await slot.findByRole("button", { name: "Complete" }));
    await waitFor(() =>
      expect(slot.rpcCalls).toContainEqual({
        method: "login.complete",
        input: {
          sessionId: "22222222-2222-4222-8222-222222222222",
          pasted: "one-time-code",
          label: "Work Claude",
        },
      }),
    );
    fireEvent.click(slot.getByRole("button", { name: "Close" }));
    fireEvent.pointerDown(add);
    fireEvent.click(
      await slot.findByText("Sign in to Codex", { selector: "span.block" }),
    );
    expect(
      (await slot.findByLabelText("Codex user code")).textContent,
    ).toContain("ABCD-1234");
  });

  it("persists provider routing from the section switch", async () => {
    const slot = render([account()], {
      "routing.set": () => ({ provider: "claude", enabled: false }),
    });
    fireEvent.click(
      await slot.findByRole("switch", { name: "Route Claude threads" }),
    );
    await waitFor(() =>
      expect(slot.rpcCalls).toContainEqual({
        method: "routing.set",
        input: { provider: "claude", enabled: false },
      }),
    );
  });

  it.each(["claude", "codex"] as const)(
    "retains focus on the Route %s switch while its update is pending",
    async (provider) => {
      const update = deferred<object | null>();
      const slot = render([account()], {
        "routing.set": () => update.promise,
      });
      if (provider === "codex") {
        fireEvent.click(slot.getByRole("button", { name: "Advanced" }));
      }
      const control = await slot.findByRole("switch", {
        name: `Route ${provider === "claude" ? "Claude" : "Codex"} threads`,
      });
      control.focus();
      fireEvent.click(control);
      await waitFor(() =>
        expect(slot.rpcCalls).toContainEqual({
          method: "routing.set",
          input: { provider, enabled: false },
        }),
      );
      expect(control.hasAttribute("disabled")).toBe(false);
      expect(control.getAttribute("aria-disabled")).toBe("true");
      expect(document.activeElement).toBe(control);
      fireEvent.click(control);
      expect(
        slot.rpcCalls.filter((call) => call.method === "routing.set"),
      ).toHaveLength(1);
      update.resolve({ provider, enabled: false });
      await waitFor(() =>
        expect(control.getAttribute("aria-disabled")).toBeNull(),
      );
      expect(document.activeElement).toBe(control);
    },
  );

  it("edits Advanced config fields and shows URL validation inline", async () => {
    const nextConfig = config({
      anthropicUpstreamBaseUrl: "https://proxy.example.com",
    });
    const slot = render([account()], {
      "config.set": () => nextConfig,
    });
    fireEvent.click(await slot.findByRole("button", { name: "Advanced" }));
    const anthropic = await slot.findByLabelText("Anthropic upstream base URL");
    if (!(anthropic instanceof HTMLInputElement)) {
      throw new Error("Expected the Anthropic config field to be an input.");
    }
    await waitFor(() =>
      expect(anthropic.value).toBe("https://api.anthropic.com"),
    );
    expect(slot.getByLabelText("Codex upstream base URL")).toBeTruthy();
    expect(slot.getByLabelText("Quota switch threshold")).toBeTruthy();

    fireEvent.change(anthropic, { target: { value: "ftp://invalid.example" } });
    fireEvent.blur(anthropic);
    expect(await slot.findByText("Must be an HTTP or HTTPS URL.")).toBeTruthy();
    expect(slot.rpcCalls.some((call) => call.method === "config.set")).toBe(
      false,
    );

    fireEvent.change(anthropic, {
      target: { value: "https://proxy.example.com" },
    });
    fireEvent.blur(anthropic);
    await waitFor(() =>
      expect(slot.rpcCalls).toContainEqual({
        method: "config.set",
        input: { anthropicUpstreamBaseUrl: "https://proxy.example.com" },
      }),
    );
  });

  it("shows every observed family bucket and extra usage in the detail dialog", async () => {
    const fable = {
      utilization: 0.91,
      resetAt: Date.now() + 3_600_000,
      status: null,
      observedAt: 1,
      source: "usage" as const,
    };
    const slot = render([
      account({
        familyWeekly: {
          fable,
          sonnet: null,
          opus: { ...fable, utilization: 0.2 },
          haiku: null,
          other: null,
        },
        extraUsage: { status: "allowed", observedAt: 1, source: "header" },
      }),
    ]);
    await openActions(slot, "person@example.com");
    fireEvent.click(await slot.findByText("Usage details"));
    expect(await slot.findByText("Fable 7 day")).toBeTruthy();
    expect(slot.getByText("Opus 7 day")).toBeTruthy();
    expect(slot.getByText("Extra usage")).toBeTruthy();
    expect(slot.getByText("Available")).toBeTruthy();
  });

  it("shows the email beside a display-name label in the row and detail dialog", async () => {
    const slot = render([
      account({ label: "Person Example", email: "person@example.com" }),
      account({
        id: "22222222-2222-4222-8222-222222222222",
        label: "Claude API key",
        kind: "api-key",
        email: null,
      }),
    ]);
    expect(await slot.findByText("Person Example")).toBeTruthy();
    expect(slot.getAllByText("person@example.com")).toHaveLength(1);
    expect(slot.getByText("API key")).toBeTruthy();
    await openActions(slot, "Person Example");
    fireEvent.click(await slot.findByText("Usage details"));
    expect(await slot.findByText("Email")).toBeTruthy();
    expect(slot.getAllByText("person@example.com")).toHaveLength(2);
  });

  function codexLoginStart() {
    return {
      sessionId: "33333333-3333-4333-8333-333333333333",
      verificationUri: "https://auth.openai.com/codex/device",
      userCode: "ABCD-1234",
      expiresAt: Date.now() + 600_000,
      intervalMs: 60_000,
    };
  }

  function mockCompactViewport(matches: boolean) {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query === "(max-width: 767px)" && matches,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }));
  }

  it("names the sign-in dialog once and keeps the step instructions", async () => {
    const slot = render([], { "codexLogin.start": codexLoginStart });
    fireEvent.click(
      await slot.findByRole("button", { name: "Sign in to Codex" }),
    );
    const dialog = await slot.findByRole("dialog", {
      name: "Sign in to Codex",
    });
    expect(
      slot.getAllByRole("heading", { name: "Sign in to Codex" }),
    ).toHaveLength(1);
    expect(dialog.textContent).toContain(
      "Open the verification page, sign in to ChatGPT, and enter this code.",
    );
    expect(
      (await slot.findByLabelText("Codex user code")).textContent,
    ).toContain("ABCD-1234");
    expect(slot.queryByRole("button", { name: "Cancel" })).toBeNull();
  });

  it.each([false, true])(
    "cancels the pending sign-in from the header close with compact viewport %s",
    async (compact) => {
      mockCompactViewport(compact);
      const slot = render([], {
        "codexLogin.start": codexLoginStart,
        "codexLogin.poll": () => ({ status: "pending" }),
        "codexLogin.cancel": () => ({ cancelled: true }),
      });
      fireEvent.click(
        await slot.findByRole("button", { name: "Sign in to Codex" }),
      );
      await slot.findByRole("dialog", { name: "Sign in to Codex" });
      fireEvent.click(slot.getByRole("button", { name: "Close" }));
      await waitFor(() =>
        expect(slot.rpcCalls).toContainEqual({
          method: "codexLogin.cancel",
          input: { sessionId: codexLoginStart().sessionId },
        }),
      );
      await waitFor(() =>
        expect(slot.queryByRole("dialog", { name: "Sign in to Codex" })).toBe(
          null,
        ),
      );
      const polls = () =>
        slot.rpcCalls.filter((call) => call.method === "codexLogin.poll")
          .length;
      const settled = polls();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(polls()).toBe(settled);
    },
  );

  it("does not claim success when copying the device code fails", async () => {
    const copy = deferred<void>();
    const writeText = vi.fn(() => copy.promise);
    vi.stubGlobal("navigator", {
      ...navigator,
      clipboard: { writeText },
    });
    const slot = render([], { "codexLogin.start": codexLoginStart });
    fireEvent.click(
      await slot.findByRole("button", { name: "Sign in to Codex" }),
    );
    const button = await slot.findByRole("button", {
      name: "Copy Codex sign-in code",
    });
    fireEvent.click(button);
    expect(writeText).toHaveBeenCalledWith("ABCD-1234");
    await act(async () => copy.reject(new Error("denied")));
    expect(window.getSelection()?.toString()).toBe("ABCD-1234");
    expect(slot.queryByText("Sign-in code copied")).toBeNull();
    expect(button.querySelector('[data-icon="Check"]')).toBeNull();
  });

  it("does not claim success when copying the authorization URL fails", async () => {
    const copy = deferred<void>();
    const writeText = vi.fn(() => copy.promise);
    vi.stubGlobal("navigator", {
      ...navigator,
      clipboard: { writeText },
    });
    const slot = render([], { "codexLogin.start": codexLoginStart });
    fireEvent.click(
      await slot.findByRole("button", { name: "Sign in to Codex" }),
    );
    const button = await slot.findByRole("button", {
      name: "Copy Codex authorization URL",
    });
    fireEvent.click(button);
    expect(writeText).toHaveBeenCalledWith(
      "https://auth.openai.com/codex/device",
    );
    await act(async () => copy.reject(new Error("denied")));
    const input = slot.getByRole("textbox", {
      name: "Codex authorization URL",
    }) as HTMLInputElement;
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(input.value.length);
    expect(button.textContent).not.toContain("Copied");
    expect(slot.queryByText("Authorization URL copied")).toBeNull();
  });

  it("keeps polling and the close action working after copying the code", async () => {
    const copy = deferred<void>();
    const writeText = vi.fn(() => copy.promise);
    vi.stubGlobal("navigator", {
      ...navigator,
      clipboard: { writeText },
    });
    const slot = render([], {
      "codexLogin.start": codexLoginStart,
      "codexLogin.poll": () => ({ status: "pending" }),
      "codexLogin.cancel": () => ({ cancelled: true }),
    });
    fireEvent.click(
      await slot.findByRole("button", { name: "Sign in to Codex" }),
    );
    fireEvent.click(
      await slot.findByRole("button", { name: "Copy Codex sign-in code" }),
    );
    expect(writeText).toHaveBeenCalledWith("ABCD-1234");
    await act(async () => copy.resolve());
    expect(
      (await slot.findByRole("dialog", { name: "Sign in to Codex" }))
        .textContent,
    ).toContain("Waiting for you to authorize");
    fireEvent.click(slot.getByRole("button", { name: "Close" }));
    await waitFor(() =>
      expect(slot.rpcCalls).toContainEqual({
        method: "codexLogin.cancel",
        input: { sessionId: codexLoginStart().sessionId },
      }),
    );
  });

  it("offers a fresh Codex login after device-code polling fails", async () => {
    let starts = 0;
    const slot = render([], {
      "codexLogin.start": () => {
        starts += 1;
        return {
          sessionId: "33333333-3333-4333-8333-333333333333",
          verificationUri: "https://auth.openai.com/codex/device",
          userCode: "ABCD-1234",
          expiresAt: Date.now() + 600_000,
          intervalMs: 1,
        };
      },
      "codexLogin.poll": () => ({ status: "error", message: "Code expired." }),
    });
    fireEvent.click(
      await slot.findByRole("button", { name: "Sign in to Codex" }),
    );
    fireEvent.click(await slot.findByRole("button", { name: "Try again" }));
    await waitFor(() => expect(starts).toBe(2));
  });
  it.each(["claude", "codex"] as const)(
    "reorders %s accounts with the keyboard and persists the displayed order",
    async (provider) => {
      measureAccountRows();
      const first = account({
        label: "First",
        email: "first@example.com",
        provider,
      });
      const second = account({
        id: "22222222-2222-4222-8222-222222222222",
        label: "Second",
        email: "second@example.com",
        provider,
      });
      const other = account({
        id: "33333333-3333-4333-8333-333333333333",
        provider: provider === "claude" ? "codex" : "claude",
        label: "Other",
        email: "other@example.com",
      });
      const accounts = [first, second, other];
      let finishSave = () => {};
      const slot = render(accounts, {
        "account.reorder": () =>
          new Promise<null>((resolve) => {
            finishSave = () => {
              accounts.splice(0, 2, second, first);
              resolve(null);
            };
          }),
      });
      const handle = await slot.findByRole("button", { name: "Reorder First" });
      await keyboardMove(handle);
      fireEvent.keyDown(document, { code: "Space" });
      await waitFor(() =>
        expect(slot.rpcCalls).toContainEqual({
          method: "account.reorder",
          input: { provider, accountIds: [second.id, first.id] },
        }),
      );
      const providerOrder = () =>
        slot
          .getAllByRole("button", { name: /Reorder (First|Second)/ })
          .map((button) => button.getAttribute("aria-label"));
      expect(providerOrder()).toEqual(["Reorder Second", "Reorder First"]);
      expect(handle.hasAttribute("disabled")).toBe(true);
      finishSave();
      await waitFor(() => expect(handle.hasAttribute("disabled")).toBe(false));
      expect(providerOrder()).toEqual(["Reorder Second", "Reorder First"]);
      expect(
        slot
          .getByRole("button", { name: "Reorder Other" })
          .hasAttribute("disabled"),
      ).toBe(true);
    },
  );

  it("restores the displayed order and reports a rejected reorder", async () => {
    measureAccountRows();
    const slot = render(
      [
        account({ label: "First", email: "first@example.com" }),
        account({
          id: "22222222-2222-4222-8222-222222222222",
          label: "Second",
          email: "second@example.com",
        }),
      ],
      {
        "account.reorder": () => {
          throw new Error("Refresh the account list and try again.");
        },
      },
    );
    const handle = await slot.findByRole("button", { name: "Reorder First" });
    await keyboardMove(handle);
    fireEvent.keyDown(document, { code: "Space" });
    expect(
      await slot.findByText("Refresh the account list and try again."),
    ).toBeTruthy();
    expect(
      slot
        .getAllByRole("button", { name: /Reorder/ })
        .map((button) => button.getAttribute("aria-label")),
    ).toEqual(["Reorder First", "Reorder Second"]);
    expect(handle.hasAttribute("disabled")).toBe(false);
  });

  it.each(["cancel", "unchanged"])(
    "does not save a %s drag",
    async (action) => {
      measureAccountRows();
      const slot = render([
        account({ label: "First", email: "first@example.com" }),
        account({
          id: "22222222-2222-4222-8222-222222222222",
          label: "Second",
          email: "second@example.com",
        }),
      ]);
      const handle = await slot.findByRole("button", { name: "Reorder First" });
      await keyboardMove(handle, action === "cancel" ? "ArrowDown" : "ArrowUp");
      fireEvent.keyDown(document, {
        code: action === "cancel" ? "Escape" : "Space",
      });
      await waitFor(() =>
        expect(handle.getAttribute("aria-pressed")).toBeNull(),
      );
      expect(
        slot.rpcCalls.filter((call) => call.method === "account.reorder"),
      ).toEqual([]);
      expect(
        slot
          .getAllByRole("button", { name: /Reorder/ })
          .map((button) => button.getAttribute("aria-label")),
      ).toEqual(["Reorder First", "Reorder Second"]);
    },
  );
});
