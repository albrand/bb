import { mkdir } from "node:fs/promises";
import path from "node:path";
import {
  BRIDGE_WORKER_REGISTRY_FORMAT_VERSION,
  createAgentRuntime,
  readBridgeWorkerEntries,
  reapDeadBridgeWorkers,
  retireBridgeWorker,
  writeBridgeWorkerEntry,
  type BridgeWorkerRegistryEntry,
  type AgentRuntime,
  type AgentRuntimeOptions,
  type AgentRuntimeSkillRoot,
  type AgentRuntimeProcessExitInfo,
  type BridgeLineDelivery,
  type ReapedIdleProviderSession,
} from "@bb/agent-runtime";
import type { Logger } from "@bb/logger";
import { killProcessesWithCwdUnder } from "@bb/process-utils";
import type {
  PendingInteractionCreate,
  PendingInteractionResolution,
  ThreadEvent,
  WorkspaceProvisionType,
} from "@bb/domain";
import { threadScope, turnScope } from "@bb/domain";
import type {
  HostDaemonActiveThread,
  HostDaemonEnvironmentChange,
  HostDaemonLoadedEnvironment,
  HostDaemonInjectedSkillSource,
} from "@bb/host-daemon-contract";
import type {
  DataDirSkillsWatchError,
  HostWatcher,
  InjectedSkillsObservedChange,
} from "@bb/host-watcher";
import {
  provisionWorkspace,
  WorkspaceError,
  type DestroyWorkspaceArgs,
  type HostWorkspace,
  type ProvisionWorkspaceArgs,
} from "@bb/host-workspace";
import {
  cleanupInjectedSkillStagingDirs,
  EMPTY_SKILL_CATALOG_HASH,
  stageInjectedSkillSources,
  type InjectedSkillsLogger,
} from "./injected-skills.js";
import {
  reconnectProvisionArgs,
  reconnectWorkspaceForProvision,
} from "./workspace-provision-target.js";
import {
  bridgeCapabilitiesSchema,
  PROVIDER_BRIDGE_PROTOCOL_VERSION,
  type BridgeCapabilities,
} from "@bb/provider-bridge-protocol";
import { ASSEMBLER_GRAMMAR_VERSIONS } from "@bb/provider-bridge-protocol/assembler";
import { BRIDGE_SOCKET_TRANSPORT_VERSION } from "@bb/provider-bridge-protocol/bridge-kit";
import {
  createProviderInstallationGate,
  PROVIDER_INSTALLATION_GATE_TTL_MS,
  type ProviderInstallationGate,
} from "./provider-installation-gate.js";
import type { FetchSkillTree } from "./skill-trees.js";
import { userExecutableProcessOptions } from "./user-executable-env.js";
import { waitWhileProviderSignInRenews } from "./provider-sign-in-renewal.js";
import { z } from "zod";

type StopWatching = () => void | Promise<void>;

const STOP_WATCHING: StopWatching = () => undefined;
const PROVIDER_MAINTENANCE_WORKSPACE_DIR = "provider-maintenance-workspace";
const PROVIDER_MAINTENANCE_IDLE_TIMEOUT_MS = 60_000;
const PROVIDER_PROCESS_EXIT_DETAIL_MAX_LENGTH = 4000;

interface RuntimeSkillConfig {
  catalogHash: string;
  skillRoots: readonly AgentRuntimeSkillRoot[];
}

interface CreateEntryArgs extends Omit<
  EnsureEnvironmentArgs,
  "injectedSkillSources" | "targetThreadId"
> {
  provisionSignal: AbortSignal;
  skillConfig: RuntimeSkillConfig | null;
}

interface ApplyExistingEnvironmentProvisionArgs {
  entry: RuntimeEntry;
  provision: ProvisionWorkspaceArgs | undefined;
  signal: AbortSignal;
}

interface EnsureCompatibleEntryArgs {
  entry: RuntimeEntry;
  skillConfig: RuntimeSkillConfig | null;
  targetThreadId?: string;
}

interface ReplaceEntryForSkillCatalogArgs {
  entry: RuntimeEntry;
  skillConfig: RuntimeSkillConfig;
  targetThreadId?: string;
}

interface SkillCatalogConflictErrorArgs {
  environmentId: string;
  activeCatalogHash: string | null;
  requestedCatalogHash: string;
}

export class SkillCatalogConflictError extends Error {
  constructor(args: SkillCatalogConflictErrorArgs) {
    super(
      `Daemon bug: a command targeting no thread carried injected skill sources into busy environment ${args.environmentId} (active catalog ${args.activeCatalogHash ?? "none"}, requested ${args.requestedCatalogHash})`,
    );
    this.name = "SkillCatalogConflictError";
  }
}

function formatProviderProcessExitStatus(
  info: AgentRuntimeProcessExitInfo,
): string {
  if (info.signal) {
    return `signal ${info.signal}`;
  }
  if (info.code !== null) {
    return `code ${info.code}`;
  }
  return "unknown status";
}

function buildProviderProcessExitMessage(
  info: AgentRuntimeProcessExitInfo,
): string {
  return `Provider "${info.providerId}" exited unexpectedly with ${formatProviderProcessExitStatus(info)}`;
}

function buildProviderProcessExitDetail(
  info: AgentRuntimeProcessExitInfo,
): string | undefined {
  if (!info.stderr) {
    return undefined;
  }
  return `stderr:\n${info.stderr.slice(-PROVIDER_PROCESS_EXIT_DETAIL_MAX_LENGTH)}`;
}

export interface RuntimeEntry {
  adoptionProtectedUntil: number | null;
  environmentId: string;
  runtime: AgentRuntime;
  skillCatalogHash: string | null;
  lastWarnedStaleSkillCatalogHash: string | null;
  stopWatchingStatus: StopWatching;
  workspace: HostWorkspace;
  path: string;
  terminals: Set<string>;
}

interface InjectedSkillsChangedNotification {
  changedPaths: string[];
  sourceType: InjectedSkillsObservedChange["sourceType"];
}

export interface EnsureEnvironmentArgs {
  environmentId: string;
  injectedSkillSources?: readonly HostDaemonInjectedSkillSource[];
  personalWorkspaceRoot?: string;
  targetThreadId?: string;
  workspacePath?: string;
  workspaceProvisionType?: WorkspaceProvisionType;
  provision?: ProvisionWorkspaceArgs;
}

interface CancelEnvironmentProvisionArgs {
  environmentId: string;
}

interface CancelEnvironmentProvisionResult {
  aborted: boolean;
}

interface RefreshEnvironmentWorkspaceArgs {
  environmentId: string;
  provision: ProvisionWorkspaceArgs;
  workspacePath: string;
}

export interface RuntimeManagerOptions {
  bridgeBundleDir?: AgentRuntimeOptions["bridgeBundleDir"];
  createRuntime?: (options: AgentRuntimeOptions) => AgentRuntime;
  dataDir?: string;
  dataDirSkillsRootPath?: string | null;
  fetchSkillTree?: FetchSkillTree;
  hostWatcher?: HostWatcher;
  logger?: Pick<Logger, "debug" | "info" | "warn">;
  provisionWorkspace?: (
    options: ProvisionWorkspaceArgs,
  ) => Promise<HostWorkspace>;
  providerInstallationGateTtlMs?: number;
  providerMaintenanceIdleTimeoutMs?: number;
  shellEnv?: AgentRuntimeOptions["shellEnv"];
  onEvent?: (args: {
    environmentId: string;
    event: ThreadEvent;
    delivery?: BridgeLineDelivery;
  }) => void;
  threadStorageRootPath?: string | null;
  onInjectedSkillsChanged?: (args: InjectedSkillsChangedNotification) => void;
  onDataDirSkillsWatchError?: (args: {
    error: DataDirSkillsWatchError;
  }) => void;
  onWorkspaceStatusChanged?: (args: {
    changeKinds: HostDaemonEnvironmentChange[];
    environmentId: string;
  }) => void;
  onInteractiveRequest?: (
    request: PendingInteractionCreate,
  ) => Promise<PendingInteractionResolution>;
  onToolCall?: AgentRuntimeOptions["onToolCall"];
  onStderr?: AgentRuntimeOptions["onStderr"];
  onProcessExit?: AgentRuntimeOptions["onProcessExit"];
}

