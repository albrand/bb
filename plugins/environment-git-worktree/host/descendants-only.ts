import type { ProcReader } from "./holders.js";

export function descendantsOnly(base: ProcReader, rootPid: number): ProcReader {
  const parents = async (pid: string): Promise<number | null> => {
    try {
      const stat = await base.readFile(`/proc/${pid}/stat`);
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const parent = Number(fields[1]);
      return Number.isInteger(parent) ? parent : null;
    } catch {
      return null;
    }
  };
  const below = async (pid: string): Promise<boolean> => {
    let current: number | null = Number(pid);
    for (
      let steps = 0;
      steps < 64 && current !== null && current > 1;
      steps += 1
    ) {
      if (current === rootPid) return true;
      current = await parents(String(current));
    }
    return false;
  };
  return {
    ...base,
    readdir: async (path) => {
      const entries = await base.readdir(path);
      if (path !== "/proc") return entries;
      const kept: string[] = [];
      for (const entry of entries) {
        if (!/^\d+$/u.test(entry) || (await below(entry))) kept.push(entry);
      }
      return kept;
    },
  };
}
