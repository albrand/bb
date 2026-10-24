import { createHash } from "node:crypto";
import {
  createTerminalSession,
  getNativeTerminalThread,
  getThread,
  setNativeTerminalThreadTerminal,
  setNativeTerminalToolCredential,
  updateThread,
} from "@bb/db";
import { threadResponseSchema } from "@bb/server-contract";
import { describe, expect, it, vi } from "vitest";
import { registerFakeAiService } from "../helpers/ai-services.js";
import { readJson } from "../helpers/json.js";
import { textInput } from "../helpers/prompt-input.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
} from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

const INITIAL_PROMPT = "Fix the native terminal thread title generation";
const GENERATED_TITLE = "Fix native thread titles";

async function withTitleFixture(
  run: (fixture: {
    harness: TestAppHarness;
    complete: ReturnType<typeof vi.fn<(prompt: string) => Promise<string>>>;
    create: (args: {
      providerId: string;
      prompt?: string;
      title?: string;
    }) => Promise<string>;
    activity: (threadId: string, prompt: string) => Promise<void>;
  }) => Promise<void>,
): Promise<void> {
  await withTestHarness(async (harness) => {
    const complete = vi.fn<(prompt: string) => Promise<string>>();
    complete.mockResolvedValue(GENERATED_TITLE);
    registerFakeAiService(harness.deps.aiServices, {
      id: "codex",
      pluginId: "provider-codex",
      builtin: true,
      complete,
    });
    const { host, session } = seedHostSession(harness.deps);
    const { project } = seedProjectWithSource(harness.deps, {
      hostId: host.id,
    });
    const environment = seedEnvironment(harness.deps, {
      hostId: host.id,
      projectId: project.id,
      status: "ready",
    });
    const openTerminal = vi
      .spyOn(harness.deps.terminalSessions, "createTerminal")
      .mockRejectedValue(new Error("The CLI never boots"));
    try {
      await run({
        harness,
        complete,
        async create(args) {
          const response = await harness.app.request("/api/v1/threads", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              origin: "cli",
              projectId: project.id,
              providerId: args.providerId,
              ...(args.title === undefined ? {} : { title: args.title }),
              input: args.prompt === undefined ? [] : textInput(args.prompt),
              environment: { type: "reuse", environmentId: environment.id },
              nativeTerminal: true,
            }),
          });
          expect(response.status).toBe(201);
          const thread = threadResponseSchema.parse(await readJson(response));
          await vi.waitFor(() => {
            expect(openTerminal).toHaveBeenCalled();
          });
          expect(getNativeTerminalThread(harness.db, thread.id)).toMatchObject({
            initialPrompt: args.prompt ?? null,
            terminalSessionId: null,
          });
          return thread.id;
        },
        async activity(threadId, prompt) {
          const credential = "synthetic-title-test-credential";
          const terminal = createTerminalSession(harness.db, {
            cols: 80,
            daemonSessionId: session.id,
            environmentId: environment.id,
            hostId: host.id,
            initialCwd: "/tmp/native-title",
            rows: 24,
            status: "running",
            threadId,
            title: "Claude Code",
          });
          setNativeTerminalThreadTerminal(harness.db, {
            terminalSessionId: terminal.id,
            threadId,
          });
          setNativeTerminalToolCredential(harness.db, {
            credentialHash: createHash("sha256")
              .update(credential)
              .digest("hex"),
            terminalSessionId: terminal.id,
            threadId,
          });
          const response = await harness.app.request(
            `/api/v1/threads/${threadId}/native-terminal/activity`,
            {
              method: "POST",
              headers: {
                authorization: `Bearer ${credential}`,
                "content-type": "application/json",
              },
              body: JSON.stringify({ state: "working", prompt }),
            },
          );
          expect(response.status).toBe(200);
        },
      });
    } finally {
      openTerminal.mockRestore();
    }
  });
}

