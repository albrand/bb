import { describe, expect, it } from "vitest";
import {
  addVocabularyTerms,
  parseWritingSetting,
  removeVocabularyTerms,
} from "./settings-writing.js";

describe("vocabulary terms", () => {
  it("trims terms the same way when adding and removing", () => {
    const added = addVocabularyTerms(["bb"], [" refreshToken ", "bb", " "]);
    expect(added).toEqual(["bb", "refreshToken"]);
    expect(removeVocabularyTerms(added, [" refreshToken "])).toEqual({
      vocabulary: ["bb"],
      missing: [],
    });
  });

  it("reports terms that are not in the vocabulary", () => {
    expect(removeVocabularyTerms(["bb"], ["Hermes"])).toEqual({
      vocabulary: ["bb"],
      missing: ["Hermes"],
    });
  });
});

describe("parseWritingSetting", () => {
  it("maps each CLI key to its setting", () => {
    expect(parseWritingSetting("mode", "developer")).toEqual({
      mode: "developer",
    });
    expect(parseWritingSetting("typing-correction", "suggest")).toEqual({
      typingCorrection: "suggest",
    });
    expect(parseWritingSetting("dictation-formatting", "off")).toEqual({
      dictationFormatting: false,
    });
    expect(parseWritingSetting("daily-correction-limit", "50")).toEqual({
      dailyCorrectionLimit: 50,
    });
    expect(parseWritingSetting("daily-dictation-minutes", "0")).toEqual({
      dailyDictationMinutes: 0,
    });
  });

  it("explains invalid keys and values", () => {
    expect(() => parseWritingSetting("mode", "loud")).toThrow(
      /mode must be one of/,
    );
    expect(() => parseWritingSetting("dictation-formatting", "yes")).toThrow(
      /on or off/,
    );
    expect(() => parseWritingSetting("daily-correction-limit", "1.5")).toThrow(
      /whole number/,
    );
    for (const value of ["", " ", "1e2", "0x10", " 5", "-1"]) {
      expect(() =>
        parseWritingSetting("daily-correction-limit", value),
      ).toThrow(/whole number/);
      expect(() =>
        parseWritingSetting("daily-dictation-minutes", value),
      ).toThrow(/whole number/);
    }
    expect(() => parseWritingSetting("color", "red")).toThrow(
      /Unknown setting/,
    );
  });
});
