// @vitest-environment jsdom

import type { ReactNode } from "react";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { createStore, Provider } from "jotai";
import { afterEach, describe, expect, it } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  installTestPluginRuntime,
  renderSlot,
} from "@get-bb/plugin-sdk/testing/app";
import {
  makePluginProject,
  makeSidebarThread,
  sdkResult,
} from "../model/fixtures.js";
import { preferencesReadyAtom } from "../preferences/preferences-sync.js";
import type { OrganizationMode } from "../../shared/preferences.js";
import {
  sidebarHiddenGroupsAtom,
  sidebarManualSectionOrderAtom,
  sidebarMachineSectionOrderAtom,
  sidebarOrganizationModeAtom,
  sidebarSectionOrderAtom,
} from "../preferences/atoms.js";

installTestPluginRuntime();
const { ProjectList } = await import("./ProjectList.js");
const { resetSidebarDataCacheForTest } =
  await import("../model/use-sidebar-data.js");

const ALEXANDRE_PROJECT_IDS = [
  "proj_qryjzqk9q5",
  "proj_d7xhqan8mu",
  "proj_jar2yhj7rg",
  "proj_mzwjz6w964",
  "proj_vqpdy6v2fk",
  "proj_x7jn4qukp5",
  "proj_wxxgc32efp",
  "proj_7ev9icuvv4",
  "proj_mbwbcuricd",
  "proj_vc7ja7zcxd",
  "proj_ukf2dmbsdx",
  "proj_gm6ymj27nh",
  "proj_bx4a8g8s2w",
  "proj_mwske3musv",
  "proj_gnvrunrxvq",
  "proj_4y7pccahv4",
];

function alexandreProjects() {
  return ALEXANDRE_PROJECT_IDS.map((id, index) =>
    makePluginProject({ id, name: `Project ${index}` }),
  );
}

afterEach(() => {
  cleanup();
  resetSidebarDataCacheForTest();
});

function Harness({
  children,
  store,
}: {
  children: ReactNode;
  store: ReturnType<typeof createStore>;
}) {
  return (
    <TooltipProvider>
      <Provider store={store}>{children}</Provider>
    </TooltipProvider>
  );
}

function makeSection(id: string, name: string) {
  return { id, name, createdAt: 1, updatedAt: 1 };
}

function renderCustomSections(
  pinned = false,
  mode: OrganizationMode = "chronological",
  looseThread = false,
  listSections: () => Promise<ReturnType<typeof makeSection>[]> = sdkResult([
    makeSection("sec_a", "Alpha"),
    makeSection("sec_b", "Beta"),
    makeSection("sec_created", "Gamma"),
  ]),
  projects = [makePluginProject()],
  alexandrePreferences = false,
  sections = [makeSection("sec_a", "Alpha"), makeSection("sec_b", "Beta")],
) {
  const store = createStore();
  store.set(preferencesReadyAtom(), true);
  store.set(sidebarOrganizationModeAtom, mode);
  if (alexandrePreferences) {
    store.set(sidebarSectionOrderAtom, [
      "pinned",
      "project:proj_qryjzqk9q5",
      "project:proj_d7xhqan8mu",
      "project:proj_jar2yhj7rg",
      "project:proj_mzwjz6w964",
      "project:proj_vqpdy6v2fk",
      "project:proj_x7jn4qukp5",
      "project:proj_wxxgc32efp",
      "project:proj_7ev9icuvv4",
      "project:proj_mbwbcuricd",
      "threads",
      "project:proj_vc7ja7zcxd",
      "project:proj_ukf2dmbsdx",
      "project:proj_gm6ymj27nh",
      "project:proj_bx4a8g8s2w",
      "project:proj_mwske3musv",
      "project:proj_gnvrunrxvq",
      "project:proj_4y7pccahv4",
    ]);
    store.set(sidebarManualSectionOrderAtom, [
      "pinned",
      "section:sec_pcm9ngh7cx",
      "section:sec_29ztuf93jc",
      "section:sec_evxvad77wg",
      "threads",
    ]);
    store.set(sidebarMachineSectionOrderAtom, [
      "pinned",
      "machines",
      "threads",
    ]);
    store.set(sidebarHiddenGroupsAtom, ["project:proj_mzwjz6w964"]);
  }
  const rendered = renderSlot(
    { component: Harness },
    { children: <ProjectList activeThreadId={null} />, store },
    {
      sidebarThreads: {
        threads: [
          makeSidebarThread({
            id: "thr_alpha",
            sectionId: "sec_a",
            pinnedAt: pinned ? 1 : null,
          }),
          ...(looseThread
            ? [makeSidebarThread({ id: "thr_loose", title: "Project thread" })]
            : []),
        ],
        projects,
        sections,
      },
      sdk: {
        threads: {
          update: sdkResult({ ok: true }),
        },
        threadSections: {
          create: sdkResult(makeSection("sec_created", "Gamma")),
          delete: sdkResult({ ok: true }),
          list: listSections,
        },
      },
    },
  );
  return { ...rendered, store };
}

