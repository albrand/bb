import { useEffect, useMemo, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { AppTheme } from "@bb/domain";
import { systemThemeQueryOptions } from "@/hooks/queries/system-queries";
import { refreshThemeColorMeta } from "@/hooks/useTheme";
import {
  clearResolvedCodeThemePreview,
  previewResolvedCodeTheme,
} from "@/lib/code-theme";
import { clearAppThemePreview, previewAppThemeCss } from "@/lib/app-theme-css";
import { preloadAppThemeCss, resolveAppThemeCss } from "@/lib/themes";

export interface AppThemePreview {
  prefetchThemes(themeIds: readonly string[]): void;
  previewTheme(themeId: string | null): void;
}

function clearPreview(): void {
  clearAppThemePreview();
  clearResolvedCodeThemePreview();
  refreshThemeColorMeta();
}

function showPreview(theme: AppTheme, css: string): void {
  previewAppThemeCss(css);
  previewResolvedCodeTheme(theme.resolvedCodeTheme);
  refreshThemeColorMeta();
}

export function useAppThemePreview(): AppThemePreview {
  const queryClient = useQueryClient();
  const requestRef = useRef(0);

  useEffect(
    () => () => {
      requestRef.current += 1;
      clearPreview();
    },
    [],
  );

  return useMemo(
    () => ({
      prefetchThemes(themeIds) {
        for (const themeId of themeIds) {
          void queryClient.prefetchQuery(systemThemeQueryOptions(themeId));
          preloadAppThemeCss(themeId);
        }
      },
      previewTheme(themeId) {
        requestRef.current += 1;
        const request = requestRef.current;
        if (themeId === null) {
          clearPreview();
          return;
        }
        void queryClient
          .fetchQuery(systemThemeQueryOptions(themeId))
          .then(async (theme) => ({
            theme,
            css: await resolveAppThemeCss(theme),
          }))
          .then(({ theme, css }) => {
            if (requestRef.current === request) showPreview(theme, css);
          })
          .catch(() => undefined);
      },
    }),
    [queryClient],
  );
}
