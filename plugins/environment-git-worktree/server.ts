import {
  defineRpcContract,
  type BbPluginApi,
  type JsonValue,
} from "@get-bb/plugin-sdk";
import type {
  PluginEnvironmentProviderCreateContext,
  PluginEnvironmentProviderCreateResult,
  PluginEnvironmentProviderProgress,
} from "@get-bb/plugin-sdk/environment-provider";
import { reportHostProgress } from "bb-environment-provider-host/progress";
import { z } from "zod";
import {
  discoveredWorktreeSchema,
  worktreeBaseBranchSchema,
  worktreeHostContract,
  worktreeHostSignals,
  type WorktreeBaseBranch,
} from "./contract.js";
import { attemptBranchName } from "./attempt-branch.js";
import { GIT_WORKTREE_ENVIRONMENT_PROVIDER_ID } from "./provider-id.js";

const CREATE_TIMEOUT_MS = 15 * 60 * 1000;
const REMOVE_TIMEOUT_MS = 15 * 60 * 1000;

export const worktreeInputsSchema = z
  .union([
    z
      .object({
        kind: z.literal("existing"),
        path: z.string().min(1),
      })
      .strict(),
    z
      .object({
        branch: worktreeBaseBranchSchema.default({ kind: "default" }),
      })
      .strict(),
  ])
  .default({ branch: { kind: "default" } });
export type WorktreeInputs = z.infer<typeof worktreeInputsSchema>;
type WorktreeOperation = Pick<
  PluginEnvironmentProviderCreateContext<{ gitCheckout: true }>,
  | "attempt"
  | "experimental_claimPath"
  | "host"
  | "pathKey"
  | "projectCheckout"
  | "report"
  | "signal"
  | "thread"
>;

export const worktreeRpcContract = defineRpcContract({
  defaultBaseBranch: {
    input: z
      .object({
        projectId: z.string().min(1),
        hostId: z.string().min(1).nullable(),
      })
      .strict(),
    output: z.object({ branch: z.string().min(1).nullable() }).strict(),
  },
  listExistingWorktrees: {
    input: z
      .object({
        projectId: z.string().min(1),
        hostId: z.string().min(1),
      })
      .strict(),
    output: z.object({ worktrees: z.array(discoveredWorktreeSchema) }).strict(),
  },
});

const ADOPTED_RESOURCE = { adopted: true } as const;

