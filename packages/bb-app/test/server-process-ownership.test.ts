import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DESKTOP_OWNED_RUNTIME_SHUTDOWN_GRACE_MS,
  SERVER_SHUTDOWN_BOUND_MS,
  SERVER_SHUTDOWN_SAFETY_MARGIN_MS,
} from "@bb/config/full-stack-shutdown";
import { afterEach, describe, expect, it } from "vitest";

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const launcherEntry = join(fixtureDir, "orphan-launcher.mjs");
const serverEntry = join(fixtureDir, "orphan-server.mjs");
const shutdownLauncherEntry = join(fixtureDir, "sigterm-launcher.mjs");
const slowChildEntry = join(fixtureDir, "slow-stop-child.mjs");
const realServerEntry = join(fixtureDir, "real-server-entry.mjs");
const realLauncherEntry = join(fixtureDir, "real-server-launcher.mjs");
const pluginTimeoutLauncherEntry = join(fixtureDir, "plugin-timeout-launcher.mjs");
const seedPluginDatabaseEntry = join(fixtureDir, "seed-plugin-database.mjs");
const startupStallLauncherEntry = join(fixtureDir, "startup-stall-launcher.mjs");
const liveDisconnectLauncherEntry = join(fixtureDir, "disconnect-live-launcher.mjs");
const pluginStopTimeoutEntry = join(fixtureDir, "plugin-stop-timeout.mjs");
const detachedHolderEntry = join(fixtureDir, "detached-holder.mjs");
const reportLauncherEntry = join(fixtureDir, "report-stuck-child.mjs");
const disconnectQueueEntry = join(fixtureDir, "launcher-disconnect-queue.mjs");
const scratchDirs: string[] = [];
const activeChildren = new Set<number>();
const childErrors = new WeakMap<ChildProcess, { stderr: string }>();

afterEach(() => {
  for (const pid of activeChildren) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
  activeChildren.clear();
  for (const dir of scratchDirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function scratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "bb-server-ownership-"));
  scratchDirs.push(dir);
  return dir;
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("Missing test port");
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

function spawnFixture(
  entry: string,
  env: NodeJS.ProcessEnv,
  ipc = false,
): ChildProcess {
  const child = spawn(
    process.execPath,
    ["--conditions=source", "--import", "tsx", entry],
    {
      cwd: process.cwd(),
      env: { ...process.env, ...env },
      stdio: ipc ? ["ignore", "pipe", "pipe", "ipc"] : ["ignore", "pipe", "pipe"],
    },
  );
  const captured = { stderr: "" };
  child.stdout?.on("data", (chunk: Buffer) => { captured.stderr += chunk.toString(); });
  child.stderr?.on("data", (chunk: Buffer) => {
    captured.stderr += chunk.toString();
  });
  childErrors.set(child, captured);
  if (child.pid !== undefined) activeChildren.add(child.pid);
  return child;
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    if (child.pid !== undefined) activeChildren.delete(child.pid);
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Process did not exit within ${timeoutMs}ms`)),
      timeoutMs,
    );
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", () => {
      clearTimeout(timer);
      if (child.pid !== undefined) activeChildren.delete(child.pid);
      resolve();
    });
  });
}

async function waitForFile(path: string, timeoutMs = 5_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return readFileSync(path, "utf8");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${path}`);
}

async function waitForText(
  child: ChildProcess,
  path: string,
  text: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path) && readFileSync(path, "utf8").includes(text)) return;
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `Launcher exited before ${text}: ${childErrors.get(child)?.stderr ?? ""}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(
    `Timed out waiting for ${text}: ${childErrors.get(child)?.stderr ?? ""}`,
  );
}

async function waitForFileText(
  path: string,
  text: string,
  timeoutMs = 10_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      const contents = readFileSync(path, "utf8");
      if (contents.includes(text)) return contents;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${text} in ${path}`);
}

