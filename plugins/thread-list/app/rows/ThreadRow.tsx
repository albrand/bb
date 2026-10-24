import {
  memo,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEventHandler,
  type PointerEventHandler,
  type ReactNode,
} from "react";
import { useComposedRefs } from "@radix-ui/react-compose-refs";
import { useAtomValue } from "jotai";
import { Icon } from "@/components/ui/icon";
import { useIsCompactViewport } from "@/components/ui/hooks/use-compact-viewport";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  COARSE_POINTER_COMPACT_ROW_HEIGHT_CLASS,
  COARSE_POINTER_ROW_ACTION_SIZE_CLASS,
  COARSE_POINTER_ROW_HEIGHT_CLASS,
} from "@/components/ui/coarse-pointer-sizing";
import { cn } from "@/lib/utils";
import { LIST_HOVER_TRANSITION } from "@/components/ui/motion";
import {
  hasThreadListWorkingActivity,
  nativeActivityGuidanceText,
  nativeActivityNoticeText,
  resolveThreadListIndicator,
  resolveThreadStatus,
  threadListIndicatorStateForThread,
  NO_COLLAPSED_CHILD_ACTIVITY,
  type CollapsedChildActivity,
  type ThreadListIndicatorState,
} from "../model/thread-activity.js";
import {
  experimental_ThreadActionsContextMenu as ThreadActionsContextMenu,
  experimental_ThreadActionsMenu as ThreadActionsMenu,
  experimental_ThreadStatusGlyph as ThreadStatusGlyph,
  experimental_THREAD_ACTION_GROUPS,
  experimental_useSidebarThreadPullRequest,
  experimental_useThreadActions,
  experimental_useSidebarThreadSplit,
  experimental_ProviderIcon as ProviderIcon,
  ThreadTitle,
  UrlLink,
  useSidebarSplitLayout,
  useSidebarThreadDraft,
  useSidebarThreadRowStatus,
  useSidebarThreadShortcut,
  useSdk,
  type PluginSidebarSplitPane,
  type PluginThreadActionsInlineItem,
  type PluginThreadActionsTriggerProps,
  type PluginSidebarThread,
  type PluginSidebarThreadRowStatus,
  type PluginProvidersState,
} from "@get-bb/plugin-sdk/app";
import type { SidebarThread } from "../model/sidebar-thread.js";
import {
  NO_THREAD_IDS,
  useThreadsHaveDraft,
} from "../list/sidebarDraftPresence.js";
import { useAutomationWokeAt } from "../model/automation-woke.js";
import { useSidebarProjectName } from "../model/use-sidebar-data.js";
import {
  sidebarShowProviderIconsAtom,
  threadRowActionsAtom,
} from "../preferences/atoms.js";
import { ShortcutPill } from "@/components/ui/shortcut-pill";
import { SidebarStickyTier } from "../ui/sidebar.js";
import {
  SIDEBAR_HOVER_ACTIONS_CLASS,
  SIDEBAR_HOVER_ACTIONS_FADE_CLASS,
  SIDEBAR_HOVER_ACTIONS_INSET_CLASS,
  SIDEBAR_HOVER_ACTIONS_MOBILE_ALWAYS_VALUE,
  SIDEBAR_HOVER_ACTIONS_ROW_CLASS,
} from "@/components/ui/sidebar-hover-actions";
import type { ConsumeDragClickSuppression } from "@/components/ui/use-drag-click-suppression";
import { SidebarChildToggleChevron } from "./SidebarChildToggleChevron.js";
import { useSidebarRename } from "./SidebarInlineRename.js";
import { SidebarRowControls } from "./SidebarRowControls.js";
import {
  SIDEBAR_CONTROL_BUTTON_CLASS,
  SIDEBAR_ROW_BASE_CLASS,
  SIDEBAR_ROW_GLYPH_SLOT_CLASS,
  SIDEBAR_ROW_ACCENT_STATE_CLASS,
  SIDEBAR_ROW_INTERACTIVE_STATE_CLASS,
  SIDEBAR_ROW_OPEN_IN_SPLIT_STATE_CLASS,
  SIDEBAR_ROW_SELECTED_STATE_CLASS,
  SIDEBAR_STATUS_GLYPH_BOX_CLASS,
  SIDEBAR_SUCCESS_STATUS_COLOR_CLASS,
  SIDEBAR_WORKING_STATUS_COLOR_CLASS,
  getSidebarThreadGroupLineLeft,
  getSidebarThreadRowPaddingLeft,
} from "@/components/ui/sidebar-row-classes";
import type {
  SidebarNestTargetState,
  SidebarReorderPlacement,
  ThreadRowNestDrop,
} from "./sidebarThreadRowDroppable.js";
import type { SidebarSortableDragBindings } from "@/components/ui/sortable-motion";
import { SidebarThreadDragChip } from "../dnd/sidebarThreadDragChip.js";
import { SplitPaneMiniMap } from "@/components/ui/split-pane-mini-map";
import { ThreadRowQuickActions } from "./ThreadRowQuickActions.js";
import { toThreadActionTarget } from "./threadActionTarget.js";
import { useOpenThreadInSplit } from "./threadRowNavigation.js";
import { Button } from "@/components/ui/button";
import { COARSE_POINTER_ICON_SIZE_CLASS } from "@/components/ui/coarse-pointer-sizing";
import {
  useCustomizeThreadRowActions,
  useThreadRowActionsCustomizing,
} from "../list/customizeRowActionsContext.js";
import {
  ThreadRowActionsEditor,
  focusFirstRowActionSlot,
} from "../list/ThreadRowActionsCustomize.js";

