import type {
  PluginEnvironmentProviderCreateContext,
  PluginEnvironmentProviderProgress,
  PluginEnvironmentProviderRemoveContext,
} from "@get-bb/plugin-sdk/environment-provider";
import {
  createFakePluginHost,
  makeHostResponse,
  makeThreadResponse,
  type FakePluginHarness,
} from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import plugin from "./server.js";
type Project = PluginEnvironmentProviderCreateContext["project"];
type HostRpcCall = FakePluginHarness["experimental_hostRpcCalls"][number];
import { personalWorkspaceHostContract } from "./contract.js";
import { PERSONAL_WORKSPACE_ENVIRONMENT_PROVIDER_ID } from "./provider-id.js";
const HOST_ID = "host_a";
const PROJECT_ID = "personal";
const THREAD_ID = "thr_1";
const DATA_DIR = "/data/plugins/environment-personal-workspace/host-data";

function workspacePathFor(pathKey: string): string {
  return `${DATA_DIR}/workspaces/${pathKey}`;
}

const WORKSPACE_PATH = workspacePathFor(THREAD_ID);

const PROVISION_HOST = makeHostResponse({ id: HOST_ID, name: "Fake machine" });

const PERSONAL_PROJECT: Project = {
  id: PROJECT_ID,
  kind: "personal",
  name: "Personal",
  gitRemoteUrl: null,
  createdAt: 1,
  updatedAt: 1,
};

function createFakeWorkspaceHost() {
  const directories = new Set<string>();
  const busy = new Set<string>();
  const unknownHolders = new Set<string>();
  return {
    directories,
    busy,
    unknownHolders,
    async call(request: HostRpcCall): Promise<unknown> {
      switch (request.method) {
        case "createWorkspace": {
          const input =
            personalWorkspaceHostContract.createWorkspace.input.parse(
              request.input,
            );
          const path = workspacePathFor(input.pathKey);
          directories.add(path);
          return { path };
        }
        case "removeWorkspace": {
          const input =
            personalWorkspaceHostContract.removeWorkspace.input.parse(
              request.input,
            );
          const target = input.path ?? workspacePathFor(input.pathKey);
          if (busy.has(target)) {
            return {
              removed: false,
              holders: [{ pid: 4242, cwd: `${target}/sub` }],
              unknown: null,
              excludedOtherUsers: 0,
              unvouchedHelpers: [],
            };
          }
          if (unknownHolders.has(target)) {
            return {
              removed: false,
              holders: [],
              unknown: "a process's working directory could not be read",
              excludedOtherUsers: null,
              unvouchedHelpers: null,
            };
          }
          return {
            removed: directories.delete(target),
            holders: [],
            unknown: null,
            excludedOtherUsers: 0,
              unvouchedHelpers: [{ pid: 321, comm: "sshd-session" }],
          };
        }
        default:
          throw new Error(`unexpected host method ${request.method}`);
      }
    },
  };
}

type CoveringEnvironment = NonNullable<
  PluginEnvironmentProviderRemoveContext["environment"]
>;

function environmentAt(id: string, path: string): CoveringEnvironment {
  return {
    id,
    name: null,
    projectId: PROJECT_ID,
    hostId: HOST_ID,
    path,
    isGitRepo: false,
    isWorktree: false,
    branchName: null,
    baseBranch: null,
    defaultBranch: null,
    mergeBaseBranch: null,
    status: "ready",
    environmentProviderId: PERSONAL_WORKSPACE_ENVIRONMENT_PROVIDER_ID,
    environmentProviderSelection: null,
    environmentProviderInstanceKey: null,
    lifecycle: { phase: "active", retireAt: null, teardown: null },
    hostLifecycle: "active",
    managed: true,
    workspaceProvisionType: "personal",
    createdAt: 0,
    updatedAt: 0,
  };
}

async function setup(environments: CoveringEnvironment[] = []) {
  const host = createFakeWorkspaceHost();
  const { bb, harness } = createFakePluginHost({
    experimental_callHostRpc: (call) => host.call(call),
    sdk: { environments: { list: async () => environments } },
  });
  await plugin(bb);
  const provider = harness.registrations.environmentProviders.get(
    PERSONAL_WORKSPACE_ENVIRONMENT_PROVIDER_ID,
  );
  if (provider === undefined) throw new Error("Provider not registered");
  const steps: string[] = [];
  const logs: string[] = [];
  const report: PluginEnvironmentProviderProgress = {
    step: (text) => steps.push(text),
    log: (text) => logs.push(text),
  };
  const context: PluginEnvironmentProviderCreateContext = {
    thread: makeThreadResponse({ id: THREAD_ID, projectId: PROJECT_ID }),
    project: PERSONAL_PROJECT,
    host: PROVISION_HOST,
    projectCheckout: null,
    gitRemote: null,
    inputs: null,
    suggestedBranchName: "bb/test",
    attempt: 1,
    pathKey: THREAD_ID,
    experimental_claimPath: async () => true,
    report,
    signal: new AbortController().signal,
  };
  return { host, harness, provider, context, steps, logs };
}

