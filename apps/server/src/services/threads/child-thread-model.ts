// Child threads run on a lighter model than the orchestrators that spawn
// them. A thread with a parent, or a top-level thread another thread spawned,
// is a child: every turn it runs, whether its model came from the request, a
// sticky update, the project's remembered default or the catalog default, uses
// the model its provider declares for children (`models.childThreadModel`). A
// provider that declares none leaves its children alone.
interface ChildThreadModelArgs {
  parentThreadId: string | null | undefined;
  declaredChildModel: string | null | undefined;
}

export function childThreadModel(args: ChildThreadModelArgs): string | null {
  if (!args.parentThreadId) {
    return null;
  }
  return args.declaredChildModel ?? null;
}
