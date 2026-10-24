import { isActiveTerminalSessionStatus } from "@bb/domain";
import type { TerminalSession } from "@bb/server-contract";

export function isVisibleTerminalSession(session: TerminalSession): boolean {
  return (
    isActiveTerminalSessionStatus(session.status) ||
    session.status === "disconnected"
  );
}

export function getThreadTerminalLayoutSessions(
  sessions: readonly TerminalSession[],
  terminalIds: readonly string[],
  threadId: string,
): TerminalSession[] | null {
  const selected = terminalIds.map((terminalId) =>
    sessions.find(
      (session) =>
        session.id === terminalId &&
        session.threadId === threadId &&
        isVisibleTerminalSession(session),
    ),
  );
  return selected.some((session) => session === undefined)
    ? null
    : selected.filter((session): session is TerminalSession => session !== undefined);
}

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
    (session.status === "disconnected" &&
      retainedTerminalIds.has(session.id)) ||
    session.status === "exited"
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

export function omitSupersededDisconnectedSessions(
  sessions: readonly TerminalSession[],
): readonly TerminalSession[] {
  return sessions.filter(
    (session) =>
      !(
        session.status === "exited" &&
        session.closeReason === "daemon-disconnect" &&
        (session.exitCode ?? 0) === 0 &&
        session.threadId !== null &&
        sessions.some(
          (other) =>
            other.id !== session.id &&
            other.threadId === session.threadId &&
            other.status === "running" &&
            other.createdAt > session.createdAt,
        )
      ),
  );
}
