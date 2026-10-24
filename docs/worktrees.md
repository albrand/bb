# Worktrees, setup scripts, and teardown scripts

When you start a thread in bb, you can run it in your project's existing
checkout or in a fresh **managed worktree** — a separate working copy on disk
with its own branch. Worktrees let bb work on multiple things in parallel
without touching your main checkout, and they make it easy to throw away
whatever the agent does without affecting the rest of your work.

You can pair a worktree with a **`.worktreeinclude` file** that lists the local
files each new worktree needs, and with a **setup script** that bb runs the
first time the worktree is created — useful for installing dependencies,
generating secrets, or anything else you need before the agent starts.
You can also add a **teardown script** that releases resources outside the
worktree before bb removes it.

## What is a managed worktree?

A managed worktree is a `git worktree` of your project's repo, on a fresh
branch. Under the hood it's `git worktree add` plus some bookkeeping:

- It shares the repo's `.git` state with your main checkout — cheap to
  create, no full clone.
- It gets its own branch so multiple threads can run in parallel.
- It lives at
  `<BB_DATA_DIR>/plugins/environment-git-worktree/host-data/worktrees/<thread-id>/<repo-name>`
  — for example, `~/.bb/plugins/environment-git-worktree/host-data/worktrees/thr_abc.../myrepo`.
