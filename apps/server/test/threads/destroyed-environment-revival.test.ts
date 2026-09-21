import {
  deleteProjectSource,
  getEnvironment,
  environments,
  type EnvironmentRow,
} from "@bb/db";
import { eq } from "drizzle-orm";
import { DEFAULT_ENVIRONMENT_PROVIDER_ID } from "../../src/services/environments/environment-provider-ids.js";
import { acceptThreadSendRequest } from "../../src/services/threads/thread-send-request.js";
import {
  listQueuedThreadCommands,
  registerTestHostRpcCapture,
  waitForQueuedCommand,
} from "../helpers/commands.js";
import { textInput } from "../helpers/prompt-input.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
} from "../helpers/seed.js";
import { withTestHarness } from "../helpers/test-app.js";
import type { TestAppHarness } from "../helpers/test-app.js";
import { describe, expect, it } from "vitest";

interface DestroyedEnvironmentFixture {
  environment: EnvironmentRow;
  projectSourcePath: string;
  thread: ReturnType<typeof seedThread>;
}

function seedDestroyedEnvironmentFixture(
  harness: TestAppHarness,
  args: {
    environmentProviderId?: string;
    providerOwnsPath?: boolean;
  } = {},
): DestroyedEnvironmentFixture {
  const { host, session } = seedHostSession(harness.deps, {
    id: "host-revival",
  });
  const projectSourcePath = `/tmp/revival-source-${host.id}`;
  registerTestHostRpcCapture(harness, {
    hostId: host.id,
    sessionId: session.id,
    pathsExistResult: { existence: { [projectSourcePath]: true } },
  });
  const { project } = seedProjectWithSource(harness.deps, {
    hostId: host.id,
    path: projectSourcePath,
  });
  const environment = seedEnvironment(harness.deps, {
    hostId: host.id,
    projectId: project.id,
    path: null,
    status: "destroyed",
    ...(args.environmentProviderId === undefined
      ? {}
      : { environmentProviderId: args.environmentProviderId }),
    providerOwnsPath: args.providerOwnsPath ?? false,
  });
  harness.db
    .update(environments)
    .set({ teardownStatus: "removed" })
    .where(eq(environments.id, environment.id))
    .run();
  const thread = seedThread(harness.deps, {
    projectId: project.id,
    environmentId: environment.id,
    status: "idle",
  });
  return { environment, projectSourcePath, thread };
}

async function sendToDestroyedEnvironment(
  harness: TestAppHarness,
  fixture: DestroyedEnvironmentFixture,
) {
  return acceptThreadSendRequest(harness.deps, {
    thread: fixture.thread,
    payload: {
      input: textInput("resume after retirement"),
      mode: "start",
      model: "gpt-5",
      permissionMode: "full",
      reasoningLevel: "medium",
      serviceTier: "default",
    },
  });
}

describe("destroyed environment revival", () => {
  it("revives an unmanaged project checkout and dispatches to its source path", async () => {
    await withTestHarness(async (harness) => {
      const fixture = seedDestroyedEnvironmentFixture(harness, {
        environmentProviderId:
          DEFAULT_ENVIRONMENT_PROVIDER_ID.projectCheckout,
      });

      const response = await sendToDestroyedEnvironment(harness, fixture);

      expect(response).toMatchObject({ delivery: "sent" });
      expect(getEnvironment(harness.db, fixture.environment.id)).toMatchObject({
        status: "ready",
        path: fixture.projectSourcePath,
        teardownStatus: null,
        retireAt: null,
      });
      const command = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          (command.type === "thread.start" || command.type === "turn.submit") &&
          command.threadId === fixture.thread.id,
      );
      expect(command.command).toMatchObject(
        command.command.type === "thread.start"
          ? { workspaceContext: { workspacePath: fixture.projectSourcePath } }
          : { cwd: fixture.projectSourcePath },
      );
    });
  });

  it.each([
    DEFAULT_ENVIRONMENT_PROVIDER_ID.gitWorktree,
    DEFAULT_ENVIRONMENT_PROVIDER_ID.personalWorkspace,
  ])("does not revive destroyed %s environments", async (providerId) => {
    await withTestHarness(async (harness) => {
      const fixture = seedDestroyedEnvironmentFixture(harness, {
        environmentProviderId: providerId,
      });

      await expect(sendToDestroyedEnvironment(harness, fixture)).resolves.toMatchObject({
        delivery: "sent",
      });
      expect(getEnvironment(harness.db, fixture.environment.id)?.status).toBe(
        "destroyed",
      );
    });
  });

  it("never revives an owned project checkout", async () => {
    await withTestHarness(async (harness) => {
      const fixture = seedDestroyedEnvironmentFixture(harness, {
        environmentProviderId:
          DEFAULT_ENVIRONMENT_PROVIDER_ID.projectCheckout,
        providerOwnsPath: true,
      });

      await expect(sendToDestroyedEnvironment(harness, fixture)).resolves.toMatchObject({
        delivery: "sent",
      });
      expect(getEnvironment(harness.db, fixture.environment.id)?.status).toBe(
        "destroyed",
      );
    });
  });

  it("keeps the destroyed error when the project source is missing", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, {
        id: "host-revival-missing-source",
      });
      const { project, source } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/revival-missing-source",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: null,
        status: "destroyed",
        environmentProviderId:
          DEFAULT_ENVIRONMENT_PROVIDER_ID.projectCheckout,
      });
      harness.db
        .update(environments)
        .set({ teardownStatus: "removed" })
        .where(eq(environments.id, environment.id))
        .run();
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "idle",
      });
      deleteProjectSource(harness.db, harness.hub, source.id);

      await expect(
        sendToDestroyedEnvironment(harness, { environment, projectSourcePath: source.path, thread }),
      ).rejects.toMatchObject({
        body: {
          code: "thread_environment_unavailable",
          details: { reason: "destroyed" },
        },
      });
      expect(getEnvironment(harness.db, environment.id)?.status).toBe(
        "destroyed",
      );
    });
  });

  it("revives a legacy null-provider environment and dispatches", async () => {
    await withTestHarness(async (harness) => {
      const fixture = seedDestroyedEnvironmentFixture(harness);

      const response = await sendToDestroyedEnvironment(harness, fixture);

      expect(response).toMatchObject({ delivery: "sent" });
      expect(getEnvironment(harness.db, fixture.environment.id)).toMatchObject({
        status: "ready",
        path: fixture.projectSourcePath,
      });
      expect(
        listQueuedThreadCommands(harness, "thread.start", fixture.thread.id),
      ).toHaveLength(1);
    });
  });
});
