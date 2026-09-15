import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { experimental_createBridgeJsonRpcTestHarness as createBridgeJsonRpcTestHarness } from "@get-bb/plugin-sdk/provider-bridge/testing";
import { handleLine } from "./bridge.js";
import {
  FULL_ACCESS_SESSION_OPTIONS,
  stubFakeCodexAppServer,
} from "./fake-codex-app-server-harness.js";

const THREAD_ID = "thr_resume_hydration";
const PROVIDER_THREAD_ID = "codex-resume-hydration";

let harness: ReturnType<typeof createBridgeJsonRpcTestHarness>;
let workspaceDir: string;
let requestLogPath: string;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "bb-codex-resume-hydration-"));
  requestLogPath = join(workspaceDir, "requests.jsonl");
  const scriptPath = join(workspaceDir, "script.json");
  writeFileSync(scriptPath, JSON.stringify({ requestLogPath }), "utf8");
  stubFakeCodexAppServer(scriptPath);
  harness = createBridgeJsonRpcTestHarness(handleLine);
});

afterEach(async () => {
  const cleanupId = 993_001;
  harness.sendRequest(cleanupId, "thread/stop", {
    threadId: THREAD_ID,
    providerThreadId: PROVIDER_THREAD_ID,
    intent: "release",
    activeTurnId: null,
  });
  await harness.waitForResponse(cleanupId).catch(() => undefined);
  harness.restore();
  vi.unstubAllEnvs();
  rmSync(workspaceDir, { recursive: true, force: true });
});

it("excludes turn history when it resumes a Codex thread", async () => {
  harness.sendRequest(1, "thread/resume", {
    threadId: THREAD_ID,
    providerThreadId: PROVIDER_THREAD_ID,
    cwd: workspaceDir,
    instructionMode: "append",
    options: { ...FULL_ACCESS_SESSION_OPTIONS },
  });
  expect((await harness.waitForResponse(1)).error).toBeUndefined();

  const requests = readFileSync(requestLogPath, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(requests).toContainEqual({
    method: "thread/resume",
    params: expect.objectContaining({ excludeTurns: true }),
  });
});

it("defers a selected model until the resumed thread's next turn", async () => {
  harness.sendRequest(1, "thread/resume", {
    threadId: THREAD_ID,
    providerThreadId: PROVIDER_THREAD_ID,
    cwd: workspaceDir,
    instructionMode: "append",
    options: { ...FULL_ACCESS_SESSION_OPTIONS, model: "gpt-5.6-terra" },
  });
  expect((await harness.waitForResponse(1)).error).toBeUndefined();

  harness.sendRequest(2, "turn/start", {
    threadId: THREAD_ID,
    providerThreadId: PROVIDER_THREAD_ID,
    clientRequestId: "creq_terramede2",
    input: [{ type: "text", text: "continue", mentions: [] }],
    options: { ...FULL_ACCESS_SESSION_OPTIONS, model: "gpt-5.6-terra" },
  });
  expect((await harness.waitForResponse(2)).error).toBeUndefined();

  const requests = readFileSync(requestLogPath, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const resume = requests.find(
    (request) => request.method === "thread/resume",
  );
  const turn = requests.find((request) => request.method === "turn/start");

  expect(resume?.params).not.toHaveProperty("model");
  expect(turn?.params).toMatchObject({ model: "gpt-5.6-terra" });
});
