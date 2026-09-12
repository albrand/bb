// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderInfo } from "@bb/domain";
import { defaultAppSettings } from "@bb/domain";
import { makeProviderInfo } from "@bb/test-helpers/domain-fixtures";
import {
  ProvidersSettingsSection,
  reorderProviderIds,
} from "./ProvidersSettingsSection";

const mocks = vi.hoisted(() => ({
  providers: [] as ProviderInfo[],
  providerStates: [] as {
    providerId: string;
    displayName: string;
    status: string;
    statusMessage: string | null;
    loginCommand: string | null;
  }[],
}));

vi.mock("@/hooks/queries/system-queries", () => ({
  useSystemProviders: () => ({ data: mocks.providers, isPending: false }),
  useSystemProviderStates: () => ({
    data: { providers: mocks.providerStates },
    isPending: false,
  }),
}));

function signInState(providerId: string, loginCommand: string | null) {
  return {
    providerId,
    displayName: providerId,
    status: "unauthenticated",
    statusMessage: null,
    loginCommand,
  };
}

function provider(id: string, displayName: string): ProviderInfo {
  return makeProviderInfo({
    id,
    displayName,
    logoUrl: null,
    capabilities: {
      supportsThreadArchive: false,
      supportsThreadRename: false,
      supportsServiceTier: false,
      supportsNativeUserQuestion: false,
      supportsFork: false,
      supportsSessionRewind: false,
      modelCatalogScope: "workspace",
      permissionModes: ["full"],
    },
  });
}

afterEach(cleanup);

afterEach(() => {
  mocks.providerStates = [];
});

describe("ProvidersSettingsSection", () => {
  it("names the sign-in command for a provider that is not signed in", () => {
    mocks.providers = [provider("acp-cursor", "Cursor")];
    mocks.providerStates = [signInState("acp-cursor", "cursor-agent login")];
    render(
      <ProvidersSettingsSection
        disabled={false}
        generalSettings={defaultAppSettings}
        onGeneralSettingsChange={vi.fn()}
      />,
    );

    expect(screen.getByText("Not signed in")).toBeTruthy();
    expect(screen.getByText(/cursor-agent login/)).toBeTruthy();
  });

  it("says a provider is not signed in even when it names no command", () => {
    mocks.providers = [provider("acp-other", "Other")];
    mocks.providerStates = [signInState("acp-other", null)];
    render(
      <ProvidersSettingsSection
        disabled={false}
        generalSettings={defaultAppSettings}
        onGeneralSettingsChange={vi.fn()}
      />,
    );

    expect(screen.getByText("Not signed in")).toBeTruthy();
  });

  it("leaves a ready provider unlabelled", () => {
    mocks.providers = [provider("codex", "Codex")];
    mocks.providerStates = [
      { ...signInState("codex", null), status: "ready" },
    ];
    render(
      <ProvidersSettingsSection
        disabled={false}
        generalSettings={defaultAppSettings}
        onGeneralSettingsChange={vi.fn()}
      />,
    );

    expect(screen.queryByText("Not signed in")).toBeNull();
  });

  it("shows reorder handles and writes the default as a user setting", () => {
    mocks.providers = [
      provider("alpha", "Alpha"),
      provider("beta", "Beta"),
      provider("gamma", "Gamma"),
    ];
    const onChange = vi.fn();
    render(
      <ProvidersSettingsSection
        disabled={false}
        generalSettings={defaultAppSettings}
        onGeneralSettingsChange={onChange}
      />,
    );

    const rows = screen.getAllByText(/Alpha|Beta|Gamma/);
    expect(rows.map((row) => row.textContent)).toEqual([
      "Alpha",
      "Beta",
      "Gamma",
    ]);
    expect(screen.getAllByText("Default")).toHaveLength(1);

    const reorderHandles = screen.getAllByRole("button", {
      name: /Reorder (Alpha|Beta|Gamma)/,
    });
    expect(reorderHandles).toHaveLength(3);
    expect(reorderHandles[0]?.parentElement?.className).toContain(
      "group/provider-row",
    );

    fireEvent.click(
      screen.getAllByRole("button", { name: "Make default" })[1]!,
    );
    expect(onChange).toHaveBeenLastCalledWith({
      ...defaultAppSettings,
      defaultProviderId: "gamma",
    });
  });

  it("marks an unavailable provider and blocks it as the default", () => {
    mocks.providers = [
      provider("alpha", "Alpha"),
      { ...provider("beta", "Beta"), available: false },
    ];
    render(
      <ProvidersSettingsSection
        disabled={false}
        generalSettings={{ ...defaultAppSettings, defaultProviderId: "alpha" }}
        onGeneralSettingsChange={vi.fn()}
      />,
    );
    expect(screen.getByText("Unavailable")).toBeTruthy();
    expect(
      (
        screen.getByRole("button", {
          name: "Make default",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  it("builds the complete picker order after a drag", () => {
    expect(
      reorderProviderIds(["alpha", "beta", "gamma"], "gamma", "alpha"),
    ).toEqual(["gamma", "alpha", "beta"]);
    expect(
      reorderProviderIds(["alpha", "beta", "gamma"], "gamma", "gamma"),
    ).toBeNull();
  });
});
