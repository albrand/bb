import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  archiveThread,
  createConnection,
  createNativeTerminalThread,
  createTerminalSession,
  getNativeTerminalThread,
  getRetainedTerminalOutput,
  getTerminalSession,
  getThread,
  listNativeTerminalThreadsWithDisconnectedTerminal,
  listEvents,
  migrate,
  noopNotifier,
  projectAttachmentThreads,
  queuedThreadMessages,
  setNativeTerminalThreadTerminal,
  setQueuedThreadMessageFailureReason,
  terminalSessions,
  threads,
  unarchiveThread,
  upsertProjectExecutionDefaults,
  type DbConnection,
} from "@bb/db";
import { createMigratedConnection } from "@bb/db/testing";
import { eq } from "drizzle-orm";
import type { PromptInput } from "@bb/domain";
import {
  HOST_DAEMON_PROTOCOL_VERSION,
  hostDaemonServerWsMessageSchema,
  type HostDaemonServerWsMessage,
} from "@bb/host-daemon-contract";
import {
  apiErrorSchema,
  nativeTerminalLaunchSpecSchema,
  nativeTerminalThreadSchema,
  terminalOutputResponseSchema,
  threadResponseSchema,
} from "@bb/server-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import { queueParentSystemMessage } from "../../src/services/threads/parent-system-messages.js";
import { sendThreadMessage } from "../../src/services/threads/thread-send.js";
import {
  NATIVE_TERMINAL_ENDED_MESSAGE,
  NATIVE_TOOL_CREDENTIAL_ENV,
  nativeTerminalLaunchCommand,
  reopenNativeTerminalsAfterDaemonReconnect,
  resumeNativeTerminalAfterUnarchive,
} from "../../src/services/threads/native-terminal-threads.js";
import { handleDaemonSocketClosed } from "../../src/internal/session-owner-side-effects.js";
import { applyLoggedThreadLifecycleEvent } from "../../src/services/threads/lifecycle-outcome.js";
import { internalAuthHeaders } from "../helpers/commands.js";
import { createProviderRegistryService } from "../../src/services/providers/provider-registry.js";
import { createTestProviderRegistry } from "../helpers/provider-registry.js";
import { recordNativeTerminalActivity } from "../../src/services/threads/native-terminal-activity.js";
import { ApiError } from "../../src/errors.js";
import { onDaemonSocketOpen } from "../../src/ws/daemon-protocol.js";
import { resolvePendingThreadSessionOptions } from "../../src/services/threads/thread-session-options.js";
import { storeAttachment } from "../../src/services/projects/attachments.js";
import { readJson } from "../helpers/json.js";
import { textInput } from "../helpers/prompt-input.js";
import {
  seedEnvironment,
  seedHostSession,
  seedPrimaryHost,
  seedProjectWithSource,
  seedQueuedMessage,
  seedSession,
  seedThread,
} from "../helpers/seed.js";
import {
  createTestAppHarness,
  type TestAppHarness,
} from "../helpers/test-app.js";

interface FakeDaemonSocket {
  close(code?: number, reason?: string): void;
  send(data: string): void;
  sentMessages: string[];
}

type TerminalOpenMessage = Extract<
  HostDaemonServerWsMessage,
  { type: "terminal.open" }
>;

interface Fixture {
  environment: ReturnType<typeof seedEnvironment>;
  harness: TestAppHarness;
  hostId: string;
  projectId: string;
  sessionId: string;
  socket: FakeDaemonSocket;
}

const harnesses: TestAppHarness[] = [];
const explicitlyMigratedDbs: DbConnection[] = [];

afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.cleanup();
  for (const db of explicitlyMigratedDbs.splice(0)) db.$client.close();
});

function createFakeDaemonSocket(): FakeDaemonSocket {
  const sentMessages: string[] = [];
  return {
    close: vi.fn(),
    send: vi.fn((data: string) => {
      sentMessages.push(data);
    }),
    sentMessages,
  };
}

function daemonMessages(socket: FakeDaemonSocket): HostDaemonServerWsMessage[] {
  return socket.sentMessages.map((message) =>
    hostDaemonServerWsMessageSchema.parse(JSON.parse(message)),
  );
}

async function waitForTerminalOpen(
  socket: FakeDaemonSocket,
  skip = 0,
): Promise<TerminalOpenMessage> {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const opens = daemonMessages(socket).filter(
      (message): message is TerminalOpenMessage =>
        message.type === "terminal.open",
    );
    const open = opens[skip];
    if (open !== undefined) return open;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for terminal.open");
}

async function createFixture(db?: DbConnection): Promise<Fixture> {
  const harness = await createTestAppHarness(db === undefined ? {} : { db });
  harnesses.push(harness);
  const seeded = seedHostSession(harness.deps, { id: "native-host" });
  const { project } = seedProjectWithSource(harness.deps, {
    hostId: seeded.host.id,
    path: "/tmp/native-project",
  });
  const environment = seedEnvironment(harness.deps, {
    hostId: seeded.host.id,
    path: "/tmp/native-workspace",
    projectId: project.id,
    status: "ready",
  });
  const socket = createFakeDaemonSocket();
  harness.hub.registerDaemon(seeded.session.id, seeded.host.id, socket);
  return {
    environment,
    harness,
    hostId: seeded.host.id,
    projectId: project.id,
    sessionId: seeded.session.id,
    socket,
  };
}

async function createMigratedMemoryFixture(): Promise<Fixture> {
  const db = createMigratedConnection();
  explicitlyMigratedDbs.push(db);
  return createFixture(db);
}

async function postJson(
  fixture: Fixture,
  path: string,
  body: unknown,
  authorization?: string,
): Promise<Response> {
  return fixture.harness.app.request(`/api/v1${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(authorization === undefined ? {} : { authorization }),
    },
    body: JSON.stringify(body),
  });
}

async function createNativeThread(
  fixture: Fixture,
  args: {
    providerId: string;
    prompt?: string;
    input?: PromptInput[];
    model?: string;
    modelSource?: "explicit" | "client-preference";
  },
) {
  const response = await postNativeThread(fixture, args);
  expect(response.status).toBe(201);
  return threadResponseSchema.parse(await readJson(response));
}

async function storeImageAttachment(fixture: Fixture): Promise<string> {
  const attachment = await storeAttachment(
    fixture.harness.db,
    fixture.harness.deps.config.dataDir,
    fixture.projectId,
    new File(["png"], "shot.png", { type: "image/png" }),
  );
  return attachment.path;
}

function storedAttachmentPath(fixture: Fixture, attachmentPath: string) {
  return path.join(
    fixture.harness.deps.config.dataDir,
    "attachments",
    fixture.projectId,
    attachmentPath,
  );
}

async function postNativeThread(
  fixture: Fixture,
  args: {
    providerId: string;
    prompt?: string;
    input?: PromptInput[];
    model?: string;
    modelSource?: "explicit" | "client-preference";
  },
): Promise<Response> {
  return postJson(fixture, "/threads", {
    projectId: fixture.projectId,
    providerId: args.providerId,
    ...(args.model === undefined ? {} : { model: args.model }),
    ...(args.modelSource === undefined
      ? {}
      : {
          executionInputSources: {
            providerId: "explicit",
            model: args.modelSource,
          },
        }),
    origin: "cli",
    input:
      args.input ?? (args.prompt === undefined ? [] : textInput(args.prompt)),
    environment: { type: "reuse", environmentId: fixture.environment.id },
    nativeTerminal: true,
  });
}

function acknowledgeOpen(fixture: Fixture, open: TerminalOpenMessage): void {
  fixture.harness.deps.terminalSessions.handleDaemonTerminalMessage({
    hostId: fixture.hostId,
    sessionId: fixture.sessionId,
    message: {
      type: "terminal.opened",
      requestId: open.requestId,
      terminalId: open.terminalId,
      shell: "/bin/zsh",
      title: "zsh",
      initialCwd: "/tmp/native-workspace",
      cols: open.cols,
      rows: open.rows,
    },
  });
}

async function waitForThreadStatus(
  fixture: Fixture,
  threadId: string,
  status: string,
): Promise<void> {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    if (getThread(fixture.harness.db, threadId)?.status === status) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Thread ${threadId} never reached ${status}`);
}

async function openRunningNativeThread(
  fixture: Fixture,
  args: { providerId: string; prompt?: string; input?: PromptInput[] },
) {
  const thread = await createNativeThread(fixture, args);
  const open = await waitForTerminalOpen(fixture.socket);
  acknowledgeOpen(fixture, open);
  await waitForThreadStatus(fixture, thread.id, "idle");
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const record = getNativeTerminalThread(fixture.harness.db, thread.id);
    if (record?.terminalSessionId === open.terminalId) break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return { open, thread };
}

type FakeCliScreen = (pasted: string) => string | null;

interface FakeCli {
  inputs(): string[];
  stop(): void;
}

