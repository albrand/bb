// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getDefaultStore } from "jotai";
import { DndContext, useDraggable } from "@dnd-kit/core";
import { CompactViewportOverrideProvider } from "@/components/ui/hooks/use-compact-viewport";
import { useSidebarReorderDnd } from "@/components/ui/use-sidebar-reorder-dnd";
import { SidebarTouchSensor } from "../dnd/sidebarTouchSensor.js";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SidebarRenameProvider } from "./SidebarInlineRename.js";
import type {
  PluginSidebarPullRequest,
  PluginSidebarProject,
  PluginSidebarSplitLayout,
  PluginSidebarThread,
  PluginSidebarThreadRowStatus,
  PluginProvidersState,
  PluginBrowserBbSdk,
  PluginThreadActionEntry,
} from "@get-bb/plugin-sdk/app";
import {
  installTestPluginRuntime,
  renderSlot,
  type PluginSdkTestFakes,
  type RenderedSlot,
  type TestThreadActionsResolver,
} from "@get-bb/plugin-sdk/testing/app";
import { NO_COLLAPSED_CHILD_ACTIVITY } from "../model/thread-activity.js";
import { useAutomationWokeAt } from "../model/automation-woke.js";
import {
  makeSidebarEnvironment,
  makeSidebarThread,
} from "../model/fixtures.js";
import { sidebarShowProviderIconsAtom } from "../preferences/atoms.js";
import { SidebarProjectsContext } from "../model/use-sidebar-data.js";
import type { ThreadRowOptions } from "./ThreadRow.js";
import {
  preferenceValueAtom,
  resetPreferencesSyncForTest,
} from "../preferences/preferences-sync.js";
import {
  CustomizeRowActionsContext,
  ThreadRowActionsCustomizingContext,
} from "../list/customizeRowActionsContext.js";

installTestPluginRuntime();
const { SidebarDraftPresenceSync } =
  await import("../list/sidebarDraftPresence.js");
const { ThreadRowNavigationProvider } =
  await import("./threadRowNavigation.js");
const {
  resetSidebarTitleDoubleClickForTest,
  SidebarProvidersContext,
  ThreadRow,
} = await import("./ThreadRow.js");

const DEFAULT_OPTIONS: ThreadRowOptions = {
  kind: "default",
  depth: 1,
  isCompact: false,
};

function expectPersistentRowMetadata(element: HTMLElement) {
  expect(element.isConnected).toBe(true);
  for (
    let ancestor: HTMLElement | null = element;
    ancestor !== null;
    ancestor = ancestor.parentElement
  ) {
    const style = getComputedStyle(ancestor);
    expect(style.display).not.toBe("none");
    expect(style.visibility).not.toBe("hidden");
    expect(style.opacity).not.toBe("0");
    expect(ancestor.hidden).toBe(false);
    for (const utility of ancestor.classList) {
      expect(utility).not.toMatch(
        /^(?:(?:max-md|pointer-coarse|\[@media\(hover:none\)\]):)*(?:hidden|invisible|opacity-0|[wh]-0|size-0|scale-0)$/,
      );
    }
  }
}

function createThread(
  overrides: Partial<PluginSidebarThread> = {},
): PluginSidebarThread {
  return makeSidebarThread(overrides);
}

function createPullRequest(
  state: PluginSidebarPullRequest["state"],
  number = 10843,
  title = `${state} pull request`,
): PluginSidebarPullRequest {
  return {
    number,
    title,
    url: `https://github.com/albrand/bb/pull/${number}`,
    state,
    attention:
      state === "draft"
        ? "draft"
        : state === "merged"
          ? "merged"
          : state === "closed"
            ? "closed"
            : "none",
    experimental_autoMerge: false,
    experimental_inMergeQueue: false,
    experimental_checks: { state: "no_checks" },
    experimental_review: { state: "none" },
    experimental_mergeability: { state: "unknown" },
  };
}

function activity(
  overrides: Partial<PluginSidebarThread["activity"]>,
): PluginSidebarThread["activity"] {
  return {
    workflows: 0,
    backgroundAgents: 0,
    backgroundCommands: 0,
    planMode: 0,
    goals: 0,
    ...overrides,
  };
}

interface HarnessProps {
  thread: PluginSidebarThread;
  projects?: PluginSidebarProject[];
  providers?: PluginProvidersState["providers"];
  isCompactViewport?: boolean;
  crossProjectId?: string | null;
  isActive?: boolean;
  options?: ThreadRowOptions;
  onRowEvent?: () => void;
  onCustomizeRowActions?: (threadId: string) => void;
  onFinishCustomizingRowActions?: (restoreFocus: boolean) => void;
}

function ThreadRowHarness({
  thread,
  projects = [],
  providers = [],
  isCompactViewport,
  crossProjectId = null,
  isActive = false,
  options = DEFAULT_OPTIONS,
  onRowEvent,
  onCustomizeRowActions,
  onFinishCustomizingRowActions,
}: HarnessProps) {
  const row = (
    <ThreadRow
      thread={thread}
      crossProjectId={crossProjectId}
      isActive={isActive}
      options={options}
    />
  );
  const content = (
    <SidebarProjectsContext.Provider value={projects}>
      <SidebarProvidersContext.Provider value={providers}>
        <TooltipProvider>
          <SidebarDraftPresenceSync />
          <ThreadRowNavigationProvider>
            <SidebarRenameProvider>
              <CustomizeRowActionsContext.Provider
                value={onCustomizeRowActions ?? null}
              >
                <ThreadRowActionsCustomizingContext.Provider
                  value={
                    onFinishCustomizingRowActions
                      ? {
                          threadId: thread.id,
                          onDone: onFinishCustomizingRowActions,
                        }
                      : null
                  }
                >
                  <div
                    onPointerDown={onRowEvent}
                    onKeyDown={onRowEvent}
                    onClick={onRowEvent}
                  >
                    {row}
                  </div>
                </ThreadRowActionsCustomizingContext.Provider>
              </CustomizeRowActionsContext.Provider>
            </SidebarRenameProvider>
          </ThreadRowNavigationProvider>
        </TooltipProvider>
      </SidebarProvidersContext.Provider>
    </SidebarProjectsContext.Provider>
  );
  return isCompactViewport === undefined ? (
    content
  ) : (
    <CompactViewportOverrideProvider isCompactViewport={isCompactViewport}>
      {content}
    </CompactViewportOverrideProvider>
  );
}

function ThreadRowGalleryHarness({
  threads,
}: {
  threads: PluginSidebarThread[];
}) {
  return (
    <>
      {threads.map((thread) => (
        <ThreadRowHarness key={thread.id} thread={thread} />
      ))}
    </>
  );
}

function renderThreadRows(
  threads: PluginSidebarThread[],
  callRpc: PluginBrowserBbSdk["plugins"]["callRpc"],
): RenderedSlot {
  return renderSlot(
    { component: ThreadRowGalleryHarness },
    { threads },
    {
      sidebarThreads: { threads, projects: [] },
      sdk: { plugins: { callRpc } },
    },
  );
}

interface RenderThreadRowArgs extends Omit<HarnessProps, "thread"> {
  thread?: PluginSidebarThread;
  hasComposerDraft?: boolean;
  hiddenDraftThreadIds?: string[];
  shortcutKey?: string;
  pluginStatus?: PluginSidebarThreadRowStatus;
  splitLayout?: PluginSidebarSplitLayout;
  projects?: PluginSidebarProject[];
  providers?: PluginProvidersState["providers"];
  sidebarPullRequest?: PluginSidebarPullRequest;
  openUrl?: (url: string) => boolean;
  sdk?: PluginSdkTestFakes;
  threadActions?: TestThreadActionsResolver;
}

function renderThreadRow({
  thread = createThread(),
  hasComposerDraft = false,
  hiddenDraftThreadIds = [],
  shortcutKey,
  pluginStatus,
  splitLayout,
  projects = [],
  providers = [],
  sidebarPullRequest,
  openUrl,
  sdk,
  threadActions = hostThreadActions(),
  ...harness
}: RenderThreadRowArgs = {}): RenderedSlot & {
  rerenderThreadRow(nextThread: PluginSidebarThread): void;
} {
  const slot = renderSlot(
    { component: ThreadRowHarness },
    { thread, projects, providers, ...harness },
    {
      sidebarThreads: { threads: [thread], projects },
      providers: { providers },
      sidebarDraftThreadIds: [
        ...(hasComposerDraft ? [thread.id] : []),
        ...hiddenDraftThreadIds,
      ],
      sidebarRowStatuses: pluginStatus ? { [thread.id]: pluginStatus } : {},
      sidebarPullRequests: sidebarPullRequest
        ? { [thread.id]: sidebarPullRequest }
        : {},
      sidebarShortcuts: shortcutKey
        ? {
            [thread.id]: {
              label: `⌘${shortcutKey}`,
              ariaKeyshortcuts: `Meta+${shortcutKey}`,
            },
          }
        : {},
      sidebarSplitLayout: splitLayout,
      openUrl,
      sdk,
      threadActions,
    },
  );
  return Object.assign(slot, {
    rerenderThreadRow(nextThread: PluginSidebarThread) {
      slot.lifecycle.rerender(
        <ThreadRowHarness
          thread={nextThread}
          projects={projects}
          providers={providers}
          {...harness}
        />,
      );
    },
  });
}

function twoPaneLayout(threadId: string): PluginSidebarSplitLayout {
  return {
    panes: [
      {
        paneId: "pane-thread",
        rect: { x: 0, y: 0, width: 0.5, height: 1 },
        threadId,
        isFocused: true,
      },
      {
        paneId: "pane-compose",
        rect: { x: 0.5, y: 0, width: 0.5, height: 1 },
        threadId: null,
        isFocused: false,
      },
    ],
  };
}