export interface RuntimeManagerReapIdleProviderSessionsArgs {
  idleForMs: number;
  nowMs: number;
}

interface RuntimeManagerReapedIdleProviderSession extends ReapedIdleProviderSession {
  environmentId: string;
}

export interface RuntimeManagerReapIdleProviderSessionsResult {
  reapedSessions: RuntimeManagerReapedIdleProviderSession[];
}

type ReleaseThreadActiveTurnPolicy = "interrupt" | "keep";

interface ReleaseThreadFromOtherEnvironmentsResult {
  activeTurnEnvironmentIds: string[];
  providerCheckpointId: string | null;
  releasedEnvironmentIds: string[];
}

interface RuntimeWorkspaceWriteRootsArgs {
  threadStorageRootPath: string | null | undefined;
  workspaceRoots: readonly string[];
}

interface PendingEnvironmentProvision {
  abortController: AbortController;
  done: Promise<unknown>;
}

interface PendingProviderMaintenanceRuntime {
  generation: number;
  promise: Promise<AgentRuntime>;
}

interface RunCancellableEnvironmentProvisionArgs {
  environmentId: string;
  work: (signal: AbortSignal) => Promise<void>;
}

function shellEnvEquals(
  left: NonNullable<AgentRuntimeOptions["shellEnv"]>,
  right: NonNullable<AgentRuntimeOptions["shellEnv"]>,
): boolean {
  const leftEntries = Object.entries(left);
  const rightEntries = Object.entries(right);
  if (leftEntries.length !== rightEntries.length) {
    return false;
  }
  return leftEntries.every(([key, value]) => right[key] === value);
}

function providerProcessEnvFromShellEnv(
  shellEnv: NonNullable<AgentRuntimeOptions["shellEnv"]>,
): Record<string, string> | null {
  const env: Record<string, string> = {};
  if (shellEnv.PATH) {
    env.PATH = shellEnv.PATH;
  }
  const recordDir = process.env.BB_PROVIDER_BRIDGE_RECORD_DIR;
  if (recordDir) {
    env.BB_PROVIDER_BRIDGE_RECORD_DIR = recordDir;
  }
  return Object.keys(env).length > 0 ? env : null;
}

export class RuntimeManager {
  private readonly createRuntime;
  private readonly hostWatcher;
  private readonly provisionWorkspace;
  private baseShellEnv;
  private readonly entries = new Map<string, RuntimeEntry>();
  private readonly pendingEntries = new Map<string, Promise<RuntimeEntry>>();
  private readonly pendingCatalogHashes = new Map<string, string>();
  private readonly pendingEnvironmentProvisions = new Map<
    string,
    PendingEnvironmentProvision
  >();
  private readonly pendingWorkspaceRefreshes = new Map<
    string,
    Promise<HostWorkspace>
  >();
  private readonly inFlightThreadCommandsByEnvironmentId = new Map<
    string,
    Map<string, number>
  >();
  private readonly inFlightThreadCommandCompletionsByEnvironmentId = new Map<
    string,
    Map<string, Set<Promise<void>>>
  >();
  private readonly threadControlTails = new Map<string, Promise<void>>();
  private providerMaintenanceRuntime: AgentRuntime | null = null;
  private runtimesClosed = false;
  private readonly adoptingThreadIds = new Set<string>();
  private readonly adoptedBridgeThreads: {
    threadId: string;
    activeTurnId: string | null;
    runtime: AgentRuntime;
  }[] = [];
  private adoptionSettled = settledAdoptionGate();
  private pendingProviderMaintenanceRuntime: PendingProviderMaintenanceRuntime | null =
    null;
  private providerMaintenanceRuntimeGeneration = 0;
  private providerMaintenanceActiveRequests = 0;
  private providerMaintenanceIdleTimer: ReturnType<typeof setTimeout> | null =
    null;
  readonly providerInstallationGate: ProviderInstallationGate;
  private stopWatchingDataDirSkillsRoot: StopWatching = STOP_WATCHING;

  constructor(private readonly options: RuntimeManagerOptions = {}) {
    this.createRuntime = options.createRuntime ?? createAgentRuntime;
    this.hostWatcher = options.hostWatcher;
    this.provisionWorkspace = options.provisionWorkspace ?? provisionWorkspace;
    this.baseShellEnv = { ...(options.shellEnv ?? {}) };
    this.providerInstallationGate = createProviderInstallationGate({
      ttlMs:
        options.providerInstallationGateTtlMs ??
        PROVIDER_INSTALLATION_GATE_TTL_MS,
    });
    this.ensureDataDirSkillsWatcher();
  }

  private runtimeWorkspaceWriteRoots(
    args: RuntimeWorkspaceWriteRootsArgs,
  ): string[] {
    const roots = [...args.workspaceRoots];
    if (args.threadStorageRootPath) {
      roots.push(args.threadStorageRootPath);
    }
    return [...new Set(roots)];
  }

  get(environmentId: string): RuntimeEntry | undefined {
    return this.entries.get(environmentId);
  }

  async getOrAwait(environmentId: string): Promise<RuntimeEntry | undefined> {
    const existing = this.entries.get(environmentId);
    if (existing) {
      return existing;
    }

    const pending = this.pendingEntries.get(environmentId);
    if (pending) {
      return pending;
    }

    return undefined;
  }

