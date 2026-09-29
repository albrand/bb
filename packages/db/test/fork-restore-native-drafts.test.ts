import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import {
  PERSONAL_PROJECT_ID,
  promptInputSchema,
  queuedMessageWaitingOnSchema,
  type PromptInput,
} from "@bb/domain";
import {
  claimQueuedThreadMessageGroup,
  createConnection,
  createQueuedThreadMessage,
  createThread,
  listQueuedThreadMessagesByWaitHolder,
  migrate,
  noopNotifier,
  updateQueuedThreadMessage,
} from "../src/index.js";

const THREAD_DRAFTS_MIGRATION_TIMESTAMP = 1790322211064;
const originalMigration = readFileSync(
  new URL("./fixtures/0132_thread_drafts_original.sql", import.meta.url),
  "utf8",
);

function text(value: string): PromptInput {
  return { type: "text", text: value, mentions: [] };
}

it("lets a user edit and send a first-message draft that the original 0132 moved into threads.draft", () => {
  const db = createConnection(":memory:");
  try {
    migrate(db);
    const earlier = createThread(db, noopNotifier, {
      projectId: PERSONAL_PROJECT_ID,
      providerId: "used-provider",
      status: "idle",
    });
    createQueuedThreadMessage(db, noopNotifier, {
      threadId: earlier.id,
      content: [text("Earlier queued message")],
      model: "used-model",
      reasoningLevel: "high",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: null,
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });
    const firstMessageDraft = createThread(db, noopNotifier, {
      projectId: PERSONAL_PROJECT_ID,
      providerId: "used-provider",
      status: "pending",
    });
    const unknownProviderDraft = createThread(db, noopNotifier, {
      projectId: PERSONAL_PROJECT_ID,
      providerId: "never-used-provider",
      status: "pending",
    });
    db.$client
      .prepare("DELETE FROM __drizzle_migrations WHERE created_at >= ?")
      .run(THREAD_DRAFTS_MIGRATION_TIMESTAMP);
    db.$client.exec(originalMigration);
    db.$client
      .prepare("INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)")
      .run(
        createHash("sha256").update(originalMigration).digest("hex"),
        THREAD_DRAFTS_MIGRATION_TIMESTAMP,
      );
    const draftContent: PromptInput[] = [
      text("Plan the release"),
      { type: "localFile", path: "/tmp/plan.md", name: "plan.md" },
    ];
    const setDraft = db.$client.prepare(
      "UPDATE threads SET draft = ? WHERE id = ?",
    );
    setDraft.run(JSON.stringify(draftContent), firstMessageDraft.id);
    setDraft.run(JSON.stringify([text("Orphan draft")]), unknownProviderDraft.id);

    migrate(db);

    const held = listQueuedThreadMessagesByWaitHolder(db, "plugin:drafts");
    expect(held.map((row) => row.threadId)).toEqual([firstMessageDraft.id]);
    const [draft] = held;
    if (draft === undefined) throw new Error("expected a held draft");
    expect(promptInputSchema.array().parse(JSON.parse(draft.content))).toEqual(
      draftContent,
    );
    expect(
      queuedMessageWaitingOnSchema.parse(JSON.parse(draft.waitingOn ?? "null")),
    ).toEqual({ kind: "plugin", pluginId: "drafts", reason: "Draft" });
    expect({
      model: draft.model,
      reasoningLevel: draft.reasoningLevel,
      permissionMode: draft.permissionMode,
    }).toEqual({
      model: "used-model",
      reasoningLevel: "high",
      permissionMode: "full",
    });

    const edited: PromptInput[] = [
      text("Plan the release, then tag it"),
      { type: "localFile", path: "/tmp/plan.md", name: "plan.md" },
    ];
    const update = updateQueuedThreadMessage(db, noopNotifier, {
      id: draft.id,
      threadId: firstMessageDraft.id,
      content: edited,
      expectedUpdatedAt: draft.updatedAt,
    });
    expect(update.kind).toBe("updated");

    const claimed = claimQueuedThreadMessageGroup(db, noopNotifier, draft.id, {
      kind: "explicit-send",
    });
    expect(claimed?.map((row) => JSON.parse(row.content))).toEqual([edited]);

    expect(
      db.$client
        .prepare(
          "SELECT thread_id AS threadId, content FROM fork_unrestored_thread_drafts",
        )
        .all(),
    ).toEqual([
      {
        threadId: unknownProviderDraft.id,
        content: JSON.stringify([text("Orphan draft")]),
      },
    ]);
    expect(
      db.$client
        .prepare(
          "SELECT name FROM pragma_table_info('threads') WHERE name = 'draft'",
        )
        .all(),
    ).toEqual([]);
  } finally {
    db.$client.close();
  }
});
