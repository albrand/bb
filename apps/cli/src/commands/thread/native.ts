import { spawn } from "node:child_process";
import { mkdirSync, statSync, unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import type { NativeTerminalThread } from "@bb/server-contract";
import { action, CliExitError } from "../../action.js";
import { cliFetch, createCliBbSdk } from "../../client.js";
import { createNodeBbSdk } from "@bb/sdk/node";
import {
  takeNativeToolCredentialFromEnv,
  withSocketCredential,
} from "../../native-tool-credential.js";
import { requireThreadIdOrSelf } from "../../context-env.js";
import { fillNativeTerminalTemplate } from "@bb/domain";
import { createSessionDiscoverer } from "../../native-session-discovery.js";
import {
  createNativeActivityPump,
  createNativeActivityWiring,
} from "../../native-activity-wiring.js";
import { createNativeActivityReporter } from "../../native-activity-reporter.js";
import { nativeActivityHookSettings } from "../../native-activity.js";
import {
  hookSpoolCandidates,
  openHookCapture,
  removeHookSpool,
  type HookCapture,
} from "../../native-hook-spool.js";
import {
  measureResumedTranscript,
  NativeActivityReader,
} from "../../native-activity-reader.js";
import {
  findNativeSession,
  nativeMcpArgs,
  resolveNativeHarnessLaunch,
} from "../../native-harness.js";
import {
  defaultNativeHolderSocketPath,
  openNativeHolderConnection,
  ignoreNativeHolderSignals,
  logNativeHolderEvent,
  pipeNativeHolderClient,
  runNativeHolder,
} from "../../native-holder.js";
import { runNativeMcpServer } from "../../native-mcp.js";
import { checkNativeTerminal } from "../../native-terminal-check.js";
import { outputJson } from "../helpers.js";
import { attachTerminal } from "../terminal.js";

const SESSION_DISCOVERY_INTERVAL_MS = 2_000;
const ACTIVITY_POLL_INTERVAL_MS = 750;
const ACTIVITY_HEARTBEAT_INTERVAL_MS = 30_000;
const ACTIVITY_FLUSH_TIMEOUT_MS = 3_000;
const HOLDER_START_TIMEOUT_MS = 20_000;
const DETACHING_SIGNALS = ["SIGTERM", "SIGHUP"] as const;
const SWALLOWED_SIGNALS = ["SIGINT", "SIGQUIT"] as const;

interface NativeOpenOptions {
  attach?: boolean;
  chat?: boolean;
  convert?: boolean;
  json?: boolean;
  self?: boolean;
}

interface NativeRunOptions {
  json?: boolean;
  probe?: boolean;
  reattach?: boolean;
}

interface NativeHoldOptions {
  json?: boolean;
  socket: string;
}

function describeNativeThread(view: NativeTerminalThread): string {
  const terminal =
    view.terminal === null
      ? "no terminal"
      : `terminal ${view.terminal.id} (${view.terminal.status})`;
  const session = view.nativeSessionId ?? "not yet known";
  return `${view.displayName} session ${session}, ${terminal}`;
}

function nativeHolderLogPath(socketPath: string): string {
  return socketPath.replace(/\.sock$/u, ".log");
}

function removeEmptyNativeHolderLog(socketPath: string): void {
  const logPath = nativeHolderLogPath(socketPath);
  try {
    if (statSync(logPath).size === 0) unlinkSync(logPath);
  } catch {
    return;
  }
}

function spawnNativeHolder(threadId: string, socketPath: string): void {
  mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 });
  const script = process.argv[1];
  if (script === undefined) {
    throw new CliExitError(
      "Cannot locate the bb CLI to start the native terminal holder",
      1,
    );
  }
  const holder = spawn(
    process.execPath,
    [
      ...process.execArgv,
      script,
      "thread",
      "native-hold",
      threadId,
      "--socket",
      socketPath,
    ],
    {
      cwd: process.cwd(),
      detached: true,
      env: process.env,
      stdio: ["ignore", "ignore", "ignore"],
    },
  );
  holder.unref();
}

