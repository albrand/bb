import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createFakePluginHost,
  type CreateFakePluginHostOptions,
} from "@get-bb/plugin-sdk/testing";
import { REAUTH_NOTIFICATION_CHANNEL } from "../contract.js";
import { createReauthCoordinator } from "./coordinator.js";
import { HEADLESS_EXIT_CODE, loginTerminalTitle } from "./login-command.js";

const PLUGIN_ID = "provider-reauth";
const HOST_ID = "host-one";
const ENVIRONMENT_ID = "env-one";
const THREAD_ID = "thread-one";
const REQUEST_ID = "creq_aaaaaaaaaa";
const CODE_MARKER = "marker-oauth-code-do-not-leak";

interface TerminalRecord {
  id: string;
  title: string;
  command: string;
  status: "running" | "exited";
  exitCode: number | null;
  closed: boolean;
}

interface HarnessOptions {
  claudeStatuses?: string[];
  codexStatuses?: string[];
  existingTerminals?: TerminalRecord[];
  threadProviderId?: string;
  environmentId?: string | null;
  terminalScript?: (terminal: TerminalRecord, poll: number) => void;
}

function createHarness(options: HarnessOptions = {}) {
  const terminals: TerminalRecord[] = [...(options.existingTerminals ?? [])];
  const retries: { threadId: string; turnRequestId?: string }[] = [];
  const outputReads: string[] = [];
  const claudeStatuses = [...(options.claudeStatuses ?? ["unauthenticated"])];
  const codexStatuses = [...(options.codexStatuses ?? ["ready"])];
  let clock = 1_000;
  let polls = 0;
  let created = 0;

  function nextStatus(queue: string[]): string {
    return queue.length > 1 ? (queue.shift() ?? "unknown") : (queue[0] ?? "unknown");
  }

  const sdk: CreateFakePluginHostOptions["sdk"] = {
    threads: {
      get: async () => ({
        id: THREAD_ID,
        providerId: options.threadProviderId ?? "claude-code",
        environmentId:
          options.environmentId === undefined
            ? ENVIRONMENT_ID
            : options.environmentId,
      }),
      retry: async (args: unknown) => {
        retries.push(args as { threadId: string; turnRequestId?: string });
        return { ok: true };
      },
    },
    environments: {
      get: async () => ({ id: ENVIRONMENT_ID, hostId: HOST_ID }),
    },
    system: {
      providerStates: async () => ({
        providers: [
          {
            providerId: "claude-code",
            displayName: "Claude Code",
            status: nextStatus(claudeStatuses),
          },
          {
            providerId: "codex",
            displayName: "Codex",
            status: nextStatus(codexStatuses),
          },
        ],
      }),
    },
    terminals: {
      list: async () => ({ sessions: terminals }),
      create: async (args: unknown) => {
        created += 1;
        const request = args as {
          title?: string;
          start?: { command?: string };
        };
        const terminal: TerminalRecord = {
          id: `terminal-${created}`,
          title: request.title ?? "",
          command: request.start?.command ?? "",
          status: "running",
          exitCode: null,
          closed: false,
        };
        terminals.push(terminal);
        return terminal;
      },
      get: async (args: unknown) =>
        terminals.find(
          (terminal) => terminal.id === (args as { terminalId: string }).terminalId,
        ),
      close: async (args: unknown) => {
        const terminalId = (args as { terminalId: string }).terminalId;
        const terminal = terminals.find((item) => item.id === terminalId);
        if (terminal) {
          terminal.closed = true;
          terminal.status = "exited";
        }
        return terminal;
      },
      output: async (args: unknown) => {
        outputReads.push((args as { terminalId: string }).terminalId);
        return { chunks: [{ seq: 1, data: CODE_MARKER }] };
      },
    },
  };

  const host = createFakePluginHost({ pluginId: PLUGIN_ID, sdk });
  const coordinator = createReauthCoordinator({
    bb: host.bb,
    now: () => clock,
    sleep: async (ms: number) => {
      clock += ms;
      polls += 1;
      const terminal = terminals.at(-1);
      if (terminal !== undefined) options.terminalScript?.(terminal, polls);
    },
  });

  return {
    coordinator,
    host,
    terminals,
    retries,
    outputReads,
    createdCount: () => created,
    notifications: () =>
      host.harness.realtimeSignals.filter(
        (signal) => signal.channel === REAUTH_NOTIFICATION_CHANNEL,
      ),
  };
}

