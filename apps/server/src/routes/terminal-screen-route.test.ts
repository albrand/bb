import { readFileSync } from "node:fs";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { AppDeps } from "../types.js";
import {
  browserRequestProblem,
  requestHostProblem,
} from "../browser-request-guard.js";
import { createServerErrorHandler, ApiError } from "../errors.js";
import { registerTerminalRoutes } from "./terminals.js";

function createApp() {
  const logger = {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  };
  const terminalSessions = {
    readTerminalScreen: vi.fn(async ({ terminalId, query }) => {
      if (terminalId !== "term_allowed" || query.threadId !== "thr_allowed") {
        throw new ApiError(
          404,
          "terminal_not_found",
          "Terminal session not found",
        );
      }
      return {
        rows: ["screen"],
        cursor: { col: 0, row: 0 },
        cols: 40,
        gridRows: 5,
        truncated: false,
        complete: true,
      };
    }),
  };
  const deps = {
    config: { serverPort: 4872 },
    logger,
    terminalSessions,
  } as unknown as AppDeps;
  const app = new Hono();
  app.onError(createServerErrorHandler(logger));
  app.use("*", async (context, next) => {
    const problem = requestHostProblem(context, deps);
    if (problem !== null) {
      throw new ApiError(problem.status, "forbidden_host", problem.error);
    }
    await next();
  });
  const publicApi = new Hono();
  publicApi.use("*", async (context, next) => {
    const problem = browserRequestProblem(context, deps);
    if (problem !== null) {
      throw new ApiError(problem.status, "forbidden_origin", problem.error);
    }
    await next();
  });
  registerTerminalRoutes(publicApi, deps);
  app.route("/api/v1", publicApi);
  return { app, terminalSessions };
}

describe("terminal screen public API mounting", () => {
  it("rejects an untrusted Host before reading a snapshot", async () => {
    const { app, terminalSessions } = createApp();
    const response = await app.request(
      "http://untrusted.test/api/v1/terminals/term_allowed/screen?threadId=thr_allowed",
      { headers: { host: "untrusted.test" } },
    );
    expect(response.status).toBe(403);
    expect(terminalSessions.readTerminalScreen).not.toHaveBeenCalled();
  });

  it("rejects a cross-origin browser request before reading a snapshot", async () => {
    const { app, terminalSessions } = createApp();
    const response = await app.request(
      "http://localhost:4872/api/v1/terminals/term_allowed/screen?threadId=thr_allowed",
      { headers: { origin: "https://untrusted.test" } },
    );
    expect(response.status).toBe(403);
    expect(terminalSessions.readTerminalScreen).not.toHaveBeenCalled();
  });

  it.each([
    ["unknown terminal", "term_missing", "thr_allowed"],
    ["another thread's terminal", "term_allowed", "thr_other"],
  ])("returns 404 for %s", async (_label, terminalId, threadId) => {
    const { app } = createApp();
    const response = await app.request(
      `http://localhost:4872/api/v1/terminals/${terminalId}/screen?threadId=${threadId}`,
    );
    expect(response.status).toBe(404);
  });

  it("keeps terminal routes inside the production publicApi mount", () => {
    const source = readFileSync(
      new URL("../server.ts", import.meta.url),
      "utf8",
    );
    expect(source).toContain("registerTerminalRoutes(publicApi, deps)");
    expect(source).not.toContain("registerTerminalRoutes(app, deps)");
  });
});