function getIndicatorIcon(label: string, iconName: string): Element | null {
  screen.getByLabelText(label);
  return document.querySelector(`[data-icon="${iconName}"]`);
}

function renderSplitThreadRow(args: RenderThreadRowArgs = {}) {
  const thread = args.thread ?? createThread();
  return renderThreadRow({
    ...args,
    thread,
    splitLayout: twoPaneLayout(thread.id),
  });
}

function renderedIndicators(): Array<string | null> {
  return Array.from(
    document.querySelectorAll("[data-thread-status-glyph]"),
    (glyph) => glyph.getAttribute("data-thread-status-glyph"),
  );
}

function statusGlyph(): HTMLElement {
  const glyph = document.querySelector<HTMLElement>(
    "[data-thread-status-glyph]",
  );
  if (!glyph) {
    throw new Error("Expected a thread status glyph");
  }
  return glyph;
}

function openActionsMenu() {
  fireEvent.pointerDown(
    screen.getByRole("button", { name: "Thread actions" }),
    {
      button: 0,
    },
  );
}

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

interface RanThreadAction {
  key: string;
  threadId: string;
}

function hostThreadActions({
  ran = [],
  archiveRun,
}: {
  ran?: RanThreadAction[];
  archiveRun?: () => Promise<void>;
} = {}): TestThreadActionsResolver {
  return (thread, { requestRename }) => {
    const entry = (
      key: string,
      label: string,
      icon: string,
      run: () => Promise<void> = async () => {
        ran.push({ key, threadId: thread.id });
      },
    ): PluginThreadActionEntry => ({
      key,
      pluginId: key.split("/")[0] ?? "bb--core",
      group: "2_organize",
      action: {
        label,
        icon,
        run: () => run().catch(() => undefined),
      },
    });
    const isArchived = thread.archivedAt !== null;
    return [
      entry("bb--core/copyLink", "Copy link", "Copy"),
      entry(
        "bb--core/pin",
        thread.pinnedAt === null ? "Pin" : "Unpin",
        thread.pinnedAt === null ? "Pin" : "PinOff",
      ),
      ...(thread.parentThreadId === null && !isArchived
        ? [entry("thread-list/move", "Move to section", "SectionMove")]
        : []),
      entry("bb--core/rename", "Rename", "Edit", async () => {
        requestRename(thread.id);
      }),
      entry(
        "bb--core/archive",
        isArchived ? "Unarchive" : "Archive",
        isArchived ? "ArchiveRestore" : "Archive",
        archiveRun,
      ),
    ];
  };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetSidebarTitleDoubleClickForTest();
  resetPreferencesSyncForTest();
});

