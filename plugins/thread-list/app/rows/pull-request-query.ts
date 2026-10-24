import { experimental_useRpcKeyedQuery } from "@get-bb/plugin-sdk/app";
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const THREAD_LIST_PULL_REQUEST_PLUGIN_ID = "bb--github-pr-status";

const pullRequestSchema = z
  .object({
    number: z.number().int().positive(),
    title: z.string(),
    state: z.enum(["draft", "open", "merged", "closed"]),
    url: z.string().url(),
  })
  .passthrough();

const environmentPullRequestSchema = z.discriminatedUnion("outcome", [
  z
    .object({ outcome: z.literal("available"), pullRequest: pullRequestSchema })
    .passthrough(),
  z.object({ outcome: z.literal("absent") }).passthrough(),
  z
    .object({ outcome: z.literal("unavailable"), message: z.string() })
    .passthrough(),
]);

export const threadListPullRequestRpcContract = defineRpcContract({
  pullRequests: {
    experimental_description:
      "The GitHub pull request for each environment's current branch, keyed by environment id.",
    input: z
      .object({
        keys: z.array(z.string().min(1)).min(1).max(200),
      })
      .strict(),
    output: z.record(z.string(), environmentPullRequestSchema),
    keyTags: (key) => [`environment:${key}`],
  },
});

export type ThreadListPullRequest = z.infer<typeof pullRequestSchema>;

export function useThreadListPullRequest(environmentId: string | null) {
  const query = experimental_useRpcKeyedQuery({
    contract: threadListPullRequestRpcContract,
    pluginId: THREAD_LIST_PULL_REQUEST_PLUGIN_ID,
    method: "pullRequests",
    keys: environmentId === null ? [] : [environmentId],
    enabled: environmentId !== null,
  });
  const row = environmentId ? query.data?.[environmentId] : undefined;
  return row?.outcome === "available" ? row.pullRequest : null;
}
