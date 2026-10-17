export type TerminalShellEvent =
  | { type: "cwd"; cwd: string }
  | { type: "prompt-start" }
  | { type: "command-start" }
  | { type: "command-finish"; exitCode: number }
  | { type: "title"; title: string };

const MAX_OSC_PAYLOAD_LENGTH = 4096;
const OSC_52_MAX_TEXT_BYTES = 1024 * 1024;
const terminalCurrentCwds = new Map<string, string>();

export function setTerminalCurrentCwd(terminalId: string, cwd: string): void {
  terminalCurrentCwds.set(terminalId, cwd);
}

export function getTerminalCurrentCwd(terminalId: string): string | undefined {
  return terminalCurrentCwds.get(terminalId);
}

export function clearTerminalCurrentCwd(terminalId: string): void {
  terminalCurrentCwds.delete(terminalId);
}

function normalizePosixPath(value: string): string {
  const parts: string[] = [];
  for (const part of value.split("/")) {
    if (part.length === 0 || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `/${parts.join("/")}`;
}

export function parseTerminalShellOsc(
  code: number,
  payload: string,
): TerminalShellEvent | null {
  if (payload.length > MAX_OSC_PAYLOAD_LENGTH) return null;
  if (code === 7) {
    try {
      const url = new URL(payload);
      if (
        url.protocol !== "file:" ||
        (url.hostname !== "" && url.hostname !== "localhost") ||
        url.username !== "" ||
        url.password !== "" ||
        url.port !== "" ||
        url.search !== "" ||
        url.hash !== ""
      )
        return null;
      const cwd = decodeURIComponent(url.pathname);
      if (!cwd.startsWith("/") || cwd.includes("\0")) return null;
      return { type: "cwd", cwd: normalizePosixPath(cwd) };
    } catch {
      return null;
    }
  }
  if (code === 133 || code === 633) {
    const [marker, ...fields] = payload.split(";");
    if (code === 633 && marker === "P") {
      const cwdField = fields.find((field) => field.startsWith("Cwd="));
      const cwd = cwdField?.slice(4);
      if (
        cwd !== undefined &&
        cwd.startsWith("/") &&
        !/[\u0000-\u001f\u007f]/u.test(cwd)
      ) {
        return { type: "cwd", cwd: normalizePosixPath(cwd) };
      }
    }
    if (marker === "A") return { type: "prompt-start" };
    if (marker === "B") return { type: "command-start" };
    if (marker === "C") return { type: "command-start" };
    if (marker === "D") {
      const statusText = fields[0] ?? "0";
      if (!/^-?\d{1,6}$/u.test(statusText)) return null;
      const exitCode = Number(statusText);
      return Number.isSafeInteger(exitCode)
        ? { type: "command-finish", exitCode }
        : null;
    }
  }
  if (
    (code === 0 || code === 2) &&
    payload.length > 0 &&
    !/[\u0000-\u001f\u007f]/u.test(payload)
  ) {
    return { type: "title", title: payload.slice(0, 256) };
  }
  return null;
}

export function terminalCwdFromOsc7(payload: string): string | null {
  const event = parseTerminalShellOsc(7, payload);
  return event?.type === "cwd" ? event.cwd : null;
}

export function terminalCwdTitle(cwd: string): string {
  const normalized = normalizePosixPath(cwd);
  return normalized.split("/").at(-1) || cwd;
}

export function shouldUseTerminalCwdTitle(args: {
  currentTitle: string;
  defaultTitle: string;
  previousCwdTitle: string | null;
}): boolean {
  return (
    args.currentTitle === args.defaultTitle ||
    args.currentTitle === args.previousCwdTitle
  );
}

export function terminalSpawnCwd(args: {
  currentCwd: string | undefined;
  initialCwd: string;
}): string | undefined {
  return (
    args.currentCwd ?? (args.initialCwd === "~" ? undefined : args.initialCwd)
  );
}

export function terminalPromptLine(
  lines: readonly number[],
  viewportLine: number,
  direction: "previous" | "next",
): number | null {
  if (direction === "previous") {
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index];
      if (line !== undefined && line < viewportLine) return line;
    }
    return null;
  }
  return lines.find((line) => line > viewportLine) ?? null;
}

export function registerTerminalShellOscHandlers(
  terminal: {
    registerOscHandler: (
      identifier: number,
      callback: (data: string) => boolean,
    ) => { dispose(): void };
  },
  onEvent: (event: TerminalShellEvent) => void,
): { dispose(): void } {
  const registrations = [7, 133, 633].map((identifier) =>
    terminal.registerOscHandler(identifier, (payload) => {
      const event = parseTerminalShellOsc(identifier, payload);
      if (event === null) return false;
      onEvent(event);
      return true;
    }),
  );
  return {
    dispose: () =>
      registrations.forEach((registration) => registration.dispose()),
  };
}

export function parseTerminalOsc52Copy(payload: string): string | null {
  if (
    payload.length > Math.ceil(OSC_52_MAX_TEXT_BYTES / 3) * 4 + 4 ||
    !payload.startsWith("c;")
  ) {
    return null;
  }
  const encoded = payload.slice(2);
  if (encoded === "?" || encoded.length === 0) return null;
  try {
    const binary = atob(encoded);
    if (binary.length > OSC_52_MAX_TEXT_BYTES) return null;
    const bytes = Uint8Array.from(binary, (character) =>
      character.charCodeAt(0),
    );
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

export function registerTerminalOsc52Handler(
  terminal: {
    parser: {
      registerOscHandler(
        identifier: number,
        callback: (data: string) => boolean,
      ): { dispose(): void };
    };
  },
  onCopy: (text: string) => void,
  shouldIgnore: () => boolean,
): { dispose(): void } {
  const registration = terminal.parser.registerOscHandler(52, (payload) => {
    if (shouldIgnore()) return true;
    const text = parseTerminalOsc52Copy(payload);
    if (text === null) return true;
    onCopy(text);
    return true;
  });
  return { dispose: () => registration.dispose() };
}
