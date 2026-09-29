export function PaletteShortcut({ children }: { children: string }) {
  return (
    <kbd
      aria-hidden="true"
      className="pointer-events-none inline-flex shrink-0 items-center justify-center whitespace-nowrap rounded-sm bg-state-hover/50 px-1.5 py-1 font-sans text-xs font-normal leading-none tabular-nums text-subtle-foreground"
    >
      {children}
    </kbd>
  );
}
