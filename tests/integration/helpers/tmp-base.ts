import { tmpdir } from "node:os";

export const HARNESS_TMP_ROOT_PREFIX = "bb-integration-";

export function integrationTmpBase(): string {
  return process.platform === "win32" ? tmpdir() : "/tmp";
}
