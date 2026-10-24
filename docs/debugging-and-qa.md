# Debugging And QA

Claude native activity receipts are accepted only from the current live terminal binding with its bearer credential. Recording the first native session needs a live terminal too, and the check runs before the binding is written, so a stale credential of an exited terminal leaves the binding empty. Hook evidence is used only when its `session_id` matches the control-plane assigned session. For active native threads whose provider reports activity, a receipt newer than 90 seconds is shown as confirmed; absent or older evidence is shown as **Activity not reported**. This is a display diagnostic: it leaves the durable thread status active and never marks unfinished work successful, failed, or stopped. A receipt confirms that the holder reported activity, not that Claude or a tool made progress, and it cannot identify a holder that remains live while stuck. A holder that predates this protocol cannot report, but an authenticated agent tool call bound to the current terminal and provider session is shown separately as **Agent tool call seen**; it never counts as a running turn. Holders refresh their credential on reattach, so a daemon reconnect does not silence new-code holders. From the moment the server starts replacing a thread's native terminal it revokes the stored credential of the old terminal: a report with it is answered 401 and changes nothing, even while the replacement terminal is still being created; when the replacement cannot be created the old credential is restored, so the old holder can report again, and when it succeeds only the new credential is stored. The gate is unconditional: every activity report must carry the current credential of the native terminal this thread is bound to. The gate requires the thread's terminal to be live or to await its reattach: a current-credential report from a running or disconnected terminal, or from a terminal that a daemon disconnect exited and that awaits its reattach, is accepted and still settles the turn, and only a terminal that has not exited (running or disconnected) has its report stamped as confirmation; a report with the stored credential of a terminal that exited for any other reason (process exit, user close, environment destroyed), of an archived thread or of a thread with no terminal is refused with 409 `native_terminal_not_live` before any state changes (a thread whose environment is unavailable is still accepted). A report with a missing, stale or other-thread credential changes nothing (no Working, no turn settlement, no question opened or closed, no title, no evidence stamp, no binding move) and is answered with 401 `native_terminal_credential_invalid` and a server warning. A holder that predates this protocol reports without a credential, so after this change its thread stops reporting activity and shows **Activity not reported** until the thread is reopened (`/exit` in the terminal, then `bb thread native <id>`); a question that was pending at that moment must be asked again. A report sent with a new credential before the server has stored its hash is rejected the same way; An activity report may carry two optional fields. `closes` lists the native question ids the report closes: omitted, the report closes no question (an older server treats an omitted list as close-everything-not-listed, but this server does not, so a report that was stripped of the field for an old server and reaches an upgraded server late cannot end any question, including one opened after the report was made); an empty list closes none; a populated list closes exactly the named questions that are still open on this thread and nothing else, so a report that arrives late cannot end a newer question. A holder sends it on every report, computed at send time from the questions it has reported and not yet seen closed (a report whose delivery timed out stays counted as possibly open, so the next report carries the close). Each permission prompt gets its own id, the tool name, a random per-holder-process nonce (16 hex characters from the system random source; it is not a credential and is not derived from one, and because it is part of every question id it appears wherever ids are logged, for example in the server's already-handled warning) and an occurrence number (`permission:Bash#<nonce>.2`; the visible prompt text still names the tool), so a holder that resumes the same session cannot collide with the ids of the previous holder, and a close names the occurrence its own tool call opened (see the hook correlation below). `confirms: false` (omitted means true; the default is filled once at the route) makes the server reconcile the questions as above but, instead of stamping the evidence time, clear it when the report closed at least one open question and no newer time was stamped, so the thread shows **Activity not reported** at once and the next real report or heartbeat confirms it again; a delayed or duplicate one finds nothing to close and clears nothing. The holder sets `confirms: false` only on the report that resolves a question it retained while it knows an open question was dropped from its holding bound; from then on it never restores Working from a close, and stays unconfirmed until the next prompt or idle report. When a new terminal is bound to the thread the server ends the questions of the previous binding, because a holder that names what it closes would not. When a report names an id that has no stored question yet, the server writes an interrupted tombstone row for it (one row per name, at most 8 names per report because the request schema caps `closes` at 8, packages/server-contract/src/api/native-terminal-threads.ts) and retags a question that a daemon restart had interrupted as answered, so a waiting report that was delayed on the wire is refused by the existing already-handled rule and a daemon-restart replay cannot revive it; this is stored in the database and survives a server restart (power loss is not claimed). The ids the registry refuses are cached per thread for the server's lifetime and that cache is dropped when a new terminal is bound. Each hook event is published as its own record: the generated hook command (only sh, mktemp, cat, ln, mv and rm) writes the event's input to a private temp file in the launch's spool directory under the system temp directory, then publishes it with `ln`, which fails if the name exists, under the next free 12-digit sequence number, retrying the next number only when the name exists, so concurrent hooks never overwrite or interleave each other and every record is whole. The holder reads strictly in sequence order and waits for a missing number, because it may simply not be published yet. A gap that is still open after 10 seconds while later numbers exist is counted as lost evidence and then skipped, so a permanently missing record cannot keep every later question (Needs input) unread. Before the reader moves past a missing number it reserves that exact name with an exclusive create (at most 64 per scan, never deleted, never overwritten); a publisher that read a stale hint therefore gets EEXIST on the reserved name from `ln` and publishes at the next free number, which is read in order, and if a publisher wins the race (the create finds a complete record) that record is read normally instead of skipped. Content that an outside writer puts into a reserved number is counted as lost evidence, truncated and never applied; no path of this holder's own writers lands a record behind the cursor, including on a network file system whose lookup cache is stale, because the exclusive create is decided by the file system and not by a cached lookup. A record that exists but cannot be parsed, a leftover temp file whose process is gone, and such a gap are counted (`activity-hook-identity-unconfirmed`, reason `unreadable-record`, with a running count) and treated as lost evidence, never as evidence that nothing is pending: Working reports and heartbeats are withheld until the next prompt or idle report. The reader truncates consumed records but does not delete them; the holder removes the whole directory when it exits. The reader never lists the whole spool directory in one step: each maintenance tick (the reader is polled every 750 ms and scans when 2 seconds have passed, so a tick is about 2.25 s) reads at most 4,096 entries from an open directory cursor (`opendir`), resumes where the previous tick stopped and starts a new pass after a complete one, so the work per tick is bounded however many consumed files the launch has accumulated (consumed files are truncated, never deleted or renamed), and a ready next record is read at the next normal poll whatever maintenance is doing. A pass inspects every entry for abandoned temp files and learns the highest published number; the advisory `.hint` file only adds an early positive signal (a hint ahead of the cursor while the next file is missing and the file it names exists) and is never used to skip inspection, because it can regress under concurrent writers. A gap, a reservation, a late record in a skipped number and an abandoned temp file are therefore still found. While the next file is missing, each tick also stats the next 64 numbers after it (at most 64 failed stats), independent of the directory cursor, and treats the first one present as the highest published number, so a nearby gap is skipped after the same 10-second wait as before whatever the hint says or the pass is doing. A gap more than 64 numbers ahead that the hint does not show, and an abandoned temp file, are found when the pass reaches them: N/4,096 ticks for N consumed files (UNPROVEN estimate for a launch with 150,000 files: about 37 ticks of 2.25 s, about 83 s, about twice that if the entry was just behind the cursor). Once a gap target (the highest number seen) has been seen, it is kept until the reader's next number reaches it or the file at the target is reported missing (the only place it is cleared; that case is counted once per target number as lost evidence, together with the gap that leads to exactly that number (a gap toward a nearer file is counted separately), and makes no reservation of its own toward the target (the set of counted numbers drops an entry once the reader's next number passes it), while any other stat error keeps the target; a hint whose file does not exist is never a target, which costs at most two extra stats per tick), so a hint that regresses meanwhile neither restarts the 10-second wait nor counts the loss twice; a published next file or a reservation that meets a published file keeps a target that is still ahead and restarts only the wait and the count for the following gap. Skipped numbers are re-probed for late content by name, at most 256 steps per tick (a probe, or the move past one skipped range), from a position (range and number) that persists across ticks and wraps, and adjacent skipped ranges are merged, so the work of a tick stays capped however many ranges the launch has accumulated and every skipped number is re-probed in turn. The reader opens every spool, late and append file with `O_RDONLY | O_NONBLOCK | O_NOFOLLOW`, checks the open descriptor with `fstat` and reads and truncates only through a descriptor of a regular file, so a name swapped for a FIFO, a socket or a symlink can neither freeze the holder's event loop nor be followed: it is counted once as lost evidence (Working withheld), never read and never removed, and a numbered spool name that holds one stays occupied, so a publisher moves on to the next number. Truncating a consumed file opens it a second time by name, so it proceeds only when that descriptor has the same device and inode as the file that was read, is a regular file and, for late files, has a link count of 1 (the spool does not require a single link: the publishing hook's temp name still links the file until it removes it); otherwise the file is left as it is, counted once, and a replaced file is read again on the next step or poll. The append reader takes its size snapshot from the descriptor it reads and remembers the device and inode of the last regular main file and what the last observation was. Each episode in which the main file is not a regular file, or cannot be opened, is counted once (a different non-regular object counts as a new episode), and a return to the same regular file, for example after a transient open error or after the original is put back over a FIFO, neither replays it nor counts again. The reader restarts from offset 0 and counts once when the regular file's inode changes directly from another regular file, or when the file is smaller than the read offset (truncated); when a different regular file follows a non-regular episode it restarts from offset 0 without counting again, because that episode was already counted. Residual (open, not accepted): a delete and recreate that reuses the same inode at a size not below the offset is not detected, and neither is a rename back of an earlier main file after another file took its place (the original K1 is renamed aside, a file K2 is put in its place, then K1 is renamed back: the reader re-reads K1 from the start, and each step is counted as an episode or a change). Both need an outside actor inside the private 0700 hook directory, such as a temporary-file cleaner that removes the main file, which links to the pending runtime question of whether a cleaner can delete the hook directory during a long idle session. Three behaviours differ from before: a late file that does not parse is now truncated after it is counted; an open error of the main file other than a missing file is now counted; and a symlinked main file is now refused instead of followed. This needs hard links on the directory's file system, which the usual local ones on macOS (APFS), Linux and WSL2 (ext4, tmpfs) provide. The holder probes with a real link and picks the first private candidate that supports links: the system temp directory, then `XDG_RUNTIME_DIR` when it is set, absolute and owned by the user, then a 0700 directory `hooks` under `~/.bb/native-terminals` (the directory the holder socket already lives in); a candidate on a network file system (NFS, SMB/CIFS, 9p such as WSL DrvFs, FUSE, AFS, Ceph, Coda; detected from the statfs type on Linux only) is tried after the local ones. It creates its launch directory in the first candidate whose real link probe succeeds (a directory whose probe failed is removed and never selected) and removes only its own launch directory at exit wherever it is. If no candidate supports links it falls back, as the last resort, to one append file in its own private 0700 directory, with the appenders serialized by a lock named `hooks.lock` and logs `activity-hook-spool-append-fallback` once. The lock is a symlink created with `ln -s` (atomic and exclusive); its target records the holder as `<pid>:p<start>` (the start time in clock ticks, field 22 of `/proc/<pid>/stat`) or `<pid>:s<start>` (the `ps -o lstart=` text with spaces replaced by underscores, where `/proc` is not readable; it keeps the colons of the clock time, so the reader takes the pid up to the first colon and the rest as the start), or only `<pid>` when neither can be read; the hook accepts it only if `hooks.lock` is then a symlink whose target (`readlink`) is exactly that record, because `ln -s` onto an existing lock directory, or onto a symlink to a directory, succeeds by creating its entry inside it, and the lock may have been released and taken by another hook in between: otherwise the hook removes only its own entry and keeps waiting. Where symlinks are unsupported the lock is a directory created with `mkdir` that holds a `pid` file, and a lock directory with no pid yet counts as held by a live process. A hook takes the `mkdir` lock only when `ln -s` has failed three times in a row while the lock was absent and it has never seen the lock as a symlink, so a symlink lock that is merely released between two checks cannot turn into a directory. The directory lock is taken with a single `mkdir hooks.lock`, which is atomic and refuses an existing name on every POSIX file system, and its `pid` file is then created exclusively (noclobber, so the create fails if the file exists) and read back to confirm it names the hook itself; a hook that cannot create it exclusively does not own the directory and never writes into it. An earlier version created the directory under a private name and renamed it into place after checking that `hooks.lock` was absent; that check and the `mv` were two steps, and `mv` onto a directory that appeared in between nests the source inside it (and `mv -T`, which refuses to, does not exist on macOS and BSD), so the rename was dropped rather than guarded. A directory without a `pid` file is therefore normal for the moment between `mkdir` and the write, and is never reclaimed at once: a waiter reclaims one only after it has watched the same directory (the same inode) without a `pid` for more than 2 seconds, and then only with `rmdir`, which refuses a directory that has any entry, so a winner that has just written its pid is never removed; a winner that stalls past the grace period, whose directory was reclaimed and taken by another hook, wakes up to a `pid` file that exists, fails its exclusive create and tries again, so only one process can ever own a lock directory's pid. A hook that can create symlinks and finds a lock directory with no `pid` file removes only its own entry and applies the same rule. A hook releases only what it owns, once: it reads the `pid` file and, only if it names the hook itself, removes that one file by name (never a glob) and then runs `rmdir` once, never retrying; a symlink lock is removed only if its target is the hook's own pid. While the hook's pid file exists nobody can reclaim or take the directory (reclaim touches only directories without a `pid`, and the exclusive create fails), so the check and the removal cannot race a new owner. If the hook was paused after removing its pid and another hook reclaimed and took the directory meanwhile, the single `rmdir` fails on the new owner's `pid` and leaves the directory alone; if the lock was moved away by the reader and replaced, the owner check fails and nothing is removed. An entry that another hook's `ln -s` created inside the directory at that moment makes the `rmdir` fail and leaves a directory without a `pid`, which waiters reclaim after more than 2 seconds. Only `sh` and the tools already used (`ln`, `mkdir`, `rm`, `mv`, `cat`, `printf`, `sleep`, `readlink`, `date +%s`) are needed, no `flock`. Each hook creates a marker `.tmp.<pid>.mark` first, reads its whole input, takes the lock, appends the record and its newline while holding it, removes the marker and removes the lock. A hook that cannot take the lock polls every 0.05 s (every second where `sleep` takes no fractions) until a wall-clock deadline of 20 seconds from its start, read from `date +%s` on every iteration: Claude Code's hook timeout is 60 seconds by default, so the deadline leaves room to read the input and publish, and a permission prompt that is waiting for its own hook is delayed by at most that long behind a stalled holder. At the deadline it writes the record it holds in memory to its own temp file and renames it atomically to `.late.<pid>.<start second>`, then removes its marker; only a hook that cannot even write that file renames its marker to `.lost.<pid>`. Records therefore never interleave and cannot hide inside each other (for example an empty `permission_suggestions` array in a long record). Only the reader breaks a lock that a hook owns, never a hook, and it never moves or renames a lock. A lock is stale only when the holder it records is gone: its pid is not alive (checked with signal 0; a process we may not signal counts as alive), or the pid is alive but its start time differs from the recorded one (a reused pid; the two start times are compared only when both are the same kind, `p` or `s`, and an unreadable start time counts as the holder being alive). There is no age rule for a lock whose holder is alive: a hook that is paused for any length of time (SIGSTOP, laptop sleep) keeps its lock until it resumes or dies, and a lock that records no start time (written by an older hook, or on a system where neither source is readable) is judged by the pid alone. A text whose first character is a digit always names its holder: its pid is the leading run of digits, whatever follows (so every record a hook writes parses, a partial write such as a truncated pid is judged by that pid, and a live holder's lock is never removed by age); a start that is not `:` followed by exactly one of the two forms the hook writes (`p` and the process start ticks from /proc, or `s` and the five fields of the `ps -o lstart=` time, weekday, month, day, `hh:mm:ss` and year, joined by single underscores) is ignored and counts as alive, so `<live-pid>:pgarbage` keeps its lock; only a lock directory without a pid file, or with a text that does not start with digits, is removed by age, after 10 minutes (600,000 ms, `ORPHANED_LOCK_AGE_MS`), because no holder can be identified, and that cannot create a second holder because a hook holds the lock only after it has read back its own exact record, so a hook whose pid file was removed reads back nothing and tries again; hooks reclaim a pid-less directory themselves after more than 2 seconds. For a directory lock the reader re-reads the pid file and, only if that still holds the text it read, deletes that one file and runs `rmdir` once; if the `rmdir` fails another hook took the directory and it is left alone. For a symlink lock it re-reads the link and unlinks it only if the target is unchanged. For a stale holder nothing can change what the reader read in between: the pid file is created exclusively and a symlink lock occupies its path, so no other hook can create either while the old one exists, and only the dead owner or the one reader of that append file remove it (the reader is single: the append file lives in a directory created per holder capture and is read by that holder's one reader). The reader counts the break as lost evidence. A live holder is never broken, however slow. On every poll the reader takes a snapshot of the main file's size, reads the new late files, applies the late openers, and only then applies the main-file lines up to the snapshot; lines past it wait for the next poll, so a close can never be read before the late file of its opener. It counts each late file as lost evidence, so Working and heartbeats stay withheld until the next prompt or idle report, but it applies the record itself only if it opens a question (a permission request) and no close of the same tool was applied here at or after the hook's start second and the turn was not cleared after it: a permission request blocks its own dialog, so its close can only follow after the hook published. A late close or a late state change is never applied. Needs input therefore arrives up to about 20 seconds late, not lost. The reader also counts, once each: a `.lost.<pid>` marker at once; a `.tmp.<pid>.mark` marker whose process is gone (a hook killed before it appended, or a failed write); a broken lock; a line that stays without its newline for 10 seconds, which is still read normally if it completes later; and any line it cannot parse (for example the torn bytes of a killed writer joined by the next record, when neither record is applied). Residuals on this path: a hook killed before it publishes (or one that cannot write its late file) loses its record, always counted; a hook killed without giving up is recognised as dead by its pid, so if that pid is reused the count can take up to 10 minutes; a hook that is paused while holding the lock blocks the other hooks until it resumes or dies, which they bear by waiting 20 seconds and publishing late files (of which only permission openers are applied, the rest being counted as lost evidence); hooks, the CLI and the holder are assumed to share one pid namespace (a sandboxed-hook future would make every holder look dead and break its lock); a lock directory whose hook was killed before it wrote its pid blocks appends until the 10-minute bound, which delays records (waiters publish late files after 20 seconds) rather than losing them. Open findings on this path (not accepted, user-visible, tracked under Q1/D1; each needs the append last resort and a lock stalled for 20 seconds or more): (a) a late opener is refused, still counted as lost evidence, when a close of the same tool was applied at or after the hook's start second (for example a concurrent auto-allowed call of that tool), so Needs input is lost while the CLI is waiting; the condition can be dropped once D1 proves that Claude Code waits for every permission request hook before the dialog and before acting on another hook's decision, which its documentation does not state; (b) a late close is never applied, so a question that was answered through a late hook stays open, with Activity not reported, until the next prompt or idle report; (c) the comparison is in whole seconds: a close in the hook's start second refuses the opener, while a clear in that same second does not. Only if not even that file can be created does it log `activity-hook-spool-unsupported`, install no hooks and mark the hook history permanently incomplete for the launch: the reader then withholds every Working report and every heartbeat, so the thread shows **Activity not reported** and never a Working that a waiting permission prompt could contradict (the transcript has no permission-request record). If a hook cannot create its temp file (`mktemp` fails: no inodes, no file descriptors, no `mktemp`), it appends one byte to the spool's `.loss` file with one shell-builtin `printf x >>` before it exits (one `O_APPEND` write of one byte is atomic on a local file system, so concurrent hooks each add exactly one byte and none overwrites another; on a network file system, which is tried last, the count can be low but the file still grows), and the reader counts the file's growth on each scan as lost evidence (`unreadable-record`), so Working reports and heartbeats are withheld and the thread shows Activity not reported, whichever event was lost (a lost permission request included). On every scan the reader also creates and removes a probe file in the spool and counts a change to cannot-write (ENOSPC, EDQUOT, EACCES, EPERM, EROFS, EMFILE, ENFILE) once as lost evidence, which covers a spool where not even the one-byte append can succeed. Residual: a failure that begins and ends between two scans (2 seconds) and in which the mark cannot be written is not seen. Native Windows is not supported for this: native-terminal mode cannot start there today (its start command is POSIX shell text that the Windows terminal passes to PowerShell) and the hook command needs a POSIX shell with those tools. Hook correlation (Claude Code): the hooks reference documents that `PermissionRequest` carries `tool_name` and `tool_input` but no `tool_use_id`, while `PreToolUse` (which runs before every tool call, whether or not it needs permission), `PostToolUse`, `PostToolUseFailure` and `PermissionDenied` do. The holder therefore records every `PreToolUse` call (its `tool_use_id`, tool name and a SHA-256 of the canonical `tool_input`, at most 256 calls, dropped when the turn is cleared) and, when a permission prompt arrives, binds it to the oldest unbound call of the same tool whose input fingerprint is equal, so the prompt carries that `tool_use_id`. A completion closes the open prompt of its own `tool_use_id`, whatever a hook did to the input afterwards. Only when the completion's call was never announced (an older holder, a lost or late `PreToolUse` record), or was announced with a different input, does it close the oldest unbound prompt of that tool with an equal input fingerprint. A completion with no `tool_use_id` and no `tool_input`, a completion of a call that was announced but never prompted (an auto-allowed call), and a completion that matches no prompt close nothing: the question stays Needs input until a report that names it or the turn ends, which is the failure the user would see instead of a wrong close. Two open prompts for the same tool with the same input are indistinguishable to the user, so closing either one is correct. When another `PreToolUse` hook rewrites the input with `updatedInput`, the permission prompt and the completion both carry the rewritten input while the announced call carries the original, so no announced call binds the prompt; the completion then closes the oldest unbound prompt of that tool with an equal input fingerprint, because its input differs from the announced one. A completion whose input equals its announced call's input (an auto-allowed call) never takes that path. Codex is unaffected. A server that does not know the fields answers 400 `invalid_request` naming them. The holder then retries that one report once without exactly the fields the message names (same credential, thread, state, prompt and questions) and remembers nothing about the server, so the next report tries the fields again. The retried report omits `closes`: an old server closes by its own rule, and a server upgraded between the rejection and the retry closes nothing for it. A holder keeps its last non-heartbeat report that the server did not accept for a transient reason (401, 408, 429, 5xx, a client timeout or a transport failure; one report, replaced by any newer one) and resends it on the next credential refresh or heartbeat tick; any other refusal is dropped. When the CLI rotates its own session id in-process (for example a context reset), the holder follows the new id only through the provider's own continuation record: the last 64 KiB of the bound transcript must contain a record the provider declares as a continuation (Claude: `continued-in`) whose next-session field equals the session id the hook reports, that id must look like a session id, must never have been left before, and must have its own transcript file, and the holder must have followed fewer than 256 moves. Hook records that arrive before the continuation record exists are held (at most 64 records, 60 seconds) and applied once it appears; a foreign session without a matching continuation record, or past the 256 limit, is never followed and the thread shows **Activity not reported** once its last receipt is older than 90 seconds. The holder then moves the thread binding with `POST .../native-terminal/session` carrying `replacesNativeSessionId`, and it publishes nothing for the new session until the server recorded the move: the new session's hook records are held (at most 64, the overflow rules of discovered sessions apply), replayed once after the move is recorded, and dropped without being reported after a permanent refusal; the server accepts it only for the current live holder credential, only while the replaced id is still the stored one (compare-and-swap), and never for a session another thread holds. A move the server cannot take yet (401, 408, 429, 5xx, a terminal that is not live, a fetch transport failure) is retried on every heartbeat tick and credential refresh; any other refusal or unexpected failure is permanent: the holder stops reporting and confirming and logs `activity-session-rebind-refused` with the code, so the thread shows **Activity not reported** once its last receipt is older than 90 seconds. Every hook record that is still dropped for its session identity is logged by the holder as `activity-hook-identity-unconfirmed` with its reason and a running count; each adoption is logged as `activity-session-adopted` and each move the server could not take yet as `activity-session-rebind-deferred` with its status and code.

A Codex session that a holder started before this change discovers is not recorded until the thread is reopened (`/exit` in the terminal, then `bb thread native <id>`), because recording a session now needs the holder's credential; threads that already have a recorded session are unaffected, and a holder that has a credential stops asking after a permanent refusal (logged as `session-discovery-stopped`).

The provider's `sessionIdField` travels in the server's native-terminal launch response to the `bb` CLI holder; it is not a host-daemon session, WebSocket, or RPC field, so this change does not increment `HOST_DAEMON_PROTOCOL_VERSION`. The strict provider declaration parser runs on the server and must ship with the provider declaration; an older server parser does not accept a newer declaration containing this field, and daemon protocol negotiation cannot fix that mismatch. A new server rejects the activity reports of an older CLI holder because they carry no credential, so that thread shows **Activity not reported** until it is reopened. Updating the host daemon does not replace a CLI process that is already running: confirmation requires that holder to end and its owner to start a new native session with a compatible CLI. An older server does not send the new runtime diagnostic, so a newer app retains its prior display behavior; an older app may continue to show **Working** from the old runtime data even when the new server reports unconfirmed activity (**Activity not reported**).

- `pnpm dev` and `pnpm start:worktree` save the absolute source checkout path in `<data dir>/bb-dev-instance.json`. Storage reports use this record to identify development data even after the checkout is removed. Older instances can be identified from `bb-app-runtime.json` or hash-verified path matches; unknown source paths are reported explicitly.
- `pnpm dev` prints the active frontend URL, server API URL, host daemon port, data dir, and logs dir. Do not assume fixed dev ports.
- `pnpm mobile:apk:dev` builds a standalone ARM64 Android APK at `apps/mobile/build-output/bb-dev.apk`, named **bb dev** with an orange icon and separate package/data from the installed app. Append `-- x86_64` for an Intel emulator. See [the mobile build instructions](../apps/mobile/README.md#android-local-apk-and-verification) for prerequisites, installation, and per-thread delivery.
- `pnpm start:worktree` builds production artifacts and serves the optimized app bundle from the checkout-specific dev server URL, while keeping the same dev data directory and deterministic server/host-daemon ports. It has no Vite dev server or hot reload.
- `pnpm start:worktree-remote` is the trusted-network variant of `pnpm start:worktree`; it binds that server to all IPv4 interfaces.
- `pnpm desktop` packages the Electron app and launches it against the installed data directory, ports and Electron user-data directory, the same targets a released build uses. It shares the single-instance lock with an installed bb: quit that first, or the launch focuses it instead of starting your build.
- `pnpm desktop:worktree` packages and launches it against this checkout's data directory and deterministic ports, the same instance `pnpm start:worktree` uses, with Electron's user-data directory at `$BB_DATA_DIR/desktop` (override with `BB_DESKTOP_USER_DATA_DIR`). Like `pnpm start:worktree`, it skips first-run setup unless `BB_SKIP_ONBOARDING=0`. It refuses to start when the server or host-daemon port is busy, so a stale server cannot answer for your build. It shows the dev Dock icon while running (`BB_DESKTOP_DEV_ICON=1`). Set `BB_DESKTOP_OPEN_DEVTOOLS=1` to open DevTools. Both desktop commands always repackage first; machines without a Developer ID identity produce unsigned artifacts.
- The packaged app defaults to server/frontend `:38886`, host daemon `:38887`, data dir `~/.bb/`, and logs under `~/.bb/logs/`.
- `bb-app` (including `pnpm start`), `bb-server`, and `bb-host-daemon` capture service stdout and stderr in `logs/server-stdio.log` and `logs/host-daemon-stdio.log` under the selected data directory. Each writer owns separate log segments capped at 10 MiB; the five newest completed segments per log family are retained. The named `.log` file is a hard-link view of the newest writer segment. These contain startup errors, crashes, and other output that bypasses the logger; application log lines go to rotating `server.N.log` and `host-daemon.N.log` files. Use `tail -F` on the named `.log` file and inspect matching `.backup-*` files for earlier output. Service output is not forwarded to the launcher's terminal.
- Entity IDs in URLs (`proj_*`, `thr_*`) are primary keys. Query them directly against the active data dir: `sqlite3 <data>/bb.db "SELECT * FROM threads WHERE id = 'thr_xxx';"`.
- API routes are under `/api/v1/`, for example `GET /api/v1/threads/:id`. Use `curl` against the server API to isolate frontend issues from server behavior.
- Use the CLI to inspect state: `pnpm bb thread show <id>`, `pnpm bb project list`, `pnpm bb status`. From source, use `pnpm bb:dev`.

The desktop main process also writes rotating `logs/desktop.log` immediately,
including updater, Connect, and startup errors. View → Local Logs is available
on every desktop platform and when attached to an existing server; it follows
local desktop, server, and daemon files in the selected data directory.

## Desktop Browser Tab Recovery

When the desktop app connects to a BB Connect server, it installs and renews
the Connect desktop session in both the app and embedded browser cookie stores.
This also authenticates shared-port links under the same Connect domain. The
browser keeps its separate profile; unrelated site cookies are not copied.

Desktop browser registration first uses a private local broker descriptor whose
recorded server URL matches the selected server's origin. Otherwise it discovers
the other private local broker descriptors and sends a fresh random challenge to the selected server's `/api/v1/desktop-browsers/broker-proof`
endpoint. The server routes it to the descriptor's enrolled host, whose broker
returns an HMAC using its local authentication token. The desktop verifies that
proof against the private descriptor before registering; the token never leaves
the machine. This works for alternate domains and proxies without hostname rules
or plugin dependencies. Redirects and invalid proofs are rejected. This internal
desktop handshake adds `desktop.broker.prove` in daemon protocol 248. Older
protocol-246/247 daemons remain compatible for existing operations; the server
rejects proof requests for those daemons with an upgrade-required error before
sending any RPC. Failed lookups retry with exponential backoff from 2 seconds up
to 1 minute.

Saved desktop browser tabs keep their URL and owning host/window. Opening one
in the desktop app attaches the existing view when that window still owns it,
including after its connection generation changes. While the desktop or host is
reconnecting, the panel retries for about a minute, then offers Try again.

The desktop keeps at most four hidden user browser pages resident across
windows and servers, and evicts the renderer of any page hidden or unused for
five minutes. A sweep runs every 30 seconds while hidden user pages exist; the
least recently hidden or used pages are evicted first. Visible pages, agent-created
tabs, downloads (including paused ones), control leases, attached debuggers,
in-flight evaluations and captures, and pages with open popups are never
evicted. An evicted (cold) tab keeps its identity in native tab lists and broker
snapshots. Showing it, navigating it, evaluating, capturing, or leasing it
restores its navigation history in the same browser session; in-page
JavaScript state is lost. Hiding, moving, stopping, focusing, searching, or
closing a cold tab does not restore it. CDP targets cover only resident pages,
so a cold tab leaves the target list until it is restored.

Archiving a thread evicts its hidden pages in each desktop window at once,
including agent-created tabs and pages with downloads; a page on screen is
evicted once it is hidden. Control leases, attached debuggers, open popups, and
in-flight evaluations or captures still keep a page until they end. Evicted
tabs keep their saved tabs and restore like any cold tab. Unarchiving stops the
immediate eviction and leaves the thread's pages to the idle rules above.
Archive state reaches the window as realtime thread changes, so each time the
window's realtime connection opens, including after a reconnect or a server
switch, it re-reads the archive state of every thread with pages in that window.
An archive or unarchive made while the window was disconnected applies then.

Switching servers hides each server's native pages and popups, pauses media,
and revokes automation leases. Returning to the same server origin reattaches
resident pages with their unsaved state; cold pages restore from history when
shown. Native tab lookup, page events, and broker snapshots stay scoped to the
active server. Closing the window or quitting the desktop app still releases
its pages across all servers.

After a window closes or the app relaunches, the panel reopens the saved URL in
the current window on the same host once the host confirms the old window is
gone. Native history and unsaved page state are not restored. The desktop broker
suppresses teardown snapshots from destroyed windows so closing a window does
not delete its saved tabs before another window can recover them. The server adopts
the restored tab from the window's browser snapshot and closes competing restored
views if two windows reopen it concurrently. Snapshots from a stale restoring
generation cannot adopt the tab. A newer snapshot from the same window and
thread cancels a pending adoption, including when the newer snapshot is empty.

Web clients, other hosts, and other live windows show the saved URL and its
availability instead of attaching a native view. Copy link remains available;
Open in browser accepts only HTTP(S) URLs. The panel's tab close control also
works in this state. Selecting another saved tab rechecks its owning window;
Try again also rechecks a window previously reported as live after it closes.
Inspect the persisted owner with
`bb thread tabs show <threadId> --json` or `sdk.threads.tabs.get`, and compare it
with `bb browser instances --host <hostId> --json` or
`sdk.experimental_desktopBrowsers.listInstances`. Recovery uses the existing
native snapshot and browser APIs; no daemon wire fields change.

Browser tab favicons retain their candidates across same-origin navigation. The
native desktop manager caches candidates for the 40 most recently used HTTP(S)
origins per connected server; returning to an origin or reopening its tab can
reuse those candidates. Same-origin candidate updates retain earlier candidates as fallbacks, and empty
updates leave the known icon intact. Crossing to an uncached origin clears the
previous icon. The cache is in memory and ends with the desktop process.

The preload browser `onState` subscription immediately replays the latest
validated state for up to 100 recently updated tabs before forwarding live
updates. This lets remounted tab headers recover without waiting for a new
favicon event. Renderer image-size measurements are also bounded and reused
so remounts retain the appropriate Retina candidate. Image bytes still load
through the renderer's browser cache; authenticated icon fetching through the
embedded browser session is not implemented by this cache.

## Log Fields

- `Slow DB query` is logged when a prepared statement, `exec` batch, or
  complete transaction takes at least 100 ms. `durationMs` is elapsed time and
  `cpuDurationMs` is CPU time on the calling thread; a large gap means waiting
  or descheduling (filesystem I/O, lock waits, or scheduler contention), not
  necessarily slow SQL. `operation: "transaction"` covers the callback, commit,
  and rollback, and its SQL label is the transaction mode; statements inside it
  may log separately, so do not add their durations. Commits can include
  SQLite's automatic WAL checkpoint. SQL string literals are redacted and
  parameter values are never logged.
- Connect's `tunnel closed` warnings include the last transport error's message
  and code, `connectedDurationMs`, and `lastHeartbeatAckAgeMs`. A null duration
  means the opening handshake never completed; a null acknowledgement age means
  no heartbeat acknowledgement arrived on that connection. They also carry the
  Cloudflare `colo` and `ray`, and `traffic`: open HTTP and WebSocket streams,
  bytes each way, how long each direction had been quiet, and bytes still
  buffered. `tunnel connected` and `handshake timed out` lines carry dial
  timings in milliseconds since dialing: `lookupMs`, `connectMs`, `tlsMs`, and
  `upgradeMs` (the gate's 101). A timed-out dial with `tlsMs` but no
  `upgradeMs` reached Cloudflare and was waiting on the gate. They appear in the
  server logs and `<dataDir>/plugins/connect/logs/plugin.log`.

## bb Connect Gate Events

The gate answers every proxied request within the response-head timeout (30 s,
90 s for voice transcription) from when the Worker receives it; a miss gets a
504 naming the stuck stage: `routing`, `tunnel-object`, `request-body`,
`response-head`, or `finishing`. Workers Logs keeps only about 1% of gate
requests, so the gate also writes these to the Analytics Engine dataset
`bb_connect_gate_events` (`bb_connect_gate_events_staging` on staging):

- `blob1` `stall` (a 504) or `slow` (a tunnel dial unanswered after 3 s);
  `blob2` stage, `blob3` method, `blob4` host, `blob5` path; `double1` elapsed
  ms; `double2` tunnel-object attempts (above 1 means the object restarted and
  the dial was replayed).
- For a stall that reached the tunnel object, `blob6` is the tunnel state
  (`connected`, `disconnected`, or `unknown` when the object did not answer
  within 2 s) and `double3` the age in ms of the last answered heartbeat, or
  -1. A bb heartbeats every 20 s, so an age of minutes means a dead tunnel the
  object still holds; a recent age means the bb's server did not answer.
  Routing stalls and `slow` events leave `blob6` empty and `double3` at -1.
- `blob1` `tunnel-gap` is written when a server's tunnel opens after a period
  with none: `blob2` is how the previous tunnel ended (`closed`, `lost`, or
  `unreported`), `blob3` is `replaced-live` when that tunnel had replaced a
  working one, `blob4` host, `double1` ms without a tunnel, and `double2` the
  previous tunnel's lifetime (-1 when unreported). `replaced-live` with a short
  or unreported previous tunnel is a bb whose abandoned dial replaced its
  working tunnel; `double1 + double2` near 300,000 means it then waited out the
  five-minute takeover backoff.

Query with the Analytics Engine SQL API and an Account Analytics Read token,
for example `SELECT timestamp, blob1, blob2, blob5, double2 FROM
bb_connect_gate_events WHERE blob4 = '<handle>.getbb.app' ORDER BY timestamp
DESC`.

## Reproducing Test Order Failures

CI's test shards shuffle test files and tests within each file. Vitest prints the seed for
runs that execute; unchanged Turbo tasks can still reuse cached results.
Reproduce a failing package with its logged seed:

```bash
pnpm exec turbo run test --filter=@bb/app -- --sequence.shuffle --sequence.seed=4721 --maxWorkers=2
```

For a repository-wide order audit, omit the filter and use `--concurrency=4`
before Turbo's `--` separator. CI caps each Vitest process at two workers so
package concurrency does not multiply into unbounded worker contention.
Use a second seed after
repairing order dependencies. Reset test-owned mock implementations, fixture
arrays, persisted preferences, and databases before each test. Await background
work and close streams, workers, and subprocesses before removing their files or
tearing down their environment. Worker isolation does not restore built-in
process objects or cancel resources that a test leaves running.

## ACP Steer Cancellation Failures

ACP steering cancels the active prompt before submitting the follow-up. If that
prompt returns an error during cancellation, BB marks the session for rebuilding
before the next turn. The replacement process attempts `session/load`; providers
without working session restoration start fresh and report the loss of in-agent
history. The failed turn stays failed, and an unsent steer is not acknowledged as
accepted.

Older Hermes adapters can throw `NoneType.startswith` during cancellation and
leave their internal session marked running. Update Hermes to include
[the null-response fix](https://github.com/NousResearch/hermes-agent/commit/8f0322da5b82029f3bc4d16fbaa2c986299abfc6)
and [the running-state cleanup](https://github.com/NousResearch/hermes-agent/commit/bccd45618c16b605822dd179cd0399abdecaf698),
then restart its retained process with `bb thread stop <thread-id>` before sending
a new message. BB's recovery prevents reuse after a cancellation error; it does
not repair the older adapter's failing turn.

## Machine Authentication Cache

Successful verification of an unlimited daemon host key is cached in server
memory for 30 seconds, capped at the key's expiry. The cache holds at most
1,024 entries and retains only token hashes. Hits neither read nor write the
authentication database and do not extend the cache lifetime. The next request
after expiry uses the existing verifier and updates usage timestamps, so
`lastRequest` and `updatedAt` describe the last full verification rather than
every request. A burst of concurrent cold requests can still perform separate
verifications before the first result is cached.

Revocation and reenrollment invalidate that host's cached keys and prevent
already-running verifications from returning or caching invalidated credentials.
Restarting the server discards the cache. Enrollment keys and keys with quotas,
refills, or enabled rate limiting always use the existing verifier. Direct edits
to authentication rows outside the machine-auth service are observed when the
cache expires; QA that changes a warmed key's database fields must account for
that window. Expiry known when caching is enforced on every hit.

## Terminal Data Plane

Terminal keystrokes and output normally cross the server's main thread, so they
wait behind whatever else that thread is doing. For a host whose daemon supports
it, the server starts one helper process (`terminal-data-plane-child`), and the
daemon opens a second WebSocket to `/internal/terminal-data` that the server
hands to that helper. Browser terminal sockets for that host are handed to the
helper too, and bytes then flow browser, helper, daemon without touching the
main thread. Opening, attaching (replay), resizing and closing a terminal still
go through the server connection.

The server log says which path a host is on: `Terminal data socket attached`
and `Terminal data socket detached`, each with `hostId` and `daemonSessionId`.
The daemon log has matching `Terminal data socket attached` lines. A host stays
on the server connection while its daemon does not answer the probe command,
while the helper is down, or after the data socket failed to open six times in
a row. Every switch between the two paths closes that host's browser terminal
sockets with code 1013 and reason `terminal-output-path-changed`; the client
reconnects and asks the daemon to replay from its last sequence number.

The probe and connect commands are new host RPC commands. A daemon that does
not know a command type closes its server connection, so they ship with a
`HOST_DAEMON_PROTOCOL_VERSION` bump and the server never sends them to an older
daemon.

The fork's recent host-daemon protocol changes are listed in the
[protocol history](fork/host-daemon-protocol-history.md).

The data socket is admitted only with a single-use ticket (15 seconds, bound to
the host and its daemon session, sent over the already authenticated server
connection) plus the daemon's host key, and never with an `Origin` header.

## Slow Database Operations

The server logs `Slow DB query` when a prepared statement, `exec` batch, or
complete transaction takes at least 100 ms. `durationMs` measures elapsed time;
`cpuDurationMs` measures CPU time on the calling thread. A large gap indicates
waiting or descheduling, not necessarily inefficient SQL. It does not by itself
distinguish filesystem I/O, lock waits, and scheduler contention.

`operation: "transaction"` includes the callback, commit, and rollback; its SQL
label identifies the transaction mode rather than containing callback SQL.
Statements inside it may also log, so do not add their durations to the
transaction duration. Commit timing matters because SQLite's automatic WAL
checkpoint can perform filesystem writes and synchronization on the server
thread. `operation: "exec"` also covers maintenance batches. SQL string
literals are redacted and parameter values are never logged.

Only while performance diagnostics are enabled, slow-DB records also include
`diagnostics.resourceUsage`: process-wide deltas for `minorPageFault`,
`majorPageFault`, `fsRead`, `fsWrite`, `voluntaryContextSwitches`, and
`involuntaryContextSwitches`. These are counts, not bytes or durations, from
[Node's resourceUsage](https://nodejs.org/api/process.html#processresourceusage).
They can include activity on other process threads. Unsupported OS counters
remain zero; in particular, zero filesystem counters do not rule out I/O or
fsync waits. Page faults do not identify whether the fault was on the SQLite
mmap, the server heap, or another mapping, and these counters do not measure
swap-in bytes.

`diagnostics.wal.sizeBytes` is the most recent asynchronous sample of the WAL's
physical file size. A slow log with diagnostics enabled requests a refresh at
most once per second per connection, with at most one refresh in flight.
`diagnostics.wal.sampledAt` is the sample's UTC completion time; the log uses
the previous sample, which may be older after an idle period. Both fields are
null before the first sample and for in-memory databases. Missing or
inaccessible WAL files report a null size with a sample timestamp. WAL size
can include space reused by earlier generations; it does not measure uncheckpointed backlog or identify
checkpoint progress. Resource sampling is also disabled with the live gate.

## Pending Question Drafts

Native provider questions and Ask User Question plugin forms save partial
selections, free text, and the current question in browser-local storage under
`bb.question-draft.v1:<threadId>:<interactionId>`. These drafts survive thread
navigation and page reloads on the same browser/device. They are cleared after
successful submission or cancellation and retained if either request fails.
When local storage is unavailable, an in-memory fallback preserves drafts
across navigation until the page reloads. Drafts are not sent to the agent until
submitted, and CLI/SDK answers do not read the browser's draft.
There is no time-based expiry. If an interaction is resolved elsewhere, its
draft can remain in local storage but is never rendered as an active question;
the server's pending interaction list controls that. Clearing browser site data
removes these drafts. Older clients ignore this new storage namespace. Only the
native question form and Ask User Question plugin opt in; secret-request forms
do not use this storage.

## Native Draft Rollback

Migration `0132_thread_drafts` now only adds the temporary `threads.draft`
column. Its original pre-release SQL merged Drafts plugin queue entries into
that column and deleted the held rows and built-in plugin installation. The
original hash remains accepted by `migration-history.ts` for databases that
already ran it; it is not replayed.

Migration `0133_remove_thread_drafts` drops the column without converting its
contents back into queued messages. Databases upgrading through the revised
`0132` retain their existing queue rows and Drafts plugin installation. Databases
that ran the original `0132` lose the stored core draft contents, retaining their
thread rows and any remaining queued messages. The restored built-in plugin is
installed through normal server startup. Reintroducing native drafts requires
a new migration after `0133`.

## Archive Confirmation Counts

`GET /api/v1/threads/:id/child-summary` and `sdk.threads.childSummary` return
`nonDeletedChildCount` for deletion (direct children, including archived rows)
and `unarchivedDescendantCount` for archive confirmation. The latter follows
the same hierarchy, lifecycle-owner, and hidden source-fork edges as
`archive-all`, deduplicates threads, traverses archived intermediaries, and
excludes hidden, already archived, or deleted candidates and the requested root.
Hidden threads still participate in the archive cascade, and visible descendants
beneath hidden threads still count toward confirmation.
The UI adds the root to the displayed total and skips confirmation when no
unarchived descendants remain or the General setting `confirmThreadArchive`
is disabled. The summary is a preview; concurrent changes
can alter the eventual archive result. CLI and SDK archive calls remain
non-interactive.

## File Content Routes

Clients read file bytes through path-shaped GET routes, so relative URLs in
HTML and markdown resolve against the same route:

- `/api/v1/threads/:id/thread-storage/files/:path` reads the thread's storage
  folder.
- `/api/v1/threads/:id/host-files/:absolutePath` and
  `/api/v1/hosts/:id/files/:absolutePath` read the thread environment's host or
  the named host from its filesystem root. The path omits the leading `/`; a
  first segment such as `C:` selects that Windows drive root.
- `/api/v1/environments/:id/files/:path` reads the environment workspace, and
  `/api/v1/environments/:id/revisions/:ref/files/:path` reads `HEAD` or a
  4-40 character hex commit from it.
- `/api/v1/projects/:id/files/:path` and
  `/api/v1/projects/:id/hosts/:hostId/files/:path` read the project's local-path
  source on the primary or named host.

Media elements, HTML iframes, markdown images, and Download links use these
URLs directly. The server resolves the root on every request, so they need no
setup and do not expire.

Plugins that preview an arbitrary host directory instead mint a lease:
`POST /api/v1/files/previews` with `{ hostId?, rootPath, ttlMs? }` returns
`{ baseUrl, expiresAtMs }`, and `GET /api/v1/file-previews/:lease/:path` reads
that root. Minting the same root again returns the same `baseUrl` and extends
its expiry. Leases live in server memory and do not survive a server restart.

File content reads support a single HTTP byte range for media playback, seeking, and
file preview sampling. Responses advertise `Accept-Ranges: bytes`; bounded,
open-ended, and suffix ranges return `206` with `Content-Range` and the selected
bytes. Unsatisfiable ranges return `416` with `Content-Range: bytes */<size>`.
Malformed ranges, unsupported units, and multipart ranges fall back to the full
`200` response. HEAD ignores Range. Revision routes read the file with one
whole-file daemon read, so those responses ignore Range, keep the daemon's
25 MB non-image limit, and revalidate with a strong SHA-256 ETag.

File previews request the first 64 KiB. A complete sample becomes the preview
directly. Otherwise the sample, its MIME type, and the `Content-Range` size
classify the file: images and videos render from the file URL, binaries show
their size and a Download link, and text is fetched in full only when it is at
most 25 MB. The Download link is the file URL with the anchor `download`
attribute, so the browser streams it to disk without the 25 MB limit.

`If-None-Match` revalidation takes precedence over Range. Streamed responses use
weak metadata ETags (`W/"file-<revision>"`), not content SHA-256 hashes. This
avoids reading an entire large file just to validate it. Because the validator
is weak, any `If-Range` header falls back to a full `200` response, including a
matching weak tag or date. All raw file responses carry `Content-Security-Policy:
sandbox allow-scripts`, including SVG and XHTML, so directly opened documents
cannot acquire the app's origin privileges. HTML also carries the no-store
policy, at any size; the app renders an HTML iframe only for files up
to 5 MiB and shows larger HTML as source or, past 25 MB, as a Download.

The server uses `host.read_file_chunk` for a metadata-only probe (`length: 0`),
then reads at most 1 MiB per RPC as the HTTP consumer pulls data. HEAD, `304`,
and `416` responses read no contents. Cancelling or aborting stops subsequent
reads; an already in-flight RPC can finish. Each RPC opens and closes its file
handle, so no remote read session needs cleanup. Offsets and lengths are
validated at the daemon boundary, and paths remain confined to the route's root.

The daemon returns a revision based on device, inode, size, and nanosecond
mtime/ctime. Every content read checks the expected revision before and after
reading from its open descriptor. A mismatch before response headers produces
retryable `409 file_changed`; a change or error after streaming starts aborts
the HTTP body. The server also rejects short/misaligned chunks. This detects
ordinary writes, truncation, and replacement; it is not an immutable filesystem
snapshot or a cryptographic guarantee against changes hidden by filesystem
metadata granularity.

Streamed reads bypass the whole-file size caps (including the 25 MiB
non-image cap); each chunk stays bounded regardless of file size. `host.read_file`
consumers such as `POST /files/read` and revision routes keep their
whole-file limits and SHA-256 validators. `sdk.projects.fileContent` (and
`bb project content`) reads through the project file routes and decides utf8 versus
base64 from the returned bytes. Host-daemon protocol 219 introduced the chunk
RPC; older enrolled daemons cannot serve streamed reads until updated.

## Stale Workspace Claims

Failed thread provisioning immediately requests environment cleanup. If a previous
failure left a claim behind, sends, environment admission, and provider path claims
repair it when they encounter it; restarting the server is not required.

Claims owned by threads that are still starting or stopping remain blocked. A stale
claim on a ready or shared checkout is released locally, preserving the workspace.
A partially created environment retains its claim and is scheduled for the existing
background lifecycle cleanup. Sends report `workspace_busy` with “Workspace cleanup
is pending. Try again shortly.” until removal completes. Provider cleanup is never
awaited by this admission repair, and startup does not scan for abandoned claims.

## Local Dev QA

Run `pnpm dev` from this checkout and keep it running in a terminal. It prints
the checkout-specific URLs, data directory, and logs directory. Stop it with
Ctrl-C. For desktop-only changes, start
`pnpm exec turbo run dev --filter=@bb/desktop` in a second terminal.

Use the Node version in `.nvmrc` (22.19.0). Desktop development requires
Node 22.19 or newer in the Node 22 release line.

A bb connect shared-port URL is a different browser origin from localhost. If
QA through that URL needs the browser-local host daemon, restart the dev app
with the share origin configured after exposing its app port:

```bash
BB_APP_URL=https://<handle>--<app-port>.getbb.app pnpm dev
```

The port remains stable for the checkout, so the existing share continues to
work after the restart. The host daemon intentionally rejects remote origins
that are not configured; otherwise any webpage could drive its local editor
API.

For CLI QA, `pnpm bb:dev` derives this checkout's server and daemon endpoints.
In the test shell, clear inherited endpoint and thread context overrides first
so commands target the dev instance. Keep these changes inside that shell.

Test agents with:

```bash
unset BB_SERVER_URL BB_HOST_DAEMON_PORT BB_THREAD_ID BB_ENVIRONMENT_ID BB_THREAD_STORAGE BB_PROJECT_ID BB_CLI BB_CLI_REEXEC
pnpm bb:dev thread spawn --project proj_personal --provider codex --permission-mode accept-edits --title "Smoke test" --prompt "Reply only with ok." --json
```

## Local Cloud

Run the Cloud dashboard, the Connect worker, and the AI gateway against one
local D1 database:

```bash
pnpm cloud:dev
```

The command applies migrations and prints the dashboard URL. Create a local
email/password account, claim a handle, create a pairing code, and run the
displayed `bb account login --code` command against a bb started with
`pnpm dev` (`bb connect --code` does the same and also turns remote access
back on). A browser sign-in started with
`bb account login` opens `<local origin>/link?code=…` on the same origin. The
same worktree-specific local origin serves the dashboard at `bb.localhost`,
sends `bb.localhost/api/ai/*` to the AI gateway worker, and routes
`<handle>.bb.localhost` through the Connect worker. Email/password auth
is enabled only for this loopback workflow; production remains GitHub-only.
`pnpm dev` automatically sets `BB_DEV_CONNECT_BASE_URL` to that worktree's
local Cloud origin. While the bb is signed out, Settings → bb account and
Settings → Installed plugins → Connect therefore sign in against the local
Cloud, and a pasted code redeems locally. An explicit `--base-url ...` (or
`bb connect --server ...`) still wins, so the dev bb can still sign in to
getbb.app.
Local machine enrollment follows the same origin: local `http:` server URLs
produce `ws:` machine tunnels and `http:` share URLs, while non-local machine
enrollment remains HTTPS-only.

For bb connect next, `pnpm cloud:dev` sets the Connect worker's and bb-web's
`NEXT_BASE_DOMAIN` to `next.bb.localhost`. `BB_CLOUD_DEV_GATE_SECRET` sets the
worker's `GATE_SECRET` (the account API answers 404 without it),
`BB_CLOUD_DEV_GATE_PUBLIC_KEYS` sets bb-web's `GATE_PUBLIC_KEYS`, and
`BB_CLOUD_DEV_STATE_DIR` moves the local D1 and Durable Object state away from
`.wrangler/cloud-dev`. `apps/connect-next/scripts/e2e-local.sh` uses all three;
see [connect-next.md](connect-next.md#local-end-to-end-run).

The AI gateway answers `503 unavailable` until an OpenRouter key is present.
Export `OPENROUTER_API_KEY` in the shell before `pnpm cloud:dev` to pass it
through to the local worker; the startup banner says which mode is active.
To exercise the whole chain without OpenRouter, export
`BB_CLOUD_DEV_AI_UPSTREAM_BASE_URL` (for example `http://127.0.0.1:4599/api/v1`)
pointing at a local OpenAI-compatible fake, plus any non-empty
`OPENROUTER_API_KEY`.
The production gateway gets the key from the repository's `OPENROUTER_API_KEY`
Actions secret, which `deploy-ai-gateway.yml` uploads with each deploy. Set the
staging key with `wrangler secret put OPENROUTER_API_KEY --env staging` from
`apps/ai-gateway`. Use a dedicated OpenRouter key with account-wide zero data
retention and a daily credit limit.

Ctrl-C stops the local services. Local D1 state is kept under
`.wrangler/cloud-dev`.

To test a source bb against the deployed staging Cloud instead, start it with
`pnpm dev --staging`. bb account and Connect then sign in, redeem codes, open
tunnels, and call the AI gateway at `https://vibecodethis.site`; no
`pnpm cloud:dev` is needed. The flag only changes the default origin, so a
dev data dir already signed in elsewhere keeps its account until
`bb account logout`.

## Record Provider Bridge Traffic

Export `BB_PROVIDER_BRIDGE_RECORD_DIR` before you start the dev app and every
provider bridge records its runtime and provider wires as NDJSON:

```bash
BB_PROVIDER_BRIDGE_RECORD_DIR=$HOME/.bb/provider-recordings/raw pnpm dev
```

In a second terminal, run:

```bash
unset BB_SERVER_URL BB_HOST_DAEMON_PORT BB_THREAD_ID BB_ENVIRONMENT_ID BB_THREAD_STORAGE BB_PROJECT_ID BB_CLI BB_CLI_REEXEC
pnpm bb:dev thread spawn --project proj_personal --provider codex --prompt "Run git status." --json
ls ~/.bb/provider-recordings/raw/codex/
```

The layout is `<dir>/<providerId>/<threadId>/<direction>.ndjson`, plus a
`_process` scope for lines that belong to no thread. See
[provider-bridge-protocol.md](provider-bridge-protocol.md), "Record mode",
for the entry format. Raw recordings can contain secrets and absolute paths.
Run `node scripts/provider-recordings/redact.mjs <raw-dir> <out-dir>` before
you share one, and never commit a raw recording.

To compare two checkouts' bridges on the committed recordings, run
`pnpm parity --old <checkout> --new . [--provider <id>] [--cell <name>]`.
Each leg replays every cell through its own bridge, assembler, and timeline
projection; the run prints a PASS/FAIL line per cell with event and row
counts and exits non-zero on any diff outside
`packages/provider-bridge-protocol/recordings/parity-allowlist.json`.

## Performance Fixture Database

Use `pnpm seed:perf` to fill a dev database with a large, realistic fixture:
many projects, ~1,200 threads, and ~400k event rows with production-like
payloads. Use it to reproduce performance problems that only appear at scale.

- Start the dev app once first (`pnpm dev`), then stop it and
  seed. The fixture then attaches to the real local host, so agents still run.
- By default the command seeds this checkout's dev data dir. Pass
  `--data-dir <path>` for another target. The command refuses to touch `~/.bb`.
- Scale flags: `--projects`, `--threads`, `--events`, `--seed`. `--reset`
  deletes the database file first. Without `--reset` the fixture appends.
- Example: `pnpm seed:perf -- --reset --events 400000`.

## Opt-in Benchmarks

`pnpm exec turbo run bench` runs the benchmarks that `turbo run test` skips. The
task is uncached, and each package's `bench` script turns its benchmark on:

- `@bb/app`: the sidebar thread list mount and update benchmark
  (`sidebar.bench.test.tsx`) and the composer large-paste benchmark
  (`prompt-paste-performance.test.ts`). `BB_SIDEBAR_BENCH_THREADS` sets the
  thread count (default 3000), `BB_SIDEBAR_BENCH_OUT` writes the results as
  JSON, and `PROMPTBOX_PERF_FIXTURE_OUT` saves the paste fixture.
- `@bb/host-watcher`: the root watcher recovery benchmark
  (`root-recovery-benchmark.test.ts`). `BB_WATCHER_BENCHMARK_OUTPUT` writes its
  report.

Filter to one package, e.g.
`BB_SIDEBAR_BENCH_OUT=/tmp/sidebar.json pnpm exec turbo run bench --filter=@bb/app`.
Compare runs on an idle machine; the numbers are wall-clock timings.

## Provider Corpus

The provider corpus is a private set of real production threads extracted from
a personal `~/.bb/bb.db`. It is the regression oracle for timeline projection:
every change must project the same rows and build timelines at the same speed.
The corpus contains real prompts, code, and paths, so it is **never
committed**; `.gitignore` blocks every `provider-corpus/` directory except the
in-repo harness and scripts.

- Location: `~/.bb/provider-corpus/` by default. Tests read it through
  `BB_PROVIDER_CORPUS_DIR` and skip when the variable is unset or the directory
  has no `manifest.json`, so CI and fresh checkouts stay green.
- Layout: `manifest.json` (thread selection and reasons), `profile.json`,
  `threads/<provider>/<threadId>/{meta.json,events.ndjson}`, and the generated
  `snapshots/` directory described below.
- Reader: `@bb/test-helpers` exports `corpusAvailable()`,
  `listCorpusThreads({ provider?, reasons? })`, and `loadCorpusThread(id)`.
  Event rows decode through the same `parseStoredThreadEvent` the server uses.

Gates under `apps/server/test/provider-corpus/`:

- `row-snapshots.test.ts` loads each thread into in-memory SQLite and projects
  every timeline page the way `GET /threads/:id/timeline` does (default and
  nested variants), then compares the rows with
  `snapshots/rows/<provider>/<threadId>.json`.
- `timeline-perf.test.ts` measures cold builds of the 10 largest threads per
  provider (latest page and full page walk) and compares with
  `snapshots/perf-baseline.json`. The CI micro-benchmark in the same file needs
  no corpus.
- `timeline-streaming-memo.test.ts` appends streaming rows to each thread's
  latest turn and requires every latest-page build to equal a build on a fresh
  connection with empty caches.

Run them:

```bash
scripts/provider-corpus/snapshot-rows.sh compare   # default mode, fails on diffs
scripts/provider-corpus/snapshot-rows.sh write     # refresh the baseline
```

The script wraps `pnpm exec turbo run test:provider-corpus --filter=@bb/server`
with `BB_PROVIDER_CORPUS_SNAPSHOT=write|compare`. Turbo strips undeclared
variables, so use that task (not the package `test` task) when you set the
corpus variables. Each run writes `snapshots/rows-last-run.json` and
`snapshots/perf-last-run.md` with totals and the perf table.

Compare mode fails on any row diff that `snapshots/allowlist.json` does not
cover. An entry names a scope, a path, and the PR that made the change:

```json
[
  {
    "threadId": "thr_abc123",
    "path": "/variants/*/pages/*/rows/*/output",
    "pr": "#1234",
    "reason": "…"
  },
  {
    "provider": "codex",
    "path": "/variants/default/pages/**/planSteps",
    "pr": "#1235",
    "reason": "…"
  },
  { "*": true, "path": "/variants/**/maxSeq", "pr": "#1236", "reason": "…" }
]
```

`path` is a JSON pointer over the snapshot, or a glob where `*` matches one
segment and `**` any number. The run prints the entries it used; an entry that
covers nothing fails the run because it is stale.

`snapshots/rows` is the baseline minted on `main` and shared by every
workstream, so never run `write` against it from a feature branch. A PR that
intentionally changes rows carries its own allowlist in the repository
(`apps/server/test/provider-corpus/allowlists/<ws>.json`, same schema, merged
after the shared file) and compares with
`BB_PROVIDER_CORPUS_ALLOWLIST=<that file>`. A snapshot of the branch's own
rows goes to a shadow directory: `BB_PROVIDER_CORPUS_SNAPSHOT_DIR=<dir>`
redirects both `write` and `compare`. Re-mint `snapshots/rows` from `main`
after such a PR merges and delete the allowlist file it carried.

A pointer allowlist cannot describe a change that adds or removes rows: every
later sibling shifts and the diff reports the whole turn. For such a change,
carry a row-class file instead
(`apps/server/test/provider-corpus/allowlists/<ws>-row-classes.json`) and set
`BB_PROVIDER_CORPUS_ROW_CLASSES=<that file>` on the compare run. The gate then
matches rows by identity (`callId`, `itemId`, `interactionId`, turn id, or row
id), buckets every change into the first class whose matcher fits, and fails
on a change no class claims or an entry that claims nothing (judged per
entry, so a dead matcher cannot hide behind a sibling with the same name). A
class names a `reason` and one matcher: `added`, `removed`, `moved` (the row left one
nesting level for another), `resegmented` (a turn shows a different number of
visible segments), `reshaped` (`from`/`to` kinds, optionally the other
`fields` the reshape may touch), or `changed` with the `fields` it may touch;
each narrows by `kind`, `workKind`, `role`, and `nested`. Turn bounds that follow a changed child fall into the built-in
`container-bounds` class. The run prints the count per class and records them
in `rows-last-run.json`. To iterate on the classes without re-projecting the
corpus, mint the branch's rows once into a shadow directory and classify the
two directories offline:

```bash
pnpm exec tsx scripts/provider-corpus/classify-row-diff.ts \
  ~/.bb/provider-corpus/snapshots/rows ~/.bb/provider-corpus/snapshots/rows.<ws> \
  --classes apps/server/test/provider-corpus/allowlists/<ws>-row-classes.json --verbose
```

Perf compare mode passes when each thread's normalized cost (minimum build time
divided by a fixed CPU calibration workload run alongside it) is within 10% of
the baseline, or within 5 ms for small latest-page builds, and the median event
size is within 15%. Compare mode refuses a baseline written with different gate
settings. Run the gate on a machine whose load average is below its core count;
the table header warns when the machine is oversubscribed.

## Desktop Browser Smoke Tests

```bash
pnpm exec turbo run smoke:browser-cdp --filter=@bb/desktop > /tmp/browser-cdp-smoke.log 2>&1
pnpm exec turbo run smoke:browser-cdp --filter=@bb/desktop -- --dev-browser /absolute/path/to/dev-browser > /tmp/browser-cdp-local-smoke.log 2>&1
pnpm exec turbo run smoke:browser-broker --filter=@bb/desktop -- --dev-browser /absolute/path/to/dev-browser > /tmp/browser-broker-smoke.log 2>&1
```

`smoke:browser-cdp` drives real Electron `WebContentsView` tabs through the
production CDP bridge with checksum-pinned DevBrowser and agent-browser
releases, a local fixture site, and a separate Electron profile; it starts no
BB core and reads no existing store. It requires Linux x64, `xvfb-run`, and
network access to GitHub releases. The command prints its artifact directory
(screenshots, protocol traces, result summary); credentials are redacted.
`--dev-browser` tests a local DevBrowser build instead, records its SHA256, and
adds cross-origin iframe snapshot-reference checks that the pinned release
cannot pass. Run the task with `-- --help` for usage. Popup control is untested.
A result with `forcedExit: true` means Electron did not quit within five
seconds and its process group was killed: the browser checks passed, but
graceful shutdown was not proven.

`smoke:browser-broker` runs the actual SDK and CLI against an in-memory
migrated test server, an authenticated host broker, the desktop broker client,
and real Electron tabs. The harness supplies the server-to-host RPC responder,
so it does not prove remote-machine transport. It uses no existing BB store or
browser profile.

## Provider-literal ratchet (G1)

`node scripts/check-provider-literal-ratchet.mjs` counts provider-id literals
(`"codex"`, `"claude-code"`, `"acp-…"`, `providerId === "…"`, `isAcpProviderId`, …)
in core (everything outside `plugins/provider-*` and `examples/`) and compares a
per-file count against `scripts/provider-literal-baseline.json`. The count may
only go down, so adding a provider-id branch to core fails CI. After removing
literals, regenerate the baseline with `--write` and commit it. `--list` prints
every hit. When the baseline reaches zero, delete it and the guard. See
[provider-plugin-api.md](provider-plugin-api.md).

## File Content Routes

Clients read file bytes through path-shaped GET routes, which you can `curl`
directly:

- `/api/v1/threads/:id/thread-storage/files/:path`: the thread's storage folder.
- `/api/v1/threads/:id/host-files/:absolutePath` and
  `/api/v1/hosts/:id/files/:absolutePath`: the thread environment's host or the
  named host, from its filesystem root. The path omits the leading `/`; a first
  segment such as `C:` selects that Windows drive root.
- `/api/v1/environments/:id/files/:path` reads the environment workspace, and
  `/api/v1/environments/:id/revisions/:ref/files/:path` reads `HEAD` or a
  4-40 character hex commit from it.
- `/api/v1/projects/:id/files/:path` and
  `/api/v1/projects/:id/hosts/:hostId/files/:path`: the project's local-path
  source on the primary or named host.
- `GET /api/v1/file-previews/:lease/:path` reads a root leased through
  `POST /api/v1/files/previews` (`{ hostId?, rootPath, ttlMs? }`); leases live
  in server memory and do not survive a restart.

Responses support a single HTTP byte range and carry
`Content-Security-Policy: sandbox allow-scripts`. A file that changes before
response headers are sent returns retryable `409 file_changed`; a change after
streaming starts aborts the body. Revision routes ignore Range and keep the
daemon's 25 MB non-image limit.

Working-tree, host, thread-storage, leased-preview, and uploaded-attachment
responses share `services/files/file-stream-response.ts`. It owns ranges,
conditional requests, HEAD, bounded streaming, backpressure, and cancellation.
The local reader opens a file handle only when bytes are needed and closes it
on completion, cancellation, or failure. The daemon reader uses the existing
chunk RPC and passes cancellation through to pending calls. Both readers
validate file consistency; failures before headers return an error and failures
after streaming begins terminate the body.

Routes explicitly choose content type, cache policy, and security headers.
Daemon files retain weak revision ETags and their sandbox/nosniff policy;
HTML remains `no-store`. Attachments retain their immutable private cache policy
and strong ETags. Weak validators never authorize `If-Range`; attachment ranges
can use an exact strong ETag or Last-Modified match. Git revision reads remain
on the separate whole-file path described above.

Uploaded attachments use `GET /api/v1/projects/:id/attachments/content?path=<stored-path>`.
This route streams single byte ranges from disk, including open-ended and suffix
ranges, with `206`, `Accept-Ranges: bytes`, and `Content-Range`. Unsatisfiable
ranges return `416`; malformed or multipart ranges fall back to the full `200`
response. `If-None-Match` takes precedence over ranges. `If-Range` must match the
strong ETag or Last-Modified value exactly; otherwise the full file is returned.
HEAD returns full-file headers without reading the body. To check partial reads,
use `curl -D - -H 'Range: bytes=0-1023' '<attachment-url>' -o /tmp/attachment-part`.

Skill detail reads and file listings resolve symlinked skill directories on
their owning host. The server opts into `followRootSymlink` for
`host.read_file_relative` and `host.list_files`; other callers pass `false`.
Relative skill reads remain confined to the resolved directory and deny dotfiles,
and listings skip nested symlinks. Linked skills remain read-only in bb.

## Prepared Worktree Restarts

`pnpm start` and `pnpm start:worktree` always run Turbo-backed preparation
before launching: Turbo rebuilds what changed and restores unchanged artifacts
from cache, and native modules are repaired when necessary. Add `--dryrun` to
prepare, print the resolved ports, bind host, paths, and runtime entrypoints as
JSON, and exit without launching services, migrating data, or requiring free
ports. Dry runs still write build outputs; run
`pnpm install --frozen-lockfile` first when needed.

Preparation writes build outputs in the checkout, so it is not an atomic
release switch for an instance serving those files. Do not prepare
concurrently with another preparation or against files a live instance serves.
To restart with minimal downtime, warm the shared Turbo cache from a separate
staging checkout, then stop the instance, update and prepare its checkout, and
launch. Moving the serving checkout changes the instance's default data
directory and ports.

Cache hits restore cached files but can leave extra files from an earlier
build. Built source servers load bundled plugins from
`packages/bundled-plugins/dist`; see
[official-plugin-release-process.md](official-plugin-release-process.md) for
adding a bundled plugin. The launcher sets `BB_BUILD_TOOLCHAIN` (Node, OS, and
architecture) to partition Turbo cache entries; do not set it yourself.

App production builds cache React Compiler transforms under
`<git-common-dir>/bb-cache/react-compiler`, shared across worktrees; delete it
while no build runs to clear it. `BABEL_SHOW_CONFIG_FOR` and
`ENABLE_REACT_COMPILER_TIMINGS=1` bypass that cache. Use
`pnpm exec turbo run build --filter=@bb/app --force` to rebuild without Turbo's
whole-task cache.

## Reviewing UI Code Splits

See [UI code splitting](ui-code-splitting.md) for the app's `defineSplit`
contract, explicit preload scopes, bundle-boundary guards, and parallel worker
handoff requirements. Use an isolated production build with browser request
interception to review loading and failure states and verify cold-download
behavior. Keep temporary review stories and fixtures out of the final diff.

## Server Move Markers

A server move or `bb server import` leaves JSON markers in the data
directory; check them when a server refuses to start or keeps redirecting:

- `server-import-journal.json`: an import is installing files. Without a
  matching `server-import.json` the import was interrupted, and the server
  refuses to start; rerunning `bb server import` into that directory rolls it
  back from `server-import-backup/`.
- `server-import.json`: the imported server on the target is waiting for
  activation (no plugins, sweeps, or daemon sessions run).
- `server-moved.json`: the old computer after the switch. The launcher refuses
  to start a server from that data and answers the old port with 410
  `server_moved`.
- `server-move-run.json`: the old server's durable move state, reconciled at
  boot.
- `last-server-move.json`: the new server's record of the move.
- `server-connect-hold.json`: an imported server starts without bb connect
  until `bb server allow-connect`.

During a move, `/health` on the new server reports
`serverMove: { moveId, state }` with `pending`, `activating`, or `ready`.
Usage is in `bb guide machines`.

## Daemon Protocol Mismatch

The server checks the daemon's protocol version before parsing session
payloads. A daemon on another `HOST_DAEMON_PROTOCOL_VERSION` is rejected with
`protocol_version_mismatch` and cannot serve workspace RPCs until it updates and
reconnects. Auto-update-enabled daemons install the server's matching `bb-app`
artifact; disabled or failed updates leave the machine disconnected until a
manual update succeeds. The commit that bumps the version records what changed.

## Opt-in server performance diagnostics

Collection needs both startup permission and the **Server performance
diagnostics** experiment; see [configuration.md](configuration.md) for the
flag, environment variable, and experiment. It covers the server only, not the
daemon. Leave it off for routine operation: profiling and extra logging add
overhead.

While on, the server logs database operations of at least 25 ms, API requests
of at least 100 ms, and event-loop stalls of at least 100 ms. Every five
seconds `Server performance sample` records process and main-thread CPU, loop
utilization and delay, GC, and memory; CPU values are interval totals, not
per-request attribution. A 1 ms V8 CPU profile is saved every 30 seconds to
`$BB_DATA_DIR/logs/performance/` (`Server CPU profile saved` logs its path,
PID, and UTC window). Profiles are kept for up to 12 hours and 1 GB total,
oldest first, so copy the ones you need. They use private permissions and
contain local paths and function names; inspect before sharing.

A worker connects to the main-thread inspector and processes completed
profiles, serializes JSON, and writes files. Captures overlap at rotation to
preserve coverage without restarting V8's sampler. Native V8 sampling and
profile completion still have some main-thread cost. Retention scans existing
files once at startup, then tracks this recorder's writes incrementally; use
one server per data directory. Rotation does not queue more captures while a
previous capture is being saved. Shutdown awaits the active save and writes
the final capture.

### Turn traces

While both gates are on, every message sent through the send API also writes
one `Turn trace` info line once its first streamed output is stored and
broadcast. `turnTrace.spans` holds milliseconds since the server received the
send: `dispatch.checkpoint.done`, `runtimeConfig.*` (runtime configuration
assembly, including the daemon reads it waits on), `command.sent`,
`send.responded`, `command.settled`, and `firstOutput.batchReceived`,
`firstOutput.committed`, `firstOutput.notified` for the first event batch that
carries an agent message, reasoning, or plan delta. `turnTrace.rpcs` lists every
daemon RPC the send awaited with its start offset and duration.
`turnTrace.daemon.spans` are the daemon's own offsets from receiving
`turn.submit`: `lanes.entered`, `skills.staged`, `runtime.ready`,
`input.staged`, `bridge.turnStarted`, and `events.flushed`. Server and daemon
offsets use different clocks, so compare durations rather than offsets:
`command.settled - command.sent - daemon events.flushed` is the round trip
spent on the network. `outcome` is `output`, `not-sent` (queued or refused),
`command-failed`, `completed-without-output`, `superseded` by a newer traced
send on the thread, or `no-output` after two minutes. Queue drains, retries,
and other server-initiated dispatches are not traced.

### Stream traces

While both gates are on, every ingested daemon event batch that carries agent
message, reasoning, or plan text writes one `Stream trace` info line per thread.
`streamTrace.receivedAt`, `committedAt`, and `notifiedAt` are epoch
milliseconds; `events`, `textEvents`, and `textChars` size the batch;
`served` is `push` when a thread view is subscribed to timeline pushes (the
`timelinePush` experiment) and `refetch` otherwise, so comparing lines of the
two kinds gives the A/B between delivery paths. The
intervals between consecutive lines for a thread are the chunk cadence the
server sees. The host daemon logs `Posted daemon event batch` at debug level
(`BB_LOG_LEVEL=debug`) for every POST: `eventBatch.events`, `textChars`,
`oldestQueuedMs` (how long the oldest event waited), `sincePreviousPostMs`,
`postMs`, and `postedAt`. Each timeline push to a subscribed thread view writes
a `Timeline push trace` line: `timelinePushTrace.maxSeq`, `withDelta` (false
when the subscriber had no base and received the full window), `bytes`,
`buildMs`, and `sentAt`. In the browser, the same gates add
`performance.mark` entries: `bb:timeline-applied` (`threadId`, `maxSeq`,
`source`: `fetch`, `fetch-delta`, `push`, or `push-delta`) when timeline data
is applied, and `bb:stream-row-commit` (`rowId`,
`threadId`, `textLength`) when a streaming assistant row commits. Read them with
`performance.getEntriesByType("mark")`. Streaming assistant text is revealed a
complete line at a time, so row commits follow line completion, not every
applied chunk.

### Diagnose a captured stall

1. Note the request path and UTC time. Find its `Slow API request` and nearby
   `Event loop stalled` records; for timelines, also
   `Thread timeline build blocked the event loop` and its stage timings.
   `inFlightWorkAtObservation` can name an unrelated long poll; compare
   `longestSynchronousWork` and its wall/CPU times with the profile instead.
   The stall-bound off-cpu rule labels `stallCauseCandidate` as `off-cpu` only
   when raw whole-window main-thread CPU is less than 10% of raw `maxDelayMs`.
   Comparisons use unrounded values; log durations are rounded only for display.
   Even if all that CPU fell inside the stall, the main thread ran for less than 10% of
   the stall duration. The whole-window CPU/wall ratio remains context and
   cannot establish when CPU was used. This rule does not distinguish
   preemption from a blocking wait. The
   process-wide `processContextSwitchHint` compares voluntary and involuntary
   context-switch deltas as a clue, not proof. Otherwise, the candidate is the
   longer of the single longest GC pause and the longest synchronous
   operation's CPU or wall duration. It is attributed only when that one
   raw duration is at least 90% of raw `maxDelayMs`; separate work or GC pauses
   are
   never summed. The 90% threshold includes the operator walk's 3500.8 ms
   operation against a 3527.4 ms stall (99.25%), while six separate 250 ms
   operations against a 1512 ms stall remain unattributed (16.5% each). If
   off-cpu and a work or GC candidate both qualify, off-cpu wins and the
   work or GC cause is not reported.
   `unattributed` means neither rule explains it and `stallCauseCandidate` is
   null. `longestSynchronousWork` and `lastCompletedWork` remain available as
   context. Candidates are not confirmed causes: both measurements fall
   somewhere in the five-second window. Profile processing runs in a worker and
   no longer emits the historical `cpu-profile:*` synchronous-work labels.
2. With performance diagnostics enabled, look for `Event loop stall attribution`
   records for the same PID and UTC window. They are emitted at the next CPU
   profile rotation (normally within 30 seconds), or on diagnostics shutdown,
   even if the profile file is discarded for exceeding its size limit. A
   separate 20 ms timer records individual gaps of at least 100 ms; the
   five-second histogram's observation time is not the stall's end time.
   `stacks` ranks the top five sampled leaf stacks in each gap, with up to 12
   caller frames, including GC, plugin functions, native writes, and database
   callers. Frame coordinates are one-based; cached Node source maps are used
   in the profile worker when available, otherwise coordinates refer to the
   generated code. Profile scanning and stack formatting run in that worker;
   the main thread only collects and transfers bounded timing windows.
   `sampledMs` is elapsed sampling coverage, not CPU time; native frames can
   include waiting. Each sample contributes at most 10 ms so a long sampling
   gap cannot be blamed on one frame. `unobservedMs` reports missing coverage,
   including profile boundaries. The window includes up to one timer interval
   of ordinary work; ranked stacks are evidence, not proof of a single cause.
   Up to 128 windows are retained per rotation, with overflow reported as
   `droppedWindows`; gaps of 60 seconds or more are treated as suspension.
   These records require the existing profiling gates. Without profiling, the
   immediate stall record can only report explicitly measured candidates.
3. Load the `.cpuprofile` covering that time and PID in Chrome DevTools'
   JavaScript profiler, select the window, and read the bottom-up view.
   Match function names against the exact source revision of the build.
4. Compare stacks with `mainThreadCpuMs`, GC totals, and SQL `cpuDurationMs`.
   A slow SQL operation with little CPU indicates waiting but does not identify
   the lock owner or prove disk I/O.
5. Repeat with a small control workload. Expected long polls log slow requests
   without blocking the loop; require corroborating loop delay, stage timings,
   or sampled execution before calling them stalls.

## Workspace Context Read Limits

The server passes `host.read_workspace_agent_context` its project skill read
policy: at most 1,000 non-hidden, non-excluded directories, 10 MiB per
`SKILL.md`, and 32 MiB of JSON-encoded content in total (directory metadata,
shared skill discovery, and workspace instructions do not count). These are a
starting policy, not a measured requirement or transport ceiling. Files over a
limit are skipped with server warnings; smaller later files can still fit, and
count truncation is reported separately. Only exact-case `SKILL.md` files are
read; symlinked skill directories or files and roots escaping the workspace are
skipped before reading. Command lookup sets `includeAgentInstructions: false`,
so an invalid `.bb/AGENTS.md` cannot break the command catalog; turn
preparation sets it to `true` and reports instruction-read errors.

## Interrupted Optimistic Query Refreshes

Optimistic cache owners use `cancelOptimisticQueries` instead of calling
`queryClient.cancelQueries` directly. During a mutation it records interrupted
reads and the mutations pending at cancellation. It invalidates those queries
after those mutations finish, including success, error, and settled callbacks.
A later optimistic cancellation of the same query extends that wait even if
the query is already idle. Active queries refresh; inactive queries become
stale for their next mount. Removed queries are discarded from recovery.

This deliberately waits for every mutation pending at cancellation because a
cache owner does not have the identity of its calling mutation. Later unrelated
mutations do not delay recovery. Queries without an interrupted read are not
refetched. Calling cache-owner helpers outside a mutation retains ordinary
cancellation behavior. Browser suspension and realtime replacement reads have
their own recovery paths and continue to use ordinary cancellation.

For a stale drawer or sidebar, check whether an optimistic mutation canceled
the last realtime refresh, then whether its recovery ran after the mutation
callbacks. Cover this ordering with real Query and Mutation observers; an
isolated rollback helper test does not exercise mutation settlement.

## Environment Status Loading

Merge-base status is cached per host daemon process at two levels, each a
least-recently-used cache capped by estimated size. Full comparisons (16 MiB)
are keyed by checkout path, shell path, resolved HEAD and base commits, base
label, and file limit; working-tree status is always read fresh. Per-commit
changed files (64 MiB, skipping any commit over 1 MiB) and patch IDs (8 MiB per
diff mode) are keyed by commit SHA and shared by every checkout on the host, so
a new commit or a fetched base commit only needs its own diff. Comparisons where
a Git command failed or squash detection timed out are not cached. A daemon
restart clears both levels.

Ahead/behind counts exclude commits whose patch appears on the other side, as
`git rev-list --cherry-pick` does: only commits touching the same set of paths
as a commit on the other side are patch-hashed, without rename detection.
Squash detection reuses the per-commit changed files for the newest 1,000 base
commits and hashes its candidate patches with Git's rename detection, cached
separately, within 8 MiB of patch output and a 1-second deadline per attempt.
When it cannot finish, `mergeBase.squashMergeCheckComplete` is false and the
counts may include already squash-merged commits; the next refresh retries with
the cached work. Daemons older than this field report `true`.
