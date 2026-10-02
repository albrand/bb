import type { TimelineRow, TimelineTurnRow } from "@bb/server-contract";
import { useQueryClient } from "@tanstack/react-query";
import { ThreadUsageAndAgents } from "@/components/thread/ThreadUsageSummary";
import { ThreadTimelineRows } from "@/components/thread/timeline";
import {
  commandRow,
  conversationRow,
  turnRow,
} from "@/test/fixtures/thread-timeline-rows";
import { StoryCard, StoryRow } from "../../../../../.ladle/story-card";
import {
  fileChangeActiveThinkingDelete,
  fileChangeAssistantStream,
  fileChangeIndex,
  fileChangeTimelineService,
  fileChangeToViewMessages,
} from "./projection-refactor-story-rows";

export default {
  title: "thread/timeline/rows/Turn",
};

function TimelineStage({ children }: { children: React.ReactNode }) {
  return (
    <div className="@container/page mx-auto w-full max-w-[760px]">
      {children}
    </div>
  );
}

const baseProps = {
  threadRuntimeDisplayStatus: "idle" as const,
  workspaceRootPath: undefined,
};

const assistantOpener: TimelineRow = conversationRow({
  id: "thr_zeb7z9afmw:assistant-text:35343",
  threadId: "thr_zeb7z9afmw",
  turnId: "019dd185-ef12-7d50-aa48-47882e9c8aaf",
  sourceSeqStart: 35343,
  sourceSeqEnd: 35343,
  startedAt: 1777337120500,
  createdAt: 1777337121200,
  role: "assistant",
  text: "I’m moving the active-thinking state into the main projection pass so we stop reconstructing it from events afterward. After that I’ll remove the old parent-specific branch and stop recomputing active-thinking inside the turn-summary-details loop.",
  attachments: null,
});

const commandSedAssistantStream: TimelineRow = commandRow({
  id: "thr_zeb7z9afmw:command:call_YrdwFQNVKDsaBvwc98oQ9qP4",
  threadId: "thr_zeb7z9afmw",
  turnId: "019dd185-ef12-7d50-aa48-47882e9c8aaf",
  sourceSeqStart: 35347,
  sourceSeqEnd: 35347,
  startedAt: 1777337121300,
  createdAt: 1777337121800,
  status: "completed",
  callId: "call_YrdwFQNVKDsaBvwc98oQ9qP4",
  command:
    "/bin/zsh -lc \"sed -n '1,260p' packages/core-ui/src/assistant-stream-projection.ts\"",
  cwd: "/Users/michael/.bb-dev/worktrees/env_33i22gvcqe/bb",
  source: null,
  output: "",
  exitCode: 0,
  approvalStatus: null,
  activityIntents: [
    {
      type: "read",
      command: "sed",
      name: "assistant-stream-projection.ts",
      path: "packages/core-ui/src/assistant-stream-projection.ts",
    },
  ],
  durationMs: 500,
});

const commandSedTimelineHelpers: TimelineRow = commandRow({
  id: "thr_zeb7z9afmw:command:call_XF7ZEgp9XUvdErfdDi9zKDX6",
  threadId: "thr_zeb7z9afmw",
  turnId: "019dd185-ef12-7d50-aa48-47882e9c8aaf",
  sourceSeqStart: 35349,
  sourceSeqEnd: 35349,
  startedAt: 1777337121900,
  createdAt: 1777337122300,
  status: "completed",
  callId: "call_XF7ZEgp9XUvdErfdDi9zKDX6",
  command:
    "/bin/zsh -lc \"sed -n '1,200p' packages/core-ui/src/timeline-message-helpers.ts\"",
  cwd: "/Users/michael/.bb-dev/worktrees/env_33i22gvcqe/bb",
  source: null,
  output: "",
  exitCode: 0,
  approvalStatus: null,
  activityIntents: [
    {
      type: "read",
      command: "sed",
      name: "timeline-message-helpers.ts",
      path: "packages/core-ui/src/timeline-message-helpers.ts",
    },
  ],
  durationMs: 400,
});

