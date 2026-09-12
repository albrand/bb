import { isActiveTerminalSessionStatus } from "@bb/domain";
import type { TerminalSession } from "@bb/server-contract";

interface RetainedTerminalSessionArgs {
  retainedTerminalIds: ReadonlySet<string>;
  session: TerminalSession;
}

export function shouldShowRetainedTerminalSession({
  retainedTerminalIds,
  session,
}: RetainedTerminalSessionArgs): boolean {
  return (
    isActiveTerminalSessionStatus(session.status) ||
    (session.status === "disconnected" && retainedTerminalIds.has(session.id))
  );
}

export function shouldCloseUnretainedDisconnectedTerminalSession({
  retainedTerminalIds,
  session,
}: RetainedTerminalSessionArgs): boolean {
  return (
    session.status === "disconnected" && !retainedTerminalIds.has(session.id)
  );
}
