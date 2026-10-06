import { useMemo, useState } from "react";
import type { Host } from "@bb/domain";
import type { CliSkillMachineStatus } from "@bb/server-contract";
import { Button } from "@bb/shared-ui/button";
import { Checkbox } from "@bb/shared-ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@bb/shared-ui/dialog";
import { MachineStatusDot } from "@/components/machines/MachineStatusDot";
import type { CliSkillsAction } from "@/components/settings/CliSkillsSettingsSection";

interface InstallCliSkillsDialogContentProps {
  action?: CliSkillsAction;
  hosts: readonly Host[];
  onCancel: () => void;
  onInstall: (hostIds: string[]) => void;
  pending: boolean;
  statusLoading?: boolean;
  statusUnavailable?: boolean;
  statusByHostId: ReadonlyMap<string, CliSkillMachineStatus>;
}

const MACHINE_STATUS_LABELS: Record<CliSkillMachineStatus, string | null> = {
  installed: "Installed",
  outdated: "Out of date",
  missing: "Not installed",
  unknown: null,
};

function isConnected(host: Host): boolean {
  return host.status === "connected";
}

function machineStatusLabel(args: {
  connected: boolean;
  status: CliSkillMachineStatus | undefined;
  statusUnavailable: boolean;
}): string | null {
  if (!args.connected) return "Disconnected";
  if (
    args.statusUnavailable ||
    args.status === undefined ||
    args.status === "unknown"
  ) {
    return "Status unavailable";
  }
  return MACHINE_STATUS_LABELS[args.status];
}

