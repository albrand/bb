import { spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  chmodSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { spawnLoggedProcess } from "../src/logged-process.js";

const scratchDirs: string[] = [];

afterEach(() => {
  for (const dir of scratchDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function scratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "bb-logged-process-"));
  scratchDirs.push(dir);
  return dir;
}

function familyFiles(logDir: string, logName: string): string[] {
  return readdirSync(logDir)
    .filter(
      (name) =>
        name === `${logName}-stdio.log` ||
        name.startsWith(`${logName}-stdio.log.active-`) ||
        name.startsWith(`${logName}-stdio.log.backup-`),
    )
    .map((name) => join(logDir, name));
}

function uniqueFamilyFiles(logDir: string, logName: string): string[] {
  const seen = new Set<string>();
  return familyFiles(logDir, logName).filter((path) => {
    let stat;
    try {
      stat = statSync(path);
    } catch {
      return false;
    }
    const key = `${stat.dev}:${stat.ino}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function waitForExit(
  child: ChildProcess,
  timeoutMs = 5_000,
): Promise<number | null> {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Child stalled while writing logs"));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

describe("spawnLoggedProcess", () => {
  it.each(["server", "host-daemon"] as const)(
    "captures %s stdout and stderr bursts while draining child pipes",
    async (logName) => {
      const logDir = join(scratchDir(), "logs");
      const child = spawnLoggedProcess({
        command: process.execPath,
        args: [
          "-e",
          `
            process.stdout.write("A".repeat(2 * 1024 * 1024) + "\\n");
            process.stderr.write("B".repeat(2 * 1024 * 1024) + "\\n");
            setImmediate(() => process.stdout.write("done\\n"));
          `,
        ],
        env: process.env,
        logDir,
        logName,
      });

      expect(await waitForExit(child)).toBe(0);
      const logPath = join(logDir, `${logName}-stdio.log`);
      const output = readFileSync(logPath, "utf8");
      expect(output.split("A").length - 1).toBe(2 * 1024 * 1024);
      expect(output.split("B").length - 1).toBe(2 * 1024 * 1024);
      expect(output).toContain("done\n");
      if (process.platform !== "win32")
        expect(statSync(logPath).mode & 0o777).toBe(0o600);
    },
  );

  it("preserves output across child restarts, including early failures", async () => {
    const logDir = scratchDir();
    for (const message of ["first startup", "second startup"]) {
      const child = spawnLoggedProcess({
        command: process.execPath,
        args: [
          "-e",
          `console.error(${JSON.stringify(message)}); process.exit(1);`,
        ],
        env: process.env,
        logDir,
        logName: "server",
      });
      expect(await waitForExit(child)).toBe(1);
    }
    await expect
      .poll(
        () =>
          (() => {
            try {
              const output = uniqueFamilyFiles(logDir, "server")
                .map((path) => readFileSync(path, "utf8"))
                .join("");
              return (
                output.includes("first startup\n") &&
                output.includes("second startup\n")
              );
            } catch {
              return false;
            }
          })(),
        { timeout: 5_000 },
      )
      .toBe(true);
  });

  it("keeps a paused writer within its own segment while another writer rotates", async () => {
    const logDir = scratchDir();
    const enteredPath = join(logDir, "first-writer-before-write");
    const releasePath = join(logDir, "release-first-writer");
    const firstBytes = 9 * 1024 * 1024 + 64 * 1024;
    const secondBytes = 11 * 1024 * 1024;
    const first = spawnLoggedProcess({
      command: process.execPath,
      args: ["-e", `process.stdout.write(Buffer.alloc(${firstBytes}, 65));`],
      env: process.env,
      logDir,
      logName: "server",
      testWriterBarrier: {
        enteredPath,
        releasePath,
        pauseAtBytes: 9 * 1024 * 1024,
      },
    });
    let second: ChildProcess | undefined;
    try {
      await expect
        .poll(() => existsSync(enteredPath), { timeout: 5_000, interval: 10 })
        .toBe(true);
      second = spawnLoggedProcess({
        command: process.execPath,
        args: ["-e", `process.stdout.write(Buffer.alloc(${secondBytes}, 66));`],
        env: process.env,
        logDir,
        logName: "server",
      });
      expect(await waitForExit(second)).toBe(0);
      writeFileSync(releasePath, "release");
      expect(await waitForExit(first)).toBe(0);
      await expect
        .poll(
          () => {
            try {
              return Buffer.concat(
                uniqueFamilyFiles(logDir, "server").map((path) =>
                  readFileSync(path),
                ),
              ).length;
            } catch {
              return 0;
            }
          },
          { timeout: 5_000, interval: 10 },
        )
        .toBe(firstBytes + secondBytes);
      const files = uniqueFamilyFiles(logDir, "server");
      const backups = familyFiles(logDir, "server").filter((path) =>
        path.includes(".backup-"),
      );
      expect(backups.length).toBeLessThanOrEqual(5);
      expect(
        familyFiles(logDir, "server").every(
          (path) => statSync(path).size <= 10 * 1024 * 1024,
        ),
      ).toBe(true);
      expect(
        files.every((path) => statSync(path).size <= 10 * 1024 * 1024),
      ).toBe(true);
      const output = Buffer.concat(files.map((path) => readFileSync(path)));
      expect(
        output.length,
        JSON.stringify(
          files.map((path) => [
            path,
            statSync(path).size,
            readFileSync(path).filter((byte) => byte === 65).length,
            readFileSync(path).filter((byte) => byte === 66).length,
          ]),
        ),
      ).toBe(firstBytes + secondBytes);
      expect(output.filter((byte) => byte === 65).length).toBe(firstBytes);
      expect(output.filter((byte) => byte === 66).length).toBe(secondBytes);
      expect(
        statSync(join(logDir, "server-stdio.log")).size,
      ).toBeLessThanOrEqual(10 * 1024 * 1024);
    } finally {
      if (!existsSync(releasePath)) writeFileSync(releasePath, "release");
      if (first.exitCode === null) first.kill("SIGKILL");
      if (second?.exitCode === null) second.kill("SIGKILL");
    }
  });

  it("keeps the child alive and logging after its parent exits", async () => {
    const logDir = scratchDir();
    const markerPath = join(logDir, "child-alive");
    const launcher = spawn(
      process.execPath,
      [
        "--conditions=source",
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        `
          import { spawnLoggedProcess } from "./src/logged-process.ts";
          spawnLoggedProcess({
            command: process.execPath,
            args: ["-e", ${JSON.stringify(
              `setTimeout(() => { process.stdout.write("after parent close\\n"); require("node:fs").writeFileSync(${JSON.stringify(markerPath)}, "alive"); }, 250); setTimeout(() => process.exit(0), 350);`,
            )}],
            env: process.env,
            logDir: ${JSON.stringify(logDir)},
            logName: "server",
          });
          process.exit(0);
        `,
      ],
      { cwd: process.cwd(), env: process.env, stdio: "ignore" },
    );

    expect(await waitForExit(launcher)).toBe(0);
    await expect
      .poll(() => existsSync(markerPath), { timeout: 5_000 })
      .toBe(true);
    const logPath = join(logDir, "server-stdio.log");
    await expect
      .poll(
        () =>
          existsSync(logPath) &&
          readFileSync(logPath, "utf8").includes("after parent close\n"),
        { timeout: 5_000 },
      )
      .toBe(true);
  });

  it("reports output lost after real open and append failures, then resumes logging", async () => {
    const logDir = scratchDir();
    const attemptedPath = join(logDir, "first-write-attempted");
    const laterPath = join(logDir, "later-write-completed");
    const diagnosticPath = join(logDir, "writer-diagnostics");
    const lostOutput = "unique child payload 61d";
    writeFileSync(diagnosticPath, "");
    const child = spawnLoggedProcess({
      command: process.execPath,
      args: [
        "-e",
        `
          const fs = require("node:fs");
          process.stdout.write(${JSON.stringify(lostOutput)}, () => {
            fs.writeFileSync(${JSON.stringify(attemptedPath)}, "attempted");
            setTimeout(() => {
              process.stdout.write("later output recovered\\n");
              fs.writeFileSync(${JSON.stringify(laterPath)}, "alive");
            }, 150);
            setTimeout(() => process.exit(0), 250);
          });
        `,
      ],
      env: process.env,
      logDir,
      logName: "server",
      testWriterBarrier: {
        failActiveOpenCount: 4,
        failActiveWriteCount: 1,
        diagnosticPath,
      },
    });

    await expect
      .poll(() => existsSync(attemptedPath), { timeout: 5_000 })
      .toBe(true);
    expect(await waitForExit(child)).toBe(0);
    expect(existsSync(laterPath)).toBe(true);
    await expect
      .poll(
        () =>
          (() => {
            const output = uniqueFamilyFiles(logDir, "server")
              .map((path) => readFileSync(path, "utf8"))
              .join("");
            return (
              output.includes("later output recovered\n") &&
              (output.includes(lostOutput) ||
                output.includes(
                  `[bb] ${Buffer.byteLength(lostOutput)} bytes of child output lost: EIO\n`,
                ))
            );
          })(),
        { timeout: 5_000 },
      )
      .toBe(true);
    const output = uniqueFamilyFiles(logDir, "server")
      .map((path) => readFileSync(path, "utf8"))
      .join("");
    if (!output.includes(lostOutput)) {
      expect(output).toContain(
        `[bb] ${Buffer.byteLength(lostOutput)} bytes of child output lost: EIO\n`,
      );
      expect(readFileSync(diagnosticPath, "utf8")).toContain(
        `${Buffer.byteLength(lostOutput)} bytes of child output lost: EIO`,
      );
    }
    expect(readFileSync(diagnosticPath, "utf8")).toContain(
      "stdio output retry",
    );
  });

  it("recovers a dead writer segment during a survivor rotation", async () => {
    const logDir = scratchDir();
    const firstBytes = 1024 * 1024;
    const secondBytes = 11 * 1024 * 1024;
    const enteredPath = join(logDir, "survivor-before-write");
    const releasePath = join(logDir, "release-survivor");
    const completionPath = join(logDir, "survivor-writer-finished");
    const first = spawnLoggedProcess({
      command: process.execPath,
      args: [
        "-e",
        `process.stdout.write(Buffer.alloc(${firstBytes}, 65)); setInterval(() => {}, 1000);`,
      ],
      env: process.env,
      logDir,
      logName: "server",
    });
    let survivor: ChildProcess | undefined;
    let writerPid: number | undefined;
    try {
      await expect
        .poll(
          () =>
            familyFiles(logDir, "server").some((path) =>
              path.includes(".active-"),
            ),
          { timeout: 5_000, interval: 10 },
        )
        .toBe(true);
      const firstSegment = familyFiles(logDir, "server").find((path) =>
        path.includes(".active-"),
      );
      expect(firstSegment).toBeDefined();
      writerPid = Number(firstSegment!.match(/\.active-(\d+)-/)?.[1]);
      expect(Number.isInteger(writerPid)).toBe(true);
      survivor = spawnLoggedProcess({
        command: process.execPath,
        args: ["-e", `process.stdout.write(Buffer.alloc(${secondBytes}, 66));`],
        env: process.env,
        logDir,
        logName: "server",
        testWriterBarrier: {
          enteredPath,
          releasePath,
          pauseAtBytes: 9 * 1024 * 1024,
          completionPath,
        },
      });
      await expect
        .poll(() => existsSync(enteredPath), { timeout: 5_000, interval: 10 })
        .toBe(true);
      process.kill(writerPid!, "SIGKILL");
      await expect
        .poll(
          () => {
            try {
              process.kill(writerPid!, 0);
              return false;
            } catch (error) {
              return (error as NodeJS.ErrnoException).code === "ESRCH";
            }
          },
          { timeout: 5_000, interval: 10 },
        )
        .toBe(true);
      writeFileSync(releasePath, "release");
      expect(await waitForExit(survivor)).toBe(0);
      await expect
        .poll(() => existsSync(completionPath), {
          timeout: 5_000,
          interval: 10,
        })
        .toBe(true);
      await expect
        .poll(
          () =>
            !familyFiles(logDir, "server").some((path) =>
              path.includes(`.active-${writerPid}-`),
            ),
          { timeout: 5_000, interval: 10 },
        )
        .toBe(true);
      const files = uniqueFamilyFiles(logDir, "server");
      const backups = familyFiles(logDir, "server").filter((path) =>
        path.includes(".backup-"),
      );
      expect(backups.length).toBeLessThanOrEqual(5);
      expect(
        familyFiles(logDir, "server").every(
          (path) => statSync(path).size <= 10 * 1024 * 1024,
        ),
      ).toBe(true);
      const output = Buffer.concat(files.map((path) => readFileSync(path)));
      expect(output.length).toBe(firstBytes + secondBytes);
      expect(output.filter((byte) => byte === 65).length).toBe(firstBytes);
      expect(output.filter((byte) => byte === 66).length).toBe(secondBytes);
    } finally {
      if (!existsSync(releasePath)) writeFileSync(releasePath, "release");
      if (writerPid !== undefined) {
        try {
          process.kill(writerPid, "SIGKILL");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
      }
      if (first.exitCode === null) first.kill("SIGKILL");
      if (survivor?.exitCode === null) survivor.kill("SIGKILL");
    }
  });

  it("recovers a segment when a live pid has a different recorded incarnation", async () => {
    const logDir = scratchDir();
    const stopPath = join(logDir, "stop-incarnation-survivor");
    const completionPath = join(logDir, "incarnation-survivor-finished");
    const source = process.platform === "linux" ? 1 : 2;
    const mismatchedSegment = join(
      logDir,
      `server-stdio.log.active-${process.pid}-${source}-0000000000000000-deadbeef-dead-beef-dead-beefdeadbeef`,
    );
    const survivor = spawnLoggedProcess({
      command: process.execPath,
      args: [
        "-e",
        `const fs = require("node:fs"); process.stdout.write("incarnation-survivor-started\\n"); const timer = setInterval(() => { if (fs.existsSync(${JSON.stringify(stopPath)})) { clearInterval(timer); process.exit(0); } }, 10);`,
      ],
      env: process.env,
      logDir,
      logName: "server",
      testWriterBarrier: {
        completionPath,
        identityRecheckMs: 25,
        recoveryIntervalMs: 25,
      },
    });
    try {
      await expect
        .poll(
          () =>
            familyFiles(logDir, "server").some((path) =>
              path.includes(".active-"),
            ),
          { timeout: 5_000, interval: 10 },
        )
        .toBe(true);
      writeFileSync(mismatchedSegment, "reused-pid-segment\\n");
      await expect
        .poll(() => !existsSync(mismatchedSegment), {
          timeout: 3_000,
          interval: 10,
        })
        .toBe(true);
      const recovered = familyFiles(logDir, "server").find(
        (path) =>
          path.includes(".backup-") &&
          readFileSync(path, "utf8").includes("reused-pid-segment\\n"),
      );
      expect(recovered).toBeDefined();
      expect(survivor.exitCode).toBeNull();
      writeFileSync(stopPath, "stop");
      expect(await waitForExit(survivor)).toBe(0);
      await expect
        .poll(() => existsSync(completionPath), {
          timeout: 3_000,
          interval: 10,
        })
        .toBe(true);
    } finally {
      if (survivor.exitCode === null) survivor.kill("SIGKILL");
    }
  });

  it("keeps live segments when writers use different locale environments", async () => {
    const logDir = scratchDir();
    const firstStopPath = join(logDir, "stop-locale-writer-one");
    const secondStopPath = join(logDir, "stop-locale-writer-two");
    const firstCompletionPath = join(logDir, "locale-writer-one-finished");
    const secondCompletionPath = join(logDir, "locale-writer-two-finished");
    const makeArgs = (label: string, stopPath: string) => [
      "-e",
      `const fs = require("node:fs"); process.stdout.write(${JSON.stringify(label)}); const timer = setInterval(() => { if (fs.existsSync(${JSON.stringify(stopPath)})) { clearInterval(timer); process.exit(0); } }, 10);`,
    ];
    const first = spawnLoggedProcess({
      command: process.execPath,
      args: makeArgs("locale-writer-one", firstStopPath),
      env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
      logDir,
      logName: "server",
      testWriterBarrier: {
        completionPath: firstCompletionPath,
        forcePsIdentity: true,
        recoveryIntervalMs: 60_000,
        writerEnv: { LC_ALL: "C", TZ: "UTC" },
      },
    });
    let second: ChildProcess | undefined;
    try {
      await expect
        .poll(
          () =>
            familyFiles(logDir, "server").some(
              (path) =>
                path.includes(".active-") &&
                readFileSync(path, "utf8").includes("locale-writer-one"),
            ),
          { timeout: 5_000, interval: 10 },
        )
        .toBe(true);
      const firstActivePath = familyFiles(logDir, "server").find(
        (path) =>
          path.includes(".active-") &&
          readFileSync(path, "utf8").includes("locale-writer-one"),
      )!;
      second = spawnLoggedProcess({
        command: process.execPath,
        args: makeArgs("locale-writer-two", secondStopPath),
        env: { ...process.env, LC_ALL: "C.utf8", TZ: "Pacific/Honolulu" },
        logDir,
        logName: "server",
        testWriterBarrier: {
          completionPath: secondCompletionPath,
          forcePsIdentity: true,
          recoveryIntervalMs: 60_000,
          writerEnv: { LC_ALL: "C.utf8", TZ: "Pacific/Honolulu" },
        },
      });
      await expect
        .poll(
          () =>
            familyFiles(logDir, "server").some(
              (path) => path.includes(".active-") && path !== firstActivePath,
            ),
          { timeout: 5_000, interval: 10 },
        )
        .toBe(true);
      const secondActivePath = familyFiles(logDir, "server").find(
        (path) => path.includes(".active-") && path !== firstActivePath,
      )!;
      expect(existsSync(firstActivePath)).toBe(true);
      expect(existsSync(secondActivePath)).toBe(true);
      expect(
        readFileSync(firstActivePath, "utf8").includes("locale-writer-one"),
      ).toBe(true);
      expect(
        readFileSync(secondActivePath, "utf8").includes("locale-writer-two"),
      ).toBe(true);
      writeFileSync(firstStopPath, "stop");
      writeFileSync(secondStopPath, "stop");
      expect(await waitForExit(first)).toBe(0);
      expect(await waitForExit(second)).toBe(0);
      await expect
        .poll(
          () =>
            existsSync(firstCompletionPath) && existsSync(secondCompletionPath),
          { timeout: 3_000, interval: 10 },
        )
        .toBe(true);
      const output = uniqueFamilyFiles(logDir, "server")
        .map((path) => readFileSync(path, "utf8"))
        .join("");
      expect(output).toContain("locale-writer-one");
      expect(output).toContain("locale-writer-two");
    } finally {
      if (!existsSync(firstStopPath)) writeFileSync(firstStopPath, "stop");
      if (!existsSync(secondStopPath)) writeFileSync(secondStopPath, "stop");
      if (first.exitCode === null) first.kill("SIGKILL");
      if (second?.exitCode === null) second.kill("SIGKILL");
    }
  });

  it("reclaims an unreadable live owner only after its segment exceeds the idle bound", async () => {
    const logDir = scratchDir();
    const stopPath = join(logDir, "stop-unreadable-owner-survivor");
    const completionPath = join(logDir, "unreadable-owner-survivor-finished");
    const identitySource = process.platform === "linux" ? 1 : 2;
    const ownerPrefix = `server-stdio.log.active-${process.pid}-${identitySource}-0000000000000000-`;
    const staleSegment = join(
      logDir,
      `${ownerPrefix}deadbeef-dead-beef-dead-beefdeadbeef`,
    );
    const freshSegment = join(
      logDir,
      `${ownerPrefix}feedface-feed-face-feed-facefeedface`,
    );
    const fallbackMs = 500;
    const survivor = spawnLoggedProcess({
      command: process.execPath,
      args: [
        "-e",
        `const fs = require("node:fs"); process.stdout.write("unreadable-owner-survivor-started\\n"); const timer = setInterval(() => { if (fs.existsSync(${JSON.stringify(stopPath)})) { clearInterval(timer); process.exit(0); } }, 10);`,
      ],
      env: process.env,
      logDir,
      logName: "server",
      testWriterBarrier: {
        completionPath,
        identityFallbackMs: fallbackMs,
        identityRecheckMs: 25,
        recoveryIntervalMs: 25,
        unreadableOwnerIdentityPids: [process.pid],
      },
    });
    try {
      await expect
        .poll(
          () =>
            familyFiles(logDir, "server").some((path) =>
              path.includes(".active-"),
            ),
          { timeout: 5_000, interval: 10 },
        )
        .toBe(true);
      writeFileSync(staleSegment, "stale-unreadable-segment\\n");
      utimesSync(staleSegment, new Date(0), new Date(0));
      writeFileSync(freshSegment, "fresh-unreadable-segment\\n");
      await expect
        .poll(() => !existsSync(staleSegment), { timeout: 2_000, interval: 10 })
        .toBe(true);
      expect(existsSync(freshSegment)).toBe(true);
      expect(
        familyFiles(logDir, "server").some(
          (path) =>
            path.includes(".backup-") &&
            readFileSync(path, "utf8").includes("stale-unreadable-segment\\n"),
        ),
      ).toBe(true);
      writeFileSync(stopPath, "stop");
      expect(await waitForExit(survivor)).toBe(0);
      await expect
        .poll(() => existsSync(completionPath), {
          timeout: 3_000,
          interval: 10,
        })
        .toBe(true);
    } finally {
      if (survivor.exitCode === null) survivor.kill("SIGKILL");
    }
  });

  it("recovers a dead writer segment on a timer while a survivor stays below the rotation limit", async () => {
    const logDir = scratchDir();
    const deadStopPath = join(logDir, "stop-dead-child");
    const survivorContinuePath = join(logDir, "continue-survivor");
    const survivorStopPath = join(logDir, "stop-survivor");
    const completionPath = join(logDir, "survivor-writer-finished");
    const first = spawnLoggedProcess({
      command: process.execPath,
      args: [
        "-e",
        `const fs = require("node:fs"); process.stdout.write("dead-segment-output\\n"); const timer = setInterval(() => { if (fs.existsSync(${JSON.stringify(deadStopPath)})) { clearInterval(timer); process.exit(0); } }, 10);`,
      ],
      env: process.env,
      logDir,
      logName: "server",
    });
    let survivor: ChildProcess | undefined;
    let writerPid: number | undefined;
    let firstSegment: string | undefined;
    let survivorSegment: string | undefined;
    try {
      await expect
        .poll(
          () =>
            familyFiles(logDir, "server").find((path) =>
              path.includes(".active-"),
            ),
          { timeout: 5_000, interval: 10 },
        )
        .toBeDefined();
      firstSegment = familyFiles(logDir, "server").find((path) =>
        path.includes(".active-"),
      );
      expect(firstSegment).toBeDefined();
      writerPid = Number(firstSegment!.match(/\.active-(\d+)-/)?.[1]);
      expect(Number.isInteger(writerPid)).toBe(true);
      await expect
        .poll(
          () =>
            readFileSync(firstSegment!, "utf8").includes(
              "dead-segment-output\n",
            ),
          { timeout: 5_000, interval: 10 },
        )
        .toBe(true);
      survivor = spawnLoggedProcess({
        command: process.execPath,
        args: [
          "-e",
          `const fs = require("node:fs"); let continued = false; process.stdout.write("survivor-started\\n"); const timer = setInterval(() => { if (!continued && fs.existsSync(${JSON.stringify(survivorContinuePath)})) { continued = true; process.stdout.write("survivor-after-recovery\\n"); } if (fs.existsSync(${JSON.stringify(survivorStopPath)})) { clearInterval(timer); process.exit(0); } }, 10);`,
        ],
        env: process.env,
        logDir,
        logName: "server",
        testWriterBarrier: { recoveryIntervalMs: 25, completionPath },
      });
      await expect
        .poll(
          () =>
            familyFiles(logDir, "server").find(
              (path) => path.includes(".active-") && path !== firstSegment,
            ),
          { timeout: 5_000, interval: 10 },
        )
        .toBeDefined();
      survivorSegment = familyFiles(logDir, "server").find(
        (path) => path.includes(".active-") && path !== firstSegment,
      );
      expect(survivorSegment).toBeDefined();
      expect(statSync(survivorSegment!).size).toBeLessThan(10 * 1024 * 1024);

      process.kill(writerPid!, "SIGKILL");
      await expect
        .poll(
          () => {
            try {
              process.kill(writerPid!, 0);
              return false;
            } catch (error) {
              return (error as NodeJS.ErrnoException).code === "ESRCH";
            }
          },
          { timeout: 5_000, interval: 10 },
        )
        .toBe(true);
      await expect
        .poll(() => !existsSync(firstSegment!), {
          timeout: 3_000,
          interval: 10,
        })
        .toBe(true);
      expect(existsSync(survivorSegment!)).toBe(true);
      expect(
        familyFiles(logDir, "server").some((path) => path.includes(".active-")),
      ).toBe(true);
      expect(statSync(survivorSegment!).size).toBeLessThan(10 * 1024 * 1024);
      expect(
        uniqueFamilyFiles(logDir, "server").some(
          (path) =>
            path !== survivorSegment &&
            readFileSync(path, "utf8").includes("dead-segment-output\n"),
        ),
      ).toBe(true);

      writeFileSync(survivorContinuePath, "continue");
      await expect
        .poll(
          () =>
            readFileSync(survivorSegment!, "utf8").includes(
              "survivor-after-recovery\n",
            ),
          { timeout: 3_000, interval: 10 },
        )
        .toBe(true);
      expect(existsSync(survivorSegment!)).toBe(true);
      expect(statSync(survivorSegment!).size).toBeLessThan(10 * 1024 * 1024);
      writeFileSync(survivorStopPath, "stop");
      expect(await waitForExit(survivor)).toBe(0);
      await expect
        .poll(() => existsSync(completionPath), {
          timeout: 3_000,
          interval: 10,
        })
        .toBe(true);
      writeFileSync(deadStopPath, "stop");
      expect(await waitForExit(first)).toBe(0);
      const files = uniqueFamilyFiles(logDir, "server");
      const backups = familyFiles(logDir, "server").filter((path) =>
        path.includes(".backup-"),
      );
      expect(backups.length).toBeLessThanOrEqual(5);
      expect(
        familyFiles(logDir, "server").every(
          (path) => statSync(path).size <= 10 * 1024 * 1024,
        ),
      ).toBe(true);
      const output = Buffer.concat(files.map((path) => readFileSync(path)));
      expect(output.toString()).toContain("dead-segment-output\n");
      expect(output.toString()).toContain("survivor-started\n");
      expect(output.toString()).toContain("survivor-after-recovery\n");
    } finally {
      writeFileSync(deadStopPath, "stop");
      writeFileSync(survivorStopPath, "stop");
      if (writerPid !== undefined) {
        try {
          process.kill(writerPid, "SIGKILL");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
      }
      if (first.exitCode === null)
        await waitForExit(first).catch(() => undefined);
      if (survivor?.exitCode === null)
        await waitForExit(survivor).catch(() => undefined);
    }
  });

  it("rotates an oversized active log without discarding its contents", async () => {
    const logDir = scratchDir();
    const logPath = join(logDir, "server-stdio.log");
    const writerFinishedPath = join(logDir, "writer-finished");
    writeFileSync(logPath, `previous-active:${"x".repeat(11 * 1024 * 1024)}`);
    for (let index = 1; index <= 5; index += 1) {
      writeFileSync(`${logPath}.${index}`, `previous-${index}`);
    }
    const child = spawnLoggedProcess({
      command: process.execPath,
      args: ["-e", `process.stdout.write("new active output\\n");`],
      env: process.env,
      logDir,
      logName: "server",
      testWriterBarrier: { completionPath: writerFinishedPath },
    });

    expect(await waitForExit(child)).toBe(0);
    await expect
      .poll(() => existsSync(writerFinishedPath), { timeout: 5_000 })
      .toBe(true);
    await expect
      .poll(
        () =>
          existsSync(logPath) &&
          readFileSync(logPath, "utf8").includes("new active output\n"),
        { timeout: 5_000 },
      )
      .toBe(true);
    const backups = familyFiles(logDir, "server").filter((path) =>
      path.includes(".backup-"),
    );
    expect(backups.length).toBeLessThanOrEqual(5);
    expect(
      backups.some((path) =>
        readFileSync(path, "utf8").includes("previous-active:"),
      ),
    ).toBe(true);
    expect(
      backups.every((path) => statSync(path).size <= 10 * 1024 * 1024),
    ).toBe(true);
  });

  it.skipIf(process.platform === "win32")(
    "passes the parent environment to the detached log writer",
    async () => {
      const logDir = scratchDir();
      const fakeElectronPath = join(logDir, "electron");
      const writerStartedPath = join(logDir, "writer-started");
      writeFileSync(
        fakeElectronPath,
        `#!/usr/bin/env node\nif (process.env.ELECTRON_RUN_AS_NODE !== "1") process.exit(88);\nrequire("node:fs").writeFileSync(${JSON.stringify(writerStartedPath)}, "started");\nconst { spawnSync } = require("node:child_process");\nconst result = spawnSync(${JSON.stringify(process.execPath)}, process.argv.slice(2), { stdio: "inherit", env: process.env });\nprocess.exit(result.status ?? 1);\n`,
      );
      chmodSync(fakeElectronPath, 0o700);
      const outputPath = join(logDir, "server-stdio.log");
      const previousExecPath = process.execPath;
      const previousElectronMode = process.env.ELECTRON_RUN_AS_NODE;
      process.env.ELECTRON_RUN_AS_NODE = "1";
      Object.defineProperty(process, "execPath", { value: fakeElectronPath });
      let child!: ChildProcess;
      try {
        child = spawnLoggedProcess({
          command: previousExecPath,
          args: ["-e", `process.stdout.write("writer environment\\n");`],
          env: process.env,
          logDir,
          logName: "server",
        });
      } finally {
        Object.defineProperty(process, "execPath", { value: previousExecPath });
        if (previousElectronMode === undefined)
          delete process.env.ELECTRON_RUN_AS_NODE;
        else process.env.ELECTRON_RUN_AS_NODE = previousElectronMode;
      }

      expect(await waitForExit(child)).toBe(0);
      await expect
        .poll(() => existsSync(writerStartedPath), { timeout: 5_000 })
        .toBe(true);
      await expect
        .poll(
          () =>
            existsSync(outputPath) &&
            readFileSync(outputPath, "utf8").includes("writer environment\n"),
          { timeout: 5_000 },
        )
        .toBe(true);
    },
  );

  it("rotates stdio output at the log size limit", async () => {
    const logDir = scratchDir();
    const writerFinishedPath = join(logDir, "writer-finished");
    const child = spawnLoggedProcess({
      command: process.execPath,
      args: ["-e", `process.stdout.write("x".repeat(61 * 1024 * 1024));`],
      env: process.env,
      logDir,
      logName: "server",
      testWriterBarrier: { completionPath: writerFinishedPath },
    });

    expect(await waitForExit(child)).toBe(0);
    await expect
      .poll(() => existsSync(writerFinishedPath), { timeout: 5_000 })
      .toBe(true);
    const currentPath = join(logDir, "server-stdio.log");
    const backups = () =>
      familyFiles(logDir, "server").filter((path) => path.includes(".backup-"));
    await expect
      .poll(
        () =>
          existsSync(currentPath) &&
          statSync(currentPath).size === 1024 * 1024 &&
          backups().length === 5,
        { timeout: 5_000, interval: 10 },
      )
      .toBe(true);
    expect(backups()).toHaveLength(5);
    expect(statSync(currentPath).size).toBe(1024 * 1024);
    expect(readFileSync(currentPath, "utf8")).toBe("x".repeat(1024 * 1024));
    expect(
      familyFiles(logDir, "server").every(
        (path) => statSync(path).size <= 10 * 1024 * 1024,
      ),
    ).toBe(true);
  });

  it("fails instead of falling back to terminal output when logs cannot be opened", () => {
    const logDir = scratchDir();
    const blockedPath = join(logDir, "not-a-directory");
    writeFileSync(blockedPath, "occupied");
    expect(() =>
      spawnLoggedProcess({
        command: process.execPath,
        args: ["-e", "process.exit(0)"],
        env: process.env,
        logDir: blockedPath,
        logName: "server",
      }),
    ).toThrow();
  });

  it("reports executable spawn failures", async () => {
    const logDir = scratchDir();
    const child = spawnLoggedProcess({
      command: join(logDir, "missing-executable"),
      args: [],
      env: process.env,
      logDir,
      logName: "server",
    });
    await expect(waitForExit(child)).rejects.toThrow("ENOENT");
  });
});
