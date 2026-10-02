import { Command } from "commander";
import {
  jsonValueSchema,
  PERSONAL_PROJECT_ID,
  type JsonValue,
  type ThreadListEntry,
} from "@bb/domain";
import { action } from "../../action.js";
import { createCliBbSdk } from "../../client.js";
import { resolveExplicitIdFlag } from "../../context-env.js";
import {
  columnWidths,
  printBorderlessTable,
  truncateCell,
} from "../../table.js";
import { outputJson } from "../helpers.js";
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
  archived?: boolean;
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
    .description("List threads")
    .option("--project <id>", "Filter by project ID (defaults to all projects)")
    .option("--environment <id>", "Filter by environment ID")
    .option(
      "--machine <id-or-name>",
      "Filter by machine ID or active machine name",
    )
    .option("--host <id-or-name>", "Alias for --machine")
    .option("--parent-thread <id>", "Filter by parent thread ID")
    .option("--section <id>", "Filter by thread section ID")
    .option("--unsectioned", "Show only threads outside sections")
    .option("--archived", "Show only archived threads")
    .option("--include-hidden", "Include hidden threads")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (opts: ThreadListCommandOptions) => {
        const sdk = createCliBbSdk(getUrl());
        const projectId = resolveExplicitIdFlag({
          flagName: "--project flag",
          value: opts.project,
        });
        const parentThreadId = resolveExplicitIdFlag({
          flagName: "--parent-thread",
          value: opts.parentThread,
        });
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
          ...(opts.archived ? { archived: true } : {}),
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
              listIndicator:
                thread.listIndicator === "working" ||
                thread.listIndicator === "needs-input"
                  ? thread.listIndicator
                  : wokeThreadIds.has(thread.id)
                    ? "woke"
                    : thread.listIndicator,
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

function formatThreadListStatus(thread: ThreadListEntry): string {
  const flags: string[] = [];
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
  thread: Pick<ThreadListEntry, "id" | "listIndicator">,
  wokeThreadIds: ReadonlySet<string>,
): string {
  if (thread.listIndicator === "needs-input") return "Needs input";
  if (thread.listIndicator === "working") return "Working";
  if (wokeThreadIds.has(thread.id)) return "Woke";
  if (thread.listIndicator === "done-unread") return "Done";
  return "-";
}
