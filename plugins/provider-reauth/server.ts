import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { providerReauthRpcContract } from "./contract.js";
import { registerProviderReauthCli } from "./src/cli.js";
import {
  createReauthCoordinator,
  type ReauthCoordinator,
} from "./src/coordinator.js";

export default async function plugin(bb: BbPluginApi): Promise<void> {
  const coordinator: ReauthCoordinator = createReauthCoordinator({ bb });

  bb.events.on("turn.failed", async (event) => {
    await coordinator.handleTurnFailed({
      threadId: event.threadId,
      requestId: event.requestId,
      errorInfo: event.errorInfo ?? null,
    });
  });

  bb.rpc.register(providerReauthRpcContract, {
    "reauth.start": (input) => coordinator.start(input),
    "reauth.status": () => ({ running: coordinator.running() }),
  });

  registerProviderReauthCli(bb, coordinator);

  return Promise.resolve();
}
