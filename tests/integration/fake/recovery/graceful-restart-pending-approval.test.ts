import type { PendingInteraction } from "@bb/domain";
import { describe, expect, it } from "vitest";
import {
  getThreadEvents,
  getThreadResponse,
  listThreadInteractions,
  resolveThreadInteraction,
  sendTextMessage,
} from "../../helpers/api.js";
import {
  waitForHostConnected,
  waitForHostDisconnected,
  waitForThreadOutputContaining,
  waitForThreadStatus,
} from "../../helpers/assertions.js";
import { withHarness, type IntegrationHarness } from "../../helpers/harness.js";
import {
  createRecoveryThread,
  RECOVERY_TEST_TIMEOUT_MS,
  RECOVERY_TIMEOUT_MS,
} from "./shared.js";

const APPROVAL_TEXT = "approve:command waits across the restart";

async function waitForPendingInteraction(
  harness: IntegrationHarness,
  threadId: string,
  exceptId: string | null,
): Promise<PendingInteraction> {
  const deadline = Date.now() + RECOVERY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const pending = (await listThreadInteractions(harness.api, threadId)).find(
      (interaction) =>
        interaction.status === "pending" && interaction.id !== exceptId,
    );
    if (pending !== undefined) return pending;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`No new pending interaction on ${threadId}`);
}

async function waitForPendingInteractionById(
  harness: IntegrationHarness,
  threadId: string,
  interactionId: string,
): Promise<PendingInteraction> {
  const deadline = Date.now() + RECOVERY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const interaction = (await listThreadInteractions(harness.api, threadId)).find(
      (candidate) =>
        candidate.status === "pending" && candidate.id === interactionId,
    );
    if (interaction !== undefined) return interaction;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Pending interaction ${interactionId} was not restored`);
}

describe.sequential("fake provider graceful restart while awaiting approval", () => {
  it(
    "restores the same approval after adoption, and its answer reaches the adopted provider",
    () =>
      withHarness(async (harness) => {
        const { thread } = await createRecoveryThread(
          harness,
          "Approval Restart",
        );
        await sendTextMessage(harness.api, thread.id, { text: APPROVAL_TEXT });
        const before = await waitForPendingInteraction(
          harness,
          thread.id,
          null,
        );
        const turnsBefore = (await getThreadEvents(harness.api, thread.id))
          .filter((event) => event.type === "turn/started")
          .map((event) => event.scope);

        await harness.shutdownDaemon("self-update");
        await waitForHostDisconnected(
          harness.api,
          harness.hostId,
          RECOVERY_TIMEOUT_MS,
        );
        await harness.startDaemon();
        await waitForHostConnected(harness.api, RECOVERY_TIMEOUT_MS);

        const after = await waitForPendingInteractionById(
          harness,
          thread.id,
          before.id,
        );
        expect(after.turnId).toBe(before.turnId);
        expect(after.payload).toEqual(before.payload);
        expect(
          (await listThreadInteractions(harness.api, thread.id)).map(
            (interaction) => interaction.id,
          ),
        ).toEqual([after.id]);
        expect((await getThreadResponse(harness.api, thread.id)).status).toBe(
          "active",
        );

        await resolveThreadInteraction({
          api: harness.api,
          threadId: thread.id,
          interactionId: after.id,
          resolution: { decision: "allow_once", grantedPermissions: null },
        });
        await waitForThreadOutputContaining(
          harness.api,
          thread.id,
          `Response to: ${APPROVAL_TEXT}`,
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
            .map((event) => event.scope),
        ).toEqual(turnsBefore);
        expect(
          events.filter((event) => event.type === "system/thread/interrupted"),
        ).toEqual([]);
      }),
    RECOVERY_TEST_TIMEOUT_MS,
  );
});
