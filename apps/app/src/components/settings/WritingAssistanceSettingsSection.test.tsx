// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { WritingAssistanceView } from "@bb/domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import {
  vocabularyEdit,
  WritingAssistanceSettingsSection,
} from "./WritingAssistanceSettingsSection";

const view = vi.hoisted(() => vi.fn());
const editVocabulary = vi.hoisted(() => vi.fn());
const updateSettings = vi.hoisted(() => vi.fn());

vi.mock("@/lib/sdk", () => ({
  sdk: { writingAssistance: { view, editVocabulary, updateSettings } },
}));

vi.mock("@/hooks/useRealtimeSubscription", () => ({
  useSystemRealtimeSubscription: () => undefined,
}));

function writingView(vocabulary: string[]): WritingAssistanceView {
  return {
    settings: {
      mode: "prompt",
      typingCorrection: "automatic",
      dictationFormatting: true,
      vocabulary,
      dailyCorrectionLimit: 300,
      dailyDictationMinutes: 60,
    },
    usage: {
      day: "2026-10-20",
      corrections: 0,
      formattings: 0,
      dictationSegments: 0,
      audioSeconds: 0,
      inputChars: 0,
      outputChars: 0,
      estimatedCostMicros: 0,
    },
    correctionAvailable: true,
  };
}

beforeEach(() => {
  view.mockReset();
  editVocabulary.mockReset();
  updateSettings.mockReset();
});

afterEach(() => cleanup());

describe("vocabularyEdit", () => {
  it("lists only the terms the user added and removed", () => {
    expect(
      vocabularyEdit(
        ["bb", "Hermes", "refreshToken"],
        ["bb", "Kestrel", "Hermes"],
      ),
    ).toEqual({ add: ["Kestrel"], remove: ["refreshToken"] });
  });
});

describe("WritingAssistanceSettingsSection vocabulary", () => {
  it("saves only the added and removed terms, so a term added elsewhere meanwhile is kept", async () => {
    view.mockResolvedValue(writingView(["bb", "Hermes"]));
    editVocabulary.mockResolvedValue(writingView(["Hermes", "Kestrel", "Ada"]));
    const { wrapper: Wrapper } = createQueryClientTestHarness();
    render(
      <Wrapper>
        <WritingAssistanceSettingsSection />
      </Wrapper>,
    );
    const field = (await screen.findByLabelText(
      "Vocabulary",
    )) as HTMLTextAreaElement;
    await waitFor(() => expect(field.value).toBe("bb\nHermes"));
    fireEvent.change(field, { target: { value: "Hermes\nKestrel" } });
    fireEvent.blur(field);
    await waitFor(() => expect(editVocabulary).toHaveBeenCalledTimes(1));
    expect(editVocabulary).toHaveBeenCalledWith({
      add: ["Kestrel"],
      remove: ["bb"],
      ifMissing: "ignore",
    });
    expect(updateSettings).not.toHaveBeenCalled();
    await waitFor(() => expect(field.value).toBe("Hermes\nKestrel\nAda"));
  });

  it("sends nothing when the list did not change", async () => {
    view.mockResolvedValue(writingView(["bb"]));
    const { wrapper: Wrapper } = createQueryClientTestHarness();
    render(
      <Wrapper>
        <WritingAssistanceSettingsSection />
      </Wrapper>,
    );
    const field = (await screen.findByLabelText(
      "Vocabulary",
    )) as HTMLTextAreaElement;
    await waitFor(() => expect(field.value).toBe("bb"));
    fireEvent.change(field, { target: { value: " bb \n" } });
    fireEvent.blur(field);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(editVocabulary).not.toHaveBeenCalled();
    expect(updateSettings).not.toHaveBeenCalled();
  });
});