const commandSedVisibleText: TimelineRow = commandRow({
  id: "thr_zeb7z9afmw:command:call_AcUMKIrd6rllJWdPYubsSTjL",
  threadId: "thr_zeb7z9afmw",
  turnId: "019dd185-ef12-7d50-aa48-47882e9c8aaf",
  sourceSeqStart: 35351,
  sourceSeqEnd: 35351,
  startedAt: 1777337122400,
  createdAt: 1777337122800,
  status: "completed",
  callId: "call_AcUMKIrd6rllJWdPYubsSTjL",
  command:
    "/bin/zsh -lc \"sed -n '1,220p' packages/core-ui/src/visible-text-buffer.ts\"",
  cwd: "/Users/michael/.bb-dev/worktrees/env_33i22gvcqe/bb",
  source: null,
  output: "",
  exitCode: 0,
  approvalStatus: null,
  activityIntents: [
    {
      type: "read",
      command: "sed",
      name: "visible-text-buffer.ts",
      path: "packages/core-ui/src/visible-text-buffer.ts",
    },
  ],
  durationMs: 400,
});

const assistantPlanning: TimelineRow = conversationRow({
  id: "thr_zeb7z9afmw:assistant-text:35381",
  threadId: "thr_zeb7z9afmw",
  turnId: "019dd185-ef12-7d50-aa48-47882e9c8aaf",
  sourceSeqStart: 35381,
  sourceSeqEnd: 35381,
  startedAt: 1777337122900,
  createdAt: 1777337123000,
  role: "assistant",
  text: "I’ve got the shape of the refactor now. The key is to make the flat projection pass return both durable messages and ephemeral `activeThinking`, then use that one result everywhere instead of rebuilding lifecycle from raw events afterward.",
  attachments: null,
});

const turnChildren: TimelineRow[] = [
  assistantOpener,
  commandSedAssistantStream,
  commandSedTimelineHelpers,
  commandSedVisibleText,
  assistantPlanning,
  fileChangeAssistantStream,
  fileChangeIndex,
  fileChangeTimelineService,
  fileChangeActiveThinkingDelete,
  fileChangeToViewMessages,
];

interface BuildTurnRowArgs {
  status: TimelineTurnRow["status"];
  completedAt: number | null;
  startedAt: number;
  createdAt: number;
}

function buildTurnRow({
  status,
  completedAt,
  startedAt,
  createdAt,
}: BuildTurnRowArgs): TimelineTurnRow {
  return turnRow({
    id: "thr_zeb7z9afmw:019dd185-ef12-7d50-aa48-47882e9c8aaf:turn",
    threadId: "thr_zeb7z9afmw",
    turnId: "019dd185-ef12-7d50-aa48-47882e9c8aaf",
    sourceSeqStart: 35289,
    sourceSeqEnd: 35671,
    startedAt,
    createdAt,
    status,
    summaryCount: turnChildren.length,
    durationMs: completedAt === null ? null : completedAt - startedAt,
    children: turnChildren,
  });
}

const completedTurnRow = buildTurnRow({
  status: "completed",
  completedAt: 1777337131200,
  startedAt: 1777337120000,
  createdAt: 1777337131200,
});