const SIDEBAR_TITLE_DOUBLE_CLICK_MS = 400;

export const SidebarProvidersContext = createContext<
  PluginProvidersState["providers"]
>([]);

let lastSidebarTitleClick: { at: number; threadId: string } | null = null;

function consumeSidebarTitleDoubleClick(threadId: string): boolean {
  const now = Date.now();
  const previous = lastSidebarTitleClick;
  lastSidebarTitleClick = { at: now, threadId };
  return (
    previous !== null &&
    previous.threadId === threadId &&
    now - previous.at < SIDEBAR_TITLE_DOUBLE_CLICK_MS
  );
}

export function resetSidebarTitleDoubleClickForTest(): void {
  lastSidebarTitleClick = null;
}

interface ThreadRowBaseOptions {
  depth: number;
  isCompact: boolean;
  consumeClickSuppression?: ConsumeDragClickSuppression;
  dragBindings?: SidebarSortableDragBindings;
  nestDrop?: ThreadRowNestDrop;
}

export type ThreadRowOptions =
  | (ThreadRowBaseOptions & {
      kind: "default";
    })
  | (ThreadRowBaseOptions & {
      kind: "parent";
      isCollapsed: boolean;
      childCount: number;
      childActivity: CollapsedChildActivity;
      stickyLevel?: number;
      onToggleCollapsed: (threadId: string) => void;
    });

interface ThreadRowProps {
  thread: SidebarThread;
  crossProjectId: string | null;
  isActive: boolean;
  onProjectSelect?: () => void;
  options: ThreadRowOptions;
}

type ThreadRowClickCaptureHandler = MouseEventHandler<HTMLDivElement>;

interface ThreadRowContainerArgs {
  children: ReactNode;
  className: string;
  containerRef: (element: HTMLDivElement | null) => void;
  dragBindings?: SidebarSortableDragBindings;
  nestTargetState: SidebarNestTargetState | null;
  reorderPlacement: SidebarReorderPlacement | null;
  onClick?: MouseEventHandler<HTMLDivElement>;
  onClickCapture?: ThreadRowClickCaptureHandler;
  onSplitDragPointerDown?: PointerEventHandler<HTMLElement>;
  stickyLevel?: number;
  style: CSSProperties;
}

const NEST_TARGET_STATE_CLASS: Record<SidebarNestTargetState, string> = {
  valid:
    "bg-sidebar-accent text-sidebar-accent-foreground ring-1 ring-inset ring-sidebar-ring",
  blocked: "ring-1 ring-inset ring-destructive/60",
  unchanged: "ring-1 ring-inset ring-sidebar-border",
};

export const REORDER_PLACEMENT_CLASS: Record<SidebarReorderPlacement, string> =
  {
    before:
      "before:pointer-events-none before:absolute before:inset-x-1 before:-top-px before:h-0.5 before:rounded-full before:bg-sidebar-ring before:content-['']",
    after:
      "after:pointer-events-none after:absolute after:inset-x-1 after:-bottom-px after:h-0.5 after:rounded-full after:bg-sidebar-ring after:content-['']",
  };

const HOVER_CAPABLE_ACTIONS_OVERLAY_CLASS =
  "[@media(hover:hover)]:absolute [@media(hover:hover)]:inset-y-0 [@media(hover:hover)]:right-1 [@media(hover:hover)]:z-30";

function getHoverActionsInsetStyle(actionCount: number): CSSProperties {
  return {
    "--bb-sidebar-hover-actions-inset": `calc(var(--spacing) * ${7.5 * actionCount})`,
  } as CSSProperties;
}

function getThreadRowStyle(depth: number): CSSProperties {
  return {
    paddingLeft: getSidebarThreadRowPaddingLeft(depth),
  };
}

function renderThreadRowContainer({
  children,
  className,
  containerRef,
  dragBindings,
  nestTargetState,
  onClick,
  onClickCapture,
  onSplitDragPointerDown,
  reorderPlacement,
  stickyLevel,
  style,
}: ThreadRowContainerArgs) {
  const containerProps = {
    "data-sidebar-rename-row": "",
    className,
    style,
    "data-sidebar-nest-target": nestTargetState ?? undefined,
    "data-sidebar-reorder-placement": reorderPlacement ?? undefined,
    ...dragBindings?.attributes,
    ...(dragBindings?.listeners ?? {}),
    onClick,
    onClickCapture,
    onPointerDown: onSplitDragPointerDown,
  };
  if (stickyLevel !== undefined) {
    return (
      <SidebarStickyTier
        ref={containerRef}
        tier="parent"
        level={stickyLevel}
        {...containerProps}
      >
        {children}
      </SidebarStickyTier>
    );
  }

  return (
    <div ref={containerRef} {...containerProps}>
      {children}
    </div>
  );
}

interface CollapsedThreadStatusGlyphProps {
  activity: CollapsedChildActivity;
  pluginStatus?: PluginSidebarThreadRowStatus | null;
}

