import fsp from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";

const rootPid = Number(process.env.PROCESS_VIEW_ROOT_PID);
const readdir = fsp.readdir.bind(fsp);

async function parentOf(pid) {
  try {
    const stat = await fsp.readFile(`/proc/${pid}/stat`, "utf8");
    const parent = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
    return Number.isInteger(parent) ? parent : null;
  } catch {
    return null;
  }
}

async function isBelowRoot(pid) {
  let current = Number(pid);
  for (
    let steps = 0;
    steps < 64 && current !== null && current > 1;
    steps += 1
  ) {
    if (current === rootPid) return true;
    current = await parentOf(current);
  }
  return false;
}

fsp.readdir = async (path, ...rest) => {
  const entries = await readdir(path, ...rest);
  if (path !== "/proc" || rest.length > 0) return entries;
  const kept = [];
  for (const entry of entries) {
    if (!/^\d+$/u.test(entry) || (await isBelowRoot(entry))) kept.push(entry);
  }
  return kept;
};
syncBuiltinESMExports();