function startFakeCli(
  fixture: Fixture,
  terminalId: string,
  screen: FakeCliScreen,
  redraw: string | null = null,
): FakeCli {
  const output: { seq: number; dataBase64: string }[] = [];
  let nextSeq = 7;
  let handled = 0;
  const draw = (text: string) => {
    output.push({
      seq: nextSeq,
      dataBase64: Buffer.from(text, "utf8").toString("base64"),
    });
    nextSeq += 1;
  };
  if (redraw !== null) draw(redraw);
  const timer = setInterval(() => {
    const messages = daemonMessages(fixture.socket);
    for (const message of messages.slice(handled)) {
      if (message.type === "terminal.input") {
        if (message.terminalId !== terminalId) continue;
        const text = Buffer.from(message.dataBase64, "base64").toString("utf8");
        const pasted = /^\u001b\[200~([\s\S]*)\u001b\[201~$/u.exec(text);
        const drawn = pasted === null ? null : screen(pasted[1] ?? "");
        if (drawn !== null) draw(drawn);
      }
      if (message.type === "terminal.attach") {
        if (message.terminalId !== terminalId) continue;
        if (redraw !== null) draw(redraw);
        fixture.harness.deps.terminalSessions.handleDaemonTerminalMessage({
          hostId: fixture.hostId,
          sessionId: fixture.sessionId,
          message: {
            type: "terminal.replay",
            requestId: message.requestId,
            terminalId,
            chunks: output.filter((chunk) => chunk.seq >= message.sinceSeq),
            replayStartSeq: message.sinceSeq,
            nextSeq,
          },
        });
      }
    }
    handled = messages.length;
  }, 5);
  return {
    inputs: () =>
      daemonMessages(fixture.socket).flatMap((message) =>
        message.type === "terminal.input" && message.terminalId === terminalId
          ? [Buffer.from(message.dataBase64, "base64").toString("utf8")]
          : [],
      ),
    stop: () => clearInterval(timer),
  };
}

function scrolledPastScreen(line: string): string {
  return `${line}\r\n${"• Ran a step\r\n".repeat(120)}› `;
}

function composerScreen(pasted: string): string {
  const words = pasted.split(" ");
  return `\u001b[2K\u001b[1G\u203a ${words.join("\u001b[1C")}\u001b[0m`;
}

describe("native terminal threads", () => {
  it("adopts a holder-backed shell after the server reloads its database", async () => {
    const fixture = await createFixture();
    const creating = postJson(fixture, "/terminals", {
      cols: 80,
      rows: 24,
      target: {
        kind: "environment",
        environmentId: fixture.environment.id,
      },
    });
    const open = await waitForTerminalOpen(fixture.socket);
    fixture.harness.deps.terminalSessions.handleDaemonTerminalMessage({
      hostId: fixture.hostId,
      sessionId: fixture.sessionId,
      message: {
        type: "terminal.opened",
        requestId: open.requestId,
        terminalId: open.terminalId,
        shell: "/bin/zsh",
        title: "zsh",
        initialCwd: "/tmp/native-workspace",
        cols: open.cols,
        rows: open.rows,
      },
    });
    expect((await creating).status).toBe(201);
    fixture.harness.deps.terminalSessions.handleDaemonTerminalMessage({
      hostId: fixture.hostId,
      sessionId: fixture.sessionId,
      message: {
        type: "terminal.output",
        terminalId: open.terminalId,
        chunk: {
          seq: 0,
          dataBase64: Buffer.from(
            `\u001b]7717;bb-holder;${open.terminalId}\u0007BEFORE:42424\n`,
          ).toString("base64"),
        },
      },
    });
    fixture.harness.deps.terminalSessions.flushAllRetainedOutput();
    handleDaemonSocketClosed(fixture.harness.deps, {
      sessionId: fixture.sessionId,
    });

    const reloadedDb = createConnection(fixture.harness.db.$client.serialize());
    migrate(reloadedDb);
    explicitlyMigratedDbs.push(reloadedDb);
    const restartedHarness = await createTestAppHarness({ db: reloadedDb });
    harnesses.push(restartedHarness);
    const openedSession = await restartedHarness.app.request(
      "/internal/session/open",
      {
        method: "POST",
        headers: internalAuthHeaders(restartedHarness, {
          hostId: fixture.hostId,
        }),
        body: JSON.stringify({
          hostId: fixture.hostId,
          instanceId: "instance-1",
          hostName: "Test Host",
          hasMachineCredential: false,
          platform: "darwin",
          dataDir: "/tmp/server-restarted",
          localApiPort: null,
          protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
          activeThreads: [],
          undeliveredEventThreadIds: [],
        }),
      },
    );
    expect(openedSession.status).toBe(201);
    const { sessionId } = (await readJson(openedSession)) as {
      sessionId: string;
    };
    const socket = createFakeDaemonSocket();
    await onDaemonSocketOpen(restartedHarness.deps, {
      hostId: fixture.hostId,
      sessionId,
      socket,
    });

    expect(
      daemonMessages(socket).filter(
        (message) => message.type === "terminal.open",
      ),
    ).toEqual([]);
    expect(
      getTerminalSession(reloadedDb, {
        kind: "terminal",
        terminalId: open.terminalId,
      }),
    ).toMatchObject({
      daemonSessionId: sessionId,
      holderBacked: true,
      status: "running",
    });
    const retained = getRetainedTerminalOutput(reloadedDb, {
      hostId: fixture.hostId,
      terminalSessionId: open.terminalId,
      now: Date.now(),
    });
    expect(retained).not.toBeNull();
    expect(
      Buffer.concat(
        (retained ?? []).map((chunk) =>
          Buffer.from(chunk.dataBase64, "base64"),
        ),
      ).toString("utf8"),
    ).toBe("BEFORE:42424\n");
  });

  it("applies a reconnecting client's size after a native terminal reopens", async () => {
    const fixture = await createMigratedMemoryFixture();
    const { open, thread } = await openRunningNativeThread(fixture, {
      providerId: "claude-code",
    });
    fixture.harness.db
      .update(terminalSessions)
      .set({ closeReason: "daemon-disconnect", status: "disconnected" })
      .where(eq(terminalSessions.id, open.terminalId))
      .run();

    const restarted = await createTestAppHarness({ db: fixture.harness.db });
    harnesses.push(restarted);
    const daemonSocket = createFakeDaemonSocket();
    restarted.hub.registerDaemon(
      fixture.sessionId,
      fixture.hostId,
      daemonSocket,
    );
    const browserSocket = { close() {}, send() {} };
    restarted.deps.terminalSessions.attachBrowserTerminal({
      outputAcks: false,
      resizeAcks: false,
      socket: browserSocket,
      sinceSeq: 0,
      terminalId: open.terminalId,
    });
    restarted.deps.terminalSessions.handleBrowserTerminalMessage({
      terminalId: open.terminalId,
      socket: browserSocket,
      message: { type: "visibility", visible: true },
    });
    restarted.deps.terminalSessions.handleBrowserTerminalMessage({
      terminalId: open.terminalId,
      socket: browserSocket,
      message: { type: "resize", cols: 52, rows: 41 },
    });

    expect(
      getTerminalSession(restarted.db, {
        kind: "terminal",
        terminalId: open.terminalId,
      }),
    ).toMatchObject({ cols: 120, rows: 36, status: "disconnected" });

    const reopening = reopenNativeTerminalsAfterDaemonReconnect(
      restarted.deps,
      { hostId: fixture.hostId, threadIds: [thread.id] },
    );
    const reopen = await waitForTerminalOpen(daemonSocket);
    expect(reopen).toMatchObject({ cols: 52, rows: 41 });
    acknowledgeOpen(
      { ...fixture, harness: restarted, socket: daemonSocket },
      reopen,
    );
    await reopening;

    const reopenedTerminalId = getNativeTerminalThread(
      restarted.db,
      thread.id,
    )?.terminalSessionId;
    expect(reopenedTerminalId).toBe(reopen.terminalId);
    expect(
      getTerminalSession(restarted.db, {
        kind: "terminal",
        terminalId: reopen.terminalId,
      }),
    ).toMatchObject({ cols: 52, rows: 41, status: "running" });
    expect(
      daemonMessages(daemonSocket).filter(
        (message) =>
          message.type === "terminal.resize" &&
          message.terminalId === reopen.terminalId,
      ),
    ).toEqual([]);

    const attachedSocket = {
      close() {},
      send() {},
    };
    const originalSetTimeout = globalThis.setTimeout;
    const scheduledRepaints: { delay: number; run: () => void }[] = [];
    const timeoutSpy = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementation((callback, delay, ...args) => {
        if (delay === 0 || delay === 1_500) {
          scheduledRepaints.push({
            delay,
            run: () => callback(...args),
          });
          return { unref() {} } as ReturnType<typeof setTimeout>;
        }
        return originalSetTimeout(callback, delay, ...args);
      });
    try {
      restarted.deps.terminalSessions.attachBrowserTerminal({
        outputAcks: false,
        resizeAcks: false,
        socket: attachedSocket,
        sinceSeq: 0,
        terminalId: reopen.terminalId,
      });
      const attach = daemonMessages(daemonSocket).find(
        (message) =>
          message.type === "terminal.attach" &&
          message.terminalId === reopen.terminalId,
      );
      if (attach?.type !== "terminal.attach") {
        throw new Error(
          "Expected terminal.attach after browser client connects",
        );
      }
      await restarted.deps.terminalSessions.handleDaemonTerminalMessage({
        hostId: fixture.hostId,
        sessionId: fixture.sessionId,
        message: {
          type: "terminal.replay",
          requestId: attach.requestId,
          terminalId: reopen.terminalId,
          chunks: [],
          replayStartSeq: 0,
          nextSeq: 0,
        },
      });
      expect(
        daemonMessages(daemonSocket).filter(
          (message) =>
            message.type === "terminal.resize" &&
            message.terminalId === reopen.terminalId,
        ),
      ).toEqual([]);

      expect(scheduledRepaints.map(({ delay }) => delay)).toEqual([1_500]);
      expect(
        daemonMessages(daemonSocket).filter(
          (message) =>
            message.type === "terminal.resize" &&
            message.terminalId === reopen.terminalId,
        ),
      ).toEqual([]);

      const repaint = scheduledRepaints[0];
      if (!repaint) throw new Error("Expected one delayed terminal repaint");
      repaint.run();
      expect(
        daemonMessages(daemonSocket).filter(
          (message) =>
            message.type === "terminal.resize" &&
            message.terminalId === reopen.terminalId,
        ),
      ).toEqual([
        {
          type: "terminal.resize",
          terminalId: reopen.terminalId,
          cols: 52,
          rows: 40,
        },
        {
          type: "terminal.resize",
          terminalId: reopen.terminalId,
          cols: 52,
          rows: 41,
        },
      ]);
    } finally {
      timeoutSpy.mockRestore();
    }

    restarted.deps.terminalSessions.attachBrowserTerminal({
      outputAcks: false,
      resizeAcks: false,
      socket: attachedSocket,
      sinceSeq: 0,
      terminalId: reopen.terminalId,
    });
    const secondAttach = daemonMessages(daemonSocket).filter(
      (message) =>
        message.type === "terminal.attach" &&
        message.terminalId === reopen.terminalId,
    )[1];
    if (secondAttach?.type !== "terminal.attach") {
      throw new Error(
        "Expected second terminal.attach after browser reconnect",
      );
    }
    restarted.deps.terminalSessions.handleDaemonTerminalMessage({
      hostId: fixture.hostId,
      sessionId: fixture.sessionId,
      message: {
        type: "terminal.replay",
        requestId: secondAttach.requestId,
        terminalId: reopen.terminalId,
        chunks: [],
        replayStartSeq: 0,
        nextSeq: 0,
      },
    });
    expect(
      daemonMessages(daemonSocket).filter(
        (message) =>
          message.type === "terminal.resize" &&
          message.terminalId === reopen.terminalId,
      ),
    ).toHaveLength(2);
    restarted.db
      .update(terminalSessions)
      .set({ closeReason: "user", status: "exited" })
      .where(eq(terminalSessions.id, reopen.terminalId))
      .run();
    await new Promise((resolve) => setTimeout(resolve, 300));
  });

  it("runs the bb wrapper when BB_CLI supports it and the bare harness otherwise", async () => {
    const fixture = await createFixture();
    const { open, thread } = await openRunningNativeThread(fixture, {
      providerId: "claude-code",
      prompt: "Probe the wrapper",
    });
    if (open.start.mode !== "command") throw new Error("expected command");
    const command = open.start.command;
    const dir = mkdtempSync(path.join(os.tmpdir(), "bb-native-shell-"));
    try {
      const script = (name: string, body: string): string => {
        const file = path.join(dir, name);
        writeFileSync(file, `#!/bin/sh\n${body}\n`);
        chmodSync(file, 0o755);
        return file;
      };
      script("claude", 'echo "bare $BB_THREAD_ID $*"');
      const supporting = script(
        "bb-new",
        `case "$*" in "thread native-run ${thread.id} --probe") exit 0;; *--probe*) exit 1;; esac\necho "wrapper $BB_THREAD_ID $*"`,
      );
      const legacy = script(
        "bb-old",
        "echo \"error: unknown command 'native-run'\" >&2; exit 1",
      );
      const run = (bbCli: string | null): string =>
        execFileSync("/bin/sh", ["-c", command], {
          encoding: "utf8",
          env: {
            PATH: `${dir}:/usr/bin:/bin`,
            ...(bbCli === null ? {} : { BB_CLI: bbCli }),
          },
        }).trim();

      expect(run(supporting)).toBe(
        `wrapper ${thread.id} thread native-run ${thread.id}`,
      );
      expect(run(legacy)).toBe(
        `bare ${thread.id} --dangerously-skip-permissions`,
      );
      expect(run(null)).toBe(
        `bare ${thread.id} --dangerously-skip-permissions`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("passes each launch argument intact to the bare harness fallback", () => {
    const command = nativeTerminalLaunchCommand({
      executable: "codex",
      launchArgs: [
        "--no-daemon",
        "--dangerously-bypass-approvals-and-sandbox",
        "--no-alt-screen",
        "it's $HOME",
      ],
      reattachOnly: false,
      threadId: "thr_fallback",
    });
    const dir = mkdtempSync(path.join(os.tmpdir(), "bb-native-fallback-"));
    try {
      const file = path.join(dir, "codex");
      writeFileSync(file, '#!/bin/sh\nprintf "%s\\n" "$@"\n');
      chmodSync(file, 0o755);
      expect(
        execFileSync("/bin/sh", ["-c", command], {
          encoding: "utf8",
          env: { PATH: `${dir}:/usr/bin:/bin` },
        }).split("\n"),
      ).toEqual([
        "--no-daemon",
        "--dangerously-bypass-approvals-and-sandbox",
        "--no-alt-screen",
        "it's $HOME",
        "",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("never starts the provider CLI from a reconnect reopen unless bb can reattach", () => {
    const threadId = "thr_reattach";
    const command = nativeTerminalLaunchCommand({
      executable: "claude",
      launchArgs: ["--dangerously-skip-permissions"],
      reattachOnly: true,
      threadId,
    });
    const dir = mkdtempSync(path.join(os.tmpdir(), "bb-native-reattach-"));
    try {
      const script = (name: string, body: string): string => {
        const file = path.join(dir, name);
        writeFileSync(file, `#!/bin/sh\n${body}\n`);
        chmodSync(file, 0o755);
        return file;
      };
      script("claude", 'echo "bare $*"');
      const holderAware = script(
        "bb-new",
        `case "$*" in "thread native-run ${threadId} --reattach --probe") exit 0;; *--probe*) exit 1;; esac\necho "wrapper $BB_THREAD_ID $*"`,
      );
      const beforeHolder = script(
        "bb-before-holder",
        `case "$*" in "thread native-run ${threadId} --probe") exit 0;; *--reattach*) echo "error: unknown option '--reattach'" >&2; exit 1;; esac\necho "relaunched $*"`,
      );
      const run = (bbCli: string | null): string =>
        execFileSync("/bin/sh", ["-c", command], {
          encoding: "utf8",
          env: {
            PATH: `${dir}:/usr/bin:/bin`,
            ...(bbCli === null ? {} : { BB_CLI: bbCli }),
          },
        }).trim();

      expect(run(holderAware)).toBe(
        `wrapper ${threadId} thread native-run ${threadId} --reattach`,
      );
      for (const bbCli of [beforeHolder, null]) {
        const output = run(bbCli);
        expect(output).toBe(NATIVE_TERMINAL_ENDED_MESSAGE);
        expect(output).not.toMatch(/bare|relaunched/u);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("provisions without a provider turn and opens the harness in a thread terminal", async () => {
    const fixture = await createFixture();
    const { open, thread } = await openRunningNativeThread(fixture, {
      providerId: "claude-code",
      prompt: "Fix the flaky test",
    });

    expect(open.threadId).toBe(thread.id);
    expect(open.start).toEqual({
      mode: "command",
      command: expect.stringContaining(
        `"$BB_CLI" thread native-run ${thread.id}`,
      ),
    });
    expect(open.start.mode === "command" && open.start.command).toContain(
      `BB_THREAD_ID=${thread.id}`,
    );
    const types = listEvents(fixture.harness.db, { threadId: thread.id }).map(
      (event) => event.type,
    );
    expect(types).not.toContain("client/turn/requested");
    expect(types).not.toContain("client/thread/start");

    const record = getNativeTerminalThread(fixture.harness.db, thread.id);
    expect(record?.providerId).toBe("claude-code");
    expect(record?.nativeSessionId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(record?.terminalSessionId).toBe(open.terminalId);

    const view = nativeTerminalThreadSchema.parse(
      await readJson(
        await fixture.harness.app.request(
          `/api/v1/threads/${thread.id}/native-terminal`,
        ),
      ),
    );
    expect(view.terminal?.id).toBe(open.terminalId);
    expect(view.terminal?.status).toBe("running");
  });

  it("resumes the same native session when an archived thread is unarchived", async () => {
    const fixture = await createFixture();
    const thread = seedThread(fixture.harness.deps, {
      projectId: fixture.projectId,
      environmentId: fixture.environment.id,
      providerId: "claude-code",
      status: "active",
    });
    const sessionId = "11111111-2222-3333-4444-555555555555";
    const terminal = createTerminalSession(fixture.harness.db, {
      cols: 80,
      daemonSessionId: null,
      environmentId: fixture.environment.id,
      hostId: fixture.hostId,
      initialCwd: "/tmp/native-workspace",
      rows: 24,
      status: "running",
      threadId: thread.id,
      title: "Claude Code",
    });
    createNativeTerminalThread(fixture.harness.db, {
      threadId: thread.id,
      providerId: "claude-code",
      nativeSessionId: sessionId,
      initialPrompt: null,
      initialImages: [],
      model: null,
    });
    setNativeTerminalThreadTerminal(fixture.harness.db, {
      threadId: thread.id,
      terminalSessionId: terminal.id,
    });

    fixture.harness.hub.unregisterDaemon(fixture.sessionId);
    const archive = await postJson(
      fixture,
      `/threads/${thread.id}/archive-all`,
      {},
    );
    expect(archive.status).toBe(200);
    expect(
      getTerminalSession(fixture.harness.db, {
        kind: "terminal",
        terminalId: terminal.id,
      }),
    ).toMatchObject({ status: "exited", closeReason: "thread-archived" });

    fixture.harness.hub.registerDaemon(
      fixture.sessionId,
      fixture.hostId,
      fixture.socket,
    );
    const unarchive = await postJson(
      fixture,
      `/threads/${thread.id}/unarchive`,
      {},
    );
    expect(unarchive.status).toBe(200);

    const reopen = await waitForTerminalOpen(fixture.socket);
    expect(reopen.threadId).toBe(thread.id);
    expect(reopen.start).toMatchObject({
      mode: "command",
      command: expect.not.stringContaining("--reattach"),
    });
    acknowledgeOpen(fixture, reopen);
    await expect
      .poll(() => getNativeTerminalThread(fixture.harness.db, thread.id))
      .toMatchObject({
        nativeSessionId: sessionId,
        terminalSessionId: reopen.terminalId,
      });
    const launch = nativeTerminalLaunchSpecSchema.parse(
      await readJson(
        await postJson(
          fixture,
          `/threads/${thread.id}/native-terminal/launch`,
          {},
        ),
      ),
    );
    expect(launch.nativeSessionId).toBe(sessionId);
  });

  it("does not attempt reconnect reattachment while the native thread is still archived", async () => {
    const fixture = await createMigratedMemoryFixture();
    const { thread } = await openRunningNativeThread(fixture, {
      providerId: "claude-code",
    });
    const terminalId = getNativeTerminalThread(
      fixture.harness.db,
      thread.id,
    )?.terminalSessionId;
    if (terminalId === null || terminalId === undefined) {
      throw new Error("native thread has no terminal");
    }
    archiveThread(fixture.harness.db, noopNotifier, thread.id);
    fixture.harness.db
      .update(terminalSessions)
      .set({ status: "exited", closeReason: "thread-archived" })
      .where(eq(terminalSessions.id, terminalId))
      .run();
    fixture.socket.sentMessages.length = 0;
    const warn = vi.spyOn(fixture.harness.deps.logger, "warn");
    expect(
      listNativeTerminalThreadsWithDisconnectedTerminal(
        fixture.harness.db,
        fixture.hostId,
      ),
    ).not.toContain(thread.id);
    const reopening = reopenNativeTerminalsAfterDaemonReconnect(
      fixture.harness.deps,
      { hostId: fixture.hostId, threadIds: [thread.id] },
    );
    await new Promise((resolve) => setTimeout(resolve, 25));
    const accidentalOpen = daemonMessages(fixture.socket).find(
      (message): message is TerminalOpenMessage =>
        message.type === "terminal.open",
    );
    if (accidentalOpen !== undefined) acknowledgeOpen(fixture, accidentalOpen);
    await reopening;
    expect(accidentalOpen).toBeUndefined();
    fixture.socket.sentMessages.length = 0;
    fixture.harness.hub.unregisterDaemon(fixture.sessionId);
    onDaemonSocketOpen(fixture.harness.deps, {
      hostId: fixture.hostId,
      sessionId: fixture.sessionId,
      socket: fixture.socket,
    });
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(
      daemonMessages(fixture.socket).filter(
        (message) => message.type === "terminal.open",
      ),
    ).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("dispatches an unarchived thread-archived terminal on daemon reconnect", async () => {
    const fixture = await createMigratedMemoryFixture();
    const { thread } = await openRunningNativeThread(fixture, {
      providerId: "claude-code",
    });
    const record = getNativeTerminalThread(fixture.harness.db, thread.id);
    if (
      record?.terminalSessionId === null ||
      record?.terminalSessionId === undefined
    ) {
      throw new Error("native thread has no terminal");
    }
    if (record.nativeSessionId === null) {
      throw new Error("native thread has no provider session");
    }
    archiveThread(fixture.harness.db, noopNotifier, thread.id);
    fixture.harness.db
      .update(terminalSessions)
      .set({ status: "exited", closeReason: "thread-archived" })
      .where(eq(terminalSessions.id, record.terminalSessionId))
      .run();
    expect(
      unarchiveThread(fixture.harness.db, fixture.harness.hub, thread.id),
    ).not.toBeNull();
    expect(
      listNativeTerminalThreadsWithDisconnectedTerminal(
        fixture.harness.db,
        fixture.hostId,
      ),
    ).toContain(thread.id);
    fixture.harness.hub.unregisterDaemon(fixture.sessionId);
    onDaemonSocketOpen(fixture.harness.deps, {
      hostId: fixture.hostId,
      sessionId: fixture.sessionId,
      socket: fixture.socket,
    });

    const reopen = await waitForTerminalOpen(fixture.socket);
    expect(reopen.threadId).toBe(thread.id);
    expect(reopen.start.mode).toBe("command");
    if (reopen.start.mode !== "command") {
      throw new Error("Expected a native CLI command start");
    }
    expect(reopen.start.command).not.toContain("--reattach");
    expect(reopen.start.command).toContain(
      `exec "$BB_CLI" thread native-run ${thread.id}`,
    );
    acknowledgeOpen(fixture, reopen);
    await expect
      .poll(() => getNativeTerminalThread(fixture.harness.db, thread.id))
      .toMatchObject({
        nativeSessionId: record.nativeSessionId,
        terminalSessionId: reopen.terminalId,
      });
    const launch = nativeTerminalLaunchSpecSchema.parse(
      await readJson(
        await postJson(
          fixture,
          `/threads/${thread.id}/native-terminal/launch`,
          {},
        ),
      ),
    );
    expect(launch.nativeSessionId).toBe(record.nativeSessionId);
  });

  it("does not attempt reconnect reattachment for a deleted native thread", async () => {
    const fixture = await createMigratedMemoryFixture();
    const { thread } = await openRunningNativeThread(fixture, {
      providerId: "claude-code",
    });
    const terminalId = getNativeTerminalThread(
      fixture.harness.db,
      thread.id,
    )?.terminalSessionId;
    if (terminalId === null || terminalId === undefined) {
      throw new Error("native thread has no terminal");
    }
    fixture.harness.db
      .update(threads)
      .set({ deletedAt: Date.now() })
      .where(eq(threads.id, thread.id))
      .run();
    fixture.harness.db
      .update(terminalSessions)
      .set({ status: "exited", closeReason: "thread-archived" })
      .where(eq(terminalSessions.id, terminalId))
      .run();
    fixture.socket.sentMessages.length = 0;
    const warn = vi.spyOn(fixture.harness.deps.logger, "warn");

    await reopenNativeTerminalsAfterDaemonReconnect(fixture.harness.deps, {
      hostId: fixture.hostId,
      threadIds: [thread.id],
    });

    expect(daemonMessages(fixture.socket)).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("does not reconnect an exited terminal unless its close reason is eligible", async () => {
    const fixture = await createMigratedMemoryFixture();
    const { thread } = await openRunningNativeThread(fixture, {
      providerId: "claude-code",
    });
    const terminalId = getNativeTerminalThread(
      fixture.harness.db,
      thread.id,
    )?.terminalSessionId;
    if (terminalId === null || terminalId === undefined) {
      throw new Error("native thread has no terminal");
    }
    fixture.harness.db
      .update(terminalSessions)
      .set({ status: "exited", closeReason: "user" })
      .where(eq(terminalSessions.id, terminalId))
      .run();
    fixture.socket.sentMessages.length = 0;
    const warn = vi.spyOn(fixture.harness.deps.logger, "warn");

    await reopenNativeTerminalsAfterDaemonReconnect(fixture.harness.deps, {
      hostId: fixture.hostId,
      threadIds: [thread.id],
    });

    expect(daemonMessages(fixture.socket)).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("launches an unarchived thread whose terminal exited during archive into the same provider session", async () => {
    const fixture = await createMigratedMemoryFixture();
    const { thread } = await openRunningNativeThread(fixture, {
      providerId: "claude-code",
    });
    const record = getNativeTerminalThread(fixture.harness.db, thread.id);
    if (
      record?.terminalSessionId === null ||
      record?.terminalSessionId === undefined
    ) {
      throw new Error("native thread has no terminal");
    }
    if (record.nativeSessionId === null) {
      throw new Error("native thread has no provider session");
    }
    fixture.harness.db
      .update(terminalSessions)
      .set({ status: "exited", closeReason: "thread-archived" })
      .where(eq(terminalSessions.id, record.terminalSessionId))
      .run();
    fixture.socket.sentMessages.length = 0;
    const warn = vi.spyOn(fixture.harness.deps.logger, "warn");

    const reopening = reopenNativeTerminalsAfterDaemonReconnect(
      fixture.harness.deps,
      { hostId: fixture.hostId, threadIds: [thread.id] },
    );
    const reopen = await waitForTerminalOpen(fixture.socket);
    expect(reopen.start.mode).toBe("command");
    if (reopen.start.mode !== "command") {
      throw new Error("Expected a native CLI command start");
    }
    expect(reopen.start.command).not.toContain("--reattach");
    expect(reopen.start.command).toContain(
      `exec "$BB_CLI" thread native-run ${thread.id}`,
    );
    acknowledgeOpen(fixture, reopen);
    await reopening;

    expect(
      daemonMessages(fixture.socket).filter(
        (message) => message.type === "terminal.open",
      ),
    ).toHaveLength(1);
    expect(warn).not.toHaveBeenCalled();
    expect(
      getNativeTerminalThread(fixture.harness.db, thread.id),
    ).toMatchObject({
      nativeSessionId: record.nativeSessionId,
      terminalSessionId: reopen.terminalId,
    });
    const launch = nativeTerminalLaunchSpecSchema.parse(
      await readJson(
        await postJson(
          fixture,
          `/threads/${thread.id}/native-terminal/launch`,
          {},
        ),
      ),
    );
    expect(launch.nativeSessionId).toBe(record.nativeSessionId);
    fixture.harness.deps.terminalSessions.handleDaemonTerminalMessage({
      hostId: fixture.hostId,
      sessionId: fixture.sessionId,
      message: {
        type: "terminal.exited",
        terminalId: reopen.terminalId,
        exitCode: 0,
        closeReason: "user",
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
  });

  it("reattaches an unarchived thread whose terminal exited during daemon disconnect", async () => {
    const fixture = await createMigratedMemoryFixture();
    const { thread } = await openRunningNativeThread(fixture, {
      providerId: "claude-code",
    });
    const record = getNativeTerminalThread(fixture.harness.db, thread.id);
    if (
      record?.terminalSessionId === null ||
      record?.terminalSessionId === undefined
    ) {
      throw new Error("native thread has no terminal");
    }
    if (record.nativeSessionId === null) {
      throw new Error("native thread has no provider session");
    }
    fixture.harness.db
      .update(terminalSessions)
      .set({ status: "exited", closeReason: "daemon-disconnect" })
      .where(eq(terminalSessions.id, record.terminalSessionId))
      .run();
    fixture.socket.sentMessages.length = 0;

    const reopening = reopenNativeTerminalsAfterDaemonReconnect(
      fixture.harness.deps,
      { hostId: fixture.hostId, threadIds: [thread.id] },
    );
    const reopen = await waitForTerminalOpen(fixture.socket);
    expect(reopen.start.mode).toBe("command");
    if (reopen.start.mode !== "command") {
      throw new Error("Expected a native CLI command start");
    }
    expect(reopen.start.command).toContain("--reattach");
    acknowledgeOpen(fixture, reopen);
    await reopening;

    expect(
      daemonMessages(fixture.socket).filter(
        (message) => message.type === "terminal.open",
      ),
    ).toHaveLength(1);
    expect(
      getNativeTerminalThread(fixture.harness.db, thread.id),
    ).toMatchObject({
      nativeSessionId: record.nativeSessionId,
      terminalSessionId: reopen.terminalId,
    });
    fixture.harness.deps.terminalSessions.handleDaemonTerminalMessage({
      hostId: fixture.hostId,
      sessionId: fixture.sessionId,
      message: {
        type: "terminal.exited",
        terminalId: reopen.terminalId,
        exitCode: 0,
        closeReason: "user",
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
  });

  it("coalesces reconnect and unarchive into one launch-capable terminal.open that resumes the stored session", async () => {
    const fixture = await createMigratedMemoryFixture();
    const { thread } = await openRunningNativeThread(fixture, {
      providerId: "claude-code",
    });
    const record = getNativeTerminalThread(fixture.harness.db, thread.id);
    if (
      record?.terminalSessionId === null ||
      record?.terminalSessionId === undefined
    ) {
      throw new Error("native thread has no terminal");
    }
    if (record.nativeSessionId === null) {
      throw new Error("native thread has no provider session");
    }
    archiveThread(fixture.harness.db, noopNotifier, thread.id);
    fixture.harness.db
      .update(terminalSessions)
      .set({ status: "exited", closeReason: "thread-archived" })
      .where(eq(terminalSessions.id, record.terminalSessionId))
      .run();
    expect(
      unarchiveThread(fixture.harness.db, fixture.harness.hub, thread.id),
    ).not.toBeNull();
    fixture.socket.sentMessages.length = 0;

    let enterCreateTerminal: (() => void) | undefined;
    const createTerminalEntered = new Promise<void>((resolve) => {
      enterCreateTerminal = resolve;
    });
    let releaseCreateTerminal: (() => void) | undefined;
    const createTerminalGate = new Promise<void>((resolve) => {
      releaseCreateTerminal = resolve;
    });
    const createTerminal =
      fixture.harness.deps.terminalSessions.createTerminal.bind(
        fixture.harness.deps.terminalSessions,
      );
    vi.spyOn(
      fixture.harness.deps.terminalSessions,
      "createTerminal",
    ).mockImplementation(async (args) => {
      enterCreateTerminal?.();
      await createTerminalGate;
      return createTerminal(args);
    });

    const reconnecting = reopenNativeTerminalsAfterDaemonReconnect(
      fixture.harness.deps,
      { hostId: fixture.hostId, threadIds: [thread.id] },
    );
    await createTerminalEntered;
    const unarchiving = resumeNativeTerminalAfterUnarchive(
      fixture.harness.deps,
      { threadId: thread.id },
    );
    releaseCreateTerminal?.();

    const reopen = await waitForTerminalOpen(fixture.socket);
    expect(reopen.start.mode).toBe("command");
    if (reopen.start.mode !== "command") {
      throw new Error("Expected a native CLI command start");
    }
    expect(reopen.start.command).not.toContain("--reattach");
    expect(reopen.start.command).toContain(
      `exec "$BB_CLI" thread native-run ${thread.id}`,
    );
    acknowledgeOpen(fixture, reopen);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const opens = daemonMessages(fixture.socket).filter(
      (message): message is TerminalOpenMessage =>
        message.type === "terminal.open",
    );
    for (const extraOpen of opens.slice(1)) {
      acknowledgeOpen(fixture, extraOpen);
    }
    await Promise.all([reconnecting, unarchiving]);
    const launch = nativeTerminalLaunchSpecSchema.parse(
      await readJson(
        await postJson(
          fixture,
          `/threads/${thread.id}/native-terminal/launch`,
          {},
        ),
      ),
    );
    for (const open of opens) {
      fixture.harness.deps.terminalSessions.handleDaemonTerminalMessage({
        hostId: fixture.hostId,
        sessionId: fixture.sessionId,
        message: {
          type: "terminal.exited",
          terminalId: open.terminalId,
          exitCode: 0,
          closeReason: "user",
        },
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(opens).toHaveLength(1);
    expect(
      opens.filter((message) => message.start.mode === "command"),
    ).toHaveLength(1);
    expect(opens[0]?.type === "terminal.open" && opens[0].terminalId).toBe(
      reopen.terminalId,
    );
    expect(
      getNativeTerminalThread(fixture.harness.db, thread.id),
    ).toMatchObject({
      nativeSessionId: record.nativeSessionId,
      terminalSessionId: reopen.terminalId,
    });
    expect(launch.nativeSessionId).toBe(record.nativeSessionId);
    expect(opens).toHaveLength(1);
  });

  it("hands the creation prompt to the first launch only", async () => {
    const fixture = await createFixture();
    const { thread } = await openRunningNativeThread(fixture, {
      providerId: "claude-code",
      prompt: "Fix the flaky test",
    });
    const launchPath = `/threads/${thread.id}/native-terminal/launch`;
    const first = nativeTerminalLaunchSpecSchema.parse(
      await readJson(await postJson(fixture, launchPath, {})),
    );
    const second = nativeTerminalLaunchSpecSchema.parse(
      await readJson(await postJson(fixture, launchPath, {})),
    );
    expect(first.initialPrompt).toBe("Fix the flaky test");
    expect(first.cli.executable).toBe("claude");
    expect(first.cli.launchArgs).toEqual(["--dangerously-skip-permissions"]);
    expect(first.cli.session.kind).toBe("assigned");
    expect(first.nativeSessionId).not.toBeNull();
    expect(second.initialPrompt).toBeNull();
    expect(second.nativeSessionId).toBe(first.nativeSessionId);
  });

  it("hands an uploaded attachment to the first launch as a file path", async () => {
    const fixture = await createFixture();
    seedPrimaryHost(fixture.harness.deps, fixture.hostId);
    const attachmentPath = await storeImageAttachment(fixture);
    const { thread } = await openRunningNativeThread(fixture, {
      providerId: "claude-code",
      input: [
        ...textInput("Describe this screenshot"),
        { type: "localImage", path: attachmentPath },
      ],
    });
    const spec = nativeTerminalLaunchSpecSchema.parse(
      await readJson(
        await postJson(
          fixture,
          `/threads/${thread.id}/native-terminal/launch`,
          {},
        ),
      ),
    );
    expect(spec.initialPrompt).toBe(
      `${storedAttachmentPath(fixture, attachmentPath)}\nDescribe this screenshot`,
    );
    expect(
      fixture.harness.db
        .select()
        .from(projectAttachmentThreads)
        .all()
        .map((owner) => owner.threadId),
    ).toEqual([thread.id]);
  });

  it("starts a thread from an attachment alone", async () => {
    const fixture = await createFixture();
    seedPrimaryHost(fixture.harness.deps, fixture.hostId);
    const attachmentPath = await storeImageAttachment(fixture);
    const { thread } = await openRunningNativeThread(fixture, {
      providerId: "codex",
      input: [{ type: "localImage", path: attachmentPath }],
    });
    const spec = nativeTerminalLaunchSpecSchema.parse(
      await readJson(
        await postJson(
          fixture,
          `/threads/${thread.id}/native-terminal/launch?images=argv`,
          {},
        ),
      ),
    );
    expect(spec.initialPrompt).toBeNull();
    expect(spec.initialImages).toEqual([
      storedAttachmentPath(fixture, attachmentPath),
    ]);
  });

  it("hands Codex an image as a launch image instead of a path in the prompt", async () => {
    const fixture = await createFixture();
    seedPrimaryHost(fixture.harness.deps, fixture.hostId);
    const attachmentPath = await storeImageAttachment(fixture);
    const { thread } = await openRunningNativeThread(fixture, {
      providerId: "codex",
      input: [
        ...textInput("Describe this screenshot"),
        { type: "localImage", path: attachmentPath },
        { type: "localFile", path: "/tmp/notes.txt" },
      ],
    });
    const launch = async () =>
      nativeTerminalLaunchSpecSchema.parse(
        await readJson(
          await postJson(
            fixture,
            `/threads/${thread.id}/native-terminal/launch?images=argv`,
            {},
          ),
        ),
      );
    const first = await launch();
    expect(first.initialImages).toEqual([
      storedAttachmentPath(fixture, attachmentPath),
    ]);
    expect(first.initialPrompt).toBe(
      "/tmp/notes.txt\nDescribe this screenshot",
    );
    const second = await launch();
    expect(second.initialImages).toEqual([]);
    expect(second.initialPrompt).toBeNull();
  });

  it("keeps a Codex image as a path in the prompt for a bb CLI that does not ask for launch images", async () => {
    const fixture = await createFixture();
    seedPrimaryHost(fixture.harness.deps, fixture.hostId);
    const attachmentPath = await storeImageAttachment(fixture);
    const { thread } = await openRunningNativeThread(fixture, {
      providerId: "codex",
      input: [
        ...textInput("Describe this screenshot"),
        { type: "localImage", path: attachmentPath },
        { type: "localFile", path: "/tmp/notes.txt" },
      ],
    });
    const launch = async () =>
      nativeTerminalLaunchSpecSchema.parse(
        await readJson(
          await postJson(
            fixture,
            `/threads/${thread.id}/native-terminal/launch`,
            {},
          ),
        ),
      );
    const first = await launch();
    expect(first.initialImages).toEqual([]);
    expect(first.initialPrompt).toBe(
      `${storedAttachmentPath(fixture, attachmentPath)}\n/tmp/notes.txt\nDescribe this screenshot`,
    );
    const second = await launch();
    expect(second.initialImages).toEqual([]);
    expect(second.initialPrompt).toBeNull();
  });

  it("refuses an uploaded attachment for a thread on another machine", async () => {
    const fixture = await createFixture();
    seedPrimaryHost(fixture.harness.deps, "another-host");
    const attachmentPath = await storeImageAttachment(fixture);
    const response = await postNativeThread(fixture, {
      providerId: "claude-code",
      input: [
        ...textInput("Describe this screenshot"),
        { type: "localImage", path: attachmentPath },
      ],
    });
    expect(response.status).toBe(400);
    expect(apiErrorSchema.parse(await readJson(response)).message).toContain(
      "runs on another machine",
    );
  });

  it("refuses an attachment that was never uploaded", async () => {
    const fixture = await createFixture();
    seedPrimaryHost(fixture.harness.deps, fixture.hostId);
    const response = await postNativeThread(fixture, {
      providerId: "claude-code",
      input: [{ type: "localImage", path: "missing.png" }],
    });
    expect(response.status).toBe(400);
  });

  it("refuses another project's upload before any terminal thread is created", async () => {
    const fixture = await createFixture();
    seedPrimaryHost(fixture.harness.deps, fixture.hostId);
    const { project: otherProject } = seedProjectWithSource(
      fixture.harness.deps,
      { hostId: fixture.hostId, path: "/tmp/native-other-project" },
    );
    const otherUpload = await storeAttachment(
      fixture.harness.db,
      fixture.harness.deps.config.dataDir,
      otherProject.id,
      new File(["png"], "theirs.png", { type: "image/png" }),
    );
    const threadsBefore = fixture.harness.db
      .select()
      .from(threads)
      .all().length;
    const response = await postNativeThread(fixture, {
      providerId: "claude-code",
      input: [
        ...textInput("Describe this screenshot"),
        { type: "localImage", path: otherUpload.path },
      ],
    });
    expect(response.status).toBe(400);
    expect(fixture.harness.db.select().from(threads).all()).toHaveLength(
      threadsBefore,
    );
    expect(
      fixture.harness.db.select().from(projectAttachmentThreads).all(),
    ).toEqual([]);
  });

  it("pastes an attachment path ahead of the message", async () => {
    const fixture = await createFixture();
    seedPrimaryHost(fixture.harness.deps, fixture.hostId);
    const attachmentPath = await storeImageAttachment(fixture);
    const { open, thread } = await openRunningNativeThread(fixture, {
      providerId: "codex",
    });
    const cli = startFakeCli(fixture, open.terminalId, composerScreen);
    try {
      const response = await postJson(fixture, `/threads/${thread.id}/send`, {
        input: [
          ...textInput("run the tests"),
          { type: "localImage", path: attachmentPath },
        ],
        mode: "auto",
      });
      expect(response.status).toBe(200);
      expect(cli.inputs()).toEqual([
        `\u001b[200~${storedAttachmentPath(fixture, attachmentPath)}\u001b[201~`,
        "\u001b[200~run the tests\u001b[201~",
        "\r",
      ]);
    } finally {
      cli.stop();
    }
  });

  it.each(["claude-code", "codex"])(
    "rejects a scheduled %s native message before attachment or terminal side effects",
    async (providerId) => {
      const fixture = await createFixture();
      seedPrimaryHost(fixture.harness.deps, fixture.hostId);
      const attachmentPath = await storeImageAttachment(fixture);
      const { open, thread } = await openRunningNativeThread(fixture, {
        providerId,
      });
      const cli = startFakeCli(fixture, open.terminalId, composerScreen);
      try {
        const response = await postJson(fixture, `/threads/${thread.id}/send`, {
          input: [
            ...textInput("run the tests"),
            { type: "localImage", path: attachmentPath },
          ],
          mode: "auto",
          sendAt: Date.now() + 60_000,
        });
        expect(response.status).toBe(400);
        expect(apiErrorSchema.parse(await readJson(response))).toMatchObject({
          code: "invalid_request",
          message: "sendAt is not supported for native terminal threads",
        });
        expect(cli.inputs()).toEqual([]);
        expect(
          fixture.harness.db
            .select()
            .from(queuedThreadMessages)
            .where(eq(queuedThreadMessages.threadId, thread.id))
            .all(),
        ).toEqual([]);
        expect(
          listEvents(fixture.harness.db, { threadId: thread.id }).filter(
            (event) => event.type === "client/turn/requested",
          ),
        ).toEqual([]);
        expect(
          fixture.harness.db
            .select()
            .from(projectAttachmentThreads)
            .where(eq(projectAttachmentThreads.threadId, thread.id))
            .all(),
        ).toEqual([]);
      } finally {
        cli.stop();
      }
    },
  );

  it("pastes an image on its own so Codex attaches it before the message", async () => {
    const fixture = await createFixture();
    seedPrimaryHost(fixture.harness.deps, fixture.hostId);
    const attachmentPath = await storeImageAttachment(fixture);
    const { open, thread } = await openRunningNativeThread(fixture, {
      providerId: "codex",
    });
    const cli = startFakeCli(fixture, open.terminalId, (pasted) =>
      pasted.endsWith(".png")
        ? "\u001b[2;1H\u001b[2K\u203a [Image #1]"
        : `\u001b[2;1H\u001b[2K\u203a [Image #1] ${pasted}`,
    );
    try {
      const response = await postJson(fixture, `/threads/${thread.id}/send`, {
        input: [
          ...textInput("run the tests"),
          { type: "localImage", path: attachmentPath },
        ],
        mode: "auto",
      });
      expect(response.status).toBe(200);
      expect(cli.inputs()).toEqual([
        `\u001b[200~${storedAttachmentPath(fixture, attachmentPath)}\u001b[201~`,
        "\u001b[200~run the tests\u001b[201~",
        "\r",
      ]);
    } finally {
      cli.stop();
    }
  });

  it("sends Codex a second image while an earlier image with the same label is still shown", async () => {
    const fixture = await createFixture();
    seedPrimaryHost(fixture.harness.deps, fixture.hostId);
    const attachmentPath = await storeImageAttachment(fixture);
    const { open, thread } = await openRunningNativeThread(fixture, {
      providerId: "codex",
    });
    const cli = startFakeCli(
      fixture,
      open.terminalId,
      (pasted) =>
        pasted.endsWith(".png")
          ? "\u001b[6;1H\u001b[2K\u203a [Image #1]"
          : `\u001b[6;1H\u001b[2K\u203a [Image #1] ${pasted}`,
      "\u001b[2;1H\u203a [Image #1] What colour is this?\r\n\u2022 Green",
    );
    try {
      const response = await postJson(fixture, `/threads/${thread.id}/send`, {
        input: [
          ...textInput("run the tests"),
          { type: "localImage", path: attachmentPath },
        ],
        mode: "auto",
      });
      expect(response.status).toBe(200);
      expect(cli.inputs()).toEqual([
        `\u001b[200~${storedAttachmentPath(fixture, attachmentPath)}\u001b[201~`,
        "\u001b[200~run the tests\u001b[201~",
        "\r",
      ]);
    } finally {
      cli.stop();
    }
  });

  it("stops before the message when Codex only redraws an earlier image with the same label", async () => {
    const fixture = await createFixture();
    seedPrimaryHost(fixture.harness.deps, fixture.hostId);
    const attachmentPath = await storeImageAttachment(fixture);
    const { open, thread } = await openRunningNativeThread(fixture, {
      providerId: "codex",
    });
    const cli = startFakeCli(
      fixture,
      open.terminalId,
      () => "\u001b[2;1H\u001b[2K\u203a [Image #1] What colour is this?",
      "\u001b[2;1H\u203a [Image #1] What colour is this?\r\n\u2022 Green",
    );
    try {
      const response = await postJson(fixture, `/threads/${thread.id}/send`, {
        input: [
          ...textInput("run the tests"),
          { type: "localImage", path: attachmentPath },
        ],
        mode: "auto",
      });
      expect(response.status).toBe(409);
      expect(apiErrorSchema.parse(await readJson(response)).code).toBe(
        "native_terminal_input_not_shown",
      );
      expect(cli.inputs()).toEqual([
        `\u001b[200~${storedAttachmentPath(fixture, attachmentPath)}\u001b[201~`,
      ]);
    } finally {
      cli.stop();
    }
  }, 10_000);

  it("sends Claude Code an image and a message as two pastes and one Enter", async () => {
    const fixture = await createFixture();
    seedPrimaryHost(fixture.harness.deps, fixture.hostId);
    const attachmentPath = await storeImageAttachment(fixture);
    const { open, thread } = await openRunningNativeThread(fixture, {
      providerId: "claude-code",
    });
    const cli = startFakeCli(fixture, open.terminalId, (pasted) =>
      pasted.endsWith(".png")
        ? "\u001b[2;1H\u001b[2K\u276f [Image #1]"
        : `\u001b[2;1H\u001b[2K\u276f [Image #1] ${pasted}`,
    );
    try {
      const response = await postJson(fixture, `/threads/${thread.id}/send`, {
        input: [
          ...textInput("run the tests"),
          { type: "localImage", path: attachmentPath },
        ],
        mode: "auto",
      });
      expect(response.status).toBe(200);
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(cli.inputs()).toEqual([
        `\u001b[200~${storedAttachmentPath(fixture, attachmentPath)}\u001b[201~`,
        "\u001b[200~run the tests\u001b[201~",
        "\r",
      ]);
    } finally {
      cli.stop();
    }
  });

  it.each(["claude-code", "codex"])(
    "never presses Enter when %s shows the attachment but not the message",
    async (providerId) => {
      const fixture = await createFixture();
      seedPrimaryHost(fixture.harness.deps, fixture.hostId);
      const attachmentPath = await storeImageAttachment(fixture);
      const { open, thread } = await openRunningNativeThread(fixture, {
        providerId,
      });
      const cli = startFakeCli(fixture, open.terminalId, (pasted) =>
        pasted.endsWith(".png")
          ? "\u001b[2;1H\u001b[2K\u276f [Image #1]"
          : null,
      );
      try {
        const response = await postJson(fixture, `/threads/${thread.id}/send`, {
          input: [
            ...textInput("run the tests"),
            { type: "localImage", path: attachmentPath },
          ],
          mode: "auto",
        });
        expect(response.status).toBe(409);
        expect(apiErrorSchema.parse(await readJson(response)).code).toBe(
          "native_terminal_input_not_shown",
        );
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(cli.inputs()).toEqual([
          `\u001b[200~${storedAttachmentPath(fixture, attachmentPath)}\u001b[201~`,
          "\u001b[200~run the tests\u001b[201~",
        ]);
      } finally {
        cli.stop();
      }
    },
    10_000,
  );

  it("stops before the message when the CLI never shows the attachment", async () => {
    const fixture = await createFixture();
    seedPrimaryHost(fixture.harness.deps, fixture.hostId);
    const attachmentPath = await storeImageAttachment(fixture);
    const { open, thread } = await openRunningNativeThread(fixture, {
      providerId: "codex",
    });
    const cli = startFakeCli(fixture, open.terminalId, () => null);
    try {
      const response = await postJson(fixture, `/threads/${thread.id}/send`, {
        input: [
          ...textInput("run the tests"),
          { type: "localImage", path: attachmentPath },
        ],
        mode: "auto",
      });
      expect(response.status).toBe(409);
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(cli.inputs()).toEqual([
        `\u001b[200~${storedAttachmentPath(fixture, attachmentPath)}\u001b[201~`,
      ]);
    } finally {
      cli.stop();
    }
  }, 10_000);

  it("presses Enter when Claude Code draws a pasted image as a chip", async () => {
    const fixture = await createFixture();
    seedPrimaryHost(fixture.harness.deps, fixture.hostId);
    const attachmentPath = await storeImageAttachment(fixture);
    const { open, thread } = await openRunningNativeThread(fixture, {
      providerId: "claude-code",
    });
    const cli = startFakeCli(
      fixture,
      open.terminalId,
      () => "\u001b[2;1H\u001b[2K❯ [Image #2]",
      "\u001b[1;1H❯ [Image #1] an earlier screenshot",
    );
    try {
      const response = await postJson(fixture, `/threads/${thread.id}/send`, {
        input: [{ type: "localImage", path: attachmentPath }],
        mode: "auto",
      });
      expect(response.status).toBe(200);
      expect(cli.inputs()).toEqual([
        `\u001b[200~${storedAttachmentPath(fixture, attachmentPath)}\u001b[201~`,
        "\r",
      ]);
    } finally {
      cli.stop();
    }
  });

  it("never presses Enter when only an earlier image chip is redrawn", async () => {
    const fixture = await createFixture();
    seedPrimaryHost(fixture.harness.deps, fixture.hostId);
    const attachmentPath = await storeImageAttachment(fixture);
    const { open, thread } = await openRunningNativeThread(fixture, {
      providerId: "claude-code",
    });
    const earlier = "\u001b[1;1H❯ [Image #1] an earlier screenshot";
    const cli = startFakeCli(fixture, open.terminalId, () => earlier, earlier);
    try {
      const response = await postJson(fixture, `/threads/${thread.id}/send`, {
        input: [{ type: "localImage", path: attachmentPath }],
        mode: "auto",
      });
      expect(response.status).toBe(409);
      expect(apiErrorSchema.parse(await readJson(response)).code).toBe(
        "native_terminal_input_not_shown",
      );
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(cli.inputs()).toHaveLength(1);
    } finally {
      cli.stop();
    }
  }, 10_000);

  it("launches codex outside its shared background server so chat can take the session back", async () => {
    const fixture = await createFixture();
    const { thread } = await openRunningNativeThread(fixture, {
      providerId: "codex",
    });
    const spec = nativeTerminalLaunchSpecSchema.parse(
      await readJson(
        await postJson(
          fixture,
          `/threads/${thread.id}/native-terminal/launch`,
          {},
        ),
      ),
    );
    expect(spec.cli.executable).toBe("codex");
    expect(spec.cli.launchArgs).toEqual([
      "--no-daemon",
      "--dangerously-bypass-approvals-and-sandbox",
      "--no-alt-screen",
    ]);
    expect(spec.cli.activity?.transcript?.prompt).toContainEqual({
      match: {
        equals: {
          type: "event_msg",
          "payload.type": "item_completed",
          "payload.item.type": "UserMessage",
        },
      },
      text: "payload.item.content.0.text",
    });
  });

  it("presses Enter only after the CLI draws the pasted message", async () => {
    const fixture = await createFixture();
    const { open, thread } = await openRunningNativeThread(fixture, {
      providerId: "codex",
    });
    const cli = startFakeCli(fixture, open.terminalId, composerScreen);
    try {
      const response = await postJson(fixture, `/threads/${thread.id}/send`, {
        input: textInput("run the tests"),
        mode: "auto",
      });
      expect(response.status).toBe(200);
      expect(cli.inputs()).toEqual([
        "\u001b[200~run the tests\u001b[201~",
        "\r",
      ]);
    } finally {
      cli.stop();
    }
    expect(
      listEvents(fixture.harness.db, { threadId: thread.id }).some(
        (event) => event.type === "client/turn/requested",
      ),
    ).toBe(false);
  });

  it("never presses Enter while a menu ignores the paste", async () => {
    const fixture = await createFixture();
    const { open, thread } = await openRunningNativeThread(fixture, {
      providerId: "codex",
    });
    const cli = startFakeCli(fixture, open.terminalId, () => null);
    try {
      const response = await postJson(fixture, `/threads/${thread.id}/send`, {
        input: textInput("run the tests"),
        mode: "auto",
      });
      expect(response.status).toBe(409);
      expect(apiErrorSchema.parse(await readJson(response)).code).toBe(
        "native_terminal_input_not_shown",
      );
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(cli.inputs()).toEqual(["\u001b[200~run the tests\u001b[201~"]);
    } finally {
      cli.stop();
    }
  }, 10_000);

  it.each(["claude-code", "codex"])(
    "pastes no attachment for %s when the screen already shows the message",
    async (providerId) => {
      const fixture = await createFixture();
      seedPrimaryHost(fixture.harness.deps, fixture.hostId);
      const attachmentPath = await storeImageAttachment(fixture);
      const { open, thread } = await openRunningNativeThread(fixture, {
        providerId,
      });
      const cli = startFakeCli(
        fixture,
        open.terminalId,
        () => "\u001b[6;1H\u001b[2K\u203a [Image #1]",
        "\u001b[2;1H\u203a [Image #1] What colour is this picture?\r\n\u2022 Green",
      );
      try {
        const response = await postJson(fixture, `/threads/${thread.id}/send`, {
          input: [
            ...textInput("What colour is this picture?"),
            { type: "localImage", path: attachmentPath },
          ],
          mode: "auto",
        });
        expect(response.status).toBe(409);
        expect(apiErrorSchema.parse(await readJson(response)).code).toBe(
          "native_terminal_input_ambiguous",
        );
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(cli.inputs()).toEqual([]);
      } finally {
        cli.stop();
      }
    },
  );

  it("says the attachment is still in the input box when the message appears on screen after it was pasted", async () => {
    const fixture = await createFixture();
    seedPrimaryHost(fixture.harness.deps, fixture.hostId);
    const attachmentPath = await storeImageAttachment(fixture);
    const { open, thread } = await openRunningNativeThread(fixture, {
      providerId: "codex",
    });
    const cli = startFakeCli(
      fixture,
      open.terminalId,
      () =>
        "\u001b[2;1H\u2022 You could say: run the tests\u001b[6;1H\u001b[2K\u203a [Image #1]",
    );
    try {
      const response = await postJson(fixture, `/threads/${thread.id}/send`, {
        input: [
          ...textInput("run the tests"),
          { type: "localImage", path: attachmentPath },
        ],
        mode: "auto",
      });
      expect(response.status).toBe(409);
      const error = apiErrorSchema.parse(await readJson(response));
      expect(error.code).toBe("native_terminal_input_ambiguous");
      expect(error.message).toContain("still in the input box");
      expect(error.message).not.toContain("nothing was sent");
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(cli.inputs()).toEqual([
        `\u001b[200~${storedAttachmentPath(fixture, attachmentPath)}\u001b[201~`,
      ]);
    } finally {
      cli.stop();
    }
  });

  it("sends nothing when a redrawn menu already shows the reply", async () => {
    const fixture = await createFixture();
    const { open, thread } = await openRunningNativeThread(fixture, {
      providerId: "claude-code",
    });
    const cli = startFakeCli(
      fixture,
      open.terminalId,
      () => null,
      "\u001b[3;1H\u001b[2K\u276f 1. Yes\r\n\u001b[2K  2. No, and tell Claude what to do differently",
    );
    try {
      const response = await postJson(fixture, `/threads/${thread.id}/send`, {
        input: textInput("1"),
        mode: "auto",
      });
      expect(response.status).toBe(409);
      expect(apiErrorSchema.parse(await readJson(response)).code).toBe(
        "native_terminal_input_ambiguous",
      );
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(cli.inputs()).toEqual([]);
    } finally {
      cli.stop();
    }
  });

  it("sends a short reply that only older output shows", async () => {
    const fixture = await createFixture();
    const { open, thread } = await openRunningNativeThread(fixture, {
      providerId: "codex",
    });
    const cli = startFakeCli(
      fixture,
      open.terminalId,
      composerScreen,
      scrolledPastScreen("• Everything is ok now"),
    );
    try {
      const response = await postJson(fixture, `/threads/${thread.id}/send`, {
        input: textInput("ok"),
        mode: "auto",
      });
      expect(response.status).toBe(200);
      expect(cli.inputs()).toEqual(["\u001b[200~ok\u001b[201~", "\r"]);
    } finally {
      cli.stop();
    }
  });

  it.each([
    ["the whole screen", "\u001b[2J", ""],
    ["below the cursor", "\u001b[J", "\r\n\u276f 1. ok\r\n  2. No"],
    ["below the cursor, explicit", "\u001b[0J", "\r\n\u276f 1. ok\r\n  2. No"],
    ["above the cursor", "\u001b[1J", "\r\n\u276f 1. ok\r\n  2. No"],
  ])(
    "never presses Enter when the CLI erases %s and reprints older output",
    async (_name, erase, menu) => {
      const fixture = await createFixture();
      const { open, thread } = await openRunningNativeThread(fixture, {
        providerId: "codex",
      });
      const history = scrolledPastScreen("• Everything is ok now");
      const cli = startFakeCli(
        fixture,
        open.terminalId,
        () => `\u001b[H${erase}${history}${menu}`,
        history,
      );
      try {
        const response = await postJson(fixture, `/threads/${thread.id}/send`, {
          input: textInput("ok"),
          mode: "auto",
        });
        expect(response.status).toBe(409);
        expect(apiErrorSchema.parse(await readJson(response)).code).toBe(
          "native_terminal_input_not_shown",
        );
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(cli.inputs()).toEqual(["\u001b[200~ok\u001b[201~"]);
      } finally {
        cli.stop();
      }
    },
    10_000,
  );

  it("sends nothing when the CLI redraws the same text from its history", async () => {
    const fixture = await createFixture();
    const { open, thread } = await openRunningNativeThread(fixture, {
      providerId: "codex",
    });
    const cli = startFakeCli(
      fixture,
      open.terminalId,
      composerScreen,
      "\u001b[H\u001b[2J\u203a run the tests\r\n\u2022 Ran pnpm test\r\n\u203a ",
    );
    try {
      const response = await postJson(fixture, `/threads/${thread.id}/send`, {
        input: textInput("run the tests"),
        mode: "auto",
      });
      expect(response.status).toBe(409);
      expect(apiErrorSchema.parse(await readJson(response)).code).toBe(
        "native_terminal_input_ambiguous",
      );
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(cli.inputs()).toEqual([]);
    } finally {
      cli.stop();
    }
  });

  it("does not take a redrawn earlier placeholder for the echo", async () => {
    const fixture = await createFixture();
    const { open, thread } = await openRunningNativeThread(fixture, {
      providerId: "claude-code",
    });
    const cli = startFakeCli(
      fixture,
      open.terminalId,
      () => null,
      "\u001b[1;1H> [Pasted text #1 +59 lines]\r\n\u276f 1. Yes\r\n  2. No",
    );
    const message = Array.from(
      { length: 60 },
      (_, index) => `line ${index} of a long message`,
    ).join("\n");
    try {
      const response = await postJson(fixture, `/threads/${thread.id}/send`, {
        input: textInput(message),
        mode: "auto",
      });
      expect(response.status).toBe(409);
      expect(apiErrorSchema.parse(await readJson(response)).code).toBe(
        "native_terminal_input_not_shown",
      );
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(cli.inputs()).toEqual([`\u001b[200~${message}\u001b[201~`]);
    } finally {
      cli.stop();
    }
  }, 10_000);

  it("accepts the provider's placeholder for a long paste", async () => {
    const fixture = await createFixture();
    const { open, thread } = await openRunningNativeThread(fixture, {
      providerId: "claude-code",
    });
    const cli = startFakeCli(
      fixture,
      open.terminalId,
      () => "\u001b[2;1H\u001b[2K> [Pasted text #2 +59 lines]",
      "\u001b[1;1H> [Pasted text #1 +59 lines]",
    );
    const message = Array.from(
      { length: 60 },
      (_, index) => `line ${index} of a long message`,
    ).join("\n");
    try {
      const response = await postJson(fixture, `/threads/${thread.id}/send`, {
        input: textInput(message),
        mode: "auto",
      });
      expect(response.status).toBe(200);
      expect(cli.inputs()).toEqual([`\u001b[200~${message}\u001b[201~`, "\r"]);
    } finally {
      cli.stop();
    }
  });

  it("submits concurrent sends one at a time", async () => {
    const fixture = await createFixture();
    const { open, thread } = await openRunningNativeThread(fixture, {
      providerId: "codex",
    });
    const cli = startFakeCli(fixture, open.terminalId, composerScreen);
    try {
      const [first, second] = await Promise.all([
        postJson(fixture, `/threads/${thread.id}/send`, {
          input: textInput("first message"),
          mode: "auto",
        }),
        postJson(fixture, `/threads/${thread.id}/send`, {
          input: textInput("second message"),
          mode: "auto",
        }),
      ]);
      expect([first.status, second.status]).toEqual([200, 200]);
      expect(cli.inputs()).toEqual([
        "\u001b[200~first message\u001b[201~",
        "\r",
        "\u001b[200~second message\u001b[201~",
        "\r",
      ]);
    } finally {
      cli.stop();
    }
  });

  it("refuses provider dispatch and forks for a native thread", async () => {
    const fixture = await createFixture();
    const { thread } = await openRunningNativeThread(fixture, {
      providerId: "claude-code",
    });
    const row = getThread(fixture.harness.db, thread.id);
    if (row === null) throw new Error("thread missing");
    await expect(
      sendThreadMessage(fixture.harness.deps, {
        environment: fixture.environment,
        payload: { input: textInput("hi"), mode: "auto" },
        thread: row,
        trigger: "user",
      }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      queueParentSystemMessage(fixture.harness.deps, {
        input: textInput("child finished"),
        parentThreadId: thread.id,
        systemMessageKind: "child-completed",
        systemMessageSubject: null,
      }),
    ).resolves.toBe(false);

    const fork = await postJson(fixture, "/threads/fork", {
      sourceThreadId: thread.id,
      input: textInput("fork it"),
    });
    expect(fork.status).toBe(409);
    expect(apiErrorSchema.parse(await readJson(fork)).code).toBe(
      "native_terminal_thread",
    );
  });

  it("rejects a queued message for a native thread at enqueue and leaves existing queue rows untouched", async () => {
    const fixture = await createFixture();
    const { thread } = await openRunningNativeThread(fixture, {
      providerId: "claude-code",
    });
    const existing = seedQueuedMessage(fixture.harness.deps, {
      content: textInput("queued before the guard"),
      threadId: thread.id,
    });
    setQueuedThreadMessageFailureReason(fixture.harness.db, noopNotifier, {
      id: existing.id,
      threadId: thread.id,
      failureReason: "This thread runs its agent in a native terminal",
      now: Date.now(),
      retryDelaysMs: [],
    });
    const rowsBefore = fixture.harness.db
      .select()
      .from(queuedThreadMessages)
      .where(eq(queuedThreadMessages.threadId, thread.id))
      .all();

    const response = await postJson(
      fixture,
      `/threads/${thread.id}/queued-messages`,
      { input: textInput("will never deliver") },
    );
    expect(response.status).toBe(409);
    expect(apiErrorSchema.parse(await readJson(response))).toEqual({
      code: "native_terminal_thread",
      message:
        "This thread runs its agent in a native terminal; send input through the terminal",
    });

    const rowsAfter = fixture.harness.db
      .select()
      .from(queuedThreadMessages)
      .where(eq(queuedThreadMessages.threadId, thread.id))
      .all();
    expect(rowsAfter).toEqual(rowsBefore);
    expect(rowsAfter).toHaveLength(1);
  });

  it("rejects providers without a native harness", async () => {
    const fixture = await createFixture();
    const response = await postJson(fixture, "/threads", {
      projectId: fixture.projectId,
      providerId: "fake",
      origin: "cli",
      input: [],
      environment: { type: "reuse", environmentId: fixture.environment.id },
      nativeTerminal: true,
    });
    expect(response.status).toBe(400);
  });

  it("rejects creation fields a native terminal thread cannot honor", async () => {
    const fixture = await createFixture();
    for (const [field, value] of [
      ["sessionOptions", { daybreak: true }],
      ["sendAt", Date.now() + 60_000],
      ["sourceThreadId", "thread-source"],
    ] as const) {
      const response = await postJson(fixture, "/threads", {
        projectId: fixture.projectId,
        providerId: "claude-code",
        origin: "cli",
        input: [],
        environment: { type: "reuse", environmentId: fixture.environment.id },
        nativeTerminal: true,
        [field]: value,
      });
      expect(response.status).toBe(400);
      expect(JSON.stringify(await readJson(response))).toContain(
        `${field} is not supported for native terminal threads`,
      );
    }
    expect(
      fixture.harness.db.select({ id: threads.id }).from(threads).all(),
    ).toEqual([]);
    expect(
      daemonMessages(fixture.socket).some(
        (message) => message.type === "terminal.open",
      ),
    ).toBe(false);
  });

  it("keeps the requested provider and model instead of project execution defaults", async () => {
    const fixture = await createFixture();
    upsertProjectExecutionDefaults(fixture.harness.db, {
      projectId: fixture.projectId,
      providerId: "codex",
      model: "gpt-standard",
      serviceTier: "default",
      reasoningLevel: "low",
      permissionMode: "full",
    });

    const unpinned = await createNativeThread(fixture, {
      providerId: "claude-code",
    });
    const pinned = await createNativeThread(fixture, {
      providerId: "claude-code",
      model: "opus",
    });
    const remembered = await createNativeThread(fixture, {
      providerId: "claude-code",
      model: "claude-opus-5-5[1m]",
      modelSource: "client-preference",
    });

    for (const [thread, model] of [
      [unpinned, null],
      [pinned, "opus"],
      [remembered, "claude-opus-5-5[1m]"],
    ] as const) {
      expect(thread.providerId).toBe("claude-code");
      const record = getNativeTerminalThread(fixture.harness.db, thread.id);
      expect(record?.providerId).toBe("claude-code");
      expect(record?.model).toBe(model);
      expect(
        resolvePendingThreadSessionOptions(fixture.harness.db, thread.id),
      ).toEqual({});
      const types = listEvents(fixture.harness.db, {
        threadId: thread.id,
      }).map((event) => event.type);
      expect(types).not.toContain("thread/extensionState/updated");
      expect(types).not.toContain("client/thread/start");
    }
  });

  it("binds a discovered codex session to exactly one thread", async () => {
    const fixture = await createFixture();
    const first = await openRunningNativeThread(fixture, {
      providerId: "codex",
    });
    const secondThread = await createNativeThread(fixture, {
      providerId: "codex",
    });
    const secondOpen = await waitForTerminalOpen(fixture.socket, 1);
    acknowledgeOpen(fixture, secondOpen);
    for (let attempt = 0; attempt < 600; attempt += 1) {
      const record = getNativeTerminalThread(
        fixture.harness.db,
        secondThread.id,
      );
      if (record?.terminalSessionId === secondOpen.terminalId) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const second = { thread: secondThread };
    const credentialOf = (threadId: string) => {
      const open = daemonMessages(fixture.socket).find(
        (message): message is TerminalOpenMessage =>
          message.type === "terminal.open" && message.threadId === threadId,
      );
      const entry = open?.contributedEnv.find(
        (candidate) => candidate.name === NATIVE_TOOL_CREDENTIAL_ENV,
      );
      return `Bearer ${entry?.value}`;
    };
    const sessionId = "01a1246a-b896-7b71-9895-ce5345f5f623";

    const recorded = await postJson(
      fixture,
      `/threads/${first.thread.id}/native-terminal/session`,
      { nativeSessionId: sessionId },
      credentialOf(first.thread.id),
    );
    expect(recorded.status).toBe(200);
    expect(
      nativeTerminalThreadSchema.parse(await readJson(recorded))
        .nativeSessionId,
    ).toBe(sessionId);

    const stolen = await postJson(
      fixture,
      `/threads/${second.thread.id}/native-terminal/session`,
      { nativeSessionId: sessionId },
      credentialOf(second.thread.id),
    );
    expect(stolen.status).toBe(409);

    const rebound = await postJson(
      fixture,
      `/threads/${first.thread.id}/native-terminal/session`,
      { nativeSessionId: "11111111-2222-3333-4444-555555555555" },
      credentialOf(first.thread.id),
    );
    expect(rebound.status).toBe(409);
  });

  it("reopens an exited native terminal instead of duplicating a live one", async () => {
    const fixture = await createFixture();
    const { open, thread } = await openRunningNativeThread(fixture, {
      providerId: "claude-code",
    });
    const openPath = `/threads/${thread.id}/native-terminal/open`;
    const again = nativeTerminalThreadSchema.parse(
      await readJson(await postJson(fixture, openPath, {})),
    );
    expect(again.terminal?.id).toBe(open.terminalId);

    fixture.harness.deps.terminalSessions.handleDaemonTerminalMessage({
      hostId: fixture.hostId,
      sessionId: fixture.sessionId,
      message: {
        type: "terminal.exited",
        terminalId: open.terminalId,
        exitCode: 0,
        closeReason: "process-exit",
      },
    });
    const reopening = postJson(fixture, openPath, { cols: 90, rows: 20 });
    const reopen = await waitForTerminalOpen(fixture.socket, 1);
    expect(reopen.cols).toBe(90);
    acknowledgeOpen(fixture, reopen);
    const reopened = nativeTerminalThreadSchema.parse(
      await readJson(await reopening),
    );
    expect(reopened.terminal?.id).toBe(reopen.terminalId);
    expect(reopened.terminal?.id).not.toBe(open.terminalId);
  });

  it("reopens native terminals the host daemon lost when it restarts and leaves the rest alone", async () => {
    const fixture = await createFixture();
    const lost = await openRunningNativeThread(fixture, {
      providerId: "claude-code",
    });
    const finished = await createNativeThread(fixture, {
      providerId: "claude-code",
    });
    const finishedOpen = await waitForTerminalOpen(fixture.socket, 1);
    acknowledgeOpen(fixture, finishedOpen);
    await waitForThreadStatus(fixture, finished.id, "idle");
    fixture.harness.deps.terminalSessions.handleDaemonTerminalMessage({
      hostId: fixture.hostId,
      sessionId: fixture.sessionId,
      message: {
        type: "terminal.exited",
        terminalId: finishedOpen.terminalId,
        exitCode: 0,
        closeReason: "process-exit",
      },
    });

    fixture.harness.deps.terminalSessions.handleDaemonSessionClosed({
      sessionId: fixture.sessionId,
    });
    const restarted = seedSession(fixture.harness.deps, fixture.hostId, {
      instanceId: "instance-2",
    });
    const socket = createFakeDaemonSocket();
    onDaemonSocketOpen(fixture.harness.deps, {
      hostId: fixture.hostId,
      sessionId: restarted.id,
      socket,
    });

    const reopen = await waitForTerminalOpen(socket);
    expect(reopen.threadId).toBe(lost.thread.id);
    expect(reopen.start.mode === "command" && reopen.start.command).toContain(
      `exec "$BB_CLI" thread native-run ${lost.thread.id} --reattach`,
    );
    expect(
      lost.open.start.mode === "command" && lost.open.start.command,
    ).not.toContain("--reattach");
    fixture.harness.deps.terminalSessions.handleDaemonTerminalMessage({
      hostId: fixture.hostId,
      sessionId: restarted.id,
      message: {
        type: "terminal.opened",
        requestId: reopen.requestId,
        terminalId: reopen.terminalId,
        shell: "/bin/zsh",
        title: "zsh",
        initialCwd: "/tmp/native-workspace",
        cols: reopen.cols,
        rows: reopen.rows,
      },
    });
    await expect
      .poll(
        () =>
          getNativeTerminalThread(fixture.harness.db, lost.thread.id)
            ?.terminalSessionId,
      )
      .toBe(reopen.terminalId);
    expect(
      getTerminalSession(fixture.harness.db, {
        kind: "terminal",
        terminalId: lost.open.terminalId,
      }),
    ).toMatchObject({
      closeReason: "daemon-disconnect",
      status: "exited",
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const opens = daemonMessages(socket).filter(
      (message) => message.type === "terminal.open",
    );
    expect(opens).toHaveLength(1);
    expect(
      getNativeTerminalThread(fixture.harness.db, finished.id)
        ?.terminalSessionId,
    ).toBe(finishedOpen.terminalId);
  });

  async function restartDaemonWithRunningNativeThread(
    instanceId: string,
    options: {
      beforeRestart?: (fixture: Fixture) => void;
      deferProviders?: boolean;
      useMigratedMemoryDb?: boolean;
    } = {},
  ) {
    const fixture = options.useMigratedMemoryDb
      ? await createMigratedMemoryFixture()
      : await createFixture();
    const running = await openRunningNativeThread(fixture, {
      providerId: "claude-code",
    });
    applyLoggedThreadLifecycleEvent(fixture.harness.deps, {
      event: { type: "run.started" },
      threadId: running.thread.id,
    });
    expect(getThread(fixture.harness.db, running.thread.id)?.status).toBe(
      "active",
    );
    options.beforeRestart?.(fixture);
    handleDaemonSocketClosed(fixture.harness.deps, {
      sessionId: fixture.sessionId,
    });
    const lateProviders = options.deferProviders
      ? createProviderRegistryService({ deferRegistrationsSettled: true })
      : null;
    if (lateProviders !== null) {
      fixture.harness.deps.providerRegistry = lateProviders;
    }
    const opened = await fixture.harness.app.request("/internal/session/open", {
      method: "POST",
      headers: internalAuthHeaders(fixture.harness, {
        hostId: fixture.hostId,
      }),
      body: JSON.stringify({
        hostId: fixture.hostId,
        instanceId,
        hostName: "Test Host",
        hasMachineCredential: false,
        platform: "darwin",
        dataDir: "/tmp/host-daemon-restart",
        localApiPort: null,
        protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
        activeThreads: [],
        undeliveredEventThreadIds: [],
      }),
    });
    expect(opened.status).toBe(201);
    const { sessionId } = (await readJson(opened)) as { sessionId: string };
    const socket = createFakeDaemonSocket();
    onDaemonSocketOpen(fixture.harness.deps, {
      hostId: fixture.hostId,
      sessionId,
      socket,
    });
    return { fixture, lateProviders, running, sessionId, socket };
  }

  function interruptionReasons(fixture: Fixture, threadId: string): string[] {
    return listEvents(fixture.harness.db, { threadId })
      .filter((row) => row.type === "system/thread/interrupted")
      .map((row) => (JSON.parse(row.data) as { reason: string }).reason);
  }

  it("keeps a running native thread active across a real daemon restart when its holder survives and the reattach lands", async () => {
    const { fixture, running, sessionId, socket } =
      await restartDaemonWithRunningNativeThread("instance-restarted");
    const reopen = await waitForTerminalOpen(socket);
    expect(reopen.threadId).toBe(running.thread.id);
    expect(reopen.start.mode === "command" && reopen.start.command).toContain(
      "--reattach",
    );
    expect(interruptionReasons(fixture, running.thread.id)).toEqual([]);
    fixture.harness.deps.terminalSessions.handleDaemonTerminalMessage({
      hostId: fixture.hostId,
      sessionId,
      message: {
        type: "terminal.opened",
        requestId: reopen.requestId,
        terminalId: reopen.terminalId,
        shell: "/bin/zsh",
        title: "zsh",
        initialCwd: "/tmp/native-workspace",
        cols: reopen.cols,
        rows: reopen.rows,
      },
    });
    await expect
      .poll(
        () =>
          getNativeTerminalThread(fixture.harness.db, running.thread.id)
            ?.terminalSessionId,
      )
      .toBe(reopen.terminalId);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(getThread(fixture.harness.db, running.thread.id)?.status).toBe(
      "active",
    );
    expect(interruptionReasons(fixture, running.thread.id)).toEqual([]);
  });

  it.each(["an older daemon", "a direct-shell fallback"] as const)(
    "ends a shell after daemon restart when no holder marker was observed (%s)",
    async () => {
      const fixture = await createFixture();
      const creating = postJson(fixture, "/terminals", {
        cols: 80,
        rows: 24,
        target: {
          kind: "environment",
          environmentId: fixture.environment.id,
        },
      });
      const initialOpen = await waitForTerminalOpen(fixture.socket);
      fixture.harness.deps.terminalSessions.handleDaemonTerminalMessage({
        hostId: fixture.hostId,
        sessionId: fixture.sessionId,
        message: {
          type: "terminal.opened",
          requestId: initialOpen.requestId,
          terminalId: initialOpen.terminalId,
          shell: "/bin/zsh",
          title: "zsh",
          initialCwd: "/tmp/native-workspace",
          cols: initialOpen.cols,
          rows: initialOpen.rows,
        },
      });
      expect((await creating).status).toBe(201);
      handleDaemonSocketClosed(fixture.harness.deps, {
        sessionId: fixture.sessionId,
      });
      const openedSession = await fixture.harness.app.request(
        "/internal/session/open",
        {
          method: "POST",
          headers: internalAuthHeaders(fixture.harness, {
            hostId: fixture.hostId,
          }),
          body: JSON.stringify({
            hostId: fixture.hostId,
            instanceId: "instance-shell-restarted",
            hostName: "Test Host",
            hasMachineCredential: false,
            platform: "darwin",
            dataDir: "/tmp/host-daemon-restart",
            localApiPort: null,
            protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
            activeThreads: [],
            undeliveredEventThreadIds: [],
          }),
        },
      );
      expect(openedSession.status).toBe(201);
      const { sessionId } = (await readJson(openedSession)) as {
        sessionId: string;
      };
      const rpc = vi.spyOn(fixture.harness.deps.hub, "requestHostOnlineRpc");
      const socket = createFakeDaemonSocket();
      await onDaemonSocketOpen(fixture.harness.deps, {
        hostId: fixture.hostId,
        sessionId,
        socket,
      });

      expect(rpc).not.toHaveBeenCalled();
      expect(
        daemonMessages(socket).filter(
          (message) => message.type === "terminal.open",
        ),
      ).toEqual([]);
      expect(
        getTerminalSession(fixture.harness.db, {
          kind: "terminal",
          terminalId: initialOpen.terminalId,
        }),
      ).toMatchObject({ status: "exited", closeReason: "daemon-disconnect" });
    },
  );

  it("reopens a holder-backed shell after a real daemon restart, rebases output, and keeps a user-closed terminal closed", async () => {
    const fixture = await createFixture();
    const openShell = async (skip: number) => {
      const creating = postJson(fixture, "/terminals", {
        cols: 80,
        rows: 24,
        target: {
          kind: "environment",
          environmentId: fixture.environment.id,
        },
      });
      const open = await waitForTerminalOpen(fixture.socket, skip);
      fixture.harness.deps.terminalSessions.handleDaemonTerminalMessage({
        hostId: fixture.hostId,
        sessionId: fixture.sessionId,
        message: {
          type: "terminal.opened",
          requestId: open.requestId,
          terminalId: open.terminalId,
          shell: "/bin/zsh",
          title: "zsh",
          initialCwd: "/tmp/native-workspace",
          cols: open.cols,
          rows: open.rows,
        },
      });
      expect((await creating).status).toBe(201);
      return open;
    };
    const active = await openShell(0);
    const closed = await openShell(1);
    const pid = 42424;
    const output = (seq: number, text: string) =>
      fixture.harness.deps.terminalSessions.handleDaemonTerminalMessage({
        hostId: fixture.hostId,
        sessionId: fixture.sessionId,
        message: {
          type: "terminal.output",
          terminalId: active.terminalId,
          chunk: {
            seq,
            dataBase64: Buffer.from(text).toString("base64"),
          },
        },
      });
    const forwarded = vi.spyOn(
      fixture.harness.deps.hub,
      "sendTerminalClientMessage",
    );
    output(
      0,
      `\u001b]7717;bb-holder;${active.terminalId}\u0007BEFORE:${pid}\n`,
    );
    expect(
      getTerminalSession(fixture.harness.db, {
        kind: "terminal",
        terminalId: active.terminalId,
      }),
    ).toMatchObject({ holderBacked: true });
    expect(
      forwarded.mock.calls
        .map(([, message]) => message)
        .filter((message) => message.type === "output")
        .map((message) =>
          Buffer.from(message.chunk.dataBase64, "base64").toString("utf8"),
        )
        .join(""),
    ).toBe(`BEFORE:${pid}\n`);
    fixture.harness.deps.terminalSessions.flushAllRetainedOutput();

    handleDaemonSocketClosed(fixture.harness.deps, {
      sessionId: fixture.sessionId,
    });
    await fixture.harness.deps.terminalSessions.closeTerminal({
      terminalId: closed.terminalId,
      payload: { mode: "force", reason: "user" },
    });
    const openedSession = await fixture.harness.app.request(
      "/internal/session/open",
      {
        method: "POST",
        headers: internalAuthHeaders(fixture.harness, {
          hostId: fixture.hostId,
        }),
        body: JSON.stringify({
          hostId: fixture.hostId,
          instanceId: "instance-shell-restarted",
          hostName: "Test Host",
          hasMachineCredential: false,
          platform: "darwin",
          dataDir: "/tmp/host-daemon-restart",
          localApiPort: null,
          protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
          activeThreads: [],
          undeliveredEventThreadIds: [],
        }),
      },
    );
    expect(openedSession.status).toBe(201);
    const { sessionId } = (await readJson(openedSession)) as {
      sessionId: string;
    };
    const holderRpc = vi.spyOn(
      fixture.harness.deps.hub,
      "requestHostOnlineRpc",
    );
    const reconcile = vi.spyOn(
      fixture.harness.deps.terminalSessions,
      "reconcileDisconnectedHostTerminals",
    );
    const socket = createFakeDaemonSocket();
    await onDaemonSocketOpen(fixture.harness.deps, {
      hostId: fixture.hostId,
      sessionId,
      socket,
    });

    expect(holderRpc).not.toHaveBeenCalled();
    expect(reconcile).toHaveBeenCalledWith(
      expect.objectContaining({
        daemonSessionId: sessionId,
        hostId: fixture.hostId,
      }),
    );

    const reopened = await waitForTerminalOpen(socket);
    expect(reopened.terminalId).toBe(active.terminalId);
    expect(reopened.start).toEqual({ mode: "shell" });
    expect(reopened.contributedEnv).toContainEqual(
      expect.objectContaining({
        name: "BB_TERMINAL_HOLDER_REATTACH_ONLY",
        value: "1",
      }),
    );
    expect(
      daemonMessages(socket)
        .filter((message) => message.type === "terminal.open")
        .map((message) => message.terminalId),
    ).not.toContain(closed.terminalId);
    fixture.harness.deps.terminalSessions.handleDaemonTerminalMessage({
      hostId: fixture.hostId,
      sessionId,
      message: {
        type: "terminal.opened",
        requestId: reopened.requestId,
        terminalId: reopened.terminalId,
        shell: "/bin/zsh",
        title: "zsh",
        initialCwd: "/tmp/native-workspace",
        cols: reopened.cols,
        rows: reopened.rows,
      },
    });
    fixture.harness.deps.terminalSessions.handleDaemonTerminalMessage({
      hostId: fixture.hostId,
      sessionId,
      message: {
        type: "terminal.output",
        terminalId: active.terminalId,
        chunk: {
          seq: 0,
          dataBase64: Buffer.from(
            `\u001b]7717;bb-holder;${active.terminalId}\u0007AFTER:${pid}\n`,
          ).toString("base64"),
        },
      },
    });
    const runningOutputPromise = fixture.harness.app.request(
      `/api/v1/terminals/${active.terminalId}/output`,
    );
    let attach:
      | Extract<HostDaemonServerWsMessage, { type: "terminal.attach" }>
      | undefined;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      attach = daemonMessages(socket).find(
        (
          message,
        ): message is Extract<
          HostDaemonServerWsMessage,
          { type: "terminal.attach" }
        > =>
          message.type === "terminal.attach" &&
          message.terminalId === active.terminalId,
      );
      if (attach !== undefined) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(attach).toBeDefined();
    if (attach === undefined) throw new Error("Missing terminal.attach");
    fixture.harness.deps.terminalSessions.handleDaemonTerminalMessage({
      hostId: fixture.hostId,
      sessionId,
      message: {
        type: "terminal.replay",
        requestId: attach.requestId,
        terminalId: active.terminalId,
        chunks: [
          {
            seq: 0,
            dataBase64: Buffer.from(`AFTER:${pid}\n`).toString("base64"),
          },
        ],
        replayStartSeq: 0,
        nextSeq: 1,
      },
    });
    const runningOutputResponse = await runningOutputPromise;
    expect(runningOutputResponse.status).toBe(200);
    const runningOutput = terminalOutputResponseSchema.parse(
      await readJson(runningOutputResponse),
    );
    expect(runningOutput.chunks.map((chunk) => chunk.seq)).toEqual([0, 1]);
    expect(
      Buffer.concat(
        runningOutput.chunks.map((chunk) =>
          Buffer.from(chunk.dataBase64, "base64"),
        ),
      ).toString("utf8"),
    ).toBe(`BEFORE:${pid}\nAFTER:${pid}\n`);
    expect(
      forwarded.mock.calls
        .map(([, message]) => message)
        .filter((message) => message.type === "output")
        .map((message) =>
          Buffer.from(message.chunk.dataBase64, "base64").toString("utf8"),
        )
        .join(""),
    ).toBe(`BEFORE:${pid}\nAFTER:${pid}\n`);
    fixture.harness.deps.terminalSessions.handleDaemonTerminalMessage({
      hostId: fixture.hostId,
      sessionId,
      message: {
        type: "terminal.exited",
        terminalId: active.terminalId,
        exitCode: 0,
        closeReason: "process-exit",
      },
    });
    fixture.harness.deps.terminalSessions.flushAllRetainedOutput();
    const outputResponse = await fixture.harness.app.request(
      `/api/v1/terminals/${active.terminalId}/output`,
    );
    expect(outputResponse.status).toBe(200);
    const retained = terminalOutputResponseSchema.parse(
      await readJson(outputResponse),
    );
    expect(retained.chunks.map((chunk) => chunk.seq)).toEqual([0, 1]);
    expect(
      Buffer.concat(
        retained.chunks.map((chunk) => Buffer.from(chunk.dataBase64, "base64")),
      ).toString("utf8"),
    ).toBe(`BEFORE:${pid}\nAFTER:${pid}\n`);
    expect(
      getTerminalSession(fixture.harness.db, {
        kind: "terminal",
        terminalId: closed.terminalId,
      }),
    ).toMatchObject({ status: "exited", closeReason: "user" });
  });

  it("forwards ordinary output unchanged without decoding it when no holder marker is pending", async () => {
    const fixture = await createFixture();
    const creating = postJson(fixture, "/terminals", {
      cols: 80,
      rows: 24,
      target: {
        kind: "environment",
        environmentId: fixture.environment.id,
      },
    });
    const open = await waitForTerminalOpen(fixture.socket);
    fixture.harness.deps.terminalSessions.handleDaemonTerminalMessage({
      hostId: fixture.hostId,
      sessionId: fixture.sessionId,
      message: {
        type: "terminal.opened",
        requestId: open.requestId,
        terminalId: open.terminalId,
        shell: "/bin/zsh",
        title: "zsh",
        initialCwd: "/tmp/native-workspace",
        cols: open.cols,
        rows: open.rows,
      },
    });
    expect((await creating).status).toBe(201);
    fixture.harness.deps.terminalSessions.handleDaemonTerminalMessage({
      hostId: fixture.hostId,
      sessionId: fixture.sessionId,
      message: {
        type: "terminal.output",
        terminalId: open.terminalId,
        chunk: {
          seq: 0,
          dataBase64: Buffer.from("FIRST\n").toString("base64"),
        },
      },
    });

    const chunk = {
      seq: 1,
      dataBase64: Buffer.from("SECOND\n").toString("base64"),
    };
    const from = vi.spyOn(Buffer, "from");
    const forwarded = vi.spyOn(
      fixture.harness.deps.hub,
      "sendTerminalClientMessage",
    );
    try {
      fixture.harness.deps.terminalSessions.handleDaemonTerminalMessage({
        hostId: fixture.hostId,
        sessionId: fixture.sessionId,
        message: {
          type: "terminal.output",
          terminalId: open.terminalId,
          chunk,
        },
      });
      expect(from).not.toHaveBeenCalled();
      const output = forwarded.mock.calls.find(
        ([, message]) => message.type === "output" && message.chunk.seq === 1,
      );
      expect(output?.[1]).toMatchObject({ type: "output", chunk });
      if (output?.[1].type !== "output") throw new Error("Missing output");
      expect(output[1].chunk).toBe(chunk);
    } finally {
      from.mockRestore();
      forwarded.mockRestore();
    }
  });

  it("buffers split holder markers and preserves non-markers and incomplete output", async () => {
    const fixture = await createFixture();
    let openedCount = 0;
    const openShell = async () => {
      const creating = postJson(fixture, "/terminals", {
        cols: 80,
        rows: 24,
        target: {
          kind: "environment",
          environmentId: fixture.environment.id,
        },
      });
      const open = await waitForTerminalOpen(fixture.socket, openedCount++);
      fixture.harness.deps.terminalSessions.handleDaemonTerminalMessage({
        hostId: fixture.hostId,
        sessionId: fixture.sessionId,
        message: {
          type: "terminal.opened",
          requestId: open.requestId,
          terminalId: open.terminalId,
          shell: "/bin/zsh",
          title: "zsh",
          initialCwd: "/tmp/native-workspace",
          cols: open.cols,
          rows: open.rows,
        },
      });
      expect((await creating).status).toBe(201);
      return open.terminalId;
    };
    const send = (terminalId: string, seq: number, data: Buffer) =>
      fixture.harness.deps.terminalSessions.handleDaemonTerminalMessage({
        hostId: fixture.hostId,
        sessionId: fixture.sessionId,
        message: {
          type: "terminal.output",
          terminalId,
          chunk: { seq, dataBase64: data.toString("base64") },
        },
      });
    const retainedText = async (terminalId: string) => {
      fixture.harness.deps.terminalSessions.flushAllRetainedOutput();
      const retained = getRetainedTerminalOutput(fixture.harness.db, {
        hostId: fixture.hostId,
        terminalSessionId: terminalId,
        now: Date.now(),
      });
      return Buffer.concat(
        (retained ?? []).map((chunk) =>
          Buffer.from(chunk.dataBase64, "base64"),
        ),
      ).toString("utf8");
    };
    const forwarded = vi.spyOn(
      fixture.harness.deps.hub,
      "sendTerminalClientMessage",
    );

    const replayTerminalId = await openShell();
    const replayMarker = Buffer.from(
      `\u001b]7791;bb-grid;80;24\u0007\u001b]7717;bb-holder;${replayTerminalId}\u0007`,
    );
    await fixture.harness.deps.terminalSessions.handleDaemonTerminalMessage({
      hostId: fixture.hostId,
      sessionId: fixture.sessionId,
      message: {
        type: "terminal.replay",
        requestId: "holder-marker-replay",
        terminalId: replayTerminalId,
        chunks: replayMarker
          .reduce<Buffer[]>(
            (parts, byte) => [...parts, Buffer.from([byte])],
            [],
          )
          .map((part, seq) => ({
            seq,
            dataBase64: part.toString("base64"),
          }))
          .concat([
            {
              seq: replayMarker.length,
              dataBase64: Buffer.from("REPLAY-SUFFIX\n").toString("base64"),
            },
          ]),
        replayStartSeq: 0,
        nextSeq: replayMarker.length + 1,
      },
    });
    expect(
      getTerminalSession(fixture.harness.db, {
        kind: "terminal",
        terminalId: replayTerminalId,
      }),
    ).toMatchObject({ holderBacked: true });
    expect(await retainedText(replayTerminalId)).toBe(
      `\u001b]7791;bb-grid;80;24\u0007REPLAY-SUFFIX\n`,
    );
    const midReplayMarker = Buffer.from(
      `\u001b]7717;bb-holder;${replayTerminalId}\u0007`,
    );
    const midReplayChunks = [
      Buffer.from("BEFORE\n"),
      ...Array.from(midReplayMarker, (byte) => Buffer.from([byte])),
      Buffer.from("AFTER\n"),
    ];
    await fixture.harness.deps.terminalSessions.handleDaemonTerminalMessage({
      hostId: fixture.hostId,
      sessionId: fixture.sessionId,
      message: {
        type: "terminal.replay",
        requestId: "holder-marker-mid-replay",
        terminalId: replayTerminalId,
        chunks: midReplayChunks.map((part, index) => ({
          seq: 100 + index,
          dataBase64: part.toString("base64"),
        })),
        replayStartSeq: 100,
        nextSeq: 100 + midReplayChunks.length,
      },
    });
    const holderReplayText = await retainedText(replayTerminalId);
    expect(holderReplayText.endsWith("BEFORE\nAFTER\n")).toBe(true);
    expect(holderReplayText).not.toContain(
      `\u001b]7717;bb-holder;${replayTerminalId}\u0007`,
    );

    const firstSplitTerminalId = await openShell();
    const firstSplitMarker = Buffer.from(
      `\u001b]7717;bb-holder;${firstSplitTerminalId}\u0007`,
    );
    for (let offset = 1; offset < firstSplitMarker.length; offset += 1) {
      const terminalId =
        offset === 1 ? firstSplitTerminalId : await openShell();
      const marker = Buffer.from(`\u001b]7717;bb-holder;${terminalId}\u0007`);
      expect(marker.length).toBe(firstSplitMarker.length);
      const suffix = `SPLIT-${offset}\n`;
      send(terminalId, 0, marker.subarray(0, offset));
      send(
        terminalId,
        1,
        Buffer.concat([marker.subarray(offset), Buffer.from(suffix)]),
      );
      expect(
        getTerminalSession(fixture.harness.db, {
          kind: "terminal",
          terminalId,
        }),
      ).toMatchObject({ holderBacked: true });
      expect(await retainedText(terminalId)).toBe(suffix);
    }

    const bytewiseTerminalId = await openShell();
    const bytewiseMarker = Buffer.from(
      `\u001b]7717;bb-holder;${bytewiseTerminalId}\u0007`,
    );
    for (const [seq, byte] of bytewiseMarker.entries()) {
      send(bytewiseTerminalId, seq, Buffer.from([byte]));
    }
    send(bytewiseTerminalId, bytewiseMarker.length, Buffer.from("BYTEWISE\n"));
    expect(
      getTerminalSession(fixture.harness.db, {
        kind: "terminal",
        terminalId: bytewiseTerminalId,
      }),
    ).toMatchObject({ holderBacked: true });
    expect(await retainedText(bytewiseTerminalId)).toBe("BYTEWISE\n");

    const nonMarkerTerminalId = await openShell();
    const nonMarker = Buffer.from(
      "\u001b]7717;bb-holder;!not-a-holder\u0007VISIBLE\n",
    );
    send(nonMarkerTerminalId, 0, nonMarker);
    expect(
      getTerminalSession(fixture.harness.db, {
        kind: "terminal",
        terminalId: nonMarkerTerminalId,
      }),
    ).toMatchObject({ holderBacked: false });
    expect(await retainedText(nonMarkerTerminalId)).toBe(
      nonMarker.toString("utf8"),
    );

    const incompleteTerminalId = await openShell();
    const incomplete = Buffer.concat([
      Buffer.from(`\u001b]7717;bb-holder;${incompleteTerminalId}`),
      Buffer.alloc(160, 0x61),
    ]);
    send(incompleteTerminalId, 0, incomplete);
    expect(
      getTerminalSession(fixture.harness.db, {
        kind: "terminal",
        terminalId: incompleteTerminalId,
      }),
    ).toMatchObject({ holderBacked: false });
    expect(await retainedText(incompleteTerminalId)).toBe(
      incomplete.toString("utf8"),
    );

    const delayedOffsets = [
      ...Array.from({ length: 17 }, (_, index) => index + 1),
      Buffer.byteLength("\u001b]7717;bb-holder;") + 3,
    ];
    const grid = Buffer.from("\u001b]7791;bb-grid;80;24\u0007");
    const gridPrefix = Buffer.from("\u001b]7791;bb-grid;");
    const gridCases = [
      ...[4, 8, gridPrefix.length, grid.length - 2].flatMap((splitAt) =>
        [300, 2_000].flatMap((delayMs) =>
          ["same-chunk", "later-chunk"].map((markerPlacement) => ({
            splitAt,
            delayMs,
            markerPlacement,
          })),
        ),
      ),
    ];
    const gridTerminalIds = await Promise.all(gridCases.map(() => openShell()));
    const delayedTerminalIds = await Promise.all(
      delayedOffsets.map(() => openShell()),
    );
    const timedOutTerminalId = await openShell();
    vi.useFakeTimers();
    for (const [index, splitAt] of delayedOffsets.entries()) {
      const delayedTerminalId = delayedTerminalIds[index];
      if (delayedTerminalId === undefined) throw new Error("Missing terminal");
      const marker = Buffer.from(
        `\u001b]7717;bb-holder;${delayedTerminalId}\u0007`,
      );
      const first = Buffer.concat([grid, marker.subarray(0, splitAt)]);
      send(delayedTerminalId, 0, first);
      await vi.advanceTimersByTimeAsync(250);
      const beforeRemainder = await retainedText(delayedTerminalId);
      if (splitAt <= 3) {
        expect(beforeRemainder).toBe(first.toString());
      } else {
        expect(beforeRemainder).toBe("");
      }
      await vi.advanceTimersByTimeAsync(1_750);
      expect(await retainedText(delayedTerminalId)).toBe(beforeRemainder);
      expect(
        getTerminalSession(fixture.harness.db, {
          kind: "terminal",
          terminalId: delayedTerminalId,
        }),
      ).toMatchObject({ holderBacked: false });
      send(
        delayedTerminalId,
        1,
        Buffer.concat([marker.subarray(splitAt), Buffer.from("AFTER\n")]),
      );
      expect(
        getTerminalSession(fixture.harness.db, {
          kind: "terminal",
          terminalId: delayedTerminalId,
        }),
      ).toMatchObject({ holderBacked: true });
      const ambiguousPrefix =
        splitAt <= 3 ? marker.subarray(0, splitAt) : Buffer.alloc(0);
      const stringTerminator =
        splitAt <= 3 ? Buffer.from("\u001b\\") : Buffer.alloc(0);
      const retained = await retainedText(delayedTerminalId);
      expect(retained).not.toContain("7717;bb-holder");
      expect(retained.match(/AFTER\n/gu)).toHaveLength(1);
      expect(retained).toBe(
        Buffer.concat([
          grid,
          ambiguousPrefix,
          stringTerminator,
          Buffer.from("AFTER\n"),
        ]).toString(),
      );
    }

    for (const [index, scenario] of gridCases.entries()) {
      const terminalId = gridTerminalIds[index];
      if (terminalId === undefined) throw new Error("Missing grid terminal");
      const holder = Buffer.from(`\u001b]7717;bb-holder;${terminalId}\u0007`);
      const suffix = Buffer.from("AFTER\n");
      send(terminalId, 0, grid.subarray(0, scenario.splitAt));
      await vi.advanceTimersByTimeAsync(scenario.delayMs);
      expect(await retainedText(terminalId)).toBe("");
      const gridRemainder = grid.subarray(scenario.splitAt);
      const sameChunk = scenario.markerPlacement === "same-chunk";
      send(
        terminalId,
        1,
        Buffer.concat([
          gridRemainder,
          ...(sameChunk ? [holder] : []),
          ...(sameChunk ? [suffix] : []),
        ]),
      );
      if (!sameChunk) {
        await vi.advanceTimersByTimeAsync(scenario.delayMs);
        send(terminalId, 2, Buffer.concat([holder, suffix]));
      }
      expect(
        getTerminalSession(fixture.harness.db, {
          kind: "terminal",
          terminalId,
        }),
      ).toMatchObject({ holderBacked: true });
      const retained = await retainedText(terminalId);
      expect(retained).toBe(`${grid.toString()}AFTER\n`);
      expect(retained).not.toContain("7717;bb-holder");
      expect(retained.match(/AFTER\n/gu)).toHaveLength(1);
      const clientText = forwarded.mock.calls
        .filter(
          ([id, message]) => id === terminalId && message.type === "output",
        )
        .map(([, message]) =>
          message.type === "output"
            ? Buffer.from(message.chunk.dataBase64, "base64").toString("utf8")
            : "",
        )
        .join("");
      expect(clientText).toBe(retained);
      expect(clientText).not.toContain("7717;bb-holder");
    }

    const timedOutPrefix = Buffer.from("\u001b]7;");
    send(timedOutTerminalId, 0, timedOutPrefix);
    await vi.advanceTimersByTimeAsync(250);
    expect(
      getTerminalSession(fixture.harness.db, {
        kind: "terminal",
        terminalId: timedOutTerminalId,
      }),
    ).toMatchObject({ holderBacked: false });
    expect(await retainedText(timedOutTerminalId)).toBe(
      timedOutPrefix.toString("utf8"),
    );
    vi.useRealTimers();
  });

  it("does not adopt a terminal when the first holder marker names another terminal", async () => {
    const fixture = await createFixture();
    const creating = postJson(fixture, "/terminals", {
      cols: 80,
      rows: 24,
      target: {
        kind: "environment",
        environmentId: fixture.environment.id,
      },
    });
    const open = await waitForTerminalOpen(fixture.socket);
    fixture.harness.deps.terminalSessions.handleDaemonTerminalMessage({
      hostId: fixture.hostId,
      sessionId: fixture.sessionId,
      message: {
        type: "terminal.opened",
        requestId: open.requestId,
        terminalId: open.terminalId,
        shell: "/bin/zsh",
        title: "zsh",
        initialCwd: "/tmp/native-workspace",
        cols: open.cols,
        rows: open.rows,
      },
    });
    expect((await creating).status).toBe(201);
    fixture.harness.deps.terminalSessions.handleDaemonTerminalMessage({
      hostId: fixture.hostId,
      sessionId: fixture.sessionId,
      message: {
        type: "terminal.output",
        terminalId: open.terminalId,
        chunk: {
          seq: 0,
          dataBase64: Buffer.from(
            `\u001b]7717;bb-holder;term-other\u0007PROMPT\n`,
          ).toString("base64"),
        },
      },
    });
    handleDaemonSocketClosed(fixture.harness.deps, {
      sessionId: fixture.sessionId,
    });
    const openedSession = await fixture.harness.app.request(
      "/internal/session/open",
      {
        method: "POST",
        headers: internalAuthHeaders(fixture.harness, {
          hostId: fixture.hostId,
        }),
        body: JSON.stringify({
          hostId: fixture.hostId,
          instanceId: "instance-shell-restarted",
          hostName: "Test Host",
          hasMachineCredential: false,
          platform: "darwin",
          dataDir: "/tmp/host-daemon-restart",
          localApiPort: null,
          protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
          activeThreads: [],
          undeliveredEventThreadIds: [],
        }),
      },
    );
    const { sessionId } = (await readJson(openedSession)) as {
      sessionId: string;
    };
    const socket = createFakeDaemonSocket();
    await onDaemonSocketOpen(fixture.harness.deps, {
      hostId: fixture.hostId,
      sessionId,
      socket,
    });

    fixture.harness.deps.terminalSessions.flushAllRetainedOutput();
    const outputResponse = await fixture.harness.app.request(
      `/api/v1/terminals/${open.terminalId}/output`,
    );
    const retained = terminalOutputResponseSchema.parse(
      await readJson(outputResponse),
    );
    expect(
      Buffer.concat(
        retained.chunks.map((chunk) => Buffer.from(chunk.dataBase64, "base64")),
      ).toString("utf8"),
    ).toBe("PROMPT\n");
    expect(
      getTerminalSession(fixture.harness.db, {
        kind: "terminal",
        terminalId: open.terminalId,
      }),
    ).toMatchObject({ holderBacked: false });
    expect(
      daemonMessages(socket).filter(
        (message) => message.type === "terminal.open",
      ),
    ).toEqual([]);
    expect(
      getTerminalSession(fixture.harness.db, {
        kind: "terminal",
        terminalId: open.terminalId,
      }),
    ).toMatchObject({ status: "exited", closeReason: "daemon-disconnect" });
  });

  it("interrupts a running native thread after a real daemon restart when the reattach finds the holder gone", async () => {
    const { fixture, running, sessionId, socket } =
      await restartDaemonWithRunningNativeThread("instance-restarted");
    const reopen = await waitForTerminalOpen(socket);
    fixture.harness.deps.terminalSessions.handleDaemonTerminalMessage({
      hostId: fixture.hostId,
      sessionId,
      message: {
        type: "terminal.opened",
        requestId: reopen.requestId,
        terminalId: reopen.terminalId,
        shell: "/bin/zsh",
        title: "zsh",
        initialCwd: "/tmp/native-workspace",
        cols: reopen.cols,
        rows: reopen.rows,
      },
    });
    fixture.harness.deps.terminalSessions.handleDaemonTerminalMessage({
      hostId: fixture.hostId,
      sessionId,
      message: {
        type: "terminal.exited",
        terminalId: reopen.terminalId,
        exitCode: 0,
        closeReason: "process-exit",
      },
    });
    await expect
      .poll(() => interruptionReasons(fixture, running.thread.id), {
        timeout: 5000,
      })
      .toEqual(["host-daemon-restarted"]);
    expect(getThread(fixture.harness.db, running.thread.id)?.status).not.toBe(
      "active",
    );
  });

  it("keeps a running native thread active and reattaches the same CLI session when its provider registers after the settle timeout", async () => {
    const sourceRegistry = await createTestProviderRegistry();
    const registration = sourceRegistry.get("claude-code");
    if (registration === null) throw new Error("claude-code is not seeded");
    const { fixture, lateProviders, running, sessionId, socket } =
      await restartDaemonWithRunningNativeThread("instance-restarted", {
        deferProviders: true,
      });
    const nativeSessionBefore = getNativeTerminalThread(
      fixture.harness.db,
      running.thread.id,
    )?.nativeSessionId;
    await new Promise((resolve) => setTimeout(resolve, 30_500));
    expect(
      daemonMessages(socket).filter(
        (message) => message.type === "terminal.open",
      ),
    ).toHaveLength(0);
    expect(getThread(fixture.harness.db, running.thread.id)?.status).toBe(
      "active",
    );
    expect(interruptionReasons(fixture, running.thread.id)).toEqual([]);

    lateProviders?.register(registration);
    const reopen = await waitForTerminalOpen(socket);
    expect(reopen.threadId).toBe(running.thread.id);
    expect(reopen.start.mode === "command" && reopen.start.command).toContain(
      `native-run ${running.thread.id} --reattach`,
    );
    fixture.harness.deps.terminalSessions.handleDaemonTerminalMessage({
      hostId: fixture.hostId,
      sessionId,
      message: {
        type: "terminal.opened",
        requestId: reopen.requestId,
        terminalId: reopen.terminalId,
        shell: "/bin/zsh",
        title: "zsh",
        initialCwd: "/tmp/native-workspace",
        cols: reopen.cols,
        rows: reopen.rows,
      },
    });
    await expect
      .poll(
        () =>
          getNativeTerminalThread(fixture.harness.db, running.thread.id)
            ?.terminalSessionId,
      )
      .toBe(reopen.terminalId);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(getThread(fixture.harness.db, running.thread.id)?.status).toBe(
      "active",
    );
    expect(interruptionReasons(fixture, running.thread.id)).toEqual([]);
    expect(
      getNativeTerminalThread(fixture.harness.db, running.thread.id)
        ?.nativeSessionId,
    ).toBe(nativeSessionBefore);
  }, 60_000);

  it("interrupts a running native thread once when the provider never registers before the reattach deadline, and lets a new reconnect resume it", async () => {
    const sourceRegistry = await createTestProviderRegistry();
    const registration = sourceRegistry.get("claude-code");
    if (registration === null) throw new Error("claude-code is not seeded");
    let restoreTimers = false;
    try {
      const { fixture, lateProviders, running, sessionId, socket } =
        await restartDaemonWithRunningNativeThread("instance-restarted", {
          beforeRestart: () => {
            vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
            restoreTimers = true;
          },
          deferProviders: true,
        });
      await vi.advanceTimersByTimeAsync(44_000);
      expect(getThread(fixture.harness.db, running.thread.id)?.status).toBe(
        "active",
      );
      expect(interruptionReasons(fixture, running.thread.id)).toEqual([]);

      await vi.advanceTimersByTimeAsync(2_000);
      expect(getThread(fixture.harness.db, running.thread.id)?.status).not.toBe(
        "active",
      );
      expect(interruptionReasons(fixture, running.thread.id)).toEqual([
        "host-daemon-restarted",
      ]);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(interruptionReasons(fixture, running.thread.id)).toEqual([
        "host-daemon-restarted",
      ]);

      vi.useRealTimers();
      restoreTimers = false;
      lateProviders?.register(registration);
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(
        daemonMessages(socket).filter(
          (message) => message.type === "terminal.open",
        ),
      ).toHaveLength(0);
      void reopenNativeTerminalsAfterDaemonReconnect(fixture.harness.deps, {
        hostId: fixture.hostId,
        threadIds: [running.thread.id],
      });
      const reopen = await waitForTerminalOpen(socket);
      expect(reopen.threadId).toBe(running.thread.id);
      fixture.harness.deps.terminalSessions.handleDaemonTerminalMessage({
        hostId: fixture.hostId,
        sessionId,
        message: {
          type: "terminal.opened",
          requestId: reopen.requestId,
          terminalId: reopen.terminalId,
          shell: "/bin/zsh",
          title: "zsh",
          initialCwd: "/tmp/native-workspace",
          cols: reopen.cols,
          rows: reopen.rows,
        },
      });
      await expect
        .poll(
          () =>
            getNativeTerminalThread(fixture.harness.db, running.thread.id)
              ?.terminalSessionId,
        )
        .toBe(reopen.terminalId);
      const reopenedCredential = reopen.contributedEnv.find(
        (entry) => entry.name === NATIVE_TOOL_CREDENTIAL_ENV,
      )?.value;
      recordNativeTerminalActivity(fixture.harness.deps, {
        confirms: true,
        authorization: `Bearer ${reopenedCredential}`,
        threadId: running.thread.id,
        state: "working",
      });
      expect(getThread(fixture.harness.db, running.thread.id)?.status).toBe(
        "active",
      );
    } finally {
      if (restoreTimers) vi.useRealTimers();
    }
  }, 60_000);

  it("retries a failed deadline interrupt and stops the native thread on the next attempt", async () => {
    let restoreTimers = false;
    let transaction: ReturnType<typeof vi.spyOn> | undefined;
    let errorLog: ReturnType<typeof vi.spyOn> | undefined;
    try {
      const { fixture, running } = await restartDaemonWithRunningNativeThread(
        "instance-restarted",
        {
          beforeRestart: () => {
            vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
            restoreTimers = true;
          },
          deferProviders: true,
          useMigratedMemoryDb: true,
        },
      );
      transaction = vi.spyOn(fixture.harness.deps.db, "transaction");
      transaction.mockImplementationOnce(() => {
        throw new Error("injected interrupt transaction failure");
      });
      errorLog = vi.spyOn(fixture.harness.deps.logger, "error");

      await vi.advanceTimersByTimeAsync(46_000);

      expect(transaction).toHaveBeenCalledTimes(2);
      expect(getThread(fixture.harness.db, running.thread.id)?.status).not.toBe(
        "active",
      );
      expect(interruptionReasons(fixture, running.thread.id)).toEqual([
        "host-daemon-restarted",
      ]);
      expect(errorLog).not.toHaveBeenCalled();
    } finally {
      transaction?.mockRestore();
      errorLog?.mockRestore();
      if (restoreTimers) vi.useRealTimers();
    }
  }, 60_000);

  it("stops retrying a failed deadline interrupt when a newer reconnect moves the reattach epoch", async () => {
    let restoreTimers = false;
    let transaction: ReturnType<typeof vi.spyOn> | undefined;
    try {
      const { fixture, lateProviders, running, sessionId, socket } =
        await restartDaemonWithRunningNativeThread("instance-restarted", {
          beforeRestart: () => {
            vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
            restoreTimers = true;
          },
          deferProviders: true,
          useMigratedMemoryDb: true,
        });
      const registration = (await createTestProviderRegistry()).get(
        "claude-code",
      );
      if (registration === null) throw new Error("claude-code is not seeded");
      transaction = vi.spyOn(fixture.harness.deps.db, "transaction");
      transaction.mockImplementationOnce(() => {
        throw new Error("injected interrupt transaction failure");
      });

      await vi.advanceTimersByTimeAsync(45_000);

      expect(transaction).toHaveBeenCalledTimes(1);
      const reconnect = reopenNativeTerminalsAfterDaemonReconnect(
        fixture.harness.deps,
        { hostId: fixture.hostId, threadIds: [running.thread.id] },
      );
      lateProviders?.register(registration);
      let opening: TerminalOpenMessage | undefined;
      for (let step = 0; step < 20 && opening === undefined; step += 1) {
        await vi.advanceTimersByTimeAsync(1);
        opening = daemonMessages(socket).find(
          (message): message is TerminalOpenMessage =>
            message.type === "terminal.open",
        );
      }
      if (opening === undefined) throw new Error("reconnect never opened");
      fixture.harness.deps.terminalSessions.handleDaemonTerminalMessage({
        hostId: fixture.hostId,
        sessionId,
        message: {
          type: "terminal.opened",
          requestId: opening.requestId,
          terminalId: opening.terminalId,
          shell: "/bin/zsh",
          title: "zsh",
          initialCwd: "/tmp/native-workspace",
          cols: opening.cols,
          rows: opening.rows,
        },
      });
      await reconnect;

      expect(
        getTerminalSession(fixture.harness.db, {
          kind: "terminal",
          terminalId: opening.terminalId,
        }),
      ).toMatchObject({ status: "running" });
      const recoveredTransactionCount = transaction.mock.calls.length;
      await vi.advanceTimersByTimeAsync(25);

      expect(transaction).toHaveBeenCalledTimes(recoveredTransactionCount);
      expect(getThread(fixture.harness.db, running.thread.id)?.status).toBe(
        "active",
      );
      expect(interruptionReasons(fixture, running.thread.id)).toEqual([]);
    } finally {
      transaction?.mockRestore();
      if (restoreTimers) vi.useRealTimers();
    }
  }, 60_000);

  it("bounds failed deadline interrupt retries and logs the final failure", async () => {
    let restoreTimers = false;
    let transaction: ReturnType<typeof vi.spyOn> | undefined;
    let errorLog: ReturnType<typeof vi.spyOn> | undefined;
    try {
      const { fixture, running } = await restartDaemonWithRunningNativeThread(
        "instance-restarted",
        {
          beforeRestart: () => {
            vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
            restoreTimers = true;
          },
          deferProviders: true,
          useMigratedMemoryDb: true,
        },
      );
      transaction = vi.spyOn(fixture.harness.deps.db, "transaction");
      transaction.mockImplementation(() => {
        throw new Error("persistent interrupt transaction failure");
      });
      errorLog = vi.spyOn(fixture.harness.deps.logger, "error");

      await vi.advanceTimersByTimeAsync(46_000);

      expect(transaction).toHaveBeenCalledTimes(3);
      expect(getThread(fixture.harness.db, running.thread.id)?.status).toBe(
        "active",
      );
      expect(interruptionReasons(fixture, running.thread.id)).toEqual([]);
      expect(errorLog).toHaveBeenCalledWith(
        expect.objectContaining({
          attempts: 3,
          hostId: fixture.hostId,
          threadId: running.thread.id,
        }),
        "Failed to interrupt a native terminal thread after retries",
      );
    } finally {
      transaction?.mockRestore();
      errorLog?.mockRestore();
      if (restoreTimers) vi.useRealTimers();
    }
  }, 60_000);

  it("does not let a stale reattach deadline interrupt a thread an overlapping explicit open already recovered", async () => {
    const sourceRegistry = await createTestProviderRegistry();
    let restoreTimers = false;
    try {
      const { fixture, running, sessionId, socket } =
        await restartDaemonWithRunningNativeThread("instance-restarted", {
          beforeRestart: () => {
            vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
            restoreTimers = true;
          },
          deferProviders: true,
        });
      const reconnectRegistry = fixture.harness.deps.providerRegistry;
      let explicitPhase = true;
      fixture.harness.deps.providerRegistry = {
        ...sourceRegistry,
        get: (providerId: string) =>
          explicitPhase ? sourceRegistry.get(providerId) : null,
        onProviderRegistered: reconnectRegistry.onProviderRegistered,
        whenProviderRegistered: reconnectRegistry.whenProviderRegistered,
      };
      const explicitOpen = postJson(
        fixture,
        `/threads/${running.thread.id}/native-terminal/open`,
        {},
      );
      let explicit: TerminalOpenMessage | undefined;
      for (
        let attempt = 0;
        attempt < 200 && explicit === undefined;
        attempt++
      ) {
        await vi.advanceTimersByTimeAsync(10);
        explicit = daemonMessages(socket).find(
          (message): message is TerminalOpenMessage =>
            message.type === "terminal.open",
        );
      }
      if (explicit === undefined) throw new Error("explicit open never sent");
      fixture.harness.deps.terminalSessions.handleDaemonTerminalMessage({
        hostId: fixture.hostId,
        sessionId,
        message: {
          type: "terminal.opened",
          requestId: explicit.requestId,
          terminalId: explicit.terminalId,
          shell: "/bin/zsh",
          title: "zsh",
          initialCwd: "/tmp/native-workspace",
          cols: explicit.cols,
          rows: explicit.rows,
        },
      });
      await vi.advanceTimersByTimeAsync(10);
      expect((await explicitOpen).status).toBe(200);
      expect(
        getNativeTerminalThread(fixture.harness.db, running.thread.id)
          ?.terminalSessionId,
      ).toBe(explicit.terminalId);

      explicitPhase = false;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(getThread(fixture.harness.db, running.thread.id)?.status).toBe(
        "active",
      );
      expect(interruptionReasons(fixture, running.thread.id)).toEqual([]);
    } finally {
      if (restoreTimers) vi.useRealTimers();
    }
  }, 60_000);

  it("does not let a stale reattach deadline interrupt a thread a newer open recovered on the same terminal id", async () => {
    const sourceRegistry = await createTestProviderRegistry();
    let restoreTimers = false;
    try {
      const { fixture, running } = await restartDaemonWithRunningNativeThread(
        "instance-restarted",
        {
          beforeRestart: () => {
            vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
            restoreTimers = true;
          },
          deferProviders: true,
        },
      );
      const reconnectRegistry = fixture.harness.deps.providerRegistry;
      let explicitPhase = true;
      fixture.harness.deps.providerRegistry = {
        ...sourceRegistry,
        get: (providerId: string) =>
          explicitPhase ? sourceRegistry.get(providerId) : null,
        onProviderRegistered: reconnectRegistry.onProviderRegistered,
        whenProviderRegistered: reconnectRegistry.whenProviderRegistered,
      };
      const terminalId = getNativeTerminalThread(
        fixture.harness.db,
        running.thread.id,
      )?.terminalSessionId;
      if (terminalId === null || terminalId === undefined) {
        throw new Error("native thread has no terminal");
      }
      fixture.harness.db
        .update(terminalSessions)
        .set({ status: "running", closeReason: null })
        .where(eq(terminalSessions.id, terminalId))
        .run();
      const reopened = await postJson(
        fixture,
        `/threads/${running.thread.id}/native-terminal/open`,
        {},
      );
      expect(reopened.status).toBe(200);
      expect(
        getNativeTerminalThread(fixture.harness.db, running.thread.id)
          ?.terminalSessionId,
      ).toBe(terminalId);

      explicitPhase = false;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(getThread(fixture.harness.db, running.thread.id)?.status).toBe(
        "active",
      );
      expect(interruptionReasons(fixture, running.thread.id)).toEqual([]);
    } finally {
      if (restoreTimers) vi.useRealTimers();
    }
  }, 60_000);

  async function restartWithFailingReattach(
    failure: (attempt: number) => Error | null,
  ) {
    let attempts = 0;
    const restart = await restartDaemonWithRunningNativeThread(
      "instance-restarted",
      {
        beforeRestart: (fixture) => {
          vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
          const terminals = fixture.harness.deps.terminalSessions;
          const createTerminal = terminals.createTerminal.bind(terminals);
          vi.spyOn(terminals, "createTerminal").mockImplementation(
            async (createArgs) => {
              attempts += 1;
              const error = failure(attempts);
              if (error !== null) throw error;
              return createTerminal(createArgs);
            },
          );
        },
      },
    );
    return { ...restart, attempts: () => attempts };
  }

  it("keeps a running native thread active when a transient reattach failure is followed by a successful retry", async () => {
    const { fixture, running, sessionId, socket, attempts } =
      await restartWithFailingReattach((attempt) =>
        attempt === 1
          ? new ApiError(502, "host_disconnected", "Host is not connected")
          : null,
      );
    try {
      let reopen: TerminalOpenMessage | undefined;
      for (let step = 0; step < 400 && reopen === undefined; step += 1) {
        await vi.advanceTimersByTimeAsync(50);
        reopen = daemonMessages(socket).find(
          (message): message is TerminalOpenMessage =>
            message.type === "terminal.open",
        );
      }
      if (reopen === undefined) throw new Error("retry never reopened");
      fixture.harness.deps.terminalSessions.handleDaemonTerminalMessage({
        hostId: fixture.hostId,
        sessionId,
        message: {
          type: "terminal.opened",
          requestId: reopen.requestId,
          terminalId: reopen.terminalId,
          shell: "/bin/zsh",
          title: "zsh",
          initialCwd: "/tmp/native-workspace",
          cols: reopen.cols,
          rows: reopen.rows,
        },
      });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(attempts()).toBe(2);
      expect(getThread(fixture.harness.db, running.thread.id)?.status).toBe(
        "active",
      );
      expect(interruptionReasons(fixture, running.thread.id)).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  }, 60_000);

  it("interrupts a running native thread exactly once at the deadline when every reattach attempt fails transiently", async () => {
    const { fixture, running, attempts } = await restartWithFailingReattach(
      () => new ApiError(502, "host_disconnected", "Host is not connected"),
    );
    try {
      await vi.advanceTimersByTimeAsync(44_000);
      expect(getThread(fixture.harness.db, running.thread.id)?.status).toBe(
        "active",
      );
      expect(interruptionReasons(fixture, running.thread.id)).toEqual([]);
      expect(attempts()).toBeGreaterThan(1);

      await vi.advanceTimersByTimeAsync(2_000);
      expect(interruptionReasons(fixture, running.thread.id)).toEqual([
        "host-daemon-restarted",
      ]);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(interruptionReasons(fixture, running.thread.id)).toEqual([
        "host-daemon-restarted",
      ]);
    } finally {
      vi.useRealTimers();
    }
  }, 60_000);

  it("interrupts a running native thread at once when the reattached terminal exits before its open completes", async () => {
    const { fixture, running, sessionId, socket } =
      await restartWithFailingReattach(() => null);
    try {
      let reopen: TerminalOpenMessage | undefined;
      for (let step = 0; step < 400 && reopen === undefined; step += 1) {
        await vi.advanceTimersByTimeAsync(50);
        reopen = daemonMessages(socket).find(
          (message): message is TerminalOpenMessage =>
            message.type === "terminal.open",
        );
      }
      if (reopen === undefined) throw new Error("reattach never opened");
      const terminals = fixture.harness.deps.terminalSessions;
      terminals.handleDaemonTerminalMessage({
        hostId: fixture.hostId,
        sessionId,
        message: {
          type: "terminal.opened",
          requestId: reopen.requestId,
          terminalId: reopen.terminalId,
          shell: "/bin/zsh",
          title: "zsh",
          initialCwd: "/tmp/native-workspace",
          cols: reopen.cols,
          rows: reopen.rows,
        },
      });
      terminals.handleDaemonTerminalMessage({
        hostId: fixture.hostId,
        sessionId,
        message: {
          type: "terminal.exited",
          terminalId: reopen.terminalId,
          exitCode: 0,
          closeReason: "process-exit",
        },
      });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(interruptionReasons(fixture, running.thread.id)).toEqual([
        "host-daemon-restarted",
      ]);
      expect(
        daemonMessages(socket).filter(
          (message) => message.type === "terminal.open",
        ),
      ).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(interruptionReasons(fixture, running.thread.id)).toEqual([
        "host-daemon-restarted",
      ]);
    } finally {
      vi.useRealTimers();
    }
  }, 60_000);

  it("does not interrupt a reattached native thread whose terminal is closed for a reason other than the process exiting", async () => {
    const { fixture, running, sessionId, socket } =
      await restartWithFailingReattach(() => null);
    try {
      let reopen: TerminalOpenMessage | undefined;
      for (let step = 0; step < 400 && reopen === undefined; step += 1) {
        await vi.advanceTimersByTimeAsync(50);
        reopen = daemonMessages(socket).find(
          (message): message is TerminalOpenMessage =>
            message.type === "terminal.open",
        );
      }
      if (reopen === undefined) throw new Error("reattach never opened");
      const terminals = fixture.harness.deps.terminalSessions;
      terminals.handleDaemonTerminalMessage({
        hostId: fixture.hostId,
        sessionId,
        message: {
          type: "terminal.opened",
          requestId: reopen.requestId,
          terminalId: reopen.terminalId,
          shell: "/bin/zsh",
          title: "zsh",
          initialCwd: "/tmp/native-workspace",
          cols: reopen.cols,
          rows: reopen.rows,
        },
      });
      await vi.advanceTimersByTimeAsync(100);
      terminals.handleDaemonTerminalMessage({
        hostId: fixture.hostId,
        sessionId,
        message: {
          type: "terminal.exited",
          terminalId: reopen.terminalId,
          exitCode: null,
          closeReason: "user",
        },
      });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(getThread(fixture.harness.db, running.thread.id)?.status).toBe(
        "active",
      );
      expect(interruptionReasons(fixture, running.thread.id)).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  }, 60_000);

  it.each([
    [
      "an unlisted 4xx ApiError",
      () => new ApiError(400, "invalid_request", "Bad"),
    ],
    ["an ordinary Error", () => new Error("boom")],
  ])(
    "retries %s until the deadline and then interrupts exactly once",
    async (_name, makeError) => {
      const { fixture, running, attempts } =
        await restartWithFailingReattach(makeError);
      try {
        await vi.advanceTimersByTimeAsync(44_000);
        expect(getThread(fixture.harness.db, running.thread.id)?.status).toBe(
          "active",
        );
        expect(interruptionReasons(fixture, running.thread.id)).toEqual([]);
        expect(attempts()).toBeGreaterThan(5);

        await vi.advanceTimersByTimeAsync(2_000);
        expect(interruptionReasons(fixture, running.thread.id)).toEqual([
          "host-daemon-restarted",
        ]);
        await vi.advanceTimersByTimeAsync(120_000);
        expect(interruptionReasons(fixture, running.thread.id)).toEqual([
          "host-daemon-restarted",
        ]);
      } finally {
        vi.useRealTimers();
      }
    },
    60_000,
  );

  it("does not start another reattach after the deadline and discards one that resolves late", async () => {
    let releaseHeld: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      releaseHeld = resolve;
    });
    let attempts = 0;
    const { fixture, running, sessionId, socket } =
      await restartDaemonWithRunningNativeThread("instance-restarted", {
        beforeRestart: (beforeFixture) => {
          vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
          const terminals = beforeFixture.harness.deps.terminalSessions;
          const createTerminal = terminals.createTerminal.bind(terminals);
          vi.spyOn(terminals, "createTerminal").mockImplementation(
            async (createArgs) => {
              attempts += 1;
              if (attempts < 23) {
                throw new ApiError(502, "host_disconnected", "Host is gone");
              }
              await held;
              return createTerminal(createArgs);
            },
          );
        },
      });
    try {
      await vi.advanceTimersByTimeAsync(44_500);
      expect(attempts).toBe(23);
      expect(interruptionReasons(fixture, running.thread.id)).toEqual([]);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(interruptionReasons(fixture, running.thread.id)).toEqual([
        "host-daemon-restarted",
      ]);

      releaseHeld();
      let late: TerminalOpenMessage | undefined;
      for (let step = 0; step < 400 && late === undefined; step += 1) {
        await vi.advanceTimersByTimeAsync(50);
        late = daemonMessages(socket).find(
          (message): message is TerminalOpenMessage =>
            message.type === "terminal.open",
        );
      }
      if (late === undefined) throw new Error("held attempt never opened");
      fixture.harness.deps.terminalSessions.handleDaemonTerminalMessage({
        hostId: fixture.hostId,
        sessionId,
        message: {
          type: "terminal.opened",
          requestId: late.requestId,
          terminalId: late.terminalId,
          shell: "/bin/zsh",
          title: "zsh",
          initialCwd: "/tmp/native-workspace",
          cols: late.cols,
          rows: late.rows,
        },
      });
      await vi.advanceTimersByTimeAsync(60_000);

      expect(attempts).toBe(23);
      expect(
        daemonMessages(socket).filter(
          (message) => message.type === "terminal.open",
        ),
      ).toHaveLength(1);
      expect(
        daemonMessages(socket).some(
          (message) =>
            message.type === "terminal.close" &&
            message.terminalId === late.terminalId,
        ),
      ).toBe(true);
      expect(interruptionReasons(fixture, running.thread.id)).toEqual([
        "host-daemon-restarted",
      ]);
      expect(getThread(fixture.harness.db, running.thread.id)?.status).not.toBe(
        "active",
      );
    } finally {
      vi.useRealTimers();
    }
  }, 60_000);

  it("discards a reattach that resolves past the monotonic deadline before the deadline timer runs, and interrupts exactly once", async () => {
    const sourceRegistry = await createTestProviderRegistry();
    const registration = sourceRegistry.get("claude-code");
    if (registration === null) throw new Error("claude-code is not seeded");
    let now = 0;
    try {
      const { fixture, lateProviders, running, sessionId, socket } =
        await restartDaemonWithRunningNativeThread("instance-restarted", {
          beforeRestart: () => {
            vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
          },
          deferProviders: true,
          useMigratedMemoryDb: true,
        });
      void reopenNativeTerminalsAfterDaemonReconnect(
        fixture.harness.deps,
        { hostId: fixture.hostId, threadIds: [running.thread.id] },
        () => now,
      );
      lateProviders?.register(registration);
      let opening: TerminalOpenMessage | undefined;
      for (let step = 0; step < 400 && opening === undefined; step += 1) {
        await vi.advanceTimersByTimeAsync(5);
        opening = daemonMessages(socket).find(
          (message): message is TerminalOpenMessage =>
            message.type === "terminal.open",
        );
      }
      if (opening === undefined) throw new Error("reattach never opened");
      now = 45_001;
      fixture.harness.deps.terminalSessions.handleDaemonTerminalMessage({
        hostId: fixture.hostId,
        sessionId,
        message: {
          type: "terminal.opened",
          requestId: opening.requestId,
          terminalId: opening.terminalId,
          shell: "/bin/zsh",
          title: "zsh",
          initialCwd: "/tmp/native-workspace",
          cols: opening.cols,
          rows: opening.rows,
        },
      });
      for (let step = 0; step < 40; step += 1) {
        await vi.advanceTimersByTimeAsync(50);
        if (
          daemonMessages(socket).some(
            (message) =>
              message.type === "terminal.close" &&
              message.terminalId === opening.terminalId,
          )
        ) {
          break;
        }
      }

      expect(
        daemonMessages(socket).some(
          (message) =>
            message.type === "terminal.close" &&
            message.terminalId === opening.terminalId,
        ),
      ).toBe(true);
      expect(interruptionReasons(fixture, running.thread.id)).toEqual([
        "host-daemon-restarted",
      ]);
      expect(getThread(fixture.harness.db, running.thread.id)?.status).not.toBe(
        "active",
      );

      await vi.advanceTimersByTimeAsync(60_000);
      expect(interruptionReasons(fixture, running.thread.id)).toEqual([
        "host-daemon-restarted",
      ]);
      expect(
        daemonMessages(socket).filter(
          (message) => message.type === "terminal.open",
        ),
      ).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  }, 60_000);

  it("keeps a late reconnect open under the newer reconnect epoch and deadline", async () => {
    let createStarted!: () => void;
    let releaseCreate!: () => void;
    let restoreTimers = false;
    let now = 0;
    let createSpy: ReturnType<typeof vi.spyOn> | undefined;
    const createEntered = new Promise<void>((resolve) => {
      createStarted = resolve;
    });
    const createGate = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    try {
      const { fixture, running, sessionId, socket } =
        await restartDaemonWithRunningNativeThread("instance-restarted", {
          beforeRestart: () => {
            vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
            restoreTimers = true;
          },
          useMigratedMemoryDb: true,
        });
      const terminals = fixture.harness.deps.terminalSessions;
      const createTerminal = terminals.createTerminal.bind(terminals);
      createSpy = vi
        .spyOn(terminals, "createTerminal")
        .mockImplementation(async (args) => {
          const opened = createTerminal(args);
          createStarted();
          await createGate;
          return opened;
        });
      const firstReconnect = reopenNativeTerminalsAfterDaemonReconnect(
        fixture.harness.deps,
        { hostId: fixture.hostId, threadIds: [running.thread.id] },
        () => now,
      );
      await createEntered;
      let openMessage: TerminalOpenMessage | undefined;
      for (let step = 0; step < 20 && openMessage === undefined; step += 1) {
        await vi.advanceTimersByTimeAsync(5);
        openMessage = daemonMessages(socket).find(
          (message): message is TerminalOpenMessage =>
            message.type === "terminal.open",
        );
      }
      if (openMessage === undefined) throw new Error("reconnect never opened");

      now = 20_000;
      const secondReconnect = reopenNativeTerminalsAfterDaemonReconnect(
        fixture.harness.deps,
        { hostId: fixture.hostId, threadIds: [running.thread.id] },
        () => now,
      );
      now = 45_001;

      fixture.harness.deps.terminalSessions.handleDaemonTerminalMessage({
        hostId: fixture.hostId,
        sessionId,
        message: {
          type: "terminal.opened",
          requestId: openMessage.requestId,
          terminalId: openMessage.terminalId,
          shell: "/bin/zsh",
          title: "zsh",
          initialCwd: "/tmp/native-workspace",
          cols: openMessage.cols,
          rows: openMessage.rows,
        },
      });
      releaseCreate();
      await vi.advanceTimersByTimeAsync(65_001);
      await Promise.all([firstReconnect, secondReconnect]);

      expect(createSpy).toHaveBeenCalledTimes(1);
      expect(
        daemonMessages(socket).filter(
          (message) => message.type === "terminal.open",
        ),
      ).toHaveLength(1);
      expect(
        daemonMessages(socket).some(
          (message) =>
            message.type === "terminal.close" &&
            message.terminalId === openMessage.terminalId,
        ),
      ).toBe(false);
      expect(getThread(fixture.harness.db, running.thread.id)?.status).toBe(
        "active",
      );
      expect(interruptionReasons(fixture, running.thread.id)).toEqual([]);

      now = 65_001;
      expect(interruptionReasons(fixture, running.thread.id)).toEqual([]);
      expect(getThread(fixture.harness.db, running.thread.id)?.status).toBe(
        "active",
      );
      expect(interruptionReasons(fixture, running.thread.id)).toEqual([]);
    } finally {
      createSpy?.mockRestore();
      if (restoreTimers) vi.useRealTimers();
    }
  }, 60_000);

  it("never starts an attempt once the monotonic clock has reached the deadline, even though the deadline timer has not fired", async () => {
    const sourceRegistry = await createTestProviderRegistry();
    const registration = sourceRegistry.get("claude-code");
    if (registration === null) throw new Error("claude-code is not seeded");
    let now = 0;
    let attempts = 0;
    try {
      const { fixture, lateProviders, running, socket } =
        await restartDaemonWithRunningNativeThread("instance-restarted", {
          beforeRestart: () => {
            vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
          },
          deferProviders: true,
        });
      vi.spyOn(
        fixture.harness.deps.terminalSessions,
        "createTerminal",
      ).mockImplementation(async () => {
        attempts += 1;
        now = 45_000;
        throw new ApiError(502, "host_disconnected", "Host is gone");
      });
      const reopening = reopenNativeTerminalsAfterDaemonReconnect(
        fixture.harness.deps,
        { hostId: fixture.hostId, threadIds: [running.thread.id] },
        () => now,
      );
      lateProviders?.register(registration);
      let finished = false;
      void reopening.then(() => {
        finished = true;
      });
      for (let step = 0; step < 100 && !finished; step += 1) {
        await vi.advanceTimersByTimeAsync(100);
      }
      expect(finished).toBe(true);

      expect(attempts).toBe(1);
      expect(interruptionReasons(fixture, running.thread.id)).toEqual([
        "host-daemon-restarted",
      ]);

      await vi.advanceTimersByTimeAsync(60_000);
      expect(attempts).toBe(1);
      expect(interruptionReasons(fixture, running.thread.id)).toEqual([
        "host-daemon-restarted",
      ]);
      expect(
        daemonMessages(socket).filter(
          (message) => message.type === "terminal.open",
        ),
      ).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  }, 60_000);

  it("retries a cancelled reattach open that did not come from the terminal exiting and interrupts only at the deadline", async () => {
    const { fixture, running, attempts } = await restartWithFailingReattach(
      () => new ApiError(409, "terminal_open_cancelled", "Cancelled"),
    );
    try {
      await vi.advanceTimersByTimeAsync(20_000);
      expect(getThread(fixture.harness.db, running.thread.id)?.status).toBe(
        "active",
      );
      expect(interruptionReasons(fixture, running.thread.id)).toEqual([]);
      expect(attempts()).toBeGreaterThan(2);

      await vi.advanceTimersByTimeAsync(27_000);
      expect(interruptionReasons(fixture, running.thread.id)).toEqual([
        "host-daemon-restarted",
      ]);
    } finally {
      vi.useRealTimers();
    }
  }, 60_000);

  it.each(["ENOENT", "ECONNREFUSED"])(
    "treats a %s failure of the reattach open as transient and interrupts only at the deadline",
    async (code) => {
      const { fixture, running, attempts } = await restartWithFailingReattach(
        () => Object.assign(new Error(`connect ${code}`), { code }),
      );
      try {
        await vi.advanceTimersByTimeAsync(44_000);
        expect(getThread(fixture.harness.db, running.thread.id)?.status).toBe(
          "active",
        );
        expect(interruptionReasons(fixture, running.thread.id)).toEqual([]);
        expect(attempts()).toBeGreaterThan(1);

        await vi.advanceTimersByTimeAsync(2_000);
        expect(interruptionReasons(fixture, running.thread.id)).toEqual([
          "host-daemon-restarted",
        ]);
      } finally {
        vi.useRealTimers();
      }
    },
    60_000,
  );

  it("gives an explicit open its own launch when it overlaps a reconnect reopen", async () => {
    const fixture = await createFixture();
    const lost = await openRunningNativeThread(fixture, {
      providerId: "claude-code",
    });
    fixture.harness.deps.terminalSessions.handleDaemonSessionClosed({
      sessionId: fixture.sessionId,
    });
    const restarted = seedSession(fixture.harness.deps, fixture.hostId, {
      instanceId: "instance-2",
    });
    const socket = createFakeDaemonSocket();
    onDaemonSocketOpen(fixture.harness.deps, {
      hostId: fixture.hostId,
      sessionId: restarted.id,
      socket,
    });
    const acknowledge = (open: TerminalOpenMessage) =>
      fixture.harness.deps.terminalSessions.handleDaemonTerminalMessage({
        hostId: fixture.hostId,
        sessionId: restarted.id,
        message: {
          type: "terminal.opened",
          requestId: open.requestId,
          terminalId: open.terminalId,
          shell: "/bin/zsh",
          title: "zsh",
          initialCwd: "/tmp/native-workspace",
          cols: open.cols,
          rows: open.rows,
        },
      });
    const reattach = await waitForTerminalOpen(socket);
    expect(
      reattach.start.mode === "command" && reattach.start.command,
    ).toContain("native-run " + lost.thread.id + " --reattach");

    const explicit = postJson(
      fixture,
      `/threads/${lost.thread.id}/native-terminal/open`,
      {},
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    acknowledge(reattach);
    const launch = await waitForTerminalOpen(socket, 1);
    expect(launch.start.mode === "command" && launch.start.command).toContain(
      `"$BB_CLI" thread native-run ${lost.thread.id}`,
    );
    expect(
      launch.start.mode === "command" && launch.start.command,
    ).not.toContain("--reattach");
    acknowledge(launch);

    const opened = nativeTerminalThreadSchema.parse(
      await readJson(await explicit),
    );
    expect(opened.terminal?.id).toBe(launch.terminalId);
    expect(
      getNativeTerminalThread(fixture.harness.db, lost.thread.id)
        ?.terminalSessionId,
    ).toBe(launch.terminalId);
  });

  it("keeps the same native terminal when the same daemon reconnects", async () => {
    const fixture = await createFixture();
    const { open, thread } = await openRunningNativeThread(fixture, {
      providerId: "claude-code",
    });
    fixture.harness.deps.terminalSessions.handleDaemonSessionClosed({
      sessionId: fixture.sessionId,
    });
    const reconnected = seedSession(fixture.harness.deps, fixture.hostId);
    const socket = createFakeDaemonSocket();
    onDaemonSocketOpen(fixture.harness.deps, {
      hostId: fixture.hostId,
      sessionId: reconnected.id,
      socket,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(
      daemonMessages(socket).filter(
        (message) => message.type === "terminal.open",
      ),
    ).toEqual([]);
    expect(
      getNativeTerminalThread(fixture.harness.db, thread.id)?.terminalSessionId,
    ).toBe(open.terminalId);
    expect(
      getTerminalSession(fixture.harness.db, {
        kind: "terminal",
        terminalId: open.terminalId,
      })?.status,
    ).toBe("running");
  });
});
