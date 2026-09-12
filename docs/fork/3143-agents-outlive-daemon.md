# Fork note: agents outlive the daemon (get-bb/bb#3143)

This fork (albrand/bb) keeps provider bridge workers alive across a daemon or
IDE restart: the daemon detaches instead of killing them, and the next daemon
adopts them. The full design, the per-phase history and the review findings
live outside this repo; what follows is the part that has to travel with the
code, which is the behaviour a reader of these files needs to know is
deliberate.

## Implementation decisions (2026-09-11)

### The delta assembler lives in the daemon, not the worker (design gap)

The design rebuilt the daemon's state from `bridge/state` (identity, turn
state, background work, interactive requests). It missed the thread-delta
assembler. `packages/agent-runtime/src/bridge-protocol-adapter.ts:182` creates
one per adapter, on the daemon side. The assembler owns the bb turn and item
ids the server stores (maps from provider ids, `delta-assembler.ts:130-140`
and `:286-299`), mints them from counters under a random per-process prefix
(`:206-222`), and holds throttled text and progress until the next delta.
Stored events keep no provider ids (`packages/domain` has none), so the server
cannot hand the maps back. A fresh daemon adopting mid-turn would therefore
mint a new turn and a new item for the continued output.

Decision: **option D, a weaker timeline
guarantee.** The turn survives the swap and keeps producing output. A visible
segment break after adoption (a streaming item continues under a new item id)
is acceptable. The alternatives were rejected: moving the assembler into the
worker, persisting its state, or putting provider ids into the domain event
shape. Option D comes with three conditions, all implemented and tested:

1. **Flush before detach.** A graceful detach flushes every assembler
   (`DeltaAssembler.flushPending`), waits up to 5 s for the server to accept
   the resulting events, and only then sends the final ack (phase 4b).
2. **No duplicate items on replay.** A wseq is acked only once its line is
   processed, nothing it produced sits in a throttle buffer, a request line has
   been answered, and the server has accepted its events
   (`BridgeLineAckTracker`). The resume point is past everything emitted, so a
   graceful detach and adoption replay nothing (phase 4b, and phase 5's
   "no replayed output" test).
3. **No competing turn.** The adopting daemon seeds the fresh assembler's open
   turn (`seedOpenTurn`), turn state and the event grammar with the bb turn id.
   Continued output then stays on the same bb turn, with no second
   `turn/started` (phase 5).

**Known limit (not engineered around):** an ungraceful daemon death (SIGKILL,
crash, power loss) can lose what was in the assembler's throttle window (at
most one flush interval of text and progress). It can also replay lines
between the last ack and the death. The server drops the events of replayed
lines by replay key (`fork_worker_event_keys`), but the lost throttle window
is gone.

**Measured behaviour, real-provider e2e on f3193e1f4 (2026-09-11, scenario E):**
a background command started before a swap keeps running - 48/48 ticks with no
gap across the quit, and the adopted runtime survived three provider polls with
no eviction line, the hold logging `protectedForMs=900000` at each relaunch.
What the timeline says about it is wrong for the life of the command: at session
open the still-running task is closed as `item/backgroundTask/completed` with
`taskStatus: "stopped"` (item status `interrupted`), the command ran on for
another 3.5 minutes, and then reappeared and completed under a NEW item id. The
domain has four terminal task statuses - completed, failed, killed, stopped -
and none of them means "this daemon can no longer follow this task", so
`stopped` (which maps to the item status `interrupted`, not to a claim of
failure) is the least-wrong available and stays. Removing the mislabel needs the
worker-side open-work report, which costs a transport bump to 3.

**Known limit, accepted 2026-09-11 (coordinator decision, no fix):** the spill
file is never compacted. A frame kept for an unanswered request sits on disk
for as long as the approval is open, and the bytes of frames acked before it
are not reclaimed until the whole buffer is dropped. What was fixed instead is
spill GROWTH (f3193e1f4): a kept frame no longer forces every later frame to
disk, so the file stops growing once memory has room. What remains is the
unreclaimed space of one buffer, bounded by the 30-minute reattach TTL, which
drops the buffer and unlinks the file.

