import { describe, expect, it, vi } from "vitest";
import { Buffer } from "node:buffer";
import {
  archiveThread,
  createEnvironment,
  createNativeTerminalThread,
  createProject,
  createTerminalSession,
  createThread,
  listNativeTerminalThreadsWithDisconnectedTerminal,
  noopNotifier,
  setNativeTerminalThreadTerminal,
  terminalSessions,
  upsertHost,
  SYSTEM_RELEASE_ACTOR,
} from "@bb/db";
import { eq } from "drizzle-orm";
import { terminalDataBase64Schema, TERMINAL_DATA_MAX_BYTES } from "@bb/domain";
import { createProviderRegistryService } from "../../../src/services/providers/provider-registry.js";
import {
  openNativeTerminal,
  reopenNativeTerminalsAfterDaemonReconnect,
  takeNativeTerminalLaunchSpec,
} from "../../../src/services/threads/native-terminal-threads.js";
import { acceptThreadSendRequest } from "../../../src/services/threads/thread-send-request.js";
import { createTestProviderRegistry } from "../../helpers/provider-registry.js";
import { textInput } from "../../helpers/prompt-input.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
} from "../../helpers/seed.js";
import {
  withTestHarness,
  type TestAppHarness,
} from "../../helpers/test-app.js";

async function createDisconnectedNativeThread(
  harness: TestAppHarness,
  index: number,
  hostId: string,
): Promise<{ threadId: string; terminalId: string }> {
  const { project } = createProject(harness.db, noopNotifier, {
    name: `Native Terminal Project ${index}`,
    source: {
      type: "local_path",
      hostId,
      path: `/tmp/native-terminal-${index}`,
    },
  });
  const environment = createEnvironment(harness.db, noopNotifier, {
    providerOwnsPath: false,
    hostId,
    projectId: project.id,
    path: `/tmp/native-terminal-${index}/env`,
    status: "ready",
  });
  const thread = createThread(harness.db, noopNotifier, {
    projectId: project.id,
    environmentId: environment.id,
    providerId: "codex",
  });
  createNativeTerminalThread(harness.db, {
    threadId: thread.id,
    providerId: "codex",
    nativeSessionId: `session-existing-${index}`,
    initialPrompt: null,
    initialImages: [],
    model: null,
  });
  const terminal = createTerminalSession(harness.db, {
    threadId: thread.id,
    environmentId: environment.id,
    hostId,
    daemonSessionId: null,
    title: "Codex",
    initialCwd: "/tmp",
    cols: 120,
    rows: 36,
    status: "disconnected",
  });
  setNativeTerminalThreadTerminal(harness.db, {
    threadId: thread.id,
    terminalSessionId: terminal.id,
  });
  return { threadId: thread.id, terminalId: terminal.id };
}