async function createSectionFrom(actionsLabel: string) {
  fireEvent.pointerDown(
    await screen.findByRole("button", { name: actionsLabel }),
    { button: 0 },
  );
  fireEvent.click(await screen.findByRole("menuitem", { name: "New section" }));
  const input = await screen.findByRole("textbox", { name: "Section name" });
  fireEvent.change(input, { target: { value: "Gamma" } });
  fireEvent.click(screen.getByRole("button", { name: "Create section" }));
}

describe("creating a sidebar section", () => {
  it.each(["project", "machine"] as const)(
    "keeps an empty custom section discoverable ahead of long %s groups with Alexandre’s saved preferences",
    async (mode) => {
      renderCustomSections(
        false,
        mode,
        false,
        sdkResult([
          makeSection("sec_29ztuf93jc", "discovery"),
          makeSection("sec_evxvad77wg", "rais3"),
        ]),
        alexandreProjects(),
        true,
        [
          makeSection("sec_29ztuf93jc", "discovery"),
          makeSection("sec_evxvad77wg", "rais3"),
        ],
      );

      const emptySection = await screen.findByRole("button", {
        name: "New thread in rais3 section",
      });
      const firstModeGroup = screen.getByText(
        mode === "project" ? "Project 0" : "Threads",
        { exact: true },
      );
      expect(
        Boolean(
          emptySection.compareDocumentPosition(firstModeGroup) &
          Node.DOCUMENT_POSITION_FOLLOWING,
        ),
      ).toBe(true);
    },
  );

  it.each(["chronological", "project", "machine"] as const)(
    "shows a newly created empty section immediately in %s mode with Alexandre’s saved preferences",
    async (mode) => {
      renderCustomSections(
        false,
        mode,
        true,
        undefined,
        alexandreProjects(),
        true,
        [
          makeSection("sec_29ztuf93jc", "discovery"),
          makeSection("sec_evxvad77wg", "rais3"),
        ],
      );

      await createSectionFrom("rais3 section actions");

      const createdSection = await screen.findByRole("button", {
        name: "New thread in Gamma section",
      });
      expect(createdSection).toBeTruthy();
      if (mode !== "chronological") {
        const firstModeGroup = screen.getByText(
          mode === "project" ? "Project 0" : "Threads",
          { exact: true },
        );
        expect(
          Boolean(
            createdSection.compareDocumentPosition(firstModeGroup) &
            Node.DOCUMENT_POSITION_FOLLOWING,
          ),
        ).toBe(true);
      }
    },
  );

  it.each(["chronological", "project", "machine"] as const)(
    "renders the returned empty section immediately in %s mode",
    async (mode) => {
      renderCustomSections(false, mode, true);
      await createSectionFrom(
        mode === "project"
          ? "Test project actions"
          : mode === "machine"
            ? "No machine actions"
            : "Threads actions",
      );

      expect(
        await screen.findByRole("button", {
          name: "New thread in Gamma section",
        }),
      ).toBeTruthy();
    },
  );

  it("removes a created section when the authoritative read sees another client's deletion", async () => {
    let resolveList!: (sections: ReturnType<typeof makeSection>[]) => void;
    const listSections = () =>
      new Promise<ReturnType<typeof makeSection>[]>((resolve) => {
        resolveList = resolve;
      });
    renderCustomSections(false, "project", true, listSections);
    await createSectionFrom("Test project actions");

    expect(
      await screen.findByRole("button", {
        name: "New thread in Gamma section",
      }),
    ).toBeTruthy();

    resolveList([makeSection("sec_a", "Alpha"), makeSection("sec_b", "Beta")]);
    await waitFor(() =>
      expect(
        screen.queryByRole("button", {
          name: "New thread in Gamma section",
        }),
      ).toBeNull(),
    );
  });

  it("removes an optimistic section after a successful delete", async () => {
    renderCustomSections(false, "project", true);
    await createSectionFrom("Test project actions");
    expect(
      await screen.findByRole("button", {
        name: "New thread in Gamma section",
      }),
    ).toBeTruthy();

    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Gamma section actions" }),
      { button: 0 },
    );
    fireEvent.click(await screen.findByRole("menuitem", { name: "Remove" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Remove section" }),
    );

    await waitFor(() =>
      expect(
        screen.queryByRole("button", {
          name: "New thread in Gamma section",
        }),
      ).toBeNull(),
    );
  });

  it.each(["project", "machine"] as const)(
    "keeps custom sections visible while creating from %s mode",
    async (mode) => {
      const { inspection } = renderCustomSections(false, mode, true);
      expect(
        await screen.findByRole("button", {
          name: "New thread in Alpha section",
        }),
      ).toBeTruthy();
      await createSectionFrom(
        mode === "project" ? "Test project actions" : "No machine actions",
      );

      await waitFor(() =>
        expect(
          screen.queryByRole("textbox", { name: "Section name" }),
        ).toBeNull(),
      );
      expect(inspection.sdkCalls).toContainEqual({
        method: "threadSections.create",
        args: [{ name: "Gamma" }],
      });
    },
  );

  it("pins new threads from the Pinned header", async () => {
    const { inspection } = renderCustomSections(true);
    fireEvent.click(
      await screen.findByRole("button", { name: "New thread in Pinned" }),
    );
    expect(inspection.sidebarActionCalls).toContainEqual({
      method: "openNewThread",
      options: {
        focusPrompt: true,
        experimental_placement: { sectionId: null, pinned: true },
      },
    });
  });

  it("keeps the composer project when starting a thread in a section", async () => {
    const { inspection } = renderCustomSections();
    fireEvent.click(
      await screen.findByRole("button", {
        name: "New thread in Alpha section",
      }),
    );

    expect(inspection.sidebarActionCalls).toContainEqual({
      method: "openNewThread",
      options: {
        experimental_placement: { sectionId: "sec_a", pinned: false },
        focusPrompt: true,
      },
    });
  });

  it("offers section moves from a thread row in the rendered list", async () => {
    const slot = renderCustomSections();
    fireEvent.pointerDown(
      await screen.findByRole("button", { name: "Thread actions" }),
      { button: 0 },
    );
    const move = await screen.findByRole("menuitem", {
      name: "Move to section",
    });
    fireEvent.keyDown(move, { key: "ArrowRight" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Beta" }));
    await waitFor(() =>
      expect(slot.inspection.sdkCalls).toContainEqual({
        method: "threads.update",
        args: [{ threadId: "thr_alpha", sectionId: "sec_b" }],
      }),
    );
  });

  it("shows one divider before the built-in section visibility actions", async () => {
    renderCustomSections();
    fireEvent.pointerDown(
      await screen.findByRole("button", { name: "Threads actions" }),
      { button: 0 },
    );
    const menu = screen
      .getByRole("menuitem", { name: "Hide from list" })
      .closest('[role="menu"]');
    expect(menu?.querySelectorAll('[role="separator"]')).toHaveLength(2);
  });

  it("places the new section directly below the section it was created from", async () => {
    const { store } = renderCustomSections();
    await createSectionFrom("Alpha section actions");
    await waitFor(() =>
      expect(store.get(sidebarManualSectionOrderAtom)).toEqual([
        "pinned",
        "section:sec_a",
        "section:sec_created",
        "section:sec_b",
        "threads",
      ]),
    );
  });

  it("places the new section directly below a built-in section", async () => {
    const { store } = renderCustomSections();
    await createSectionFrom("Threads actions");
    await waitFor(() =>
      expect(store.get(sidebarManualSectionOrderAtom)).toEqual([
        "pinned",
        "section:sec_a",
        "section:sec_b",
        "threads",
        "section:sec_created",
      ]),
    );
  });
});
