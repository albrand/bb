import type {
  NativeTerminalThread,
  TerminalSession,
} from "@bb/server-contract";

export type NativeTerminalState =
  | { kind: "preparing" }
  | { kind: "live"; terminalId: string }
  | { kind: "ended"; exitCode: number | null };

export function resolveNativeTerminalSession(args: {
  listedSessions: readonly TerminalSession[] | undefined;
  listUpdatedAt: number;
  view: NativeTerminalThread;
  viewUpdatedAt: number;
}): TerminalSession | null {
  const terminal = args.view.terminal;
  if (terminal === null) return null;
  const listed = args.listedSessions?.find((entry) => entry.id === terminal.id);
  if (listed !== undefined) return listed;
  if (args.listedSessions === undefined || terminal.status === "exited") {
    return terminal;
  }
  return args.viewUpdatedAt > args.listUpdatedAt ? terminal : null;
}

export function resolveNativeTerminalState(args: {
  session: TerminalSession | null;
  threadIsProvisioning: boolean;
}): NativeTerminalState {
  if (args.session === null) {
    return args.threadIsProvisioning
      ? { kind: "preparing" }
      : { kind: "ended", exitCode: null };
  }
  if (args.session.status === "exited") {
    return { kind: "ended", exitCode: args.session.exitCode };
  }
  return { kind: "live", terminalId: args.session.id };
}
