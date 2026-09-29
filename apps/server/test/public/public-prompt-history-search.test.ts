import { createPromptHistoryEntry, markThreadDeleted } from "@bb/db";
import type { PromptHistoryScope, PromptInput } from "@bb/domain";
import { promptHistorySearchResponseSchema } from "@bb/server-contract";
import { describe, expect, it } from "vitest";
import { readJson } from "../helpers/json.js";
import { textInput } from "../helpers/prompt-input.js";
import {
  seedHostSession,
  seedProjectWithSource,
  seedThread,
} from "../helpers/seed.js";
import {
  withTestHarness,
  type TestAppHarness as TestHarness,
} from "../helpers/test-app.js";

interface SeedPromptArgs {
  createdAt: number;
  input: PromptInput[];
  projectId: string;
  requestSequence: number;
  scope?: PromptHistoryScope;
  threadId: string;
}

function seedPrompt(harness: TestHarness, args: SeedPromptArgs) {
  return createPromptHistoryEntry(harness.deps.db, {
    projectId: args.projectId,
    threadId: args.threadId,
    scope: args.scope ?? "thread",
    requestSequence: args.requestSequence,
    input: args.input,
    createdAt: args.createdAt,
  });
}

function seedTwoProjects(harness: TestHarness) {
  const { host } = seedHostSession(harness.deps);
  const { project: alpha } = seedProjectWithSource(harness.deps, {
    hostId: host.id,
    name: "Alpha",
    path: "/tmp/alpha",
  });
  const { project: beta } = seedProjectWithSource(harness.deps, {
    hostId: host.id,
    name: "Beta",
    path: "/tmp/beta",
  });
  const alphaThread = seedThread(harness.deps, {
    projectId: alpha.id,
    title: "Alpha work",
    titleFallback: "Alpha work",
  });
  const betaThread = seedThread(harness.deps, {
    projectId: beta.id,
    title: "Beta work",
    titleFallback: "Beta work",
  });
  return { alpha, beta, alphaThread, betaThread };
}

async function search(harness: TestHarness, query: string) {
  const response = await harness.app.request(
    `/api/v1/prompt-history/search${query}`,
  );
  expect(response.status).toBe(200);
  return promptHistorySearchResponseSchema.parse(await readJson(response));
}

function texts(results: { input: PromptInput[] }[]): string[] {
  return results.map((result) =>
    result.input
      .flatMap((item) => (item.type === "text" ? [item.text] : []))
      .join(""),
  );
}

