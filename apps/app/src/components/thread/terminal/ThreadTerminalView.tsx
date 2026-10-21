import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type TouchEvent as ReactTouchEvent,
} from "react";
import "@xterm/xterm/css/xterm.css";
import type { ITheme, Terminal as XTermTerminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@bb/shared-ui/context-menu";
import { TERMINAL_DATA_MAX_BYTES } from "@bb/domain";
import { useMediaQuery } from "@bb/shared-ui/hooks/use-media-query";
import { appToast } from "@/components/ui/app-toast";
import type {
  TerminalServerMessage,
  TerminalSession,
} from "@bb/server-contract";
import { useAppThemeEpoch } from "@/hooks/useAppTheme";
import { useSystemConfig } from "@/hooks/queries/system-queries";
import { usePreferredTheme } from "@/hooks/useTheme";
import type { MarkdownPreviewLinkHandler } from "@/components/ui/markdown-link";
import { openUrlInExternalBrowser } from "@/lib/url-open-routing";
import { decodeBase64Bytes } from "@/lib/base64-bytes";
import { sdk } from "@/lib/sdk";
import { wsManager } from "@/lib/ws";
import { useAppNavigationHost } from "@/lib/app-navigation-host";
import { copyToClipboardWithToast } from "@/lib/clipboard";
import {
  anchorPointFromMouseEvent,
  selectionAnchorFromPointerRelease,
  type MessageProseSelection,
  type SelectionAnchor,
  type SelectionAnchorPoint,
} from "@/components/thread/timeline/SelectableMessageProse.js";
import { TimelineSelectionMenu } from "@/components/thread/timeline/TimelineSelectionMenu.js";
import { buildTerminalWebSocketUrl } from "./terminal-websocket-url";
import { TerminalWebSocketTransport } from "@bb/client-core";
import {
  hasRunningLayoutAnimation,
  observeLayoutSignals,
  watchTerminalLayoutSettled,
} from "./terminal-layout-settle";
import { TerminalLinkOpenDialog } from "./TerminalLinkOpenDialog";
import { TerminalAttentionPane } from "./TerminalAttentionPane";
import { TerminalMobileControls } from "./TerminalMobileControls";
import { TerminalCommandGutter } from "./TerminalCommandGutter";
import { TerminalSearch } from "./TerminalSearch";
import type { TerminalSearchAddonInstance } from "./terminal-search-addon";
import { loadOptionalTerminalSearchAddon } from "./terminal-search-addon";
import { TerminalTextSelectSheet } from "./TerminalTextSelectSheet";
import { terminalTextSnapshot } from "./terminal-text-snapshot";
import {
  createTerminalClipboardKeyHandler,
  pasteTerminalClipboard,
} from "./terminal-clipboard";
import {
  applyTerminalControl,
  encodeTerminalArrow,
  suppressDuplicateTerminalCompositionInput,
} from "./terminal-mobile-input";
import {
  createTerminalOsc8LinkHandler,
  requestTerminalLinkOpen,
  type TerminalLinkTarget,
} from "./terminal-links";
import {
  nextSharedTerminalSize,
  type TerminalGridSize,
} from "./terminal-shared-size";
import { handleTerminalFileDrop } from "./terminal-file-drop";
import {
  registerTerminalOsc52Handler,
  terminalPromptLine,
} from "./terminal-shell-state";
import { createTerminalOutputPipeline } from "./terminal-output-pipeline";
import {
  mountTerminalReplayPreview,
  updateTerminalReplayPreviewPtyGrid,
} from "./terminal-replay-preview";
import {
  applyTerminalSurfaceScale,
  attachTerminalScalePointerCoordinates,
  canRevealTerminalSurface,
  readTerminalSurfaceScale,
  terminalSurfaceScale,
} from "./terminal-grid-presentation";
import {
  attachTerminalPromptTracker,
  type TerminalPromptTrackerState,
} from "./terminal-prompt-tracker";
import { dropMouseReportsWithoutPosition } from "./terminal-mouse-reports";
import { sendTerminalTapClick } from "./terminal-tap-click";
import { attachTerminalWheelLines } from "./terminal-wheel";
import { attachTerminalInteractions } from "./terminal-interactions";
import {
  loadOptionalTerminalWebglAddon,
  loadTerminalWebglRenderer,
  observeTerminalWebglVisibility,
} from "./terminal-webgl-renderer";
export {
  loadOptionalTerminalWebglAddon,
  loadTerminalWebglRenderer,
} from "./terminal-webgl-renderer";

export const TERMINAL_FONT_FAMILY =
  '"JetBrainsMono Nerd Font Mono", "MesloLGS NF", "Symbols Nerd Font Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace';
const TERMINAL_FONT_CSS_VARIABLE = "--font-terminal";
const CLIPBOARD_BLOCKED_MESSAGE =
  "This connection can’t read the clipboard. Long-press a message box and choose Paste.";
const TERMINAL_UNICODE_VERSION = "11";
export const TERMINAL_ALLOW_PROPOSED_API = true;
const TERMINAL_TOUCH_FOCUS_MAX_DURATION_MS = 700;
const TERMINAL_TOUCH_FOCUS_MOVEMENT_THRESHOLD_PX = 10;

type TerminalFitScheduler = () => void;

interface ShouldFocusTerminalAfterAsyncMountArgs {
  currentFocusIsAvailable: boolean;
  hasExplicitFocusRequest: boolean;
  focusMovedDuringMount: boolean;
  isPanelOpen: boolean;
}

export function shouldFocusTerminalAfterAsyncMount({
  currentFocusIsAvailable,
  hasExplicitFocusRequest,
  focusMovedDuringMount,
  isPanelOpen,
}: ShouldFocusTerminalAfterAsyncMountArgs): boolean {
  if (!isPanelOpen) {
    return false;
  }
  if (focusMovedDuringMount && currentFocusIsAvailable) {
    return false;
  }
  return hasExplicitFocusRequest || !currentFocusIsAvailable;
}

interface TerminalTouchPoint extends SelectionAnchorPoint {
  identifier: number;
}

interface TerminalTouchFocusGesture {
  identifier: number;
  maximumMovementPx: number;
  startedAt: number;
  startPoint: SelectionAnchorPoint;
}

interface FocusTerminalFromTouchReleaseArgs {
  changedTouches: readonly TerminalTouchPoint[];
  focus: () => void;
  gesture: TerminalTouchFocusGesture | null;
  releasedAt: number;
  remainingTouchCount: number;
}

function terminalTouchMovement(
  startPoint: SelectionAnchorPoint,
  currentPoint: SelectionAnchorPoint,
): number {
  return Math.hypot(
    currentPoint.x - startPoint.x,
    currentPoint.y - startPoint.y,
  );
}

export function startTerminalTouchFocusGesture(
  touches: readonly TerminalTouchPoint[],
  startedAt: number,
): TerminalTouchFocusGesture | null {
  const touch = touches.length === 1 ? touches[0] : undefined;
  if (touch === undefined) {
    return null;
  }
  return {
    identifier: touch.identifier,
    maximumMovementPx: 0,
    startedAt,
    startPoint: { x: touch.x, y: touch.y },
  };
}

export function updateTerminalTouchFocusGesture(
  gesture: TerminalTouchFocusGesture | null,
  touches: readonly TerminalTouchPoint[],
): TerminalTouchFocusGesture | null {
  const touch = touches.length === 1 ? touches[0] : undefined;
  if (
    gesture === null ||
    touch === undefined ||
    touch.identifier !== gesture.identifier
  ) {
    return null;
  }
  return {
    ...gesture,
    maximumMovementPx: Math.max(
      gesture.maximumMovementPx,
      terminalTouchMovement(gesture.startPoint, touch),
    ),
  };
}

export function focusTerminalFromTouchRelease({
  changedTouches,
  focus,
  gesture,
  releasedAt,
  remainingTouchCount,
}: FocusTerminalFromTouchReleaseArgs): boolean {
  if (remainingTouchCount !== 0) {
    return false;
  }
  const completedGesture = updateTerminalTouchFocusGesture(
    gesture,
    changedTouches,
  );
  if (completedGesture === null) {
    return false;
  }
  const duration = releasedAt - completedGesture.startedAt;
  if (
    duration < 0 ||
    duration >= TERMINAL_TOUCH_FOCUS_MAX_DURATION_MS ||
    completedGesture.maximumMovementPx >
      TERMINAL_TOUCH_FOCUS_MOVEMENT_THRESHOLD_PX
  ) {
    return false;
  }
  focus();
  return true;
}

type TerminalTouchListLike = ArrayLike<
  Pick<Touch, "clientX" | "clientY" | "identifier">
>;

interface TerminalTouchEventLike {
  changedTouches: TerminalTouchListLike;
  timeStamp: number;
  touches: TerminalTouchListLike;
}

function terminalTouchPoints(
  touches: TerminalTouchListLike,
): TerminalTouchPoint[] {
  return Array.from(touches, (touch) => ({
    identifier: touch.identifier,
    x: touch.clientX,
    y: touch.clientY,
  }));
}

export function createTerminalTouchHandlers(terminalRef: {
  readonly current: Pick<XTermTerminal, "element" | "focus" | "modes"> | null;
}) {
  let gesture: TerminalTouchFocusGesture | null = null;
  return {
    cancel(): void {
      gesture = null;
    },
    end(event: TerminalTouchEventLike): void {
      const completed = gesture;
      gesture = null;
      const changedTouches = terminalTouchPoints(event.changedTouches);
      const tapped = focusTerminalFromTouchRelease({
        changedTouches,
        focus: () => terminalRef.current?.focus(),
        gesture: completed,
        releasedAt: event.timeStamp,
        remainingTouchCount: event.touches.length,
      });
      const terminal = terminalRef.current;
      const tap = changedTouches[0];
      if (tapped && terminal !== null && tap !== undefined) {
        sendTerminalTapClick(terminal, tap);
      }
    },
    move(event: TerminalTouchEventLike): void {
      gesture = updateTerminalTouchFocusGesture(
        gesture,
        terminalTouchPoints(event.touches),
      );
    },
    start(event: TerminalTouchEventLike): void {
      gesture = startTerminalTouchFocusGesture(
        terminalTouchPoints(event.touches),
        event.timeStamp,
      );
    },
  };
}

interface HasVisibleTerminalSizeArgs {
  containerElement: HTMLElement;
  entries?: readonly ResizeObserverEntry[];
}

function readResolvedCssColor(
  probe: HTMLElement,
  varName: string,
): string | undefined {
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue(varName)
    .trim();
  if (!raw) {
    return undefined;
  }
  probe.style.color = raw;
  return getComputedStyle(probe).color;
}

type TerminalCssVariableReader = (name: string) => string | undefined;

export function resolveTerminalFontFamily(
  get: TerminalCssVariableReader,
): string {
  const value = get(TERMINAL_FONT_CSS_VARIABLE)?.trim();
  return value || TERMINAL_FONT_FAMILY;
}

export function buildTerminalThemeFromCssColors(
  get: TerminalCssVariableReader,
): ITheme {
  return {
    background: get("--sidebar"),
    foreground: get("--foreground"),
    cursor: get("--foreground"),
    cursorAccent: get("--sidebar"),
    selectionBackground: get("--muted"),
    black: get("--ansi-0"),
    red: get("--ansi-1"),
    green: get("--ansi-2"),
    yellow: get("--ansi-3"),
    blue: get("--ansi-4"),
    magenta: get("--ansi-5"),
    cyan: get("--ansi-6"),
    white: get("--ansi-7"),
    brightBlack: get("--ansi-8"),
    brightRed: get("--ansi-9"),
    brightGreen: get("--ansi-10"),
    brightYellow: get("--ansi-11"),
    brightBlue: get("--ansi-12"),
    brightMagenta: get("--ansi-13"),
    brightCyan: get("--ansi-14"),
    brightWhite: get("--ansi-15"),
  };
}

function buildTerminalTheme(): ITheme {
  if (typeof document === "undefined") {
    return {};
  }
  const probe = document.createElement("span");
  probe.style.position = "absolute";
  probe.style.visibility = "hidden";
  probe.style.pointerEvents = "none";
  document.body.appendChild(probe);
  const get = (name: string) => readResolvedCssColor(probe, name);
  const theme = buildTerminalThemeFromCssColors(get);
  probe.remove();
  return theme;
}

function readTerminalFontFamily(): string {
  if (typeof document === "undefined") {
    return TERMINAL_FONT_FAMILY;
  }
  return resolveTerminalFontFamily((name) =>
    getComputedStyle(document.documentElement).getPropertyValue(name),
  );
}

export function applyTerminalFontFamily(
  terminal: Pick<XTermTerminal, "options">,
  fontFamily: string,
  scheduleFit: TerminalFitScheduler,
): boolean {
  if (terminal.options.fontFamily === fontFamily) {
    return false;
  }
  terminal.options.fontFamily = fontFamily;
  scheduleFit();
  return true;
}

export function forceTerminalFontMeasurement(
  terminal: Pick<
    XTermTerminal,
    "options" | "clearTextureAtlas" | "refresh" | "rows"
  >,
): void {
  const fontFamily = terminal.options.fontFamily;
  terminal.options.fontFamily = `${fontFamily} `;
  terminal.options.fontFamily = fontFamily;
  terminal.clearTextureAtlas();
  terminal.refresh(0, terminal.rows - 1);
}

export function observeTerminalFontLoading(
  fontSet: Pick<
    FontFaceSet,
    "ready" | "addEventListener" | "removeEventListener"
  >,
  onFontsLoaded: () => void,
): () => void {
  let disposed = false;
  const refresh = () => {
    if (!disposed) {
      onFontsLoaded();
    }
  };
  fontSet.addEventListener("loadingdone", refresh);
  void fontSet.ready.then(refresh);
  return () => {
    disposed = true;
    fontSet.removeEventListener("loadingdone", refresh);
  };
}

interface ThreadTerminalViewProps {
  autoFocus: boolean;
  isPanelOpen: boolean;
  onAutoFocusHandled?: () => void;
  onOpenLink?: MarkdownPreviewLinkHandler;
  onSelectionAddToChat?: (text: string) => void;
  onSessionChange?: (session: TerminalSession) => void;
  onTitleChange?: TerminalTitleChangeHandler;
  onCwdChange?: (cwd: string) => void;
  onUserInput?: () => void;
  session: TerminalSession;
}

type TerminalTitleChangeHandler = (title: string) => void;

type TerminalConnectionNotice = "reconnecting" | "reconnected";

const TERMINAL_RECONNECTING_NOTICE_DELAY_MS = 1_000;
const TERMINAL_RECONNECTED_NOTICE_DURATION_MS = 1_500;
const EMPTY_TERMINAL_PROMPT_TRACKER: TerminalPromptTrackerState = {
  commandMarks: [],
  lineHeight: 16,
  promptLines: [],
  viewportLine: 0,
};

interface WriteTerminalStatusArgs {
  terminal: XTermTerminal;
  text: string;
}

interface WriteTerminalSessionStatusNoticeArgs {
  lastNotice: TerminalSessionStatusNoticeRef;
  session: TerminalSession;
  terminal: XTermTerminal;
}

interface TerminalOutputWriteArgs {
  data: string | Uint8Array;
  isReplay: boolean;
  onParsed: () => void;
  replayWriteState: TerminalReplayWriteState;
  terminal: XTermTerminal;
  pipeline?: ReturnType<typeof createTerminalOutputPipeline>;
  replayPipeline?: Pick<
    ReturnType<typeof createTerminalOutputPipeline>,
    "push"
  >;
}

interface ForwardTerminalDataArgs {
  data: string;
  isUserInput: boolean;
  onInput: (dataBase64: string) => void;
  onUserInput?: () => void;
  replayWriteState: TerminalReplayWriteState;
  sessionStatus: TerminalSession["status"];
}

interface OpenTerminalWebLinkArgs {
  onOpenLink: MarkdownPreviewLinkHandler;
  uri: string;
}

interface TerminalContextMenuState {
  link: TerminalLinkTarget | null;
  selectionText: string;
}

interface CaptureTerminalContextMenuStateArgs {
  link: TerminalLinkTarget | null;
  terminal: Pick<XTermTerminal, "getSelection"> | null;
}

interface TerminalReplayWriteState {
  suppressedWriteCount: number;
}

type TerminalSessionStatusNotice = "exited";
type TerminalSessionStatusNoticeRef = {
  current: TerminalSessionStatusNotice | null;
};

interface HandleTerminalServerMessageArgs {
  acknowledgeOutput: (nextSeq: number) => void;
  message: TerminalServerMessage;
  onReplayComplete: () => void;
  onSessionChange?: (session: TerminalSession) => void;
  replayNextSeq: number | null;
  replayWriteState: TerminalReplayWriteState;
  setReplayNextSeq: (nextSeq: number | null) => void;
  terminal: XTermTerminal;
  pipeline?: ReturnType<typeof createTerminalOutputPipeline>;
  replayPipeline?: Pick<
    ReturnType<typeof createTerminalOutputPipeline>,
    "push"
  >;
  allowAttachedGrid?: boolean;
  onReplayStart?: (session: TerminalSession) => void;
}

function encodeBytesBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

export function encodeTerminalInputChunks(value: string): string[] {
  const bytes = new TextEncoder().encode(value);
  const chunks: string[] = [];
  for (
    let offset = 0;
    offset < bytes.byteLength;
    offset += TERMINAL_DATA_MAX_BYTES
  ) {
    chunks.push(
      encodeBytesBase64(
        bytes.subarray(
          offset,
          Math.min(offset + TERMINAL_DATA_MAX_BYTES, bytes.byteLength),
        ),
      ),
    );
  }
  return chunks;
}

export function forwardTerminalData({
  data,
  isUserInput,
  onInput,
  onUserInput,
  replayWriteState,
  sessionStatus,
}: ForwardTerminalDataArgs): void {
  if (
    sessionStatus !== "running" ||
    (replayWriteState.suppressedWriteCount > 0 && !isUserInput)
  ) {
    return;
  }
  const input = dropMouseReportsWithoutPosition(data);
  if (input.length === 0) {
    return;
  }

  for (const dataBase64 of encodeTerminalInputChunks(input)) {
    onInput(dataBase64);
  }
  onUserInput?.();
}

export function subscribeToTerminalUserInput(
  terminal: XTermTerminal,
  listener: () => void,
): { dispose: () => void } | null {
  const core: unknown = Reflect.get(terminal, "_core");
  if (typeof core !== "object" || core === null) return null;
  const coreService: unknown = Reflect.get(core, "coreService");
  if (typeof coreService !== "object" || coreService === null) return null;
  const onUserInput: unknown = Reflect.get(coreService, "onUserInput");
  if (typeof onUserInput !== "function") return null;
  const disposable: unknown = onUserInput.call(coreService, listener);
  if (typeof disposable !== "object" || disposable === null) return null;
  const dispose: unknown = Reflect.get(disposable, "dispose");
  if (typeof dispose !== "function") return null;
  return { dispose: () => dispose.call(disposable) };
}

export function attachTerminalInputForwarding({
  onData,
  terminal,
}: {
  onData: (data: string, isUserInput: boolean) => void;
  terminal: XTermTerminal;
}): { dispose: () => void } {
  let userInputPending = false;
  const userInputSubscription = subscribeToTerminalUserInput(terminal, () => {
    userInputPending = true;
  });
  const dataSubscription = terminal.onData((data) => {
    const isUserInput = userInputPending;
    userInputPending = false;
    onData(data, isUserInput);
  });
  return {
    dispose: () => {
      userInputSubscription?.dispose();
      dataSubscription.dispose();
    },
  };
}

function hasVisibleTerminalSize({
  containerElement,
  entries,
}: HasVisibleTerminalSizeArgs): boolean {
  const entry = entries?.[0];
  const width = entry?.contentRect.width ?? containerElement.clientWidth;
  const height = entry?.contentRect.height ?? containerElement.clientHeight;
  return width > 0 && height > 0;
}

function buildTerminalSelection({
  anchor,
  containerElement,
  text,
}: {
  anchor: SelectionAnchor | null;
  containerElement: HTMLElement;
  text: string;
}): MessageProseSelection | null {
  const trimmedText = text.trim();
  if (trimmedText.length === 0) {
    return null;
  }

  const selection: MessageProseSelection = {
    text: trimmedText,
    rect:
      anchor === null
        ? containerElement.getBoundingClientRect()
        : new DOMRect(anchor.point.x, anchor.point.y, 0, 0),
  };
  if (anchor !== null) {
    selection.anchorPoint = anchor.point;
    selection.anchorSide = anchor.side;
  }
  return selection;
}

function writeTerminalStatus({
  terminal,
  text,
}: WriteTerminalStatusArgs): void {
  terminal.write(`\r\n\x1b[2m${text}\x1b[0m\r\n`);
}

function writeTerminalSessionStatusNotice({
  lastNotice,
  session,
  terminal,
}: WriteTerminalSessionStatusNoticeArgs): void {
  switch (session.status) {
    case "exited":
      if (lastNotice.current === "exited") {
        return;
      }
      lastNotice.current = "exited";
      writeTerminalStatus({
        terminal,
        text:
          session.exitCode === null
            ? "Terminal exited"
            : `Terminal exited with code ${session.exitCode}`,
      });
      return;
    case "starting":
    case "running":
    case "disconnected":
      lastNotice.current = null;
      return;
  }
}

export async function writeRetainedTerminalOutput({
  chunks,
  lastNotice,
  session,
  terminal,
  pipeline,
}: {
  chunks: readonly Uint8Array[];
  lastNotice: TerminalSessionStatusNoticeRef;
  session: TerminalSession;
  terminal: XTermTerminal;
  pipeline?: ReturnType<typeof createTerminalOutputPipeline>;
}): Promise<void> {
  await Promise.all(
    chunks.map(
      (chunk) =>
        new Promise<void>((resolve) => {
          if (pipeline) pipeline.push(chunk, resolve);
          else terminal.write(chunk, resolve);
        }),
    ),
  );
  writeTerminalSessionStatusNotice({ lastNotice, session, terminal });
  await new Promise<void>((resolve) => terminal.write("", resolve));
}

function openTerminalWebLink({
  onOpenLink,
  uri,
}: OpenTerminalWebLinkArgs): void {
  if (onOpenLink({ href: uri })) {
    return;
  }
  openUrlInExternalBrowser(uri);
}

export function captureTerminalContextMenuState({
  link,
  terminal,
}: CaptureTerminalContextMenuStateArgs): TerminalContextMenuState {
  return {
    link,
    selectionText: terminal?.getSelection() ?? "",
  };
}

export function writeTerminalOutput({
  data,
  isReplay,
  onParsed,
  replayWriteState,
  terminal,
  pipeline,
  replayPipeline,
}: TerminalOutputWriteArgs): void {
  const bytes =
    typeof data === "string" ? new TextEncoder().encode(data) : data;
  const write = (callback: () => void, applyMarkerGrids: boolean) => {
    if (pipeline) pipeline.push(bytes, callback, applyMarkerGrids);
    else terminal.write(data, callback);
  };
  if (!isReplay) {
    write(onParsed, true);
    return;
  }

  replayWriteState.suppressedWriteCount += 1;
  write(() => {
    if (!replayPipeline) {
      replayWriteState.suppressedWriteCount -= 1;
      onParsed();
      return;
    }
    replayPipeline.push(bytes, () => {
      replayWriteState.suppressedWriteCount -= 1;
      onParsed();
    });
  }, false);
}

export function handleTerminalServerMessage({
  acknowledgeOutput,
  message,
  onReplayComplete,
  onSessionChange,
  replayNextSeq,
  replayWriteState,
  setReplayNextSeq,
  terminal,
  pipeline,
  replayPipeline,
  allowAttachedGrid = true,
  onReplayStart,
}: HandleTerminalServerMessageArgs): void {
  switch (message.type) {
    case "attached":
      if (message.replayStartSeq < message.nextSeq) {
        onReplayStart?.(message.session);
      }
      if (allowAttachedGrid) {
        if (pipeline)
          pipeline.setGrid(message.session.cols, message.session.rows);
        else terminal.resize(message.session.cols, message.session.rows);
      }
      onSessionChange?.(message.session);
      setReplayNextSeq(message.nextSeq);
      if (message.replayStartSeq === message.nextSeq) {
        setReplayNextSeq(null);
        onReplayComplete();
      }
      return;
    case "pong":
      return;
    case "session-updated":
      onSessionChange?.(message.session);
      return;
    case "output": {
      const nextSeq = message.chunk.seq + 1;
      writeTerminalOutput({
        data: decodeBase64Bytes(message.chunk.dataBase64),
        isReplay: replayNextSeq !== null && message.chunk.seq < replayNextSeq,
        onParsed: () => {
          acknowledgeOutput(nextSeq);
          if (
            replayNextSeq !== null &&
            message.chunk.seq < replayNextSeq &&
            nextSeq === replayNextSeq
          ) {
            setReplayNextSeq(null);
            onReplayComplete();
          }
        },
        replayWriteState,
        terminal,
        pipeline,
        replayPipeline,
      });
      return;
    }
    case "error":
      writeTerminalStatus({
        terminal,
        text: `Terminal error: ${message.message}`,
      });
      return;
    case "exited":
      onSessionChange?.(message.session);
      writeTerminalStatus({
        terminal,
        text:
          message.session.exitCode === null
            ? "Terminal exited"
            : `Terminal exited with code ${message.session.exitCode}`,
      });
      return;
  }
}

export function ThreadTerminalView({
  autoFocus,
  isPanelOpen,
  onAutoFocusHandled,
  onOpenLink,
  onSelectionAddToChat,
  onSessionChange,
  onTitleChange,
  onCwdChange,
  onUserInput,
  session,
}: ThreadTerminalViewProps) {
  const [handoffOwnerToken, setHandoffOwnerToken] = useState(() =>
    wsManager.getDeviceHandoffClientToken(),
  );
  useEffect(
    () => wsManager.onDeviceHandoffClientToken(setHandoffOwnerToken),
    [],
  );
  const isTouchDevice = useMediaQuery("(pointer: coarse)");
  const attentionClearRequestRef = useRef<string | null>(null);
  const [controlActive, setControlActive] = useState(false);
  const controlActiveRef = useRef(false);
  const changeControlActive = (active: boolean) => {
    controlActiveRef.current = active;
    setControlActive(active);
  };

  useEffect(() => {
    if (!isPanelOpen || session.attention == null) return;
    const requestKey = `${session.id}:${session.attention.seq}`;
    if (attentionClearRequestRef.current === requestKey) return;
    attentionClearRequestRef.current = requestKey;
    void sdk.terminals.experimental_attention
      .clear({ terminalId: session.id })
      .then((updatedSession) => onSessionChange?.(updatedSession))
      .catch(() => {
        attentionClearRequestRef.current = null;
        appToast.error("Couldn't clear terminal attention.");
      });
  }, [isPanelOpen, onSessionChange, session.attention, session.id]);
  const [terminalReady, setTerminalReady] = useState(false);
  const [promptTrackerState, setPromptTrackerState] = useState(
    EMPTY_TERMINAL_PROMPT_TRACKER,
  );
  const [terminalSearchAddon, setTerminalSearchAddon] =
    useState<TerminalSearchAddonInstance | null>(null);
  const [terminalSearchOpen, setTerminalSearchOpen] = useState(false);
  const [textSnapshot, setTextSnapshot] = useState<string | null>(null);
  const [activeSelection, setActiveSelection] =
    useState<MessageProseSelection | null>(null);
  const [pendingTerminalLink, setPendingTerminalLink] =
    useState<TerminalLinkTarget | null>(null);
  const [connectionNotice, setConnectionNotice] =
    useState<TerminalConnectionNotice | null>(null);
  const [contextMenuState, setContextMenuState] =
    useState<TerminalContextMenuState>({
      link: null,
      selectionText: "",
    });
  const containerRef = useRef<HTMLDivElement | null>(null);
  const webglVisibilityRef = useRef<ReturnType<
    typeof observeTerminalWebglVisibility
  > | null>(null);
  const terminalRef = useRef<XTermTerminal | null>(null);
  const compositionInputGuardRef = useRef<
    ReturnType<typeof suppressDuplicateTerminalCompositionInput> | null
  >(null);
  const promptLinesRef = useRef<number[]>([]);
  const hoveredTerminalLinkRef = useRef<TerminalLinkTarget | null>(null);
  const pointerStartPointRef = useRef<SelectionAnchorPoint | null>(null);
  const pointerIsDownRef = useRef(false);
  const touchFocusGestureRef = useRef<TerminalTouchFocusGesture | null>(null);
  const touchHandlersRef = useRef<ReturnType<
    typeof createTerminalTouchHandlers
  > | null>(null);
  const touchHandlers = useCallback(() => {
    touchHandlersRef.current ??= createTerminalTouchHandlers(terminalRef);
    return touchHandlersRef.current;
  }, []);
  const lastPointerReleaseAnchorRef = useRef<SelectionAnchor | null>(null);
  const handleFileDropRef = useRef<((files: FileList) => void) | null>(null);
  const onSessionChangeRef = useRef<
    ((session: TerminalSession) => void) | undefined
  >(onSessionChange);
  const onTitleChangeRef = useRef<TerminalTitleChangeHandler | undefined>(
    onTitleChange,
  );
  const onCwdChangeRef = useRef(onCwdChange);
  const onUserInputRef = useRef<(() => void) | undefined>(onUserInput);
  const onAutoFocusHandledRef = useRef<(() => void) | undefined>(
    onAutoFocusHandled,
  );
  const autoFocusRef = useRef(autoFocus);
  const isPanelOpenRef = useRef(isPanelOpen);
  const sessionStatusRef = useRef<TerminalSession["status"]>(session.status);
  const sessionRef = useRef(session);
  const lastStatusNoticeRef = useRef<TerminalSessionStatusNotice | null>(null);
  const scheduleFitRef = useRef<TerminalFitScheduler | null>(null);
  const systemConfig = useSystemConfig();
  const copyOnSelectRef = useRef(false);
  copyOnSelectRef.current =
    systemConfig.data?.generalSettings.terminalCopyOnSelect === true;
  const preferredTheme = usePreferredTheme();
  const appThemeEpoch = useAppThemeEpoch();
  const appNavigation = useAppNavigationHost();
  const handleOpenLinkByPreference = useCallback<MarkdownPreviewLinkHandler>(
    ({ href }) => appNavigation.openUrl({ url: href }),
    [appNavigation],
  );
  const effectiveOnOpenLink = onOpenLink ?? handleOpenLinkByPreference;
  const onOpenLinkRef = useRef<MarkdownPreviewLinkHandler>(effectiveOnOpenLink);
  promptLinesRef.current = promptTrackerState.promptLines;
  const jumpToPrompt = useCallback((direction: "previous" | "next") => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    const line = terminalPromptLine(
      promptLinesRef.current,
      terminal.buffer.active.viewportY,
      direction,
    );
    if (line !== null) terminal.scrollToLine(line);
  }, []);

  autoFocusRef.current = autoFocus;
  isPanelOpenRef.current = isPanelOpen;
  sessionStatusRef.current = session.status;
  sessionRef.current = session;
  onAutoFocusHandledRef.current = onAutoFocusHandled;
  onOpenLinkRef.current = effectiveOnOpenLink;
  onSessionChangeRef.current = onSessionChange;
  onTitleChangeRef.current = onTitleChange;
  onCwdChangeRef.current = onCwdChange;
  onUserInputRef.current = onUserInput;

  const reportTerminalSelection = useCallback(
    (anchor: SelectionAnchor | null, selectionText?: string) => {
      const terminal = terminalRef.current;
      const container = containerRef.current;
      if (!terminal || !container) {
        setActiveSelection(null);
        return;
      }
      if (pointerIsDownRef.current) {
        return;
      }
      const text = selectionText ?? terminal.getSelection();
      setActiveSelection(
        buildTerminalSelection({
          anchor,
          containerElement: container,
          text,
        }),
      );
    },
    [],
  );

  const copyTerminalSelection = useCallback((text: string) => {
    void copyToClipboardWithToast(text, {
      successMessage: null,
      errorMessage: null,
    });
  }, []);

  const copyTerminalSelectionOnSelect = useCallback((text: string) => {
    void copyToClipboardWithToast(text, {
      successMessage: "Selection copied",
      errorMessage: "Failed to copy selection",
    });
  }, []);

  const clearTerminalSelection = useCallback(() => {
    terminalRef.current?.clearSelection();
    setActiveSelection(null);
  }, []);

  const updateHoveredTerminalLink = useCallback(
    (target: TerminalLinkTarget | null) => {
      hoveredTerminalLinkRef.current = target;
    },
    [],
  );

  const openTerminalLink = useCallback((uri: string) => {
    openTerminalWebLink({
      onOpenLink: onOpenLinkRef.current,
      uri,
    });
  }, []);

  const confirmTerminalLinkOpen = useCallback(
    (target: TerminalLinkTarget) => {
      setPendingTerminalLink(null);
      openTerminalLink(target.uri);
    },
    [openTerminalLink],
  );

  const requestOpenTerminalLink = useCallback(
    (target: TerminalLinkTarget) => {
      requestTerminalLinkOpen({
        openLink: openTerminalLink,
        requestConfirmation: setPendingTerminalLink,
        target,
      });
    },
    [openTerminalLink],
  );

  const captureTerminalContextMenu = useCallback(() => {
    setContextMenuState(
      captureTerminalContextMenuState({
        link: hoveredTerminalLinkRef.current,
        terminal: terminalRef.current,
      }),
    );
  }, []);

  const copyTerminalContextValue = useCallback(
    (text: string, successMessage: string) => {
      void copyToClipboardWithToast(text, {
        successMessage,
        errorMessage: "Failed to copy",
      });
    },
    [],
  );

  const pasteFromClipboard = useCallback(() => {
    const terminal = terminalRef.current;
    if (terminal === null || sessionStatusRef.current !== "running") {
      return;
    }
    void pasteTerminalClipboard({
      terminal,
      readText: () => navigator.clipboard.readText(),
      isActive: () =>
        terminalRef.current === terminal &&
        sessionStatusRef.current === "running",
    }).catch(() => {
      appToast.error(CLIPBOARD_BLOCKED_MESSAGE);
    });
  }, []);

  const handleSelectionAddToChat = useCallback(
    (text: string) => {
      onSelectionAddToChat?.(text);
      clearTerminalSelection();
    },
    [clearTerminalSelection, onSelectionAddToChat],
  );

  const handleTerminalPointerDown = useCallback(
    (event: Pick<PointerEvent, "button" | "clientX" | "clientY">) => {
      if (event.button !== 0) {
        if (event.button === 1) {
          terminalRef.current?.focus();
        }
        return;
      }
      pointerIsDownRef.current = true;
      pointerStartPointRef.current = anchorPointFromMouseEvent(event);
    },
    [],
  );

  const handleTerminalPointerRelease = useCallback(
    (event: Pick<PointerEvent, "button" | "clientX" | "clientY">) => {
      if (event.button !== 0) {
        return;
      }
      const anchor = selectionAnchorFromPointerRelease(
        pointerStartPointRef.current,
        { clientX: event.clientX, clientY: event.clientY },
      );
      lastPointerReleaseAnchorRef.current = anchor;
      pointerIsDownRef.current = false;
      pointerStartPointRef.current = null;
      window.requestAnimationFrame(() => {
        reportTerminalSelection(anchor);
      });
    },
    [reportTerminalSelection],
  );

  const handleTerminalPointerCancel = useCallback(() => {
    pointerStartPointRef.current = null;
    pointerIsDownRef.current = false;
    window.requestAnimationFrame(() => {
      reportTerminalSelection(lastPointerReleaseAnchorRef.current);
    });
  }, [reportTerminalSelection]);

  useEffect(() => {
    const release = (event: PointerEvent) => {
      if (pointerIsDownRef.current) {
        handleTerminalPointerRelease(event);
      }
    };
    const cancel = () => {
      if (pointerIsDownRef.current) {
        handleTerminalPointerCancel();
      }
    };
    document.addEventListener("pointerup", release);
    document.addEventListener("pointercancel", cancel);
    return () => {
      document.removeEventListener("pointerup", release);
      document.removeEventListener("pointercancel", cancel);
    };
  }, [handleTerminalPointerRelease, handleTerminalPointerCancel]);

  const handleTerminalTouchStart = useCallback(
    (event: ReactTouchEvent<HTMLDivElement>) => {
      touchFocusGestureRef.current = startTerminalTouchFocusGesture(
        terminalTouchPoints(event.touches),
        event.timeStamp,
      );
    },
    [],
  );

  const handleTerminalTouchMove = useCallback(
    (event: ReactTouchEvent<HTMLDivElement>) => {
      touchFocusGestureRef.current = updateTerminalTouchFocusGesture(
        touchFocusGestureRef.current,
        terminalTouchPoints(event.touches),
      );
    },
    [],
  );

  const handleTerminalTouchEnd = useCallback(
    (event: ReactTouchEvent<HTMLDivElement>) => {
      const gesture = touchFocusGestureRef.current;
      touchFocusGestureRef.current = null;
      focusTerminalFromTouchRelease({
        changedTouches: terminalTouchPoints(event.changedTouches),
        focus: () => terminalRef.current?.focus(),
        gesture,
        releasedAt: event.timeStamp,
        remainingTouchCount: event.touches.length,
      });
    },
    [],
  );

  const handleTerminalTouchCancel = useCallback(() => {
    touchFocusGestureRef.current = null;
  }, []);

  useEffect(() => {
    touchFocusGestureRef.current = null;
    touchHandlersRef.current?.cancel();
    setActiveSelection(null);
    setTextSnapshot(null);
    updateHoveredTerminalLink(null);
    setPendingTerminalLink(null);
    setContextMenuState({ link: null, selectionText: "" });
  }, [session.id, updateHoveredTerminalLink]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    const activeElementAtMount = document.activeElement;
    container.style.containerType = "inline-size";

    let disposed = false;
    let transport: TerminalWebSocketTransport | null = null;
    let terminal: XTermTerminal | null = null;
    let webglRenderer: ReturnType<typeof loadTerminalWebglRenderer> | null =
      null;
    let fitAddon: FitAddon | null = null;
    let replayNextSeq: number | null = null;
    const replayWriteState: TerminalReplayWriteState = {
      suppressedWriteCount: 0,
    };
    let resizeAnimationFrame: number | null = null;
    let connectionNoticeTimeout: ReturnType<typeof setTimeout> | null = null;
    let terminalInteractions: ReturnType<
      typeof attachTerminalInteractions
    > | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let selectionChangeDisposable: { dispose: () => void } | null = null;
    let terminalKeyDisposable: { dispose: () => void } | null = null;
    let terminalInputForwarding: { dispose: () => void } | null = null;
    let shellOscDisposable: { dispose: () => void } | null = null;
    let osc52Disposable: { dispose: () => void } | null = null;
    let stopObservingFonts: (() => void) | null = null;
    let stopWatchingLayout: (() => void) | null = null;
    let sharedSize: TerminalGridSize | null = null;
    let markerGridActive = false;
    let replayCompleted = false;
    let localFitGrid: TerminalGridSize | null = null;
    let latestPtyGrid: TerminalGridSize = {
      cols: sessionRef.current.cols,
      rows: sessionRef.current.rows,
    };
    let terminalInputClaimed = false;
    let detachPointerCoordinates: (() => void) | null = null;
    let detachGridVisibilityListeners: (() => void) | null = null;
    let replayPreview: {
      dispose(): void;
      resize(cols: number, rows: number): Promise<void>;
      setFitGrid(cols: number, rows: number): void;
      setPtyGrid(cols: number, rows: number): void;
      push(bytes: Uint8Array, callback: () => void): void;
    } | null = null;
    let outputPipeline: ReturnType<typeof createTerminalOutputPipeline> | null =
      null;
    let containerHasSize = hasVisibleTerminalSize({
      containerElement: container,
    });
    const reportDocumentVisibility = () => {
      transport?.setVisible(
        document.visibilityState === "visible" && containerHasSize,
      );
    };

    async function mountTerminal(
      containerElement: HTMLDivElement,
    ): Promise<void> {
      const updateGridVisibility = () => {
        if (terminal === null || (replayPreview !== null && !replayCompleted)) {
          return;
        }
        containerElement.dataset.renderGridCols = String(terminal.cols);
        containerElement.dataset.renderGridRows = String(terminal.rows);
        const ownsTerminal =
          terminalInputClaimed &&
          document.hasFocus() &&
          terminal.element?.contains(document.activeElement) === true;
        const canReveal =
          localFitGrid !== null &&
          canRevealTerminalSurface({
            fitGrid: localFitGrid,
            isOwner: ownsTerminal,
            ptyGrid: latestPtyGrid,
            rendererGrid: { cols: terminal.cols, rows: terminal.rows },
          });
        containerElement.style.opacity = "0";
        const scale =
          localFitGrid !== null
            ? terminalSurfaceScale(latestPtyGrid, localFitGrid)
            : 1;
        if (terminal.element) {
          applyTerminalSurfaceScale(terminal.element, scale);
        }
        const rendererWidth = containerElement.getBoundingClientRect().width;
        const paintedWidth =
          terminal.element
            ?.querySelector<HTMLElement>(".xterm-screen")
            ?.getBoundingClientRect().width ?? 0;
        const widthFits =
          rendererWidth > 0 && paintedWidth <= rendererWidth + 1;
        containerElement.dataset.ptyGridCols = String(latestPtyGrid.cols);
        containerElement.dataset.ptyGridRows = String(latestPtyGrid.rows);
        if (canReveal && widthFits) {
          containerElement.style.opacity = "";
          if (replayCompleted && replayPreview !== null) {
            replayPreview.dispose();
            replayPreview = null;
          }
          return;
        }
      };
      const requiredModulesPromise = Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
        import("@xterm/addon-web-links"),
        import("@xterm/addon-unicode11"),
      ]);
      const webglAddonModulePromise = loadOptionalTerminalWebglAddon(
        () => import("@xterm/addon-webgl"),
      );
      const searchAddonModulePromise = loadOptionalTerminalSearchAddon(
        () => import("@xterm/addon-search"),
      );
      const [
        { Terminal },
        { FitAddon: LoadedFitAddon },
        { WebLinksAddon },
        { Unicode11Addon },
      ] = await requiredModulesPromise;
      const webglAddonModule = await webglAddonModulePromise;
      const searchAddonModule = await searchAddonModulePromise;
      if (disposed) {
        return;
      }

      const osc8LinkHandler = createTerminalOsc8LinkHandler({
        onActivate: requestOpenTerminalLink,
        onHover: (target) => {
          if (!disposed) {
            updateHoveredTerminalLink(target);
          }
        },
      });

      terminal = new Terminal({
        allowProposedApi: TERMINAL_ALLOW_PROPOSED_API,
        convertEol: true,
        cursorBlink: true,
        fontFamily: readTerminalFontFamily(),
        fontSize: 12,
        linkHandler: osc8LinkHandler,
        scrollback: 10_000,
        theme: buildTerminalTheme(),
      });
      setPromptTrackerState(EMPTY_TERMINAL_PROMPT_TRACKER);
      shellOscDisposable = attachTerminalPromptTracker({
        onChange: setPromptTrackerState,
        onCwdChange: (cwd) => onCwdChangeRef.current?.(cwd),
        terminal,
      });
      terminal.attachCustomKeyEventHandler((event) => {
        if (
          event.type === "keydown" &&
          event.altKey &&
          event.shiftKey &&
          (event.key === "ArrowUp" || event.key === "ArrowDown")
        ) {
          event.preventDefault();
          jumpToPrompt(event.key === "ArrowUp" ? "previous" : "next");
          return false;
        }
        return createTerminalClipboardKeyHandler({
          terminal: activeTerminal,
          copy: (text) => copyTerminalContextValue(text, "Selection copied"),
          paste: pasteFromClipboard,
        })(event);
      });
      terminalRef.current = terminal;
      osc52Disposable = registerTerminalOsc52Handler(
        { parser: terminal.parser },
        (text) => {
          const now = Date.now();
          window.dispatchEvent(
            new CustomEvent("bb-device-handoff", {
              detail: {
                type: "device-handoff",
                id: `${now}-${Math.random()}`,
                createdAt: now,
                expiresAt: now + 120_000,
                originLabel: session.title,
                request: {
                  kind: "copy-text",
                  text,
                  origin: {
                    ...(session.threadId === null
                      ? {}
                      : { threadId: session.threadId }),
                    terminalSessionId: session.id,
                  },
                },
              },
            }),
          );
        },
        () => replayWriteState.suppressedWriteCount > 0,
      );
      outputPipeline = createTerminalOutputPipeline(
        terminal,
        (grid, apply) => {
          markerGridActive = true;
          if (apply) {
            latestPtyGrid = grid;
          }
          updateTerminalReplayPreviewPtyGrid(replayPreview, grid, apply);
          updateGridVisibility();
        },
        (cols, rows) => {
          containerElement.dataset.renderGridCols = String(cols);
          containerElement.dataset.renderGridRows = String(rows);
          updateGridVisibility();
        },
      );
      fitAddon = new LoadedFitAddon();
      terminal.loadAddon(fitAddon);
      terminal.loadAddon(new Unicode11Addon());
      terminal.unicode.activeVersion = TERMINAL_UNICODE_VERSION;
      terminal.loadAddon(
        new WebLinksAddon(
          (event, uri) => {
            if (event.button !== 0) {
              return;
            }
            requestOpenTerminalLink({ source: "detected-url", uri });
          },
          {
            hover: (_event, uri) => {
              updateHoveredTerminalLink({ source: "detected-url", uri });
            },
            leave: () => {
              updateHoveredTerminalLink(null);
            },
          },
        ),
      );
      terminal.open(containerElement);
      document.addEventListener("focusin", updateGridVisibility);
      document.addEventListener("focusout", updateGridVisibility);
      window.addEventListener("focus", updateGridVisibility);
      window.addEventListener("blur", updateGridVisibility);
      window.addEventListener("resize", updateGridVisibility);
      detachGridVisibilityListeners = () => {
        document.removeEventListener("focusin", updateGridVisibility);
        document.removeEventListener("focusout", updateGridVisibility);
        window.removeEventListener("focus", updateGridVisibility);
        window.removeEventListener("blur", updateGridVisibility);
        window.removeEventListener("resize", updateGridVisibility);
      };
      if (terminal.element) {
        detachPointerCoordinates = attachTerminalScalePointerCoordinates(
          terminal.element,
          () =>
            terminal?.element ? readTerminalSurfaceScale(terminal.element) : 1,
        );
      }
      containerElement.dataset.renderGridCols = String(terminal.cols);
      containerElement.dataset.renderGridRows = String(terminal.rows);
      if (searchAddonModule !== null) {
        const searchAddon = new searchAddonModule.SearchAddon();
        terminal.loadAddon(searchAddon);
        setTerminalSearchAddon(searchAddon);
      }
      attachTerminalWheelLines(terminal);
      if (webglAddonModule !== null) {
        webglRenderer = loadTerminalWebglRenderer(
          terminal,
          () => new webglAddonModule.WebglAddon(),
          { root: containerElement, visible: false },
        );
        webglVisibilityRef.current = observeTerminalWebglVisibility({
          root: containerElement,
          renderer: webglRenderer,
          isPanelOpen: () => isPanelOpenRef.current,
        });
      }
      if (sessionRef.current.status !== "exited") {
        writeTerminalSessionStatusNotice({
          lastNotice: lastStatusNoticeRef,
          session: sessionRef.current,
          terminal,
        });
      }
      const fitTerminal = () => {
        if (!fitAddon || !terminal) {
          return;
        }
        if (!hasVisibleTerminalSize({ containerElement })) {
          return;
        }
        const fitted = fitAddon.proposeDimensions();
        if (
          fitted === undefined ||
          !Number.isFinite(fitted.cols) ||
          !Number.isFinite(fitted.rows)
        ) {
          return;
        }
        localFitGrid = { cols: fitted.cols, rows: fitted.rows };
        containerElement.dataset.fitGridCols = String(fitted.cols);
        containerElement.dataset.fitGridRows = String(fitted.rows);
        replayPreview?.setFitGrid(fitted.cols, fitted.rows);
        updateGridVisibility();
        transport?.sendResize(fitted.cols, fitted.rows);
      };
      const scheduleFit: TerminalFitScheduler = () => {
        if (resizeAnimationFrame !== null) {
          return;
        }
        resizeAnimationFrame = window.requestAnimationFrame(() => {
          resizeAnimationFrame = null;
          fitTerminal();
        });
      };
      fitTerminal();
      const fontSet = document.fonts;
      if (fontSet !== undefined) {
        stopObservingFonts = observeTerminalFontLoading(fontSet, () => {
          if (terminal === null) {
            return;
          }
          forceTerminalFontMeasurement(terminal);
          scheduleFit();
        });
      }
      scheduleFitRef.current = scheduleFit;
      const currentActiveElement = document.activeElement;
      if (
        shouldFocusTerminalAfterAsyncMount({
          currentFocusIsAvailable:
            currentActiveElement !== null &&
            currentActiveElement !== document.body &&
            currentActiveElement.isConnected,
          hasExplicitFocusRequest: autoFocusRef.current,
          focusMovedDuringMount: currentActiveElement !== activeElementAtMount,
          isPanelOpen: isPanelOpenRef.current,
        })
      ) {
        terminal.focus();
        onAutoFocusHandledRef.current?.();
      }

      const activeTerminal = terminal!;
      let reconnecting = false;
      let repaintAfterReconnect = false;
      let reconnectingNoticeVisible = false;
      const clearConnectionNoticeTimeout = () => {
        if (connectionNoticeTimeout !== null) {
          clearTimeout(connectionNoticeTimeout);
          connectionNoticeTimeout = null;
        }
      };
      const activeTransport = new TerminalWebSocketTransport({
        onRepaintNudgeSizeReleased: (size) => {
          const nextSize = nextSharedTerminalSize(sharedSize, size, false);
          if (nextSize !== null) {
            sharedSize = nextSize;
            if (!markerGridActive) {
              latestPtyGrid = nextSize;
              outputPipeline?.setGrid(
                nextSize.cols,
                nextSize.rows,
                updateGridVisibility,
              );
            }
            scheduleFit();
          }
        },
        onConnectionState: (state) => {
          if (disposed) {
            return;
          }
          if (state === "reconnecting") {
            repaintAfterReconnect = true;
            if (reconnecting) {
              return;
            }
            reconnecting = true;
            clearConnectionNoticeTimeout();
            setConnectionNotice(null);
            connectionNoticeTimeout = setTimeout(() => {
              connectionNoticeTimeout = null;
              reconnectingNoticeVisible = true;
              setConnectionNotice("reconnecting");
            }, TERMINAL_RECONNECTING_NOTICE_DELAY_MS);
            return;
          }
          reconnecting = false;
          clearConnectionNoticeTimeout();
          if (state === "attached" && reconnectingNoticeVisible) {
            setConnectionNotice("reconnected");
            connectionNoticeTimeout = setTimeout(() => {
              connectionNoticeTimeout = null;
              setConnectionNotice(null);
            }, TERMINAL_RECONNECTED_NOTICE_DURATION_MS);
          } else {
            setConnectionNotice(null);
          }
          reconnectingNoticeVisible = false;
        },
        onInputOverflow: (maxBytes) => {
          writeTerminalStatus({
            terminal: activeTerminal,
            text: `Terminal input queue is full (${maxBytes} bytes); input was not sent`,
          });
        },
        onInvalidMessage: () => {
          writeTerminalStatus({
            terminal: activeTerminal,
            text: "Terminal received an invalid server message",
          });
        },
        onMessage: (message) => {
          if (
            message.type === "attached" ||
            message.type === "session-updated"
          ) {
            const { cols, rows } = message.session;
            const isOwnNudgeEcho =
              message.type === "session-updated" &&
              activeTransport.consumeRepaintNudgeEcho(
                { cols, rows },
                message.resizeSeq,
              );
            latestPtyGrid = { cols, rows };
            updateGridVisibility();
            const nextSize = nextSharedTerminalSize(
              sharedSize,
              { cols, rows },
              isOwnNudgeEcho,
            );
            if (nextSize !== null) {
              sharedSize = nextSize;
              replayPreview?.resize(nextSize.cols, nextSize.rows);
              scheduleFit();
            } else {
              replayPreview?.resize(cols, rows);
            }
            if (message.type === "session-updated" && !markerGridActive) {
              outputPipeline?.setGrid(cols, rows, updateGridVisibility);
            }
          }
          handleTerminalServerMessage({
            acknowledgeOutput: (nextSeq) =>
              activeTransport.acknowledgeOutput(nextSeq),
            message,
            onReplayComplete: () => {
              replayCompleted = true;
              outputPipeline?.setGrid(
                latestPtyGrid.cols,
                latestPtyGrid.rows,
                updateGridVisibility,
              );
              if (
                !disposed &&
                sessionStatusRef.current === "running" &&
                repaintAfterReconnect
              ) {
                repaintAfterReconnect = false;
                activeTransport.requestRepaint();
              }
            },
            onSessionChange: onSessionChangeRef.current,
            replayNextSeq,
            replayWriteState,
            onReplayStart: () => {
              replayPreview?.dispose();
              replayCompleted = false;
              const replayGrid = latestPtyGrid;
              const previewTerminal = new Terminal({
                cols: replayGrid.cols,
                rows: replayGrid.rows,
                fontFamily: readTerminalFontFamily(),
                fontSize: 12,
                theme: buildTerminalTheme(),
              });
              replayPreview = mountTerminalReplayPreview({
                container: containerElement,
                initialFitGrid: localFitGrid,
                isOwner: () =>
                  terminalInputClaimed &&
                  document.hasFocus() &&
                  activeTerminal.element?.contains(document.activeElement) ===
                    true,
                terminal: previewTerminal,
              });
            },
            setReplayNextSeq: (nextSeq) => {
              replayNextSeq = nextSeq;
            },
            terminal: activeTerminal,
            pipeline: outputPipeline ?? undefined,
            replayPipeline: replayPreview ?? undefined,
            allowAttachedGrid: !markerGridActive,
          });
        },
        onSequenceGap: () => {
          activeTerminal.reset();
          writeTerminalStatus({
            terminal: activeTerminal,
            text: "Some terminal output was unavailable after reconnect",
          });
        },
        shouldReconnect: () =>
          !disposed && sessionStatusRef.current === "running",
        url: buildTerminalWebSocketUrl({
          handoffOwnerToken:
            wsManager.getDeviceHandoffClientToken() ?? handoffOwnerToken,
          terminalId: session.id,
        }),
      });
      transport = activeTransport;
      fitTerminal();
      reportDocumentVisibility();
      document.addEventListener("visibilitychange", reportDocumentVisibility);
      if (sessionRef.current.status === "exited") {
        const output = await sdk.terminals.output({
          terminalId: sessionRef.current.id,
          tailBytes: 64 * 1024,
        });
        if (!disposed) {
          await writeRetainedTerminalOutput({
            chunks: output.chunks.map((chunk) =>
              decodeBase64Bytes(chunk.dataBase64),
            ),
            lastNotice: lastStatusNoticeRef,
            session: sessionRef.current,
            terminal: activeTerminal,
            pipeline: outputPipeline ?? undefined,
          });
        }
      } else {
        activeTransport.start();
      }
      stopWatchingLayout = watchTerminalLayoutSettled({
        cancelFrame: (handle) => window.cancelAnimationFrame(handle),
        measure: () => {
          const rect = containerElement.getBoundingClientRect();
          if (
            rect.width <= 0 ||
            rect.height <= 0 ||
            hasRunningLayoutAnimation(containerElement) ||
            document.fonts?.status === "loading"
          ) {
            return null;
          }
          const fitted = fitAddon?.proposeDimensions();
          if (
            fitted === undefined ||
            !Number.isFinite(fitted.cols) ||
            !Number.isFinite(fitted.rows)
          ) {
            return null;
          }
          return `${rect.width}x${rect.height}:${fitted?.cols}x${fitted?.rows}`;
        },
        onSettled: () => {
          if (disposed) {
            return;
          }
          fitTerminal();
          activeTransport.markLayoutSettled();
        },
        ready: document.fonts?.ready,
        subscribe: (onSignal) =>
          observeLayoutSignals({
            affectsContainer: (target) =>
              target instanceof Node && target.contains(containerElement),
            document,
            fontSet: document.fonts,
            onSignal,
          }),
        requestFrame: (callback) => window.requestAnimationFrame(callback),
      });
      const sendTerminalInput = (dataBase64: string) =>
        activeTransport.sendInput(dataBase64);
      handleFileDropRef.current = (files) => {
        const desktop = window.bbDesktop;
        handleTerminalFileDrop({
          files: Array.from(files),
          getPathForFile: desktop?.getPathForFile,
          isRunning: sessionStatusRef.current === "running",
          sendInput: (input) =>
            forwardTerminalData({
              data: input,
              isUserInput: true,
              onInput: sendTerminalInput,
              onUserInput: onUserInputRef.current,
              replayWriteState,
              sessionStatus: sessionStatusRef.current,
            }),
        });
      };
      terminalInteractions = attachTerminalInteractions({
        element: containerElement.parentElement ?? containerElement,
        getSelection: () => activeTerminal.getSelection(),
        onPointerDown: (event) => {
          if (
            event.target instanceof Node &&
            activeTerminal.element?.contains(event.target)
          ) {
            terminalInputClaimed = true;
            updateGridVisibility();
          }
          handleTerminalPointerDown(event);
        },
        onPointerRelease: handleTerminalPointerRelease,
        onPointerCancel: handleTerminalPointerCancel,
        onSelection: (text) =>
          reportTerminalSelection(lastPointerReleaseAnchorRef.current, text),
        copySelection: (text) => {
          if (copyOnSelectRef.current) {
            copyTerminalSelectionOnSelect(text);
          }
        },
        onFilesDrop: (files) => handleFileDropRef.current?.(files),
      });
      terminalKeyDisposable = activeTerminal.onKey(() => {
        terminalInputClaimed = true;
        updateGridVisibility();
      });
      terminalInputForwarding = attachTerminalInputForwarding({
        onData: (data, isUserInput) => {
          if (controlActiveRef.current) {
            data = applyTerminalControl(data);
            controlActiveRef.current = false;
            setControlActive(false);
          }
          forwardTerminalData({
            data,
            isUserInput,
            onInput: sendTerminalInput,
            onUserInput: onUserInputRef.current,
            replayWriteState,
            sessionStatus: sessionStatusRef.current,
          });
        },
        terminal: activeTerminal,
      });
      setTerminalReady(true);
      activeTerminal.onTitleChange((title) => {
        if (replayWriteState.suppressedWriteCount > 0) {
          return;
        }
        if (sessionStatusRef.current !== "running") {
          return;
        }
        onTitleChangeRef.current?.(title);
      });
      selectionChangeDisposable = activeTerminal.onSelectionChange(
        terminalInteractions.onSelectionChange,
      );

      resizeObserver = new ResizeObserver((entries) => {
        updateGridVisibility();
        const hasSize = hasVisibleTerminalSize({ containerElement, entries });
        if (hasSize !== containerHasSize) {
          containerHasSize = hasSize;
          reportDocumentVisibility();
        }
        if (!hasSize) {
          return;
        }
        scheduleFit();
      });
      resizeObserver.observe(containerElement);
    }

    void mountTerminal(container).catch((error) => {
      if (!disposed) {
        container.textContent =
          error instanceof Error ? error.message : String(error);
      }
    });

    return () => {
      disposed = true;
      controlActiveRef.current = false;
      setControlActive(false);
      setTerminalReady(false);
      setTerminalSearchAddon(null);
      setTerminalSearchOpen(false);
      stopObservingFonts?.();
      stopWatchingLayout?.();
      if (resizeAnimationFrame !== null) {
        window.cancelAnimationFrame(resizeAnimationFrame);
      }
      if (connectionNoticeTimeout !== null) {
        clearTimeout(connectionNoticeTimeout);
      }
      setConnectionNotice(null);
      resizeObserver?.disconnect();
      replayPreview?.dispose();
      replayPreview = null;
      detachPointerCoordinates?.();
      detachPointerCoordinates = null;
      detachGridVisibilityListeners?.();
      detachGridVisibilityListeners = null;
      selectionChangeDisposable?.dispose();
      terminalKeyDisposable?.dispose();
      terminalKeyDisposable = null;
      terminalInputForwarding?.dispose();
      terminalInputForwarding = null;
      shellOscDisposable?.dispose();
      osc52Disposable?.dispose();
      terminalInteractions?.dispose();
      handleFileDropRef.current = null;
      document.removeEventListener(
        "visibilitychange",
        reportDocumentVisibility,
      );
      transport?.dispose();
      webglVisibilityRef.current?.dispose();
      webglVisibilityRef.current = null;
      webglRenderer?.dispose();
      terminal?.dispose();
      terminalRef.current = null;
      scheduleFitRef.current = null;
    };
  }, [
    copyTerminalContextValue,
    pasteFromClipboard,
    reportTerminalSelection,
    copyTerminalSelection,
    copyTerminalSelectionOnSelect,
    handleTerminalPointerDown,
    handleTerminalPointerRelease,
    handleTerminalPointerCancel,
    jumpToPrompt,
    requestOpenTerminalLink,
    session.id,
    handoffOwnerToken,
    session.title,
    session.threadId,
    updateHoveredTerminalLink,
  ]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!isTouchDevice || terminal?.element == null) return;
    const compositionInputGuard = suppressDuplicateTerminalCompositionInput(
      terminal.element.parentElement ?? terminal.element,
      (data) => terminal.input(data),
    );
    compositionInputGuardRef.current = compositionInputGuard;
    return () => {
      compositionInputGuard.dispose();
      compositionInputGuardRef.current = null;
    };
  }, [isTouchDevice, terminalReady]);

  useEffect(() => {
    if (!isPanelOpen || !autoFocus) {
      return;
    }
    const terminal = terminalRef.current;
    if (terminal !== null) {
      terminal.focus();
      onAutoFocusHandledRef.current?.();
    }
    scheduleFitRef.current?.();
  }, [autoFocus, isPanelOpen]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) {
      return;
    }
    writeTerminalSessionStatusNotice({
      lastNotice: lastStatusNoticeRef,
      session,
      terminal,
    });
  }, [session]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) {
      return;
    }
    applyTerminalFontFamily(terminal, readTerminalFontFamily(), () =>
      scheduleFitRef.current?.(),
    );
    terminal.options.theme = buildTerminalTheme();
  }, [preferredTheme, appThemeEpoch]);

  const connectionNoticeText =
    session.status === "disconnected"
      ? "Terminal disconnected"
      : connectionNotice === "reconnecting"
        ? "Reconnecting…"
        : connectionNotice === "reconnected"
          ? "Reconnected"
          : null;
  useEffect(() => {
    webglVisibilityRef.current?.sync();
  }, [isPanelOpen]);

  const contextMenuLink = contextMenuState.link;
  const contextMenuSelectionText = contextMenuState.selectionText;
  return (
    <div className="flex h-full min-h-0 flex-col" data-app-terminal="">
      <ContextMenu
        onOpenChange={(open) => {
          if (!open) {
            setContextMenuState({ link: null, selectionText: "" });
          }
        }}
      >
        <ContextMenuTrigger asChild>
          <TerminalAttentionPane
            attention={session.attention}
            className="group/terminal-pane relative min-h-0 w-full flex-1 overflow-hidden bg-sidebar p-2"
            onContextMenuCapture={captureTerminalContextMenu}
            onTouchStart={(event) => {
              touchHandlers().start(event);
              handleTerminalTouchStart(event);
            }}
            onTouchMove={(event) => {
              touchHandlers().move(event);
              handleTerminalTouchMove(event);
            }}
            onTouchEnd={(event) => {
              touchHandlers().end(event);
              handleTerminalTouchEnd(event);
            }}
            onTouchCancel={() => {
              touchHandlers().cancel();
              handleTerminalTouchCancel();
            }}
          >
            <div
              ref={containerRef}
              data-terminal-renderer="dom"
              data-terminal-context-loss-count="0"
              className="box-border h-full min-h-0 w-full overflow-hidden pl-2"
            />
            <TerminalCommandGutter
              commandMarks={promptTrackerState.commandMarks}
              lineHeight={promptTrackerState.lineHeight}
              rows={session.rows}
              viewportLine={promptTrackerState.viewportLine}
            />
            <TerminalSearch
              addon={terminalSearchAddon}
              terminal={terminalRef.current}
              touch={isTouchDevice}
              open={terminalSearchOpen}
              onOpenChange={setTerminalSearchOpen}
            />
            {connectionNoticeText !== null ? (
              <div
                role="status"
                className="pointer-events-none absolute top-2 right-2 rounded-md border border-border bg-popover px-2 py-1 text-xs text-muted-foreground shadow-sm"
              >
                {connectionNoticeText}
              </div>
            ) : null}
          </TerminalAttentionPane>
        </ContextMenuTrigger>
        <ContextMenuContent
          className="min-w-36"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            terminalRef.current?.focus();
          }}
        >
          {contextMenuLink !== null ? (
            <>
              <ContextMenuItem
                onSelect={() => requestOpenTerminalLink(contextMenuLink)}
              >
                Open Link
              </ContextMenuItem>
              <ContextMenuItem
                onSelect={() => openUrlInExternalBrowser(contextMenuLink.uri)}
              >
                Open Link Externally
              </ContextMenuItem>
              <ContextMenuItem
                onSelect={() =>
                  copyTerminalContextValue(contextMenuLink.uri, "Link copied")
                }
              >
                Copy Link
              </ContextMenuItem>
            </>
          ) : null}
          {contextMenuLink !== null && contextMenuSelectionText.length > 0 ? (
            <ContextMenuSeparator />
          ) : null}
          {contextMenuSelectionText.length > 0 ? (
            <ContextMenuItem
              onSelect={() =>
                copyTerminalContextValue(
                  contextMenuSelectionText,
                  "Selection copied",
                )
              }
            >
              Copy
            </ContextMenuItem>
          ) : null}
          {contextMenuLink !== null || contextMenuSelectionText.length > 0 ? (
            <ContextMenuSeparator />
          ) : null}
          <ContextMenuItem
            disabled={session.status !== "running"}
            onSelect={pasteFromClipboard}
          >
            Paste
          </ContextMenuItem>
        </ContextMenuContent>
        <TimelineSelectionMenu
          selection={activeSelection}
          onAddToChat={
            onSelectionAddToChat === undefined
              ? undefined
              : handleSelectionAddToChat
          }
          onDismiss={clearTerminalSelection}
        />
        <TerminalLinkOpenDialog
          target={pendingTerminalLink}
          onConfirm={confirmTerminalLinkOpen}
          onOpenChange={(open) => {
            if (!open) {
              setPendingTerminalLink(null);
            }
          }}
        />
      </ContextMenu>
      {isTouchDevice ? (
        <TerminalMobileControls
          controlActive={controlActive}
          disabled={!terminalReady || session.status !== "running"}
          readOnlyDisabled={!terminalReady}
          onControlChange={(active) => {
            changeControlActive(active);
            if (active) terminalRef.current?.focus();
          }}
          onPreviousPrompt={() => jumpToPrompt("previous")}
          onNextPrompt={() => jumpToPrompt("next")}
          onArrow={(key) => {
            const terminal = terminalRef.current;
            if (!terminal) return;
            changeControlActive(false);
            compositionInputGuardRef.current?.flushPendingInput();
            terminal.input(
              encodeTerminalArrow(
                key,
                terminal.modes.applicationCursorKeysMode,
              ),
            );
          }}
          onInput={(data) => {
            changeControlActive(false);
            compositionInputGuardRef.current?.flushPendingInput();
            terminalRef.current?.input(data);
          }}
          onKeyboardToggle={() => {
            const terminal = terminalRef.current;
            if (!terminal) return;
            if (document.activeElement === terminal.textarea) terminal.blur();
            else terminal.focus();
          }}
          onSearch={() => setTerminalSearchOpen(true)}
          searchAvailable={terminalSearchAddon !== null}
          onPaste={() => {
            changeControlActive(false);
            pasteFromClipboard();
          }}
          onSelectText={() => {
            const terminal = terminalRef.current;
            if (!terminal) return;
            terminal.blur();
            setTextSnapshot(terminalTextSnapshot(terminal));
          }}
        />
      ) : null}
      {isTouchDevice ? (
        <TerminalTextSelectSheet
          open={textSnapshot !== null}
          text={textSnapshot ?? ""}
          onOpenChange={(open) => {
            if (!open) setTextSnapshot(null);
          }}
        />
      ) : null}
    </div>
  );
}
