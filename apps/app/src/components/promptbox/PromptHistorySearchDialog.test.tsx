// @vitest-environment jsdom

import { useState } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { PromptHistorySearchDialog } from "./PromptHistorySearchDialog";

const mocks = vi.hoisted(() => ({
  copy: vi.fn(),
  warning: vi.fn(),
}));

vi.mock("@bb/client-core", () => ({
  getProjectStoredPromptAttachmentPaths: () => ["/tmp/old.png"],
  promptInputToDraft: () => ({
    text: "Older prompt",
    mentions: [],
    attachments: [{ path: "/tmp/old.png", name: "old.png" }],
  }),
}));

vi.mock("@bb/shared-ui/hooks/use-compact-viewport", () => ({
  useIsCompactViewport: () => false,
}));

vi.mock("@/hooks/queries/prompt-history-search-queries", () => ({
  usePromptHistorySearch: () => ({
    data: [
      {
        id: "prompt_old",
        input: [{ type: "text", text: "Older prompt" }],
        lastUsedAt: 100,
        useCount: 1,
        projectId: "proj_other",
        projectName: "Other project",
        threadId: "thr_old",
        threadTitle: "Old thread",
      },
    ],
    debouncedQuery: "",
    isError: false,
    isFetching: false,
    isPending: false,
    retry: vi.fn(),
  }),
}));

vi.mock("@/components/ui/app-toast", () => ({
  appToast: { warning: mocks.warning },
}));

vi.mock("@/lib/sdk", () => ({
  sdk: { projects: { attachments: { copy: mocks.copy } } },
}));

function deferredCopy() {
  let resolve!: () => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function Harness() {
  const [open, setOpen] = useState(true);
  const [draft, setDraft] = useState("Current draft");
  return (
    <>
      <textarea
        aria-label="Composer"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
      />
      <PromptHistorySearchDialog
        open={open}
        projectId="proj_current"
        onOpenChange={setOpen}
        onInsert={(nextDraft) => setDraft(nextDraft.text)}
        onAfterClose={() => undefined}
      />
    </>
  );
}

const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;

beforeAll(() => {
  HTMLElement.prototype.scrollIntoView = vi.fn();
});

afterAll(() => {
  HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("PromptHistorySearchDialog", () => {
  it.each(["resolve", "reject"] as const)(
    "preserves subsequent typing when a cancelled attachment copy %s",
    async (outcome) => {
      const pending = deferredCopy();
      mocks.copy.mockReturnValueOnce(pending.promise);
      render(<Harness />);

      fireEvent.click(screen.getByRole("option"));
      expect(mocks.copy).toHaveBeenCalledOnce();
      fireEvent.keyDown(document, { key: "Escape" });
      await waitFor(() =>
        expect(screen.queryByTestId("prompt-history-search")).toBeNull(),
      );
      const composer = screen.getByRole("textbox", { name: "Composer" });
      fireEvent.change(composer, { target: { value: "Newer draft" } });

      await act(async () => {
        if (outcome === "resolve") pending.resolve();
        else pending.reject(new Error("copy failed"));
        await pending.promise.catch(() => undefined);
      });

      expect(composer).toHaveProperty("value", "Newer draft");
    },
  );

  it("inserts a selected prompt after its attachment copy completes", async () => {
    mocks.copy.mockResolvedValueOnce(undefined);
    render(<Harness />);

    fireEvent.click(screen.getByRole("option"));

    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "Composer" })).toHaveProperty(
        "value",
        "Older prompt",
      ),
    );
  });
});