**Known limit, accepted 2026-09-11 (coordinator decision, no fix):** replay-key
dedup can leave an item delta whose `item/started` was dropped. The mechanism:
after an ungraceful death, or when the server is slower than the 1.5 s detach
settle, the replayed lines are re-assembled by a FRESH delta assembler, which
mints a new item id; the `item/started` for that new id carries a replay key
the server already stored, so the server drops it, while later deltas for the
same new id are not deduped and arrive with no start. The visible effect is a
stray item delta in the timeline - not lost work, not a hang. The cheap route
if it ever needs closing: have the server report the dropped keys and have the
daemon suppress later events for those item ids. Not built.

### Where the adoption seed comes from

The seed is **not** delivered in the `session.open` reply. Stock upstream
daemons (the Hermes VPS runs one against this fork server) parse that reply
with a strict schema, so adding a field would break them. Instead:

- The daemon persists, per worker thread, the runtime config, provider thread
  id, active bb turn id and provider turn id in the worker's registry entry.
  It rewrites them on turn/started and turn/completed.
- Adopted workers stay connected but are not resumed until the session is
  open. The daemon then reads the server's active turn per adopted thread
  through the fork-only route `POST /internal/session/fork/active-turns`.
- If the server still holds the registry's turn id, the daemon seeds it. If
  not (stale seed: an ungraceful death, or the server already ended the turn),
  it opens a new segment, a fresh `turn/started`, which the replayed completion
  closes. It never reuses a turn the server has ended.

### Wire compatibility: no protocol bump

`HOST_DAEMON_PROTOCOL_VERSION` stays 180. The server requires an exact match,
and stock daemons connect to this server. Every wire addition is optional and
additive:

- `replayKeys` on event groups;
- `adoptedThreads` on the `session.open` request;
- two fork-only routes, `/session/fork/active-turns` and
  `/session/fork/detach-notice`.

A stock daemon sends none of these, and the server behaves as before; a test
posts an upstream-0.42.1-shaped event group. The flip side: a fork daemon must
only talk to this fork server, because a stock server's strict schema would
reject `replayKeys`.

### Disconnect grace versus a real swap

Measured on this Mac from the bb logs, from the old daemon's SIGTERM to the
new daemon's session open:

- 2026-09-10 21:02:20 → 21:03:05.8: 45.2 s
- 2026-09-10 21:03:38.4 → 21:03:59.1: 20.8 s
- 2026-09-11 11:02:45.3 → 11:11:27.6: 522 s. That swap failed and bb was
  relaunched by hand.

On this Mac the server runs inside bb.app and restarts with the daemon, so the
in-memory 30 s grace timers never fire here. What protects a Mac swap is
`adoptedThreads`: on a new instance id the server skips interrupting an
adopted thread whose active turn matches, and counts it as reported-active.

For topologies where the server outlives the daemon, a graceful detach posts
`/session/fork/detach-notice`. The named threads get a **10-minute** grace
instead of 30 s, recorded in `fork_detached_threads`. 10 minutes covers the
normal swaps more than 13 times over, and even the failed 8.7-minute one. It
stays under the worker's 30-minute reattach window, and it bounds how long a
thread shows as active if nothing comes back.

### Every server path that can interrupt an adopted turn (Mac swap)

On the Mac a swap restarts the server as well as the daemon. Traced on the
branch; paths in `apps/server/src` unless noted. Ordered by which process
fires them.

**Old server, quit window.** The launcher signals the daemon, then the server
once the daemon exits or 3 s pass (`packages/bb-app/src/launcher.ts:3155`).
The daemon closes its WebSocket last, after detach and flush
(`apps/host-daemon/src/app.ts:970`).

| Path | Effect on an adopted thread | Status |
|---|---|---|
| `handleDaemonSocketClosed` `internal/session-owner-side-effects.ts:145`, closing the session row `daemon-disconnect` (:165) | none: it only schedules in-memory timers, which die with the process | no interrupt |
| 5 s `DAEMON_DISCONNECT_GRACE_MS` (`constants.ts:4`) → `completeDaemonDisconnectGrace` :221 | interrupts pending interactions for every host thread (:229), not excepted; background tasks except detached threads | fires only if the old server's shutdown (plugin stop, then `closeWebSockets`, `start-server.ts:262`) outlasts 5 s after the WS close. Not measured. Pending interactions are re-created on adoption, see below |
| active-work grace → `completeDaemonActiveWorkDisconnectGrace` :245, `interruptActiveThreadsForHost` :261 | would interrupt | excepts detach-notice threads (10 min); on the Mac it dies with the server anyway. Test: "holds the active-work grace…" |
| in-flight live command rejected on disconnect (`ws/hub.ts:903` → `services/hosts/live-command.ts:232` → `settleThreadCommandFailure` `services/threads/thread-lifecycle.ts:743`) | a steer (`turn.submit`) or other thread command in flight at quit is rejected (`client/turn/rejected`, `system/error`), then `run.failed` sets the thread to `error`, leaving the turn open. The shutting-down daemon also refuses new work (`Host daemon runtimes are shutting down`) with the same result | the thread self-heals: the adopted turn still matches, so `reconcileDaemonReportedThreads` revives `error` → `active` (`thread-lifecycle.ts:1856`). The rejected steer message is lost and shown as rejected. Test: "revives an adopted thread that a command failed during the swap" (b3422ea81) |
| server `SIGTERM` → `runShutdown` `start-server.ts:262` | closes sockets only | no interrupt |

