import { execFileSync } from "node:child_process";

export function listDescendantPids(
  psOutput: string,
  rootPid: number,
): number[] {
  const childrenByParent = new Map<number, number[]>();
  for (const row of psOutput.split("\n")) {
    const [pidText, ppidText] = row.trim().split(/\s+/u);
    const pid = Number(pidText);
    const ppid = Number(ppidText);
    if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(ppid)) continue;
    const siblings = childrenByParent.get(ppid) ?? [];
    siblings.push(pid);
    childrenByParent.set(ppid, siblings);
  }
  const descendants: number[] = [];
  const pending = [...(childrenByParent.get(rootPid) ?? [])];
  while (pending.length > 0) {
    const pid = pending.shift();
    if (pid === undefined || descendants.includes(pid)) continue;
    descendants.push(pid);
    pending.push(...(childrenByParent.get(pid) ?? []));
  }
  return descendants;
}

export interface DescendantPauser {
  stop(): number[];
  resume(): number[];
}

export interface DescendantPauserDeps {
  listDescendants: () => number[];
  signal: (pid: number, signal: "SIGSTOP" | "SIGCONT") => boolean;
}

function listOwnDescendants(): number[] {
  if (process.platform === "win32") return [];
  try {
    const psOutput = execFileSync("ps", ["-A", "-o", "pid=,ppid="], {
      encoding: "utf8",
    });
    return listDescendantPids(psOutput, process.pid);
  } catch {
    return [];
  }
}

function signalPid(pid: number, signal: "SIGSTOP" | "SIGCONT"): boolean {
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

export function createDescendantPauser(
  deps: DescendantPauserDeps = {
    listDescendants: listOwnDescendants,
    signal: signalPid,
  },
): DescendantPauser {
  const stopped = new Set<number>();
  return {
    stop() {
      for (const pid of deps.listDescendants()) {
        if (deps.signal(pid, "SIGSTOP")) stopped.add(pid);
      }
      return [...stopped];
    },
    resume() {
      const pids = [...new Set([...stopped, ...deps.listDescendants()])];
      stopped.clear();
      for (const pid of pids) deps.signal(pid, "SIGCONT");
      return pids;
    },
  };
}
