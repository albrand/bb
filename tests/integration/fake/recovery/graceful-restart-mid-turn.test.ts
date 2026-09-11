import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  getThreadEvents,
  getThreadResponse,
  sendTextMessage,
} from "../../helpers/api.js";
import {
  waitForHostConnected,
  waitForHostDisconnected,
  waitForThreadOutputContaining,
  waitForThreadStatus,
} from "../../helpers/assertions.js";
import { withHarness } from "../../helpers/harness.js";
import {
  ACTIVE_TIMEOUT_MS,
  createRecoveryThread,
  RECOVERY_TEST_TIMEOUT_MS,
  RECOVERY_TIMEOUT_MS,
} from "./shared.js";

const MID_TURN_TEXT = "delay:6000 stream:2 survives the daemon";

describe.sequential("fake provider graceful restart mid-turn", () => {
  it(
    "keeps a running turn across a graceful daemon restart and completes it on the same turn",
    () =>
      withHarness(async (harness) => {
        const { thread } = await createRecoveryThread(
          harness,
          "Mid-turn Restart",
        );
        await sendTextMessage(harness.api, thread.id, { text: MID_TURN_TEXT });
        await waitForThreadStatus(
          harness.api,
          thread.id,
          "active",
          ACTIVE_TIMEOUT_MS,
        );
        const readyTurns = (await getThreadEvents(harness.api, thread.id))
          .filter((event) => event.type === "turn/started")
          .map((event) => event.scope);
        const deadline = Date.now() + RECOVERY_TIMEOUT_MS;
        let startedBefore: unknown[] = [];
        while (startedBefore.length === 0 && Date.now() < deadline) {
          startedBefore = (await getThreadEvents(harness.api, thread.id))
            .filter((event) => event.type === "turn/started")
            .map((event) => event.scope)
            .slice(readyTurns.length);
          if (startedBefore.length === 0) {
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
        }
        expect(startedBefore).toHaveLength(1);

        await harness.shutdownDaemon("self-update");
        await waitForHostDisconnected(
          harness.api,
          harness.hostId,
          RECOVERY_TIMEOUT_MS,
        );
        await harness.startDaemon();
        await waitForHostConnected(harness.api, RECOVERY_TIMEOUT_MS);
        expect((await getThreadResponse(harness.api, thread.id)).status).toBe(
          "active",
        );

        await waitForThreadOutputContaining(
          harness.api,
          thread.id,
          "survives the daemon",
          RECOVERY_TIMEOUT_MS,
        );
        await waitForThreadStatus(
          harness.api,
          thread.id,
          "idle",
          RECOVERY_TIMEOUT_MS,
        );

        const events = await getThreadEvents(harness.api, thread.id);
        expect(
          events
            .filter((event) => event.type === "turn/started")
            .map((event) => event.scope)
            .slice(readyTurns.length),
        ).toEqual(startedBefore);
        const completed = events
          .filter((event) => event.type === "turn/completed")
          .slice(readyTurns.length);
        expect(completed.map((event) => event.scope)).toEqual(startedBefore);
        expect(JSON.stringify(completed[0])).not.toContain("interrupted");
        expect(
          events.filter((event) => event.type === "system/thread/interrupted"),
        ).toEqual([]);
        const workersForThread = (
          await readdir(path.join(harness.daemonDataDir, "bridge-workers"))
        ).filter((name) => name.endsWith(".json"));
        const threadsPerWorker = await Promise.all(
          workersForThread.map(async (name) => {
            const entry = JSON.parse(
              await readFile(
                path.join(harness.daemonDataDir, "bridge-workers", name),
                "utf8",
              ),
            ) as { threads: Record<string, unknown> };
            return Object.keys(entry.threads);
          }),
        );
        expect(
          threadsPerWorker.filter((threadIds) => threadIds.includes(thread.id)),
        ).toHaveLength(1);
      }),
    RECOVERY_TEST_TIMEOUT_MS,
  );
});
