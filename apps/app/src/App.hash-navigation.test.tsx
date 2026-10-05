// @vitest-environment jsdom

import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { HashNavigationScroll } from "./App";

describe("HashNavigationScroll", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("scrolls to a destination that is already mounted", async () => {
    const scrollIntoView = vi.spyOn(Element.prototype, "scrollIntoView");
    const focus = vi.spyOn(HTMLElement.prototype, "focus");

    render(
      <MemoryRouter initialEntries={["/plugins/workflows#configuration"]}>
        <HashNavigationScroll />
        <div id="configuration" />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(scrollIntoView).toHaveBeenCalledWith({
        block: "start",
        inline: "nearest",
      });
      expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    });
  });

  it.each([
    ["/threads/thr_main#msg=187", false],
    ["/threads/thr_main#msg=187", true],
    ["/projects/proj_main/threads/thr_main#msg=187", false],
  ])(
    "leaves message fragments to the timeline for %s (matching DOM id: %s)",
    (entry, hasMatchingId) => {
      const scrollIntoView = vi.spyOn(Element.prototype, "scrollIntoView");
      const observe = vi.spyOn(MutationObserver.prototype, "observe");

      render(
        <MemoryRouter initialEntries={[entry]}>
          <HashNavigationScroll />
          {hasMatchingId ? <div id="msg=187" /> : null}
        </MemoryRouter>,
      );

      expect(scrollIntoView).not.toHaveBeenCalled();
      expect(observe).not.toHaveBeenCalled();
    },
  );

  it("keeps malformed message fragments on the hash-scroll path", () => {
    const observe = vi.spyOn(MutationObserver.prototype, "observe");

    render(
      <MemoryRouter initialEntries={["/threads/thr_main#msg=007"]}>
        <HashNavigationScroll />
      </MemoryRouter>,
    );

    expect(observe).toHaveBeenCalled();
  });

  it("waits for lazy plugin surfaces to mount", async () => {
    const scrollIntoView = vi.spyOn(Element.prototype, "scrollIntoView");
    const view = render(
      <MemoryRouter initialEntries={["/#plugin-workflows-active-runs"]}>
        <HashNavigationScroll />
      </MemoryRouter>,
    );

    expect(scrollIntoView).not.toHaveBeenCalled();

    view.rerender(
      <MemoryRouter initialEntries={["/#plugin-workflows-active-runs"]}>
        <HashNavigationScroll />
        <section id="plugin-workflows-active-runs" />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(scrollIntoView).toHaveBeenCalledWith({
        block: "start",
        inline: "nearest",
      });
    });
  });

  it("stops observing when a destination does not mount by the deadline", async () => {
    vi.useFakeTimers();
    const getElementById = vi.spyOn(document, "getElementById");
    const view = render(
      <MemoryRouter initialEntries={["/#destination-that-never-mounts"]}>
        <HashNavigationScroll />
      </MemoryRouter>,
    );

    expect(getElementById).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2_000);
    const callsAfterDeadline = getElementById.mock.calls.length;

    view.container.appendChild(document.createElement("div"));
    await Promise.resolve();

    expect(getElementById).toHaveBeenCalledTimes(callsAfterDeadline);
  });
});
