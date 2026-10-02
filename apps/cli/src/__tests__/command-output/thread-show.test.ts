import { describe, expect, it, vi } from "vitest";
import * as domain from "@bb/domain";
import type * as serverContract from "@bb/server-contract";
import {
  setupCommandOutputTestEnvironment,
  collectLogLines,
  createClientMock,
  runCommand,
  stubServerApi,
} from "../helpers/command-output-harness.js";
import type { CommandRegistrar } from "../helpers/command-output-harness.js";
import * as fixtures from "../helpers/command-output-fixtures.js";
import { registerThreadCommands } from "../../commands/thread/index.js";

describe("bb thread show command output", () => {
  setupCommandOutputTestEnvironment();

  function stubThreadApi(handlers: Parameters<typeof stubServerApi>[0]): void {
    stubServerApi({
      "v1.threads.:id.child-summary.$get": vi.fn(async () => ({
        nonDeletedChildCount: 0,
        unarchivedDescendantCount: 0,
        working: 0,
        waiting: 0,
        idle: 0,
        failed: 0,
        totalTokens: 0,
        children: [],
      })),
      "v1.threads.:id.spend-summary.$get": vi.fn(async () => ({
        providerId: "codex",
        historyComplete: false,
        total: {
          inputTokens: null,
          cachedInputTokens: null,
          outputTokens: null,
          reasoningOutputTokens: null,
          totalTokens: null,
        },
        turns: [],
      })),
      ...handlers,
    });
  }

  const register: CommandRegistrar = (program) =>
    registerThreadCommands(program, () => "http://server");

  function makePullRequest(
    overrides: Partial<domain.ThreadPullRequest> = {},
  ): domain.ThreadPullRequest {
    return {
      number: 42,
      title: "Review thread show",
      state: "open",
      url: "https://github.com/example/bb/pull/42",
      baseRefName: "main",
      headRefName: "bb/thread-show-pr",
      updatedAt: "2026-06-24T12:00:00.000Z",
      autoMerge: false,
      inMergeQueue: false,
      checks: {
        state: "passing",
        totalCount: 3,
        passedCount: 3,
        failedCount: 0,
        pendingCount: 0,
      },
      review: {
        state: "review_required",
        reviewRequestCount: 1,
      },
      mergeability: {
        state: "mergeable",
        mergeStateStatus: "CLEAN",
        mergeable: "MERGEABLE",
      },
      attention: "ready_to_merge",
      ...overrides,
    };
  }

  it.each([
    {
      flag: "archived",
      stamp: { archivedAt: 1_700_000_000_000 },
      label: "Archived:",
    },
    {
      flag: "pinned",
      stamp: { pinnedAt: 1_700_000_000_000 },
      label: "Pinned:",
    },
  ])(
    "bb thread show prints $flag timestamp for $flag threads",
    async ({ flag, stamp, label }) => {
      const thread: domain.Thread = fixtures.makeThread({
        id: `thread-${flag}-1`,
        projectId: "proj-1",
        providerId: "codex",
        status: "idle",
        createdAt: 1,
        updatedAt: 2,
        ...stamp,
      });
      const get = vi.fn(async () => thread);
      const timelineGet = fixtures.makeEmptyTimelineGetMock();
      stubThreadApi({
        "v1.threads.:id.$get": get,
        "v1.threads.:id.timeline.$get": timelineGet,
      });

      await runCommand(["thread", "show", `thread-${flag}-1`], register);

      expect(get).toHaveBeenCalledWith({
        param: { id: `thread-${flag}-1` },
      });
      expect(timelineGet).toHaveBeenCalledWith({
        param: { id: `thread-${flag}-1` },
        query: { summaryOnly: "true" },
      });
      const lines = collectLogLines(vi.mocked(console.log));
      expect(lines.some((line) => line.includes(label))).toBe(true);
    },
  );

  it("bb thread show prints the latest failed turn error", async () => {
    const thread: domain.Thread = fixtures.makeThread({
      id: "thread-show-error",
      projectId: "proj-1",
      providerId: "codex",
      status: "error",
      createdAt: 1,
      updatedAt: 2,
    });
    const get = vi.fn(async () => thread);
    const events = vi.fn(async () => [
      {
        id: "event-turn-completed",
        threadId: thread.id,
        type: "turn/completed",
        data: {
          status: "failed",
          error: { message: "Agent stopped the turn: refusal" },
        },
        createdAt: 2,
        sequence: 2,
      },
    ]);
    const timelineGet = fixtures.makeEmptyTimelineGetMock();
    stubThreadApi({
      "v1.threads.:id.$get": get,
      "v1.threads.:id.events.$get": events,
      "v1.threads.:id.timeline.$get": timelineGet,
    });

    await runCommand(["thread", "show", thread.id], register);

    expect(collectLogLines(vi.mocked(console.log))).toContain(
      "  Error: Agent stopped the turn: refusal",
    );
    expect(events).toHaveBeenCalledWith({
      param: { id: thread.id },
      query: {
        limit: "100",
        order: "desc",
        types: "system/error,turn/completed",
      },
    });
  });

  it("bb thread show --self resolves from BB_THREAD_ID", async () => {
    vi.stubEnv("BB_THREAD_ID", "thread-show-self");
    const thread: domain.Thread = fixtures.makeThread({
      id: "thread-show-self",
      projectId: "proj-1",
      providerId: "codex",
      status: "idle",
      createdAt: 1,
      updatedAt: 2,
    });
    const get = vi.fn(async () => thread);
    const timelineGet = fixtures.makeEmptyTimelineGetMock();
    stubThreadApi({
      "v1.threads.:id.$get": get,
      "v1.threads.:id.timeline.$get": timelineGet,
    });

    await runCommand(["thread", "show", "--self"], register);

    expect(get).toHaveBeenCalledWith({
      param: { id: "thread-show-self" },
    });
    expect(collectLogLines(vi.mocked(console.error))).toEqual([]);
  });

  it("bb thread show --work-status prints non-git environment message", async () => {
    const thread: domain.Thread = fixtures.makeThread({
      id: "thread-show-work-status",
      projectId: "proj-1",
      providerId: "codex",
      environmentId: "env-work-status",
      status: "idle",
      createdAt: 1,
      updatedAt: 2,
    });
    const environment = fixtures.makeEnvironment({
      id: "env-work-status",
      projectId: "proj-1",
      hostId: "host-1",
      isGitRepo: false,
      createdAt: 1,
      updatedAt: 2,
    });
    const get = vi.fn(async () => thread);
    const environmentGet = vi.fn(async () => environment);
    const statusGet = vi.fn(async () => ({
      outcome: "not_applicable",
      reason: "non_git_environment",
      message: "Workspace is not a Git repository.",
    }));
    const pullRequestGet = vi.fn(async () => ({ outcome: "absent" }));
    const timelineGet = fixtures.makeEmptyTimelineGetMock();
    stubThreadApi({
      "v1.environments.:id.$get": environmentGet,
      "v1.environments.:id.pull-request.$get": pullRequestGet,
      "v1.environments.:id.status.$get": statusGet,
      "v1.threads.:id.$get": get,
      "v1.threads.:id.timeline.$get": timelineGet,
    });

    await runCommand(
      ["thread", "show", "thread-show-work-status", "--work-status"],
      register,
    );

    expect(statusGet).toHaveBeenCalledWith({
      param: { id: "env-work-status" },
      query: { mergeBaseBranch: "main" },
    });
    expect(collectLogLines(vi.mocked(console.log))).toContain(
      "Work status: Workspace is not a Git repository.",
    );
  });

  it("bb thread show rejects combining a thread id with --self", async () => {
    vi.stubEnv("BB_THREAD_ID", "thread-show-self");

    await expect(
      runCommand(["thread", "show", "thread-explicit", "--self"], register),
    ).rejects.toThrow("process.exit:1");

    expect(collectLogLines(vi.mocked(console.error))).toContain(
      "Error: Cannot combine a thread ID argument with --self.",
    );
    expect(createClientMock).not.toHaveBeenCalled();
  });

  it("bb thread show --git-diff uses the environment base branch before the repository default", async () => {
    const thread: domain.Thread = fixtures.makeThread({
      id: "thread-show-diff-base",
      projectId: "proj-1",
      providerId: "codex",
      environmentId: "env-diff-base",
      status: "idle",
      createdAt: 1,
      updatedAt: 2,
    });
    const environment = fixtures.makeEnvironment({
      id: "env-diff-base",
      projectId: "proj-1",
      hostId: "host-1",
      baseBranch: "release",
      defaultBranch: "main",
      mergeBaseBranch: null,
      createdAt: 1,
      updatedAt: 2,
    });
    const gitDiff: domain.ThreadGitDiffResponse = {
      diff: "",
      files: "M\tsrc/file.ts\n",
      mergeBaseRef: "abc1234",
      shortstat: " 1 file changed, 1 insertion(+)",
      truncated: false,
    };
    const get = vi.fn(async () => thread);
    const environmentGet = vi.fn(async () => environment);
    const diffResponse: serverContract.EnvironmentDiffResponse = {
      outcome: "available",
      diff: gitDiff,
    };
    const diffGet = vi.fn(async () => diffResponse);
    const pullRequestGet = vi.fn(async () => ({ outcome: "absent" }));
    const timelineGet = fixtures.makeEmptyTimelineGetMock();
    stubThreadApi({
      "v1.environments.:id.$get": environmentGet,
      "v1.environments.:id.diff.$get": diffGet,
      "v1.environments.:id.pull-request.$get": pullRequestGet,
      "v1.threads.:id.$get": get,
      "v1.threads.:id.timeline.$get": timelineGet,
    });

    await runCommand(
      ["thread", "show", "thread-show-diff-base", "--git-diff"],
      register,
    );

    expect(diffGet).toHaveBeenCalledWith({
      param: { id: "env-diff-base" },
      query: {
        mergeBaseBranch: "release",
        target: "all",
      },
    });
  });

  it("bb thread show --git-diff renders an available uncommitted diff response", async () => {
    const thread: domain.Thread = fixtures.makeThread({
      id: "thread-show-uncommitted-diff",
      projectId: "proj-1",
      providerId: "codex",
      environmentId: "env-uncommitted-diff",
      status: "idle",
      createdAt: 1,
      updatedAt: 2,
    });
    const environment = fixtures.makeEnvironment({
      id: "env-uncommitted-diff",
      projectId: "proj-1",
      hostId: "host-1",
      createdAt: 1,
      updatedAt: 2,
    });
    const diffResponse: serverContract.EnvironmentDiffResponse = {
      outcome: "available",
      diff: {
        diff: "diff --git a/smoke.txt b/smoke.txt\nnew file mode 100644\n",
        files: "A\tsmoke.txt\n",
        mergeBaseRef: null,
        shortstat: "1 file changed\n",
        truncated: false,
      },
    };
    const get = vi.fn(async () => thread);
    const environmentGet = vi.fn(async () => environment);
    const diffGet = vi.fn(async () => diffResponse);
    const pullRequestGet = vi.fn(async () => ({ outcome: "absent" }));
    const timelineGet = fixtures.makeEmptyTimelineGetMock();
    stubThreadApi({
      "v1.environments.:id.$get": environmentGet,
      "v1.environments.:id.diff.$get": diffGet,
      "v1.environments.:id.pull-request.$get": pullRequestGet,
      "v1.threads.:id.$get": get,
      "v1.threads.:id.timeline.$get": timelineGet,
    });

    await runCommand(
      [
        "thread",
        "show",
        "thread-show-uncommitted-diff",
        "--git-diff",
        "--diff-target",
        "uncommitted",
      ],
      register,
    );

    expect(diffGet).toHaveBeenCalledWith({
      param: { id: "env-uncommitted-diff" },
      query: {
        target: "uncommitted",
      },
    });
    const output = collectLogLines(vi.mocked(console.log)).join("\n");
    expect(output).toContain("Git diff:");
    expect(output).toContain("A\tsmoke.txt");
    expect(output).toContain("Summary: 1 file changed");
    expect(output).toContain("diff --git a/smoke.txt b/smoke.txt");
  });

  it("bb thread show prints pull request details for the thread environment", async () => {
    const thread: domain.Thread = fixtures.makeThread({
      id: "thread-show-pr",
      projectId: "proj-1",
      providerId: "codex",
      environmentId: "env-show-pr",
      status: "idle",
      createdAt: 1,
      updatedAt: 2,
    });
    const environment = fixtures.makeEnvironment({
      id: "env-show-pr",
      projectId: "proj-1",
      hostId: "host-1",
      branchName: "bb/thread-show-pr",
      createdAt: 1,
      updatedAt: 2,
    });
    const pullRequest = makePullRequest({
      title: "Show pull requests in thread show",
      attention: "ready_to_merge",
    });
    const get = vi.fn(async () => thread);
    const environmentGet = vi.fn(async () => environment);
    const pullRequestGet = vi.fn(async () => ({
      outcome: "available",
      pullRequest,
    }));
    const timelineGet = fixtures.makeEmptyTimelineGetMock();
    stubThreadApi({
      "v1.environments.:id.$get": environmentGet,
      "v1.environments.:id.pull-request.$get": pullRequestGet,
      "v1.threads.:id.$get": get,
      "v1.threads.:id.timeline.$get": timelineGet,
    });

    await runCommand(["thread", "show", "thread-show-pr"], register);

    expect(pullRequestGet).toHaveBeenCalledWith({
      param: { id: "env-show-pr" },
    });
    const output = collectLogLines(vi.mocked(console.log)).join("\n");
    expect(output.indexOf("Environment:")).toBeLessThan(
      output.indexOf("Pull request:"),
    );
    expect(output).toContain(
      "Pull request: #42 open - Show pull requests in thread show",
    );
    expect(output).toContain("#42 open - Show pull requests in thread show");
    expect(output).toContain("https://github.com/example/bb/pull/42");
    expect(output).toContain("Branch:       bb/thread-show-pr -> main");
    expect(output).toContain(
      "Checks:       passing (3 passed, 0 failed, 0 pending, 3 total)",
    );
    expect(output).toContain("Review:       review_required (1 requested)");
    expect(output).toContain("Merge:        mergeable");
  });

  it("bb thread show reports a failed pull request lookup distinctly from none", async () => {
    const thread: domain.Thread = fixtures.makeThread({
      id: "thread-show-pr-down",
      projectId: "proj-1",
      providerId: "codex",
      environmentId: "env-show-pr-down",
      status: "idle",
      createdAt: 1,
      updatedAt: 2,
    });
    const environment = fixtures.makeEnvironment({
      id: "env-show-pr-down",
      projectId: "proj-1",
      hostId: "host-1",
      createdAt: 1,
      updatedAt: 2,
    });
    const get = vi.fn(async () => thread);
    const environmentGet = vi.fn(async () => environment);
    const pullRequestGet = vi.fn(async () => ({
      outcome: "unavailable",
      message: "gh pr view failed: authentication required",
    }));
    const timelineGet = fixtures.makeEmptyTimelineGetMock();
    stubThreadApi({
      "v1.environments.:id.$get": environmentGet,
      "v1.environments.:id.pull-request.$get": pullRequestGet,
      "v1.threads.:id.$get": get,
      "v1.threads.:id.timeline.$get": timelineGet,
    });

    await runCommand(["thread", "show", "thread-show-pr-down"], register);

    const output = collectLogLines(vi.mocked(console.log)).join("\n");
    expect(output).toContain("Pull request: unavailable");
    expect(output).toContain("gh pr view failed: authentication required");
    expect(output).not.toContain("Pull request: none");
  });

  it("prints token kinds and child agent states", async () => {
    const thread = fixtures.makeThread({
      id: "thread-spend-show",
      projectId: "proj-1",
      providerId: "codex",
      status: "idle",
      createdAt: 1,
      updatedAt: 2,
    });
    stubThreadApi({
      "v1.threads.:id.$get": vi.fn(async () => thread),
      "v1.threads.:id.timeline.$get": fixtures.makeEmptyTimelineGetMock(),
      "v1.threads.:id.spend-summary.$get": vi.fn(async () => ({
        providerId: "codex",
        historyComplete: true,
        total: {
          inputTokens: 1_200,
          cachedInputTokens: 300,
          outputTokens: 80_000,
          reasoningOutputTokens: 12_000,
          totalTokens: 93_500,
        },
        turns: [
          {
            turnId: "turn-1",
            inputTokens: 1_000,
            cachedInputTokens: null,
            outputTokens: 20,
            reasoningOutputTokens: 4,
            totalTokens: 1_024,
          },
        ],
      })),
      "v1.threads.:id.child-summary.$get": vi.fn(async () => ({
        nonDeletedChildCount: 2,
        unarchivedDescendantCount: 2,
        working: 1,
        waiting: 0,
        idle: 1,
        failed: 0,
        totalTokens: 64_400_000,
        children: [],
      })),
    });

    await runCommand(["thread", "show", thread.id], register);

    const lines = collectLogLines(vi.mocked(console.log));
    expect(lines).toContain(
      "  Thread: Input (uncached) 1.2K · Out 80K · Reasoning (within output) 12K · Cached 300 · Σ 93.5K",
    );
    expect(lines).toContain(
      "  Turn turn-1: Input (uncached) 1K · Out 20 · Reasoning (within output) 4 · Cached unavailable · Σ 1K",
    );
    expect(lines).toContain("Ran 2 agents:");
    expect(lines).toContain(
      "  1 working · 0 waiting · 1 idle · 0 failed · Σ 64.4M",
    );
  });

  it("renders the live Claude token rows with partial-history labels", async () => {
    const thread = fixtures.makeThread({
      id: "thr_k3d6qji9a4",
      projectId: "proj-1",
      providerId: "claude-code",
      status: "idle",
      createdAt: 1,
      updatedAt: 2,
    });
    stubThreadApi({
      "v1.threads.:id.$get": vi.fn(async () => thread),
      "v1.threads.:id.timeline.$get": fixtures.makeEmptyTimelineGetMock(),
      "v1.threads.:id.spend-summary.$get": vi.fn(async () => ({
        providerId: "claude-code",
        historyComplete: false,
        total: {
          inputTokens: 6_442,
          cachedInputTokens: 686_719_425,
          outputTokens: 1_809_971,
          reasoningOutputTokens: 0,
          totalTokens: 688_535_838,
        },
        turns: [
          {
            turnId: "da385f7e5d-t1",
            inputTokens: 30,
            cachedInputTokens: 2_843_776,
            outputTokens: 6_149,
            reasoningOutputTokens: null,
            totalTokens: 2_849_955,
          },
          {
            turnId: "da385f7e5d-t2",
            inputTokens: 8,
            cachedInputTokens: 788_012,
            outputTokens: 831,
            reasoningOutputTokens: null,
            totalTokens: 788_851,
          },
        ],
      })),
    });

    await runCommand(["thread", "show", thread.id], register);

    expect(collectLogLines(vi.mocked(console.log))).toContain(
      "  Thread: Input (uncached) ≥ 6.4K (partial history) · Out ≥ 1.8M (partial history) · Reasoning included in output · Cached (read + write) ≥ 686.7M (partial history) · Σ ≥ 688.5M (partial history)",
    );
    expect(collectLogLines(vi.mocked(console.log)).join("\n")).toMatch(
      /Turn da385f7e5d-t2: Input \(uncached\) 8 · Out 831 · Reasoning included in output · Cached \(read \+ write\) 788K · Σ 788\.9K/,
    );
  });

  it("keeps thread show available when spend summary routes fail", async () => {
    const thread = fixtures.makeThread({
      id: "thread-spend-unavailable",
      projectId: "proj-1",
      providerId: "codex",
      status: "idle",
      createdAt: 1,
      updatedAt: 2,
    });
    stubThreadApi({
      "v1.threads.:id.$get": vi.fn(async () => thread),
      "v1.threads.:id.timeline.$get": fixtures.makeEmptyTimelineGetMock(),
      "v1.threads.:id.spend-summary.$get": vi.fn(async () => {
        throw new Error("spend summary unavailable");
      }),
      "v1.threads.:id.child-summary.$get": vi.fn(async () => {
        throw new Error("child summary unavailable");
      }),
    });

    await runCommand(["thread", "show", thread.id], register);

    const lines = collectLogLines(vi.mocked(console.log));
    expect(lines).toContain("Token usage: unavailable");
    expect(lines).not.toContain("Ran 0 agents:");
    expect(lines.some((line) => line.includes("Status: idle"))).toBe(true);
  });

  it("bb thread show --json includes pull request details", async () => {
    const thread: domain.Thread = fixtures.makeThread({
      id: "thread-json-show-pr",
      projectId: "proj-1",
      providerId: "codex",
      environmentId: "env-json-show-pr",
      status: "idle",
      createdAt: 1,
      updatedAt: 2,
    });
    const environment = fixtures.makeEnvironment({
      id: "env-json-show-pr",
      projectId: "proj-1",
      hostId: "host-1",
      createdAt: 1,
      updatedAt: 2,
    });
    const pullRequest = makePullRequest();
    const get = vi.fn(async () => thread);
    const environmentGet = vi.fn(async () => environment);
    const pullRequestGet = vi.fn(async () => ({
      outcome: "available",
      pullRequest,
    }));
    const timelineGet = fixtures.makeEmptyTimelineGetMock();
    stubThreadApi({
      "v1.environments.:id.$get": environmentGet,
      "v1.environments.:id.pull-request.$get": pullRequestGet,
      "v1.threads.:id.$get": get,
      "v1.threads.:id.timeline.$get": timelineGet,
    });

    await runCommand(
      ["thread", "show", "thread-json-show-pr", "--json"],
      register,
    );

    expect(
      JSON.parse(String(vi.mocked(console.log).mock.calls[0]?.[0])),
    ).toEqual({
      thread,
      environment: {
        ...environment,
        pullRequest: {
          status: "available",
          pullRequest,
        },
      },
      pendingTodos: null,
      execution: null,
      childSummary: {
        nonDeletedChildCount: 0,
        unarchivedDescendantCount: 0,
        working: 0,
        waiting: 0,
        idle: 0,
        failed: 0,
        totalTokens: 0,
        children: [],
      },
      spendSummary: {
        providerId: "codex",
        historyComplete: false,
        total: {
          inputTokens: null,
          cachedInputTokens: null,
          outputTokens: null,
          reasoningOutputTokens: null,
          totalTokens: null,
        },
        turns: [],
      },
    });
  });

  it("bb thread show --json prints the thread in status payload format", async () => {
    const thread: domain.Thread = fixtures.makeThread({
      id: "thread-json-show",
      projectId: "proj-1",
      providerId: "codex",
      status: "idle",
      createdAt: 1,
      updatedAt: 2,
    });
    const get = vi.fn(async () => thread);
    const timelineGet = fixtures.makeEmptyTimelineGetMock();
    stubThreadApi({
      "v1.threads.:id.$get": get,
      "v1.threads.:id.timeline.$get": timelineGet,
    });

    await runCommand(
      ["thread", "show", "thread-json-show", "--json"],
      register,
    );

    expect(
      JSON.parse(String(vi.mocked(console.log).mock.calls[0]?.[0])),
    ).toEqual({
      thread,
      environment: null,
      pendingTodos: null,
      execution: null,
      childSummary: {
        nonDeletedChildCount: 0,
        unarchivedDescendantCount: 0,
        working: 0,
        waiting: 0,
        idle: 0,
        failed: 0,
        totalTokens: 0,
        children: [],
      },
      spendSummary: {
        providerId: "codex",
        historyComplete: false,
        total: {
          inputTokens: null,
          cachedInputTokens: null,
          outputTokens: null,
          reasoningOutputTokens: null,
          totalTokens: null,
        },
        turns: [],
      },
    });
  });
});