  private enqueueThreadControl<T>(
    threadId: string,
    work: () => T | PromiseLike<T>,
  ): Promise<T> {
    const previous = this.threadControlTails.get(threadId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(work);
    const settled = next.then(
      () => undefined,
      () => undefined,
    );
    this.threadControlTails.set(threadId, settled);
    void settled.then(() => {
      if (this.threadControlTails.get(threadId) === settled) {
        this.threadControlTails.delete(threadId);
      }
    });
    return next;
  }

  async releaseThreadFromOtherEnvironments(args: {
    activeTurn: ReleaseThreadActiveTurnPolicy;
    environmentId: string;
    threadId: string;
  }): Promise<ReleaseThreadFromOtherEnvironmentsResult> {
    await this.waitForThreadCommandsInOtherEnvironments(args);
    return this.enqueueThreadControl(args.threadId, () =>
      this.releaseThreadFromOtherEnvironmentsOnce(args),
    );
  }

  private async waitForThreadCommandsInOtherEnvironments(args: {
    environmentId: string;
    threadId: string;
  }): Promise<void> {
    for (;;) {
      const inFlightOldCommands = [
        ...this.inFlightThreadCommandCompletionsByEnvironmentId.entries(),
      ].flatMap(([environmentId, commandsByThreadId]) =>
        environmentId === args.environmentId
          ? []
          : [...(commandsByThreadId.get(args.threadId) ?? [])],
      );
      if (inFlightOldCommands.length === 0) {
        return;
      }
      await Promise.all(inFlightOldCommands);
    }
  }

  private async releaseThreadFromOtherEnvironmentsOnce(args: {
    activeTurn: ReleaseThreadActiveTurnPolicy;
    environmentId: string;
    threadId: string;
  }): Promise<ReleaseThreadFromOtherEnvironmentsResult> {
    const staleEntries = [...this.entries.values()].filter(
      (entry) =>
        entry.environmentId !== args.environmentId &&
        entry.runtime.hasThread(args.threadId),
    );
    const keptEntries =
      args.activeTurn === "interrupt"
        ? []
        : staleEntries.filter(
            (entry) => entry.runtime.getActiveTurnId(args.threadId) !== null,
          );
    const releasedEntries = staleEntries.filter(
      (entry) => !keptEntries.includes(entry),
    );

    const stopResults = await Promise.all(
      releasedEntries.map((entry) =>
        entry.runtime.stopThread({ threadId: args.threadId }),
      ),
    );
    const providerCheckpointIds = new Set(
      stopResults.flatMap((result) =>
        result.providerCheckpointId === null
          ? []
          : [result.providerCheckpointId],
      ),
    );
    return {
      activeTurnEnvironmentIds: keptEntries.map((entry) => entry.environmentId),
      providerCheckpointId:
        providerCheckpointIds.size === 1
          ? (providerCheckpointIds.values().next().value ?? null)
          : null,
      releasedEnvironmentIds: releasedEntries.map(
        (entry) => entry.environmentId,
      ),
    };
  }

  listThreadOwnerEntries(threadId: string): RuntimeEntry[] {
    return [...this.entries.values()].filter((entry) =>
      entry.runtime.hasThread(threadId),
    );
  }

  markTerminalActive(environmentId: string, terminalId: string): void {
    this.entries.get(environmentId)?.terminals.add(terminalId);
  }

  markTerminalInactive(environmentId: string, terminalId: string): void {
    this.entries.get(environmentId)?.terminals.delete(terminalId);
  }

  async retainEnvironmentForThreadCommand(
    environmentId: string,
    threadId: string,
  ): Promise<() => void> {
    return this.enqueueThreadControl(threadId, () => {
      const commandsByThreadId =
        this.inFlightThreadCommandsByEnvironmentId.get(environmentId) ??
        new Map<string, number>();
      commandsByThreadId.set(
        threadId,
        (commandsByThreadId.get(threadId) ?? 0) + 1,
      );
      this.inFlightThreadCommandsByEnvironmentId.set(
        environmentId,
        commandsByThreadId,
      );

      let resolveCompletion!: () => void;
      const completion = new Promise<void>((resolve) => {
        resolveCompletion = resolve;
      });
      const completionsByThreadId =
        this.inFlightThreadCommandCompletionsByEnvironmentId.get(
          environmentId,
        ) ?? new Map<string, Set<Promise<void>>>();
      const completions =
        completionsByThreadId.get(threadId) ?? new Set<Promise<void>>();
      completions.add(completion);
      completionsByThreadId.set(threadId, completions);
      this.inFlightThreadCommandCompletionsByEnvironmentId.set(
        environmentId,
        completionsByThreadId,
      );

      let released = false;
      return () => {
        if (released) {
          return;
        }
        released = true;

        const activeCommands =
          this.inFlightThreadCommandsByEnvironmentId.get(environmentId);
        if (activeCommands) {
          const count = activeCommands.get(threadId) ?? 0;
          if (count <= 1) {
            activeCommands.delete(threadId);
          } else {
            activeCommands.set(threadId, count - 1);
          }
          if (activeCommands.size === 0) {
            this.inFlightThreadCommandsByEnvironmentId.delete(environmentId);
          }
        }

        const activeCompletions =
          this.inFlightThreadCommandCompletionsByEnvironmentId.get(
            environmentId,
          );
        const threadCompletions = activeCompletions?.get(threadId);
        threadCompletions?.delete(completion);
        if (threadCompletions?.size === 0) {
          activeCompletions?.delete(threadId);
        }
        if (activeCompletions?.size === 0) {
          this.inFlightThreadCommandCompletionsByEnvironmentId.delete(
            environmentId,
          );
        }
        resolveCompletion();
      };
    });
  }

  listActiveThreads(): HostDaemonActiveThread[] {
    const activeThreads: HostDaemonActiveThread[] = [];
    for (const entry of this.entries.values()) {
      for (const threadId of entry.runtime.getLiveThreadIds()) {
        activeThreads.push({
          threadId,
        });
      }
    }
    return activeThreads;
  }

  hasOpenBackgroundWork(): boolean {
    for (const entry of this.entries.values()) {
      if (entry.runtime.hasOpenBackgroundWork()) return true;
    }
    return false;
  }

  listLoadedEnvironments(): HostDaemonLoadedEnvironment[] {
    return [...this.entries.keys()].map((environmentId) => ({
      environmentId,
    }));
  }

  async reapIdleProviderSessions(
    args: RuntimeManagerReapIdleProviderSessionsArgs,
  ): Promise<RuntimeManagerReapIdleProviderSessionsResult> {
    await this.deferWhileProviderSignInRenews("idle-provider-session-reaped");
    const reapedSessions: RuntimeManagerReapedIdleProviderSession[] = [];
    for (const entry of this.entries.values()) {
      const result = await entry.runtime.reapIdleProviderSessions({
        ...args,
        runThreadExclusive: (threadId, work) =>
          this.enqueueThreadControl(threadId, () => {
            if (this.entryHasInFlightThreadCommand(entry, threadId)) {
              return null;
            }
            return work();
          }),
      });
      for (const session of result.reapedSessions) {
        reapedSessions.push({
          ...session,
          environmentId: entry.environmentId,
        });
      }
    }
    return { reapedSessions };
  }

  getShellEnv(): NonNullable<AgentRuntimeOptions["shellEnv"]> {
    return { ...this.baseShellEnv };
  }

  async replaceBaseShellEnv(
    shellEnv: NonNullable<AgentRuntimeOptions["shellEnv"]>,
  ): Promise<void> {
    if (shellEnvEquals(this.baseShellEnv, shellEnv)) {
      return;
    }

    this.baseShellEnv = { ...shellEnv };
    this.providerInstallationGate.clear();
    await this.shutdownProviderMaintenanceRuntime();
    await this.evictIdleRuntimeEntries();
  }

  private getInjectedSkillsLogger(): InjectedSkillsLogger | undefined {
    return this.options.logger;
  }

  private async resolveRuntimeSkillConfig(
    args: EnsureEnvironmentArgs,
  ): Promise<RuntimeSkillConfig | null> {
    if (args.injectedSkillSources === undefined) {
      return null;
    }
    if (args.injectedSkillSources.length === 0) {
      return {
        catalogHash: EMPTY_SKILL_CATALOG_HASH,
        skillRoots: [],
      };
    }
    if (!this.options.dataDir) {
      throw new Error("Runtime skill staging requires a host dataDir");
    }
    return stageInjectedSkillSources({
      dataDir: this.options.dataDir,
      injectedSkillSources: args.injectedSkillSources,
      ...(this.options.fetchSkillTree !== undefined
        ? { fetchSkillTree: this.options.fetchSkillTree }
        : {}),
      logger: this.getInjectedSkillsLogger(),
    });
  }

  private entryHasActiveRuntimeWork(entry: RuntimeEntry): boolean {
    return (
      this.isAdoptionProtected(entry) ||
      entry.terminals.size > 0 ||
      entry.runtime.getLiveThreadIds().length > 0 ||
      entry.runtime.hasOpenBackgroundWork()
    );
  }

  private isAdoptionProtected(entry: RuntimeEntry): boolean {
    if (entry.adoptionProtectedUntil === null) return false;
    if (Date.now() < entry.adoptionProtectedUntil) return true;
    entry.adoptionProtectedUntil = null;
    this.options.logger?.info(
      { environmentId: entry.environmentId },
      "Adopted environment runtime is evictable again; its adoption hold has expired",
    );
    return false;
  }

  private hasInFlightThreadCommand(
    entry: RuntimeEntry,
    excludingThreadId?: string,
  ): boolean {
    const commandsByThreadId = this.inFlightThreadCommandsByEnvironmentId.get(
      entry.environmentId,
    );
    if (!commandsByThreadId) {
      return false;
    }
    return [...commandsByThreadId.keys()].some(
      (threadId) => threadId !== excludingThreadId,
    );
  }

  private entryHasInFlightThreadCommand(
    entry: RuntimeEntry,
    threadId: string,
  ): boolean {
    return (
      this.inFlightThreadCommandsByEnvironmentId
        .get(entry.environmentId)
        ?.has(threadId) ?? false
    );
  }

  private entryHasActiveEnvironmentWork(entry: RuntimeEntry): boolean {
    return (
      this.entryHasActiveRuntimeWork(entry) ||
      this.hasInFlightThreadCommand(entry)
    );
  }

  private async cleanupUnusedInjectedSkillStagingDirs(
    pendingCatalogHashes: readonly string[],
  ): Promise<void> {
    if (!this.options.dataDir) {
      return;
    }
    try {
      await cleanupInjectedSkillStagingDirs({
        dataDir: this.options.dataDir,
        keepCatalogHashes: [
          ...pendingCatalogHashes,
          ...this.pendingCatalogHashes.values(),
          ...[...this.entries.values()].flatMap((entry) =>
            entry.skillCatalogHash === null ? [] : [entry.skillCatalogHash],
          ),
        ],
        logger: this.getInjectedSkillsLogger(),
      });
    } catch (error) {
      this.options.logger?.warn(
        {
          reason:
            error instanceof Error && error.message.trim().length > 0
              ? error.message
              : "Unable to clean injected skill staging directories",
        },
        "Failed to clean injected skill staging directories",
      );
    }
  }

  private async replaceEntryForSkillCatalog(
    args: ReplaceEntryForSkillCatalogArgs,
  ): Promise<void> {
    await this.deferWhileProviderSignInRenews("skill-catalog-replaced");
    if (
      this.entryHasActiveRuntimeWork(args.entry) ||
      this.hasInFlightThreadCommand(args.entry, args.targetThreadId)
    ) {
      throw new SkillCatalogConflictError({
        environmentId: args.entry.environmentId,
        activeCatalogHash: args.entry.skillCatalogHash,
        requestedCatalogHash: args.skillConfig.catalogHash,
      });
    }

    this.entries.delete(args.entry.environmentId);
    await this.stopWatchingStatus(args.entry);
    await this.stopRuntimeEntry(args.entry, "skill-catalog-replaced");
    await this.cleanupUnusedInjectedSkillStagingDirs([
      args.skillConfig.catalogHash,
    ]);
  }

  private async ensureCompatibleEntry(
    args: EnsureCompatibleEntryArgs,
  ): Promise<RuntimeEntry | null> {
    if (
      args.skillConfig === null ||
      args.entry.skillCatalogHash === args.skillConfig.catalogHash ||
      (args.entry.skillCatalogHash === null &&
        args.skillConfig.skillRoots.length === 0)
    ) {
      return args.entry;
    }

    if (
      args.targetThreadId !== undefined &&
      (this.entryHasActiveRuntimeWork(args.entry) ||
        this.hasInFlightThreadCommand(args.entry, args.targetThreadId))
    ) {
      if (
        args.entry.lastWarnedStaleSkillCatalogHash !==
        args.skillConfig.catalogHash
      ) {
        args.entry.lastWarnedStaleSkillCatalogHash =
          args.skillConfig.catalogHash;
        this.options.logger?.warn(
          {
            environmentId: args.entry.environmentId,
            threadId: args.targetThreadId,
            activeCatalogHash: args.entry.skillCatalogHash,
            requestedCatalogHash: args.skillConfig.catalogHash,
          },
          "Deferring injected skill catalog refresh for busy runtime",
        );
      }
      return args.entry;
    }

    await this.replaceEntryForSkillCatalog({
      entry: args.entry,
      skillConfig: args.skillConfig,
      ...(args.targetThreadId !== undefined
        ? { targetThreadId: args.targetThreadId }
        : {}),
    });
    return null;
  }

  async invalidateProviderMaintenanceRuntime(): Promise<void> {
    this.providerInstallationGate.clear();
    try {
      await this.shutdownProviderMaintenanceRuntime();
    } catch (error) {
      this.options.logger?.warn(
        { err: error },
        "Failed to shut down provider maintenance runtime during invalidation",
      );
    }
  }

  private async shutdownProviderMaintenanceRuntime(): Promise<void> {
    this.clearProviderMaintenanceIdleTimer();
    const existingRuntime = this.providerMaintenanceRuntime;
    const pendingRuntime = this.pendingProviderMaintenanceRuntime;
    this.providerMaintenanceRuntimeGeneration += 1;
    this.providerMaintenanceRuntime = null;
    if (this.pendingProviderMaintenanceRuntime === pendingRuntime) {
      this.pendingProviderMaintenanceRuntime = null;
    }

    const resolvedPendingRuntime = pendingRuntime
      ? await pendingRuntime.promise.catch(() => null)
      : null;
    if (
      resolvedPendingRuntime &&
      this.providerMaintenanceRuntime === resolvedPendingRuntime
    ) {
      this.providerMaintenanceRuntime = null;
    }

    const runtimes = [...new Set([existingRuntime, resolvedPendingRuntime])];
    await Promise.all(
      runtimes.map((runtime) => runtime?.shutdown() ?? Promise.resolve()),
    );
  }

  private clearProviderMaintenanceIdleTimer(): void {
    if (this.providerMaintenanceIdleTimer === null) return;
    clearTimeout(this.providerMaintenanceIdleTimer);
    this.providerMaintenanceIdleTimer = null;
  }

  private scheduleProviderMaintenanceIdleShutdown(): void {
    this.clearProviderMaintenanceIdleTimer();
    if (
      this.providerMaintenanceActiveRequests > 0 ||
      (this.providerMaintenanceRuntime === null &&
        this.pendingProviderMaintenanceRuntime === null)
    ) {
      return;
    }

    const timeoutMs =
      this.options.providerMaintenanceIdleTimeoutMs ??
      PROVIDER_MAINTENANCE_IDLE_TIMEOUT_MS;
    this.providerMaintenanceIdleTimer = setTimeout(() => {
      this.providerMaintenanceIdleTimer = null;
      if (this.providerMaintenanceActiveRequests > 0) return;
      void this.deferWhileProviderSignInRenews("provider-maintenance-idle")
        .then(() => {
          if (
            this.providerMaintenanceActiveRequests > 0 ||
            this.providerMaintenanceIdleTimer !== null
          ) {
            return;
          }
          return this.shutdownProviderMaintenanceRuntime();
        })
        .catch((error) => {
          this.options.logger?.warn(
            { err: error },
            "Failed to shut down idle provider maintenance runtime",
          );
        });
    }, timeoutMs);
    this.providerMaintenanceIdleTimer.unref();
  }

  private async deferWhileProviderSignInRenews(reason: string): Promise<void> {
    const outcome = await waitWhileProviderSignInRenews(this.baseShellEnv);
    if (outcome !== "clear") {
      this.options.logger?.info(
        { reason, outcome },
        "Deferred stopping provider work while a provider sign-in renewal was in progress",
      );
    }
  }

  private async stopRuntimeEntry(
    entry: RuntimeEntry,
    reason: string,
  ): Promise<void> {
    const bridgeWorkers =
      this.options.dataDir === undefined
        ? []
        : readBridgeWorkerEntries(
            bridgeWorkerDirForDataDir(this.options.dataDir),
          )
            .entries.filter(
              (worker) => worker.environmentId === entry.environmentId,
            )
            .map((worker) => ({ id: worker.id, pid: worker.pid }));
    this.options.logger?.info(
      { environmentId: entry.environmentId, reason, bridgeWorkers },
      "Stopping environment runtime and its provider bridge workers",
    );
    await entry.runtime.shutdown();
  }

  private async evictIdleRuntimeEntries(): Promise<void> {
    await this.deferWhileProviderSignInRenews(
      "idle-after-shell-environment-change",
    );
    const idleEntries = [...this.entries.values()].filter(
      (entry) => !this.entryHasActiveEnvironmentWork(entry),
    );

    for (const entry of idleEntries) {
      await this.stopWatchingStatus(entry);
      this.entries.delete(entry.environmentId);
    }

    await Promise.all(
      idleEntries.map((entry) =>
        this.stopRuntimeEntry(entry, "idle-after-shell-environment-change"),
      ),
    );
    await this.cleanupUnusedInjectedSkillStagingDirs([]);
  }

  async ensureProviderMaintenanceRuntime(args: {
    dataDir: string;
  }): Promise<AgentRuntime> {
    if (this.providerMaintenanceRuntime) {
      return this.providerMaintenanceRuntime;
    }
    if (this.pendingProviderMaintenanceRuntime) {
      return this.pendingProviderMaintenanceRuntime.promise;
    }

    const generation = this.providerMaintenanceRuntimeGeneration;
    let pendingRuntime!: PendingProviderMaintenanceRuntime;
    const promise = Promise.resolve()
      .then(() => this.createProviderMaintenanceRuntime(args))
      .then((runtime) => {
        if (
          this.pendingProviderMaintenanceRuntime === pendingRuntime &&
          this.providerMaintenanceRuntimeGeneration === generation
        ) {
          this.providerMaintenanceRuntime = runtime;
        }
        return runtime;
      })
      .finally(() => {
        if (this.pendingProviderMaintenanceRuntime === pendingRuntime) {
          this.pendingProviderMaintenanceRuntime = null;
        }
      });
    pendingRuntime = {
      generation,
      promise,
    };
    this.pendingProviderMaintenanceRuntime = pendingRuntime;
    return promise;
  }

  async withProviderMaintenanceRuntime<TResult>(
    args: { dataDir: string },
    request: (runtime: AgentRuntime) => Promise<TResult>,
  ): Promise<TResult> {
    this.clearProviderMaintenanceIdleTimer();
    this.providerMaintenanceActiveRequests += 1;
    try {
      const runtime = await this.ensureProviderMaintenanceRuntime(args);
      return await request(runtime);
    } finally {
      this.providerMaintenanceActiveRequests -= 1;
      if (this.providerMaintenanceActiveRequests === 0) {
        this.scheduleProviderMaintenanceIdleShutdown();
      }
    }
  }

  async ensureEnvironment(args: EnsureEnvironmentArgs): Promise<RuntimeEntry> {
    if (this.runtimesClosed) {
      throw new Error("Host daemon runtimes are shutting down");
    }
    const skillConfig = await this.resolveRuntimeSkillConfig(args);
    const existing = this.entries.get(args.environmentId);
    if (existing) {
      await this.runCancellableEnvironmentProvision({
        environmentId: args.environmentId,
        work: (signal) =>
          this.applyExistingEnvironmentProvision({
            entry: existing,
            provision: args.provision,
            signal,
          }),
      });
      const compatible = await this.ensureCompatibleEntry({
        entry: existing,
        skillConfig,
        ...(args.targetThreadId !== undefined
          ? { targetThreadId: args.targetThreadId }
          : {}),
      });
      if (compatible) {
        return compatible;
      }
    }

    const pending = this.pendingEntries.get(args.environmentId);
    if (pending) {
      const entry = await pending;
      const compatible = await this.ensureCompatibleEntry({
        entry,
        skillConfig,
        ...(args.targetThreadId !== undefined
          ? { targetThreadId: args.targetThreadId }
          : {}),
      });
      if (compatible) {
        return compatible;
      }
    }

    const pendingProvision = this.createPendingEnvironmentProvision(
      args.environmentId,
    );
    const creation = Promise.resolve()
      .then(() =>
        this.createEntry({
          ...args,
          provisionSignal: pendingProvision.abortController.signal,
          skillConfig,
        }),
      )
      .then((entry) => {
        this.entries.set(args.environmentId, entry);
        return entry;
      })
      .finally(() => {
        this.pendingEntries.delete(args.environmentId);
        this.pendingCatalogHashes.delete(args.environmentId);
        this.clearPendingEnvironmentProvision(
          args.environmentId,
          pendingProvision,
        );
      });
    pendingProvision.done = creation;
    this.pendingEntries.set(args.environmentId, creation);
    if (skillConfig !== null) {
      this.pendingCatalogHashes.set(
        args.environmentId,
        skillConfig.catalogHash,
      );
    }

    return creation;
  }

  async refreshEnvironmentWorkspace(
    args: RefreshEnvironmentWorkspaceArgs,
  ): Promise<HostWorkspace> {
    const pending = this.pendingWorkspaceRefreshes.get(args.environmentId);
    if (pending) {
      return pending;
    }

    const refresh = this.refreshEnvironmentWorkspaceOnce(args).finally(() => {
      if (this.pendingWorkspaceRefreshes.get(args.environmentId) === refresh) {
        this.pendingWorkspaceRefreshes.delete(args.environmentId);
      }
    });
    this.pendingWorkspaceRefreshes.set(args.environmentId, refresh);
    return refresh;
  }

  private async refreshEnvironmentWorkspaceOnce(
    args: RefreshEnvironmentWorkspaceArgs,
  ): Promise<HostWorkspace> {
    const entry = await this.getOrAwait(args.environmentId);
    if (entry && entry.path !== args.workspacePath) {
      throw new Error(
        `Cannot refresh environment ${args.environmentId} at ${args.workspacePath}; it is bound to ${entry.path}`,
      );
    }

    const workspace = await this.provisionHostWorkspace(args.provision);
    if (workspace.path !== args.workspacePath) {
      throw new Error(
        `Workspace refresh for ${args.environmentId} returned ${workspace.path}, not ${args.workspacePath}`,
      );
    }
    if (entry) {
      entry.workspace = workspace;
    }
    return workspace;
  }

  async cancelEnvironmentProvision(
    args: CancelEnvironmentProvisionArgs,
  ): Promise<CancelEnvironmentProvisionResult> {
    const pending = this.pendingEnvironmentProvisions.get(args.environmentId);
    if (!pending) {
      return { aborted: false };
    }

    pending.abortController.abort(
      new WorkspaceError(
        "provision_cancelled",
        "Environment provisioning was cancelled",
      ),
    );
    return { aborted: true };
  }

  private async runCancellableEnvironmentProvision(
    args: RunCancellableEnvironmentProvisionArgs,
  ): Promise<void> {
    const existing = this.pendingEnvironmentProvisions.get(args.environmentId);
    if (existing) {
      await existing.done;
      return;
    }

    const pending = this.createPendingEnvironmentProvision(args.environmentId);
    const done = Promise.resolve().then(() =>
      args.work(pending.abortController.signal),
    );
    pending.done = done;
    try {
      return await done;
    } finally {
      this.clearPendingEnvironmentProvision(args.environmentId, pending);
    }
  }

  private createPendingEnvironmentProvision(
    environmentId: string,
  ): PendingEnvironmentProvision {
    const pending: PendingEnvironmentProvision = {
      abortController: new AbortController(),
      done: Promise.resolve(),
    };
    this.pendingEnvironmentProvisions.set(environmentId, pending);
    return pending;
  }

  private clearPendingEnvironmentProvision(
    environmentId: string,
    pending: PendingEnvironmentProvision,
  ): void {
    if (this.pendingEnvironmentProvisions.get(environmentId) === pending) {
      this.pendingEnvironmentProvisions.delete(environmentId);
    }
  }

  private async applyExistingEnvironmentProvision(
    args: ApplyExistingEnvironmentProvisionArgs,
  ): Promise<void> {
    if (
      args.provision?.workspaceProvisionType !== "unmanaged" ||
      !args.provision.checkout
    ) {
      return;
    }
    if (args.provision.path !== args.entry.path) {
      throw new Error(
        `Cannot reprovision existing environment ${args.entry.environmentId} at a different path`,
      );
    }

    await this.provisionHostWorkspace({
      ...args.provision,
      signal: args.signal,
    });
    this.options.onWorkspaceStatusChanged?.({
      environmentId: args.entry.environmentId,
      changeKinds: ["work-status-changed", "git-refs-changed"],
    });
  }

  async destroyEnvironment(
    environmentId: string,
    args: DestroyWorkspaceArgs,
  ): Promise<void> {
    const existing = this.entries.get(environmentId);
    const pending = this.pendingEntries.get(environmentId);
    const entry = existing ?? (pending ? await pending : undefined);

    if (!entry) {
      return;
    }

    this.entries.delete(environmentId);
    await this.stopWatchingStatus(entry);
    await this.stopRuntimeEntry(entry, "environment-destroyed");
    await this.killManagedWorkspaceProcesses(entry);
    await entry.workspace.destroy(args);
    await this.cleanupUnusedInjectedSkillStagingDirs([]);
  }

  private async killManagedWorkspaceProcesses(
    entry: RuntimeEntry,
  ): Promise<void> {
    if (!entry.workspace.managed) {
      return;
    }
    try {
      const killed = await killProcessesWithCwdUnder({
        directory: entry.workspace.path,
      });
      if (killed.length > 0) {
        this.options.logger?.warn(
          {
            environmentId: entry.environmentId,
            workspacePath: entry.workspace.path,
            pids: killed.map((process) => process.pid),
          },
          "Killed processes still running in a destroyed environment",
        );
      }
    } catch (error) {
      this.options.logger?.warn(
        {
          environmentId: entry.environmentId,
          reason: error instanceof Error ? error.message : String(error),
        },
        "Failed to reap processes in a destroyed environment",
      );
    }
  }

  async forgetEnvironment(environmentId: string): Promise<void> {
    const existing = this.entries.get(environmentId);
    const pending = this.pendingEntries.get(environmentId);
    let entry = existing;
    if (!entry && pending) {
      try {
        entry = await pending;
      } catch {
        entry = undefined;
      }
    }

    if (!entry) {
      return;
    }

    this.entries.delete(environmentId);
    await this.stopWatchingStatus(entry);
    await this.stopRuntimeEntry(entry, "environment-forgotten");
    await this.cleanupUnusedInjectedSkillStagingDirs([]);
  }

  async evictIdleEnvironments(): Promise<string[]> {
    if (this.pendingEntries.size > 0) {
      return [];
    }
    await this.deferWhileProviderSignInRenews("idle-environment-evicted");
    if (this.pendingEntries.size > 0) {
      return [];
    }

    const idleEntries = [...this.entries.values()].filter(
      (entry) => !this.entryHasActiveEnvironmentWork(entry),
    );

    for (const entry of idleEntries) {
      await this.stopWatchingStatus(entry);
      this.entries.delete(entry.environmentId);
    }

    const shutdownResults = await Promise.allSettled(
      idleEntries.map(async (entry) => {
        await this.stopRuntimeEntry(entry, "idle-environment-evicted");
        return entry.environmentId;
      }),
    );
    const firstRejected = shutdownResults.find(
      (result) => result.status === "rejected",
    );
    if (firstRejected && firstRejected.status === "rejected") {
      throw firstRejected.reason;
    }

    await this.cleanupUnusedInjectedSkillStagingDirs([]);
    return shutdownResults.flatMap((result) =>
      result.status === "fulfilled" ? [result.value] : [],
    );
  }

  async reconcileBridgeWorkers(): Promise<void> {
    if (this.options.dataDir === undefined) return;
    const dir = bridgeWorkerDirForDataDir(this.options.dataDir);
    const { live, reaped, retirable } = reapDeadBridgeWorkers(dir);
    const normalizedLive = live.map((entry) =>
      migrateLegacyBridgeWorkerEntry(dir, entry),
    );
    const adoptable = normalizedLive.filter(isAdoptableBridgeWorker);
    const unadopted: { entry: BridgeWorkerRegistryEntry; reason: string }[] =
      normalizedLive
        .filter((entry) => !adoptable.includes(entry))
        .map((entry) => ({
          entry,
          reason:
            entry.formatVersion !== BRIDGE_WORKER_REGISTRY_FORMAT_VERSION
              ? "incompatible-registry-format"
              : entry.capabilities === null
                ? "handshake-not-recorded"
                : "incompatible-protocol-or-framing",
        }));
    const newestByProcess = new Map<string, BridgeWorkerRegistryEntry>();
    for (const entry of adoptable) {
      const key = bridgeWorkerProcessSlot(entry);
      const current = newestByProcess.get(key);
      if (current === undefined || entry.startedAt > current.startedAt) {
        newestByProcess.set(key, entry);
      }
    }
    for (const entry of adoptable) {
      if (newestByProcess.get(bridgeWorkerProcessSlot(entry)) !== entry) {
        unadopted.push({ entry, reason: "superseded-by-newer-worker" });
      }
    }
    const adopted: BridgeWorkerRegistryEntry[] = [];
    const byEnvironment = new Map<string, BridgeWorkerRegistryEntry[]>();
    for (const entry of newestByProcess.values()) {
      const group = byEnvironment.get(entry.environmentId) ?? [];
      group.push(entry);
      byEnvironment.set(entry.environmentId, group);
    }
    for (const [environmentId, entries] of byEnvironment) {
      const workspace = entries[0]?.workspace;
      if (workspace === undefined) continue;
      try {
        const runtimeEntry = await this.ensureEnvironment({
          environmentId,
          workspacePath: workspace.workspacePath,
          workspaceProvisionType: workspace.workspaceProvisionType,
          ...(workspace.personalWorkspaceRoot === null
            ? {}
            : { personalWorkspaceRoot: workspace.personalWorkspaceRoot }),
        });
        const threads = runtimeEntry.runtime.adoptBridgeWorkers({
          dir,
          entries,
        });
        const adoptedThreadIds = new Set(
          threads.map((thread) => thread.threadId),
        );
        for (const entry of entries) {
          if (
            Object.keys(entry.threads).some((threadId) =>
              adoptedThreadIds.has(threadId),
            )
          ) {
            adopted.push(entry);
          } else {
            unadopted.push({ entry, reason: "thread-configs-unreadable" });
          }
        }
        this.adoptedBridgeThreads.push(
          ...threads.map((thread) => ({
            ...thread,
            runtime: runtimeEntry.runtime,
          })),
        );
        for (const thread of threads) {
          this.adoptingThreadIds.add(thread.threadId);
        }
        if (threads.length > 0) {
          this.adoptionSettled = pendingAdoptionGate();
          runtimeEntry.adoptionProtectedUntil =
            Date.now() + ADOPTED_RUNTIME_PROTECTION_MS;
          this.options.logger?.info(
            { environmentId, protectedForMs: ADOPTED_RUNTIME_PROTECTION_MS },
            "Adopted environment runtime is protected from eviction while its provider work is unknown",
          );
        }
      } catch (error) {
        this.options.logger?.warn(
          { environmentId, err: error },
          "Could not adopt provider bridge workers; retiring them",
        );
        unadopted.push(
          ...entries.map((entry) => ({ entry, reason: "adoption-failed" })),
        );
      }
    }
    const retirements: {
      id: string;
      pid: number | null;
      reason: string;
      socketPath: string;
    }[] = [
      ...unadopted.map(({ entry, reason }) => ({
        id: entry.id,
        pid: entry.pid,
        reason,
        socketPath: entry.socketPath,
      })),
      ...retirable.map((item) => ({
        id: item.id,
        pid: null,
        reason: "unparseable-entry",
        socketPath: item.socketPath,
      })),
    ];
    if (retirements.length > 0) {
      await this.deferWhileProviderSignInRenews("bridge-worker-retired");
    }
    const retired = await Promise.all(
      retirements.map(async ({ id, pid, reason, socketPath }) => ({
        id,
        pid,
        reason,
        outcome: await retireBridgeWorker({
          dir,
          id,
          socketPath,
          timeoutMs: BRIDGE_WORKER_RETIRE_TIMEOUT_MS,
        }),
      })),
    );
    if (adopted.length > 0 || reaped.length > 0 || retired.length > 0) {
      this.options.logger?.info(
        {
          adopted: adopted.map((entry) => ({ id: entry.id, pid: entry.pid })),
          reaped: reaped.map((entry) => ({
            id: entry.id,
            pid: entry.pid,
            reason: "process-not-running",
          })),
          retired,
        },
        "Reconciled provider bridge workers left by a previous host daemon",
      );
    }
  }

  listAdoptedBridgeThreads(): {
    threadId: string;
    activeTurnId: string | null;
  }[] {
    return this.adoptedBridgeThreads.map(({ threadId, activeTurnId }) => ({
      threadId,
      activeTurnId,
    }));
  }

  async completeBridgeWorkerAdoption(
    fetchActiveTurnIds: (
      threadIds: readonly string[],
    ) => Promise<ReadonlyMap<string, string | null>>,
  ): Promise<void> {
    const adopted = this.adoptedBridgeThreads.splice(0);
    if (adopted.length === 0) return;
    try {
      await this.continueAdoptedThreads(adopted, fetchActiveTurnIds);
    } finally {
      this.adoptingThreadIds.clear();
      this.adoptionSettled.resolve();
    }
  }

  async whenBridgeWorkerAdoptionSettled(threadId?: string): Promise<void> {
    if (this.adoptionSettled.settled) return;
    if (threadId !== undefined && !this.adoptingThreadIds.has(threadId)) return;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      this.adoptionSettled.promise,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, BRIDGE_WORKER_ADOPTION_WAIT_MS);
        timer.unref();
      }),
    ]);
    clearTimeout(timer);
  }

  private async continueAdoptedThreads(
    adopted: typeof this.adoptedBridgeThreads,
    fetchActiveTurnIds: (
      threadIds: readonly string[],
    ) => Promise<ReadonlyMap<string, string | null>>,
  ): Promise<void> {
    let activeTurnIds: ReadonlyMap<string, string | null>;
    try {
      activeTurnIds = await fetchActiveTurnIds(
        adopted.map((thread) => thread.threadId),
      );
    } catch (error) {
      this.options.logger?.warn(
        { err: error },
        "Could not confirm adopted turns with the server; continuing them as new segments",
      );
      activeTurnIds = new Map();
    }
    for (const runtime of new Set(adopted.map((thread) => thread.runtime))) {
      runtime.completeBridgeWorkerAdoption(activeTurnIds);
    }
  }

  async shutdownAll(mode: RuntimeShutdownMode): Promise<void> {
    this.runtimesClosed = true;
    const entries = [...this.entries.values()];
    for (const pending of this.pendingEntries.values()) {
      try {
        entries.push(await pending);
      } catch {}
    }
    this.entries.clear();
    this.pendingEntries.clear();

    if (mode === "detach" && entries.length > 0) {
      this.options.logger?.info(
        { environmentIds: entries.map((entry) => entry.environmentId) },
        "Detaching from environment runtimes; their provider bridge workers keep running",
      );
    }
    if (mode === "detach") {
      await Promise.all(
        entries.map(async (entry) => {
          await this.stopWatchingStatus(entry);
          await entry.runtime.detach();
        }),
      );
    } else {
      for (const entry of entries) {
        await this.stopWatchingStatus(entry);
        await this.stopRuntimeEntry(entry, "host-daemon-stopped");
      }
    }
    await this.shutdownProviderMaintenanceRuntime();
    await this.stopWatchingDataDirSkillsRoot();
    this.stopWatchingDataDirSkillsRoot = STOP_WATCHING;
    await this.cleanupUnusedInjectedSkillStagingDirs([]);
  }

  private buildUnexpectedProviderExitEvents(
    info: AgentRuntimeProcessExitInfo,
  ): ThreadEvent[] {
    const message = buildProviderProcessExitMessage(info);
    const detail = buildProviderProcessExitDetail(info);
    const events: ThreadEvent[] = [];

    for (const thread of info.threads) {
      if (thread.activeTurnId === null) {
        if (thread.pendingTurnStart) {
          events.push({
            type: "system/error",
            threadId: thread.threadId,
            scope: threadScope(),
            code: "provider_process_exited",
            message,
            ...(detail ? { detail } : {}),
          });
        }
        continue;
      }

      if (thread.providerThreadId === null) {
        continue;
      }

      events.push({
        type: "turn/completed",
        threadId: thread.threadId,
        providerThreadId: thread.providerThreadId,
        scope: turnScope(thread.activeTurnId),
        status: "failed",
        error: { message },
      });
      events.push({
        type: "system/error",
        threadId: thread.threadId,
        scope: turnScope(thread.activeTurnId),
        code: "provider_process_exited",
        message,
        ...(detail ? { detail } : {}),
      });
    }

    return events;
  }

  private async createProviderMaintenanceRuntime(args: {
    dataDir: string;
  }): Promise<AgentRuntime> {
    const workspacePath = path.join(
      args.dataDir,
      PROVIDER_MAINTENANCE_WORKSPACE_DIR,
    );
    await mkdir(workspacePath, { recursive: true });

    let runtime: AgentRuntime | null = null;
    const shellEnv = this.getShellEnv();
    const providerProcessEnv = providerProcessEnvFromShellEnv(shellEnv);
    runtime = this.createRuntime({
      workspacePath,
      additionalWorkspaceWriteRoots: [],
      ...(providerProcessEnv ? { env: providerProcessEnv } : {}),
      shellEnv,
      threadStorageRootPath: this.options.threadStorageRootPath ?? undefined,
      bridgeBundleDir: this.options.bridgeBundleDir,
      onEvent: (event) => {
        this.options.onStderr?.(
          `Dropping provider maintenance event ${event.type}; no environment owns provider-only maintenance commands.`,
          event.threadId,
        );
      },
      onToolCall:
        this.options.onToolCall ??
        (async () => ({
          contentItems: [],
          success: true,
        })),
      onInteractiveRequest: this.options.onInteractiveRequest,
      onStderr: this.options.onStderr,
      onProcessExit: (info) => {
        if (
          runtime &&
          this.providerMaintenanceRuntime === runtime &&
          runtime.listRunningProviders().length === 0
        ) {
          this.providerMaintenanceRuntime = null;
        }
        this.options.onProcessExit?.(info);
      },
    });
    return runtime;
  }

  private async createEntry(args: CreateEntryArgs): Promise<RuntimeEntry> {
    const provision =
      args.provision ??
      (args.workspacePath
        ? reconnectProvisionArgs({
            environmentId: args.environmentId,
            ...(args.personalWorkspaceRoot !== undefined
              ? { personalWorkspaceRoot: args.personalWorkspaceRoot }
              : {}),
            workspacePath: args.workspacePath,
            workspaceProvisionType: args.workspaceProvisionType ?? "unmanaged",
          })
        : null);

    if (!provision) {
      throw new Error(
        `Missing workspace path for environment ${args.environmentId}`,
      );
    }

    const workspace = await this.provisionHostWorkspace({
      ...provision,
      signal: args.provisionSignal,
    });
    const workspaceWriteRoots =
      await workspace.getAdditionalWorkspaceWriteRoots();
    const additionalWorkspaceWriteRoots = this.runtimeWorkspaceWriteRoots({
      threadStorageRootPath: this.options.threadStorageRootPath,
      workspaceRoots: workspaceWriteRoots,
    });
    let runtime: AgentRuntime | null = null;
    const shellEnv = this.getShellEnv();
    const providerProcessEnv = providerProcessEnvFromShellEnv(shellEnv);
    runtime = this.createRuntime({
      workspacePath: workspace.path,
      additionalWorkspaceWriteRoots,
      ...(args.skillConfig ? { skillRoots: args.skillConfig.skillRoots } : {}),
      ...(providerProcessEnv ? { env: providerProcessEnv } : {}),
      shellEnv,
      threadStorageRootPath: this.options.threadStorageRootPath ?? undefined,
      bridgeBundleDir: this.options.bridgeBundleDir,
      ...(this.options.dataDir === undefined
        ? {}
        : {
            bridgeWorkers: {
              dir: bridgeWorkerDirForDataDir(this.options.dataDir),
              environmentId: args.environmentId,
              workspace: reconnectWorkspaceForProvision({
                provision,
                workspacePath: workspace.path,
              }),
            },
          }),
      onEvent: (event, delivery) => {
        this.options.onEvent?.({
          environmentId: args.environmentId,
          event,
          ...(delivery === undefined ? {} : { delivery }),
        });
      },
      onToolCall:
        this.options.onToolCall ??
        (async () => ({
          contentItems: [],
          success: true,
        })),
      onInteractiveRequest: this.options.onInteractiveRequest,
      onStderr: this.options.onStderr,
      onProviderRecovery: (hint) => {
        this.options.logger?.debug(
          {
            environmentId: args.environmentId,
            providerId: hint.providerId,
            threadId: hint.threadId,
            kind: hint.kind,
            retryable: hint.retryable,
            message: hint.message,
          },
          "Provider bridge raised a recovery hint",
        );
      },
      onProcessExit: (info) => {
        if (!info.expected) {
          for (const event of this.buildUnexpectedProviderExitEvents(info)) {
            this.options.onEvent?.({
              environmentId: args.environmentId,
              event,
            });
          }
        }
        const current = this.entries.get(args.environmentId);
        if (
          !info.expected &&
          current?.runtime === runtime &&
          runtime.listRunningProviders().length === 0
        ) {
          this.entries.delete(args.environmentId);
        }
        this.options.onProcessExit?.(info);
      },
    });

    return {
      adoptionProtectedUntil: null,
      environmentId: args.environmentId,
      runtime,
      skillCatalogHash: args.skillConfig?.catalogHash ?? null,
      lastWarnedStaleSkillCatalogHash: null,
      stopWatchingStatus: STOP_WATCHING,
      terminals: new Set<string>(),
      workspace,
      path: workspace.path,
    };
  }

  private provisionHostWorkspace(
    provision: ProvisionWorkspaceArgs,
  ): Promise<HostWorkspace> {
    return this.provisionWorkspace({
      ...provision,
      ...userExecutableProcessOptions(this.getShellEnv()),
    });
  }

  private async stopWatchingStatus(entry: RuntimeEntry): Promise<void> {
    const stopWatchingStatus = entry.stopWatchingStatus;
    entry.stopWatchingStatus = STOP_WATCHING;
    await stopWatchingStatus();
  }

  private ensureDataDirSkillsWatcher(): void {
    if (
      !this.hostWatcher?.watchDataDirSkillsRoot ||
      this.stopWatchingDataDirSkillsRoot !== STOP_WATCHING
    ) {
      return;
    }

    const dataDirSkillsRootPath = this.options.dataDirSkillsRootPath;
    if (!dataDirSkillsRootPath) {
      return;
    }

    this.stopWatchingDataDirSkillsRoot =
      this.hostWatcher.watchDataDirSkillsRoot({
        dataDirSkillsRootPath,
        onChange: (event) => {
          this.options.onInjectedSkillsChanged?.({
            changedPaths: event.changedPaths,
            sourceType: event.sourceType,
          });
        },
        onWatchError: (error) => {
          this.options.onDataDirSkillsWatchError?.({
            error,
          });
        },
      });
  }
}

