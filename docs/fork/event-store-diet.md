# What the fork stops storing, and why

The event store grew to 2.9 GB in one month — 1,512,369 rows, of which the
`events` table and its indexes were 94%. A query under load took 4.4 s and
dropped both daemons. This is what the fork changed and what a user gives up.

The numbers below were measured on a consistent snapshot of a real 2.9 GB
database (`sqlite3 -readonly bb.db "VACUUM INTO snapshot.db"`), not estimated.

## What was already happening

Upstream is not missing retention. `completed-event-output-truncation` runs
every 10 s and had caught up to its own 7-day horizon: all four of its
`maintenance_scan_cursors` sat at the boundary, updated seconds ago. Its
threshold is 32 KiB, and only 85 MB of the 727 MB of stored command output was
above 32 KiB. The policy was working and aimed at bytes that were not there.

`event-pruning.ts` separately deletes rows by sequence for context-window
usage, token usage and turn diffs, and deletes resolved item deltas. Sequence
gaps mid-thread are therefore already normal, which is why dropping a row is
not a new class of risk.

## Dropped at ingest

**Codex hook telemetry.** A codex session emits `hook/started` and
`hook/completed` for every entry in the user's `hooks.json`. The codex bridge
classifies both as `unknown`, so the server stored each verbatim as
`provider/unhandled`: 457,229 rows, 314 MB, 30% of every row in the database
and 97% of that event type. The only surface that renders an unhandled event
is a timeline row behind `isDevelopment || showUnhandledProviderEvents`, and
that setting defaults to off. The one unconditional reader, model-fallback
extraction, only matches `claude-code` events whose method is `sdk/message`.

The filter is narrow on purpose — codex hook `rawType`s only, never
`provider/unhandled` as a type — because the `claude-code` `sdk/*` events
stored under it are what model fallback detection reads.

**`turn/diff/updated`.** 389 rows averaging 80 KB. The type is on the
timeline's own exclusion list, and no route, projection, CLI command, plugin or
automation reads it. It was produced only to be pruned.

Dropping `turn/diff/updated` also removes it as an in-turn prune trigger, since
the pruner only sees events that were stored, so it is removed from that trigger
set too rather than left as an entry that can never match. Three triggers remain.
Nothing depends on it: every root turn completion that moves a thread to idle
prunes unconditionally, as does archiving, and the in-turn path is only an
optimisation for long turns.

Dropping at ingest needs no protocol change. The daemon dequeues a batch on any
2xx and never reconciles which events came back in `acceptedEvents`, so a
shorter list causes no redelivery; upstream already drops events on this path
for orphan snapshots and execution reports.

## Truncated after 7 days

Upstream truncated one size for everything. The fork sets the threshold per
target, because the useful residue of a command log is not the useful residue
of a patch. Threshold equals retained size, split half as head and half as
tail — in a command log the last lines usually carry the failure.

| target | threshold | retained | why |
|---|---|---|---|
| `commandExecution` `aggregatedOutput` | 8 KiB | 4 KiB head + 4 KiB tail | 88 MB of old rows and 143 MB/week of new ones, at the cost of touching 12.6% of rows. An 8 KB command log is still a command log. |
| `toolCall` `result` | 4 KiB | 2 KiB + 2 KiB | Results are short; the long ones are dumps. |
| `fileChange` `changes[].diff` | 16 KiB | 8 KiB + 8 KiB | A handful of enormous patches dominate: 16 KiB leaves 97% of diffs completely intact, and truncating a patch destroys it rather than trimming it. |
| `webSearch` / `webFetch` `resultText` | 32 KiB | 2 KiB + 2 KiB | Unchanged from upstream. |

A file change stores its patches in `$.item.changes`, a structured array, so it
cannot be truncated the way a string path is: slicing the array's JSON text
produces invalid JSON. It is truncated structurally instead. Every entry
survives, so the file list a thread renders stays complete, and only each
entry's `diff` is shortened. The marker is left inline in the diff text because
`ThreadEventFileChange` has nowhere to record a truncation descriptor, and
adding one would change a contract shared with the daemon and the plugin SDK.

Two rules keep that honest. **Truncation never grows a payload**: a payload only
just over its threshold would come back longer once the marker is added, so
nothing is touched unless shortening it actually saves bytes. And **the
already-truncated test is structural, not a substring search**. Content can
quote the marker — a diff of the file defining it does, and on the live database
twelve command events quote it in their command line or output without having
been truncated at all. A substring test would exempt those from truncation
forever. A truncated diff instead has an exact shape: length equal to
head + marker + tail, with the marker at exactly `head`.

Both `item/started` and `item/completed` are scanned for file changes. They
carry the same array, and the timeline's output merge keeps whichever payload
is longer, so truncating one side alone would let the other re-inflate it.

## What a user loses

On a thread older than 7 days, a command that printed more than 8 KB now shows
its first and last 4 KB with a marker between them, instead of up to 32 KB.
This is not a new behaviour — it is what the product already did to any output
over 32 KiB, applied to more rows. Nothing changes inside the 7-day window.

Nothing else is affected, and this was checked rather than assumed:

- **Search** indexes exactly three things — the visible text of a prompt, the
  text of an `agentMessage`, and a manager message. It has never indexed
  command output, tool results, file diffs or unhandled provider events.
- **Token usage and spend** are untouched. No event type carrying usage,
  context-window, model or rate-limit data is dropped or truncated. The fleet
  plugin's ledger follows events with a cursor and reads only usage fields,
  `$.execution.model`, and item metadata — never an output payload.
- **The timeline read path** already caps inline output at 32,000 characters
  before it can reach a client, so anything stored beyond that was unreachable.

## Why these types and not others

bb already prunes. The pruner keeps at most two `thread/tokenUsage/updated` and
two `thread/contextWindowUsage/updated` rows per thread below its cutoff,
deletes `turn/diff/updated` wholesale below the cutoff, keeps only the earliest
delta per item, and keeps only the latest background-task progress per open
item. On a one-month database those types had collapsed to 2.0-2.5 rows per
thread, and background-task progress to five rows in total.

Every type at the top of the byte table is one the pruner never touches —
`item/completed`, `item/started`, `provider/unhandled`,
`provider/rateLimits/updated`, `client/turn/requested`. That is *why* they are
at the top, and it is the justification for this whole change: nothing here
re-solves a problem the pruner already solves.

## What retention does not do

The always-on sweep only ever moves forward. A target it has never scanned
seeds its cursor at the time of that first scan, so adding one never rewrites
the rows already on disk. Compacting existing rows is a separate, scheduled
pass, taken against a backup with the database idle, because reclaiming the
space needs a VACUUM and a VACUUM needs roughly twice the file size free.

Truncating a row shrinks the table and nothing else. Index bytes come back only
when a row is deleted.

## On upstream 0.43.1

Upstream 0.43.1 replaced the seven-day truncation sweep with insert-time
retention: an output over its threshold is stored in the event row as a
head-and-tail preview carrying a truncation descriptor, and the full text goes
to the `retained_event_outputs` sidecar, which the timeline hydrates from until
it expires seven days after the event. A one-time migration sweep converts
legacy rows over 32 KiB.

The per-target limits above now apply at that insert-time step
(`getCompletedEventOutputTruncationLimits` in
`packages/db/src/retained-event-output.ts`), so what a thread shows during its
first seven days is unchanged and the row is small from the start. The legacy
migration keeps upstream's 32 KiB candidate filter, so rows already on disk
between the fork threshold and 32 KiB are not rewritten, consistent with the
rule that introducing a target never rewrites existing rows. File-change diffs
are not an upstream retention target and keep their own sweep and cursor.
