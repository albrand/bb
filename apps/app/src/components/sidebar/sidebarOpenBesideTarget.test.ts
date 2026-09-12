// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { findFocusedSidebarThread } from "./sidebarThreadShortcuts";

function sidebarRow(threadId: string, projectId: string): HTMLAnchorElement {
  const anchor = document.createElement("a");
  anchor.href = `/projects/${projectId}/threads/${threadId}`;
  anchor.dataset.sidebarThreadId = threadId;
  anchor.dataset.sidebarProjectId = projectId;
  const label = document.createElement("span");
  anchor.appendChild(label);
  document.body.appendChild(anchor);
  return anchor;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("findFocusedSidebarThread", () => {
  it("resolves the thread from the focused row, including a focused descendant", () => {
    const row = sidebarRow("thr_1", "proj_1");

    expect(findFocusedSidebarThread(row)).toEqual({
      projectId: "proj_1",
      threadId: "thr_1",
    });
    expect(findFocusedSidebarThread(row.firstElementChild)).toEqual({
      projectId: "proj_1",
      threadId: "thr_1",
    });
  });

  it("declines anything that is not a sidebar thread row", () => {
    sidebarRow("thr_1", "proj_1");
    const composer = document.createElement("textarea");
    document.body.appendChild(composer);

    expect(findFocusedSidebarThread(composer)).toBeNull();
    expect(findFocusedSidebarThread(null)).toBeNull();
  });

  it("declines a row that carries no project id", () => {
    const anchor = document.createElement("a");
    anchor.dataset.sidebarThreadId = "thr_1";
    document.body.appendChild(anchor);

    expect(findFocusedSidebarThread(anchor)).toBeNull();
  });
});