export function CollapsedThreadStatusGlyph({
  activity,
  pluginStatus = null,
}: CollapsedThreadStatusGlyphProps) {
  const hasUnsubmittedDraft = useThreadsHaveDraft(activity.threadIds);
  const statusProps: ThreadListIndicatorState = {
    hasPendingInteraction: activity.pending,
    hasUnsubmittedDraft,
    hasUnreadError: activity.unreadError,
    hasUnreadSuccess: activity.unread,
    isAutomationWoken: false,
    isBackgroundAgentActive: activity.backgroundAgent,
    isBackgroundCommandActive: activity.backgroundCommand,
    isGoalActive: activity.goal,
    isActivityUnreported: false,
    queuedFailedCount: 0,
    queuedWork: "none",
    isPlanModeActive: activity.planMode,
    isRuntimeActive: activity.runtimeWorking,
    isWorkflowActive: activity.workflow,
  };
  return (
    <ThreadStatusGlyph
      indicator={resolveThreadListIndicator(statusProps)}
      rowStatus={pluginStatus}
    />
  );
}

function ThreadTrailingIndicator({
  state,
  hideIdleDraftLabel,
  rowStatus,
  nativeActivityUnconfirmed,
  nativeActivityNotice,
  nativeActivityGuidance,
  automationStartedAt,
  elapsedMinutes,
}: {
  state: ThreadListIndicatorState;
  hideIdleDraftLabel: boolean;
  rowStatus: PluginSidebarThreadRowStatus | null;
  nativeActivityUnconfirmed: boolean;
  nativeActivityNotice: string;
  nativeActivityGuidance: string | null;
  automationStartedAt: number | null;
  elapsedMinutes: number | null;
}) {
  const guidanceId = useId();
  const resolvedState = {
    ...state,
    isAutomationWoken: automationStartedAt !== null,
  };
  const { indicatorKind, rowStatusIsVisible } = resolveThreadStatus(
    resolvedState,
    rowStatus,
  );

  if (
    indicatorKind === "none" &&
    !rowStatusIsVisible &&
    !nativeActivityUnconfirmed
  ) {
    return null;
  }

  const statusText =
    indicatorKind === "needs-input"
      ? "Needs input"
      : indicatorKind === "working"
        ? `Working${elapsedMinutes === null ? "" : ` ${elapsedMinutes}m`}`
        : indicatorKind === "woke"
          ? `Woke${elapsedMinutes === null ? "" : ` ${elapsedMinutes}m`}`
          : indicatorKind === "done-unread"
            ? "Done"
            : indicatorKind === "activity-unreported"
              ? nativeActivityNotice
              : null;

  const activityNoticeApplies =
    nativeActivityUnconfirmed &&
    indicatorKind !== "needs-input" &&
    indicatorKind !== "queued-failed";
  const hasGuidance =
    indicatorKind === "activity-unreported" && nativeActivityGuidance !== null;
  const indicator = (
    <span
      aria-describedby={hasGuidance ? guidanceId : undefined}
      data-sidebar-thread-trailing-indicator=""
      data-sidebar-status-slot={statusText === null ? undefined : ""}
      className={cn(
        "inline-flex h-5 shrink-0 items-center gap-1.5 rounded-full px-1.5 font-medium text-xs",
        statusText !== null && "justify-end gap-1 whitespace-nowrap px-0",
        statusText === null && "px-0",
        indicatorKind === "needs-input" && "text-destructive-text",
        indicatorKind === "working" && SIDEBAR_WORKING_STATUS_COLOR_CLASS,
        indicatorKind === "woke" && "text-warning",
        indicatorKind === "done-unread" && SIDEBAR_SUCCESS_STATUS_COLOR_CLASS,
        statusText === null && SIDEBAR_ROW_GLYPH_SLOT_CLASS,
        statusText === null && SIDEBAR_STATUS_GLYPH_BOX_CLASS,
      )}
      role={statusText === null ? undefined : "img"}
      aria-label={statusText ?? undefined}
      title={
        statusText === null && activityNoticeApplies && !hasGuidance
          ? nativeActivityNotice
          : undefined
      }
    >
      <ThreadStatusGlyph
        indicator={indicatorKind}
        rowStatus={rowStatus}
        hideIdleDraftLabel={hideIdleDraftLabel}
        hideAccessibleLabel={statusText !== null}
        experimental_queuedFailedCount={state.queuedFailedCount}
      />
      {statusText === null ? null : (
        <span data-sidebar-status-full="" className="text-right">
          {statusText}
        </span>
      )}
      {activityNoticeApplies && indicatorKind !== "activity-unreported" ? (
        <span
          data-sidebar-native-activity-warning=""
          className={statusText === null ? "sr-only" : "text-muted-foreground"}
          role="status"
        >
          {nativeActivityNotice}
        </span>
      ) : null}
      {hasGuidance ? (
        <span
          data-sidebar-native-activity-guidance=""
          id={guidanceId}
          className="sr-only"
        >
          {nativeActivityGuidance}
        </span>
      ) : null}
    </span>
  );
  if (statusText === null && !hasGuidance) return indicator;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{indicator}</TooltipTrigger>
      <TooltipContent side="top">
        {[
          statusText ?? nativeActivityNotice,
          hasGuidance ? nativeActivityGuidance : null,
        ]
          .filter((text) => text !== null)
          .join(". ")}
      </TooltipContent>
    </Tooltip>
  );
}

function isNativeActivityNotConfirmed(
  thread: Pick<PluginSidebarThread, "experimental_nativeActivity">,
): boolean {
  const activity = thread.experimental_nativeActivity;
  return activity !== undefined && activity.confirmation !== "confirmed";
}