export type RuntimeShutdownMode = "detach" | "stop";

const BRIDGE_WORKER_RETIRE_TIMEOUT_MS = 2_000;

function bridgeWorkerProcessSlot(entry: BridgeWorkerRegistryEntry): string {
  return `${entry.environmentId}\n${entry.processKey}`;
}

const legacyThreadConfigSchema = z.object({
  bridgeLaunch: z.object({
    capabilities: z
      .object({
        fork: z.enum(["none", "tip", "checkpoint"]),
        supportsThreadArchive: z.boolean(),
        supportsThreadRename: z.boolean(),
      })
      .passthrough(),
  }),
  sessionRestorable: z.boolean(),
});

const legacyProviderHandshakeDefaults: Record<
  string,
  Pick<
    BridgeCapabilities,
    "threadGoalClear" | "approvalEnforcedBy" | "steerMode"
  >
> = {
  "claude-code": {
    threadGoalClear: false,
    approvalEnforcedBy: "provider",
    steerMode: "inject",
  },
  codex: {
    threadGoalClear: true,
    approvalEnforcedBy: "runtime",
    steerMode: "inject",
  },
  pi: {
    threadGoalClear: false,
    approvalEnforcedBy: "runtime",
    steerMode: "inject",
  },
};

function inferLegacyBridgeCapabilities(
  entry: BridgeWorkerRegistryEntry,
): BridgeCapabilities | null {
  if (entry.formatVersion !== 1 || entry.capabilities !== null) return null;
  const declaration = legacyProviderHandshakeDefaults[entry.providerId];
  if (declaration === undefined) return null;
  const firstThread = Object.values(entry.threads)[0];
  if (firstThread === undefined) return null;
  const parsed = legacyThreadConfigSchema.safeParse(firstThread.config);
  if (!parsed.success) return null;
  return bridgeCapabilitiesSchema.parse({
    sessionRestore: parsed.data.sessionRestorable,
    threadArchive: parsed.data.bridgeLaunch.capabilities.supportsThreadArchive,
    threadRename: parsed.data.bridgeLaunch.capabilities.supportsThreadRename,
    ...declaration,
    fork: parsed.data.bridgeLaunch.capabilities.fork,
    grammarVersions: ASSEMBLER_GRAMMAR_VERSIONS,
    skills: { configure: true },
  });
}

