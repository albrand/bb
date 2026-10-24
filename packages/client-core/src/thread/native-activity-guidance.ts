export const NATIVE_ACTIVITY_FALLBACK_HOST = "this thread's machine";

export type NativeActivityGuidanceSegment =
  | { kind: "command"; text: string }
  | { kind: "text"; text: string };

export function nativeActivityRecoveryGuidance(args: {
  hostName: string | null;
  threadId: string;
}): NativeActivityGuidanceSegment[] {
  return [
    {
      kind: "text",
      text: `If this session started before bb was updated, update bb on ${args.hostName ?? NATIVE_ACTIVITY_FALLBACK_HOST}, save your work, type `,
    },
    { kind: "command", text: "/exit" },
    { kind: "text", text: " in the terminal, then reopen with " },
    { kind: "command", text: `bb thread native ${args.threadId}` },
    {
      kind: "text",
      text: ". A pending question will need to be asked again.",
    },
  ];
}

export function nativeActivityRecoveryText(args: {
  hostName: string | null;
  threadId: string;
}): string {
  return nativeActivityRecoveryGuidance(args)
    .map((segment) => segment.text)
    .join("");
}
