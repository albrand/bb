// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { Host } from "@bb/domain";
import { makeHost } from "@bb/test-helpers/domain-fixtures";
import type { CliSkillMachineStatus } from "@bb/server-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InstallCliSkillsDialog } from "./InstallCliSkillsDialog";

afterEach(() => {
  cleanup();
});

function host(overrides: Partial<Host> & Pick<Host, "id" | "name">): Host {
  return makeHost({
    lastSeenAt: 1,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  });
}

const hosts: Host[] = [
  host({ id: "host-laptop", name: "Laptop" }),
  host({ id: "host-studio", name: "Studio" }),
  host({ id: "host-old", name: "Old Box", status: "disconnected" }),
];

const statuses = new Map<string, CliSkillMachineStatus>([
  ["host-laptop", "installed"],
  ["host-studio", "outdated"],
]);
const missingStatuses = new Map<string, CliSkillMachineStatus>([
  ["host-laptop", "missing"],
  ["host-studio", "missing"],
]);

function checkbox(name: string): HTMLInputElement {
  const control = screen.getByRole("checkbox", { name });
  if (!(control instanceof HTMLElement)) {
    throw new Error(`Checkbox ${name} is missing`);
  }
  return control as HTMLInputElement;
}

describe("InstallCliSkillsDialog", () => {
  it("installs only the machines left selected", () => {
    const onInstall = vi.fn();
    render(
      <InstallCliSkillsDialog
        open={true}
        onOpenChange={() => undefined}
        hosts={hosts}
        statusByHostId={missingStatuses}
        onCancel={() => undefined}
        onInstall={onInstall}
        pending={false}
      />,
    );

    fireEvent.click(checkbox("Studio"));
    fireEvent.click(screen.getByRole("button", { name: "Install" }));

    expect(onInstall).toHaveBeenCalledWith(["host-laptop"]);
  });

  it("cannot select a disconnected machine or install with nothing selected", () => {
    const onInstall = vi.fn();
    render(
      <InstallCliSkillsDialog
        open={true}
        onOpenChange={() => undefined}
        hosts={hosts}
        statusByHostId={missingStatuses}
        onCancel={() => undefined}
        onInstall={onInstall}
        pending={false}
      />,
    );

    expect(checkbox("Old Box").hasAttribute("disabled")).toBe(true);
    fireEvent.click(checkbox("Laptop"));
    fireEvent.click(checkbox("Studio"));

    const install = screen.getByRole("button", { name: "Install" });
    expect(install.hasAttribute("disabled")).toBe(true);
    fireEvent.click(install);
    expect(onInstall).not.toHaveBeenCalled();
  });

  it("preselects only missing machines when some machines are already installed", () => {
    const partialHosts = [
      hosts[0],
      hosts[1],
      host({ id: "host-travel", name: "Travel PC" }),
    ];
    render(
      <InstallCliSkillsDialog
        open={true}
        onOpenChange={() => undefined}
        hosts={partialHosts}
        statusByHostId={new Map([
          ["host-laptop", "installed"],
          ["host-studio", "missing"],
          ["host-travel", "missing"],
        ])}
        action="install"
        onCancel={() => undefined}
        onInstall={() => undefined}
        pending={false}
      />,
    );

    expect(checkbox("Laptop").getAttribute("aria-checked")).toBe("false");
    expect(checkbox("Studio").getAttribute("aria-checked")).toBe("true");
    expect(checkbox("Travel PC").getAttribute("aria-checked")).toBe("true");
    expect(
      screen.getByRole("heading", { name: "Install bb CLI skills" }),
    ).toBeDefined();
    expect(
      screen.getByText(
        "Choose the remaining machines to install them onto. Each selected machine gets the skills in ~/.agents/skills and ~/.claude/skills.",
      ),
    ).toBeDefined();
  });

  it("updates the default selection when partial statuses load while open", () => {
    const { rerender } = render(
      <InstallCliSkillsDialog
        open={true}
        onOpenChange={() => undefined}
        hosts={hosts}
        statusByHostId={new Map()}
        action="install"
        onCancel={() => undefined}
        onInstall={() => undefined}
        pending={false}
      />,
    );

    expect(checkbox("Laptop").getAttribute("aria-checked")).toBe("true");
    expect(checkbox("Studio").getAttribute("aria-checked")).toBe("true");

    rerender(
      <InstallCliSkillsDialog
        open={true}
        onOpenChange={() => undefined}
        hosts={hosts}
        statusByHostId={new Map([
          ["host-laptop", "installed"],
          ["host-studio", "missing"],
        ])}
        action="install"
        onCancel={() => undefined}
        onInstall={() => undefined}
        pending={false}
      />,
    );

    expect(checkbox("Laptop").getAttribute("aria-checked")).toBe("false");
    expect(checkbox("Studio").getAttribute("aria-checked")).toBe("true");
  });

  it("updates the default selection when outdated statuses load while open", () => {
    const { rerender } = render(
      <InstallCliSkillsDialog
        open={true}
        onOpenChange={() => undefined}
        hosts={hosts}
        statusByHostId={new Map()}
        action="install"
        onCancel={() => undefined}
        onInstall={() => undefined}
        pending={false}
      />,
    );

    rerender(
      <InstallCliSkillsDialog
        open={true}
        onOpenChange={() => undefined}
        hosts={hosts}
        statusByHostId={statuses}
        action="update"
        onCancel={() => undefined}
        onInstall={() => undefined}
        pending={false}
      />,
    );

    expect(checkbox("Laptop").getAttribute("aria-checked")).toBe("false");
    expect(checkbox("Studio").getAttribute("aria-checked")).toBe("true");
  });

  it("reselects only outdated machines after a pre-load choice", () => {
    const onInstall = vi.fn();
    const { rerender } = render(
      <InstallCliSkillsDialog
        open={true}
        onOpenChange={() => undefined}
        hosts={hosts}
        statusByHostId={new Map()}
        action="install"
        onCancel={() => undefined}
        onInstall={onInstall}
        pending={false}
      />,
    );

    fireEvent.click(checkbox("Studio"));
    expect(checkbox("Studio").getAttribute("aria-checked")).toBe("false");

    rerender(
      <InstallCliSkillsDialog
        open={true}
        onOpenChange={() => undefined}
        hosts={hosts}
        statusByHostId={statuses}
        action="update"
        onCancel={() => undefined}
        onInstall={onInstall}
        pending={false}
      />,
    );

    expect(checkbox("Laptop").getAttribute("aria-checked")).toBe("false");
    expect(checkbox("Studio").getAttribute("aria-checked")).toBe("true");
    expect(checkbox("Laptop").hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Update" }));
    expect(onInstall).toHaveBeenCalledWith(["host-studio"]);
  });

  it("replaces Update when its only outdated machine disconnects", () => {
    const { rerender } = render(
      <InstallCliSkillsDialog
        open={true}
        onOpenChange={() => undefined}
        hosts={hosts.slice(0, 2)}
        statusByHostId={statuses}
        action="update"
        onCancel={() => undefined}
        onInstall={() => undefined}
        pending={false}
      />,
    );

    expect(screen.getByRole("button", { name: "Update" }).hasAttribute("disabled")).toBe(false);
    expect(checkbox("Studio").getAttribute("aria-checked")).toBe("true");

    rerender(
      <InstallCliSkillsDialog
        open={true}
        onOpenChange={() => undefined}
        hosts={[hosts[0], host({ id: "host-studio", name: "Studio", status: "disconnected" })]}
        statusByHostId={statuses}
        action="reinstall"
        onCancel={() => undefined}
        onInstall={() => undefined}
        pending={false}
      />,
    );

    expect(screen.getByRole("button", { name: "Reinstall" }).hasAttribute("disabled")).toBe(false);
    expect(checkbox("Laptop").getAttribute("aria-checked")).toBe("true");
    expect(checkbox("Studio").getAttribute("aria-checked")).toBe("false");
    expect(checkbox("Studio").hasAttribute("disabled")).toBe(true);
  });

  it("updates only outdated machines and uses matching dialog copy", () => {
    render(
      <InstallCliSkillsDialog
        open={true}
        onOpenChange={() => undefined}
        hosts={hosts}
        statusByHostId={statuses}
        action="update"
        onCancel={() => undefined}
        onInstall={() => undefined}
        pending={false}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Update bb CLI skills" }),
    ).toBeDefined();
    expect(checkbox("Laptop").getAttribute("aria-checked")).toBe("false");
    expect(checkbox("Studio").getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("button", { name: "Update" })).toBeDefined();
    expect(
      screen.getByText(
        "Choose the machines to update. Their older copies in ~/.agents/skills and ~/.claude/skills will be replaced.",
      ),
    ).toBeDefined();
  });

  it("drops the machine list entirely when there is nothing to choose", () => {
    const onInstall = vi.fn();
    render(
      <InstallCliSkillsDialog
        open={true}
        onOpenChange={() => undefined}
        hosts={[host({ id: "host-laptop", name: "Laptop" })]}
        statusByHostId={statuses}
        action="reinstall"
        onCancel={() => undefined}
        onInstall={onInstall}
        pending={false}
      />,
    );

    expect(screen.queryAllByRole("checkbox")).toEqual([]);
    expect(
      screen.getByText(
        "The skills will be reinstalled into ~/.agents/skills and ~/.claude/skills on Laptop.",
      ),
    ).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Reinstall" }));
    expect(onInstall).toHaveBeenCalledWith(["host-laptop"]);
  });
});
