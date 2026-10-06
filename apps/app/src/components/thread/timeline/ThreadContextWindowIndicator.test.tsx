// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { ThreadContextWindowUsage } from "@bb/server-contract";
import {
  ThreadContextWindowCard,
  ThreadContextWindowIndicator,
} from "./ThreadContextWindowIndicator";

afterEach(cleanup);

it("keeps the context trigger clear of compact footer siblings without changing desktop spacing", () => {
  const usage: ThreadContextWindowUsage = {
    usedTokens: 1000,
    modelContextWindow: 10000,
    estimated: true,
  };

  render(<ThreadContextWindowIndicator usage={usage} />);

  const trigger = screen.getByRole("button", {
    name: "Context window 10% used",
  });
  const triggerClasses = trigger.className.split(/\s+/);

  expect(triggerClasses).toContain("-m-1");
  expect(triggerClasses).toContain("max-md:ml-0");
  expect(triggerClasses).toContain("max-md:-mr-3");
  expect(triggerClasses).toContain("max-md:h-11");
  expect(triggerClasses).not.toContain("max-md:-ml-1");
});

it("shows details when a snapshot arrives and removes them when only aggregate usage remains", () => {
  const usage: ThreadContextWindowUsage = {
    usedTokens: 1000,
    modelContextWindow: 10000,
    estimated: true,
    snapshot: {
      capturedAt: "2026-09-11T00:00:00.000Z",
      providerSessionId: "session",
      providerTurnId: null,
      model: "model",
      usedTokens: 1000,
      contextWindowTokens: 10000,
      autoCompactAtTokens: null,
      estimated: true,
      categories: [
        {
          id: "messages",
          label: "Messages",
          kind: "used",
          tokens: 1000,
          entries: [],
        },
      ],
    },
  };
  const aggregateUsage = {
    usedTokens: usage.usedTokens,
    modelContextWindow: usage.modelContextWindow,
    estimated: usage.estimated,
  };
  const { rerender } = render(
    <ThreadContextWindowCard usage={aggregateUsage} />,
  );
  expect(screen.getByText("10% used")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Show details" })).toBeNull();
  rerender(<ThreadContextWindowCard usage={usage} />);
  fireEvent.click(screen.getByRole("button", { name: "Show details" }));
  expect(screen.getByText("Messages")).toBeTruthy();
  rerender(<ThreadContextWindowCard usage={aggregateUsage} />);
  expect(screen.queryByText("Messages")).toBeNull();
  expect(screen.queryByRole("button", { name: "Hide details" })).toBeNull();
  expect(screen.getByText("10% used")).toBeTruthy();
});
