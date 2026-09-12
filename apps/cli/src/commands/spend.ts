import { Command } from "commander";
import type { BbSdk } from "@bb/sdk/node";
import type { SpendGroupByQueryValue } from "@bb/server-contract";
import { action } from "../action.js";
import { createCliBbSdk } from "../client.js";
import { resolveContextSnapshot } from "../context-env.js";
import { renderBorderlessTable } from "../table.js";
import { outputJson } from "./helpers.js";

const HERMES_PROVIDER = "acp-hermes-agent";
const DEFAULT_WINDOW_DAYS = 14;
const DEFAULT_ANALYSIS_TIMEOUT_MS = 300_000;
const ACTIVE_WAIT_MS = 30_000;
const DAY_MS = 86_400_000;

type ResolveServerUrl = () => string;

interface SpendListOptions {
  by?: string;
  from?: string;
  json?: boolean;
  provider?: string;
  thread?: string;
  to?: string;
}

interface SpendAnalyzeOptions {
  days?: string;
  dryRun?: boolean;
  json?: boolean;
  show?: boolean;
  topic: string;
}

const GROUP_BY_VALUES: readonly SpendGroupByQueryValue[] = [
  "day",
  "thread",
  "provider",
  "model",
];

function localDay(at: number): string {
  const date = new Date(at);
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function parseGroupBy(value: string | undefined): SpendGroupByQueryValue {
  if (value === undefined) return "provider";
  const match = GROUP_BY_VALUES.find((candidate) => candidate === value);
  if (match === undefined) {
    throw new Error(`--by must be one of ${GROUP_BY_VALUES.join(", ")}`);
  }
  return match;
}

function compact(value: number): string {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return `${value}`;
}

function labelFor(
  groupBy: SpendGroupByQueryValue,
  row: { day: string; model: string; providerId: string; threadId: string },
): string {
  if (groupBy === "day") return row.day;
  if (groupBy === "thread") return row.threadId;
  if (groupBy === "provider") return row.providerId;
  return row.model === "" ? "unknown-model" : row.model;
}

/**
 * The machine that can run a Hermes review, if one is connected.
 *
 * A host is a candidate only if it actually exposes the provider: a connected
 * machine that does not is not a Hermes, and reporting one as available is how
 * a review comes back as a timeout instead of a clear refusal.
 */
async function findHermesHost(
  sdk: BbSdk,
): Promise<{ id: string; name: string } | null> {
  const hosts = await sdk.hosts.list().catch(() => []);
  for (const host of hosts) {
    if (host.status !== "connected") continue;
    const providers = await sdk.providers
      .list({ hostId: host.id })
      .catch(() => []);
    if (providers.some((provider) => provider.id === HERMES_PROVIDER)) {
      return { id: host.id, name: host.name ?? host.id };
    }
  }
  return null;
}

async function readThreadOutput(sdk: BbSdk, threadId: string): Promise<string> {
  const result = await sdk.threads.output({ threadId }).catch(() => null);
  if (result === null) return "";
  if (typeof result === "string") return result;
  const record = result as { output?: string; text?: string };
  return record.output ?? record.text ?? "";
}

/**
 * A checkout on the reviewer's machine to open the thread in.
 *
 * A reviewer reads the question, not the repository, but a thread still has to
 * open somewhere. The caller's own project usually has no source on the Hermes
 * box - the common default is the personal project, which cannot hold one at
 * all - so any project with a source there is borrowed. The borrowed project
 * decides only which directory the thread opens in.
 */
async function findHermesWorkspace(
  sdk: BbSdk,
  args: { hostId: string; projectId: string },
): Promise<{ path: string; projectId: string } | null> {
  const sourceOn = async (projectId: string): Promise<string | null> => {
    const project = await sdk.projects.get({ projectId }).catch(() => null);
    return (
      project?.sources.find((source) => source.hostId === args.hostId)?.path ??
      null
    );
  };
  const own = await sourceOn(args.projectId);
  if (own !== null) {
    return { path: own, projectId: args.projectId };
  }
  const projects = await sdk.projects.list().catch(() => []);
  for (const candidate of projects) {
    if (candidate.id === args.projectId) continue;
    const path = await sourceOn(candidate.id);
    if (path !== null) {
      return { path, projectId: candidate.id };
    }
  }
  return null;
}

/**
 * Send one analysis request to Hermes and return what it answers.
 *
 * Three behaviours here are carried over from `bb fleet validate`, which
 * discovered each of them the hard way:
 *
 *   * `threads.send` requires `mode`. Without it every send fails and a caller
 *     that swallows the error spawns a fresh reviewer instead of continuing;
 *   * waiting for `idle` on a thread that is ALREADY idle returns immediately,
 *     so the read returns the PREVIOUS answer as though it were new. The output
 *     before sending is captured and the new text has to differ;
 *   * a topic's thread is not archived, or the next round faces a reviewer that
 *     has never seen the round it is following up on.
 */
async function consultHermes(
  sdk: BbSdk,
  args: {
    host: { id: string; name: string };
    payload: string;
    threadId: string | null;
    timeoutMs: number;
    topic: string;
    workspace: { path: string; projectId: string };
  },
): Promise<{ response: string; threadId: string }> {
  if (args.threadId === null) {
    const spawned = await sdk.threads.spawn({
      projectId: args.workspace.projectId,
      environment: {
        type: "host",
        hostId: args.host.id,
        workspace: { type: "unmanaged", path: args.workspace.path },
      },
      title: `spend analysis: ${args.topic}`,
      providerId: HERMES_PROVIDER,
      visibility: "hidden",
      prompt: args.payload,
      // `ThreadSpawnArgs` does not type `environment`, and a review thread has
      // to open in a checkout on the reviewer's machine rather than the
      // caller's. This is the boundary, so the cast stays here and narrows
      // immediately into a thread id.
    } as never);
    const threadId = spawned.id;
    await sdk.threads.wait({
      threadId,
      status: "idle",
      timeoutMs: args.timeoutMs,
    });
    const answer = await readThreadOutput(sdk, threadId);
    if (answer.trim() === "") {
      throw new Error(
        `Hermes on ${args.host.name} produced no answer for topic ${args.topic}.`,
      );
    }
    return { response: answer.trim(), threadId };
  }

  const threadId = args.threadId;
  const before = await readThreadOutput(sdk, threadId);
  // `mode` is required by the route and absent from `ThreadSendArgs`. Omitting
  // it makes every send fail, which is how the plugin this follows ended up
  // spawning a fresh reviewer each round while believing it continued one.
  await sdk.threads.send({
    threadId,
    mode: "auto",
    input: [
      {
        type: "text",
        text: args.payload,
        mentions: [],
        visibility: "agent-only",
      },
    ],
  } as never);
  await sdk.threads
    .wait({ threadId, status: "active", timeoutMs: ACTIVE_WAIT_MS })
    .catch(() => undefined);
  await sdk.threads.wait({
    threadId,
    status: "idle",
    timeoutMs: args.timeoutMs,
  });
  const after = await readThreadOutput(sdk, threadId);
  if (after.trim() === "" || after.trim() === before.trim()) {
    throw new Error(
      `Hermes on ${args.host.name} produced no new answer for topic ${args.topic}.`,
    );
  }
  return { response: after.trim(), threadId };
}

export function registerSpendCommands(
  program: Command,
  getUrl: ResolveServerUrl,
): void {
  const spend = program
    .command("spend")
    .description("Token and usage totals recorded by the server");

  spend
    .command("list", { isDefault: true })
    .description("Show recorded token totals")
    .option("--by <dimension>", "day, thread, provider or model")
    .option("--from <day>", "First local day to include (YYYY-MM-DD)")
    .option("--to <day>", "Last local day to include (YYYY-MM-DD)")
    .option("--thread <id>", "Only this thread")
    .option("--provider <id>", "Only this provider")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (opts: SpendListOptions) => {
        const groupBy = parseGroupBy(opts.by);
        const sdk = createCliBbSdk(getUrl());
        const now = Date.now();
        const result = await sdk.spend.rollup({
          from: opts.from ?? localDay(now - (DEFAULT_WINDOW_DAYS - 1) * DAY_MS),
          to: opts.to ?? localDay(now),
          groupBy,
          ...(opts.thread === undefined ? {} : { threadId: opts.thread }),
          ...(opts.provider === undefined
            ? {}
            : { providerId: opts.provider }),
        });
        if (outputJson(opts, result)) return;

        if (result.rows.length === 0) {
          console.log("No spend recorded for this window.");
          console.log(
            "If the rollup is new, run `bb spend backfill` to replay the usage events still in the store.",
          );
          return;
        }
        // The cost column appears only when a price exists for something in the
        // window. bb ships no prices, so normally it does not, and a column of
        // dashes would read as "free" rather than "not priced".
        const priced = result.rows.some((row) => row.costUsd !== null);
        console.log(
          renderBorderlessTable(
            {
              head: [
                groupBy,
                "total",
                "fresh in",
                "cached",
                "out",
                "weighted",
                "turns",
                ...(priced ? ["usd"] : []),
              ],
              colWidths: [34, 10, 10, 10, 10, 12, 7, ...(priced ? [10] : [])],
            },
            result.rows.map((row) => [
              labelFor(groupBy, row),
              compact(row.totalTokens),
              compact(row.inputTokens),
              compact(row.cachedInputTokens),
              compact(row.outputTokens),
              compact(Math.round(row.weightedUnits)),
              `${row.turns}`,
              ...(priced
                ? [row.costUsd === null ? "no price" : row.costUsd.toFixed(2)]
                : []),
            ]),
          ),
        );
        console.log("");
        console.log(
          "weighted = fresh input x1 + cached x0.1 + output x5. A cost proxy, not money.",
        );
        if (!priced) {
          console.log(
            "No dollar figure: fork_spend_prices is empty and bb does not guess a rate.",
          );
        }
        if (result.coverage.historyPartial > 0) {
          console.log(
            `${result.coverage.historyPartial} of ${result.coverage.threads} threads had usage events pruned before the rollup existed; their totals are floors.`,
          );
        }
      }),
    );

  spend
    .command("backfill")
    .description("Replay the usage events still in the event store")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (opts: { json?: boolean }) => {
        const sdk = createCliBbSdk(getUrl());
        const result = await sdk.spend.backfill();
        if (outputJson(opts, result)) return;
        console.log(`Threads scanned:        ${result.threadsScanned}`);
        console.log(`Usage events scanned:   ${result.usageEventsScanned}`);
        console.log(`Contributions applied:  ${result.contributionsApplied}`);
        console.log(`History complete:       ${result.threadsHistoryComplete}`);
        console.log(`History partial:        ${result.threadsHistoryPartial}`);
        if (result.threadsHistoryPartial > 0) {
          console.log("");
          console.log(
            "A partial thread had usage events pruned before this existed. Its recorded total is a floor.",
          );
        }
      }),
    );

  spend
    .command("analyze")
    .description("Ask Hermes to assess the recorded totals (never automatic)")
    .requiredOption("--topic <name>", "Reuse a topic to continue one review")
    .option("--days <n>", "Days of history to send", `${DEFAULT_WINDOW_DAYS}`)
    .option(
      "--dry-run",
      "Print exactly what would be sent and exit without sending",
    )
    .option("--show", "Print the stored assessment for this topic and exit")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (opts: SpendAnalyzeOptions) => {
        const sdk = createCliBbSdk(getUrl());

        if (opts.show === true) {
          const stored = await sdk.spend.assessments({ topic: opts.topic });
          if (outputJson(opts, stored)) return;
          const assessment = stored.assessments[0];
          if (assessment === undefined) {
            console.log(`No stored assessment for topic ${opts.topic}.`);
            return;
          }
          console.log(
            `${assessment.windowFrom} to ${assessment.windowTo} via ${assessment.host} (payload ${assessment.payloadSha256.slice(0, 12)})`,
          );
          console.log("");
          console.log(assessment.response);
          return;
        }

        const days = Number.parseInt(opts.days ?? `${DEFAULT_WINDOW_DAYS}`, 10);
        if (!Number.isFinite(days) || days < 1) {
          throw new Error("--days must be a positive whole number.");
        }
        const now = Date.now();
        const built = await sdk.spend.analysisPayload({
          from: localDay(now - (days - 1) * DAY_MS),
          to: localDay(now),
        });

        if (opts.dryRun === true) {
          if (outputJson(opts, built)) return;
          console.log(
            `Would send ${built.rows} rows, sha256 ${built.sha256}. Nothing has been sent.`,
          );
          console.log("");
          console.log(built.payload);
          return;
        }

        const host = await findHermesHost(sdk);
        if (host === null) {
          throw new Error(
            `No connected machine exposes ${HERMES_PROVIDER}. Nothing was sent.`,
          );
        }
        const context = resolveContextSnapshot();
        const projectId = context.projectId;
        if (projectId === null || projectId === undefined) {
          throw new Error(
            "No project in context. Run this from a project, or pass BB_PROJECT_ID.",
          );
        }
        const workspace = await findHermesWorkspace(sdk, {
          hostId: host.id,
          projectId,
        });
        if (workspace === null) {
          throw new Error(
            `No project has a source on ${host.name}, so a review thread cannot open there. Nothing was sent.`,
          );
        }
        const existing = await sdk.spend.assessments({ topic: opts.topic });
        const consultation = await consultHermes(sdk, {
          host,
          payload: built.payload,
          threadId: existing.assessments[0]?.threadId ?? null,
          timeoutMs: DEFAULT_ANALYSIS_TIMEOUT_MS,
          topic: opts.topic,
          workspace,
        });
        const assessment = await sdk.spend.recordAssessment({
          topic: opts.topic,
          requestedAt: now,
          windowFrom: built.windowFrom,
          windowTo: built.windowTo,
          payloadSha256: built.sha256,
          response: consultation.response,
          host: host.name,
          threadId: consultation.threadId,
        });
        if (outputJson(opts, assessment)) return;
        console.log(
          `Sent ${built.rows} rows (sha256 ${built.sha256.slice(0, 12)}) to ${host.name}.`,
        );
        console.log("");
        console.log(assessment.response);
      }),
    );
}
