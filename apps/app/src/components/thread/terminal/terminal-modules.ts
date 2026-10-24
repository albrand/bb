export function importTerminalModules() {
  return Promise.all([
    import("@xterm/xterm"),
    import("@xterm/addon-fit"),
    importTerminalUnicodeAddon(),
  ]);
}

export function importTerminalSearchAddon() {
  return import("@xterm/addon-search");
}

export function importTerminalWebLinksAddon() {
  return import("@xterm/addon-web-links");
}

export function importTerminalUnicodeAddon() {
  return import("@xterm/addon-unicode11");
}

export function importTerminalWebglAddon() {
  return import("@xterm/addon-webgl");
}

export function preloadTerminalModules(): void {
  void importTerminalModules().catch(() => undefined);
  void importTerminalSearchAddon().catch(() => undefined);
  void importTerminalWebLinksAddon().catch(() => undefined);
  void importTerminalWebglAddon().catch(() => undefined);
}
