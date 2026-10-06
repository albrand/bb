import { useMemo, useState } from "react";
import type { Host } from "@bb/domain";
import type {
  CliSkillMachineStatus,
  SystemCliSkillsStatusResponse,
  SystemInstallCliSkillsResponse,
} from "@bb/server-contract";
import { Button } from "@bb/shared-ui/button";
import {
  SettingsSection,
  SettingsWithControl,
} from "@/components/ui/settings-section";
import { appToast } from "@/components/ui/app-toast";
import { InstallCliSkillsDialog } from "@/components/settings/InstallCliSkillsDialog";
import { useInstallCliSkills } from "@/hooks/mutations/settings-mutations";
import { selectHosts, useHosts } from "@/hooks/queries/host-queries";
import { useCliSkillsStatus } from "@/hooks/queries/system-queries";

const CLI_SKILLS_SETTING_LABEL = "bb CLI skills";

interface CliSkillsSettingsSectionContentProps {
  action?: CliSkillsAction;
  actionLabel?: string;
  hasConnectedMachine: boolean;
  onOpenPicker: () => void;
  pending: boolean;
  statusBadge: string | null;
}

export type CliSkillsAction = "install" | "update" | "reinstall";

function installDescription(
  hasConnectedMachine: boolean,
  action: CliSkillsAction,
  statusBadge: string | null,
): string {
  if (!hasConnectedMachine) {
    return "Connect a machine to install them into ~/.agents/skills and ~/.claude/skills.";
  }
  if (action === "reinstall") {
    const unknownMachines = statusBadge?.split("; status unavailable on ")[1];
    return unknownMachines === undefined
      ? "Installed in ~/.agents/skills and ~/.claude/skills on all your machines, so agents outside bb can use the bb CLI."
      : `Installed in ~/.agents/skills and ~/.claude/skills on every machine with a reported status; status unavailable on ${unknownMachines}.`;
  }
  if (action === "update") {
    return "Update the bb CLI skills in ~/.agents/skills and ~/.claude/skills so agents outside bb can use the latest version.";
  }
  const unknownMachines = statusBadge?.split("; status unavailable on ")[1];
  if (statusBadge?.startsWith("Installed on ") && unknownMachines !== undefined) {
    return `Install them into ~/.agents/skills and ~/.claude/skills on machines marked Not installed; status unavailable on ${unknownMachines}.`;
  }
  return statusBadge?.startsWith("Installed on ")
    ? "Install them into ~/.agents/skills and ~/.claude/skills on the remaining machines, so agents outside bb can use the bb CLI."
    : "Install them into ~/.agents/skills and ~/.claude/skills so agents outside bb can use the bb CLI.";
}

export function summarizeMachineStatuses(
  statuses: readonly { name: string; status: CliSkillMachineStatus }[],
): string | null {
  const unknown = statuses.filter(({ status }) => status === "unknown");
  const unknownSummary =
    unknown.length === 0
      ? ""
      : `; status unavailable on ${unknown.map(({ name }) => name).join(", ")}`;
  const known = statuses.filter(({ status }) => status !== "unknown");
  if (known.length === 0) return null;
  const outdated = known.filter(({ status }) => status === "outdated");
  if (outdated.length > 0) {
    return `Out of date on ${outdated.map(({ name }) => name).join(", ")}${unknownSummary}`;
  }
  const installed = known.filter(({ status }) => status === "installed").length;
  if (installed === known.length) {
    return `${known.length > 1
      ? `Installed on ${known.length} machines`
      : "Installed"}${unknownSummary}`;
  }
  if (installed > 0) {
    return `Installed on ${installed} of ${known.length} machines${unknownSummary}`;
  }
  return `Not installed${unknownSummary}`;
}