const TOKEN_THREAD_ID = "thr_token_footer_story";
const tokenTurnRows: TimelineTurnRow[] = [
  {
    ...turnRow({
      id: `${TOKEN_THREAD_ID}:turn-1`,
      threadId: TOKEN_THREAD_ID,
      turnId: "token-turn-1",
      sourceSeqStart: 1,
      sourceSeqEnd: 2,
      startedAt: 1777337120000,
      status: "completed",
      children: [
        conversationRow({
          id: `${TOKEN_THREAD_ID}:assistant-1`,
          threadId: TOKEN_THREAD_ID,
          turnId: "token-turn-1",
          sourceSeqStart: 2,
          sourceSeqEnd: 2,
          startedAt: 1777337121000,
          createdAt: 1777337121000,
          role: "assistant",
          text: "The first completed response has full token data.",
          attachments: null,
        }),
      ],
    }),
  },
  {
    ...turnRow({
      id: `${TOKEN_THREAD_ID}:turn-2`,
      threadId: TOKEN_THREAD_ID,
      turnId: "token-turn-2",
      sourceSeqStart: 3,
      sourceSeqEnd: 4,
      startedAt: 1777337130000,
      status: "completed",
      children: [
        conversationRow({
          id: `${TOKEN_THREAD_ID}:assistant-2`,
          threadId: TOKEN_THREAD_ID,
          turnId: "token-turn-2",
          sourceSeqStart: 4,
          sourceSeqEnd: 4,
          startedAt: 1777337131000,
          createdAt: 1777337131000,
          role: "assistant",
          text: "The second completed response has partial token data and no reported reasoning.",
          attachments: null,
        }),
      ],
    }),
  },
  {
    ...turnRow({
      id: `${TOKEN_THREAD_ID}:turn-3`,
      threadId: TOKEN_THREAD_ID,
      turnId: "token-turn-3",
      sourceSeqStart: 5,
      sourceSeqEnd: 6,
      startedAt: 1777337140000,
      status: "completed",
      children: [
        conversationRow({
          id: `${TOKEN_THREAD_ID}:assistant-3`,
          threadId: TOKEN_THREAD_ID,
          turnId: "token-turn-3",
          sourceSeqStart: 6,
          sourceSeqEnd: 6,
          startedAt: 1777337141000,
          createdAt: 1777337141000,
          role: "assistant",
          text: "The older completed response has no spend row, so its footer stays clear.",
          attachments: null,
        }),
      ],
    }),
  },
];

function TokenFooterThread() {
  const queryClient = useQueryClient();
  queryClient.setQueryData(["threadChildSummary", TOKEN_THREAD_ID], {
    nonDeletedChildCount: 3,
    unarchivedDescendantCount: 3,
    working: 1,
    waiting: 1,
    idle: 1,
    failed: 0,
    totalTokens: 64_400_000,
    children: [],
  });
  queryClient.setQueryData(["threadSpendSummary", TOKEN_THREAD_ID], {
    historyComplete: false,
    total: {
      inputTokens: 130,
      cachedInputTokens: 2_843_796,
      outputTokens: 6_349,
      reasoningOutputTokens: null,
      totalTokens: 2_850_275,
    },
    turns: [
      {
        turnId: "token-turn-1",
        inputTokens: 30,
        cachedInputTokens: 2_843_776,
        outputTokens: 6_149,
        reasoningOutputTokens: 500,
        totalTokens: 2_850_455,
      },
      {
        turnId: "token-turn-2",
        inputTokens: 100,
        cachedInputTokens: 20,
        outputTokens: 200,
        reasoningOutputTokens: null,
        totalTokens: 320,
      },
    ],
  });
  return (
    <div className="w-full">
      <div className="mb-3 border-b border-border pb-2">
        <ThreadUsageAndAgents threadId={TOKEN_THREAD_ID} />
      </div>
      <ThreadTimelineRows
        {...baseProps}
        initialExpanded={new Set(tokenTurnRows.map((row) => row.id))}
        threadId={TOKEN_THREAD_ID}
        timelineRows={tokenTurnRows}
      />
    </div>
  );
}

export function Overview() {
  return (
    <StoryCard>
      <StoryRow
        label="collapsed"
        hint="completed turn — header only, click to expand"
      >
        <TimelineStage>
          <ThreadTimelineRows
            {...baseProps}
            timelineRows={[completedTurnRow]}
          />
        </TimelineStage>
      </StoryRow>
      <StoryRow label="expanded" hint="turn body open to its child rows">
        <TimelineStage>
          <ThreadTimelineRows
            {...baseProps}
            initialExpanded={new Set([completedTurnRow.id])}
            timelineRows={[completedTurnRow]}
          />
        </TimelineStage>
      </StoryRow>
    </StoryCard>
  );
}

export function TokenFooterLayout() {
  return (
    <div className="w-full min-w-0 p-3">
      <p className="mb-3 text-xs text-muted-foreground">
        Three completed turns: full spend, partial spend, and no spend row.
      </p>
      <TokenFooterThread />
    </div>
  );
}
