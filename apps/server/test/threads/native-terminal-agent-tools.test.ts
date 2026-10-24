import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  createTerminalSession,
  getEnvironment,
  getNativeTerminalThread,
  getThread,
  setNativeTerminalThreadTerminal,
  setNativeTerminalToolCredential,
  threads,
} from "@bb/db";
import { applyLoggedThreadLifecycleEvent } from "../../src/services/threads/lifecycle-outcome.js";
import { buildThreadStatusChangeMetadata } from "../../src/services/threads/thread-runtime-display.js";
import * as runtimeConfig from "../../src/services/threads/thread-runtime-config.js";
import {
  nativeTerminalAgentToolsSchema,
  nativeTerminalLaunchSpecSchema,
  threadResponseSchema,
} from "@bb/server-contract";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildExecutionOptions,
  prepareTurnSubmitCommandPayload,
} from "../../src/services/threads/thread-commands.js";
import { UPDATE_ENVIRONMENT_DIRECTORY_TOOL_NAME } from "../../src/services/threads/thread-environment-directory.js";
import {
  internalAuthHeaders,
  registerTestHostRpcCapture,
} from "../helpers/commands.js";
import { readJson } from "../helpers/json.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
} from "../helpers/seed.js";
import {
  createTestAppHarness,
  type TestAppHarness,
} from "../helpers/test-app.js";

interface Fixture {
  environmentId: string;
  harness: TestAppHarness;
  hostId: string;
  pluginsDir: string;
  projectId: string;
  sessionId: string;
  terminalOpens: {
    credential: string | null;
    requestId: string;
    terminalId: string;
  }[];
  credentials: Map<string, string>;
}

const harnesses: TestAppHarness[] = [];
const pluginDirs: string[] = [];

afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.cleanup();
  for (const dir of pluginDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

const PLUGIN_SOURCE = `
  export default function plugin(bb: any) {
    bb.agents.registerTool({
      name: "echo_context",
      description: "Echo params and call context",
      parameters: { type: "object" },
      execute: (params: any, ctx: any) =>
        (globalThis.__nativeToolCalls = (globalThis.__nativeToolCalls ?? 0) + 1,
        "thread=" + ctx.threadId +
        " project=" + ctx.projectId +
        " params=" + JSON.stringify(params)),
    });
    bb.agents.registerTool({
      name: "unselected_tool",
      description: "Registered but never selected",
      parameters: { type: "object" },
      execute: () => "must not run",
    });
    bb.agents.configure(() => ({ tools: ["echo_context"], skills: [] }));
  }
`;

async function createFixture(): Promise<Fixture> {
  const harness = await createTestAppHarness();
  harnesses.push(harness);
  const pluginsDir = await mkdtemp(join(tmpdir(), "bb-native-tools-"));
  pluginDirs.push(pluginsDir);
  const rootDir = join(pluginsDir, "bb-plugin-native-tools");
  await mkdir(rootDir, { recursive: true });
  await writeFile(
    join(rootDir, "package.json"),
    JSON.stringify({
      name: "bb-plugin-native-tools",
      version: "0.1.0",
      bb: {
        name: "Native tools fixture",
        description: "Agent tool fixture.",
        branding: { icon: "Zap" },
        server: "./server.ts",
      },
    }),
  );
  await writeFile(join(rootDir, "server.ts"), PLUGIN_SOURCE);
  expect((await harness.pluginService.installPath(rootDir)).status).toBe(
    "running",
  );
  const seeded = seedHostSession(harness.deps, { id: "native-tools-host" });
  const { project } = seedProjectWithSource(harness.deps, {
    hostId: seeded.host.id,
    path: "/tmp/native-tools-project",
  });
  const environment = seedEnvironment(harness.deps, {
    hostId: seeded.host.id,
    path: "/tmp/native-tools-workspace",
    projectId: project.id,
    status: "ready",
  });
  const terminalOpens: Fixture["terminalOpens"] = [];
  harness.hub.registerDaemon(seeded.session.id, seeded.host.id, {
    close: vi.fn(),
    send: vi.fn((data: string) => {
      const message = JSON.parse(data) as {
        contributedEnv?: { name: string; value: unknown }[];
        requestId?: string;
        terminalId?: string;
        type: string;
      };
      if (
        message.type === "terminal.open" &&
        message.terminalId &&
        message.requestId
      ) {
        const env = message.contributedEnv?.find(
          (entry) => entry.name === "BB_NATIVE_TOOL_CREDENTIAL",
        );
        terminalOpens.push({
          credential: typeof env?.value === "string" ? env.value : null,
          requestId: message.requestId,
          terminalId: message.terminalId,
        });
      }
    }),
  });
  return {
    environmentId: environment.id,
    harness,
    hostId: seeded.host.id,
    pluginsDir,
    projectId: project.id,
    sessionId: seeded.session.id,
    terminalOpens,
    credentials: new Map(),
  };
}

async function createNativeThread(fixture: Fixture): Promise<string> {
  const response = await fixture.harness.app.request("/api/v1/threads", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      projectId: fixture.projectId,
      providerId: "claude-code",
      origin: "cli",
      input: [],
      environment: { type: "reuse", environmentId: fixture.environmentId },
      nativeTerminal: true,
    }),
  });
  expect(response.status).toBe(201);
  const thread = threadResponseSchema.parse(await readJson(response));
  const opensBefore = fixture.credentials.size;
  for (let attempt = 0; attempt < 600; attempt += 1) {
    if (fixture.terminalOpens.length > opensBefore) break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const open = fixture.terminalOpens[opensBefore];
  if (open === undefined) throw new Error("terminal never opened");
  const terminalId = open.terminalId;
  fixture.harness.deps.terminalSessions.handleDaemonTerminalMessage({
    hostId: fixture.hostId,
    sessionId: fixture.sessionId,
    message: {
      type: "terminal.opened",
      requestId: open.requestId,
      terminalId,
      shell: "/bin/zsh",
      title: "zsh",
      initialCwd: "/tmp/native-tools-workspace",
      cols: 80,
      rows: 24,
    },
  });
  for (let attempt = 0; attempt < 600; attempt += 1) {
    if (
      getNativeTerminalThread(fixture.harness.db, thread.id)
        ?.terminalSessionId === terminalId
    ) {
      if (open.credential === null) throw new Error("no credential");
      fixture.credentials.set(thread.id, open.credential);
      return thread.id;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("terminal never bound");
}

function authHeaders(
  fixture: Fixture,
  threadId: string,
): Record<string, string> {
  const credential = fixture.credentials.get(threadId);
  return credential === undefined
    ? {}
    : { authorization: `Bearer ${credential}` };
}

type Surface = "native-terminal" | "chat-internal";

interface ToolResponse {
  contentItems: { type: string; text?: string }[];
  success: boolean;
}

async function callTool(
  fixture: Fixture,
  surface: Surface,
  threadId: string,
  tool: string,
  args: unknown,
): Promise<ToolResponse> {
  const response =
    surface === "native-terminal"
      ? await fixture.harness.app.request(
          `/api/v1/threads/${threadId}/native-terminal/agent-tools/${tool}/call`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              ...authHeaders(fixture, threadId),
            },
            body: JSON.stringify({ callId: "call-1", arguments: args }),
          },
        )
      : await fixture.harness.app.request("/internal/session/tool-call", {
          method: "POST",
          headers: internalAuthHeaders(fixture.harness),
          body: JSON.stringify({
            sessionId: fixture.sessionId,
            threadId,
            providerThreadId: "provider-thread",
            turnId: "turn-1",
            callId: "call-1",
            tool,
            arguments: args,
          }),
        });
  expect(response.status).toBe(200);
  return (await readJson(response)) as ToolResponse;
}

