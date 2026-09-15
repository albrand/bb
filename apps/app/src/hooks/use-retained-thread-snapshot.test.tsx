// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useRetainedThreadSnapshot } from "./use-retained-thread-snapshot";

describe("useRetainedThreadSnapshot", () => {
  it("keeps a same-thread snapshot visible while its query is replaced", () => {
    const firstSnapshot = { id: "thread-1", title: "First" };
    const initialProps: {
      snapshot: typeof firstSnapshot | undefined;
      threadId: string;
    } = { snapshot: firstSnapshot, threadId: "thread-1" };
    const { result, rerender } = renderHook(
      ({ snapshot, threadId }) =>
        useRetainedThreadSnapshot({ snapshot, threadId }),
      { initialProps },
    );

    rerender({ snapshot: undefined, threadId: "thread-1" });

    expect(result.current).toBe(firstSnapshot);
  });

  it("does not retain a previous thread's snapshot after navigation", () => {
    const initialProps: {
      snapshot: { id: string; title: string } | undefined;
      threadId: string;
    } = {
      snapshot: { id: "thread-1", title: "First" },
      threadId: "thread-1",
    };
    const { result, rerender } = renderHook(
      ({ snapshot, threadId }) =>
        useRetainedThreadSnapshot({ snapshot, threadId }),
      { initialProps },
    );

    rerender({ snapshot: undefined, threadId: "thread-2" });

    expect(result.current).toBeUndefined();
  });
});