**New server, boot, before any daemon connects.** `runStartupRecoverySweep`
(`services/system/periodic-sweeps.ts:608`):

| Step | Touches | Adopted thread |
|---|---|---|
| `deliverLegacyDeferredThreadMessages` (`services/threads/legacy-deferred-messages.ts:102`) | one-time legacy table into the queue | no interrupt |
| `runEnvironmentProvisioningSweep` :402 | environments in `provisioning` | not applicable (environment is ready) |
| `runThreadProvisioningOrphanCleanupSweep` :428 | threads in `starting` | not applicable (thread is `active`) |
| `recoverOrphanedEnvironmentDestroyRequests` (`services/environments/environment-cleanup-internal.ts:292`) | stale `destroying` managed environments | not applicable |
| `advanceRetiringManagedEnvironments` :181 | retiring managed environments; defers when the host has no daemon, and cleanup stops while live threads remain | not applicable |
| periodic sweeps every 10 s (`PERIODIC_SWEEP_JOBS`) | pruning, queue dispatch, provisioning, schedules | none interrupt an `active` thread |

Nothing on boot interrupts an active thread before a daemon connects. The
flip side, which is not new: the grace timers died with the old server, so a
thread left `active` whose daemon never returns has nothing that interrupts
it.

**New server, session open** (`internal/session.ts:76-118`,
`previousSession` = the latest row for the host, closed or not):

| Path | Adopted thread | Status |
|---|---|---|
| `openSession` marks old active rows `replaced` (`packages/db/src/data/sessions.ts:43`) | none | no interrupt |
| `interruptActiveThreadsForHost` `session-owner-side-effects.ts:121` (new instance id) | excepted unless the adopted and stored turns are both set and differ | Phase 6 test "keeps the adopted thread's turn active…" |
| `settleDanglingBackgroundTasks` :126 | excepted | Phase 6 |
| `reconcileDaemonReportedThreads` activeButMissing (`thread-lifecycle.ts:1894`) | only **running** adopted threads (adopted turn set and equal to the stored active turn) join the reported set; excepted ones are skipped by the active-but-missing interrupt | 74eff4751, see below |
| `interruptPendingInteractionsForHostThreads` :117 | not excepted: the old question or approval is interrupted, then re-created from the replayed request | asked again, see below; test c08c5a33f |
| stale adopted turn (server ended it) | interrupted by design; the daemon opens a new segment | test "interrupts an adopted thread whose turn the server no longer recognizes" |

Not a swap path: `handleHostRemoved` :187 (interrupts with no grace, :213) is
reached only from `DELETE /hosts/:id` (`routes/hosts.ts:191`), which refuses
the primary host, so never on this Mac.

**Idle threads on an adopted worker (fixed in 74eff4751).** The
real-provider end-to-end run (claude-code, thr_9v2kit77zf) found that an
idle thread on an adopted worker came back `active` with no turn and stayed
that way. The daemon lists every thread of an adopted worker, idle ones
included, with `activeTurnId: null`. The server trusted any adopted thread
whose stored active turn was null and merged it into the reported-active
set, so reconcile's `inactiveButActive` applied `run.started` to it. The fix
splits the adopted set:

- **running:** the adopted turn is set and equals the stored active turn.
  Only these count as reported-active, so only these can be revived.
