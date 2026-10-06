// Child threads (spawned under a parent) run on a lighter model than the
// orchestrators that spawn them. Orchestrators are top-level threads, so a
// thread with a parent is a child: every turn it runs, whether its model came
// from the request, a sticky update, the project's remembered default or the
// catalog default (which for Claude is Opus), uses the child model instead.
const CHILD_THREAD_MODELS: Readonly<Record<string, string>> = {
  "claude-code": "claude-sonnet-5-5",
};

interface ChildThreadModelArgs {
  parentThreadId: string | null | undefined;
  providerId: string;
}

export function childThreadModel(args: ChildThreadModelArgs): string | null {
  if (!args.parentThreadId) {
    return null;
  }
  return CHILD_THREAD_MODELS[args.providerId] ?? null;
}
