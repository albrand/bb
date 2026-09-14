import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { AgentRuntime, AgentRuntimeOptions } from "@bb/agent-runtime";
import { readProcessIdentity } from "@bb/agent-runtime";
import { createScriptedEchoLaunch } from "@bb/agent-runtime/test";
import type { ThreadEvent } from "@bb/domain";
import { threadScope, turnScope } from "@bb/domain";
import type { HostDaemonInjectedSkillSource } from "@bb/host-daemon-contract";
import type { HostWatcher } from "@bb/host-watcher";
import {
  provisionWorkspace,
  type HostWorkspace,
  type ProvisionWorkspaceArgs,
} from "@bb/host-workspace";
import {
  createDeferredPromise,
  makeWorkspaceMergeBase,
  makeWorkspaceStatus,
} from "@bb/test-helpers";
import { createBridgeSocketServer } from "@bb/provider-bridge-protocol/bridge-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RuntimeManager,
  SkillCatalogConflictError,
} from "./runtime-manager.js";

type GetCurrentBranchArgs = Parameters<HostWorkspace["getCurrentBranch"]>;
type GetStatusResult = Awaited<ReturnType<HostWorkspace["getStatus"]>>;
type GetDiffResult = Awaited<ReturnType<HostWorkspace["getDiff"]>>;
type GetLocalStateFingerprintResult = Awaited<
  ReturnType<HostWorkspace["getLocalStateFingerprint"]>
>;
type GetSharedGitRefsFingerprintResult = Awaited<
  ReturnType<HostWorkspace["getSharedGitRefsFingerprint"]>
>;
type CommitArgs = Parameters<HostWorkspace["commit"]>;
type ProvisionWorkspaceMockArgs = Parameters<
  (options: ProvisionWorkspaceArgs) => Promise<HostWorkspace>
>;
type EnsureProviderArgs = Parameters<AgentRuntime["ensureProvider"]>[0];
type StartThreadArgs = Parameters<AgentRuntime["startThread"]>[0];
type ResumeThreadArgs = Parameters<AgentRuntime["resumeThread"]>[0];
type RunTurnArgs = Parameters<AgentRuntime["runTurn"]>[0];
type SteerTurnArgs = Parameters<AgentRuntime["steerTurn"]>[0];
type StopThreadArgs = Parameters<AgentRuntime["stopThread"]>[0];
type RenameThreadArgs = Parameters<AgentRuntime["renameThread"]>[0];
type ListModelsArgs = Parameters<AgentRuntime["listModels"]>[0];
interface RunGitOptions {
  cwd: string;
}

interface WriteInjectedSkillSourceArgs {
  dataDir: string;
  name: string;
  token: string;
}

interface RuntimeOptionsRef {
  current: AgentRuntimeOptions | null;
}

interface RuntimeManagerProviderMaintenanceInternals {
  createProviderMaintenanceRuntime: (args: {
    dataDir: string;
  }) => Promise<AgentRuntime>;
  providerMaintenanceRuntime: AgentRuntime | null;
}

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function runGit(
  args: readonly string[],
  options: RunGitOptions,
): Promise<string> {
  const result = await execFileAsync("git", [...args], {
    cwd: options.cwd,
  });
  return result.stdout;
}

async function initRepo(): Promise<string> {
  const repoPath = await makeTempDir("bb-runtime-manager-repo-");
  await runGit(["init", "-b", "main"], { cwd: repoPath });
  await runGit(["config", "user.name", "BB Tests"], { cwd: repoPath });
  await runGit(["config", "user.email", "bb@example.com"], { cwd: repoPath });
  await fs.writeFile(path.join(repoPath, "README.md"), "hello\n", "utf8");
  await runGit(["add", "."], { cwd: repoPath });
  await runGit(["commit", "-m", "Initial commit"], { cwd: repoPath });
  return repoPath;
}

