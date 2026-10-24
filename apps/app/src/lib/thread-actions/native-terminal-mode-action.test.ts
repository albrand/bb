import type { BbNavigate, PluginThreadActionTarget } from "@get-bb/plugin-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  nativeTerminalModeItem,
  type NativeTerminalModeData,
} from "./native-terminal-mode-action";

const { toast, showMutationErrorToast } = vi.hoisted(() => ({
  toast: { success: vi.fn() },
  showMutationErrorToast: vi.fn(),
}));

vi.mock("@/components/ui/app-toast", () => ({ appToast: toast }));
vi.mock("@/lib/mutation-errors", () => ({ showMutationErrorToast }));

function target(
  overrides: Partial<PluginThreadActionTarget> = {},
): PluginThreadActionTarget {
  return {
    id: "thr_a",
    projectId: "prj_a",
    parentThreadId: null,
    archivedAt: null,
    pinnedAt: null,
    sectionId: null,
    isUnread: false,
    status: "idle",
    environment: { id: "env_a", path: "/workspace" },
    ...overrides,
  };
}

function modeData(
  overrides: Partial<{
    providerId: string | null;
    mode: "chat" | "terminal" | "terminalOnly" | "unknown";
    switchMode: NativeTerminalModeData["switchMode"];
  }> = {},
): NativeTerminalModeData {
  const providerId =
    overrides.providerId === undefined ? "claude-code" : overrides.providerId;
  return {
    providerIdOf: () => providerId,
    isNativeProvider: (id) => id === "claude-code" || id === "codex",
    modeOf: () => overrides.mode ?? "chat",
    switchMode: overrides.switchMode ?? vi.fn(async () => undefined),
  };
}

function itemFor(
  thread: PluginThreadActionTarget,
  data: NativeTerminalModeData,
) {
  const navigate = { toThread: vi.fn() } as unknown as BbNavigate;
  const item = nativeTerminalModeItem({
    thread,
    data,
    navigate,
    sdk: {} as never,
  });
  return { item, navigate };
}

async function runItem(
  item: ReturnType<typeof nativeTerminalModeItem>,
): Promise<void> {
  await item?.run({ requestRename: () => undefined } as never);
}

beforeEach(() => {
  toast.success.mockReset();
  showMutationErrorToast.mockReset();
});

describe("Open in terminal / Back to chat", () => {
  it("moves an idle claude-code or codex chat thread to its terminal and shows it", async () => {
    for (const providerId of ["claude-code", "codex"]) {
      const switchMode = vi.fn(async () => undefined);
      const { item, navigate } = itemFor(
        target(),
        modeData({ providerId, switchMode }),
      );
      expect(item).toMatchObject({
        label: "Open in terminal",
        icon: "Terminal",
      });
      expect(item?.detail).toBeUndefined();
      await runItem(item);
      expect(switchMode).toHaveBeenCalledWith("thr_a", "terminal", "prj_a");
      expect(navigate.toThread).toHaveBeenCalledWith("thr_a");
    }
  });

  it("warns that a running turn stops before the thread moves", () => {
    for (const status of ["starting", "active"] as const) {
      expect(itemFor(target({ status }), modeData()).item?.detail).toBe(
        "Stops the running turn first",
      );
    }
  });

  it("offers Back to chat for a thread in its terminal", async () => {
    const switchMode = vi.fn(async () => undefined);
    const { item, navigate } = itemFor(
      target(),
      modeData({ mode: "terminal", switchMode }),
    );
    expect(item).toMatchObject({
      label: "Back to chat",
      icon: "MessageSquare",
    });
    await runItem(item);
    expect(switchMode).toHaveBeenCalledWith("thr_a", "chat", "prj_a");
    expect(toast.success).toHaveBeenCalledWith("Thread is back in chat");
    expect(navigate.toThread).not.toHaveBeenCalled();
  });

  it("hides the action where the thread cannot resume in a terminal", () => {
    const hidden: [string, PluginThreadActionTarget, NativeTerminalModeData][] =
      [
        ["archived", target({ archivedAt: 1 }), modeData()],
        [
          "archived in terminal",
          target({ archivedAt: 1 }),
          modeData({ mode: "terminal" }),
        ],
        [
          "no terminal CLI",
          target(),
          modeData({ providerId: "acp-elyra-codex" }),
        ],
        ["provider unknown", target(), modeData({ providerId: null })],
        ["no workspace", target({ environment: null }), modeData()],
        ["no session yet", target({ status: "pending" }), modeData()],
        [
          "started in the terminal",
          target(),
          modeData({ mode: "terminalOnly" }),
        ],
        ["mode not loaded yet", target(), modeData({ mode: "unknown" })],
        [
          "mode not loaded, running",
          target({ status: "active" }),
          modeData({ mode: "unknown" }),
        ],
      ];
    for (const [, thread, data] of hidden) {
      expect(itemFor(thread, data).item).toBeNull();
    }
  });

  it("reports a refused switch and stays on the thread list", async () => {
    const error = new Error("native_terminal_no_session");
    const { item, navigate } = itemFor(
      target(),
      modeData({ switchMode: vi.fn(async () => Promise.reject(error)) }),
    );
    await runItem(item);
    expect(showMutationErrorToast).toHaveBeenCalledWith({
      error,
      fallbackMessage: "Thread could not open in its terminal.",
    });
    expect(navigate.toThread).not.toHaveBeenCalled();
  });
});
