import { createDesktopAppUpdateService } from "./services/system/desktop-app-update.js";
import { createDesktopUpdateChannel } from "./services/system/desktop-update-channel.js";
import { serve } from "@hono/node-server";
import { existsSync } from "node:fs";
import { Server as HttpServer } from "node:http";
import type { Socket } from "node:net";
import { verifyAuthenticatedDaemon } from "./internal/auth.js";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ServerConfig } from "@bb/config/server";
import { isLoopbackHostname } from "@bb/config/loopback";
import { toOptionalString } from "@bb/config/strings";
import {
  SERVER_HTTP_CLOSE_WAIT_TIMEOUT_MS,
  SERVER_HTTP_DRAIN_TIMEOUT_MS,
  SERVER_PLUGIN_SHUTDOWN_TIMEOUT_MS,
  SERVER_TERMINAL_OUTPUT_FLUSH_TIMEOUT_MS,
  SERVER_WEBSOCKET_SHUTDOWN_WAIT_TIMEOUT_MS,
} from "@bb/config/full-stack-shutdown";
import { superviseTcpServerSockets } from "@bb/process-utils";
import { createLogger } from "@bb/logger";
import {
  getAppSettings,
  getDisabledProviderIds,
  listRunningThreads,
  setAppSettings,
  type DbConnection,
} from "@bb/db";
import { initDb } from "./db.js";
import { createApp } from "./server.js";
import { PendingInteractionLifecycle } from "./services/interactions/pending-interactions.js";
import { createMachineAuthService } from "./services/machine-auth.js";
import { resolveBuiltinSkillsRootPath } from "./services/skills/builtin-skills-copy.js";
import { SkillTreeRegistry } from "./services/skills/injected-skills.js";
import { PluginHostArtifactRegistry } from "./services/plugins/plugin-host-artifact-registry.js";
import { createProviderNativeRootsCache } from "./services/providers/native-roots.js";
import { createAiServiceRegistry } from "./services/ai/ai-service-registry.js";
import { createAppUpdateService } from "./services/system/app-update.js";
import {
  createCliCommandService,
  createWindowsUserPath,
} from "./services/system/cli-command.js";
import { createAppVersionService } from "./services/system/app-version.js";
import {
  resetWorkspaceWriteClaims,
  startWorkspaceWriteClaimHeartbeat,
  stopWorkspaceWriteClaimHeartbeat,
} from "./services/threads/workspace-write-serialization.js";
import { createLauncherChannel } from "./services/system/launcher-channel.js";
import { watchLauncherDisconnect } from "./services/system/launcher-disconnect.js";
import { createBbAppManagedConfigReloader } from "./services/system/bb-app-managed-config.js";
import { startGatedPerformanceDiagnostics } from "./services/system/performance-diagnostics.js";
import { startEventLoopStallMonitor } from "./services/system/event-loop-stall-monitor.js";
import {
  runPeriodicSweeps,
  runStartupRecoverySweep,
} from "./services/system/periodic-sweeps.js";
import { installProviderModelCatalogPrewarm } from "./services/providers/provider-model-catalog-prewarm.js";
import {
  createProviderRegistryService,
  type ProviderRegistryService,
} from "./services/providers/provider-registry.js";
import type { PluginService } from "./services/plugins/plugin-service.js";
import {
  appInstallFromServerConfig,
  createTelemetryService,
} from "./services/system/telemetry.js";
import {
  createTerminalDataPlaneSpawn,
  startTerminalDataPlane,
} from "./services/terminals/data-plane/terminal-data-plane.js";
import { TerminalSessionLifecycle } from "./services/terminals/terminal-session-lifecycle.js";
import { createLifecycleDedupers } from "./lifecycle-dedupers.js";
import { TURN_ACCEPTANCE_GRACE_MS } from "./constants.js";
import type { ServerLogger, ServerRuntimeConfig } from "./types.js";
import { NotificationHub } from "./ws/hub.js";
import {
  onTerminalSocketClose,
  onTerminalSocketOpen,
  onTerminalSocketParsedMessage,
} from "./ws/terminal-protocol.js";
import { startDaemonLivenessChecks } from "./ws/daemon-protocol.js";
import { WatchInterestCoordinator } from "./ws/watch-interests.js";
import { WorkspaceReadCaches } from "./services/environments/workspace-read-cache.js";
import { HostSharedPortCoordinator } from "./ws/host-shared-ports.js";
import { disconnectImportedDaemonSessions } from "./internal/session-owner-side-effects.js";
import {
  applyServerImportAtBoot,
  refuseInterruptedServerImport,
  repairLastServerMoveHostName,
} from "./services/server-move/pending-boot.js";
import { createConnectHold } from "./services/server-move/connect-hold.js";
import { isServerMoveFrozen } from "./services/server-move/freeze-state.js";
import { reconcileServerMoveRunAtBoot } from "./services/server-move/reconcile.js";
import {
  retireServerProcess as retireProcessWithDeadline,
  SERVER_RETIRE_FORCE_EXIT_MS,
} from "./services/server-move/retire.js";
import {
  PluginToolCallRegistry,
  setPluginToolCallRegistry,
} from "./services/plugins/plugin-tool-calls.js";

