import { spawn } from "node:child_process";
import { Command } from "commander";
import type { NativeTerminalThread } from "@bb/server-contract";
import { action, CliExitError } from "../../action.js";
import { createCliBbSdk } from "../../client.js";
import { requireThreadIdOrSelf } from "../../context-env.js";
import {
  findNativeSession,
  resolveNativeHarnessLaunch,
} from "../../native-harness.js";
import { outputJson } from "../helpers.js";
import { attachTerminal } from "../terminal.js";

const SESSION_DISCOVERY_INTERVAL_MS = 2_000;
const FORWARDED_SIGNALS = ["SIGTERM", "SIGHUP"] as const;
const SWALLOWED_SIGNALS = ["SIGINT", "SIGQUIT"] as const;

interface NativeOpenOptions {
  attach?: boolean;
  json?: boolean;
  self?: boolean;
}

interface NativeRunOptions {
  json?: boolean;
  probe?: boolean;
}

function describeNativeThread(view: NativeTerminalThread): string {
  const terminal =
    view.terminal === null
      ? "no terminal"
      : `terminal ${view.terminal.id} (${view.terminal.status})`;
  const session = view.nativeSessionId ?? "not yet known";
  return `${view.displayName} session ${session}, ${terminal}`;
}

async function runNativeHarness(
  baseUrl: string,
  threadId: string,
): Promise<number> {
  const sdk = createCliBbSdk(baseUrl);
  const spec = await sdk.nativeTerminals.launch({ threadId });
  const launch = resolveNativeHarnessLaunch(spec, process.env);
  const cwd = process.cwd();
  const launchedAtMs = Date.now();
  const child = spawn(launch.command, launch.args, {
    cwd,
    env: process.env,
    stdio: "inherit",
  });
  for (const signal of SWALLOWED_SIGNALS) process.on(signal, () => {});
  for (const signal of FORWARDED_SIGNALS) {
    process.on(signal, () => {
      child.kill(signal);
    });
  }

  let recorded = !launch.discoverSession;
  const discover = async (): Promise<void> => {
    if (recorded) return;
    let match: ReturnType<typeof findNativeSession>;
    try {
      match = findNativeSession({
        cli: spec.cli,
        cwd,
        env: process.env,
        launchedAtMs,
        nowMs: Date.now(),
      });
    } catch {
      return;
    }
    if (match.kind !== "unique") return;
    recorded = true;
    try {
      await sdk.nativeTerminals.recordSession({
        threadId,
        nativeSessionId: match.sessionId,
      });
    } catch {
      recorded = false;
    }
  };
  const timer = launch.discoverSession
    ? setInterval(() => {
        discover().catch(() => undefined);
      }, SESSION_DISCOVERY_INTERVAL_MS)
    : null;

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      resolve(code ?? (signal === null ? 1 : 128));
    });
  });
  if (timer !== null) clearInterval(timer);
  await discover();
  return exitCode;
}

export function registerNativeCommands(
  parent: Command,
  getUrl: () => string,
): void {
  parent
    .command("native [threadId]")
    .description(
      "Open the native terminal of a thread created with `bb thread spawn --native`, resuming its native CLI session when it has exited",
    )
    .option("--self", "Target the current thread (BB_THREAD_ID)")
    .option("--attach", "Attach this terminal to the native session")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(
        async (threadIdArg: string | undefined, opts: NativeOpenOptions) => {
          const threadId = requireThreadIdOrSelf(threadIdArg, {
            self: opts.self === true,
          });
          const columns = process.stdout.columns;
          const rows = process.stdout.rows;
          const view = await createCliBbSdk(getUrl()).nativeTerminals.open({
            threadId,
            ...(columns ? { cols: columns } : {}),
            ...(rows ? { rows } : {}),
          });
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
    .option("--json", "Print the probe result as JSON")
    .action(
      action(async (threadId: string, opts: NativeRunOptions) => {
        if (opts.probe) {
          if (opts.json) console.log(JSON.stringify({ supported: true }));
          return;
        }
        process.exitCode = await runNativeHarness(getUrl(), threadId);
      }),
    );
}
