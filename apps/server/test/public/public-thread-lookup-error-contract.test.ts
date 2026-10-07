import { archiveThread, markThreadDeleted } from "@bb/db";
import { createBbSdk } from "@bb/sdk/core";
import { createHttpTransport } from "@bb/sdk/node";
import { describe, expect, it } from "vitest";
import {
  seedHostSession,
  seedProjectWithSource,
  seedThread,
} from "../helpers/seed.js";
import { withTestHarness } from "../helpers/test-app.js";

describe("thread lookup contract used by plugins to detect gone threads", () => {
  it("reports archived threads through archivedAt and missing or deleted threads as HTTP 404 thread_not_found through the SDK", async () => {
    await withTestHarness(async (harness) => {
      const sdk = createBbSdk({
        transport: createHttpTransport({
          baseUrl: "http://localhost",
          runtime: "node",
          fetch: async (input, init) =>
            harness.app.fetch(new Request(input, init)),
        }),
      });
      const { host } = seedHostSession(harness.deps, {
        id: "host-thread-lookup-contract",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/thread-lookup-contract-source",
      });
      const live = seedThread(harness.deps, { projectId: project.id });
      const archived = seedThread(harness.deps, { projectId: project.id });
      const deleted = seedThread(harness.deps, { projectId: project.id });

      archiveThread(harness.db, harness.hub, archived.id);
      markThreadDeleted(harness.db, harness.hub, { threadId: deleted.id });

      const liveThread = await sdk.threads.get({ threadId: live.id });
      expect(liveThread.archivedAt).toBeNull();
      expect(liveThread.deletedAt).toBeNull();
      const archivedThread = await sdk.threads.get({ threadId: archived.id });
      expect(archivedThread.archivedAt).toEqual(expect.any(Number));
      for (const threadId of ["thr_missing", deleted.id]) {
        const error = await sdk.threads.get({ threadId }).then(
          () => null,
          (thrown: unknown) => thrown,
        );
        expect(error).toMatchObject({
          name: "BbHttpError",
          status: 404,
          code: "thread_not_found",
        });
      }
    });
  });
});
