export const conductorThemeCss = `
/*
 * Conductor theme for bb. Copyright (c) 2026 bottlebrushes. MIT License:
 * https://github.com/bottlebrushes/bb-plugin-conductor-theme (f640f51).
 * Full licence text in THIRD_PARTY_NOTICES.md at the repository root.
 * Adapted for the fork: fonts are the vendored Geist Variable faces, and
 * variables and selectors bb never reads were removed.
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
  --secondary: color-mix(in oklch, var(--ink) 8%, var(--canvas));
  --accent: color-mix(in oklch, var(--ink) 8%, var(--canvas));
  --muted: color-mix(in oklch, var(--ink) 11%, var(--canvas));
  --input: color-mix(in oklch, var(--ink) 29.5%, var(--canvas));
  --surface-recessed: color-mix(in oklab, var(--ink) 6%, transparent);
  --surface-recessed-solid: color-mix(in oklab, var(--ink) 6%, var(--canvas));
  --surface-recessed-soft-solid: #fdfcfc;
  --surface-raised: #2c282608;
  --surface-raised-solid: #ffffff;
  --surface-scrim: #ffffffeb;
  --state-hover: color-mix(in oklab, var(--ink) 5.9%, transparent);
  --state-active: color-mix(in oklab, var(--ink) 11.8%, transparent);
  --surface-selected: #faf7f5;
  --surface-selected-border: #ece4df;
  --border-seam: color-mix(in oklch, var(--ink) 9.5%, var(--canvas));
  --border-seam-vertical: var(--border-seam);
  --border: color-mix(in oklch, var(--ink) 14%, var(--canvas));
  --border-hairline: color-mix(in oklch, var(--ink) 14.7%, var(--canvas));

  /* Inks */
  --muted-foreground: #625c59;
  --readback-foreground: #7d5e59;
  --subtle-foreground: #6f6a68;
  --accent-foreground: #2c2826;
  --secondary-foreground: #2c2826;

  /* Accents & Brand */
  --primary: #15803d;
  --primary-foreground: #ffffff;
  --timeline-accent: #0284c7;
  --file-accent: #b45309;
  --ring: #15803d;
  --sidebar-ring: #15803d;
  --sidebar-search-match: #1aa14a26;
  --sidebar-search-match-border: #1aa14a80;

  /* Status */
  --destructive: #c81e27;
  --destructive-foreground: #ffffff;
  --destructive-text: #b91c22;
  --warning: #f99c00;
  --warning-text: #a3480a;
  --attention: #f99c00;
  --success: #16a249;
  --success-foreground: #0f7a37;
  --diff-added: #0f7a37;
  --diff-removed: #b91c22;
  --pr-merged: #0d9488;
  --surface-destructive: #fb2c3614;
  --surface-destructive-border: #fb2c3640;
  --surface-attention: #f99c0017;

  /* Sidebar */
  --sidebar: #fcfbfa;
  --sidebar-foreground: #57514f;
  --sidebar-accent: color-mix(in oklch, var(--ink) 8%, var(--sidebar));
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

  /* Real Conductor Dark Ramp (sampled directly from live app UI) */
  --canvas: #151110;
  --ink: #ece9e7;
  --background: #151110;
  --foreground: #ece9e7;
  --card: #2a1e1d;
  --popover: #2a1e1d;
  --secondary: color-mix(in oklch, var(--ink) 13%, var(--card));
  --accent: color-mix(in oklch, var(--ink) 13%, var(--card));
  --muted: color-mix(in oklch, var(--ink) 16%, var(--card));
  --input: color-mix(in oklch, var(--ink) 32.6%, var(--card));
  --surface-recessed: color-mix(in oklab, var(--ink) 6%, transparent);
  --surface-recessed-solid: color-mix(in oklab, var(--ink) 6%, var(--canvas));
  --surface-recessed-soft-solid: #261b1a;
  --surface-raised: #ffffff0f;
  --surface-raised-solid: #2c2726;
  --surface-scrim: #151110eb;
  --state-hover: color-mix(in oklab, var(--ink) 13.8%, transparent);
  --state-active: color-mix(in oklab, var(--ink) 22.5%, transparent);
  --surface-selected: color-mix(in oklab, var(--primary) 14%, transparent);
  --surface-selected-border: color-mix(in oklab, var(--primary) 35%, transparent);
  --border-seam: color-mix(in oklch, var(--ink) 11%, var(--card));
  --border-seam-vertical: var(--border-seam);
  --border: color-mix(in oklch, var(--ink) 19.4%, var(--card));
  --border-hairline: color-mix(in oklch, var(--ink) 21%, var(--card));

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

  /* Sidebar (espresso with white text and icons) */
  --sidebar: #1b1716;
  --sidebar-foreground: #ece9e7;
  --sidebar-accent: color-mix(in oklch, var(--ink) 12%, var(--sidebar));
  --sidebar-accent-foreground: #ffffff;
  --sidebar-border: #2f2e2d;

  /* Controls */
  --pill-surface: linear-gradient(to bottom, #2c2726, #201e1c);
  --pill-surface-border: #373433;
  --pill-foreground: #ece9e7;
  --pill-icon: #ece9e7;
  --pill-surface-selected: linear-gradient(to bottom, #2a1e1d, #2c2726);
  --pill-surface-selected-border: #3c3635;

}

/* Specific component surfaces */
.dark [data-promptbox] {
  background-color: #201e1c;
  border-color: #373433;
}

.dark #thread-detail-secondary-panel {
  --sidebar: #181413;
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

/* Syntax Highlighting for lightweight chat code */
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