describe("public prompt history search route", () => {
  it("searches prompts from every project and returns their context", async () => {
    await withTestHarness(async (harness) => {
      const { alpha, beta, alphaThread, betaThread } = seedTwoProjects(harness);
      seedPrompt(harness, {
        projectId: alpha.id,
        threadId: alphaThread.id,
        scope: "project",
        requestSequence: 1,
        createdAt: 100,
        input: textInput("Refactor the auth middleware"),
      });
      seedPrompt(harness, {
        projectId: beta.id,
        threadId: betaThread.id,
        requestSequence: 1,
        createdAt: 200,
        input: textInput("Write tests for AUTH tokens"),
      });
      seedPrompt(harness, {
        projectId: beta.id,
        threadId: betaThread.id,
        requestSequence: 2,
        createdAt: 300,
        input: textInput("Deploy the docs site"),
      });

      const results = await search(harness, "?query=auth");

      expect(texts(results)).toEqual([
        "Write tests for AUTH tokens",
        "Refactor the auth middleware",
      ]);
      expect(results[0]).toMatchObject({
        projectId: beta.id,
        projectName: "Beta",
        threadId: betaThread.id,
        threadTitle: "Beta work",
        lastUsedAt: 200,
        useCount: 1,
      });
      expect(results[1]).toMatchObject({
        projectId: alpha.id,
        projectName: "Alpha",
      });

      const alphaOnly = await search(
        harness,
        `?query=auth&projectId=${alpha.id}`,
      );
      expect(texts(alphaOnly)).toEqual(["Refactor the auth middleware"]);
    });
  });

  it("requires every term in prompt text, not in the stored JSON", async () => {
    await withTestHarness(async (harness) => {
      const { alpha, alphaThread } = seedTwoProjects(harness);
      seedPrompt(harness, {
        projectId: alpha.id,
        threadId: alphaThread.id,
        requestSequence: 1,
        createdAt: 100,
        input: [
          ...textInput("fix the flaky login test"),
          { type: "localImage", path: "/tmp/shot.png" },
        ],
      });
      seedPrompt(harness, {
        projectId: alpha.id,
        threadId: alphaThread.id,
        requestSequence: 2,
        createdAt: 200,
        input: textInput("the login page is slow"),
      });

      expect(texts(await search(harness, "?query=login%20flaky"))).toEqual([
        "fix the flaky login test",
      ]);
      expect(await search(harness, "?query=text")).toEqual([]);
      expect(await search(harness, "?query=type")).toEqual([]);
      expect(await search(harness, "?query=localImage")).toEqual([]);
      expect(await search(harness, "?query=mentions")).toEqual([]);
    });
  });

  it("requires terms beyond the eighth word", async () => {
    await withTestHarness(async (harness) => {
      const { alpha, alphaThread } = seedTwoProjects(harness);
      seedPrompt(harness, {
        projectId: alpha.id,
        threadId: alphaThread.id,
        requestSequence: 1,
        createdAt: 100,
        input: textInput("one two three four five six seven eight"),
      });
      seedPrompt(harness, {
        projectId: alpha.id,
        threadId: alphaThread.id,
        requestSequence: 2,
        createdAt: 200,
        input: textInput("one two three four five six seven eight nine"),
      });

      expect(
        texts(
          await search(
            harness,
            "?query=one%20two%20three%20four%20five%20six%20seven%20eight%20nine",
          ),
        ),
      ).toEqual(["one two three four five six seven eight nine"]);
    });
  });

  it("treats LIKE wildcards and backslashes in the query literally", async () => {
    await withTestHarness(async (harness) => {
      const { alpha, alphaThread } = seedTwoProjects(harness);
      seedPrompt(harness, {
        projectId: alpha.id,
        threadId: alphaThread.id,
        requestSequence: 1,
        createdAt: 100,
        input: textInput("coverage is at 100% now"),
      });
      seedPrompt(harness, {
        projectId: alpha.id,
        threadId: alphaThread.id,
        requestSequence: 2,
        createdAt: 200,
        input: textInput("rename user_id to account_id"),
      });
      seedPrompt(harness, {
        projectId: alpha.id,
        threadId: alphaThread.id,
        requestSequence: 3,
        createdAt: 300,
        input: textInput("open C:\\repo\\src"),
      });
      seedPrompt(harness, {
        projectId: alpha.id,
        threadId: alphaThread.id,
        requestSequence: 4,
        createdAt: 400,
        input: textInput("userXid 100 percent"),
      });

      expect(texts(await search(harness, "?query=100%25"))).toEqual([
        "coverage is at 100% now",
      ]);
      expect(texts(await search(harness, "?query=user_id"))).toEqual([
        "rename user_id to account_id",
      ]);
      expect(texts(await search(harness, "?query=C%3A%5Crepo"))).toEqual([
        "open C:\\repo\\src",
      ]);
    });
  });

  it("collapses repeated prompts into one result with a use count", async () => {
    await withTestHarness(async (harness) => {
      const { alpha, beta, alphaThread, betaThread } = seedTwoProjects(harness);
      seedPrompt(harness, {
        projectId: alpha.id,
        threadId: alphaThread.id,
        requestSequence: 1,
        createdAt: 100,
        input: textInput("continue"),
      });
      seedPrompt(harness, {
        projectId: beta.id,
        threadId: betaThread.id,
        requestSequence: 1,
        createdAt: 300,
        input: textInput("continue"),
      });
      seedPrompt(harness, {
        projectId: alpha.id,
        threadId: alphaThread.id,
        requestSequence: 2,
        createdAt: 200,
        input: textInput("continue"),
      });

      const results = await search(harness, "?query=continue");

      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        useCount: 3,
        lastUsedAt: 300,
        projectId: beta.id,
        threadId: betaThread.id,
      });
    });
  });

  it("lists recent prompts without a query, bounded by limit, skipping deleted threads", async () => {
    await withTestHarness(async (harness) => {
      const { alpha, alphaThread } = seedTwoProjects(harness);
      const deletedThread = seedThread(harness.deps, {
        projectId: alpha.id,
      });
      for (const sequence of [1, 2, 3]) {
        seedPrompt(harness, {
          projectId: alpha.id,
          threadId: alphaThread.id,
          requestSequence: sequence,
          createdAt: sequence * 100,
          input: textInput(`prompt ${sequence}`),
        });
      }
      seedPrompt(harness, {
        projectId: alpha.id,
        threadId: deletedThread.id,
        requestSequence: 1,
        createdAt: 1_000,
        input: textInput("prompt from a deleted thread"),
      });
      markThreadDeleted(harness.deps.db, harness.deps.hub, {
        threadId: deletedThread.id,
      });

      expect(texts(await search(harness, ""))).toEqual([
        "prompt 3",
        "prompt 2",
        "prompt 1",
      ]);
      expect(texts(await search(harness, "?limit=2"))).toEqual([
        "prompt 3",
        "prompt 2",
      ]);
    });
  });

  it("rejects an invalid limit and an unknown project", async () => {
    await withTestHarness(async (harness) => {
      expect(
        (await harness.app.request("/api/v1/prompt-history/search?limit=0"))
          .status,
      ).toBe(400);
      expect(
        (await harness.app.request("/api/v1/prompt-history/search?limit=abc"))
          .status,
      ).toBe(400);
      expect(
        (
          await harness.app.request(
            "/api/v1/prompt-history/search?projectId=proj_missing",
          )
        ).status,
      ).toBe(404);
    });
  });
});