function failure(overrides: { threadId?: string; requestId?: string } = {}) {
  return {
    threadId: overrides.threadId ?? THREAD_ID,
    requestId: overrides.requestId ?? REQUEST_ID,
    errorInfo: { category: "unknown" },
  };
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("the re-auth plugin must not make network calls");
    }),
  );
});

describe("provider re-auth coordinator", () => {
  it("opens one guarded sign-in for a signed-out Claude Code and resumes the turns that failed", async () => {
    const harness = createHarness({
      claudeStatuses: ["unauthenticated", "unauthenticated", "ready"],
    });

    await harness.coordinator.handleTurnFailed(failure());
    await harness.coordinator.handleTurnFailed(
      failure({ threadId: "thread-two", requestId: "creq_bbbbbbbbbb" }),
    );
    await harness.coordinator.whenSettled();

    expect(harness.createdCount()).toBe(1);
    const terminal = harness.terminals[0];
    expect(terminal?.title).toBe(loginTerminalTitle("claude-code"));
    expect(terminal?.command).toContain("launchctl managername");
    expect(terminal?.command).toContain("exec claude auth login");
    expect(terminal?.closed).toBe(true);
    expect(harness.retries.map((retry) => retry.threadId)).toEqual([
      THREAD_ID,
      "thread-two",
    ]);
    const notifications = harness.notifications();
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.payload).toMatchObject({
      outcome: "renewed",
      resumedTurns: 2,
      canRetry: false,
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("never reads the sign-in terminal's output, and leaks nothing it printed", async () => {
    const harness = createHarness({
      claudeStatuses: ["unauthenticated", "ready"],
    });

    await harness.coordinator.handleTurnFailed(failure());
    await harness.coordinator.whenSettled();

    expect(harness.outputReads).toEqual([]);
    const recorded = JSON.stringify([
      harness.host.harness.logEntries,
      harness.host.harness.realtimeSignals,
      harness.host.harness.sdk.calls,
    ]);
    expect(recorded).not.toContain(CODE_MARKER);
  });

  it("records how long the sign-in took without publishing it", async () => {
    const harness = createHarness({
      claudeStatuses: ["unauthenticated", "ready"],
    });

    await harness.coordinator.handleTurnFailed(failure());
    await harness.coordinator.whenSettled();

    const logged = harness.host.harness.logEntries.map(
      (entry) => entry.message,
    );
    expect(logged.some((message) => message.includes("msToReady="))).toBe(true);
    expect(
      JSON.stringify(harness.notifications()).includes("msToReady"),
    ).toBe(false);
  });

  it("does not open a sign-in on a host with no desktop session, and holds off afterwards", async () => {
    const harness = createHarness({
      claudeStatuses: ["unauthenticated"],
      terminalScript: (terminal) => {
        terminal.status = "exited";
        terminal.exitCode = HEADLESS_EXIT_CODE;
      },
    });

    await harness.coordinator.handleTurnFailed(failure());
    await harness.coordinator.whenSettled();
    await harness.coordinator.handleTurnFailed(failure());
    await harness.coordinator.whenSettled();

    expect(harness.createdCount()).toBe(1);
    const notifications = harness.notifications();
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.payload).toMatchObject({
      outcome: "headless",
      canRetry: false,
    });
    expect(harness.retries).toEqual([]);
  });

  it("gives up on a sign-in nobody completes and offers a retry", async () => {
    const harness = createHarness({ claudeStatuses: ["unauthenticated"] });

    await harness.coordinator.handleTurnFailed(failure());
    await harness.coordinator.whenSettled();

    const notifications = harness.notifications();
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.payload).toMatchObject({
      outcome: "timed-out",
      canRetry: true,
    });
    expect(harness.terminals[0]?.closed).toBe(true);
    expect(harness.retries).toEqual([]);
  });

  it("does not sign in again the moment a renewed provider fails once more", async () => {
    const harness = createHarness({
      claudeStatuses: ["unauthenticated", "ready", "unauthenticated"],
    });

    await harness.coordinator.handleTurnFailed(failure());
    await harness.coordinator.whenSettled();
    await harness.coordinator.handleTurnFailed(failure());
    await harness.coordinator.whenSettled();

    expect(harness.createdCount()).toBe(1);
    expect(harness.notifications()).toHaveLength(1);
  });

  it("does not let a flood of failures shorten the cooldown", async () => {
    const harness = createHarness({
      claudeStatuses: ["unauthenticated"],
      terminalScript: (terminal) => {
        terminal.status = "exited";
        terminal.exitCode = 1;
      },
    });

    await harness.coordinator.handleTurnFailed(failure());
    await harness.coordinator.whenSettled();
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await harness.coordinator.handleTurnFailed(
        failure({ threadId: `thread-flood-${attempt}` }),
      );
      await harness.coordinator.whenSettled();
    }

    expect(harness.createdCount()).toBe(1);
    expect(harness.notifications()).toHaveLength(1);
  });

  it("honours an explicit sign-in request during a cooldown", async () => {
    const harness = createHarness({
      claudeStatuses: ["unauthenticated"],
      terminalScript: (terminal) => {
        terminal.status = "exited";
        terminal.exitCode = HEADLESS_EXIT_CODE;
      },
    });

    await harness.coordinator.handleTurnFailed(failure());
    await harness.coordinator.whenSettled();
    expect(harness.createdCount()).toBe(1);

    await expect(
      harness.coordinator.start({
        providerId: "claude-code",
        hostId: HOST_ID,
      }),
    ).resolves.toEqual({ started: true, reason: "started" });
    await harness.coordinator.whenSettled();

    expect(harness.createdCount()).toBe(2);
  });

  it("leaves a healthy provider alone", async () => {
    const harness = createHarness({ claudeStatuses: ["ready"] });

    await harness.coordinator.handleTurnFailed(failure());
    await harness.coordinator.whenSettled();

    expect(harness.createdCount()).toBe(0);
    expect(harness.notifications()).toEqual([]);
  });

  it("adopts a sign-in another bb process already started on the host", async () => {
    const harness = createHarness({
      claudeStatuses: ["unauthenticated", "ready"],
      existingTerminals: [
        {
          id: "terminal-existing",
          title: loginTerminalTitle("claude-code"),
          command: "exec claude auth login",
          status: "running",
          exitCode: null,
          closed: false,
        },
      ],
    });

    await harness.coordinator.handleTurnFailed(failure());
    await harness.coordinator.whenSettled();

    expect(harness.createdCount()).toBe(0);
    expect(harness.terminals[0]?.closed).toBe(true);
  });

  it("trusts codex's own unauthorized code, and ignores its other failures", async () => {
    const ignored = createHarness({
      threadProviderId: "codex",
      codexStatuses: ["expired"],
    });
    await ignored.coordinator.handleTurnFailed(failure());
    await ignored.coordinator.whenSettled();
    expect(ignored.createdCount()).toBe(0);

    const triggered = createHarness({
      threadProviderId: "codex",
      codexStatuses: ["expired", "ready"],
    });
    await triggered.coordinator.handleTurnFailed({
      ...failure(),
      errorInfo: { category: "unauthorized" },
    });
    await triggered.coordinator.whenSettled();

    expect(triggered.createdCount()).toBe(1);
    expect(triggered.terminals[0]?.command).toContain("exec codex login");
  });

  it("ignores a provider it does not sign in", async () => {
    const harness = createHarness({ threadProviderId: "acp-opencode" });

    await harness.coordinator.handleTurnFailed(failure());
    await harness.coordinator.whenSettled();

    expect(harness.createdCount()).toBe(0);
  });
});
