import { environments } from "@bb/db";
import { validatePluginEnvironmentProviderDeclaration } from "@get-bb/plugin-sdk/internal/host-policy";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { settleUnclaimedEnvironmentTeardown } from "../../../src/services/environments/environment-engine.js";
import { setPluginEnvironmentProviderBridge } from "../../../src/services/plugins/plugin-environment-provider-registry.js";
import { invokePluginInline } from "../../../src/services/plugins/plugin-hook-registry.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
} from "../../helpers/seed.js";
import {
  withTestHarness,
  type TestAppHarness,
} from "../../helpers/test-app.js";

const faults = vi.hoisted(() => ({ nullHostFor: new Set<string>() }));

vi.mock("@bb/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@bb/db")>();
  return {
    ...actual,
    getEnvironment: (...args: Parameters<typeof actual.getEnvironment>) => {
      const found = actual.getEnvironment(...args);
      return found !== null && faults.nullHostFor.has(found.id)
        ? { ...found, hostId: null as never }
        : found;
    },
  };
});

const PLUGIN_ID = "null-host";
const PROVIDER_ID = "null-host-provider";

afterEach(() => {
  faults.nullHostFor.clear();
  setPluginEnvironmentProviderBridge(undefined);
});

function installProvider(): void {
  const record = {
    pluginId: PLUGIN_ID,
    provider: validatePluginEnvironmentProviderDeclaration({
      id: PROVIDER_ID,
      displayName: "Null host",
      description: "Exercises the resumed-restore guard.",
      icon: "Folder",
      create: async () => {
        throw new Error("Unexpected create");
      },
      remove: async () => ({ status: "removed" }),
    }),
  };
  setPluginEnvironmentProviderBridge({
    listEnvironmentProviders: () => [record],
    getEnvironmentProvider: (id) =>
      id === record.provider.id ? record : undefined,
    invokeProvider: (_pluginId, _label, run) => invokePluginInline(run),
    decisionTimeoutMs: 10_000,
  });
}

function seedInterruptedAttempt(harness: TestAppHarness) {
  const { host } = seedHostSession(harness.deps, { id: "host_null_host" });
  const { project } = seedProjectWithSource(harness.deps, {
    hostId: host.id,
    path: "/tmp/null-host-project",
  });
  const environment = seedEnvironment(harness.deps, {
    hostId: host.id,
    projectId: project.id,
    path: "/tmp/null-host",
    environmentProviderId: PROVIDER_ID,
    environmentProviderPluginId: PLUGIN_ID,
    environmentProviderInstanceKey: "null-host-key",
    providerOwnsPath: true,
  });
  seedThread(harness.deps, {
    projectId: project.id,
    environmentId: environment.id,
    status: "idle",
  });
  harness.db
    .update(environments)
    .set({
      status: "error",
      teardownStatus: "running",
      teardownAttempt: 1,
      teardownMessage: null,
      teardownPriorStatus: "ready",
      retireAt: Date.now() - 1,
    })
    .where(eq(environments.id, environment.id))
    .run();
  return environment;
}

function readRow(harness: TestAppHarness, environmentId: string) {
  const found = harness.db
    .select()
    .from(environments)
    .where(eq(environments.id, environmentId))
    .get();
  if (found === undefined) throw new Error("Missing environment");
  return found;
}

describe("the resumed-restore guard and the host id of an environment", () => {
  it("never lets a migrated database hold an environment without a host", async () =>
    withTestHarness(async (harness) => {
      const environment = seedInterruptedAttempt(harness);
      const column = harness.db.$client
        .prepare<[], { name: string; notnull: number }>(
          "PRAGMA table_info(environments)",
        )
        .all()
        .find((candidate) => candidate.name === "host_id");
      expect(column?.notnull).toBe(1);
      expect(() =>
        harness.db.$client
          .prepare("UPDATE environments SET host_id = NULL WHERE id = ?")
          .run(environment.id),
      ).toThrow(/NOT NULL constraint failed: environments\.host_id/u);
      expect(readRow(harness, environment.id).hostId).not.toBeNull();
    }));

  it("restores the snapshot of an interrupted attempt whose host id is present (control)", async () =>
    withTestHarness(async (harness) => {
      installProvider();
      const environment = seedInterruptedAttempt(harness);

      settleUnclaimedEnvironmentTeardown(
        harness.deps,
        readRow(harness, environment.id),
      );

      expect(readRow(harness, environment.id)).toMatchObject({
        status: "ready",
        teardownStatus: null,
        teardownPriorStatus: null,
      });
    }));

  it("fails closed if the environment reader ever reports a missing host id (fault-injected getter, not a reachable row)", async () =>
    withTestHarness(async (harness) => {
      installProvider();
      const environment = seedInterruptedAttempt(harness);
      const stale = readRow(harness, environment.id);
      faults.nullHostFor.add(environment.id);

      settleUnclaimedEnvironmentTeardown(harness.deps, stale);

      faults.nullHostFor.clear();
      expect(readRow(harness, environment.id)).toMatchObject({
        status: "error",
        teardownStatus: "failed",
        teardownPriorStatus: null,
        teardownMessage: expect.stringContaining(
          "does not own the path or record a teardown-script row",
        ),
      });
    }));
});
