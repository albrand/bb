import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ProviderNativeTerminal } from "@bb/domain";
import { afterEach, describe, expect, it } from "vitest";
import { publishHooks } from "./helpers/hook-spool.js";
import { NativeActivityReader } from "../native-activity-reader.js";

interface ClaudePluginTestHost {
  bb: unknown;
  harness: {
    registrations: {
      providerRegistrations: {
        id: string;
        experimental_nativeTerminal?: ProviderNativeTerminal;
      }[];
    };
  };
}

const {
  createFakePluginHost,
}: {
  createFakePluginHost(options: { pluginId: string }): ClaudePluginTestHost;
} = await import(
  new URL(
    "../../../../packages/plugin-sdk/src/testing/fake-plugin-host.ts",
    import.meta.url,
  ).href
);
const { default: claudeCodePlugin }: { default(bb: unknown): void } =
  await import(
    new URL(
      "../../../../plugins/provider-claude-code/server.ts",
      import.meta.url,
    ).href
  );

const SESSION_ID = "11111111-2222-4333-8444-555555555555";
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function readFixture(name: string): Record<string, unknown>[] {
  const file = new URL(`./fixtures/${name}`, import.meta.url);
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

function jsonl(records: unknown[]): string {
  return records.map((record) => `${JSON.stringify(record)}\n`).join("");
}

function claudeDeclaration(): ProviderNativeTerminal {
  const host = createFakePluginHost({ pluginId: "provider-claude-code" });
  claudeCodePlugin(host.bb);
  const cli = host.harness.registrations.providerRegistrations.find(
    (entry) => entry.id === "claude-code",
  )?.experimental_nativeTerminal;
  if (cli === undefined) throw new Error("Claude native declaration missing");
  return cli;
}

describe("native activity over a blocked Stop followed by a long foreground tool call", () => {
  it("keeps the thread working from the Stop hook error through the unanswered foreground tool call", () => {
    const transcript = readFixture(
      "long-tool-after-blocked-stop.transcript.jsonl",
    );
    const hooks = readFixture("long-tool-after-blocked-stop.hooks.jsonl");
    const feedback = transcript.findIndex((record) => {
      const message = record.message;
      return (
        typeof message === "object" &&
        message !== null &&
        "content" in message &&
        typeof message.content === "string" &&
        message.content.startsWith("Stop hook feedback:\n")
      );
    });
    expect(feedback).toBeGreaterThan(0);
    const last = transcript[transcript.length - 1];
    const lastContent =
      typeof last.message === "object" && last.message !== null
        ? Reflect.get(last.message, "content")
        : undefined;
    expect(lastContent).toEqual([
      expect.objectContaining({ type: "tool_use", name: "Bash" }),
    ]);

    const home = mkdtempSync(path.join(os.tmpdir(), "bb-native-live-"));
    roots.push(home);
    const dir = path.join(home, ".claude", "projects", "work");
    mkdirSync(dir, { recursive: true });
    const transcriptFile = path.join(dir, `${SESSION_ID}.jsonl`);
    const eventsFile = path.join(home, "hooks.jsonl");
    writeFileSync(transcriptFile, jsonl(transcript.slice(0, feedback)));
    const prompts = hooks.filter(
      (hook) => hook.hook_event_name === "UserPromptSubmit",
    );
    const stops = hooks.filter((hook) => hook.hook_event_name === "Stop");
    expect(stops).toHaveLength(1);
    publishHooks(eventsFile, jsonl(prompts));

    const reader = new NativeActivityReader(
      claudeDeclaration(),
      { HOME: home },
      eventsFile,
      { kind: "start", id: SESSION_ID },
    );
    reader.read();
    expect(reader.heartbeat()).toEqual({ state: "working", prompt: null });

    publishHooks(eventsFile, jsonl(stops));
    reader.read();

    appendFileSync(transcriptFile, jsonl(transcript.slice(feedback)));
    reader.read();
    expect(reader.heartbeat()).toEqual({ state: "working", prompt: null });
  });
});
