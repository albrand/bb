import { scanProcessesWithCwdUnder } from "@bb/process-utils";
import { CommandDispatchError } from "../command-dispatch-support.js";

export async function refuseWhileHeld(args: {
  directory: string;
  action: string;
}): Promise<void> {
  const scan = await scanProcessesWithCwdUnder({
    directories: [args.directory],
  });
  if (scan.status === "clear") return;
  if (scan.status === "unknown") {
    throw new CommandDispatchError(
      "path_in_use",
      `Refusing to ${args.action} ${args.directory}: whether a process is still working inside it could not be established (${scan.reason}). Nothing was stopped and nothing was removed.`,
    );
  }
  throw new CommandDispatchError(
    "path_in_use",
    `Refusing to ${args.action} ${args.directory}: ${scan.holders.length === 1 ? "a process is" : `${scan.holders.length} processes are`} still working inside it (${scan.holders
      .slice(0, 5)
      .map((holder) => `pid ${holder.pid} in ${holder.cwd}`)
      .join("; ")}). Nothing was stopped and nothing was removed.`,
  );
}