- **excepted:** not interrupted, including reconcile's active-but-missing
  sweep, when the two turns are equal (both null, or the same id), or when
  the adopted turn is set and the server holds none (the daemon opens a new
  segment). An adopted turn of null while the server still holds turn X is
  **not** excepted (92d8d4b1e, after review): X is interrupted as before
  adoption. Otherwise a completion that never arrives (ungraceful death, a
  registry write that ran ahead of server acceptance) would leave the thread
  active with no turn anywhere. The cost: if X's `turn/completed` was still
  in the replay buffer, the thread shows interrupted although the turn
  finished. A graceful detach waits for events to settle before release, so
  that case needs an ungraceful path. Test "interrupts a thread whose adopted
  worker reports no turn while the server still holds one": fails on
  74eff4751, passes on 92d8d4b1e.

A stale seed (adopted turn set, stored turn null) is excepted but not running.
The thread becomes active through the daemon's new-segment `turn/started`,
which applies `run.started` (`apps/server/src/internal/events.ts:357-383`).
Tests: "leaves an idle thread on an adopted worker idle across a restart" and
"interrupts a thread whose adopted worker reports no turn while the server
still holds one" (replaced by 92d8d4b1e). Both fail on b3422ea81/c08c5a33f (`expected 'active' to be 'idle'`,
`expected 'error' to be 'active'`) and pass on 74eff4751.

**Pending interactions across a swap: asked again, no hang (measured).**
The earlier version of this section called this a gap. The measurement
disagrees:

1. At session open the server interrupts the old interaction (:117).
2. The provider's request line is not acked until answered, so the worker
   replays it to the new daemon.
3. A pending interaction is not an event, so replay-key dedup does not touch
   it. The runtime registers it through `onInteractiveRequest` →
   `POST /session/interactive-request`
   (`apps/host-daemon/src/interactive-request-registry.ts` `registerAndWait`).
4. The adopted process gets a fresh `interactiveRequestScope`
   (`packages/agent-runtime/src/runtime-provider-process.ts:506`), so the
   replayed request has a new `providerRequestId`. The server creates a new
   pending interaction
   (`apps/server/src/services/interactions/pending-interactions.ts:386-428`).
   The user is asked again, and the answer goes to the adopted worker.

Test `tests/integration/fake/recovery/graceful-restart-pending-approval.test.ts`
(c08c5a33f) runs a scripted-provider turn blocked on a command approval
through detach, adopt and answer. The turn completes on the same `turn/started`,
with no `system/thread/interrupted`. It passed 3 runs of 3.

Counter-check, with the scope forced to a fixed string so the replay reuses
the old id: the server answers "already handled" (:392-397), the daemon
rejects, the runtime sends the provider a JSON-RPC error
(`runtime-provider-requests.ts:360-374`), and the turn ended `failed` about
2 s after adoption. No hang in either branch. Not verified: how a real
codex or claude-code bridge reacts to an approval asked twice.

### Other deviations and additions

- **Socket path length.** `<dataDir>/bridge-workers/<12 hex>.sock` must fit
  `sun_path` (104 bytes on macOS, 108 on Linux). That leaves 70 or 74 bytes
  for the data dir. `~/.bb`, `~/.bb-dev/<id>` and `~/.bb-machines/<host>` fit,
  but a longer `BB_DATA_DIR` fails every provider launch with a clear error.
  Decided: allow a fallback directory (00cc40aab, on
  `patch/issue-3143-followups`). A socket path that would not fit goes to
  `/tmp/bb-<uid>/<16 hex sha256(workerDir)>/<id>.sock`. Both directories are
  created 0700 and lstat-checked: a symlink, a non-directory, another owner,
  or any group/other bit is refused, never repaired. The registry records the
  real path. The spill file stays in the worker dir via `BB_BRIDGE_SPILL`. The
  `/tmp/bb-<uid>/<digest>` directories are never removed (one per data dir).
- **Phase 3 interim retirement.** Phase 3 retired live workers on daemon start
  (no double worker before adoption existed). Phase 5 replaced it with
  adoption, and anything not adoptable is still retired.
- **Backpressure.** Past a 1 GiB hard cap on unacked output, the worker
  SIGSTOPs its own descendant processes (the provider), and SIGCONTs them when
  the daemon catches up. Bridges ignore `process.stdout.write` backpressure,
  so this is the only way to stall the agent instead of dropping output.
  After review (fixup 8b9374250): SIGCONT goes to the exact pids stopped
  plus the current tree, so a stopped grandchild that was re-parented to
  launchd is still continued. The pause only holds while a daemon is attached
  or reattaching. A detach releases it, and a detached worker is never
  paused, so the reattach TTL can always retire it cleanly. `bridge/shutdown`,
  the TTL and SIGTERM/SIGINT all continue the provider first. Pause and
  release are logged to the worker log with the pids and retained bytes. The
  cost: while detached, memory stays at 64 MiB (disk spill), but disk is
  bounded only by provider output over the 30-minute reattach window.
