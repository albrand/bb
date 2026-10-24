import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { deleteThread } from "../../helpers/api.js";
import {
  createProjectFixture,
  createReadyHostThread,
} from "../../helpers/fixtures.js";
import { withHarness } from "../../helpers/harness.js";
import { DEFAULT_TIMEOUT_MS } from "./shared.js";

const SECRET = "FAKE_SECRET_p19_test";
const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const run = promisify(execFile);

describe.sequential("the reason a deleted thread's files are kept", () => {
  it(
    "names the processes by id and never carries a holder's command line, in the column, the API or the CLI",
    () =>
      withHarness(
        { builtinPlugins: ["environment-git-worktree"] },
        async (harness) => {
          const project = await createProjectFixture(harness, {
            name: "Reason",
          });
          const created = await createReadyHostThread(harness, {
            projectId: project.id,
            timeoutMs: DEFAULT_TIMEOUT_MS,
            workspace: { type: "managed-worktree" },
          });
          const threadId = created.thread.id;
          const storage = path.join(
            harness.daemonDataDir,
            "thread-storage",
            threadId,
          );
          await fs.mkdir(storage, { recursive: true });
          const holder = spawn(
            "sh",
            ["-c", "sleep 600; true", "sh", `--token=${SECRET}`],
            { cwd: storage, stdio: "ignore" },
          );
          try {
            const cmdline = await fs.readFile(
              `/proc/${holder.pid}/cmdline`,
              "utf8",
            );
            expect(cmdline).toContain(SECRET);

            await deleteThread(harness.api, threadId);
            let keptReason: string | null = null;
            for (
              let attempt = 0;
              attempt < 300 && keptReason === null;
              attempt += 1
            ) {
              const response = await harness.api.threads[":id"][
                "storage-deletion"
              ].$get({ param: { id: threadId } });
              const body =
                response.status === 200 ? await response.json() : null;
              keptReason = body?.keptReason ?? null;
              if (keptReason === null)
                await new Promise((resolve) => setTimeout(resolve, 100));
            }
            expect(keptReason).not.toBeNull();

            const stored = (
              harness.db.$client
                .prepare(
                  "SELECT storage_delete_refusal AS reason FROM threads WHERE id = ?",
                )
                .get(threadId) as { reason: string | null }
            ).reason;
            const served = JSON.stringify(
              await (
                await harness.api.threads[":id"]["storage-deletion"].$get({
                  param: { id: threadId },
                })
              ).json(),
            );
            const shown = await run(
              process.execPath,
              [
                "--conditions=source",
                "--import",
                "tsx",
                "apps/cli/src/index.ts",
                "thread",
                "show",
                threadId,
                "--json",
              ],
              {
                cwd: REPO_ROOT,
                env: { ...process.env, BB_SERVER_URL: harness.server.baseUrl },
              },
            );

            for (const [source, text] of [
              ["the stored column", stored ?? ""],
              ["GET /threads/:id/storage-deletion", served],
              ["bb thread show --json", shown.stdout],
            ] as const) {
              expect(text, source).not.toContain(SECRET);
              expect(text, source).not.toContain("--token");
              expect(text, source).not.toContain("thread-storage");
              expect(text, source).toContain(`pid ${holder.pid}`);
            }
          } finally {
            holder.kill("SIGKILL");
          }
        },
      ),
    240_000,
  );
});
