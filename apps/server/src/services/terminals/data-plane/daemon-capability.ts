import {
  TERMINAL_DATA_PLANE_PROBE_IPC_VERSION,
  TERMINAL_DATA_PLANE_PROBE_TIMEOUT_MS,
  terminalDataPlaneProbeResultSchema,
  type HostDaemonOnlineRpcRequestMessage,
  type HostDaemonOnlineRpcResponseMessage,
} from "@bb/host-daemon-contract";
import type { TerminalDataPlaneRouteMode } from "../../../terminal-data-plane/ipc-contract.js";

export interface DaemonCapabilityRpcPort {
  request(args: {
    hostId: string;
    message: HostDaemonOnlineRpcRequestMessage;
    timeoutMs: number;
  }): Promise<HostDaemonOnlineRpcResponseMessage>;
}

export interface DaemonCapabilityLogger {
  debug(fields: Record<string, unknown>, message: string): void;
}

export interface DaemonCapabilityOptions {
  logger: DaemonCapabilityLogger;
  newRequestId: () => string;
  rpc: DaemonCapabilityRpcPort;
  timeoutMs?: number;
}

export class DaemonDataPlaneCapabilities {
  private readonly modes = new Map<string, TerminalDataPlaneRouteMode>();

  constructor(private readonly options: DaemonCapabilityOptions) {}

  modeFor(daemonSessionId: string): TerminalDataPlaneRouteMode {
    return this.modes.get(daemonSessionId) ?? "main-relay";
  }

  forget(daemonSessionId: string): void {
    this.modes.delete(daemonSessionId);
  }

  async negotiate(args: {
    daemonSessionId: string;
    hostId: string;
  }): Promise<TerminalDataPlaneRouteMode> {
    this.modes.set(args.daemonSessionId, "main-relay");
    let response: HostDaemonOnlineRpcResponseMessage;
    try {
      response = await this.options.rpc.request({
        hostId: args.hostId,
        message: {
          type: "host-rpc.request",
          requestId: this.options.newRequestId(),
          command: { type: "terminal-data-plane.probe" },
        },
        timeoutMs: this.options.timeoutMs ?? TERMINAL_DATA_PLANE_PROBE_TIMEOUT_MS,
      });
    } catch (error) {
      this.options.logger.debug(
        { err: error, hostId: args.hostId },
        "Terminal data plane probe got no answer; using the main relay",
      );
      return "main-relay";
    }
    if (!response.ok) {
      this.options.logger.debug(
        { errorCode: response.errorCode, hostId: args.hostId },
        "Daemon does not support the terminal data plane; using the main relay",
      );
      return "main-relay";
    }
    const parsed = terminalDataPlaneProbeResultSchema.safeParse(response.result);
    if (
      !parsed.success ||
      !parsed.data.dataSocket ||
      parsed.data.ipcVersion !== TERMINAL_DATA_PLANE_PROBE_IPC_VERSION
    ) {
      return "main-relay";
    }
    if (this.modes.has(args.daemonSessionId)) {
      this.modes.set(args.daemonSessionId, "data-socket");
    }
    return "data-socket";
  }
}