const ARCHIVED_ROW_ACTION_KEYS = ["bb--core/archive"];
const CUSTOMIZE_ROW_ACTIONS_KEY = "thread-list/customizeRowActions";

function renderThreadActionsTrigger(props: PluginThreadActionsTriggerProps) {
  return (
    <Button
      {...props}
      type="button"
      variant="ghost"
      size="icon"
      className={cn(
        props.className,
        "rounded-md p-0",
        "data-[state=open]:bg-state-active data-[state=open]:text-foreground",
        SIDEBAR_CONTROL_BUTTON_CLASS,
      )}
      aria-label="Thread actions"
      data-thread-actions-trigger=""
      onClick={(event) => {
        props.onClick?.(event);
        event.stopPropagation();
      }}
    >
      <Icon name="MoreHorizontal" className={COARSE_POINTER_ICON_SIZE_CLASS} />
    </Button>
  );
}

const PULL_REQUEST_STATE_CLASS = {
  draft: "text-muted-foreground",
  open: "text-success-foreground",
  merged: "text-accent-foreground",
  closed: "text-destructive",
} as const;

function getPullRequestRepository(url: string): string {
  const parsedUrl = new URL(url);
  const pathSegments = parsedUrl.pathname.split("/").filter(Boolean);
  const pullRequestSegment = pathSegments.findIndex((segment) =>
    [
      "pull",
      "pulls",
      "pull-requests",
      "merge_requests",
      "pullrequest",
    ].includes(segment.toLowerCase()),
  );
  const repositorySegments = (
    pullRequestSegment >= 0
      ? pathSegments.slice(0, pullRequestSegment)
      : pathSegments.slice(0, 2)
  ).filter((segment) => segment !== "-" && segment !== "_git");

  return repositorySegments.length > 0
    ? repositorySegments.join("/")
    : parsedUrl.hostname;
}

function SidebarThreadPullRequestChip({ threadId }: { threadId: string }) {
  const { pullRequest } = experimental_useSidebarThreadPullRequest(threadId);
  if (pullRequest === null) return null;

  const stateLabel =
    pullRequest.state[0].toUpperCase() + pullRequest.state.slice(1);
  const repository = getPullRequestRepository(pullRequest.url);
  const accessibleLabel = `Pull request #${pullRequest.number}: ${pullRequest.title}, ${stateLabel}, ${repository}`;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <UrlLink
          data-sidebar-thread-pull-request=""
          href={pullRequest.url}
          aria-label={accessibleLabel}
          onClick={(event) => event.stopPropagation()}
          className={cn(
            "relative z-20 shrink-0 whitespace-nowrap rounded-sm px-1 text-xs font-medium tabular-nums no-underline outline-none focus-visible:ring-1 focus-visible:ring-ring hover:underline",
            PULL_REQUEST_STATE_CLASS[pullRequest.state],
          )}
        >
          #{pullRequest.number}
        </UrlLink>
      </TooltipTrigger>
      <TooltipContent side="top">
        {pullRequest.title} · {stateLabel} · {repository}
      </TooltipContent>
    </Tooltip>
  );
}

function useThreadSplitMiniMap(
  threadId: string,
): readonly PluginSidebarSplitPane[] | null {
  const layout = useSidebarSplitLayout();
  return useMemo(() => {
    if (layout === null) return null;
    const slots = layout.panes.map<PluginSidebarSplitPane>((pane) => ({
      paneId: pane.paneId,
      rect: pane.rect,
      isMe: pane.threadId === threadId,
      isFocused: pane.isFocused,
    }));
    return slots.some((slot) => slot.isMe) ? slots : null;
  }, [layout, threadId]);
}

