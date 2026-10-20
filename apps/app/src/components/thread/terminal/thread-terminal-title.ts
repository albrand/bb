import { sliceUtf16Head } from "@bb/text-utils";

const TERMINAL_TITLE_MAX_LENGTH = 200;

interface NormalizeTerminalTitleArgs {
  title: string;
}

export function normalizeTerminalTitle({
  title,
}: NormalizeTerminalTitleArgs): string | null {
  const trimmedTitle = title.trim();
  if (!trimmedTitle) {
    return null;
  }

  const shellPathTitle = shellPathTitleLeaf(trimmedTitle);
  if (shellPathTitle !== null) {
    return sliceUtf16Head(shellPathTitle, TERMINAL_TITLE_MAX_LENGTH);
  }

  return sliceUtf16Head(trimmedTitle, TERMINAL_TITLE_MAX_LENGTH);
}

function shellPathTitleLeaf(title: string): string | null {
  const match = /^[^@\s:]+@[^:\s]+:(.+)$/u.exec(title);
  const path = match?.[1]?.trimStart();
  if (!path || !isPathLikeTerminalTitlePath(path)) {
    return null;
  }
  const leaf = path.replace(/\/+$/u, "").split("/").at(-1);
  return leaf || path;
}

function isPathLikeTerminalTitlePath(path: string): boolean {
  return (
    path === "~" ||
    path === "." ||
    path.startsWith("~/") ||
    path.startsWith("/") ||
    path.startsWith("./")
  );
}
