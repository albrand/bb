import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerThreadCommands } from "../commands/thread/index.js";

afterEach(() => {
  vi.restoreAllMocks();
});

function program(): Command {
  const root = new Command().exitOverride();
  registerThreadCommands(root, () => "http://127.0.0.1:1");
  for (const command of root.commands) command.exitOverride();
  return root;
}

describe("bb thread native-run --probe", () => {
  it("accepts the probe argv the server puts in the native terminal command", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await program().parseAsync(
      ["thread", "native-run", "thr_probe", "--probe", "--json"],
      { from: "user" },
    );
    expect(log).toHaveBeenCalledWith(JSON.stringify({ supported: true }));
  });

  it("rejects a probe without the thread id", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await expect(
      program().parseAsync(["thread", "native-run", "--probe"], {
        from: "user",
      }),
    ).rejects.toThrow(/missing required argument/);
  });
});
