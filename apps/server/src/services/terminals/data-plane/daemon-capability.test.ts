import {
  hostDaemonOnlineRpcResponseMessageSchema,
  type HostDaemonOnlineRpcResponseMessage,
} from "@bb/host-daemon-contract";
import { describe, expect, it, vi } from "vitest";
import {
  DaemonDataPlaneCapabilities,
  type DaemonCapabilityRpcPort,
} from "./daemon-capability.js";

const ARGS = { daemonSessionId: "ds_1", hostId: "host_1" };

function answer(
  response: unknown,
): HostDaemonOnlineRpcResponseMessage {
  return hostDaemonOnlineRpcResponseMessageSchema.parse(response);
}

function legacyDaemonAnswer(): HostDaemonOnlineRpcResponseMessage {
  return answer({
    type: "host-rpc.response",
    requestId: "req_1",
    commandType: "terminal-data-plane.probe",
    ok: false,
    errorCode: "invalid_command",
    errorMessage: "Invalid host RPC command",
  });
}

function capableDaemonAnswer(
  result: unknown = { dataSocket: true, ipcVersion: 1 },
): HostDaemonOnlineRpcResponseMessage {
  return answer({
    type: "host-rpc.response",
    requestId: "req_1",
    commandType: "terminal-data-plane.probe",
    ok: true,
    result,
  });
}

type ProbeRequest = Parameters<DaemonCapabilityRpcPort["request"]>[0];

function firstRequest(rpc: {
  request: { mock: { calls: ProbeRequest[][] } };
}): ProbeRequest {
  const call = rpc.request.mock.calls[0];
  const request = call?.[0];
  if (request === undefined) {
    throw new Error("probe was not sent");
  }
  return request;
}

function createCapabilities(
  request: () => Promise<HostDaemonOnlineRpcResponseMessage>,
  timeoutMs?: number,
) {
  const rpc = { request: vi.fn((_request: ProbeRequest) => request()) };
  const capabilities = new DaemonDataPlaneCapabilities({
    logger: { debug: vi.fn() },
    newRequestId: () => "req_1",
    rpc,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
  return { capabilities, rpc };
}

describe("DaemonDataPlaneCapabilities", () => {
  it("keeps a legacy daemon that answers invalid_command on the main relay", async () => {
    const { capabilities, rpc } = createCapabilities(async () =>
      legacyDaemonAnswer(),
    );
    expect(capabilities.modeFor(ARGS.daemonSessionId)).toBe("main-relay");
    await expect(capabilities.negotiate(ARGS)).resolves.toBe("main-relay");
    expect(capabilities.modeFor(ARGS.daemonSessionId)).toBe("main-relay");
    expect(rpc.request).toHaveBeenCalledTimes(1);
    expect(firstRequest(rpc).message.command).toEqual({
      type: "terminal-data-plane.probe",
    });
  });

  it("routes a daemon with the current probe IPC version through the data socket", async () => {
    const { capabilities } = createCapabilities(async () =>
      capableDaemonAnswer({ dataSocket: true, ipcVersion: 1 }),
    );
    await expect(capabilities.negotiate(ARGS)).resolves.toBe("data-socket");
    expect(capabilities.modeFor(ARGS.daemonSessionId)).toBe("data-socket");
  });

  it("falls back to the main relay when the probe times out", async () => {
    vi.useFakeTimers();
    try {
      const { capabilities, rpc } = createCapabilities(
        () =>
          new Promise<HostDaemonOnlineRpcResponseMessage>((_resolve, reject) => {
            setTimeout(() => reject(new Error("timeout")), 3_000);
          }),
        3_000,
      );
      const negotiated = capabilities.negotiate(ARGS);
      await vi.advanceTimersByTimeAsync(3_000);
      await expect(negotiated).resolves.toBe("main-relay");
      expect(capabilities.modeFor(ARGS.daemonSessionId)).toBe("main-relay");
      expect(firstRequest(rpc).timeoutMs).toBe(3_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ["a daemon without the data socket", { dataSocket: false, ipcVersion: 1 }],
    ["an unknown IPC version", { dataSocket: true, ipcVersion: 2 }],
    ["a malformed result", { dataSocket: "yes" }],
  ])("stays on the main relay for %s", async (_name, result) => {
    const { capabilities } = createCapabilities(async () => {
      try {
        return capableDaemonAnswer(result);
      } catch {
        return legacyDaemonAnswer();
      }
    });
    await expect(capabilities.negotiate(ARGS)).resolves.toBe("main-relay");
    expect(capabilities.modeFor(ARGS.daemonSessionId)).toBe("main-relay");
  });

  it("does not resurrect a session that closed while the probe was in flight", async () => {
    let finish: (value: HostDaemonOnlineRpcResponseMessage) => void = () =>
      undefined;
    const { capabilities } = createCapabilities(
      () =>
        new Promise<HostDaemonOnlineRpcResponseMessage>((resolve) => {
          finish = resolve;
        }),
    );
    const negotiated = capabilities.negotiate(ARGS);
    capabilities.forget(ARGS.daemonSessionId);
    finish(capableDaemonAnswer());
    await negotiated;
    expect(capabilities.modeFor(ARGS.daemonSessionId)).toBe("main-relay");
  });
});
