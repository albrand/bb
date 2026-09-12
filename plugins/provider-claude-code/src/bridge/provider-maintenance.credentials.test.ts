import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

type KeychainOutcome =
  | { kind: "value"; stdout: string }
  | { kind: "exit"; code: number | null };

const state = vi.hoisted(() => ({
  keychain: [] as KeychainOutcome[],
  keychainCalls: 0,
  file: "",
  fileReads: 0,
}));

vi.mock("node:child_process", () => ({
  execFile: (
    file: string,
    _args: readonly string[],
    _options: object,
    callback: (
      error: Error | null,
      result: { stdout: string; stderr: string },
    ) => void,
  ) => {
    if (file !== "security") {
      callback(null, { stdout: "2.1.270 (Claude Code)", stderr: "" });
      return;
    }
    const outcome =
      state.keychain[Math.min(state.keychainCalls, state.keychain.length - 1)];
    state.keychainCalls += 1;
    if (outcome === undefined || outcome.kind === "value") {
      callback(null, { stdout: outcome?.stdout ?? "", stderr: "" });
      return;
    }
    callback(Object.assign(new Error("security failed"), { code: outcome.code }), {
      stdout: "",
      stderr: "",
    });
  },
}));

vi.mock("node:fs/promises", () => ({
  default: {
    readFile: (file: string) => {
      if (!file.endsWith(".credentials.json")) {
        return Promise.resolve(
          JSON.stringify({ oauthAccount: { emailAddress: null } }),
        );
      }
      state.fileReads += 1;
      return Promise.resolve(state.file);
    },
  },
}));

vi.mock("@get-bb/plugin-sdk/provider-bridge", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@get-bb/plugin-sdk/provider-bridge")
  >()),
  experimental_resolveExecutablePath: () => Promise.resolve("/test/claude"),
}));

import {
  getClaudeProviderHealth,
  getClaudeProviderUsage,
} from "./provider-maintenance.js";

const originalPlatform = process.platform;
const KEYCHAIN_ACCESS_TOKEN = "keychain-access-token";
const FILE_ACCESS_TOKEN = "stale-file-access-token";

function credentialsJson(accessToken: string, expiresAt: number | null) {
  return JSON.stringify({
    claudeAiOauth: {
      accessToken,
      expiresAt,
      subscriptionType: "pro",
      rateLimitTier: "default_claude_max_5x",
    },
  });
}

function keychainValue(json: string): KeychainOutcome {
  return { kind: "value", stdout: Buffer.from(json, "utf8").toString("hex") };
}

beforeAll(() => {
  Object.defineProperty(process, "platform", {
    configurable: true,
    value: "darwin",
  });
});

afterAll(() => {
  Object.defineProperty(process, "platform", {
    configurable: true,
    value: originalPlatform,
  });
  vi.unstubAllGlobals();
});

beforeEach(() => {
  state.keychain = [keychainValue(credentialsJson(KEYCHAIN_ACCESS_TOKEN, null))];
  state.keychainCalls = 0;
  state.file = credentialsJson(FILE_ACCESS_TOKEN, null);
  state.fileReads = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ limits: [] }),
    }),
  );
});

describe("Claude Code credential loading", () => {
  it("loads a hex-encoded Keychain credential", async () => {
    const result = await getClaudeProviderUsage();

    expect(result).toEqual({
      supported: true,
      usage: expect.objectContaining({ status: "ok" }),
    });
  });

  it("uses the credential file only when the Keychain has no item", async () => {
    state.keychain = [{ kind: "exit", code: 44 }];

    const health = await getClaudeProviderHealth();

    expect(health).toEqual({
      supported: true,
      health: expect.objectContaining({ status: "ready" }),
    });
    expect(state.fileReads).toBe(1);
  });

  it("reports an unreadable Keychain as unknown after one retry instead of trusting the file", async () => {
    state.file = credentialsJson(FILE_ACCESS_TOKEN, 1);
    state.keychain = [{ kind: "exit", code: 36 }];

    const health = await getClaudeProviderHealth();
    const usage = await getClaudeProviderUsage();

    expect(health).toEqual({
      supported: true,
      health: expect.objectContaining({
        status: "unknown",
        statusMessage:
          "Could not read the Claude Code sign-in from the macOS Keychain.",
      }),
    });
    expect(usage).toEqual({
      supported: true,
      usage: expect.objectContaining({ status: "error" }),
    });
    expect(state.keychainCalls).toBe(8);
    expect(state.fileReads).toBe(0);
    expect(JSON.stringify([health, usage])).not.toContain(FILE_ACCESS_TOKEN);
  });

  it("recovers when the retry reads the Keychain", async () => {
    state.keychain = [
      { kind: "exit", code: null },
      { kind: "exit", code: null },
      keychainValue(credentialsJson(KEYCHAIN_ACCESS_TOKEN, null)),
    ];

    const health = await getClaudeProviderHealth();

    expect(health).toEqual({
      supported: true,
      health: expect.objectContaining({ status: "ready" }),
    });
    expect(state.fileReads).toBe(0);
  });

  it("reports a sign-in Claude Code blanked after a rejected renewal as signed out", async () => {
    state.keychain = [keychainValue(credentialsJson("", 0))];

    const health = await getClaudeProviderHealth();
    const usage = await getClaudeProviderUsage();

    expect(health).toEqual({
      supported: true,
      health: expect.objectContaining({
        status: "unauthenticated",
        statusMessage:
          "Claude Code could not renew its sign-in and needs a new one.",
        loginCommand: "claude auth login",
      }),
    });
    expect(usage).toEqual({
      supported: true,
      usage: { status: "unauthenticated" },
    });
    expect(state.fileReads).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not fall back to the credential file when the Keychain value is invalid", async () => {
    state.keychain = [{ kind: "value", stdout: "invalid-keychain-value" }];

    const result = await getClaudeProviderUsage();

    expect(result).toEqual({
      supported: true,
      usage: expect.objectContaining({
        status: "error",
        message:
          "The Claude Code sign-in in the macOS Keychain is not in a recognized format.",
      }),
    });
    expect(state.fileReads).toBe(0);
  });

  it("distinguishes usage-check throttling from an exhausted Claude limit", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 429 }),
    );

    const result = await getClaudeProviderUsage();

    expect(result).toEqual({
      supported: true,
      usage: expect.objectContaining({
        status: "error",
        message:
          "Anthropic temporarily throttled this usage check. This does not mean your Claude limit is exhausted. Try again later.",
      }),
    });
  });
});
