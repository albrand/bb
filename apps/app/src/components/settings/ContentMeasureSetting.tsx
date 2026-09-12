import { Icon } from "@bb/shared-ui/icon";
import { cn } from "@bb/shared-ui/lib/utils";
import { COARSE_POINTER_ICON_SIZE_CLASS } from "@bb/shared-ui/coarse-pointer-sizing";
import { Button } from "@bb/shared-ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@bb/shared-ui/dropdown-menu";
import { SettingsWithControl } from "@/components/ui/settings-section";
import {
  CONTENT_MEASURE_LABELS,
  CONTENT_MEASURE_OPTIONS,
  CONTENT_MEASURE_WIDTH_PX,
  setContentMeasure,
  useContentMeasure,
} from "@/lib/content-measure";

const SETTINGS_DROPDOWN_TRIGGER_CLASS =
  "h-7 w-full justify-between border-border/60 bg-card px-2 text-xs sm:w-36";
const SETTINGS_DROPDOWN_CONTENT_CLASS =
  "min-w-[var(--radix-dropdown-menu-trigger-width)]";

export const CONTENT_MEASURE_SETTING_LABEL = "Content width";

export function ContentMeasureSetting() {
  const measure = useContentMeasure();
  return (
    <SettingsWithControl
      label={CONTENT_MEASURE_SETTING_LABEL}
      description={`How wide the thread, composer and settings column may grow on a large window. Comfortable is ${CONTENT_MEASURE_WIDTH_PX.comfortable}px, Wide is ${CONTENT_MEASURE_WIDTH_PX.wide}px. Narrow windows are unaffected.`}
    >
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            className={SETTINGS_DROPDOWN_TRIGGER_CLASS}
            aria-label={CONTENT_MEASURE_SETTING_LABEL}
          >
            {CONTENT_MEASURE_LABELS[measure]}
            <Icon name="ChevronDown" className="size-3.5 text-muted-foreground" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className={SETTINGS_DROPDOWN_CONTENT_CLASS}>
          {CONTENT_MEASURE_OPTIONS.map((option) => (
            <DropdownMenuItem key={option} onSelect={() => setContentMeasure(option)}>
              {CONTENT_MEASURE_LABELS[option]}
              <Icon
                name="Check"
                className={cn(
                  "ml-auto",
                  measure !== option && "opacity-0",
                  COARSE_POINTER_ICON_SIZE_CLASS,
                )}
              />
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </SettingsWithControl>
  );
}