describe("native terminal thread titles", () => {
  it.each(["claude-code", "codex"])(
    "titles a %s thread from its creation prompt without CLI activity",
    async (providerId) => {
      await withTitleFixture(async ({ harness, complete, create }) => {
        const threadId = await create({ providerId, prompt: INITIAL_PROMPT });
        await vi.waitFor(() => {
          expect(getThread(harness.db, threadId)?.title).toBe(GENERATED_TITLE);
        });
        expect(complete).toHaveBeenCalledOnce();
        expect(complete.mock.calls[0]?.[0]).toContain(INITIAL_PROMPT);
      });
    },
  );

  it("preserves an explicit title during creation and later activity", async () => {
    await withTitleFixture(async ({ harness, complete, create, activity }) => {
      const threadId = await create({
        providerId: "codex",
        prompt: INITIAL_PROMPT,
        title: "My chosen title",
      });
      await activity(threadId, INITIAL_PROMPT);
      expect(getThread(harness.db, threadId)?.title).toBe("My chosen title");
      expect(complete).not.toHaveBeenCalled();
    });
  });

  it("titles a promptless thread once from its first activity prompt", async () => {
    await withTitleFixture(async ({ harness, complete, create, activity }) => {
      const threadId = await create({ providerId: "claude-code" });
      expect(getThread(harness.db, threadId)?.title).toBeNull();
      expect(complete).not.toHaveBeenCalled();
      await activity(threadId, INITIAL_PROMPT);
      await vi.waitFor(() => {
        expect(getThread(harness.db, threadId)?.title).toBe(GENERATED_TITLE);
      });
      await activity(
        threadId,
        "A different prompt that should never retitle this",
      );
      expect(complete).toHaveBeenCalledOnce();
      expect(complete.mock.calls[0]?.[0]).toContain(INITIAL_PROMPT);
    });
  });

  it("does not generate again after a creation-time title", async () => {
    await withTitleFixture(async ({ harness, complete, create, activity }) => {
      const threadId = await create({
        providerId: "codex",
        prompt: INITIAL_PROMPT,
      });
      await vi.waitFor(() => {
        expect(getThread(harness.db, threadId)?.title).toBe(GENERATED_TITLE);
      });
      await activity(
        threadId,
        "A different prompt that should never retitle this",
      );
      expect(getThread(harness.db, threadId)?.title).toBe(GENERATED_TITLE);
      expect(complete).toHaveBeenCalledOnce();
    });
  });

  it("shares pending creation inference with simultaneous activity", async () => {
    await withTitleFixture(async ({ harness, complete, create, activity }) => {
      let resolveTitle!: (title: string) => void;
      complete.mockReturnValue(
        new Promise<string>((resolve) => {
          resolveTitle = resolve;
        }),
      );
      const threadId = await create({
        providerId: "claude-code",
        prompt: INITIAL_PROMPT,
      });
      try {
        expect(complete).toHaveBeenCalledOnce();
        await activity(threadId, INITIAL_PROMPT);
        await activity(threadId, INITIAL_PROMPT);
        expect(complete).toHaveBeenCalledOnce();
        expect(getThread(harness.db, threadId)?.title).toBeNull();
      } finally {
        resolveTitle(GENERATED_TITLE);
      }
      await vi.waitFor(() => {
        expect(getThread(harness.db, threadId)?.title).toBe(GENERATED_TITLE);
      });
    });
  });

  it("preserves a title edited while creation inference is pending", async () => {
    await withTitleFixture(async ({ harness, complete, create }) => {
      let resolveTitle!: (title: string) => void;
      complete.mockReturnValue(
        new Promise<string>((resolve) => {
          resolveTitle = resolve;
        }),
      );
      const threadId = await create({
        providerId: "codex",
        prompt: INITIAL_PROMPT,
      });
      updateThread(harness.db, harness.hub, threadId, {
        title: "Edited title",
      });
      resolveTitle(GENERATED_TITLE);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(complete).toHaveBeenCalledOnce();
      expect(getThread(harness.db, threadId)?.title).toBe("Edited title");
    });
  });
});
