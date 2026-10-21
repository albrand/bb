import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TERMINAL_DATA_PLANE_IPC_VERSION } from "../../../terminal-data-plane/ipc-contract.js";
import {
  CHILD_FALLBACK_COOLDOWN_MS,
  CHILD_RESPAWN_DELAYS_MS,
  CHILD_STABLE_READY_MS,
  DataPlaneChildSupervisor,
  type DataPlaneChildProcess,
} from "./child-supervisor.js";

const V = TERMINAL_DATA_PLANE_IPC_VERSION;

class FakeChild implements DataPlaneChildProcess {
  connected = true;
  pid = 4242;
  readonly sent: unknown[] = [];
  readonly pendingCallbacks: Array<(error: Error | null) => void> = [];
  killed = false;
  private readonly listeners = new Map<string, Array<(arg: never) => void>>();

  send(
    message: unknown,
    _handle: unknown,
    callback: (error: Error | null) => void,
  ): boolean {
    this.sent.push(message);
    this.pendingCallbacks.push(callback);
    return true;
  }

  kill(): boolean {
    this.killed = true;
    return true;
  }

  on(event: "message", listener: (message: unknown) => void): this;
  on(event: "exit" | "disconnect", listener: () => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: string, listener: (arg: never) => void): this {
    const existing = this.listeners.get(event) ?? [];
    existing.push(listener);
    this.listeners.set(event, existing);
    return this;
  }

  emit(event: string, arg?: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) {
      (listener as (value?: unknown) => void)(arg);
    }
  }

  becomeReady(): void {
    this.emit("message", { v: V, type: "ready", pid: this.pid });
  }

  crash(): void {
    this.connected = false;
    this.emit("exit");
  }
}

function createFixture() {
  const children: FakeChild[] = [];
  const events: string[] = [];
  const messages: unknown[] = [];
  const logger = { error: vi.fn(), warn: vi.fn() };
  const supervisor = new DataPlaneChildSupervisor({
    logger,
    onDown: () => events.push("down"),
    onMessage: (message) => messages.push(message),
    onReady: () => events.push("ready"),
    spawn: () => {
      const child = new FakeChild();
      children.push(child);
      return child;
    },
  });
  return { children, events, logger, messages, supervisor };
}

describe("DataPlaneChildSupervisor", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("refuses to send until the child reports ready", () => {
    const { children, supervisor } = createFixture();
    supervisor.start();
    expect(supervisor.state).toBe("starting");
    expect(
      supervisor.send({ v: V, type: "terminal.resync", terminalId: "t1" }),
    ).toBe(false);
    children[0]?.becomeReady();
    expect(supervisor.state).toBe("ready");
    expect(
      supervisor.send({ v: V, type: "terminal.resync", terminalId: "t1" }),
    ).toBe(true);
    supervisor.stop();
  });

  it("drops malformed child messages and forwards valid ones", () => {
    const { children, logger, messages, supervisor } = createFixture();
    supervisor.start();
    const child = children[0];
    child?.becomeReady();
    child?.emit("message", { v: V, type: "browser.attached" });
    child?.emit("message", {
      v: V + 1,
      type: "browser.attached",
      attachId: "a",
    });
    child?.emit("message", { v: V, type: "browser.attached", attachId: "a" });
    expect(messages).toEqual([{ v: V, type: "browser.attached", attachId: "a" }]);
    expect(logger.warn).toHaveBeenCalledTimes(2);
    supervisor.stop();
  });

  it("respawns with the bounded backoff and reports down once per crash", () => {
    const { children, events, supervisor } = createFixture();
    supervisor.start();
    children[0]?.becomeReady();
    children[0]?.crash();
    expect(supervisor.state).toBe("down");
    expect(events).toEqual(["ready", "down"]);
    vi.advanceTimersByTime((CHILD_RESPAWN_DELAYS_MS[0] ?? 0) - 1);
    expect(children).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(children).toHaveLength(2);
    children[1]?.crash();
    vi.advanceTimersByTime((CHILD_RESPAWN_DELAYS_MS[1] ?? 0) - 1);
    expect(children).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(children).toHaveLength(3);
    supervisor.stop();
  });

  it("falls back after five rapid crashes and retries after the cooldown", () => {
    const { children, supervisor } = createFixture();
    supervisor.start();
    for (let index = 0; index < 4; index += 1) {
      children[index]?.crash();
      vi.advanceTimersByTime(CHILD_RESPAWN_DELAYS_MS[index] ?? 0);
    }
    expect(children).toHaveLength(5);
    children[4]?.crash();
    expect(supervisor.state).toBe("fallback");
    vi.advanceTimersByTime(CHILD_FALLBACK_COOLDOWN_MS - 1);
    expect(children).toHaveLength(5);
    vi.advanceTimersByTime(1);
    expect(children).toHaveLength(6);
    children[5]?.becomeReady();
    expect(supervisor.state).toBe("ready");
    supervisor.stop();
  });

  it("resets the backoff after a stable ready period", () => {
    const { children, supervisor } = createFixture();
    supervisor.start();
    children[0]?.crash();
    vi.advanceTimersByTime(CHILD_RESPAWN_DELAYS_MS[0] ?? 0);
    children[1]?.becomeReady();
    vi.advanceTimersByTime(CHILD_STABLE_READY_MS + 1);
    children[1]?.crash();
    vi.advanceTimersByTime(CHILD_RESPAWN_DELAYS_MS[0] ?? 0);
    expect(children).toHaveLength(3);
    supervisor.stop();
  });

  it("tracks bytes in flight until the send callback fires", () => {
    const { children, supervisor } = createFixture();
    supervisor.start();
    const child = children[0];
    child?.becomeReady();
    supervisor.send(
      { v: V, type: "terminal.resync", terminalId: "t1" },
      { bytes: 1000 },
    );
    supervisor.send(
      { v: V, type: "terminal.resync", terminalId: "t2" },
      { bytes: 500 },
    );
    expect(supervisor.pendingIpcBytes).toBe(1500);
    child?.pendingCallbacks[0]?.(null);
    expect(supervisor.pendingIpcBytes).toBe(500);
    child?.crash();
    expect(supervisor.pendingIpcBytes).toBe(0);
    supervisor.stop();
  });

  it("ignores events from a replaced child and does not respawn after stop", () => {
    const { children, events, supervisor } = createFixture();
    supervisor.start();
    const first = children[0];
    first?.becomeReady();
    first?.crash();
    vi.advanceTimersByTime(CHILD_RESPAWN_DELAYS_MS[0] ?? 0);
    first?.emit("exit");
    expect(events.filter((event) => event === "down")).toHaveLength(1);
    supervisor.stop();
    children[1]?.crash();
    vi.advanceTimersByTime(60_000);
    expect(children).toHaveLength(2);
    expect(children[1]?.sent).toContainEqual({ v: V, type: "shutdown" });
  });
});