describe("reopenNativeTerminalsAfterDaemonReconnect", () => {
  it("sends a large public tell as ordered valid frames without closing its session", async () => {
    await withTestHarness(async (h) => {
      const seeded = seedHostSession(h.deps, { id: "host-native-large-tell" });
      const { project } = seedProjectWithSource(h.deps, {
        hostId: seeded.host.id,
        path: "/tmp/native-large-tell-project",
      });
      const environment = seedEnvironment(h.deps, {
        hostId: seeded.host.id,
        path: "/tmp/native-large-tell-workspace",
        projectId: project.id,
        status: "ready",
      });
      const thread = seedThread(h.deps, {
        environmentId: environment.id,
        projectId: project.id,
        providerId: "claude-code",
      });
      createNativeTerminalThread(h.db, {
        threadId: thread.id,
        providerId: "claude-code",
        nativeSessionId: "native-large-tell-session",
        initialPrompt: null,
        initialImages: [],
        model: null,
      });
      const terminal = createTerminalSession(h.db, {
        threadId: thread.id,
        environmentId: environment.id,
        hostId: seeded.host.id,
        daemonSessionId: seeded.session.id,
        title: "Claude Code",
        initialCwd: environment.path ?? "/tmp",
        cols: 120,
        rows: 36,
        status: "running",
      });
      setNativeTerminalThreadTerminal(h.db, {
        threadId: thread.id,
        terminalSessionId: terminal.id,
      });

      const sentMessages: unknown[] = [];
      const socket = {
        close: vi.fn(),
        send: vi.fn((data: string) => sentMessages.push(JSON.parse(data))),
      };
      h.hub.registerDaemon(seeded.session.id, seeded.host.id, socket);

      const before = {
        chunks: [],
        nextSeq: 0,
        truncated: false,
        status: "running" as const,
        exitCode: null,
        closeReason: null,
      };
      const after = {
        ...before,
        chunks: [
          {
            seq: 0,
            dataBase64: Buffer.from(
              "\r\n> [Pasted text #1 +4000 lines]",
            ).toString("base64"),
          },
        ],
        nextSeq: 1,
      };
      let outputReads = 0;
      vi.spyOn(
        h.deps.terminalSessions,
        "readTerminalOutput",
      ).mockImplementation(async () => {
        outputReads += 1;
        return outputReads > 2 ? after : before;
      });

      const bracketedPastePrefix = "\u001b[200~";
      const bracketedPastePrefixBytes = bracketedPastePrefix.length;
      const euro = "€";
      const emoji = "😀";
      const prefixText = "a".repeat(
        TERMINAL_DATA_MAX_BYTES - bracketedPastePrefixBytes - 1,
      );
      const middleText = "b".repeat(
        TERMINAL_DATA_MAX_BYTES - Buffer.byteLength(euro),
      );
      const text = `${prefixText}${euro}${middleText}${emoji}${"æ🧪😀\n".repeat(4_000)}END`;
      const euroStartByte =
        bracketedPastePrefixBytes + Buffer.byteLength(prefixText);
      const emojiStartByte =
        euroStartByte + Buffer.byteLength(euro) + Buffer.byteLength(middleText);
      const result = await acceptThreadSendRequest(h.deps, {
        thread,
        payload: { input: textInput(text), mode: "start" },
      });

      expect(result).toEqual({ ok: true, delivery: "sent" });
      expect(socket.close).not.toHaveBeenCalled();
      expect(
        h.deps.terminalSessions.getTerminal({ terminalId: terminal.id }).status,
      ).toBe("running");
      const inputFrames = sentMessages
        .filter(
          (message): message is { type: string; dataBase64: string } =>
            typeof message === "object" &&
            message !== null &&
            "type" in message &&
            message.type === "terminal.input" &&
            "dataBase64" in message &&
            typeof message.dataBase64 === "string",
        )
        .map((message) => message.dataBase64);
      expect(inputFrames.length).toBeGreaterThan(1);
      for (const frame of inputFrames) {
        expect(terminalDataBase64Schema.parse(frame)).toBe(frame);
        expect(Buffer.from(frame, "base64").byteLength).toBeLessThanOrEqual(
          TERMINAL_DATA_MAX_BYTES,
        );
      }
      expect(inputFrames.length).toBeGreaterThanOrEqual(2);
      const expected = Buffer.from(
        `${bracketedPastePrefix}${text}\u001b[201~\r`,
      );
      const decoded = inputFrames.map((frame) => Buffer.from(frame, "base64"));
      expect(Buffer.concat(decoded)).toEqual(expected);
      expect(expected.byteLength).toBeGreaterThan(120_000);
      expect(decoded.length).toBeGreaterThanOrEqual(3);
      expect(euroStartByte).toBe(TERMINAL_DATA_MAX_BYTES - 1);
      expect(emojiStartByte).toBe(TERMINAL_DATA_MAX_BYTES * 2 - 1);
      expect(decoded[0].at(-1)).toBe(0xe2);
      expect(decoded[1].subarray(0, 2)).toEqual(Buffer.from([0x82, 0xac]));
      expect(decoded[1].at(-1)).toBe(0xf0);
      expect(decoded[2].subarray(0, 3)).toEqual(
        Buffer.from([0x9f, 0x98, 0x80]),
      );
      const fatalUtf8Decoder = new TextDecoder("utf-8", { fatal: true });
      expect(() => fatalUtf8Decoder.decode(decoded[0])).toThrow();
      expect(() => fatalUtf8Decoder.decode(decoded[1])).toThrow();
      expect(fatalUtf8Decoder.decode(Buffer.concat(decoded))).toBe(
        expected.toString("utf8"),
      );
    });
  });

  it("reopens with the same CLI session when the provider registers after the settle timeout", async () => {
    await withTestHarness({ seedFirstPartyProviders: false }, async (h) => {
      const host = upsertHost(h.db, noopNotifier, {
        id: "host-native-reconnect",
        name: "Native Terminal Host",
      });
      const { threadId } = await createDisconnectedNativeThread(h, 1, host.id);
      expect(
        listNativeTerminalThreadsWithDisconnectedTerminal(h.db, host.id),
      ).toContain(threadId);
      h.db
        .update(terminalSessions)
        .set({ status: "exited", closeReason: "daemon-disconnect" })
        .where(eq(terminalSessions.threadId, threadId))
        .run();
      const sourceRegistry = await createTestProviderRegistry();
      const registration = sourceRegistry.get("codex");
      if (registration === null)
        throw new Error("Codex provider is not seeded");
      const providerRegistry = createProviderRegistryService({
        deferRegistrationsSettled: true,
      });
      h.deps.providerRegistry = providerRegistry;
      const warn = vi.spyOn(h.deps.logger, "warn");
      const createTerminal = vi
        .spyOn(h.deps.terminalSessions, "createTerminal")
        .mockImplementation(async () => {
          const terminal = createTerminalSession(h.db, {
            threadId,
            environmentId: null,
            hostId: host.id,
            daemonSessionId: null,
            title: "Codex",
            initialCwd: "/tmp",
            cols: 120,
            rows: 36,
            status: "running",
          });
          return terminal;
        });

      const reopening = reopenNativeTerminalsAfterDaemonReconnect(h.deps, {
        hostId: host.id,
        threadIds: [threadId],
      });
      await new Promise((resolve) => setTimeout(resolve, 30_100));
      expect(createTerminal).not.toHaveBeenCalled();

      providerRegistry.register(registration);
      await reopening;

      expect(warn).not.toHaveBeenCalled();
      expect(createTerminal).toHaveBeenCalledOnce();
      expect(
        takeNativeTerminalLaunchSpec(h.deps, { imagesAsArgv: true, threadId })
          .nativeSessionId,
      ).toBe("session-existing-1");
      const start = createTerminal.mock.calls[0]?.[0].payload.start;
      if (start?.mode !== "command") {
        throw new Error("Expected a command terminal launch");
      }
      expect(start.command).toContain("--reattach");
      expect(start.command).toContain("native-run");
    });
  }, 45_000);

  it("resolves no provider env for a reattach, so no pooler credential is minted for a CLI that keeps its launch env", async () => {
    await withTestHarness({ seedFirstPartyProviders: false }, async (h) => {
      const host = upsertHost(h.db, noopNotifier, {
        id: "host-native-stale",
        name: "Native Terminal Host",
      });
      const { threadId } = await createDisconnectedNativeThread(h, 4, host.id);
      h.db
        .update(terminalSessions)
        .set({ status: "exited", closeReason: "daemon-disconnect" })
        .where(eq(terminalSessions.threadId, threadId))
        .run();
      const sourceRegistry = await createTestProviderRegistry();
      const registration = sourceRegistry.get("codex");
      if (registration === null)
        throw new Error("Codex provider is not seeded");
      const providerRegistry = createProviderRegistryService();
      providerRegistry.register(registration);
      h.deps.providerRegistry = providerRegistry;
      const resolveProviderEnv = vi
        .spyOn(h.pluginService, "resolveProviderEnv")
        .mockResolvedValue({ entries: [] });
      const createTerminal = vi
        .spyOn(h.deps.terminalSessions, "createTerminal")
        .mockImplementation(async () =>
          createTerminalSession(h.db, {
            threadId,
            environmentId: null,
            hostId: host.id,
            daemonSessionId: null,
            title: "Codex",
            initialCwd: "/tmp",
            cols: 120,
            rows: 36,
            status: "running",
          }),
        );

      await reopenNativeTerminalsAfterDaemonReconnect(h.deps, {
        hostId: host.id,
        threadIds: [threadId],
      });

      expect(resolveProviderEnv).not.toHaveBeenCalled();
      expect(createTerminal).toHaveBeenCalledOnce();
      const contributed =
        createTerminal.mock.calls[0]?.[0].extraContributedEnv ?? [];
      expect(contributed.map((entry) => entry.name)).toEqual([
        "BB_NATIVE_TOOL_CREDENTIAL",
      ]);
    });
  });

  it("still resolves the native provider env when a new terminal is opened", async () => {
    await withTestHarness({ seedFirstPartyProviders: false }, async (h) => {
      const host = upsertHost(h.db, noopNotifier, {
        id: "host-native-open",
        name: "Native Terminal Host",
      });
      const { threadId } = await createDisconnectedNativeThread(h, 5, host.id);
      h.db
        .update(terminalSessions)
        .set({ status: "exited", closeReason: "user" })
        .where(eq(terminalSessions.threadId, threadId))
        .run();
      const sourceRegistry = await createTestProviderRegistry();
      const registration = sourceRegistry.get("codex");
      if (registration === null)
        throw new Error("Codex provider is not seeded");
      const providerRegistry = createProviderRegistryService();
      providerRegistry.register(registration);
      h.deps.providerRegistry = providerRegistry;
      const resolveProviderEnv = vi
        .spyOn(h.pluginService, "resolveProviderEnv")
        .mockResolvedValue({ entries: [] });
      vi.spyOn(h.deps.terminalSessions, "createTerminal").mockImplementation(
        async () =>
          createTerminalSession(h.db, {
            threadId,
            environmentId: null,
            hostId: host.id,
            daemonSessionId: null,
            title: "Codex",
            initialCwd: "/tmp",
            cols: 120,
            rows: 36,
            status: "running",
          }),
      );

      await openNativeTerminal(h.deps, { threadId, request: {} });

      expect(resolveProviderEnv).toHaveBeenCalledOnce();
      expect(resolveProviderEnv).toHaveBeenCalledWith(
        expect.objectContaining({
          context: expect.objectContaining({
            threadId,
            experimental_runtimeKind: "native",
          }),
        }),
      );
    });
  });

  it("does not reopen a terminal closed or archived while provider registration is pending", async () => {
    await withTestHarness({ seedFirstPartyProviders: false }, async (h) => {
      const host = upsertHost(h.db, noopNotifier, {
        id: "host-native-closed",
        name: "Native Terminal Host",
      });
      const closed = await createDisconnectedNativeThread(h, 2, host.id);
      const archived = await createDisconnectedNativeThread(h, 3, host.id);
      const sourceRegistry = await createTestProviderRegistry();
      const registration = sourceRegistry.get("codex");
      if (registration === null)
        throw new Error("Codex provider is not seeded");
      const providerRegistry = createProviderRegistryService({
        deferRegistrationsSettled: true,
      });
      h.deps.providerRegistry = providerRegistry;
      const createTerminal = vi.spyOn(
        h.deps.terminalSessions,
        "createTerminal",
      );
      const reconnectCandidates = [closed.threadId, archived.threadId];
      expect(
        listNativeTerminalThreadsWithDisconnectedTerminal(h.db, host.id),
      ).toEqual(reconnectCandidates);

      h.db
        .update(terminalSessions)
        .set({ status: "exited", closeReason: "daemon-disconnect" })
        .where(eq(terminalSessions.id, closed.terminalId))
        .run();
      await h.deps.terminalSessions.closeTerminal({
        terminalId: closed.terminalId,
        payload: { mode: "force", reason: "user" },
      });
      expect(
        h.db
          .select({ closeReason: terminalSessions.closeReason })
          .from(terminalSessions)
          .where(eq(terminalSessions.id, closed.terminalId))
          .get()?.closeReason,
      ).toBe("user");
      archiveThread(
        h.db,
        noopNotifier,
        archived.threadId,
        SYSTEM_RELEASE_ACTOR,
      );

      const reopening = reopenNativeTerminalsAfterDaemonReconnect(h.deps, {
        hostId: host.id,
        threadIds: reconnectCandidates,
      });
      await Promise.resolve();
      providerRegistry.register(registration);
      await reopening;

      expect(createTerminal).not.toHaveBeenCalled();
    });
  });
});
