// Child threads (spawned under a parent) default to a lighter model than the
// orchestrators that spawn them. Without this, a child spawned with no model
// inherits the project's remembered default or the catalog default, which for
// Claude is Opus. An explicitly requested model always wins.
const CHILD_THREAD_DEFAULT_MODELS: Readonly<Record<string, string>> = {
  "claude-code": "claude-sonnet-5-5",
};

interface ChildThreadDefaultModelArgs {
  parentThreadId: string | undefined;
  providerId: string;
  requestedModel: string | null;
}

export function childThreadDefaultModel(
  args: ChildThreadDefaultModelArgs,
): string | null {
  if (!args.parentThreadId || args.requestedModel !== null) {
    return null;
  }
  return CHILD_THREAD_DEFAULT_MODELS[args.providerId] ?? null;
}
