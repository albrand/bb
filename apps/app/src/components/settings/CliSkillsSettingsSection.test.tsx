// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  CliSkillsSettingsSectionContent,
  getCliSkillsPresentation,
  summarizeMachineStatuses,
} from "./CliSkillsSettingsSection";

afterEach(() => {
  cleanup();
});

function installButton(): HTMLButtonElement {
  const button = screen.getByRole("button", { name: /bb CLI skills/ });
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error("Install control is not a button");
  }
  return button;
}

describe("CliSkillsSettingsSectionContent", () => {
  it("offers the picker when a machine is connected", () => {
    render(
      <CliSkillsSettingsSectionContent
        hasConnectedMachine={true}
        onOpenPicker={() => undefined}
        pending={false}
        statusBadge={null}
      />,
    );

    expect(installButton().disabled).toBe(false);
    expect(installButton().textContent).toBe("Install");
  });

  it("offers a quiet reinstall when all known machines already have the skills", () => {
    render(
      <CliSkillsSettingsSectionContent
        hasConnectedMachine={true}
        onOpenPicker={() => undefined}
        pending={false}
        statusBadge="Installed on 3 machines"
        action="reinstall"
      />,
    );

    expect(installButton().textContent).toBe("Reinstall");
    expect(installButton().className).toContain("bg-secondary");
    expect(installButton().getAttribute("aria-label")).toBe(
      "Reinstall bb CLI skills",
    );
    expect(
      screen.getByText(
        "Installed in ~/.agents/skills and ~/.claude/skills on all your machines, so agents outside bb can use the bb CLI.",
      ),
    ).toBeDefined();
  });

  it("qualifies installed machines when another machine's status is unknown", () => {
    const presentation = getCliSkillsPresentation([
      { name: "Laptop", status: "installed", connected: true },
      { name: "Old Studio", status: "outdated", connected: false },
    ]);
    render(
      <CliSkillsSettingsSectionContent
        hasConnectedMachine={true}
        onOpenPicker={() => undefined}
        pending={false}
        statusBadge={presentation.statusBadge}
        action={presentation.action}
      />,
    );

    expect(installButton().textContent).toBe("Reinstall");
    expect(
      screen.getByText("Installed; status unavailable on Old Studio"),
    ).toBeDefined();
    expect(
      screen.getByText(
        "Installed in ~/.agents/skills and ~/.claude/skills on every machine with a reported status; status unavailable on Old Studio.",
      ),
    ).toBeDefined();
    expect(
      screen.queryByText(
        "Installed in ~/.agents/skills and ~/.claude/skills on all your machines, so agents outside bb can use the bb CLI.",
      ),
    ).toBeNull();
  });

  it("counts remaining machines and gives outdated machines an update action", () => {
    const onOpenPicker = () => undefined;
    const { rerender } = render(
      <CliSkillsSettingsSectionContent
        hasConnectedMachine={true}
        onOpenPicker={onOpenPicker}
        pending={false}
        statusBadge="Installed on 1 of 3 machines"
        action="install"
        actionLabel="Install on 2 more"
      />,
    );

    expect(installButton().textContent).toBe("Install on 2 more");
    expect(installButton().getAttribute("aria-label")).toBe(
      "Install on 2 more bb CLI skills",
    );

    rerender(
      <CliSkillsSettingsSectionContent
        hasConnectedMachine={true}
        onOpenPicker={onOpenPicker}
        pending={false}
        statusBadge="Out of date on Studio"
        action="update"
      />,
    );

    expect(installButton().textContent).toBe("Update");
    expect(installButton().getAttribute("aria-label")).toBe(
      "Update bb CLI skills",
    );
  });

  it("explains why the install is unavailable with no connected machine", () => {
    render(
      <CliSkillsSettingsSectionContent
        hasConnectedMachine={false}
        onOpenPicker={() => undefined}
        pending={false}
        statusBadge={null}
      />,
    );

    expect(installButton().disabled).toBe(true);
    expect(installButton().getAttribute("aria-label")).toBe(
      "Install bb CLI skills",
    );
    expect(
      screen.getByText(
        "Connect a machine to install them into ~/.agents/skills and ~/.claude/skills.",
      ),
    ).toBeDefined();
  });

  it("shows disconnected machines while keeping install disabled and the connect copy", () => {
    const presentation = getCliSkillsPresentation(
      [
        { name: "Laptop", status: "outdated", connected: false },
        { name: "Studio", status: "installed", connected: false },
      ],
      false,
    );
    render(
      <CliSkillsSettingsSectionContent
        hasConnectedMachine={false}
        onOpenPicker={() => undefined}
        pending={false}
        statusBadge={presentation.statusBadge}
        action={presentation.action}
      />,
    );

    expect(installButton().disabled).toBe(true);
    expect(installButton().textContent).toBe("Install");
    expect(screen.getByText("Disconnected: Laptop, Studio")).toBeDefined();
    expect(
      screen.getByText(
        "Connect a machine to install them into ~/.agents/skills and ~/.claude/skills.",
      ),
    ).toBeDefined();
  });

  it("blocks reopening the picker while an install is running", () => {
    render(
      <CliSkillsSettingsSectionContent
        hasConnectedMachine={true}
        onOpenPicker={() => undefined}
        pending={true}
        statusBadge="Installed"
      />,
    );

    expect(installButton().disabled).toBe(true);
    expect(installButton().textContent).toBe("Installing…");
  });
});