describe("ThreadRow", () => {
  it("renders bounded status chips and progress on the row", () => {
    const statuses = Object.fromEntries(
      Array.from({ length: 8 }, (_, index) => [
        `status-${index}`,
        { value: `A long status value ${index}`, priority: 8 - index },
      ]),
    );
    renderThreadRow({
      thread: createThread({
        archivedAt: Date.now(),
        experimental_rowState: {
          statuses,
          progress: { value: 0.4, label: "Implementation" },
        },
      }),
    });

    expect(
      document.querySelectorAll("[data-sidebar-thread-status-chip]"),
    ).toHaveLength(2);
    expect(screen.getByText("+6 more")).toBeTruthy();
    expect(
      screen
        .getByRole("progressbar", { name: "Implementation" })
        .getAttribute("aria-valuenow"),
    ).toBe("40");
    expect(
      screen.getByText("A long status value 0").classList.contains("truncate"),
    ).toBe(true);
  });

  it("renders cleared status and progress without stale row indicators", () => {
    const { rerenderThreadRow } = renderThreadRow({
      thread: createThread({
        archivedAt: Date.now(),
        experimental_rowState: {
          statuses: {
            removed: { value: "Cleared status" },
            remaining: { value: "Still active" },
          },
          progress: { value: 0.4, label: "In progress" },
        },
      }),
    });

    expect(screen.getByText("Cleared status")).toBeTruthy();
    expect(
      screen.getByRole("progressbar", { name: "In progress" }),
    ).toBeTruthy();

    rerenderThreadRow(
      createThread({
        archivedAt: Date.now(),
        experimental_rowState: {
          statuses: { remaining: { value: "Still active" } },
          progress: null,
        },
      }),
    );

    expect(screen.getByText("Still active")).toBeTruthy();
    expect(screen.queryByText("Cleared status")).toBeNull();
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  it("renders Needs input, Working, Woke 3m elapsed, and Done labels", async () => {
    const callRpc = vi.fn().mockResolvedValue({
      automations: [
        {
          automation: {
            lastRunStatus: "running",
            lastRunThreadId: "thr_woke",
            lastRunAt: Date.now() - (3 * 60_000 + 30_000),
          },
        },
      ],
    }) as PluginBrowserBbSdk["plugins"]["callRpc"];
    const threads = [
      createThread({
        id: "thr_input",
        hasPendingInteraction: true,
      }),
      createThread({
        id: "thr_working",
        status: "active",
        runtimeStatus: "active",
      }),
      createThread({
        id: "thr_woke",
        experimental_rowState: {
          statuses: { task: { value: "Running" } },
          progress: { value: 0.3, label: "Writing tests" },
        },
      }),
      createThread({ id: "thr_done", isUnread: true }),
    ];
    renderThreadRows(threads, callRpc);
    await waitFor(() =>
      expect(screen.getByLabelText("Needs input")).toBeTruthy(),
    );
    expect(screen.getByLabelText("Working")).toBeTruthy();
    await waitFor(() => expect(screen.getByLabelText("Woke 3m")).toBeTruthy());
    expect(screen.getByText("Running")).toBeTruthy();
    expect(
      screen.getByRole("progressbar", { name: "Writing tests" }),
    ).toBeTruthy();
    expect(screen.getByLabelText("Done")).toBeTruthy();
    expect(callRpc).toHaveBeenCalledWith(
      expect.objectContaining({
        pluginId: "automations",
        method: "automations_overview",
      }),
    );
  });

  it("reserves a compact status slot with full accessible status text", async () => {
    const callRpc = vi.fn().mockResolvedValue({
      automations: [],
    }) as PluginBrowserBbSdk["plugins"]["callRpc"];
    const { container } = renderThreadRows(
      [createThread({ id: "thr_done", isUnread: true })],
      callRpc,
    );

    await waitFor(() =>
      expect(
        container.querySelector("[data-sidebar-status-slot]"),
      ).not.toBeNull(),
    );
    expect(
      container.querySelector('[data-sidebar-status-slot][aria-label="Done"]'),
    ).not.toBeNull();
    const statusSlot = container.querySelector("[data-sidebar-status-slot]");
    expect(statusSlot?.classList.contains("whitespace-nowrap")).toBe(true);
    expect(
      statusSlot?.closest("[data-sidebar-thread-trailing]"),
    ).not.toBeNull();
    expect(
      statusSlot?.parentElement?.getAttribute("style") ?? "",
    ).not.toContain("overflow: hidden");
  });

  it("updates only rows whose automation status or elapsed minute changed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 30_000);
    const startedAt = Date.now() - 60_000;
    const callRpc = vi.fn().mockResolvedValue({
      automations: [
        {
          automation: {
            lastRunStatus: "running",
            lastRunThreadId: "thr_automation_active",
            lastRunAt: startedAt,
          },
        },
      ],
    }) as PluginBrowserBbSdk["plugins"]["callRpc"];
    const renders: Record<string, number> = {};
    const Probe = ({ threadId }: { threadId: string }) => {
      const snapshot = useAutomationWokeAt(threadId);
      renders[threadId] = (renders[threadId] ?? 0) + 1;
      return <span>{snapshot.elapsedMinutes ?? "none"}</span>;
    };
    const Probes = () => (
      <>
        <Probe threadId="thr_automation_active" />
        <Probe threadId="thr_automation_idle" />
      </>
    );
    renderSlot({ component: Probes }, {}, { sdk: { plugins: { callRpc } } });

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(callRpc).toHaveBeenCalledTimes(1);
    const beforeRefresh = { ...renders };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(40_000);
    });
    expect(renders).toEqual(beforeRefresh);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(renders["thr_automation_active"]).toBe(
      beforeRefresh["thr_automation_active"] + 1,
    );
    expect(renders["thr_automation_idle"]).toBe(
      beforeRefresh["thr_automation_idle"],
    );
  });

  it("renders open, draft, merged, and closed PR rows together", () => {
    const states = ["open", "draft", "merged", "closed"] as const;
    const threads = states.map((state) =>
      createThread({ id: `thread-${state}`, title: `${state} thread` }),
    );
    const pullRequests = Object.fromEntries(
      states.map((state, index) => [
        threads[index].id,
        createPullRequest(state, 10843 + index),
      ]),
    );
    const slot = renderSlot(
      { component: ThreadRowGalleryHarness },
      { threads },
      {
        sidebarThreads: { threads },
        sidebarPullRequests: pullRequests,
      },
    );

    for (const [index, state] of states.entries()) {
      expect(
        slot.getByRole("link", {
          name: new RegExp(`Pull request #${10843 + index}`),
        }),
      ).toBeTruthy();
      expect(slot.getByText(`${state} thread`)).toBeTruthy();
    }
  });

  it("keeps the PR chip in the trailing row while status is visible", () => {
    renderThreadRow({
      thread: createThread({ isUnread: true }),
      sidebarPullRequest: createPullRequest("open"),
    });
    const pullRequest = screen.getByRole("link", {
      name: /Pull request #10843/,
    });

    expect(pullRequest.closest(".bb-sidebar-hover-actions")).toBeNull();
    expect(
      pullRequest.closest("[data-sidebar-thread-trailing]"),
    ).not.toBeNull();
  });

  it("keeps the PR badge and row actions in the row's trailing layout lane", () => {
    const { container } = renderThreadRow({
      sidebarPullRequest: createPullRequest("open"),
    });
    const trailing = container.querySelector<HTMLElement>(
      "[data-sidebar-thread-trailing]",
    );
    const controls = container.querySelector<HTMLElement>(
      "[data-sidebar-row-controls]",
    );
    const actionSlot = controls?.parentElement;
    const pullRequest = screen.getByRole("link", {
      name: /Pull request #10843/,
    });

    expect(trailing?.contains(pullRequest)).toBe(true);
    expectPersistentRowMetadata(pullRequest);
    expect(trailing?.contains(controls)).toBe(true);
    expect(actionSlot?.classList.contains("absolute")).toBe(false);
  });

  it("reserves no permanent trailing space for hover actions on hover-capable pointers", () => {
    const { container } = renderThreadRow({
      thread: createThread({ status: "active", runtimeStatus: "active" }),
      sidebarPullRequest: createPullRequest("open"),
    });
    const controls = container.querySelector<HTMLElement>(
      "[data-sidebar-row-controls]",
    );
    const actionSlot = controls?.parentElement;
    const badges = container.querySelector<HTMLElement>(
      "[data-sidebar-thread-trailing-badges]",
    );
    const titleLane = screen.getByRole("link", {
      name: "Open Thread",
    }).parentElement;

    expect(actionSlot?.className).toContain("[@media(hover:hover)]:absolute");
    expect(actionSlot?.className).not.toMatch(/(^|\s)(w-|min-w-)\S+/);
    expect(badges?.className).toContain("bb-sidebar-hover-actions-fade");
    expect(badges?.contains(screen.getByLabelText("Working"))).toBe(true);
    expect(titleLane?.className).toContain("bb-sidebar-hover-actions-inset");
    expect(
      titleLane?.style.getPropertyValue("--bb-sidebar-hover-actions-inset"),
    ).not.toBe("");
  });

  it("fades the trailing badges while the actions menu is open so they never draw under the actions", async () => {
    const { container } = renderThreadRow({
      sidebarPullRequest: createPullRequest("open"),
    });
    const badges = container.querySelector<HTMLElement>(
      "[data-sidebar-thread-trailing-badges]",
    )!;
    expect(badges.hasAttribute("data-sidebar-hover-actions-open")).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Thread actions" }));
    await screen.findByRole("menuitem", { name: "Rename" });

    expect(badges.getAttribute("data-sidebar-hover-actions-open")).toBe("true");
    expect(badges.className).toContain("bb-sidebar-hover-actions-fade");
    expect(badges.className).toContain("[@media(hover:none)]:opacity-100!");
  });

  it("keeps working status, PR badge, and actions in the trailing layout lane", () => {
    const { container } = renderThreadRow({
      thread: createThread({ status: "active", runtimeStatus: "active" }),
      sidebarPullRequest: createPullRequest("open"),
    });
    const trailing = container.querySelector<HTMLElement>(
      "[data-sidebar-thread-trailing]",
    );
    const status = screen.getByLabelText("Working");
    const controls = container.querySelector<HTMLElement>(
      "[data-sidebar-row-controls]",
    );
    const actionSlot = controls?.parentElement;
    const pullRequest = screen.getByRole("link", {
      name: /Pull request #10843/,
    });

    expect(trailing?.contains(status)).toBe(true);
    expectPersistentRowMetadata(status);
    expectPersistentRowMetadata(pullRequest);
    expect(trailing?.contains(pullRequest)).toBe(true);
    expect(trailing?.contains(controls)).toBe(true);
    expect(actionSlot?.classList.contains("absolute")).toBe(false);
  });

  it("keeps undelivered queued messages visible and does not repeat the native activity state beside them", () => {
    const { container } = renderThreadRow({
      thread: createThread({
        status: "active",
        runtimeStatus: "active",
        queuedWork: "failed",
        experimental_queuedFailedCount: 4,
        experimental_nativeActivity: {
          lastEvidenceAt: null,
          freshForMs: 90_000,
          confirmation: "unconfirmed",
          evidenceKind: "unknown",
        },
      }),
    });

    const queued = container.querySelector(
      '[data-thread-status-glyph="queued-failed"]',
    );
    expect(queued?.getAttribute("data-queued-failed-count")).toBe("4");
    expect(
      container.querySelector("[data-sidebar-native-activity-warning]"),
    ).toBeNull();
    expect(container.querySelector('[aria-label="Working"]')).toBeNull();
    const slot = container.querySelector(
      "[data-sidebar-thread-trailing-indicator]",
    );
    expect(slot?.classList.contains("px-0")).toBe(true);
    expect(slot?.classList.contains("px-1.5")).toBe(false);
  });

  it("keeps the activity warning screen-reader only beside a queued clock, which has no status text", () => {
    const { container } = renderThreadRow({
      thread: createThread({
        lastReadAt: 1,
        latestAttentionAt: 1,
        queuedWork: "waiting",
        experimental_nativeActivity: {
          lastEvidenceAt: null,
          freshForMs: 90_000,
          confirmation: "unconfirmed",
          evidenceKind: "unknown",
        },
      }),
    });

    expect(renderedIndicators()).toEqual(["queued-waiting"]);
    const warning = container.querySelector(
      "[data-sidebar-native-activity-warning]",
    );
    expect(warning?.textContent).toBe("Activity not reported");
    expect(warning?.classList.contains("sr-only")).toBe(true);
    expect(warning?.classList.contains("text-muted-foreground")).toBe(false);
  });

  describe("recovery guidance for an activity that is not reported", () => {
    const unconfirmed = (
      evidenceKind: "tool-call" | "unknown" = "unknown",
    ) => ({
      ...(evidenceKind === "tool-call" ? { lastToolCallAt: Date.now() } : {}),
      lastEvidenceAt: null,
      freshForMs: 90_000,
      confirmation: "unconfirmed" as const,
      evidenceKind,
    });
    const guidanceOf = (container: HTMLElement) =>
      container.querySelector("[data-sidebar-native-activity-guidance]");

    it("keeps the short label, and carries the host-aware guidance in the accessible description", () => {
      const { container } = renderThreadRow({
        thread: createThread({
          id: "thr_native",
          status: "active",
          runtimeStatus: "active",
          host: { id: "host_1", name: "Build box" },
          experimental_nativeActivity: unconfirmed(),
        }),
      });
      const label = screen.getByRole("img", { name: "Activity not reported" });
      expect(label.textContent).toContain("Activity not reported");
      expect(label.getAttribute("aria-describedby")).toBe(
        guidanceOf(container)?.id,
      );
      expect(guidanceOf(container)?.textContent).toBe(
        "If this session started before bb was updated, update bb on Build box, save your work, type /exit in the terminal, then reopen with bb thread native thr_native. A pending question will need to be asked again.",
      );
      expect(
        label.querySelector("[data-sidebar-status-full]")?.textContent,
      ).toBe("Activity not reported");
    });

    it("falls back to this thread's machine when the host is unknown", () => {
      const { container } = renderThreadRow({
        thread: createThread({
          status: "active",
          runtimeStatus: "active",
          host: null,
          experimental_nativeActivity: unconfirmed(),
        }),
      });
      expect(guidanceOf(container)?.textContent).toContain(
        "update bb on this thread's machine, save your work",
      );
    });

    it("shows the guidance for tool-call-only evidence and does not turn it into Working", () => {
      const { container } = renderThreadRow({
        thread: createThread({
          status: "active",
          runtimeStatus: "active",
          experimental_nativeActivity: unconfirmed("tool-call"),
        }),
      });
      expect(guidanceOf(container)).not.toBeNull();
      expect(
        screen.getByRole("img", { name: /Agent tool call seen/u }),
      ).toBeTruthy();
      expect(container.querySelector('[aria-label="Working"]')).toBeNull();
    });

    it("shows no guidance for confirmed activity", () => {
      const { container } = renderThreadRow({
        thread: createThread({
          status: "active",
          runtimeStatus: "active",
          experimental_nativeActivity: {
            lastEvidenceAt: Date.now(),
            freshForMs: 90_000,
            confirmation: "confirmed",
            evidenceKind: "holder-report",
          },
        }),
      });
      expect(guidanceOf(container)).toBeNull();
      expect(
        container
          .querySelector("[data-sidebar-thread-trailing-indicator]")
          ?.getAttribute("aria-describedby") ?? null,
      ).toBeNull();
    });

    it("offers no action: the description is plain text", () => {
      const { container } = renderThreadRow({
        thread: createThread({
          status: "active",
          runtimeStatus: "active",
          experimental_nativeActivity: unconfirmed(),
        }),
      });
      expect(
        guidanceOf(container)?.querySelectorAll("button, a, input"),
      ).toHaveLength(0);
    });

    it("shows no guidance, no lead and no description next to a pending question", async () => {
      const { container } = renderThreadRow({
        thread: createThread({
          status: "active",
          runtimeStatus: "active",
          hasPendingInteraction: true,
          experimental_nativeActivity: unconfirmed(),
        }),
      });
      const indicator = screen.getByRole("img", { name: "Needs input" });
      expect(indicator.getAttribute("aria-describedby")).toBeNull();
      expect(guidanceOf(container)).toBeNull();
      expect(
        container.querySelector("[data-sidebar-native-activity-warning]"),
      ).toBeNull();
      expect(container.textContent).not.toContain("Activity not reported");
      fireEvent.pointerMove(indicator);
      expect((await screen.findByRole("tooltip")).textContent).toBe(
        "Needs input",
      );
    });

    it("shows no guidance, no lead and no description next to undelivered queued messages", async () => {
      const { container } = renderThreadRow({
        thread: createThread({
          status: "active",
          runtimeStatus: "active",
          queuedWork: "failed",
          experimental_queuedFailedCount: 2,
          experimental_nativeActivity: unconfirmed(),
        }),
      });
      const indicator = container.querySelector(
        "[data-sidebar-thread-trailing-indicator]",
      );
      expect(
        container.querySelector('[data-thread-status-glyph="queued-failed"]'),
      ).not.toBeNull();
      expect(indicator?.getAttribute("aria-describedby")).toBeNull();
      expect(indicator?.getAttribute("title")).toBeNull();
      expect(guidanceOf(container)).toBeNull();
      expect(
        container.querySelector("[data-sidebar-native-activity-warning]"),
      ).toBeNull();
      expect(container.textContent).not.toContain("Activity not reported");
    });

    it("leaves a pending question as Needs input", () => {
      renderThreadRow({
        thread: createThread({
          status: "active",
          runtimeStatus: "active",
          hasPendingInteraction: true,
          experimental_nativeActivity: unconfirmed(),
        }),
      });
      expect(screen.getByRole("img", { name: "Needs input" })).toBeTruthy();
      expect(screen.queryByRole("img", { name: "Working" })).toBeNull();
    });
  });

  it("shows native activity uncertainty without a runtime Working label", () => {
    const { container } = renderThreadRow({
      thread: createThread({
        status: "active",
        runtimeStatus: "active",
        experimental_nativeActivity: {
          lastEvidenceAt: null,
          freshForMs: 90_000,
          confirmation: "unconfirmed",
          evidenceKind: "unknown",
        },
      }),
    });
    const warning = screen.getByRole("img", { name: "Activity not reported" });

    expect(warning.textContent).toContain("Activity not reported");
    expect(container.querySelector('[aria-label="Working"]')).toBeNull();
  });

  it.each(
    [false, true].flatMap((isCompactViewport) =>
      (["Working", "Done"] as const).flatMap((statusLabel) =>
        (["resting", "hover", "focus", "menu-open"] as const).flatMap((state) =>
          [undefined, "3"].map((shortcutKey) => ({
            isCompactViewport,
            statusLabel,
            state,
            shortcutKey,
          })),
        ),
      ),
    ),
  )(
    "keeps $statusLabel and the PR visible in $state (mobile=$isCompactViewport, shortcut=$shortcutKey)",
    async ({ isCompactViewport, statusLabel, state, shortcutKey }) => {
      const { container } = renderThreadRow({
        thread: createThread(
          statusLabel === "Working"
            ? { status: "active", runtimeStatus: "active" }
            : { isUnread: true },
        ),
        isCompactViewport,
        shortcutKey,
        sidebarPullRequest: createPullRequest("open"),
      });
      const row = container.querySelector<HTMLElement>(
        "[data-sidebar-rename-row]",
      )!;
      const archive = screen.getByRole("button", { name: "Archive" });
      const menu = screen.getByRole("button", { name: "Thread actions" });
      if (state === "hover") {
        fireEvent.pointerEnter(row, { pointerType: "mouse" });
        fireEvent.mouseOver(row);
      } else if (state === "focus") {
        act(() => archive.focus());
        expect(document.activeElement).toBe(archive);
      } else if (state === "menu-open") {
        fireEvent.click(menu);
        await screen.findByRole("menuitem", { name: "Rename" });
        expect(
          menu.closest('[data-sidebar-hover-actions-open="true"]'),
        ).not.toBeNull();
      }
      const status = screen.getByLabelText(statusLabel);
      expect(screen.getByRole("img", { name: statusLabel })).toBe(status);
      expectPersistentRowMetadata(status);
      expectPersistentRowMetadata(
        screen.getByRole("link", { name: /Pull request #10843/ }),
      );
      const glyph = status.querySelector<HTMLElement>(
        "[data-thread-status-glyph]",
      )!;
      expect(glyph.getAttribute("data-thread-status-glyph")).toBe(
        statusLabel === "Working" ? "working" : "done-unread",
      );
      expectPersistentRowMetadata(glyph);
      if (shortcutKey) {
        expect(
          screen
            .getByRole("link", { name: "Open Thread" })
            .getAttribute("aria-keyshortcuts"),
        ).toBe("Meta+3");
        expect(
          screen.getByText("⌘3").closest("[data-sidebar-shortcut-secondary]"),
        ).not.toBeNull();
      }
      expect(status.classList.contains("shrink-0")).toBe(true);
      expect(row.querySelector(".bb-thread-title")?.classList).toContain(
        "flex-1",
      );
      expect(row.querySelector(".bb-thread-title")?.classList).toContain(
        "truncate",
      );
      expect(
        archive.closest(".bb-sidebar-hover-actions")?.classList,
      ).not.toContain("absolute");
      if (isCompactViewport) {
        expect(
          menu
            .closest("[data-sidebar-hover-actions-mobile]")
            ?.getAttribute("data-sidebar-hover-actions-mobile"),
        ).toBe("always");
      }
    },
  );

  it.each([
    ["open", "text-success-foreground"],
    ["draft", "text-muted-foreground"],
    ["merged", "text-accent-foreground"],
    ["closed", "text-destructive"],
  ] as const)(
    "shows a %s pull request chip with its state color",
    (state, tone) => {
      const stateLabel = state[0].toUpperCase() + state.slice(1);
      const slot = renderThreadRow({
        sidebarPullRequest: createPullRequest(
          state,
          10843,
          "Add sidebar PR status",
        ),
      });

      const chip = slot.getByRole("link", {
        name: `Pull request #10843: Add sidebar PR status, ${stateLabel}, albrand/bb`,
      });
      expect(chip.textContent).toBe("#10843");
      expect(chip.classList.contains(tone)).toBe(true);
    },
  );

  it("shows the PR title, state, and repository in its hover tooltip", async () => {
    const slot = renderThreadRow({
      sidebarPullRequest: createPullRequest(
        "open",
        10843,
        "Add sidebar PR status",
      ),
    });

    fireEvent.pointerMove(
      slot.getByRole("link", { name: /Pull request #10843/ }),
    );

    expect((await slot.findByRole("tooltip")).textContent).toBe(
      "Add sidebar PR status · Open · albrand/bb",
    );
  });

  it("omits the PR chip when current-branch PR data is unavailable", () => {
    const slot = renderThreadRow();

    expect(slot.queryByRole("link", { name: /Pull request/ })).toBeNull();
  });

  it("does not select the row when the PR chip is clicked", () => {
    const onRowEvent = vi.fn();
    const openUrl = vi.fn(() => true);
    const slot = renderThreadRow({
      onRowEvent,
      openUrl,
      sidebarPullRequest: createPullRequest(
        "open",
        10843,
        "Add sidebar PR status",
      ),
    });

    fireEvent.click(slot.getByRole("link", { name: /Pull request #10843/ }));

    expect(onRowEvent).not.toHaveBeenCalled();
    expect(openUrl).toHaveBeenCalledWith(
      "https://github.com/albrand/bb/pull/10843",
    );
  });

  it("shows the registered provider icon by default and keeps it visible during inline rename", async () => {
    const provider: PluginProvidersState["providers"][number] = {
      id: "provider-test",
      pluginId: "provider-test",
      displayName: "Test Provider",
      logoUrl: "/provider-test.svg",
      available: true,
      maintenance: { health: false, usage: false, installation: false },
      capabilities: {
        supportsThreadArchive: true,
        supportsThreadRename: true,
        supportsServiceTier: false,
        supportsNativeUserQuestion: false,
        supportsFork: true,
        supportsSessionRewind: false,
        modelCatalogScope: "workspace",
        permissionModes: ["accept-edits", "auto", "full"],
      },
      composerActions: [],
      completedTurnDisplay: "collapse",
    };
    const slot = renderThreadRow({ providers: [provider] });
    expect(screen.getByRole("img", { name: "Test Provider" })).toBeTruthy();
    expect(
      slot.container.querySelector('[data-provider-logo="/provider-test.svg"]'),
    ).toBeTruthy();

    fireEvent.doubleClick(screen.getByText("Thread"));
    const input = await screen.findByRole("textbox", { name: "Thread name" });
    expect(screen.getByRole("img", { name: "Test Provider" })).toBeTruthy();
    fireEvent.change(input, { target: { value: "Scratch name" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("textbox", { name: "Thread name" })).toBeNull();
    expect(screen.getByRole("img", { name: "Test Provider" })).toBeTruthy();
    expect(slot.inspection.navigateCalls).toEqual([]);

    slot.rerenderThreadRow(createThread({ providerId: "missing" }));
    expect(screen.queryByRole("img", { name: "Test Provider" })).toBeNull();
    expect(
      slot.container.querySelector("[data-sidebar-thread-provider]"),
    ).toBeNull();

    slot.rerenderThreadRow(createThread());
    act(() => getDefaultStore().set(sidebarShowProviderIconsAtom, false));
    expect(
      slot.container.querySelector("[data-sidebar-thread-provider]"),
    ).toBeNull();
  });

  it("links the row to the thread href and leaves a plain click to the host", () => {
    const slot = renderThreadRow({
      thread: createThread({ href: "/projects/proj_test/threads/thr_test" }),
    });
    const link = screen.getByRole("link", { name: "Open Thread" });
    expect(link.getAttribute("href")).toBe(
      "/projects/proj_test/threads/thr_test",
    );
    expect(link.getAttribute("data-sidebar-thread-shortcut-target")).toBe("");
    expect(link.getAttribute("data-sidebar-thread-id")).toBe("thr_test");
    expect(link.getAttribute("data-sidebar-project-id")).toBe("proj_test");
    expect(link.getAttribute("data-sidebar-rename-anchor")).toBe("");
    expect(link.closest("[data-sidebar-rename-row]")).not.toBeNull();
    fireEvent.click(link);
    expect(slot.inspection.navigateCalls).toEqual([]);
  });

  it.each([
    ["meta", { metaKey: true }],
    ["ctrl", { ctrlKey: true }],
  ])("opens the thread in a split on %s-click", (_label, modifier) => {
    const slot = renderThreadRow();
    const link = screen.getByRole("link", { name: "Open Thread" });
    const event = fireEvent.click(link, modifier);
    expect(event).toBe(false);
    expect(slot.inspection.navigateCalls).toEqual([
      { method: "toThread", threadId: "thr_test", options: { split: true } },
    ]);
  });

  it("keeps desktop restore available, hides it on mobile, and blocks row event propagation", async () => {
    const thread = createThread({ archivedAt: 1, isArchived: true });
    const rowEvent = vi.fn();
    const ran: RanThreadAction[] = [];
    renderThreadRow({
      thread,
      onRowEvent: rowEvent,
      threadActions: hostThreadActions({ ran }),
    });
    const restore = screen.getByRole("button", { name: "Unarchive" });
    expect(restore.querySelector('[data-icon="ArchiveRestore"]')).toBeTruthy();
    expect(restore.closest("[data-sidebar-hover-actions-open]")).toBeNull();
    expect(
      restore.closest(".\\[\\@media\\(hover\\:none\\)\\]\\:hidden"),
    ).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Archive" })).toBeNull();
    fireEvent.pointerDown(restore, { pointerType: "touch", button: 0 });
    fireEvent.keyDown(restore, { key: "Enter" });
    fireEvent.click(restore);
    await waitFor(() =>
      expect(ran).toEqual([{ key: "bb--core/archive", threadId: "thr_test" }]),
    );
    expect(rowEvent).not.toHaveBeenCalled();
  });

  it("disables a row action button while its run is in flight and recovers when it fails", async () => {
    const pending = deferred();
    const archiveRun = vi.fn(() => pending.promise);
    renderThreadRow({
      thread: createThread({ archivedAt: 1, isArchived: true }),
      threadActions: hostThreadActions({ archiveRun }),
    });
    const restore = screen.getByRole<HTMLButtonElement>("button", {
      name: "Unarchive",
    });
    expect(restore.disabled).toBe(false);
    fireEvent.click(restore);
    await waitFor(() => expect(restore.disabled).toBe(true));
    fireEvent.click(restore);
    expect(archiveRun).toHaveBeenCalledTimes(1);
    await act(async () => {
      pending.reject(new Error("Unarchive failed"));
      await pending.promise.catch(() => undefined);
    });
    await waitFor(() => expect(restore.disabled).toBe(false));
  });

  it("names a choice row action with its current value", () => {
    getDefaultStore().set(preferenceValueAtom("rowActions"), [
      "push-notifications/notifications",
    ]);
    renderThreadRow({
      threadActions: () => [
        {
          key: "push-notifications/notifications",
          pluginId: "push-notifications",
          group: "1_state",
          action: {
            label: "Notifications",
            detail: "Muted",
            icon: "Notification",
            choices: {
              items: [{ id: "muted", label: "Muted", selected: true }],
            },
            run: async () => undefined,
          },
        },
      ],
    });
    expect(
      screen.getByRole("button", { name: "Notifications, Muted" }),
    ).not.toBeNull();
  });

  it("shows configured row actions in order in the trailing layout lane", async () => {
    getDefaultStore().set(preferenceValueAtom("rowActions"), [
      "bb--core/pin",
      "bb--core/copyLink",
      "bb--core/archive",
    ]);
    const ran: RanThreadAction[] = [];
    renderThreadRow({ threadActions: hostThreadActions({ ran }) });
    const controls = document.querySelector("[data-sidebar-row-controls]");
    expect(
      Array.from(controls?.querySelectorAll("button") ?? []).map((button) =>
        button.getAttribute("aria-label"),
      ),
    ).toEqual(["Pin", "Copy link", "Archive", "Thread actions"]);
    expect(
      document
        .querySelector("[data-sidebar-thread-trailing]")
        ?.contains(controls ?? null),
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Pin" }));
    await waitFor(() =>
      expect(ran).toEqual([{ key: "bb--core/pin", threadId: "thr_test" }]),
    );
  });

  it("skips row action keys that have no action for the thread", () => {
    getDefaultStore().set(preferenceValueAtom("rowActions"), [
      "thread-list/move",
      "plugin-gone/action",
      "bb--core/archive",
    ]);
    renderThreadRow({
      thread: createThread({ parentThreadId: "thr_parent" }),
    });
    expect(
      screen.queryByRole("button", { name: "Move to section" }),
    ).toBeNull();
    expect(screen.getByRole("button", { name: "Archive" })).toBeTruthy();
    expect(
      document
        .querySelector("[data-sidebar-thread-trailing]")
        ?.contains(document.querySelector("[data-sidebar-row-controls]")),
    ).toBe(true);
  });

  it("shows only the actions menu when every row action is turned off", () => {
    getDefaultStore().set(preferenceValueAtom("rowActions"), []);
    renderThreadRow();
    expect(screen.queryByRole("button", { name: "Archive" })).toBeNull();
    expect(screen.getByRole("button", { name: "Thread actions" })).toBeTruthy();
    expect(
      document
        .querySelector("[data-sidebar-thread-trailing]")
        ?.contains(document.querySelector("[data-sidebar-row-controls]")),
    ).toBe(true);
  });

  it.each([
    [[]],
    [["bb--core/pin", "bb--core/copyLink", "bb--core/archive"]],
  ] as const)(
    "reserves one action for an archived row whatever the row actions (%j)",
    (rowActions) => {
      getDefaultStore().set(preferenceValueAtom("rowActions"), [...rowActions]);
      renderThreadRow({
        thread: createThread({ archivedAt: 1, isArchived: true }),
      });
      expect(screen.getByRole("button", { name: "Unarchive" })).toBeTruthy();
    },
  );

  it("starts the inline rename directly from a Rename row action", async () => {
    getDefaultStore().set(preferenceValueAtom("rowActions"), [
      "bb--core/rename",
    ]);
    renderThreadRow();
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    expect(
      await screen.findByRole("textbox", { name: "Thread name" }),
    ).toHaveProperty("value", "Thread");
  });

  it.each(["dropdown", "context"] as const)(
    "adds Customize row actions to the %s menu",
    async (surface) => {
      const customize = vi.fn();
      renderThreadRow({ onCustomizeRowActions: customize });
      if (surface === "dropdown") {
        fireEvent.click(screen.getByRole("button", { name: "Thread actions" }));
      } else {
        fireEvent.contextMenu(
          screen.getByRole("link", { name: "Open Thread" }),
        );
      }
      fireEvent.click(
        await screen.findByRole("menuitem", { name: "Customize row actions" }),
      );
      expect(customize).toHaveBeenCalledWith("thr_test");
    },
  );

  it("leaves Customize row actions out when the list cannot customize", async () => {
    renderThreadRow();
    fireEvent.click(screen.getByRole("button", { name: "Thread actions" }));
    await screen.findByRole("menuitem", { name: "Rename" });
    expect(
      screen.queryByRole("menuitem", { name: "Customize row actions" }),
    ).toBeNull();
  });

  it("customizes row actions on the real row until Done", () => {
    const finish = vi.fn();
    renderThreadRow({ onFinishCustomizingRowActions: finish });
    expect(screen.getByRole("link", { name: "Open Thread" })).toBeTruthy();
    expect(
      document
        .querySelector("[data-sidebar-thread-trailing]")
        ?.classList.contains("hidden"),
    ).toBe(true);
    expect(screen.getByRole("group", { name: "Row actions" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(finish).toHaveBeenCalledWith(true);
  });

  it.each(["dropdown", "context"] as const)(
    "starts an inline rename once the %s menu has closed",
    async (surface) => {
      renderThreadRow();
      if (surface === "dropdown") {
        fireEvent.click(screen.getByRole("button", { name: "Thread actions" }));
      } else {
        fireEvent.contextMenu(
          screen.getByRole("link", { name: "Open Thread" }),
        );
      }
      fireEvent.click(await screen.findByRole("menuitem", { name: "Rename" }));
      const input = await screen.findByRole("textbox", { name: "Thread name" });
      expect(input).toHaveProperty("value", "Thread");
    },
  );

  it("suppresses the context menu while the title is being edited", async () => {
    renderThreadRow();
    fireEvent.doubleClick(screen.getByText("Thread"));
    await screen.findByRole("textbox", { name: "Thread name" });
    expect(
      screen
        .getByTestId("bb-thread-actions-context-menu")
        .getAttribute("data-disabled"),
    ).toBe("true");
  });

  const splitWorkingCases: Array<{
    label: string;
    pluginStatus?: PluginSidebarThreadRowStatus;
    thread: PluginSidebarThread;
  }> = [
    {
      label: "runtime + pending input",
      thread: createThread({
        status: "active",
        runtimeStatus: "active",
        hasPendingInteraction: true,
      }),
    },
    {
      label: "workflow + pending input",
      thread: createThread({
        hasPendingInteraction: true,
        activity: activity({ workflows: 1 }),
      }),
    },
    {
      label: "background agent + unread error",
      thread: createThread({
        status: "error",
        activity: activity({ backgroundAgents: 1 }),
      }),
    },
    {
      label: "background command + pending input",
      thread: createThread({
        hasPendingInteraction: true,
        activity: activity({ backgroundCommands: 1 }),
      }),
    },
    {
      label: "plan mode + unread error",
      thread: createThread({
        status: "error",
        activity: activity({ planMode: 1 }),
      }),
    },
    {
      label: "goal + pending input",
      thread: createThread({
        hasPendingInteraction: true,
        activity: activity({ goals: 1 }),
      }),
    },
    {
      label: "plugin running + unread error",
      pluginStatus: {
        icon: "AiContentGenerator01",
        label: "Plugin running",
        tone: "running",
      },
      thread: createThread({ status: "error" }),
    },
  ];

  it.each(splitWorkingCases)(
    "shimmers the split map for $label",
    ({ pluginStatus, thread }) => {
      const { container } = renderSplitThreadRow({ pluginStatus, thread });

      const splitMap = screen.getByRole("img", { name: /open in split/ });
      expect(Array.from(splitMap.classList)).toContain("animate-shine-icon");
      expect(
        splitMap.closest("[data-sidebar-thread-trailing-indicator]"),
      ).not.toBeNull();
      expect(container.querySelector("[data-thread-status-glyph]")).toBeNull();
    },
  );

  it.each([
    ["idle", createThread()],
    ["unread error only", createThread({ status: "error" })],
  ])("keeps the split map static for %s", (_label, thread) => {
    renderSplitThreadRow({ thread });

    const splitMap = screen.getByRole("img", { name: /open in split/ });
    expect(Array.from(splitMap.classList)).not.toContain("animate-shine-icon");
  });

  it("marks the row as open in a split and omits the map when the thread is in no pane", () => {
    const { container, unmount } = renderSplitThreadRow();
    expect(
      container.querySelector(".bb-sidebar-open-in-split-row"),
    ).not.toBeNull();
    unmount();

    const other = renderThreadRow({ splitLayout: twoPaneLayout("thr_other") });
    expect(screen.queryByRole("img", { name: /open in split/ })).toBeNull();
    expect(
      other.container.querySelector(".bb-sidebar-open-in-split-row"),
    ).toBeNull();
  });

  it.each([
    {
      label: "pending input",
      expectedStatus: "Needs input",
      thread: createThread({ hasPendingInteraction: true }),
    },
    {
      label: "unread error",
      expectedStatus: "Done",
      thread: createThread({ status: "error" }),
    },
    {
      label: "plugin status",
      expectedStatus: "Plugin improving draft",
      pluginStatus: {
        icon: "AiContentGenerator01" as const,
        label: "Plugin improving draft",
      },
      thread: createThread(),
    },
    {
      label: "collapsed child workflow",
      expectedStatus: "Working",
      options: {
        kind: "parent" as const,
        depth: 1,
        isCompact: false,
        isCollapsed: true,
        childCount: 1,
        childActivity: {
          ...NO_COLLAPSED_CHILD_ACTIVITY,
          workflow: true,
        },
        onToggleCollapsed: vi.fn(),
      },
      thread: createThread(),
    },
  ])(
    "preserves the $label status in the split map accessible name",
    ({ expectedStatus, options, pluginStatus, thread }) => {
      renderSplitThreadRow({ options, pluginStatus, thread });

      expect(
        screen
          .getByRole("img", { name: /open in split/ })
          .getAttribute("aria-label"),
      ).toBe(`Thread — open in split; ${expectedStatus}`);
    },
  );

  it("puts the draft glyph in the trailing status slot", () => {
    renderThreadRow({
      hasComposerDraft: true,
      thread: createThread({ lastReadAt: 1, latestAttentionAt: 1 }),
    });

    const draftGlyph = statusGlyph();
    expect(draftGlyph.getAttribute("data-thread-status-glyph")).toBe("draft");
    expect(draftGlyph.hasAttribute("data-hide-idle-draft-label")).toBe(true);
    expect(
      draftGlyph.closest("[data-sidebar-thread-trailing-indicator]"),
    ).not.toBeNull();
    expect(
      screen.getByRole("link", { name: "Open Thread (unsubmitted draft)" }),
    ).not.toBeNull();
  });

  it("passes a plugin status over the draft glyph and drops it without one", () => {
    const withStatus = renderThreadRow({
      hasComposerDraft: true,
      pluginStatus: {
        icon: "AiContentGenerator01",
        label: "Plugin improving draft",
      },
      thread: createThread({ lastReadAt: 1, latestAttentionAt: 1 }),
    });

    expect(statusGlyph().getAttribute("data-thread-status-glyph")).toBe(
      "draft",
    );
    expect(statusGlyph().getAttribute("data-row-status")).toBe(
      "Plugin improving draft",
    );
    withStatus.unmount();

    renderThreadRow({
      hasComposerDraft: true,
      thread: createThread({ lastReadAt: 1, latestAttentionAt: 1 }),
    });
    expect(statusGlyph().getAttribute("data-thread-status-glyph")).toBe(
      "draft",
    );
    expect(statusGlyph().hasAttribute("data-row-status")).toBe(false);
  });

  it("keeps a plugin status alongside a keyboard shortcut", () => {
    renderThreadRow({
      pluginStatus: {
        icon: "AiContentGenerator01",
        label: "Plugin improving draft",
      },
      shortcutKey: "3",
    });

    expect(screen.getByText("⌘3")).not.toBeNull();
    expect(statusGlyph().getAttribute("data-row-status")).toBe(
      "Plugin improving draft",
    );
  });

  it("keeps a split mini-map alongside a keyboard shortcut", () => {
    renderSplitThreadRow({ shortcutKey: "3" });

    expect(screen.getByText("⌘3")).not.toBeNull();
    expect(screen.getByRole("img", { name: /open in split/ })).not.toBeNull();
  });

  it("passes the plugin status tone through to the status glyph", () => {
    renderThreadRow({
      hasComposerDraft: true,
      pluginStatus: {
        icon: "AiContentGenerator01",
        label: "Plugin improving draft",
        tone: "success",
      },
    });

    expect(statusGlyph().getAttribute("data-row-status")).toBe(
      "Plugin improving draft",
    );
    expect(statusGlyph().getAttribute("data-row-status-tone")).toBe("success");
  });

  it("keeps the runtime indicator ahead of a plugin status", () => {
    renderThreadRow({
      pluginStatus: {
        icon: "AiContentGenerator01",
        label: "Plugin improving draft",
      },
      thread: createThread({ status: "active", runtimeStatus: "active" }),
    });

    expect(renderedIndicators()).toEqual(["working"]);
    expect(
      statusGlyph().closest("[data-sidebar-thread-trailing-indicator]"),
    ).not.toBeNull();
  });

  it.each([true, false] as const)(
    "keeps the working-draft indicator ahead of the runtime indicator when isActive=%s",
    (isActive) => {
      renderThreadRow({
        hasComposerDraft: true,
        isActive,
        thread: createThread({ status: "active", runtimeStatus: "active" }),
      });

      expect(renderedIndicators()).toEqual(["working"]);
    },
  );

  it("renders the host title component and labels the row with the resolved display title", () => {
    const { container } = renderThreadRow({
      thread: createThread({
        title: "Compare @thread:thr_mentioned in @project:proj_mentioned",
        titleFallback:
          "Compare @thread:thr_mentioned in @project:proj_mentioned",
        displayTitle: "Compare Mention target in Mention project",
      }),
    });

    expect(
      container.querySelector('[data-thread-title="thr_test"]')?.textContent,
    ).toBe("Compare Mention target in Mention project");
    expect(
      screen.getByRole("link", {
        name: "Open Compare Mention target in Mention project",
      }),
    ).not.toBeNull();
    expect(
      screen.getByTitle("Compare Mention target in Mention project"),
    ).not.toBeNull();
    expect(screen.queryByText(/@thread:thr_mentioned/)).toBeNull();
  });

  it("marks a child from another project with the project name", () => {
    const { container } = renderThreadRow({
      crossProjectId: "proj_other",
      projects: [
        {
          id: "proj_other",
          name: "Web App",
          isPersonal: false,
          href: "/projects/proj_other",
          settingsHref: "/projects/proj_other/settings",
        },
      ],
      thread: createThread({
        parentThreadId: "thr_parent",
        projectId: "proj_other",
      }),
    });

    const marker = container.querySelector(
      "[data-sidebar-thread-cross-project]",
    );
    expect(marker?.getAttribute("aria-label")).toBe("In project Web App");
    expect(marker?.querySelector('[data-icon="FolderExport"]')).not.toBeNull();
    expect(
      marker?.parentElement?.previousElementSibling?.querySelector(
        ".bb-thread-title",
      ),
    ).not.toBeNull();
    expect(
      marker?.closest("[data-sidebar-thread-trailing-indicator]"),
    ).toBeNull();
    expect(
      screen.getByRole("link", { name: "Open Thread" }).getAttribute("href"),
    ).toBe("/projects/proj_other/threads/thr_test");
  });

  it("falls back to a generic label when the other project is unknown", () => {
    const { container } = renderThreadRow({
      crossProjectId: "proj_unknown",
      thread: createThread({
        parentThreadId: "thr_parent",
        projectId: "proj_unknown",
      }),
    });

    expect(
      container
        .querySelector("[data-sidebar-thread-cross-project]")
        ?.getAttribute("aria-label"),
    ).toBe("In another project");
  });

  it("opens the thread when the cross-project marker is clicked", () => {
    const { container } = renderThreadRow({
      crossProjectId: "proj_other",
      thread: createThread({
        parentThreadId: "thr_parent",
        projectId: "proj_other",
      }),
    });
    const link = screen.getByRole("link", { name: "Open Thread" });
    const onLinkClick = vi.fn();
    link.addEventListener("click", onLinkClick);

    fireEvent.click(
      container.querySelector("[data-sidebar-thread-cross-project]")!,
    );

    expect(onLinkClick).toHaveBeenCalledTimes(1);
  });

  it("omits the cross-project marker for same-project rows", () => {
    const { container } = renderThreadRow({});
    expect(
      container.querySelector("[data-sidebar-thread-cross-project]"),
    ).toBeNull();
  });

  it("shows the needs-input indicator when the thread needs user input", () => {
    renderThreadRow({
      thread: createThread({ hasPendingInteraction: true }),
    });

    expect(renderedIndicators()).toEqual(["needs-input"]);
  });

  it("clocks a thread with queued work, and drops the clock once it runs", () => {
    const { container, rerenderThreadRow } = renderThreadRow({
      thread: createThread({
        lastReadAt: 1,
        latestAttentionAt: 1,
        queuedWork: "waiting",
      }),
    });

    expect(renderedIndicators()).toEqual(["queued-waiting"]);

    rerenderThreadRow(
      createThread({
        lastReadAt: 1,
        latestAttentionAt: 1,
        queuedWork: "waiting",
        runtimeStatus: "active",
      }),
    );
    expect(renderedIndicators()).toEqual(["working"]);
  });

  it("shows unread success instead of queued work", () => {
    renderThreadRow({
      thread: createThread({
        status: "idle",
        lastReadAt: 1_000,
        latestAttentionAt: 2_000,
        queuedWork: "waiting",
      }),
    });

    expect(renderedIndicators()).toEqual(["done-unread"]);
  });

  it("keeps queue failure separate from an unread completed turn", () => {
    renderThreadRow({
      thread: createThread({
        lastReadAt: 1,
        latestAttentionAt: 1,
        queuedWork: "failed",
      }),
    });
    expect(renderedIndicators()).toEqual(["queued-failed"]);

    cleanup();
    renderThreadRow({
      thread: createThread({
        status: "error",
        lastReadAt: 0,
        latestAttentionAt: 10,
      }),
    });
    expect(renderedIndicators()).toEqual(["done-unread"]);
  });

  it.each([true, false])(
    "reserves quick-action space after parent disclosure (collapsed: %s)",
    (isCollapsed) => {
      const onToggleCollapsed = vi.fn();
      renderThreadRow({
        thread: createThread({
          title: "Nested discussion with enough text to fill the sidebar width",
          displayTitle:
            "Nested discussion with enough text to fill the sidebar width",
        }),
        options: {
          kind: "parent",
          depth: 1,
          isCompact: false,
          isCollapsed,
          childCount: 1,
          childActivity: NO_COLLAPSED_CHILD_ACTIVITY,
          onToggleCollapsed,
        },
      });
      const toggle = screen.getByRole("button", {
        name: /(?:Expand|Collapse) Nested discussion/,
      });
      const titleContainer = toggle.parentElement;
      const link = screen.getByRole("link", {
        name: "Open Nested discussion with enough text to fill the sidebar width",
      });
      const navigationTarget = link.parentElement;
      const titleWrapper = link.nextElementSibling;
      expect(titleContainer?.classList.contains("flex-1")).toBe(true);
      expect(titleContainer?.classList.contains("min-w-0")).toBe(true);
      expect(navigationTarget?.classList.contains("flex-1")).toBe(true);
      expect(titleWrapper?.classList.contains("flex-1")).toBe(true);
      expect(
        link.parentElement?.classList.contains(
          "pr-(--bb-sidebar-hover-actions-inset)",
        ),
      ).toBe(true);
      const row = link.closest("[data-sidebar-rename-row]");
      expect(
        Array.from(row?.querySelectorAll("button") ?? [], (button) =>
          button.getAttribute("aria-label"),
        ),
      ).toEqual([
        toggle.getAttribute("aria-label"),
        "Archive",
        "Thread actions",
      ]);
      fireEvent.click(toggle);
      expect(onToggleCollapsed).toHaveBeenCalledWith("thr_test");
    },
  );

  it("routes a tap on the bare row through its navigation link", () => {
    renderThreadRow();
    const link = screen.getByRole("link", { name: "Open Thread" });
    const row = link.closest("[data-sidebar-rename-row]");
    expect(row).not.toBeNull();
    const clickLink = vi.spyOn(link, "click");

    fireEvent.click(row!);
    expect(clickLink).toHaveBeenCalledOnce();

    fireEvent.click(row!.querySelector("[data-sidebar-thread-trailing]")!);
    expect(clickLink).toHaveBeenCalledTimes(2);

    fireEvent.click(link);
    expect(clickLink).toHaveBeenCalledTimes(2);
  });

  it("does not route a suppressed drag click on the trailing area", () => {
    renderThreadRow({
      options: {
        ...DEFAULT_OPTIONS,
        consumeClickSuppression: vi.fn(() => true),
      },
    });
    const link = screen.getByRole("link", { name: "Open Thread" });
    const clickLink = vi.spyOn(link, "click");
    const trailing = link
      .closest("[data-sidebar-rename-row]")
      ?.querySelector("[data-sidebar-thread-trailing]");
    expect(trailing).not.toBeNull();

    fireEvent.click(trailing!);
    expect(clickLink).not.toHaveBeenCalled();
  });

  it("keeps the parent-thread disclosure caret visible on mobile", () => {
    renderThreadRow({
      thread: createThread({
        title: "Parent thread",
        displayTitle: "Parent thread",
      }),
      options: {
        kind: "parent",
        depth: 1,
        isCompact: false,
        isCollapsed: false,
        childCount: 1,
        childActivity: NO_COLLAPSED_CHILD_ACTIVITY,
        onToggleCollapsed: vi.fn(),
      },
    });

    expect(
      screen
        .getByRole("button", { name: "Collapse Parent thread threads" })
        .getAttribute("data-sidebar-hover-actions-mobile"),
    ).toBe("always");
  });

  it.each([
    { isCollapsed: true, expectedHoverReveal: false },
    { isCollapsed: false, expectedHoverReveal: true },
  ])(
    "sets parent-thread disclosure hover reveal to $expectedHoverReveal when collapsed is $isCollapsed",
    ({ expectedHoverReveal, isCollapsed }) => {
      renderThreadRow({
        thread: createThread({
          title: "Parent thread",
          displayTitle: "Parent thread",
        }),
        options: {
          kind: "parent",
          depth: 1,
          isCompact: false,
          isCollapsed,
          childCount: 1,
          childActivity: NO_COLLAPSED_CHILD_ACTIVITY,
          onToggleCollapsed: vi.fn(),
        },
      });

      const toggle = screen.getByRole("button", {
        name: `${isCollapsed ? "Expand" : "Collapse"} Parent thread threads`,
      });
      expect(toggle.classList.contains("bb-sidebar-hover-actions")).toBe(
        expectedHoverReveal,
      );
    },
  );

  it("renders a sticky parent tier with its guide line", () => {
    const { container } = renderThreadRow({
      options: {
        kind: "parent",
        depth: 2,
        isCompact: false,
        isCollapsed: false,
        childCount: 1,
        childActivity: NO_COLLAPSED_CHILD_ACTIVITY,
        stickyLevel: 1,
        onToggleCollapsed: vi.fn(),
      },
    });
    const tier = container.querySelector<HTMLElement>(
      '[data-sidebar-sticky-tier="parent"]',
    );
    expect(tier).not.toBeNull();
    expect(
      tier?.style.getPropertyValue("--bb-sidebar-sticky-parent-level"),
    ).toBe("1");
    expect(tier?.style.paddingLeft).toBe("36px");
    expect(tier?.querySelector('[aria-hidden="true"].w-px')).not.toBeNull();
  });

  it("keeps its active indicator and actions alongside a Command shortcut", () => {
    renderThreadRow({
      shortcutKey: "3",
      thread: createThread({ status: "active", runtimeStatus: "active" }),
    });

    const shortcut = screen.getByText("⌘3");
    expect(shortcut.className).toContain("px-1.5");
    expect(shortcut.className).toContain("py-1");
    expect(shortcut.className).toContain("opacity-60");
    expect(screen.getByRole("img", { name: "Working" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "Archive" })).not.toBeNull();
    expect(
      screen.getByRole("button", { name: "Thread actions" }),
    ).not.toBeNull();
    expect(
      screen
        .getByRole("link", { name: "Open Thread" })
        .getAttribute("aria-keyshortcuts"),
    ).toBe("Meta+3");
  });

  it("shows runtime work before workflow and background work", () => {
    renderThreadRow({
      thread: createThread({
        activity: activity({
          workflows: 1,
          backgroundAgents: 1,
          backgroundCommands: 1,
        }),
        runtimeStatus: "active",
      }),
    });

    expect(renderedIndicators()).toEqual(["working"]);
  });

  it("shows the workflow indicator for an idle thread with an active workflow", () => {
    renderThreadRow({
      thread: createThread({ activity: activity({ workflows: 1 }) }),
    });

    expect(renderedIndicators()).toEqual(["working"]);
  });

  it.each([
    { activityKey: "backgroundAgents" as const, indicator: "working" },
    { activityKey: "backgroundCommands" as const, indicator: "working" },
    { activityKey: "planMode" as const, indicator: "working" },
    { activityKey: "goals" as const, indicator: "working" },
  ])(
    "shows the $indicator indicator for $activityKey activity",
    ({ activityKey, indicator }) => {
      renderThreadRow({
        thread: createThread({ activity: activity({ [activityKey]: 1 }) }),
      });

      expect(renderedIndicators()).toEqual([indicator]);
    },
  );

  it("shows workflow before background agent and command work", () => {
    renderThreadRow({
      thread: createThread({
        activity: activity({
          workflows: 1,
          backgroundAgents: 1,
          backgroundCommands: 1,
        }),
      }),
    });

    expect(renderedIndicators()).toEqual(["working"]);
  });

  it("folds background agent and command work into one working indicator", () => {
    renderThreadRow({
      thread: createThread({
        activity: activity({ backgroundAgents: 1, backgroundCommands: 1 }),
      }),
    });

    expect(renderedIndicators()).toEqual(["working"]);
  });

  it.each([
    { flag: "workflow" as const, indicator: "working" },
    { flag: "backgroundAgent" as const, indicator: "working" },
    { flag: "backgroundCommand" as const, indicator: "working" },
    { flag: "planMode" as const, indicator: "working" },
    { flag: "goal" as const, indicator: "working" },
  ])(
    "shows the $indicator indicator for collapsed parent rows with hidden $flag activity",
    ({ flag, indicator }) => {
      renderThreadRow({
        thread: createThread({ lastReadAt: 1, latestAttentionAt: 1 }),
        options: {
          kind: "parent",
          depth: 1,
          isCompact: false,
          isCollapsed: true,
          childCount: 1,
          childActivity: {
            ...NO_COLLAPSED_CHILD_ACTIVITY,
            working: true,
            [flag]: true,
          },
          onToggleCollapsed: vi.fn(),
        },
      });

      expect(renderedIndicators()).toEqual([indicator]);
    },
  );

  it("shows a working draft for collapsed descendants before named work", () => {
    renderThreadRow({
      thread: createThread({ lastReadAt: 1, latestAttentionAt: 1 }),
      hiddenDraftThreadIds: ["thr_hidden_child"],
      options: {
        kind: "parent",
        depth: 1,
        isCompact: false,
        isCollapsed: true,
        childCount: 1,
        childActivity: {
          ...NO_COLLAPSED_CHILD_ACTIVITY,
          threadIds: ["thr_hidden_child"],
          working: true,
          planMode: true,
          goal: true,
        },
        onToggleCollapsed: vi.fn(),
      },
    });

    expect(renderedIndicators()).toEqual(["working"]);
  });

  it("ignores hidden child activity once the parent is expanded", () => {
    renderThreadRow({
      thread: createThread({ lastReadAt: 1, latestAttentionAt: 1 }),
      options: {
        kind: "parent",
        depth: 1,
        isCompact: false,
        isCollapsed: false,
        childCount: 1,
        childActivity: {
          ...NO_COLLAPSED_CHILD_ACTIVITY,
          working: true,
          workflow: true,
        },
        onToggleCollapsed: vi.fn(),
      },
    });

    expect(renderedIndicators()).toEqual([]);
  });

  it("shows unread success for an already-unread successful thread on initial load", () => {
    renderThreadRow({
      thread: createThread({
        status: "idle",
        lastReadAt: 1_000,
        latestAttentionAt: 2_000,
      }),
    });

    expect(renderedIndicators()).toEqual(["done-unread"]);
  });

  it("switches directly from working to unread success after finishing", () => {
    const thread = createThread({
      status: "active",
      runtimeStatus: "active",
      lastReadAt: 1_000,
      latestAttentionAt: 1_000,
    });
    const { rerenderThreadRow } = renderThreadRow({ thread });

    expect(renderedIndicators()).toEqual(["working"]);

    rerenderThreadRow({
      ...thread,
      status: "idle",
      runtimeStatus: "idle",
      latestAttentionAt: 2_000,
      isUnread: true,
    });

    expect(renderedIndicators()).toEqual(["done-unread"]);
  });

  it("edits the row title inline after a double click and commits on Enter", async () => {
    const slot = renderThreadRow({
      sdk: { threads: { update: vi.fn().mockResolvedValue({}) } },
    });

    fireEvent.doubleClick(screen.getByText("Thread"));
    const input = await screen.findByRole("textbox", { name: "Thread name" });
    expect(input).toHaveProperty("value", "Thread");

    fireEvent.change(input, { target: { value: "Renamed thread" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(slot.inspection.sdkCalls).toEqual([
        {
          method: "threads.update",
          args: [{ threadId: "thr_test", title: "Renamed thread" }],
        },
      ]);
    });
    await waitFor(() => {
      expect(screen.queryByRole("textbox", { name: "Thread name" })).toBeNull();
    });
    expect(screen.getByText("Thread")).not.toBeNull();
  });

  it("navigates instead of renaming when the title is double-tapped on a compact viewport", async () => {
    renderThreadRow({ isCompactViewport: true });
    const link = screen.getByRole("link", { name: "Open Thread" });

    expect(fireEvent.click(link)).toBe(true);
    expect(fireEvent.click(link)).toBe(true);
    fireEvent.doubleClick(screen.getByText("Thread"));
    await act(async () => new Promise(requestAnimationFrame));

    expect(screen.queryByRole("textbox", { name: "Thread name" })).toBeNull();
  });

  it("does not start a sortable drag while editing the title", async () => {
    const onPointerDown = vi.fn();
    renderThreadRow({
      options: {
        ...DEFAULT_OPTIONS,
        dragBindings: {
          attributes: {
            role: "button",
            tabIndex: 0,
            "aria-disabled": false,
            "aria-pressed": undefined,
            "aria-roledescription": "sortable",
            "aria-describedby": "thread-sortable",
          },
          disabled: false,
          isDragging: false,
          listeners: { onPointerDown },
          setActivatorNodeRef: vi.fn(),
        },
      },
    });

    fireEvent.doubleClick(screen.getByText("Thread"));
    fireEvent.pointerDown(
      await screen.findByRole("textbox", { name: "Thread name" }),
    );

    expect(onPointerDown).not.toHaveBeenCalled();
  });

  it("restores the row when a long press opens its menu and still allows deliberate dragging", async () => {
    const onDragStart = vi.fn();
    const thread = createThread();
    function DraggableThread() {
      const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
        id: thread.id,
      });
      return (
        <ThreadRowHarness
          thread={thread}
          options={{
            ...DEFAULT_OPTIONS,
            dragBindings: {
              attributes,
              listeners,
              setActivatorNodeRef: setNodeRef,
              isDragging,
              disabled: false,
            },
          }}
        />
      );
    }
    function Harness() {
      const { dndContextProps } = useSidebarReorderDnd({
        onDragStart,
        onDragEnd: vi.fn(),
        touchSensor: SidebarTouchSensor,
      });
      return (
        <CompactViewportOverrideProvider isCompactViewport>
          <DndContext {...dndContextProps}>
            <DraggableThread />
          </DndContext>
        </CompactViewportOverrideProvider>
      );
    }
    const slot = renderSlot(
      { component: Harness },
      {},
      {
        sidebarThreads: { threads: [thread], projects: [] },
      },
    );
    const link = screen.getByRole("link", { name: "Open Thread" });
    expect(link).toHaveProperty("draggable", false);
    fireEvent.pointerDown(link, {
      pointerId: 1,
      pointerType: "touch",
      isPrimary: true,
      clientX: 10,
      clientY: 10,
    });
    fireEvent.touchStart(link, { touches: [{ clientX: 10, clientY: 10 }] });
    await act(async () => new Promise((resolve) => setTimeout(resolve, 550)));
    expect(
      slot.container.querySelector("[data-sidebar-touch-armed=true]"),
    ).not.toBeNull();
    fireEvent.contextMenu(link);
    expect(await screen.findByRole("menu")).not.toBeNull();
    expect(
      slot.container.querySelector("[data-sidebar-touch-armed-chip]"),
    ).toBeNull();
    expect(onDragStart).not.toHaveBeenCalled();
    fireEvent.touchMove(link, { touches: [{ clientX: 26, clientY: 10 }] });
    await waitFor(() => expect(onDragStart).toHaveBeenCalledTimes(1));
    expect(
      screen
        .getByTestId("bb-thread-actions-context-menu")
        .getAttribute("data-dragging"),
    ).toBe("true");
    fireEvent.touchEnd(link, { touches: [] });
  });

  it("starts touch reordering from the thread row", () => {
    const onTouchStart = vi.fn();
    renderThreadRow({
      options: {
        ...DEFAULT_OPTIONS,
        dragBindings: {
          attributes: {
            role: "button",
            tabIndex: 0,
            "aria-disabled": false,
            "aria-pressed": undefined,
            "aria-roledescription": "sortable",
            "aria-describedby": "thread-sortable",
          },
          disabled: false,
          isDragging: false,
          listeners: { onTouchStart },
          setActivatorNodeRef: vi.fn(),
        },
      },
    });

    fireEvent.touchStart(screen.getByRole("link", { name: "Open Thread" }));
    expect(onTouchStart).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Reorder Thread" })).toBeNull();
  });

  it("suppresses the click that follows a drag and drops the suppression afterwards", () => {
    const consumeClickSuppression = vi
      .fn<() => boolean>()
      .mockReturnValueOnce(true)
      .mockReturnValue(false);
    const slot = renderThreadRow({
      options: { ...DEFAULT_OPTIONS, consumeClickSuppression },
    });
    const link = screen.getByRole("link", { name: "Open Thread" });

    expect(fireEvent.click(link)).toBe(false);
    expect(fireEvent.click(link, { metaKey: true })).toBe(false);
    expect(consumeClickSuppression).toHaveBeenCalledTimes(2);
    expect(slot.inspection.navigateCalls).toEqual([
      { method: "toThread", threadId: "thr_test", options: { split: true } },
    ]);
  });

  it("starts a rename from a second click after the row remounts", async () => {
    const thread = createThread();
    const { rerenderThreadRow } = renderThreadRow({ thread });
    const link = screen.getByRole("link", { name: "Open Thread" });

    fireEvent.click(link);
    rerenderThreadRow(thread);
    fireEvent.click(screen.getByRole("link", { name: "Open Thread" }));

    expect(
      await screen.findByRole("textbox", { name: "Thread name" }),
    ).toHaveProperty("value", "Thread");
  });
});
