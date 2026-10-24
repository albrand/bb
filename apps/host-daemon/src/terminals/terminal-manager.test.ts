import fs from "node:fs/promises";
import { chmodSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentRuntime } from "@bb/agent-runtime";
import type { HostDaemonDaemonWsMessage } from "@bb/host-daemon-contract";
import {
  createTerminalGridMarker,
  createTerminalGridMarkerScanner,
  stripTerminalGridMarkers,
} from "@bb/domain";
import type { HostWorkspace } from "@bb/host-workspace";
import {
  createDeferredPromise,
  makeTempDir,
  makeWorkspaceMergeBase,
  makeWorkspaceStatus,
} from "@bb/test-helpers";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostDaemonLogger } from "../logger.js";
import { RuntimeManager } from "../runtime-manager.js";
import {
  ensureNodePtySpawnHelpersExecutableInPackage,
  resolveNodePtySpawnHelperPaths,
  resolveTerminalCwdOverride,
  TerminalManager,
  type ResolveTerminalShell,
  type SpawnTerminalPtyArgs,
  type TerminalPtyAdapter,
  type TerminalPtyDisposable,
  type TerminalPtyExit,
  type TerminalPtyProcess,
} from "./terminal-manager.js";

const DEFAULT_TERMINAL_START = { mode: "shell" } as const;
const tempDirs: string[] = [];

interface ResizeCall {
  cols: number;
  rows: number;
}

interface SpawnedTerminal {
  args: SpawnTerminalPtyArgs;
  pty: FakeTerminalPty;
}

interface TerminalManagerHarness {
  adapter: FakeTerminalPtyAdapter;
  logger: HostDaemonLogger;
  manager: TerminalManager;
  messages: HostDaemonDaemonWsMessage[];
  runtime: AgentRuntime;
  runtimeManager: RuntimeManager;
  workspace: HostWorkspace;
}

interface WaitForOutputArgs {
  messages: HostDaemonDaemonWsMessage[];
  text: string;
}

type TerminalMessageObserver = (message: HostDaemonDaemonWsMessage) => void;

interface CreateHarnessOptions {
  closeGracePeriodMs?: number;
  exitedRetentionMs?: number;
  maxExitedScrollbackBytes?: number;
  maxExitedTerminals?: number;
  onSendMessage: TerminalMessageObserver;
  preserveGridMarkers?: boolean;
  shellEnv?: NodeJS.ProcessEnv;
  resolveShell: ResolveTerminalShell;
}

interface CreateHarnessWithShellArgs {
  resolveShell: ResolveTerminalShell;
}

interface AttachTerminalArgs {
  requestId: string;
  terminalId: string;
}

type TerminalOutputChunk = Extract<
  HostDaemonDaemonWsMessage,
  { type: "terminal.output" }
>["chunk"];

type SteerTurnResult = Awaited<ReturnType<AgentRuntime["steerTurn"]>>;

async function writeEmptyFile(filePath: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, "");
}

function createFakeLogger(): HostDaemonLogger {
  return {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  };
}

async function cleanupTempDirs(): Promise<void> {
  await Promise.all(
    tempDirs.splice(0).map(async (tempDir) => {
      await fs.chmod(tempDir, 0o700).catch(() => undefined);
      await fs.rm(tempDir, { force: true, recursive: true });
    }),
  );
}

class FakeTerminalPty implements TerminalPtyProcess {
  disposeCount: number;
  exited = false;
  paused = false;
  pauseCount = 0;
  readonly killCalls: (string | null)[];
  readonly resizeCalls: ResizeCall[];
  readonly writeCalls: (Buffer | string)[];
  private readonly dataListeners: ((data: string) => void)[];
  private readonly exitListeners: ((event: TerminalPtyExit) => void)[];
  private readonly registeredDataListeners: ((data: string) => void)[];
  private readonly registeredExitListeners: ((
    event: TerminalPtyExit,
  ) => void)[];

  constructor() {
    this.disposeCount = 0;
    this.killCalls = [];
    this.resizeCalls = [];
    this.writeCalls = [];
    this.dataListeners = [];
    this.exitListeners = [];
    this.registeredDataListeners = [];
    this.registeredExitListeners = [];
  }

  dispose(): void {
    this.disposeCount += 1;
  }

  hasExited(): boolean {
    return this.exited;
  }

  pause(): void {
    this.paused = true;
    this.pauseCount += 1;
  }

  resume(): void {
    this.paused = false;
  }

  kill(signal?: string): void {
    this.killCalls.push(signal ?? null);
  }

  onData(listener: (data: string) => void): TerminalPtyDisposable {
    this.dataListeners.push(listener);
    this.registeredDataListeners.push(listener);
    return {
      dispose: () => {
        const index = this.dataListeners.indexOf(listener);
        if (index >= 0) {
          this.dataListeners.splice(index, 1);
        }
      },
    };
  }

  onExit(listener: (event: TerminalPtyExit) => void): TerminalPtyDisposable {
    this.exitListeners.push(listener);
    this.registeredExitListeners.push(listener);
    return {
      dispose: () => {
        const index = this.exitListeners.indexOf(listener);
        if (index >= 0) {
          this.exitListeners.splice(index, 1);
        }
      },
    };
  }

  resize(cols: number, rows: number): void {
    this.resizeCalls.push({ cols, rows });
  }

  write(data: Buffer | string): void {
    this.writeCalls.push(data);
  }

  emitData(data: string): void {
    for (const listener of this.dataListeners) {
      listener(data);
    }
  }

  emitExit(exitCode: number): void {
    for (const listener of [...this.exitListeners]) {
      listener({ exitCode });
    }
  }

  emitStaleData(data: string): void {
    for (const listener of [...this.registeredDataListeners]) {
      listener(data);
    }
  }

  emitStaleExit(exitCode: number): void {
    for (const listener of [...this.registeredExitListeners]) {
      listener({ exitCode });
    }
  }
}

class FakeTerminalPtyAdapter implements TerminalPtyAdapter {
  lastSpawnArgs: SpawnTerminalPtyArgs | null;
  onSpawn: ((args: SpawnTerminalPtyArgs) => void) | null;
  spawnError: Error | null;
  readonly spawned: SpawnedTerminal[];

  constructor() {
    this.spawned = [];
    this.lastSpawnArgs = null;
    this.onSpawn = null;
    this.spawnError = null;
  }

  spawn(args: SpawnTerminalPtyArgs): TerminalPtyProcess {
    this.lastSpawnArgs = args;
    this.onSpawn?.(args);
    if (this.spawnError !== null) throw this.spawnError;
    const pty = new FakeTerminalPty();
    this.spawned.push({ args, pty });
    return pty;
  }
}

function createFakeRuntime(): AgentRuntime {
  const steerTurnResult: SteerTurnResult = { status: "steered" };
  return {
    ensureProvider: vi.fn(async () => undefined),
    startThread: vi.fn(async () => ({
      providerThreadId: "provider-thread",
    })),
    prepareThreadRewind: vi.fn(async () => ({
      providerThreadId: "provider-thread-rewind",
    })),
    discardThreadRewind: vi.fn(async () => undefined),
    resumeThread: vi.fn(async () => ({
      providerThreadId: "provider-thread",
    })),
    runTurn: vi.fn(async () => undefined),
    steerTurn: vi.fn(async () => steerTurnResult),
    stopThread: vi.fn(async () => ({ providerCheckpointId: null })),
    clearThreadGoal: vi.fn(async () => ({ cleared: true })),
    renameThread: vi.fn(async () => undefined),
    archiveThread: vi.fn(async () => undefined),
    unarchiveThread: vi.fn(async () => undefined),
    listModels: vi.fn(async () => ({ models: [], selectedOnlyModels: [] })),
    listCommands: vi.fn(async () => ({ commands: [] })),
    providerHealth: vi.fn(async () => ({ supported: false as const })),
    providerUsage: vi.fn(async () => ({ supported: false as const })),
    providerInstallationStatus: vi.fn(async () => {
      throw new Error("Unexpected provider installation status call");
    }),
    providerInstallationRun: vi.fn(async () => {
      throw new Error("Unexpected provider installation run call");
    }),
    listRunningProviders: vi.fn(() => []),
    getActiveTurnId: vi.fn(() => null),
    waitForActiveTurn: vi.fn(async () => null),
    getProviderSession: vi.fn(() => null),
    reapIdleProviderSessions: vi.fn(async () => ({ reapedSessions: [] })),
    hasThread: vi.fn(() => false),
    getLiveThreadIds: vi.fn(() => []),
    hasOpenBackgroundWork: vi.fn(() => false),
    shutdown: vi.fn(async () => undefined),
    detach: vi.fn(async () => undefined),
    adoptBridgeWorkers: vi.fn(() => []),
    completeBridgeWorkerAdoption: vi.fn(),
  };
}

function createFakeWorkspace(path: string): HostWorkspace {
  return {
    path,
    isGitRepo: true,
    isWorktree: false,
    getCurrentBranch: vi.fn(async () => "main"),
    getHeadSha: vi.fn(async () => "commit-1"),
    getLocalStateSnapshot: vi.fn(async () => ({
      fingerprint: "local-1",
      branchName: "main",
    })),
    getSharedGitRefsSnapshot: vi.fn(async () => ({
      fingerprint: "refs-1",
      defaultBranch: "main",
    })),
    getAdditionalWorkspaceWriteRoots: vi.fn(async () => []),
    getStatus: vi.fn(async () =>
      makeWorkspaceStatus({
        mergeBase: makeWorkspaceMergeBase(),
      }),
    ),
    getDefaultBranch: vi.fn(async () => "main"),
    getDiff: vi.fn(async () => ({
      diff: "",
      files: "",
      mergeBaseRef: null,
      shortstat: "",
      truncated: false,
    })),
    diffFiles: vi.fn(async () => ({
      files: [],
      shortstat: "",
      mergeBaseRef: null,
      truncated: false,
    })),
    diffPatch: vi.fn(async () => []),
    commit: vi.fn(async () => ({
      commitSha: "commit-1",
      commitSubject: "commit",
    })),
  };
}

function createHarness(
  args: { preserveGridMarkers?: boolean } = {},
): TerminalManagerHarness {
  return createHarnessWithShell(
    {
      resolveShell: async () => "/bin/zsh",
    },
    args,
  );
}

function createHarnessWithShell(
  args: CreateHarnessWithShellArgs,
  options: { preserveGridMarkers?: boolean } = {},
): TerminalManagerHarness {
  return createHarnessWithOptions({
    onSendMessage: () => undefined,
    preserveGridMarkers: options.preserveGridMarkers,
    resolveShell: args.resolveShell,
  });
}

function createHarnessWithOptions(
  args: CreateHarnessOptions,
): TerminalManagerHarness {
  const adapter = new FakeTerminalPtyAdapter();
  const messages: HostDaemonDaemonWsMessage[] = [];
  const logger = createFakeLogger();
  const runtime = createFakeRuntime();
  const workspace = createFakeWorkspace("/tmp/terminal-workspace");
  const runtimeManager = new RuntimeManager({
    createRuntime: () => runtime,
    provisionWorkspace: async () => workspace,
    shellEnv: {
      BB_BASE_ENV: "1",
      ...args.shellEnv,
    },
  });
  const manager = new TerminalManager({
    closeGracePeriodMs: args.closeGracePeriodMs,
    exitedRetentionMs: args.exitedRetentionMs,
    maxExitedScrollbackBytes: args.maxExitedScrollbackBytes,
    maxExitedTerminals: args.maxExitedTerminals,
    logger,
    ptyAdapter: adapter,
    resolveShell: args.resolveShell,
    runtimeManager,
    sendMessage: (message) => {
      if (!args.preserveGridMarkers && message.type === "terminal.output") {
        message = {
          ...message,
          chunk: stripGridMarkerFromChunk(message.chunk),
        };
      } else if (
        !args.preserveGridMarkers &&
        message.type === "terminal.replay"
      ) {
        message = {
          ...message,
          chunks: message.chunks.map(stripGridMarkerFromChunk),
        };
      }
      messages.push(message);
      args.onSendMessage(message);
      return true;
    },
  });

  return {
    adapter,
    logger,
    manager,
    messages,
    runtime,
    runtimeManager,
    workspace,
  };
}

