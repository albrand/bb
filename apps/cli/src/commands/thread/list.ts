import { Command } from "commander";
import {
  jsonValueSchema,
  PERSONAL_PROJECT_ID,
  type JsonValue,
  type ThreadListEntry,
} from "@bb/domain";
import {
  isNativeActivityUnconfirmed,
  nativeActivityEvidenceKind,
} from "@bb/client-core";
import { action } from "../../action.js";
import { createCliBbSdk } from "../../client.js";
import { resolveExplicitIdFlag } from "../../context-env.js";
import {
  columnWidths,
  printBorderlessTable,
  truncateCell,
} from "../../table.js";
import { collectOption, outputJson } from "../helpers.js";
import {
  resolveMachineHostId,
  resolveMachineTargetOption,
} from "../machine.js";

interface ThreadListCommandOptions {
  environment?: string;
  machine?: string;
  host?: string;
  project?: string;
  parentThread?: string;
  thread: string[];
  archived?: boolean;
  all?: boolean;
  section?: string;
  unsectioned?: boolean;
  json?: boolean;
  includeHidden?: boolean;
}

export function registerListCommand(
  parent: Command,
  getUrl: () => string,
): void {
  parent
    .command("list")
    .description(
      "List active threads; --thread IDs can include archived threads; use --archived or --all for history",
    )
    .option("--project <id>", "Filter by project ID (defaults to all projects)")
    .option("--environment <id>", "Filter by environment ID")
    .option(
      "--machine <id-or-name>",
      "Filter by machine ID or active machine name",
    )
    .option("--host <id-or-name>", "Alias for --machine")
    .option("--parent-thread <id>", "Filter by parent thread ID")
    .option(
      "--thread <id>",
      "Show only this thread ID, including archived threads; leave out unknown or deleted IDs (repeatable, up to 200)",
      collectOption,
      [],
    )
    .option("--section <id>", "Filter by thread section ID")
    .option("--unsectioned", "Show only threads outside sections")
    .option("--archived", "Show only archived threads")
    .option("--all", "Include archived and non-archived threads")
    .option("--include-hidden", "Include hidden threads")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (opts: ThreadListCommandOptions) => {
        if (opts.all && opts.archived) {
          throw new Error("--all cannot be combined with --archived.");
        }
        const sdk = createCliBbSdk(getUrl());
        const projectId = resolveExplicitIdFlag({
          flagName: "--project flag",
          value: opts.project,
        });
        const parentThreadId = resolveExplicitIdFlag({
          flagName: "--parent-thread",
          value: opts.parentThread,
        });
        const threadIds = opts.thread.flatMap(
          (value) =>
            resolveExplicitIdFlag({ flagName: "--thread", value }) ?? [],
        );
        const environmentId = resolveExplicitIdFlag({
          flagName: "--environment",
          value: opts.environment,
        });
        const machineTarget = resolveMachineTargetOption(opts);
        const hostId =
          machineTarget === undefined
            ? undefined
            : machineTarget.trim().startsWith("host_")
              ? resolveExplicitIdFlag({
                  flagName: "--machine",
                  value: machineTarget,
                })
              : await resolveMachineHostId({
                  serverUrl: getUrl(),
                  target: machineTarget,
                });
        if (opts.section && opts.unsectioned) {
          throw new Error("Cannot combine --section with --unsectioned.");
        }
        const sectionId = resolveExplicitIdFlag({
          flagName: "--section",
          value: opts.section,
        });
        const threads = await sdk.threads.list({
          ...(projectId ? { projectId } : {}),
          ...(environmentId ? { environmentId } : {}),
          ...(hostId ? { hostId } : {}),
          ...(parentThreadId ? { parentThreadId } : {}),
          ...(threadIds.length > 0 ? { threadIds } : {}),
          ...(opts.archived
            ? { archived: true }
            : opts.all || threadIds.length > 0
              ? {}
              : { archived: false }),
          ...(sectionId ? { sectionId } : {}),
          ...(opts.unsectioned ? { unsectioned: true } : {}),
          ...(opts.includeHidden ? { includeHidden: true } : {}),
        });
        const wokeThreadIds = await getWokenThreadIds(sdk);
        if (
          outputJson(
            opts,
            threads.map((thread) => ({
              ...thread,
              listIndicator: activityAwareListIndicator(thread, wokeThreadIds),
            })),
          )
        )
          return;
        if (threads.length === 0) {
          console.log("No threads found");
          return;
        }
        const projects = await sdk.projects.list({ includePersonal: false });
        const projectNames = new Map(
          projects.map((project) => [project.id, project.name]),
        );
        printThreadTable(threads, projectNames, wokeThreadIds);
      }),
    );
}

const MAX_TITLE_WIDTH = 60;

