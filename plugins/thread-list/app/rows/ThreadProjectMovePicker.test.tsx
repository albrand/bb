// @vitest-environment jsdom
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { CompactViewportOverrideProvider } from "@/components/ui/hooks/use-compact-viewport";
import {
  installTestPluginRuntime,
  renderSlot,
} from "@get-bb/plugin-sdk/testing/app";
import { makeSidebarThread } from "../model/fixtures.js";

installTestPluginRuntime();
const { ThreadProjectMovePicker } =
  await import("./ThreadProjectMovePicker.js");
const originalInnerWidth = window.innerWidth;

afterEach(() => {
  cleanup();
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: originalInnerWidth,
  });
});

it("shows the project picker inside the responsive drawer at 375px", async () => {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: 375,
  });

  function Harness() {
    return (
      <CompactViewportOverrideProvider isCompactViewport>
        <DropdownMenu>
          <DropdownMenuTrigger>Open actions</DropdownMenuTrigger>
          <DropdownMenuContent>
            <ThreadProjectMovePicker
              thread={makeSidebarThread()}
              surface="dropdown"
              onCloseMenu={() => {}}
            />
          </DropdownMenuContent>
        </DropdownMenu>
      </CompactViewportOverrideProvider>
    );
  }

  renderSlot(
    { component: Harness },
    {},
    { sdk: { projects: { list: vi.fn().mockResolvedValue([]) } } },
  );

  fireEvent.click(screen.getByRole("button", { name: "Open actions" }));
  fireEvent.click(
    await screen.findByRole("menuitem", { name: "Move to project…" }),
  );

  const dialog = await screen.findByRole("dialog", { name: "Move to project" });
  expect(dialog.getAttribute("data-persistent-drawer-content")).toBe("");
  expect(dialog.className).toContain("fixed");
  expect(dialog.className).toContain("inset-x-0");
  expect(dialog.className).toContain("max-h-[85dvh]");
});
