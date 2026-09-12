export const conductorBlackThemeCss = `
/*
 * Conductor theme for bb. Copyright (c) 2026 bottlebrushes. MIT License:
 * https://github.com/bottlebrushes/bb-plugin-conductor-theme (f640f51).
 * Full licence text in THIRD_PARTY_NOTICES.md at the repository root.
 * Adapted for the fork: fonts are the vendored Geist Variable faces, and
 * variables and selectors bb never reads were removed.
 */
/*
 * Conductor Pitch Black Theme for bb
 * True native black canvas (#000000) paired with Conductor's warm espresso brown
 * message cards (#2a1e1d), stone borders, Geist typography, and emerald green actions.
 */

:root,
.light {
  color-scheme: light;

  /* Typography */
  --font-sans: "Geist Variable", "Inter Variable", Inter, sans-serif;
  --font-mono: "Geist Mono Variable", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;

  /* Surfaces */
  --canvas: #ffffff;
  --ink: #2c2826;
  --background: #ffffff;
  --foreground: #2c2826;
  --card: #ffffff;
  --popover: #ffffff;
  --secondary: #fafaf9;
  --accent: #f5f3f0;
  --muted: #fafaf9;
  --input: #d8d4cf;

  --surface-recessed: #2c28260a;
  --surface-recessed-solid: #f8f7f6;
  --surface-recessed-soft-solid: #fdfcfc;
  --surface-raised: #2c282608;
  --surface-raised-solid: #ffffff;
  --surface-scrim: #ffffffeb;

  --state-hover: #2c28260a;
  --state-active: #2c282614;
  --surface-selected: #faf7f5;
  --surface-selected-border: #ece4df;

  --border-seam: #f3ece7;
  --border-seam-vertical: #f3ece7;
  --border: #eae8e6;
  --border-hairline: #f0edea;

  /* Inks */
  --muted-foreground: #756f6c;
  --readback-foreground: #7d5e59;
  --subtle-foreground: #99918c;
  --accent-foreground: #2c2826;
  --secondary-foreground: #2c2826;

  /* Accents & Brand */
  --primary: #1aa14a;
  --primary-foreground: #ffffff;
  --timeline-accent: #0284c7;
  --file-accent: #b45309;
  --ring: #1aa14a;
  --sidebar-ring: #1aa14a;
  --sidebar-search-match: #1aa14a26;
  --sidebar-search-match-border: #1aa14a80;

  /* Status */
  --destructive: #fb2c36;
  --destructive-foreground: #ffffff;
  --destructive-text: #e02424;
  --warning: #f99c00;
  --warning-text: #d97706;
  --attention: #f99c00;
  --success: #16a249;
  --success-foreground: #16a249;
  --diff-added: #16a249;
  --diff-removed: #fb2c36;
  --pr-merged: #0d9488;
  --surface-destructive: #fb2c3614;
  --surface-destructive-border: #fb2c3640;
  --surface-attention: #f99c0017;

  /* Sidebar */
  --sidebar: #fcfbfa;
  --sidebar-foreground: #756f6c;
  --sidebar-accent: #f0edea;
  --sidebar-accent-foreground: #2c2826;
  --sidebar-border: #eae8e6;

  /* Controls */
  --pill-surface: linear-gradient(to bottom, #ffffff, #fafaf9);
  --pill-surface-border: #eae8e6;
  --pill-foreground: #2c2826;
  --pill-icon: #756f6c;
  --pill-surface-selected: linear-gradient(to bottom, #f5f3f0, #eae8e6);
  --pill-surface-selected-border: #d8d4cf;

}

.dark {
  color-scheme: dark;

  /* Typography */
  --font-sans: "Geist Variable", "Inter Variable", Inter, sans-serif;
  --font-mono: "Geist Mono Variable", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;

  /* Native Black Canvas & Warm Brown Cards Ramp */
  --canvas: #000000;
  --ink: #ece9e7;
  --background: #000000;
  --foreground: #ece9e7;
  --card: #2a1e1d;
  --popover: #201e1c;
  --secondary: #2a1e1d;
  --accent: #241b1a;
  --muted: #2a1e1d;
  --input: #4a4240;
  --surface-recessed-solid: #2a1e1d;
  --surface-recessed-soft-solid: #221817;
  --surface-raised: #ffffff0f;
  --surface-raised-solid: #2c2726;
  --surface-scrim: #000000eb;

  --state-hover: #ece9e70f;
  --state-active: #ece9e718;
  --surface-selected: #2a1e1d;
  --surface-selected-border: #3c3635;

  --border-seam: #3c3635;
  --border-seam-vertical: #3c3635;
  --border: #262220;
  --border-hairline: #1c1817;

  /* Inks (lightened for strong contrast on brown/dark surfaces) */
  --muted-foreground: #c2bcba;
  --readback-foreground: #dbd9d7;
  --subtle-foreground: #a5a09e;
  --accent-foreground: #ece9e7;
  --secondary-foreground: #ece9e7;
  /* Accents & Brand: Emerald Green, Terracotta & Soft Cyan */
  --primary: #3eb15f;
  --primary-foreground: #ffffff;
  --timeline-accent: #81ddf9;
  --file-accent: #d8a599;
  --ring: #3eb15f;
  --sidebar-ring: #3eb15f;
  --sidebar-search-match: #3eb15f26;
  --sidebar-search-match-border: #3eb15f80;

  /* Status */
  --destructive: #f56c69;
  --destructive-foreground: #ffffff;
  --destructive-text: #f56c69;
  --warning: #fddd6b;
  --warning-text: #fddd6b;
  --attention: #fddd6b;
  --success: #49db7e;
  --success-foreground: #49db7e;
  --diff-added: #49db7e;
  --diff-removed: #f56c69;
  --pr-merged: #70b7af;
  --surface-destructive: #f56c691a;
  --surface-destructive-border: #f56c694d;
  --surface-attention: #fddd6b1f;

  /* Sidebar (native black with white text and icons) */
  --sidebar: #000000;
  --sidebar-foreground: #ece9e7;
  --sidebar-accent: #151110;
  --sidebar-accent-foreground: #ffffff;
  --sidebar-border: #1a1716;
  /* Controls */
  --pill-surface: linear-gradient(to bottom, #201e1c, #151110);
  --pill-surface-border: #2c2726;
  --pill-foreground: #ece9e7;
  --pill-icon: #ece9e7;
  --pill-surface-selected: linear-gradient(to bottom, #2a1e1d, #201e1c);
  --pill-surface-selected-border: #3c3635;
}

/* Specific component surfaces */
.dark [data-promptbox] {
  background-color: #1b1716;
  border-color: #373433;
}

.dark #thread-detail-secondary-panel {
  --sidebar: #000000;
  --sidebar-foreground: #ece9e7;
}

.dark aside,
.dark [data-sidebar] {
  --sidebar-foreground: #ece9e7;
  color: #ece9e7;
}
/* Switch and toggle styling */
.dark [role="switch"][data-state="unchecked"] {
  background-color: #3d3533 !important;
  border: 1px solid #574c49 !important;
}

.dark [role="switch"] span {
  background-color: #ece9e7 !important;
}

.dark [role="switch"][data-state="checked"] {
  background-color: #3eb15f !important;
  border: 1px solid #49db7e !important;
}

.dark [role="switch"][data-state="checked"] span {
  background-color: #ffffff !important;
}

.dark .bb-code-highlight.bb-code-highlight {
  --sh-identifier: #ece9e7;
  --sh-sign: #a5a09e;
  --sh-property: #81ddf9;
  --sh-comment: #706967;
  --sh-keyword: #f56c69;
  --sh-string: #d8a599;
  --sh-class: #fddd6b;
  --sh-entity: #70b7af;
  --sh-jsxliterals: #81ddf9;
}

.light .bb-code-highlight.bb-code-highlight {
  --sh-identifier: #2c2826;
  --sh-sign: #756f6c;
  --sh-property: #0550ae;
  --sh-comment: #8c8682;
  --sh-keyword: #cf222e;
  --sh-string: #0a3069;
  --sh-class: #953800;
  --sh-entity: #8250df;
  --sh-jsxliterals: #0550ae;
}
`;