async function runNativeHarness(
  baseUrl: string,
  threadId: string,
  reattachOnly: boolean,
): Promise<number> {
  const socketPath = defaultNativeHolderSocketPath(baseUrl, threadId);
  const credential = takeNativeToolCredentialFromEnv(process.env);
  const connection = await openNativeHolderConnection({
    socketPath,
    reattachOnly,
    startHolder: () => spawnNativeHolder(threadId, socketPath),
    startTimeoutMs: HOLDER_START_TIMEOUT_MS,
  });
  if (connection.kind === "ended") {
    process.stdout.write(
      "The CLI for this thread ended while bb was disconnected from this machine. Open the terminal again to resume the session.\r\n",
    );
    return 0;
  }
  if (connection.kind === "did-not-start") {
    throw new CliExitError(
      `The native terminal holder did not start; see ${nativeHolderLogPath(socketPath)}`,
      1,
    );
  }
  const attached = connection.socket;
  for (const signal of SWALLOWED_SIGNALS) process.on(signal, () => {});
  for (const signal of DETACHING_SIGNALS) {
    process.on(signal, () => {
      attached.destroy();
    });
  }
  return await pipeNativeHolderClient(attached, {
    input: process.stdin,
    output: process.stdout,
    fallbackSize: { cols: 120, rows: 40 },
    credential,
  });
}

interface NativeMcpOptions {
  credentialSocket: string;
  serverUrl?: string;
}

