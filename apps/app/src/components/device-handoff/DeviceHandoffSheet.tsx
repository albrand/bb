import { useEffect } from "react";
import type {
  DeviceHandoffExpiredSignal,
  DeviceHandoffSignal,
} from "@bb/server-contract";
import { Button } from "@bb/shared-ui/button";
import {
  PersistentResponsiveDrawerShell,
  useResponsiveDrawerRealization,
} from "@bb/shared-ui/responsive-overlay";
import { copyToClipboardWithToast } from "@/lib/clipboard";
import { openUrlInExternalBrowser } from "@/lib/url-open-routing";

interface DeviceHandoffSheetProps {
  signal: DeviceHandoffSignal | DeviceHandoffExpiredSignal | null;
  position: number;
  count: number;
  onDismiss(): void;
  onShown(id: string): void;
}

export function DeviceHandoffSheet({
  signal,
  position,
  count,
  onDismiss,
  onShown,
}: DeviceHandoffSheetProps) {
  const open = signal !== null;
  const { isContentRealized } = useResponsiveDrawerRealization({ open });
  useEffect(() => {
    if (isContentRealized && signal?.type === "device-handoff") {
      onShown(signal.id);
    }
  }, [isContentRealized, onShown, signal]);
  useEffect(() => {
    if (signal === null || signal.type !== "device-handoff") return;
    const timer = window.setTimeout(
      onDismiss,
      Math.max(0, signal.expiresAt - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [onDismiss, signal]);

  const copy = () => {
    if (
      signal?.type !== "device-handoff" ||
      signal.request.kind !== "copy-text"
    )
      return;
    void copyToClipboardWithToast(signal.request.text, {
      successMessage: "Copied on this device",
      errorMessage: "Could not copy text",
    }).then((copied) => {
      if (copied) onDismiss();
    });
  };

  const openUrl = () => {
    if (signal?.type !== "device-handoff" || signal.request.kind !== "open-url")
      return;
    openUrlInExternalBrowser(signal.request.url);
    onDismiss();
  };

  const content =
    signal?.type === "device-handoff-expired" ? (
      <>
        <p className="text-sm text-muted-foreground">
          A link or copied text from this terminal expired before you opened it.
          Run the command again.
        </p>
        <div className="flex justify-end">
          <Button type="button" onClick={onDismiss}>
            Dismiss
          </Button>
        </div>
      </>
    ) : signal?.type === "device-handoff" &&
      signal.request.kind === "copy-text" ? (
      <>
        <p className="text-sm text-muted-foreground">{signal.originLabel}</p>
        <pre className="max-h-48 overflow-auto rounded-md bg-muted p-3 text-sm whitespace-pre-wrap break-words">
          {signal.request.text.slice(0, 1_000)}
          {signal.request.text.length > 1_000 ? "…" : ""}
        </pre>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onDismiss}>
            Dismiss
          </Button>
          <Button type="button" onClick={copy}>
            Copy
          </Button>
        </div>
      </>
    ) : signal?.type === "device-handoff" &&
      signal.request.kind === "open-url" ? (
      <>
        <p className="text-sm text-muted-foreground">{signal.originLabel}</p>
        <p className="break-all text-sm">{new URL(signal.request.url).host}</p>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onDismiss}>
            Dismiss
          </Button>
          <Button type="button" onClick={openUrl}>
            Open
          </Button>
        </div>
      </>
    ) : null;

  return (
    <PersistentResponsiveDrawerShell
      contentClassName="max-h-[min(80dvh,42rem)]"
      open={open}
      onOpenChange={(next) => {
        if (!next) onDismiss();
      }}
      srLabel="Device handoff"
    >
      {isContentRealized && signal !== null ? (
        <section className="flex max-h-[min(80dvh,42rem)] flex-col gap-3 overflow-y-auto px-4 pb-4">
          <h2 className="text-base font-semibold">
            {signal.type === "device-handoff-expired"
              ? "Handoff expired"
              : signal.request.kind === "copy-text"
                ? "Text ready to copy"
                : "URL ready to open"}
          </h2>
          {count > 1 ? (
            <p className="text-sm text-muted-foreground">
              {position} of {count}
            </p>
          ) : null}
          {content}
        </section>
      ) : null}
    </PersistentResponsiveDrawerShell>
  );
}