- bb removes it once no thread uses it; see [Cleanup](#cleanup).

Worktrees are created by bb's built-in **Worktree** plugin, which is enabled by
default. Disabling it in Settings → Installed plugins leaves existing worktrees alone
but stops bb from making new ones: a thread that asks for one waits until the
plugin is running again.

## Start a thread in a worktree

In the app, pick **Worktree** in the environment picker when starting
a thread.

From the CLI:

```bash
pnpm bb thread spawn \
  --project <project-id> \
  --new-environment worktree \
  --prompt "..."
```

Omit `--base-branch` for bb's smart default. Explicit values are exact:
`main` is local and `origin/main` is remote.

New worktree branches start at the selected base without tracking it as an
upstream, even when Git's `branch.autoSetupMerge` is enabled. Publish with
`git push -u origin HEAD` to set the upstream to the task's remote branch.
Reusing an existing branch preserves its upstream configuration.

## Copy local files with `.worktreeinclude`

A new worktree checks out tracked files only. Your `.env`, your local
certificates, and anything else git ignores stay behind in your main checkout.

Commit a `.worktreeinclude` file at the root of your repo to list what a
worktree needs. It uses gitignore syntax — one pattern per line, `#` for
comments, `!` to negate an earlier pattern:

```gitignore
# Local credentials the agent needs
.env
.env.*
!.env.example
certs/
```

bb copies every untracked file in the source checkout that matches a pattern,
after it creates the worktree and before it runs `.bb-env-setup.sh`. Your
setup script can therefore read the copied files.

Contract:

- bb copies files. It does not create symlinks, and each worktree gets its own
  copy — an edit inside the worktree does not change your main checkout.
- bb never replaces anything the worktree already has. If the branch tracks a
  file at that path, the tracked file wins and bb reports the skip.
- bb skips symlinks in the source checkout rather than copying their targets,
  and it never writes through a symlink in the worktree.
- A pattern that matches nothing, an unreadable file, or a failed copy is
  reported in the provisioning transcript. Provisioning continues.
- Large directories such as `node_modules` are copied file by file, which is
  slow. Install dependencies in `.bb-env-setup.sh` instead.

## Run setup with `.bb-env-setup.sh`

Drop a file named `.bb-env-setup.sh` at the root of your project. If bb finds
one after an environment provider creates a path it owns (`ownsPath: true`), bb
runs the script inside that path before handing the thread to the agent. Core
owns this policy for every provider. Attaching a project checkout or personal
workspace (`ownsPath: false`) does not run either hook. Provider-specific
preparation, including `.worktreeinclude` copying, finishes before setup starts.

Use it for anything the agent will need in a fresh checkout — install
dependencies, sync local state, generate tokens, etc. To bring local files in
from your main checkout, prefer `.worktreeinclude` above.

```bash
#!/usr/bin/env bash
set -euo pipefail

pnpm install
```

Contract:

- The script runs with `env bash`, working directory set to the new worktree.
- stdin is closed. stdout and stderr stream into the thread's provisioning
  transcript in the app.
- A non-zero exit, a signal, or a timeout (15 minutes) fails provisioning and
  the thread doesn't start.
- A bash script on every platform. On native Windows bb runs it with the bash
  that Git for Windows installs and fails with a message naming Git for Windows
  when there is none.

## Cleanup

You don't need to clean up worktrees by hand. The Worktree plugin watches every
worktree it made and removes the ones nothing is using:

- Deleting the last thread on a worktree removes it right away.
- Archiving the last thread starts a five-minute grace period. Unarchive a
  thread within it and the worktree is kept; let it elapse and the worktree
  goes.
- An archived thread keeps running for 30 seconds so Undo can restore it;
  see `bb guide thread-lifecycle`.

Before it runs `.bb-env-teardown.sh` or stops anything, bb inspects every
worktree it is about to remove and checks that nothing recoverable would be
lost. If any one of them is protected, bb changes nothing, keeps the whole
environment as it was, shows the reason as the environment's kept message, and
retries with a delay that doubles from one minute up to one hour. A thread
that starts using the worktree in the meantime cancels the removal. A worktree is protected when it:

- contains a `.keep-worktree` file (create one to keep a worktree on purpose),
- has modified tracked files or untracked files (ignored files such as
  `node_modules` do not count),
- is locked, or is in the middle of a merge, rebase, cherry-pick or revert,
- has a stash entry made on its branch (`git stash`),
- has a HEAD that is not reachable from any remote-tracking branch, checked
  after bb fetches every remote of the repository, which includes repositories
  with no remote and detached commits that were never pushed. When the branch
  has no upstream, the message says so. A branch needs no upstream when it holds
  no commit that is not already on a remote-tracking branch,
- is held by a program (see below), or cannot be fetched to check,
- is not a linked worktree of the expected repository inside bb's worktree
  directory, or is a symbolic link.

Archiving a thread's last session on a worktree that is already being removed
cannot be undone until the removal finishes: Unarchive answers that the
workspace is busy. If something changes a worktree after the inspection and
bb has already stopped its processes or removed a sibling, the environment is
marked failed with the list of what was removed and what was kept, and it is
never restored automatically. A thread that is live on such an environment is
told so and its message names the path; archive the thread so bb can finish the
removal, then unarchive it to restore the workspace, or recover the path
yourself. A removal that failed before bb touched anything is undone when the
thread is unarchived.

A worktree is removed only after the threads that use it were released: an
archive or a delete of each of them through bb (the app, `bb thread archive`,
`bb thread delete` or the SDK) records the release, and unarchiving a thread
withdraws it. Whoever archives or deletes counts: you, the thread itself, or a
coordinator that archives its child; bb records which of them it was, as the
caller claims it (the CLI claims the thread in `BB_THREAD_ID`). The release is
not what keeps your work safe: the checks above are. A thread that was archived
or deleted before bb recorded releases is treated as released by an
upgrade-time record. bb also looks for programs that use the worktree: any
process of yours whose working directory is inside it, or that holds a file open
inside it. bb never signals those programs. While one is running, or when bb
cannot tell (for example on Windows, or when a process cannot be inspected), the
worktree is kept and the message names the program so its owner can finish and
close it. A scan is a snapshot: a program that opens a file after the last check
is not excluded. When bb does remove the worktree
of a create that failed, it runs `git worktree remove` without `--force`, and bb
never uses `--force`. A create that finds a branch still checked out by
an earlier workspace leaves it alone and says where it is; the owning cleanup
removes such a workspace, never the new create. A create that fails after bb made the worktree
removes it only while it holds nothing but what bb put there: HEAD is still the
commit bb created, no tracked file changed, no `.keep-worktree`, lock or
unfinished operation exists, and every other file is a `.worktreeinclude` copy
whose contents still match what bb wrote. Anything else is kept and the create
reports why. A failed create keeps its whole worktree in place for now, copies included, and
the failure message says where it is. bb moves or removes it only after its owner
has released it and a durable retention record exists; neither is available yet.
The copies may hold secrets such as `.env` files and use disk; they exist only on
that machine, so destroying an ephemeral machine would lose them. The branch is left behind, so work you committed to it survives the
worktree. Push (or open a PR) from inside the worktree to let bb remove it, and
move your own shells out of the worktree first if you want to keep them.

## Run teardown with `.bb-env-teardown.sh`

Commit a file named `.bb-env-teardown.sh` at the project root when setup
creates resources outside the worktree. For example, the script can remove a
database, a proxy registration, a container, or a port reservation.

```bash
#!/usr/bin/env bash
set -euo pipefail

docker rm -f "my-project-${USER}"
```

Contract:

- bb runs the script before calling a provider to remove a path it owns,
  including cleanup after failed setup. Attached paths do not run it.
- bb runs `env bash .bb-env-teardown.sh` from the worktree before it removes
  the worktree, so the script can read tracked and generated files.
- stdin is closed. bb records stdout and stderr in the server lifecycle logs.
- The script gets a separate 15-minute timeout.
- A non-zero exit, a signal, or a timeout reports a failure. It never stops bb
  from removing the worktree.
- The script receives the same sanitized environment as the setup script.
- A bash script on every platform. On native Windows bb runs it with the bash
  that Git for Windows installs and fails with a message naming Git for Windows
  when there is none.

A server restart does not rerun a hook that already started. An unreachable
daemon leaves cleanup pending for retry.

## If something isn't working

A few quick checks:

1. If worktree creation fails, look at the thread's provisioning transcript
   in the app. Failures from `git worktree add` (dirty source checkout,
   invalid base branch, conflicting branch name) show up there with the exact
   git error.
2. If `.bb-env-setup.sh` doesn't seem to run, make sure it's committed to
   the branch you're working from. A file that exists only in the working
   copy of your main checkout won't appear in the new worktree.
3. If your setup script hangs, remember stdin is closed. Anything that
   prompts for input will time out at 15 minutes.
4. Run `bash .bb-env-setup.sh` manually in a clean clone to verify it works
   outside bb before debugging through the provisioning transcript.
5. Run `bash .bb-env-teardown.sh` manually before you delete a test worktree.
   Confirm that repeated runs do not fail or remove shared resources.

## Fresh project clones on machines

Core applies the same setup and teardown policy when a project checkout is freshly
cloned onto a new machine and the environment provider reports that it owns the
checkout. `.bb-env-setup.sh` must succeed before the environment is ready.
`.bb-env-teardown.sh` runs before removal with its own 15-minute timeout; a failure
is reported but does not prevent removal. A user-maintained checkout attached to
BB remains unowned and runs neither hook.

Fresh machine clones do not apply `.worktreeinclude`, because the new host has
no local source checkout; supply local files and secrets through Machine
environment settings. Restoring a machine filesystem does not rerun
`.bb-env-setup.sh`.