async function holdNativeHarness(
  baseUrl: string,
  threadId: string,
  socketPath: string,
): Promise<number> {
  let ownsSocket = false;
  ignoreNativeHolderSignals(process, socketPath, () => ownsSocket);
  process.on("uncaughtExceptionMonitor", (error) => {
    if (!ownsSocket) return;
    logNativeHolderEvent(socketPath, "uncaught-exception", {
      name: error.name,
    });
  });
  const sdk = createCliBbSdk(baseUrl);
  const nodePty = await import("node-pty");
  const cwd = process.cwd();
  let discovery: {
    cli: Parameters<typeof findNativeSession>[0]["cli"];
    launchedAtMs: number;
  } | null = null;
  const discoverer = createSessionDiscoverer({
    currentCredential: () => currentCredential(),
    discardUnsentReports: () => reporter.discardRetained(),
    find: () => {
      if (discovery === null) return null;
      try {
        const match = findNativeSession({
          cli: discovery.cli,
          cwd,
          env: process.env,
          launchedAtMs: discovery.launchedAtMs,
          nowMs: Date.now(),
        });
        return match.kind === "unique" ? match.sessionId : null;
      } catch {
        return null;
      }
    },
    log: (event, fields) => {
      if (ownsSocket) logNativeHolderEvent(socketPath, event, fields);
    },
    reader: () => reader,
    recordSession: (args) =>
      sdk.nativeTerminals.recordSession({ ...args, threadId }),
  });
  const discover = discoverer.discover;
  let reader: NativeActivityReader | null = null;
  let hookSpoolDirectory: string | null = null;
  const activityTimers: NodeJS.Timeout[] = [];
  let currentCredential: () => string | null = () => null;
  const reporter = createNativeActivityReporter({
    currentCredential: () => currentCredential(),
    log: (event, fields) => {
      if (ownsSocket) logNativeHolderEvent(socketPath, event, fields);
    },
    send: (args) => sdk.nativeTerminals.reportActivity(args),
    threadId,
  });
  const report = reporter.report;
  const wiring = createNativeActivityWiring({
    currentCredential: () => currentCredential(),
    log: (event, fields) => {
      if (ownsSocket) logNativeHolderEvent(socketPath, event, fields);
    },
    reader: () => reader,
    recordSession: (args) =>
      sdk.nativeTerminals.recordSession({ ...args, threadId }),
    report,
    retryReport: reporter.retry,
  });
  const readActivity = createNativeActivityPump({
    reader: () => reader,
    report,
  });
  const finishActivity = (): void => {
    report(reader?.finish() ?? null);
  };
  let pty: ReturnType<typeof nodePty.spawn> | null = null;
  const exitCode = await runNativeHolder({
    socketPath,
    holderPid: process.pid,
    holderPgid: process.pid,
    holderSid: process.pid,
    cwd,
    env: process.env,
    onCredentialChanged: wiring.onCredentialChanged,
    prepare: async ({
      credential,
      credentialSocket,
      currentCredential: readCredential,
    }) => {
      currentCredential = readCredential;
      const spec = await sdk.nativeTerminals.launch({
        imagesAsArgv: true,
        threadId,
      });
      const activity = spec.cli.activity;
      const hooks = activity?.hooks;
      const capture: HookCapture | null =
        hooks === undefined
          ? null
          : openHookCapture(
              hookSpoolCandidates({
                env: process.env,
                home: os.homedir(),
                tmpDir: os.tmpdir(),
              }),
              threadId,
              {
                appendFallback: () => {
                  if (ownsSocket) {
                    logNativeHolderEvent(
                      socketPath,
                      "activity-hook-spool-append-fallback",
                      {},
                    );
                  }
                },
                unsupported: () => {
                  if (ownsSocket) {
                    logNativeHolderEvent(
                      socketPath,
                      "activity-hook-spool-unsupported",
                      {},
                    );
                  }
                },
              },
            );
      hookSpoolDirectory = capture?.directory ?? null;
      const source = capture?.source;
      const hookTarget =
        source === undefined ||
        (typeof source === "object" && "unavailable" in source)
          ? null
          : source;
      const activityArgs =
        hooks === undefined || hookTarget === null
          ? []
          : hooks.args.map((arg) =>
              fillNativeTerminalTemplate(arg, {
                settings: nativeActivityHookSettings(hooks, hookTarget),
              }),
            );
      const script = process.argv[1];
      const mcpArgs =
        script === undefined || credential === null
          ? []
          : nativeMcpArgs(spec.cli, {
              command: process.execPath,
              args: [
                ...process.execArgv,
                script,
                "thread",
                "native-mcp",
                threadId,
                "--server-url",
                baseUrl,
                "--credential-socket",
                credentialSocket,
              ],
            });
      const launch = resolveNativeHarnessLaunch(
        spec,
        process.env,
        activityArgs,
        mcpArgs,
        cwd,
      );
      discovery = { cli: spec.cli, launchedAtMs: Date.now() };
      discoverer.arm(launch.session.kind === "discover");
      reader = new NativeActivityReader(
        spec.cli,
        process.env,
        capture?.source ?? null,
        launch.session.kind === "resume"
          ? {
              ...launch.session,
              ...(await measureResumedTranscript(
                spec.cli,
                process.env,
                launch.session.id,
              )),
            }
          : launch.session,
        (total) => {
          if (ownsSocket) {
            logNativeHolderEvent(socketPath, "activity-transcript-eviction", {
              count: total,
            });
          }
        },
        (reason, total) => {
          if (ownsSocket) {
            logNativeHolderEvent(
              socketPath,
              "activity-hook-identity-unconfirmed",
              {
                reason,
                count: total,
              },
            );
          }
        },
        wiring.onSessionAdopted,
      );
      if (activity !== undefined) {
        activityTimers.push(
          setInterval(readActivity, ACTIVITY_POLL_INTERVAL_MS),
          setInterval(wiring.onHeartbeatTick, ACTIVITY_HEARTBEAT_INTERVAL_MS),
        );
      }
      return { command: launch.command, args: launch.args };
    },
    spawnPty: (child, options) => {
      pty = nodePty.spawn(child.command, child.args, {
        name: process.env.TERM ?? "xterm-256color",
        cols: options.cols,
        rows: options.rows,
        cwd: options.cwd,
        env: options.env,
      });
      return pty;
    },
    tick: discover,
    tickIntervalMs: SESSION_DISCOVERY_INTERVAL_MS,
    onSocketReady: () => {
      ownsSocket = true;
    },
    onSocketClosed: () => {
      ownsSocket = false;
    },
    checkTerminal: () => checkNativeTerminal({ baseUrl, threadId }),
  });
  for (const timer of activityTimers) clearInterval(timer);
  await discover();
  readActivity();
  finishActivity();
  await Promise.race([
    Promise.all([reporter.settled(), wiring.settled()]),
    new Promise((resolve) => setTimeout(resolve, ACTIVITY_FLUSH_TIMEOUT_MS)),
  ]);
  if (hookSpoolDirectory !== null) removeHookSpool(hookSpoolDirectory);
  return exitCode;
}

