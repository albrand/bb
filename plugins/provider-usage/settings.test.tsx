// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { providerUsageRpcContract } from "./server.js";
import type { UsageMachine, UsageProvider } from "./usage-schema.js";

afterEach(cleanup);

const usageInput = (input: unknown) =>
  providerUsageRpcContract.getUsage.input.parse(input);

function account(id: string, providerId = "codex"): UsageProvider {
  return {
    id,
    providerId,
    accountLabel: `${id}@example.com`,
    displayName: providerId === "codex" ? "Codex" : "Claude Code",
    logoUrl: null,
    icon: null,
    strings: { iconTint: null },
    signInHint: "Sign in again.",
    expiredHint: "Session expired.",
    usage: {
      status: "ok",
      accountEmail: `${id}@example.com`,
      planLabel: "Max (20x)",
      windows: [
        {
          label: "Weekly limit",
          usedPercent: 42,
          resetsAt: new Date(Date.now() + 3600_000).toISOString(),
          cost: null,
        },
      ],
    },
  };
}
const machine = (id: string, providers: UsageProvider[]): UsageMachine => ({
  id,
  displayName: id === "source:pool" ? "Account Pooler" : "My machine",
  status: "connected",
  error: null,
  providers,
});

it("fetches all providers only in the selected source and keeps grouped accounts, icons, labels and reset times", async () => {
  const app = await loadPluginApp(() => import("./app"));
  const result = {
    machines: [
      machine("host", [account("local")]),
      machine("source:pool", [
        account("first"),
        account("second"),
        account("third", "claude-code"),
      ]),
    ],
  };
  const slot = renderSlot(
    app.settingsSections[0]!,
    {},
    { rpc: { getUsage: () => result } },
  );
  await waitFor(() =>
    expect(slot.getByLabelText("Reload usage data")).toBeTruthy(),
  );
  expect(
    slot.getByRole("button", { name: "Usage source" }).textContent,
  ).toContain("Combined");
  expect(slot.getByText("local@example.com")).toBeTruthy();
  expect(slot.getByText("third@example.com")).toBeTruthy();
  expect(slot.queryByText("first@example.com")).toBeNull();
  fireEvent.pointerDown(slot.getByRole("button", { name: "Usage source" }));
  fireEvent.click(
    await screen.findByRole("menuitem", { name: /Account Pooler/ }),
  );
  await slot.findByText("first@example.com");
  expect(slot.getAllByRole("heading", { name: "Codex" })).toHaveLength(2);
  expect(slot.getByText("first@example.com")).toBeTruthy();
  expect(slot.getByText("second@example.com")).toBeTruthy();
  expect(slot.queryByText("local@example.com")).toBeNull();
  expect(slot.getAllByText(/Resets in/)).toHaveLength(3);
  expect(slot.rpcCalls[0]?.input).toEqual({
    force: false,
    machineIds: null,
    providerId: null,
    maxAgeMs: 60_000,
  });
  fireEvent.click(slot.getByLabelText("Reload usage data"));
  await waitFor(() =>
    expect(slot.rpcCalls.some((call) => usageInput(call.input).force)).toBe(
      true,
    ),
  );
  expect(
    slot.rpcCalls.some((call) => {
      const input = usageInput(call.input);
      return input.force && input.machineIds?.includes("source:pool");
    }),
  ).toBe(true);
  expect(
    slot.rpcCalls.some((call) => {
      const input = usageInput(call.input);
      return input.force && input.machineIds?.includes("host");
    }),
  ).toBe(false);
  expect(slot.rpcCalls.at(-1)?.input).toMatchObject({
    force: true,
    machineIds: ["source:pool"],
  });
});

