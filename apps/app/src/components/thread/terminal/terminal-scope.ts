export type ThreadTerminalTarget =
  | { kind: "thread"; threadId: string }
  | { kind: "environment"; environmentId: string }
  | { kind: "host_path"; cwd: string | null; hostId: string };

export function resolveTerminalScopeKey(target: ThreadTerminalTarget): string {
  switch (target.kind) {
    case "thread":
      return target.threadId;
    case "environment":
      return target.environmentId;
    case "host_path":
      return `${target.hostId}:${target.cwd ?? "home"}`;
  }
}
