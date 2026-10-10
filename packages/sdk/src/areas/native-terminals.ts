import type {
  NativeTerminalLaunchSpec,
  NativeTerminalThread,
} from "@bb/server-contract";
import { signalRequestArgs, type CreateSdkAreaArgs } from "./common.js";

export interface NativeTerminalThreadArgs {
  signal?: AbortSignal;
  threadId: string;
}

export interface NativeTerminalOpenArgs extends NativeTerminalThreadArgs {
  cols?: number;
  rows?: number;
}

export interface NativeTerminalRecordSessionArgs extends NativeTerminalThreadArgs {
  nativeSessionId: string;
}

export type NativeTerminalThreadResult = NativeTerminalThread;
export type NativeTerminalLaunchResult = NativeTerminalLaunchSpec;

export interface NativeTerminalsArea {
  get(
    args: NativeTerminalThreadArgs,
  ): Promise<NativeTerminalThreadResult | null>;
  launch(args: NativeTerminalThreadArgs): Promise<NativeTerminalLaunchResult>;
  open(args: NativeTerminalOpenArgs): Promise<NativeTerminalThreadResult>;
  recordSession(
    args: NativeTerminalRecordSessionArgs,
  ): Promise<NativeTerminalThreadResult>;
}

export function createNativeTerminalsArea(
  args: CreateSdkAreaArgs,
): NativeTerminalsArea {
  const { transport } = args;
  const route = () => transport.api.v1.threads[":id"]["native-terminal"];
  return {
    async get(input) {
      return transport.readJson(
        route().$get(
          { param: { id: input.threadId } },
          ...signalRequestArgs(input.signal),
        ),
      );
    },
    async launch(input) {
      return transport.readJson(
        route().launch.$post(
          { param: { id: input.threadId } },
          ...signalRequestArgs(input.signal),
        ),
      );
    },
    async open(input) {
      return transport.readJson(
        route().open.$post(
          {
            param: { id: input.threadId },
            json: {
              ...(input.cols !== undefined ? { cols: input.cols } : {}),
              ...(input.rows !== undefined ? { rows: input.rows } : {}),
            },
          },
          ...signalRequestArgs(input.signal),
        ),
      );
    },
    async recordSession(input) {
      return transport.readJson(
        route().session.$post(
          {
            param: { id: input.threadId },
            json: { nativeSessionId: input.nativeSessionId },
          },
          ...signalRequestArgs(input.signal),
        ),
      );
    },
  };
}
