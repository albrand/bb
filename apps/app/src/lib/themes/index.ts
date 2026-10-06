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
import { createRetryableChunkImport } from "../retryable-chunk-import";

const loadConductorTheme = createRetryableChunkImport(
  () => import("./conductor"),
);
const loadConductorBlackTheme = createRetryableChunkImport(
  () => import("./conductor-black"),
);

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
    return (await loadConductorTheme()).conductorThemeCss;
  }
  if (appearance.themeId === "conductor-black") {
    return (await loadConductorBlackTheme()).conductorBlackThemeCss;
  }
  return builtInThemeCss[appearance.themeId];
}

export function preloadAppThemeCss(themeId: string): void {
  if (themeId === "conductor") {
    void loadConductorTheme().catch(() => undefined);
  } else if (themeId === "conductor-black") {
    void loadConductorBlackTheme().catch(() => undefined);
  }
}
