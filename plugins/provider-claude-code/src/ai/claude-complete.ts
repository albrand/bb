import { spawn } from "node:child_process";
import { Buffer } from "node:buffer";
import os from "node:os";
import { z } from "zod";
import { missingClaudeCliGuidance } from "../bridge/missing-cli-error.js";
import type {
  ClaudeAiCompleteInput,
  ClaudeAiFailureCode,
  ClaudeAiTextResult,
} from "./host-contract.js";

const SYSTEM_PROMPT =
  "Follow the instructions in the user message exactly. Reply with only the requested text.";
const MAX_OUTPUT_BYTES = 1024 * 1024;
const SIGNED_OUT_PATTERN = /not logged in|please run \/login/i;
const SIGN_IN_MESSAGE = "Run `claude auth login` on the primary machine";
const PASSED_ENV = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "XDG_RUNTIME_DIR",
  "DBUS_SESSION_BUS_ADDRESS",
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "SYSTEMROOT",
  "SYSTEMDRIVE",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  "USERPROFILE",
  "USERNAME",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
  "PROGRAMFILES",
]);

const cliResultSchema = z.object({
  type: z.literal("result"),
  is_error: z.boolean(),
  result: z.string().optional(),
  api_error_status: z.number().nullish(),
});

export interface ClaudeCompleteDeps {
  executable: string;
  env: NodeJS.ProcessEnv;
}

export function claudeCompleteArgs(model: string): string[] {
  return [
    "-p",
    "--output-format",
    "json",
    "--model",
    model,
    "--tools",
    "",
    "--no-session-persistence",
    "--setting-sources",
    "",
    "--strict-mcp-config",
    "--disable-slash-commands",
    "--system-prompt",
    SYSTEM_PROMPT,
  ];
}

export function claudeCompleteEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(
      Object.entries(env).filter(
        ([key]) => PASSED_ENV.has(key.toUpperCase()) || key.startsWith("LC_"),
      ),
    ),
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
  };
}

function failure(
  code: ClaudeAiFailureCode,
  message: string,
): ClaudeAiTextResult {
  return { ok: false, code, message };
}

function failureCodeForStatus(status: number): ClaudeAiFailureCode {
  if (status === 401 || status === 403) return "auth_required";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "service_unavailable";
  return "request_failed";
}

export function parseClaudeCliResult(
  stdout: string,
  stderr: string,
  exitCode: number | null,
): ClaudeAiTextResult {
  let parsed: z.infer<typeof cliResultSchema> | null = null;
  try {
    const candidate = cliResultSchema.safeParse(JSON.parse(stdout.trim()));
    if (candidate.success) parsed = candidate.data;
  } catch {
    parsed = null;
  }
  if (parsed === null) {
    const output = `${stdout}\n${stderr}`.trim();
    if (SIGNED_OUT_PATTERN.test(output)) {
      return failure("auth_required", SIGN_IN_MESSAGE);
    }
    if (exitCode !== 0) {
      return failure(
        "request_failed",
        stderr.trim() || `Claude Code exited with code ${exitCode}`,
      );
    }
    return failure("invalid_response", "Claude Code returned no result");
  }
  if (parsed.is_error) {
    const message = parsed.result?.trim() || "Claude Code could not answer";
    if (SIGNED_OUT_PATTERN.test(message)) {
      return failure("auth_required", SIGN_IN_MESSAGE);
    }
    return failure(
      parsed.api_error_status == null
        ? "request_failed"
        : failureCodeForStatus(parsed.api_error_status),
      message,
    );
  }
  if (parsed.result === undefined) {
    return failure("invalid_response", "Claude Code returned no result");
  }
  return { ok: true, text: parsed.result };
}

export function completeClaudeInference(
  input: ClaudeAiCompleteInput,
  signal: AbortSignal,
  deps: ClaudeCompleteDeps,
): Promise<ClaudeAiTextResult> {
  if (signal.aborted) {
    return Promise.resolve(failure("timeout", "The request was cancelled"));
  }
  return new Promise((resolve) => {
    let settled = false;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const child = spawn(deps.executable, claudeCompleteArgs(input.model), {
      cwd: os.tmpdir(),
      env: claudeCompleteEnv(deps.env),
      stdio: ["pipe", "pipe", "pipe"],
    });
    const finish = (result: ClaudeAiTextResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
      resolve(result);
    };
    const timer = setTimeout(
      () =>
        finish(
          failure(
            "timeout",
            `Claude did not answer within ${input.timeoutMs}ms`,
          ),
        ),
      input.timeoutMs,
    );
    const onAbort = (): void =>
      finish(failure("timeout", "The request was cancelled"));
    signal.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      stdout.push(chunk);
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_OUTPUT_BYTES) {
        finish(failure("invalid_response", "Claude Code output was too large"));
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderrBytes >= MAX_OUTPUT_BYTES) return;
      stderr.push(chunk);
      stderrBytes += chunk.length;
    });
    child.on("error", (error: NodeJS.ErrnoException) =>
      finish(
        failure(
          "request_failed",
          error.code === "ENOENT" ? missingClaudeCliGuidance() : error.message,
        ),
      ),
    );
    child.on("close", (exitCode) =>
      finish(
        parseClaudeCliResult(
          Buffer.concat(stdout).toString("utf8"),
          Buffer.concat(stderr).toString("utf8"),
          exitCode,
        ),
      ),
    );
    child.stdin.on("error", () => {});
    child.stdin.end(input.prompt);
  });
}
