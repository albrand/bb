import { useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NativeTerminalPromptBar } from "./NativeTerminalPromptBar";
import { TerminalMobileControls } from "./TerminalMobileControls";

export default {
  title: "thread/terminal/Native Terminal Thread",
};

const queryClient = new QueryClient({
  defaultOptions: { mutations: { retry: false } },
});

const TUI_LINES = [
  "╭─────────────────────────────────────────────╮",
  "│ ✻ Welcome to the native CLI                  │",
  "│   cwd: ~/projects/bb-fork                    │",
  "╰─────────────────────────────────────────────╯",
  "",
  "> fix the failing typecheck in apps/app",
  "",
  "● Reading native-terminal-queries.ts",
  "● Update(native-terminal-queries.ts)",
  "  ⎿  Added 1 line",
  "",
  "  ? for shortcuts · ⇧tab to cycle modes",
];

function FakeTerminal() {
  return (
    <pre className="min-h-0 flex-1 overflow-hidden bg-background px-2 py-1 font-mono text-xs text-foreground">
      {TUI_LINES.join("\n")}
    </pre>
  );
}

function PhoneFrame({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-[44rem] w-[24.375rem] shrink-0 flex-col overflow-hidden rounded-xl border border-border">
      {children}
    </div>
  );
}

function NativeThreadPhone() {
  const [controlActive, setControlActive] = useState(false);
  return (
    <QueryClientProvider client={queryClient}>
      <PhoneFrame>
        <div
          className="flex h-full min-h-0 min-w-0 flex-col"
          data-native-terminal-thread="native-provider"
        >
          <FakeTerminal />
          <TerminalMobileControls
            controlActive={controlActive}
            disabled={false}
            onArrow={() => undefined}
            onControlChange={setControlActive}
            onInput={() => undefined}
            onKeyboardToggle={() => undefined}
            onPaste={() => undefined}
          />
          <NativeTerminalPromptBar
            providerLabel="Native CLI"
            threadId="thr-story"
          />
        </div>
      </PhoneFrame>
    </QueryClientProvider>
  );
}

export const Phone = () => <NativeThreadPhone />;
