import { useEffect, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useIsCompactViewport } from "@bb/shared-ui/hooks/use-compact-viewport";
import { ResponsiveDrawerShell } from "@bb/shared-ui/responsive-overlay";
import { cn } from "@bb/shared-ui/lib/utils";
import { usePortalScopeProps } from "@bb/shared-ui/lib/portal-scope";
import { readWindowFindTopOffset } from "@/lib/bb-desktop";

interface ComposerPopupHostProps {
  open: boolean;
  focusKey: string;
  placement: "top" | "bottom";
  label: string;
  interactive: boolean;
  popupKey: string | null;
  popupRef: RefObject<HTMLDivElement | null>;
  composerRef: RefObject<HTMLFormElement | null>;
  onClose(restoreFocus: boolean): void;
  children: ReactNode;
}

export function ComposerPopupHost(props: ComposerPopupHostProps) {
  const { open, label, interactive, popupRef, composerRef, onClose } = props;
  const compact = useIsCompactViewport();
  const drawer = interactive && compact;
  const scopeProps = usePortalScopeProps();

  useEffect(() => {
    if (!open || drawer) return;
    const dismissOutside = (event: PointerEvent) => {
      if (!(event.target instanceof Node)) return;
      if (popupRef.current?.contains(event.target)) return;
      if (composerRef.current?.contains(event.target)) return;
      onClose(false);
    };
    document.addEventListener("pointerdown", dismissOutside, true);
    return () =>
      document.removeEventListener("pointerdown", dismissOutside, true);
  }, [composerRef, drawer, onClose, open, popupRef]);

  const content = <ComposerPopupContent {...props} drawer={drawer} />;

  if (drawer) {
    return (
      <ResponsiveDrawerShell
        open={open}
        srLabel={label}
        onOpenChange={(next) => {
          if (!next) onClose(false);
        }}
        onAfterCloseAutoFocus={() => onClose(true)}
        contentClassName="p-0"
      >
        {content}
      </ResponsiveDrawerShell>
    );
  }
  if (!interactive) {
    return open
      ? createPortal(<div {...scopeProps}>{content}</div>, document.body)
      : null;
  }
  return open ? content : null;
}

function ComposerPopupContent({
  open,
  focusKey,
  drawer,
  placement,
  label,
  interactive,
  popupKey,
  popupRef,
  composerRef,
  children,
}: ComposerPopupHostProps & { drawer: boolean }) {
  const compact = useIsCompactViewport();

  useEffect(() => {
    if (interactive || !open) return;
    const menu = popupRef.current;
    const composer = composerRef.current;
    if (!menu || !composer) return;
    const viewport = window.visualViewport;
    const surface =
      composer.closest<HTMLElement>("[data-promptbox-shell]") ?? composer;
    const siblings = Array.from(surface.children).flatMap((child) =>
      child instanceof HTMLElement &&
      child !== composer &&
      !child.contains(composer)
        ? [{ element: child, display: child.style.display }]
        : [],
    );
    const originalMaxHeight = composer.style.maxHeight;
    const originalOverflowY = composer.style.overflowY;
    const originalScrollTop = composer.scrollTop;
    const restoreComposer = () => {
      composer.style.maxHeight = originalMaxHeight;
      composer.style.overflowY = originalOverflowY;
      for (const sibling of siblings)
        sibling.element.style.display = sibling.display;
    };
    const position = () => {
      restoreComposer();
      let anchor = surface.getBoundingClientRect();
      const left = viewport?.offsetLeft ?? 0;
      const top =
        (viewport?.offsetTop ?? 0) +
        Math.max(compact ? 56 : 0, readWindowFindTopOffset()) +
        8;
      const right = left + (viewport?.width ?? window.innerWidth) - 8;
      const bottom =
        (viewport?.offsetTop ?? 0) +
        (viewport?.height ?? window.innerHeight) -
        8;
      const spaceAbove = () =>
        Math.max(0, Math.min(anchor.top - 8, bottom) - top);
      const spaceBelow = () =>
        Math.max(0, bottom - Math.max(anchor.bottom + 8, top));
      if (Math.max(spaceAbove(), spaceBelow()) < 48) {
        for (const sibling of siblings) sibling.element.style.display = "none";
        composer.style.maxHeight = `${Math.max(44, Math.floor((bottom - top - 16) / 2))}px`;
        composer.style.overflowY = "auto";
        anchor = surface.getBoundingClientRect();
      }
      const above = spaceAbove();
      const below = spaceBelow();
      const useAbove =
        placement === "top"
          ? above >= 48 || above >= below
          : below < 48 && above > below;
      const availableHeight = useAbove ? above : below;
      menu.toggleAttribute(
        "data-promptbox-typeahead-constrained",
        availableHeight < 96,
      );
      menu.style.left = `${Math.max(left + 8, anchor.left)}px`;
      menu.style.width = `${Math.max(0, Math.min(anchor.width, right - anchor.left))}px`;
      menu.style.setProperty(
        "--promptbox-typeahead-max-height",
        `${availableHeight}px`,
      );
      const preferredTop = useAbove
        ? anchor.top - menu.offsetHeight - 8
        : anchor.bottom + 8;
      menu.style.top = `${Math.max(top, Math.min(preferredTop, bottom - menu.offsetHeight))}px`;
      menu.style.visibility = "visible";
    };
    position();
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(position);
    observer?.observe(composer);
    if (surface !== composer) observer?.observe(surface);
    observer?.observe(menu);
    const positionOnScroll = (event: Event) => {
      if (event.target instanceof Node && menu.contains(event.target)) return;
      position();
    };
    window.addEventListener("resize", position);
    window.addEventListener("scroll", positionOnScroll, true);
    viewport?.addEventListener("resize", position);
    viewport?.addEventListener("scroll", position);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", positionOnScroll, true);
      viewport?.removeEventListener("resize", position);
      viewport?.removeEventListener("scroll", position);
      restoreComposer();
      composer.scrollTop = originalScrollTop;
    };
  }, [compact, composerRef, interactive, open, placement, popupRef]);

  useEffect(() => {
    if (!open || !interactive) return;
    const frame = window.requestAnimationFrame(() => {
      const firstInput = popupRef.current?.querySelector<HTMLElement>(
        'input:not([disabled]), textarea:not([disabled]), select:not([disabled]), button:not([disabled]), [tabindex="0"]',
      );
      firstInput?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [focusKey, interactive, open, popupRef]);
  return (
    <div
      ref={popupRef}
      data-promptbox-typeahead-menu=""
      role={interactive && !drawer ? "dialog" : undefined}
      aria-label={interactive ? label : undefined}
      className={
        drawer
          ? undefined
          : !interactive
            ? "invisible fixed z-50"
            : cn(
                "absolute -left-px -right-px z-20",
                placement === "top" ? "bottom-full mb-2" : "top-full mt-2",
              )
      }
    >
      {children}
    </div>
  );
}