function stripGridMarkerFromChunk<T extends { dataBase64: string }>(
  chunk: T,
): T {
  return {
    ...chunk,
    dataBase64: Buffer.from(
      stripTerminalGridMarkers(
        Buffer.from(chunk.dataBase64, "base64").toString("utf8"),
      ),
    ).toString("base64"),
  };
}

function collectTerminalOutput(messages: HostDaemonDaemonWsMessage[]): string {
  const scanner = createTerminalGridMarkerScanner();
  const filtered = messages
    .flatMap((message) =>
      message.type === "terminal.output"
        ? [Buffer.from(message.chunk.dataBase64, "base64").toString("utf8")]
        : [],
    )
    .map((chunk) => scanner.push(chunk).text)
    .join("");
  return filtered + scanner.flush();
}

async function waitForOutputContaining(args: WaitForOutputArgs): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (collectTerminalOutput(args.messages).includes(args.text)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(
    `Timed out waiting for terminal output: ${args.text}\nCurrent output:\n${collectTerminalOutput(args.messages)}\nMessages:\n${JSON.stringify(args.messages)}`,
  );
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function openTerminal(
  harness: TerminalManagerHarness,
  contributedEnv: import("@bb/host-daemon-contract").HostDaemonContributedEnvEntry[] = [],
): Promise<FakeTerminalPty> {
  await harness.manager.handleMessage({
    type: "terminal.open",
    contributedEnv,
    requestId: "open-1",
    terminalId: "term-1",
    threadId: "thr-1",
    target: {
      kind: "workspace",
      environmentId: "env-1",
      workspaceContext: {
        workspacePath: "/tmp/terminal-workspace",
      },
    },
    cols: 100,
    rows: 30,
    start: DEFAULT_TERMINAL_START,
  });
  const spawned = harness.adapter.spawned[0];
  if (!spawned) {
    throw new Error("Expected terminal PTY to spawn");
  }
  return spawned.pty;
}

async function openTerminalWithId(
  harness: TerminalManagerHarness,
  terminalId: string,
): Promise<FakeTerminalPty> {
  const spawnedBefore = harness.adapter.spawned.length;
  await harness.manager.handleMessage({
    type: "terminal.open",
    contributedEnv: [],
    requestId: `open-${terminalId}`,
    terminalId,
    threadId: "thr-1",
    target: {
      kind: "workspace",
      environmentId: "env-1",
      workspaceContext: {
        workspacePath: "/tmp/terminal-workspace",
      },
    },
    cols: 100,
    rows: 30,
    start: DEFAULT_TERMINAL_START,
  });
  const spawned = harness.adapter.spawned[spawnedBefore];
  if (!spawned) {
    throw new Error(`Expected terminal PTY to spawn for ${terminalId}`);
  }
  return spawned.pty;
}

async function attachTerminal(
  harness: TerminalManagerHarness,
  args: AttachTerminalArgs,
): Promise<void> {
  await harness.manager.handleMessage({
    type: "terminal.attach",
    requestId: args.requestId,
    terminalId: args.terminalId,
    sinceSeq: 0,
    tailBytes: 4 * 1024 * 1024,
  });
}

function terminalNotFoundError(
  args: AttachTerminalArgs,
): HostDaemonDaemonWsMessage {
  return {
    type: "terminal.error",
    requestId: args.requestId,
    terminalId: args.terminalId,
    code: "terminal_not_found",
    message: "Terminal session is not open",
  };
}

function textChunk(text: string, seq: number): TerminalOutputChunk {
  return {
    seq,
    dataBase64: Buffer.from(text, "utf8").toString("base64"),
  };
}

describe("TerminalManager", () => {
  it("starts shell terminals through the terminal-id holder client when bb is available", async () => {
    const harness = createHarnessWithOptions({
      onSendMessage: () => undefined,
      resolveShell: async () => "/bin/zsh",
      shellEnv: { BB_CLI: "/tmp/bb" },
    });

    await openTerminal(harness);

    expect(harness.adapter.lastSpawnArgs?.file).toBe("/tmp/bb");
    expect(harness.adapter.lastSpawnArgs?.args.slice(0, 3)).toEqual([
      "terminal",
      "holder-shell-client",
      "term-1",
    ]);
    expect(harness.adapter.lastSpawnArgs?.args[3]).toBe("/bin/zsh");
    expect(
      JSON.parse(
        Buffer.from(
          harness.adapter.lastSpawnArgs?.args[4] ?? "",
          "base64",
        ).toString("utf8"),
      ),
    ).toEqual([]);
  });

  it("starts a direct shell when bb is unavailable", async () => {
    const harness = createHarnessWithOptions({
      onSendMessage: () => undefined,
      resolveShell: async () => "/bin/zsh",
      shellEnv: {},
    });

    await openTerminal(harness);

    expect(harness.adapter.lastSpawnArgs?.file).toBe("/bin/zsh");
    expect(harness.adapter.lastSpawnArgs?.args).not.toContain(
      "holder-shell-client",
    );
  });

  it("passes bash integration env and rcfile args through the holder client", async () => {
    const harness = createHarnessWithOptions({
      onSendMessage: () => undefined,
      resolveShell: async () => "/bin/bash",
      shellEnv: { BB_CLI: "/tmp/bb" },
    });

    await openTerminal(harness);

    const spawn = harness.adapter.lastSpawnArgs;
    expect(spawn?.file).toBe("/tmp/bb");
    expect(spawn?.args.slice(0, 4)).toEqual([
      "terminal",
      "holder-shell-client",
      "term-1",
      "/bin/bash",
    ]);
    const shellArgs = JSON.parse(
      Buffer.from(spawn?.args[4] ?? "", "base64").toString("utf8"),
    ) as string[];
    expect(shellArgs[0]).toBe("--rcfile");
    const rcFile = shellArgs[1];
    if (!rcFile) throw new Error("Expected bash integration rcfile");
    expect(await fs.readFile(rcFile, "utf8")).toContain("\\e]133;A\\a");
    expect(spawn?.env.BB_CLI).toBe("/tmp/bb");
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    await cleanupTempDirs();
  });

  it("opens a PTY in the workspace and keeps the environment active", async () => {
    const harness = createHarness();
    await openTerminal(harness);

    expect(harness.adapter.spawned).toHaveLength(1);
    expect(harness.adapter.spawned[0]?.args).toMatchObject({
      cols: 100,
      cwd: "/tmp/terminal-workspace",
      file: "/bin/zsh",
      rows: 30,
    });
    expect(harness.adapter.spawned[0]?.args.env).toMatchObject({
      BB_BASE_ENV: "1",
      BB_TERMINAL_SESSION_ID: "term-1",
      COLORTERM: "truecolor",
      DISABLE_AUTO_TITLE: "true",
      FORCE_HYPERLINK: "1",
      PROMPT_EOL_MARK: "",
      TERM: "xterm-256color",
    });
    expect(harness.messages).toContainEqual(
      expect.objectContaining({
        type: "terminal.opened",
        terminalId: "term-1",
        initialCwd: "/tmp/terminal-workspace",
        title: "zsh",
      }),
    );
    expect(harness.runtimeManager.get("env-1")?.terminals.has("term-1")).toBe(
      true,
    );
    await harness.runtimeManager.replaceBaseShellEnv({ BB_BASE_ENV: "2" });
    expect(harness.runtimeManager.get("env-1")).toBeDefined();
    expect(harness.runtime.shutdown).not.toHaveBeenCalled();
  });

  it("starts a split terminal in the requested existing directory", async () => {
    const harness = createHarness();
    await harness.manager.handleMessage({
      type: "terminal.open",
      contributedEnv: [],
      requestId: "open-split",
      terminalId: "term-split",
      threadId: "thr-1",
      target: {
        kind: "workspace",
        environmentId: "env-1",
        workspaceContext: { workspacePath: "/tmp/terminal-workspace" },
      },
      cwd: "/tmp",
      cols: 100,
      rows: 30,
      start: DEFAULT_TERMINAL_START,
    });
    expect(harness.adapter.spawned[0]?.args.cwd).toBe("/tmp");
  });

  it("removes shell integration files after a terminal closes", async () => {
    const harness = createHarness();
    const pty = await openTerminal(harness);
    const directory = harness.adapter.spawned[0]?.args.env.ZDOTDIR;
    if (!directory) throw new Error("Expected temporary ZDOTDIR");
    tempDirs.push(directory);
    await expect(fs.access(directory)).resolves.toBeUndefined();

    await harness.manager.handleMessage({
      type: "terminal.close",
      terminalId: "term-1",
      reason: "user",
    });
    pty.emitExit(0);

    await vi.waitFor(() =>
      expect(
        harness.messages.some(
          (message) =>
            message.type === "terminal.exited" &&
            message.terminalId === "term-1",
        ),
      ).toBe(true),
    );
    await vi.waitFor(async () =>
      expect(fs.access(directory)).rejects.toThrow(),
    );
  });

  it("removes shell integration files when PTY spawn fails", async () => {
    const harness = createHarness();
    harness.adapter.spawnError = new Error("spawn fixture failure");

    await harness.manager.handleMessage({
      type: "terminal.open",
      contributedEnv: [],
      requestId: "open-fails",
      terminalId: "term-fails",
      threadId: "thr-1",
      target: {
        kind: "workspace",
        environmentId: "env-1",
        workspaceContext: { workspacePath: "/tmp/terminal-workspace" },
      },
      cols: 100,
      rows: 30,
      start: DEFAULT_TERMINAL_START,
    });

    const directory = harness.adapter.lastSpawnArgs?.env.ZDOTDIR;
    if (!directory) throw new Error("Expected temporary ZDOTDIR");
    tempDirs.push(directory);
    await expect(fs.access(directory)).rejects.toThrow();
    expect(harness.messages).toContainEqual(
      expect.objectContaining({
        type: "terminal.error",
        terminalId: "term-fails",
        message: "spawn fixture failure",
      }),
    );
  });

  it("logs and preserves the spawn error when integration cleanup fails", async () => {
    const harness = createHarness();
    const spawnError = new Error("spawn fixture failure");
    harness.adapter.spawnError = spawnError;
    harness.adapter.onSpawn = (args) => {
      const directory = args.env.ZDOTDIR;
      if (!directory) throw new Error("Expected temporary ZDOTDIR");
      chmodSync(directory, 0o500);
    };

    await harness.manager.handleMessage({
      type: "terminal.open",
      contributedEnv: [],
      requestId: "open-cleanup-fails",
      terminalId: "term-cleanup-fails",
      threadId: "thr-1",
      target: {
        kind: "workspace",
        environmentId: "env-1",
        workspaceContext: { workspacePath: "/tmp/terminal-workspace" },
      },
      cols: 100,
      rows: 30,
      start: DEFAULT_TERMINAL_START,
    });

    const directory = harness.adapter.lastSpawnArgs?.env.ZDOTDIR;
    if (!directory) throw new Error("Expected temporary ZDOTDIR");
    tempDirs.push(directory);
    expect(harness.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ terminalId: "term-cleanup-fails" }),
      "Failed to remove terminal shell integration files",
    );
    expect(harness.messages).toContainEqual(
      expect.objectContaining({
        type: "terminal.error",
        terminalId: "term-cleanup-fails",
        message: spawnError.message,
      }),
    );
    await fs.chmod(directory, 0o700);
    await fs.rm(directory, { force: true, recursive: true });
  });

  it("logs shell integration cleanup failures without interrupting close", async () => {
    const harness = createHarness();
    const pty = await openTerminal(harness);
    const directory = harness.adapter.spawned[0]?.args.env.ZDOTDIR;
    if (!directory) throw new Error("Expected temporary ZDOTDIR");
    tempDirs.push(directory);
    await fs.chmod(directory, 0o500);

    await harness.manager.handleMessage({
      type: "terminal.close",
      terminalId: "term-1",
      reason: "user",
    });
    pty.emitExit(0);

    await vi.waitFor(() =>
      expect(harness.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ terminalId: "term-1" }),
        "Failed to remove terminal shell integration files",
      ),
    );
    expect(harness.messages).toContainEqual(
      expect.objectContaining({
        type: "terminal.exited",
        terminalId: "term-1",
        exitCode: 0,
      }),
    );
    await fs.chmod(directory, 0o700);
    await fs.rm(directory, { force: true, recursive: true });
  });

  it.each([
    ["relative", "tmp", "/tmp/terminal-workspace"],
    ["parent traversal", "/tmp/../tmp", "/tmp/terminal-workspace"],
    ["NUL", "/tmp\0invalid", "/tmp/terminal-workspace"],
    ["file", "/etc/passwd", "/tmp/terminal-workspace"],
    ["missing", "/tmp/p19-missing-cwd", "/tmp/terminal-workspace"],
    ["over-long", `/${"a".repeat(4096)}`, "/tmp/terminal-workspace"],
  ] as const)(
    "safely resolves %s cwd input",
    async (_label, cwd, expectedCwd) => {
      const harness = createHarness();
      await harness.manager.handleMessage({
        type: "terminal.open",
        contributedEnv: [],
        requestId: "open-cwd-input",
        terminalId: "term-cwd-input",
        threadId: "thr-1",
        target: {
          kind: "workspace",
          environmentId: "env-1",
          workspaceContext: { workspacePath: "/tmp/terminal-workspace" },
        },
        cwd,
        cols: 100,
        rows: 30,
        start: DEFAULT_TERMINAL_START,
      });
      expect(harness.adapter.spawned).toHaveLength(1);
      expect(harness.adapter.spawned[0]?.args.cwd).toBe(expectedCwd);
      expect(harness.messages).toContainEqual(
        expect.objectContaining({
          type: "terminal.opened",
          terminalId: "term-cwd-input",
          initialCwd: expectedCwd,
        }),
      );
    },
  );

  it.each([
    ["forward slash", "C:/base/../outside"],
    ["backslash", String.raw`C:\base\..\outside`],
  ])(
    "rejects Windows cwd traversal with %s separators",
    async (_label, cwd) => {
      const statPath = vi.fn(async () => ({ isDirectory: () => true }));

      await expect(
        resolveTerminalCwdOverride(
          { cwd, defaultCwd: String.raw`C:\workspace` },
          { pathApi: path.win32, statPath },
        ),
      ).resolves.toBe(String.raw`C:\workspace`);
      expect(statPath).not.toHaveBeenCalled();
    },
  );

  it("injects the starting grid before terminal output", async () => {
    const harness = createHarness({ preserveGridMarkers: true });
    const pty = await openTerminal(harness, [
      {
        name: "GH_TOKEN",
        value: "terminal-private-token",
        source: { core: "machine-git" },
        reason: "Git",
      },
    ]);
    expect(harness.adapter.spawned[0]?.args.env.GH_TOKEN).toBe(
      "terminal-private-token",
    );
    pty.emitData("terminal-private-token");
    await waitForOutputContaining({
      messages: harness.messages,
      text: "terminal-private-token",
    });
    expect(collectTerminalOutput(harness.messages)).toContain(
      "terminal-private-token",
    );
    const rawOutput = harness.messages
      .filter((message) => message.type === "terminal.output")
      .map((message) =>
        Buffer.from(message.chunk.dataBase64, "base64").toString("utf8"),
      )
      .join("");
    expect(
      rawOutput.startsWith(createTerminalGridMarker({ cols: 100, rows: 30 })),
    ).toBe(true);
  });

  it("strips a program-emitted grid marker split across PTY chunks", async () => {
    const harness = createHarness({ preserveGridMarkers: true });
    const pty = await openTerminal(harness);
    const spoof = createTerminalGridMarker({ cols: 41, rows: 17 });
    pty.emitData(spoof.slice(0, 10));
    pty.emitData(`${spoof.slice(10)}payload`);
    await waitForOutputContaining({
      messages: harness.messages,
      text: "payload",
    });
    const rawOutput = harness.messages
      .filter((message) => message.type === "terminal.output")
      .map((message) =>
        Buffer.from(message.chunk.dataBase64, "base64").toString("utf8"),
      )
      .join("");
    expect(rawOutput).toContain(
      createTerminalGridMarker({ cols: 100, rows: 30 }),
    );
    expect(rawOutput).not.toContain(spoof);
  });

  it("puts the new grid marker between old-size and new-size output", async () => {
    const harness = createHarness({ preserveGridMarkers: true });
    const markTerminalActive = vi.spyOn(
      harness.runtimeManager,
      "markTerminalActive",
    );
    const pty = await openTerminal(harness);
    expect(markTerminalActive).toHaveBeenCalledTimes(1);
    pty.emitData("old-size");
    await harness.manager.handleMessage({
      type: "terminal.resize",
      terminalId: "term-1",
      cols: 51,
      rows: 16,
    });
    expect(markTerminalActive).toHaveBeenCalledTimes(1);
    pty.emitData("new-size");
    await waitForOutputContaining({
      messages: harness.messages,
      text: "new-size",
    });
    const rawOutput = harness.messages
      .filter((message) => message.type === "terminal.output")
      .map((message) =>
        Buffer.from(message.chunk.dataBase64, "base64").toString("utf8"),
      )
      .join("");
    expect(rawOutput).toBe(
      `${createTerminalGridMarker({ cols: 100, rows: 30 })}old-size${createTerminalGridMarker({ cols: 51, rows: 16 })}new-size`,
    );
  });

  it("opens a command PTY through the resolved shell", async () => {
    const harness = createHarness();

    await harness.manager.handleMessage({
      type: "terminal.open",
      contributedEnv: [],
      requestId: "open-command",
      terminalId: "term-command",
      threadId: "thr-1",
      target: {
        kind: "workspace",
        environmentId: "env-1",
        workspaceContext: {
          workspacePath: "/tmp/terminal-workspace",
        },
      },
      cols: 100,
      rows: 30,
      start: { mode: "command", command: "pnpm dev" },
    });

    expect(harness.adapter.spawned[0]?.args).toMatchObject({
      args: ["-lc", "pnpm dev"],
      file: "/bin/zsh",
    });
    expect(harness.messages).toContainEqual(
      expect.objectContaining({
        type: "terminal.opened",
        terminalId: "term-command",
        title: "pnpm dev",
      }),
    );
    expect(
      harness.runtimeManager.get("env-1")?.terminals.has("term-command"),
    ).toBe(true);

    const wideCommand = "调".repeat(100);
    await harness.manager.handleMessage({
      type: "terminal.open",
      contributedEnv: [],
      requestId: "open-wide-command",
      terminalId: "term-wide-command",
      threadId: "thr-1",
      target: {
        kind: "workspace",
        environmentId: "env-1",
        workspaceContext: {
          workspacePath: "/tmp/terminal-workspace",
        },
      },
      cols: 100,
      rows: 30,
      start: { mode: "command", command: wideCommand },
    });
    expect(harness.messages).toContainEqual(
      expect.objectContaining({
        type: "terminal.opened",
        terminalId: "term-wide-command",
        title: `${"调".repeat(38)}...`,
      }),
    );

    await harness.runtimeManager.replaceBaseShellEnv({ BB_BASE_ENV: "2" });
    expect(harness.runtimeManager.get("env-1")).toBeDefined();
    expect(harness.runtime.shutdown).not.toHaveBeenCalled();
  });

  it("opens a PTY in a host path without an environment", async () => {
    const cwd = await makeTempDir("bb-terminal-host-path-");
    const harness = createHarness();

    await harness.manager.handleMessage({
      type: "terminal.open",
      contributedEnv: [],
      requestId: "open-host-path",
      terminalId: "term-host-path",
      target: {
        kind: "host_path",
        cwd,
      },
      cols: 80,
      rows: 24,
      start: DEFAULT_TERMINAL_START,
    });

    expect(harness.adapter.spawned).toHaveLength(1);
    expect(harness.adapter.spawned[0]?.args).toMatchObject({
      cols: 80,
      cwd,
      rows: 24,
    });
    expect(harness.messages).toContainEqual(
      expect.objectContaining({
        type: "terminal.opened",
        terminalId: "term-host-path",
        initialCwd: cwd,
      }),
    );
    expect(harness.runtimeManager.get("env-1")).toBeUndefined();
  });

  it("opens a host-path PTY in the home directory when no cwd is provided", async () => {
    const harness = createHarness();
    const expectedCwd = os.homedir();

    await harness.manager.handleMessage({
      type: "terminal.open",
      contributedEnv: [],
      requestId: "open-host-home",
      terminalId: "term-host-home",
      target: {
        kind: "host_path",
        cwd: null,
      },
      cols: 80,
      rows: 24,
      start: DEFAULT_TERMINAL_START,
    });

    expect(harness.adapter.spawned).toHaveLength(1);
    expect(harness.adapter.spawned[0]?.args).toMatchObject({
      cwd: expectedCwd,
    });
    expect(harness.messages).toContainEqual(
      expect.objectContaining({
        type: "terminal.opened",
        terminalId: "term-host-home",
        initialCwd: expectedCwd,
      }),
    );
    expect(harness.runtimeManager.get("env-1")).toBeUndefined();
  });

  it("closes a terminal after an in-progress open finishes", async () => {
    const shell = createDeferredPromise<string>();
    let resolveShellCalls = 0;
    const harness = createHarnessWithShell({
      resolveShell: () => {
        resolveShellCalls += 1;
        return shell.promise;
      },
    });

    const openPromise = harness.manager.handleMessage({
      type: "terminal.open",
      contributedEnv: [],
      requestId: "open-1",
      terminalId: "term-1",
      threadId: "thr-1",
      target: {
        kind: "workspace",
        environmentId: "env-1",
        workspaceContext: {
          workspacePath: "/tmp/terminal-workspace",
        },
      },
      cols: 100,
      rows: 30,
      start: DEFAULT_TERMINAL_START,
    });
    await vi.waitFor(() => expect(resolveShellCalls).toBe(1));

    const closePromise = harness.manager.handleMessage({
      type: "terminal.close",
      terminalId: "term-1",
      reason: "user",
    });

    expect(harness.adapter.spawned).toHaveLength(0);
    shell.resolve("/bin/zsh");
    await Promise.all([openPromise, closePromise]);

    const pty = harness.adapter.spawned[0]?.pty;
    if (!pty) {
      throw new Error("Expected terminal PTY to spawn");
    }
    expect(harness.adapter.spawned).toHaveLength(1);
    expect(pty.killCalls).toEqual([null]);

    pty.emitExit(0);
    await vi.waitFor(() =>
      expect(
        harness.messages.filter(
          (message) => message.type === "terminal.exited",
        ),
      ).toEqual([
        {
          type: "terminal.exited",
          terminalId: "term-1",
          exitCode: 0,
          closeReason: "user",
        },
      ]),
    );
  });

  it("shuts down terminals after in-progress opens finish", async () => {
    const shell = createDeferredPromise<string>();
    let resolveShellCalls = 0;
    const harness = createHarnessWithShell({
      resolveShell: () => {
        resolveShellCalls += 1;
        return shell.promise;
      },
    });

    const openPromise = harness.manager.handleMessage({
      type: "terminal.open",
      contributedEnv: [],
      requestId: "open-1",
      terminalId: "term-1",
      threadId: "thr-1",
      target: {
        kind: "workspace",
        environmentId: "env-1",
        workspaceContext: {
          workspacePath: "/tmp/terminal-workspace",
        },
      },
      cols: 100,
      rows: 30,
      start: DEFAULT_TERMINAL_START,
    });
    await vi.waitFor(() => expect(resolveShellCalls).toBe(1));

    const shutdownPromise = harness.manager.shutdownAll();
    shell.resolve("/bin/zsh");
    await Promise.all([openPromise, shutdownPromise]);

    const pty = harness.adapter.spawned[0]?.pty;
    if (!pty) {
      throw new Error("Expected terminal PTY to spawn");
    }
    expect(pty.killCalls).toEqual([null]);
    expect(
      harness.messages.filter((message) => message.type === "terminal.exited"),
    ).toEqual([
      {
        type: "terminal.exited",
        terminalId: "term-1",
        exitCode: null,
        closeReason: "daemon-disconnect",
      },
    ]);
  });

  it("serializes PTY exits behind already queued terminal messages", async () => {
    const shell = createDeferredPromise<string>();
    let resolveShellCalls = 0;
    let exitOnOpened = false;
    let harness: TerminalManagerHarness | null = null;
    harness = createHarnessWithOptions({
      onSendMessage: (message) => {
        if (!exitOnOpened || message.type !== "terminal.opened") {
          return;
        }
        const currentHarness = harness;
        const pty = currentHarness?.adapter.spawned[0]?.pty;
        if (!pty) {
          throw new Error("Expected terminal PTY to spawn");
        }
        pty.emitExit(0);
      },
      resolveShell: () => {
        resolveShellCalls += 1;
        return shell.promise;
      },
    });

    const firstOpenPromise = harness.manager.handleMessage({
      type: "terminal.open",
      contributedEnv: [],
      requestId: "open-1",
      terminalId: "term-1",
      threadId: "thr-1",
      target: {
        kind: "workspace",
        environmentId: "env-1",
        workspaceContext: {
          workspacePath: "/tmp/terminal-workspace",
        },
      },
      cols: 100,
      rows: 30,
      start: DEFAULT_TERMINAL_START,
    });
    await vi.waitFor(() => expect(resolveShellCalls).toBe(1));

    const secondOpenPromise = harness.manager.handleMessage({
      type: "terminal.open",
      contributedEnv: [],
      requestId: "open-2",
      terminalId: "term-1",
      threadId: "thr-1",
      target: {
        kind: "workspace",
        environmentId: "env-1",
        workspaceContext: {
          workspacePath: "/tmp/terminal-workspace",
        },
      },
      cols: 100,
      rows: 30,
      start: DEFAULT_TERMINAL_START,
    });

    exitOnOpened = true;
    shell.resolve("/bin/zsh");
    await Promise.all([firstOpenPromise, secondOpenPromise]);

    expect(harness.adapter.spawned).toHaveLength(1);
    expect(resolveShellCalls).toBe(1);
    await vi.waitFor(() =>
      expect(
        harness.messages.filter(
          (message) =>
            message.type === "terminal.opened" ||
            message.type === "terminal.error" ||
            message.type === "terminal.exited",
        ),
      ).toEqual([
        expect.objectContaining({
          type: "terminal.opened",
          requestId: "open-1",
          terminalId: "term-1",
        }),
        {
          type: "terminal.error",
          requestId: "open-2",
          terminalId: "term-1",
          code: "terminal_exists",
          message: "Terminal session is already open",
        },
        {
          type: "terminal.exited",
          terminalId: "term-1",
          exitCode: 0,
          closeReason: "process-exit",
        },
      ]),
    );
  });

  it("rejects terminal opens when the loaded runtime path differs from workspaceContext", async () => {
    const harness = createHarness();
    await harness.runtimeManager.ensureEnvironment({
      environmentId: "env-1",
      workspacePath: "/tmp/terminal-workspace",
    });

    await harness.manager.handleMessage({
      type: "terminal.open",
      contributedEnv: [],
      requestId: "open-stale",
      terminalId: "term-stale",
      threadId: "thr-1",
      target: {
        kind: "workspace",
        environmentId: "env-1",
        workspaceContext: {
          workspacePath: "/tmp/stale-terminal-workspace",
        },
      },
      cols: 100,
      rows: 30,
      start: DEFAULT_TERMINAL_START,
    });

    expect(harness.adapter.spawned).toHaveLength(0);
    expect(harness.messages).toEqual([
      {
        type: "terminal.error",
        requestId: "open-stale",
        terminalId: "term-stale",
        code: "workspace_type_mismatch",
        message:
          "Loaded environment env-1 is bound to /tmp/terminal-workspace, not /tmp/stale-terminal-workspace",
      },
    ]);
  });

  it("scrubs inherited bb runtime env vars before spawning a terminal", async () => {
    vi.stubEnv("BB_DATA_DIR", "/tmp/leaked-bb-data");
    vi.stubEnv("BB_HOST_DAEMON_PORT", "38887");
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("OPENAI_API_KEY", "external-secret");

    const harness = createHarness();
    await openTerminal(harness);

    const env = harness.adapter.spawned[0]?.args.env;
    expect(env).toMatchObject({
      BB_BASE_ENV: "1",
      BB_TERMINAL_SESSION_ID: "term-1",
      OPENAI_API_KEY: "external-secret",
    });
    expect(env?.BB_DATA_DIR).toBeUndefined();
    expect(env?.BB_HOST_DAEMON_PORT).toBeUndefined();
    expect(env?.NODE_ENV).toBeUndefined();
  });

  it("keeps a launching agent session's markers out of terminal shells", async () => {
    const markers = [
      "CLAUDECODE",
      "CLAUDE_CODE_CHILD_SESSION",
      "CLAUDE_CODE_ENTRYPOINT",
      "CLAUDE_CODE_EXECPATH",
      "CLAUDE_CODE_MESSAGING_SOCKET",
      "CLAUDE_CODE_MESSAGING_TOKEN",
      "CLAUDE_CODE_SESSION_ATTENDED",
      "CLAUDE_CODE_SESSION_ID",
      "CLAUDE_PID",
    ];
    for (const marker of markers) {
      vi.stubEnv(marker, "outer-session");
    }
    vi.stubEnv("CLAUDE_CODE_USE_BEDROCK", "1");
    vi.stubEnv("ANTHROPIC_API_KEY", "user-key");

    const harness = createHarness();
    await openTerminal(harness);

    const env = harness.adapter.spawned[0]?.args.env;
    expect(env).toMatchObject({
      ANTHROPIC_API_KEY: "user-key",
      BB_TERMINAL_SESSION_ID: "term-1",
      CLAUDE_CODE_USE_BEDROCK: "1",
    });
    for (const marker of markers) {
      expect(env).not.toHaveProperty(marker);
    }
  });

  it("keeps the daemon's Electron run-as-node mode out of terminal shells", async () => {
    vi.stubEnv("ELECTRON_RUN_AS_NODE", "1");
    const harness = createHarness();
    await openTerminal(harness);

    const env = harness.adapter.spawned[0]?.args.env;
    expect(env?.BB_TERMINAL_SESSION_ID).toBe("term-1");
    expect(env).not.toHaveProperty("ELECTRON_RUN_AS_NODE");
  });

  it("makes every available node-pty spawn-helper executable", async () => {
    const logger = createFakeLogger();
    const packageDirectory = await makeTempDir("bb-node-pty-package-");
    const buildNativePath = path.join(
      packageDirectory,
      "build",
      "Release",
      "pty.node",
    );
    const buildHelperPath = path.join(
      packageDirectory,
      "build",
      "Release",
      "spawn-helper",
    );
    const prebuildHelperPath = path.join(
      packageDirectory,
      "prebuilds",
      `${process.platform}-${process.arch}`,
      "spawn-helper",
    );
    await writeEmptyFile(buildNativePath);
    await writeEmptyFile(buildHelperPath);
    await fs.chmod(buildHelperPath, 0o644);
    await writeEmptyFile(
      path.join(
        packageDirectory,
        "prebuilds",
        `${process.platform}-${process.arch}`,
        "pty.node",
      ),
    );
    await writeEmptyFile(prebuildHelperPath);
    await fs.chmod(prebuildHelperPath, 0o644);

    expect(resolveNodePtySpawnHelperPaths({ packageDirectory })).toEqual([
      buildHelperPath,
      prebuildHelperPath,
    ]);

    ensureNodePtySpawnHelpersExecutableInPackage({
      logger,
      packageDirectory,
    });

    if (process.platform !== "win32") {
      const buildHelperMode = (await fs.stat(buildHelperPath)).mode;
      const prebuildHelperMode = (await fs.stat(prebuildHelperPath)).mode;
      expect(buildHelperMode & 0o111).not.toBe(0);
      expect(prebuildHelperMode & 0o111).not.toBe(0);
    }
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("logs and skips when no node-pty spawn-helper is present", async () => {
    const logger = createFakeLogger();
    const packageDirectory = await makeTempDir("bb-node-pty-package-");
    const buildHelperPath = path.join(
      packageDirectory,
      "build",
      "Release",
      "spawn-helper",
    );
    const prebuildHelperPath = path.join(
      packageDirectory,
      "prebuilds",
      `${process.platform}-${process.arch}`,
      "spawn-helper",
    );
    await writeEmptyFile(
      path.join(packageDirectory, "build", "Release", "pty.node"),
    );
    await writeEmptyFile(
      path.join(
        packageDirectory,
        "prebuilds",
        `${process.platform}-${process.arch}`,
        "pty.node",
      ),
    );

    expect(() =>
      ensureNodePtySpawnHelpersExecutableInPackage({
        logger,
        packageDirectory,
      }),
    ).not.toThrow();
    expect(logger.warn).toHaveBeenCalledWith({
      component: "terminal-manager",
      msg: "no node-pty spawn-helper found at known paths",
      searched: expect.arrayContaining([buildHelperPath, prebuildHelperPath]),
    });
  });

  it("forwards output and replays scrollback on attach", async () => {
    const harness = createHarness({ preserveGridMarkers: true });
    const pty = await openTerminal(harness);

    pty.emitData("hello");
    pty.emitData("\n");
    await harness.manager.handleMessage({
      type: "terminal.attach",
      requestId: "attach-1",
      terminalId: "term-1",
      sinceSeq: 0,
      tailBytes: 4 * 1024 * 1024,
    });

    const emitted = harness.messages.filter(
      (message) => message.type === "terminal.output",
    );
    expect(emitted).toHaveLength(1);
    const emittedChunk = emitted[0];
    if (emittedChunk?.type !== "terminal.output")
      throw new Error("Missing output");
    expect(
      Buffer.from(emittedChunk.chunk.dataBase64, "base64").toString("utf8"),
    ).toBe(`${createTerminalGridMarker({ cols: 100, rows: 30 })}hello\n`);
    expect(harness.messages).toContainEqual({
      type: "terminal.replay",
      requestId: "attach-1",
      terminalId: "term-1",
      chunks: [
        {
          seq: 0,
          dataBase64: Buffer.from(
            `${createTerminalGridMarker({ cols: 100, rows: 30 })}hello\n`,
            "utf8",
          ).toString("base64"),
        },
      ],
      replayStartSeq: 0,
      nextSeq: 1,
    });
  });

  it("reports unattended terminal attention and coalesces repeats for two seconds", async () => {
    vi.useFakeTimers();
    let now = 1_000_000;
    const dateNow = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      const harness = createHarness();
      const pty = await openTerminal(harness);
      pty.emitData("\u0007\u001b]9;build finished\u0007");
      await vi.advanceTimersByTimeAsync(50);
      expect(
        harness.messages.filter(
          (message) => message.type === "terminal.attention",
        ),
      ).toEqual([
        {
          type: "terminal.attention",
          terminalId: "term-1",
          seq: 0,
          kind: "bell",
        },
      ]);
      now = 1_001_999;
      pty.emitData("\u001b]777;notify;Build;Again\u0007");
      await vi.advanceTimersByTimeAsync(50);
      expect(
        harness.messages.filter(
          (message) => message.type === "terminal.attention",
        ),
      ).toHaveLength(1);
      now = 1_002_000;
      pty.emitData("\u001b]777;notify;Build;Again\u0007");
      await vi.advanceTimersByTimeAsync(50);
      expect(
        harness.messages.filter(
          (message) => message.type === "terminal.attention",
        ),
      ).toHaveLength(2);
    } finally {
      dateNow.mockRestore();
      vi.useRealTimers();
    }
  });

  it("flushes the first output after an idle period without the batch delay", async () => {
    const harness = createHarness();
    const pty = await openTerminal(harness);
    vi.useFakeTimers({
      toFake: [
        "setTimeout",
        "clearTimeout",
        "setImmediate",
        "clearImmediate",
        "performance",
      ],
    });
    await vi.advanceTimersByTimeAsync(4);

    pty.emitData("a");
    await vi.advanceTimersByTimeAsync(0);

    expect(collectTerminalOutput(harness.messages)).toBe("a");

    pty.emitData("b");
    await vi.advanceTimersByTimeAsync(3);

    expect(collectTerminalOutput(harness.messages)).toBe("a");
    await vi.advanceTimersByTimeAsync(1);
    expect(collectTerminalOutput(harness.messages)).toBe("ab");

    await vi.advanceTimersByTimeAsync(4);
    pty.emitData("c");
    await vi.advanceTimersByTimeAsync(0);
    expect(collectTerminalOutput(harness.messages)).toBe("abc");
  });

  it("pauses the PTY a window ahead of acknowledged output and resumes on acknowledgement", async () => {
    const harness = createHarness();
    const pty = await openTerminal(harness);
    await harness.manager.handleMessage({
      type: "terminal.flow-control",
      terminalId: "term-1",
      enabled: true,
    });
    const chunk = "x".repeat(64 * 1024);

    for (let index = 0; index < 15; index += 1) {
      pty.emitData(chunk);
    }
    expect(pty.paused).toBe(false);
    pty.emitData(chunk);
    expect(pty.paused).toBe(true);

    await harness.manager.handleMessage({
      type: "terminal.ack",
      terminalId: "term-1",
      nextSeq: 8,
    });
    expect(pty.paused).toBe(true);
    await harness.manager.handleMessage({
      type: "terminal.ack",
      terminalId: "term-1",
      nextSeq: 9,
    });
    expect(pty.paused).toBe(false);
  });

  it("resumes a paused PTY whose process exited so node-pty can drain it", async () => {
    const harness = createHarness();
    const pty = await openTerminal(harness);
    await harness.manager.handleMessage({
      type: "terminal.flow-control",
      terminalId: "term-1",
      enabled: true,
    });
    for (let index = 0; index < 17; index += 1) {
      pty.emitData("x".repeat(64 * 1024));
    }
    expect(pty.paused).toBe(true);

    pty.exited = true;

    await vi.waitFor(() => {
      expect(pty.paused).toBe(false);
    });
  });

  it("stops pacing every PTY when the server connection is released", async () => {
    const harness = createHarness();
    const pty = await openTerminal(harness);
    await harness.manager.handleMessage({
      type: "terminal.flow-control",
      terminalId: "term-1",
      enabled: true,
    });
    for (let index = 0; index < 17; index += 1) {
      pty.emitData("x".repeat(64 * 1024));
    }
    expect(pty.paused).toBe(true);

    harness.manager.releaseOutputFlowControl();
    for (let index = 0; index < 17; index += 1) {
      pty.emitData("x".repeat(64 * 1024));
    }

    expect(pty.paused).toBe(false);
    expect(pty.pauseCount).toBe(1);
  });

  it("keeps a retained terminal read-only after it exits", async () => {
    const harness = createHarness();
    const pty = await openTerminal(harness);

    pty.emitData("build failed\n");
    pty.emitExit(1);
    await harness.manager.handleMessage({
      type: "terminal.input",
      terminalId: "term-1",
      dataBase64: Buffer.from("pwd\n", "utf8").toString("base64"),
    });
    await harness.manager.handleMessage({
      type: "terminal.resize",
      terminalId: "term-1",
      cols: 120,
      rows: 40,
    });
    pty.emitStaleData("after exit\n");
    await attachTerminal(harness, {
      requestId: "attach-read-only",
      terminalId: "term-1",
    });

    expect(pty.writeCalls).toEqual([]);
    expect(pty.resizeCalls).toEqual([]);
    expect(harness.messages).toContainEqual({
      type: "terminal.exited",
      terminalId: "term-1",
      exitCode: 1,
      closeReason: "process-exit",
    });
    expect(harness.messages).toContainEqual({
      type: "terminal.replay",
      requestId: "attach-read-only",
      terminalId: "term-1",
      chunks: [textChunk("build failed\n", 0)],
      replayStartSeq: 0,
      nextSeq: 1,
    });
  });

  it("forgets retained scrollback once the retention window passes", async () => {
    vi.useFakeTimers();
    const harness = createHarnessWithOptions({
      exitedRetentionMs: 60_000,
      onSendMessage: () => undefined,
      resolveShell: async () => "/bin/zsh",
    });
    const pty = await openTerminal(harness);

    pty.emitData("build failed\n");
    pty.emitExit(1);
    await vi.advanceTimersByTimeAsync(59_000);
    await attachTerminal(harness, {
      requestId: "attach-before-expiry",
      terminalId: "term-1",
    });
    expect(harness.manager["retainedReplayParserStateBytes"]).toBe(0);
    await vi.advanceTimersByTimeAsync(1_000);
    await attachTerminal(harness, {
      requestId: "attach-after-expiry",
      terminalId: "term-1",
    });

    expect(harness.messages).toContainEqual({
      type: "terminal.replay",
      requestId: "attach-before-expiry",
      terminalId: "term-1",
      chunks: [textChunk("build failed\n", 0)],
      replayStartSeq: 0,
      nextSeq: 1,
    });
    expect(harness.messages).toContainEqual(
      terminalNotFoundError({
        requestId: "attach-after-expiry",
        terminalId: "term-1",
      }),
    );
    expect(vi.getTimerCount()).toBe(0);
    expect(harness.manager["retainedReplayParserStateBytes"]).toBe(0);
  });

  it("evicts the oldest retained terminal past the retained terminal cap", async () => {
    const harness = createHarnessWithOptions({
      maxExitedTerminals: 1,
      onSendMessage: () => undefined,
      resolveShell: async () => "/bin/zsh",
    });
    const first = await openTerminalWithId(harness, "term-first");
    first.emitData("first output\n");
    first.emitExit(0);
    const second = await openTerminalWithId(harness, "term-second");
    second.emitData("second output\n");
    second.emitExit(0);

    await attachTerminal(harness, {
      requestId: "attach-first",
      terminalId: "term-first",
    });
    await attachTerminal(harness, {
      requestId: "attach-second",
      terminalId: "term-second",
    });

    expect(harness.messages).toContainEqual(
      terminalNotFoundError({
        requestId: "attach-first",
        terminalId: "term-first",
      }),
    );
    expect(harness.messages).toContainEqual({
      type: "terminal.replay",
      requestId: "attach-second",
      terminalId: "term-second",
      chunks: [textChunk("second output\n", 0)],
      replayStartSeq: 0,
      nextSeq: 1,
    });
    expect(harness.manager["retainedReplayParserStateBytes"]).toBe(0);
    harness.manager.dispose();
    expect(harness.manager["retainedReplayParserStateBytes"]).toBe(0);
  });

  it("evicts the oldest retained terminal past the retained byte cap", async () => {
    const harness = createHarnessWithOptions({
      maxExitedScrollbackBytes: 8,
      onSendMessage: () => undefined,
      resolveShell: async () => "/bin/zsh",
    });
    const first = await openTerminalWithId(harness, "term-first");
    first.emitData("first output\n");
    first.emitExit(0);
    await attachTerminal(harness, {
      requestId: "attach-only-retained",
      terminalId: "term-first",
    });
    const second = await openTerminalWithId(harness, "term-second");
    second.emitData("second output\n");
    second.emitExit(0);
    await attachTerminal(harness, {
      requestId: "attach-evicted",
      terminalId: "term-first",
    });
    await attachTerminal(harness, {
      requestId: "attach-newest",
      terminalId: "term-second",
    });

    expect(harness.messages).toContainEqual({
      type: "terminal.replay",
      requestId: "attach-only-retained",
      terminalId: "term-first",
      chunks: [textChunk("first output\n", 0)],
      replayStartSeq: 0,
      nextSeq: 1,
    });
    expect(harness.messages).toContainEqual(
      terminalNotFoundError({
        requestId: "attach-evicted",
        terminalId: "term-first",
      }),
    );
    expect(harness.messages).toContainEqual({
      type: "terminal.replay",
      requestId: "attach-newest",
      terminalId: "term-second",
      chunks: [textChunk("second output\n", 0)],
      replayStartSeq: 0,
      nextSeq: 1,
    });
    expect(harness.manager["retainedReplayParserStateBytes"]).toBe(0);
    harness.manager.dispose();
    expect(harness.manager["retainedReplayParserStateBytes"]).toBe(0);
  });

  it("clears retained scrollback and its timers on dispose", async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    const pty = await openTerminal(harness);

    pty.emitData("build failed\n");
    pty.emitExit(1);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    harness.manager.dispose();
    await attachTerminal(harness, {
      requestId: "attach-disposed",
      terminalId: "term-1",
    });

    expect(vi.getTimerCount()).toBe(0);
    expect(harness.messages).toContainEqual(
      terminalNotFoundError({
        requestId: "attach-disposed",
        terminalId: "term-1",
      }),
    );
  });

  it("answers primary device attribute queries without replaying them", async () => {
    const harness = createHarness();
    const pty = await openTerminal(harness);

    pty.emitData("before\u001b[0cbetween\u001b[cafter");
    await harness.manager.handleMessage({
      type: "terminal.attach",
      requestId: "attach-da1",
      terminalId: "term-1",
      sinceSeq: 0,
      tailBytes: 4 * 1024 * 1024,
    });

    expect(pty.writeCalls).toEqual(["\u001b[?1;2c\u001b[?1;2c"]);
    expect(collectTerminalOutput(harness.messages)).toBe("beforebetweenafter");
    expect(harness.messages).toContainEqual({
      type: "terminal.replay",
      requestId: "attach-da1",
      terminalId: "term-1",
      chunks: [
        {
          seq: 0,
          dataBase64: Buffer.from("beforebetweenafter", "utf8").toString(
            "base64",
          ),
        },
      ],
      replayStartSeq: 0,
      nextSeq: 1,
    });
  });

  it("answers primary device attribute queries split across output chunks", async () => {
    const harness = createHarness();
    const pty = await openTerminal(harness);

    for (const chunk of ["\u001b", "[", "0", "c", "\u001b[", "c"]) {
      pty.emitData(chunk);
    }
    await harness.manager.handleMessage({
      type: "terminal.attach",
      requestId: "attach-split-da1",
      terminalId: "term-1",
      sinceSeq: 0,
      tailBytes: 4 * 1024 * 1024,
    });

    expect(pty.writeCalls).toEqual(["\u001b[?1;2c", "\u001b[?1;2c"]);
    expect(collectTerminalOutput(harness.messages)).toBe("");
    expect(harness.messages).toContainEqual({
      type: "terminal.replay",
      requestId: "attach-split-da1",
      terminalId: "term-1",
      chunks: [textChunk("", 0)],
      replayStartSeq: 0,
      nextSeq: 1,
    });
  });

  it("bounds device attribute replies for one flooded output chunk", async () => {
    const harness = createHarness();
    const pty = await openTerminal(harness);

    pty.emitData("\u001b[c".repeat(5_000));

    expect(pty.writeCalls).toEqual(["\u001b[?1;2c".repeat(8)]);
    expect(collectTerminalOutput(harness.messages)).toBe("");
  });

  it("preserves near matches and incomplete device attribute queries on exit", async () => {
    const harness = createHarness();
    const pty = await openTerminal(harness);

    pty.emitData("before\u001b[1cafter\u001b[0");
    pty.emitExit(0);

    expect(pty.writeCalls).toEqual([]);
    expect(collectTerminalOutput(harness.messages)).toBe(
      "before\u001b[1cafter\u001b[0",
    );
    expect(
      harness.messages
        .filter(
          (message) =>
            message.type === "terminal.output" ||
            message.type === "terminal.exited",
        )
        .map((message) => message.type),
    ).toEqual(["terminal.output", "terminal.exited"]);
  });

  it("bounds replay to the requested tail without splitting output chunks", async () => {
    const harness = createHarness();
    const pty = await openTerminal(harness);

    pty.emitData(`${"a".repeat(64 * 1024)}tail`);
    await harness.manager.handleMessage({
      type: "terminal.attach",
      requestId: "attach-tail",
      terminalId: "term-1",
      sinceSeq: 0,
      tailBytes: 4,
    });

    expect(harness.messages).toContainEqual({
      type: "terminal.replay",
      requestId: "attach-tail",
      terminalId: "term-1",
      chunks: [
        {
          seq: 1,
          dataBase64: Buffer.from(`${"a".repeat(22)}tail`, "utf8").toString(
            "base64",
          ),
        },
      ],
      replayStartSeq: 1,
      nextSeq: 2,
    });
  });

  it("starts replay after a CSI sequence that crosses the tail boundary", async () => {
    const harness = createHarness();
    const pty = await openTerminal(harness);

    pty.emitData(`${"x".repeat(64 * 1024 - 2)}\u001b[`);
    pty.emitData("31mOK");
    await harness.manager.handleMessage({
      type: "terminal.attach",
      requestId: "attach-csi-tail",
      terminalId: "term-1",
      sinceSeq: 0,
      tailBytes: 1,
    });

    const replay = harness.messages.find(
      (message) => message.type === "terminal.replay",
    );
    expect(replay).toMatchObject({
      chunks: [
        {
          seq: 2,
          dataBase64: Buffer.from("\u001b[31mOK", "utf8").toString("base64"),
        },
      ],
      replayStartSeq: 2,
    });
  });

  it("starts replay after a UTF-8 code point that crosses the tail boundary", async () => {
    const harness = createHarness();
    const pty = await openTerminal(harness);

    pty.emitData(`${"x".repeat(64 * 1024 - 2)}💙`);
    pty.emitData("tail");
    await harness.manager.handleMessage({
      type: "terminal.attach",
      requestId: "attach-utf8-tail",
      terminalId: "term-1",
      sinceSeq: 0,
      tailBytes: 6,
    });

    const replay = harness.messages.find(
      (message) => message.type === "terminal.replay",
    );
    expect(replay).toMatchObject({
      chunks: [
        {
          seq: 2,
          dataBase64: Buffer.from("tail", "utf8").toString("base64"),
        },
      ],
      replayStartSeq: 2,
    });
  });

  it.each([
    ["semicolons", ";", "h"],
    ["digits", "9", "h"],
    ["intermediates", " ", "h"],
    ["semicolons interrupted by ESC", ";", "\u001b[0m"],
    ["digits interrupted by ESC", "9", "\u001b[0m"],
    ["intermediates interrupted by ESC", " ", "\u001b[0m"],
  ])(
    "bounds unfinished CSI %s and recovers for later replay",
    async (_name, byte, recovery) => {
      const harness = createHarness();
      const pty = await openTerminal(harness);

      pty.emitData(`\u001b[?1049;${byte.repeat(1_000_000)}`);
      await harness.manager.handleMessage({
        type: "terminal.attach",
        requestId: "attach-unfinished-csi",
        terminalId: "term-1",
        sinceSeq: 0,
        tailBytes: 1,
      });

      const session = harness.manager["sessions"].get("term-1");
      expect(session).toBeDefined();
      expect(
        session?.scrollbackParserState.csiParameters.length,
      ).toBeLessThanOrEqual(1024);
      for (const entry of session?.scrollback ?? []) {
        expect(
          entry.parserStateBefore.csiParameters.length,
        ).toBeLessThanOrEqual(1024);
      }
      expect(harness.messages).toContainEqual(
        expect.objectContaining({
          type: "terminal.replay",
          requestId: "attach-unfinished-csi",
          chunks: [],
        }),
      );

      pty.emitData(recovery);
      await harness.manager.handleMessage({
        type: "terminal.attach",
        requestId: "attach-recovered-csi",
        terminalId: "term-1",
        sinceSeq: 0,
        tailBytes: 1,
      });
      expect(harness.messages).toContainEqual(
        expect.objectContaining({
          type: "terminal.replay",
          requestId: "attach-recovered-csi",
          chunks: [],
        }),
      );

      pty.emitData("PRIMARY");
      await harness.manager.handleMessage({
        type: "terminal.attach",
        requestId: "attach-primary-screen-tail",
        terminalId: "term-1",
        sinceSeq: 0,
        tailBytes: 7,
      });
      expect(harness.messages).toContainEqual(
        expect.objectContaining({
          type: "terminal.replay",
          requestId: "attach-primary-screen-tail",
          chunks: [
            expect.objectContaining({
              dataBase64: Buffer.from("PRIMARY", "utf8").toString("base64"),
            }),
          ],
        }),
      );

      pty.emitData("\u001b[?1049h");
      await harness.manager.handleMessage({
        type: "terminal.attach",
        requestId: "flush-normal-csi",
        terminalId: "term-1",
        sinceSeq: 0,
        tailBytes: 64 * 1024,
      });
      pty.emitData("OK");
      await harness.manager.handleMessage({
        type: "terminal.attach",
        requestId: "attach-normal-csi-tail",
        terminalId: "term-1",
        sinceSeq: 0,
        tailBytes: 2,
      });
      expect(harness.messages).toContainEqual(
        expect.objectContaining({
          type: "terminal.replay",
          requestId: "attach-normal-csi-tail",
          chunks: [
            expect.objectContaining({
              dataBase64: Buffer.from("\u001b[?1049hOK", "utf8").toString(
                "base64",
              ),
            }),
          ],
        }),
      );
      await harness.manager.handleMessage({
        type: "terminal.close",
        terminalId: "term-1",
        reason: "user",
      });
    },
  );

  it.each([256, 512])(
    "bounds retained CSI snapshots across 12000 separate %s-byte output chunks",
    async (chunkBytes) => {
      const harness = createHarness();
      const pty = await openTerminal(harness);
      vi.useFakeTimers({
        toFake: [
          "setTimeout",
          "clearTimeout",
          "setImmediate",
          "clearImmediate",
          "performance",
        ],
      });
      const session = harness.manager["sessions"].get("term-1");
      if (!session) {
        throw new Error("Terminal session did not open");
      }
      const capturedLengths = new Set<number>();
      let maxRetainedChunks = 0;
      let maxRetainedBytes = 0;
      for (let index = 0; index < 12_000; index += 1) {
        pty.emitData(
          `${index === 0 ? "\u001b[" : ""}${";".repeat(chunkBytes)}`,
        );
        vi.advanceTimersByTime(4);
        const entry = session.scrollback.at(-1);
        expect(entry?.chunk.seq).toBe(index);
        const length = entry?.parserStateBefore.csiParameters.length ?? -1;
        expect(length).toBeGreaterThanOrEqual(0);
        expect(length).toBeLessThanOrEqual(1024);
        capturedLengths.add(length);
        maxRetainedChunks = Math.max(
          maxRetainedChunks,
          session.scrollback.length,
        );
        maxRetainedBytes = Math.max(maxRetainedBytes, session.scrollbackBytes);
      }
      expect(capturedLengths.has(chunkBytes)).toBe(true);
      expect(capturedLengths.has(1024)).toBe(true);
      const retainedChunks = Math.min(10_000, (4 * 1024 * 1024) / chunkBytes);
      expect(maxRetainedChunks).toBe(retainedChunks);
      expect(maxRetainedBytes).toBeLessThanOrEqual(4 * 1024 * 1024);
      expect(session.scrollback).toHaveLength(retainedChunks);
      expect(session.scrollbackBytes).toBe(retainedChunks * chunkBytes);
      expect(session.scrollback[0]?.chunk.seq).toBe(12_000 - retainedChunks);
      expect(
        session.scrollback.every(
          (entry) => entry.parserStateBefore.escape === "csi-ignore",
        ),
      ).toBe(true);
      expect(
        session.scrollback.reduce(
          (total, entry) =>
            total + entry.parserStateBefore.csiParameters.length,
          0,
        ),
      ).toBe(0);
      await harness.manager.handleMessage({
        type: "terminal.attach",
        requestId: "attach-pruned-csi",
        terminalId: "term-1",
        sinceSeq: 0,
        tailBytes: 4 * 1024 * 1024,
      });
      expect(harness.messages).toContainEqual(
        expect.objectContaining({
          type: "terminal.replay",
          requestId: "attach-pruned-csi",
          chunks: [],
        }),
      );
      pty.emitData("mOK");
      vi.advanceTimersByTime(4);
      await harness.manager.handleMessage({
        type: "terminal.attach",
        requestId: "attach-pruned-csi-recovered",
        terminalId: "term-1",
        sinceSeq: 0,
        tailBytes: 4 * 1024 * 1024,
      });
      expect(harness.messages).toContainEqual(
        expect.objectContaining({
          type: "terminal.replay",
          requestId: "attach-pruned-csi-recovered",
          chunks: [
            expect.objectContaining({
              dataBase64: Buffer.from("OK").toString("base64"),
            }),
          ],
        }),
      );
      pty.emitExit(0);
      const exited = harness.manager["exitedSessions"].get("term-1");
      expect(exited?.scrollback).toHaveLength(retainedChunks);
      expect(exited?.scrollbackBytes).toBeLessThanOrEqual(4 * 1024 * 1024);
      harness.manager.dispose();
    },
  );

  it.each(["held", "growing"] as const)(
    "bounds aggregate snapshot storage with %s CSI parameters in tiny output chunks",
    async (mode) => {
      const harness = createHarness();
      const pty = await openTerminal(harness);
      vi.useFakeTimers({
        toFake: [
          "setTimeout",
          "clearTimeout",
          "setImmediate",
          "clearImmediate",
          "performance",
        ],
      });
      const session = harness.manager["sessions"].get("term-1");
      if (!session) {
        throw new Error("Terminal session did not open");
      }
      pty.emitData(`\u001b[${mode === "held" ? ";".repeat(1024) : ";"}`);
      vi.advanceTimersByTime(4);
      for (let index = 0; index < 12_000; index += 1) {
        const position = index % 1025;
        pty.emitData(
          mode === "held"
            ? "\u0000"
            : position === 0
              ? "m\u001b[;"
              : position === 1024
                ? "m"
                : String(Math.floor(index / 1025) % 10),
        );
        vi.advanceTimersByTime(4);
        expect(session.scrollback.at(-1)?.chunk.seq).toBe(index + 1);
      }
      expect(session.scrollback.length).toBeLessThanOrEqual(10_000);
      expect(
        session.scrollback.every(
          (entry) => entry.parserStateBefore.csiParameters.length <= 1024,
        ),
      ).toBe(true);
      const snapshotBytes = session.scrollback.reduce(
        (total, entry) => total + entry.parserStateBefore.csiParameters.length,
        0,
      );
      const chargedEntries = session.scrollback.filter(
        (entry) => entry.parserStateBefore.csiParameters.length > 0,
      ).length;
      expect(64 * chargedEntries + 2 * snapshotBytes).toBeLessThanOrEqual(
        4 * 1024 * 1024,
      );
      if (mode === "held") {
        expect(session.scrollback).toHaveLength(1985);
        expect(snapshotBytes).toBe(1985 * 1024);
        expect(session.scrollbackBytes).toBe(1985);
      } else {
        expect(
          new Set(
            session.scrollback.map(
              (entry) => entry.parserStateBefore.csiParameters,
            ),
          ).size,
        ).toBeGreaterThan(1024);
        expect(snapshotBytes).toBeGreaterThan(1024 * 1024);
        expect(session.scrollbackBytes).toBeLessThan(11_000);
      }
      await harness.manager.handleMessage({
        type: "terminal.attach",
        requestId: "attach-held-csi",
        terminalId: "term-1",
        sinceSeq: 0,
        tailBytes: 1,
      });
      expect(harness.messages).toContainEqual(
        expect.objectContaining({
          type: "terminal.replay",
          requestId: "attach-held-csi",
          chunks: [],
        }),
      );
      pty.emitData("mOK");
      vi.advanceTimersByTime(4);
      await harness.manager.handleMessage({
        type: "terminal.attach",
        requestId: "attach-held-csi-recovered",
        terminalId: "term-1",
        sinceSeq: 0,
        tailBytes: mode === "held" ? 100_000 : 1,
      });
      expect(harness.messages).toContainEqual(
        expect.objectContaining({
          type: "terminal.replay",
          requestId: "attach-held-csi-recovered",
          chunks: [
            expect.objectContaining({
              dataBase64: Buffer.from("OK").toString("base64"),
            }),
          ],
        }),
      );
      pty.emitExit(0);
      const exited = harness.manager["exitedSessions"].get("term-1");
      expect(exited?.scrollback).toHaveLength(session.scrollback.length);
      expect(exited?.scrollbackBytes).toBe(session.scrollbackBytes);
      harness.manager.dispose();
    },
  );

  it("bounds replay snapshots across many active and exited terminals and evicts exited history first", async () => {
    const harness = createHarness();
    const exitedPty = await openTerminalWithId(harness, "term-exited");
    vi.useFakeTimers({
      toFake: [
        "setTimeout",
        "clearTimeout",
        "setImmediate",
        "clearImmediate",
        "performance",
      ],
    });
    const budget = 4 * 1024 * 1024;
    const measuredCharge = () =>
      [
        ...harness.manager["sessions"].values(),
        ...harness.manager["exitedSessions"].values(),
      ].reduce(
        (total, session) =>
          total +
          session.scrollback.reduce(
            (sum, entry) =>
              sum +
              (entry.parserStateBefore.csiParameters.length === 0
                ? 0
                : 64 + 2 * entry.parserStateBefore.csiParameters.length),
            0,
          ),
        0,
      );
    const assertBudget = () => {
      const measured = measuredCharge();
      expect(measured).toBeLessThanOrEqual(budget);
      expect(harness.manager["retainedReplayParserStateBytes"]).toBe(measured);
    };
    exitedPty.emitData(`\u001b[${";".repeat(1024)}`);
    vi.advanceTimersByTime(4);
    for (let index = 0; index < 2000; index += 1) {
      exitedPty.emitData("\u0000");
      vi.advanceTimersByTime(4);
    }
    assertBudget();
    exitedPty.emitExit(0);
    await attachTerminal(harness, {
      requestId: "attach-before-budget-eviction",
      terminalId: "term-exited",
    });
    assertBudget();
    expect(harness.manager["exitedSessions"].has("term-exited")).toBe(true);
    const quietPty = await openTerminalWithId(harness, "term-quiet");
    quietPty.emitData("\u001b[?1049hQUIET");
    vi.advanceTimersByTime(4);
    const active = [];
    for (let terminal = 0; terminal < 10; terminal += 1) {
      const terminalId = `term-busy-${terminal}`;
      const pty = await openTerminalWithId(harness, terminalId);
      active.push({ pty, terminalId });
      pty.emitData(
        `${terminal === 0 ? "\u001b[?1049h" : ""}\u001b[${";".repeat(1024)}`,
      );
      vi.advanceTimersByTime(4);
      const session = harness.manager["sessions"].get(terminalId);
      if (!session) {
        throw new Error("Terminal session did not open");
      }
      for (let index = 0; index < 12_000; index += 1) {
        pty.emitData("\u0000");
        vi.advanceTimersByTime(4);
        const lastSeq = session.scrollback.at(-1)?.chunk.seq;
        if (lastSeq !== index + 1) {
          expect(lastSeq).toBe(index + 1);
        }
        const retained = harness.manager["retainedReplayParserStateBytes"];
        if (!(retained <= budget)) {
          expect(retained).toBeLessThanOrEqual(budget);
        }
        if (index % 256 === 0) {
          assertBudget();
        }
        if (terminal === 0 && index === 200) {
          expect(harness.manager["exitedSessions"].has("term-exited")).toBe(
            false,
          );
          await attachTerminal(harness, {
            requestId: "attach-quiet-before-active-eviction",
            terminalId: "term-quiet",
          });
          expect(harness.messages).toContainEqual(
            expect.objectContaining({
              type: "terminal.replay",
              requestId: "attach-quiet-before-active-eviction",
              chunks: [textChunk("\u001b[?1049hQUIET", 0)],
            }),
          );
        }
        harness.messages.length = 0;
      }
      assertBudget();
      expect(session.scrollback.length).toBeLessThanOrEqual(1985);
      expect(session.scrollbackParserState.csiParameters).toHaveLength(1024);
    }
    const quietSession = harness.manager["sessions"].get("term-quiet");
    expect(quietSession?.scrollback).toHaveLength(1);
    quietPty.emitData("QUIET-RECOVERED");
    vi.advanceTimersByTime(4);
    await attachTerminal(harness, {
      requestId: "attach-quiet-after-active-eviction",
      terminalId: "term-quiet",
    });
    expect(harness.messages).toContainEqual(
      expect.objectContaining({
        type: "terminal.replay",
        requestId: "attach-quiet-after-active-eviction",
        chunks: [
          textChunk("\u001b[?1049hQUIET", 0),
          textChunk("QUIET-RECOVERED", 1),
        ],
      }),
    );
    for (const { pty, terminalId } of active) {
      const marker = `RECOVERED-${terminalId}`;
      pty.emitData(`m${marker}`);
      vi.advanceTimersByTime(4);
      await attachTerminal(harness, { requestId: terminalId, terminalId });
      expect(harness.messages).toContainEqual(
        expect.objectContaining({
          type: "terminal.replay",
          requestId: terminalId,
          chunks: [
            textChunk(
              `${terminalId === "term-busy-0" ? "\u001b[?1049h" : ""}${marker}`,
              12_001,
            ),
          ],
        }),
      );
      assertBudget();
    }
    await harness.manager.shutdownAll();
    assertBudget();
    harness.manager.dispose();
    expect(harness.manager["retainedReplayParserStateBytes"]).toBe(0);
    expect(measuredCharge()).toBe(0);
  });

  it.each([{ maxExitedTerminals: 0 }, { exitedRetentionMs: 0 }])(
    "releases replay snapshot charges when exited retention is disabled: %j",
    async (options) => {
      const harness = createHarnessWithOptions({
        ...options,
        onSendMessage: () => undefined,
        resolveShell: async () => "/bin/zsh",
      });
      const pty = await openTerminal(harness);
      pty.emitData(`\u001b[${";".repeat(1024)}`);
      await attachTerminal(harness, {
        requestId: "attach-active",
        terminalId: "term-1",
      });
      pty.emitData("\u0000");
      await attachTerminal(harness, {
        requestId: "attach-charged",
        terminalId: "term-1",
      });
      expect(harness.manager["retainedReplayParserStateBytes"]).toBe(2112);
      await harness.manager.shutdownAll();
      expect(harness.manager["exitedSessions"].size).toBe(0);
      expect(harness.manager["retainedReplayParserStateBytes"]).toBe(0);
      harness.manager.dispose();
      expect(harness.manager["retainedReplayParserStateBytes"]).toBe(0);
    },
  );

  it("releases old exited snapshot charges when a terminal ID is reused and on dispose", async () => {
    const harness = createHarness();
    const first = await openTerminal(harness);
    first.emitData(`\u001b[${";".repeat(1024)}`);
    await attachTerminal(harness, {
      requestId: "attach-first",
      terminalId: "term-1",
    });
    first.emitData("\u0000");
    first.emitExit(0);
    await attachTerminal(harness, {
      requestId: "attach-exited",
      terminalId: "term-1",
    });
    expect(harness.manager["retainedReplayParserStateBytes"]).toBe(2112);
    const second = await openTerminalWithId(harness, "term-1");
    second.emitData("SECOND");
    second.emitExit(0);
    await attachTerminal(harness, {
      requestId: "attach-replaced",
      terminalId: "term-1",
    });
    expect(harness.manager["retainedReplayParserStateBytes"]).toBe(0);
    const live = await openTerminalWithId(harness, "term-live");
    live.emitData("\u001b[;");
    await attachTerminal(harness, {
      requestId: "attach-live",
      terminalId: "term-live",
    });
    live.emitData("\u0000");
    await attachTerminal(harness, {
      requestId: "attach-live-charged",
      terminalId: "term-live",
    });
    expect(harness.manager["retainedReplayParserStateBytes"]).toBe(66);
    harness.manager.dispose();
    expect(harness.manager["retainedReplayParserStateBytes"]).toBe(0);
    expect(
      harness.manager["sessions"].get("term-live")?.scrollback,
    ).toHaveLength(0);
    await harness.manager.shutdownAll();
    harness.manager.dispose();
    expect(harness.manager["retainedReplayParserStateBytes"]).toBe(0);
  });

  it("shares empty CSI snapshots so many benign terminals preserve their replay history", async () => {
    const harness = createHarness();
    vi.useFakeTimers({
      toFake: [
        "setTimeout",
        "clearTimeout",
        "setImmediate",
        "clearImmediate",
        "performance",
      ],
    });
    const snapshots = new Set();
    for (let terminal = 0; terminal < 8; terminal += 1) {
      const terminalId = `term-benign-${terminal}`;
      const pty = await openTerminalWithId(harness, terminalId);
      for (let index = 0; index < 10_000; index += 1) {
        pty.emitData("BENIGN\n");
        vi.advanceTimersByTime(4);
        harness.messages.length = 0;
      }
    }
    for (const session of harness.manager["sessions"].values()) {
      expect(session.scrollback).toHaveLength(10_000);
      expect(session.scrollbackBytes).toBe(70_022);
      for (const entry of session.scrollback) {
        expect(Object.isFrozen(entry.parserStateBefore)).toBe(true);
        snapshots.add(entry.parserStateBefore);
      }
      await attachTerminal(harness, {
        requestId: session.terminalId,
        terminalId: session.terminalId,
      });
      const replay = harness.messages.find(
        (message) =>
          message.type === "terminal.replay" &&
          message.requestId === session.terminalId,
      );
      if (!replay || replay.type !== "terminal.replay") {
        throw new Error("Terminal replay was not sent");
      }
      expect(replay.chunks).toHaveLength(10_000);
      expect(replay.chunks[0]).toEqual(textChunk("BENIGN\n", 0));
      expect(replay.chunks.at(-1)).toEqual(textChunk("BENIGN\n", 9999));
      harness.messages.length = 0;
    }
    expect(snapshots.size).toBe(1);
    expect(harness.manager["retainedReplayParserStateBytes"]).toBe(0);
    await harness.manager.shutdownAll();
    harness.manager.dispose();
  });

  it.each([
    { maxExitedTerminals: 1 },
    { maxExitedScrollbackBytes: 8 },
    { exitedRetentionMs: 100 },
  ])(
    "releases charged exited snapshots through retention limits: %j",
    async (options) => {
      const harness = createHarnessWithOptions({
        ...options,
        onSendMessage: () => undefined,
        resolveShell: async () => "/bin/zsh",
      });
      vi.useFakeTimers({
        toFake: [
          "setTimeout",
          "clearTimeout",
          "setImmediate",
          "clearImmediate",
          "performance",
        ],
      });
      const pty = await openTerminal(harness);
      pty.emitData("\u001b[;");
      vi.advanceTimersByTime(4);
      pty.emitData("\u0000");
      vi.advanceTimersByTime(4);
      pty.emitExit(0);
      await attachTerminal(harness, {
        requestId: "attach-charged-exited",
        terminalId: "term-1",
      });
      expect(harness.manager["retainedReplayParserStateBytes"]).toBe(66);
      if ("exitedRetentionMs" in options) {
        await vi.advanceTimersByTimeAsync(100);
      } else {
        const second = await openTerminalWithId(harness, "term-second");
        second.emitData("SECOND");
        second.emitExit(0);
        await attachTerminal(harness, {
          requestId: "attach-second",
          terminalId: "term-second",
        });
      }
      expect(harness.manager["exitedSessions"].has("term-1")).toBe(false);
      expect(harness.manager["retainedReplayParserStateBytes"]).toBe(0);
      harness.manager.dispose();
      expect(harness.manager["exitedSessions"].size).toBe(0);
    },
  );

  it.each([1024, 1025])(
    "respects the CSI parameter byte boundary at %s bytes",
    async (length) => {
      const harness = createHarness();
      const pty = await openTerminal(harness);

      pty.emitData(`\u001b[?1049;${";".repeat(length - 6)}`);
      await harness.manager.handleMessage({
        type: "terminal.attach",
        requestId: "attach-csi-limit",
        terminalId: "term-1",
        sinceSeq: 0,
        tailBytes: 1,
      });
      expect(
        harness.manager["sessions"].get("term-1")?.scrollbackParserState
          .csiParameters.length,
      ).toBe(length === 1024 ? 1024 : 0);

      pty.emitData("hPRIMARY");
      await harness.manager.handleMessage({
        type: "terminal.attach",
        requestId: "attach-csi-limit-recovered",
        terminalId: "term-1",
        sinceSeq: 0,
        tailBytes: 1,
      });
      expect(harness.messages).toContainEqual(
        expect.objectContaining({
          type: "terminal.replay",
          requestId: "attach-csi-limit-recovered",
          chunks: [
            expect.objectContaining({
              dataBase64: Buffer.from(
                length === 1024 ? "\u001b[?1049hPRIMARY" : "PRIMARY",
                "utf8",
              ).toString("base64"),
            }),
          ],
        }),
      );
      await harness.manager.handleMessage({
        type: "terminal.close",
        terminalId: "term-1",
        reason: "user",
      });
    },
  );

  it("restores alternate-screen mode when replay starts after its enter sequence", async () => {
    const harness = createHarness();
    const pty = await openTerminal(harness);

    pty.emitData(`\u001b[?1049h${"x".repeat(64 * 1024 - 8)}`);
    pty.emitData("tail");
    await harness.manager.handleMessage({
      type: "terminal.attach",
      requestId: "attach-alternate-screen-tail",
      terminalId: "term-1",
      sinceSeq: 0,
      tailBytes: 4,
    });

    const replay = harness.messages.find(
      (message) => message.type === "terminal.replay",
    );
    expect(replay).toMatchObject({
      chunks: [
        {
          seq: 2,
          dataBase64: Buffer.from("\u001b[?1049htail", "utf8").toString(
            "base64",
          ),
        },
      ],
      replayStartSeq: 2,
    });
  });

  it("replays output verbatim when it continues the caller's stream", async () => {
    const harness = createHarness();
    const pty = await openTerminal(harness);
    const flush = async (requestId: string, sinceSeq: number) => {
      await harness.manager.handleMessage({
        type: "terminal.attach",
        requestId,
        terminalId: "term-1",
        sinceSeq,
        tailBytes: 64 * 1024,
      });
    };

    pty.emitData("\u001b[?1049hfirst");
    await flush("flush-enter", 0);
    pty.emitData("\u001b[38;");
    await flush("flush-split-sequence", 1);
    pty.emitData("5;1mchip");
    await flush("read-since-2", 2);
    await flush("read-since-1", 1);

    expect(harness.messages).toContainEqual(
      expect.objectContaining({
        type: "terminal.replay",
        requestId: "read-since-2",
        chunks: [textChunk("5;1mchip", 2)],
        replayStartSeq: 2,
      }),
    );
    expect(harness.messages).toContainEqual(
      expect.objectContaining({
        type: "terminal.replay",
        requestId: "read-since-1",
        chunks: [textChunk("\u001b[38;", 1), textChunk("5;1mchip", 2)],
        replayStartSeq: 1,
      }),
    );
  });

  it("writes input and resizes the active PTY", async () => {
    const harness = createHarness();
    const pty = await openTerminal(harness);

    await harness.manager.handleMessage({
      type: "terminal.input",
      terminalId: "term-1",
      dataBase64: Buffer.from("pwd\n", "utf8").toString("base64"),
    });
    await harness.manager.handleMessage({
      type: "terminal.resize",
      terminalId: "term-1",
      cols: 120,
      rows: 40,
    });
    await harness.manager.handleMessage({
      type: "terminal.resize",
      terminalId: "term-1",
      cols: 120,
      rows: 40,
    });

    expect(pty.writeCalls).toHaveLength(1);
    expect(pty.writeCalls[0]).toEqual(Buffer.from("pwd\n"));
    expect(pty.resizeCalls).toEqual([{ cols: 120, rows: 40 }]);
  });

  it("kills a terminal and emits exactly one user exit", async () => {
    const harness = createHarness();
    const pty = await openTerminal(harness);

    await harness.manager.handleMessage({
      type: "terminal.close",
      terminalId: "term-1",
      reason: "user",
    });
    pty.emitExit(0);
    pty.emitExit(0);

    expect(pty.killCalls).toEqual([null]);
    expect(
      harness.messages.filter((message) => message.type === "terminal.exited"),
    ).toEqual([
      {
        type: "terminal.exited",
        terminalId: "term-1",
        exitCode: 0,
        closeReason: "user",
      },
    ]);
    await harness.runtimeManager.replaceBaseShellEnv({ BB_BASE_ENV: "2" });
    expect(harness.runtimeManager.get("env-1")).toBeUndefined();
    expect(harness.runtime.shutdown).toHaveBeenCalledTimes(1);
  });

  it("acknowledges closing a terminal that is already gone", async () => {
    const harness = createHarness();

    await harness.manager.handleMessage({
      type: "terminal.close",
      terminalId: "term-missing",
      reason: "user",
    });

    expect(harness.messages).toEqual([
      {
        type: "terminal.exited",
        terminalId: "term-missing",
        exitCode: null,
        closeReason: "user",
      },
    ]);
  });

  it("force kills and cleans up a terminal when node-pty never emits exit", async () => {
    vi.useFakeTimers();
    const harness = createHarnessWithOptions({
      closeGracePeriodMs: 10,
      onSendMessage: () => undefined,
      resolveShell: async () => "/bin/zsh",
    });
    const pty = await openTerminal(harness);

    await harness.manager.handleMessage({
      type: "terminal.close",
      terminalId: "term-1",
      reason: "user",
    });
    await vi.advanceTimersByTimeAsync(10);

    expect(pty.killCalls).toEqual([null, "SIGKILL"]);
    expect(pty.disposeCount).toBe(1);
    expect(
      harness.messages.filter((message) => message.type === "terminal.exited"),
    ).toEqual([
      {
        type: "terminal.exited",
        terminalId: "term-1",
        exitCode: null,
        closeReason: "user",
      },
    ]);
    await harness.runtimeManager.replaceBaseShellEnv({ BB_BASE_ENV: "2" });
    expect(harness.runtimeManager.get("env-1")).toBeUndefined();
  });

  it("kills all terminals on shutdown", async () => {
    const harness = createHarness();
    const pty = await openTerminal(harness);

    await harness.manager.shutdownAll();
    pty.emitExit(0);

    expect(pty.killCalls).toEqual([null]);
    expect(
      harness.messages.filter((message) => message.type === "terminal.exited"),
    ).toEqual([
      {
        type: "terminal.exited",
        terminalId: "term-1",
        exitCode: null,
        closeReason: "daemon-disconnect",
      },
    ]);
  });

  it("ignores stale output and exits from a replaced PTY", async () => {
    const harness = createHarness();
    const oldPty = await openTerminal(harness);

    await harness.manager.shutdownAll();
    await openTerminal(harness);
    const newPty = harness.adapter.spawned[1]?.pty;
    if (!newPty) {
      throw new Error("Expected replacement terminal PTY to spawn");
    }

    oldPty.emitStaleData("stale-output\n");
    oldPty.emitStaleExit(7);
    newPty.emitData("current-output\n");
    await harness.manager.handleMessage({
      type: "terminal.input",
      terminalId: "term-1",
      dataBase64: Buffer.from("pwd\n", "utf8").toString("base64"),
    });
    await harness.manager.handleMessage({
      type: "terminal.attach",
      requestId: "attach-replacement",
      terminalId: "term-1",
      sinceSeq: 0,
      tailBytes: 4 * 1024 * 1024,
    });

    expect(newPty.writeCalls).toEqual([Buffer.from("pwd\n")]);
    expect(collectTerminalOutput(harness.messages)).toContain(
      "current-output\n",
    );
    expect(collectTerminalOutput(harness.messages)).not.toContain(
      "stale-output\n",
    );
    expect(
      harness.messages.filter((message) => message.type === "terminal.exited"),
    ).toEqual([
      {
        type: "terminal.exited",
        terminalId: "term-1",
        exitCode: null,
        closeReason: "daemon-disconnect",
      },
    ]);
  });

  it("runs commands in one persistent shell from the workspace cwd", async () => {
    if (process.platform === "win32") {
      return;
    }

    const workspacePath = await makeTempDir("bb-terminal-manager-real-");
    const targetPath = await makeTempDir("bb-terminal-manager-target-");
    const expectedWorkspacePath = await fs.realpath(workspacePath);
    const expectedTargetPath = await fs.realpath(targetPath);
    const messages: HostDaemonDaemonWsMessage[] = [];
    const runtimeManager = new RuntimeManager({
      createRuntime: () => createFakeRuntime(),
      provisionWorkspace: async () => createFakeWorkspace(workspacePath),
    });
    const manager = new TerminalManager({
      logger: {
        debug: vi.fn(),
        error: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
      },
      resolveShell: async () => "/bin/sh",
      runtimeManager,
      sendMessage: (message) => {
        messages.push(message);
        return true;
      },
    });

    await manager.handleMessage({
      type: "terminal.open",
      contributedEnv: [],
      requestId: "open-real",
      terminalId: "term-real",
      threadId: "thr-real",
      target: {
        kind: "workspace",
        environmentId: "env-real",
        workspaceContext: {
          workspacePath,
        },
      },
      cols: 100,
      rows: 30,
      start: DEFAULT_TERMINAL_START,
    });
    await manager.handleMessage({
      type: "terminal.input",
      terminalId: "term-real",
      dataBase64: Buffer.from(
        [
          'printf "__PWD1:%s\\n" "$(pwd -P)"',
          `cd ${shellQuote(targetPath)}`,
          'printf "__PWD2:%s\\n" "$(pwd -P)"',
          "",
        ].join("\n"),
        "utf8",
      ).toString("base64"),
    });

    await waitForOutputContaining({
      messages,
      text: `__PWD1:${expectedWorkspacePath}`,
    });
    await waitForOutputContaining({
      messages,
      text: `__PWD2:${expectedTargetPath}`,
    });
    await manager.shutdownAll();
  }, 10_000);
});
