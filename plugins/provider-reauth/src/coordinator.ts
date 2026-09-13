import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  REAUTH_NOTIFICATION_CHANNEL,
  REAUTH_PROVIDERS,
  type ReauthNotification,
  type ReauthOutcome,
  type ReauthProviderId,
} from "../contract.js";
import {
  HEADLESS_EXIT_CODE,
  loginTerminalCommand,
  loginTerminalTitle,
} from "./login-command.js";

export const READINESS_POLL_MS = 5_000;
export const LOGIN_TIMEOUT_MS = 10 * 60_000;
export const COOLDOWN_MS = 10 * 60_000;
const CONSENT_WITHOUT_INPUT_MS = 5_000;
const TERMINAL_COLS = 100;
const TERMINAL_ROWS = 30;

export interface ReauthStartResult {
  started: boolean;
  reason: "started" | "already-running" | "cooling-down" | "already-ready";
}

interface WaitingTurn {
  threadId: string;
  turnRequestId: string;
}

interface RunningLogin {
  providerId: ReauthProviderId;
  hostId: string;
  startedAt: number;
  waiting: Map<string, WaitingTurn>;
  settled: Promise<void>;
}

export interface ReauthCoordinatorOptions {
  bb: BbPluginApi;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface ReauthCoordinator {
  handleTurnFailed(event: {
    threadId: string;
    requestId: string;
    errorInfo: { category: string } | null;
  }): Promise<void>;
  start(args: {
    providerId: ReauthProviderId;
    hostId: string;
  }): Promise<ReauthStartResult>;
  running(): {
    providerId: ReauthProviderId;
    hostId: string;
    startedAt: number;
    waitingTurns: number;
  }[];
  whenSettled(): Promise<void>;
}

function isReauthProvider(value: string): value is ReauthProviderId {
  return REAUTH_PROVIDERS.some((providerId) => providerId === value);
}

function providerName(providerId: ReauthProviderId): string {
  return providerId === "claude-code" ? "Claude Code" : "Codex";
}

function loginKey(providerId: ReauthProviderId, hostId: string): string {
  return `${providerId}:${hostId}`;
}

export function createReauthCoordinator(
  options: ReauthCoordinatorOptions,
): ReauthCoordinator {
  const { bb } = options;
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const runs = new Map<string, RunningLogin>();
  const settling = new Set<Promise<void>>();
  const cooldowns = new Map<string, number>();

  async function providerStatus(
    providerId: ReauthProviderId,
    hostId: string,
  ): Promise<string | null> {
    const states = await bb.sdk.system.providerStates({ hostId });
    return (
      states.providers.find((state) => state.providerId === providerId)
        ?.status ?? null
    );
  }

  function publish(
    outcome: ReauthOutcome,
    args: {
      providerId: ReauthProviderId;
      hostId: string;
      resumedTurns: number;
      title: string;
      body: string;
      canRetry: boolean;
    },
  ): void {
    const notification: ReauthNotification = {
      id: `${args.providerId}-${args.hostId}-${now()}`,
      outcome,
      providerId: args.providerId,
      providerName: providerName(args.providerId),
      hostId: args.hostId,
      resumedTurns: args.resumedTurns,
      title: args.title,
      body: args.body,
      canRetry: args.canRetry,
    };
    bb.realtime.publish(REAUTH_NOTIFICATION_CHANNEL, notification);
  }

  async function findRunningLoginTerminal(
    providerId: ReauthProviderId,
    hostId: string,
  ): Promise<string | null> {
    const title = loginTerminalTitle(providerId);
    const { sessions } = await bb.sdk.terminals.list({
      scope: { kind: "host_path", hostId },
    });
    return (
      sessions.find(
        (session) =>
          session.title === title &&
          (session.status === "starting" ||
            session.status === "running" ||
            session.status === "disconnected"),
      )?.id ?? null
    );
  }

  async function closeTerminal(terminalId: string): Promise<void> {
    try {
      await bb.sdk.terminals.close({ terminalId, mode: "force" });
    } catch {
      return;
    }
  }

  async function resumeWaitingTurns(run: RunningLogin): Promise<number> {
    let resumed = 0;
    for (const turn of run.waiting.values()) {
      try {
        await bb.sdk.threads.retry({
          threadId: turn.threadId,
          turnRequestId: turn.turnRequestId,
          reason: `${providerName(run.providerId)} sign-in renewed`,
        });
        resumed += 1;
      } catch {
        continue;
      }
    }
    return resumed;
  }

  function turnsPhrase(resumed: number): string {
    if (resumed === 0) return "no turns were waiting";
    return resumed === 1 ? "1 turn resumed" : `${resumed} turns resumed`;
  }

  async function watchLogin(
    run: RunningLogin,
    terminalId: string,
  ): Promise<void> {
    const deadline = run.startedAt + LOGIN_TIMEOUT_MS;
    while (now() < deadline) {
      await sleep(READINESS_POLL_MS);
      const status = await providerStatus(run.providerId, run.hostId);
      if (status === "ready") {
        await closeTerminal(terminalId);
        const msToReady = now() - run.startedAt;
        const resumed = await resumeWaitingTurns(run);
        bb.log.info(
          `sign-in renewed providerId=${run.providerId} hostId=${run.hostId} msToReady=${msToReady} completedWithoutInput=${msToReady < CONSENT_WITHOUT_INPUT_MS} resumedTurns=${resumed}`,
        );
        publish("renewed", {
          providerId: run.providerId,
          hostId: run.hostId,
          resumedTurns: resumed,
          title: `${providerName(run.providerId)} sign-in renewed`,
          body: turnsPhrase(resumed),
          canRetry: false,
        });
        return;
      }
      const terminal = await bb.sdk.terminals.get({ terminalId });
      if (terminal.status !== "exited") {
        continue;
      }
      if (terminal.exitCode === HEADLESS_EXIT_CODE) {
        publish("headless", {
          providerId: run.providerId,
          hostId: run.hostId,
          resumedTurns: 0,
          title: `${providerName(run.providerId)} needs a sign-in`,
          body: `This host has no desktop session, so bb cannot open a browser. Run the sign-in on host ${run.hostId}.`,
          canRetry: false,
        });
        cooldowns.set(loginKey(run.providerId, run.hostId), now() + COOLDOWN_MS);
        return;
      }
      publish("failed", {
        providerId: run.providerId,
        hostId: run.hostId,
        resumedTurns: 0,
        title: `${providerName(run.providerId)} sign-in did not finish`,
        body: "The sign-in command exited before the provider was ready.",
        canRetry: true,
      });
      cooldowns.set(loginKey(run.providerId, run.hostId), now() + COOLDOWN_MS);
      return;
    }
    await closeTerminal(terminalId);
    publish("timed-out", {
      providerId: run.providerId,
      hostId: run.hostId,
      resumedTurns: 0,
      title: `${providerName(run.providerId)} sign-in timed out`,
      body: "The browser sign-in was not completed in ten minutes.",
      canRetry: true,
    });
    cooldowns.set(loginKey(run.providerId, run.hostId), now() + COOLDOWN_MS);
  }

  async function runLogin(run: RunningLogin): Promise<void> {
    const key = loginKey(run.providerId, run.hostId);
    try {
      const adopted = await findRunningLoginTerminal(run.providerId, run.hostId);
      const terminalId =
        adopted ??
        (
          await bb.sdk.terminals.create({
            cols: TERMINAL_COLS,
            rows: TERMINAL_ROWS,
            scope: { kind: "host_path", hostId: run.hostId, cwd: null },
            title: loginTerminalTitle(run.providerId),
            start: {
              mode: "command",
              command: loginTerminalCommand(run.providerId),
            },
          })
        ).id;
      await watchLogin(run, terminalId);
    } catch (error) {
      bb.log.warn(
        `sign-in run failed providerId=${run.providerId} hostId=${run.hostId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      cooldowns.set(key, now() + COOLDOWN_MS);
      publish("failed", {
        providerId: run.providerId,
        hostId: run.hostId,
        resumedTurns: 0,
        title: `${providerName(run.providerId)} sign-in could not start`,
        body: "bb could not start the provider sign-in on this host.",
        canRetry: true,
      });
    } finally {
      runs.delete(key);
    }
  }

  function launch(
    providerId: ReauthProviderId,
    hostId: string,
    waiting: WaitingTurn | null,
  ): ReauthStartResult {
    const key = loginKey(providerId, hostId);
    const existing = runs.get(key);
    if (existing) {
      if (waiting !== null) {
        existing.waiting.set(
          `${waiting.threadId}:${waiting.turnRequestId}`,
          waiting,
        );
      }
      return { started: false, reason: "already-running" };
    }
    const cooldownUntil = cooldowns.get(key);
    if (cooldownUntil !== undefined && now() < cooldownUntil) {
      return { started: false, reason: "cooling-down" };
    }
    const run: RunningLogin = {
      providerId,
      hostId,
      startedAt: now(),
      waiting: new Map(),
      settled: Promise.resolve(),
    };
    if (waiting !== null) {
      run.waiting.set(`${waiting.threadId}:${waiting.turnRequestId}`, waiting);
    }
    runs.set(key, run);
    run.settled = runLogin(run);
    settling.add(run.settled);
    void run.settled.finally(() => settling.delete(run.settled));
    return { started: true, reason: "started" };
  }

  return {
    async handleTurnFailed(event) {
      const thread = await bb.sdk.threads.get({ threadId: event.threadId });
      const providerId = thread.providerId;
      if (!isReauthProvider(providerId) || thread.environmentId === null) {
        return;
      }
      const environment = await bb.sdk.environments.get({
        environmentId: thread.environmentId,
      });
      const hostId = environment.hostId;
      const status = await providerStatus(providerId, hostId);
      if (status === null) return;
      const signedOut =
        providerId === "claude-code"
          ? status === "unauthenticated"
          : event.errorInfo?.category === "unauthorized" &&
            status !== "not_installed" &&
            status !== "unsupported_version";
      if (!signedOut) return;
      launch(providerId, hostId, {
        threadId: event.threadId,
        turnRequestId: event.requestId,
      });
    },
    async start({ providerId, hostId }) {
      const status = await providerStatus(providerId, hostId);
      if (status === "ready") {
        return { started: false, reason: "already-ready" };
      }
      return launch(providerId, hostId, null);
    },
    async whenSettled() {
      while (settling.size > 0) {
        await Promise.all([...settling]);
      }
    },
    running() {
      return [...runs.values()].map((run) => ({
        providerId: run.providerId,
        hostId: run.hostId,
        startedAt: run.startedAt,
        waitingTurns: run.waiting.size,
      }));
    },
  };
}
