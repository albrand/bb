import { expect, it, vi } from "vitest";
import {
  createFakePluginHost,
  makeHostResponse,
} from "@get-bb/plugin-sdk/testing";
import plugin from "./server.js";
import { usageListMethod, usageFetchMethod } from "./usage-source-contract.js";
import { usageSnapshotSchema } from "./usage-schema.js";

it("preserves a restarting host status while usage is temporarily unavailable", async () => {
  const host = createFakePluginHost({
    pluginId: "provider-usage",
    sdk: {
      system: { config: async () => ({ primaryHostId: null }) },
      hosts: {
        list: async () => [
          makeHostResponse({
            id: "host",
            name: "Studio",
            status: "restarting",
          }),
        ],
      },
      providers: { list: async () => [] },
      plugins: { experimental_discoverRpc: async () => [] },
    },
  });
  plugin(host.bb);
  try {
    await expect(
      host.harness.behavior.callRpc("getUsage", {
        force: false,
        machineIds: null,
        providerId: null,
        maxAgeMs: 60_000,
      }),
    ).resolves.toEqual({
      machines: [
        {
          id: "host",
          displayName: "Studio",
          status: "restarting",
          providers: [],
          error: null,
        },
      ],
    });
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

it("lists cheaply, fetches only an explicit source/provider, preserves per-account failures, and evicts removed resources", async () => {
  let enabled = true;
  let failure = false;
  let failedResourceId: string | null = null;
  let hasWork = true;
  let expiredWindows = false;
  const rpc = vi.fn(async ({ pluginId, method, input }) => {
    if (method === usageListMethod)
      return pluginId === "pool"
        ? {
            label: "Account Pooler",
            resources: [
              {
                id: "claude",
                providerId: "claude-code",
                label: "claude@example.com",
                scope: { kind: "shared" },
              },
              {
                id: "personal",
                providerId: "codex",
                label: "personal@example.com",
                scope: { kind: "shared" },
              },
              ...(hasWork
                ? [
                    {
                      id: "work",
                      providerId: "codex",
                      label: "work@example.com",
                      scope: { kind: "shared" },
                    },
                  ]
                : []),
            ],
          }
        : {
            resources: [
              {
                id: "host",
                providerId: "codex",
                label: "Codex",
                scope: { kind: "host", hostId: "host", hostName: "Machine" },
              },
            ],
          };
    if (failure || failedResourceId === input.resourceId)
      throw new Error("Upstream failed");
    return {
      observedAt: 123,
      usage: {
        status: "ok",
        accountEmail: `${input.resourceId}@example.com`,
        planLabel: null,
        windows: [
          {
            id: "week",
            label: "Weekly",
            usedPercent: 42,
            resetsAt: expiredWindows
              ? new Date(Date.now() - 60_000).toISOString()
              : null,
            model: null,
            cost: null,
          },
        ],
      },
    };
  });
  const host = createFakePluginHost({
    pluginId: "provider-usage",
    sdk: {
      system: { config: async () => ({ primaryHostId: null }) },
      hosts: {
        list: async () => [
          makeHostResponse({
            id: "host",
            name: "Machine",
            status: "connected",
          }),
        ],
      },
      providers: {
        list: async () => [
          { id: "codex", displayName: "Codex", logoUrl: "/codex.svg" },
          {
            id: "claude-code",
            displayName: "Claude Code",
            logoUrl: "/claude.svg",
          },
        ],
      },
      plugins: {
        experimental_discoverRpc: async () =>
          enabled
            ? [
                {
                  pluginId: "pool",
                  displayName: "Account Pooler",
                  method: usageListMethod,
                },
                {
                  pluginId: "local",
                  displayName: "Codex",
                  method: usageListMethod,
                },
              ]
            : [],
        callRpc: rpc,
      },
    },
  });
  plugin(host.bb);
  const request = {
    force: false,
    machineIds: null,
    providerId: null,
    maxAgeMs: 60_000,
  };
  try {
    const listed = await host.harness.behavior.callRpc("getUsage", request);
    expect(listed).toMatchObject({
      machines: [
        { id: "host" },
        {
          id: "source:pool",
          providers: [
            { providerId: "codex", usage: null },
            { providerId: "codex", usage: null },
            { providerId: "claude-code", usage: null },
          ],
        },
      ],
    });
    expect(
      rpc.mock.calls.some(([args]) => args.method === usageFetchMethod),
    ).toBe(false);
    await host.harness.behavior.callRpc("getUsage", {
      ...request,
      providerId: "codex",
    });
    await host.harness.behavior.callRpc("getUsage", {
      ...request,
      providerId: "claude-code",
    });
    expect(
      rpc.mock.calls
        .filter(([args]) => args.method === usageFetchMethod)
        .map(([args]) => args.input.resourceId)
        .sort(),
    ).toEqual(["claude", "host", "personal", "work"]);
    rpc.mockClear();
    const target = {
      ...request,
      force: true,
      machineIds: ["source:pool"],
      providerId: "codex",
    };
    await host.harness.behavior.callRpc("getUsage", target);
    expect(
      rpc.mock.calls
        .filter(([args]) => args.method === usageFetchMethod)
        .map(([args]) => [
          args.pluginId,
          args.input.resourceId,
          args.input.refresh,
        ]),
    ).toEqual([
      ["pool", "personal", true],
      ["pool", "work", true],
    ]);
    await host.harness.behavior.callRpc("getUsage", {
      ...target,
      force: false,
    });
    expect(
      rpc.mock.calls.filter(([args]) => args.method === usageFetchMethod),
    ).toHaveLength(2);
    failure = true;
    expect(
      await host.harness.behavior.callRpc("getUsage", {
        ...target,
        providerId: "codex",
        force: true,
      }),
    ).toMatchObject({
      machines: [
        { id: "host", providers: [{ usage: { status: "ok" } }] },
        {
          id: "source:pool",
          error: null,
          providers: [
            { usage: { status: "error" } },
            { usage: { status: "error" } },
            { usage: { status: "ok" } },
          ],
        },
      ],
    });
    failure = false;
    failedResourceId = "work";
    rpc.mockClear();
    const partialRefresh = await host.harness.behavior.callRpc("getUsage", {
      ...target,
      providerId: "codex",
      force: true,
    });
    expect(partialRefresh).toMatchObject({
      machines: [
        { id: "host" },
        {
          id: "source:pool",
          error: null,
          providers: [
            { id: "pool:personal", usage: { status: "ok" } },
            { id: "pool:work", usage: { status: "error" } },
            { id: "pool:claude", usage: { status: "ok" } },
          ],
        },
      ],
    });
    expect(
      rpc.mock.calls
        .filter(([args]) => args.method === usageFetchMethod)
        .map(([args]) => args.input.resourceId)
        .sort(),
    ).toEqual(["personal", "work"]);
    failedResourceId = null;
    failure = false;
    hasWork = false;
    expect(
      await host.harness.behavior.callRpc("getUsage", {
        ...target,
        providerId: "codex",
        force: true,
      }),
    ).toMatchObject({
      machines: [
        { id: "host" },
        {
          id: "source:pool",
          error: null,
          providers: [{ id: "pool:personal" }, { id: "pool:claude" }],
        },
      ],
    });
    await host.harness.behavior.callRpc("getUsage", {
      ...target,
      providerId: "claude-code",
    });
    expect(
      rpc.mock.calls
        .filter(([args]) => args.method === usageFetchMethod)
        .at(-1)?.[0].input.resourceId,
    ).toBe("claude");
    await host.harness.behavior.callRpc("getUsage", {
      ...target,
      machineIds: null,
    });
    expect(
      rpc.mock.calls
        .filter(([args]) => args.method === usageFetchMethod)
        .at(-1)?.[0].pluginId,
    ).toBe("local");
    expiredWindows = true;
    const stale = usageSnapshotSchema.parse(
      await host.harness.behavior.callRpc("getUsage", {
        ...target,
        force: true,
      }),
    );
    const pool = stale.machines.find((machine) => machine.id === "source:pool");
    expect(pool?.error).toBeNull();
    expect(
      pool?.providers.find((provider) => provider.id === "pool:personal")
        ?.usage,
    ).toEqual({
      status: "error",
      message: "Usage data is stale. Refresh usage.",
    });
    enabled = false;
    expect(
      await host.harness.behavior.callRpc("getUsage", request),
    ).toMatchObject({ machines: [{ id: "host", providers: [] }] });
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

it("keeps an unconfigured shared group without hosts or measurement requests", async () => {
  const rpc = vi.fn(async () => ({ label: "Account Pooler", resources: [] }));
  const host = createFakePluginHost({
    pluginId: "provider-usage",
    sdk: {
      system: { config: async () => ({ primaryHostId: null }) },
      hosts: { list: async () => [] },
      providers: { list: async () => [] },
      plugins: {
        experimental_discoverRpc: async () => [
          { pluginId: "pool", displayName: "Pool", method: usageListMethod },
        ],
        callRpc: rpc,
      },
    },
  });
  plugin(host.bb);
  try {
    await expect(
      host.harness.behavior.callRpc("getUsage", {
        force: false,
        machineIds: null,
        providerId: null,
        maxAgeMs: 0,
      }),
    ).resolves.toEqual({
      machines: [
        {
          id: "source:pool",
          displayName: "Account Pooler",
          status: "connected",
          providers: [],
          error: null,
        },
      ],
    });
    expect(rpc).toHaveBeenCalledTimes(1);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

it("collapses known account observations per machine, preserves unknown identities, and normalizes display labels", async () => {
  const { bb, harness } = createFakePluginHost({
    sdk: {
      system: { config: async () => ({ primaryHostId: null }) },
      hosts: {
        list: async () => [
          makeHostResponse({ id: "host", status: "connected" }),
        ],
      },
      providers: { list: async () => [] },
      plugins: {
        experimental_discoverRpc: async () => [
          { pluginId: "adapter", displayName: "Adapter" },
          { pluginId: "custom", displayName: "Custom" },
        ],
        callRpc: async ({ pluginId, method }) =>
          method === usageListMethod
            ? {
                resources: [
                  {
                    id: "account",
                    providerId: "codex",
                    accountKey: null,
                    label: "same@example.com",
                    scope: { kind: "host", hostId: "host", hostName: "Host" },
                  },
                  {
                    id: "unknown",
                    providerId: "other",
                    accountKey: null,
                    label: "same@example.com",
                    scope: { kind: "host", hostId: "host", hostName: "Host" },
                  },
                ],
              }
            : {
                accountKey: "issuer:account:1",
                observedAt: 123,
                usage: {
                  status: "ok",
                  accountEmail: "same@example.com",
                  planLabel: "max",
                  plan: { id: "max", multiplier: 20 },
                  windows: [
                    {
                      id: "week",
                      kind: "weekly",
                      label: "168 hour window",
                      model: null,
                      resetsAt: null,
                      cost: null,
                      usedPercent: pluginId === "adapter" ? 42 : 81,
                    },
                  ],
                },
              },
      },
    },
  });
  try {
    plugin(bb);
    const snapshot = await harness.behavior.callRpc("getUsage", {
      force: false,
      machineIds: ["host"],
      providerId: "codex",
      maxAgeMs: 0,
    });
    expect(snapshot).toMatchObject({
      machines: [
        {
          providers: [
            {
              id: "adapter:account",
              usage: {
                planLabel: "Max (20x)",
                windows: [{ label: "Weekly limit", usedPercent: 42 }],
              },
            },
            { id: "adapter:unknown", usage: null },
            { id: "custom:unknown", usage: null },
          ],
        },
      ],
    });
    expect(JSON.stringify(snapshot)).not.toContain("81");
  } finally {
    await harness.lifecycle.dispose();
  }
});
