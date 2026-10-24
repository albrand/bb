import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { environmentHostProgressSchema } from "bb-environment-provider-host/progress";

export const worktreeBaseBranchSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("named"), name: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("default") }).strict(),
]);
export type WorktreeBaseBranch = z.infer<typeof worktreeBaseBranchSchema>;

export const discoveredWorktreeSchema = z
  .object({
    path: z.string().min(1),
    branch: z.string().nullable(),
    locked: z.boolean(),
    prunable: z.boolean(),
  })
  .strict();
export type DiscoveredWorktree = z.infer<typeof discoveredWorktreeSchema>;

export const worktreeHostContract = defineRpcContract({
  defaultBaseBranch: {
    input: z.object({ sourcePath: z.string().min(1) }).strict(),
    output: z.object({ branch: z.string().min(1).nullable() }).strict(),
  },
  listWorktrees: {
    input: z.object({ sourcePath: z.string().min(1) }).strict(),
    output: z.object({ worktrees: z.array(discoveredWorktreeSchema) }).strict(),
  },
  resolveExistingWorktree: {
    input: z
      .object({
        sourcePath: z.string().min(1),
        path: z.string().min(1),
      })
      .strict(),
    output: z.discriminatedUnion("status", [
      z
        .object({
          status: z.literal("resolved"),
          path: z.string().min(1),
          branch: z.string().nullable(),
        })
        .strict(),
      z
        .object({ status: z.literal("failed"), message: z.string().min(1) })
        .strict(),
    ]),
  },
  create: {
    input: z
      .object({
        operationId: z.string().min(1),
        sourcePath: z.string().min(1),
        pathKey: z.string().min(1),
        branchName: z.string().min(1),
        baseBranch: worktreeBaseBranchSchema,
        branchMode: z.enum(["reset", "reuse-existing"]),
        previousAttempt: z
          .object({
            threadId: z.string().min(1),
            attempt: z.number().int().min(2),
          })
          .strict()
          .optional(),
      })
      .strict(),
    output: z.discriminatedUnion("status", [
      z
        .object({
          status: z.literal("created"),
          path: z.string().min(1),
          baseBranch: z.string().min(1).nullable(),
        })
        .strict(),
      z
        .object({
          status: z.literal("failed"),
          message: z.string().min(1),
          kept: z.discriminatedUnion("kind", [
            z.object({ kind: z.literal("kept"), path: z.string().min(1) }).strict(),
            z.object({ kind: z.literal("nothing") }).strict(),
            z.object({ kind: z.literal("unknown") }).strict(),
          ]),
        })
        .strict(),
    ]),
  },
  proveRetentionAbsent: {
    input: z
      .object({
        path: z.string().min(1).nullable(),
        pathKey: z.string().min(1).nullable(),
        branchName: z.string().min(1).nullable(),
        sourcePath: z.string().min(1).nullable(),
        threadId: z.string().min(1).nullable(),
      })
      .strict(),
    output: z.discriminatedUnion("absent", [
      z
        .object({ absent: z.literal(true), proof: z.string().min(1) })
        .strict(),
      z
        .object({ absent: z.literal(false), reason: z.string().min(1) })
        .strict(),
    ]),
  },
  inspect: {
    input: z
      .object({
        pathKey: z.string().min(1),
        path: z.string().min(1).nullable(),
      })
      .strict(),
    output: z.discriminatedUnion("status", [
      z.object({ status: z.literal("removable") }).strict(),
      z
        .object({ status: z.literal("retained"), message: z.string().min(1) })
        .strict(),
      z
        .object({ status: z.literal("failed"), message: z.string().min(1) })
        .strict(),
    ]),
  },
  remove: {
    input: z
      .object({
        operationId: z.string().min(1),
        pathKey: z.string().min(1),
        path: z.string().min(1).nullable(),
      })
      .strict(),
    output: z.discriminatedUnion("status", [
      z.object({ status: z.literal("removed") }).strict(),
      z
        .object({ status: z.literal("retained"), message: z.string().min(1) })
        .strict(),
      z
        .object({ status: z.literal("failed"), message: z.string().min(1) })
        .strict(),
    ]),
  },
});

export const worktreeHostSignals = {
  progress: {
    payload: environmentHostProgressSchema,
  },
} as const;
