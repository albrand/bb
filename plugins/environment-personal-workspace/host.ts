import { mkdir, stat } from "node:fs/promises";
import {
  experimental_defineHostEntry,
  internal_DO_NOT_USE_scanProcessesWithCwdUnder,
} from "@get-bb/plugin-sdk/host";
import { personalWorkspaceHostContract } from "./contract.js";
import {
  assertRemovableWorkspacePath,
  resolveWorkspacePath,
} from "./host/paths.js";
import { removeDirectoryTree } from "./host/remove-directory-tree.js";

async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

export function createPersonalWorkspaceHostEntry() {
  return experimental_defineHostEntry({
    contract: personalWorkspaceHostContract,
    handlers: {
      async createWorkspace(input, context) {
        const target = resolveWorkspacePath({
          dataDir: context.experimental_paths.dataDir,
          pathKey: input.pathKey,
        });
        await mkdir(target, { recursive: true });
        return { path: target };
      },

      async removeWorkspace(input, context) {
        const target =
          input.path === null
            ? resolveWorkspacePath({
                dataDir: context.experimental_paths.dataDir,
                pathKey: input.pathKey,
              })
            : assertRemovableWorkspacePath({
                dataDir: context.experimental_paths.dataDir,
                path: input.path,
              });
        const existed = await pathExists(target);
        let excludedOtherUsers: number | null = null;
        let unvouchedHelpers: { pid: number; comm: string }[] | null = null;
        if (existed) {
          const scan = await internal_DO_NOT_USE_scanProcessesWithCwdUnder({
            directories: [target],
          });
          if (scan.status === "held")
            return {
              removed: false,
              holders: scan.holders,
              unknown: null,
              excludedOtherUsers: scan.excludedOtherUsers,
              unvouchedHelpers: scan.unvouchedHelpers,
            };
          if (scan.status === "unknown")
            return {
              removed: false,
              holders: [],
              unknown: scan.reason,
              excludedOtherUsers: null,
              unvouchedHelpers: null,
            };
          excludedOtherUsers = scan.excludedOtherUsers;
          unvouchedHelpers = scan.unvouchedHelpers;
        }
        await removeDirectoryTree(target);
        return {
          removed: existed,
          holders: [],
          unknown: null,
          excludedOtherUsers,
          unvouchedHelpers,
        };
      },
    },
  });
}

export default createPersonalWorkspaceHostEntry();
