import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";
import { roundDurationMs } from "@bb/process-utils";
import { parseRequestAppSurface } from "@bb/config/app-surface";
import type { ThreadListClientKind, ThreadListRequestShape } from "@bb/db";
import type { ThreadListQuery } from "@bb/server-contract";
import type { PluginService } from "../plugins/plugin-service.js";

interface EventLoopWorkFrame {
  blocksEventLoop: boolean;
  id: number;
  label: string;
  parentId: number | null;
  startedAt: number;
  threadListContext: ThreadListRequestContext | null;
  threadListQuery: ThreadListQuery | null;
  threadListLimit: number | undefined;
  threadListOffset: number | undefined;
  threadListPluginCallerResolver: ThreadListPluginCallerResolver | null;
}

interface ThreadListRequestContext {
  req: { header(name: string): string | undefined };
}

type ThreadListPluginCallerResolver = Pick<PluginService, "resolveRpcCaller">;

interface CompletedEventLoopWork {
  blocksEventLoop: boolean;
  durationMs: number;
  cpuMs: number | null;
  label: string;
}

interface EventLoopWorkSnapshot {
  inFlightWorkAtObservation: string | null;
  lastCompletedWork: string | null;
  lastCompletedWorkWallMs: number | null;
  longestSynchronousWork: string | null;
  longestSynchronousWorkWallMs: number | null;
  longestSynchronousWorkCpuMs: number | null;
  synchronousWorkCpuMs: number;
  rawLongestSynchronousWorkWallMs: number | null;
  rawLongestSynchronousWorkCpuMs: number | null;
}

const activeFrames = new Map<number, EventLoopWorkFrame>();
const currentFrameId = new AsyncLocalStorage<number>();
const threadListRequestFields = new WeakMap<
  ThreadListRequestContext,
  { clientKind: ThreadListClientKind; requestShape: ThreadListRequestShape }
>();
const completedInWindow: CompletedEventLoopWork[] = [];
let nextFrameId = 1;
let lastCompleted: CompletedEventLoopWork | null = null;

function enterEventLoopWork(label: string, blocksEventLoop: boolean): number {
  const id = nextFrameId;
  nextFrameId += 1;
  activeFrames.set(id, {
    blocksEventLoop,
    id,
    label,
    parentId: currentFrameId.getStore() ?? null,
    startedAt: performance.now(),
    threadListContext: null,
    threadListQuery: null,
    threadListLimit: undefined,
    threadListOffset: undefined,
    threadListPluginCallerResolver: null,
  });
  return id;
}

function leaveEventLoopWork(id: number, cpuMs: number | null): void {
  const frame = activeFrames.get(id);
  activeFrames.delete(id);
  if (frame === undefined) {
    return;
  }
  const completed: CompletedEventLoopWork = {
    blocksEventLoop: frame.blocksEventLoop,
    cpuMs,
    durationMs: performance.now() - frame.startedAt,
    label: frame.label,
  };
  lastCompleted = completed;
  completedInWindow.push(completed);
}

function formatLineage(root: EventLoopWorkFrame): string {
  const labels: string[] = [root.label];
  let parentId = root.id;
  for (;;) {
    const children: EventLoopWorkFrame[] = [...activeFrames.values()]
      .filter((frame) => frame.parentId === parentId)
      .sort((left, right) => left.id - right.id);
    const child = children[0];
    if (child === undefined) {
      break;
    }
    labels.push(child.label);
    parentId = child.id;
  }
  return labels.join(" > ");
}

function formatActiveWork(): string | null {
  if (activeFrames.size === 0) {
    return null;
  }
  const roots = [...activeFrames.values()]
    .filter(
      (frame) => frame.parentId === null || !activeFrames.has(frame.parentId),
    )
    .sort((left, right) => left.id - right.id);
  return roots.map((root) => formatLineage(root)).join(" | ");
}

function selectLongestSynchronousWork(): CompletedEventLoopWork | null {
  let longest: CompletedEventLoopWork | null = null;
  for (const completed of completedInWindow) {
    if (!completed.blocksEventLoop) {
      continue;
    }
    if (longest === null || completed.durationMs > longest.durationMs) {
      longest = completed;
    }
  }
  return longest;
}

function getEventLoopWorkSnapshot(): EventLoopWorkSnapshot {
  const longest = selectLongestSynchronousWork();
  return {
    inFlightWorkAtObservation: formatActiveWork(),
    lastCompletedWork: lastCompleted?.label ?? null,
    lastCompletedWorkWallMs:
      lastCompleted === null ? null : roundDurationMs(lastCompleted.durationMs),
    longestSynchronousWork: longest?.label ?? null,
    longestSynchronousWorkCpuMs:
      longest === null || longest.cpuMs === null
        ? null
        : roundDurationMs(longest.cpuMs),
    synchronousWorkCpuMs: roundDurationMs(
      completedInWindow.reduce(
        (total, completed) =>
          total + (completed.blocksEventLoop ? (completed.cpuMs ?? 0) : 0),
        0,
      ),
    ),
    longestSynchronousWorkWallMs:
      longest === null ? null : roundDurationMs(longest.durationMs),
    rawLongestSynchronousWorkWallMs: longest?.durationMs ?? null,
    rawLongestSynchronousWorkCpuMs: longest?.cpuMs ?? null,
  };
}