export function getCliSkillsPresentation(
  statuses: readonly { name: string; status: CliSkillMachineStatus }[],
  hasConnectedMachine = true,
): {
  action: CliSkillsAction;
  actionLabel?: string;
  statusBadge: string | null;
} {
  const knownStatuses = statuses.filter(({ status }) => status !== "unknown");
  const installedCount = knownStatuses.filter(
    ({ status }) => status === "installed",
  ).length;
  const missingCount = knownStatuses.filter(
    ({ status }) => status === "missing",
  ).length;
  const hasOutdated = knownStatuses.some(({ status }) => status === "outdated");
  const allKnownInstalled =
    knownStatuses.length > 0 && installedCount === knownStatuses.length;
  const action: CliSkillsAction = !hasConnectedMachine
    ? "install"
    : hasOutdated
      ? "update"
      : allKnownInstalled
        ? "reinstall"
        : "install";
  const actionLabel =
    action === "install" && installedCount > 0 && missingCount > 0
      ? `Install on ${missingCount} more`
      : undefined;

  return {
    action,
    ...(actionLabel === undefined ? {} : { actionLabel }),
    statusBadge: summarizeMachineStatuses(statuses),
  };
}

export function CliSkillsSettingsSectionContent({
  action = "install",
  actionLabel,
  hasConnectedMachine,
  onOpenPicker,
  pending,
  statusBadge,
}: CliSkillsSettingsSectionContentProps) {
  return (
    <SettingsSection title="Skills">
      <SettingsWithControl
        label={CLI_SKILLS_SETTING_LABEL}
        {...(statusBadge === null ? {} : { labelBadge: statusBadge })}
        description={installDescription(hasConnectedMachine, action, statusBadge)}
      >
        <Button
          type="button"
          variant={action === "reinstall" ? "secondary" : "outline"}
          size="sm"
          className="max-sm:min-h-11"
          disabled={!hasConnectedMachine || pending}
          onClick={onOpenPicker}
          aria-label={`${actionLabel ?? (action === "update" ? "Update" : action === "reinstall" ? "Reinstall" : "Install")} ${CLI_SKILLS_SETTING_LABEL}`}
        >
          {pending
            ? action === "update"
              ? "Updating…"
              : action === "reinstall"
                ? "Reinstalling…"
                : "Installing…"
            : actionLabel ??
              (action === "update"
                ? "Update"
                : action === "reinstall"
                  ? "Reinstall"
                  : "Install")}
        </Button>
      </SettingsWithControl>
    </SettingsSection>
  );
}

function reportInstallResults(result: SystemInstallCliSkillsResponse): void {
  const installed = result.results.filter((entry) => entry.ok);
  const failed = result.results.filter((entry) => !entry.ok);
  if (installed.length > 0) {
    appToast.success(
      `Installed the bb CLI skills on ${installed
        .map((entry) => entry.hostName)
        .join(", ")}`,
    );
  }
  for (const entry of failed) {
    appToast.error(`${entry.hostName}: ${entry.errorMessage}`);
  }
}

function statusByHostId(
  status: SystemCliSkillsStatusResponse | undefined,
): ReadonlyMap<string, CliSkillMachineStatus> {
  return new Map(
    (status?.machines ?? []).map((machine) => [machine.hostId, machine.status]),
  );
}

export function CliSkillsSettingsSection() {
  const hostsQuery = useHosts();
  const statusQuery = useCliSkillsStatus();
  const installCliSkills = useInstallCliSkills();
  const [pickerOpen, setPickerOpen] = useState(false);
  const hosts: readonly Host[] = useMemo(
    () => selectHosts(hostsQuery.data, "persistent"),
    [hostsQuery.data],
  );
  const statuses = statusByHostId(statusQuery.data);
  const statusItems = statusQuery.data?.machines.map((machine) => ({
    name: machine.hostName,
    status: machine.status,
  })) ?? [];
  const hasConnectedMachine = hosts.some((host) => host.status === "connected");
  const { action, actionLabel, statusBadge } =
    getCliSkillsPresentation(statusItems, hasConnectedMachine);

  return (
    <>
      <CliSkillsSettingsSectionContent
        hasConnectedMachine={hasConnectedMachine}
        action={action}
        {...(actionLabel === undefined ? {} : { actionLabel })}
        pending={installCliSkills.isPending}
        statusBadge={statusBadge}
        onOpenPicker={() => setPickerOpen(true)}
      />
      <InstallCliSkillsDialog
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        hosts={hosts}
        statusByHostId={statuses}
        action={action}
        pending={installCliSkills.isPending}
        onCancel={() => setPickerOpen(false)}
        onInstall={(hostIds) =>
          installCliSkills.mutate(
            { hostIds },
            {
              onSuccess: (result) => {
                setPickerOpen(false);
                reportInstallResults(result);
                void statusQuery.refetch();
              },
            },
          )
        }
      />
    </>
  );
}
