import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useSyncExternalStore,
} from "react";
import { useSystemConfig } from "@/hooks/queries/system-queries";
import { refreshThemeColorMeta } from "@/hooks/useTheme";
import { applyResolvedCodeTheme } from "@/lib/code-theme";
import {
  applyAppThemeCss,
  getAppThemeEpoch,
  subscribeAppThemeChange,
} from "@/lib/app-theme-css";
import { resolveAppThemeCss } from "@/lib/themes";

export function useAppTheme(): void {
  const { data } = useSystemConfig();
  const appearance = data?.appearance;
  const themeId = appearance?.themeId;
  const customCss = appearance?.customCss ?? null;
  const cssAppearance = useMemo(
    () => (themeId === undefined ? undefined : { themeId, customCss }),
    [themeId, customCss],
  );

  useLayoutEffect(() => {
    if (appearance?.resolvedCodeTheme === undefined) return;
    applyResolvedCodeTheme(appearance.resolvedCodeTheme);
  }, [appearance?.resolvedCodeTheme]);

  useEffect(() => {
    if (cssAppearance === undefined) return;
    let active = true;
    void resolveAppThemeCss(cssAppearance).then(
      (css) => {
        if (!active) return;
        applyAppThemeCss(css);
        refreshThemeColorMeta();
      },
      () => undefined,
    );
    return () => {
      active = false;
    };
  }, [cssAppearance]);
}

export function useAppThemeEpoch(): number {
  return useSyncExternalStore(
    subscribeAppThemeChange,
    getAppThemeEpoch,
    getAppThemeEpoch,
  );
}
