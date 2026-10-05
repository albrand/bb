import { lazy, Suspense, useCallback, useState, type ReactNode } from "react";
import type { Thread } from "@bb/domain";
import { CompactLongPressMenu } from "@/components/ui/compact-long-press-menu";
import type { ThreadActionsCompactStep } from "./ThreadActionsMenu";

const ThreadActionsLongPressMenuContents = lazy(() =>
  import("./ThreadActionsMenu").then((module) => ({
    default: module.ThreadActionsLongPressMenuContents,
  })),
);

export function ThreadActionsLongPressMenu({
  children,
  thread,
}: {
  children: ReactNode;
  thread: Thread;
}) {
  const [compactStep, setCompactStep] =
    useState<ThreadActionsCompactStep>("actions");
  const resetCompactStepOnClose = useCallback((open: boolean) => {
    if (!open) setCompactStep("actions");
  }, []);
  const resetCompactStep = useCallback(() => setCompactStep("actions"), []);

  return (
    <CompactLongPressMenu
      label="Thread actions"
      onOpenChange={resetCompactStepOnClose}
      items={
        <Suspense fallback={null}>
          <ThreadActionsLongPressMenuContents
            thread={thread}
            compactStep={compactStep}
            onCompactStepChange={setCompactStep}
            onCloseMenu={resetCompactStep}
          />
        </Suspense>
      }
    >
      {children}
    </CompactLongPressMenu>
  );
}