export function registerNativeCommands(
  parent: Command,
  getUrl: () => string,
): void {
  parent
    .command("native [threadId]")
    .description(
      "Open a thread's native terminal, resuming its provider CLI session when it has exited. --convert moves a claude-code or codex chat thread to its terminal on the same session; --chat moves it back",
    )
    .option("--self", "Target the current thread (BB_THREAD_ID)")
    .option(
      "--convert",
      "Move a chat thread to its native terminal: stops its running turn and resumes the same session in claude or codex",
    )
    .option(
      "--chat",
      "Move a converted thread back to chat: closes its terminal and lets bb continue the same session",
    )
    .option("--attach", "Attach this terminal to the native session")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(
        async (threadIdArg: string | undefined, opts: NativeOpenOptions) => {
          const threadId = requireThreadIdOrSelf(threadIdArg, {
            self: opts.self === true,
          });
          if (opts.chat && (opts.convert || opts.attach)) {
            throw new CliExitError(
              "--chat cannot be combined with --convert or --attach",
              1,
            );
          }
          const sdk = createCliBbSdk(getUrl());
          if (opts.chat) {
            const result = await sdk.nativeTerminals.switchMode({
              threadId,
              mode: "chat",
            });
            if (outputJson(opts, result)) return;
            console.log(`Thread ${threadId} is back in chat`);
            return;
          }
          const columns = process.stdout.columns;
          const rows = process.stdout.rows;
          const view = opts.convert
            ? await sdk.nativeTerminals.switchMode({
                threadId,
                mode: "terminal",
              })
            : await sdk.nativeTerminals.open({
                threadId,
                ...(columns ? { cols: columns } : {}),
                ...(rows ? { rows } : {}),
              });
          if (view === null) {
            throw new CliExitError("The native terminal did not open", 1);
          }
          if (outputJson(opts, view)) return;
          if (opts.attach) {
            if (view.terminal === null) {
              throw new CliExitError("The native terminal did not open", 1);
            }
            await attachTerminal({
              baseUrl: getUrl(),
              terminalId: view.terminal.id,
            });
            return;
          }
          console.log(describeNativeThread(view));
        },
      ),
    );

  parent
    .command("native-run <threadId>", { hidden: true })
    .description(
      "Run a native thread's provider CLI in this terminal (bb launches this inside the thread's terminal)",
    )
    .option("--probe", "Exit successfully without running anything")
    .option(
      "--reattach",
      "Only attach to the thread's CLI if it is still running; never start it",
    )
    .option("--json", "Print the probe result as JSON")
    .action(
      action(async (threadId: string, opts: NativeRunOptions) => {
        if (opts.probe) {
          if (opts.json) console.log(JSON.stringify({ supported: true }));
          return;
        }
        process.exitCode = await runNativeHarness(
          getUrl(),
          threadId,
          opts.reattach === true,
        );
      }),
    );

  parent
    .command("native-mcp <threadId>", { hidden: true })
    .description(
      "Serve a native thread's bb tools to its provider CLI over stdio MCP (native-run passes this to the CLI)",
    )
    .option(
      "--server-url <url>",
      "bb server to serve the tools from; the provider CLI starts this command without bb's environment",
    )
    .requiredOption(
      "--credential-socket <path>",
      "Unix socket (mode 0600) on which the native terminal holder serves the terminal's tool credential",
    )
    .action(
      action(async (threadId: string, opts: NativeMcpOptions) => {
        const sdk = createNodeBbSdk({
          baseUrl: opts.serverUrl ?? getUrl(),
          fetch: withSocketCredential(cliFetch, opts.credentialSocket),
        });
        await runNativeMcpServer(
          {
            listTools: async () =>
              (await sdk.nativeTerminals.agentTools({ threadId })).tools,
            callTool: (call) =>
              sdk.nativeTerminals.callAgentTool({
                threadId,
                tool: call.tool,
                callId: call.callId,
                arguments: call.arguments,
                signal: call.signal,
              }),
          },
          { input: process.stdin, output: process.stdout },
        );
      }),
    );

  parent
    .command("native-hold <threadId>", { hidden: true })
    .description(
      "Hold a native thread's provider CLI in a detached terminal that outlives the bb terminal and host daemon (native-run starts this)",
    )
    .requiredOption(
      "--socket <path>",
      "Unix socket the native terminal attaches through",
    )
    .option("--json", "Print the provider CLI's exit code as JSON when it ends")
    .action(
      action(async (threadId: string, opts: NativeHoldOptions) => {
        const exitCode = await holdNativeHarness(
          getUrl(),
          threadId,
          opts.socket,
        );
        removeEmptyNativeHolderLog(opts.socket);
        if (opts.json) console.log(JSON.stringify({ exitCode }));
        process.exitCode = exitCode;
      }),
    );
}
