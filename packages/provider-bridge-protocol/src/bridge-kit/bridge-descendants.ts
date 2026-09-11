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

export function signalDescendantProcesses(signal: "SIGSTOP" | "SIGCONT"): void {
  if (process.platform === "win32") return;
  let psOutput: string;
  try {
    psOutput = execFileSync("ps", ["-A", "-o", "pid=,ppid="], {
      encoding: "utf8",
    });
  } catch {
    return;
  }
  for (const pid of listDescendantPids(psOutput, process.pid)) {
    try {
      process.kill(pid, signal);
    } catch {}
  }
}
