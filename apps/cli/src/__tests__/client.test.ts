import { describe, expect, it, vi } from "vitest";
import { ACTOR_THREAD_HEADER, withActorThread } from "../client.js";

type Send = Parameters<typeof withActorThread>[0];

describe("withActorThread", () => {
  it("claims the thread in BB_THREAD_ID on every request", async () => {
    const send = vi.fn<Send>(async () => new Response("{}"));

    await withActorThread(send, { BB_THREAD_ID: "thr_caller" })(
      "http://bb.test/api/v1/threads/thr_x/archive-all",
      { method: "POST", headers: { "x-other": "kept" } },
    );

    const init = send.mock.calls[0]?.[1];
    const headers = new Headers(init?.headers);
    expect(headers.get(ACTOR_THREAD_HEADER)).toBe("thr_caller");
    expect(headers.get("x-other")).toBe("kept");
    expect(init?.method).toBe("POST");
  });

  it("claims nothing outside a thread", async () => {
    const send = vi.fn<Send>(async () => new Response("{}"));

    await withActorThread(send, {})("http://bb.test/api/v1/threads/thr_x", {
      method: "DELETE",
    });

    const headers = new Headers(send.mock.calls[0]?.[1]?.headers);
    expect(headers.has(ACTOR_THREAD_HEADER)).toBe(false);
  });
});