- **Closing races found by the end-to-end test.** A daemon that is shutting
  down refuses new environments and new spawns. An adopted runtime counts as
  busy from the moment it is adopted, so an early command with a different
  skill catalog cannot replace it and stop its worker.
- **Linux.** `install-machine.sh` sets `KillMode=process` for new installs and
  re-runs. Existing units only get it when the installer runs again; the
  drop-in the design mentions is not done.
- **Mac quit ordering (phase 7).** bb-app now signals the daemon first and the
  server once the daemon stops or after a 3 s head start. Without it, the
  detach raced a server that was shutting down in the same quit.
- **Autoinstall.** `fork-swap-survivable.sh <installed> <staged>` decides
  whether a swap keeps agents alive: both builds contain the adoption routes,
  with the same bridge protocol and socket framing. `fork-autoinstall.sh`
  skips the "no running threads" and "bb quiet" checks only then. It still
  waits until nobody is at the Mac, because the UI restarts. It also greps the
  installed bundle's `daemon-bundle.mjs` and `start-server.js` for the
  adoption route, because `installed-commit` is only a claim:
  `fork-rollback.sh` restores an older app without resetting that file.
  Tested with `test-fork-swap-survivable.sh`, which includes the rollback
  case.

### Review and real-provider e2e follow-ups (2026-09-11)

From the independent review (thr_4urbvvtvvw, /tmp/r3143-review-report.md)
and the real-provider e2e (thr_9v2kit77zf). Each fix has a test that fails
without it.