function isProcessRunning(pid: number): boolean {
  try {
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      if (stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) === "Z") {
        return false;
      }
    }
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessExitByPid(
  pid: number,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessRunning(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Process ${pid} did not exit within ${timeoutMs}ms`);
}

describe("server process ownership", () => {
  it("resolves when a child has already exited", async () => {
    const child = spawn(process.execPath, ["-e", "process.exit(0)"], {
      stdio: "ignore",
    });
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", () => resolve());
    });
    await waitForExit(child, 100);
  });

  it("ignores IPC disconnect while its launcher parent is alive", async () => {
    const dir = scratchDir();
    const marker = join(dir, "disconnect.log");
    const child = spawnFixture(disconnectQueueEntry, {
      BB_DISCONNECT_MARKER: marker,
    });
    await waitForExit(child, 5_000);
    expect(readFileSync(marker, "utf8")).toContain("reason ipc-disconnect-parent-alive");
    expect(readFileSync(marker, "utf8")).toContain("alive\n");
    expect(readFileSync(marker, "utf8")).not.toContain("shutdown\n");
  });

  it.each(["standalone", "desktop"] as const)("runs production shutdown on parent loss and releases its database and port (%s)", async (surface) => {
    const dir = scratchDir();
    const port = await freePort();
    const ready = join(dir, "ready");
    const agentPidFile = join(dir, "agent.pid");
    const holderPidFile = join(dir, "holder.pid");
    const launcher = spawnFixture(realLauncherEntry, {
      BB_OWNERSHIP_DIR: dir, BB_ORPHAN_READY: ready,
      BB_SERVER_PID_FILE: join(dir, "server.pid"),
      BB_AGENT_ENTRY: detachedHolderEntry,
      BB_AGENT_PID_FILE: agentPidFile,
      BB_AGENT_READY: join(dir, "agent.ready"),
      BB_HOLDER_ENTRY: detachedHolderEntry,
      BB_HOLDER_PID_FILE: holderPidFile,
      BB_NATIVE_HOLDER_READY: join(dir, "native-holder.ready"),
      BB_RUN_SHUTDOWN_MARKER: join(dir, "run-shutdown.log"),
      BB_REAL_LAUNCHER_PID: join(dir, "launcher.pid"),
      BB_REAL_SERVER_ENTRY: realServerEntry, BB_SERVER_PORT: String(port),
      ...(surface === "desktop" ? { BB_OWNERSHIP_DESKTOP: "1" } : {}),
    }, surface === "desktop");
    let serverPid: number | null = null;
    let agentPid: number | null = null;
    let holderPid: number | null = null;
    try {
      await waitForFile(join(dir, "server.pid"), 45_000);
      const deadline = Date.now() + 45_000;
      while (Date.now() < deadline) {
        try { await fetch(`http://127.0.0.1:${port}/`); break; }
        catch { await new Promise((resolve) => setTimeout(resolve, 50)); }
      }
      expect(await fetch(`http://127.0.0.1:${port}/`).then(() => true)).toBe(true);
      serverPid = Number((await waitForFile(join(dir, "server.pid"), 1_000)).trim());
      activeChildren.add(serverPid);
      agentPid = Number(await waitForFile(agentPidFile));
      activeChildren.add(agentPid);
      holderPid = Number(await waitForFile(holderPidFile));
      activeChildren.add(holderPid);
      await waitForFile(join(dir, "agent.ready"));
      await waitForFile(join(dir, "native-holder.ready"));
      process.kill(launcher.pid!, "SIGKILL");
      await waitForExit(launcher, 2_000);
      await waitForProcessExitByPid(serverPid, 10_000);
      activeChildren.delete(serverPid);
      const shutdownLog = readFileSync(
        join(dir, "run-shutdown.log"),
        "utf8",
      );
      expect(shutdownLog).toContain("server-close");
      expect(isProcessRunning(agentPid)).toBe(true);
      expect(isProcessRunning(holderPid)).toBe(true);
      const Database = createRequire(import.meta.url)("better-sqlite3");
      const db = new Database(join(dir, "bb.db"));
      db.close();
      await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow();
    } finally {
      if (serverPid !== null && activeChildren.has(serverPid)) {
        try { process.kill(serverPid, "SIGKILL"); } catch {}
        activeChildren.delete(serverPid);
      }
      for (const pid of [agentPid, holderPid]) {
        if (pid === null || !activeChildren.has(pid)) continue;
        try { process.kill(pid, "SIGKILL"); } catch {}
        activeChildren.delete(pid);
      }
    }
  }, 120_000);

  it.each(
    (["standalone", "desktop"] as const).flatMap((surface) =>
      (["during-startup", "after-startup"] as const).map(
        (mode) => [surface, mode] as const,
      ),
    ),
  )(
    "keeps a %s server alive when IPC disconnects while its launcher remains alive %s",
    async (surface, mode) => {
      const dir = scratchDir();
      const port = await freePort();
      const disconnectReady = join(dir, "disconnected");
      const releaseLauncher = join(dir, "release-launcher");
      const serverPidFile = join(dir, "server.pid");
      let lockDb: { exec(sql: string): unknown; close(): void } | undefined;
      if (mode === "during-startup") {
        const Database = createRequire(import.meta.url)("better-sqlite3");
        const setup = new Database(join(dir, "bb.db"));
        setup.pragma("journal_mode = WAL");
        setup.exec("CREATE TABLE IF NOT EXISTS startup_disconnect_probe (value INTEGER)");
        setup.close();
        const startupLock = new Database(join(dir, "bb.db")) as { exec(sql: string): unknown; close(): void };
        lockDb = startupLock;
        startupLock.exec("BEGIN IMMEDIATE");
      }
      const launcher = spawnFixture(liveDisconnectLauncherEntry, {
        BB_OWNERSHIP_DIR: dir,
        BB_DISCONNECT_MODE: mode === "after-startup" ? "after-ready" : "during-startup",
        BB_DISCONNECT_READY_FILE: disconnectReady,
        BB_LAUNCHER_RELEASE_FILE: releaseLauncher,
        BB_ORPHAN_READY: join(dir, "server-ready"),
        BB_SERVER_PID_FILE: serverPidFile,
        BB_RUN_SHUTDOWN_MARKER: join(dir, "run-shutdown.log"),
        BB_REAL_SERVER_ENTRY: realServerEntry,
        BB_SERVER_PORT: String(port),
        ...(surface === "desktop" ? { BB_OWNERSHIP_DESKTOP: "1" } : {}),
      }, surface === "desktop");
      let serverPid: number | null = null;
      try {
        serverPid = Number(await waitForFile(serverPidFile, 45_000));
        activeChildren.add(serverPid);
        if (mode === "during-startup") {
          const deadline = Date.now() + 10_000;
          let databaseFdFound = false;
          while (Date.now() < deadline && !databaseFdFound) {
            try {
              databaseFdFound = readdirSync(`/proc/${serverPid}/fd`).some((fd) =>
                readlinkSync(`/proc/${serverPid}/fd/${fd}`).startsWith(join(dir, "bb.db")),
              );
            } catch {}
            if (!databaseFdFound) await new Promise((resolve) => setTimeout(resolve, 10));
          }
          expect(databaseFdFound).toBe(true);
        }
        await waitForFile(disconnectReady, 45_000);
        await new Promise((resolve) => setTimeout(resolve, SERVER_SHUTDOWN_BOUND_MS + SERVER_SHUTDOWN_SAFETY_MARGIN_MS));
        expect(isProcessRunning(serverPid)).toBe(true);
        if (mode === "during-startup") {
          if (lockDb === undefined) throw new Error("Startup database lock is missing");
          lockDb.exec("ROLLBACK");
          const healthDeadline = Date.now() + 45_000;
          while (Date.now() < healthDeadline) {
            try {
              const response = await fetch(`http://127.0.0.1:${port}/`);
              if (response.ok) break;
            } catch {}
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
        }
        expect(await fetch(`http://127.0.0.1:${port}/`).then((response) => response.status)).toBe(200);
        await new Promise((resolve) => setTimeout(resolve, SERVER_SHUTDOWN_BOUND_MS + SERVER_SHUTDOWN_SAFETY_MARGIN_MS));
        expect(await fetch(`http://127.0.0.1:${port}/`).then((response) => response.status)).toBe(200);
        writeFileSync(releaseLauncher, "exit");
        await waitForExit(launcher, 5_000);
        await waitForProcessExitByPid(serverPid, SERVER_SHUTDOWN_BOUND_MS + SERVER_SHUTDOWN_SAFETY_MARGIN_MS);
        activeChildren.delete(serverPid);
        expect(readFileSync(join(dir, "run-shutdown.log"), "utf8")).toContain("server-close");
        await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow();
      } finally {
        try { lockDb?.exec("ROLLBACK"); } catch {}
        lockDb?.close();
        if (serverPid !== null && activeChildren.has(serverPid)) {
          try { process.kill(serverPid, "SIGKILL"); } catch {}
          activeChildren.delete(serverPid);
        }
        if (launcher.exitCode === null && launcher.signalCode === null) {
          try { process.kill(launcher.pid!, "SIGKILL"); } catch {}
        }
      }
    },
    120_000,
  );

  it("exits within the shared bound when the launcher dies during database startup", async () => {
    if (process.platform !== "linux") return;
    const dir = scratchDir();
    const databasePath = join(dir, "bb.db");
    const Database = createRequire(import.meta.url)("better-sqlite3");
    const setupDb = new Database(databasePath);
    setupDb.pragma("auto_vacuum = INCREMENTAL");
    setupDb.pragma("journal_mode = WAL");
    setupDb.exec("CREATE TABLE startup_deadline_probe (value INTEGER)");
    setupDb.close();
    const lockDb = new Database(databasePath);
    lockDb.exec("BEGIN IMMEDIATE");
    const serverPidFile = join(dir, "server.pid");
    const launcher = spawnFixture(startupStallLauncherEntry, {
      BB_OWNERSHIP_DIR: dir,
      BB_ORPHAN_READY: join(dir, "server-started"),
      BB_SERVER_PID_FILE: serverPidFile,
      BB_REAL_SERVER_ENTRY: realServerEntry,
      BB_SERVER_PORT: String(await freePort()),
    });
    let serverPid: number | null = null;
    try {
      serverPid = Number(await waitForFile(serverPidFile));
      activeChildren.add(serverPid);
      const openDatabaseDeadline = Date.now() + 10_000;
      let databaseFdFound = false;
      while (Date.now() < openDatabaseDeadline) {
        if (!isProcessRunning(serverPid)) break;
        try {
          databaseFdFound = readdirSync(`/proc/${serverPid}/fd`).some((fd) =>
            readlinkSync(`/proc/${serverPid}/fd/${fd}`).startsWith(databasePath),
          );
        } catch {}
        if (databaseFdFound) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      let descriptors = "unavailable";
      try {
        descriptors = readdirSync(`/proc/${serverPid}/fd`).map((fd) => {
          try { return readlinkSync(`/proc/${serverPid}/fd/${fd}`); } catch { return "unreadable"; }
        }).join(", ");
      } catch {}
      let serverOutput = "";
      try { serverOutput = readFileSync(join(dir, "logs", "server-stdio.log"), "utf8"); } catch {}
      expect(
        databaseFdFound,
        `server db descriptors: ${descriptors}; server output: ${serverOutput}; launcher output: ${childErrors.get(launcher)?.stderr ?? ""}`,
      ).toBe(true);
      expect(isProcessRunning(serverPid)).toBe(true);
      const killedAt = Date.now();
      process.kill(launcher.pid!, "SIGKILL");
      await waitForExit(launcher, 2_000);
      let statAfterLauncherExit = "unavailable";
      try { statAfterLauncherExit = readFileSync(`/proc/${serverPid}/stat`, "utf8"); } catch {}
      try {
        await waitForProcessExitByPid(serverPid, SERVER_SHUTDOWN_BOUND_MS);
      } catch (error) {
        let serverOutput = "";
        try {
          serverOutput = readFileSync(
            join(dir, "logs", "server-stdio.log"),
            "utf8",
          );
        } catch {}
        try {
          serverOutput += readdirSync(join(dir, "logs"))
            .map(
              (file) =>
                `${file}: ${readFileSync(join(dir, "logs", file), "utf8")}`,
            )
            .join("\n");
        } catch {}
        try {
          serverOutput += ` server stat: ${readFileSync(`/proc/${serverPid}/stat`, "utf8")}`;
        } catch {}
        serverOutput += ` stat after launcher exit: ${statAfterLauncherExit}`;
        throw new Error(`${String(error)}; server output: ${serverOutput}`);
      }
      activeChildren.delete(serverPid);
      expect(Date.now() - killedAt).toBeLessThanOrEqual(SERVER_SHUTDOWN_BOUND_MS);
      lockDb.exec("ROLLBACK");
      lockDb.prepare("INSERT INTO startup_deadline_probe (value) VALUES (1)").run();
      expect(lockDb.prepare("SELECT value FROM startup_deadline_probe").get()).toEqual({ value: 1 });
    } finally {
      try { lockDb.exec("ROLLBACK"); } catch {}
      lockDb.close();
      if (serverPid !== null && activeChildren.has(serverPid)) {
        try { process.kill(serverPid, "SIGKILL"); } catch {}
        activeChildren.delete(serverPid);
      }
    }
  }, 30_000);

  it("exits after plugin timeout without closing its migrated database", async () => {
    const dir = scratchDir();
    const resultPath = join(dir, "plugin-timeout.json");
    const child = spawnFixture(pluginStopTimeoutEntry, {
      BB_PLUGIN_TIMEOUT_RESULT: resultPath,
    });
    await waitForExit(
      child,
      DESKTOP_OWNED_RUNTIME_SHUTDOWN_GRACE_MS,
    );
    expect(child.exitCode, childErrors.get(child)?.stderr ?? "").toBe(0);
    const result = JSON.parse(readFileSync(resultPath, "utf8")) as {
      completedWithinBounds: boolean;
      databaseClosed: boolean;
      dbReadable: boolean;
      elapsedMs: number;
      pluginObservedDatabaseError: boolean;
      pluginStopTimedOut: boolean;
      shutdownBoundMs: number;
    };
    expect(result.pluginObservedDatabaseError, "plugin database read failed after shutdown began").toBe(false);
    expect(result.completedWithinBounds).toBe(false);
    expect(result.pluginStopTimedOut).toBe(true);
    expect(result.databaseClosed).toBe(false);
    expect(result.dbReadable).toBe(true);
    expect(result.pluginObservedDatabaseError).toBe(false);
    expect(result.elapsedMs).toBeLessThanOrEqual(result.shutdownBoundMs);
  }, 15_000);

  it("keeps the production database open when a real plugin does not stop", async () => {
    const dir = scratchDir();
    const port = await freePort();
    const databasePath = join(dir, "bb.db");
    const pluginDir = join(dir, "plugins", "stuck-dispose");
    const pluginReady = join(dir, "plugin-ready");
    const pluginStopping = join(dir, "plugin-stopping");
    const dbCloseMarker = join(dir, "database-closed");
    const httpShutdownMarker = join(dir, "http-shutdown.log");
    const serverPidFile = join(dir, "server.pid");
    execFileSync(
      process.execPath,
      ["--conditions=source", "--import", "tsx", seedPluginDatabaseEntry, databasePath, pluginDir],
      { cwd: process.cwd(), stdio: "pipe" },
    );
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(
      join(pluginDir, "package.json"),
      JSON.stringify({
        name: "bb-plugin-stuck-dispose",
        version: "0.1.0",
        bb: {
          name: "Stuck dispose fixture",
          description: "A plugin whose cleanup does not finish.",
          branding: { icon: "Zap" },
          server: "./server.ts",
        },
      }),
    );
    writeFileSync(
      join(pluginDir, "server.ts"),
      `import { writeFileSync } from "node:fs";\nexport default function plugin(bb: any) {\n  writeFileSync(${JSON.stringify(pluginReady)}, "ready");\n  bb.onDispose(() => {\n    writeFileSync(${JSON.stringify(pluginStopping)}, "started");\n    return new Promise<void>(() => {});\n  });\n}`,
    );
    const launcher = spawnFixture(pluginTimeoutLauncherEntry, {
      BB_DATA_DIR: dir,
      BB_ORPHAN_READY: join(dir, "server-starting"),
      BB_RUN_SHUTDOWN_MARKER: httpShutdownMarker,
      BB_REAL_SERVER_ENTRY: realServerEntry,
      BB_SERVER_PID_FILE: serverPidFile,
      BB_SERVER_CHILD_OUTPUT: join(dir, "server-output.log"),
      BB_SERVER_BIND_HOST: "127.0.0.1",
      BB_SERVER_PORT: String(port),
      BB_HOST_DAEMON_PORT: String(port + 1),
      BB_TELEMETRY: "false",
      NODE_ENV: "test",
      P7_DB_PATH: databasePath,
      P7_DB_CLOSE_MARKER: dbCloseMarker,
    });
    let serverPid: number | null = null;
    let serverExited = false;
    try {
      try {
        serverPid = Number(await waitForFile(serverPidFile, 45_000));
      } catch (error) {
        const outputPath = join(dir, "server-output.log");
        throw new Error(
          `${String(error)}; server output: ${existsSync(outputPath) ? readFileSync(outputPath, "utf8") : "none"}; launcher output: ${childErrors.get(launcher)?.stderr ?? "none"}`,
        );
      }
      activeChildren.add(serverPid);
      const healthDeadline = Date.now() + 45_000;
      while (Date.now() < healthDeadline) {
        if (!isProcessRunning(serverPid)) {
          const serverOutputPath = join(dir, "server-output.log");
          const serverOutput = existsSync(serverOutputPath)
            ? readFileSync(serverOutputPath, "utf8")
            : "no server output captured";
          throw new Error(
            `Server ${serverPid} exited before becoming healthy: ${serverOutput}`,
          );
        }
        try {
          const response = await fetch(`http://127.0.0.1:${port}/`);
          if (response.status === 200) break;
        } catch {}
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(await fetch(`http://127.0.0.1:${port}/`).then((response) => response.status)).toBe(200);
      try {
        await waitForFile(pluginReady, 10_000);
      } catch (error) {
        const outputPath = join(dir, "server-output.log");
        throw new Error(
          `${String(error)}; server output: ${existsSync(outputPath) ? readFileSync(outputPath, "utf8") : "none"}`,
        );
      }
      const startedAt = Date.now();
      process.kill(serverPid, "SIGTERM");
      try {
        await waitForFile(pluginStopping, SERVER_SHUTDOWN_BOUND_MS);
      } catch (error) {
        const outputPath = join(dir, "server-output.log");
        throw new Error(
          `${String(error)}; server output: ${existsSync(outputPath) ? readFileSync(outputPath, "utf8") : "none"}`,
        );
      }
      await waitForProcessExitByPid(serverPid, SERVER_SHUTDOWN_BOUND_MS + 1_000);
      serverExited = true;
      await waitForExit(launcher, 2_000);
      expect(Date.now() - startedAt).toBeLessThanOrEqual(
        SERVER_SHUTDOWN_BOUND_MS + 1_000,
      );
      expect(readFileSync(httpShutdownMarker, "utf8")).toContain("server-close");
      expect(existsSync(dbCloseMarker), "production runShutdown closed bb.db").toBe(false);
      const Database = createRequire(
        join(dirname(fileURLToPath(import.meta.url)), "../../db/package.json"),
      )("better-sqlite3");
      const reopenedDb = new Database(databasePath);
      try {
        reopenedDb.exec("CREATE TABLE shutdown_reopen_probe (value INTEGER)");
        expect(reopenedDb.prepare("SELECT count(*) AS count FROM shutdown_reopen_probe").get()).toEqual({ count: 0 });
      } finally {
        reopenedDb.close();
      }
    } finally {
      if (!serverExited && serverPid !== null && activeChildren.has(serverPid)) {
        try { process.kill(serverPid, "SIGKILL"); } catch {}
        activeChildren.delete(serverPid);
      }
      if (launcher.exitCode === null && launcher.signalCode === null) {
        try { process.kill(launcher.pid!, "SIGKILL"); } catch {}
        await waitForExit(launcher, 2_000).catch(() => undefined);
      }
    }
  }, 60_000);

  it("keeps a standalone server alive without an IPC parent channel", async () => {
    const dir = scratchDir();
    const port = await freePort();
    const server = spawn(process.execPath, ["--conditions=source", "--import", "tsx", realServerEntry], {
      cwd: process.cwd(),
      env: { ...process.env, BB_DATA_DIR: dir, BB_ORPHAN_READY: join(dir, "ready"), BB_SERVER_PID_FILE: join(dir, "server.pid"), BB_SERVER_BIND_HOST: "127.0.0.1", BB_SERVER_PORT: String(port), BB_HOST_DAEMON_PORT: String(port + 1), BB_TELEMETRY: "false", NODE_ENV: "test" },
      stdio: "ignore",
    });
    if (server.pid !== undefined) activeChildren.add(server.pid);
    try {
      await waitForFile(join(dir, "server.pid"), 45_000);
      const deadline = Date.now() + 45_000;
      while (Date.now() < deadline) {
        if (server.exitCode !== null || server.signalCode !== null) {
          throw new Error(
            `Standalone server exited before health: ${String(server.exitCode)} ${String(server.signalCode)}`,
          );
        }
        try {
          const response = await fetch(`http://127.0.0.1:${port}/`);
          if (response.ok) break;
        } catch {}
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(server.exitCode).toBeNull();
      expect(await fetch(`http://127.0.0.1:${port}/`).then((response) => response.status)).toBe(200);
    } finally {
      if (server.pid !== undefined) {
        try { process.kill(server.pid, "SIGTERM"); } catch {}
        await waitForExit(server, 8_000).catch(() => undefined);
        activeChildren.delete(server.pid);
      }
    }
  }, 120_000);
  it("runs normal server shutdown when its launcher is SIGKILLed", async () => {
    const dir = scratchDir();
    const port = await freePort();
    const pidFile = join(dir, "server.pid");
    const marker = join(dir, "shutdown.log");
    const launcherReady = join(dir, "launcher.pid");
    const launcher = spawnFixture(launcherEntry, {
      BB_HOLDER_ENTRY: detachedHolderEntry,
      BB_HOLDER_PID_FILE: join(dir, "holder.pid"),
      BB_HOLDER_READY: join(dir, "holder.ready"),
      BB_ORPHAN_DIR: dir,
      BB_ORPHAN_LAUNCHER_READY: launcherReady,
      BB_ORPHAN_MARKER: marker,
      BB_ORPHAN_PID_FILE: pidFile,
      BB_ORPHAN_SERVER_ENTRY: serverEntry,
      BB_SERVER_PORT: String(port),
    });
    let serverPid: number | null = null;
    let serverExited = false;
    try {
      await waitForFile(launcherReady);
      const holderPid = Number(await waitForFile(join(dir, "holder.pid")));
      activeChildren.add(holderPid);
      serverPid = Number(await waitForFile(pidFile));
      activeChildren.add(serverPid);
      process.kill(launcher.pid!, "SIGKILL");
      await waitForExit(launcher, 2_000);
      await waitForProcessExitByPid(serverPid, 10_000);
      serverExited = true;
      const shutdown = await waitForFileText(
        marker,
        "shutdown-finished",
        1_000,
      );
      expect(shutdown).toBe("shutdown-started\nshutdown-finished\n");
      expect(isProcessRunning(holderPid)).toBe(true);
      if (serverPid !== null) activeChildren.delete(serverPid);
    } finally {
      if (
        serverPid !== null &&
        !serverExited &&
        activeChildren.has(serverPid)
      ) {
        try {
          process.kill(serverPid, "SIGKILL");
        } catch {}
        activeChildren.delete(serverPid);
      }
    }
  });

  it("reports a managed child that survives SIGKILL", async () => {
    const dir = scratchDir();
    const launcher = spawnFixture(reportLauncherEntry, {
      BB_SHUTDOWN_CHILD_ENTRY: slowChildEntry,
      BB_SHUTDOWN_LOG_DIR: join(dir, "logs"),
      BB_SHUTDOWN_MARKER: join(dir, "child.log"),
      BB_REPORT_PID_FILE: join(dir, "server.pid"),
    });
    let serverPid: number | null = null;
    try {
      serverPid = Number(await waitForFile(join(dir, "server.pid"), 10_000));
      activeChildren.add(serverPid);
      await waitForExit(launcher, 8_000);
      expect(childErrors.get(launcher)?.stderr).toContain(
        "server did not stop after SIGKILL within",
      );
      expect(isProcessRunning(serverPid)).toBe(true);
    } finally {
      if (serverPid !== null) {
        try { process.kill(serverPid, "SIGKILL"); } catch {}
        activeChildren.delete(serverPid);
      }
    }
  });

  it("finishes the launcher SIGTERM shutdown with its server child inside desktop grace", async () => {
    const dir = scratchDir();
    const marker = join(dir, "shutdown.log");
    const launcher = spawnFixture(shutdownLauncherEntry, {
      BB_HOLDER_ENTRY: detachedHolderEntry,
      BB_HOLDER_PID_FILE: join(dir, "holder.pid"),
      BB_HOLDER_READY: join(dir, "holder.ready"),
      BB_SHUTDOWN_CHILD_ENTRY: slowChildEntry,
      BB_SHUTDOWN_LOG_DIR: join(dir, "logs"),
      BB_SHUTDOWN_MARKER: marker,
      BB_SERVER_CHILD_PID_FILE: join(dir, "server.pid"),
      BB_DAEMON_CHILD_PID_FILE: join(dir, "daemon.pid"),
    });
    try {
      await waitForText(launcher, marker, "launcher:ready");
      activeChildren.add(Number(readFileSync(join(dir, "server.pid"), "utf8")));
      activeChildren.add(Number(readFileSync(join(dir, "daemon.pid"), "utf8")));
      const holderPid = Number(readFileSync(join(dir, "holder.pid"), "utf8"));
      activeChildren.add(holderPid);
      const startedAt = Date.now();
      process.kill(launcher.pid!, "SIGTERM");
      await waitForExit(launcher, DESKTOP_OWNED_RUNTIME_SHUTDOWN_GRACE_MS);
      const elapsedMs = Date.now() - startedAt;
      expect(elapsedMs).toBeLessThan(DESKTOP_OWNED_RUNTIME_SHUTDOWN_GRACE_MS);
      const shutdown = readFileSync(marker, "utf8");
      expect(shutdown).toContain("server:stopped");
      expect(shutdown).toContain("daemon:stopped");
      expect(shutdown).toContain("launcher:stopped");
      expect(isProcessRunning(holderPid)).toBe(true);
      for (const childPidFile of [
        join(dir, "server.pid"),
        join(dir, "daemon.pid"),
      ]) {
        const pid = Number(readFileSync(childPidFile, "utf8"));
        await waitForProcessExitByPid(pid, 2_000);
        activeChildren.delete(pid);
      }
    } finally {
      for (const childPidFile of [
        join(dir, "server.pid"),
        join(dir, "daemon.pid"),
      ]) {
        if (!existsSync(childPidFile)) continue;
        const pid = Number(readFileSync(childPidFile, "utf8"));
        if (!activeChildren.has(pid)) continue;
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
        activeChildren.delete(pid);
      }
    }
  });
});