describe("summarizeMachineStatuses", () => {
  it("reports a single machine plainly", () => {
    expect(
      summarizeMachineStatuses([{ status: "installed", name: "Laptop" }]),
    ).toBe("Installed");
    expect(
      summarizeMachineStatuses([{ status: "outdated", name: "Laptop" }]),
    ).toBe("Out of date on Laptop");
    expect(
      summarizeMachineStatuses([{ status: "missing", name: "Laptop" }]),
    ).toBe("Not installed");
  });

  it("counts a mixed fleet instead of claiming either extreme", () => {
    expect(
      summarizeMachineStatuses([
        { status: "installed", name: "Laptop" },
        { status: "outdated", name: "Studio" },
        { status: "missing", name: "Travel PC" },
      ]),
    ).toBe("Out of date on Studio");
    expect(
      summarizeMachineStatuses([
        { status: "installed", name: "Laptop" },
        { status: "installed", name: "Studio" },
      ]),
    ).toBe("Installed on 2 machines");
  });

  it("names machines it could not ask while reporting known machine status", () => {
    expect(
      summarizeMachineStatuses([
        { status: "installed", name: "Laptop" },
        { status: "unknown", name: "Studio" },
      ]),
    ).toBe("Installed; status unavailable on Studio");
    expect(
      summarizeMachineStatuses([
        { status: "unknown", name: "Laptop" },
        { status: "unknown", name: "Studio" },
      ]),
    ).toBe(null);
    expect(summarizeMachineStatuses([])).toBe(null);
  });
});

describe("getCliSkillsPresentation", () => {
  it("reinstalls when every known machine already has the skills", () => {
    expect(
      getCliSkillsPresentation([
        { name: "Laptop", status: "installed" },
        { name: "Studio", status: "installed" },
        { name: "Unknown box", status: "unknown" },
      ]),
    ).toEqual({
      action: "reinstall",
      statusBadge:
        "Installed on 2 machines; status unavailable on Unknown box",
    });
  });

  it("installs on missing machines when only some machines already have the skills", () => {
    expect(
      getCliSkillsPresentation([
        { name: "Laptop", status: "installed" },
        { name: "Studio", status: "missing" },
        { name: "Travel PC", status: "missing" },
      ]),
    ).toEqual({
      action: "install",
      actionLabel: "Install on 2 more",
      statusBadge: "Installed on 1 of 3 machines",
    });
  });

  it("updates outdated machines and names them in the badge", () => {
    expect(
      getCliSkillsPresentation([
        { name: "Laptop", status: "installed" },
        { name: "Studio", status: "outdated" },
        { name: "Build Mac", status: "outdated" },
        { name: "Travel PC", status: "missing" },
      ]),
    ).toEqual({
      action: "update",
      statusBadge: "Out of date on Studio, Build Mac",
    });
  });

  it("does not offer Update for an outdated disconnected machine", () => {
    expect(
      getCliSkillsPresentation([
        { name: "Laptop", status: "installed", connected: true },
        { name: "Studio", status: "outdated", connected: false },
      ]),
    ).toEqual({
      action: "reinstall",
      statusBadge: "Installed; status unavailable on Studio",
    });
  });

  it("keeps first-install copy when no machine has the skills or the status is unknown", () => {
    expect(
      getCliSkillsPresentation([{ name: "Laptop", status: "missing" }]),
    ).toEqual({ action: "install", statusBadge: "Not installed" });
    expect(
      getCliSkillsPresentation([{ name: "Laptop", status: "unknown" }]),
    ).toEqual({ action: "install", statusBadge: null });
  });

  it("keeps the disabled install action when no machine is connected", () => {
    expect(
      getCliSkillsPresentation(
        [{ name: "Laptop", status: "installed" }],
        false,
      ),
    ).toEqual({ action: "install", statusBadge: "Installed" });
  });
});
