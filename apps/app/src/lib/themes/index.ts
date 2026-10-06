import {
  isBuiltInThemeId,
  type AppTheme,
  type BuiltInThemeId,
} from "@bb/domain";
import { catppuccinThemeCss } from "./catppuccin";
import { draculaThemeCss } from "./dracula";
import { gruvboxThemeCss } from "./gruvbox";
import { nordThemeCss } from "./nord";
import { solarizedThemeCss } from "./solarized";

type EagerBuiltInThemeId = Exclude<
  BuiltInThemeId,
  "conductor" | "conductor-black"
>;

const builtInThemeCss: Record<EagerBuiltInThemeId, string> = {
  default: "",
  nord: nordThemeCss,
  dracula: draculaThemeCss,
  solarized: solarizedThemeCss,
  gruvbox: gruvboxThemeCss,
  catppuccin: catppuccinThemeCss,
};

export async function resolveAppThemeCss(
  appearance: Pick<AppTheme, "themeId" | "customCss">,
): Promise<string> {
  if (!isBuiltInThemeId(appearance.themeId)) {
    return appearance.customCss ?? "";
  }
  if (appearance.themeId === "conductor") {
    return (await import("./conductor")).conductorThemeCss;
  }
  if (appearance.themeId === "conductor-black") {
    return (await import("./conductor-black")).conductorBlackThemeCss;
  }
  return builtInThemeCss[appearance.themeId];
}

export function preloadAppThemeCss(themeId: string): void {
  if (themeId === "conductor") {
    void import("./conductor").catch(() => undefined);
  } else if (themeId === "conductor-black") {
    void import("./conductor-black").catch(() => undefined);
  }
}
