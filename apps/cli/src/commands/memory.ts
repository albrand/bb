import { Command } from "commander";
import {
  createHostDaemonLocalClient,
  DEFAULT_HOST_DAEMON_LOCAL_BIND_HOST,
} from "@bb/host-daemon-contract";
import { loadCliConfig } from "@bb/config/cli";
import { action } from "../action.js";
import { outputJson } from "./helpers.js";

interface MemoryCommandOptions {
  json?: boolean;
}

function localHostDaemonUrl(): string {
  const config = loadCliConfig();
  return `http://${DEFAULT_HOST_DAEMON_LOCAL_BIND_HOST}:${config.BB_HOST_DAEMON_PORT}`;
}

export function registerMemoryCommands(program: Command): void {
  const memory = program
    .command("memory")
    .description("Inspect and reclaim BB-managed agent memory");

  memory
    .command("status", { isDefault: true })
    .description("Show daemon memory and managed agent lease state")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (opts: MemoryCommandOptions) => {
        const response =
          await createHostDaemonLocalClient(localHostDaemonUrl()).memory.$get();
        if (!response.ok) {
          throw new Error(
            `Host daemon memory status failed (${response.status})`,
          );
        }
        const payload = await response.json();
        if (outputJson(opts, payload)) return;
        const used = payload.totalMemoryBytes - payload.freeMemoryBytes;
        const percent =
          payload.totalMemoryBytes > 0
            ? Math.round((used / payload.totalMemoryBytes) * 100)
            : 0;
        console.log(`Host memory: ${percent}% used`);
        console.log(`Daemon RSS: ${payload.daemonRssBytes} bytes`);
        console.log(`Managed leases: ${payload.leaseCount}`);
        console.log(`Reclaimable leases: ${payload.reclaimableLeaseCount}`);
        console.log(`Protected threads: ${payload.protectedThreadCount}`);
      }),
    );

  memory
    .command("gc")
    .description("Reclaim stale, orphaned managed agent process groups")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (opts: MemoryCommandOptions) => {
        const response = await createHostDaemonLocalClient(
          localHostDaemonUrl(),
        ).memory.$post({ query: { force: "true" } });
        if (!response.ok) {
          throw new Error(`Host daemon memory GC failed (${response.status})`);
        }
        const payload = await response.json();
        if (outputJson(opts, payload)) return;
        console.log(`Reclaimed: ${payload.reclaimed.length}`);
        for (const entry of payload.reclaimed) {
          console.log(
            `  ${entry.threadId} (pid ${entry.pid}): ${entry.stopped ? "stopped" : "still running"}`,
          );
        }
        if (payload.reclaimed.length === 0) {
          console.log("No reclaimable managed agent leases found.");
        }
      }),
    );
}