describe("native terminal agent tools", () => {
  it("gives a native terminal the same tool results as the chat tool-call path", async () => {
    const fixture = await createFixture();
    const threadId = await createNativeThread(fixture);
    const table: { args: unknown; tool: string }[] = [
      { tool: "echo_context", args: { foo: 1 } },
      { tool: "echo_context", args: {} },
    ];
    for (const row of table) {
      const native = await callTool(
        fixture,
        "native-terminal",
        threadId,
        row.tool,
        row.args,
      );
      const chat = await callTool(
        fixture,
        "chat-internal",
        threadId,
        row.tool,
        row.args,
      );
      expect(native).toEqual(chat);
    }
    const echo = await callTool(
      fixture,
      "native-terminal",
      threadId,
      "echo_context",
      { foo: 1 },
    );
    expect(echo.success).toBe(true);
    expect(echo.contentItems[0]?.text).toContain(`thread=${threadId}`);
  });

  it("lists the tools a chat turn on the same thread receives", async () => {
    const fixture = await createFixture();
    const threadId = await createNativeThread(fixture);
    const listed = nativeTerminalAgentToolsSchema.parse(
      await readJson(
        await fixture.harness.app.request(
          `/api/v1/threads/${threadId}/native-terminal/agent-tools`,
          { headers: authHeaders(fixture, threadId) },
        ),
      ),
    );
    const thread = fixture.harness.db
      .select()
      .from(threads)
      .where(eq(threads.id, threadId))
      .get();
    if (thread === undefined) throw new Error("thread missing");
    fixture.harness.hub.unregisterDaemon(fixture.sessionId);
    registerTestHostRpcCapture(fixture.harness, {
      hostId: fixture.hostId,
      sessionId: fixture.sessionId,
    });
    const environment = getEnvironment(
      fixture.harness.db,
      thread.environmentId ?? "",
    );
    if (environment === null) throw new Error("environment missing");
    const execution = await buildExecutionOptions(
      fixture.harness.deps,
      { model: "claude-sonnet-5-5" },
      { threadId },
    );
    const chatTools = (
      await prepareTurnSubmitCommandPayload(fixture.harness.deps, {
        environment,
        execution,
        permissionEscalation: "ask",
        input: [],
        providerThreadId: "provider-thread",
        target: { mode: "start" },
        thread,
      })
    ).resumeContext.dynamicTools;
    expect(listed.tools.map((tool) => tool.name)).toEqual(
      chatTools
        .map((tool) => tool.name)
        .filter((name) => name !== UPDATE_ENVIRONMENT_DIRECTORY_TOOL_NAME),
    );
    expect(listed.tools.map((tool) => tool.name)).toContain("echo_context");
  });

  it("rejects a tool outside the thread's resolved list without invoking it", async () => {
    const fixture = await createFixture();
    const threadId = await createNativeThread(fixture);
    for (const tool of [
      "unselected_tool",
      UPDATE_ENVIRONMENT_DIRECTORY_TOOL_NAME,
    ]) {
      const response = await fixture.harness.app.request(
        `/api/v1/threads/${threadId}/native-terminal/agent-tools/${tool}/call`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...authHeaders(fixture, threadId),
          },
          body: JSON.stringify({ callId: "c", arguments: {} }),
        },
      );
      expect(response.status).toBe(404);
    }
  });

  describe("tool-call evidence", () => {
    const SESSION = "0a1b2c3d-1111-2222-3333-444455556666";

    const setSession = (
      fixture: Fixture,
      threadId: string,
      sessionId: string | null,
    ) =>
      fixture.harness.db.$client
        .prepare(
          "UPDATE fork_native_terminal_threads SET native_session_id = ? WHERE thread_id = ?",
        )
        .run(sessionId, threadId);

    const bindSession = async (
      fixture: Fixture,
      threadId: string,
      sessionId = SESSION,
    ) => {
      setSession(fixture, threadId, sessionId);
    };

    async function markWorking(fixture: Fixture, threadId: string) {
      applyLoggedThreadLifecycleEvent(fixture.harness.deps, {
        event: { type: "run.started" },
        threadId,
      });
    }

    const callTool = (
      fixture: Fixture,
      threadId: string,
      headers: Record<string, string>,
    ) =>
      fixture.harness.app.request(
        `/api/v1/threads/${threadId}/native-terminal/agent-tools/echo_context/call`,
        {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body: JSON.stringify({ callId: "c", arguments: {} }),
        },
      );

    const record = (fixture: Fixture, threadId: string) =>
      getNativeTerminalThread(fixture.harness.db, threadId);

    const display = (fixture: Fixture, threadId: string) => {
      const thread = getThread(fixture.harness.db, threadId);
      if (thread === null) throw new Error("thread missing");
      return buildThreadStatusChangeMetadata(fixture.harness.deps, thread)
        .statusChange?.runtime.nativeActivity;
    };

    it("is recorded as its own evidence type, never as a holder report or working", async () => {
      const fixture = await createFixture();
      const threadId = await createNativeThread(fixture);
      await bindSession(fixture, threadId);
      await markWorking(fixture, threadId);
      const clock = vi.spyOn(Date, "now").mockReturnValue(5_000_000);
      try {
        expect((await callTool(fixture, threadId, {})).status).toBe(401);
        expect(
          (
            await callTool(fixture, threadId, {
              authorization: "Bearer not-the-credential",
            })
          ).status,
        ).toBe(401);
        expect(record(fixture, threadId)?.lastToolCallAt).toBeNull();
        expect(display(fixture, threadId)).toMatchObject({
          confirmation: "unconfirmed",
          evidenceKind: "unknown",
        });

        expect(
          (await callTool(fixture, threadId, authHeaders(fixture, threadId)))
            .status,
        ).toBe(200);
        expect(record(fixture, threadId)).toMatchObject({
          lastEvidenceAt: null,
          lastToolCallAt: 5_000_000,
          lastToolCallSessionId: SESSION,
        });
        expect(display(fixture, threadId)).toMatchObject({
          confirmation: "unconfirmed",
          evidenceKind: "tool-call",
          lastEvidenceAt: null,
          lastToolCallAt: 5_000_000,
        });
      } finally {
        clock.mockRestore();
      }
    });

    it("notifies clients again once the previous call is older than a heartbeat, not on every call", async () => {
      const fixture = await createFixture();
      const threadId = await createNativeThread(fixture);
      await bindSession(fixture, threadId);
      await markWorking(fixture, threadId);
      const notify = vi.spyOn(fixture.harness.hub, "notifyThread");
      const clock = vi.spyOn(Date, "now").mockReturnValue(8_000_000);
      const statusChanges = () =>
        notify.mock.calls.filter(
          (call) => call[0] === threadId && call[1].includes("status-changed"),
        ).length;
      try {
        await callTool(fixture, threadId, authHeaders(fixture, threadId));
        const afterFirst = statusChanges();
        expect(afterFirst).toBeGreaterThan(0);
        clock.mockReturnValue(8_010_000);
        await callTool(fixture, threadId, authHeaders(fixture, threadId));
        expect(statusChanges()).toBe(afterFirst);
        clock.mockReturnValue(8_031_000);
        await callTool(fixture, threadId, authHeaders(fixture, threadId));
        expect(statusChanges()).toBeGreaterThan(afterFirst);
      } finally {
        clock.mockRestore();
        notify.mockRestore();
      }
    });

    it("expires with the freshness window", async () => {
      const fixture = await createFixture();
      const threadId = await createNativeThread(fixture);
      await bindSession(fixture, threadId);
      await markWorking(fixture, threadId);
      const clock = vi.spyOn(Date, "now").mockReturnValue(5_000_000);
      try {
        await callTool(fixture, threadId, authHeaders(fixture, threadId));
        clock.mockReturnValue(5_090_000);
        expect(display(fixture, threadId)).toMatchObject({
          evidenceKind: "tool-call",
        });
        clock.mockReturnValue(5_090_001);
        expect(display(fixture, threadId)).toMatchObject({
          confirmation: "unconfirmed",
          evidenceKind: "unknown",
        });
      } finally {
        clock.mockRestore();
      }
    });

    it("does not cross threads", async () => {
      const fixture = await createFixture();
      const first = await createNativeThread(fixture);
      const second = await createNativeThread(fixture);
      await bindSession(fixture, first);
      await bindSession(
        fixture,
        second,
        "9f8e7d6c-1111-2222-3333-444455556666",
      );
      const foreign = authHeaders(fixture, second);
      expect((await callTool(fixture, first, foreign)).status).toBe(401);
      expect(record(fixture, first)?.lastToolCallAt).toBeNull();
      expect(record(fixture, second)?.lastToolCallAt).toBeNull();
      expect(
        (await callTool(fixture, second, authHeaders(fixture, second))).status,
      ).toBe(200);
      expect(record(fixture, first)?.lastToolCallAt).toBeNull();
      expect(record(fixture, second)?.lastToolCallAt).not.toBeNull();
    });

    it("is dropped on reattach, and an old-credential replay does not refresh the new terminal", async () => {
      const fixture = await createFixture();
      const threadId = await createNativeThread(fixture);
      await bindSession(fixture, threadId);
      const oldHeaders = authHeaders(fixture, threadId);
      expect((await callTool(fixture, threadId, oldHeaders)).status).toBe(200);
      expect(record(fixture, threadId)?.lastToolCallAt).not.toBeNull();

      const reattached = createTerminalSession(fixture.harness.db, {
        cols: 80,
        environmentId: fixture.environmentId,
        hostId: fixture.hostId,
        daemonSessionId: fixture.sessionId,
        initialCwd: "/tmp",
        rows: 24,
        status: "running",
        threadId,
        title: "Native terminal",
      });
      const nextCredential = "reattached-credential-for-tool-call-evidence";
      setNativeTerminalToolCredential(fixture.harness.db, {
        threadId,
        terminalSessionId: reattached.id,
        credentialHash: createHash("sha256")
          .update(nextCredential)
          .digest("hex"),
      });
      setNativeTerminalThreadTerminal(fixture.harness.db, {
        threadId,
        terminalSessionId: reattached.id,
      });
      expect(record(fixture, threadId)).toMatchObject({
        lastToolCallAt: null,
        lastToolCallSessionId: null,
      });

      expect((await callTool(fixture, threadId, oldHeaders)).status).toBe(401);
      expect(record(fixture, threadId)?.lastToolCallAt).toBeNull();

      expect(
        (
          await callTool(fixture, threadId, {
            authorization: `Bearer ${nextCredential}`,
          })
        ).status,
      ).toBe(200);
      expect(record(fixture, threadId)).toMatchObject({
        lastToolCallSessionId: SESSION,
      });
      expect(record(fixture, threadId)?.lastToolCallAt).not.toBeNull();
    });

    it("gives an old-credential call that reattach overtakes no evidence on the new terminal", async () => {
      const fixture = await createFixture();
      const threadId = await createNativeThread(fixture);
      await bindSession(fixture, threadId);
      const oldHeaders = authHeaders(fixture, threadId);
      const resolveTools = runtimeConfig.resolveThreadDynamicTools;
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let entered: () => void = () => undefined;
      const suspended = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const spy = vi
        .spyOn(runtimeConfig, "resolveThreadDynamicTools")
        .mockImplementation(async (...args) => {
          entered();
          await gate;
          return resolveTools(...args);
        });
      try {
        const inFlight = callTool(fixture, threadId, oldHeaders);
        await suspended;

        const reattached = createTerminalSession(fixture.harness.db, {
          cols: 80,
          environmentId: fixture.environmentId,
          hostId: fixture.hostId,
          daemonSessionId: fixture.sessionId,
          initialCwd: "/tmp",
          rows: 24,
          status: "running",
          threadId,
          title: "Native terminal",
        });
        setNativeTerminalToolCredential(fixture.harness.db, {
          threadId,
          terminalSessionId: reattached.id,
          credentialHash: createHash("sha256")
            .update("credential-of-the-reattached-terminal")
            .digest("hex"),
        });
        setNativeTerminalThreadTerminal(fixture.harness.db, {
          threadId,
          terminalSessionId: reattached.id,
        });
        release();

        expect((await inFlight).status).toBe(200);
        expect(spy).toHaveBeenCalledTimes(1);
        expect(record(fixture, threadId)).toMatchObject({
          terminalSessionId: reattached.id,
          lastToolCallAt: null,
          lastToolCallSessionId: null,
        });
      } finally {
        spy.mockRestore();
      }
    });

    it("returns the tool's own result when recording the evidence fails, and logs the failure", async () => {
      const fixture = await createFixture();
      const threadId = await createNativeThread(fixture);
      await bindSession(fixture, threadId);
      await markWorking(fixture, threadId);
      const baseline = await (
        await callTool(fixture, threadId, authHeaders(fixture, threadId))
      ).json();
      fixture.harness.db.$client
        .prepare(
          "UPDATE fork_native_terminal_threads SET last_tool_call_at = NULL, last_tool_call_session_id = NULL WHERE thread_id = ?",
        )
        .run(threadId);
      const warn = vi.spyOn(fixture.harness.deps.logger, "warn");
      const notify = vi
        .spyOn(fixture.harness.hub, "notifyThread")
        .mockImplementation((_threadId, kinds) => {
          if (kinds.includes("status-changed")) {
            throw new Error("notify failed");
          }
        });
      try {
        const response = await callTool(
          fixture,
          threadId,
          authHeaders(fixture, threadId),
        );
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual(baseline);
        expect(warn).toHaveBeenCalledWith(
          expect.objectContaining({ threadId }),
          "Native terminal tool-call evidence was not recorded",
        );
      } finally {
        notify.mockRestore();
        warn.mockRestore();
      }
    });

    it("binds to the provider session and records nothing while the session is unknown", async () => {
      const fixture = await createFixture();
      const threadId = await createNativeThread(fixture);
      setSession(fixture, threadId, null);
      expect(
        (await callTool(fixture, threadId, authHeaders(fixture, threadId)))
          .status,
      ).toBe(200);
      expect(record(fixture, threadId)?.lastToolCallAt).toBeNull();

      await bindSession(fixture, threadId);
      await markWorking(fixture, threadId);
      const clock = vi.spyOn(Date, "now").mockReturnValue(6_000_000);
      try {
        await callTool(fixture, threadId, authHeaders(fixture, threadId));
        expect(display(fixture, threadId)).toMatchObject({
          evidenceKind: "tool-call",
        });
        fixture.harness.db.$client
          .prepare(
            "UPDATE fork_native_terminal_threads SET native_session_id = ? WHERE thread_id = ?",
          )
          .run("11111111-2222-3333-4444-555555555555", threadId);
        expect(display(fixture, threadId)).toMatchObject({
          evidenceKind: "unknown",
        });
        expect(display(fixture, threadId)?.lastToolCallAt).toBeUndefined();
      } finally {
        clock.mockRestore();
      }
    });

    it("is not refreshed by a call after the terminal exited", async () => {
      const fixture = await createFixture();
      const threadId = await createNativeThread(fixture);
      await bindSession(fixture, threadId);
      const clock = vi.spyOn(Date, "now").mockReturnValue(7_000_000);
      try {
        await callTool(fixture, threadId, authHeaders(fixture, threadId));
        expect(record(fixture, threadId)?.lastToolCallAt).toBe(7_000_000);
        fixture.harness.deps.terminalSessions.handleDaemonTerminalMessage({
          hostId: fixture.hostId,
          sessionId: fixture.sessionId,
          message: {
            type: "terminal.exited",
            terminalId: fixture.terminalOpens[0]?.terminalId ?? "",
            exitCode: 0,
            closeReason: "process-exit",
          },
        });
        clock.mockReturnValue(7_050_000);
        expect(
          (await callTool(fixture, threadId, authHeaders(fixture, threadId)))
            .status,
        ).toBe(409);
        expect(record(fixture, threadId)?.lastToolCallAt).toBe(7_000_000);
      } finally {
        clock.mockRestore();
      }
    });
  });

  it("binds the routes to the terminal's credential", async () => {
    const fixture = await createFixture();
    const first = await createNativeThread(fixture);
    const second = await createNativeThread(fixture);
    const listPath = (id: string) =>
      `/api/v1/threads/${id}/native-terminal/agent-tools`;
    const callPath = (id: string) => `${listPath(id)}/echo_context/call`;
    const post = (id: string, headers: Record<string, string>) =>
      fixture.harness.app.request(callPath(id), {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({ callId: "c", arguments: {} }),
      });
    const invocations = () =>
      (globalThis as { __nativeToolCalls?: number }).__nativeToolCalls ?? 0;
    const before = invocations();
    const secondCredential = fixture.credentials.get(second) ?? "";
    expect((await fixture.harness.app.request(listPath(first))).status).toBe(
      401,
    );
    expect((await post(first, {})).status).toBe(401);
    expect(
      (await post(first, { authorization: "Bearer not-the-credential" }))
        .status,
    ).toBe(401);
    const foreign = { authorization: `Bearer ${secondCredential}` };
    expect(
      (await fixture.harness.app.request(listPath(first), { headers: foreign }))
        .status,
    ).toBe(401);
    expect((await post(first, foreign)).status).toBe(401);
    expect(invocations()).toBe(before);
    expect((await post(first, authHeaders(fixture, first))).status).toBe(200);
    expect(invocations()).toBe(before + 1);
    expect(
      (
        await fixture.harness.app.request(listPath(first), {
          headers: authHeaders(fixture, first),
        })
      ).status,
    ).toBe(200);
    const oldCredential = authHeaders(fixture, first);
    const launchResponse = await fixture.harness.app.request(
      `/api/v1/threads/${first}/native-terminal/launch`,
      { method: "POST" },
    );
    const launchBody = await readJson(launchResponse);
    expect(JSON.stringify(launchBody)).not.toContain(
      fixture.credentials.get(first) ?? "unreachable",
    );
    expect(launchBody).not.toHaveProperty("toolCredential");
    expect(nativeTerminalLaunchSpecSchema.safeParse(launchBody).success).toBe(
      true,
    );
    expect((await post(first, oldCredential)).status).toBe(200);

    fixture.harness.deps.terminalSessions.handleDaemonTerminalMessage({
      hostId: fixture.hostId,
      sessionId: fixture.sessionId,
      message: {
        type: "terminal.exited",
        terminalId: fixture.terminalOpens[0]?.terminalId ?? "",
        exitCode: 0,
        closeReason: "process-exit",
      },
    });
    const reopening = fixture.harness.app.request(
      `/api/v1/threads/${first}/native-terminal/open`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      },
    );
    for (let attempt = 0; attempt < 600; attempt += 1) {
      if (fixture.terminalOpens.length > 2) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const reopen = fixture.terminalOpens[2];
    if (reopen === undefined || reopen.credential === null) {
      throw new Error("terminal never reopened with a credential");
    }
    fixture.harness.deps.terminalSessions.handleDaemonTerminalMessage({
      hostId: fixture.hostId,
      sessionId: fixture.sessionId,
      message: {
        type: "terminal.opened",
        requestId: reopen.requestId,
        terminalId: reopen.terminalId,
        shell: "/bin/zsh",
        title: "zsh",
        initialCwd: "/tmp/native-tools-workspace",
        cols: 80,
        rows: 24,
      },
    });
    expect((await reopening).status).toBe(200);
    expect(reopen.credential).not.toBe(fixture.credentials.get(first));
    expect((await post(first, oldCredential)).status).toBe(401);
    expect(
      (await post(first, { authorization: `Bearer ${reopen.credential}` }))
        .status,
    ).toBe(200);
  });

  it("answers every unauthenticated caller with the same 401 whatever the thread's state", async () => {
    const fixture = await createFixture();
    const live = await createNativeThread(fixture);
    const archived = await createNativeThread(fixture);
    const exited = await createNativeThread(fixture);
    const foreign = await createNativeThread(fixture);
    const chat = seedThread(fixture.harness.deps, {
      projectId: fixture.projectId,
      environmentId: fixture.environmentId,
      status: "idle",
    });
    fixture.harness.db
      .update(threads)
      .set({ archivedAt: Date.now() })
      .where(eq(threads.id, archived))
      .run();
    fixture.harness.deps.terminalSessions.handleDaemonTerminalMessage({
      hostId: fixture.hostId,
      sessionId: fixture.sessionId,
      message: {
        type: "terminal.exited",
        terminalId:
          fixture.terminalOpens.find(
            (open) => open.credential === fixture.credentials.get(exited),
          )?.terminalId ?? "",
        exitCode: 0,
        closeReason: "process-exit",
      },
    });
    const invocations = () =>
      (globalThis as { __nativeToolCalls?: number }).__nativeToolCalls ?? 0;
    const before = invocations();
    const targets: Record<string, string> = {
      "missing thread": "thr_doesnotexist",
      "chat thread": chat.id,
      "archived native": archived,
      "exited native": exited,
      "live native": live,
    };
    const credentials: Record<string, Record<string, string>> = {
      "no credential": {},
      "wrong credential": { authorization: "Bearer not-the-credential" },
      "foreign credential": {
        authorization: `Bearer ${fixture.credentials.get(foreign) ?? ""}`,
      },
    };
    for (const [targetName, id] of Object.entries(targets)) {
      for (const [credentialName, headers] of Object.entries(credentials)) {
        const base = `/api/v1/threads/${id}/native-terminal/agent-tools`;
        const get = await fixture.harness.app.request(base, { headers });
        expect(get.status, `GET ${targetName} ${credentialName}`).toBe(401);
        const post = await fixture.harness.app.request(
          `${base}/echo_context/call`,
          {
            method: "POST",
            headers: { "content-type": "application/json", ...headers },
            body: JSON.stringify({ callId: "c", arguments: {} }),
          },
        );
        expect(post.status, `POST ${targetName} ${credentialName}`).toBe(401);
        expect(await readJson(post)).toEqual({
          code: "native_terminal_credential_invalid",
          message:
            "A valid credential for this thread's current native terminal is required",
        });
      }
    }
    expect(invocations()).toBe(before);

    const validRows: [string, string, number][] = [
      ["live native", live, 200],
      ["archived native", archived, 409],
      ["exited native", exited, 409],
    ];
    for (const [name, id, status] of validRows) {
      const base = `/api/v1/threads/${id}/native-terminal/agent-tools`;
      const headers = authHeaders(fixture, id);
      expect(
        (await fixture.harness.app.request(base, { headers })).status,
        `GET valid ${name}`,
      ).toBe(status);
      expect(
        (
          await fixture.harness.app.request(`${base}/echo_context/call`, {
            method: "POST",
            headers: { "content-type": "application/json", ...headers },
            body: JSON.stringify({ callId: "c", arguments: {} }),
          })
        ).status,
        `POST valid ${name}`,
      ).toBe(status);
    }
    expect(
      (
        await fixture.harness.app.request(
          `/api/v1/threads/${live}/native-terminal/agent-tools/unselected_tool/call`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              ...authHeaders(fixture, live),
            },
            body: JSON.stringify({ callId: "c", arguments: {} }),
          },
        )
      ).status,
    ).toBe(404);
  });

  it("applies the public API origin guard to both routes", async () => {
    const fixture = await createFixture();
    const threadId = await createNativeThread(fixture);
    const list = await fixture.harness.app.request(
      `/api/v1/threads/${threadId}/native-terminal/agent-tools`,
      { headers: { origin: "https://evil.example" } },
    );
    expect(list.status).toBe(403);
    const call = await fixture.harness.app.request(
      `/api/v1/threads/${threadId}/native-terminal/agent-tools/echo_context/call`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://evil.example",
          ...authHeaders(fixture, threadId),
        },
        body: JSON.stringify({ callId: "c", arguments: {} }),
      },
    );
    expect(call.status).toBe(403);
  });
});