const shutdownSockets = new WeakMap<HttpServer, Set<Socket>>();

async function waitAtMost(
  promise: Promise<unknown>,
  timeoutMs: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(
        () => true,
        () => false,
      ),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

interface StartHttpListenerArgs {
  fetch: Parameters<typeof serve>[0]["fetch"];
  logger: Pick<ServerLogger, "warn">;
  serverConfig: Pick<ServerConfig, "BB_SERVER_BIND_HOST" | "BB_SERVER_PORT">;
}

export function startHttpListener(args: StartHttpListenerArgs): HttpServer {
  const server = serve({
    hostname: args.serverConfig.BB_SERVER_BIND_HOST,
    port: args.serverConfig.BB_SERVER_PORT,
    fetch: args.fetch,
  }) as HttpServer;
  const sockets = new Set<Socket>();
  shutdownSockets.set(server, sockets);
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  superviseTcpServerSockets(server, (error, _socket, context) => {
    args.logger.warn(
      {
        err: error,
        ...context,
      },
      "Server TCP client socket failed",
    );
  });
  return server;
}

export async function shutdownHttpBeforePlugins(args: {
  closeDatabase?: () => void;
  closeWebSockets: () => Promise<void>;
  onPluginStopTimeout?: () => void;
  server: ReturnType<typeof startHttpListener>;
  stopPeriodicUpdateChecks?: () => Promise<void>;
  stopPlugins: () => Promise<void>;
  stopTerminalDataPlane: () => void;
  flushTerminalOutputBeforeClose?: (signal: AbortSignal) => Promise<void>;
}): Promise<{ completedWithinBounds: boolean; pluginStopTimedOut: boolean }> {
  let completedWithinBounds = true;
  let databaseCanClose = true;
  let pluginStopTimedOut = false;
  args.stopTerminalDataPlane();
  const closed = new Promise<void>((resolve, reject) => {
    args.server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
  args.server.closeIdleConnections();
  const webSocketsClosed = args.closeWebSockets();
  let drainTimer: ReturnType<typeof setTimeout> | undefined;
  let drained = false;
  try {
    drained = await Promise.race([
      closed.then(
        () => true,
        () => false,
      ),
      new Promise<boolean>((resolve) => {
        drainTimer = setTimeout(
          () => resolve(false),
          SERVER_HTTP_DRAIN_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (drainTimer !== undefined) {
      clearTimeout(drainTimer);
    }
  }
  if (!drained) {
    args.server.closeAllConnections();
  }
  const webSocketsClosedWithinBound = await waitAtMost(
    webSocketsClosed,
    SERVER_WEBSOCKET_SHUTDOWN_WAIT_TIMEOUT_MS,
  );
  completedWithinBounds = webSocketsClosedWithinBound && completedWithinBounds;
  databaseCanClose = webSocketsClosedWithinBound;
  if (args.flushTerminalOutputBeforeClose !== undefined) {
    const flushController = new AbortController();
    const flushOutcome = await new Promise<
      "completed" | "failed" | "timed-out"
    >((resolve) => {
      const timer = setTimeout(
        () => resolve("timed-out"),
        SERVER_TERMINAL_OUTPUT_FLUSH_TIMEOUT_MS,
      );
      void Promise.resolve()
        .then(() =>
          args.flushTerminalOutputBeforeClose!(flushController.signal),
        )
        .then(
          () => {
            clearTimeout(timer);
            resolve("completed");
          },
          () => {
            clearTimeout(timer);
            resolve("failed");
          },
        );
    });
    if (flushOutcome !== "completed") flushController.abort(flushOutcome);
    completedWithinBounds =
      flushOutcome === "completed" && completedWithinBounds;
  }
  const httpClosed = await waitAtMost(
    closed,
    SERVER_HTTP_CLOSE_WAIT_TIMEOUT_MS,
  );
  completedWithinBounds = httpClosed && completedWithinBounds;
  databaseCanClose = databaseCanClose && httpClosed;
  for (const socket of shutdownSockets.get(args.server) ?? []) socket.destroy();
  const httpClosedAfterSocketDestroy = await waitAtMost(
    closed,
    SERVER_HTTP_CLOSE_WAIT_TIMEOUT_MS,
  );
  completedWithinBounds = httpClosedAfterSocketDestroy && completedWithinBounds;
  databaseCanClose =
    databaseCanClose && (httpClosed || httpClosedAfterSocketDestroy);
  let pluginStopTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    const stopped = await Promise.race([
      Promise.all([args.stopPeriodicUpdateChecks?.(), args.stopPlugins()]).then(
        () => true,
      ),
      new Promise<false>((resolve) => {
        pluginStopTimer = setTimeout(
          () => resolve(false),
          SERVER_PLUGIN_SHUTDOWN_TIMEOUT_MS,
        );
      }),
    ]);
    if (!stopped) {
      pluginStopTimedOut = true;
      databaseCanClose = false;
      args.onPluginStopTimeout?.();
    }
    completedWithinBounds = stopped && completedWithinBounds;
  } finally {
    if (pluginStopTimer !== undefined) clearTimeout(pluginStopTimer);
  }
  if (databaseCanClose && !pluginStopTimedOut) args.closeDatabase?.();
  return { completedWithinBounds, pluginStopTimedOut };
}

export async function shutdownServerRuntime(args: {
  closeWebSockets: () => Promise<void>;
  db: DbConnection;
  logger: Pick<ServerLogger, "warn">;
  stopPeriodicUpdateChecks: () => Promise<void>;
  stopPlugins: () => Promise<void>;
  server: ReturnType<typeof startHttpListener>;
  stopTerminalDataPlane: () => void;
  flushTerminalOutputBeforeClose?: (signal: AbortSignal) => Promise<void>;
}): Promise<{ completedWithinBounds: boolean; pluginStopTimedOut: boolean }> {
  const result = await shutdownHttpBeforePlugins({
    closeDatabase: () => args.db.$client.close(),
    closeWebSockets: args.closeWebSockets,
    onPluginStopTimeout: () =>
      args.logger.warn(
        `Plugin shutdown did not finish within ${SERVER_PLUGIN_SHUTDOWN_TIMEOUT_MS}ms`,
      ),
    server: args.server,
    stopPeriodicUpdateChecks: args.stopPeriodicUpdateChecks,
    stopPlugins: args.stopPlugins,
    stopTerminalDataPlane: args.stopTerminalDataPlane,
    flushTerminalOutputBeforeClose: args.flushTerminalOutputBeforeClose,
  });
  if (result.pluginStopTimedOut) {
    args.logger.warn("Database close skipped because plugin stop timed out");
  } else if (!result.completedWithinBounds) {
    args.logger.warn(
      "Database close skipped because a shutdown step exceeded its bound",
    );
  }
  return result;
}

export interface StartServerPluginsArgs {
  dataDir: string;
  logger: Pick<ServerLogger, "error" | "warn">;
  pluginService: Pick<PluginService, "start" | "startPeriodicUpdateChecks">;
  providerRegistry: Pick<ProviderRegistryService, "markRegistrationsSettled">;
}

export function startServerPlugins(
  args: StartServerPluginsArgs,
): Promise<void> {
  return args.pluginService
    .start({
      hold: createConnectHold({ dataDir: args.dataDir, logger: args.logger }),
    })
    .catch((error: unknown) => {
      args.logger.error({ err: error }, "Plugin startup failed");
    })
    .finally(() => {
      args.providerRegistry.markRegistrationsSettled();
      args.pluginService.startPeriodicUpdateChecks();
    });
}

export async function runServer(serverConfig: ServerConfig): Promise<void> {
  const logger = createLogger({
    component: "server",
    dataDir: serverConfig.BB_DATA_DIR,
  });
  const launcherDisconnect = watchLauncherDisconnect(process, {
    exit: (code) => process.exit(code),
    log: (message) => logger.warn(message),
  });
  await launcherDisconnect.ready();
  await refuseInterruptedServerImport({
    dataDir: serverConfig.BB_DATA_DIR,
    logger,
  });
  let diagnosticsEnabled = () => false;
  const db = initDb(serverConfig.databasePath, {
    slowQueryThresholdMs: () => (diagnosticsEnabled() ? 25 : 100),
    slowQueryDiagnosticsEnabled: () => diagnosticsEnabled(),
    dataDir: serverConfig.BB_DATA_DIR,
    logger,
  });
  const serverImport = await applyServerImportAtBoot({
    dataDir: serverConfig.BB_DATA_DIR,
    db,
    logger,
    now: Date.now(),
  });
  const pendingServerMove = serverImport.pendingMove;
  if (pendingServerMove === null) {
    await repairLastServerMoveHostName({
      dataDir: serverConfig.BB_DATA_DIR,
      db,
      logger,
    });
  }
  if (serverConfig.BB_SKIP_ONBOARDING) {
    const settings = getAppSettings(db);
    if (settings.onboardingCompletedAt === null) {
      setAppSettings(db, {
        ...settings,
        onboardingCompletedAt: new Date().toISOString(),
      });
    }
  }
  const serverMoveRun =
    pendingServerMove === null
      ? await reconcileServerMoveRunAtBoot({
          dataDir: serverConfig.BB_DATA_DIR,
          logger,
          now: Date.now(),
        })
      : null;
  const hub = new NotificationHub();
  const watchInterests = new WatchInterestCoordinator({ db, hub });
  const sharedPorts = new HostSharedPortCoordinator({ db, hub });
  const workspaceReadCaches = new WorkspaceReadCaches({ hub });
  const lifecycleDedupers = createLifecycleDedupers();
  const appUrl = toOptionalString(serverConfig.BB_APP_URL);

  const selfDir = dirname(fileURLToPath(import.meta.url));
  const appDir = resolve(selfDir, "../../app");
  const appDistDir = join(appDir, "dist");
  const isProduction = process.env.NODE_ENV === "production";
  const staticDir =
    isProduction && existsSync(appDistDir) ? appDistDir : undefined;
  const runtimeConfig: ServerRuntimeConfig = {
    appVersion: serverConfig.BB_APP_VERSION,
    builtinSkillsRootPath: resolveBuiltinSkillsRootPath(),
    marketplaceUrl: serverConfig.BB_MARKETPLACE_URL,
    connectGateKeysUrl: serverConfig.BB_CONNECT_GATE_KEYS_URL,
    customModels: [],
    dataDir: serverConfig.BB_DATA_DIR,
    featureFlags: serverConfig.featureFlags,
    hostDaemonPort: serverConfig.BB_HOST_DAEMON_PORT,
    inheritedSkillsRootPaths: serverConfig.BB_INHERITED_SKILLS_ROOTS,
    isDevelopment: !isProduction,
    turnAcceptanceGraceMs: TURN_ACCEPTANCE_GRACE_MS,
    performanceDiagnosticsAvailable: serverConfig.BB_PERF_DIAGNOSTICS,
    serverPort: serverConfig.BB_SERVER_PORT,
    sharedSkillRoots: { user: [], project: [] },
  };

  const providerRegistry = createProviderRegistryService({
    deferRegistrationsSettled: true,
    readUserProviderPreferences: () => {
      const settings = getAppSettings(db);
      return {
        providerOrder: settings.providerOrder,
        disabledProviderIds: getDisabledProviderIds(db),
        defaultProviderId: settings.defaultProviderId,
      };
    },
  });

  if (appUrl !== undefined) {
    runtimeConfig.appUrl = appUrl;
  }
  if (serverConfig.BB_DEV_APP_PORT !== undefined) {
    runtimeConfig.devAppPort = serverConfig.BB_DEV_APP_PORT;
  }
  if (serverConfig.BB_SERVER_LAUNCH_ID !== undefined) {
    runtimeConfig.launchId = serverConfig.BB_SERVER_LAUNCH_ID;
  }
  const terminalSessions = new TerminalSessionLifecycle({
    config: runtimeConfig,
    db,
    hub,
    logger,
  });
  const bbAppManagedConfig = await createBbAppManagedConfigReloader({
    config: runtimeConfig,
    hub,
    logger,
  });

  const telemetry = await createTelemetryService({
    apiKey: serverConfig.BB_POSTHOG_API_KEY,
    appInstall: appInstallFromServerConfig(serverConfig),
    appSurface: serverConfig.BB_APP_SURFACE,
    appVersion: serverConfig.BB_APP_VERSION,
    dataDir: serverConfig.BB_DATA_DIR,
    enabled:
      serverConfig.BB_TELEMETRY && isProduction && pendingServerMove === null,
    telemetryEnabled: getAppSettings(db).telemetryEnabled,
    logger,
  });

  const machineAuth = await createMachineAuthService({
    dataDir: serverConfig.BB_DATA_DIR,
    db,
    logger,
  });
  await machineAuth.ensureReady();
  const skillTreeRegistry = new SkillTreeRegistry();
  const pluginHostArtifacts = new PluginHostArtifactRegistry();
  const providerNativeRoots = createProviderNativeRootsCache();
  const aiServices = createAiServiceRegistry({
    onStatusChange: () => hub.notifySystem(["config-changed"]),
  });
  const pendingInteractions = new PendingInteractionLifecycle({
    config: runtimeConfig,
    db,
    hub,
    lifecycleDedupers,
    logger,
    machineAuth,
    providerRegistry,
    pluginHostArtifacts,
    aiServices,
    skillTreeRegistry,
    telemetry,
    terminalSessions,
  });
  pendingInteractions.start();
  setPluginToolCallRegistry(new PluginToolCallRegistry({ logger }));

  const appVersion = createAppVersionService({
    installKind: serverConfig.BB_APP_INSTALL_KIND ?? null,
    sourceCommit: serverConfig.BB_APP_SOURCE_COMMIT ?? null,
    config: runtimeConfig,
    logger,
  });
  const appUpdateMode = serverConfig.BB_APP_UPDATE_MODE ?? null;
  const desktopUpdateChannel =
    serverConfig.BB_APP_SURFACE === "desktop"
      ? createDesktopUpdateChannel(process)
      : null;
  const appUpdate =
    desktopUpdateChannel === null
      ? createAppUpdateService({
          currentCommit:
            serverConfig.BB_APP_INSTALL_KIND === "source"
              ? (serverConfig.BB_APP_SOURCE_COMMIT ?? null)
              : null,
          appSurface: serverConfig.BB_APP_SURFACE,
          appVersion,
          config: runtimeConfig,
          countRunningThreads: () => listRunningThreads(db).length,
          launcher:
            appUpdateMode === null ? null : createLauncherChannel(process),
          logger,
          mode: appUpdateMode,
          notifyChanged: () => hub.notifySystem(["app-update-changed"]),
        })
      : createDesktopAppUpdateService({
          channel: desktopUpdateChannel,
          currentVersion: runtimeConfig.appVersion,
          dataDir: serverConfig.BB_DATA_DIR,
          countRunningThreads: () => listRunningThreads(db).length,
          notifyChanged: () => hub.notifySystem(["app-update-changed"]),
          logger,
        });
  const cliCommand = createCliCommandService({
    env: process.env,
    homeDir: homedir(),
    launcherPath: serverConfig.BB_CLI_LAUNCHER ?? null,
    platform: process.platform,
    windowsUserPath: createWindowsUserPath(process.env),
  });
  const {
    app,
    closeWebSockets,
    injectWebSocket,
    pluginCatalogService,
    pluginService,
    serverMove,
    tunnelIngress,
  } = createApp(
    {
      appUpdate,
      appVersion,
      bbAppManagedConfig,
      cliCommand,
      config: runtimeConfig,
      db,
      hub,
      lifecycleDedupers,
      logger,
      machineAuth,
      pendingInteractions,
      providerRegistry,
      pluginHostArtifacts,
      providerNativeRoots,
      aiServices,
      skillTreeRegistry,
      telemetry,
      terminalSessions,
      watchInterests,
      sharedPorts,
      workspaceReadCaches,
    },
    {
      serverMove: {
        appSurface: serverConfig.BB_APP_SURFACE,
        bindHost: serverConfig.BB_SERVER_BIND_HOST,
        manualImportPending: serverImport.manualImportPending,
        pending: pendingServerMove,
        restoredRun: serverMoveRun,
        retireProcess: retireServerProcess,
      },
      staticDir,
      performanceDiagnosticsEnabled: () => diagnosticsEnabled(),
    },
  );
  disconnectImportedDaemonSessions(
    {
      config: runtimeConfig,
      db,
      hub,
      lifecycleDedupers,
      logger,
      machineAuth,
      pendingInteractions,
      providerRegistry,
      pluginHostArtifacts,
      aiServices,
      skillTreeRegistry,
      telemetry,
      terminalSessions,
    },
    { sessions: serverImport.importedDaemonSessions },
  );
  resetWorkspaceWriteClaims({ db });
  startWorkspaceWriteClaimHeartbeat({ db });
  const performanceDiagnostics = await startGatedPerformanceDiagnostics({
    allowed: serverConfig.BB_PERF_DIAGNOSTICS,
    dataDir: serverConfig.BB_DATA_DIR,
    db,
    hub,
    logger,
  });
  diagnosticsEnabled = performanceDiagnostics.isEnabled;
  const eventLoopStallMonitor = startEventLoopStallMonitor({
    logger,
    thresholdMs: () => (diagnosticsEnabled() ? 100 : 500),
  });
  const stopDaemonLivenessChecks = startDaemonLivenessChecks({
    config: runtimeConfig,
    db,
    hub,
    lifecycleDedupers,
    logger,
    machineAuth,
    pendingInteractions,
    providerRegistry,
    pluginHostArtifacts,
    aiServices,
    sharedPorts,
    skillTreeRegistry,
    telemetry,
    terminalSessions,
  });

  const sweepDeps = {
    config: runtimeConfig,
    db,
    hub,
    lifecycleDedupers,
    logger,
    machineAuth,
    pendingInteractions,
    providerRegistry,
    pluginHostArtifacts,
    aiServices,
    skillTreeRegistry,
    pluginSchedules: pluginService,
    plugins: pluginService,
    telemetry,
    terminalSessions,
  };
  const providerModelCatalogPrewarm =
    pendingServerMove === null
      ? installProviderModelCatalogPrewarm(sweepDeps)
      : null;
  if (pendingServerMove === null) {
    await runStartupRecoverySweep(sweepDeps).catch((error) => {
      logger.error({ err: error }, "Startup recovery sweep failed");
    });
  }

  if (!isLoopbackHostname(serverConfig.BB_SERVER_BIND_HOST)) {
    logger.warn(
      { bindHost: serverConfig.BB_SERVER_BIND_HOST },
      "SECURITY WARNING: The public API is unauthenticated and permits command execution and file reads. Wildcard server binding must only be used behind a trusted network boundary.",
    );
  }

  const server = startHttpListener({
    fetch: app.fetch,
    logger,
    serverConfig,
  });
  injectWebSocket(server);
  const terminalDataPlane =
    server instanceof HttpServer
      ? startTerminalDataPlane({
          daemons: {
            currentSessionIdForHost: (hostId) =>
              hub.getDaemonSessionIdForHost(hostId),
            request: (args) => hub.requestHostOnlineRpc(args),
            setSessionDirectOutput: (args) =>
              terminalSessions.setDaemonSessionDirectOutput(args),
            subscribe: (listener) => hub.subscribeDaemonSessions(listener),
            verify: (authorizationHeader) =>
              verifyAuthenticatedDaemon({ machineAuth }, authorizationHeader),
          },
          guard: { config: runtimeConfig },
          lifecycle: {
            attach: (args) => {
              terminalSessions.markDirectOutputSocket(args.socket);
              onTerminalSocketOpen({ terminalSessions }, args);
            },
            detach: (args) => onTerminalSocketClose({ terminalSessions }, args),
            handleMessage: (args) =>
              onTerminalSocketParsedMessage({ terminalSessions }, args),
            recordInputActivity: (terminalId) =>
              terminalSessions.recordDirectTerminalInput(terminalId),
            stripHolderMarkersFromDataPlaneOutput: (terminalId, chunk) =>
              terminalSessions.stripHolderMarkersFromDataPlaneOutput(
                terminalId,
                chunk,
              ),
            recordOutputBatch: (args) =>
              terminalSessions.recordDirectTerminalOutputBatch(args),
          },
          logger,
          resolveTerminal: (terminalId) =>
            terminalSessions.resolveRunningTerminalRoute(terminalId),
          server,
          spawn: createTerminalDataPlaneSpawn(),
        })
      : null;

  logger.info(
    {
      bindHost: serverConfig.BB_SERVER_BIND_HOST,
      port: serverConfig.BB_SERVER_PORT,
      dataDir: serverConfig.BB_DATA_DIR,
    },
    "Server listening",
  );
  void terminalSessions.warmTerminalScreenStates().catch((error: unknown) => {
    logger.warn({ err: error }, "Failed to warm terminal screen states");
  });
  pluginService.bindSdk({
    baseUrl: `http://127.0.0.1:${serverConfig.BB_SERVER_PORT}`,
  });
  let sweepInterval: ReturnType<typeof setInterval> | null = null;
  if (pendingServerMove === null) {
    telemetry.capture({ name: "app_started" });
    if (serverMoveRun?.kind === "completed") {
      logger.info(
        { moveId: serverMoveRun.run.status.moveId },
        "This server already moved before it restarted; retiring without starting plugins",
      );
      providerRegistry.markRegistrationsSettled();
    } else {
      void startServerPlugins({
        dataDir: serverConfig.BB_DATA_DIR,
        logger,
        pluginService,
        providerRegistry,
      }).finally(() => {
        void serverMove.handlePluginsStarted();
      });
    }
    sweepInterval = setInterval(() => {
      if (!isServerMoveFrozen(db)) {
        void runPeriodicSweeps(sweepDeps);
      }
    }, 10_000);
    sweepInterval.unref();
  } else {
    logger.info(
      { moveId: pendingServerMove.moveId },
      "Server started in pending move mode; waiting for the target machine to activate it",
    );
  }

  let shutdownPromise: Promise<void> | null = null;
  const runShutdown = (): Promise<void> => {
    if (shutdownPromise) {
      return shutdownPromise;
    }
    shutdownPromise = (async () => {
      serverMove.dispose();
      appUpdate.dispose();
      providerModelCatalogPrewarm?.stop();
      eventLoopStallMonitor.stop();
      await performanceDiagnostics.stop();
      stopDaemonLivenessChecks();
      stopWorkspaceWriteClaimHeartbeat({ db });
      if (sweepInterval !== null) {
        clearInterval(sweepInterval);
      }
      pluginCatalogService.stopPeriodicRefresh();
      await shutdownServerRuntime({
        closeWebSockets,
        db,
        logger,
        stopPlugins: async () => {
          if (pendingServerMove !== null) return;
          await pluginService.stop().catch((error: unknown) => {
            logger.warn({ err: error }, "Plugin shutdown failed");
          });
        },
        stopPeriodicUpdateChecks: () =>
          pluginService.stopPeriodicUpdateChecks(),
        server,
        stopTerminalDataPlane: () => {
          terminalDataPlane?.stop();
        },
        flushTerminalOutputBeforeClose: async (signal) => {
          await terminalSessions.flushRetainedOutputBeforeClose(signal);
        },
      });
      await tunnelIngress.closeAll();
      await closeWebSockets();
    })();
    return shutdownPromise;
  };

  function retireServerProcess(): void {
    logger.info({}, "Server moved to another machine; shutting down");
    retireProcessWithDeadline({
      exit: (code) => process.exit(code),
      forceExitAfterMs: SERVER_RETIRE_FORCE_EXIT_MS,
      shutdown: runShutdown,
    });
  }

  process.on("uncaughtException", (error: unknown) => {
    if (pluginService.handleUncaughtException(error)) return;
    const message =
      error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  });

  process.once("SIGINT", () => {
    void runShutdown().finally(() => process.exit(0));
  });
  process.once("SIGTERM", () => {
    void runShutdown().finally(() => process.exit(0));
  });
  launcherDisconnect.setShutdown({
    shutdown: runShutdown,
    exit: (code) => process.exit(code),
  });
}
