import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";
import {
  createDescendantPauser,
  listDescendantPids,
} from "./bridge-descendants.js";

it("finds every descendant of the worker, including re-parented grandchildren's branches, and nothing else", () => {
  const ps = [
    "    1     0",
    "  100     1",
    "  200   100",
    "  201   100",
    "  300   200",
    "  400     1",
    "  401   400",
    "garbage row",
  ].join("\n");

  expect(listDescendantPids(ps, 100).sort()).toEqual([200, 201, 300]);
  expect(listDescendantPids(ps, 999)).toEqual([]);
});

it("continues every process it stopped, even one that has since left the worker's tree", () => {
  let tree = [10, 11];
  const signals: string[] = [];
  const pauser = createDescendantPauser({
    listDescendants: () => tree,
    signal: (pid, signal) => {
      signals.push(`${signal}:${pid}`);
      return true;
    },
  });

  expect(pauser.stop()).toEqual([10, 11]);
  tree = [12];
  expect(pauser.resume().sort()).toEqual([10, 11, 12]);
  expect(signals).toEqual([
    "SIGSTOP:10",
    "SIGSTOP:11",
    "SIGCONT:10",
    "SIGCONT:11",
    "SIGCONT:12",
  ]);
  signals.length = 0;
  tree = [];
  pauser.resume();
  expect(signals).toEqual([]);
});

it.skipIf(process.platform === "win32")(
  "continues a stopped grandchild whose parent exited while it was stopped",
  () => {
    const script = [
      "import { spawn, execFileSync } from 'node:child_process';",
      `import { createDescendantPauser } from ${JSON.stringify(new URL("./bridge-descendants.ts", import.meta.url).href)};`,
      "const parent = spawn('sh', ['-c', 'sleep 30 & echo $!; wait'], { stdio: ['ignore', 'pipe', 'ignore'] });",
      "const grandchild = Number(await new Promise((resolve) => parent.stdout.once('data', (chunk) => resolve(String(chunk).trim()))));",
      "const state = (pid) => execFileSync('ps', ['-o', 'stat=,ppid=', '-p', String(pid)], { encoding: 'utf8' }).trim();",
      "const pauser = createDescendantPauser();",
      "pauser.stop();",
      "await new Promise((resolve) => setTimeout(resolve, 100));",
      "const stopped = state(grandchild);",
      "parent.kill('SIGKILL');",
      "await new Promise((resolve) => parent.once('exit', resolve));",
      "await new Promise((resolve) => setTimeout(resolve, 100));",
      "const orphaned = state(grandchild);",
      "pauser.resume();",
      "await new Promise((resolve) => setTimeout(resolve, 100));",
      "const continued = state(grandchild);",
      "process.kill(grandchild, 'SIGKILL');",
      "process.stdout.write(JSON.stringify({ stopped, orphaned, continued, self: process.pid }));",
    ].join("\n");
    const output = execFileSync(
      process.execPath,
      [
        "--import",
        import.meta.resolve("tsx"),
        "--input-type=module",
        "-e",
        script,
      ],
      { encoding: "utf8" },
    );
    const { stopped, orphaned, continued, self } = JSON.parse(output) as {
      stopped: string;
      orphaned: string;
      continued: string;
      self: number;
    };
    expect(stopped.startsWith("T")).toBe(true);
    expect(orphaned.startsWith("T")).toBe(true);
    expect(Number(orphaned.split(/\s+/u)[1])).not.toBe(self);
    expect(continued.startsWith("T")).toBe(false);
  },
);

it.skipIf(process.platform === "win32")(
  "stops and continues the worker's provider processes, not the worker itself",
  () => {
    const script = [
      "import { spawn, execFileSync } from 'node:child_process';",
      `import { createDescendantPauser } from ${JSON.stringify(new URL("./bridge-descendants.ts", import.meta.url).href)};`,
      "const child = spawn('sleep', ['30'], { stdio: 'ignore' });",
      "const state = () => execFileSync('ps', ['-o', 'stat=', '-p', String(child.pid)], { encoding: 'utf8' }).trim();",
      "await new Promise((resolve) => setTimeout(resolve, 100));",
      "const pauser = createDescendantPauser();",
      "pauser.stop();",
      "await new Promise((resolve) => setTimeout(resolve, 100));",
      "const stopped = state();",
      "pauser.resume();",
      "await new Promise((resolve) => setTimeout(resolve, 100));",
      "const continued = state();",
      "child.kill('SIGKILL');",
      "process.stdout.write(JSON.stringify({ stopped, continued }));",
    ].join("\n");
    const output = execFileSync(
      process.execPath,
      [
        "--import",
        import.meta.resolve("tsx"),
        "--input-type=module",
        "-e",
        script,
      ],
      { encoding: "utf8" },
    );
    const { stopped, continued } = JSON.parse(output) as {
      stopped: string;
      continued: string;
    };
    expect(stopped.startsWith("T")).toBe(true);
    expect(continued.startsWith("T")).toBe(false);
  },
);
