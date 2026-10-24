import type {
  NativeTerminalActivityState,
  NativeTerminalAgentToolResult,
  NativeTerminalAgentTools,
  NativeTerminalLaunchSpec,
  NativeTerminalMode,
  NativeTerminalOpenQuestion,
  NativeTerminalThread,
} from "@bb/server-contract";
import { signalRequestArgs, type CreateSdkAreaArgs } from "./common.js";

export interface NativeTerminalThreadArgs {
  signal?: AbortSignal;
  threadId: string;
}

export interface NativeTerminalLaunchArgs extends NativeTerminalThreadArgs {
  imagesAsArgv?: boolean;
}

export interface NativeTerminalOpenArgs extends NativeTerminalThreadArgs {
  cols?: number;
  rows?: number;
}

export interface NativeTerminalRecordSessionArgs extends NativeTerminalThreadArgs {
  authorization?: string;
  nativeSessionId: string;
  replacesNativeSessionId?: string;
}

export interface NativeTerminalSwitchModeArgs extends NativeTerminalThreadArgs {
  mode: NativeTerminalMode;
}

export interface NativeTerminalReportActivityArgs extends NativeTerminalThreadArgs {
  authorization?: string;
  state: NativeTerminalActivityState;
  prompt?: string;
  questions?: NativeTerminalOpenQuestion[];
  confirms?: boolean;
  closes?: string[];
}

export interface NativeTerminalCallAgentToolArgs extends NativeTerminalThreadArgs {
  arguments: Record<string, unknown>;
  callId: string;
  tool: string;
}

export type NativeTerminalThreadResult = NativeTerminalThread;
export type NativeTerminalLaunchResult = NativeTerminalLaunchSpec;

export interface NativeTerminalsArea {
  get(
    args: NativeTerminalThreadArgs,
  ): Promise<NativeTerminalThreadResult | null>;
  launch(args: NativeTerminalLaunchArgs): Promise<NativeTerminalLaunchResult>;
  agentTools(args: NativeTerminalThreadArgs): Promise<NativeTerminalAgentTools>;
  callAgentTool(
    args: NativeTerminalCallAgentToolArgs,
  ): Promise<NativeTerminalAgentToolResult>;
  open(args: NativeTerminalOpenArgs): Promise<NativeTerminalThreadResult>;
  recordSession(
    args: NativeTerminalRecordSessionArgs,
  ): Promise<NativeTerminalThreadResult>;
  switchMode(
    args: NativeTerminalSwitchModeArgs,
  ): Promise<NativeTerminalThreadResult | null>;
  reportActivity(args: NativeTerminalReportActivityArgs): Promise<{ ok: true }>;
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
          {
            param: { id: input.threadId },
            query: input.imagesAsArgv === true ? { images: "argv" } : {},
          },
          ...signalRequestArgs(input.signal),
        ),
      );
    },
    async agentTools(input) {
      return transport.readJson(
        route()["agent-tools"].$get(
          { param: { id: input.threadId } },
          ...signalRequestArgs(input.signal),
        ),
      );
    },
    async callAgentTool(input) {
      return transport.readJson(
        route()["agent-tools"][":tool"].call.$post(
          {
            param: { id: input.threadId, tool: input.tool },
            json: { callId: input.callId, arguments: input.arguments },
          },
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
    async switchMode(input) {
      return transport.readJson(
        route().mode.$post(
          {
            param: { id: input.threadId },
            json: { mode: input.mode },
          },
          ...signalRequestArgs(input.signal),
        ),
      );
    },
    async reportActivity(input) {
      const signalOptions = signalRequestArgs(input.signal)[0];
      const init = {
        ...signalOptions?.init,
        ...(input.authorization === undefined
          ? {}
          : { headers: { authorization: input.authorization } }),
      };
      return transport.readJson(
        route().activity.$post(
          {
            param: { id: input.threadId },
            json: {
              state: input.state,
              ...(input.prompt === undefined ? {} : { prompt: input.prompt }),
              ...(input.questions === undefined
                ? {}
                : { questions: input.questions }),
              ...(input.confirms === undefined
                ? {}
                : { confirms: input.confirms }),
              ...(input.closes === undefined ? {} : { closes: input.closes }),
            },
          },
          ...(Object.keys(init).length === 0 ? [] : [{ init }]),
        ),
      );
    },
    async recordSession(input) {
      const signalOptions = signalRequestArgs(input.signal)[0];
      const init = {
        ...signalOptions?.init,
        ...(input.authorization === undefined
          ? {}
          : { headers: { authorization: input.authorization } }),
      };
      return transport.readJson(
        route().session.$post(
          {
            param: { id: input.threadId },
            json: {
              nativeSessionId: input.nativeSessionId,
              ...(input.replacesNativeSessionId === undefined
                ? {}
                : { replacesNativeSessionId: input.replacesNativeSessionId }),
            },
          },
          ...(Object.keys(init).length === 0 ? [] : [{ init }]),
        ),
      );
    },
  };
}