function InstallCliSkillsDialogContent({
  action = "install",
  hosts,
  onCancel,
  onInstall,
  pending,
  statusLoading = false,
  statusUnavailable = false,
  statusByHostId,
}: InstallCliSkillsDialogContentProps) {
  const connectedHostIds = useMemo(
    () => hosts.filter(isConnected).map((host) => host.id),
    [hosts],
  );
  const installedHostIds = connectedHostIds.filter(
    (hostId) => statusByHostId.get(hostId) === "installed",
  );
  const missingHostIds = connectedHostIds.filter(
    (hostId) => statusByHostId.get(hostId) === "missing",
  );
  const targetHostIds = statusUnavailable
    ? []
    : connectedHostIds.filter((hostId) => {
    const status = statusByHostId.get(hostId);
    if (action === "update") {
      return status === "outdated" || status === "missing";
    }
    if (action === "reinstall") return status === "installed";
    return status === "missing";
      });
  const targetHostIdsKey = JSON.stringify([
    action,
    connectedHostIds,
    targetHostIds,
  ]);
  const [selectedHostIdsOverride, setSelectedHostIdsOverride] = useState<{
    targetsKey: string;
    hostIds: readonly string[];
  } | null>(null);
  const selectedHostIds =
    selectedHostIdsOverride?.targetsKey === targetHostIdsKey
      ? selectedHostIdsOverride.hostIds
      : targetHostIds;
  const choosable = hosts.length > 1;
  const selected = choosable
    ? selectedHostIds.filter((hostId) => connectedHostIds.includes(hostId))
    : targetHostIds;
  const actionTitle =
    action === "update"
      ? "Update"
      : action === "reinstall"
        ? "Reinstall"
        : "Install";

  return (
    <>
      <DialogHeader>
        <DialogTitle>{actionTitle} bb CLI skills</DialogTitle>
        <DialogDescription>
          {statusLoading
            ? "Checking machine statuses before choosing where to install the bb CLI skills."
            : statusUnavailable
              ? "Could not confirm machine status. Try again before installing the bb CLI skills."
              : targetHostIds.length === 0 && connectedHostIds.length > 0
              ? "No connected machine has a confirmed status that can be installed to. Try again when machine status is available."
              : choosable
            ? action === "update"
              ? missingHostIds.length > 0
                ? "Choose outdated machines to update and missing machines to install. Selected machines get the latest skills in ~/.agents/skills and ~/.claude/skills."
                : "Choose the machines to update. Their older copies in ~/.agents/skills and ~/.claude/skills will be replaced."
              : action === "reinstall"
                ? "Choose the machines to reinstall. Existing copies in ~/.agents/skills and ~/.claude/skills will be replaced."
                : installedHostIds.length > 0
                  ? "Choose the remaining machines to install them onto. Each selected machine gets the skills in ~/.agents/skills and ~/.claude/skills."
                  : "Choose the machines to install them onto. Each one gets the skills in ~/.agents/skills and ~/.claude/skills, replacing any copy already there."
            : action === "update"
              ? `The latest skills will replace the older copies in ~/.agents/skills and ~/.claude/skills on ${hosts[0]?.name ?? "the selected machine"}.`
              : action === "reinstall"
                ? `The skills will be reinstalled into ~/.agents/skills and ~/.claude/skills on ${hosts[0]?.name ?? "the selected machine"}.`
                : `The skills go in ~/.agents/skills and ~/.claude/skills on ${hosts[0]?.name ?? "the selected machine"}, replacing any copy already there.`}
        </DialogDescription>
      </DialogHeader>

      {choosable ? (
        <div className="flex flex-col gap-1 py-1">
          {hosts.map((host) => {
            const connected = isConnected(host);
            const statusLabel = machineStatusLabel({
              connected,
              status: statusByHostId.get(host.id),
              statusUnavailable,
            });
            return (
              <label
                key={host.id}
                className="flex items-center gap-2.5 rounded-md px-1 py-2 text-sm has-[:disabled]:opacity-60"
              >
                <Checkbox
                  checked={selected.includes(host.id)}
                  disabled={
                    !connected ||
                    pending ||
                    statusUnavailable ||
                    (action === "install" &&
                      statusByHostId.get(host.id) !== "missing") ||
                    (action === "reinstall" &&
                      statusByHostId.get(host.id) !== "installed") ||
                    (action === "update" &&
                      statusByHostId.get(host.id) !== "outdated" &&
                      statusByHostId.get(host.id) !== "missing")
                  }
                  onCheckedChange={(checked) =>
                    setSelectedHostIdsOverride((current) => {
                      const selection =
                        current?.targetsKey === targetHostIdsKey
                          ? current.hostIds
                          : targetHostIds;
                      return {
                        targetsKey: targetHostIdsKey,
                        hostIds:
                          checked === true
                            ? [...selection, host.id]
                            : selection.filter((hostId) => hostId !== host.id),
                      };
                    })
                  }
                  aria-label={host.name}
                />
                <MachineStatusDot connected={connected} />
                <span className="min-w-0 truncate">{host.name}</span>
                {statusLabel === null ? null : (
                  <span className="ml-auto shrink-0 text-xs text-subtle-foreground">
                    {statusLabel}
                  </span>
                )}
              </label>
            );
          })}
        </div>
      ) : null}

      <DialogFooter>
        <Button
          type="button"
          variant="outline"
          className="max-md:pointer-coarse:min-h-11"
          disabled={pending}
          onClick={onCancel}
        >
          Cancel
        </Button>
        <Button
          type="button"
          variant={action === "reinstall" ? "secondary" : "default"}
          className="max-md:pointer-coarse:min-h-11"
          disabled={
            statusLoading || statusUnavailable || pending || selected.length === 0
          }
          onClick={() => onInstall([...selected])}
        >
          {pending
            ? action === "update"
              ? "Updating…"
              : action === "reinstall"
                ? "Reinstalling…"
                : "Installing…"
            : actionTitle}
        </Button>
      </DialogFooter>
    </>
  );
}

interface InstallCliSkillsDialogProps extends InstallCliSkillsDialogContentProps {
  onOpenChange: (open: boolean) => void;
  open: boolean;
}

export function InstallCliSkillsDialog({
  onOpenChange,
  open,
  ...contentProps
}: InstallCliSkillsDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        {open ? <InstallCliSkillsDialogContent {...contentProps} /> : null}
      </DialogContent>
    </Dialog>
  );
}