describe("personal workspace resource operations", () => {
  it("creates the directory for the path key core supplies", async () => {
    const f = await setup();
    expect(await f.provider.create(f.context)).toEqual({
      status: "created",
      path: WORKSPACE_PATH,
      ownsPath: true,
    });
    expect(f.steps).toEqual(["Preparing personal workspace…"]);
    expect([...f.host.directories]).toEqual([WORKSPACE_PATH]);
  });
  it("keeps distinct path keys in distinct directories", async () => {
    const f = await setup();
    await f.provider.create(f.context);
    await f.provider.create({ ...f.context, pathKey: "second" });
    expect(f.host.directories.size).toBe(2);
  });
  it("removes the directory core supplies", async () => {
    const f = await setup();
    await f.provider.create(f.context);
    await f.provider.remove({
      environment: null,
      hostId: HOST_ID,
      path: WORKSPACE_PATH,
      pathKey: THREAD_ID,
      resource: null,
      attempt: 1,
      report: f.context.report,
      signal: new AbortController().signal,
    });
    expect(f.host.directories.size).toBe(0);
  });
  it("removes an interrupted directory by path key before core knows its path", async () => {
    const f = await setup();
    await f.provider.create(f.context);
    await f.provider.remove({
      environment: null,
      hostId: HOST_ID,
      path: null,
      pathKey: THREAD_ID,
      resource: null,
      attempt: 1,
      report: f.context.report,
      signal: new AbortController().signal,
    });
    expect(f.host.directories.size).toBe(0);
  });
  it("keeps the directory while another environment still covers it and removes it once that environment is removed", async () => {
    const covering = environmentAt("env_other", WORKSPACE_PATH);
    const f = await setup([covering]);
    await f.provider.create(f.context);
    const removeContext = {
      environment: environmentAt("env_self", WORKSPACE_PATH),
      hostId: HOST_ID,
      path: WORKSPACE_PATH,
      pathKey: THREAD_ID,
      resource: null,
      attempt: 1,
      report: f.context.report,
      signal: new AbortController().signal,
    };
    expect(await f.provider.remove(removeContext)).toEqual({
      status: "retained",
      message:
        "Kept the personal workspace because env_other still covers it. Nothing was removed.",
    });
    expect(f.host.directories.size).toBe(1);
    const released = await setup([
      {
        ...covering,
        lifecycle: {
          phase: "teardown",
          retireAt: 1,
          teardown: { status: "removed", attempt: 1 },
        },
      },
    ]);
    await released.provider.create(released.context);
    expect(await released.provider.remove(removeContext)).toEqual({
      status: "removed",
    });
    expect(released.host.directories.size).toBe(0);
  });
  it("says in the removal log which users' processes were checked", async () => {
    const f = await setup();
    await f.provider.create(f.context);
    await f.provider.remove({
      environment: null,
      hostId: HOST_ID,
      path: WORKSPACE_PATH,
      pathKey: THREAD_ID,
      resource: null,
      attempt: 1,
      report: f.context.report,
      signal: new AbortController().signal,
    });
    expect(f.logs.join("\n")).toContain("Checked the current user's processes");
    expect(f.logs.join("\n")).toContain("sshd-session 321");
  });
  it("keeps the directory and names the process working inside it", async () => {
    const f = await setup();
    await f.provider.create(f.context);
    f.host.busy.add(WORKSPACE_PATH);
    const result = await f.provider.remove({
      environment: null,
      hostId: HOST_ID,
      path: WORKSPACE_PATH,
      pathKey: THREAD_ID,
      resource: null,
      attempt: 1,
      report: f.context.report,
      signal: new AbortController().signal,
    });
    expect(result).toMatchObject({
      status: "retained",
      message: expect.stringContaining("pid 4242"),
    });
    expect(f.host.directories.size).toBe(1);
  });
  it("keeps the directory when holders cannot be established", async () => {
    const f = await setup();
    await f.provider.create(f.context);
    f.host.unknownHolders.add(WORKSPACE_PATH);
    const result = await f.provider.remove({
      environment: null,
      hostId: HOST_ID,
      path: WORKSPACE_PATH,
      pathKey: THREAD_ID,
      resource: null,
      attempt: 1,
      report: f.context.report,
      signal: new AbortController().signal,
    });
    expect(result).toMatchObject({
      status: "retained",
      message: expect.stringContaining("could not be established"),
    });
    expect(f.host.directories.size).toBe(1);
  });
  it("does not count its own row as covering the directory when the remove request carries no environment", async () => {
    const own = environmentAt("env_self", WORKSPACE_PATH);
    const f = await setup([
      {
        ...own,
        environmentProviderInstanceKey: THREAD_ID,
      },
    ]);
    await f.provider.create(f.context);
    expect(
      await f.provider.remove({
        environment: null,
        hostId: HOST_ID,
        path: WORKSPACE_PATH,
        pathKey: THREAD_ID,
        resource: null,
        attempt: 1,
        report: f.context.report,
        signal: new AbortController().signal,
      }),
    ).toEqual({ status: "removed" });
    expect(f.host.directories.size).toBe(0);
  });
});