function migrateLegacyBridgeWorkerEntry(
  dir: string,
  entry: BridgeWorkerRegistryEntry,
): BridgeWorkerRegistryEntry {
  const capabilities = inferLegacyBridgeCapabilities(entry);
  if (capabilities === null) return entry;
  const migrated = {
    ...entry,
    formatVersion: BRIDGE_WORKER_REGISTRY_FORMAT_VERSION,
    capabilities,
    capabilitiesSource: "inferred" as const,
  };
  writeBridgeWorkerEntry(dir, migrated);
  return migrated;
}

function isAdoptableBridgeWorker(entry: BridgeWorkerRegistryEntry): boolean {
  return (
    entry.formatVersion === BRIDGE_WORKER_REGISTRY_FORMAT_VERSION &&
    entry.bridgeProtocolVersion === PROVIDER_BRIDGE_PROTOCOL_VERSION &&
    entry.transportVersion === BRIDGE_SOCKET_TRANSPORT_VERSION &&
    entry.capabilities !== null &&
    Object.keys(entry.threads).length > 0
  );
}

const BRIDGE_WORKER_ADOPTION_WAIT_MS = 15_000;
const ADOPTED_RUNTIME_PROTECTION_MS = 15 * 60_000;

interface AdoptionGate {
  promise: Promise<void>;
  resolve: () => void;
  settled: boolean;
}

function settledAdoptionGate(): AdoptionGate {
  return {
    promise: Promise.resolve(),
    resolve: () => undefined,
    settled: true,
  };
}

function pendingAdoptionGate(): AdoptionGate {
  let settle: () => void = () => undefined;
  const gate: AdoptionGate = {
    promise: new Promise<void>((resolve) => {
      settle = resolve;
    }),
    resolve: () => {
      gate.settled = true;
      settle();
    },
    settled: false,
  };
  return gate;
}

function bridgeWorkerDirForDataDir(dataDir: string): string {
  return path.join(dataDir, "bridge-workers");
}