export function getCurrentEventLoopWorkLabel(): string | null {
  const labels: string[] = [];
  const currentId = currentFrameId.getStore();
  let frame = currentId === undefined ? undefined : activeFrames.get(currentId);
  while (frame !== undefined) {
    labels.unshift(frame.label);
    frame =
      frame.parentId === null ? undefined : activeFrames.get(frame.parentId);
  }
  return labels.length === 0 ? null : labels.join(" > ");
}

export function setCurrentThreadListSlowQueryContext(
  context: ThreadListRequestContext,
  query: ThreadListQuery,
  limit: number | undefined,
  offset: number | undefined,
  pluginCallerResolver: ThreadListPluginCallerResolver,
): void {
  const currentId = currentFrameId.getStore();
  const frame =
    currentId === undefined ? undefined : activeFrames.get(currentId);
  if (frame === undefined) return;
  frame.threadListContext = context;
  frame.threadListQuery = query;
  frame.threadListLimit = limit;
  frame.threadListOffset = offset;
  frame.threadListPluginCallerResolver = pluginCallerResolver;
  const fields = getCurrentThreadListSlowQueryFields();
  if (fields !== undefined) threadListRequestFields.set(context, fields);
}

export function clearCurrentThreadListSlowQueryContext(): void {
  const currentId = currentFrameId.getStore();
  const frame =
    currentId === undefined ? undefined : activeFrames.get(currentId);
  if (frame === undefined) return;
  frame.threadListContext = null;
  frame.threadListQuery = null;
  frame.threadListLimit = undefined;
  frame.threadListOffset = undefined;
  frame.threadListPluginCallerResolver = null;
}

export function getCurrentThreadListSlowQueryFields():
  | { clientKind: ThreadListClientKind; requestShape: ThreadListRequestShape }
  | undefined {
  const currentId = currentFrameId.getStore();
  let frame = currentId === undefined ? undefined : activeFrames.get(currentId);
  while (frame !== undefined) {
    const context = frame.threadListContext;
    const query = frame.threadListQuery;
    if (context !== null && query !== null) {
      const filters = [
        ...(query.projectId === undefined ? [] : ["project"]),
        ...(query.environmentId === undefined ? [] : ["environment"]),
        ...(query.hostId === undefined ? [] : ["host"]),
        ...(query.parentThreadId === undefined && query.hasParent === undefined
          ? []
          : ["parent"]),
        ...(query.sourceThreadId === undefined ? [] : ["sourceThread"]),
        ...(query.threadIds === undefined ? [] : ["threadIds"]),
        ...(query.sectionId === undefined ? [] : ["section"]),
        ...(query.unsectioned === undefined ? [] : ["unsectioned"]),
        ...(query.originKind === undefined ? [] : ["origin"]),
        ...(query.originPluginId === undefined ? [] : ["originPlugin"]),
      ].sort();
      const userAgent = context.req.header("user-agent")?.trim();
      const userAgentKind =
        userAgent === undefined || userAgent.length === 0
          ? "missing"
          : /^node(?:\.js)?(?:\/|$)/iu.test(userAgent)
            ? "node"
            : /^mozilla\//iu.test(userAgent)
              ? "browser"
              : "other";
      const callerToken = context.req.header("x-bb-plugin-caller");
      const resolution =
        frame.threadListPluginCallerResolver?.resolveRpcCaller(callerToken);
      const pluginId =
        resolution?.ok === true && resolution.caller.kind === "plugin"
          ? resolution.caller.pluginId
          : undefined;
      const appSurface =
        parseRequestAppSurface(context.req.header("x-bb-app-surface")) ?? "api";
      return {
        clientKind: {
          appSurface,
          userAgentKind,
          ...(pluginId === undefined ? {} : { pluginId }),
        },
        requestShape: {
          includeHidden: query.includeHidden === "true",
          archived: query.archived ?? "absent",
          filters,
          limit: frame.threadListLimit ?? null,
          offset: frame.threadListOffset ?? null,
        },
      };
    }
    frame =
      frame.parentId === null ? undefined : activeFrames.get(frame.parentId);
  }
  return undefined;
}

export function getThreadListSlowApiRequestFields(
  context: ThreadListRequestContext,
):
  | { clientKind: ThreadListClientKind; requestShape: ThreadListRequestShape }
  | undefined {
  return threadListRequestFields.get(context);
}

export function takeEventLoopWorkWindowSnapshot(): EventLoopWorkSnapshot {
  const snapshot = getEventLoopWorkSnapshot();
  completedInWindow.length = 0;
  return snapshot;
}

export function runEventLoopWorkSync<T>(label: string, work: () => T): T {
  const id = enterEventLoopWork(label, true);
  const cpuStart = process.threadCpuUsage();
  return currentFrameId.run(id, () => {
    try {
      return work();
    } finally {
      const cpu = process.threadCpuUsage(cpuStart);
      leaveEventLoopWork(id, (cpu.user + cpu.system) / 1_000);
    }
  });
}

export async function runEventLoopWork<T>(
  label: string,
  work: () => Promise<T> | T,
): Promise<T> {
  const id = enterEventLoopWork(label, false);
  return currentFrameId.run(id, async () => {
    try {
      return await work();
    } finally {
      leaveEventLoopWork(id, null);
    }
  });
}

export function resetEventLoopWorkForTests(): void {
  activeFrames.clear();
  completedInWindow.length = 0;
  lastCompleted = null;
  nextFrameId = 1;
}
