// @vitest-environment jsdom
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UsageProvider } from "./usage-schema.js";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import {
  loadPluginApp,
  mountPluginContentScripts,
  renderSlot,
} from "@get-bb/plugin-sdk/testing/app";

const activeUsageLifecycles: Array<{ dispose: () => Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(
    activeUsageLifecycles.splice(0).map((lifecycle) => lifecycle.dispose()),
  );
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function threadOnMachine(
  hostId: string,
  hostName: string,
): PluginSidebarThread {
  return {
    id: "thread-active",
    projectId: "project-one",
    title: "Active thread",
    titleFallback: null,
    displayTitle: "Active thread",
    parentThreadId: null,
    lifecycleOwnerThreadId: null,
    sourceThreadId: null,
    sectionId: null,
    originKind: null,
    originPluginId: null,
    providerId: "codex",
    status: "idle",
    runtimeStatus: "idle",
    queuedWork: "none",
    experimental_queuedFailedCount: 0,
    hasPendingInteraction: false,
    activity: {
      workflows: 0,
      backgroundAgents: 0,
      backgroundCommands: 0,
      planMode: 0,
      goals: 0,
    },
    indicator: "none",
    indicatorLabel: null,
    isUnread: false,
    isPinned: false,
    pinnedAt: null,
    pinSortKey: null,
    isArchived: false,
    archivedAt: null,
    href: "/projects/project-one/threads/thread-active",
    isHidden: false,
    environment: null,
    host: { id: hostId, name: hostName },
    createdAt: 1,
    updatedAt: 1,
    lastReadAt: 1,
    latestAttentionAt: 1,
  };
}

async function setupUsageDisclosure() {
  localStorage.removeItem("bb.bb--provider-usage.selected-machine.v1");
  const pooledAccounts: UsageProvider[] = (
    [
      ["claude-code", "Claude Code", "claude-team@example.com", 97],
      ["claude-code", "Claude Code", "claude-backup@example.com", 54],
    ] as const
  ).map(([providerId, displayName, email, usedPercent]) => ({
    id: email,
    providerId: providerId,
    accountLabel:
      providerId === "claude-code"
        ? email === "claude-team@example.com"
          ? "Claude Principal"
          : "Claude Secondary"
        : email,
    displayName: displayName,
    logoUrl: `/api/v1/system/providers/${providerId}/logo`,
    icon: null,
    strings: { iconTint: null },
    signInHint: "Sign in.",
    expiredHint: "Sign in again.",
    accountPool:
      providerId !== "claude-code"
        ? null
        : email === "claude-team@example.com"
          ? {
              active: true,
              enabled: true,
              status: "ready",
              heldUntil: null,
              error: null,
              extraUsage: "allowed",
            }
          : {
              active: false,
              enabled: true,
              status: "held",
              heldUntil: Date.now() + 30 * 60_000,
              error: null,
              extraUsage: "rejected",
            },
    usage: {
      status: "ok",
      accountEmail: email,
      planLabel: "Pro",
      windows: [
        ...(providerId === "claude-code"
          ? [
              {
                label: "Five-hour limit",
                usedPercent: 12,
                resetsAt: null,
                cost: null,
              },
              {
                label: "Weekly · Fable",
                usedPercent: 91,
                resetsAt: null,
                cost: null,
              },
            ]
          : []),
        {
          label: "Weekly limit",
          usedPercent: usedPercent,
          resetsAt: null,
          cost: null,
        },
      ],
    },
  }));
  const fetchMock = vi.fn(
    async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(
        JSON.stringify({
          ok: true,
          result: {
            machines: [
              {
                id: "host-m4",
                displayName: "M4",
                status: "connected",
                error: null,
                providers: [
                  {
                    id: "claude-code",
                    providerId: "claude-code",
                    accountLabel: null,
                    displayName: "Claude Code",
                    logoUrl:
                      "/api/v1/system/providers/claude-code/logo?h=claude",
                    icon: null,
                    strings: {
                      iconTint: { light: "#D97757", dark: "#E38A6E" },
                    },
                    signInHint: "Sign in to Claude Code.",
                    expiredHint: "Sign in to Claude Code again.",
                    usage: {
                      status: "ok",
                      accountEmail: "claude@example.com",
                      planLabel: "Max",
                      windows: [
                        {
                          label: "Five-hour limit",
                          usedPercent: 82,
                          resetsAt: "2026-09-02T18:42:00.000Z",
                          cost: null,
                        },
                      ],
                    },
                  },
                  {
                    id: "codex",
                    providerId: "codex",
                    accountLabel: null,
                    displayName: "Codex",
                    logoUrl: "/api/v1/system/providers/codex/logo?h=codex",
                    icon: null,
                    strings: { iconTint: null },
                    signInHint: "Sign in to Codex.",
                    expiredHint: "Sign in to Codex again.",
                    usage: {
                      status: "ok",
                      accountEmail: "codex@example.com",
                      planLabel: "Plus",
                      windows: [
                        {
                          label: "Five-hour limit",
                          usedPercent: 21,
                          resetsAt: null,
                          cost: null,
                        },
                        {
                          label: "Weekly limit",
                          usedPercent: 37,
                          resetsAt: null,
                          cost: null,
                        },
                      ],
                    },
                  },
                ],
              },
              {
                id: "host-m5",
                displayName: "M5",
                status: "connected",
                error: null,
                providers: [
                  {
                    id: "codex",
                    providerId: "codex",
                    accountLabel: null,
                    displayName: "Codex",
                    logoUrl: "/api/v1/system/providers/codex/logo?h=codex",
                    icon: null,
                    strings: { iconTint: null },
                    signInHint: "Sign in to Codex.",
                    expiredHint: "Sign in to Codex again.",
                    usage: {
                      status: "ok",
                      accountEmail: "codex@example.com",
                      planLabel: "Plus",
                      windows: [
                        {
                          label: "Weekly limit",
                          usedPercent: 97,
                          resetsAt: null,
                          cost: null,
                        },
                      ],
                    },
                  },
                ],
              },
              {
                id: "source:account-pool",
                displayName: "Account Pooler",
                status: "connected",
                error: null,
                providers: pooledAccounts,
              },
              {
                id: "host-intel",
                displayName: "Intel",
                status: "disconnected",
                error: null,
                providers: [],
              },
            ],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  );
  vi.stubGlobal("fetch", fetchMock);
  vi.resetModules();
  const app = await loadPluginApp(() => import("./app"));
  const mounted = await mountPluginContentScripts(app, {
    pluginId: "bb--provider-usage",
  });
  activeUsageLifecycles.push(mounted.lifecycle);
  const item = app.experimentalSidebarFooterItems[0];
  if (item?.kind !== "disclosure") throw new Error("missing disclosure");
  await waitFor(() => {
    if (fetchMock.mock.calls.length === 0)
      throw new Error("initial usage request not sent");
  });
  const dismiss = vi.fn();
  const slot = renderSlot(
    item,
    { dismiss },
    {
      pluginId: "bb--provider-usage",
      context: { threadId: "thread-active" },
      sidebarThreads: {
        threads: [threadOnMachine("host-m5", "M5")],
      },
    },
  );
  await waitFor(() =>
    expect(
      slot.getByRole("button", { name: "Usage machine: Account Pooler" }),
    ).toBeTruthy(),
  );
  return { item, slot, dismiss, fetchMock };
}

function selectMachine(
  slot: ReturnType<typeof renderSlot>,
  current: string,
  next: string,
) {
  fireEvent.pointerDown(
    slot.getByRole("button", { name: `Usage machine: ${current}` }),
    { button: 0 },
  );
  fireEvent.click(slot.getByRole("menuitemradio", { name: next }));
}

describe("provider usage footer disclosure", () => {
  it("aggregates every machine", async () => {
    const { item, slot, fetchMock } = await setupUsageDisclosure();
    expect(item).toMatchObject({
      kind: "disclosure",
      id: "usage",
      label: "Provider usage",
      icon: "ChartColumn",
    });
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/v1/plugins/bb--provider-usage/rpc/getUsage",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            force: false,
            machineIds: null,
            maxAgeMs: 30 * 60_000,
            providerIds: [],
          }),
        }),
      ),
    );
    expect(
      slot.getByRole("button", { name: "Usage machine: Account Pooler" }),
    ).toBeTruthy();
    expect(
      slot
        .getByRole("tab", { name: "All accounts" })
        .getAttribute("aria-selected"),
    ).toBe("true");
    expect(
      slot.getAllByRole("region").map((row) => row.getAttribute("aria-label")),
    ).toEqual([
      "Claude Code Claude Principal",
      "Claude Code Claude Secondary",
      "Codex codex@example.com",
    ]);
    await waitFor(() =>
      expect(fetchMock.mock.calls).toEqual(
        expect.arrayContaining([
          [
            "/api/v1/plugins/bb--provider-usage/rpc/getUsage",
            expect.objectContaining({
              body: JSON.stringify({
                force: false,
                machineIds: ["source:account-pool", "host-m4"],
                maxAgeMs: 2 * 60_000,
                providerIds: ["claude-code", "codex"],
              }),
            }),
          ],
        ]),
      ),
    );
  });

  it("shows pooled account status in the disclosure card", async () => {
    const { slot } = await setupUsageDisclosure();
    expect(slot.getAllByText("Active")).toHaveLength(1);
    expect(slot.getByText("Extra usage allowed")).toBeTruthy();
    expect(slot.getByText("Enabled · held")).toBeTruthy();
    expect(slot.getByText("Extra usage rejected")).toBeTruthy();
  });

  it("selects and persists a host machine in the disclosure card", async () => {
    const { slot } = await setupUsageDisclosure();
    selectMachine(slot, "Account Pooler", "M5");
    expect(
      slot.getByRole("heading", { name: "codex@example.com" }),
    ).toBeTruthy();
    expect(slot.getByText("97%")).toBeTruthy();
    expect(
      localStorage.getItem("bb.bb--provider-usage.selected-machine.v1"),
    ).toBe("host-m5");
  });

  it("keeps provider selection and navigation in the selected machine card", async () => {
    const { slot } = await setupUsageDisclosure();
    selectMachine(slot, "Account Pooler", "M5");
    const machinePicker = slot.getByRole("button", {
      name: "Usage machine: M5",
    });
    selectMachine(slot, "M5", "M4");
    const allTab = slot.getByRole("tab", { name: "All accounts" });
    const claudeTab = slot.getByRole("tab", { name: "Claude Code" });
    const codexTab = slot.getByRole("tab", { name: "Codex" });
    fireEvent.keyDown(allTab, { key: "ArrowRight" });
    expect(claudeTab.getAttribute("aria-selected")).toBe("true");
    expect(
      slot
        .getByRole("button", { name: "Usage machine: M4" })
        .closest('[data-provider-usage-header=""]'),
    ).toBe(claudeTab.closest('[data-provider-usage-header=""]'));
    expect(
      claudeTab.querySelector("[data-provider-logo*='claude-code']"),
    ).not.toBeNull();
    expect(
      codexTab.querySelector("[data-provider-logo*='/codex/']"),
    ).not.toBeNull();
    expect(
      slot.getByRole("heading", { name: "claude@example.com" }),
    ).toBeTruthy();
    expect(slot.getByText("82%")).toBeTruthy();

    fireEvent.click(codexTab);
    expect(
      slot.getByRole("heading", { name: "codex@example.com" }),
    ).toBeTruthy();
    expect(slot.getByText("37%")).toBeTruthy();
    fireEvent.keyDown(codexTab, { key: "ArrowLeft" });
    expect(claudeTab.getAttribute("aria-selected")).toBe("true");
  });

  it("refreshes the selected machine and stale provider data", async () => {
    const { slot, dismiss, fetchMock } = await setupUsageDisclosure();
    selectMachine(slot, "Account Pooler", "M4");
    selectMachine(slot, "M4", "Intel");
    expect(
      slot.getByText(
        "Intel is offline. Usage will refresh when it reconnects.",
      ),
    ).toBeTruthy();
    fireEvent.click(
      slot.getByRole("button", { name: "Collapse provider usage" }),
    );
    expect(dismiss).toHaveBeenCalledOnce();
    const reloadButton = slot.getByRole("button", {
      name: "Reload provider usage",
    }) as HTMLButtonElement;
    await waitFor(() => expect(reloadButton.disabled).toBe(false));
    const callsBeforeManualRefresh = fetchMock.mock.calls.length;
    fireEvent.click(reloadButton);
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledTimes(callsBeforeManualRefresh + 1),
    );
    expect(fetchMock.mock.calls.at(-1)?.[1]).toEqual(
      expect.objectContaining({
        body: JSON.stringify({
          force: true,
          machineIds: ["host-intel"],
          maxAgeMs: 0,
          providerIds: [],
        }),
      }),
    );

    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    window.dispatchEvent(new Event("blur"));
    now.mockReturnValue(5 * 60_000 + 1_001);
    const callsBeforeFocus = fetchMock.mock.calls.length;
    window.dispatchEvent(new Event("focus"));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledTimes(callsBeforeFocus + 3),
    );
    const focusCalls = fetchMock.mock.calls.slice(callsBeforeFocus);
    expect(focusCalls[0]?.[1]).toEqual(
      expect.objectContaining({
        body: JSON.stringify({
          force: false,
          machineIds: null,
          maxAgeMs: 5 * 60_000,
          providerIds: [],
        }),
      }),
    );
    expect(
      focusCalls
        .slice(1)
        .map(([, options]) => JSON.parse(options!.body as string)),
    ).toEqual([
      expect.objectContaining({ providerIds: ["claude-code"] }),
      expect.objectContaining({ providerIds: ["codex"] }),
    ]);
    now.mockRestore();
  });

  it("shows provider-specific pooled usage and reset details", async () => {
    const { slot } = await setupUsageDisclosure();
    selectMachine(slot, "Account Pooler", "M4");
    selectMachine(slot, "M4", "Intel");
    selectMachine(slot, "Intel", "Account Pooler");
    expect(slot.getAllByRole("tab")).toHaveLength(3);
    const poolCodexTab = slot.getByRole("tab", { name: "Codex" });
    expect(
      slot.container.querySelector("[data-provider-usage-tone]"),
    ).toBeNull();
    fireEvent.click(poolCodexTab);
    expect(
      poolCodexTab.querySelector("[data-provider-logo*='/codex/']"),
    ).not.toBeNull();
    expect(poolCodexTab.querySelector("[data-provider-usage-tone]")).toBeNull();
    expect(
      slot
        .getByRole("tab", { name: "Claude Code" })
        .querySelector('[data-provider-usage-tone="critical"]'),
    ).not.toBeNull();
    expect(
      slot.getByRole("heading", { name: "codex@example.com" }),
    ).toBeTruthy();
    expect(slot.getByText("37%")).toBeTruthy();
    expect(
      slot.getAllByRole("heading").map((heading) => heading.textContent),
    ).toEqual(["codex@example.com"]);
    expect(
      slot.getByRole("button", {
        name: "Five-hour limit: 21% used. Reset time not reported",
      }),
    ).toBeTruthy();
    const windowButton = slot.getByRole("button", {
      name: "Weekly limit: 37% used. Reset time not reported",
    });
    fireEvent.click(windowButton);
    expect(slot.getByText("Reset time not reported.")).toBeTruthy();
    fireEvent.click(slot.getByRole("tab", { name: "Claude Code" }));
    expect(slot.getByText("Claude Principal")).toBeTruthy();
    expect(slot.getByText("claude-team@example.com")).toBeTruthy();
    expect(slot.queryByText("personal@example.com")).toBeNull();
  });

  it("preserves displayed data and hides raw errors after failed refreshes", async () => {
    const { slot, fetchMock } = await setupUsageDisclosure();
    selectMachine(slot, "Account Pooler", "M4");
    selectMachine(slot, "M4", "Intel");
    selectMachine(slot, "Intel", "Account Pooler");
    fireEvent.click(slot.getByRole("tab", { name: "Claude Code" }));
    const diagnostics = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    for (const failure of [
      () => new Response("bb connect temporarily unavailable", { status: 503 }),
      () => new Response("bb connect is not JSON", { status: 200 }),
      () => Response.json({ ok: true, result: { machines: "invalid" } }),
    ]) {
      await waitFor(() =>
        expect(
          slot
            .getByRole("button", { name: "Reload provider usage" })
            .hasAttribute("disabled"),
        ).toBe(false),
      );
      fetchMock.mockResolvedValueOnce(failure());
      fireEvent.click(
        slot.getByRole("button", { name: "Reload provider usage" }),
      );
      await waitFor(() =>
        expect(
          slot.getByText("Couldn’t refresh. Showing last update."),
        ).toBeTruthy(),
      );
      expect(slot.getByText("claude-team@example.com")).toBeTruthy();
      expect(
        slot.queryByText(/Unexpected token|bb connect|invalid JSON/i),
      ).toBeNull();
      fireEvent.click(
        slot.getByRole("button", { name: "Reload provider usage" }),
      );
      await waitFor(() =>
        expect(
          slot.queryByText("Couldn’t refresh. Showing last update."),
        ).toBeNull(),
      );
    }
    expect(diagnostics).toHaveBeenCalledTimes(3);
  });
});
it.each([
  ["empty", "No accounts report usage yet."],
  ["expired", "Sign in again in the source plugin’s settings."],
  [
    "unauthenticated",
    "Sign in to this account in the source plugin’s settings.",
  ],
  ["no-limits", "No usage limits reported for this plan."],
  ["source-error", "Couldn’t refresh. Showing last update."],
] as const)("renders the %s shared-source state", async (state, expected) => {
  const usage: UsageProvider["usage"] =
    state === "expired" || state === "unauthenticated"
      ? { status: state }
      : {
          status: "ok",
          accountEmail: "review@example.com",
          planLabel: null,
          windows:
            state === "no-limits"
              ? []
              : [
                  {
                    label: "Weekly limit",
                    usedPercent: 42,
                    resetsAt: null,
                    cost: null,
                  },
                ],
        };
  const account: UsageProvider = {
    id: "account",
    providerId: "codex",
    accountLabel: "review@example.com",
    displayName: "Codex",
    logoUrl: null,
    icon: null,
    strings: { iconTint: null },
    signInHint: "Sign in to this account in the source plugin’s settings.",
    expiredHint: "Sign in again in the source plugin’s settings.",
    usage,
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({
        ok: true,
        result: {
          machines: [
            {
              id: "source:pool",
              displayName: "Review pool",
              status: "connected",
              providers: state === "empty" ? [] : [account],
              error: state === "source-error" ? "private backend error" : null,
            },
          ],
        },
      }),
    ),
  );
  const app = await loadPluginApp(() => import("./app"));
  const mounted = await mountPluginContentScripts(app, {
    pluginId: "bb--provider-usage",
  });
  const item = app.experimentalSidebarFooterItems[0];
  if (item?.kind !== "disclosure") throw new Error("missing disclosure");
  const slot = renderSlot(
    item,
    { dismiss: vi.fn() },
    { pluginId: "bb--provider-usage" },
  );
  await waitFor(() =>
    expect(slot.getByText(expected, { exact: false })).toBeTruthy(),
  );
  if (state === "source-error") {
    expect(slot.getByText("42%")).toBeTruthy();
    expect(slot.queryByText("private backend error")).toBeNull();
    expect(
      slot.queryByRole("button", { name: "Retry usage refresh" }),
    ).toBeNull();
  }
  await mounted.lifecycle.dispose();
});

