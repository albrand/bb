import * as React from "react";
import { cn } from "../../lib/utils";
import { CONTROL_HOVER_TRANSITION } from "./motion.js";

type SwitchProps = Omit<
  React.ComponentPropsWithoutRef<"button">,
  "onChange" | "role"
> & {
  checked: boolean;
  size?: "default" | "sm";
  onCheckedChange?: (checked: boolean) => void;
};

const Switch = React.forwardRef<HTMLButtonElement, SwitchProps>(
  (
    {
      checked,
      className,
      disabled,
      size = "sm",
      onCheckedChange,
      onClick,
      ...props
    },
    ref,
  ) => (
    <button
      {...props}
      ref={ref}
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      data-state={checked ? "checked" : "unchecked"}
      data-switch-hit-area
      className={cn(
        "group peer relative inline-flex shrink-0 cursor-pointer items-center justify-start rounded-full outline-none disabled:cursor-not-allowed disabled:opacity-50",
        size === "default" && "h-5 w-9 pointer-coarse:size-11",
        size === "sm" && "h-4 w-7 pointer-coarse:size-11",
        className,
      )}
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented) {
          onCheckedChange?.(!checked);
        }
      }}
    >
      <span
        aria-hidden
        data-state={checked ? "checked" : "unchecked"}
        data-switch-track
        className={cn(
          `pointer-events-none absolute inset-0 m-auto box-border rounded-full border border-transparent bg-input shadow-xs ${CONTROL_HOVER_TRANSITION} group-focus-visible:ring-2 group-focus-visible:ring-ring group-focus-visible:ring-offset-2 group-focus-visible:ring-offset-background data-[state=checked]:bg-foreground data-[state=unchecked]:border-input data-[state=unchecked]:bg-muted`,
          size === "default" && "h-5 w-9",
          size === "sm" && "h-4 w-7",
        )}
      />
      <span
        aria-hidden
        data-state={checked ? "checked" : "unchecked"}
        className={cn(
          "pointer-events-none relative z-10 block rounded-full bg-background ring-0 transition-transform data-[state=unchecked]:bg-foreground data-[state=unchecked]:translate-x-0",
          size === "default" && "ml-px size-4 pointer-coarse:ml-[5px] data-[state=checked]:translate-x-4",
          size === "sm" && "ml-px size-3 pointer-coarse:ml-[9px] data-[state=checked]:translate-x-3",
        )}
      />
    </button>
  ),
);
Switch.displayName = "Switch";

export { Switch };
