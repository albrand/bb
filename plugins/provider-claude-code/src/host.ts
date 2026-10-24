import os from "node:os";
import { defineRpcContract } from "@get-bb/plugin-sdk";
import {
  experimental_defineHostEntry,
  experimental_nativeRootsHostContract,
} from "@get-bb/plugin-sdk/host";
import { completeClaudeInference } from "./ai/claude-complete.js";
import { claudeAiStatusFromHealth } from "./ai/claude-status.js";
import { trustedClaudeExecutable } from "./ai/claude-executable.js";
import {
  type ClaudeAiTextResult,
  claudeAiHostContract,
} from "./ai/host-contract.js";
import { getClaudeProviderHealth } from "./bridge/provider-maintenance.js";
import { resolveClaudeNativeRoots } from "./native-roots.js";

export { experimental_providerBridge } from "./bridge/bridge.js";

const claudeHostContract = defineRpcContract({
  ...claudeAiHostContract,
  ...experimental_nativeRootsHostContract,
});

export default experimental_defineHostEntry({
  contract: claudeHostContract,
  handlers: {
    resolveNativeRoots: (input) =>
      resolveClaudeNativeRoots({
        cwd: input.cwd,
        homeDir: os.homedir(),
        env: process.env,
      }),
    "claude.ai.complete": async (input, context) => {
      const executable = await trustedClaudeExecutable();
      if (!executable.ok) {
        const refused: ClaudeAiTextResult = {
          ok: false,
          code: "request_failed",
          message: executable.message,
        };
        return refused;
      }
      return completeClaudeInference(input, context.signal, {
        executable: executable.path,
        env: process.env,
      });
    },
    "claude.ai.status": async () => {
      const executable = await trustedClaudeExecutable();
      if (!executable.ok) return { ready: false, message: executable.message };
      return claudeAiStatusFromHealth(await getClaudeProviderHealth());
    },
  },
});