it("shows pooled Claude accounts and host Codex in the default combined view", async () => {
  const app = await loadPluginApp(() => import("./app"));
  const hostClaude = claudeAccount("host-claude");
  hostClaude.accountLabel = "alexandre@example.com";
  if (hostClaude.usage?.status === "ok")
    hostClaude.usage.accountEmail = "alexandre@example.com";
  const principal = claudeAccount("principal");
  principal.accountLabel = "principal@example.com";
  if (principal.usage?.status === "ok")
    principal.usage.accountEmail = "principal@example.com";
  const alexandre = claudeAccount("alexandre");
  alexandre.accountLabel = "alexandre@example.com";
  if (alexandre.usage?.status === "ok")
    alexandre.usage.accountEmail = "alexandre@example.com";
  const result = {
    machines: [
      machine("host", [hostClaude, account("codex-account")]),
      machine("source:pool", [principal, alexandre]),
    ],
  };
  const slot = renderSlot(
    app.settingsSections[0]!,
    {},
    { rpc: { getUsage: () => result } },
  );

  await slot.findByText("principal@example.com");
  expect(slot.getAllByText("alexandre@example.com")).toHaveLength(1);
  expect(slot.getByText("codex-account@example.com")).toBeTruthy();
  expect(slot.getAllByRole("heading", { name: "Claude Code" })).toHaveLength(2);
  expect(slot.getAllByText("Five-hour limit")).toHaveLength(2);
  expect(slot.getAllByText("Weekly limit")).toHaveLength(3);
  expect(slot.getAllByText(/^Resets/)).toHaveLength(5);
  const sourceButton = slot.getByRole("button", { name: "Usage source" });
  expect(sourceButton.textContent).toContain("Combined");
  expect(sourceButton.className).toContain("pointer-coarse:min-h-11");
  expect(slot.getByLabelText("Reload usage data").className).toContain(
    "pointer-coarse:min-w-11",
  );
  expect(
    sourceButton.closest("section")?.firstElementChild?.className,
  ).toContain("min-w-0");

  fireEvent.click(slot.getByLabelText("Reload usage data"));
  await waitFor(() =>
    expect(
      slot.rpcCalls.some((call) => {
        const input = usageInput(call.input);
        return (
          input.machineIds?.includes("host") &&
          input.providerId === "codex" &&
          input.force
        );
      }),
    ).toBe(true),
  );
  expect(
    slot.rpcCalls.some((call) => {
      const input = usageInput(call.input);
      return (
        input.machineIds?.includes("source:pool") &&
        input.providerId === "claude-code" &&
        input.force
      );
    }),
  ).toBe(true);
});

function claudeAccount(id: string): UsageProvider {
  const provider = account(id, "claude-code");
  if (provider.usage?.status === "ok") {
    provider.usage.windows = [
      {
        label: "Five-hour limit",
        usedPercent: 12,
        resetsAt: new Date(Date.now() + 3600_000).toISOString(),
        cost: null,
      },
      {
        label: "Weekly limit",
        usedPercent: 35,
        resetsAt: new Date(Date.now() + 86_400_000).toISOString(),
        cost: null,
      },
    ];
  }
  return provider;
}

it("falls back to the host providers when the pool has no accounts", async () => {
  const app = await loadPluginApp(() => import("./app"));
  const slot = renderSlot(
    app.settingsSections[0]!,
    {},
    {
      rpc: {
        getUsage: () => ({
          machines: [
            machine("host", [
              account("host-claude", "claude-code"),
              account("codex-account"),
            ]),
            machine("source:pool", []),
          ],
        }),
      },
    },
  );

  await slot.findByText("host-claude@example.com");
  expect(slot.getByText("codex-account@example.com")).toBeTruthy();
  expect(slot.queryByText("principal@example.com")).toBeNull();
});

it("keeps pool usage visible when a host source refresh fails", async () => {
  const app = await loadPluginApp(() => import("./app"));
  const hostCodex = account("codex-account");
  hostCodex.usage = null;
  const principal = account("principal", "claude-code");
  principal.usage = null;
  const result = {
    machines: [
      machine("host", [hostCodex]),
      machine("source:pool", [principal]),
    ],
  };
  const slot = renderSlot(
    app.settingsSections[0]!,
    {},
    {
      rpc: {
        getUsage: (unknownInput) => {
          const input = usageInput(unknownInput);
          if (input.machineIds === null) return result;
          if (input.machineIds?.includes("host"))
            throw new Error("host source unavailable");
          return {
            machines: [
              result.machines[0]!,
              machine("source:pool", [account("principal", "claude-code")]),
            ],
          };
        },
      },
    },
  );

  await slot.findByText(
    "Some usage sources could not be refreshed. Showing available results.",
  );
  expect(slot.getByText("principal@example.com")).toBeTruthy();
  expect(slot.getByText("42% used")).toBeTruthy();
  expect(slot.getByText("codex-account@example.com")).toBeTruthy();
});

it("uses machine usage when the pool is disabled", async () => {
  const app = await loadPluginApp(() => import("./app"));
  const slot = renderSlot(
    app.settingsSections[0]!,
    {},
    {
      rpc: {
        getUsage: () => ({ machines: [machine("host", [account("local")])] }),
      },
    },
  );
  await slot.findByText("local@example.com");
  await waitFor(() => expect(slot.rpcCalls).toHaveLength(2));
  expect(slot.rpcCalls[1]?.input).toMatchObject({
    machineIds: ["host"],
    providerId: "codex",
  });
});