| Item | Commit | What changed |
|---|---|---|
| e2e 2: idle workers vanished silently | 0e9bfbcd4 | Cause: stock idle eviction. A changed login-shell env (re-resolved on provider health, usage and model calls) stops every idle environment runtime, adopted workers included. It is kept, now logged: stop reasons with worker ids and pids, exits, detach, and the reconcile at info level. |
| F3: active thread, no stored turn, null adoption stayed active | 353f65ff7, reworked in ad22c87d6 | The immediate interrupt was wrong: it wrote `system/thread/interrupted` between the thread's `client/turn/requested` and a `turn/started` still in the worker's replay buffer, and `hasThreadStopBeforeTurnStarted` (apps/server/src/internal/events.ts:568-617, used at :363 and :394) then skipped that `turn/started`, so the provider ran a turn the thread never showed. Now the thread is excepted at session open and re-checked once, 60 s later (`ADOPTED_THREAD_TURN_REPLAY_GRACE_MS`): it is interrupted only if it is still active with still no stored turn. Recorded gap, ACCEPTED 2026-09-11, no fix and no persistence work: the 60 s timer is in memory, so a server that stops inside the window loses it. Reaching that needs a second restart within 60 s of the first, and the next daemon reconnect reconciles the thread anyway - it reports no adoption for it, and `activeButMissing` interrupts it. Verified by the reviewer at ad22c87d6: 5/5 on the null-adoption tests, 8/8 on the adopted-threads tests, 10/10 recovery integration. |
| F7: detached threads' background tasks never settled | 852309a42 | The 10-minute callback settles them. |
| F8: detach could outlast the launcher's SIGKILL | bd976278f | Environments detach in parallel; settle waits at most 1.5 s, the notice at most 1 s. |
| F6: commands before adoption saw no active turn | 4d6ae8564 | thread.* and turn.* commands wait for adoption to settle (max 15 s). |
| F4: one pending request blocked the worker's ack | f674c7c96 | `bridge/ack {through, keep}`: the ack goes past an unanswered request and keeps only it for replay. Transport version 2. |
| e2e 1: item open at the swap stayed pending forever | ee5fc9602 | At session open the server settles the adopted threads' open background tasks and completes the adopted turn's open items as interrupted. |
| e2e 3: re-asked interaction left open after its turn completed | 2049ae213 | On turn/completed the daemon rejects that turn's pending requests (answering the worker) and asks the server to interrupt them. Stock had the same gap. |
| F9: socket limbo | ede92c9f7 | The daemon redials a live worker whose socket dropped and resumes. |
| F9: racy detach test | 8c63848fb | Asserts worker identity, not a pre-turn snapshot. |
| F10: reconnect resume acked unaccepted output | 031962041 | `bridge/resume` carried the last received wseq, so the worker dropped frames whose events the server had not stored. It carries the acknowledged position now; the receive-side wseq check still suppresses duplicates. |
| F10: failToConnect SIGKILLed a spawned worker's group | 8e85edaa1 | It asks over the socket first, falls back to SIGTERM when the socket is unreachable, and kills only if the process is still alive 1 s later. |
| F10: an answer lost with its socket stranded the request | 65cecf449 | `responded(id)` fired when the daemon wrote the response, so a socket dying with those bytes on it left the provider waiting while the next ack dropped the request. Responses are confirmed only by an ack that left on a live socket; a socket that closes first restores them to the keep list. |
| F12: an unreachable worker's log was deleted before its tail was read | b0566b2b6 (rebased 781caa367) | The stop went through retireBridgeWorker, which removes the log; it now only sends bridge/shutdown and leaves removal to the exit path. Same commit: whenExited kept its listener after a timeout, and a keep restored by a dying socket was never replayed, because resume skipped kept frames at or below the resume point and the receive side dropped them as already seen. |
| F13: an adopted runtime was evicted while its provider work was unknown | fe7f79b5c, simplified in 2e453114f | Current rule: an adopted runtime is exempt from both idle-eviction paths and skill-catalog replacement for a flat 15 minutes (ADOPTED_RUNTIME_PROTECTION_MS, inside entryHasActiveRuntimeWork), and the expiry is logged. Nothing releases it early. Two earlier attempts were dropped: seeding open background task ids from the server (it can never fire - closeItemsOrphanedByAdoption settles those tasks at session open before the daemon asks, and a fresh delta assembler mints new item ids, so a seeded id could never clear), and releasing the hold when a thread completed a turn (it lost a pre-swap command as soon as any new turn finished, for slightly earlier eviction). The honest limit: inside the window an adopted runtime is not evicted whatever it is doing; after it, an adopted thread with pre-swap background work the daemon cannot see can still be evicted by a login-shell change. The limit is bounded by the window, not by whether a new turn happened. Marking a still-running background task "stopped" at session open is a deliberate trade against leaving it pending forever: after adoption the daemon mints new item ids and will never update the old ones, so a terminal-but-wrong status beats a non-terminal one. Only a worker-side open-work report would remove the need for that trade, and it costs a transport bump to 3, which makes the first swap onto it non-survivable again. |
| F8 follow-up: unbounded steps ran before the detach notice | 1db90df70 | shutdownRuntimes now runs the bounded steps first - monitors, detach notice (<=1 s), shutdownAll("detach") (<=1.5 s), event flush, connection close - and the plugin host, auth proxy, local API, tunnel, watchers and terminals after. Checked before reordering: a local API request arriving in that window cannot resurrect anything, because RuntimeManager.shutdownAll sets runtimesClosed first for both modes (ensureEnvironment throws) and ProviderProcessManager.closeAll sets shuttingDown before the settle wait. |
| F4 follow-up: a kept spilled frame pinned the buffer in spilling mode | f3193e1f4 | append spilled whenever spilled.length > 0, so one open approval sent every later frame to disk while attached and the file never shrank. Spilling is decided by memory pressure alone now, and framesAfter merges the memory and spill lists by wseq. Test: a kept spilled frame plus 10k acked frames leaves the spill file size unchanged (340 KB before, 12 KB after). |
| F10: an ack write was treated as proof of delivery | d8ddeb86f | sendAck cleared the unconfirmed responses when the ack was written, so a socket dying between the write and the flush lost the answer and the ack together, dropped the kept request and left the provider waiting. They clear on the first frame received after that ack instead, and a reattached socket sends one, so a keep restored by the drop reaches the worker. The rule is an approximation - a frame proves the worker is alive and reading, not that it processed our ack - and it trades a hang for a possible duplicate ask when the provider goes quiet right after answering. |
| F10(c): a replacement storm between two daemons | 0534cf5f3 | Every drop was followed by an immediate redial at the 25 ms connect retry, so two un-released daemons on one data dir would trade a worker between them. Measured without the fix: 18,465 connection attempts in 1.5 s. A connection that dies within a second of attaching now backs off, doubling from 100 ms to a 2 s cap (against BRIDGE_REATTACH_TTL_MS of 30 minutes); a connection that survives resets it. Defence in depth - the data-dir lock is what is supposed to prevent two daemons. |
| F6 polish | 2e453114f | The adoption gate waits only for commands whose thread is being adopted, and its 15 s timer is unref'd. |
| F9: replay-key race | 596f0de75 | The keys are re-checked inside the append transaction; a batch that lost the race gets a retryable 503. |

