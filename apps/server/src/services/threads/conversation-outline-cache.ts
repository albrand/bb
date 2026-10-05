import {
  getDatabaseDataVersion,
  getThreadEventRewriteGeneration,
  type DbConnection,
} from "@bb/db";
import type { ThreadConversationOutlineItem } from "@bb/server-contract";
import {
  MIN_AGENT_MESSAGE_DELTAS_FOR_SUMMARY_COMPACTION,
  type ThreadEventWithMeta,
} from "@bb/thread-view";

interface ConversationOutlineProjection {
  events: ThreadEventWithMeta[];
  items: {
    item: ThreadConversationOutlineItem;
    sourceSeqStart: number;
    sourceSeqEnd: number;
  }[];
}

export interface ConversationOutlineSelection {
  events: ThreadEventWithMeta[];
  project: () => ConversationOutlineProjection["items"];
}

interface Checkpoint {
  agentMessageDeltaCount: number;
  items: ThreadConversationOutlineItem[];
  itemIds: Set<string>;
  sequenceStart: number;
  turnIds: Set<string>;
  requestIds: Set<string>;
}

interface Entry {
  agentMessageDeltaCount: number;
  checkpoint: Checkpoint;
  contextBoundarySeq: number;
  dataVersion: number;
  generation: number;
  key: string;
  maxSeq: number;
  orderingBoundarySequence: number | null;
  chars: number;
}

interface OutlineCache {
  entries: Map<string, Entry>;
  chars: number;
}

const caches = new WeakMap<DbConnection, OutlineCache>();
const MAX_ENTRIES = 16;
const MAX_CHARS = 8_000_000;

function referencedRequestId(
  event: ThreadEventWithMeta["event"],
): string | null {
  if (
    event.type === "client/turn/requested" ||
    event.type === "client/turn/rejected"
  ) {
    return event.requestId;
  }
  return event.type === "turn/input/accepted" ? event.clientRequestId : null;
}

function isNestedWorkEvent(event: ThreadEventWithMeta["event"]): boolean {
  return (
    event.type.startsWith("item/backgroundTask/") ||
    event.type.startsWith("item/delegation/") ||
    ("item" in event &&
      (event.item.type === "backgroundTask" ||
        event.item.type === "delegation"))
  );
}

function eventItemId(event: ThreadEventWithMeta["event"]): string | null {
  if ("item" in event) return event.item.id;
  return "itemId" in event ? event.itemId : null;
}

function eventParentToolCallId(
  event: ThreadEventWithMeta["event"],
): string | null {
  if ("parentToolCallId" in event) return event.parentToolCallId ?? null;
  if ("item" in event && "parentToolCallId" in event.item) {
    return event.item.parentToolCallId ?? null;
  }
  return null;
}

function isThreadError(event: ThreadEventWithMeta["event"]): boolean {
  return (
    event.scope.kind === "thread" &&
    (event.type === "system/error" ||
      event.type === "provider/error" ||
      event.type === "system/thread/interrupted")
  );
}

function canReuse(
  checkpoint: Checkpoint,
  events: ThreadEventWithMeta[],
): boolean {
  let hasTailTurn = false;
  return events.every(({ event }) => {
    const itemId = eventItemId(event);
    if (itemId !== null && checkpoint.itemIds.has(itemId)) return false;
    const parentToolCallId = eventParentToolCallId(event);
    if (
      parentToolCallId !== null &&
      checkpoint.itemIds.has(parentToolCallId)
    ) {
      return false;
    }
    if (isNestedWorkEvent(event)) return true;
    if (event.type === "turn/started") hasTailTurn = true;
    if (isThreadError(event) && !hasTailTurn) return false;
    if (
      event.scope.kind === "turn" &&
      checkpoint.turnIds.has(event.scope.turnId)
    )
      return false;
    const requestId = referencedRequestId(event);
    if (requestId !== null && checkpoint.requestIds.has(requestId))
      return false;
    if (
      event.type === "client/turn/requested" &&
      "expectedTurnId" in event.target
    ) {
      const turnId = event.target.expectedTurnId;
      if (turnId !== null && checkpoint.turnIds.has(turnId)) return false;
    }
    return true;
  });
}

