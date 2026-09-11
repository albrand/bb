import { tmpdir } from "node:os";

export function integrationTmpBase(): string {
  return process.platform === "win32" ? tmpdir() : "/tmp";
}