Not mine, per the coordinator: F2, F5, the duplicate processKey and
socketPath validation (thr_uvk7k262wu, patch/issue-3143-followups). Spill
compaction is skipped (bounded by the TTL).

## Phase 7 end-to-end check (manual, not run yet)

Run only at a safe moment. It quits bb, which today (before this chain is
installed) stops every agent. It proves the claim only once the installed
build *and* the build you swap to both contain this chain.

Preconditions:

1. Build and install a fork build from `patch/issue-3143` (or from `ours`
   after the chain merges). Its `installed-commit` must pass
   `fork-swap-survivable.sh <installed> <same commit>`. Make sure no other
   agent you care about is mid-turn on an older build.
2. `ls ~/.bb/bridge-workers/` exists after starting any thread: a `.json`,
   `.sock` and `.log` per worker.

Procedure:

1. Start a long codex turn in a scratch project, for example:
   `bb thread spawn --provider codex ...` with the prompt "Run
   `for i in $(seq 1 30); do echo tick $i; sleep 10; done` in the shell and
   report each tick". Note the thread id `T`.
2. Wait until two or three ticks are visible. Record:
   - `bb thread show T` (status `active`, the active turn id `TURN1`);
   - `ls ~/.bb/bridge-workers/*.json` and, for the entry holding `T`, its
     `pid` (`jq .pid`) and `threads[T].activeTurnId`, which must equal
     `TURN1`;
   - `ps -o pid,etime -p <pid>`.
3. Quit bb (Cmd-Q). While it is closed:
   - `ps -o pid,etime -p <pid>`: the worker is still alive, and so is its
     codex child (`pgrep -P <pid>`);
   - its `.json` entry still exists;
   - `tail ~/.bb/logs/host-daemon.*.log` (newest) shows
     `Shutting down host daemon` with reason `SIGTERM` and no provider exit.
4. Relaunch bb. Within about a minute:
   - the worker pid from step 2 is still alive and is still the pid in its
     registry entry. The "Reconciled provider bridge workers" message is logged
     at debug level, which the desktop's log files do not keep, so the pid is
     the evidence;
   - `bb thread show T` still reports `active` with the same `TURN1`, never
     `error` or `interrupted`;
   - the thread keeps printing ticks, with at most one visible segment break
     (the command output may continue as a new item);
   - `ls ~/.bb/bridge-workers/*.json` still lists exactly one worker holding
     `T`, with the same pid.
5. Let the turn finish. `bb thread show T` goes `idle`. `bb thread log T`
   shows exactly one `turn/started` and one `turn/completed` for `TURN1`
   (status completed), and no `system/thread/interrupted` event.
6. Negative check: repeat step 3, but relaunch after more than 30 minutes, or
   `kill -9` the daemon while bb runs. The turn may show a new segment. The
   thread must still end `idle` (or `error` with a clear message), never stuck
   `active`.

Pass criteria: steps 3-5 hold; no second worker for `T`; no duplicated tick
lines beyond the documented segment break. Record the timings (quit to
relaunch, relaunch to first new tick) next to the numbers measured above.

## After the merge: what is still unproven (2026-09-11)

Merged into `ours` at 476bde366 and staged. Two things remain untested on the
real app, and the order they happen in matters:

1. **The first install of this build cannot be survivable**, and that is by
   design: the registry format version goes from absent to 1, so
   `fork-swap-survivable.sh` refuses, and `fork-autoinstall.sh` keeps its
   "no running threads" gate. Agents stop that once.
2. **The phase 7 end-to-end check has still never run against the desktop
   app.** Every real-provider pass so far (A, C, D, E, and the post-merge A)
   ran against an isolated `bb-app` instance, which exercises the launcher,
   server, daemon and workers but NOT the Electron wrapper's quit path
   (`apps/desktop/src/main.ts`, SIGTERM then SIGKILL of `bb-app`).

So the supervised check is: after the first install, start a long turn, quit
bb from the menu, reopen it, and confirm the same turn keeps streaming and
completes. Only when that passes does `bb-fork-tools/survivable-verified` get
written, which is what lets the auto-installer swap while threads are running.
