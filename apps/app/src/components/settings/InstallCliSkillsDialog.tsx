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
}): string | null {
  if (!args.connected) return "Disconnected";
  return args.status === undefined ? null : MACHINE_STATUS_LABELS[args.status];
}

function InstallCliSkillsDialogContent({
  action = "install",
  hosts,
  onCancel,
  onInstall,
  pending,
  statusByHostId,
}: InstallCliSkillsDialogContentProps) {
  const connectedHostIds = useMemo(
    () => hosts.filter(isConnected).map((host) => host.id),
    [hosts],
  );
  const installedHostIds = connectedHostIds.filter(
    (hostId) => statusByHostId.get(hostId) === "installed",
  );
  const targetHostIds = connectedHostIds.filter((hostId) => {
    const status = statusByHostId.get(hostId);
    if (action === "update") return status === "outdated";
    if (action === "install" && installedHostIds.length > 0) {
      return status === "missing";
    }
    return true;
  });
  const [selectedHostIds, setSelectedHostIds] =
    useState<readonly string[]>(targetHostIds);
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
          {choosable
            ? action === "update"
              ? "Choose the machines to update. Their older copies in ~/.agents/skills and ~/.claude/skills will be replaced."
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
            });
            return (
              <label
                key={host.id}
                className="flex items-center gap-2.5 rounded-md px-1 py-2 text-sm has-[:disabled]:opacity-60"
              >
                <Checkbox
                  checked={selected.includes(host.id)}
                  disabled={!connected || pending}
                  onCheckedChange={(checked) =>
                    setSelectedHostIds((current) =>
                      checked === true
                        ? [...current, host.id]
                        : current.filter((hostId) => hostId !== host.id),
                    )
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
          disabled={pending}
          onClick={onCancel}
        >
          Cancel
        </Button>
        <Button
          type="button"
          variant={action === "reinstall" ? "secondary" : "default"}
          disabled={pending || selected.length === 0}
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
