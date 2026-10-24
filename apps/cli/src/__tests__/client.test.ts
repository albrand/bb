import { afterEach, describe, expect, it, vi } from "vitest";
import { createCliBbSdk } from "../client.js";

describe("CLI SDK client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("marks requests made through the CLI SDK client", async () => {
    const fetch = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        Response.json([]),
    );
    vi.stubGlobal("fetch", fetch);

    await createCliBbSdk("http://server").threads.list();

    const request = fetch.mock.calls[0]?.[1];
    expect(request).toBeDefined();
    expect(new Headers(request?.headers).get("x-bb-app-surface")).toBe("cli");
  });
});
