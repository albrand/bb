import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { personalWorkspaceHostContract } from "./contract.js";
import { PERSONAL_WORKSPACE_ENVIRONMENT_PROVIDER_ID } from "./provider-id.js";

function overlaps(left: string, right: string): boolean {
  const normalize = (value: string) =>
    `${value.replaceAll("\\", "/").replace(/\/+$/, "")}/`;
  const a = normalize(left);
  const b = normalize(right);
  return a.startsWith(b) || b.startsWith(a);
}

export default async function personalWorkspacePlugin(
  bb: BbPluginApi,
): Promise<void> {
  const host = bb.hosts.experimental_client({
    contract: personalWorkspaceHostContract,
  });

  bb.experimental_environments.register({
    id: PERSONAL_WORKSPACE_ENVIRONMENT_PROVIDER_ID,
    displayName: "Personal workspace",
    description: "Create a personal directory without a project.",
    icon: "Folder",
    requires: { projectless: true },
    async create({ host: machine, pathKey, report, signal }) {
      report.step("Preparing personal workspace…");
      try {
        const created = await host.call(
          "createWorkspace",
          { pathKey },
          { hostId: machine.id, signal },
        );
        return {
          status: "created",
          ownsPath: true,
          path: created.path,
        };
      } catch (error) {
        if (signal.aborted) throw error;
        return {
          status: "failed",

          message: error instanceof Error ? error.message : String(error),
        };
      }
    },
    async remove({ environment, hostId, path, pathKey, report, signal }) {
      if (hostId === null) {
        return {
          status: "failed",
          message: "The personal workspace machine is unknown",
        };
      }
      try {
        const covering = [];
        for (let offset = 0; ; offset += 500) {
          const page = await bb.sdk.environments.list({
            hostId,
            limit: 500,
            offset,
            signal,
          });
          covering.push(
            ...page.filter(
              (other) =>
                other.id !== environment?.id &&
                other.environmentProviderInstanceKey !== pathKey &&
                other.path !== null &&
                other.status !== "destroyed" &&
                other.lifecycle.teardown?.status !== "removed" &&
                (path === null
                  ? other.path.replaceAll("\\", "/").split("/").pop() ===
                    pathKey
                  : overlaps(other.path, path)),
            ),
          );
          if (page.length < 500) break;
        }
        if (covering.length > 0) {
          return {
            status: "retained",
            message: `Kept the personal workspace because ${covering
              .map((other) => other.id)
              .join(", ")} still covers it. Nothing was removed.`,
          };
        }
        const removal = await host.call(
          "removeWorkspace",
          { pathKey, path },
          { hostId, signal },
        );
        if (removal.unknown !== null) {
          return {
            status: "retained",
            message: `Kept the personal workspace because whether a process is still working inside it could not be established (${removal.unknown}). Nothing was removed and nothing was stopped; it is checked again later.`,
          };
        }
        if (removal.holders.length > 0) {
          return {
            status: "retained",
            message: `Kept the personal workspace because ${removal.holders.length === 1 ? "a process is" : `${removal.holders.length} processes are`} still working inside it (${removal.holders
              .slice(0, 5)
              .map((holder) => `pid ${holder.pid} in ${holder.cwd}`)
              .join("; ")}). Nothing was removed and nothing was stopped; it is checked again later.`,
          };
        }
        const helpers = removal.unvouchedHelpers ?? [];
        report.log(
          removal.excludedOtherUsers === null
            ? "Only the current user's processes were checked before removing the workspace; other users' processes were not."
            : `Checked the current user's processes before removing the workspace; ${removal.excludedOtherUsers} process(es) of other users could not be read and were excluded${helpers.length === 0 ? "" : `, and ${helpers.length} session helper(s) of the same user could not be read and were not counted (${helpers.map((helper) => `${helper.comm} ${helper.pid}`).join(", ")})`}.`,
        );
        return { status: "removed" };
      } catch (error) {
        if (signal.aborted) throw error;
        return {
          status: "failed",
          message: error instanceof Error ? error.message : String(error),
        };
      }
    },
  });
}