function nextCheckpoint(
  projection: ConversationOutlineProjection,
  previous: Checkpoint,
): Checkpoint {
  const activeTurns = new Set<string>();
  const pendingRequests = new Set<string>();
  let completedBoundary = previous.sequenceStart;
  let boundary = previous.sequenceStart;
  for (const { event, meta } of projection.events) {
    if (isThreadError(event)) {
      completedBoundary = boundary;
    }
    if (
      event.type === "client/turn/requested" &&
      (event.target.kind === "steer" ||
        (event.target.kind === "auto" && event.target.expectedTurnId !== null))
    )
      pendingRequests.add(event.requestId);
    if (event.type === "turn/input/accepted")
      pendingRequests.delete(event.clientRequestId);
    if (event.type === "client/turn/rejected")
      pendingRequests.delete(event.requestId);
    if (event.scope.kind !== "turn") continue;
    if (event.type === "turn/started") {
      if (activeTurns.size === 0) boundary = completedBoundary;
      activeTurns.add(event.scope.turnId);
    }
    if (event.type === "turn/completed") {
      activeTurns.delete(event.scope.turnId);
      if (activeTurns.size === 0 && pendingRequests.size === 0)
        completedBoundary = meta.seq + 1;
    }
  }
  if (boundary <= previous.sequenceStart) return previous;
  const turnIds = new Set(previous.turnIds);
  const requestIds = new Set(previous.requestIds);
  const itemIds = new Set(previous.itemIds);
  for (const { event, meta } of projection.events) {
    if (meta.seq >= boundary) continue;
    if (event.scope.kind === "turn") turnIds.add(event.scope.turnId);
    const requestId = referencedRequestId(event);
    if (requestId !== null) requestIds.add(requestId);
    const itemId = eventItemId(event);
    if (itemId !== null) itemIds.add(itemId);
  }
  const checkpoint: Checkpoint = {
    agentMessageDeltaCount:
      previous.agentMessageDeltaCount +
      projection.events.filter(
        ({ event, meta }) =>
          meta.seq < boundary && event.type === "item/agentMessage/delta",
      ).length,
    items: previous.items,
    itemIds,
    sequenceStart: boundary,
    turnIds,
    requestIds,
  };
  const tailEvents = projection.events.filter(
    ({ meta }) => meta.seq >= boundary,
  );
  if (!canReuse(checkpoint, tailEvents)) return previous;
  if (
    projection.items.some(
      ({ sourceSeqStart, sourceSeqEnd }) =>
        sourceSeqStart < boundary && sourceSeqEnd >= boundary,
    )
  )
    return previous;
  let reachedTail = false;
  const frozen: ThreadConversationOutlineItem[] = [];
  for (const row of projection.items) {
    if (row.sourceSeqStart >= boundary) reachedTail = true;
    else {
      if (reachedTail) return previous;
      frozen.push(row.item);
    }
  }
  checkpoint.items = [...previous.items, ...frozen];
  return checkpoint;
}

export function projectConversationOutlineIncrementally(args: {
  db: DbConnection;
  threadId: string;
  key: string;
  maxSeq: number;
  contextBoundarySeq: number;
  orderingBoundarySequence: number | null;
  select: (
    sequenceStart: number,
    precedingAgentMessageDeltaCount: number,
  ) => ConversationOutlineSelection;
}): ThreadConversationOutlineItem[] {
  let cache = caches.get(args.db);
  if (cache === undefined) {
    cache = { entries: new Map(), chars: 0 };
    caches.set(args.db, cache);
  }
  const dataVersion = getDatabaseDataVersion(args.db);
  const generation = getThreadEventRewriteGeneration(args.threadId);
  const entry = cache.entries.get(args.threadId);
  if (entry !== undefined) {
    cache.entries.delete(args.threadId);
    cache.chars -= entry.chars;
  }
  const empty: Checkpoint = {
    agentMessageDeltaCount: 0,
    items: [],
    itemIds: new Set(),
    sequenceStart: args.contextBoundarySeq,
    turnIds: new Set(),
    requestIds: new Set(),
  };
  let checkpoint =
    entry !== undefined &&
    entry.key === args.key &&
    entry.dataVersion === dataVersion &&
    entry.generation === generation &&
    entry.contextBoundarySeq === args.contextBoundarySeq &&
    entry.orderingBoundarySequence === args.orderingBoundarySequence &&
    entry.maxSeq <= args.maxSeq
      ? entry.checkpoint
      : empty;
  let selection = args.select(
    checkpoint.sequenceStart,
    checkpoint.agentMessageDeltaCount,
  );
  let agentMessageDeltaCount =
    checkpoint.agentMessageDeltaCount +
    selection.events.filter(
      ({ event }) => event.type === "item/agentMessage/delta",
    ).length;
  const crossedCompactionThreshold =
    entry !== undefined &&
    entry.agentMessageDeltaCount <
      MIN_AGENT_MESSAGE_DELTAS_FOR_SUMMARY_COMPACTION &&
    agentMessageDeltaCount >= MIN_AGENT_MESSAGE_DELTAS_FOR_SUMMARY_COMPACTION;
  if (
    checkpoint !== empty &&
    (crossedCompactionThreshold || !canReuse(checkpoint, selection.events))
  ) {
    checkpoint = empty;
    selection = args.select(checkpoint.sequenceStart, 0);
    agentMessageDeltaCount = selection.events.filter(
      ({ event }) => event.type === "item/agentMessage/delta",
    ).length;
  }
  const projection = { events: selection.events, items: selection.project() };
  const items = [
    ...checkpoint.items,
    ...projection.items.map(({ item }) => item),
  ];
  const next = nextCheckpoint(projection, checkpoint);
  if (next.sequenceStart > args.contextBoundarySeq) {
    const chars =
      next === entry?.checkpoint
        ? entry.chars
          : JSON.stringify(next.items).length +
          [...next.itemIds, ...next.turnIds, ...next.requestIds].reduce(
            (sum, id) => sum + id.length,
            0,
          );
    if (chars <= MAX_CHARS) {
      cache.entries.set(args.threadId, {
        agentMessageDeltaCount,
        checkpoint: next,
        contextBoundarySeq: args.contextBoundarySeq,
        dataVersion,
        generation,
        key: args.key,
        maxSeq: args.maxSeq,
        orderingBoundarySequence: args.orderingBoundarySequence,
        chars,
      });
      cache.chars += chars;
    }
  }
  while (cache.entries.size > MAX_ENTRIES || cache.chars > MAX_CHARS) {
    const oldest = cache.entries.keys().next().value;
    if (oldest === undefined) break;
    cache.chars -= cache.entries.get(oldest)!.chars;
    cache.entries.delete(oldest);
  }
  return items;
}
