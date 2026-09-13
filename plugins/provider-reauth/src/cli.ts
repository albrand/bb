import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { REAUTH_PROVIDERS, type ReauthProviderId } from "../contract.js";
import type { ReauthCoordinator } from "./coordinator.js";

function parseProviderId(value: string | undefined): ReauthProviderId | null {
  return REAUTH_PROVIDERS.find((providerId) => providerId === value) ?? null;
}

function flagValue(argv: string[], flag: string): string | null {
  const inline = argv.find((value) => value.startsWith(`${flag}=`));
  if (inline !== undefined) return inline.slice(flag.length + 1);
  const index = argv.indexOf(flag);
  return index === -1 ? null : (argv[index + 1] ?? null);
}

export function registerProviderReauthCli(
  bb: BbPluginApi,
  coordinator: ReauthCoordinator,
): void {
  bb.cli.register({
    name: "provider-signin",
    summary: "Renew an expired provider sign-in and resume the turns it stopped",
    commands: [
      {
        name: "claude-code",
        summary: "Open the Claude Code sign-in on a host and wait for it",
        usage: "bb provider-signin claude-code --host <host-id> [--json]",
      },
      {
        name: "codex",
        summary: "Open the Codex sign-in on a host and wait for it",
        usage: "bb provider-signin codex --host <host-id> [--json]",
      },
      {
        name: "status",
        summary: "Show sign-ins bb is waiting on",
        usage: "bb provider-signin status [--json]",
      },
    ],
    async run(argv) {
      const json = argv.includes("--json");
      const [command] = argv;
      if (command === "status") {
        const running = coordinator.running();
        return {
          exitCode: 0,
          stdout: json
            ? `${JSON.stringify({ running }, null, 2)}\n`
            : running.length === 0
              ? "No provider sign-in is running.\n"
              : `${running
                  .map(
                    (run) =>
                      `${run.providerId}\t${run.hostId}\twaiting turns: ${run.waitingTurns}`,
                  )
                  .join("\n")}\n`,
        };
      }
      const providerId = parseProviderId(command);
      const hostId = flagValue(argv, "--host");
      if (providerId === null || hostId === null) {
        return {
          exitCode: 2,
          stderr:
            "Usage: bb provider-signin <claude-code|codex> --host <host-id> [--json]\n",
        };
      }
      const result = await coordinator.start({ providerId, hostId });
      return {
        exitCode: result.started ? 0 : 1,
        stdout: json
          ? `${JSON.stringify(result, null, 2)}\n`
          : `${result.reason}\n`,
      };
    },
  });
}