function printThreadTable(
  threads: ThreadListEntry[],
  projectNames: ReadonlyMap<string, string>,
  wokeThreadIds: ReadonlySet<string>,
): void {
  const rows = threads.map((thread) => [
    thread.id,
    truncateCell(formatThreadListTitle(thread), MAX_TITLE_WIDTH),
    formatThreadListProject(thread, projectNames),
    formatThreadListStatus(thread),
    formatThreadListIndicator(thread, wokeThreadIds),
  ]);
  printBorderlessTable(
    {
      head: ["ID", "Title", "Project", "Status", "Needs you"],
      colWidths: columnWidths(rows, [4, 5, 7, 12, 10]),
    },
    rows,
  );
}

function formatThreadListTitle(thread: ThreadListEntry): string {
  const title = thread.title?.trim();
  if (title) return title;
  const fallback = thread.titleFallback?.trim();
  if (fallback) return fallback;
  return "-";
}

function formatThreadListProject(
  thread: ThreadListEntry,
  projectNames: ReadonlyMap<string, string>,
): string {
  if (thread.projectId === PERSONAL_PROJECT_ID) return "-";
  return projectNames.get(thread.projectId) ?? thread.projectId;
}

function formatThreadListStatus(
  thread: Pick<ThreadListEntry, "archivedAt" | "pinnedAt" | "status"> &
    Partial<Pick<ThreadListEntry, "runtime">>,
): string {
  const flags: string[] = [];
  if (
    thread.runtime !== undefined &&
    isNativeActivityUnconfirmed(thread.runtime)
  ) {
    flags.push(
      nativeActivityEvidenceKind(thread.runtime) === "tool-call"
        ? "agent tool call seen"
        : "activity not reported",
    );
  }
  if (thread.archivedAt !== null) {
    flags.push("archived");
  }
  if (thread.pinnedAt !== null) {
    flags.push("pinned");
  }
  if (flags.length === 0) {
    return thread.status;
  }
  return `${thread.status} (${flags.join(", ")})`;
}

function hasIndependentWorkingActivity(
  thread: Pick<ThreadListEntry, "activity">,
): boolean {
  return (
    thread.activity.activeWorkflowCount > 0 ||
    thread.activity.activeBackgroundAgentCount > 0 ||
    thread.activity.activeBackgroundCommandCount > 0 ||
    thread.activity.activePlanModeCount > 0 ||
    thread.activity.activeGoalCount > 0
  );
}

function activityAwareListIndicator(
  thread: Pick<ThreadListEntry, "id" | "listIndicator"> &
    Partial<Pick<ThreadListEntry, "runtime" | "activity">>,
  wokeThreadIds: ReadonlySet<string>,
): ThreadListEntry["listIndicator"] {
  if (thread.listIndicator === "needs-input") return thread.listIndicator;
  if (thread.listIndicator === "working") {
    return thread.runtime !== undefined &&
      isNativeActivityUnconfirmed(thread.runtime) &&
      (thread.activity === undefined ||
        !hasIndependentWorkingActivity({ activity: thread.activity }))
      ? "none"
      : "working";
  }
  return wokeThreadIds.has(thread.id) ? "woke" : thread.listIndicator;
}

async function getWokenThreadIds(
  sdk: ReturnType<typeof createCliBbSdk>,
): Promise<ReadonlySet<string>> {
  try {
    const overview = await sdk.plugins.callRpc({
      pluginId: "automations",
      method: "automations_overview",
      outputSchema: jsonValueSchema,
    });
    if (
      overview === null ||
      typeof overview !== "object" ||
      Array.isArray(overview) ||
      !Array.isArray(overview.automations)
    ) {
      return new Set();
    }
    return new Set(
      overview.automations.flatMap((entry) => {
        const automation = asJsonObject(entry)?.automation;
        const value = asJsonObject(automation);
        return value?.lastRunStatus === "running" &&
          typeof value.lastRunThreadId === "string"
          ? [value.lastRunThreadId]
          : [];
      }),
    );
  } catch {
    return new Set();
  }
}

function asJsonObject(
  value: JsonValue | undefined,
): Record<string, JsonValue> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value
    : null;
}

export function formatThreadListIndicator(
  thread: Pick<ThreadListEntry, "id" | "listIndicator"> &
    Partial<Pick<ThreadListEntry, "runtime" | "activity">>,
  wokeThreadIds: ReadonlySet<string>,
): string {
  if (thread.listIndicator === "needs-input") return "Needs input";
  if (thread.listIndicator === "working") {
    const hasIndependentActivity = thread.activity
      ? hasIndependentWorkingActivity({ activity: thread.activity })
      : false;
    if (
      thread.runtime === undefined ||
      !isNativeActivityUnconfirmed(thread.runtime) ||
      hasIndependentActivity
    ) {
      return "Working";
    }
    return "-";
  }
  if (wokeThreadIds.has(thread.id)) return "Woke";
  if (thread.listIndicator === "done-unread") return "Done";
  if (thread.listIndicator === "activity-unreported") {
    return "Activity not reported";
  }
  return "-";
}
