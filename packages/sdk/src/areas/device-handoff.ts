import type { DeviceHandoffRequest } from "@bb/server-contract";
import type { CreateSdkAreaArgs } from "./common.js";

export interface DeviceHandoffArea {
  request(args: DeviceHandoffRequest): Promise<{ delivered: number }>;
}

export function createDeviceHandoffArea(
  args: CreateSdkAreaArgs,
): DeviceHandoffArea {
  const { transport } = args;
  return {
    async request(request) {
      return transport.readJson(
        transport.api.v1["device-handoff"].$post({ json: request }),
      );
    },
  };
}
