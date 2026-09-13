const SKIP_REASON_LABELS: Record<string, string> = {
  "wakeAgent false": "Skipped, the script reported nothing to do",
  "empty output": "Skipped, the script produced no output",
};

export function describeSkipReason(reason: string): string {
  return SKIP_REASON_LABELS[reason] ?? `Skipped, ${reason}`;
}