async function writeInjectedSkillSource(
  args: WriteInjectedSkillSourceArgs,
): Promise<Extract<HostDaemonInjectedSkillSource, { kind: "workspace-path" }>> {
  const sourceRootPath = path.join(args.dataDir, "skills", args.name);
  await fs.mkdir(sourceRootPath, { recursive: true });
  await fs.writeFile(
    path.join(sourceRootPath, "SKILL.md"),
    [
      "---",
      `name: ${args.name}`,
      `description: Use ${args.name} when runtime manager tests run.`,
      "---",
      "",
      args.token,
      "",
    ].join("\n"),
    "utf8",
  );
  return {
    kind: "workspace-path",
    sourceType: "project",
    name: args.name,
    description: `Use ${args.name} when runtime manager tests run.`,
    sourceRootPath,
    skillFilePath: path.join(sourceRootPath, "SKILL.md"),
  };
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    tempDirs
      .splice(0)
      .map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

function getProvisionWorkspacePath(args: ProvisionWorkspaceArgs): string {
  return args.path;
}

function createFakeWorkspace(path: string, isGitRepo = true) {
  const status: GetStatusResult = makeWorkspaceStatus({
    mergeBase: makeWorkspaceMergeBase(),
  });
  const diff: GetDiffResult = {
    diff: "",
    truncated: false,
    shortstat: "",
    files: "",
    mergeBaseRef: null,
  };
  let localStateFingerprint: GetLocalStateFingerprintResult = `local:${path}:initial`;
  let localStateFingerprintError: Error | null = null;
  let sharedGitRefsFingerprint: GetSharedGitRefsFingerprintResult = `refs:${path}:initial`;
  let sharedGitRefsFingerprintError: Error | null = null;
  const workspace = {
    path,
    isGitRepo,
    isWorktree: false,
    getDefaultBranch: vi.fn(async () => "main"),
    getCurrentBranch: vi.fn(async (..._args: GetCurrentBranchArgs) => "main"),
    getHeadSha: vi.fn(async () => "commit-1"),
    getLocalStateFingerprint: vi.fn(async () => {
      if (localStateFingerprintError) {
        throw localStateFingerprintError;
      }
      return localStateFingerprint;
    }),
    getSharedGitRefsFingerprint: vi.fn(async () => {
      if (sharedGitRefsFingerprintError) {
        throw sharedGitRefsFingerprintError;
      }
      return sharedGitRefsFingerprint;
    }),
    getAdditionalWorkspaceWriteRoots: vi.fn(async () => []),
    getStatus: vi.fn(async () => status),
    getDiff: vi.fn(async () => diff),
    diffFiles: vi.fn(async () => ({
      files: [],
      shortstat: "",
      mergeBaseRef: null,
      truncated: false,
    })),
    diffPatch: vi.fn(async () => []),
    getPullRequest: vi.fn(async () => ({ outcome: "none" as const })),
    runPullRequestAction: vi.fn(async () => undefined),
    commit: vi.fn(async (..._args: CommitArgs) => ({
      commitSha: "commit-1",
      commitSubject: "commit",
    })),
    setLocalStateFingerprint(value: GetLocalStateFingerprintResult) {
      localStateFingerprint = value;
    },
    setLocalStateFingerprintError(value: Error | null) {
      localStateFingerprintError = value;
    },
    setSharedGitRefsFingerprint(value: GetSharedGitRefsFingerprintResult) {
      sharedGitRefsFingerprint = value;
    },
    setSharedGitRefsFingerprintError(value: Error | null) {
      sharedGitRefsFingerprintError = value;
    },
  } satisfies HostWorkspace & {
    setLocalStateFingerprint: (value: GetLocalStateFingerprintResult) => void;
    setLocalStateFingerprintError: (value: Error | null) => void;
    setSharedGitRefsFingerprint: (
      value: GetSharedGitRefsFingerprintResult,
    ) => void;
    setSharedGitRefsFingerprintError: (value: Error | null) => void;
  };

  return workspace;
}

interface FakeAgentRuntime extends AgentRuntime {
  endActiveTurn: (threadId: string) => void;
  setActiveTurn: (threadId: string, turnId: string) => void;
  setOpenBackgroundWork: (hasOpenWork: boolean) => void;
  setPendingTurnStart: (threadId: string, hasPending: boolean) => void;
}

function createFakeRuntime() {
  const activeTurnsByThreadId = new Map<string, string>();
  let openBackgroundWork = false;
  const pendingTurnStartThreadIds = new Set<string>();
  return {
    ensureProvider: vi.fn(async (_args: EnsureProviderArgs) => undefined),
    startThread: vi.fn(async (_args: StartThreadArgs) => ({
      providerThreadId: "provider-1",
    })),
    prepareThreadRewind: vi.fn(async () => ({
      providerThreadId: "provider-rewind-1",
    })),
    discardThreadRewind: vi.fn(async () => undefined),
    resumeThread: vi.fn(async (_args: ResumeThreadArgs) => ({
      providerThreadId: "provider-1",
    })),
    runTurn: vi.fn(async (_args: RunTurnArgs) => undefined),
    steerTurn: vi.fn(async (_args: SteerTurnArgs) => ({
      status: "steered" as const,
    })),
    stopThread: vi.fn(async (_args: StopThreadArgs) => ({
      providerCheckpointId: null,
    })),
    clearThreadGoal: vi.fn(async () => ({ cleared: true })),
    renameThread: vi.fn(async (_args: RenameThreadArgs) => undefined),
    archiveThread: vi.fn(async () => undefined),
    unarchiveThread: vi.fn(async () => undefined),
    listModels: vi.fn(async (_args: ListModelsArgs) => ({
      models: [],
      selectedOnlyModels: [],
    })),
    providerHealth: vi.fn(async () => ({ supported: false as const })),
    providerUsage: vi.fn(async () => ({ supported: false as const })),
    providerInstallationStatus: vi.fn(async () => {
      throw new Error("Unexpected provider installation status call");
    }),
    providerInstallationRun: vi.fn(async () => {
      throw new Error("Unexpected provider installation run call");
    }),
    listRunningProviders: vi.fn((): string[] => []),
    getActiveTurnId: (threadId) => activeTurnsByThreadId.get(threadId) ?? null,
    waitForActiveTurn: async (threadId) =>
      activeTurnsByThreadId.get(threadId) ?? null,
    getProviderSession: () => null,
    reapIdleProviderSessions: vi.fn<AgentRuntime["reapIdleProviderSessions"]>(
      async () => ({ reapedSessions: [] }),
    ),
    hasThread: (threadId) => activeTurnsByThreadId.has(threadId),
    getLiveThreadIds: () => [
      ...new Set([
        ...activeTurnsByThreadId.keys(),
        ...pendingTurnStartThreadIds,
      ]),
    ],
    hasOpenBackgroundWork: () => openBackgroundWork,
    shutdown: vi.fn(async () => undefined),
    detach: vi.fn(async () => undefined),
    adoptBridgeWorkers: vi.fn(() => []),
    completeBridgeWorkerAdoption: vi.fn(),
    endActiveTurn: (threadId) => {
      activeTurnsByThreadId.delete(threadId);
    },
    setActiveTurn: (threadId, turnId) => {
      activeTurnsByThreadId.set(threadId, turnId);
    },
    setOpenBackgroundWork: (hasOpenWork) => {
      openBackgroundWork = hasOpenWork;
    },
    setPendingTurnStart: (threadId, hasPending) => {
      if (hasPending) {
        pendingTurnStartThreadIds.add(threadId);
      } else {
        pendingTurnStartThreadIds.delete(threadId);
      }
    },
  } satisfies FakeAgentRuntime;
}

function isPidAlive(pid: number): boolean {
  if (pid === 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function createProvisionWorkspaceMock(path: string) {
  return vi.fn(async (..._args: ProvisionWorkspaceMockArgs) =>
    createFakeWorkspace(path),
  );
}

describe("RuntimeManager", () => {
  it("creates a runtime the first time an environment is requested", async () => {
    const provisionWorkspace = createProvisionWorkspaceMock("/tmp/env-1");
    const createRuntime = vi.fn(() => createFakeRuntime());
    const manager = new RuntimeManager({
      provisionWorkspace,
      createRuntime,
    });

    const entry = await manager.ensureEnvironment({
      environmentId: "env-1",
      workspacePath: "/tmp/env-1",
    });

    expect(provisionWorkspace).toHaveBeenCalledTimes(1);
    expect(createRuntime).toHaveBeenCalledTimes(1);
    expect(entry.path).toBe("/tmp/env-1");
  });

  it("refreshes the workspace on the resident runtime entry", async () => {
    const plainWorkspace = createFakeWorkspace("/tmp/env-refresh", false);
    const gitWorkspace = createFakeWorkspace("/tmp/env-refresh");
    const provisionWorkspace = vi
      .fn<(options: ProvisionWorkspaceArgs) => Promise<HostWorkspace>>()
      .mockResolvedValueOnce(plainWorkspace)
      .mockResolvedValueOnce(gitWorkspace);
    const manager = new RuntimeManager({
      provisionWorkspace,
      createRuntime: () => createFakeRuntime(),
    });
    const entry = await manager.ensureEnvironment({
      environmentId: "env-refresh",
      workspacePath: "/tmp/env-refresh",
    });

    const refreshed = await manager.refreshEnvironmentWorkspace({
      environmentId: "env-refresh",
      provision: {
        path: "/tmp/env-refresh",
      },
      workspacePath: "/tmp/env-refresh",
    });

    expect(refreshed).toBe(gitWorkspace);
    expect(entry.workspace).toBe(gitWorkspace);
    expect(manager.get("env-refresh")?.workspace).toBe(gitWorkspace);
    expect(provisionWorkspace).toHaveBeenCalledTimes(2);
  });

  it("reaps idle provider sessions from loaded runtimes", async () => {
    const firstRuntime = createFakeRuntime();
    const secondRuntime = createFakeRuntime();
    firstRuntime.reapIdleProviderSessions.mockResolvedValue({
      reapedSessions: [
        {
          idleForMs: 1_500,
          providerId: "codex",
          providerThreadId: "provider-thread-1",
          threadId: "thread-1",
        },
      ],
    });
    secondRuntime.reapIdleProviderSessions.mockResolvedValue({
      reapedSessions: [
        {
          idleForMs: 2_500,
          providerId: "codex",
          providerThreadId: "provider-thread-2",
          threadId: "thread-2",
        },
      ],
    });
    const runtimes = [firstRuntime, secondRuntime];
    const createRuntime = vi.fn(() => {
      const runtime = runtimes.shift();
      if (!runtime) {
        throw new Error("Unexpected runtime creation");
      }
      return runtime;
    });
    const manager = new RuntimeManager({
      provisionWorkspace: createProvisionWorkspaceMock("/tmp/env-1"),
      createRuntime,
    });

    await manager.ensureEnvironment({
      environmentId: "env-1",
      workspacePath: "/tmp/env-1",
    });
    await manager.ensureEnvironment({
      environmentId: "env-2",
      workspacePath: "/tmp/env-2",
    });

    await expect(
      manager.reapIdleProviderSessions({
        idleForMs: 1_000,
        nowMs: 5_000,
      }),
    ).resolves.toEqual({
      reapedSessions: [
        {
          environmentId: "env-1",
          idleForMs: 1_500,
          providerId: "codex",
          providerThreadId: "provider-thread-1",
          threadId: "thread-1",
        },
        {
          environmentId: "env-2",
          idleForMs: 2_500,
          providerId: "codex",
          providerThreadId: "provider-thread-2",
          threadId: "thread-2",
        },
      ],
    });
    expect(firstRuntime.reapIdleProviderSessions).toHaveBeenCalledWith({
      idleForMs: 1_000,
      nowMs: 5_000,
      runThreadExclusive: expect.any(Function),
    });
    expect(secondRuntime.reapIdleProviderSessions).toHaveBeenCalledWith({
      idleForMs: 1_000,
      nowMs: 5_000,
      runThreadExclusive: expect.any(Function),
    });
  });

  it("does not release a session while its thread command is in flight", async () => {
    const runtime = createFakeRuntime();
    const releaseWork = vi.fn(async () => ({
      idleForMs: 2_000,
      providerId: "claude-code",
      providerThreadId: "provider-thread-1",
      threadId: "thread-1",
    }));
    runtime.reapIdleProviderSessions.mockImplementation(async (args) => {
      if (!args.runThreadExclusive) {
        throw new Error("Expected thread control callback");
      }
      const released = await args.runThreadExclusive("thread-1", releaseWork);
      return { reapedSessions: released ? [released] : [] };
    });
    const manager = new RuntimeManager({
      provisionWorkspace: createProvisionWorkspaceMock("/tmp/env-1"),
      createRuntime: () => runtime,
    });
    await manager.ensureEnvironment({
      environmentId: "env-1",
      workspacePath: "/tmp/env-1",
    });
    const finishCommand = await manager.retainEnvironmentForThreadCommand(
      "env-1",
      "thread-1",
    );

    const result = await manager.reapIdleProviderSessions({
      idleForMs: 1_000,
      nowMs: 5_000,
    });

    expect(result.reapedSessions).toEqual([]);
    expect(releaseWork).not.toHaveBeenCalled();
    finishCommand();
  });

  it("passes staged injected skill roots to created runtimes", async () => {
    const dataDir = await makeTempDir("bb-runtime-manager-skills-");
    const source = await writeInjectedSkillSource({
      dataDir,
      name: "release-notes",
      token: "first-token",
    });
    const provisionWorkspace = createProvisionWorkspaceMock("/tmp/env-1");
    const runtimeOptions: RuntimeOptionsRef = { current: null };
    const manager = new RuntimeManager({
      dataDir,
      provisionWorkspace,
      createRuntime: (options) => {
        runtimeOptions.current = options;
        return createFakeRuntime();
      },
    });

    const entry = await manager.ensureEnvironment({
      environmentId: "env-skills",
      injectedSkillSources: [source],
      workspacePath: "/tmp/env-1",
    });

    expect(entry.skillCatalogHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(runtimeOptions.current?.skillRoots).toEqual([
      {
        id: `global-skills:${entry.skillCatalogHash}`,
        path: path.join(
          dataDir,
          "runtime",
          "global-skills",
          entry.skillCatalogHash ?? "",
          "skills",
        ),
        skills: [
          {
            description: "Use release-notes when runtime manager tests run.",
            name: "release-notes",
          },
        ],
      },
    ]);
  });

  it("loads a thread command's skill catalog while that command retains an idle runtime", async () => {
    const dataDir = await makeTempDir("bb-runtime-manager-command-skills-");
    const source = await writeInjectedSkillSource({
      dataDir,
      name: "release-notes",
      token: "first-token",
    });
    const provisionWorkspace = createProvisionWorkspaceMock("/tmp/env-1");
    const firstRuntime = createFakeRuntime();
    const secondRuntime = createFakeRuntime();
    const createRuntime = vi
      .fn()
      .mockReturnValueOnce(firstRuntime)
      .mockReturnValueOnce(secondRuntime);
    const manager = new RuntimeManager({
      dataDir,
      provisionWorkspace,
      createRuntime,
    });

    const initialEntry = await manager.ensureEnvironment({
      environmentId: "env-skills",
      workspacePath: "/tmp/env-1",
    });
    const release = await manager.retainEnvironmentForThreadCommand(
      "env-skills",
      "thread-1",
    );
    try {
      const configuredEntry = await manager.ensureEnvironment({
        environmentId: "env-skills",
        injectedSkillSources: [source],
        targetThreadId: "thread-1",
        workspacePath: "/tmp/env-1",
      });

      expect(configuredEntry).not.toBe(initialEntry);
      expect(configuredEntry.skillCatalogHash).not.toBeNull();
      expect(firstRuntime.shutdown).toHaveBeenCalledTimes(1);
      expect(createRuntime).toHaveBeenCalledTimes(2);
    } finally {
      release();
    }
  });

  it("does not reuse an idle runtime with a stale skill catalog hash", async () => {
    const dataDir = await makeTempDir("bb-runtime-manager-skills-stale-");
    const source = await writeInjectedSkillSource({
      dataDir,
      name: "release-notes",
      token: "first-token",
    });
    const provisionWorkspace = createProvisionWorkspaceMock("/tmp/env-1");
    const runtimes = [createFakeRuntime(), createFakeRuntime()];
    const createRuntime = vi.fn(() => {
      const runtime = runtimes.shift();
      if (!runtime) {
        throw new Error("Unexpected runtime creation");
      }
      return runtime;
    });
    const manager = new RuntimeManager({
      dataDir,
      provisionWorkspace,
      createRuntime,
    });

    const firstEntry = await manager.ensureEnvironment({
      environmentId: "env-skills",
      injectedSkillSources: [source],
      workspacePath: "/tmp/env-1",
    });
    await fs.writeFile(
      source.skillFilePath,
      [
        "---",
        "name: release-notes",
        "description: Use release-notes when runtime manager tests run.",
        "---",
        "",
        "second-token",
        "",
      ].join("\n"),
      "utf8",
    );
    const secondEntry = await manager.ensureEnvironment({
      environmentId: "env-skills",
      injectedSkillSources: [source],
      workspacePath: "/tmp/env-1",
    });

    expect(secondEntry).not.toBe(firstEntry);
    expect(secondEntry.skillCatalogHash).not.toBe(firstEntry.skillCatalogHash);
    expect(createRuntime).toHaveBeenCalledTimes(2);
    expect(firstEntry.runtime.shutdown).toHaveBeenCalledTimes(1);
  });

  it("reuses a busy runtime with a stale skill catalog and refreshes it once idle", async () => {
    const dataDir = await makeTempDir("bb-runtime-manager-skills-defer-");
    const source = await writeInjectedSkillSource({
      dataDir,
      name: "release-notes",
      token: "first-token",
    });
    const provisionWorkspace = createProvisionWorkspaceMock("/tmp/env-1");
    const runtimes: ReturnType<typeof createFakeRuntime>[] = [];
    const createRuntime = vi.fn(() => {
      const runtime = createFakeRuntime();
      runtimes.push(runtime);
      return runtime;
    });
    const manager = new RuntimeManager({
      dataDir,
      provisionWorkspace,
      createRuntime,
    });

    const firstEntry = await manager.ensureEnvironment({
      environmentId: "env-skills",
      injectedSkillSources: [source],
      workspacePath: "/tmp/env-1",
    });
    const firstCatalogHash = firstEntry.skillCatalogHash;
    runtimes[0]?.setActiveTurn("thread-1", "turn-1");
    await writeInjectedSkillSource({
      dataDir,
      name: "release-notes",
      token: "second-token",
    });

    const busyEntry = await manager.ensureEnvironment({
      environmentId: "env-skills",
      injectedSkillSources: [source],
      targetThreadId: "thread-1",
      workspacePath: "/tmp/env-1",
    });

    expect(busyEntry).toBe(firstEntry);
    expect(busyEntry.skillCatalogHash).toBe(firstCatalogHash);
    expect(createRuntime).toHaveBeenCalledTimes(1);
    expect(firstEntry.runtime.shutdown).not.toHaveBeenCalled();

    runtimes[0]?.endActiveTurn("thread-1");
    const idleEntry = await manager.ensureEnvironment({
      environmentId: "env-skills",
      injectedSkillSources: [source],
      targetThreadId: "thread-1",
      workspacePath: "/tmp/env-1",
    });

    expect(idleEntry).not.toBe(firstEntry);
    expect(idleEntry.skillCatalogHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(idleEntry.skillCatalogHash).not.toBe(firstCatalogHash);
    expect(createRuntime).toHaveBeenCalledTimes(2);
    expect(firstEntry.runtime.shutdown).toHaveBeenCalledTimes(1);
  });

  it("replaces an idle runtime that hosts the target thread and keeps the new staged catalog", async () => {
    const dataDir = await makeTempDir("bb-runtime-manager-skills-idle-host-");
    const source = await writeInjectedSkillSource({
      dataDir,
      name: "release-notes",
      token: "first-token",
    });
    const provisionWorkspace = createProvisionWorkspaceMock("/tmp/env-1");
    const createRuntime = vi.fn(() => createFakeRuntime());
    const manager = new RuntimeManager({
      dataDir,
      provisionWorkspace,
      createRuntime,
    });

    const firstEntry = await manager.ensureEnvironment({
      environmentId: "env-skills",
      injectedSkillSources: [source],
      workspacePath: "/tmp/env-1",
    });
    await writeInjectedSkillSource({
      dataDir,
      name: "release-notes",
      token: "second-token",
    });

    const secondEntry = await manager.ensureEnvironment({
      environmentId: "env-skills",
      injectedSkillSources: [source],
      targetThreadId: "thread-1",
      workspacePath: "/tmp/env-1",
    });

    expect(secondEntry).not.toBe(firstEntry);
    expect(firstEntry.skillCatalogHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(secondEntry.skillCatalogHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(secondEntry.skillCatalogHash).not.toBe(firstEntry.skillCatalogHash);
    expect(createRuntime).toHaveBeenCalledTimes(2);
    expect(firstEntry.runtime.shutdown).toHaveBeenCalledTimes(1);

    const stagingRoot = path.join(dataDir, "runtime", "global-skills");
    const newCatalogStat = await fs.stat(
      path.join(stagingRoot, secondEntry.skillCatalogHash ?? ""),
    );
    expect(newCatalogStat.isDirectory()).toBe(true);
    await expect(
      fs.stat(path.join(stagingRoot, firstEntry.skillCatalogHash ?? "")),
    ).rejects.toThrow();
  });

  it("keeps the staged catalog of an environment still being created while another environment swaps catalogs", async () => {
    const dataDir = await makeTempDir("bb-runtime-manager-skills-pending-");
    const sourceA = await writeInjectedSkillSource({
      dataDir,
      name: "release-notes",
      token: "env-a-token",
    });
    const provisionStarted = createDeferredPromise<void>();
    const releaseProvision = createDeferredPromise<void>();
    const provisionWorkspace = vi.fn(
      async (options: ProvisionWorkspaceArgs) => {
        const targetPath = "path" in options ? options.path : undefined;
        if (targetPath === "/tmp/env-a") {
          provisionStarted.resolve();
          await releaseProvision.promise;
        }
        return createFakeWorkspace(targetPath ?? "/tmp/env");
      },
    );
    const manager = new RuntimeManager({
      dataDir,
      provisionWorkspace,
      createRuntime: vi.fn(() => createFakeRuntime()),
    });

    const envA = manager.ensureEnvironment({
      environmentId: "env-a",
      injectedSkillSources: [sourceA],
      workspacePath: "/tmp/env-a",
    });
    await provisionStarted.promise;

    const sourceB = await writeInjectedSkillSource({
      dataDir,
      name: "other-notes",
      token: "env-b-first",
    });
    const firstB = await manager.ensureEnvironment({
      environmentId: "env-b",
      injectedSkillSources: [sourceB],
      workspacePath: "/tmp/env-b",
    });
    await writeInjectedSkillSource({
      dataDir,
      name: "other-notes",
      token: "env-b-second",
    });
    const secondB = await manager.ensureEnvironment({
      environmentId: "env-b",
      injectedSkillSources: [sourceB],
      targetThreadId: "thread-b",
      workspacePath: "/tmp/env-b",
    });
    expect(secondB.skillCatalogHash).not.toBe(firstB.skillCatalogHash);

    releaseProvision.resolve();
    const entryA = await envA;
    expect(entryA.skillCatalogHash).toMatch(/^[a-f0-9]{64}$/u);
    const stagingRoot = path.join(dataDir, "runtime", "global-skills");
    const catalogAStat = await fs.stat(
      path.join(stagingRoot, entryA.skillCatalogHash ?? ""),
    );
    expect(catalogAStat.isDirectory()).toBe(true);
    await expect(
      fs.stat(path.join(stagingRoot, firstB.skillCatalogHash ?? "")),
    ).rejects.toThrow();
  });

  it("reuses a busy runtime for a target thread it does not host yet", async () => {
    const dataDir = await makeTempDir("bb-runtime-manager-skills-unhosted-");
    const source = await writeInjectedSkillSource({
      dataDir,
      name: "release-notes",
      token: "first-token",
    });
    const provisionWorkspace = createProvisionWorkspaceMock("/tmp/env-1");
    const runtime = createFakeRuntime();
    const createRuntime = vi.fn(() => runtime);
    const manager = new RuntimeManager({
      dataDir,
      provisionWorkspace,
      createRuntime,
    });

    const firstEntry = await manager.ensureEnvironment({
      environmentId: "env-skills",
      injectedSkillSources: [source],
      workspacePath: "/tmp/env-1",
    });
    runtime.setActiveTurn("other-thread", "turn-1");
    await writeInjectedSkillSource({
      dataDir,
      name: "release-notes",
      token: "second-token",
    });

    const secondEntry = await manager.ensureEnvironment({
      environmentId: "env-skills",
      injectedSkillSources: [source],
      targetThreadId: "thread-1",
      workspacePath: "/tmp/env-1",
    });

    expect(secondEntry).toBe(firstEntry);
    expect(createRuntime).toHaveBeenCalledTimes(1);
    expect(firstEntry.runtime.shutdown).not.toHaveBeenCalled();
  });

  it("reuses a runtime pinned busy by a terminal when a thread brings skill sources", async () => {
    const dataDir = await makeTempDir("bb-runtime-manager-skills-terminal-");
    const source = await writeInjectedSkillSource({
      dataDir,
      name: "release-notes",
      token: "first-token",
    });
    const provisionWorkspace = createProvisionWorkspaceMock("/tmp/env-1");
    const createRuntime = vi.fn(() => createFakeRuntime());
    const manager = new RuntimeManager({
      dataDir,
      provisionWorkspace,
      createRuntime,
    });

    const terminalEntry = await manager.ensureEnvironment({
      environmentId: "env-skills",
      workspacePath: "/tmp/env-1",
    });
    manager.markTerminalActive("env-skills", "terminal-1");

    const threadEntry = await manager.ensureEnvironment({
      environmentId: "env-skills",
      injectedSkillSources: [source],
      targetThreadId: "thread-1",
      workspacePath: "/tmp/env-1",
    });

    expect(threadEntry).toBe(terminalEntry);
    expect(threadEntry.skillCatalogHash).toBeNull();
    expect(createRuntime).toHaveBeenCalledTimes(1);
    expect(terminalEntry.runtime.shutdown).not.toHaveBeenCalled();
  });

  it("rejects a stale skill catalog on a busy runtime when no thread targets it", async () => {
    const dataDir = await makeTempDir("bb-runtime-manager-skills-conflict-");
    const source = await writeInjectedSkillSource({
      dataDir,
      name: "release-notes",
      token: "first-token",
    });
    const provisionWorkspace = createProvisionWorkspaceMock("/tmp/env-1");
    const runtime = createFakeRuntime();
    const createRuntime = vi.fn(() => runtime);
    const manager = new RuntimeManager({
      dataDir,
      provisionWorkspace,
      createRuntime,
    });

    const firstEntry = await manager.ensureEnvironment({
      environmentId: "env-skills",
      injectedSkillSources: [source],
      workspacePath: "/tmp/env-1",
    });
    runtime.setActiveTurn("thread-1", "turn-1");
    await writeInjectedSkillSource({
      dataDir,
      name: "release-notes",
      token: "second-token",
    });

    await expect(
      manager.ensureEnvironment({
        environmentId: "env-skills",
        injectedSkillSources: [source],
        workspacePath: "/tmp/env-1",
      }),
    ).rejects.toBeInstanceOf(SkillCatalogConflictError);
    expect(createRuntime).toHaveBeenCalledTimes(1);
    expect(firstEntry.runtime.shutdown).not.toHaveBeenCalled();
  });

  it("passes unmanaged linked worktree git metadata roots to created runtimes", async () => {
    const repoPath = await initRepo();
    const parentDir = await makeTempDir("bb-runtime-manager-unmanaged-wt-");
    const worktreePath = path.join(parentDir, "env");
    await runGit(["worktree", "add", "-B", "bb/unmanaged", worktreePath], {
      cwd: repoPath,
    });
    const runtimeOptions: RuntimeOptionsRef = { current: null };
    const manager = new RuntimeManager({
      provisionWorkspace,
      createRuntime: (options) => {
        runtimeOptions.current = options;
        return createFakeRuntime();
      },
    });

    await manager.ensureEnvironment({
      environmentId: "env-unmanaged-roots",
      provision: {
        path: worktreePath,
      },
    });
    const gitDir = (
      await runGit(["rev-parse", "--absolute-git-dir"], { cwd: worktreePath })
    ).trim();
    const commonGitDir = path.resolve(
      worktreePath,
      (
        await runGit(["rev-parse", "--git-common-dir"], { cwd: worktreePath })
      ).trim(),
    );

    expect(runtimeOptions.current?.additionalWorkspaceWriteRoots).toEqual([
      path.resolve(gitDir),
      path.join(commonGitDir, "objects"),
      path.join(commonGitDir, "refs"),
      path.join(commonGitDir, "logs"),
    ]);
  });

  it("passes thread storage root to created runtimes as a workspace-write root", async () => {
    const provisionWorkspace = createProvisionWorkspaceMock("/tmp/env-1");
    const runtimeOptions: RuntimeOptionsRef = { current: null };
    const manager = new RuntimeManager({
      provisionWorkspace,
      threadStorageRootPath: "/tmp/bb-thread-storage",
      createRuntime: (options) => {
        runtimeOptions.current = options;
        return createFakeRuntime();
      },
    });

    await manager.ensureEnvironment({
      environmentId: "env-thread-storage-root",
      workspacePath: "/tmp/env-1",
    });

    expect(runtimeOptions.current?.additionalWorkspaceWriteRoots).toEqual([
      "/tmp/bb-thread-storage",
    ]);
  });

  it("passes shell env through to created runtimes", async () => {
    const provisionWorkspace = createProvisionWorkspaceMock("/tmp/env-1");
    const createRuntime = vi.fn(() => createFakeRuntime());
    const manager = new RuntimeManager({
      provisionWorkspace,
      createRuntime,
      shellEnv: {
        PATH: "/tmp/bb-bin:/usr/bin",
        BB_SERVER_URL: "http://127.0.0.1:3334",
      },
    });

    await manager.ensureEnvironment({
      environmentId: "env-1",
      workspacePath: "/tmp/env-1",
    });

    expect(createRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        shellEnv: {
          PATH: "/tmp/bb-bin:/usr/bin",
          BB_SERVER_URL: "http://127.0.0.1:3334",
        },
      }),
    );
  });

  it("forwards the bridge record-mode directory to provider processes but not the shell env", async () => {
    vi.stubEnv("BB_PROVIDER_BRIDGE_RECORD_DIR", "/tmp/provider-recordings/raw");
    const provisionWorkspace = createProvisionWorkspaceMock("/tmp/env-1");
    const createRuntime = vi.fn(() => createFakeRuntime());
    const manager = new RuntimeManager({
      provisionWorkspace,
      createRuntime,
      shellEnv: {
        PATH: "/tmp/bb-bin:/usr/bin",
      },
    });

    await manager.ensureEnvironment({
      environmentId: "env-1",
      workspacePath: "/tmp/env-1",
    });

    expect(createRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        env: {
          PATH: "/tmp/bb-bin:/usr/bin",
          BB_PROVIDER_BRIDGE_RECORD_DIR: "/tmp/provider-recordings/raw",
        },
        shellEnv: { PATH: "/tmp/bb-bin:/usr/bin" },
      }),
    );
  });

  it("passes the resolved shell PATH to unmanaged workspace Git", async () => {
    const provisionWorkspace = createProvisionWorkspaceMock("/tmp/env-1");
    const manager = new RuntimeManager({
      provisionWorkspace,
      shellEnv: {
        PATH: "/resolved/user/bin:/usr/bin:/bin",
      },
    });

    await manager.ensureEnvironment({
      environmentId: "env-1",
      provision: {
        path: "/tmp/env-1",
      },
    });

    expect(provisionWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        shellPath: "/resolved/user/bin:/usr/bin:/bin",
      }),
    );
  });

  it("passes shell PATH through to provider process env", async () => {
    const provisionWorkspace = createProvisionWorkspaceMock("/tmp/env-1");
    const createRuntime = vi.fn(() => createFakeRuntime());
    const manager = new RuntimeManager({
      provisionWorkspace,
      createRuntime,
      shellEnv: {
        PATH: "/tmp/bb-bin:/home/me/.local/bin:/usr/bin",
        BB_SERVER_URL: "http://127.0.0.1:3334",
        OPENAI_API_KEY: "test-openai-key",
      },
    });

    await manager.ensureEnvironment({
      environmentId: "env-1",
      workspacePath: "/tmp/env-1",
    });

    expect(createRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        env: {
          PATH: "/tmp/bb-bin:/home/me/.local/bin:/usr/bin",
        },
        shellEnv: {
          PATH: "/tmp/bb-bin:/home/me/.local/bin:/usr/bin",
          BB_SERVER_URL: "http://127.0.0.1:3334",
          OPENAI_API_KEY: "test-openai-key",
        },
      }),
    );
  });

  it("recreates the provider maintenance runtime after base shell env changes", async () => {
    const dataDir = await makeTempDir("bb-provider-maintenance-");
    const firstRuntime = createFakeRuntime();
    const secondRuntime = createFakeRuntime();
    const createRuntime = vi
      .fn()
      .mockReturnValueOnce(firstRuntime)
      .mockReturnValueOnce(secondRuntime);
    const manager = new RuntimeManager({
      createRuntime,
      shellEnv: {
        PATH: "/old/bin:/usr/bin",
      },
    });

    await expect(
      manager.ensureProviderMaintenanceRuntime({ dataDir }),
    ).resolves.toBe(firstRuntime);
    await manager.replaceBaseShellEnv({
      PATH: "/new/bin:/usr/bin",
      BB_SERVER_URL: "http://127.0.0.1:3334",
    });
    await expect(
      manager.ensureProviderMaintenanceRuntime({ dataDir }),
    ).resolves.toBe(secondRuntime);

    expect(firstRuntime.shutdown).toHaveBeenCalledTimes(1);
    expect(createRuntime).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        env: {
          PATH: "/new/bin:/usr/bin",
        },
        shellEnv: {
          PATH: "/new/bin:/usr/bin",
          BB_SERVER_URL: "http://127.0.0.1:3334",
        },
      }),
    );
  });

  it("shuts down provider maintenance workers after the request becomes idle", async () => {
    vi.useFakeTimers();
    try {
      const dataDir = await makeTempDir("bb-provider-maintenance-idle-");
      const runtime = createFakeRuntime();
      const request = createDeferredPromise<void>();
      const requestStarted = createDeferredPromise<void>();
      const manager = new RuntimeManager({
        createRuntime: () => runtime,
        providerMaintenanceIdleTimeoutMs: 100,
      });

      const activeRequest = manager.withProviderMaintenanceRuntime(
        { dataDir },
        async () => {
          requestStarted.resolve();
          return request.promise;
        },
      );
      await requestStarted.promise;
      await vi.advanceTimersByTimeAsync(200);
      expect(runtime.shutdown).not.toHaveBeenCalled();

      request.resolve();
      await activeRequest;
      await vi.advanceTimersByTimeAsync(99);
      expect(runtime.shutdown).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(runtime.shutdown).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not let stale provider maintenance creation replace a newer runtime", async () => {
    const dataDir = await makeTempDir("bb-provider-maintenance-race-");
    const staleRuntime = createFakeRuntime();
    const currentRuntime = createFakeRuntime();
    const staleCreation = createDeferredPromise<AgentRuntime>();
    const manager = new RuntimeManager({
      shellEnv: {
        PATH: "/old/bin:/usr/bin",
      },
    });
    const managerInternals =
      manager as unknown as RuntimeManagerProviderMaintenanceInternals;
    vi.spyOn(managerInternals, "createProviderMaintenanceRuntime")
      .mockImplementationOnce(() => staleCreation.promise)
      .mockImplementationOnce(async () => currentRuntime);

    const staleRuntimePromise = manager.ensureProviderMaintenanceRuntime({
      dataDir,
    });
    const replaceShellEnvPromise = manager.replaceBaseShellEnv({
      PATH: "/new/bin:/usr/bin",
    });
    const currentRuntimePromise = manager.ensureProviderMaintenanceRuntime({
      dataDir,
    });

    await expect(currentRuntimePromise).resolves.toBe(currentRuntime);
    expect(managerInternals.providerMaintenanceRuntime).toBe(currentRuntime);

    staleCreation.resolve(staleRuntime);
    await expect(staleRuntimePromise).resolves.toBe(staleRuntime);
    await replaceShellEnvPromise;

    expect(managerInternals.providerMaintenanceRuntime).toBe(currentRuntime);
    expect(staleRuntime.shutdown).toHaveBeenCalledTimes(1);
    expect(currentRuntime.shutdown).not.toHaveBeenCalled();
  });

  it("evicts idle environment runtimes after base shell env changes", async () => {
    const provisionWorkspace = createProvisionWorkspaceMock("/tmp/env-1");
    const firstRuntime = createFakeRuntime();
    const secondRuntime = createFakeRuntime();
    const createRuntime = vi
      .fn()
      .mockReturnValueOnce(firstRuntime)
      .mockReturnValueOnce(secondRuntime);
    const manager = new RuntimeManager({
      provisionWorkspace,
      createRuntime,
      shellEnv: {
        PATH: "/old/bin:/usr/bin",
      },
    });

    await manager.ensureEnvironment({
      environmentId: "env-1",
      workspacePath: "/tmp/env-1",
    });
    await manager.replaceBaseShellEnv({
      PATH: "/new/bin:/usr/bin",
    });

    expect(manager.get("env-1")).toBeUndefined();
    expect(firstRuntime.shutdown).toHaveBeenCalledTimes(1);

    await manager.ensureEnvironment({
      environmentId: "env-1",
      workspacePath: "/tmp/env-1",
    });

    expect(createRuntime).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        env: {
          PATH: "/new/bin:/usr/bin",
        },
        shellEnv: {
          PATH: "/new/bin:/usr/bin",
        },
      }),
    );
    expect(secondRuntime.shutdown).not.toHaveBeenCalled();
  });

  it("keeps an environment runtime while a background task is still open", async () => {
    const provisionWorkspace = createProvisionWorkspaceMock("/tmp/env-1");
    const runtime = createFakeRuntime();
    const manager = new RuntimeManager({
      provisionWorkspace,
      createRuntime: () => runtime,
      shellEnv: {
        PATH: "/old/bin:/usr/bin",
      },
    });

    await manager.ensureEnvironment({
      environmentId: "env-1",
      workspacePath: "/tmp/env-1",
    });
    runtime.setOpenBackgroundWork(true);

    await manager.replaceBaseShellEnv({
      PATH: "/new/bin:/usr/bin",
    });

    expect(manager.get("env-1")?.runtime).toBe(runtime);
    expect(runtime.shutdown).not.toHaveBeenCalled();

    runtime.setOpenBackgroundWork(false);
    await manager.replaceBaseShellEnv({
      PATH: "/newer/bin:/usr/bin",
    });

    expect(manager.get("env-1")).toBeUndefined();
    expect(runtime.shutdown).toHaveBeenCalledTimes(1);
  });

  it("keeps an environment runtime while a thread command is being prepared", async () => {
    const provisionWorkspace = createProvisionWorkspaceMock("/tmp/env-1");
    const runtime = createFakeRuntime();
    const manager = new RuntimeManager({
      provisionWorkspace,
      createRuntime: () => runtime,
      shellEnv: {
        PATH: "/old/bin:/usr/bin",
      },
    });

    await manager.ensureEnvironment({
      environmentId: "env-1",
      workspacePath: "/tmp/env-1",
    });
    const release = await manager.retainEnvironmentForThreadCommand(
      "env-1",
      "thread-1",
    );

    await manager.replaceBaseShellEnv({
      PATH: "/new/bin:/usr/bin",
    });

    expect(manager.get("env-1")?.runtime).toBe(runtime);
    expect(runtime.shutdown).not.toHaveBeenCalled();

    release();
    await manager.replaceBaseShellEnv({
      PATH: "/newer/bin:/usr/bin",
    });

    expect(manager.get("env-1")).toBeUndefined();
    expect(runtime.shutdown).toHaveBeenCalledTimes(1);
  });

  it("waits for an old-environment thread command before releasing a moved thread", async () => {
    const oldRuntime = createFakeRuntime();
    const manager = new RuntimeManager({
      provisionWorkspace: createProvisionWorkspaceMock("/tmp/env-old"),
      createRuntime: () => oldRuntime,
    });

    await manager.ensureEnvironment({
      environmentId: "env-old",
      workspacePath: "/tmp/env-old",
    });
    oldRuntime.setActiveTurn("thread-1", "turn-old");
    const release = await manager.retainEnvironmentForThreadCommand(
      "env-old",
      "thread-1",
    );
    const handoff = manager.releaseThreadFromOtherEnvironments({
      activeTurn: "interrupt",
      environmentId: "env-new",
      threadId: "thread-1",
    });

    await Promise.resolve();
    expect(oldRuntime.stopThread).not.toHaveBeenCalled();

    release();
    await handoff;

    expect(oldRuntime.stopThread).toHaveBeenCalledWith({
      threadId: "thread-1",
    });
  });

  it("releases a moved thread while another environment control waits", async () => {
    const oldRuntime = createFakeRuntime();
    const manager = new RuntimeManager({
      provisionWorkspace: createProvisionWorkspaceMock("/tmp/env-old"),
      createRuntime: () => oldRuntime,
    });

    await manager.ensureEnvironment({
      environmentId: "env-old",
      workspacePath: "/tmp/env-old",
    });
    const release = await manager.retainEnvironmentForThreadCommand(
      "env-new",
      "thread-1",
    );
    const oldEnvironmentControl = manager.releaseThreadFromOtherEnvironments({
      activeTurn: "interrupt",
      environmentId: "env-old",
      threadId: "thread-1",
    });
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });

    const turnHandoff = manager
      .releaseThreadFromOtherEnvironments({
        activeTurn: "interrupt",
        environmentId: "env-new",
        threadId: "thread-1",
      })
      .then(() => {
        release();
      });

    await expect(
      Promise.all([oldEnvironmentControl, turnHandoff]),
    ).resolves.toBeDefined();
    await expect(
      manager.retainEnvironmentForThreadCommand("env-new", "thread-1"),
    ).resolves.toBeInstanceOf(Function);
  });

  it("keeps an old-environment turn when a control declines to interrupt it", async () => {
    const oldRuntime = createFakeRuntime();
    const manager = new RuntimeManager({
      provisionWorkspace: createProvisionWorkspaceMock("/tmp/env-old"),
      createRuntime: () => oldRuntime,
    });

    await manager.ensureEnvironment({
      environmentId: "env-old",
      workspacePath: "/tmp/env-old",
    });
    oldRuntime.setActiveTurn("thread-1", "turn-old");

    const result = await manager.releaseThreadFromOtherEnvironments({
      activeTurn: "keep",
      environmentId: "env-new",
      threadId: "thread-1",
    });

    expect(oldRuntime.stopThread).not.toHaveBeenCalled();
    expect(result.activeTurnEnvironmentIds).toEqual(["env-old"]);
    expect(result.releasedEnvironmentIds).toEqual([]);
  });

  it("keeps an environment runtime while an accepted turn awaits its first event", async () => {
    const provisionWorkspace = createProvisionWorkspaceMock("/tmp/env-1");
    const runtime = createFakeRuntime();
    const manager = new RuntimeManager({
      provisionWorkspace,
      createRuntime: () => runtime,
      shellEnv: {
        PATH: "/tmp/fnm_multishells/first/bin:/usr/bin",
      },
    });

    await manager.ensureEnvironment({
      environmentId: "env-1",
      workspacePath: "/tmp/env-1",
    });
    runtime.setPendingTurnStart("thread-1", true);

    await manager.replaceBaseShellEnv({
      PATH: "/tmp/fnm_multishells/second/bin:/usr/bin",
    });

    expect(manager.get("env-1")?.runtime).toBe(runtime);
    expect(runtime.shutdown).not.toHaveBeenCalled();

    runtime.setPendingTurnStart("thread-1", false);
    await manager.replaceBaseShellEnv({
      PATH: "/tmp/fnm_multishells/third/bin:/usr/bin",
    });

    expect(manager.get("env-1")).toBeUndefined();
    expect(runtime.shutdown).toHaveBeenCalledTimes(1);
  });

  it("reuses the existing runtime for subsequent requests", async () => {
    const provisionWorkspace = createProvisionWorkspaceMock("/tmp/env-1");
    const createRuntime = vi.fn(() => createFakeRuntime());
    const manager = new RuntimeManager({
      provisionWorkspace,
      createRuntime,
    });

    const first = await manager.ensureEnvironment({
      environmentId: "env-1",
      workspacePath: "/tmp/env-1",
    });
    const second = await manager.ensureEnvironment({
      environmentId: "env-1",
      workspacePath: "/tmp/env-1",
    });

    expect(second).toBe(first);
    expect(provisionWorkspace).toHaveBeenCalledTimes(1);
    expect(createRuntime).toHaveBeenCalledTimes(1);
  });

  it("evicts only idle environments and keeps their workspaces intact", async () => {
    const runtimes: ReturnType<typeof createFakeRuntime>[] = [];
    const workspaces: HostWorkspace[] = [];
    const createRuntime = vi.fn(() => {
      const runtime = createFakeRuntime();
      runtimes.push(runtime);
      return runtime;
    });
    const provisionWorkspace = vi.fn(
      async (...args: ProvisionWorkspaceMockArgs) => {
        const workspace = createFakeWorkspace(
          getProvisionWorkspacePath(args[0]),
        );
        workspaces.push(workspace);
        return workspace;
      },
    );
    const manager = new RuntimeManager({
      createRuntime,
      provisionWorkspace,
    });

    await manager.ensureEnvironment({
      environmentId: "env-idle",
      workspacePath: "/tmp/env-idle",
    });
    await manager.ensureEnvironment({
      environmentId: "env-active",
      workspacePath: "/tmp/env-active",
    });
    runtimes[1]?.setActiveTurn("thr-active", "turn-active");

    await manager.replaceBaseShellEnv({ CHANGED: "1" });

    expect(manager.get("env-idle")).toBeUndefined();
    expect(manager.get("env-active")).toBeDefined();
    expect(runtimes[0]?.shutdown).toHaveBeenCalledTimes(1);
    expect(runtimes[1]?.shutdown).not.toHaveBeenCalled();
  });

  it("forgets a retired environment", async () => {
    const workspace = createFakeWorkspace("/tmp/env-retired");
    const runtime = createFakeRuntime();
    const manager = new RuntimeManager({
      provisionWorkspace:
        createProvisionWorkspaceMock("/tmp/env-retired").mockResolvedValue(
          workspace,
        ),
      createRuntime: vi.fn(() => runtime),
    });

    await manager.ensureEnvironment({
      environmentId: "env-retired",
      workspacePath: "/tmp/env-retired",
    });
    await manager.forgetEnvironment("env-retired");

    expect(manager.get("env-retired")).toBeUndefined();
    expect(runtime.shutdown).toHaveBeenCalledTimes(1);
  });

  it("leaves processes alone when an environment is only forgotten", async () => {
    const directory = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "bb-forget-env-")),
    );
    const manager = new RuntimeManager({
      provisionWorkspace: createProvisionWorkspaceMock(directory),
      createRuntime: vi.fn(() => createFakeRuntime()),
    });
    await manager.ensureEnvironment({
      environmentId: "env-forgotten",
      workspacePath: directory,
    });
    const child = spawn("sleep", ["300"], {
      cwd: directory,
      detached: true,
      stdio: "ignore",
    });
    child.unref();

    try {
      await manager.forgetEnvironment("env-forgotten");
      expect(isPidAlive(child.pid ?? 0)).toBe(true);
    } finally {
      if (child.pid) {
        try {
          process.kill(child.pid, "SIGKILL");
        } catch {}
      }
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it("does not start a workspace watcher when loading an environment", async () => {
    const hostWatcher = {
      watchWorkspace: vi.fn(() => () => undefined),
      watchThreadStorageRoot: vi.fn(() => () => undefined),
    } satisfies HostWatcher;
    const manager = new RuntimeManager({
      hostWatcher,
      provisionWorkspace: createProvisionWorkspaceMock("/tmp/env-read"),
      createRuntime: vi.fn(() => createFakeRuntime()),
    });

    await manager.ensureEnvironment({
      environmentId: "env-read",
      workspacePath: "/tmp/env-read",
    });

    expect(hostWatcher.watchWorkspace).not.toHaveBeenCalled();
    expect(hostWatcher.watchThreadStorageRoot).not.toHaveBeenCalled();
  });

  it("lists live threads for session reconciliation before the first turn event", async () => {
    const runtime = createFakeRuntime();
    const manager = new RuntimeManager({
      provisionWorkspace: createProvisionWorkspaceMock("/tmp/env-1"),
      createRuntime: vi.fn(() => runtime),
    });

    await manager.ensureEnvironment({
      environmentId: "env-1",
      workspacePath: "/tmp/env-1",
    });

    runtime.setActiveTurn("thread-1", "turn-1");
    runtime.setPendingTurnStart("thread-2", true);
    expect(manager.listActiveThreads()).toEqual([
      {
        threadId: "thread-1",
      },
      {
        threadId: "thread-2",
      },
    ]);

    runtime.endActiveTurn("thread-1");
    runtime.setPendingTurnStart("thread-2", false);
    expect(manager.listActiveThreads()).toEqual([]);
  });

  it("removes stale entries when the provider process exits", async () => {
    const workspace = createFakeWorkspace("/tmp/env-exit");
    const runtime = createFakeRuntime();
    let onProcessExit:
      | NonNullable<AgentRuntimeOptions["onProcessExit"]>
      | undefined;
    const manager = new RuntimeManager({
      provisionWorkspace:
        createProvisionWorkspaceMock("/tmp/env-exit").mockResolvedValue(
          workspace,
        ),
      createRuntime: vi.fn((options) => {
        onProcessExit = options.onProcessExit;
        return runtime;
      }),
    });

    await manager.ensureEnvironment({
      environmentId: "env-exit",
      workspacePath: "/tmp/env-exit",
    });

    onProcessExit?.({
      bridgeWorker: null,
      providerId: "fake",
      threads: [
        {
          threadId: "thread-1",
          activeTurnId: null,
          pendingTurnStart: false,
          providerThreadId: null,
        },
      ],
      code: 1,
      expected: false,
      signal: null,
      stderr: null,
    });

    expect(manager.get("env-exit")).toBeUndefined();
    expect(runtime.shutdown).not.toHaveBeenCalled();
  });

  it("keeps sibling provider threads running when one provider exits", async () => {
    const workspace = createFakeWorkspace("/tmp/env-shared");
    const runtime = createFakeRuntime();
    let runningProviders = ["fake-alpha", "fake-beta"];
    runtime.listRunningProviders.mockImplementation(() => runningProviders);
    let onProcessExit:
      | NonNullable<AgentRuntimeOptions["onProcessExit"]>
      | undefined;
    const manager = new RuntimeManager({
      provisionWorkspace:
        createProvisionWorkspaceMock("/tmp/env-shared").mockResolvedValue(
          workspace,
        ),
      createRuntime: vi.fn((options) => {
        onProcessExit = options.onProcessExit;
        return runtime;
      }),
    });

    await manager.ensureEnvironment({
      environmentId: "env-shared",
      workspacePath: "/tmp/env-shared",
    });
    runningProviders = ["fake-beta"];
    onProcessExit?.({
      bridgeWorker: null,
      providerId: "fake-alpha",
      threads: [
        {
          threadId: "thread-a",
          activeTurnId: null,
          pendingTurnStart: false,
          providerThreadId: null,
        },
      ],
      code: 1,
      expected: false,
      signal: null,
      stderr: null,
    });

    expect(manager.get("env-shared")).toBeDefined();
    expect(runtime.shutdown).not.toHaveBeenCalled();
  });

  it("emits failure events for active threads when a provider exits unexpectedly", async () => {
    const emittedEvents: Array<{
      environmentId: string;
      event: ThreadEvent;
    }> = [];
    const runtime = createFakeRuntime();
    const forwardedProcessExits: Parameters<
      NonNullable<AgentRuntimeOptions["onProcessExit"]>
    >[0][] = [];
    let onRuntimeEvent: AgentRuntimeOptions["onEvent"] | undefined;
    let onProcessExit:
      | NonNullable<AgentRuntimeOptions["onProcessExit"]>
      | undefined;
    const manager = new RuntimeManager({
      provisionWorkspace: createProvisionWorkspaceMock(
        "/tmp/env-provider-exit",
      ).mockResolvedValue(createFakeWorkspace("/tmp/env-provider-exit")),
      createRuntime: vi.fn((options) => {
        onRuntimeEvent = options.onEvent;
        onProcessExit = options.onProcessExit;
        return runtime;
      }),
      onEvent: (event) => {
        emittedEvents.push(event);
      },
      onProcessExit: (info) => {
        forwardedProcessExits.push(info);
      },
    });

    await manager.ensureEnvironment({
      environmentId: "env-provider-exit",
      workspacePath: "/tmp/env-provider-exit",
    });
    if (!onRuntimeEvent || !onProcessExit) {
      throw new Error("Expected runtime callbacks to be captured");
    }
    onRuntimeEvent({
      type: "turn/started",
      threadId: "thread-1",
      providerThreadId: "provider-1",
      scope: turnScope("turn-1"),
    });

    onProcessExit({
      bridgeWorker: null,
      providerId: "codex",
      threads: [
        {
          threadId: "thread-1",
          activeTurnId: "turn-1",
          pendingTurnStart: false,
          providerThreadId: "provider-1",
        },
      ],
      code: 1,
      expected: false,
      signal: null,
      stderr: "OPENAI_API_KEY=sk-test-secret\nUsage limit reached.",
    });

    expect(emittedEvents).toEqual([
      {
        environmentId: "env-provider-exit",
        event: {
          type: "turn/started",
          threadId: "thread-1",
          providerThreadId: "provider-1",
          scope: turnScope("turn-1"),
        },
      },
      {
        environmentId: "env-provider-exit",
        event: {
          type: "turn/completed",
          threadId: "thread-1",
          providerThreadId: "provider-1",
          scope: turnScope("turn-1"),
          status: "failed",
          error: {
            message: 'Provider "codex" exited unexpectedly with code 1',
          },
        },
      },
      {
        environmentId: "env-provider-exit",
        event: {
          type: "system/error",
          threadId: "thread-1",
          scope: turnScope("turn-1"),
          code: "provider_process_exited",
          message: 'Provider "codex" exited unexpectedly with code 1',
          detail:
            "stderr:\nOPENAI_API_KEY=sk-test-secret\nUsage limit reached.",
        },
      },
    ]);
    expect(forwardedProcessExits).toEqual([
      expect.objectContaining({
        stderr: "OPENAI_API_KEY=sk-test-secret\nUsage limit reached.",
      }),
    ]);
  });

  it("does not synthesize failure events for exited threads without an active turn", async () => {
    const emittedEvents: Array<{
      environmentId: string;
      event: ThreadEvent;
    }> = [];
    const runtime = createFakeRuntime();
    let onProcessExit:
      | NonNullable<AgentRuntimeOptions["onProcessExit"]>
      | undefined;
    const manager = new RuntimeManager({
      provisionWorkspace: createProvisionWorkspaceMock(
        "/tmp/env-idle-exit",
      ).mockResolvedValue(createFakeWorkspace("/tmp/env-idle-exit")),
      createRuntime: vi.fn((options) => {
        onProcessExit = options.onProcessExit;
        return runtime;
      }),
      onEvent: (event) => {
        emittedEvents.push(event);
      },
    });

    await manager.ensureEnvironment({
      environmentId: "env-idle-exit",
      workspacePath: "/tmp/env-idle-exit",
    });
    if (!onProcessExit) {
      throw new Error("Expected runtime callbacks to be captured");
    }

    onProcessExit({
      bridgeWorker: null,
      providerId: "codex",
      threads: [
        {
          threadId: "thread-idle",
          activeTurnId: null,
          pendingTurnStart: false,
          providerThreadId: "provider-idle",
        },
      ],
      code: 1,
      expected: false,
      signal: null,
      stderr: null,
    });

    expect(emittedEvents).toEqual([]);
  });

  it("emits a thread failure when a provider exits before turn/started", async () => {
    const emittedEvents: Array<{
      environmentId: string;
      event: ThreadEvent;
    }> = [];
    const runtime = createFakeRuntime();
    let onProcessExit:
      | NonNullable<AgentRuntimeOptions["onProcessExit"]>
      | undefined;
    const manager = new RuntimeManager({
      provisionWorkspace: createProvisionWorkspaceMock(
        "/tmp/env-pending-turn-exit",
      ).mockResolvedValue(createFakeWorkspace("/tmp/env-pending-turn-exit")),
      createRuntime: vi.fn((options) => {
        onProcessExit = options.onProcessExit;
        return runtime;
      }),
      onEvent: (event) => {
        emittedEvents.push(event);
      },
    });

    await manager.ensureEnvironment({
      environmentId: "env-pending-turn-exit",
      workspacePath: "/tmp/env-pending-turn-exit",
    });
    if (!onProcessExit) {
      throw new Error("Expected runtime callbacks to be captured");
    }

    onProcessExit({
      bridgeWorker: null,
      providerId: "claude-code",
      threads: [
        {
          threadId: "thread-pending",
          activeTurnId: null,
          pendingTurnStart: true,
          providerThreadId: "provider-pending",
        },
      ],
      code: 1,
      expected: false,
      signal: null,
      stderr: "provider failed before acknowledging the turn",
    });

    expect(emittedEvents).toEqual([
      {
        environmentId: "env-pending-turn-exit",
        event: {
          type: "system/error",
          threadId: "thread-pending",
          scope: threadScope(),
          code: "provider_process_exited",
          message: 'Provider "claude-code" exited unexpectedly with code 1',
          detail: "stderr:\nprovider failed before acknowledging the turn",
        },
      },
    ]);
  });

  it("does not emit failure events for expected provider exits", async () => {
    const emittedEvents: Array<{
      environmentId: string;
      event: ThreadEvent;
    }> = [];
    const runtime = createFakeRuntime();
    let onRuntimeEvent: AgentRuntimeOptions["onEvent"] | undefined;
    let onProcessExit:
      | NonNullable<AgentRuntimeOptions["onProcessExit"]>
      | undefined;
    const manager = new RuntimeManager({
      provisionWorkspace: createProvisionWorkspaceMock(
        "/tmp/env-expected-exit",
      ).mockResolvedValue(createFakeWorkspace("/tmp/env-expected-exit")),
      createRuntime: vi.fn((options) => {
        onRuntimeEvent = options.onEvent;
        onProcessExit = options.onProcessExit;
        return runtime;
      }),
      onEvent: (event) => {
        emittedEvents.push(event);
      },
    });

    await manager.ensureEnvironment({
      environmentId: "env-expected-exit",
      workspacePath: "/tmp/env-expected-exit",
    });
    if (!onRuntimeEvent || !onProcessExit) {
      throw new Error("Expected runtime callbacks to be captured");
    }
    onRuntimeEvent({
      type: "turn/started",
      threadId: "thread-1",
      providerThreadId: "provider-1",
      scope: turnScope("turn-1"),
    });
    emittedEvents.splice(0, emittedEvents.length);

    onProcessExit({
      bridgeWorker: null,
      providerId: "codex",
      threads: [
        {
          threadId: "thread-1",
          activeTurnId: "turn-1",
          pendingTurnStart: false,
          providerThreadId: "provider-1",
        },
      ],
      code: null,
      expected: true,
      signal: "SIGTERM",
      stderr: null,
    });

    expect(emittedEvents).toEqual([]);
    expect(manager.get("env-expected-exit")).toBeDefined();
  });

  it("shuts down all tracked environments", async () => {
    const workspaceA = createFakeWorkspace("/tmp/env-a");
    const workspaceB = createFakeWorkspace("/tmp/env-b");
    const runtimeA = createFakeRuntime();
    const runtimeB = createFakeRuntime();
    const provisionWorkspace = createProvisionWorkspaceMock("/tmp/env-a")
      .mockResolvedValueOnce(workspaceA)
      .mockResolvedValueOnce(workspaceB);
    const createRuntime = vi
      .fn()
      .mockReturnValueOnce(runtimeA)
      .mockReturnValueOnce(runtimeB);
    const manager = new RuntimeManager({
      provisionWorkspace,
      createRuntime,
    });

    await manager.ensureEnvironment({
      environmentId: "env-a",
      workspacePath: "/tmp/env-a",
    });
    await manager.ensureEnvironment({
      environmentId: "env-b",
      workspacePath: "/tmp/env-b",
    });

    await manager.shutdownAll("stop");

    expect(runtimeA.shutdown).toHaveBeenCalledTimes(1);
    expect(runtimeB.shutdown).toHaveBeenCalledTimes(1);
  });
});

