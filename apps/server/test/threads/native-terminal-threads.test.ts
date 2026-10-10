import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { getNativeTerminalThread, getThread, listEvents } from "@bb/db";
import {
  hostDaemonServerWsMessageSchema,
  type HostDaemonServerWsMessage,
} from "@bb/host-daemon-contract";
import {
  apiErrorSchema,
  nativeTerminalLaunchSpecSchema,
  nativeTerminalThreadSchema,
  threadResponseSchema,
} from "@bb/server-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import { queueParentSystemMessage } from "../../src/services/threads/parent-system-messages.js";
import { sendThreadMessage } from "../../src/services/threads/thread-send.js";
import { readJson } from "../helpers/json.js";
import { textInput } from "../helpers/prompt-input.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
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

afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.cleanup();
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

async function createFixture(): Promise<Fixture> {
  const harness = await createTestAppHarness();
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

async function postJson(
  fixture: Fixture,
  path: string,
  body: unknown,
): Promise<Response> {
  return fixture.harness.app.request(`/api/v1${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function createNativeThread(
  fixture: Fixture,
  args: { providerId: string; prompt?: string },
) {
  const response = await postJson(fixture, "/threads", {
    projectId: fixture.projectId,
    providerId: args.providerId,
    origin: "cli",
    input: args.prompt === undefined ? [] : textInput(args.prompt),
    environment: { type: "reuse", environmentId: fixture.environment.id },
    nativeTerminal: true,
  });
  expect(response.status).toBe(201);
  return threadResponseSchema.parse(await readJson(response));
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
  args: { providerId: string; prompt?: string },
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

describe("native terminal threads", () => {
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
      expect(run(legacy)).toBe(`bare ${thread.id}`);
      expect(run(null)).toBe(`bare ${thread.id}`);
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
    expect(record?.harness).toBe("claude");
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
    expect(first.harness).toBe("claude");
    expect(first.nativeSessionId).not.toBeNull();
    expect(second.initialPrompt).toBeNull();
    expect(second.nativeSessionId).toBe(first.nativeSessionId);
  });

  it("delivers sent messages to the running terminal as a bracketed paste", async () => {
    const fixture = await createFixture();
    const { open, thread } = await openRunningNativeThread(fixture, {
      providerId: "codex",
    });
    const response = await postJson(fixture, `/threads/${thread.id}/send`, {
      input: textInput("run the tests"),
      mode: "auto",
    });
    expect(response.status).toBe(200);
    const inputs = daemonMessages(fixture.socket)
      .filter((message) => message.type === "terminal.input")
      .map((message) =>
        message.type === "terminal.input"
          ? {
              terminalId: message.terminalId,
              text: Buffer.from(message.dataBase64, "base64").toString("utf8"),
            }
          : null,
      );
    expect(inputs).toEqual([
      {
        terminalId: open.terminalId,
        text: "\u001b[200~run the tests\u001b[201~",
      },
      { terminalId: open.terminalId, text: "\r" },
    ]);
    expect(
      listEvents(fixture.harness.db, { threadId: thread.id }).some(
        (event) => event.type === "client/turn/requested",
      ),
    ).toBe(false);
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

  it("binds a discovered codex session to exactly one thread", async () => {
    const fixture = await createFixture();
    const first = await openRunningNativeThread(fixture, {
      providerId: "codex",
    });
    const second = await createNativeThread(fixture, { providerId: "codex" });
    const sessionId = "01a1246a-b896-7b71-9895-ce5345f5f623";

    const recorded = await postJson(
      fixture,
      `/threads/${first.thread.id}/native-terminal/session`,
      { nativeSessionId: sessionId },
    );
    expect(recorded.status).toBe(200);
    expect(
      nativeTerminalThreadSchema.parse(await readJson(recorded))
        .nativeSessionId,
    ).toBe(sessionId);

    const stolen = await postJson(
      fixture,
      `/threads/${second.id}/native-terminal/session`,
      { nativeSessionId: sessionId },
    );
    expect(stolen.status).toBe(409);

    const rebound = await postJson(
      fixture,
      `/threads/${first.thread.id}/native-terminal/session`,
      { nativeSessionId: "11111111-2222-3333-4444-555555555555" },
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
});
