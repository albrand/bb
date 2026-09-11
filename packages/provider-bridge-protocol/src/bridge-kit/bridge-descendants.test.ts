import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";
import { listDescendantPids } from "./bridge-descendants.js";

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

it.skipIf(process.platform === "win32")(
  "stops and continues the worker's provider processes, not the worker itself",
  () => {
    const script = [
      "import { spawn, execFileSync } from 'node:child_process';",
      `import { signalDescendantProcesses } from ${JSON.stringify(new URL("./bridge-descendants.ts", import.meta.url).href)};`,
      "const child = spawn('sleep', ['30'], { stdio: 'ignore' });",
      "const state = () => execFileSync('ps', ['-o', 'stat=', '-p', String(child.pid)], { encoding: 'utf8' }).trim();",
      "await new Promise((resolve) => setTimeout(resolve, 100));",
      "signalDescendantProcesses('SIGSTOP');",
      "await new Promise((resolve) => setTimeout(resolve, 100));",
      "const stopped = state();",
      "signalDescendantProcesses('SIGCONT');",
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