function isAdoptedResource(resource: JsonValue | null): boolean {
  return (
    typeof resource === "object" &&
    resource !== null &&
    !Array.isArray(resource) &&
    resource.adopted === true
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default async function worktreePlugin(bb: BbPluginApi): Promise<void> {
  const host = bb.hosts.experimental_client({
    contract: worktreeHostContract,
    experimental_signals: worktreeHostSignals,
  });
  const reports = new Map<string, PluginEnvironmentProviderProgress>();

  host.experimental_onSignal("progress", (event) => {
    const report = reports.get(event.payload.operationId);
    if (report !== undefined) reportHostProgress(report, event.payload);
  });

  function previousAttemptOf(
    context: WorktreeOperation,
  ): { threadId: string; attempt: number } | null {
    const prefix = `${context.thread.id}-`;
    if (!context.pathKey.startsWith(prefix)) return null;
    const tail = context.pathKey.slice(prefix.length);
    if (!/^\d+$/u.test(tail)) return null;
    const attempt = Number(tail);
    return attempt >= 2 ? { threadId: context.thread.id, attempt } : null;
  }

  async function adoptExistingWorktree(
    context: WorktreeOperation,
    path: string,
  ): Promise<PluginEnvironmentProviderCreateResult> {
    const resolved = await host.call(
      "resolveExistingWorktree",
      { sourcePath: context.projectCheckout.path, path },
      {
        hostId: context.host.id,
        signal: context.signal,
        timeoutMs: CREATE_TIMEOUT_MS,
      },
    );
    if (resolved.status === "failed") {
      return { status: "failed", message: resolved.message };
    }
    if (!(await context.experimental_claimPath(resolved.path))) {
      return {
        status: "failed",
        message: `${resolved.path} is already in use by another environment.`,
      };
    }
    return {
      status: "created",
      path: resolved.path,
      ownsPath: false,
      resource: ADOPTED_RESOURCE,
    };
  }

  async function createManagedWorktree(
    context: WorktreeOperation,
    branch: {
      branchName: string;
      baseBranch: WorktreeBaseBranch;
      branchMode: "reset" | "reuse-existing";
      previousAttempt?: { threadId: string; attempt: number };
    },
  ): Promise<PluginEnvironmentProviderCreateResult> {
    const operationId = `create#${context.pathKey}#${context.attempt}`;
    reports.set(operationId, context.report);
    try {
      const result = await host.call(
        "create",
        {
          operationId,
          sourcePath: context.projectCheckout.path,
          pathKey: context.pathKey,
          ...branch,
        },
        {
          hostId: context.host.id,
          signal: context.signal,
          timeoutMs: CREATE_TIMEOUT_MS,
        },
      );
      if (result.status === "failed") {
        return {
          status: "failed",
          message: result.message,
          ...(result.kept.kind === "kept"
            ? { experimental_retained: { path: result.kept.path } }
            : result.kept.kind === "nothing"
              ? { experimental_retained: null }
              : {}),
        };
      }
      return {
        status: "created",
        path: result.path,
        ownsPath: true,
        ...(result.baseBranch === null
          ? {}
          : { mergeBaseBranch: result.baseBranch }),
      };
    } catch (error) {
      if (context.signal.aborted) throw error;
      return { status: "failed", message: errorMessage(error) };
    } finally {
      reports.delete(operationId);
    }
  }

  bb.experimental_environments.register({
    id: GIT_WORKTREE_ENVIRONMENT_PROVIDER_ID,
    displayName: "Worktree",
    description: "Create an isolated Git worktree for your changes.",
    icon: "FolderGit",
    requires: { gitCheckout: true },
    inputs: worktreeInputsSchema,
    policy: { pathKeys: "per-attempt" },
    experimental_existingPath: (inputs) =>
      "kind" in inputs ? inputs.path : null,
    async create(context) {
      if ("kind" in context.inputs) {
        return adoptExistingWorktree(context, context.inputs.path);
      }
      const previousAttempt = previousAttemptOf(context);
      const retryBranch =
        previousAttempt === null
          ? null
          : attemptBranchName(
              context.suggestedBranchName,
              previousAttempt.threadId,
              previousAttempt.attempt,
            );
      if (previousAttempt !== null && retryBranch === null) {
        return {
          status: "failed",
          message: `Cannot name this retry's branch: the suggested branch ${context.suggestedBranchName} does not end with the thread id ${previousAttempt.threadId} after a "/" or "-", so an earlier attempt's branch cannot be found. Nothing was created, and any earlier work was left alone. Set the managed branch prefix to end with "/" or "-".`,
          experimental_retained: null,
        };
      }
      return createManagedWorktree(context, {
        branchName: retryBranch ?? context.suggestedBranchName,
        baseBranch: context.inputs.branch,
        branchMode: "reset",
        ...(previousAttempt === null || retryBranch === null
          ? {}
          : { previousAttempt }),
      });
    },
    async restore(context) {
      if ("kind" in context.inputs) {
        return adoptExistingWorktree(context, context.inputs.path);
      }
      const branchName = context.previous.environment.branchName;
      if (branchName === null) {
        return {
          status: "failed",
          message:
            "The removed worktree had no branch checked out, so there is no branch to restore it on.",
        };
      }
      return createManagedWorktree(context, {
        branchName,
        baseBranch: context.inputs.branch,
        branchMode: "reuse-existing",
      });
    },
    async experimental_proveRetentionAbsent(context) {
      try {
        return await host.call(
          "proveRetentionAbsent",
          {
            path: context.path,
            pathKey: context.pathKey,
            branchName: context.branchName,
            sourcePath: context.sourcePath,
            threadId: context.threadId,
          },
          { hostId: context.hostId, signal: context.signal },
        );
      } catch (error) {
        if (context.signal.aborted) throw error;
        return { absent: false, reason: errorMessage(error) };
      }
    },
    async experimental_preflightRemove(context) {
      if (isAdoptedResource(context.resource) || context.hostId === null) {
        return { status: "removable" };
      }
      const result = await host.call(
        "inspect",
        { pathKey: context.pathKey, path: context.path },
        {
          hostId: context.hostId,
          signal: context.signal,
          timeoutMs: REMOVE_TIMEOUT_MS,
        },
      );
      if (result.status === "failed") throw new Error(result.message);
      return result;
    },
    async remove(context) {
      if (isAdoptedResource(context.resource)) {
        return { status: "removed" };
      }
      if (context.hostId === null) {
        return { status: "failed", message: "The worktree machine is unknown" };
      }
      const operationId = `remove#${context.pathKey}#${context.attempt}`;
      reports.set(operationId, context.report);
      try {
        const result = await host.call(
          "remove",
          {
            operationId,
            pathKey: context.pathKey,
            path: context.path,
          },
          {
            hostId: context.hostId,
            signal: context.signal,
            timeoutMs: REMOVE_TIMEOUT_MS,
          },
        );
        return result;
      } catch (error) {
        if (context.signal.aborted) throw error;
        return { status: "failed", message: errorMessage(error) };
      } finally {
        reports.delete(operationId);
      }
    },
  });

  bb.rpc.register(worktreeRpcContract, {
    async defaultBaseBranch({ projectId, hostId }) {
      const project = await bb.sdk.projects.get({ projectId });
      const sources = project.sources.filter(
        (source) => source.type === "local_path",
      );
      const source =
        hostId === null
          ? (sources.find((source) => source.isDefault) ?? sources[0])
          : sources.find((source) => source.hostId === hostId);
      if (source === undefined) return { branch: null };
      return host.call(
        "defaultBaseBranch",
        { sourcePath: source.path },
        { hostId: source.hostId },
      );
    },
    async listExistingWorktrees({ projectId, hostId }) {
      const project = await bb.sdk.projects.get({ projectId });
      const source = project.sources.find(
        (candidate) =>
          candidate.hostId === hostId && candidate.type === "local_path",
      );
      if (source === undefined) return { worktrees: [] };
      return host.call(
        "listWorktrees",
        { sourcePath: source.path },
        { hostId },
      );
    },
  });
}
