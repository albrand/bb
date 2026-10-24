import { HookAppendReader, HookSpoolReader } from "../../native-hook-spool.js";

const [kind, target] = process.argv.slice(2);
if (target === undefined || (kind !== "spool" && kind !== "append")) {
  throw new Error("usage: read-hook-dir <spool|append> <path>");
}
const reader =
  kind === "spool" ? new HookSpoolReader(target) : new HookAppendReader(target);
const start = Date.now();
process.stdout.write(
  JSON.stringify([reader.read(start), reader.read(start + 3_000)]),
);
