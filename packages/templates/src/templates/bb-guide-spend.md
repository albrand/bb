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
  0.1, output 5. They are a cost proxy, not money. bb ships no prices, because
  a subscription has no per-token rate to apply and a guessed one would read as
  fact.

  Providers that report no token usage at all, such as ACP agents, are absent
  rather than estimated. `bb spend` reports coverage so "no data" is visibly
  different from "no spend".

Backfill:

  `bb spend backfill` replays the usage events still in the store. It is safe to
  run repeatedly and safe to run alongside live traffic. It reports how many
  threads it could only record a floor for, because their earlier usage events
  were pruned before the rollup existed. Those totals are partial and say so.

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