describe("RuntimeManager bridge workers", () => {
  function deadPid(): number {
    const child = spawn(process.execPath, ["-e", ""]);
    if (child.pid === undefined) throw new Error("could not spawn");
    return child.pid;
  }

  async function writeRegistryEntry(args: {
    dir: string;
    id: string;
    pid: number;
  }): Promise<void> {
    await fs.mkdir(args.dir, { recursive: true });
    await fs.writeFile(
      path.join(args.dir, `${args.id}.json`),
      JSON.stringify({
        id: args.id,
        pid: args.pid,
        socketPath: path.join(args.dir, `${args.id}.sock`),
        pluginId: "provider-codex",
        providerId: "codex",
        processKey: "codex#bridge:0123456789abcdef",
        environmentId: "env-1",
        bridgeProtocolVersion: 2,
        transportVersion: 1,
        startedAt: "2026-09-11T00:00:00.000Z",
        workspace: {
          workspacePath: "/tmp/env-retire",
          workspaceProvisionType: "unmanaged",
          personalWorkspaceRoot: null,
        },
        threads: {},
      }),
    );
  }

  it("runs environment workers over the data dir's bridge worker registry", async () => {
    const dataDir = await makeTempDir("bb-runtime-manager-workers-");
    const createRuntime = vi.fn((_options: AgentRuntimeOptions) =>
      createFakeRuntime(),
    );
    const manager = new RuntimeManager({
      dataDir,
      provisionWorkspace: createProvisionWorkspaceMock("/tmp/env-workers"),
      createRuntime,
    });

    await manager.ensureEnvironment({
      environmentId: "env-1",
      workspacePath: "/tmp/env-workers",
    });

    expect(createRuntime.mock.calls[0]?.[0].bridgeWorkers).toEqual({
      dir: path.join(dataDir, "bridge-workers"),
      environmentId: "env-1",
      workspace: {
        workspacePath: "/tmp/env-workers",
        workspaceProvisionType: "unmanaged",
        personalWorkspaceRoot: null,
      },
    });
  });

  it("reaps the registry entries of workers that are no longer running", async () => {
    const dataDir = await makeTempDir("bb-runtime-manager-reap-");
    const dir = path.join(dataDir, "bridge-workers");
    const gone = deadPid();
    await new Promise((resolve) => setTimeout(resolve, 100));
    await writeRegistryEntry({ dir, id: "aaaaaaaaaaaa", pid: gone });
    await fs.writeFile(path.join(dir, "aaaaaaaaaaaa.log"), "old log");
    const manager = new RuntimeManager({
      dataDir,
      provisionWorkspace: createProvisionWorkspaceMock("/tmp/env-reap"),
      createRuntime: () => createFakeRuntime(),
    });

    await manager.reconcileBridgeWorkers();

    expect(await fs.readdir(dir)).toEqual([]);
  });

  it("detaches environment runtimes in detach mode and stops them in stop mode", async () => {
    const runtimes: ReturnType<typeof createFakeRuntime>[] = [];
    const createManager = () =>
      new RuntimeManager({
        provisionWorkspace: createProvisionWorkspaceMock("/tmp/env-modes"),
        createRuntime: () => {
          const runtime = createFakeRuntime();
          runtimes.push(runtime);
          return runtime;
        },
      });
    const detaching = createManager();
    await detaching.ensureEnvironment({
      environmentId: "env-1",
      workspacePath: "/tmp/env-modes",
    });
    await detaching.shutdownAll("detach");
    await expect(
      detaching.ensureEnvironment({
        environmentId: "env-2",
        workspacePath: "/tmp/env-modes",
      }),
    ).rejects.toThrow(/shutting down/u);
    const stopping = createManager();
    await stopping.ensureEnvironment({
      environmentId: "env-2",
      workspacePath: "/tmp/env-modes",
    });
    await stopping.shutdownAll("stop");

    const [detached, stopped] = runtimes;
    expect(detached?.detach).toHaveBeenCalledTimes(1);
    expect(detached?.shutdown).not.toHaveBeenCalled();
    expect(stopped?.shutdown).toHaveBeenCalledTimes(1);
    expect(stopped?.detach).not.toHaveBeenCalled();
  });

  it("detaches every environment at once, so the detach fits the launcher's head start", async () => {
    let concurrent = 0;
    let maxConcurrent = 0;
    const manager = new RuntimeManager({
      provisionWorkspace: createProvisionWorkspaceMock("/tmp/env-parallel"),
      createRuntime: () => {
        const runtime = createFakeRuntime();
        runtime.detach.mockImplementation(async () => {
          concurrent += 1;
          maxConcurrent = Math.max(maxConcurrent, concurrent);
          await new Promise((resolve) => setTimeout(resolve, 50));
          concurrent -= 1;
        });
        return runtime;
      },
    });
    for (const environmentId of ["env-1", "env-2", "env-3"]) {
      await manager.ensureEnvironment({
        environmentId,
        workspacePath: "/tmp/env-parallel",
      });
    }

    await manager.shutdownAll("detach");

    expect(maxConcurrent).toBe(3);
  });

  it("retires live workers a previous daemon left behind, since it cannot adopt them", async () => {
    const dataDir = await fs.mkdtemp(
      path.join(process.platform === "win32" ? os.tmpdir() : "/tmp", "bbw-"),
    );
    tempDirs.push(dataDir);
    const dir = path.join(dataDir, "bridge-workers");
    await fs.mkdir(dir, { recursive: true });
    const shutdowns: string[] = [];
    const worker = createBridgeSocketServer({
      socketPath: path.join(dir, "aaaaaaaaaaaa.sock"),
      spillPath: path.join(dir, "aaaaaaaaaaaa.buf"),
      reattachTtlMs: 60_000,
      memoryCapBytes: 1024 * 1024,
      hardCapBytes: 16 * 1024 * 1024,
      onOverflow: () => undefined,
      onBackpressure: () => undefined,
    });
    await worker.listen({
      onLine: () => undefined,
      onShutdown: (reason) => shutdowns.push(reason),
    });
    await writeRegistryEntry({ dir, id: "aaaaaaaaaaaa", pid: process.pid });
    const registered = path.join(dir, "aaaaaaaaaaaa.json");
    const entry = JSON.parse(await fs.readFile(registered, "utf8"));
    await fs.writeFile(
      registered,
      JSON.stringify({
        ...entry,
        processIdentity: readProcessIdentity(process.pid),
      }),
    );
    await writeRegistryEntry({ dir, id: "bbbbbbbbbbbb", pid: process.pid });
    const incompatible = path.join(dir, "bbbbbbbbbbbb.json");
    await fs.writeFile(
      incompatible,
      JSON.stringify({
        ...JSON.parse(await fs.readFile(incompatible, "utf8")),
        processIdentity: readProcessIdentity(process.pid),
        transportVersion: 99,
        threads: {
          t1: {
            providerThreadId: "prov-1",
            activeTurnId: "turn-1",
            activeProviderTurnId: null,
            config: {},
          },
        },
      }),
    );
    const createRuntime = vi.fn(() => createFakeRuntime());
    const manager = new RuntimeManager({
      dataDir,
      provisionWorkspace: createProvisionWorkspaceMock("/tmp/env-retire"),
      createRuntime,
    });

    try {
      await manager.reconcileBridgeWorkers();
    } finally {
      worker.close();
    }

    expect(shutdowns).toEqual(["requested"]);
    expect(await fs.readdir(dir)).toEqual([]);
    expect(createRuntime).not.toHaveBeenCalled();
    expect(manager.listAdoptedBridgeThreads()).toEqual([]);
  });

  it("leaves a real worker running across a daemon exit, and the next daemon retires it", async () => {
    const dataDir = await fs.mkdtemp(
      path.join(process.platform === "win32" ? os.tmpdir() : "/tmp", "bbw-"),
    );
    tempDirs.push(dataDir);
    const workspacePath = await makeTempDir("bb-runtime-manager-detach-ws-");
    const bridgeLaunch = createScriptedEchoLaunch({
      modulePath: fileURLToPath(
        new URL(
          "../../../tests/scripted-echo-provider/src/provider-bridge.ts",
          import.meta.url,
        ),
      ),
    });
    const createManager = () =>
      new RuntimeManager({
        dataDir,
        provisionWorkspace: createProvisionWorkspaceMock(workspacePath),
      });
    const dir = path.join(dataDir, "bridge-workers");
    const exiting = createManager();
    const entry = await exiting.ensureEnvironment({
      environmentId: "env-1",
      workspacePath,
    });
    await entry.runtime.ensureProvider({ bridgeLaunch, providerId: "fake" });
    const registered = JSON.parse(
      await fs.readFile(
        path.join(
          dir,
          (await fs.readdir(dir)).find((name) => name.endsWith(".json")) ?? "",
        ),
        "utf8",
      ),
    ) as { pid: number };

    try {
      await exiting.shutdownAll("detach");

      expect(() => process.kill(registered.pid, 0)).not.toThrow();
      expect(
        (await fs.readdir(dir)).filter((name) => name.endsWith(".json")),
      ).toHaveLength(1);

      await createManager().reconcileBridgeWorkers();

      const deadline = Date.now() + 10_000;
      while (isProcessAlive(registered.pid) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(isProcessAlive(registered.pid)).toBe(false);
      expect(
        (await fs.readdir(dir)).filter((name) => name.endsWith(".json")),
      ).toEqual([]);
    } finally {
      if (isProcessAlive(registered.pid)) {
        process.kill(registered.pid, "SIGKILL");
      }
    }
  }, 30_000);

  const adoptionRuntimeOptions = {
    model: "test-model",
    serviceTier: "default",
    reasoningLevel: "medium",
    providerOptions: {},
    permissionMode: "full",
    permissionScope: "full",
    approvalReviewer: null,
    permissionEscalation: null,
  } as const;

  async function startTurnThenDetach(
    label: string,
    options: { idleAtDetach?: boolean } = {},
  ) {
    const dataDir = await fs.mkdtemp(
      path.join(process.platform === "win32" ? os.tmpdir() : "/tmp", "bbw-"),
    );
    tempDirs.push(dataDir);
    const workspacePath = await makeTempDir(`bb-adopt-${label}-ws-`);
    const bridgeLaunch = createScriptedEchoLaunch({
      modulePath: fileURLToPath(
        new URL(
          "../../../tests/scripted-echo-provider/src/provider-bridge.ts",
          import.meta.url,
        ),
      ),
    });
    const createManager = (events: ThreadEvent[]) =>
      new RuntimeManager({
        dataDir,
        provisionWorkspace: createProvisionWorkspaceMock(workspacePath),
        onEvent: ({ event, delivery }) => {
          events.push(event);
          delivery?.onSettled();
        },
      });
    const dir = path.join(dataDir, "bridge-workers");
    const before: ThreadEvent[] = [];
    const exiting = createManager(before);
    const entry = await exiting.ensureEnvironment({
      environmentId: "env-1",
      workspacePath,
    });
    await entry.runtime.startThread({
      bridgeLaunch,
      environmentId: "env-1",
      threadId: "t1",
      projectId: "p1",
      providerId: "fake",
      options: adoptionRuntimeOptions,
    });
    await entry.runtime.runTurn({
      threadId: "t1",
      clientRequestId: "creq_666666666a",
      input: [{ type: "text", text: "delay:2500 stream:2", mentions: [] }],
      options: adoptionRuntimeOptions,
    });
    await waitFor(() =>
      options.idleAtDetach === true
        ? before.some((event) => event.type === "turn/completed")
        : before.some((event) => JSON.stringify(event).includes("chunk1")),
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    const turnStarted = before.find((event) => event.type === "turn/started");
    if (turnStarted?.scope.kind !== "turn") {
      throw new Error("the turn never started");
    }
    await exiting.shutdownAll("detach");
    const registered = await readOnlyRegistryEntry(dir);
    return {
      before,
      bbTurnId: turnStarted.scope.turnId,
      createManager,
      registered,
      dir,
    };
  }

  async function readOnlyRegistryEntry(dir: string) {
    const names = (await fs.readdir(dir)).filter((name) =>
      name.endsWith(".json"),
    );
    expect(names).toHaveLength(1);
    return JSON.parse(
      await fs.readFile(path.join(dir, names[0] ?? ""), "utf8"),
    ) as {
      pid: number;
      threads: Record<string, { activeTurnId: string | null }>;
    };
  }

  async function waitFor(predicate: () => boolean, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error("timed out waiting");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  it("logs which workers an idle runtime stops when the shell environment changes, and why", async () => {
    const dataDir = await fs.mkdtemp(
      path.join(process.platform === "win32" ? os.tmpdir() : "/tmp", "bbw-"),
    );
    tempDirs.push(dataDir);
    const workspacePath = await makeTempDir("bb-evict-log-ws-");
    const bridgeLaunch = createScriptedEchoLaunch({
      modulePath: fileURLToPath(
        new URL(
          "../../../tests/scripted-echo-provider/src/provider-bridge.ts",
          import.meta.url,
        ),
      ),
    });
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() };
    const manager = new RuntimeManager({
      dataDir,
      logger,
      provisionWorkspace: createProvisionWorkspaceMock(workspacePath),
      shellEnv: { PATH: process.env.PATH ?? "" },
    });
    const entry = await manager.ensureEnvironment({
      environmentId: "env-1",
      workspacePath,
    });
    await entry.runtime.ensureProvider({ bridgeLaunch, providerId: "fake" });
    const dir = path.join(dataDir, "bridge-workers");
    const registered = JSON.parse(
      await fs.readFile(
        path.join(
          dir,
          (await fs.readdir(dir)).find((name) => name.endsWith(".json")) ?? "",
        ),
        "utf8",
      ),
    ) as { id: string; pid: number };

    try {
      await manager.replaceBaseShellEnv({
        PATH: process.env.PATH ?? "",
        CHANGED: "1",
      });

      expect(logger.info).toHaveBeenCalledWith(
        {
          environmentId: "env-1",
          reason: "idle-after-shell-environment-change",
          bridgeWorkers: [{ id: registered.id, pid: registered.pid }],
        },
        "Stopping environment runtime and its provider bridge workers",
      );
      await waitFor(() => !isProcessAlive(registered.pid));
      expect(
        (await fs.readdir(dir)).filter((name) => name.endsWith(".json")),
      ).toEqual([]);
    } finally {
      await manager.shutdownAll("stop");
      if (isProcessAlive(registered.pid)) {
        process.kill(registered.pid, "SIGKILL");
      }
    }
  }, 30_000);

  it("keeps environment values out of the worker registry, and adoption still runs the next turn", async () => {
    const dataDir = await fs.mkdtemp(
      path.join(process.platform === "win32" ? os.tmpdir() : "/tmp", "bbw-"),
    );
    tempDirs.push(dataDir);
    const workspacePath = await makeTempDir("bb-adopt-secrets-ws-");
    const shellSecret = "ghp_shellsecret0123456789";
    const pluginSecret = "sk-pluginsecret0123456789";
    const bridgeLaunch = createScriptedEchoLaunch({
      modulePath: fileURLToPath(
        new URL(
          "../../../tests/scripted-echo-provider/src/provider-bridge.ts",
          import.meta.url,
        ),
      ),
    });
    const events: ThreadEvent[] = [];
    const createManager = () =>
      new RuntimeManager({
        dataDir,
        provisionWorkspace: createProvisionWorkspaceMock(workspacePath),
        shellEnv: { PATH: process.env.PATH ?? "", GITHUB_TOKEN: shellSecret },
        onEvent: ({ event, delivery }) => {
          events.push(event);
          delivery?.onSettled();
        },
      });
    const dir = path.join(dataDir, "bridge-workers");
    const exiting = createManager();
    const entry = await exiting.ensureEnvironment({
      environmentId: "env-1",
      workspacePath,
    });
    await entry.runtime.startThread({
      bridgeLaunch,
      contributedEnv: [
        {
          name: "PLUGIN_TOKEN",
          value: pluginSecret,
          source: { plugin: "secret-plugin" },
          reason: "test",
        },
      ],
      environmentId: "env-1",
      threadId: "t1",
      projectId: "p1",
      providerId: "fake",
      options: adoptionRuntimeOptions,
    });
    await exiting.shutdownAll("detach");
    const names = (await fs.readdir(dir)).filter((name) =>
      name.endsWith(".json"),
    );
    const raw = await fs.readFile(path.join(dir, names[0] ?? ""), "utf8");
    const registered = JSON.parse(raw) as {
      pid: number;
      threads: Record<
        string,
        { config: { envVars: unknown; contributedEnv: unknown } }
      >;
    };

    const adopting = createManager();
    try {
      expect(names).toHaveLength(1);
      expect(raw).not.toContain(shellSecret);
      expect(raw).not.toContain(pluginSecret);
      expect(raw).not.toContain(process.env.PATH ?? "PATH-unset");
      expect(registered.threads.t1?.config.envVars).toEqual({});
      expect(registered.threads.t1?.config.contributedEnv).toEqual([]);

      await adopting.reconcileBridgeWorkers();
      await adopting.completeBridgeWorkerAdoption(async () => new Map());
      await adopting.get("env-1")?.runtime.runTurn({
        threadId: "t1",
        clientRequestId: "creq_777777777a",
        input: [{ type: "text", text: "after adoption", mentions: [] }],
        options: adoptionRuntimeOptions,
      });
      await waitFor(() =>
        events.some((event) => event.type === "turn/completed"),
      );
      expect(
        (await fs.readdir(dir))
          .filter((name) => name.endsWith(".json"))
          .map((name) => name),
      ).toEqual(names);
      expect(
        await fs.readFile(path.join(dir, names[0] ?? ""), "utf8"),
      ).not.toContain(shellSecret);
    } finally {
      await adopting.shutdownAll("stop");
      if (isProcessAlive(registered.pid)) {
        process.kill(registered.pid, "SIGKILL");
      }
    }
  }, 30_000);

  it("holds thread commands until adoption has seeded the adopted turn", async () => {
    const { bbTurnId, createManager, registered } =
      await startTurnThenDetach("gate");
    const adopting = createManager([]);
    try {
      await adopting.reconcileBridgeWorkers();
      let settled = false;
      const gate = adopting.whenBridgeWorkerAdoptionSettled().then(() => {
        settled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(settled).toBe(false);
      expect(adopting.get("env-1")?.runtime.getActiveTurnId("t1")).toBeNull();

      await adopting.completeBridgeWorkerAdoption(
        async () => new Map([["t1", bbTurnId]]),
      );
      await gate;
      expect(settled).toBe(true);
      expect(adopting.get("env-1")?.runtime.getActiveTurnId("t1")).toBe(
        bbTurnId,
      );
    } finally {
      await adopting.shutdownAll("stop");
      if (isProcessAlive(registered.pid)) {
        process.kill(registered.pid, "SIGKILL");
      }
    }
  }, 30_000);

  it("adopts a running turn on restart: same worker, same bb turn, no replayed output", async () => {
    const { before, bbTurnId, createManager, registered, dir } =
      await startTurnThenDetach("same-turn");
    const after: ThreadEvent[] = [];
    const adopting = createManager(after);
    try {
      expect(registered.threads.t1?.activeTurnId).toBe(bbTurnId);
      await adopting.reconcileBridgeWorkers();
      expect(adopting.listAdoptedBridgeThreads()).toEqual([
        { threadId: "t1", activeTurnId: bbTurnId },
      ]);
      expect(adopting.listActiveThreads()).toEqual([{ threadId: "t1" }]);
      await adopting.completeBridgeWorkerAdoption(
        async () => new Map([["t1", bbTurnId]]),
      );
      expect(adopting.get("env-1")?.runtime.getActiveTurnId("t1")).toBe(
        bbTurnId,
      );

      await waitFor(() =>
        after.some((event) => event.type === "turn/completed"),
      );
      const completed = after.find((event) => event.type === "turn/completed");
      expect(completed?.scope).toEqual({ kind: "turn", turnId: bbTurnId });
      expect(after.filter((event) => event.type === "turn/started")).toEqual(
        [],
      );
      const all = [...before, ...after];
      const deltasWith = (text: string) =>
        all.filter(
          (event) =>
            event.type === "item/agentMessage/delta" &&
            event.delta.includes(text),
        );
      expect(deltasWith("chunk1")).toHaveLength(1);
      expect(deltasWith("chunk2")).toHaveLength(1);
      expect(
        all.filter(
          (event) =>
            event.type === "item/completed" &&
            JSON.stringify(event).includes("Response to: delay:2500 stream:2"),
        ),
      ).toHaveLength(1);
      expect((await readOnlyRegistryEntry(dir)).pid).toBe(registered.pid);
      expect(isProcessAlive(registered.pid)).toBe(true);

      const runtime = adopting.get("env-1")?.runtime;
      await runtime?.runTurn({
        threadId: "t1",
        clientRequestId: "creq_666666666b",
        input: [{ type: "text", text: "after adoption", mentions: [] }],
        options: adoptionRuntimeOptions,
      });
      await waitFor(
        () =>
          after.filter((event) => event.type === "turn/completed").length === 2,
      );
      expect((await readOnlyRegistryEntry(dir)).pid).toBe(registered.pid);
    } finally {
      await adopting.shutdownAll("stop");
      if (isProcessAlive(registered.pid)) {
        process.kill(registered.pid, "SIGKILL");
      }
    }
    expect(isProcessAlive(registered.pid)).toBe(false);
  }, 30_000);

  it("keeps an adopted environment through a login-shell change while its provider work is still unknown", async () => {
    const { createManager, registered } = await startTurnThenDetach(
      "adopted-shell-env",
      { idleAtDetach: true },
    );
    const after: ThreadEvent[] = [];
    const adopting = createManager(after);
    try {
      await adopting.reconcileBridgeWorkers();
      await adopting.completeBridgeWorkerAdoption(
        async () => new Map([["t1", null]]),
      );

      await adopting.replaceBaseShellEnv({ PATH: "/new/bin:/usr/bin" });

      expect(adopting.get("env-1")).toBeDefined();
      expect(isProcessAlive(registered.pid)).toBe(true);
    } finally {
      await adopting.shutdownAll("stop");
      if (isProcessAlive(registered.pid)) {
        process.kill(registered.pid, "SIGKILL");
      }
    }
  }, 30_000);

  it("lets an adopted environment be evicted again once its hold has expired", async () => {
    const { createManager, registered } = await startTurnThenDetach(
      "adopted-shell-env-after-hold",
    );
    const after: ThreadEvent[] = [];
    const adopting = createManager(after);
    try {
      await adopting.reconcileBridgeWorkers();
      await adopting.completeBridgeWorkerAdoption(
        async () => new Map([["t1", null]]),
      );
      await waitFor(() =>
        after.some((event) => event.type === "turn/completed"),
      );

      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        vi.setSystemTime(Date.now() + 16 * 60_000);
        await adopting.replaceBaseShellEnv({ PATH: "/new/bin:/usr/bin" });
      } finally {
        vi.useRealTimers();
      }

      expect(adopting.get("env-1")).toBeUndefined();
    } finally {
      await adopting.shutdownAll("stop");
      if (isProcessAlive(registered.pid)) {
        process.kill(registered.pid, "SIGKILL");
      }
    }
  }, 30_000);

  it("opens a new turn segment when the server already ended the seeded turn", async () => {
    const { bbTurnId, createManager, registered } =
      await startTurnThenDetach("stale-seed");
    const after: ThreadEvent[] = [];
    const adopting = createManager(after);
    try {
      await adopting.reconcileBridgeWorkers();
      await adopting.completeBridgeWorkerAdoption(
        async () => new Map([["t1", null]]),
      );
      expect(adopting.get("env-1")?.runtime.getActiveTurnId("t1")).not.toBe(
        bbTurnId,
      );

      await waitFor(() =>
        after.some((event) => event.type === "turn/completed"),
      );
      const started = after.filter((event) => event.type === "turn/started");
      expect(started).toHaveLength(1);
      expect(started[0]?.scope).not.toEqual({ kind: "turn", turnId: bbTurnId });
      const completed = after.find((event) => event.type === "turn/completed");
      expect(completed?.scope).toEqual(started[0]?.scope);
      expect(
        after.some(
          (event) =>
            event.scope.kind === "turn" && event.scope.turnId === bbTurnId,
        ),
      ).toBe(false);
    } finally {
      await adopting.shutdownAll("stop");
      if (isProcessAlive(registered.pid)) {
        process.kill(registered.pid, "SIGKILL");
      }
    }
    expect(isProcessAlive(registered.pid)).toBe(false);
  }, 30_000);
});

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("RuntimeManager provider sign-in renewal", () => {
  async function renewalLock(): Promise<{
    configDir: string;
    lockPath: string;
  }> {
    const configDir = await makeTempDir("bb-sign-in-renewal-");
    const lockPath = path.join(configDir, ".oauth_refresh.lock");
    await fs.mkdir(lockPath);
    return { configDir, lockPath };
  }

  it("does not evict an idle environment while a sign-in renewal lock is held", async () => {
    const { configDir, lockPath } = await renewalLock();
    const runtime = createFakeRuntime();
    const manager = new RuntimeManager({
      createRuntime: () => runtime,
      provisionWorkspace: createProvisionWorkspaceMock("/tmp/env-renewal"),
      shellEnv: { CLAUDE_CONFIG_DIR: configDir },
    });
    await manager.ensureEnvironment({
      environmentId: "env-renewal",
      workspacePath: "/tmp/env-renewal",
    });

    const eviction = manager.replaceBaseShellEnv({
      CLAUDE_CONFIG_DIR: configDir,
      SHELL_ENVIRONMENT_CHANGED: "1",
    });
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(runtime.shutdown).not.toHaveBeenCalled();

    await fs.rm(lockPath, { recursive: true });
    await eviction;
    expect(runtime.shutdown).toHaveBeenCalledOnce();
  });

  it("does not reap idle provider sessions while a sign-in renewal lock is held", async () => {
    const { configDir, lockPath } = await renewalLock();
    const runtime = createFakeRuntime();
    const manager = new RuntimeManager({
      createRuntime: () => runtime,
      provisionWorkspace: createProvisionWorkspaceMock("/tmp/env-reap"),
      shellEnv: { CLAUDE_CONFIG_DIR: configDir },
    });
    await manager.ensureEnvironment({
      environmentId: "env-reap",
      workspacePath: "/tmp/env-reap",
    });

    const reaping = manager.reapIdleProviderSessions({
      idleForMs: 1_000,
      nowMs: 5_000,
    });
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(runtime.reapIdleProviderSessions).not.toHaveBeenCalled();

    await fs.rm(lockPath, { recursive: true });
    await reaping;
    expect(runtime.reapIdleProviderSessions).toHaveBeenCalledOnce();
  });

  it("holds the idle provider maintenance shutdown until the renewal lock clears, and gives up after the bound", async () => {
    const { configDir, lockPath } = await renewalLock();
    vi.useFakeTimers();
    try {
      const dataDir = await makeTempDir("bb-provider-maintenance-renewal-");
      const runtime = createFakeRuntime();
      const manager = new RuntimeManager({
        createRuntime: () => runtime,
        providerMaintenanceIdleTimeoutMs: 100,
        shellEnv: { CLAUDE_CONFIG_DIR: configDir },
      });

      await manager.withProviderMaintenanceRuntime(
        { dataDir },
        async () => undefined,
      );
      await vi.advanceTimersByTimeAsync(100 + 20_000);
      expect(runtime.shutdown).not.toHaveBeenCalled();

      const now = new Date();
      await fs.utimes(lockPath, now, now);
      await vi.advanceTimersByTimeAsync(10_500);
      expect(runtime.shutdown).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not retire a bridge worker while a sign-in renewal lock is held", async () => {
    const { configDir, lockPath } = await renewalLock();
    const dataDir = await makeTempDir("bb-sign-in-renewal-workers-");
    const dir = path.join(dataDir, "bridge-workers");
    await fs.mkdir(dir, { recursive: true });
    const registered = path.join(dir, "cccccccccccc.json");
    await fs.writeFile(
      registered,
      JSON.stringify({
        id: "cccccccccccc",
        socketPath: path.join(dir, "cccccccccccc.sock"),
      }),
    );
    const manager = new RuntimeManager({
      dataDir,
      createRuntime: () => createFakeRuntime(),
      provisionWorkspace: createProvisionWorkspaceMock("/tmp/env-retire-lock"),
      shellEnv: { CLAUDE_CONFIG_DIR: configDir },
    });

    let reconciled = false;
    const reconciling = manager.reconcileBridgeWorkers().then(() => {
      reconciled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(reconciled).toBe(false);

    await fs.rm(lockPath, { recursive: true });
    await reconciling;
    expect(reconciled).toBe(true);
    expect(await fs.readdir(dir)).toEqual([]);
  });

  it("ignores a renewal lock abandoned by a process that exited mid-renewal", async () => {
    const { configDir, lockPath } = await renewalLock();
    const abandonedAt = new Date(Date.now() - 120_000);
    await fs.utimes(lockPath, abandonedAt, abandonedAt);
    const runtime = createFakeRuntime();
    const manager = new RuntimeManager({
      createRuntime: () => runtime,
      provisionWorkspace: createProvisionWorkspaceMock("/tmp/env-abandoned"),
      shellEnv: { CLAUDE_CONFIG_DIR: configDir },
    });
    await manager.ensureEnvironment({
      environmentId: "env-abandoned",
      workspacePath: "/tmp/env-abandoned",
    });

    await manager.replaceBaseShellEnv({
      CLAUDE_CONFIG_DIR: configDir,
      SHELL_ENVIRONMENT_CHANGED: "1",
    });
    expect(runtime.shutdown).toHaveBeenCalledOnce();
  });

  it("stops runtimes at host daemon shutdown without waiting for a renewal", async () => {
    const { configDir } = await renewalLock();
    const runtime = createFakeRuntime();
    const manager = new RuntimeManager({
      createRuntime: () => runtime,
      provisionWorkspace: createProvisionWorkspaceMock("/tmp/env-quit"),
      shellEnv: { CLAUDE_CONFIG_DIR: configDir },
    });
    await manager.ensureEnvironment({
      environmentId: "env-quit",
      workspacePath: "/tmp/env-quit",
    });

    const started = Date.now();
    await manager.shutdownAll("stop");
    expect(runtime.shutdown).toHaveBeenCalledOnce();
    expect(Date.now() - started).toBeLessThan(250);
  });
});