it("falls back to host usage when the enabled pool has no accounts", async () => {
  const app = await loadPluginApp(() => import("./app"));
  const slot = renderSlot(
    app.settingsSections[0]!,
    {},
    {
      rpc: {
        getUsage: () => ({
          machines: [
            machine("host", [account("local")]),
            machine("source:pool", []),
          ],
        }),
      },
    },
  );
  await slot.findByText("local@example.com");
  await waitFor(() => expect(slot.rpcCalls).toHaveLength(2));
  expect(slot.rpcCalls[1]?.input).toMatchObject({ machineIds: ["host"] });
});

it("renders loading and a friendly transport error without exposing raw errors", async () => {
  const app = await loadPluginApp(() => import("./app"));
  let reject!: (error: Error) => void;
  const pending = new Promise<never>((_, fail) => {
    reject = fail;
  });
  const slot = renderSlot(
    app.settingsSections[0]!,
    {},
    { rpc: { getUsage: () => pending } },
  );
  expect(slot.getByText("Loading usage…")).toBeTruthy();
  reject(new Error("Unexpected token 'b', bb connect..."));
  await slot.findByText("Couldn’t load usage.");
  expect(
    slot.queryByRole("button", { name: "Retry usage refresh" }),
  ).toBeNull();
  expect(slot.queryByText(/Unexpected token/)).toBeNull();
});

it("retains measured accounts when reloading fails", async () => {
  const app = await loadPluginApp(() => import("./app"));
  let failed = false;
  const slot = renderSlot(
    app.settingsSections[0]!,
    {},
    {
      rpc: {
        getUsage: () => {
          if (failed) throw new Error("private transport detail");
          return {
            machines: [
              machine("source:pool", [account("first", "claude-code")]),
            ],
          };
        },
      },
    },
  );
  await waitFor(() =>
    expect(slot.getByLabelText("Reload usage data")).toBeTruthy(),
  );
  failed = true;
  fireEvent.click(slot.getByLabelText("Reload usage data"));
  await slot.findByText(/Showing last update/);
  expect(slot.getByText("first@example.com")).toBeTruthy();
  expect(slot.getAllByText("42% used").length).toBeGreaterThan(0);
});

it("shows one account refresh error beside that account while keeping others current", async () => {
  const app = await loadPluginApp(() => import("./app"));
  const failed = account("failed", "claude-code");
  failed.usage = {
    status: "error",
    message: "Usage could not be refreshed for this account.",
  };
  const slot = renderSlot(
    app.settingsSections[0]!,
    {},
    {
      rpc: {
        getUsage: () => ({
          machines: [
            machine("source:pool", [failed, account("current", "claude-code")]),
          ],
        }),
      },
    },
  );

  await slot.findByText("Usage could not be refreshed for this account.");
  expect(slot.getByText("42% used")).toBeTruthy();
  expect(slot.queryByText("Couldn’t refresh. Showing last update.")).toBeNull();
});

it("shows pending measurements without inventing usage, then reports an unavailable account gracefully", async () => {
  const app = await loadPluginApp(() => import("./app"));
  const resource = { ...account("pending", "claude-code"), usage: null };
  let finish!: () => void;
  let calls = 0;
  const slot = renderSlot(
    app.settingsSections[0]!,
    {},
    {
      rpc: {
        getUsage: async () => {
          if (calls++ === 0)
            return { machines: [machine("source:pool", [resource])] };
          await new Promise<void>((resolve) => {
            finish = resolve;
          });
          return {
            machines: [
              {
                ...machine("source:pool", [resource]),
                error: "Some usage could not be refreshed.",
              },
            ],
          };
        },
      },
    },
  );
  await slot.findByText("Loading usage…");
  expect(slot.queryByText("0% used")).toBeNull();
  finish();
  await slot.findByText("Couldn’t load usage.");
  expect(slot.getByText("Usage unavailable.")).toBeTruthy();
  expect(slot.queryByText(/Showing the last/)).toBeNull();
});

it("keeps authentication and plans without limits distinct from loading and errors", async () => {
  const app = await loadPluginApp(() => import("./app"));
  const first = account("signed-out", "claude-code");
  first.usage = { status: "unauthenticated" };
  const second = account("expired", "claude-code");
  second.usage = { status: "expired" };
  const third = account("unlimited", "claude-code");
  third.usage = {
    status: "ok",
    accountEmail: "unlimited@example.com",
    planLabel: null,
    windows: [],
  };
  const slot = renderSlot(
    app.settingsSections[0]!,
    {},
    {
      rpc: {
        getUsage: () => ({
          machines: [machine("source:pool", [first, second, third])],
        }),
      },
    },
  );
  await slot.findByText("Sign in again.");
  expect(slot.getByText("Session expired.")).toBeTruthy();
  expect(
    slot.getByText("No usage limits reported for this plan."),
  ).toBeTruthy();
  expect(slot.queryByText("0% used")).toBeNull();
});