function ThreadRowComponent({
  thread,
  crossProjectId,
  isActive,
  onProjectSelect,
  options,
}: ThreadRowProps) {
  const [isDropdownActionsOpen, setIsDropdownActionsOpen] = useState(false);
  const [isContextActionsOpen, setIsContextActionsOpen] = useState(false);
  const sdk = useSdk();
  const openThreadInSplit = useOpenThreadInSplit();
  const showProviderIcons = useAtomValue(sidebarShowProviderIconsAtom);
  const providers = useContext(SidebarProvidersContext);
  const provider = showProviderIcons
    ? providers.find((candidate) => candidate.id === thread.providerId)
    : undefined;
  const shortcut = useSidebarThreadShortcut(thread.id);
  const pluginThreadRowStatus = useSidebarThreadRowStatus(thread.id);
  const { hasUnsubmittedDraft: hasComposerDraft } = useSidebarThreadDraft(
    thread.id,
  );
  const showActive = isActive;
  const threadStatus = threadListIndicatorStateForThread(
    thread,
    hasComposerDraft,
  );
  const labelTitle = thread.displayTitle;
  const crossProjectName = useSidebarProjectName(crossProjectId);
  const crossProjectLabel =
    crossProjectId === null
      ? null
      : crossProjectName
        ? `In project ${crossProjectName}`
        : "In another project";
  const handleRename = useCallback(
    async (nextTitle: string) => {
      await sdk.threads.update({ threadId: thread.id, title: nextTitle });
    },
    [sdk, thread.id],
  );
  const rename = useSidebarRename({
    kind: "thread",
    id: thread.id,
    name: labelTitle,
    label: "Thread name",
    onSave: handleRename,
  });
  const { editor, isEditing, startEditing, startEditingFromDoubleClick } =
    rename;
  const finishCustomizingActions = useThreadRowActionsCustomizing(thread.id);
  const isCustomizingActions = finishCustomizingActions !== null;
  const startTitleEditing = useCallback(
    (event: { preventDefault: () => void; stopPropagation: () => void }) => {
      event.preventDefault();
      event.stopPropagation();
      startEditingFromDoubleClick();
    },
    [startEditingFromDoubleClick],
  );
  const miniMap = useThreadSplitMiniMap(thread.id);
  const { startedAt: automationStartedAt, elapsedMinutes } =
    useAutomationWokeAt(
      thread.id,
      miniMap === null && thread.archivedAt === null,
    );
  const isOpenInSplit = miniMap !== null;
  const split = experimental_useSidebarThreadSplit(thread.id);
  const onSplitDragPointerDown = split.splitProps.onPointerDown;
  const splitAvailable = split.isAvailable;
  const openInSplit = useCallback(() => {
    openThreadInSplit(thread.id);
  }, [openThreadInSplit, thread.id]);
  const rowActionKeys = useAtomValue(threadRowActionsAtom);
  const actionTarget = toThreadActionTarget(thread);
  const quickActions = experimental_useThreadActions(actionTarget, {
    keys: thread.archivedAt !== null ? ARCHIVED_ROW_ACTION_KEYS : rowActionKeys,
    requestRename: () => {
      startEditing();
    },
  });
  const customizeRowActions = useCustomizeThreadRowActions();
  const isCompactViewport = useIsCompactViewport();
  const pendingMenuCustomize = useRef<(() => void) | null>(null);
  const inlineMenuActions: PluginThreadActionsInlineItem[] =
    customizeRowActions === null
      ? []
      : [
          {
            key: CUSTOMIZE_ROW_ACTIONS_KEY,
            group: experimental_THREAD_ACTION_GROUPS.settings,
            action: {
              label: "Customize row actions",
              icon: "FilterHorizontal",
              run: () => {
                const begin = () => customizeRowActions(thread.id);
                if (isCompactViewport) begin();
                else pendingMenuCustomize.current = begin;
              },
            },
          },
        ];
  const requestRenameFromMenu = () => {
    rename.startEditingFromMenu();
  };
  const parentOptions = options.kind === "parent" ? options : null;
  const isParentRow = parentOptions !== null;
  const isParentCollapsed = parentOptions?.isCollapsed ?? false;
  const childCount = parentOptions?.childCount ?? 0;
  const childActivity =
    parentOptions?.childActivity ?? NO_COLLAPSED_CHILD_ACTIVITY;
  const hasChildren = childCount > 0;
  const reserveActionSpace =
    crossProjectLabel !== null || (isParentRow && hasChildren);
  const hasHiddenChildren = isParentRow && isParentCollapsed && hasChildren;
  const hiddenChildrenHaveDraft = useThreadsHaveDraft(
    hasHiddenChildren ? childActivity.threadIds : NO_THREAD_IDS,
  );
  const trailingIndicatorState: ThreadListIndicatorState = {
    hasPendingInteraction:
      threadStatus.hasPendingInteraction ||
      (hasHiddenChildren && childActivity.pending),
    hasUnsubmittedDraft:
      threadStatus.hasUnsubmittedDraft || hiddenChildrenHaveDraft,
    hasUnreadError:
      threadStatus.hasUnreadError ||
      (hasHiddenChildren && childActivity.unreadError),
    hasUnreadSuccess:
      threadStatus.hasUnreadSuccess ||
      (hasHiddenChildren && childActivity.unread),
    isAutomationWoken: false,
    isBackgroundAgentActive:
      threadStatus.isBackgroundAgentActive ||
      (hasHiddenChildren && childActivity.backgroundAgent),
    isBackgroundCommandActive:
      threadStatus.isBackgroundCommandActive ||
      (hasHiddenChildren && childActivity.backgroundCommand),
    isGoalActive:
      threadStatus.isGoalActive || (hasHiddenChildren && childActivity.goal),
    queuedWork: threadStatus.queuedWork,
    queuedFailedCount: threadStatus.queuedFailedCount,
    isActivityUnreported: threadStatus.isActivityUnreported,
    isPlanModeActive:
      threadStatus.isPlanModeActive ||
      (hasHiddenChildren && childActivity.planMode),
    isRuntimeActive:
      threadStatus.isRuntimeActive ||
      (hasHiddenChildren && childActivity.runtimeWorking),
    isWorkflowActive:
      threadStatus.isWorkflowActive ||
      (hasHiddenChildren && childActivity.workflow),
  };
  const trailingIndicatorResolution = resolveThreadStatus(
    trailingIndicatorState,
    pluginThreadRowStatus,
  );
  const trailingIndicatorKind = trailingIndicatorResolution.indicatorKind;
  const hasFixedStatusSlot =
    thread.archivedAt === null &&
    (automationStartedAt !== null ||
      trailingIndicatorKind === "needs-input" ||
      trailingIndicatorKind === "working" ||
      trailingIndicatorKind === "woke" ||
      trailingIndicatorKind === "done-unread");
  const hasVisibleStatus =
    trailingIndicatorKind !== "none" ||
    trailingIndicatorResolution.rowStatusIsVisible ||
    isNativeActivityNotConfirmed(thread) ||
    miniMap !== null ||
    automationStartedAt !== null;
  const splitIndicatorIsWorking = hasThreadListWorkingActivity(
    trailingIndicatorState,
    pluginThreadRowStatus?.tone === "running",
  );
  const splitIndicatorLabel = trailingIndicatorResolution.accessibleLabel
    ? `${labelTitle} — open in split; ${trailingIndicatorResolution.accessibleLabel}`
    : `${labelTitle} — open in split`;
  const linkLabel = hasComposerDraft
    ? `Open ${labelTitle} (unsubmitted draft)`
    : `Open ${labelTitle}`;
  const rowDragBindings =
    isEditing || isCustomizingActions ? undefined : options.dragBindings;
  const nestTargetState = options.nestDrop?.state ?? null;
  const reorderPlacement = options.nestDrop?.reorderPlacement ?? null;
  const containerRef = useComposedRefs<HTMLDivElement>(
    rowDragBindings?.setActivatorNodeRef,
    options.nestDrop?.setNodeRef,
  );
  const isActionsOpen = isDropdownActionsOpen || isContextActionsOpen;
  const rowClassName = cn(
    SIDEBAR_HOVER_ACTIONS_ROW_CLASS,
    "group/thread-row cursor-pointer",
    SIDEBAR_ROW_BASE_CLASS,
    LIST_HOVER_TRANSITION,
    parentOptions?.stickyLevel === undefined && "relative",
    options.isCompact
      ? COARSE_POINTER_COMPACT_ROW_HEIGHT_CLASS
      : COARSE_POINTER_ROW_HEIGHT_CLASS,
    showActive
      ? SIDEBAR_ROW_SELECTED_STATE_CLASS
      : SIDEBAR_ROW_INTERACTIVE_STATE_CLASS,
    !showActive && isOpenInSplit && SIDEBAR_ROW_OPEN_IN_SPLIT_STATE_CLASS,
    !showActive && SIDEBAR_ROW_ACCENT_STATE_CLASS,
    rowDragBindings && !rowDragBindings.disabled && "select-none",
    !isActionsOpen && "data-[sidebar-touch-armed=true]:!bg-transparent",
    nestTargetState && NEST_TARGET_STATE_CLASS[nestTargetState],
    reorderPlacement && REORDER_PLACEMENT_CLASS[reorderPlacement],
    isCustomizingActions && "bg-sidebar-accent",
  );
  const rowStyle = getThreadRowStyle(options.depth);
  const parentGuideLeft =
    options.depth > 0 ? getSidebarThreadGroupLineLeft(options.depth - 1) : null;
  const handleRowClickCapture = useCallback<ThreadRowClickCaptureHandler>(
    (event) => {
      if (!options.consumeClickSuppression?.()) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
    },
    [options],
  );

  const rowLinkRef = useRef<HTMLAnchorElement>(null);
  useEffect(() => {
    if (isCustomizingActions) {
      focusFirstRowActionSlot(
        rowLinkRef.current?.closest("[data-sidebar-rename-row]"),
      );
    }
  }, [isCustomizingActions]);
  const handleRowClick = useCallback<MouseEventHandler<HTMLDivElement>>(
    (event) => {
      if (event.target !== event.currentTarget) {
        if (!(event.target instanceof Element)) return;
        if (!event.target.closest("[data-sidebar-thread-trailing]")) return;
        if (event.target.closest("a, button")) return;
      }
      rowLinkRef.current?.click();
    },
    [],
  );
  const handleActionsMenuCloseAutoFocus = (event: Event) => {
    const begin = pendingMenuCustomize.current;
    if (begin) {
      pendingMenuCustomize.current = null;
      event.preventDefault();
      begin();
      return;
    }
    rename.onCloseAutoFocus(event);
  };

  const rowContent = (
    <>
      {parentOptions?.stickyLevel !== undefined && parentGuideLeft !== null ? (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute -bottom-0.5 top-0 z-[1] w-px bg-border-hairline opacity-70"
          style={{ left: parentGuideLeft }}
        />
      ) : null}
      <span
        className={cn(
          "relative flex min-w-0 flex-1 items-center gap-1.5 self-stretch",
          hasVisibleStatus && "gap-1",
          !isActionsOpen &&
            "group-data-[sidebar-touch-armed=true]/thread-row:hidden",
          !isEditing &&
            !isCustomizingActions &&
            (reserveActionSpace
              ? "pr-(--bb-sidebar-hover-actions-inset) [@media(hover:none)]:pr-0"
              : SIDEBAR_HOVER_ACTIONS_INSET_CLASS),
        )}
        style={getHoverActionsInsetStyle(quickActions.length + 1)}
      >
        <a
          ref={rowLinkRef}
          href={thread.href}
          draggable={false}
          data-sidebar-thread-shortcut-target=""
          data-sidebar-thread-id={thread.id}
          data-sidebar-project-id={thread.projectId}
          data-sidebar-rename-anchor=""
          onClick={(event) => {
            if (isEditing) {
              event.preventDefault();
              event.stopPropagation();
              return;
            }
            if (splitAvailable && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              openInSplit();
              return;
            }
            if (
              consumeSidebarTitleDoubleClick(thread.id) &&
              startEditingFromDoubleClick()
            ) {
              event.preventDefault();
              event.stopPropagation();
              return;
            }
            onProjectSelect?.();
          }}
          onDoubleClick={isEditing ? undefined : startTitleEditing}
          aria-label={linkLabel}
          aria-keyshortcuts={shortcut?.ariaKeyshortcuts}
          className="absolute inset-0 rounded-md outline-none"
        />
        <span
          className={cn(
            "pointer-events-none relative flex min-w-0 flex-1 items-center self-stretch",
          )}
        >
          {provider ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <span
                  data-sidebar-thread-provider={provider.id}
                  role="img"
                  aria-label={provider.displayName}
                  className="pointer-events-auto relative z-[31] flex size-4 shrink-0 items-center justify-center mr-1.5 text-muted-foreground"
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    rowLinkRef.current?.click();
                  }}
                >
                  <ProviderIcon
                    providerKind="agent"
                    provider={provider}
                    className="size-4"
                  />
                </span>
              </TooltipTrigger>
              <TooltipContent side="top">{provider.displayName}</TooltipContent>
            </Tooltip>
          ) : null}
          {isEditing ? (
            <span className="pointer-events-auto relative z-10 min-w-0 flex-1 overflow-visible">
              {editor}
            </span>
          ) : (
            <span
              className={cn("bb-thread-title", "min-w-0 flex-1 truncate")}
              title={labelTitle}
              onDoubleClick={startTitleEditing}
            >
              <ThreadTitle threadId={thread.id} />
            </span>
          )}
        </span>
        {crossProjectLabel !== null ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                data-sidebar-thread-cross-project=""
                role="img"
                aria-label={crossProjectLabel}
                className="relative z-[31] flex size-5 shrink-0 items-center justify-center text-muted-foreground"
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  rowLinkRef.current?.click();
                }}
              >
                <Icon name="FolderExport" className="size-3.5" aria-hidden />
              </span>
            </TooltipTrigger>
            <TooltipContent side="top">{crossProjectLabel}</TooltipContent>
          </Tooltip>
        ) : null}
        {parentOptions && hasChildren ? (
          <SidebarChildToggleChevron
            disabled={isEditing}
            className={cn(isEditing && "hidden", hasVisibleStatus && "size-4")}
            isCollapsed={isParentCollapsed}
            expandLabel={`Expand ${labelTitle} threads`}
            collapseLabel={`Collapse ${labelTitle} threads`}
            onToggle={() => parentOptions.onToggleCollapsed(thread.id)}
            revealOnHover={!isParentCollapsed}
          />
        ) : null}
      </span>
      {rowDragBindings && !rowDragBindings.disabled && !isActionsOpen ? (
        <SidebarThreadDragChip
          title={labelTitle}
          visualOnly
          className="hidden group-data-[sidebar-touch-armed=true]/thread-row:flex"
        />
      ) : null}
      <span
        data-sidebar-thread-trailing=""
        className={cn(
          "flex min-w-0 shrink-0 items-center gap-0.5",
          !isActionsOpen &&
            "group-data-[sidebar-touch-armed=true]/thread-row:hidden",
          (isEditing || isCustomizingActions) && "hidden",
        )}
      >
        <span
          data-sidebar-thread-trailing-badges=""
          data-sidebar-hover-actions-open={isActionsOpen ? "true" : undefined}
          className={cn(
            SIDEBAR_HOVER_ACTIONS_FADE_CLASS,
            "flex min-w-0 shrink-0 items-center gap-0.5 [@media(hover:none)]:opacity-100!",
          )}
        >
          <SidebarThreadPullRequestChip threadId={thread.id} />
          {hasVisibleStatus ? (
            <span
              className={cn(
                "relative flex shrink-0 items-center justify-center",
                hasFixedStatusSlot
                  ? "min-w-4"
                  : COARSE_POINTER_ROW_ACTION_SIZE_CLASS,
              )}
            >
              {miniMap ? (
                <span
                  data-sidebar-thread-trailing-indicator=""
                  className={cn(
                    SIDEBAR_ROW_GLYPH_SLOT_CLASS,
                    SIDEBAR_STATUS_GLYPH_BOX_CLASS,
                  )}
                >
                  <SplitPaneMiniMap
                    slots={miniMap}
                    label={splitIndicatorLabel}
                    isWorking={splitIndicatorIsWorking}
                  />
                </span>
              ) : (
                <ThreadTrailingIndicator
                  state={trailingIndicatorState}
                  nativeActivityUnconfirmed={isNativeActivityNotConfirmed(
                    thread,
                  )}
                  nativeActivityNotice={nativeActivityNoticeText(thread)}
                  nativeActivityGuidance={nativeActivityGuidanceText(thread)}
                  automationStartedAt={automationStartedAt}
                  elapsedMinutes={elapsedMinutes}
                  hideIdleDraftLabel={
                    !hasHiddenChildren && trailingIndicatorKind === "draft"
                  }
                  rowStatus={pluginThreadRowStatus}
                />
              )}
            </span>
          ) : null}
          {shortcut ? (
            <span
              data-sidebar-shortcut-secondary={
                hasVisibleStatus ? "" : undefined
              }
              className="shrink-0"
            >
              <ShortcutPill shortcut={shortcut} />
            </span>
          ) : null}
        </span>
        {thread.archivedAt !== null ? (
          <span className="flex shrink-0 items-center gap-1 [@media(hover:none)]:hidden">
            <div
              data-sidebar-hover-actions-open={
                isActionsOpen ? "true" : undefined
              }
              className={cn(
                SIDEBAR_HOVER_ACTIONS_CLASS,
                "flex shrink-0 items-center",
              )}
            >
              <ThreadActionsMenu
                thread={actionTarget}
                trigger={renderThreadActionsTrigger}
                inline={inlineMenuActions}
                requestRename={requestRenameFromMenu}
                side="right"
                align="start"
                sideOffset={8}
                onOpenChange={setIsDropdownActionsOpen}
                onCloseAutoFocus={handleActionsMenuCloseAutoFocus}
              />
            </div>
            <span
              className="relative z-10 pointer-events-auto"
              onPointerDown={(event) => event.stopPropagation()}
              onKeyDown={(event) => event.stopPropagation()}
            >
              <ThreadRowQuickActions
                entries={quickActions}
                className={SIDEBAR_CONTROL_BUTTON_CLASS}
              />
            </span>
          </span>
        ) : (
          <div
            data-sidebar-hover-actions-open={isActionsOpen ? "true" : undefined}
            data-sidebar-hover-actions-mobile={
              SIDEBAR_HOVER_ACTIONS_MOBILE_ALWAYS_VALUE
            }
            className={cn(
              SIDEBAR_HOVER_ACTIONS_CLASS,
              "flex shrink-0 items-center justify-end gap-1",
              HOVER_CAPABLE_ACTIONS_OVERLAY_CLASS,
              isEditing && "invisible pointer-events-none",
            )}
          >
            <SidebarRowControls
              primaryAction={
                <ThreadRowQuickActions
                  entries={quickActions}
                  className={SIDEBAR_CONTROL_BUTTON_CLASS}
                  onMenuOpenChange={setIsDropdownActionsOpen}
                />
              }
            >
              <ThreadActionsMenu
                thread={actionTarget}
                trigger={renderThreadActionsTrigger}
                inline={inlineMenuActions}
                requestRename={requestRenameFromMenu}
                side="right"
                align="start"
                sideOffset={8}
                onOpenChange={setIsDropdownActionsOpen}
                onCloseAutoFocus={handleActionsMenuCloseAutoFocus}
              />
            </SidebarRowControls>
          </div>
        )}
      </span>
      {thread.experimental_rowState &&
      (Object.keys(thread.experimental_rowState.statuses).length > 0 ||
        thread.experimental_rowState.progress !== null) ? (
        <div
          data-sidebar-thread-row-state=""
          className="pointer-events-none relative z-[1] flex min-w-0 flex-col gap-1 pl-6 pr-2 pb-1"
        >
          {Object.entries(thread.experimental_rowState.statuses)
            .sort(
              ([, left], [, right]) =>
                (right.priority ?? 0) - (left.priority ?? 0),
            )
            .slice(0, 2)
            .map(([key, status]) => (
              <span
                key={key}
                data-sidebar-thread-status-chip={key}
                title={`${key}: ${status.value}`}
                className="max-w-full truncate rounded-sm bg-sidebar-accent px-1.5 py-0.5 font-medium text-xs text-sidebar-accent-foreground"
                style={status.color ? { color: status.color } : undefined}
              >
                {status.icon ? `${status.icon} ` : ""}
                {status.value}
              </span>
            ))}
          {Object.keys(thread.experimental_rowState.statuses).length > 2 ? (
            <span className="text-muted-foreground text-xs">
              +{Object.keys(thread.experimental_rowState.statuses).length - 2}{" "}
              more
            </span>
          ) : null}
          {thread.experimental_rowState.progress ? (
            <div className="flex min-w-0 flex-col gap-0.5">
              {thread.experimental_rowState.progress.label ? (
                <span className="truncate text-muted-foreground text-xs">
                  {thread.experimental_rowState.progress.label}
                </span>
              ) : null}
              <div
                role="progressbar"
                aria-label={
                  thread.experimental_rowState.progress.label ??
                  "Thread progress"
                }
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(
                  thread.experimental_rowState.progress.value * 100,
                )}
                className="h-1 overflow-hidden rounded-full bg-sidebar-accent"
              >
                <div
                  className="h-full rounded-full bg-sidebar-primary transition-[width]"
                  style={{
                    width: `${thread.experimental_rowState.progress.value * 100}%`,
                  }}
                />
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
      {finishCustomizingActions ? (
        <ThreadRowActionsEditor onDone={finishCustomizingActions} />
      ) : null}
    </>
  );

  const row = renderThreadRowContainer({
    children: rowContent,
    className: rowClassName,
    containerRef,
    dragBindings: rowDragBindings,
    nestTargetState,
    reorderPlacement,
    onClick: isEditing ? undefined : handleRowClick,
    onClickCapture:
      !isEditing && options.consumeClickSuppression
        ? handleRowClickCapture
        : undefined,
    onSplitDragPointerDown: isEditing ? undefined : onSplitDragPointerDown,
    stickyLevel: parentOptions?.stickyLevel,
    style: rowStyle,
  });

  return (
    <ThreadActionsContextMenu
      thread={actionTarget}
      inline={inlineMenuActions}
      requestRename={requestRenameFromMenu}
      onOpenChange={setIsContextActionsOpen}
      onCloseAutoFocus={handleActionsMenuCloseAutoFocus}
      disabled={isEditing}
      dragging={rowDragBindings?.isDragging ?? false}
    >
      {row}
    </ThreadActionsContextMenu>
  );
}

export const ThreadRow = memo(ThreadRowComponent);