it("keeps a measured refresh when an older snapshot response arrives late", async () => {
  const account = (usage: UsageProvider["usage"]): UsageProvider => ({
    id: "account",
    providerId: "codex",
    accountLabel: "review@example.com",
    displayName: "Codex",
    logoUrl: null,
    icon: null,
    strings: { iconTint: null },
    signInHint: "Sign in.",
    expiredHint: "Sign in again.",
    usage,
  });
  const snapshot = (usage: UsageProvider["usage"]) =>
    Response.json({
      ok: true,
      result: {
        machines: [
          {
            id: "source:pool",
            displayName: "Review pool",
            status: "connected",
            providers: [account(usage)],
            error: null,
          },
        ],
      },
    });
  let releaseInventory: (() => void) | null = null;
  const fetchMock = vi.fn(
    async (_input: RequestInfo | URL, init?: RequestInit) => {
      const { providerIds } = JSON.parse(String(init?.body)) as {
        providerIds: string[];
      };
      if (providerIds.length > 0)
        return snapshot({
          status: "ok",
          accountEmail: "review@example.com",
          planLabel: null,
          windows: [
            {
              label: "Weekly limit",
              usedPercent: 37,
              resetsAt: null,
              cost: null,
            },
          ],
        });
      if (fetchMock.mock.calls.length === 1) return snapshot(null);
      await new Promise<void>((resolve) => {
        releaseInventory = resolve;
      });
      return snapshot(null);
    },
  );
  vi.stubGlobal("fetch", fetchMock);
  const app = await loadPluginApp(() => import("./app"));
  const mounted = await mountPluginContentScripts(app, {
    pluginId: "bb--provider-usage",
  });
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
  window.dispatchEvent(new Event("blur"));
  now.mockReturnValue(5 * 60_000 + 1_001);
  window.dispatchEvent(new Event("focus"));
  await waitFor(() => expect(releaseInventory).not.toBeNull());
  now.mockRestore();

  const item = app.experimentalSidebarFooterItems[0];
  if (item?.kind !== "disclosure") throw new Error("missing disclosure");
  const slot = renderSlot(
    item,
    { dismiss: vi.fn() },
    { pluginId: "bb--provider-usage" },
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  releaseInventory!();
  await waitFor(() => expect(slot.getByText("37%")).toBeTruthy());
  await waitFor(() =>
    expect(
      slot
        .getByRole("button", { name: "Reload provider usage" })
        .hasAttribute("disabled"),
    ).toBe(false),
  );
  expect(slot.queryByText("Usage not reported.")).toBeNull();
  expect(slot.getByText("37%")).toBeTruthy();
  await mounted.lifecycle.dispose();
});
