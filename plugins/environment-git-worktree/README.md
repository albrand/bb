# Worktree

Creates an isolated Git worktree from the project checkout on an enrolled machine. The plugin supplies base-branch inputs, runs workspace setup, and removes owned worktrees after core retires them. Project sub-threads receive fresh worktrees by default.

Bundled and installed automatically. Select it through the environment picker or `bb thread spawn --environment-provider git-worktree`. Use `bb environment providers --json` for its inputs and availability.

New branches start at the selected base without an upstream. Publish with `git push -u origin HEAD` to track the task's remote branch. Existing branches keep their upstream configuration.

The Plugin Guide documents the experimental environment-provider contract. Core owns durable launches, retries, cancellation, retirement, and teardown; this plugin owns resource creation and removal.

Existing-worktree inputs (`{"kind":"existing","path":"/absolute/worktree"}`)
reuse the project's recorded environment on the selected machine before running
provider creation. Its ownership and cleanup behavior stay intact. When the path
has no environment, the plugin validates it against Git and adopts it without
taking ownership; retiring that environment leaves the worktree on disk.

Removal keeps a worktree that holds recoverable work and shows the reason
instead: a `.keep-worktree` file in its root, modified or untracked files, a
commit that no remote-tracking branch contains, a lock, or an unfinished merge,
rebase, cherry-pick or revert. A kept worktree is retried with a growing delay;
when removal fails after bb changed anything, the environment stays in error
and is never reused.

A create that fails after the worktree exists removes it only if it still holds
nothing but what bb put there; anything else is kept and reported.
