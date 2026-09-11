import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ThreadEvent } from "@bb/domain";
import { PROVIDER_BRIDGE_PROTOCOL_VERSION } from "@bb/provider-bridge-protocol";
import { readBridgeWorkerEntries } from "./bridge-worker-registry.js";
import type { AgentRuntimeProcessExitInfo } from "./types.js";
import { promptTextInput } from "./test/prompt-input.js";
import {
  createScriptedEchoRuntime,
  fullRuntimeOptions,
  waitForRuntimeState,
  waitForThreadTurnCompleted,
} from "./test/runtime-test-harness.js";

function shortTempDir(): string {
  return mkdtempSync(
    join(process.platform === "win32" ? tmpdir() : "/tmp", "bbw-"),
  );
}

describe("socket bridge workers", () => {
  let workspacePath: string;
  let bridgeWorkerDir: string;

  beforeEach(() => {
    workspacePath = mkdtempSync(join(tmpdir(), "bb-runtime-socket-"));
    bridgeWorkerDir = join(shortTempDir(), "bridge-workers");
  });

  afterEach(() => {
    rmSync(workspacePath, { recursive: true, force: true });
    rmSync(join(bridgeWorkerDir, ".."), { recursive: true, force: true });
  });

  it("runs a turn through a worker that the runtime reaches over a socket", async () => {
    const events: ThreadEvent[] = [];
    const runtime = createScriptedEchoRuntime({
      runtime: {
        workspacePath,
        bridgeWorkers: { dir: bridgeWorkerDir, environmentId: "env-1" },
        onEvent: (event) => events.push(event),
      },
    });
    try {
      await runtime.startThread({
        environmentId: "env-1",
        threadId: "t1",
        projectId: "p1",
        providerId: "fake",
        options: fullRuntimeOptions,
      });
      expect(
        readdirSync(bridgeWorkerDir).some((name) => name.endsWith(".sock")),
      ).toBe(true);
      const { entries } = readBridgeWorkerEntries(bridgeWorkerDir);
      expect(entries).toEqual([
        expect.objectContaining({
          environmentId: "env-1",
          pluginId: "provider-scripted-echo",
          providerId: "fake",
          bridgeProtocolVersion: PROVIDER_BRIDGE_PROTOCOL_VERSION,
        }),
      ]);
      const [registered] = entries;
      expect(registered?.processKey).toMatch(/^fake#bridge:/u);
      expect(registered?.socketPath).toBe(
        join(bridgeWorkerDir, `${registered?.id}.sock`),
      );
      expect(() => process.kill(registered?.pid ?? -1, 0)).not.toThrow();

      await runtime.runTurn({
        clientRequestId: "creq_555555554a",
        threadId: "t1",
        input: [promptTextInput({ text: "hello over a socket" })],
        options: fullRuntimeOptions,
      });
      await waitForThreadTurnCompleted({ events, threadId: "t1" });
    } finally {
      await runtime.shutdown();
    }
    expect(readdirSync(bridgeWorkerDir)).toEqual([]);
  });

  it("reports the tail of a crashed socket worker's log as its stderr", async () => {
    const bridgeModulePath = join(workspacePath, "crashing-bridge.mjs");
    writeFileSync(
      bridgeModulePath,
      [
        "export const experimental_providerBridge = {",
        "  experimental_apiVersion: 1,",
        "  handleLine() {",
        "    process.stderr.write('socket bridge exploded: kaboom\\n');",
        "    process.exit(3);",
        "  },",
        "};",
      ].join("\n"),
    );
    const exits: AgentRuntimeProcessExitInfo[] = [];
    const runtime = createScriptedEchoRuntime({
      runtime: {
        workspacePath,
        bridgeWorkers: { dir: bridgeWorkerDir, environmentId: "env-1" },
        onEvent: () => undefined,
        onProcessExit: (info) => exits.push(info),
      },
      launch: { modulePath: bridgeModulePath },
    });
    try {
      await expect(
        runtime.startThread({
          environmentId: "env-1",
          threadId: "t1",
          projectId: "p1",
          providerId: "fake",
          options: fullRuntimeOptions,
        }),
      ).rejects.toThrow(/kaboom/u);
      await waitForRuntimeState({
        label: "socket worker exit reported",
        predicate: () => exits.length === 1,
      });
      expect(exits[0]?.code).toBe(3);
      expect(exits[0]?.stderr).toContain("socket bridge exploded: kaboom");
      expect(readdirSync(bridgeWorkerDir)).toEqual([]);
    } finally {
      await runtime.shutdown();
    }
  });
});
