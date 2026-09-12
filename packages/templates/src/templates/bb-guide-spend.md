---
kind: instruction
title: bb Guide Spend
summary: Token and usage totals the server records, and the explicit Hermes analysis step.
intent: Help agents read recorded spend and understand what the numbers do and do not cover.
editingNotes: Keep accurate against apps/server/src/routes/spend.ts and bb spend --help.
---
Spend commands

bb records per-thread, per-provider, per-model, per-day token totals as events
are stored.

  bb spend [--by day|thread|provider|model] [--from <day>] [--to <day>]
  bb spend [--thread <id>] [--provider <id>] [--json]
  bb spend backfill [--json]
  bb spend analyze --topic <name> [--days <n>] [--dry-run] [--show] [--json]

Days are local calendar days on the machine running the server. Each stored row
also carries the first and last event time behind it, so a consumer in another
timezone can tell whether a row straddles its own day boundary.

What it costs:

  Most event traffic carries no usage events, and there the rollup costs
  nothing: it returns before it touches the database. A realistic mixed batch
  costs about 6% of the event-append path on p50 and an all-usage batch about
  14%, which is 0.14 and 0.22 milliseconds per batch.

Why the server records this:

  `thread/tokenUsage/updated` is a prunable event type. The pruner keeps at most
  two of them per thread below its cutoff, so the event store is a window onto
  recent usage rather than a record of it. Anything that polls the event log for
  spend is racing deletion. The server sees each usage event before it is
  pruned, so it records the total then.

What the columns mean:

  Fresh input, cached input, output and reasoning output are disjoint counts.
  Providers disagree about whether cached input sits inside the input count;
  bb normalises to disjoint when it records the row, so the numbers are
  comparable across providers.

  Weighted units apply the published price ratios - fresh input 1, cached input
  0.1, output 5. They are a cost proxy, not money.

  Dollars come from `fork_spend_prices`, which ships EMPTY, so `bb spend` shows
  no dollar column until you put a rate in it. bb does not guess one: a
  subscription has no per-token rate to apply, and a guessed figure reads as
  fact. Insert a row per provider and model with input, cached-input and output
  dollars per million tokens to turn the column on. A grouped row reports no
  dollars if anything behind it is unpriced, rather than showing a partial sum
  as a total.

  Providers that report no token usage at all, such as ACP agents, are absent
  rather than estimated. `bb spend` reports coverage so "no data" is visibly
  different from "no spend".

Backfill:

  `bb spend backfill` replays the usage events still in the store. It is safe to
  run repeatedly and safe to run alongside live traffic.

At-least figures:

  A thread that spent tokens before this rollup existed has usage events bb has
  already deleted. Deletion leaves no trace, so there is no missing amount to
  report: that thread contributes a LOWER BOUND, and bb says "at least" rather
  than guessing. It is not a shortfall and nothing has gone wrong.

  A thread is counted from the start only when that can be proved, and there is
  exactly one proof: it has not reached the pruner's smallest keep-recent
  window, so the pruner cannot have deleted anything. An edited message also
  deletes events outright, so a thread carrying that marker is an at-least
  figure too.

  This heals on its own. Every thread started after this ships is counted from
  its first turn, so the share of at-least figures falls as old threads stop
  being used. A high count says something about history, not about the tracker.

Analysis:

  `bb spend analyze` asks a machine running the `acp-hermes-agent` provider to
  assess the recorded totals. It is never automatic; nothing is sent unless you
  run it. Reuse a `--topic` to continue one review rather than facing a reviewer
  that has not seen the previous round.

  What leaves the machine is built from the rollup's own columns: day, thread
  id, provider id, model, token counts, weighted units, turn counts, and the
  window's dates. No prompts, messages, titles, paths, project or host names, or
  credentials - the table has no column that can hold them. Run with `--dry-run`
  to print the exact bytes and send nothing.

  `--show` prints the stored assessment for a topic, with the digest of the
  figures it was given.
